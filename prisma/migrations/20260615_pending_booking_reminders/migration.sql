-- Pending-booking reminders + auto-expiry of stale requests.
-- pendingReminderAt:   last time a "still awaiting your confirmation" daily nudge was sent (throttle).
-- pendingUrgentSentAt: set once when the requested slot is < 24h away and still PENDING (urgent nudge).
-- expiredAt:           set when a PENDING request is auto-expired because its slot passed unanswered.
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "pendingReminderAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "pendingUrgentSentAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "expiredAt" TIMESTAMP(3);
