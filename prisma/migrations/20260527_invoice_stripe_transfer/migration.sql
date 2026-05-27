-- Stripe Connect transfer tracking on Invoice. When an invoice flips to
-- PAID and the provider's ProviderBankAccount has payoutsEnabled=true,
-- GoStork calls stripe.transfers.create to push the provider's cut from
-- the platform balance to their connected account. We store the resulting
-- Transfer.id for tracing and a failure timestamp/reason if it errors.

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "stripeTransferId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "payoutFailedAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "payoutFailureReason" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_stripeTransferId_key"
  ON "Invoice" ("stripeTransferId");
