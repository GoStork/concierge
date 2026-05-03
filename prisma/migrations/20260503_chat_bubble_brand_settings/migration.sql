ALTER TABLE "BrandSettings" ADD COLUMN IF NOT EXISTS "chatBubbleFontSize" INTEGER;
ALTER TABLE "BrandSettings" ADD COLUMN IF NOT EXISTS "chatBubbleLineHeight" DOUBLE PRECISION;
ALTER TABLE "BrandSettings" ADD COLUMN IF NOT EXISTS "chatBubblePaddingX" INTEGER;
ALTER TABLE "BrandSettings" ADD COLUMN IF NOT EXISTS "chatBubblePaddingY" INTEGER;
ALTER TABLE "BrandSettings" ADD COLUMN IF NOT EXISTS "chatBubbleMaxWidth" INTEGER;
ALTER TABLE "BrandSettings" ADD COLUMN IF NOT EXISTS "chatInputFontSize" INTEGER;
ALTER TABLE "BrandSettings" ADD COLUMN IF NOT EXISTS "chatInputHeight" INTEGER;

ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "chatBubbleFontSize" INTEGER;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "chatBubbleLineHeight" DOUBLE PRECISION;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "chatBubblePaddingX" INTEGER;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "chatBubblePaddingY" INTEGER;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "chatBubbleMaxWidth" INTEGER;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "chatInputFontSize" INTEGER;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "chatInputHeight" INTEGER;
