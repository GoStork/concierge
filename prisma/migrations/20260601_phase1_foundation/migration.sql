-- Phase 1 foundation: additive fields only. No removals, no behavior changes.

-- ProviderCostSheet: matching engine fields used by the Phase 2 auto-draft.
ALTER TABLE "ProviderCostSheet" ADD COLUMN IF NOT EXISTS "category"         TEXT;
ALTER TABLE "ProviderCostSheet" ADD COLUMN IF NOT EXISTS "description"      TEXT;
ALTER TABLE "ProviderCostSheet" ADD COLUMN IF NOT EXISTS "matchingRules"    JSONB;
ALTER TABLE "ProviderCostSheet" ADD COLUMN IF NOT EXISTS "lineItemTemplate" JSONB;

-- Surrogate: 24-hour reservation hold after a Match Call.
ALTER TABLE "Surrogate" ADD COLUMN IF NOT EXISTS "reservedByParentId"   TEXT;
ALTER TABLE "Surrogate" ADD COLUMN IF NOT EXISTS "reservationExpiresAt" TIMESTAMP(3);
DO $$ BEGIN
  ALTER TABLE "Surrogate" ADD CONSTRAINT "Surrogate_reservedByParentId_fkey"
    FOREIGN KEY ("reservedByParentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "Surrogate_reservedByParentId_idx" ON "Surrogate" ("reservedByParentId");

-- Provider: states the firm is licensed in (Legal Services Stage 3a match check).
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "statesLicensedIn" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- IntendedParentProfile: detected legal needs populated by AI for cost-sheet rule matching.
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "detectedLegalNeeds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AiChatSession: stage 13 handoff completion marker.
ALTER TABLE "AiChatSession" ADD COLUMN IF NOT EXISTS "handoffCompletedAt" TIMESTAMP(3);
