-- W-9 template versioning so per-provider PandaDoc docs can detect a stale
-- template (file replaced or fields re-assigned) and regenerate themselves.
--
-- SiteSettings.w9TemplateUpdatedAt: bumped whenever the global W-9 template
-- changes - upload, sync, field re-assignment, or delete.
--
-- ProviderW9.templateUpdatedAt: snapshot of the SiteSettings value at the
-- time this row's PandaDoc document was created. ensureW9Document() compares
-- these and treats the row as stale if the snapshot is older.
--
-- Idempotent.

ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "w9TemplateUpdatedAt" TIMESTAMP(3);
ALTER TABLE "ProviderW9" ADD COLUMN IF NOT EXISTS "templateUpdatedAt" TIMESTAMP(3);

-- Seed: pretend the current template was last updated "now" so existing docs
-- aren't all flagged as stale on first deploy. Existing ProviderW9 rows get a
-- matching snapshot - we trust them as up-to-date.
UPDATE "SiteSettings"
   SET "w9TemplateUpdatedAt" = COALESCE("w9TemplateUpdatedAt", CURRENT_TIMESTAMP)
 WHERE "w9TemplateUrl" IS NOT NULL;

UPDATE "ProviderW9"
   SET "templateUpdatedAt" = COALESCE(
       "templateUpdatedAt",
       (SELECT "w9TemplateUpdatedAt" FROM "SiteSettings" LIMIT 1)
   )
 WHERE "templateUpdatedAt" IS NULL;
