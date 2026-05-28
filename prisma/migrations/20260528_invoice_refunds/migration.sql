-- Admin refund flow: when GoStork admin issues a refund through Stripe,
-- the charge.refunded webhook stamps these fields. Provider payout is
-- proportionally reversed via stripe.transfers.createReversal so the
-- platform doesn't eat the loss.

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "refundedAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "refundedAmount" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "refundReason" TEXT;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "refundNotes" TEXT;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "stripeRefundId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "payoutReversalId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "payoutReversedAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "payoutReversedAmount" INTEGER;
