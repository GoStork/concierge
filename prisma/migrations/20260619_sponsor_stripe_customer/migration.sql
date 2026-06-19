-- Provider-level Stripe customer for sponsorship billing (saved-card reuse).
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "sponsorStripeCustomerId" TEXT;
