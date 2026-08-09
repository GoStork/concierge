-- Cross-process duplicate-send guard for Notification.
-- Both servers run the same 10-minute cron; a sweep that read "not sent yet"
-- on both machines could dispatch the identical email twice in the same second.
-- The unique index makes the losing insert fail, so the duplicate never sends.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Notification_dedupeKey_key" ON "Notification" ("dedupeKey");
