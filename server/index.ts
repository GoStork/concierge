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
import { setNestApp } from "./nest-app-ref";
import { createClient } from "redis";
import { RedisStore } from "connect-redis";
import { execSync } from "child_process";
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

function ensureLocalRedis() {
  if (process.env.REDIS_URL) return;
  try {
    const result = execSync("redis-cli ping", { timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
    if (result === "PONG") return;
  } catch {
    // not running
  }
  try {
    execSync("which redis-server", { timeout: 2000, stdio: ["pipe", "pipe", "pipe"] });
    log("Starting local Redis server...", "redis");
    execSync("redis-server --daemonize yes --port 6379 --bind 127.0.0.1 --save '' --appendonly no", { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
    log("Local Redis server started", "redis");
  } catch {
    log("redis-server not found, skipping local auto-start", "redis");
  }
}

async function createSessionStore(): Promise<session.Store> {
  const redisUrl = process.env.REDIS_URL;

  // In production without REDIS_URL, skip Redis entirely to avoid startup delay
  if (!redisUrl && process.env.NODE_ENV === "production") {
    log("No REDIS_URL configured - using MemoryStore", "redis");
    return new session.MemoryStore();
  }

  const url = redisUrl || "redis://127.0.0.1:6379";
  try {
    const redisClient = createClient({
      url,
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: (retries: number) => {
          if (retries % 20 === 0) {
            log(`Redis reconnect attempt ${retries}, retrying...`, "redis");
            if (!redisUrl) {
              try { ensureLocalRedis(); } catch {}
            }
          }
          return Math.min(retries * 200, 5000);
        },
      },
    });
    redisClient.on("error", (err: Error) => {
      if (!err.message.includes("connect ECONNREFUSED")) {
        log(`Redis error: ${err.message}`, "redis");
      }
    });
    await redisClient.connect();
    log("Redis connected - using Redis session store", "redis");
    return new RedisStore({ client: redisClient, prefix: "gostork:sess:" });
  } catch (err: any) {
    log(`Redis unavailable (${err.message}) - falling back to MemoryStore`, "redis");
    return new session.MemoryStore();
  }
}

(async () => {
  if (process.env.NODE_ENV !== "production") {
    ensureLocalRedis();
  }

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

  const sessionStore = await createSessionStore();

  const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || "r3pl1t_s3cr3t_k3y_g0st0rk",
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
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
      if (path.startsWith("/api") && !quietPaths.includes(path)) {
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
  startNightlySyncScheduler(prismaService);

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

  // Auto-seed concierge prompt sections if DB is empty, and sync updated defaults
  try {
    const db = prismaService.client;
    const promptCount = await db.conciergePromptSection.count();
    const { getDefaultPromptSections } = await import("./ai-prompt-defaults");
    const sections = getDefaultPromptSections();
    if (promptCount === 0) {
      for (const s of sections) {
        await db.conciergePromptSection.create({ data: s });
      }
      log(`Auto-seeded ${sections.length} concierge prompt sections`);
    } else {
      // Sync any sections whose default content has changed
      for (const s of sections) {
        const existing = await db.conciergePromptSection.findUnique({ where: { key: s.key } });
        if (existing && existing.content !== s.content) {
          await db.conciergePromptSection.update({
            where: { key: s.key },
            data: { content: s.content },
          });
          log(`Updated concierge prompt section: ${s.key}`);
        } else if (!existing) {
          await db.conciergePromptSection.create({ data: s });
          log(`Added new concierge prompt section: ${s.key}`);
        }
      }
    }
  } catch (e: any) {
    log(`Failed to auto-seed prompts: ${e.message}`);
  }

  appReady = true;
  log("Application fully initialized");
})();
