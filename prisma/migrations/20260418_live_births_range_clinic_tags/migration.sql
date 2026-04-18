-- Convert surrogateMaxLiveBirths from Int to a range string (min,max)
ALTER TABLE "IntendedParentProfile" DROP COLUMN IF EXISTS "surrogateMaxLiveBirths";
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateLiveBirthsRange" TEXT;

-- Add egg lot cost range (was in schema but missing from previous migration)
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "eggDonorLotCostRange" TEXT;

-- Add clinic priority tags (structured multiselect alongside free-text clinicPriority)
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "clinicPriorityTags" TEXT;
