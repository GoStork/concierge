-- Automatic welcome-email reminder ladder (day 3/7/10) while no admin has logged in.
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "welcomeRemindCount" INTEGER NOT NULL DEFAULT 0;
