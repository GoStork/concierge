/**
 * AT_CLEARANCE escrow check-in sweep.
 *
 * Replaces the old setTimeout-based scheduleClearanceFollowUps: both Macs
 * auto-restart the server on every push, so in-process timers with multi-week
 * horizons never fired. This sweep runs from the shared 10-minute scheduler
 * (pending-booking.scheduler.ts) and derives everything from durable state:
 *
 *   - Which invoices: medicalClearanceStatus PENDING on a live escrow
 *     (AUTHORIZED card hold, or PAID vault funds).
 *   - Which day we're on: now - (authorizedAt ?? paidAt).
 *   - What was already sent: InvoiceReminder rows (reminderType
 *     "clearance_day<N>"), written in the same transaction as the chat card.
 *
 * Check-in cadence around the agency's averageClearanceDays (default 30):
 * day avg-7, avg, avg+7, then every 14 days after that so a stuck escrow is
 * never silently forgotten. If the server was down across several
 * checkpoints, the parent gets ONE catch-up card (the latest), not a burst.
 *
 * Cross-process safety: the check + insert runs under a pg advisory xact
 * lock keyed per invoice - the local Mac and the iMac run this cron against
 * the same DB in the same second, and an app-level check alone would post
 * duplicate cards.
 */

import { prisma } from "../../../db";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEARANCE_DAYS = 30;
const OVERDUE_REPEAT_DAYS = 14;

/** Checkpoint days for a given average clearance duration, capped at `upTo`. */
function checkpointDays(avgDays: number, upTo: number): number[] {
  const days = new Set<number>([Math.max(1, avgDays - 7), avgDays, avgDays + 7]);
  for (let d = avgDays + 7 + OVERDUE_REPEAT_DAYS; d <= upTo; d += OVERDUE_REPEAT_DAYS) {
    days.add(d);
  }
  return Array.from(days).filter(d => d <= upTo).sort((a, b) => a - b);
}

export async function runClearanceCheckinSweep(): Promise<void> {
  // Both live escrow shapes of the hybrid flow:
  //   AUTHORIZED + PENDING - card hold (first ~6 days)
  //   PAID + PENDING       - vault (day-6 conversion or wire payment)
  // The clock anchors on when the escrow protection started: authorizedAt
  // for holds, paidAt for wire payments that never had a hold phase.
  const held = await prisma.invoice.findMany({
    where: { status: { in: ["AUTHORIZED", "PAID"] }, medicalClearanceStatus: "PENDING" },
    select: {
      id: true,
      sessionId: true,
      providerName: true,
      authorizedAt: true,
      paidAt: true,
      parentUser: { select: { firstName: true, name: true } },
      provider: { select: { averageClearanceDays: true } },
    },
  });
  if (held.length === 0) return;

  const now = Date.now();
  for (const inv of held) {
    try {
      const anchor = inv.authorizedAt ?? inv.paidAt;
      if (!anchor) continue;
      const daysSince = Math.floor((now - new Date(anchor).getTime()) / DAY_MS);
      const due = checkpointDays(inv.provider?.averageClearanceDays ?? DEFAULT_CLEARANCE_DAYS, daysSince);
      if (due.length === 0) continue;

      const lockKey = `clearance-checkin:${inv.id}`;
      await prisma.$transaction(async (tx) => {
        // $executeRaw, not $queryRaw: the lock function returns void, which
        // prisma's row deserializer rejects.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

        const sent = await tx.invoiceReminder.findMany({
          where: { invoiceId: inv.id, channel: "chat", reminderType: { startsWith: "clearance_day" } },
          select: { reminderType: true },
        });
        const sentTypes = new Set(sent.map(s => s.reminderType));
        const unsent = due.filter(d => !sentTypes.has(`clearance_day${d}`));
        if (unsent.length === 0) return;

        // Record EVERY missed checkpoint but post only the latest one - a
        // long downtime must not dump three stacked check-ins into the chat.
        await tx.invoiceReminder.createMany({
          data: unsent.map(d => ({ invoiceId: inv.id, channel: "chat", reminderType: `clearance_day${d}` })),
        });

        const parentName = inv.parentUser?.firstName || inv.parentUser?.name || "The parent";
        await tx.aiChatMessage.create({
          data: {
            sessionId: inv.sessionId,
            role: "assistant",
            content: `Just checking in on your journey with ${inv.providerName}. Has your surrogate passed her medical screening? Please let us know so we can process your payment and move to the next step.`,
            senderType: "system",
            senderName: "GoStork",
            uiCardType: "clearance_tracker",
            uiCardData: {
              invoiceId: inv.id,
              providerName: inv.providerName,
              parentName,
              medicalClearanceStatus: "PENDING",
              confirmAction: "CONFIRM_CLEARANCE",
              failAction: "REPORT_CLEARANCE_FAILURE",
              providerContent: `Checking in: has the surrogate matched with ${parentName} passed her medical screening yet? Once either of you confirms on this card, the held deposit is released to you.`,
            },
          },
        });
        console.log(`[clearance-checkin] Day ${Math.max(...unsent)} check-in posted for invoice ${inv.id}`);
      });
    } catch (err: any) {
      console.error(`[clearance-checkin] Sweep failed for invoice ${inv.id}: ${err.message}`);
    }
  }
}
