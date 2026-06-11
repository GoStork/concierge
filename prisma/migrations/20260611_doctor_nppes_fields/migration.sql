-- NPI-anchored authoritative enrichment (NPPES) + provenance
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "npiTaxonomy" TEXT;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "credential" TEXT;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "licenseState" TEXT;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "medicalSchool" TEXT;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "graduationYear" INTEGER;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "fieldSources" JSONB;
