-- Daily ceiling on AI concierge turns (OWASP A06).
-- gemini-usage.ts meters spend but never gated it, so one authenticated
-- account could loop /api/ai-concierge/chat and run up an unbounded bill.
CREATE TABLE IF NOT EXISTS "ConciergeTurnBudget" (
    "id"         TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "day"        DATE NOT NULL,
    "turns"      INTEGER NOT NULL DEFAULT 0,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConciergeTurnBudget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ConciergeTurnBudget_subjectKey_day_key"
    ON "ConciergeTurnBudget"("subjectKey", "day");
CREATE INDEX IF NOT EXISTS "ConciergeTurnBudget_day_idx"
    ON "ConciergeTurnBudget"("day");

-- Every public table has RLS enabled (deny-all, no policies) so Supabase's
-- PostgREST Data API cannot read it with the anon key. Prisma connects as the
-- table owner and is unaffected.
ALTER TABLE "ConciergeTurnBudget" ENABLE ROW LEVEL SECURITY;
