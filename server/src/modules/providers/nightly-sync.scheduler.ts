import * as cron from "node-cron";
import { PrismaService } from "../prisma/prisma.service";
import type { StorageService } from "../storage/storage.service";
import { runNightlySync, getNightlySyncStatus } from "./profile-sync.service";

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

  console.log("[nightly-sync] Scheduler started - runs daily at 2:00 AM ET");
}

export function stopNightlySyncScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[nightly-sync] Scheduler stopped");
  }
}

/**
 * On Replit Autoscale (and any in-process cron) the 2 AM run is dropped if the
 * container is asleep or the server restarted across that minute. On boot, look
 * at the most recent completed nightly SyncLog: if it's older than the stale
 * threshold, fire a catch-up run asynchronously. Idempotent because runNightlySync
 * short-circuits when already running, and per-profile checkpoints make re-running
 * cheap.
 */
const STALE_HOURS = 25;

export async function runCatchUpIfStale(prisma: PrismaService, storageService?: StorageService | null) {
  try {
    if (getNightlySyncStatus().isRunning) {
      console.log("[nightly-sync] Catch-up skipped - sync already running");
      return;
    }

    const latest = await prisma.syncLog.findFirst({
      where: { source: "nightly", status: { in: ["completed", "partial"] } },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    });

    const cutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000);
    const isStale = !latest || latest.startedAt < cutoff;

    if (!isStale) {
      console.log(`[nightly-sync] Catch-up not needed - last nightly run at ${latest!.startedAt.toISOString()}`);
      return;
    }

    const lastDesc = latest ? `${latest.startedAt.toISOString()} (>${STALE_HOURS}h ago)` : "never";
    console.log(`[nightly-sync] Catch-up triggered - last nightly run: ${lastDesc}`);

    setTimeout(() => {
      runNightlySync(prisma, storageService).catch((err: any) => {
        console.error("[nightly-sync] Catch-up run failed:", err.message);
      });
    }, 30_000);
  } catch (err: any) {
    console.error("[nightly-sync] Catch-up check failed:", err.message);
  }
}
