// One-off sandbox helper: tops up the platform's AVAILABLE test balance
// (charge with Stripe's tok_bypassPending token, which skips the pending
// ledger) and then retries every failed provider payout, exactly like the
// admin Home "Retry payout" button. Test mode only - refuses live keys.
// Usage: npx tsx scripts/topup-and-retry-payouts.ts [topupCents]
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { ConnectService } from "../server/src/modules/billing/connect.service";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import Stripe from "stripe";

(async () => {
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!/^(sk|rk)_test_/.test(key)) {
    console.error("Refusing to run: STRIPE_SECRET_KEY is not a test-mode key.");
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  const prisma = app.get(PrismaService);
  const connect = app.get(ConnectService);
  const stripe = new Stripe(key);

  const failed = await prisma.invoice.findMany({
    // Failed AND deferred (waiting on the auto-retry ladder) - both are
    // owed and both should fire once the balance is topped up.
    where: {
      status: "PAID",
      stripeTransferId: null,
      bankPayoutCompletedAt: null,
      OR: [{ payoutFailedAt: { not: null } }, { payoutNextAttemptAt: { not: null } }],
    },
    select: { id: true, providerPayoutAmount: true, provider: { select: { name: true } } },
  });
  const owed = failed.reduce((s, i) => s + (i.providerPayoutAmount || 0), 0);
  console.log(`Failed payouts: ${failed.length}, total owed ${owed} cents`);

  const topup = Number(process.argv[2]) || owed;
  if (topup > 0) {
    const charge = await stripe.charges.create({
      amount: topup,
      currency: "usd",
      source: "tok_bypassPending",
      description: "Sandbox top-up: settle failed provider payouts (bypasses pending balance)",
    });
    console.log(`Topped up available balance with ${topup} cents (charge ${charge.id})`);
  }

  for (const inv of failed) {
    await prisma.invoice.update({
      where: { id: inv.id },
      data: { payoutFailedAt: null, payoutFailureReason: null, payoutNextAttemptAt: null, payoutAttemptCount: 0 },
    });
    const r = await connect.createTransferForPaidInvoice(inv.id);
    console.log(`Invoice ${inv.id} (${inv.provider?.name}, ${inv.providerPayoutAmount} cents):`, JSON.stringify(r));
  }

  await app.close();
  process.exit(0);
})();
