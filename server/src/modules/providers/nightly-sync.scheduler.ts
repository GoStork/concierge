import * as cron from "node-cron";
import { PrismaService } from "../prisma/prisma.service";
import type { StorageService } from "../storage/storage.service";
import type { NotificationService } from "../notifications/notification.service";
import { runNightlySync, getNightlySyncStatus, lastNightlySlotStart } from "./profile-sync.service";

let scheduledTask: cron.ScheduledTask | null = null;

export function startNightlySyncScheduler(
  prisma: PrismaService,
  storageService?: StorageService | null,
  notificationService?: NotificationService | null,
) {
  if (scheduledTask) {
    console.log("[nightly-sync] Scheduler already running");
    return;
  }

  scheduledTask = cron.schedule("0 2 * * *", async () => {
    console.log("[nightly-sync] Cron triggered at", new Date().toISOString());
    try {
      const results = await runNightlySync(prisma, storageService);
      await notificationService?.sendNightlySyncDigest(results);
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
 * The 2 AM run is dropped whenever the process is not alive and responsive
 * across that minute - the host was off, or node-cron missed the tick under
 * heavy event-loop load (observed Aug 5 2026: "[NODE-CRON] WARN missed
 * execution ... Possible blocking IO or high CPU"). On boot, fire a catch-up if
 * the CURRENT 2 AM period still has no successful nightly.
 *
 * This is anchored to the same 2 AM ET slot as the dedup gate in
 * runNightlySync, and deliberately not to a rolling hour count. The old 25h
 * staleness threshold left a 5-hour dead zone against that gate's 20h window:
 * a catch-up at ~08:00 was <25h at the next morning's boot (so catch-up
 * skipped) yet the 02:00 cron in between was <20h (so the cron skipped too),
 * and an entire day fell through the gap. Sharing one boundary means the two
 * gates can no longer disagree about whether a period has been satisfied.
 *
 * Idempotent: runNightlySync short-circuits on the in-process flag and on the
 * atomic DB claim, and per-profile checkpoints make re-running cheap.
 */
export async function runCatchUpIfStale(
  prisma: PrismaService,
  storageService?: StorageService | null,
  notificationService?: NotificationService | null,
) {
  try {
    if (getNightlySyncStatus().isRunning) {
      console.log("[nightly-sync] Catch-up skipped - sync already running");
      return;
    }

    // `total > 0` matches the dedup gate: a 0-found empty run must not count as
    // satisfying the period, or one broken provider suppresses the catch-up too.
    const slotStart = lastNightlySlotStart();
    const latest = await prisma.syncLog.findFirst({
      where: {
        source: "nightly",
        status: { in: ["completed", "partial"] },
        total: { gt: 0 },
        startedAt: { gte: slotStart },
      },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    });

    if (latest) {
      console.log(
        `[nightly-sync] Catch-up not needed - nightly already ran at ${latest.startedAt.toISOString()} in the period since ${slotStart.toISOString()}`,
      );
      return;
    }

    console.log(`[nightly-sync] Catch-up triggered - no successful nightly since ${slotStart.toISOString()}`);

    setTimeout(() => {
      runNightlySync(prisma, storageService)
        .then((results) => notificationService?.sendNightlySyncDigest(results))
        .catch((err: any) => {
          console.error("[nightly-sync] Catch-up run failed:", err.message);
        });
    }, 30_000);
  } catch (err: any) {
    console.error("[nightly-sync] Catch-up check failed:", err.message);
  }
}
