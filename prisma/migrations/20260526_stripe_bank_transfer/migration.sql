-- Stripe bank-transfer (customer_balance) support
--
-- User.stripeCustomerId: nullable, unique. Lazily created the first time
-- the parent triggers a payment method that requires a Customer object
-- (currently bank-transfer / customer_balance). Card payments still use
-- guest checkout.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT;

-- Unique index, but only over non-null rows so existing parents who do not
-- yet have a customer id don't all collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "User_stripeCustomerId_key"
  ON "User" ("stripeCustomerId")
  WHERE "stripeCustomerId" IS NOT NULL;

-- Invoice: bank-transfer PI ID and cached wire instructions JSON. Stored
-- separately from stripePaymentIntentId so a parent can have both an open
-- card intent and an open wire intent on the same invoice without one
-- clobbering the other.
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "stripeWirePaymentIntentId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "wireInstructionsJson" JSONB;
