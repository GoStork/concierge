-- Whisper Q&A: attachments + SLA timers on SilentQuery
ALTER TABLE "SilentQuery" ADD COLUMN IF NOT EXISTS "attachmentUrl"  TEXT;
ALTER TABLE "SilentQuery" ADD COLUMN IF NOT EXISTS "attachmentName" TEXT;
ALTER TABLE "SilentQuery" ADD COLUMN IF NOT EXISTS "attachmentMime" TEXT;
ALTER TABLE "SilentQuery" ADD COLUMN IF NOT EXISTS "firstReminderAt"  TIMESTAMP(3);
ALTER TABLE "SilentQuery" ADD COLUMN IF NOT EXISTS "secondReminderAt" TIMESTAMP(3);
ALTER TABLE "SilentQuery" ADD COLUMN IF NOT EXISTS "escalatedAt"      TIMESTAMP(3);
ALTER TABLE "SilentQuery" ADD COLUMN IF NOT EXISTS "reminderCount"    INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "SilentQuery_status_createdAt_idx" ON "SilentQuery" ("status", "createdAt");
