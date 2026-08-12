-- Log-a-call + searchable notes (Phase 9 #4 + #1).
ALTER TABLE "ParentNote" ADD COLUMN IF NOT EXISTS "bodyText" TEXT;
ALTER TABLE "ParentNote" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'NOTE';
ALTER TABLE "ParentNote" ADD COLUMN IF NOT EXISTS "outcome" TEXT;
ALTER TABLE "ParentNote" ADD COLUMN IF NOT EXISTS "durationMinutes" INTEGER;
ALTER TABLE "ParentNote" ADD COLUMN IF NOT EXISTS "occurredAt" TIMESTAMP(3);
-- Trigram indexes make ILIKE search fast at volume.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "ParentNote_bodyText_trgm" ON "ParentNote" USING gin ("bodyText" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "ParentTask_title_trgm" ON "ParentTask" USING gin ("title" gin_trgm_ops);
