-- ParentStageSnapshot.providerId had NO foreign key to Provider, while
-- ParentTask.providerId did (ParentFollowUp_providerId_fkey, ON DELETE CASCADE).
-- Deleting a Provider therefore cascaded its ParentTask rows away but left
-- ParentStageSnapshot rows orphaned. The silence sweep (server/silence-sweep.ts)
-- reads those snapshots and calls parentTask.create with the dead providerId,
-- throwing P2003; its catch only swallows P2002, so the ENTIRE sweep aborted
-- every cycle. 7 orphans dated 2026-08-12 23:10 were found on DEV; PROD had 0.

-- 1. Drop the orphans. They reference Providers that no longer exist, so they
--    are unreachable junk - nothing can render or act on them.
DELETE FROM "ParentStageSnapshot" s
WHERE NOT EXISTS (
  SELECT 1 FROM "Provider" p WHERE p.id = s."providerId"
);

-- 2. Add the FK so this can never recur.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ParentStageSnapshot_providerId_fkey'
  ) THEN
    ALTER TABLE "ParentStageSnapshot"
      ADD CONSTRAINT "ParentStageSnapshot_providerId_fkey"
      FOREIGN KEY ("providerId") REFERENCES "Provider"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
