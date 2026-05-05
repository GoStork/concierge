ALTER TABLE "BrandTemplate" ADD COLUMN IF NOT EXISTS "chatTimestampFontSize" INTEGER;
ALTER TABLE "BrandTemplate" ADD COLUMN IF NOT EXISTS "chatTimestampOpacity" FLOAT;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "chatTimestampFontSize" INTEGER;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "chatTimestampOpacity" FLOAT;
