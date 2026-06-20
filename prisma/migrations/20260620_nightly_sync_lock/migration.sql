-- Cross-container atomic claim for the nightly sync (Replit Autoscale runs
-- multiple containers; a SELECT-then-decide 20h check races when two fire at
-- the same instant). A conditional UPDATE on this single row lets exactly one
-- container win the run.
CREATE TABLE IF NOT EXISTS "NightlySyncLock" (
  "id" INTEGER NOT NULL,
  "claimedAt" TIMESTAMP(3),
  CONSTRAINT "NightlySyncLock_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton row (id = 1). Idempotent.
INSERT INTO "NightlySyncLock" ("id", "claimedAt") VALUES (1, NULL)
ON CONFLICT ("id") DO NOTHING;
