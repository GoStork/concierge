-- Payment schedules (installment plans) on provider cost sheets.
--
-- CORE INVARIANT: tranches never contribute to any total. The program total
-- stays derived from "CostItem" rows exactly as before; a tranche is a view
-- over money already counted. This migration therefore adds only new tables
-- and nullable columns - no existing total, matcher or invoice path changes.

-- Sheet-level payment terms + the parent-visibility trust gate.
ALTER TABLE "ProviderCostSheet" ADD COLUMN IF NOT EXISTS "paymentTerms" JSONB;
ALTER TABLE "ProviderCostSheet" ADD COLUMN IF NOT EXISTS "scheduleSource" TEXT;

-- Recurring / drip payments described on a single line item (pattern F:
-- "10 monthly installments after fetal heartbeat", "$300/month from week 26").
ALTER TABLE "CostItem" ADD COLUMN IF NOT EXISTS "recurrence" JSONB;

-- One payment in the installment plan.
CREATE TABLE IF NOT EXISTS "CostTranche" (
  "id"                  TEXT NOT NULL,
  "providerCostSheetId" TEXT NOT NULL,
  "sortOrder"           INTEGER NOT NULL DEFAULT 0,
  "name"                TEXT NOT NULL,
  "triggerType"         TEXT NOT NULL DEFAULT 'OTHER',
  "triggerLabel"        TEXT,
  "offsetDays"          INTEGER,
  "offsetBasis"         TEXT DEFAULT 'CALENDAR',
  "offsetDirection"     TEXT DEFAULT 'AFTER',
  "minValueCents"       INTEGER,
  "maxValueCents"       INTEGER,
  "amountBasis"         TEXT NOT NULL DEFAULT 'STATED',
  "payTo"               TEXT NOT NULL DEFAULT 'PROVIDER',
  "payToLabel"          TEXT,
  "isRefundable"        BOOLEAN,
  "refundNote"          TEXT,
  "notes"               TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CostTranche_pkey" PRIMARY KEY ("id")
);

-- Join between a line item and the tranche(s) that pay for it. Many-to-many
-- with amounts: one fee is routinely split across several tranches and one
-- tranche holds parts of several items.
CREATE TABLE IF NOT EXISTS "CostItemPayment" (
  "id"            TEXT NOT NULL,
  "costItemId"    TEXT NOT NULL,
  "trancheId"     TEXT NOT NULL,
  "minValueCents" INTEGER,
  "maxValueCents" INTEGER,
  "percent"       DOUBLE PRECISION,
  "label"         TEXT,
  "sortOrder"     INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "CostItemPayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CostTranche_providerCostSheetId_sortOrder_idx"
  ON "CostTranche"("providerCostSheetId", "sortOrder");

CREATE UNIQUE INDEX IF NOT EXISTS "CostItemPayment_costItemId_trancheId_key"
  ON "CostItemPayment"("costItemId", "trancheId");

CREATE INDEX IF NOT EXISTS "CostItemPayment_trancheId_idx"
  ON "CostItemPayment"("trancheId");

DO $$ BEGIN
  ALTER TABLE "CostTranche"
    ADD CONSTRAINT "CostTranche_providerCostSheetId_fkey"
    FOREIGN KEY ("providerCostSheetId") REFERENCES "ProviderCostSheet"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CostItemPayment"
    ADD CONSTRAINT "CostItemPayment_costItemId_fkey"
    FOREIGN KEY ("costItemId") REFERENCES "CostItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CostItemPayment"
    ADD CONSTRAINT "CostItemPayment_trancheId_fkey"
    FOREIGN KEY ("trancheId") REFERENCES "CostTranche"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Snapshot of the installment plan as it stood when a quote was SENT. Not a
-- live reference: a parent acts on the schedule they were shown, so later
-- edits to the provider's sheet must not rewrite a quote already delivered.
ALTER TABLE "ProviderQuote" ADD COLUMN IF NOT EXISTS "paymentSchedule" JSONB;
