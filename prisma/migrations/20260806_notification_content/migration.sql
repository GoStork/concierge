-- Capture what was actually sent, so the parent-record activity timeline can
-- show the message instead of "content not stored".
--
-- Nothing backfills these: buildBrandedEmail resolves brand settings, links
-- and one-time tokens at send time, so an old row cannot be re-rendered
-- faithfully. Rows written before this migration stay NULL and the UI says so.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "subject" TEXT;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "bodyHtml" TEXT;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "bodyText" TEXT;
