-- How often GoStork hears about a commitment (invoice paid / agreement signed).
-- "immediate" | "daily" | "weekly". Immediate sends inline from the paid/signed
-- path; the digests sweep the INVOICE_PAID / AGREEMENT_SIGNED journey events,
-- so changing cadence never needs a queue migration.
ALTER TABLE "SiteSettings"
  ADD COLUMN IF NOT EXISTS "commitmentAlertCadence" TEXT DEFAULT 'immediate';

UPDATE "SiteSettings" SET "commitmentAlertCadence" = 'immediate'
WHERE "commitmentAlertCadence" IS NULL;
