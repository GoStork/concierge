-- Deep-link template for API-synced profiles ({donorId}/{caseId} placeholders).
ALTER TABLE "EggDonorSyncConfig" ADD COLUMN IF NOT EXISTS "profileUrlTemplate" TEXT;
ALTER TABLE "SurrogateSyncConfig" ADD COLUMN IF NOT EXISTS "profileUrlTemplate" TEXT;
ALTER TABLE "SpermDonorSyncConfig" ADD COLUMN IF NOT EXISTS "profileUrlTemplate" TEXT;
