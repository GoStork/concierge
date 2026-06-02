-- Add serviceTypes tag array to CostProgram. Lets a single cost sheet be
-- tagged with multiple services (e.g. egg donor + surrogate bundle). The
-- parent matcher unions a program's serviceTypes against the parent's needs.

ALTER TABLE "CostProgram" ADD COLUMN IF NOT EXISTS "serviceTypes" TEXT[] NOT NULL DEFAULT '{}';

-- Backfill from the current providerTypeId so existing programs continue
-- to match. The provider type's name maps to a canonical tag:
--   IVF Clinic        -> "ivf_clinic"
--   Surrogacy Agency  -> "surrogacy"
--   Egg Donor Agency  -> "egg_donor"
--   Egg Bank          -> "egg_donor"
--   Sperm Bank        -> "sperm_donor"
UPDATE "CostProgram" SET "serviceTypes" = ARRAY['ivf_clinic']
 WHERE "providerTypeId" IN (SELECT id FROM "ProviderType" WHERE lower(name) LIKE '%ivf%' OR lower(name) LIKE '%clinic%')
   AND cardinality("serviceTypes") = 0;

UPDATE "CostProgram" SET "serviceTypes" = ARRAY['surrogacy']
 WHERE "providerTypeId" IN (SELECT id FROM "ProviderType" WHERE lower(name) LIKE '%surrogacy%')
   AND cardinality("serviceTypes") = 0;

UPDATE "CostProgram" SET "serviceTypes" = ARRAY['egg_donor']
 WHERE "providerTypeId" IN (SELECT id FROM "ProviderType" WHERE lower(name) LIKE '%egg donor%' OR lower(name) LIKE '%egg bank%')
   AND cardinality("serviceTypes") = 0;

UPDATE "CostProgram" SET "serviceTypes" = ARRAY['sperm_donor']
 WHERE "providerTypeId" IN (SELECT id FROM "ProviderType" WHERE lower(name) LIKE '%sperm bank%' OR lower(name) LIKE '%sperm donor%')
   AND cardinality("serviceTypes") = 0;

CREATE INDEX IF NOT EXISTS "CostProgram_serviceTypes_idx" ON "CostProgram" USING GIN ("serviceTypes");
