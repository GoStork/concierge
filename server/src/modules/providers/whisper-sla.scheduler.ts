import * as cron from "node-cron";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationService } from "../notifications/notification.service";
import { canSendProviderMessage } from "../../../../shared/roles";

/**
 * Auto-nudge providers who haven't answered a whisper Q&A on time.
 *
 * Three escalating stages, each fires exactly once per SilentQuery via
 * the *ReminderAt / escalatedAt columns:
 *   - 2h pending  -> first nudge (chat msg + email + SMS + in-app)
 *   - 24h pending -> second nudge (escalating tone)
 *   - 48h pending -> escalate to GoStork admins / concierge team
 *
 * Thresholds are constants here for now; can move to SiteSettings later
 * if providers want per-tenant SLA.
 */

const FIRST_NUDGE_MINUTES  = 2  * 60;
const SECOND_NUDGE_MINUTES = 24 * 60;
const ESCALATION_MINUTES   = 48 * 60;

let scheduledTask: cron.ScheduledTask | null = null;

export async function runWhisperSlaCheck(prisma: PrismaService, notifications: NotificationService) {
  const now = Date.now();

  const firstCutoff  = new Date(now - FIRST_NUDGE_MINUTES  * 60_000);
  const secondCutoff = new Date(now - SECOND_NUDGE_MINUTES * 60_000);
  const escalateCutoff = new Date(now - ESCALATION_MINUTES * 60_000);

  // Pull every PENDING whisper that could need *any* action this tick. We
  // resolve which stage applies per-row below to avoid three separate
  // queries that would each repeat the same provider/parent lookups.
  const pending = await prisma.silentQuery.findMany({
    where: { status: "PENDING", createdAt: { lte: firstCutoff } },
    include: {
      // Pull roles so we can filter to staff who can actually answer this
      // whisper - the right IP coordinator for this subjectType, or any
      // PROVIDER_ADMIN/DOCTOR/SCHEDULER. BILLING_MANAGER is blocked from
      // sending messages by chat-router, so nudging them is spam.
      provider: { select: { id: true, name: true, users: { select: { id: true, email: true, mobileNumber: true, roles: true } } } },
      parentUser: { select: { id: true, name: true, firstName: true } },
      // subjectType drives the coordinator-access check below.
      session: { select: { id: true, subjectType: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  for (const whisper of pending) {
    try {
      const ageMs = now - whisper.createdAt.getTime();
      const ageMinutes = Math.floor(ageMs / 60_000);

      const needsEscalation = whisper.createdAt <= escalateCutoff && !whisper.escalatedAt;
      const needsSecond     = whisper.createdAt <= secondCutoff   && !whisper.secondReminderAt;
      const needsFirst      = whisper.createdAt <= firstCutoff    && !whisper.firstReminderAt;

      if (!needsEscalation && !needsSecond && !needsFirst) continue;

      const parentName = whisper.parentUser?.name || whisper.parentUser?.firstName || "a prospective parent";
      const providerName = whisper.provider?.name || "your team";
      // Nudge only the staff who can actually answer this whisper. Mirrors
      // the gate at the /api/provider/concierge-sessions/:id/message
      // endpoint exactly via the shared canSendProviderMessage helper:
      //   1. subjectType access (e.g. IP_SURROGACY_COORDINATOR sees
      //      Surrogate sessions; IP_EGG_DONOR_COORDINATOR does not), AND
      //   2. at least one role that isn't BILLING_MANAGER-only.
      // So both Jered Mercer (PROVIDER_ADMIN) and Julia McConnell
      // (IP_SURROGACY_COORDINATOR + BILLING_MANAGER) get nudged on a
      // Surrogate whisper - both can answer.
      const subjectType = whisper.session?.subjectType || null;
      const notifiableUsers = (whisper.provider?.users || []).filter(u =>
        canSendProviderMessage((u.roles || []) as string[], subjectType)
      );
      const providerUserIds = notifiableUsers.map(u => u.id);
      if (providerUserIds.length === 0) {
        console.warn(`[whisper-sla] No notifiable staff for whisper ${whisper.id} (subjectType=${subjectType}). Skipping.`);
        continue;
      }

      // ESCALATION (48h+) - notify admins, leave a system msg in the session,
      // mark escalatedAt so we never do this twice for the same whisper.
      // Also backfill firstReminderAt/secondReminderAt for backlog whispers
      // that crossed the 48h threshold before this scheduler ran - otherwise
      // the next two ticks would fire FIRST + SECOND nudges and spam the
      // provider with three notifications in twenty minutes.
      if (needsEscalation) {
        const now = new Date();
        await prisma.silentQuery.update({
          where: { id: whisper.id },
          data: {
            escalatedAt: now,
            firstReminderAt: whisper.firstReminderAt ?? now,
            secondReminderAt: whisper.secondReminderAt ?? now,
            reminderCount: { increment: 1 },
          },
        });

        await prisma.aiChatMessage.create({
          data: {
            sessionId: whisper.sessionId,
            role: "assistant",
            content: `This question has been waiting ${formatAge(ageMinutes)} without a reply. GoStork has been notified and will follow up.`,
            senderType: "system",
            senderName: "GoStork",
          },
        }).catch(() => {});

        const admins = await prisma.user.findMany({
          where: { roles: { hasSome: ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE"] } },
          select: { id: true },
        });
        for (const admin of admins) {
          await prisma.inAppNotification.create({
            data: {
              userId: admin.id,
              eventType: "WHISPER_ESCALATED",
              payload: {
                whisperId: whisper.id,
                sessionId: whisper.sessionId,
                providerId: whisper.providerId,
                providerName,
                parentName,
                ageMinutes,
                questionPreview: whisper.questionText.slice(0, 160),
              },
            },
          }).catch(() => {});
        }

        await notifications.sendWhisperPendingReminder({
          providerUserIds,
          providerName,
          parentName,
          sessionId: whisper.sessionId,
          providerId: whisper.providerId,
          parentUserId: whisper.parentUserId,
          questionPreview: whisper.questionText,
          stage: "escalation",
          ageFormatted: formatAge(ageMinutes),
        }).catch(e => console.error(`[whisper-sla] escalation notify failed: ${e.message}`));

        console.log(`[whisper-sla] ESCALATED whisper ${whisper.id} (age ${ageMinutes}m)`);
        continue;
      }

      // SECOND NUDGE (24h) - also backfill firstReminderAt if missing.
      if (needsSecond) {
        const now = new Date();
        await prisma.silentQuery.update({
          where: { id: whisper.id },
          data: {
            secondReminderAt: now,
            firstReminderAt: whisper.firstReminderAt ?? now,
            reminderCount: { increment: 1 },
          },
        });

        await prisma.aiChatMessage.create({
          data: {
            sessionId: whisper.sessionId,
            role: "assistant",
            content: `Reminder: ${parentName} is still waiting for an answer (${formatAge(ageMinutes)}). The parent may move on if they don't hear back soon.`,
            senderType: "system",
            senderName: "GoStork",
          },
        }).catch(() => {});

        await notifications.sendWhisperPendingReminder({
          providerUserIds,
          providerName,
          parentName,
          sessionId: whisper.sessionId,
          providerId: whisper.providerId,
          parentUserId: whisper.parentUserId,
          questionPreview: whisper.questionText,
          stage: "second",
          ageFormatted: formatAge(ageMinutes),
        }).catch(e => console.error(`[whisper-sla] second nudge failed: ${e.message}`));

        for (const uid of providerUserIds) {
          await prisma.inAppNotification.create({
            data: {
              userId: uid,
              eventType: "WHISPER_PENDING_24H",
              payload: {
                whisperId: whisper.id,
                sessionId: whisper.sessionId,
                providerId: whisper.providerId,
                ageMinutes,
                questionPreview: whisper.questionText.slice(0, 160),
              },
            },
          }).catch(() => {});
        }

        console.log(`[whisper-sla] SECOND nudge whisper ${whisper.id} (age ${ageMinutes}m)`);
        continue;
      }

      // FIRST NUDGE (2h)
      if (needsFirst) {
        await prisma.silentQuery.update({
          where: { id: whisper.id },
          data: { firstReminderAt: new Date(), reminderCount: { increment: 1 } },
        });

        await prisma.aiChatMessage.create({
          data: {
            sessionId: whisper.sessionId,
            role: "assistant",
            content: `A prospective parent asked a question ${formatAge(ageMinutes)} ago and is waiting for an answer. Reply below - your answer is relayed by Eva and stays anonymous.`,
            senderType: "system",
            senderName: "GoStork",
          },
        }).catch(() => {});

        await notifications.sendWhisperPendingReminder({
          providerUserIds,
          providerName,
          parentName,
          sessionId: whisper.sessionId,
          providerId: whisper.providerId,
          parentUserId: whisper.parentUserId,
          questionPreview: whisper.questionText,
          stage: "first",
          ageFormatted: formatAge(ageMinutes),
        }).catch(e => console.error(`[whisper-sla] first nudge failed: ${e.message}`));

        for (const uid of providerUserIds) {
          await prisma.inAppNotification.create({
            data: {
              userId: uid,
              eventType: "WHISPER_PENDING_2H",
              payload: {
                whisperId: whisper.id,
                sessionId: whisper.sessionId,
                providerId: whisper.providerId,
                ageMinutes,
                questionPreview: whisper.questionText.slice(0, 160),
              },
            },
          }).catch(() => {});
        }

        console.log(`[whisper-sla] FIRST nudge whisper ${whisper.id} (age ${ageMinutes}m)`);
      }
    } catch (err: any) {
      console.error(`[whisper-sla] Failed for whisper ${whisper.id}: ${err.message}`);
    }
  }
}

function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}

export function startWhisperSlaScheduler(prisma: PrismaService, notifications: NotificationService) {
  if (scheduledTask) {
    console.log("[whisper-sla] Scheduler already running");
    return;
  }

  // Catch backlog at boot, then poll every 10 minutes.
  runWhisperSlaCheck(prisma, notifications).catch(err => {
    console.error(`[whisper-sla] Startup check error: ${err.message}`);
  });

  scheduledTask = cron.schedule("*/10 * * * *", async () => {
    try {
      await runWhisperSlaCheck(prisma, notifications);
    } catch (err: any) {
      console.error(`[whisper-sla] Cron error: ${err.message}`);
    }
  });

  console.log("[whisper-sla] Scheduler started - runs every 10 minutes (2h/24h/48h SLA)");
}

export function stopWhisperSlaScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[whisper-sla] Scheduler stopped");
  }
}
