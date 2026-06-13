-- CDC ART clinic profile data (services, experience-by-diagnosis, cycle practice stats)
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "cdcServices" JSONB;
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "cdcExperience" JSONB;
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "cdcCycleStats" JSONB;

-- Patient's structured diagnoses (CDC "Reason for Using ART" labels) for clinic-experience matching
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "diagnoses" TEXT[] NOT NULL DEFAULT '{}';

-- CDC-reported medical director (durable fallback for zero-doctor clinics)
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "cdcMedicalDirector" TEXT;
