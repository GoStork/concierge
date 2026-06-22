-- Append-only ad-funnel event log for marketplace profiles (impressions + clicks).
-- Not deduped, unlike "ParentProfileView": records every display and every open.
CREATE TABLE IF NOT EXISTS "ProfileEvent" (
  "id" TEXT NOT NULL,
  "parentAccountId" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "profileType" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfileEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ProfileEvent_profileId_eventType_createdAt_idx" ON "ProfileEvent" ("profileId", "eventType", "createdAt");
CREATE INDEX IF NOT EXISTS "ProfileEvent_profileId_createdAt_idx" ON "ProfileEvent" ("profileId", "createdAt");
