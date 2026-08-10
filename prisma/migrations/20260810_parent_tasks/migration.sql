-- ParentFollowUp becomes ParentTask.
--
-- The old model allowed exactly ONE open row per (parent x scope), enforced by
-- two partial unique indexes. A coordinator has more than one thing to do for a
-- family; that constraint made the feature a scratchpad instead of a queue.
ALTER TABLE "ParentFollowUp" RENAME TO "ParentTask";

-- Drop the one-open-per-scope guards. These are the whole reason a second task
-- could not exist.
DROP INDEX IF EXISTS "ParentFollowUp_open_gostork_key";
DROP INDEX IF EXISTS "ParentFollowUp_open_provider_key";

-- body was the whole task; it is the title now, with notes alongside it.
ALTER TABLE "ParentTask" RENAME COLUMN "body" TO "title";

ALTER TABLE "ParentTask"
  ADD COLUMN IF NOT EXISTS "notes" TEXT,
  ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'TODO',
  ADD COLUMN IF NOT EXISTS "priority" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "reminderMinutesBefore" INTEGER,
  ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS "systemKey" TEXT,
  ADD COLUMN IF NOT EXISTS "deepLink" TEXT,
  ADD COLUMN IF NOT EXISTS "dismissedUnresolved" BOOLEAN NOT NULL DEFAULT false;

-- systemKey is the artifact's identity. The reconcile sweep runs every 10
-- minutes on two machines; without this it would raise the same work twice.
CREATE UNIQUE INDEX IF NOT EXISTS "ParentTask_systemKey_key" ON "ParentTask"("systemKey");

-- Rename the inherited indexes, then add the two the new surfaces need.
ALTER INDEX IF EXISTS "ParentFollowUp_parentAccountId_status_dueAt_idx" RENAME TO "ParentTask_parentAccountId_status_dueAt_idx";
ALTER INDEX IF EXISTS "ParentFollowUp_providerId_status_dueAt_idx" RENAME TO "ParentTask_providerId_status_dueAt_idx";
DROP INDEX IF EXISTS "ParentFollowUp_scope_providerId_status_dueAt_idx";

-- "My tasks, soonest first" - the Home queue and the morning digest.
CREATE INDEX IF NOT EXISTS "ParentTask_assigneeUserId_status_dueAt_idx" ON "ParentTask"("assigneeUserId", "status", "dueAt");
-- The reminder sweep: due soon, not yet reminded.
CREATE INDEX IF NOT EXISTS "ParentTask_status_dueAt_reminderSentAt_idx" ON "ParentTask"("status", "dueAt", "reminderSentAt");
