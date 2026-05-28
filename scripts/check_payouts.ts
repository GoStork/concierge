import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const p = new PrismaClient({ adapter }) as any;

(async () => {
  const invs = await p.invoice.findMany({
    where: { status: "PAID", stripeTransferId: null, payoutFailedAt: null },
    select: {
      id: true,
      providerId: true,
      providerPayoutAmount: true,
      paidAt: true,
      provider: { select: { name: true } },
    },
    orderBy: { paidAt: "desc" },
    take: 6,
  });
  console.log(`\nPending payouts (PAID, no transfer, no failure): ${invs.length}`);
  for (const i of invs) console.log(`  ${i.id} | ${i.provider?.name} | payout=${i.providerPayoutAmount} | paid=${i.paidAt?.toISOString()}`);

  if (invs[0]) {
    const ba = await p.providerBankAccount.findUnique({ where: { providerId: invs[0].providerId } });
    console.log(`\nProvider bank account for "${invs[0].provider?.name}":`);
    if (!ba) {
      console.log("  NONE - provider has not connected a Stripe Connect account yet");
    } else {
      console.log(`  stripeConnectAccountId: ${ba.stripeConnectAccountId || "NULL"}`);
      console.log(`  payoutsEnabled:        ${ba.payoutsEnabled}`);
      console.log(`  chargesEnabled:        ${ba.chargesEnabled}`);
      console.log(`  detailsSubmitted:      ${ba.detailsSubmitted}`);
      console.log(`  onboardingStatus:      ${ba.onboardingStatus}`);
    }
  }

  const failed = await p.invoice.findMany({
    where: { status: "PAID", payoutFailedAt: { not: null } },
    select: { id: true, payoutFailureReason: true, payoutFailedAt: true },
    orderBy: { payoutFailedAt: "desc" },
    take: 3,
  });
  console.log(`\nRecent failed payouts: ${failed.length}`);
  for (const f of failed) console.log(`  ${f.id}: ${f.payoutFailureReason}`);
  process.exit(0);
})();
