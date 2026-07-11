-- Phase 7A: append-only journey event log
CREATE TABLE IF NOT EXISTS "JourneyEvent" (
  "id" TEXT NOT NULL,
  "parentAccountId" TEXT NOT NULL,
  "providerId" TEXT,
  "sessionId" TEXT,
  "bookingId" TEXT,
  "eventType" TEXT NOT NULL,
  "actorRole" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JourneyEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "JourneyEvent_parentAccountId_createdAt_idx" ON "JourneyEvent"("parentAccountId", "createdAt");
CREATE INDEX IF NOT EXISTS "JourneyEvent_providerId_eventType_createdAt_idx" ON "JourneyEvent"("providerId", "eventType", "createdAt");
CREATE INDEX IF NOT EXISTS "JourneyEvent_bookingId_idx" ON "JourneyEvent"("bookingId");
CREATE INDEX IF NOT EXISTS "JourneyEvent_eventType_createdAt_idx" ON "JourneyEvent"("eventType", "createdAt");

-- Phase 7A: call-outcome classification on bookings
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "outcome" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "outcomeAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "winbackSentAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "winbackNudgedAt" TIMESTAMP(3);
