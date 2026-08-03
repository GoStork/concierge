-- Audit trail for AI-initiated profile writes ([[SAVE]] tag): reversible +
-- forensically visible. See schema.prisma ProfileSaveAudit.
CREATE TABLE IF NOT EXISTS "ProfileSaveAudit" (
  "id" TEXT NOT NULL,
  "parentAccountId" TEXT NOT NULL,
  "userId" TEXT,
  "sessionId" TEXT,
  "channel" TEXT,
  "target" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "oldValue" JSONB,
  "newValue" JSONB,
  "provenance" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revertedAt" TIMESTAMP(3),
  "revertedBy" TEXT,
  CONSTRAINT "ProfileSaveAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ProfileSaveAudit_parentAccountId_createdAt_idx" ON "ProfileSaveAudit"("parentAccountId", "createdAt");
CREATE INDEX IF NOT EXISTS "ProfileSaveAudit_sessionId_idx" ON "ProfileSaveAudit"("sessionId");
