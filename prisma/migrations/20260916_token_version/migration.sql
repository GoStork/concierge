-- Token revocation for stateless JWTs (OWASP A07).
-- A password reset previously left every issued 7-day bearer token working.
-- Tokens now carry the version they were minted with; bumping this column
-- invalidates all of them for that account.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
