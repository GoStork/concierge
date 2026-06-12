-- Phase 6: saved/passed preferences for doctors (slug) and clinics (providerId).
CREATE TABLE IF NOT EXISTS "UserProfilePreference" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId"   TEXT NOT NULL,
  "type"       TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserProfilePreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserProfilePreference_userId_entityType_entityId_type_key"
  ON "UserProfilePreference" ("userId", "entityType", "entityId", "type");

CREATE INDEX IF NOT EXISTS "UserProfilePreference_userId_entityType_type_idx"
  ON "UserProfilePreference" ("userId", "entityType", "type");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'UserProfilePreference_userId_fkey'
  ) THEN
    ALTER TABLE "UserProfilePreference"
      ADD CONSTRAINT "UserProfilePreference_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
