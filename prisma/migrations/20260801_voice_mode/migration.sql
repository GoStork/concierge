-- Voice mode: persona voices, admin voice settings, session/cost log

-- Matchmaker: per-persona TTS voice + Phase 3 avatar identity
ALTER TABLE "Matchmaker" ADD COLUMN IF NOT EXISTS "voiceId" TEXT;
ALTER TABLE "Matchmaker" ADD COLUMN IF NOT EXISTS "avatarFaceId" TEXT;
ALTER TABLE "Matchmaker" ADD COLUMN IF NOT EXISTS "avatarProvider" TEXT;

-- SiteSettings: admin-controlled voice configuration
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "voiceModeEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "voiceTtsProvider" TEXT NOT NULL DEFAULT 'elevenlabs';
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "voiceSttProvider" TEXT NOT NULL DEFAULT 'google';
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "voiceDefaultVoiceId" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "voiceSessionCapMinutes" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "voiceDailyCapMinutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "voiceAvatarEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "voiceAvatarProvider" TEXT NOT NULL DEFAULT 'heygen';

-- Voice session log (daily caps + cost audit)
CREATE TABLE IF NOT EXISTS "VoiceSessionLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "sttSeconds" INTEGER NOT NULL DEFAULT 0,
    "ttsChars" INTEGER NOT NULL DEFAULT 0,
    "avatarSeconds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "VoiceSessionLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "VoiceSessionLog_userId_startedAt_idx" ON "VoiceSessionLog"("userId", "startedAt");
CREATE INDEX IF NOT EXISTS "VoiceSessionLog_sessionId_idx" ON "VoiceSessionLog"("sessionId");

-- Phase 3: default realtime-avatar id fallback
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "voiceDefaultAvatarId" TEXT;
