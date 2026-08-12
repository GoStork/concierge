-- Email normalisation + signup trust state (Phase 9 §8, part 1).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailCanonical" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "trustState" TEXT NOT NULL DEFAULT 'TRUSTED';
CREATE INDEX IF NOT EXISTS "User_emailCanonical_idx" ON "User"("emailCanonical");

-- Editable allowlist: canonical emails exempt from alias/dedup limits (staff
-- test inboxes). Managed on /admin/security.
CREATE TABLE IF NOT EXISTS "SecurityEmailAllow" (
  "canonicalEmail"  TEXT PRIMARY KEY,
  "note"            TEXT,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed the tester's inbox so alias signups keep working out of the box.
INSERT INTO "SecurityEmailAllow" ("canonicalEmail", "note") VALUES
  ('natan123@gmail.com', 'Staff test inbox - alias signups allowed')
ON CONFLICT ("canonicalEmail") DO NOTHING;
