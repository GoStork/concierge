-- CRM Phase 9 §5: silence as a first-class signal.

CREATE TABLE IF NOT EXISTS "SilenceConfig" (
    "id" TEXT NOT NULL,
    "providerId" TEXT,
    "thresholds" JSONB,
    "lineEnabled" JSONB,
    "evaEnabled" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "shadowSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SilenceConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SilenceConfig_providerId_key" ON "SilenceConfig"("providerId");

CREATE TABLE IF NOT EXISTS "SilenceState" (
    "id" TEXT NOT NULL,
    "parentAccountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "lastTouchAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SilenceState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SilenceState_parentAccountId_providerId_key"
  ON "SilenceState"("parentAccountId", "providerId");
CREATE INDEX IF NOT EXISTS "SilenceState_providerId_lastTouchAt_idx" ON "SilenceState"("providerId", "lastTouchAt");
