-- Provider legal identity: single source of truth for the "who is this
-- business legally" answer that's currently duplicated across receipt
-- PDFs (legalName + taxId on ProviderBrandSettings), the Custom Payouts
-- form (collected fresh), and the signed W-9. New table holds the
-- W-9-shaped data (name, classification, tax id, address) once, and
-- everywhere downstream reads from here.
--
-- Migration plan:
--   1. Create the new table.
--   2. Backfill from the existing ProviderBrandSettings.legalName/taxId
--      rows so receipt PDFs keep working immediately after deploy.
--   3. Drop legalName + taxId from ProviderBrandSettings.

CREATE TABLE IF NOT EXISTS "ProviderLegalIdentity" (
  "id" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "legalName" TEXT,
  "businessName" TEXT,
  "taxClassification" TEXT,
  "businessType" TEXT,
  "taxId" TEXT,
  "taxIdType" TEXT,
  "businessAddressLine1" TEXT,
  "businessAddressLine2" TEXT,
  "businessAddressCity" TEXT,
  "businessAddressState" TEXT,
  "businessAddressPostalCode" TEXT,
  "businessAddressCountry" TEXT DEFAULT 'US',
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "lastW9SyncAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderLegalIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProviderLegalIdentity_providerId_key"
  ON "ProviderLegalIdentity" ("providerId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ProviderLegalIdentity_providerId_fkey'
      AND conrelid = '"ProviderLegalIdentity"'::regclass
  ) THEN
    ALTER TABLE "ProviderLegalIdentity"
      ADD CONSTRAINT "ProviderLegalIdentity_providerId_fkey"
      FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- Backfill from ProviderBrandSettings. Each existing brand settings row
-- with a legalName or taxId becomes a ProviderLegalIdentity row tagged
-- MIGRATED_FROM_BRAND_SETTINGS so admins can spot pre-migration data.
INSERT INTO "ProviderLegalIdentity" ("id", "providerId", "legalName", "taxId", "source")
SELECT
  gen_random_uuid()::text,
  "providerId",
  "legalName",
  "taxId",
  'MIGRATED_FROM_BRAND_SETTINGS'
FROM "ProviderBrandSettings"
WHERE "legalName" IS NOT NULL OR "taxId" IS NOT NULL
ON CONFLICT ("providerId") DO NOTHING;

-- Derive taxIdType from the backfilled values: 9 digits straight = EIN
-- 12-3456789, 9 digits with dashes formatted as SSN = ssn. Best effort,
-- admins will be able to correct manually.
UPDATE "ProviderLegalIdentity"
SET "taxIdType" = CASE
  WHEN "taxId" ~ '^\d{3}-\d{2}-\d{4}$' THEN 'ssn'
  WHEN "taxId" ~ '^\d{2}-\d{7}$' THEN 'ein'
  WHEN "taxId" ~ '^\d{9}$' THEN 'ein'
  ELSE NULL
END
WHERE "taxId" IS NOT NULL AND "taxIdType" IS NULL;

-- Drop the now-duplicated columns from ProviderBrandSettings.
ALTER TABLE "ProviderBrandSettings" DROP COLUMN IF EXISTS "legalName";
ALTER TABLE "ProviderBrandSettings" DROP COLUMN IF EXISTS "taxId";
