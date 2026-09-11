-- businessAddressCountry: null now means "nobody chose yet" so the Legal
-- tab can pre-select the country from the provider's profile location.
ALTER TABLE "ProviderLegalIdentity" ALTER COLUMN "businessAddressCountry" DROP DEFAULT;

-- Rows that were auto-created by a tab visit and never saved still hold
-- the old "US" default, so clear it and they get pre-filled on next read.
-- Any row with a saved field, a W-9 sync or a later update keeps its value.
UPDATE "ProviderLegalIdentity"
SET "businessAddressCountry" = NULL
WHERE "businessAddressCountry" = 'US'
  AND "updatedAt" = "createdAt"
  AND "lastW9SyncAt" IS NULL
  AND "legalName" IS NULL
  AND "taxId" IS NULL
  AND "businessAddressLine1" IS NULL
  AND "usPayoutEntity" = false;
