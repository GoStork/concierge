-- Parent role bubble colors. The 3 prior sets (own/ai/provider) had no
-- explicit color for parent messages - they fell through to a tint of the
-- brand color. With this 4th set every chat role has its own colors, so a
-- provider viewing a parent's message (or staff viewing a 3-way) renders
-- with the parent palette instead of the auto tint.

ALTER TABLE "SiteSettings"
  ADD COLUMN IF NOT EXISTS "chatBubbleParentColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleParentTextColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleParentBorderColor" TEXT;

ALTER TABLE "ProviderBrandSettings"
  ADD COLUMN IF NOT EXISTS "chatBubbleParentColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleParentTextColor" TEXT,
  ADD COLUMN IF NOT EXISTS "chatBubbleParentBorderColor" TEXT;
