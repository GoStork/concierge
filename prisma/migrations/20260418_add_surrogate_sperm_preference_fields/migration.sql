-- Surrogate preference fields
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateRace" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateEthnicity" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateRelationship" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateBmiRange" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateTotalCostRange" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateMaxLiveBirths" INTEGER;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateMaxCSections" INTEGER;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateMaxMiscarriages" INTEGER;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateMaxAbortions" INTEGER;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateLastDeliveryYear" INTEGER;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateCovidVaccinated" BOOLEAN;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateSelectiveReduction" BOOLEAN;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateInternationalParents" BOOLEAN;

-- Sperm donor preference fields
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "spermDonorAgeRange" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "spermDonorEyeColor" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "spermDonorHairColor" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "spermDonorHeightRange" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "spermDonorRace" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "spermDonorEthnicity" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "spermDonorEducation" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "spermDonorMaxPrice" INTEGER;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "spermDonorCovidVaccinated" BOOLEAN;
