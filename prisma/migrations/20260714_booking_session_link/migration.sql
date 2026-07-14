-- Booking <-> chat-session linkage: lets the journey sidebar scope the
-- consultation rungs to one thread. Null = legacy/unlinked booking.
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;
