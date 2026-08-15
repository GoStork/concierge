-- Atomic claim for the hourly calendar-health reconnection alert. Both dev
-- servers run the sweep on the same tick; the read-then-send guard raced and
-- the dedupe key could not catch it because the email body embeds the
-- per-machine APP_URL. The sweep now compare-and-swaps this column.
ALTER TABLE "CalendarConnection" ADD COLUMN IF NOT EXISTS "reconnectAlertAt" TIMESTAMP(3);
