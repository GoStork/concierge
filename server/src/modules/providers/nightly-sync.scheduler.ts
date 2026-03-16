import * as cron from "node-cron";
import { PrismaService } from "../prisma/prisma.service";
import type { StorageService } from "../storage/storage.service";
import { runNightlySync } from "./profile-sync.service";

let scheduledTask: cron.ScheduledTask | null = null;

export function startNightlySyncScheduler(prisma: PrismaService, storageService?: StorageService | null) {
  if (scheduledTask) {
    console.log("[nightly-sync] Scheduler already running");
    return;
  }

  scheduledTask = cron.schedule("0 2 * * *", async () => {
    console.log("[nightly-sync] Cron triggered at", new Date().toISOString());
    try {
      await runNightlySync(prisma, storageService);
    } catch (err: any) {
      console.error("[nightly-sync] Cron job error:", err.message);
    }
  }, {
    timezone: "America/New_York",
  });

  console.log("[nightly-sync] Scheduler started — runs daily at 2:00 AM ET");
}

export function stopNightlySyncScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[nightly-sync] Scheduler stopped");
  }
}
