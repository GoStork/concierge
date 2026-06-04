-- Drop the confirm-classification tracking columns from ProviderCostSheet.
-- The UI no longer surfaces a Confirm action; the admin's saved Fixed-Cost
-- value is authoritative, so the source-of-write tracking and legacy review
-- flag are no longer needed.
ALTER TABLE "ProviderCostSheet" DROP COLUMN IF EXISTS "isFixedCostSource";
ALTER TABLE "ProviderCostSheet" DROP COLUMN IF EXISTS "legacyNeedsReview";
