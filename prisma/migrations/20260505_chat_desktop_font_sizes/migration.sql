ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "chatBubbleFontSizeDesktop" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "chatInputFontSizeDesktop" INTEGER;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "chatBubbleFontSizeDesktop" INTEGER;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "chatInputFontSizeDesktop" INTEGER;
