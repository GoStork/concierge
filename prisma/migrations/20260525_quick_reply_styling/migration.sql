ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "quickReplyFontSize" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "quickReplyRadius" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "quickReplyPaddingX" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "quickReplyPaddingY" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "quickReplyBorderOpacity" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "quickReplyBgOpacity" INTEGER;

ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "quickReplyFontSize" INTEGER;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "quickReplyRadius" INTEGER;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "quickReplyPaddingX" INTEGER;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "quickReplyPaddingY" INTEGER;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "quickReplyBorderOpacity" INTEGER;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "quickReplyBgOpacity" INTEGER;
