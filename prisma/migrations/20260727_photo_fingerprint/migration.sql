-- Perceptual fingerprints for stored profile photos, so a picture an agency
-- uploaded twice at two resolutions is recognised as one photo and shown once.
CREATE TABLE IF NOT EXISTS "PhotoFingerprint" (
  "url"       TEXT NOT NULL,
  "phash"     TEXT,
  "width"     INTEGER,
  "height"    INTEGER,
  "bytes"     INTEGER,
  "failed"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PhotoFingerprint_pkey" PRIMARY KEY ("url")
);

CREATE INDEX IF NOT EXISTS "PhotoFingerprint_phash_idx" ON "PhotoFingerprint"("phash");
