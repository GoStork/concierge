-- Add quickReplyMultiStyle to brand settings (controls multi-choice unselected chip style)
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "quickReplyMultiStyle" TEXT;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "quickReplyMultiStyle" TEXT;
