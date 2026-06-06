-- Optional outline (border) color for each of the 3 chat bubble types.
-- All nullable; null = no visible outline.

ALTER TABLE "SiteSettings"
  ADD COLUMN IF NOT EXISTS "chatBubbleOwnBorderColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleAiBorderColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleProviderBorderColor" TEXT;

ALTER TABLE "ProviderBrandSettings"
  ADD COLUMN IF NOT EXISTS "chatBubbleOwnBorderColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleAiBorderColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleProviderBorderColor" TEXT;
