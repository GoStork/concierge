-- Photo-set hash per donor/surrogate so the sync hook can skip re-indexing
-- faces when the photos have not changed (avoids re-indexing every donor on
-- every nightly run).

ALTER TABLE "EggDonor" ADD COLUMN IF NOT EXISTS "facePhotoHash" TEXT;
ALTER TABLE "SpermDonor" ADD COLUMN IF NOT EXISTS "facePhotoHash" TEXT;
ALTER TABLE "Surrogate" ADD COLUMN IF NOT EXISTS "facePhotoHash" TEXT;
