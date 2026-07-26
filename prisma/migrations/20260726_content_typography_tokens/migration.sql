-- Content typography tokens on SiteSettings.
-- Drives every label/value pair, prompt block, dense-card key, attribute chip
-- and section header in the product via the shared primitives in
-- client/src/components/ui/field.tsx. All nullable - NULL means "use the
-- built-in default", and color NULLs inherit the theme role.

-- Attribute pair
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "fieldLabelSize" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "fieldLabelWeight" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "fieldLabelColor" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "fieldLabelCase" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "fieldLabelTracking" DOUBLE PRECISION;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "fieldValueSize" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "fieldValueWeight" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "fieldValueColor" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "fieldLabelGap" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "fieldPairGap" INTEGER;

-- Prompt block
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "promptEyebrowSize" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "promptEyebrowWeight" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "promptEyebrowColor" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "promptEyebrowTracking" DOUBLE PRECISION;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "promptEyebrowCase" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "promptAnswerSize" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "promptAnswerWeight" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "promptAnswerColor" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "promptAnswerLineHeight" DOUBLE PRECISION;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "promptBlockGap" INTEGER;

-- Micro label
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "microLabelSize" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "microValueSize" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "microLabelWeight" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "microLabelColor" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "microLabelTracking" DOUBLE PRECISION;

-- Attribute chip
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "chipFontSize" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "chipFontWeight" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "chipRadius" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "chipPaddingX" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "chipPaddingY" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "chipBgColor" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "chipTextColor" TEXT;

-- Section header
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "sectionTitleSize" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "sectionTitleWeight" TEXT;

-- Interface typography (shared shadcn primitives: label, card, table)
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "formLabelSize" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "formLabelSmallSize" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "formLabelWeight" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "formLabelColor" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "formLabelCase" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "formLabelTracking" DOUBLE PRECISION;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "helperTextSize" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "helperTextColor" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "cardHeadingSize" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "cardHeadingWeight" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "pageTitleSize" INTEGER;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "pageTitleWeight" TEXT;
