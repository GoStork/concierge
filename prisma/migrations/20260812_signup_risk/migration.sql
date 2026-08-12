-- Signup risk state + per-IP velocity (Phase 9 §8, #2/#3).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "trustReasons" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "signupIp" TEXT;
CREATE INDEX IF NOT EXISTS "User_signupIp_idx" ON "User"("signupIp");

CREATE TABLE IF NOT EXISTS "SecuritySetting" (
  "key"       TEXT PRIMARY KEY,
  "value"     TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "SecuritySetting" ("key", "value") VALUES ('ip_signup_cap_per_day', '5')
ON CONFLICT ("key") DO NOTHING;
