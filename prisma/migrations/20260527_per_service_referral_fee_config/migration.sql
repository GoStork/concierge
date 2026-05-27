-- Per-service ReferralFeeConfig: one config row per (provider, serviceType)
-- so GoStork can negotiate different referral terms for each service an agency
-- offers (e.g. flat $1000 on egg donation but 5% on IVF cycles).
--
-- Migration plan:
--   1. Add nullable serviceType column.
--   2. Backfill it on existing rows by mapping the provider's primary
--      APPROVED ProviderService -> LineServiceType enum, falling back to "OTHER".
--   3. Make serviceType NOT NULL with default "OTHER".
--   4. Drop the existing unique constraint on providerId, add a composite
--      unique on (providerId, serviceType).

-- 1. Add serviceType column (nullable for backfill)
ALTER TABLE "ReferralFeeConfig" ADD COLUMN IF NOT EXISTS "serviceType" TEXT;

-- 2. Backfill from each provider's primary approved service. We pick the
-- first APPROVED ProviderService (any one if multiple), then map the
-- ProviderType.name to the LineServiceType enum used by InvoiceLineItem.
UPDATE "ReferralFeeConfig" rfc
SET "serviceType" = COALESCE(
  (
    SELECT CASE
      WHEN LOWER(pt.name) LIKE '%surrogacy%' THEN 'SURROGACY'
      WHEN LOWER(pt.name) LIKE '%egg donor%' OR LOWER(pt.name) LIKE '%egg bank%' THEN 'EGG_DONATION'
      WHEN LOWER(pt.name) LIKE '%sperm%' THEN 'SPERM_DONATION'
      WHEN LOWER(pt.name) LIKE '%ivf%' OR LOWER(pt.name) LIKE '%clinic%' THEN 'IVF_CLINIC'
      ELSE 'OTHER'
    END
    FROM "ProviderService" ps
    JOIN "ProviderType" pt ON pt.id = ps."providerTypeId"
    WHERE ps."providerId" = rfc."providerId" AND ps.status = 'APPROVED'
    ORDER BY ps.id
    LIMIT 1
  ),
  'OTHER'
)
WHERE "serviceType" IS NULL;

-- 3. NOT NULL + default
ALTER TABLE "ReferralFeeConfig" ALTER COLUMN "serviceType" SET DEFAULT 'OTHER';
ALTER TABLE "ReferralFeeConfig" ALTER COLUMN "serviceType" SET NOT NULL;

-- 4. Swap unique constraints. Prisma's auto-generated name for the old
-- single-column unique is "ReferralFeeConfig_providerId_key".
ALTER TABLE "ReferralFeeConfig" DROP CONSTRAINT IF EXISTS "ReferralFeeConfig_providerId_key";
DROP INDEX IF EXISTS "ReferralFeeConfig_providerId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "ReferralFeeConfig_providerId_serviceType_key"
  ON "ReferralFeeConfig" ("providerId", "serviceType");

CREATE INDEX IF NOT EXISTS "ReferralFeeConfig_providerId_idx"
  ON "ReferralFeeConfig" ("providerId");
