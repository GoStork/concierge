-- Sync configs gain an admin-selectable sync method (SOURCE_URL scrape vs provider API)
-- plus encrypted API credentials supplied by the provider.
ALTER TABLE "EggDonorSyncConfig" ADD COLUMN IF NOT EXISTS "syncMethod" TEXT NOT NULL DEFAULT 'SOURCE_URL';
ALTER TABLE "EggDonorSyncConfig" ADD COLUMN IF NOT EXISTS "encryptedApiKey" TEXT;
ALTER TABLE "EggDonorSyncConfig" ADD COLUMN IF NOT EXISTS "encryptedApiSecret" TEXT;

ALTER TABLE "SurrogateSyncConfig" ADD COLUMN IF NOT EXISTS "syncMethod" TEXT NOT NULL DEFAULT 'SOURCE_URL';
ALTER TABLE "SurrogateSyncConfig" ADD COLUMN IF NOT EXISTS "encryptedApiKey" TEXT;
ALTER TABLE "SurrogateSyncConfig" ADD COLUMN IF NOT EXISTS "encryptedApiSecret" TEXT;

ALTER TABLE "SpermDonorSyncConfig" ADD COLUMN IF NOT EXISTS "syncMethod" TEXT NOT NULL DEFAULT 'SOURCE_URL';
ALTER TABLE "SpermDonorSyncConfig" ADD COLUMN IF NOT EXISTS "encryptedApiKey" TEXT;
ALTER TABLE "SpermDonorSyncConfig" ADD COLUMN IF NOT EXISTS "encryptedApiSecret" TEXT;
