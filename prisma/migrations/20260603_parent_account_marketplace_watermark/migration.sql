-- Marketplace "New" badge watermark.
-- A profile shows the "New" badge to a parent iff:
--   profile.createdAt > parentAccount.marketplaceWatermarkAt
--   AND no row exists in ParentProfileView for this profile.
-- marketplaceWatermarkUpdatedAt records when the marketplace was last
-- opened; the 30-min sliding-session window logic uses this to decide
-- whether to slide marketplaceWatermarkAt on the next visit.

ALTER TABLE "ParentAccount"
  ADD COLUMN IF NOT EXISTS "marketplaceWatermarkAt"        TIMESTAMP(3);
ALTER TABLE "ParentAccount"
  ADD COLUMN IF NOT EXISTS "marketplaceWatermarkUpdatedAt" TIMESTAMP(3);
