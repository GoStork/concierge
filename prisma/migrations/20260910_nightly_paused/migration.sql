-- Per-config opt-out from the 2 AM ET nightly sync.
-- Manual and admin-forced ({force:true}) syncs are unaffected.
-- Added Sep 10 2026 to park Eggspecting while its origin (WPCaptcha) is
-- blocking the production egress IP: every nightly login attempt was
-- re-tripping the lockout and filling the needs-attention digest.
ALTER TABLE "EggDonorSyncConfig"   ADD COLUMN IF NOT EXISTS "nightlyPaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SurrogateSyncConfig"  ADD COLUMN IF NOT EXISTS "nightlyPaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SpermDonorSyncConfig" ADD COLUMN IF NOT EXISTS "nightlyPaused" BOOLEAN NOT NULL DEFAULT false;
