-- Doctor profiles: promote ProviderMember to a first-class, addressable entity
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "slug" TEXT;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "personKey" TEXT;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "isPublicProfile" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "specialties" TEXT[] DEFAULT '{}';
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "languagesSpoken" TEXT[] DEFAULT '{}';
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "boardCertifications" TEXT[] DEFAULT '{}';
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "education" TEXT[] DEFAULT '{}';
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "professionalMemberships" TEXT[] DEFAULT '{}';
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "npiNumber" TEXT;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "yearsExperience" INTEGER;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "providerGender" TEXT;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "offersVideoVisits" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "acceptingNewPatients" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "reviewCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "recommendPct" INTEGER;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "avgOverallScore" DECIMAL(65,30);

CREATE UNIQUE INDEX IF NOT EXISTS "ProviderMember_slug_key" ON "ProviderMember"("slug");
CREATE INDEX IF NOT EXISTS "ProviderMember_personKey_idx" ON "ProviderMember"("personKey");
CREATE INDEX IF NOT EXISTS "ProviderMember_providerId_idx" ON "ProviderMember"("providerId");

-- Provider: marketplace enrichment fields (provider self-entry) + review aggregates
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "acceptedInsurance" TEXT[] DEFAULT '{}';
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "lgbtqCare" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "offersVideoVisits" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "reviewCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "recommendPct" INTEGER;
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "avgOverallScore" DECIMAL(65,30);

-- GoStork verified reviews (clinic- and doctor-level)
CREATE TABLE IF NOT EXISTS "ProviderReview" (
  "id" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "memberId" TEXT,
  "authorUserId" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'gostork_verified',
  "recommendation" TEXT NOT NULL,
  "overallScore" INTEGER,
  "subScores" JSONB,
  "bodyText" TEXT,
  "treatmentYearStart" INTEGER,
  "treatmentYearEnd" INTEGER,
  "outcome" TEXT,
  "ageRangeLabel" TEXT,
  "ivfCycles" INTEGER,
  "iuiCycles" INTEGER,
  "diagnoses" TEXT[] DEFAULT '{}',
  "isLgbtq" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ProviderReview_providerId_status_idx" ON "ProviderReview"("providerId", "status");
CREATE INDEX IF NOT EXISTS "ProviderReview_memberId_status_idx" ON "ProviderReview"("memberId", "status");

DO $$ BEGIN
  ALTER TABLE "ProviderReview" ADD CONSTRAINT "ProviderReview_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ProviderReview" ADD CONSTRAINT "ProviderReview_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "ProviderMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
