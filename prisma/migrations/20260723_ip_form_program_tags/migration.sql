-- IP Form: section program-applicability tags + provider IP-form toggles
ALTER TABLE "IpFormSection" ADD COLUMN IF NOT EXISTS "appliesTo" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "collectsIntendedParentForm" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "requiresIdPhotocopy" BOOLEAN NOT NULL DEFAULT false;
