-- Per-profile chat inquiry events (parent engaged about a profile mid-conversation).
CREATE TABLE IF NOT EXISTS "ProfileInquiry" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfileInquiry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProfileInquiry_sessionId_profileId_key" ON "ProfileInquiry" ("sessionId", "profileId");
CREATE INDEX IF NOT EXISTS "ProfileInquiry_profileId_createdAt_idx" ON "ProfileInquiry" ("profileId", "createdAt");
