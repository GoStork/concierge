/**
 * GoStork remainder sweep.
 *
 * With the platform's Stripe payout schedule set to MANUAL (required -
 * see guard below), nothing leaves the Stripe balance automatically.
 * This scheduler implements the intended money flow explicitly:
 *
 *   parent pays $10,000 -> platform balance
 *   -> $9,000 transfer to the provider's Connect account (auto + retry ladder)
 *   -> $1,000 remainder (GoStork's fee) paid out to GoStork's bank HERE
 *
 * Each run pays out ONLY (available balance - outstanding provider
 * obligations), so provider money can never be swept into GoStork's bank
 * out of reach of transfers.create. Outstanding = every PAID invoice
 * whose provider transfer hasn't happened yet (deferred, failed, or the
 * provider isn't onboarded), regardless of why.
 *
 * Runs daily at 06:00 server time. Multi-container safe: the Stripe
 * payout uses a per-day idempotency key, so a duplicate container either
 * gets the same payout back or an idempotency error - never a double
 * payout. Skips (with a log) when the payout schedule isn't manual,
 * because then Stripe's own auto-sweep is active and paying out on top
 * of it would double-drain the balance.
 */
import * as cron from "node-cron";
import {
  retrievePlatformAvailableBalance,
  retrievePlatformPayoutSchedule,
  createPlatformPayout,
  isStripeConfigured,
} from "../../../stripe-service";

// Don't bother the bank with sweeps under $100.
const MIN_SWEEP_CENTS = 10_000;

let scheduledTask: cron.ScheduledTask | null = null;

export interface RemainderSweepResult {
  skipped?: string;
  available?: number;
  outstanding?: number;
  remainder?: number;
  payoutId?: string;
}

export async function runRemainderSweep(prisma: {
  invoice: { aggregate: (args: any) => Promise<any> };
}): Promise<RemainderSweepResult> {
  if (!isStripeConfigured()) return { skipped: "Stripe not configured" };

  const schedule = await retrievePlatformPayoutSchedule();
  if (schedule !== "manual") {
    return {
      skipped: `Platform payout schedule is "${schedule}" - Stripe already auto-sweeps the balance. Set Settings -> Business -> Payouts to Manual to activate the remainder sweep.`,
    };
  }

  const agg = await prisma.invoice.aggregate({
    where: {
      status: "PAID",
      stripeTransferId: null,
      bankPayoutCompletedAt: null,
      providerPayoutAmount: { gt: 0 },
    },
    _sum: { providerPayoutAmount: true },
  });
  const outstanding = agg._sum?.providerPayoutAmount || 0;
  const available = await retrievePlatformAvailableBalance("USD");
  const remainder = available - outstanding;

  if (remainder < MIN_SWEEP_CENTS) {
    return { available, outstanding, remainder, skipped: `Remainder ${remainder} below ${MIN_SWEEP_CENTS} cent minimum` };
  }

  const day = new Date().toISOString().slice(0, 10);
  const payout = await createPlatformPayout(remainder, "USD", `gostork-remainder-sweep-${day}`);
  console.log(
    `[remainder-sweep] Paid out ${remainder} cents to GoStork's bank (available=${available}, protected provider obligations=${outstanding}) - payout ${payout.id}`,
  );
  return { available, outstanding, remainder, payoutId: payout.id };
}

export function startRemainderSweepScheduler(prisma: { invoice: { aggregate: (args: any) => Promise<any> } }) {
  if (scheduledTask) {
    console.log("[remainder-sweep] Scheduler already running");
    return;
  }
  scheduledTask = cron.schedule("0 6 * * *", async () => {
    try {
      const r = await runRemainderSweep(prisma);
      if (r.skipped) console.log(`[remainder-sweep] Skipped: ${r.skipped}`);
    } catch (e: any) {
      console.error(`[remainder-sweep] Sweep failed: ${e?.message}`);
    }
  });
  console.log("[remainder-sweep] Scheduler started - daily 06:00, pays GoStork's fee remainder to the bank while protecting provider obligations");
}

export function stopRemainderSweepScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[remainder-sweep] Scheduler stopped");
  }
}
