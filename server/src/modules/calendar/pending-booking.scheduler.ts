import * as cron from "node-cron";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationService } from "../notifications/notification.service";

/**
 * Keeps PENDING booking requests from silently rotting.
 *
 * Each tick (every 10 min) walks every PENDING booking and applies exactly
 * one action per booking, in priority order:
 *
 *   1. EXPIRE   - requested slot has passed -> status="EXPIRED", expiredAt set,
 *                 both sides notified (but only if it expired recently; ancient
 *                 backlog is flipped silently so a one-time boot sweep can't
 *                 fire a storm of "your request expired" emails for old data).
 *   2. URGENT   - slot is < 24h away and we haven't sent the urgent nudge yet
 *                 (gated by pendingUrgentSentAt so it fires exactly once).
 *   3. DAILY    - the request has been unanswered for >= 24h since it was made
 *                 (or since the last daily nudge) -> nudge again, throttled by
 *                 pendingReminderAt to ~once per day.
 *
 * Provider gets the nudges (the parent already knows they're waiting). The
 * matching in-app notification is created here; the email/SMS lives in
 * NotificationService.sendPendingBookingReminder / sendBookingExpired.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// Don't email about requests that expired long ago (e.g. when this sweep first
// runs against historical backlog). Flip their status silently instead.
const EXPIRY_NOTIFY_GRACE_MS = 48 * 60 * 60 * 1000;

let scheduledTask: cron.ScheduledTask | null = null;

const bookingInclude = {
  providerUser: { include: { provider: true, scheduleConfig: true } },
  parentUser: true,
} as const;

export async function runPendingBookingCheck(prisma: PrismaService, notifications: NotificationService) {
  const now = new Date();
  const nowMs = now.getTime();

  const pending = await prisma.booking.findMany({
    where: { status: "PENDING" },
    include: bookingInclude as any,
    orderBy: { scheduledAt: "asc" },
  });

  for (const booking of pending) {
    try {
      const slotMs = new Date(booking.scheduledAt).getTime();

      // 1. EXPIRE - slot has passed unanswered.
      if (slotMs <= nowMs) {
        await prisma.booking.update({
          where: { id: booking.id },
          data: { status: "EXPIRED", expiredAt: now },
        });

        const recentlyExpired = nowMs - slotMs <= EXPIRY_NOTIFY_GRACE_MS;
        if (recentlyExpired) {
          await notifications.sendBookingExpired(booking).catch(e =>
            console.error(`[pending-booking] expiry notify failed for ${booking.id}: ${e.message}`));

          const recipientIds = [booking.providerUserId, booking.parentUserId].filter(Boolean) as string[];
          for (const uid of recipientIds) {
            await prisma.inAppNotification.create({
              data: {
                userId: uid,
                eventType: "BOOKING_EXPIRED",
                payload: {
                  bookingId: booking.id,
                  scheduledAt: booking.scheduledAt,
                  attendeeName: booking.attendeeName || (booking as any).parentUser?.name || null,
                },
              },
            }).catch(() => {});
          }
          console.log(`[pending-booking] EXPIRED booking ${booking.id} (slot ${booking.scheduledAt.toISOString()}) + notified`);
        } else {
          console.log(`[pending-booking] EXPIRED stale booking ${booking.id} silently (slot ${booking.scheduledAt.toISOString()})`);
        }
        continue;
      }

      // 2. URGENT - slot within 24h and the one-shot urgent nudge hasn't gone out.
      if (slotMs - nowMs <= DAY_MS && !booking.pendingUrgentSentAt) {
        await prisma.booking.update({
          where: { id: booking.id },
          data: { pendingUrgentSentAt: now, pendingReminderAt: now },
        });
        await notifications.sendPendingBookingReminder(booking, { urgent: true }).catch(e =>
          console.error(`[pending-booking] urgent nudge failed for ${booking.id}: ${e.message}`));
        await prisma.inAppNotification.create({
          data: {
            userId: booking.providerUserId,
            eventType: "BOOKING_PENDING_URGENT",
            payload: { bookingId: booking.id, scheduledAt: booking.scheduledAt, attendeeName: booking.attendeeName || (booking as any).parentUser?.name || null },
          },
        }).catch(() => {});
        console.log(`[pending-booking] URGENT nudge booking ${booking.id} (slot in <24h)`);
        continue;
      }

      // 3. DAILY - unanswered for >= 24h since request or last daily nudge.
      const lastRef = (booking.pendingReminderAt ?? booking.createdAt).getTime();
      if (nowMs - lastRef >= DAY_MS) {
        await prisma.booking.update({
          where: { id: booking.id },
          data: { pendingReminderAt: now },
        });
        await notifications.sendPendingBookingReminder(booking, { urgent: false }).catch(e =>
          console.error(`[pending-booking] daily nudge failed for ${booking.id}: ${e.message}`));
        await prisma.inAppNotification.create({
          data: {
            userId: booking.providerUserId,
            eventType: "BOOKING_PENDING_REMINDER",
            payload: { bookingId: booking.id, scheduledAt: booking.scheduledAt, attendeeName: booking.attendeeName || (booking as any).parentUser?.name || null },
          },
        }).catch(() => {});
        console.log(`[pending-booking] DAILY nudge booking ${booking.id}`);
      }
    } catch (err: any) {
      console.error(`[pending-booking] Failed for booking ${booking.id}: ${err.message}`);
    }
  }
}

export function startPendingBookingScheduler(prisma: PrismaService, notifications: NotificationService) {
  if (scheduledTask) {
    console.log("[pending-booking] Scheduler already running");
    return;
  }

  // Catch backlog at boot, then poll every 10 minutes.
  runPendingBookingCheck(prisma, notifications).catch(err => {
    console.error(`[pending-booking] Startup check error: ${err.message}`);
  });

  scheduledTask = cron.schedule("*/10 * * * *", async () => {
    try {
      await runPendingBookingCheck(prisma, notifications);
    } catch (err: any) {
      console.error(`[pending-booking] Cron error: ${err.message}`);
    }
  });

  console.log("[pending-booking] Scheduler started - runs every 10 minutes (daily/urgent nudges + auto-expiry)");
}

export function stopPendingBookingScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[pending-booking] Scheduler stopped");
  }
}
