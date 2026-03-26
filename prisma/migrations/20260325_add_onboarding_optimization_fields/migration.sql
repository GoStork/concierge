-- AlterTable: Add new fields to IntendedParentProfile for onboarding optimization
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateAgeRange" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "surrogateExperience" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "donorPreferences" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "spermDonorType" TEXT;
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "isFirstIvf" BOOLEAN;

-- AlterTable: Add onboarding service images to SiteSettings
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "onboardingClinicImageUrl" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "onboardingEggDonorImageUrl" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "onboardingSurrogateImageUrl" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "onboardingSpermDonorImageUrl" TEXT;
