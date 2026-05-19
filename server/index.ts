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
import { startNightlySyncScheduler } from "./src/modules/providers/nightly-sync.scheduler";
import { startCalendarHealthScheduler } from "./src/modules/calendar/calendar-health.scheduler";
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
  startNightlySyncScheduler(prismaService);
  startCalendarHealthScheduler(prismaService, notificationService);

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

  appReady = true;
  log("Application fully initialized");
})();
