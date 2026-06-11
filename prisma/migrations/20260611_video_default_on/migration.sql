-- Offers video visits: default on for all provider types, and backfill existing
-- providers (none had deliberately opted out - the field was brand new).
ALTER TABLE "Provider" ALTER COLUMN "offersVideoVisits" SET DEFAULT true;
UPDATE "Provider" SET "offersVideoVisits" = true WHERE "offersVideoVisits" = false;
