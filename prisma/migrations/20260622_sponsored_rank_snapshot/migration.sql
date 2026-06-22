-- Search-visibility snapshots for sponsored profiles (boosted vs organic rank).
CREATE TABLE IF NOT EXISTS "SponsoredRankSnapshot" (
  "id" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "organicPosition" INTEGER NOT NULL,
  "poolSize" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SponsoredRankSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SponsoredRankSnapshot_providerId_createdAt_idx" ON "SponsoredRankSnapshot" ("providerId", "createdAt");
