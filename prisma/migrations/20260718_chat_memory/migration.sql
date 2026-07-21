-- Rolling conversation summary on sessions (ported from AI-Health)
ALTER TABLE "AiChatSession" ADD COLUMN IF NOT EXISTS "historySummary" TEXT;
ALTER TABLE "AiChatSession" ADD COLUMN IF NOT EXISTS "summarizedThrough" TIMESTAMP(3);

-- Durable cross-thread concierge memory (parent-visible/editable)
CREATE TABLE IF NOT EXISTS "ConciergeMemory" (
  "id" TEXT NOT NULL,
  "parentAccountId" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'FACT',
  "text" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConciergeMemory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ConciergeMemory_parentAccountId_active_idx" ON "ConciergeMemory"("parentAccountId", "active");
