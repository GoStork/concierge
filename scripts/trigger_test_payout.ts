// One-shot: triggers a test-mode bank payout on a connected account so we
// can verify the payout.paid webhook flips invoices to "Received" in the UI.
// In live mode, Stripe runs the payout schedule automatically (default: daily
// 2-day rolling); in test mode you usually have to kick it manually because
// Stripe doesn't always run the schedule on the sandbox account.
//
// Usage:
//   npx tsx scripts/trigger_test_payout.ts <providerId>
//     - Resolves provider -> stripeConnectAccountId, fetches the connected
//       account's available balance, creates a payout for that amount.
//   npx tsx scripts/trigger_test_payout.ts --account acct_xxx [--amount 5000]
//     - Direct mode: use the Stripe account id. Optional --amount in cents
//       (defaults to the full available balance).
//
// Note: requires a Stripe key with payouts.create permission on the
// connected account. The platform's restricted key works for this since
// payouts on connected accounts are a platform-level capability.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import Stripe from "stripe";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter }) as any;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-04-22.dahlia" as any });

const fmt = (cents: number, currency: string = "usd") =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: currency.toUpperCase() });

(async () => {
  const args = process.argv.slice(2);
  let accountId: string | null = null;
  let amountCents: number | null = null;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--account" && args[i + 1]) {
      accountId = args[i + 1];
      i++;
    } else if (args[i] === "--amount" && args[i + 1]) {
      amountCents = parseInt(args[i + 1], 10);
      i++;
    } else if (!accountId && !args[i].startsWith("--")) {
      // Positional providerId
      const ba = await prisma.providerBankAccount.findUnique({
        where: { providerId: args[i] },
        select: { stripeConnectAccountId: true, provider: { select: { name: true } } },
      });
      if (!ba?.stripeConnectAccountId) {
        console.error(`No Connect account on file for provider ${args[i]}`);
        process.exit(1);
      }
      accountId = ba.stripeConnectAccountId;
      console.log(`Provider "${ba.provider?.name}" -> ${accountId}`);
    }
  }

  if (!accountId) {
    console.error("Usage: trigger_test_payout.ts <providerId> | --account acct_xxx [--amount cents]");
    process.exit(1);
  }

  // Read the connected account's current balance. SDK v7 requires an
  // explicit (empty) params object before the request options.
  const balance = await stripe.balance.retrieve({}, { stripeAccount: accountId });
  const available = (balance.available || []).reduce((s, a) => s + a.amount, 0);
  const pending = (balance.pending || []).reduce((s, a) => s + a.amount, 0);
  const currency = balance.available?.[0]?.currency || "usd";
  console.log(`Connected account balance: available=${fmt(available, currency)} pending=${fmt(pending, currency)}`);

  if (available <= 0) {
    console.error("No available balance to pay out. Pending funds can't be paid out yet (they haven't settled).");
    process.exit(1);
  }

  const amount = amountCents ?? available;
  if (amount > available) {
    console.error(`Requested amount ${fmt(amount, currency)} exceeds available balance ${fmt(available, currency)}`);
    process.exit(1);
  }

  console.log(`Creating payout for ${fmt(amount, currency)}...`);
  const payout = await stripe.payouts.create(
    {
      amount,
      currency,
      description: "GoStork dev: scripted test payout",
      metadata: { scripted: "true", trigger: "trigger_test_payout.ts" },
    },
    { stripeAccount: accountId },
  );
  console.log(`Created payout ${payout.id} status=${payout.status} arrival=${payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString() : "n/a"}`);

  // In test mode the payout sits as `pending` until the arrival_date (which
  // can be hours away). Stripe exposes a test_helpers endpoint that forces
  // the payout to `paid` immediately so we don't have to wait. This fires
  // the payout.paid webhook on the connected account, which our handler
  // then uses to stamp bankPayoutCompletedAt on the bundled invoices.
  console.log("Forcing payout to 'paid' via test_helpers...");
  try {
    const paid = await (stripe.testHelpers as any).payouts.pay(payout.id, undefined, { stripeAccount: accountId });
    console.log(`Payout ${paid.id} now status=${paid.status}. Watch server logs for payout.paid webhook (usually <5s).`);
  } catch (e: any) {
    console.error(`test_helpers.payouts.pay failed: ${e?.message}`);
    console.error("If your restricted key lacks 'rak_payout_write' or test helpers, the payout will still pay out on its arrival date automatically.");
  }
  process.exit(0);
})();
