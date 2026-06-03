-- Adds frozenLotStatus to EggDonor. For donors with frozen eggs (donorType
-- "Frozen Eggs" or "Fresh & Frozen"), this column carries the inventory
-- state independently of the `status` column. status remains the fresh-
-- cycle matching state for donors who do fresh cycles; for pure Frozen
-- Eggs donors, frozenLotStatus is the only meaningful availability signal.
--
-- Values: 'AVAILABLE' | 'SOLD_OUT' | null
--   AVAILABLE = lots in stock (use numberOfEggs / raw profileData for
--               low-stock count; "Less than 6 eggs available" still maps
--               to AVAILABLE - low stock is not a separate status state)
--   SOLD_OUT  = "No Frozen Eggs Available" - donor has no purchasable lots
--   null      = donor doesn't offer frozen eggs (pure Fresh Donor)

ALTER TABLE "EggDonor"
  ADD COLUMN IF NOT EXISTS "frozenLotStatus" TEXT;

-- Backfill from existing profileData. Only donors whose donorType involves
-- frozen eggs get a non-null value; pure Fresh Donor rows stay null.
UPDATE "EggDonor"
SET "frozenLotStatus" = 'AVAILABLE'
WHERE "donorType" IN ('Frozen Eggs', 'Fresh & Frozen')
  AND (
    "profileData"->>'Frozen Egg Availability' ILIKE '%frozen eggs available%'
    OR "profileData"->>'Frozen Egg Availability' ILIKE '%less than%'
  );

UPDATE "EggDonor"
SET "frozenLotStatus" = 'SOLD_OUT'
WHERE "donorType" IN ('Frozen Eggs', 'Fresh & Frozen')
  AND "profileData"->>'Frozen Egg Availability' ILIKE '%no frozen eggs available%';
