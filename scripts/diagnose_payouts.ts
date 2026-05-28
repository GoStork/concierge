import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import Stripe from "stripe";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const p = new PrismaClient({ adapter }) as any;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-04-22.dahlia" as any });

const fmt = (cents: number, cur = "usd") =>
  `${(cents / 100).toLocaleString("en-US", { style: "currency", currency: cur.toUpperCase() })}`;

(async () => {
  console.log("=== Stripe platform balance ===");
  try {
    const bal = await stripe.balance.retrieve();
    for (const a of bal.available) console.log(`  available: ${fmt(a.amount, a.currency)}`);
    for (const a of bal.pending)   console.log(`  pending:   ${fmt(a.amount, a.currency)}`);
    if (bal.instant_available) for (const a of bal.instant_available) console.log(`  instant:   ${fmt(a.amount, a.currency)}`);
  } catch (e: any) {
    console.log(`  (could not read - restricted key, check dashboard.stripe.com/test/balance for live numbers): ${e?.message?.slice(0, 120)}`);
  }

  console.log("\n=== Looking at the 6 Pending invoices ===");
  const pendingInvs = await p.invoice.findMany({
    where: { status: "PAID", stripeTransferId: null, payoutFailedAt: null },
    select: {
      id: true, providerId: true, providerPayoutAmount: true, currency: true,
      stripeTransactionId: true, paidAt: true,
      provider: { select: { name: true } },
    },
    orderBy: { paidAt: "desc" },
  });
  console.log(`Found ${pendingInvs.length} pending\n`);

  for (const inv of pendingInvs) {
    console.log(`--- ${inv.id} (${inv.provider?.name}) payout=${fmt(inv.providerPayoutAmount, inv.currency || "usd")} paid=${inv.paidAt?.toISOString()}`);
    // Look up the actual PaymentIntent and its charge to see WHICH card funded it
    if (inv.stripeTransactionId) {
      try {
        const pi = await stripe.paymentIntents.retrieve(inv.stripeTransactionId, { expand: ["latest_charge.balance_transaction"] });
        const ch: any = pi.latest_charge as any;
        const bt: any = ch?.balance_transaction;
        const card: any = ch?.payment_method_details?.card;
        console.log(`    PaymentIntent: ${pi.id} status=${pi.status} amount=${fmt(pi.amount, pi.currency)}`);
        console.log(`    Card: brand=${card?.brand} last4=${card?.last4}`);
        console.log(`    BalanceTxn: ${bt?.id} status=${bt?.status} available_on=${bt?.available_on ? new Date(bt.available_on * 1000).toISOString() : "n/a"} net=${bt ? fmt(bt.net, bt.currency) : "n/a"}`);
      } catch (e: any) {
        console.log(`    Could not load PaymentIntent ${inv.stripeTransactionId}: ${e?.message}`);
      }
    } else {
      console.log(`    NO stripeTransactionId on invoice - this invoice was marked PAID by something other than Stripe (manual mark? bank transfer? test data?)`);
    }
  }

  console.log("\nDone (no transfers attempted - this is read-only). Run retry_payouts.ts to actually retry.");
  process.exit(0);
})();
