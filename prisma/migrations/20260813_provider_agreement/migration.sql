-- GoStork -> Provider service agreement (contract providers sign with GoStork).
CREATE TABLE IF NOT EXISTS "ProviderAgreement" (
  "id" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "pandaDocDocumentId" TEXT,
  "pandaDocViewUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "templateSource" TEXT NOT NULL DEFAULT 'DEFAULT',
  "customTemplateUrl" TEXT,
  "customTemplateOriginalName" TEXT,
  "customPandaDocTemplateId" TEXT,
  "customPandaDocRoles" TEXT,
  "signerEmail" TEXT,
  "signerUserId" TEXT,
  "gostorkSignerEmail" TEXT,
  "gostorkCompletedAt" TIMESTAMP(3),
  "providerNotifiedAt" TIMESTAMP(3),
  "requestedByUserId" TEXT,
  "requestedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderAgreement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProviderAgreement_pandaDocDocumentId_key" ON "ProviderAgreement"("pandaDocDocumentId");
CREATE INDEX IF NOT EXISTS "ProviderAgreement_providerId_status_idx" ON "ProviderAgreement"("providerId", "status");

DO $$ BEGIN
  ALTER TABLE "ProviderAgreement" ADD CONSTRAINT "ProviderAgreement_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
