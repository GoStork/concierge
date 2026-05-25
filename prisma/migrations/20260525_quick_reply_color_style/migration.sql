ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "quickReplyColorStyle" TEXT;
ALTER TABLE "SiteSettings" DROP COLUMN IF EXISTS "quickReplyBorderOpacity";
ALTER TABLE "SiteSettings" DROP COLUMN IF EXISTS "quickReplyBgOpacity";

ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "quickReplyColorStyle" TEXT;
ALTER TABLE "ProviderBrandSettings" DROP COLUMN IF EXISTS "quickReplyBorderOpacity";
ALTER TABLE "ProviderBrandSettings" DROP COLUMN IF EXISTS "quickReplyBgOpacity";
