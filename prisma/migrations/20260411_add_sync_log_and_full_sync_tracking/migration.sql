-- Add SyncLog table for persistent sync run history
CREATE TABLE "SyncLog" (
  "id"          TEXT NOT NULL,
  "providerId"  TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "jobId"       TEXT NOT NULL,
  "source"      TEXT NOT NULL,
  "status"      TEXT NOT NULL,
  "startedAt"   TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "total"       INTEGER NOT NULL DEFAULT 0,
  "processed"   INTEGER NOT NULL DEFAULT 0,
  "succeeded"   INTEGER NOT NULL DEFAULT 0,
  "failed"      INTEGER NOT NULL DEFAULT 0,
  "skipped"     INTEGER NOT NULL DEFAULT 0,
  "newProfiles" INTEGER NOT NULL DEFAULT 0,
  "staleMarked" INTEGER NOT NULL DEFAULT 0,
  "errors"      JSONB,
  CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SyncLog_providerId_idx" ON "SyncLog"("providerId");
CREATE INDEX "SyncLog_startedAt_idx" ON "SyncLog"("startedAt");

ALTER TABLE "SyncLog" ADD CONSTRAINT "SyncLog_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add lastFullSyncAt to donor models for compensation/pricing change detection
ALTER TABLE "EggDonor"   ADD COLUMN "lastFullSyncAt" TIMESTAMP(3);
ALTER TABLE "Surrogate"  ADD COLUMN "lastFullSyncAt" TIMESTAMP(3);
ALTER TABLE "SpermDonor" ADD COLUMN "lastFullSyncAt" TIMESTAMP(3);
