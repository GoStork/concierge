-- Reclassify donors that were scraped as "Pending Availability" but stored as
-- MATCHED. They should be PENDING (the agency hasn't approved/onboarded the
-- donor yet, distinct from MATCHED which means committed to another parent).
--
-- Same backfill applied to Surrogate and SpermDonor for safety, though current
-- data has no rows matching there.
--
-- Idempotent: re-running flips nothing additional because the source rows are
-- already PENDING after the first pass.

UPDATE "EggDonor"
SET status = 'PENDING'
WHERE status = 'MATCHED'
  AND (
    "profileData"->>'Fresh Availability' ILIKE '%pending%'
    OR "profileData"->>'Availability' ILIKE '%pending%'
    OR "profileData"->>'Current Cycle Availability' ILIKE '%pending%'
  );

UPDATE "Surrogate"
SET status = 'PENDING'
WHERE status = 'MATCHED'
  AND (
    "profileData"->>'Availability' ILIKE '%pending%'
    OR "profileData"->>'Current Cycle Availability' ILIKE '%pending%'
  );

UPDATE "SpermDonor"
SET status = 'PENDING'
WHERE status = 'MATCHED'
  AND (
    "profileData"->>'Availability' ILIKE '%pending%'
    OR "profileData"->>'Current Cycle Availability' ILIKE '%pending%'
  );

-- Retire ON_HOLD (never produced by any scraper, no rows currently use it).
-- Map any straggler ON_HOLD rows to MATCHED so they stay non-bookable but
-- visible on the marketplace - safer than silently flipping them to AVAILABLE.
UPDATE "EggDonor"   SET status = 'MATCHED' WHERE status = 'ON_HOLD';
UPDATE "Surrogate"  SET status = 'MATCHED' WHERE status = 'ON_HOLD';
UPDATE "SpermDonor" SET status = 'MATCHED' WHERE status = 'ON_HOLD';
