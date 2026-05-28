-- Recoupment tracking for transfer reversals that hit already-paid-out
-- invoices. Stripe doesn't pull from the provider's bank for these - it
-- creates a negative Connect balance recouped from future transfers.
-- A scheduler monitors and stamps recoupedAt when balance >= 0 again.

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "payoutReversalAtRisk" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "payoutReversalRecoupedAt" TIMESTAMP(3);

-- Partial index: the monitor only scans the small set of at-risk-but-not-
-- yet-recouped rows. Speeds up the scheduler so it doesn't full-scan
-- Invoice as the table grows.
CREATE INDEX IF NOT EXISTS "Invoice_recoupment_pending_idx"
  ON "Invoice"("providerId")
  WHERE "payoutReversalAtRisk" = TRUE AND "payoutReversalRecoupedAt" IS NULL;
