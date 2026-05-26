-- New columns on ReferralFeeConfig
ALTER TABLE "ReferralFeeConfig"
  ADD COLUMN IF NOT EXISTS "parentPaysBasis" TEXT NOT NULL DEFAULT 'DEFAULT_FIRST_PAYMENT';

-- New columns on Invoice (snapshot the quote that was used + how the invoice was triggered)
ALTER TABLE "Invoice"
  ADD COLUMN IF NOT EXISTS "quotedTotalCostCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "providerQuoteId" TEXT,
  ADD COLUMN IF NOT EXISTS "triggerSource" TEXT NOT NULL DEFAULT 'PROVIDER_MANUAL';

-- ProviderQuote table (versioned history of every quote/cost sheet a provider sends a parent)
CREATE TABLE IF NOT EXISTS "ProviderQuote" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "parentUserId" TEXT NOT NULL,
  "totalCostCents" INTEGER NOT NULL,
  "costSheetFileUrl" TEXT,
  "costSheetFileName" TEXT,
  "notes" TEXT,
  "source" TEXT NOT NULL DEFAULT 'PROVIDER',
  "createdByUserId" TEXT,
  "supersededAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderQuote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ProviderQuote_sessionId_idx" ON "ProviderQuote"("sessionId");
CREATE INDEX IF NOT EXISTS "ProviderQuote_providerId_idx" ON "ProviderQuote"("providerId");
CREATE INDEX IF NOT EXISTS "ProviderQuote_sessionId_createdAt_idx" ON "ProviderQuote"("sessionId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ProviderQuote_sessionId_fkey') THEN
    ALTER TABLE "ProviderQuote" ADD CONSTRAINT "ProviderQuote_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "AiChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ProviderQuote_providerId_fkey') THEN
    ALTER TABLE "ProviderQuote" ADD CONSTRAINT "ProviderQuote_providerId_fkey"
      FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ProviderQuote_parentUserId_fkey') THEN
    ALTER TABLE "ProviderQuote" ADD CONSTRAINT "ProviderQuote_parentUserId_fkey"
      FOREIGN KEY ("parentUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ProviderQuote_createdByUserId_fkey') THEN
    ALTER TABLE "ProviderQuote" ADD CONSTRAINT "ProviderQuote_createdByUserId_fkey"
      FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'Invoice_providerQuoteId_fkey') THEN
    ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_providerQuoteId_fkey"
      FOREIGN KEY ("providerQuoteId") REFERENCES "ProviderQuote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- CostSheetReminder table (dedupe ledger for pre-meeting + post-readiness nudges)
CREATE TABLE IF NOT EXISTS "CostSheetReminder" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "bookingId" TEXT,
  "window" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CostSheetReminder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CostSheetReminder_sessionId_bookingId_window_key"
  ON "CostSheetReminder"("sessionId", "bookingId", "window");
CREATE INDEX IF NOT EXISTS "CostSheetReminder_sessionId_idx" ON "CostSheetReminder"("sessionId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'CostSheetReminder_sessionId_fkey') THEN
    ALTER TABLE "CostSheetReminder" ADD CONSTRAINT "CostSheetReminder_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "AiChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'CostSheetReminder_bookingId_fkey') THEN
    ALTER TABLE "CostSheetReminder" ADD CONSTRAINT "CostSheetReminder_bookingId_fkey"
      FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill: per your decision, existing PERCENTAGE configs auto-flip so the fee
-- starts being computed off the Total Quoted Cost (not the Default First Payment).
UPDATE "ReferralFeeConfig"
SET "parentPaysBasis" = 'TOTAL_COST'
WHERE "feeType" = 'PERCENTAGE';
