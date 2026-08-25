-- Per-day Gemini spend rollup (day, subsystem, model). See
-- server/src/lib/gemini-usage.ts. Added after the Aug 20-23 2026 crash-loop
-- incident, which cost ~$845 and could not be attributed from the codebase.
CREATE TABLE IF NOT EXISTS "GeminiUsage" (
  "id"           TEXT NOT NULL,
  "day"          DATE NOT NULL,
  "subsystem"    TEXT NOT NULL,
  "model"        TEXT NOT NULL,
  "calls"        INTEGER NOT NULL DEFAULT 0,
  "inputTokens"  INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "cachedTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GeminiUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GeminiUsage_day_subsystem_model_key"
  ON "GeminiUsage" ("day", "subsystem", "model");

CREATE INDEX IF NOT EXISTS "GeminiUsage_day_idx" ON "GeminiUsage" ("day");
