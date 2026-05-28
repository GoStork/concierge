/**
 * Reversal recoupment monitor.
 *
 * When admin refunds a parent payment AFTER the provider's payout has
 * already landed in their bank, Stripe doesn't pull money out of the
 * provider's bank account. Instead, it creates a negative balance on the
 * connected account that gets recouped from the provider's future
 * incoming transfers. Until the negative balance is cleared, GoStork is
 * effectively extending uncollateralized credit to the provider.
 *
 * This scheduler periodically checks each at-risk invoice's connected
 * account balance via Stripe. When the available+pending balance is no
 * longer negative, the negative balance has been recouped (either by a
 * fresh parent payment to that provider or by manual coordination) and
 * we stamp payoutReversalRecoupedAt to clear the risk flag.
 *
 * Grouped by provider so one Stripe API call covers all that provider's
 * pending-recoup invoices. Runs every 30 minutes - recoupment isn't time
 * critical, but reasonable cadence so admins see resolution within an hour.
 */
import * as cron from "node-cron";
import { PrismaService } from "../prisma/prisma.service";
import { retrieveConnectAccountBalance } from "../../../stripe-service";

let scheduledTask: cron.ScheduledTask | null = null;

export async function runReversalRecoupCheck(prisma: PrismaService) {
  const atRiskInvoices = await prisma.invoice.findMany({
    where: {
      payoutReversalAtRisk: true,
      payoutReversalRecoupedAt: null,
    },
    select: {
      id: true,
      providerId: true,
      payoutReversedAmount: true,
    },
  });

  if (atRiskInvoices.length === 0) {
    console.log("[reversal-recoup] No at-risk invoices pending.");
    return;
  }

  // Group by provider so we make one Stripe API call per provider rather
  // than per invoice.
  const byProvider = new Map<string, typeof atRiskInvoices>();
  for (const inv of atRiskInvoices) {
    const arr = byProvider.get(inv.providerId) || [];
    arr.push(inv);
    byProvider.set(inv.providerId, arr);
  }

  console.log(`[reversal-recoup] Checking ${atRiskInvoices.length} at-risk invoice(s) across ${byProvider.size} provider(s)`);

  let cleared = 0;
  for (const [providerId, invs] of byProvider) {
    try {
      const bank = await prisma.providerBankAccount.findUnique({
        where: { providerId },
        select: { stripeConnectAccountId: true },
      });
      if (!bank?.stripeConnectAccountId) {
        console.warn(`[reversal-recoup] Provider ${providerId} has no Connect account on file; skipping`);
        continue;
      }
      const balance = await retrieveConnectAccountBalance(bank.stripeConnectAccountId);
      const total = balance.available + balance.pending;
      // Balance >= 0 means the negative balance has been offset (either by
      // organic activity or manual repayment). Stamp recouped on all this
      // provider's pending-recoup invoices in one shot.
      if (total >= 0) {
        const result = await prisma.invoice.updateMany({
          where: {
            providerId,
            payoutReversalAtRisk: true,
            payoutReversalRecoupedAt: null,
          },
          data: { payoutReversalRecoupedAt: new Date() },
        });
        cleared += result.count;
        console.log(`[reversal-recoup] Provider ${providerId}: balance=${total} cents, cleared ${result.count} invoice(s)`);
      } else {
        const totalAtRiskCents = invs.reduce((s, i) => s + (i.payoutReversedAmount || 0), 0);
        console.log(`[reversal-recoup] Provider ${providerId}: balance=${total} cents still negative; ${invs.length} invoice(s), ${totalAtRiskCents} cents at risk`);
      }
    } catch (e: any) {
      console.error(`[reversal-recoup] Provider ${providerId} check failed: ${e?.message}`);
    }
  }
  if (cleared > 0) console.log(`[reversal-recoup] Cleared ${cleared} invoice(s) this cycle`);
}

export function startReversalRecoupScheduler(prisma: PrismaService) {
  if (scheduledTask) {
    console.log("[reversal-recoup] Scheduler already running");
    return;
  }

  // Immediate startup pass so admins see fresh state on every deploy.
  runReversalRecoupCheck(prisma).catch((err) => {
    console.error("[reversal-recoup] Startup check error:", err.message);
  });

  // Every 30 minutes. Recoupment isn't time-critical; this is just to
  // surface "no longer at risk" to admins within roughly an hour.
  scheduledTask = cron.schedule("*/30 * * * *", async () => {
    try {
      await runReversalRecoupCheck(prisma);
    } catch (err: any) {
      console.error("[reversal-recoup] Cron job error:", err.message);
    }
  });

  console.log("[reversal-recoup] Scheduler started - runs every 30 minutes, immediate startup check enabled");
}

export function stopReversalRecoupScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[reversal-recoup] Scheduler stopped");
  }
}
