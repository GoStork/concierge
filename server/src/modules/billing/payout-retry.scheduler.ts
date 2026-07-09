/**
 * Automatic payout retry sweep.
 *
 * When an invoice flips to PAID we immediately try the platform-to-provider
 * transfer, but card funds settle into the platform's PENDING balance first
 * (~2 business days live, simulated in test mode). In that case
 * ConnectService.createTransferForPaidInvoice defers the payout: no failure
 * is stamped, payoutNextAttemptAt is set on the backoff ladder (2h, 8h,
 * 24h, 48h, 72h), and this scheduler re-fires the transfer when the time
 * comes. Only after the ladder is exhausted does the invoice become a real
 * failure that lands in the admin Needs-attention queue (where the manual
 * Retry button lives).
 *
 * Runs every 30 minutes. Multi-container safe: each due invoice is claimed
 * atomically (updateMany conditioned on payoutNextAttemptAt still being
 * due) so two containers can't double-fire the same transfer; Transfer
 * creation itself is additionally guarded by the stripeTransferId
 * idempotency check inside createTransferForPaidInvoice.
 */
import * as cron from "node-cron";
import { PrismaService } from "../prisma/prisma.service";
import type { ConnectService } from "./connect.service";

let scheduledTask: cron.ScheduledTask | null = null;

export async function runPayoutRetrySweep(prisma: PrismaService, connectService: ConnectService) {
  const now = new Date();

  // Adopt orphaned payouts: PAID invoices whose transfer was never even
  // attempted - no transfer, no failure stamp, no scheduled attempt.
  // Happens for invoices paid before auto-transfer existed, or if the
  // server died between the PAID transition and the transfer call.
  // Stamping payoutNextAttemptAt = now hands them to the normal ladder
  // below: attempt -> defer while funds settle -> real failure only
  // after the ladder is exhausted.
  const adopted = await prisma.invoice.updateMany({
    where: {
      status: "PAID",
      stripeTransferId: null,
      bankPayoutCompletedAt: null,
      providerPayoutAmount: { gt: 0 },
      payoutInitiatedAt: null,
      payoutFailedAt: null,
      payoutNextAttemptAt: null,
    },
    data: { payoutNextAttemptAt: now },
  });
  if (adopted.count > 0) {
    console.log(`[payout-retry] Adopted ${adopted.count} orphaned payout(s) that never had a transfer attempt`);
  }

  const due = await prisma.invoice.findMany({
    where: {
      status: "PAID",
      stripeTransferId: null,
      bankPayoutCompletedAt: null,
      payoutNextAttemptAt: { lte: now },
      providerPayoutAmount: { gt: 0 },
    },
    select: { id: true, payoutNextAttemptAt: true, providerPayoutAmount: true },
    orderBy: { payoutNextAttemptAt: "asc" },
    take: 25,
  });
  if (due.length === 0) return;

  console.log(`[payout-retry] ${due.length} payout(s) due for automatic retry`);
  for (const inv of due) {
    // Atomic claim: null out the schedule slot so a concurrent container
    // (or the next sweep) can't pick up the same invoice. If the attempt
    // defers again, createTransferForPaidInvoice re-stamps the next slot.
    const claimed = await prisma.invoice.updateMany({
      where: { id: inv.id, payoutNextAttemptAt: { lte: now, not: null } },
      data: { payoutNextAttemptAt: null },
    });
    if (claimed.count !== 1) continue;

    try {
      const result = await connectService.createTransferForPaidInvoice(inv.id);
      if (result.status === "transferred") {
        console.log(`[payout-retry] Invoice ${inv.id}: transfer ${result.transferId} succeeded on automatic retry`);
      } else if (result.status === "deferred") {
        console.log(`[payout-retry] Invoice ${inv.id}: still waiting for funds, next attempt ${result.nextAttemptAt.toISOString()}`);
      } else if (result.status === "failed") {
        console.error(`[payout-retry] Invoice ${inv.id}: retry failed - ${result.reason}`);
      } else {
        console.log(`[payout-retry] Invoice ${inv.id}: skipped (${result.message})`);
      }
    } catch (e: any) {
      console.error(`[payout-retry] Invoice ${inv.id}: retry raised unexpectedly - ${e?.message}`);
    }
  }
}

export function startPayoutRetryScheduler(prisma: PrismaService, connectService: ConnectService) {
  if (scheduledTask) {
    console.log("[payout-retry] Scheduler already running");
    return;
  }
  scheduledTask = cron.schedule("*/30 * * * *", async () => {
    try {
      await runPayoutRetrySweep(prisma, connectService);
    } catch (e: any) {
      console.error(`[payout-retry] Sweep failed: ${e?.message}`);
    }
  });
  console.log("[payout-retry] Scheduler started - retries deferred provider payouts every 30 minutes");
}

export function stopPayoutRetryScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[payout-retry] Scheduler stopped");
  }
}
