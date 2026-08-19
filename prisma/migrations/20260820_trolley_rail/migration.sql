-- International payout rail (Trolley)
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "trolleyRecipientId" TEXT;
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "trolleyRecipientStatus" TEXT;
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "trolleyPayoutMethodReady" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "trolleyPayoutCurrency" TEXT;
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "trolleyTaxFormStatus" TEXT;
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "trolleyLastSyncAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderBankAccount_trolleyRecipientId_key" ON "ProviderBankAccount"("trolleyRecipientId");
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "trolleyPaymentId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "trolleyBatchId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "trolleyPaymentStatus" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_trolleyPaymentId_key" ON "Invoice"("trolleyPaymentId");
CREATE TABLE IF NOT EXISTS "TrolleyWebhookEvent" (
  "id" TEXT PRIMARY KEY,
  "deliveryId" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'received',
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "TrolleyWebhookEvent_deliveryId_key" ON "TrolleyWebhookEvent"("deliveryId");
