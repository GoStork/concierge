-- Captures the base URL of whichever environment generated the agreement.
-- The PandaDoc webhook handler reads this to build the next-signer email
-- link so multi-environment webhook fan-out (dev ngrok + Replit + prod
-- subscriptions all firing on the same recipient_completed event) still
-- yields the right URL regardless of which server processes the event.
ALTER TABLE "Agreement"
  ADD COLUMN IF NOT EXISTS "originAppUrl" TEXT;
