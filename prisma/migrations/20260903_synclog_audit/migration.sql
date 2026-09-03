-- Acceptance audit verdict stored on every finished sync run.
ALTER TABLE "SyncLog" ADD COLUMN IF NOT EXISTS "audit" JSONB;
