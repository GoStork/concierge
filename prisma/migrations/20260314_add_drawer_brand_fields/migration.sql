-- AlterTable: Add drawer/slider brand sizing fields to SiteSettings
ALTER TABLE "SiteSettings"
  ADD COLUMN IF NOT EXISTS "drawerTitleSize" INTEGER,
  ADD COLUMN IF NOT EXISTS "drawerBodySize" INTEGER,
  ADD COLUMN IF NOT EXISTS "drawerHandleWidth" INTEGER,
  ADD COLUMN IF NOT EXISTS "sliderValueSize" INTEGER,
  ADD COLUMN IF NOT EXISTS "sliderThumbSize" INTEGER;

-- AlterTable: Add drawer/slider brand sizing fields to ProviderBrandSettings
ALTER TABLE "ProviderBrandSettings"
  ADD COLUMN IF NOT EXISTS "drawerTitleSize" INTEGER,
  ADD COLUMN IF NOT EXISTS "drawerBodySize" INTEGER,
  ADD COLUMN IF NOT EXISTS "drawerHandleWidth" INTEGER,
  ADD COLUMN IF NOT EXISTS "sliderValueSize" INTEGER,
  ADD COLUMN IF NOT EXISTS "sliderThumbSize" INTEGER;

-- Set Hinge-inspired defaults for GoStork rows
UPDATE "SiteSettings" SET
  "drawerTitleSize" = COALESCE("drawerTitleSize", 28),
  "drawerBodySize" = COALESCE("drawerBodySize", 16),
  "drawerHandleWidth" = COALESCE("drawerHandleWidth", 48),
  "sliderValueSize" = COALESCE("sliderValueSize", 24),
  "sliderThumbSize" = COALESCE("sliderThumbSize", 28);

UPDATE "ProviderBrandSettings" SET
  "drawerTitleSize" = COALESCE("drawerTitleSize", 28),
  "drawerBodySize" = COALESCE("drawerBodySize", 16),
  "drawerHandleWidth" = COALESCE("drawerHandleWidth", 48),
  "sliderValueSize" = COALESCE("sliderValueSize", 24),
  "sliderThumbSize" = COALESCE("sliderThumbSize", 28);
