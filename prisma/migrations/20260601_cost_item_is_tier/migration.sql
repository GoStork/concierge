-- Adds the isTier flag to CostItem so the parser can distinguish tiered
-- pricing alternatives (Single Cycle / Two Cycles / Unlimited Transfers etc.)
-- from regular additive line items. Existing rows default to false so
-- nothing changes behavior until the AI starts tagging tiers on new uploads.
ALTER TABLE "CostItem" ADD COLUMN IF NOT EXISTS "isTier" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "CostItem_isTier_idx" ON "CostItem" ("isTier") WHERE "isTier" = true;
