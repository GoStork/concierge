import * as cron from "node-cron";
import { PrismaService } from "../prisma/prisma.service";
import { SponsorshipService } from "./sponsorship.service";

/**
 * Backstop sweep for sponsorship lifecycle (every 10 min, mirrors the
 * pending-booking scheduler). Handles the cases Stripe webhooks can't drive:
 *
 *   1. ONE_TIME / comped sponsorships past currentPeriodEnd -> EXPIRED (no
 *      Stripe renewal event exists for these).
 *   2. PAST_DUE that never recovered and ran past currentPeriodEnd -> EXPIRED
 *      (backstop if a renewal/cancel webhook was missed).
 *   3. Abandoned PENDING_PAYMENT older than 24h with no successful payment ->
 *      CANCELED, freeing nothing but keeping the table clean.
 *
 * deactivate()/the marketplace orderBy already treat a past sponsoredUntil as
 * non-sponsored, so the visible boost ends at the timestamp; this sweep does the
 * status bookkeeping, clears the denormalized flag, busts cache, and notifies.
 */

const PENDING_ABANDON_MS = 24 * 60 * 60 * 1000;
let scheduledTask: cron.ScheduledTask | null = null;

export async function runSponsorshipExpiryCheck(prisma: PrismaService, service: SponsorshipService) {
  const now = new Date();

  // 1 + 2: active/past-due sponsorships whose paid period has ended.
  const lapsed = await prisma.sponsorship.findMany({
    where: {
      status: { in: ["ACTIVE", "PAST_DUE"] },
      currentPeriodEnd: { lt: now },
    },
    select: { id: true, billingMode: true, status: true, isComped: true },
  });
  for (const s of lapsed) {
    try {
      // AUTO_RENEW that is merely ACTIVE shouldn't be here unless a renewal was
      // missed - treat an expired window as terminal either way.
      await service.deactivate(s.id, "EXPIRED");
    } catch (e: any) {
      console.error(`[sponsorship-expiry] deactivate ${s.id} failed: ${e.message}`);
    }
  }

  // 3: abandoned pending checkouts.
  const abandoned = await prisma.sponsorship.findMany({
    where: { status: "PENDING_PAYMENT", createdAt: { lt: new Date(now.getTime() - PENDING_ABANDON_MS) } },
    select: { id: true },
  });
  for (const s of abandoned) {
    try {
      await prisma.sponsorship.update({ where: { id: s.id }, data: { status: "CANCELED", endedAt: now } });
    } catch (e: any) {
      console.error(`[sponsorship-expiry] cancel abandoned ${s.id} failed: ${e.message}`);
    }
  }

  if (lapsed.length || abandoned.length) {
    console.log(`[sponsorship-expiry] swept ${lapsed.length} expired, ${abandoned.length} abandoned`);
  }
}

export function startSponsorshipExpiryScheduler(prisma: PrismaService, service: SponsorshipService) {
  if (scheduledTask) {
    console.log("[sponsorship-expiry] Scheduler already running");
    return;
  }
  runSponsorshipExpiryCheck(prisma, service).catch((err) =>
    console.error(`[sponsorship-expiry] Startup check error: ${err.message}`));
  scheduledTask = cron.schedule("*/10 * * * *", async () => {
    try {
      await runSponsorshipExpiryCheck(prisma, service);
    } catch (err: any) {
      console.error(`[sponsorship-expiry] Cron error: ${err.message}`);
    }
  });
  console.log("[sponsorship-expiry] Scheduler started - runs every 10 minutes");
}

export function stopSponsorshipExpiryScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[sponsorship-expiry] Scheduler stopped");
  }
}
