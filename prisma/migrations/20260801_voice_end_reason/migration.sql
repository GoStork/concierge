-- Voice cap analytics: record why each voice session ended
ALTER TABLE "VoiceSessionLog" ADD COLUMN IF NOT EXISTS "endReason" TEXT;
