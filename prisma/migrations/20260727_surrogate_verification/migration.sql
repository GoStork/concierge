-- Surrogate availability verification. See
-- docs/surrogate-availability-verification.md for the design.

ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "surrogateCoordinatorEmail" TEXT;

CREATE TABLE IF NOT EXISTS "SurrogateVerification" (
  "id"            TEXT PRIMARY KEY,
  "surrogateId"   TEXT NOT NULL,
  "providerId"    TEXT NOT NULL,
  "trigger"       TEXT NOT NULL,
  "requestedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reminderCount" INTEGER NOT NULL DEFAULT 0,
  "respondedAt"   TIMESTAMP(3),
  "respondedBy"   TEXT,
  "resultStatus"  TEXT,
  "autoHiddenAt"  TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "SurrogateVerification_surrogateId_requestedAt_idx"
  ON "SurrogateVerification" ("surrogateId", "requestedAt");
CREATE INDEX IF NOT EXISTS "SurrogateVerification_providerId_respondedAt_idx"
  ON "SurrogateVerification" ("providerId", "respondedAt");
