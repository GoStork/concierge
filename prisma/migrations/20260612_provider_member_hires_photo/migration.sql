-- AI-upscaled crisp headshot variant for doctors (ProviderMember). Original photoUrl kept.
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "highResPhotoUrl" TEXT;
