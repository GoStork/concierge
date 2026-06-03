-- Tracks which donor/surrogate profiles a parent account has already "seen".
-- Used to compute the per-parent "New" badge on marketplace cards.
-- A profile is "New" iff it was created < 24h ago AND no row exists here
-- for the (parentAccountId, profileId, profileType) tuple.

CREATE TABLE IF NOT EXISTS "ParentProfileView" (
  "id"              TEXT PRIMARY KEY,
  "parentAccountId" TEXT NOT NULL,
  "profileId"       TEXT NOT NULL,
  "profileType"     TEXT NOT NULL,
  "viewedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ParentProfileView_parentAccountId_fkey"
    FOREIGN KEY ("parentAccountId") REFERENCES "ParentAccount"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ParentProfileView_account_profile_unique"
  ON "ParentProfileView" ("parentAccountId", "profileId", "profileType");

CREATE INDEX IF NOT EXISTS "ParentProfileView_account_viewedAt_idx"
  ON "ParentProfileView" ("parentAccountId", "viewedAt");
