import "reflect-metadata";
import "dotenv/config";
// Must be the very next import after dotenv - strips egress credentials in
// passive environments before any other module reads them.
import { PASSIVE_MODE } from "./passive-mode";
import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import passport from "passport";
import { createServer } from "http";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AppModule } from "./src/app.module";
import { SpaFallbackFilter } from "./src/filters/spa-fallback.filter";
import { PrismaService } from "./src/modules/prisma/prisma.service";
import { startNightlySyncScheduler, runCatchUpIfStale } from "./src/modules/providers/nightly-sync.scheduler";
import { startGeminiUsageFlush } from "./src/lib/gemini-usage";
import { runNightlySync, getNightlySyncStatus } from "./src/modules/providers/profile-sync.service";
import { StorageService } from "./src/modules/storage/storage.service";
import { startCalendarHealthScheduler } from "./src/modules/calendar/calendar-health.scheduler";
import { startCostSheetReminderScheduler } from "./src/modules/billing/cost-sheet-reminder.scheduler";
import { startDocumentReminderScheduler } from "./src/modules/billing/document-reminder.scheduler";
import { startReversalRecoupScheduler } from "./src/modules/billing/reversal-recoup.scheduler";
import { startPayoutRetryScheduler } from "./src/modules/billing/payout-retry.scheduler";
import { startRemainderSweepScheduler } from "./src/modules/billing/remainder-sweep.scheduler";
import { startStripeSecuritySweep } from "./src/modules/billing/stripe-security.sentry";
import { ConnectService } from "./src/modules/billing/connect.service";
import { BillingService } from "./src/modules/billing/billing.service";
import { startWhisperSlaScheduler } from "./src/modules/providers/whisper-sla.scheduler";
import { startPendingBookingScheduler } from "./src/modules/calendar/pending-booking.scheduler";
import { startSponsorshipExpiryScheduler } from "./src/modules/sponsorship/sponsorship-expiry.scheduler";
import { startRankSnapshotScheduler } from "./src/modules/sponsorship/rank-snapshot.scheduler";
import { startTwilioAbuseWatchdog } from "./src/modules/security/twilio-abuse-watchdog.scheduler";
import { startAuthAuditWatchdog } from "./src/modules/security/auth-audit-watchdog.scheduler";
import { SponsorshipService } from "./src/modules/sponsorship/sponsorship.service";
import { NotificationService } from "./src/modules/notifications/notification.service";
import { setNestApp } from "./nest-app-ref";
import pgSession from "connect-pg-simple";
import { sessionSecret, jwtSecret } from "./src/lib/app-secrets";
import { authLimiter, passwordResetLimiter, publicWriteLimiter, publicBookingLimiter } from "./src/lib/rate-limits";
import { buildCsp, cspMode, CSP_REPORT_PATH } from "./src/lib/csp";
import { pool } from "./db";
import path from "path";
import { aiRouter } from "./ai-router";
import { chatRouter } from "./chat-router";

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

export function log(message: string, source = "nestjs") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

// OWASP A10: without these an unhandled rejection kills the process on modern
// Node with no explanation in the log, and the codebase fires a lot of
// deliberate `void somePromise()`. Log loudly; do not exit on a rejection
// (a single bad sweep should not take the server down), but do exit on a truly
// uncaught exception, where process state is no longer trustworthy.
process.on("unhandledRejection", (reason: any) => {
  console.error("[unhandledRejection]", reason?.stack || reason);
});
process.on("uncaughtException", (err: any) => {
  console.error("[uncaughtException]", err?.stack || err);
  process.exit(1);
});

(async () => {
  // Fail fast, before anything binds a port. sessionSecret() throws when
  // SESSION_SECRET is missing or too short, and it used to throw AFTER
  // httpServer.listen(), which left a process listening with no routes
  // registered: /__health answered {"status":"starting"} forever and every
  // real URL returned Express's bare "Cannot GET /". A zombie that looks
  // half-alive is worse than a clean crash, because nothing alerts on it.
  // (This is exactly what happened to the iMac dev box on 2026-09-16.)
  try {
    sessionSecret();
    jwtSecret();
  } catch (e: any) {
    console.error(`\n${e?.message || e}\n`);
    process.exit(1);
  }

  const app = express();
  const httpServer = createServer(app);

  const port = parseInt(process.env.PORT || "5000", 10);
  let appReady = false;

  app.get("/__health", (_req, res) => {
    res.status(200).json({ status: appReady ? "ready" : "starting" });
  });

  // If the port is already taken, a second instance must EXIT - not keep running.
  // A surviving second process still starts the schedulers below, which means two
  // in-process nightly crons fire at 2 AM and race on the same logins (one run
  // imports 0 while the other succeeds), producing false "needs attention" alerts.
  httpServer.on("error", (err: any) => {
    if (err?.code === "EADDRINUSE") {
      log(`FATAL: port ${port} already in use - another server instance is running. Exiting to avoid duplicate schedulers.`);
    } else {
      log(`FATAL: httpServer error: ${err?.message || err}`);
    }
    process.exit(1);
  });

  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`serving on port ${port}`);
    },
  );

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: false }));

  // Security headers (OWASP A02). The app previously sent none, so there was no
  // defence-in-depth against MIME sniffing, clickjacking or referrer leakage.
  // A Content-Security-Policy is deliberately NOT set here: the SPA ships
  // inline bootstrap script and would break silently. That is tracked as an
  // open item in docs/production-launch-runbook.md.
  app.disable("x-powered-by");
  const isProd = process.env.NODE_ENV === "production";
  const csp = buildCsp({ isProduction: isProd });
  const mode = cspMode();
  log(`[csp] mode=${mode}`);
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "geolocation=(), payment=(), usb=()");
    if (isProd) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    // The policy only governs documents. Sending it on JSON and images costs
    // bytes on every response and buys nothing, and the image proxy sets its
    // own much tighter sandbox policy.
    if (mode !== "off" && !req.path.startsWith("/api/")) {
      res.setHeader(
        mode === "report" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy",
        csp,
      );
    }
    next();
  });

  // Where the browser posts CSP violations. Unauthenticated by necessity (the
  // browser sends these without credentials), so it is rate limited and the
  // body is capped. Reports are how we find out that a real agency video host
  // or a payment iframe is being blocked, without a user having to report it.
  app.post(
    CSP_REPORT_PATH,
    publicWriteLimiter,
    express.json({ type: ["application/csp-report", "application/json"], limit: "8kb" }),
    (req, res) => {
      try {
        const r = (req.body?.["csp-report"] || req.body || {}) as Record<string, any>;
        const oneLine = (v: unknown, max = 300) =>
          typeof v === "string" ? v.replace(/[\r\n\u2028\u2029]+/g, " ").slice(0, max) : null;
        console.warn("[csp-violation]", JSON.stringify({
          directive: oneLine(r["effective-directive"] || r["violated-directive"], 80),
          blocked: oneLine(r["blocked-uri"], 300),
          document: oneLine(r["document-uri"], 300),
        }));
      } catch { /* a malformed report must never cost us anything */ }
      res.status(204).end();
    },
  );

  // Brute-force brakes on the unauthenticated auth surface (OWASP A07).
  app.use("/api/auth/login", authLimiter);
  app.use("/api/auth/verify-otp", authLimiter);
  app.use("/api/auth/reset-password", authLimiter);
  app.use("/api/auth/forgot-password", passwordResetLimiter);
  // Public booking: unauthenticated by design, so the only brake is volume.
  // Express matches this prefix before Nest sees the route.
  app.use("/api/calendar/book", publicBookingLimiter);

  const uploadsPath = path.resolve(process.cwd(), "public/uploads");
  app.use("/uploads", express.static(uploadsPath));

  // Static favicon paths. index.html declares /favicon.png and browsers probe
  // /favicon.ico + /apple-touch-icon.png on their own, but none of those files
  // exist - they fell through to the SPA's index.html (200 text/html). The
  // brand favicon was only ever set by JS, which Safari ignores for the tab
  // icon, so Safari kept whatever icon it had cached for the host. Point all
  // three at the live SiteSettings favicon (same public brand-asset route).
  app.get(["/favicon.png", "/favicon.ico", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"], async (_req, res) => {
    try {
      const { rows } = await pool.query('SELECT "faviconUrl" FROM "SiteSettings" LIMIT 1');
      const url: string | null = rows[0]?.faviconUrl || null;
      const m = url?.match(/storage\.googleapis\.com\/[^/]+\/(.+)/);
      if (!url) return res.status(404).end();
      res.set("Cache-Control", "public, max-age=3600");
      return res.redirect(302, m ? `/api/uploads/brand-asset?path=${encodeURIComponent(decodeURIComponent(m[1]))}` : url);
    } catch (e: any) {
      console.error("[favicon] lookup failed:", e?.message);
      return res.status(404).end();
    }
  });

  const personasPath = path.resolve(process.cwd(), "server/personas");
  app.use("/persona-avatars", express.static(personasPath));

  const sessionMiddleware = session({
    // No hardcoded fallback - see src/lib/app-secrets.ts. A missing
    // SESSION_SECRET is fatal at boot, never a publicly-known key at runtime.
    secret: sessionSecret(),
    resave: false,
    saveUninitialized: false,
    store: new (pgSession(session))({ pool, createTableIfMissing: true }),
    name: "connect.sid",
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      // The app has no CSRF tokens, so the cookie itself has to carry the
      // cross-site defence. "lax" still allows the normal top-level GET
      // navigations (email links, OAuth returns) while blocking cross-site
      // POST/PUT/DELETE from riding the session.
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  });

  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());

  // Live voice mode (Eva voice conversations): WS upgrade on /api/voice/ws,
  // authenticated with the same session middleware as HTTP requests.
  const { attachVoiceGateway } = await import("./voice/voice-gateway");
  attachVoiceGateway(httpServer, sessionMiddleware);
  const { voiceRouter } = await import("./voice/voice-router");
  app.use(voiceRouter);

  app.use("/api/ai-concierge", aiRouter);
  app.use(chatRouter);
  // Phase 8: Reviews & Ratings (docs/reviews-ratings-spec.md).
  const { reviewsRouter } = await import("./reviews-router");
  app.use(reviewsRouter);
  const { conciergeMemoryRouter } = await import("./concierge-memory");
  app.use(conciergeMemoryRouter);
  // Intended Parent Form (surrogacy agencies' parent profile form).
  const { ipFormRouter } = await import("./ip-form-router");
  app.use(ipFormRouter);
  // The parent CRM record at /parents/:id, read by GoStork staff and provider
  // staff from one payload, plus the notes / next steps / owners / tags on it.
  const { parentRecordRouter } = await import("./parent-record-router");
  app.use(parentRecordRouter);
  // Stage playbooks (CRM Phase 9 §3): authoring CRUD + bulk apply.
  const { playbooksRouter } = await import("./playbooks-router");
  app.use(playbooksRouter);
  // Silence-signal settings (CRM Phase 9 §5): /account/automation.
  const { automationRouter } = await import("./automation-router");
  app.use(automationRouter);
  // Merge / link two families (CRM Phase 9 §2b) - manual only, never suggested.
  const { mergeRouter } = await import("./merge-router");
  app.use(mergeRouter);
  // Cyber-security settings: per-country verification policy + the OTP abuse
  // log, born from the production toll-fraud signup wave (docs/crm-phase-9).
  const { securityRouter } = await import("./security-router");
  app.use(securityRouter);
  const { ensureIpFormTemplateSeeded } = await import("./ip-form-defaults");
  void ensureIpFormTemplateSeeded();

  // Tiny client-side crash sink. The root ErrorBoundary POSTs here when a
  // React render crash happens so we have the message + component stack in
  // /tmp/gostork-server.log even when the user never opens DevTools. Never
  // sensitive: it logs JSON the client already had in its own scope. Keep
  // the body small (5 KB) so a runaway client can't fill the log.
  // External cron pinger entrypoint. Replit Autoscale spins the container down
  // when idle so the in-process node-cron at 2 AM ET cannot fire. Point an
  // external scheduler (GitHub Actions cron, cron-job.org, UptimeRobot, etc.)
  // at this URL with the shared secret to guarantee the daily run. Token auth
  // bypasses session/JWT because the caller is a machine, not a logged-in user.
  // Registered BEFORE nestApp.init() so Express handles it ahead of Nest's
  // catch-all 404 for unknown /api/* routes. Service refs are late-bound.
  // Remote self-heal for the dev boxes' pull-based deploy. The iMac's
  // auto-sync loop went silently stuck for a week+ while nobody was
  // physically near it - this endpoint lets an operator (or Claude, with the
  // machine's NIGHTLY_SYNC_SECRET) run the SAME ~/.gostork/auto-sync.sh the
  // LaunchAgent runs, and read back its verdict plus the recent sync log.
  // Fixed commands only, no parameters; the script itself refuses conflicts
  // and divergence, so this can never force-resolve anything. Same secret
  // header scheme as the nightly pinger above.
  app.post("/api/cron/redeploy", async (req: Request, res: Response) => {
    const secret = process.env.NIGHTLY_SYNC_SECRET;
    if (!secret) return res.status(503).json({ message: "NIGHTLY_SYNC_SECRET not configured" });
    const provided = req.headers["x-cron-secret"];
    if (typeof provided !== "string" || provided !== secret) {
      return res.status(401).json({ message: "Invalid cron secret" });
    }
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const os = await import("node:os");
      const run = promisify(execFile);
      const script = `${os.homedir()}/.gostork/auto-sync.sh`;
      const before = (await run("git", ["rev-parse", "--short", "HEAD"], { cwd: process.cwd() })).stdout.trim();
      let scriptOut = "";
      try {
        const r = await run("/bin/bash", [script], {
          cwd: process.cwd(),
          timeout: 120_000,
          env: { ...process.env, GS_REPO_DIR: process.env.GS_REPO_DIR || process.cwd() },
        });
        scriptOut = (r.stdout + r.stderr).trim();
      } catch (e: any) {
        scriptOut = `script failed: ${e?.message}\n${e?.stdout || ""}${e?.stderr || ""}`.trim();
      }
      const after = (await run("git", ["rev-parse", "--short", "HEAD"], { cwd: process.cwd() })).stdout.trim();
      let logTail = "";
      try {
        logTail = (await run("/usr/bin/tail", ["-n", "20", "/tmp/gostork-autosync.log"])).stdout;
      } catch { /* no log yet */ }
      // If the script pulled, it also kickstarted the server - this response
      // may be the old process's last words. That is the desired outcome.
      res.json({ before, after, pulled: before !== after, scriptOut, logTail });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "redeploy failed" });
    }
  });

  let nightlySyncPrismaRef: PrismaService | null = null;
  let nightlySyncStorageRef: StorageService | null = null;
  let nightlySyncNotificationRef: NotificationService | null = null;
  app.post("/api/cron/run-nightly-sync", (req: Request, res: Response) => {
    if (PASSIVE_MODE) return res.status(200).json({ skipped: "PASSIVE_MODE" });
    const secret = process.env.NIGHTLY_SYNC_SECRET;
    if (!secret) {
      return res.status(503).json({ message: "NIGHTLY_SYNC_SECRET not configured" });
    }
    const provided = req.headers["x-cron-secret"];
    if (typeof provided !== "string" || provided !== secret) {
      return res.status(401).json({ message: "Invalid cron secret" });
    }
    if (!nightlySyncPrismaRef) {
      return res.status(503).json({ message: "Server still starting" });
    }
    const status = getNightlySyncStatus();
    if (status.isRunning) {
      return res.status(200).json({ message: "Nightly sync already running", isRunning: true });
    }
    runNightlySync(nightlySyncPrismaRef, nightlySyncStorageRef)
      .then((results) => nightlySyncNotificationRef?.sendNightlySyncDigest(results))
      .catch((err: any) => {
        console.error("[nightly-sync] Cron pinger run failed:", err.message);
      });
    return res.status(202).json({ message: "Nightly sync started", isRunning: true });
  });

  app.post("/api/client-errors", publicWriteLimiter, express.json({ limit: "5kb" }), (req, res) => {
    try {
      const { message, stack, componentStack, url, userAgent, at } = req.body || {};
      // This log is our only forensic record of client crashes, so never let a
      // caller embed newlines and forge log lines in it (OWASP A09).
      const oneLine = (v: unknown, max: number) =>
        typeof v === "string" ? v.replace(/[\r\n\u2028\u2029]+/g, " ").slice(0, max) : null;
      console.error("[CLIENT ERROR]", JSON.stringify({
        at: oneLine(at, 40) || new Date().toISOString(),
        url: oneLine(url, 500),
        userAgent: oneLine(userAgent, 300),
        message: oneLine(message, 1000),
        stack: oneLine(stack, 4000),
        componentStack: oneLine(componentStack, 2000),
      }));
    } catch (e: any) {
      console.error("[CLIENT ERROR] sink failed:", e?.message);
    }
    res.status(204).end();
  });

  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;
    let capturedJsonResponse: Record<string, any> | undefined = undefined;

    const originalResJson = res.json;
    res.json = function (bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };

    res.on("finish", () => {
      const duration = Date.now() - start;
      const quietPaths = ["/api/calendar/bookings/imminent", "/api/brand/settings", "/api/user", "/api/uploads/gcs", "/api/uploads/proxy"];
      const isError = res.statusCode >= 400;
      const isSlow = duration > 2000;
      if (path.startsWith("/api") && !quietPaths.includes(path) && (isError || isSlow)) {
        let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
        if (capturedJsonResponse) {
          const json = JSON.stringify(capturedJsonResponse);
          logLine += ` :: ${json.length > 500 ? json.slice(0, 500) + `... (${json.length} chars)` : json}`;
        }
        log(logLine);
      }
    });

    next();
  });

  const nestApp = await NestFactory.create(AppModule, new ExpressAdapter(app), {
    logger: ["error", "warn"],
  });

  nestApp.useGlobalFilters(new SpaFallbackFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle("GoStork API")
    .setDescription(
      "GoStork fertility marketplace API. " +
      "Use session cookies (web) or Bearer JWT tokens (mobile) for authentication."
    )
    .setVersion("1.0")
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "JWT token from /api/auth/login" },
    )
    .build();
  // The full API surface (390 routes, parameter names, auth scheme) is an
  // attacker's road map. Keep it for local development, never serve it in
  // production. Set ENABLE_API_DOCS=true to override on a staging host.
  if (process.env.NODE_ENV !== "production" || process.env.ENABLE_API_DOCS === "true") {
    const document = SwaggerModule.createDocument(nestApp, swaggerConfig);
    SwaggerModule.setup("docs", nestApp, document);
  }

  await nestApp.init();
  setNestApp(nestApp);

  const prismaService = nestApp.get(PrismaService);
  const notificationService = nestApp.get(NotificationService);
  const storageService = nestApp.get(StorageService);
  nightlySyncPrismaRef = prismaService;
  nightlySyncStorageRef = storageService;
  nightlySyncNotificationRef = notificationService;
  // The nightly is driven by an EXTERNAL pinger (GitHub Actions cron ->
  // /api/cron/run-nightly-sync) hitting one URL, so the in-process node-cron is
  // OFF by default. Otherwise every machine that runs this code (dev MacBook,
  // always-on iMac, each Replit container) fires its own 2 AM cron against the
  // shared DB and they pile up. Set ENABLE_NIGHTLY_SCHEDULER=true on exactly ONE
  // host if you ever want the in-process cron instead of the pinger. The atomic
  // NightlySyncLock is the safety net either way.
  // Gemini spend meter. Deliberately started OUTSIDE the PASSIVE_MODE branch:
  // this is not a sweep, and a passive instance still serves chat traffic and
  // still spends money. Buffers in memory and flushes a per-day rollup every
  // 60s - never a write per call, since one donor sync makes thousands.
  startGeminiUsageFlush(async (rows) => {
    for (const r of rows) {
      const day = new Date(`${r.day}T00:00:00.000Z`);
      await prismaService.geminiUsage.upsert({
        where: { day_subsystem_model: { day, subsystem: r.subsystem, model: r.model } },
        create: {
          day,
          subsystem: r.subsystem,
          model: r.model,
          calls: r.calls,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cachedTokens: r.cachedTokens,
          costUsd: r.costUsd,
        },
        // Increment, never overwrite - both Macs and the prod VM can write the
        // same (day, subsystem, model) row concurrently.
        update: {
          calls: { increment: r.calls },
          inputTokens: { increment: r.inputTokens },
          outputTokens: { increment: r.outputTokens },
          cachedTokens: { increment: r.cachedTokens },
          costUsd: { increment: r.costUsd },
        },
      });
    }
  });

  if (PASSIVE_MODE) {
    log("[PASSIVE_MODE] Schedulers disabled - no sweeps, reminders, or watchdogs run on this instance");
  } else {
  if (process.env.ENABLE_NIGHTLY_SCHEDULER === "true") {
    log("[nightly-sync] In-process scheduler ENABLED on this host (ENABLE_NIGHTLY_SCHEDULER=true)");
    startNightlySyncScheduler(prismaService, storageService, notificationService);
    runCatchUpIfStale(prismaService, storageService, notificationService);
  } else {
    log("[nightly-sync] In-process scheduler OFF - driven by the external pinger at /api/cron/run-nightly-sync");
  }
  startCalendarHealthScheduler(prismaService, notificationService);
  startCostSheetReminderScheduler(prismaService, notificationService);
  startDocumentReminderScheduler(notificationService);
  startReversalRecoupScheduler(prismaService);
  startPayoutRetryScheduler(prismaService, nestApp.get(ConnectService));
  startRemainderSweepScheduler(prismaService);
  startWhisperSlaScheduler(prismaService, notificationService);
  startPendingBookingScheduler(prismaService, notificationService, nestApp.get(BillingService));
  startSponsorshipExpiryScheduler(prismaService, nestApp.get(SponsorshipService));
  startRankSnapshotScheduler(prismaService);
  startTwilioAbuseWatchdog(prismaService, notificationService);
  startAuthAuditWatchdog(prismaService, notificationService);
  startStripeSecuritySweep(prismaService as any, notificationService);
  }

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    console.error("Internal Server Error:", err);
    if (res.headersSent) {
      return next(err);
    }
    // OWASP A10: 4xx messages are ours and are meant for the caller. 5xx
    // messages are not - an unhandled Prisma error would otherwise hand the
    // client our model names, column names and query shape. Log it, return a
    // generic body.
    const message =
      status < 500
        ? err.message || "Request failed"
        : "Internal Server Error";
    return res.status(status).json({ message });
  });

  if (process.env.NODE_ENV === "production") {
    const { serveStatic } = await import("./static");
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // Auto-seed ProviderType rows that the platform depends on. Idempotent -
  // only inserts a row if its name isn't already present. Mirrors the
  // never-overwrite pattern used for prompt sections below.
  try {
    const db = prismaService.client;
    const requiredProviderTypes = [
      "Legal Services",
      "Genetic Counseling",
      "Fertility Coaches",
      "Fertility Nutritionists",
      "Therapists",
      "Doulas",
    ];
    for (const name of requiredProviderTypes) {
      const existing = await db.providerType.findUnique({ where: { name } });
      if (!existing) {
        await db.providerType.create({ data: { name } });
        log(`Seeded ProviderType: ${name}`);
      }
    }
  } catch (e: any) {
    log(`Failed to seed provider types: ${e.message}`);
  }

  // Auto-seed concierge prompt sections on first run, and add any new sections added in code.
  // Existing DB sections are NEVER overwritten - admin edits in the UI are preserved across restarts.
  try {
    const db = prismaService.client;
    const { getDefaultPromptSections } = await import("./ai-prompt-defaults");
    const sections = getDefaultPromptSections();
    let seeded = 0;
    for (const s of sections) {
      const existing = await db.conciergePromptSection.findUnique({ where: { key: s.key } });
      if (!existing) {
        await db.conciergePromptSection.create({ data: s });
        seeded++;
        log(`Seeded new concierge prompt section: ${s.key}`);
      }
    }
    if (seeded > 0) log(`Seeded ${seeded} new concierge prompt section(s)`);
  } catch (e: any) {
    log(`Failed to seed prompts: ${e.message}`);
  }

  // Auto-seed sponsorship plans (create-if-not-exists; admin price edits preserved).
  try {
    const db = prismaService.client;
    const { getSponsorshipPlanDefaults } = await import("./sponsorship-plan-defaults");
    // Retire legacy shared (untyped) slot bundles - bundles are now scoped per
    // sub-profile type. Delete the unreferenced ones, deactivate any still in use.
    const legacy = await db.sponsorshipPlan.findMany({ where: { productType: "SLOT_BUNDLE", slotEntityType: null } });
    for (const lp of legacy) {
      const refs = await db.sponsorship.count({ where: { planId: lp.id } });
      if (refs === 0) await db.sponsorshipPlan.delete({ where: { id: lp.id } });
      else await db.sponsorshipPlan.update({ where: { id: lp.id }, data: { isActive: false } });
    }
    let seeded = 0;
    for (const p of getSponsorshipPlanDefaults()) {
      const existing = await db.sponsorshipPlan.findUnique({
        where: { productType_tierKey: { productType: p.productType as any, tierKey: p.tierKey } },
      });
      if (!existing) {
        await db.sponsorshipPlan.create({ data: { ...p, productType: p.productType as any, slotEntityType: (p.slotEntityType ?? null) as any } });
        seeded++;
      }
    }
    if (seeded > 0) log(`Seeded ${seeded} new sponsorship plan(s)`);
  } catch (e: any) {
    log(`Failed to seed sponsorship plans: ${e.message}`);
  }

  appReady = true;
  log("Application fully initialized");

  // Pre-warm Anthropic connection in the background - eliminates cold-start TLS latency
  // for the first real concierge request.
  import("./ai-router").then(({ warmupGeminiConnection }) => {
    warmupGeminiConnection().catch((e: any) => log(`Gemini warmup error: ${e.message}`));
  });
})().catch((err: any) => {
  // Same reasoning as the secret check above: if startup dies part-way, exit
  // so the supervisor restarts (or the box stays visibly down) rather than
  // serving 404s from a process that never finished booting.
  console.error("FATAL: server startup failed:", err?.stack || err);
  process.exit(1);
});
