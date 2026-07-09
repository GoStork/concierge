-- ASRM minimum-requirements enforcement for surrogates
-- Provider: new "Min Deliveries" matching requirement (ASRM: at least 1 prior delivery)
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "ivfSurrogateMinDeliveries" INTEGER;

-- Surrogate: structured abortions count (promoted from profileData so it can be enforced)
ALTER TABLE "Surrogate" ADD COLUMN IF NOT EXISTS "abortions" INTEGER;

-- Surrogate: system-owned ASRM gate. Set automatically on sync/upload/edit;
-- providers cannot clear it. Parent-facing queries exclude asrmHidden rows.
ALTER TABLE "Surrogate" ADD COLUMN IF NOT EXISTS "asrmHidden" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Surrogate" ADD COLUMN IF NOT EXISTS "asrmFailReasons" JSONB;
