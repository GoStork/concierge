-- Cost sheet multi-leaf coverage. Both tables get a new subTypes[] column
-- alongside the legacy subType String? value. New code reads/writes
-- subTypes[] as canonical; save paths also write subTypes[0] back into
-- subType so legacy readers keep working during the transition.

ALTER TABLE "CostProgram"       ADD COLUMN IF NOT EXISTS "subTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ProviderCostSheet" ADD COLUMN IF NOT EXISTS "subTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill: derive subTypes from the legacy (serviceTypes, subType) pair so
-- existing programs keep working with the new matcher without provider edits.
--
-- Rules per leaf:
--   IVF clinic        -> subType itself is already one of the 14 IVF leaf ids
--   surrogacy         -> emit "surrogacy" whenever serviceTypes contains it
--   sperm_donor       -> emit "sperm_donor" whenever serviceTypes contains it
--   egg_donor + fresh -> emit "egg_donor_fresh"
--   egg_donor + frozen -> emit "egg_donor_frozen"
--   egg_donor + null  -> emit BOTH egg_donor_fresh and egg_donor_frozen
--                        (conservatively cover both - admin can narrow later)

-- CostProgram backfill
UPDATE "CostProgram"
SET "subTypes" = (
  SELECT ARRAY(SELECT DISTINCT unnest_val FROM unnest(
    CASE WHEN "subType" IS NOT NULL AND "subType" LIKE 'ivf_%'         THEN ARRAY["subType"] ELSE ARRAY[]::TEXT[] END
    || CASE WHEN "subType" IS NOT NULL AND "subType" LIKE 'embryo_%'   THEN ARRAY["subType"] ELSE ARRAY[]::TEXT[] END
    || CASE WHEN "subType" IS NOT NULL AND "subType" LIKE 'fet_%'      THEN ARRAY["subType"] ELSE ARRAY[]::TEXT[] END
    || CASE WHEN "subType" IS NOT NULL AND "subType" LIKE 'shipping_%' THEN ARRAY["subType"] ELSE ARRAY[]::TEXT[] END
    || CASE WHEN "subType" IS NOT NULL AND "subType" LIKE 'egg_freezing_%' THEN ARRAY["subType"] ELSE ARRAY[]::TEXT[] END
    || CASE WHEN 'surrogacy'   = ANY("serviceTypes")                   THEN ARRAY['surrogacy']    ELSE ARRAY[]::TEXT[] END
    || CASE WHEN 'sperm_donor' = ANY("serviceTypes")                   THEN ARRAY['sperm_donor']  ELSE ARRAY[]::TEXT[] END
    || CASE WHEN 'egg_donor'   = ANY("serviceTypes") AND "subType" = 'fresh'  THEN ARRAY['egg_donor_fresh']   ELSE ARRAY[]::TEXT[] END
    || CASE WHEN 'egg_donor'   = ANY("serviceTypes") AND "subType" = 'frozen' THEN ARRAY['egg_donor_frozen']  ELSE ARRAY[]::TEXT[] END
    || CASE WHEN 'egg_donor'   = ANY("serviceTypes") AND "subType" IS NULL    THEN ARRAY['egg_donor_fresh','egg_donor_frozen'] ELSE ARRAY[]::TEXT[] END
  ) AS unnest_val)
)
WHERE COALESCE(array_length("subTypes", 1), 0) = 0;

-- ProviderCostSheet backfill: inherit from its program (the canonical source).
UPDATE "ProviderCostSheet" pcs
SET "subTypes" = cp."subTypes"
FROM "CostProgram" cp
WHERE pcs."programId" = cp.id
  AND COALESCE(array_length(pcs."subTypes", 1), 0) = 0
  AND COALESCE(array_length(cp."subTypes", 1), 0) > 0;

-- For ProviderCostSheets with no program (legacy), fall back to a 1-element
-- array from the existing subType when present.
UPDATE "ProviderCostSheet"
SET "subTypes" = ARRAY["subType"]
WHERE "programId" IS NULL
  AND "subType" IS NOT NULL
  AND COALESCE(array_length("subTypes", 1), 0) = 0;
