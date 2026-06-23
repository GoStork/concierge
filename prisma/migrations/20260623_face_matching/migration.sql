-- Look-alike face matching (AWS Rekognition). Rekognition's collection holds
-- the face index, so no pgvector column is added here - we only track indexing
-- state per entity and the parent's last uploaded photo + consent.

ALTER TABLE "EggDonor" ADD COLUMN IF NOT EXISTS "faceIndexedAt" TIMESTAMP(3);
ALTER TABLE "EggDonor" ADD COLUMN IF NOT EXISTS "rekognitionFaceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "SpermDonor" ADD COLUMN IF NOT EXISTS "faceIndexedAt" TIMESTAMP(3);
ALTER TABLE "SpermDonor" ADD COLUMN IF NOT EXISTS "rekognitionFaceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Surrogate" ADD COLUMN IF NOT EXISTS "faceIndexedAt" TIMESTAMP(3);
ALTER TABLE "Surrogate" ADD COLUMN IF NOT EXISTS "rekognitionFaceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "AiChatSession" ADD COLUMN IF NOT EXISTS "lastUploadedPhotoUrl" TEXT;

ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "faceMatchConsentAt" TIMESTAMP(3);
