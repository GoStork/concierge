-- CRM Phase 9 §3: stage playbooks + the sweep's stage snapshot.

CREATE TABLE IF NOT EXISTS "TaskPlaybook" (
    "id" TEXT NOT NULL,
    "providerId" TEXT,
    "isStarter" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "serviceLine" TEXT,
    "triggerStage" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaskPlaybook_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TaskPlaybook_providerId_isActive_idx" ON "TaskPlaybook"("providerId", "isActive");
CREATE INDEX IF NOT EXISTS "TaskPlaybook_isStarter_isActive_idx" ON "TaskPlaybook"("isStarter", "isActive");

DO $$ BEGIN
  ALTER TABLE "TaskPlaybook" ADD CONSTRAINT "TaskPlaybook_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "TaskPlaybookStep" (
    "id" TEXT NOT NULL,
    "playbookId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "type" TEXT NOT NULL DEFAULT 'TODO',
    "priority" TEXT NOT NULL DEFAULT 'NONE',
    "dueOffsetDays" INTEGER NOT NULL DEFAULT 0,
    "dueTime" TEXT,
    "reminderMinutesBefore" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "TaskPlaybookStep_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TaskPlaybookStep_playbookId_sortOrder_idx" ON "TaskPlaybookStep"("playbookId", "sortOrder");

DO $$ BEGIN
  ALTER TABLE "TaskPlaybookStep" ADD CONSTRAINT "TaskPlaybookStep_playbookId_fkey"
    FOREIGN KEY ("playbookId") REFERENCES "TaskPlaybook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ParentStageSnapshot" (
    "id" TEXT NOT NULL,
    "parentAccountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "serviceLine" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "reachedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ParentStageSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ParentStageSnapshot_parentAccountId_providerId_serviceLine_key"
  ON "ParentStageSnapshot"("parentAccountId", "providerId", "serviceLine");
CREATE INDEX IF NOT EXISTS "ParentStageSnapshot_updatedAt_idx" ON "ParentStageSnapshot"("updatedAt");
