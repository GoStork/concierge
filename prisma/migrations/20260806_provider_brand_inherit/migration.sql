-- Provider brand settings: null = inherit from global SiteSettings.
-- Drop the legacy hardcoded defaults and NOT NULL constraints that froze
-- every provider at the old GoStork green palette (#004D4D) on row creation.

ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "primaryColor" DROP DEFAULT, ALTER COLUMN "primaryColor" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "secondaryColor" DROP DEFAULT, ALTER COLUMN "secondaryColor" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "accentColor" DROP DEFAULT, ALTER COLUMN "accentColor" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "successColor" DROP DEFAULT, ALTER COLUMN "successColor" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "warningColor" DROP DEFAULT, ALTER COLUMN "warningColor" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "errorColor" DROP DEFAULT, ALTER COLUMN "errorColor" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "headingFont" DROP DEFAULT, ALTER COLUMN "headingFont" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "bodyFont" DROP DEFAULT, ALTER COLUMN "bodyFont" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "baseFontSize" DROP DEFAULT, ALTER COLUMN "baseFontSize" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "lineHeight" DROP DEFAULT, ALTER COLUMN "lineHeight" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "typeScaleRatio" DROP DEFAULT, ALTER COLUMN "typeScaleRatio" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "smallTextSize" DROP DEFAULT, ALTER COLUMN "smallTextSize" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "baseBodyWeight" DROP DEFAULT, ALTER COLUMN "baseBodyWeight" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "headingWeight" DROP DEFAULT, ALTER COLUMN "headingWeight" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "uiButtonWeight" DROP DEFAULT, ALTER COLUMN "uiButtonWeight" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "bodyLineHeight" DROP DEFAULT, ALTER COLUMN "bodyLineHeight" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "headingLineHeight" DROP DEFAULT, ALTER COLUMN "headingLineHeight" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "letterSpacing" DROP DEFAULT, ALTER COLUMN "letterSpacing" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "buttonTextCase" DROP DEFAULT, ALTER COLUMN "buttonTextCase" DROP NOT NULL;
ALTER TABLE "ProviderBrandSettings" ALTER COLUMN "linkDecoration" DROP DEFAULT, ALTER COLUMN "linkDecoration" DROP NOT NULL;

-- Data cleanup: values equal to the legacy defaults were stamped in by the
-- old column defaults, not chosen by anyone. Null them so those providers
-- resume inheriting the live GoStork brand. Real overrides (any other value)
-- are preserved.
UPDATE "ProviderBrandSettings" SET "primaryColor" = NULL WHERE "primaryColor" = '#004D4D';
UPDATE "ProviderBrandSettings" SET "secondaryColor" = NULL WHERE "secondaryColor" = '#F0FAF5';
UPDATE "ProviderBrandSettings" SET "accentColor" = NULL WHERE "accentColor" = '#0DA4EA';
UPDATE "ProviderBrandSettings" SET "successColor" = NULL WHERE "successColor" = '#16a34a';
UPDATE "ProviderBrandSettings" SET "warningColor" = NULL WHERE "warningColor" = '#f59e0b';
UPDATE "ProviderBrandSettings" SET "errorColor" = NULL WHERE "errorColor" = '#ef4444';
UPDATE "ProviderBrandSettings" SET "headingFont" = NULL WHERE "headingFont" = 'Playfair Display';
UPDATE "ProviderBrandSettings" SET "bodyFont" = NULL WHERE "bodyFont" = 'DM Sans';
UPDATE "ProviderBrandSettings" SET "baseFontSize" = NULL WHERE "baseFontSize" = 16;
UPDATE "ProviderBrandSettings" SET "lineHeight" = NULL WHERE "lineHeight" = 1.5;
UPDATE "ProviderBrandSettings" SET "typeScaleRatio" = NULL WHERE "typeScaleRatio" = 1.25;
UPDATE "ProviderBrandSettings" SET "smallTextSize" = NULL WHERE "smallTextSize" = 14;
UPDATE "ProviderBrandSettings" SET "baseBodyWeight" = NULL WHERE "baseBodyWeight" = '400';
UPDATE "ProviderBrandSettings" SET "headingWeight" = NULL WHERE "headingWeight" = '700';
UPDATE "ProviderBrandSettings" SET "uiButtonWeight" = NULL WHERE "uiButtonWeight" = '500';
UPDATE "ProviderBrandSettings" SET "bodyLineHeight" = NULL WHERE "bodyLineHeight" = 1.6;
UPDATE "ProviderBrandSettings" SET "headingLineHeight" = NULL WHERE "headingLineHeight" = 1.2;
UPDATE "ProviderBrandSettings" SET "letterSpacing" = NULL WHERE "letterSpacing" = 'normal';
UPDATE "ProviderBrandSettings" SET "buttonTextCase" = NULL WHERE "buttonTextCase" = 'normal';
UPDATE "ProviderBrandSettings" SET "linkDecoration" = NULL WHERE "linkDecoration" = 'hover';
