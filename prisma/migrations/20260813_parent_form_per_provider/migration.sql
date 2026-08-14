-- Per-provider Parent Form configuration:
-- 1. GoStork-controlled toggle allowing a provider to edit its own form adjustments.
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "canEditParentForm" BOOLEAN NOT NULL DEFAULT false;

-- 2. Provider-specific custom questions (null = global template question).
ALTER TABLE "IpFormQuestion" ADD COLUMN IF NOT EXISTS "providerId" TEXT;
CREATE INDEX IF NOT EXISTS "IpFormQuestion_providerId_idx" ON "IpFormQuestion"("providerId");

-- 3. Per-provider overrides of global sections/questions (hide / relabel / required).
CREATE TABLE IF NOT EXISTS "IpFormProviderOverride" (
  "id" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "hidden" BOOLEAN NOT NULL DEFAULT false,
  "label" TEXT,
  "helpText" TEXT,
  "required" BOOLEAN,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IpFormProviderOverride_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "IpFormProviderOverride_providerId_targetType_targetId_key" ON "IpFormProviderOverride"("providerId", "targetType", "targetId");
CREATE INDEX IF NOT EXISTS "IpFormProviderOverride_providerId_idx" ON "IpFormProviderOverride"("providerId");
