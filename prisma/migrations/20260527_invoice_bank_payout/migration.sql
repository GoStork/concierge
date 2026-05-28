-- Bank-side settlement tracking: when Stripe sweeps the connected account's
-- balance to the provider's actual bank account (payout.paid webhook on the
-- connected account), we stamp the invoices that the payout covered. Distinct
-- from the existing payoutFailedAt / payoutCompletedAt which track the
-- platform -> Connect Transfer step.

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "stripeConnectPaymentId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "stripeBankPayoutId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "bankPayoutCompletedAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "bankPayoutFailedAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "bankPayoutFailureReason" TEXT;

-- Unique because each platform Transfer has exactly one destination_payment.
-- Used by the payout.paid webhook to map back from py_xxx -> invoice.
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_stripeConnectPaymentId_key" ON "Invoice"("stripeConnectPaymentId");

-- Useful when reconciling a single Stripe Payout back to the set of invoices
-- it settled (the webhook handler does this lookup at write time, but admin
-- tooling will read by payout id too).
CREATE INDEX IF NOT EXISTS "Invoice_stripeBankPayoutId_idx" ON "Invoice"("stripeBankPayoutId");
