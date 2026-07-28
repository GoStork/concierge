-- The 32x32 greyscale thumbnail the duplicate test actually compares. A 64-bit
-- perceptual hash cannot separate a re-encoded copy from a different photo of
-- the same person; correlating thumbnails can.
ALTER TABLE "PhotoFingerprint" ADD COLUMN IF NOT EXISTS "thumb" TEXT;
