-- Explicit login page for scraper sync configs.
--
-- databaseUrl is the profile LIST page (post-login). On most provider sites the
-- login page is a DIFFERENT url, and nothing in the config said where it was, so
-- the engine guessed /wp-login.php -> /Account/Login -> /login. A guessed path
-- the site does not have can answer with a Cloudflare 403/429, which reads as an
-- edge block and aborts the walk BEFORE the path that actually works is tried
-- (Family Creations surrogate, Sep 3 2026 - it failed on /Account/Login, a path
-- familycreations.net does not have, one step before /login, which does).
--
-- loginUrl         - admin-supplied; when set it is the only login page tried.
-- lastGoodLoginUrl - written by the engine after a successful sign-in and tried
--                    ahead of the guesses on later runs.
ALTER TABLE "EggDonorSyncConfig"   ADD COLUMN IF NOT EXISTS "loginUrl" TEXT;
ALTER TABLE "EggDonorSyncConfig"   ADD COLUMN IF NOT EXISTS "lastGoodLoginUrl" TEXT;
ALTER TABLE "SurrogateSyncConfig"  ADD COLUMN IF NOT EXISTS "loginUrl" TEXT;
ALTER TABLE "SurrogateSyncConfig"  ADD COLUMN IF NOT EXISTS "lastGoodLoginUrl" TEXT;
ALTER TABLE "SpermDonorSyncConfig" ADD COLUMN IF NOT EXISTS "loginUrl" TEXT;
ALTER TABLE "SpermDonorSyncConfig" ADD COLUMN IF NOT EXISTS "lastGoodLoginUrl" TEXT;
