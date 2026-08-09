import * as cron from "node-cron";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationService } from "../notifications/notification.service";
import { runCallOutcomeSweep, runCanceledNotRebookedSweep, runWinbackSilenceSweep } from "./call-outcome.sweep";
import { runDonorHoldSweep, runStrandedAgreementSweep } from "../billing/donor-hold.sweep";
import { runClearanceCheckinSweep } from "../billing/clearance.sweep";
import type { BillingService } from "../billing/billing.service";

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
        // Atomic claim - both servers run this cron on the same tick and read
        // the same unsent booking. The loser gets count 0 and sends nothing.
        const claim = await prisma.booking.updateMany({
          where: { id: booking.id, pendingUrgentSentAt: null },
          data: { pendingUrgentSentAt: now, pendingReminderAt: now },
        });
        if (claim.count === 0) continue;
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
        // Compare-and-swap on the value we read: only the server whose UPDATE
        // finds pendingReminderAt still unchanged owns this nudge.
        const claim = await prisma.booking.updateMany({
          where: { id: booking.id, pendingReminderAt: booking.pendingReminderAt ?? null },
          data: { pendingReminderAt: now },
        });
        if (claim.count === 0) continue;
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

/**
 * Phase 3: 12h readiness re-ask.
 *
 * When a parent answers "Need more time" on a readiness_prompt card, the
 * respond endpoint stamps uiCardData.remindAt = +12h. This sweep posts a
 * single fresh readiness card once that time passes, marking the original
 * with reminderSentAt so it can never re-fire.
 */
export async function runReadinessReminderCheck(prisma: PrismaService) {
  const now = Date.now();
  // "later"-answered cards are a small set - filter timestamps in JS rather
  // than fighting Prisma's JSON-path comparison operators.
  const candidates = await prisma.aiChatMessage.findMany({
    where: {
      uiCardType: "readiness_prompt",
      uiCardData: { path: ["answered"], equals: "later" },
    },
    select: { id: true, sessionId: true, uiCardData: true },
  });

  for (const msg of candidates) {
    try {
      const data = (msg.uiCardData as any) || {};
      if (data.reminderSentAt) continue;
      const remindAtMs = data.remindAt ? new Date(data.remindAt).getTime() : null;
      if (!remindAtMs || remindAtMs > now) continue;

      const providerName = data.providerName || "the provider";
      await prisma.aiChatMessage.create({
        data: {
          sessionId: msg.sessionId,
          role: "assistant",
          content: `Just checking back in - have you had a chance to think it over? Are you ready to move forward with ${providerName}?`,
          senderType: "system",
          senderName: "GoStork",
          uiCardType: "readiness_prompt",
          uiCardData: {
            ...data,
            answered: undefined,
            remindAt: undefined,
            reminderSentAt: undefined,
            isReminder: true,
          },
        },
      });
      await prisma.aiChatMessage.update({
        where: { id: msg.id },
        data: { uiCardData: { ...data, reminderSentAt: new Date().toISOString() } },
      });
      console.log(`[readiness-reminder] Re-asked readiness in session ${msg.sessionId} (original card ${msg.id})`);
    } catch (err: any) {
      console.error(`[readiness-reminder] Failed for message ${msg.id}: ${err.message}`);
    }
  }
}

/**
 * Phase 4: 24h surrogate hold auto-release.
 *
 * A match call places reservedByParentId + reservationExpiresAt (+24h) on the
 * surrogate. If the parent pays the deposit inside the window the hold sticks
 * (billing clears reservationExpiresAt, keeps the parent). Otherwise this
 * sweep releases the hold and Eva tells the parent, offering a re-reserve.
 */
export async function runSurrogateHoldExpiryCheck(prisma: PrismaService) {
  const now = new Date();
  const expired = await prisma.surrogate.findMany({
    where: {
      reservedByParentId: { not: null },
      reservationExpiresAt: { not: null, lte: now },
      // MATCHED + live reservation = the post-double-yes payment window.
      // That case is NOT silently released anymore - the hold-decision
      // negotiation (runDonorHoldSweep) asks the provider, then warns the
      // parent, before anything is released. Only the plain 24h decision
      // hold (ON_HOLD) auto-releases here.
      status: { not: "MATCHED" },
    },
    select: { id: true, externalId: true, firstName: true, reservedByParentId: true },
  });

  for (const s of expired) {
    try {
      await prisma.surrogate.update({
        where: { id: s.id },
        // Hold expired unpaid: she's available again - revert the ON_HOLD /
        // MATCHED status the hold or the double-yes match had set.
        data: { reservedByParentId: null, reservationExpiresAt: null, status: "AVAILABLE" },
      });
      const label = s.externalId ? `Surrogate #${s.externalId}` : (s.firstName || "your surrogate match");
      console.log(`[surrogate-hold] Released expired 24h hold on ${label} (${s.id})`);

      // Eva tells the parent in their private concierge chat + offers a re-reserve.
      const parentSession = await prisma.aiChatSession.findFirst({
        where: { userId: s.reservedByParentId!, status: "ACTIVE", sessionType: "PARENT" },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      if (parentSession) {
        await prisma.aiChatMessage.create({
          data: {
            sessionId: parentSession.id,
            role: "assistant",
            content: `A quick update: the 24-hour hold on ${label} has ended, so she's visible to other families again. If you're still interested, just tell me and I'll check whether she's available and ask the agency about re-reserving her. [[QUICK_REPLY:Yes, check her availability|I need more time|Not interested anymore]]`,
            senderType: "system",
            senderName: "GoStork",
          },
        });
      }
      // The parent also gets an in-app notification so this doesn't get lost.
      await prisma.inAppNotification.create({
        data: {
          userId: s.reservedByParentId!,
          eventType: "SURROGATE_HOLD_EXPIRED",
          payload: { surrogateId: s.id, label, message: `The 24-hour hold on ${label} has ended.` },
        },
      }).catch(() => {});
    } catch (err: any) {
      console.error(`[surrogate-hold] Failed to release hold on surrogate ${s.id}: ${err.message}`);
    }
  }
}

export function startPendingBookingScheduler(prisma: PrismaService, notifications: NotificationService, billingService?: BillingService) {
  if (scheduledTask) {
    console.log("[pending-booking] Scheduler already running");
    return;
  }

  // Catch backlog at boot, then poll every 10 minutes.
  runPendingBookingCheck(prisma, notifications).catch(err => {
    console.error(`[pending-booking] Startup check error: ${err.message}`);
  });
  // Stranded drafts are BORN at restarts - sweep immediately at boot, and
  // pick the hold-decision conversation back up without waiting a cycle.
  runStrandedAgreementSweep(prisma).catch(err => {
    console.error(`[stranded-agreement] Startup sweep error: ${err.message}`);
  });
  runDonorHoldSweep(prisma).catch(err => {
    console.error(`[donor-hold] Startup sweep error: ${err.message}`);
  });
  // Escrow holds nearing expiry must not wait a cycle after a long downtime.
  if (billingService) {
    billingService.runEscrowConversionSweep().catch(err => {
      console.error(`[escrow-conversion] Startup sweep error: ${err.message}`);
    });
  }

  scheduledTask = cron.schedule("*/10 * * * *", async () => {
    try {
      await runPendingBookingCheck(prisma, notifications);
    } catch (err: any) {
      console.error(`[pending-booking] Cron error: ${err.message}`);
    }
    try {
      await runReadinessReminderCheck(prisma);
    } catch (err: any) {
      console.error(`[readiness-reminder] Cron error: ${err.message}`);
    }
    try {
      await runSurrogateHoldExpiryCheck(prisma);
    } catch (err: any) {
      console.error(`[surrogate-hold] Cron error: ${err.message}`);
    }
    // Phase 7A: call-outcome classification + win-back automation.
    try {
      await runCallOutcomeSweep(prisma, notifications);
    } catch (err: any) {
      console.error(`[call-outcome] Cron error: ${err.message}`);
    }
    try {
      await runCanceledNotRebookedSweep(prisma);
    } catch (err: any) {
      console.error(`[canceled-rebook] Cron error: ${err.message}`);
    }
    try {
      await runWinbackSilenceSweep(prisma, notifications);
    } catch (err: any) {
      console.error(`[winback] Cron error: ${err.message}`);
    }
    // Egg-donor hold decision flow (overdue deposit -> provider decides ->
    // parent gets a final window) + stranded-agreement failure marking.
    try {
      await runDonorHoldSweep(prisma);
    } catch (err: any) {
      console.error(`[donor-hold] Cron error: ${err.message}`);
    }
    try {
      await runStrandedAgreementSweep(prisma);
    } catch (err: any) {
      console.error(`[stranded-agreement] Cron error: ${err.message}`);
    }
    // AT_CLEARANCE escrow check-ins (durable replacement for the old
    // setTimeout follow-ups, which died on every server restart).
    try {
      await runClearanceCheckinSweep();
    } catch (err: any) {
      console.error(`[clearance-checkin] Cron error: ${err.message}`);
    }
    // Hybrid escrow: convert day-6 card holds into captured vault funds
    // before Stripe's ~7-day authorization window silently expires.
    if (billingService) {
      try {
        await billingService.runEscrowConversionSweep();
      } catch (err: any) {
        console.error(`[escrow-conversion] Cron error: ${err.message}`);
      }
    }
    // Phase 8: post-handoff review check-ins (+1 reminder after 3 days).
    try {
      const { runReviewCheckinSweep } = await import("../../../review-prompts");
      await runReviewCheckinSweep(prisma);
    } catch (err: any) {
      console.error(`[review-checkin] Cron error: ${err.message}`);
    }
    // Intended Parent Form reminder ladder (email/SMS/in-app until submitted).
    try {
      const { runIpFormReminderSweep } = await import("../../../ip-form-flow");
      await runIpFormReminderSweep();
    } catch (err: any) {
      console.error(`[ip-form-reminder] Cron error: ${err.message}`);
    }
    // Intended Parent Form catch-up: calls that completed before the feature
    // shipped, or through the backlog path that skips the completion hooks,
    // leave the parent with no form and no way to ask for one.
    try {
      const { runIpFormCatchupSweep } = await import("../../../ip-form-flow");
      await runIpFormCatchupSweep();
    } catch (err: any) {
      console.error(`[ip-form-catchup] Cron error: ${err.message}`);
    }
  });

  console.log("[pending-booking] Scheduler started - runs every 10 minutes (nudges + auto-expiry + readiness re-asks + call outcomes + win-back)");
}

export function stopPendingBookingScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[pending-booking] Scheduler stopped");
  }
}
