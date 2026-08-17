-- A2P 10DLC error 30923 fix: separate opt-in for the ongoing notification SMS stream.
-- OTP verification codes stay transactional and are not gated by this flag.
-- Default false is required - a pre-checked box is its own A2P violation.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "smsNotificationsOptIn" BOOLEAN NOT NULL DEFAULT false;
