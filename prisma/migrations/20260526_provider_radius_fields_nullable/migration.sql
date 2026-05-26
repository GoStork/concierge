-- Make ProviderBrandSettings radius fields nullable so providers actually
-- inherit from GoStork's SiteSettings when they haven't customized them.
--
-- Before: borderRadius/containerRadius/bottomNavRadius were Float NOT NULL with
-- defaults 0.5/0.5/0. Every provider row was stamped with those defaults, and
-- the server's "merge if not null" inheritance logic treated the defaults as
-- deliberate overrides, blocking inheritance from SiteSettings.
--
-- After: nullable Float. Null = "inherit from SiteSettings". A non-null value
-- = "this provider deliberately customized this field".
--
-- Migration is idempotent.

ALTER TABLE "ProviderBrandSettings"
  ALTER COLUMN "borderRadius" DROP NOT NULL,
  ALTER COLUMN "borderRadius" DROP DEFAULT;

ALTER TABLE "ProviderBrandSettings"
  ALTER COLUMN "containerRadius" DROP NOT NULL,
  ALTER COLUMN "containerRadius" DROP DEFAULT;

ALTER TABLE "ProviderBrandSettings"
  ALTER COLUMN "bottomNavRadius" DROP NOT NULL,
  ALTER COLUMN "bottomNavRadius" DROP DEFAULT;

-- Backfill: any row that still has the old schema default is interpreted as
-- "never customized", so null it out to enable inheritance. Rows where the
-- provider deliberately set a different value (e.g. Asian Egg Bank's
-- borderRadius = 2) are preserved.
UPDATE "ProviderBrandSettings" SET "borderRadius" = NULL WHERE "borderRadius" = 0.5;
UPDATE "ProviderBrandSettings" SET "containerRadius" = NULL WHERE "containerRadius" = 0.5;
UPDATE "ProviderBrandSettings" SET "bottomNavRadius" = NULL WHERE "bottomNavRadius" = 0;
