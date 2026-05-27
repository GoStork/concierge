-- Provider payout account: repurpose the existing ProviderBankAccount (which
-- had Dwolla-shaped fields that were never wired up) for Stripe Connect.
-- Two payout methods supported via `payoutMethod`:
--   STRIPE_CONNECT_EXPRESS - Stripe-hosted onboarding
--   STRIPE_CONNECT_CUSTOM  - GoStork-owned form (controller.dashboard.type=none)
-- In both cases stripeConnectAccountId points at the same shape of Stripe
-- account; only the controller config at creation time differs.

-- 1. Add new columns (nullable / default so existing rows survive).
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "payoutMethod" TEXT;
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "stripeConnectAccountId" TEXT;
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "payoutsEnabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "chargesEnabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "detailsSubmitted" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "requirementsCurrentlyDue" JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "requirementsEventuallyDue" JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "requirementsPastDue" JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "requirementsDisabledReason" TEXT;
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "onboardingStartedAt" TIMESTAMP(3);
ALTER TABLE "ProviderBankAccount" ADD COLUMN IF NOT EXISTS "onboardingCompletedAt" TIMESTAMP(3);

-- 2. Drop the never-wired Dwolla columns + the legacy status/verifiedAt
-- (replaced by payoutsEnabled / onboardingCompletedAt). These rows were
-- always empty in practice - no data to preserve.
ALTER TABLE "ProviderBankAccount" DROP COLUMN IF EXISTS "dwollaCustomerId";
ALTER TABLE "ProviderBankAccount" DROP COLUMN IF EXISTS "dwollaFundingSourceId";
ALTER TABLE "ProviderBankAccount" DROP COLUMN IF EXISTS "status";
ALTER TABLE "ProviderBankAccount" DROP COLUMN IF EXISTS "verifiedAt";

-- 3. Unique index on stripeConnectAccountId so we can resolve a Stripe
-- webhook event back to the right provider in O(1).
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderBankAccount_stripeConnectAccountId_key"
  ON "ProviderBankAccount" ("stripeConnectAccountId");
