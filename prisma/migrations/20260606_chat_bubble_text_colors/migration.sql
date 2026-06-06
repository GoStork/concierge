-- Admin-controlled text (foreground) color for each of the 3 chat bubble
-- types. All nullable; null = auto-pick text color from background luminance.

ALTER TABLE "SiteSettings"
  ADD COLUMN IF NOT EXISTS "chatBubbleOwnTextColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleAiTextColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleProviderTextColor" TEXT;

ALTER TABLE "ProviderBrandSettings"
  ADD COLUMN IF NOT EXISTS "chatBubbleOwnTextColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleAiTextColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleProviderTextColor" TEXT;
