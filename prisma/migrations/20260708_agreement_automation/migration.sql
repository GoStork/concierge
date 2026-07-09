-- Phase 5: agreement automation
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "agreementAutomation" TEXT;
ALTER TABLE "Agreement" ADD COLUMN IF NOT EXISTS "serviceType" TEXT;

CREATE TABLE IF NOT EXISTS "ProviderAgreementTemplate" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "agreementTemplateUrl" TEXT,
    "agreementTemplateOriginalName" TEXT,
    "pandaDocTemplateId" TEXT,
    "pandaDocRoles" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderAgreementTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProviderAgreementTemplate_providerId_serviceType_key"
    ON "ProviderAgreementTemplate"("providerId", "serviceType");

DO $$ BEGIN
    ALTER TABLE "ProviderAgreementTemplate"
        ADD CONSTRAINT "ProviderAgreementTemplate_providerId_fkey"
        FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
