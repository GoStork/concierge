-- Voice ids are provider-specific: store one per provider instead of a single
-- global value, migrating existing single ids into the elevenlabs slot.
ALTER TABLE "Matchmaker" ADD COLUMN IF NOT EXISTS "voiceIds" JSONB;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "voiceDefaultVoiceIds" JSONB;
UPDATE "Matchmaker" SET "voiceIds" = jsonb_build_object('elevenlabs', "voiceId") WHERE "voiceId" IS NOT NULL AND "voiceIds" IS NULL;
UPDATE "SiteSettings" SET "voiceDefaultVoiceIds" = jsonb_build_object('elevenlabs', "voiceDefaultVoiceId") WHERE "voiceDefaultVoiceId" IS NOT NULL AND "voiceDefaultVoiceIds" IS NULL;
