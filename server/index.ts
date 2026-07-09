import "reflect-metadata";
import "dotenv/config";
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
import { runNightlySync, getNightlySyncStatus } from "./src/modules/providers/profile-sync.service";
import { StorageService } from "./src/modules/storage/storage.service";
import { startCalendarHealthScheduler } from "./src/modules/calendar/calendar-health.scheduler";
import { startCostSheetReminderScheduler } from "./src/modules/billing/cost-sheet-reminder.scheduler";
import { startReversalRecoupScheduler } from "./src/modules/billing/reversal-recoup.scheduler";
import { startPayoutRetryScheduler } from "./src/modules/billing/payout-retry.scheduler";
import { startRemainderSweepScheduler } from "./src/modules/billing/remainder-sweep.scheduler";
import { ConnectService } from "./src/modules/billing/connect.service";
import { startWhisperSlaScheduler } from "./src/modules/providers/whisper-sla.scheduler";
import { startPendingBookingScheduler } from "./src/modules/calendar/pending-booking.scheduler";
import { startSponsorshipExpiryScheduler } from "./src/modules/sponsorship/sponsorship-expiry.scheduler";
import { startRankSnapshotScheduler } from "./src/modules/sponsorship/rank-snapshot.scheduler";
import { SponsorshipService } from "./src/modules/sponsorship/sponsorship.service";
import { NotificationService } from "./src/modules/notifications/notification.service";
import { setNestApp } from "./nest-app-ref";
import pgSession from "connect-pg-simple";
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

(async () => {
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

  const uploadsPath = path.resolve(process.cwd(), "public/uploads");
  app.use("/uploads", express.static(uploadsPath));

  const personasPath = path.resolve(process.cwd(), "server/personas");
  app.use("/persona-avatars", express.static(personasPath));

  const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || "r3pl1t_s3cr3t_k3y_g0st0rk",
    resave: false,
    saveUninitialized: false,
    store: new (pgSession(session))({ pool, createTableIfMissing: true }),
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  });

  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());

  app.use("/api/ai-concierge", aiRouter);
  app.use(chatRouter);

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
  let nightlySyncPrismaRef: PrismaService | null = null;
  let nightlySyncStorageRef: StorageService | null = null;
  let nightlySyncNotificationRef: NotificationService | null = null;
  app.post("/api/cron/run-nightly-sync", (req: Request, res: Response) => {
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

  app.post("/api/client-errors", express.json({ limit: "5kb" }), (req, res) => {
    try {
      const { message, stack, componentStack, url, userAgent, at } = req.body || {};
      console.error("[CLIENT ERROR]", JSON.stringify({
        at: at || new Date().toISOString(),
        url, userAgent, message,
        stack: typeof stack === "string" ? stack.slice(0, 4000) : null,
        componentStack: typeof componentStack === "string" ? componentStack.slice(0, 2000) : null,
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
  const document = SwaggerModule.createDocument(nestApp, swaggerConfig);
  SwaggerModule.setup("docs", nestApp, document);

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
  if (process.env.ENABLE_NIGHTLY_SCHEDULER === "true") {
    log("[nightly-sync] In-process scheduler ENABLED on this host (ENABLE_NIGHTLY_SCHEDULER=true)");
    startNightlySyncScheduler(prismaService, storageService, notificationService);
    runCatchUpIfStale(prismaService, storageService, notificationService);
  } else {
    log("[nightly-sync] In-process scheduler OFF - driven by the external pinger at /api/cron/run-nightly-sync");
  }
  startCalendarHealthScheduler(prismaService, notificationService);
  startCostSheetReminderScheduler(prismaService, notificationService);
  startReversalRecoupScheduler(prismaService);
  startPayoutRetryScheduler(prismaService, nestApp.get(ConnectService));
  startRemainderSweepScheduler(prismaService);
  startWhisperSlaScheduler(prismaService, notificationService);
  startPendingBookingScheduler(prismaService, notificationService);
  startSponsorshipExpiryScheduler(prismaService, nestApp.get(SponsorshipService));
  startRankSnapshotScheduler(prismaService);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    console.error("Internal Server Error:", err);
    if (res.headersSent) {
      return next(err);
    }
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
    const requiredProviderTypes = ["Legal Services"];
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
})();
