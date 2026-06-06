-- Three admin-controlled chat bubble background colors.
-- All nullable; null falls back to brand defaults (primary/accent/secondary)
-- at apply-time in the client.

ALTER TABLE "SiteSettings"
  ADD COLUMN IF NOT EXISTS "chatBubbleOwnColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleAiColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleProviderColor" TEXT;

ALTER TABLE "ProviderBrandSettings"
  ADD COLUMN IF NOT EXISTS "chatBubbleOwnColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleAiColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleProviderColor" TEXT;
