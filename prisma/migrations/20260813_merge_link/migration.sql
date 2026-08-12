-- CRM Phase 9 §2b: manual merge + link-as-household.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mergedIntoUserId" TEXT;

CREATE TABLE IF NOT EXISTS "ParentAccountMerge" (
    "id" TEXT NOT NULL,
    "survivingAccountId" TEXT NOT NULL,
    "absorbedAccountId" TEXT NOT NULL,
    "absorbedUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "performedByUserId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ParentAccountMerge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ParentAccountMerge_survivingAccountId_idx" ON "ParentAccountMerge"("survivingAccountId");
CREATE INDEX IF NOT EXISTS "ParentAccountMerge_absorbedAccountId_idx" ON "ParentAccountMerge"("absorbedAccountId");

CREATE TABLE IF NOT EXISTS "ParentHouseholdLink" (
    "id" TEXT NOT NULL,
    "aAccountId" TEXT NOT NULL,
    "bAccountId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ParentHouseholdLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ParentHouseholdLink_aAccountId_bAccountId_key"
  ON "ParentHouseholdLink"("aAccountId", "bAccountId");
CREATE INDEX IF NOT EXISTS "ParentHouseholdLink_bAccountId_idx" ON "ParentHouseholdLink"("bAccountId");
