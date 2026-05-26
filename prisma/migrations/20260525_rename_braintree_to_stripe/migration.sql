-- Rename Invoice columns from braintree* to stripe* (data preserved).
-- These columns have been storing Stripe IDs for some time; this just aligns the names.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Invoice' AND column_name = 'braintreeTransactionId'
  ) THEN
    ALTER TABLE "Invoice" RENAME COLUMN "braintreeTransactionId" TO "stripeTransactionId";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Invoice' AND column_name = 'braintreeAuthorizationId'
  ) THEN
    ALTER TABLE "Invoice" RENAME COLUMN "braintreeAuthorizationId" TO "stripePaymentIntentId";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Invoice' AND column_name = 'braintreePaymentLinkUrl'
  ) THEN
    ALTER TABLE "Invoice" RENAME COLUMN "braintreePaymentLinkUrl" TO "stripePaymentLinkUrl";
  END IF;
END $$;

-- Keep the unique index aligned with the renamed column.
ALTER INDEX IF EXISTS "Invoice_braintreeTransactionId_key" RENAME TO "Invoice_stripeTransactionId_key";
