// Direct retry of pending payouts. Bypasses the HTTP admin layer and calls
// Stripe transfers.create the same way ConnectService.createTransferForPaidInvoice
// does. Useful for dev when you don't want to log in as admin.
//
// Usage:
//   npx tsx scripts/retry_payouts.ts                   # retry ALL pending
//   npx tsx scripts/retry_payouts.ts <invoiceId> ...   # retry specific ones

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import Stripe from "stripe";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const p = new PrismaClient({ adapter }) as any;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-04-22.dahlia" as any });

(async () => {
  let ids = process.argv.slice(2);
  if (ids.length === 0) {
    const rows = await p.invoice.findMany({
      where: { status: "PAID", stripeTransferId: null, payoutFailedAt: null },
      select: { id: true },
      orderBy: { paidAt: "desc" },
    });
    ids = rows.map((r: any) => r.id);
  }
  console.log(`Retrying ${ids.length} invoice(s)\n`);

  for (const id of ids) {
    const inv = await p.invoice.findUnique({
      where: { id },
      select: { id: true, providerId: true, providerPayoutAmount: true, currency: true, status: true, stripeTransferId: true },
    });
    if (!inv) { console.log(`${id}: not found`); continue; }
    if (inv.status !== "PAID") { console.log(`${id}: not PAID (status=${inv.status})`); continue; }
    if (inv.stripeTransferId) { console.log(`${id}: already has transfer ${inv.stripeTransferId}`); continue; }
    if (!inv.providerPayoutAmount || inv.providerPayoutAmount <= 0) { console.log(`${id}: zero payout, nothing to send`); continue; }

    const ba = await p.providerBankAccount.findUnique({ where: { providerId: inv.providerId } });
    if (!ba?.stripeConnectAccountId || !ba.payoutsEnabled) {
      console.log(`${id}: provider not ready (account=${ba?.stripeConnectAccountId || "null"} payoutsEnabled=${ba?.payoutsEnabled})`);
      continue;
    }

    try {
      const transfer = await stripe.transfers.create({
        amount: inv.providerPayoutAmount,
        currency: inv.currency || "usd",
        destination: ba.stripeConnectAccountId,
        transfer_group: inv.id,
        description: `GoStork payout for invoice ${inv.id} (manual retry)`,
        metadata: { invoiceId: inv.id, providerId: inv.providerId, retry: "scripted" },
      });
      await p.invoice.update({
        where: { id: inv.id },
        data: {
          stripeTransferId: transfer.id,
          payoutInitiatedAt: new Date(),
          payoutCompletedAt: new Date(),
          payoutFailedAt: null,
          payoutFailureReason: null,
        },
      });
      console.log(`${id}: TRANSFERRED ${transfer.id} (amount=${transfer.amount} ${transfer.currency})`);
    } catch (e: any) {
      const reason = (e?.message || "Unknown").slice(0, 240);
      await p.invoice.update({
        where: { id: inv.id },
        data: { payoutFailedAt: new Date(), payoutFailureReason: reason },
      });
      console.log(`${id}: FAILED - ${reason}`);
    }
  }
  process.exit(0);
})();
