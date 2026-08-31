-- Automatic document-signing reminder ladder (day 3/7/10) + first-login tracking.
ALTER TABLE "ProviderAgreement" ADD COLUMN IF NOT EXISTS "autoRemindCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ProviderW9" ADD COLUMN IF NOT EXISTS "autoRemindCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);
-- Documents sent more than 14 days before this feature shipped are treated as
-- already-reminded: the ladder must not resurrect ancient sends with a burst
-- of catch-up emails on deploy.
UPDATE "ProviderAgreement" SET "autoRemindCount" = 3 WHERE status = 'SENT' AND "requestedAt" < NOW() - INTERVAL '14 days' AND "autoRemindCount" = 0;
UPDATE "ProviderW9" SET "autoRemindCount" = 3 WHERE status = 'SENT' AND "requestedAt" < NOW() - INTERVAL '14 days' AND "autoRemindCount" = 0;
