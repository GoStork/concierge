-- Per-service-line lead owners (provider scope). Existing rows keep
-- serviceLine NULL and become the org-wide fallback owner.

ALTER TABLE "ParentOwner" ADD COLUMN IF NOT EXISTS "serviceLine" TEXT;

-- One owner per (family x org x line), plus one NULL-line fallback row.
-- COALESCE because Postgres treats NULLs as distinct in unique indexes.
DROP INDEX IF EXISTS "ParentOwner_provider_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ParentOwner_provider_line_key"
  ON "ParentOwner"("parentAccountId", "providerId", COALESCE("serviceLine", ''))
  WHERE "scope" = 'PROVIDER';
