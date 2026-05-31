// One-off: trigger the whisper-SLA scheduler check once.
// Used to verify the email/SMS deep-link fix without waiting for the cron tick.
// Run with: npx tsx scripts/trigger-whisper-sla-once.ts
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { NotificationService } from "../server/src/modules/notifications/notification.service";
import { runWhisperSlaCheck } from "../server/src/modules/providers/whisper-sla.scheduler";

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn", "log"] });
  const prisma = app.get(PrismaService);
  const notifications = app.get(NotificationService);
  console.log("Running whisper-SLA check once...");
  await runWhisperSlaCheck(prisma, notifications);
  console.log("Done.");
  await app.close();
  process.exit(0);
})();
