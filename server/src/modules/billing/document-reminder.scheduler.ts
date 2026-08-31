/**
 * Automatic signing reminders for the two onboarding documents a provider
 * must execute: the GoStork Provider Service Agreement and the W-9.
 *
 * Ladder: day 3, day 7, day 10 after the send (requestedAt), max 3 reminders,
 * stopping the moment the document is signed (status leaves SENT) or the
 * agreement is superseded. Each reminder re-sends the request email with the
 * login-free guest link and reopens the Home-page task - exactly what the
 * admin's manual "Remind again" does.
 *
 * Cross-machine safety (both dev Macs run this cron): autoRemindCount is the
 * claim - the sweep increments it with an optimistic updateMany (count must
 * still equal what we read) BEFORE emailing, so two servers on the same tick
 * send once. The notification dedupe window is the second belt.
 */

import * as cron from "node-cron";
import { prisma } from "../../../db";
import { NotificationService } from "../notifications/notification.service";
import { notifyProviderAgreementProviderTurn } from "../../../pandadoc-service";
import { mintW9GuestToken } from "./w9.controller";
import { getBaseUrl } from "../../lib/get-base-url";

const THRESHOLD_DAYS = [3, 7, 10];
const DAY_MS = 24 * 60 * 60 * 1000;

function remindersDue(requestedAt: Date | null): number {
  if (!requestedAt) return 0;
  const days = (Date.now() - new Date(requestedAt).getTime()) / DAY_MS;
  return THRESHOLD_DAYS.filter((d) => days >= d).length;
}

export async function runDocumentReminderSweep(notifications: NotificationService): Promise<void> {
  const db = prisma as any;

  // ── Provider agreements awaiting the provider's signature ──
  try {
    const agreements = await db.providerAgreement.findMany({
      where: { status: "SENT", supersededAt: null, requestedAt: { not: null }, autoRemindCount: { lt: THRESHOLD_DAYS.length } },
      select: { id: true, providerId: true, requestedAt: true, autoRemindCount: true, requestedByUserId: true },
    });
    for (const a of agreements) {
      if (remindersDue(a.requestedAt) <= a.autoRemindCount) continue;
      const claimed = await db.providerAgreement.updateMany({
        where: { id: a.id, autoRemindCount: a.autoRemindCount },
        data: { autoRemindCount: a.autoRemindCount + 1 },
      });
      if (!claimed.count) continue; // the other machine got there first
      await notifyProviderAgreementProviderTurn(a.id, a.requestedByUserId || "system")
        .then(() => console.log(`[doc-reminders] Agreement reminder ${a.autoRemindCount + 1}/${THRESHOLD_DAYS.length} sent for provider ${a.providerId}`))
        .catch((e: any) => console.error(`[doc-reminders] Agreement reminder failed for ${a.id}: ${e?.message}`));
    }
  } catch (e: any) {
    console.error(`[doc-reminders] Agreement sweep failed: ${e?.message}`);
  }

  // ── W-9s awaiting signature ──
  try {
    const w9s = await db.providerW9.findMany({
      where: { status: "SENT", requestedAt: { not: null }, autoRemindCount: { lt: THRESHOLD_DAYS.length } },
      select: { id: true, providerId: true, requestedAt: true, autoRemindCount: true, requestedByUserId: true, guestToken: true, signerEmail: true, signerUserId: true },
    });
    for (const w of w9s) {
      if (remindersDue(w.requestedAt) <= w.autoRemindCount) continue;
      const claimed = await db.providerW9.updateMany({
        where: { id: w.id, autoRemindCount: w.autoRemindCount },
        data: { autoRemindCount: w.autoRemindCount + 1 },
      });
      if (!claimed.count) continue;
      try {
        const provider = await db.provider.findUnique({ where: { id: w.providerId }, select: { name: true, email: true } });
        const guestToken = await mintW9GuestToken(w.id, w.guestToken || null);
        await notifications.sendW9RequestNotification({
          providerId: w.providerId,
          providerName: provider?.name || "Provider",
          signingUrl: `${getBaseUrl()}/sign-w9/${guestToken}`,
          fallbackSigner: { userId: w.signerUserId, email: w.signerEmail || provider?.email || "", name: provider?.name || "" },
        });
        // Reopen the Home-page task the same way the manual remind does.
        const { raiseW9Task } = await import("./w9.controller");
        await raiseW9Task(w.providerId, w.requestedByUserId || "system");
        console.log(`[doc-reminders] W-9 reminder ${w.autoRemindCount + 1}/${THRESHOLD_DAYS.length} sent for provider ${w.providerId}`);
      } catch (e: any) {
        console.error(`[doc-reminders] W-9 reminder failed for ${w.id}: ${e?.message}`);
      }
    }
  } catch (e: any) {
    console.error(`[doc-reminders] W-9 sweep failed: ${e?.message}`);
  }
}

let scheduled: cron.ScheduledTask | null = null;

export function startDocumentReminderScheduler(notifications: NotificationService) {
  if (scheduled) return;
  // Hourly at :23 - the ladder is day-granular, hourly is plenty.
  scheduled = cron.schedule("23 * * * *", async () => {
    try {
      await runDocumentReminderSweep(notifications);
    } catch (e: any) {
      console.error(`[doc-reminders] sweep crashed: ${e?.message}`);
    }
  });
  console.log("[doc-reminders] Scheduler started (hourly, day 3/7/10 ladder)");
}
