ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "eggDonorAgeRange" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "eggDonorCompensationRange" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "eggDonorTotalCostRange" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "clinicAgeGroup" TEXT;
