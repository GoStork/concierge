-- Payout auto-retry bookkeeping
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "payoutNextAttemptAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "payoutAttemptCount" INTEGER NOT NULL DEFAULT 0;

-- Dismissals for the admin Home "Needs attention" queue
CREATE TABLE IF NOT EXISTS "AdminTaskDismissal" (
  "id" TEXT NOT NULL,
  "taskKey" TEXT NOT NULL,
  "dismissedBy" TEXT,
  "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminTaskDismissal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdminTaskDismissal_taskKey_key" ON "AdminTaskDismissal"("taskKey");
