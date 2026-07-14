import { PrismaService } from "../prisma/prisma.service";
import { NotificationService } from "../notifications/notification.service";
import { emitJourneyEvent, bookingEventType } from "../../../journey-events";

/**
 * Phase 7A: call outcomes + win-back.
 *
 * Sweep 1 (runCallOutcomeSweep): every CONFIRMED booking whose end time +
 * 30min grace has passed gets classified exactly once (Booking.outcome):
 *
 *   COMPLETED        - both sides joined the GoStork video room
 *   NO_SHOW_PARENT   - provider joined, parent never did
 *   NO_SHOW_PROVIDER - parent joined, provider never did (admin alert - a
 *                      provider standing up a parent is an account fire)
 *   NO_SHOW_BOTH     - nobody joined
 *   UNVERIFIED       - non-video meeting; we have no join telemetry
 *
 * Join truth comes from Booking.parentJoinedMeetingAt / providerJoinedMeetingAt,
 * stamped by the in-app video room join endpoints (incl. guest joins) - our
 * room joins ARE the Daily.co room joins, so this is verified attendance.
 *
 * Sweep 2 (runCanceledNotRebookedSweep): a canceled consultation with no
 * newer booking for the same parent-provider pair within 24h emits
 * CANCELED_NOT_REBOOKED and triggers the win-back.
 *
 * Win-back: Eva posts a deterministic re-engagement message (quick replies:
 * reschedule / later / not interested) in the parent's concierge chat. One
 * per booking (winbackSentAt). If the parent stays silent for 48h, ONE
 * follow-up marker (winbackNudgedAt): admins get a ghosting-risk alert and
 * the parent gets an in-app + email nudge. Two touches max - never nagging.
 * Reply handling is deterministic in ai-router (winback bypass).
 */

const GRACE_MS = 30 * 60 * 1000;
const REBOOK_WINDOW_MS = 24 * 60 * 60 * 1000;
const SILENCE_NUDGE_MS = 48 * 60 * 60 * 1000;
// Don't win-back ancient history when this first runs against backlog.
const BACKLOG_CUTOFF_MS = 14 * 24 * 60 * 60 * 1000;

const sweepInclude = {
  providerUser: { include: { provider: { select: { id: true, name: true } }, scheduleConfig: { select: { bookingPageSlug: true } } } },
  parentUser: { select: { id: true, name: true, firstName: true, parentAccountId: true } },
} as const;

type SweepBooking = any;

function isGoStorkHouseBooking(booking: SweepBooking): boolean {
  const roles: string[] = booking.providerUser?.roles || [];
  const providerName = (booking.providerUser?.provider?.name || "").trim().toLowerCase();
  return providerName === "gostork" || roles.some((r) => String(r).startsWith("GOSTORK"));
}

function providerDisplayName(booking: SweepBooking): string {
  return booking.providerUser?.provider?.name || booking.providerUser?.name || "the provider";
}

/** The parent's own concierge (Eva) chat - same fallback chain as the lawyer intro. */
async function findEvaSessionForParent(prisma: PrismaService, parentUserId: string): Promise<string | null> {
  const me = await prisma.user.findUnique({ where: { id: parentUserId }, select: { parentAccountId: true } });
  const accountIds = me?.parentAccountId
    ? (await prisma.user.findMany({ where: { parentAccountId: me.parentAccountId }, select: { id: true } })).map((u) => u.id)
    : [parentUserId];
  const session =
    (await prisma.aiChatSession.findFirst({
      where: { userId: { in: accountIds }, providerId: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    })) ??
    (await prisma.aiChatSession.findFirst({
      where: { userId: { in: accountIds }, matchmakerId: { not: null }, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    }));
  return session?.id ?? null;
}

/**
 * Post the win-back message. kind: "no_show" (call never happened) or
 * "canceled" (canceled and not rebooked). Sets winbackSentAt + emits
 * WINBACK_SENT. The uiCardData.winback payload lets ai-router handle the
 * quick replies deterministically (incl. serving the reschedule calendar).
 */
async function sendWinback(prisma: PrismaService, booking: SweepBooking, kind: "no_show" | "canceled"): Promise<void> {
  if (!booking.parentUserId || booking.winbackSentAt) return;
  if (isGoStorkHouseBooking(booking)) return;

  const sessionId = await findEvaSessionForParent(prisma, booking.parentUserId);
  if (!sessionId) {
    console.log(`[winback] No Eva session for parent ${booking.parentUserId} - skipping booking ${booking.id}`);
    return;
  }

  const providerName = providerDisplayName(booking);
  const isMatchCall = booking.meetingSubtype === "MATCH_CALL";
  const callLabel = isMatchCall ? "Match Call" : "call";
  const content =
    kind === "no_show"
      ? `Looks like your ${callLabel} with ${providerName} didn't end up happening - no worries at all, these things come up. Want me to help you get it back on the books?`
      : `I saw your ${callLabel} with ${providerName} was canceled and a new time hasn't been set yet. Should we find a new time that works better?`;

  await prisma.aiChatMessage.create({
    data: {
      sessionId,
      role: "assistant",
      content,
      senderType: "ai",
      uiCardData: {
        quickReplies: ["Reschedule the call", "Something came up - later", "I'm no longer interested"],
        winback: {
          bookingId: booking.id,
          kind,
          providerId: booking.providerUser?.provider?.id || null,
          providerName,
          hostUserId: booking.providerUserId,
          hostName: booking.providerUser?.name || null,
          hostSlug: booking.providerUser?.scheduleConfig?.bookingPageSlug || null,
          meetingSubtype: booking.meetingSubtype || null,
        },
      },
    },
  });
  await prisma.aiChatSession.update({ where: { id: sessionId }, data: { updatedAt: new Date() } }).catch(() => {});
  await prisma.booking.update({ where: { id: booking.id }, data: { winbackSentAt: new Date() } });
  await emitJourneyEvent({
    eventType: "WINBACK_SENT",
    parentUserId: booking.parentUserId,
    providerId: booking.providerUser?.provider?.id || null,
    sessionId,
    bookingId: booking.id,
    metadata: { kind },
  });
  console.log(`[winback] Sent ${kind} win-back for booking ${booking.id} (${providerName}) in session ${sessionId}`);
}

export async function runCallOutcomeSweep(prisma: PrismaService, notifications: NotificationService): Promise<void> {
  const now = Date.now();
  const candidates = await prisma.booking.findMany({
    where: { status: "CONFIRMED", outcome: null, scheduledAt: { lte: new Date(now - GRACE_MS) } },
    include: sweepInclude as any,
    orderBy: { scheduledAt: "asc" },
    take: 200,
  });

  for (const booking of candidates) {
    try {
      const endMs = new Date(booking.scheduledAt).getTime() + (booking.duration || 30) * 60 * 1000;
      if (endMs + GRACE_MS > now) continue; // grace runs from the END of the slot

      const parentJoined = !!booking.parentJoinedMeetingAt;
      const providerJoined = !!booking.providerJoinedMeetingAt || !!booking.actualStartedAt;
      const isBacklogCall = now - endMs > BACKLOG_CUTOFF_MS;
      let outcome =
        booking.meetingType !== "video" ? "UNVERIFIED"
        : parentJoined && providerJoined ? "COMPLETED"
        : providerJoined ? "NO_SHOW_PARENT"
        : parentJoined ? "NO_SHOW_PROVIDER"
        : "NO_SHOW_BOTH";
      // Backlog calls predate reliable join telemetry - a missing stamp on a
      // months-old call means nothing. Never brand history as a no-show.
      if (isBacklogCall && outcome !== "COMPLETED") outcome = "UNVERIFIED";

      await prisma.booking.update({ where: { id: booking.id }, data: { outcome, outcomeAt: new Date() } });

      const isBacklog = isBacklogCall;
      const eventBase =
        outcome === "COMPLETED" ? "COMPLETED"
        : outcome === "NO_SHOW_PARENT" ? "NO_SHOW_PARENT"
        : outcome === "NO_SHOW_PROVIDER" ? "NO_SHOW_PROVIDER"
        : outcome === "NO_SHOW_BOTH" ? "NO_SHOW_BOTH"
        : null;
      if (eventBase) {
        await emitJourneyEvent({
          eventType: bookingEventType(eventBase as any, booking.meetingSubtype),
          parentUserId: booking.parentUserId,
          providerId: booking.providerUser?.provider?.id || null,
          bookingId: booking.id,
          metadata: { outcome, scheduledAt: booking.scheduledAt, backlog: isBacklog },
        });
      } else {
        await emitJourneyEvent({
          eventType: "CONSULTATION_ELAPSED_UNVERIFIED",
          parentUserId: booking.parentUserId,
          providerId: booking.providerUser?.provider?.id || null,
          bookingId: booking.id,
          metadata: { meetingType: booking.meetingType, backlog: isBacklog },
        });
      }
      console.log(`[call-outcome] Booking ${booking.id} -> ${outcome}${isBacklog ? " (backlog, no win-back)" : ""}`);
      if (isBacklog) continue;

      // Phase 8: a completed first call with a real provider unlocks the
      // review checkpoint - Eva asks in the parent's concierge chat
      // (internally idempotent per account+provider+stage).
      if (outcome === "COMPLETED" && booking.parentUserId && booking.providerUser?.provider?.id) {
        const provName = (booking.providerUser.provider.name || "").trim().toLowerCase();
        if (provName !== "gostork") {
          const { maybePostReviewPrompt } = await import("../../../review-prompts");
          await maybePostReviewPrompt({
            parentUserId: booking.parentUserId,
            providerId: booking.providerUser.provider.id,
            stage: "consult_completed",
          }).catch(() => {});
        }
      }

      // Parent didn't show (alone or both absent) -> Eva win-back.
      if (outcome === "NO_SHOW_PARENT" || outcome === "NO_SHOW_BOTH") {
        await sendWinback(prisma, booking, "no_show");
      }

      // Provider stood up the parent -> alert every GoStork admin.
      if (outcome === "NO_SHOW_PROVIDER") {
        const admins = await prisma.user.findMany({ where: { roles: { has: "GOSTORK_ADMIN" } }, select: { id: true } });
        for (const a of admins) {
          await prisma.inAppNotification.create({
            data: {
              userId: a.id,
              eventType: "PROVIDER_NO_SHOW",
              payload: {
                bookingId: booking.id,
                providerName: providerDisplayName(booking),
                parentName: booking.parentUser?.name || booking.attendeeName || "a parent",
                scheduledAt: booking.scheduledAt,
                message: `${providerDisplayName(booking)} did not join a scheduled call - the parent was waiting.`,
              },
            },
          }).catch(() => {});
        }
      }
    } catch (err: any) {
      console.error(`[call-outcome] Failed for booking ${booking.id}: ${err.message}`);
    }
  }
}

export async function runCanceledNotRebookedSweep(prisma: PrismaService): Promise<void> {
  const now = Date.now();
  const candidates = await prisma.booking.findMany({
    where: {
      status: "CANCELLED",
      winbackSentAt: null,
      parentUserId: { not: null },
      cancelledAt: { lte: new Date(now - REBOOK_WINDOW_MS), gte: new Date(now - BACKLOG_CUTOFF_MS) },
    },
    include: sweepInclude as any,
    take: 200,
  });

  for (const booking of candidates) {
    try {
      if (isGoStorkHouseBooking(booking)) continue;
      const orgProviderId = booking.providerUser?.provider?.id || null;

      // "Rebooked" = ANY newer live booking between this parent account and
      // any host of the same provider org (covers reschedules, which create
      // a fresh booking, and booking a different coordinator).
      const me = booking.parentUser?.parentAccountId
        ? (await prisma.user.findMany({ where: { parentAccountId: booking.parentUser.parentAccountId }, select: { id: true } })).map((u) => u.id)
        : [booking.parentUserId as string];
      const hostWhere = orgProviderId
        ? { providerUser: { providerId: orgProviderId } }
        : { providerUserId: booking.providerUserId };
      const rebooked = await prisma.booking.findFirst({
        where: {
          ...hostWhere,
          parentUserId: { in: me },
          createdAt: { gt: booking.cancelledAt! },
          status: { in: ["PENDING", "CONFIRMED"] },
        },
        select: { id: true },
      });
      if (rebooked) {
        // Quietly close the loop - no win-back needed, but stamp so we never re-scan.
        await prisma.booking.update({ where: { id: booking.id }, data: { winbackSentAt: new Date(0) } });
        continue;
      }

      await emitJourneyEvent({
        eventType: "CANCELED_NOT_REBOOKED",
        parentUserId: booking.parentUserId,
        providerId: orgProviderId,
        bookingId: booking.id,
        actorRole: booking.cancelledByRole === "provider" ? "provider" : "parent",
        metadata: { cancelledByRole: booking.cancelledByRole, meetingSubtype: booking.meetingSubtype || null },
      });
      await sendWinback(prisma, booking, "canceled");
    } catch (err: any) {
      console.error(`[canceled-rebook] Failed for booking ${booking.id}: ${err.message}`);
    }
  }
}

/**
 * 48h silence after a win-back: one ghosting-risk alert to admins + one
 * in-app/email nudge to the parent, then we stop (winbackNudgedAt gates).
 */
export async function runWinbackSilenceSweep(prisma: PrismaService, notifications: NotificationService): Promise<void> {
  const cutoff = new Date(Date.now() - SILENCE_NUDGE_MS);
  const silent = await prisma.booking.findMany({
    where: { winbackSentAt: { not: null, lte: cutoff, gt: new Date(0) }, winbackNudgedAt: null },
    include: sweepInclude as any,
    take: 100,
  });

  for (const booking of silent) {
    try {
      // Any recorded response or re-engagement ends the win-back quietly.
      const responded = await prisma.journeyEvent.findFirst({
        where: { bookingId: booking.id, eventType: { in: ["WINBACK_RESPONSE", "REENGAGED", "CHURN_REASON"] } },
        select: { id: true },
      });
      await prisma.booking.update({ where: { id: booking.id }, data: { winbackNudgedAt: new Date() } });
      if (responded) continue;

      const providerName = providerDisplayName(booking);
      const parentName = booking.parentUser?.name || booking.attendeeName || "A parent";

      // Ghosting-risk alert for every GoStork admin (shows in notifications +
      // the Needs Attention queue reads these).
      const admins = await prisma.user.findMany({ where: { roles: { has: "GOSTORK_ADMIN" } }, select: { id: true } });
      for (const a of admins) {
        await prisma.inAppNotification.create({
          data: {
            userId: a.id,
            eventType: "GHOSTING_RISK",
            payload: {
              bookingId: booking.id,
              parentUserId: booking.parentUserId,
              parentName,
              providerName,
              message: `${parentName} hasn't responded 48h after the win-back about their ${providerName} call.`,
            },
          },
        }).catch(() => {});
      }

      // One gentle nudge to the parent - in-app + branded email.
      if (booking.parentUserId) {
        await prisma.inAppNotification.create({
          data: {
            userId: booking.parentUserId,
            eventType: "WINBACK_NUDGE",
            payload: {
              bookingId: booking.id,
              providerName,
              message: `Whenever you're ready, we can find a new time with ${providerName} - just reply in your GoStork chat.`,
            },
          },
        }).catch(() => {});
        await notifications
          .sendWinbackNudgeEmail(booking)
          .catch((e: any) => console.error(`[winback] nudge email failed for ${booking.id}: ${e.message}`));
      }
      console.log(`[winback] 48h silence on booking ${booking.id} - admin ghosting alert + parent nudge sent`);
    } catch (err: any) {
      console.error(`[winback] Silence sweep failed for booking ${booking.id}: ${err.message}`);
    }
  }
}
