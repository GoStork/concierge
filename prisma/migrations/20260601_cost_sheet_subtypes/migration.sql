-- Cost-sheet subtype overhaul: 4 tabs / 10 subtypes, kill matchingRules,
-- add Fixed-vs-Not-Fixed metadata, flag legacy rows for review.
-- Also adds User.partnerGender to power composite family-type matching.

-- 1. User.partnerGender (nullable; backfill from onboarding answer)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "partnerGender" TEXT;

-- 2. CostProgram: tab column to mirror subType's parent tab for fast filtering
ALTER TABLE "CostProgram" ADD COLUMN IF NOT EXISTS "tab" TEXT;

-- 3. ProviderCostSheet: tab + Fixed-cost metadata + legacy review flag
ALTER TABLE "ProviderCostSheet" ADD COLUMN IF NOT EXISTS "tab" TEXT;
ALTER TABLE "ProviderCostSheet" ADD COLUMN IF NOT EXISTS "isFixedCost" BOOLEAN;
ALTER TABLE "ProviderCostSheet" ADD COLUMN IF NOT EXISTS "isFixedCostSource" TEXT;
ALTER TABLE "ProviderCostSheet" ADD COLUMN IF NOT EXISTS "legacyNeedsReview" BOOLEAN NOT NULL DEFAULT false;

-- 4. Migrate existing subType values to the new 10-id enum + auto-default
--    legacy ivf_cycle -> ivf_cycle_own_eggs_own_carry
--    legacy shipping_embryos -> shipping_embryos_to_self
--    Flag every migrated row as needing clinic re-confirmation.

UPDATE "ProviderCostSheet"
   SET "tab" = 'ivf_cycle',
       "subType" = 'ivf_cycle_own_eggs_own_carry',
       "legacyNeedsReview" = true
 WHERE "subType" = 'ivf_cycle' OR "subType" IS NULL;

UPDATE "ProviderCostSheet"
   SET "tab" = 'shipping_embryos',
       "subType" = 'shipping_embryos_to_self',
       "legacyNeedsReview" = true
 WHERE "subType" = 'shipping_embryos';

UPDATE "CostProgram"
   SET "tab" = 'ivf_cycle',
       "subType" = 'ivf_cycle_own_eggs_own_carry'
 WHERE "subType" = 'ivf_cycle' OR "subType" IS NULL;

UPDATE "CostProgram"
   SET "tab" = 'shipping_embryos',
       "subType" = 'shipping_embryos_to_self'
 WHERE "subType" = 'shipping_embryos';

-- 5. Drop the Phase-1 manual matchingRules column. Matching is now derived
--    automatically from subType + parent profile state.
ALTER TABLE "ProviderCostSheet" DROP COLUMN IF EXISTS "matchingRules";

-- 6. Indexes for the new lookup paths
CREATE INDEX IF NOT EXISTS "ProviderCostSheet_tab_subType_status_idx"
    ON "ProviderCostSheet" ("tab", "subType", "status");

CREATE INDEX IF NOT EXISTS "ProviderCostSheet_legacyNeedsReview_idx"
    ON "ProviderCostSheet" ("legacyNeedsReview")
    WHERE "legacyNeedsReview" = true;

CREATE INDEX IF NOT EXISTS "CostProgram_providerId_tab_subType_idx"
    ON "CostProgram" ("providerId", "tab", "subType");
