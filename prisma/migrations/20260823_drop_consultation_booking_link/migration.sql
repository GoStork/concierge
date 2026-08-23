-- Remove the legacy external "Consultation Booking Link" feature.
-- The fields were write-only (no parent-facing surface ever read them) and an
-- external Calendly/Acuity link conflicts with GoStork's native scheduling
-- system, which is how all consultations are booked.
ALTER TABLE "Provider" DROP COLUMN IF EXISTS "consultationBookingUrl";
ALTER TABLE "Provider" DROP COLUMN IF EXISTS "consultationIframeEnabled";
