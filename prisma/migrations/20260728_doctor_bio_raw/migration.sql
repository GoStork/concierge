-- Full verbatim text of a doctor's own profile page. `bio` remains the short
-- display summary; structured extraction (education / languages / specialties)
-- reads bioRaw so summarization can no longer discard those sections.
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "bioRaw" TEXT;
