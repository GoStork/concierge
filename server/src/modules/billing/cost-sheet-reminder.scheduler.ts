import * as cron from "node-cron";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationService } from "../notifications/notification.service";

/**
 * Pre-meeting reminder for providers who haven't sent a cost sheet yet.
 *
 * Runs every 15 minutes and looks for upcoming consultation/match calls whose
 * (parent, provider) session has no active ProviderQuote, then nudges the
 * provider so the auto-invoice path doesn't get blocked when the parent
 * confirms readiness afterward.
 *
 * Two firing windows per booking, deduped via CostSheetReminder rows:
 *  - 24H_BEFORE: scheduledAt is 22-26h away
 *  - 1H_BEFORE:  scheduledAt is 45-75min away
 *
 * POST_READINESS_BLOCKED reminders are written by the chat-router auto-trigger
 * path, not here.
 */

let scheduledTask: cron.ScheduledTask | null = null;

const RELEVANT_SUBTYPES = ["DOCTOR_CONSULTATION", "MATCH_CALL"] as const;
const ACTIVE_STATUSES = ["PENDING", "CONFIRMED"] as const;

type ReminderWindow = "24H_BEFORE" | "1H_BEFORE";

interface WindowSpec {
  window: ReminderWindow;
  minMinutes: number;
  maxMinutes: number;
  reason: "pre_meeting_24h" | "pre_meeting_1h";
}

const WINDOWS: WindowSpec[] = [
  { window: "24H_BEFORE", minMinutes: 22 * 60, maxMinutes: 26 * 60, reason: "pre_meeting_24h" },
  { window: "1H_BEFORE",  minMinutes: 45,      maxMinutes: 75,      reason: "pre_meeting_1h"  },
];

export async function runCostSheetReminderCheck(prisma: PrismaService, notifications: NotificationService) {
  const now = Date.now();

  for (const spec of WINDOWS) {
    const earliest = new Date(now + spec.minMinutes * 60 * 1000);
    const latest = new Date(now + spec.maxMinutes * 60 * 1000);

    const bookings = await prisma.booking.findMany({
      where: {
        scheduledAt: { gte: earliest, lte: latest },
        meetingSubtype: { in: [...RELEVANT_SUBTYPES] },
        status: { in: [...ACTIVE_STATUSES] },
        parentUserId: { not: null },
      },
      include: {
        providerUser: { select: { id: true, providerId: true, provider: { select: { id: true, name: true } } } },
        parentUser: { select: { id: true, name: true, firstName: true } },
      },
    });

    for (const booking of bookings) {
      try {
        const providerId = booking.providerUser?.providerId;
        const parentUserId = booking.parentUserId;
        if (!providerId || !parentUserId) continue;

        // Find the (parent, provider) session.
        const session = await prisma.aiChatSession.findFirst({
          where: {
            userId: parentUserId,
            providerId,
            status: { in: ["PROVIDER_CONNECTED", "CONSULTATION_BOOKED"] },
          },
          orderBy: { updatedAt: "desc" },
          select: { id: true },
        });
        if (!session) continue;

        // If a quote already exists, no reminder needed.
        const activeQuote = await prisma.providerQuote.findFirst({
          where: { sessionId: session.id, supersededAt: null },
          select: { id: true },
        });
        if (activeQuote) continue;

        // Dedupe per (session, booking, window).
        const already = await prisma.costSheetReminder.findFirst({
          where: { sessionId: session.id, bookingId: booking.id, window: spec.window },
          select: { id: true },
        });
        if (already) continue;

        await prisma.costSheetReminder.create({
          data: { sessionId: session.id, bookingId: booking.id, window: spec.window },
        });

        // Provider members to notify (each user attached to this provider).
        const providerUsers = await prisma.user.findMany({
          where: { providerId },
          select: { id: true },
        });
        const providerUserIds = providerUsers.map(u => u.id);
        if (!providerUserIds.length) {
          console.warn(`[cost-sheet-reminder] No provider members for ${providerId}`);
          continue;
        }

        const meetingTimeFormatted = booking.scheduledAt.toLocaleString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
        const parentName = booking.parentUser?.name || booking.parentUser?.firstName || "the parent";
        const providerName = booking.providerUser?.provider?.name || "your client";

        // System chat message in the provider session.
        await prisma.aiChatMessage.create({
          data: {
            sessionId: session.id,
            role: "assistant",
            content:
              spec.window === "24H_BEFORE"
                ? `Reminder: your meeting with ${parentName} is in about 24 hours and no cost sheet has been sent yet. Send one so we can issue their invoice automatically when they're ready to proceed.`
                : `Heads up: your meeting with ${parentName} starts in about an hour and no cost sheet has been sent yet. Send one so we can invoice them right after the call.`,
            senderType: "system",
            senderName: "GoStork",
          },
        });

        await notifications.sendCostSheetMissingToProvider({
          providerUserIds,
          providerName,
          parentName,
          sessionId: session.id,
          providerId,
          parentUserId,
          reason: spec.reason,
          meetingTimeFormatted,
        });

        console.log(
          `[cost-sheet-reminder] ${spec.window} sent for booking ${booking.id} (session ${session.id})`,
        );
      } catch (err: any) {
        console.error(
          `[cost-sheet-reminder] Failed for booking ${booking.id}:`,
          err.message,
        );
      }
    }
  }
}

export function startCostSheetReminderScheduler(prisma: PrismaService, notifications: NotificationService) {
  if (scheduledTask) {
    console.log("[cost-sheet-reminder] Scheduler already running");
    return;
  }

  // Run once on startup so we catch anything already in the window when the server boots.
  runCostSheetReminderCheck(prisma, notifications).catch(err => {
    console.error("[cost-sheet-reminder] Startup check error:", err.message);
  });

  // Then every 15 minutes.
  scheduledTask = cron.schedule("*/15 * * * *", async () => {
    try {
      await runCostSheetReminderCheck(prisma, notifications);
    } catch (err: any) {
      console.error("[cost-sheet-reminder] Cron job error:", err.message);
    }
  });

  console.log("[cost-sheet-reminder] Scheduler started - runs every 15 minutes");
}

export function stopCostSheetReminderScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[cost-sheet-reminder] Scheduler stopped");
  }
}
