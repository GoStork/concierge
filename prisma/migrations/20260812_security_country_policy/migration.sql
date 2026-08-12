-- Per-country verification policy and an abuse log for the verification endpoint.
-- A country with no row is ALLOWED: GoStork's families come from 125 countries,
-- so the world is open by default and a row exists only to say otherwise.
CREATE TABLE IF NOT EXISTS "SecurityCountryPolicy" (
  "isoCode"         TEXT PRIMARY KEY,
  "policy"          TEXT NOT NULL,
  "reason"          TEXT,
  "updatedByUserId" TEXT,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "OtpAttempt" (
  "id"          TEXT PRIMARY KEY,
  "phoneMasked" TEXT NOT NULL,
  "phoneHash"   TEXT NOT NULL,
  "isoCode"     TEXT,
  "ip"          TEXT,
  "userAgent"   TEXT,
  "outcome"     TEXT NOT NULL,
  "channel"     TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "OtpAttempt_phoneHash_createdAt_idx" ON "OtpAttempt"("phoneHash", "createdAt");
CREATE INDEX IF NOT EXISTS "OtpAttempt_ip_createdAt_idx" ON "OtpAttempt"("ip", "createdAt");
CREATE INDEX IF NOT EXISTS "OtpAttempt_isoCode_createdAt_idx" ON "OtpAttempt"("isoCode", "createdAt");
CREATE INDEX IF NOT EXISTS "OtpAttempt_createdAt_idx" ON "OtpAttempt"("createdAt");
