-- Migration: provider W-9 form flow
--
-- 1. Global W-9 PandaDoc template on SiteSettings. GoStork admin uploads/configures
--    a single W-9 template once; every provider signs their own copy of it.
--
-- 2. ProviderW9 table - tracks each provider's W-9 document and signing status.
--    Mirrors the agreement flow, but GoStork is the sender and the agency is the
--    signer. One row per provider.
--
-- Idempotent: rerunning is a no-op.

ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "w9TemplateUrl" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "w9TemplateOriginalName" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "w9PandaDocTemplateId" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "w9PandaDocRoles" TEXT;

CREATE TABLE IF NOT EXISTS "ProviderW9" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "pandaDocDocumentId" TEXT,
    "pandaDocViewUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_SENT',
    "signerEmail" TEXT,
    "signerUserId" TEXT,
    "requestedByUserId" TEXT,
    "requestedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderW9_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProviderW9_providerId_key" ON "ProviderW9"("providerId");
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderW9_pandaDocDocumentId_key" ON "ProviderW9"("pandaDocDocumentId");
CREATE INDEX IF NOT EXISTS "ProviderW9_providerId_idx" ON "ProviderW9"("providerId");

-- FK with ON DELETE CASCADE so deleting a provider cleans up its W-9 record.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'ProviderW9_providerId_fkey'
    ) THEN
        ALTER TABLE "ProviderW9"
            ADD CONSTRAINT "ProviderW9_providerId_fkey"
            FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE;
    END IF;
END
$$;
