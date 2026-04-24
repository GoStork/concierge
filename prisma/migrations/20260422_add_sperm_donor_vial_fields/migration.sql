-- Add vial type and cost fields to SpermDonor
ALTER TABLE "SpermDonor" ADD COLUMN IF NOT EXISTS "vialTypes" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "SpermDonor" ADD COLUMN IF NOT EXISTS "iciCost" INTEGER;
ALTER TABLE "SpermDonor" ADD COLUMN IF NOT EXISTS "iuiCost" INTEGER;
ALTER TABLE "SpermDonor" ADD COLUMN IF NOT EXISTS "ivfCost" INTEGER;

-- Add defaultVialTypes to SpermDonorSyncConfig
ALTER TABLE "SpermDonorSyncConfig" ADD COLUMN IF NOT EXISTS "defaultVialTypes" TEXT[] NOT NULL DEFAULT '{}';

-- Add spermDonorVialType to IntendedParentProfile
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "spermDonorVialType" TEXT;
