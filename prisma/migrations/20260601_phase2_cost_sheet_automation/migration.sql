-- Phase 2 cost sheet automation: per-provider feature flag + auto-draft
-- bookkeeping on ProviderQuote. All additive, no removals.

ALTER TABLE "Provider"      ADD COLUMN IF NOT EXISTS "autoFeaturesEnabled"  JSONB;

ALTER TABLE "ProviderQuote" ADD COLUMN IF NOT EXISTS "parentAcknowledgedAt" TIMESTAMP(3);
ALTER TABLE "ProviderQuote" ADD COLUMN IF NOT EXISTS "lineItems"            JSONB;
ALTER TABLE "ProviderQuote" ADD COLUMN IF NOT EXISTS "sourceCostSheetId"    TEXT;
ALTER TABLE "ProviderQuote" ADD COLUMN IF NOT EXISTS "autoDraftedAt"        TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "ProviderQuote_sourceCostSheetId_idx" ON "ProviderQuote" ("sourceCostSheetId");
