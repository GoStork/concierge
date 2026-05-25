ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "quickReplyDeclineStyle" TEXT;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "quickReplyDeclineStyle" TEXT;
