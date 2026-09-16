-- Admin two-factor authentication (TOTP) + authentication audit log.
-- OWASP Top 10:2025 A07 (Authentication Failures) and A09 (Logging & Alerting).

-- ── User: TOTP enrollment state ──────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpSecret" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpEnabledAt" TIMESTAMP(3);
-- INTEGER, not BIGINT: a 30-second TOTP step is ~59 million today and will
-- not overflow int4 for centuries, and BigInt cannot be JSON-serialized,
-- which broke every response carrying the user row.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpLastStep" INTEGER;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- ── AuthAuditLog ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AuthAuditLog" (
    "id"        TEXT NOT NULL,
    "event"     TEXT NOT NULL,
    "userId"    TEXT,
    "email"     TEXT,
    "actorId"   TEXT,
    "ip"        TEXT,
    "userAgent" TEXT,
    "detail"    TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AuthAuditLog_userId_createdAt_idx" ON "AuthAuditLog"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AuthAuditLog_event_createdAt_idx"  ON "AuthAuditLog"("event", "createdAt");
CREATE INDEX IF NOT EXISTS "AuthAuditLog_email_createdAt_idx"  ON "AuthAuditLog"("email", "createdAt");
CREATE INDEX IF NOT EXISTS "AuthAuditLog_createdAt_idx"        ON "AuthAuditLog"("createdAt");

-- Every public table has RLS enabled (deny-all, no policies) so Supabase's
-- PostgREST Data API cannot read it with the anon key. Prisma connects as the
-- table owner and is unaffected. Omitting this re-opens the public API hole and
-- re-triggers Supabase's security advisor.
ALTER TABLE "AuthAuditLog" ENABLE ROW LEVEL SECURITY;

-- Safety net if an earlier run of this migration created the column as BIGINT.
ALTER TABLE "User" ALTER COLUMN "totpLastStep" TYPE INTEGER USING "totpLastStep"::INTEGER;
