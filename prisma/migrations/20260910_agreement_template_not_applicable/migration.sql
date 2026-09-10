-- The provider can mark a service line as not using a signed parent agreement.
ALTER TABLE "ProviderAgreementTemplate" ADD COLUMN IF NOT EXISTS "notApplicable" BOOLEAN NOT NULL DEFAULT false;
