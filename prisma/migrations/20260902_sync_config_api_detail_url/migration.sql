-- Optional per-profile detail endpoint for list+detail provider APIs
-- (e.g. Lucina: get_donors lists IDs, get_donor_full_profile_customized
-- returns the full profile per case_id/display_id).
ALTER TABLE "EggDonorSyncConfig" ADD COLUMN IF NOT EXISTS "apiDetailUrl" TEXT;
ALTER TABLE "SurrogateSyncConfig" ADD COLUMN IF NOT EXISTS "apiDetailUrl" TEXT;
ALTER TABLE "SpermDonorSyncConfig" ADD COLUMN IF NOT EXISTS "apiDetailUrl" TEXT;
