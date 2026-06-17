-- Profile Sponsorship: SponsorshipPlan / Sponsorship / SponsorshipItem tables,
-- enums, and denormalized boost columns on each sponsorable entity.

-- Enums (idempotent)
DO $$ BEGIN
  CREATE TYPE "SponsorshipProductType" AS ENUM ('SLOT_BUNDLE', 'WHOLE_PROFILE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "SponsorshipBillingMode" AS ENUM ('AUTO_RENEW', 'ONE_TIME');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "SponsorshipStatus" AS ENUM ('PENDING_PAYMENT', 'ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "SponsoredEntityType" AS ENUM ('EGG_DONOR', 'SURROGATE', 'SPERM_DONOR', 'DOCTOR', 'CLINIC_PROFILE', 'AGENCY_PROFILE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- SponsorshipPlan (pricing config)
CREATE TABLE IF NOT EXISTS "SponsorshipPlan" (
  "id"              TEXT NOT NULL,
  "productType"     "SponsorshipProductType" NOT NULL,
  "tierKey"         TEXT NOT NULL,
  "displayName"     TEXT NOT NULL,
  "priceCents"      INTEGER NOT NULL,
  "currency"        TEXT NOT NULL DEFAULT 'USD',
  "slotCount"       INTEGER NOT NULL,
  "stripeProductId" TEXT,
  "stripePriceId"   TEXT,
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SponsorshipPlan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SponsorshipPlan_productType_tierKey_key"
  ON "SponsorshipPlan"("productType", "tierKey");

-- Sponsorship (one per purchase)
CREATE TABLE IF NOT EXISTS "Sponsorship" (
  "id"                    TEXT NOT NULL,
  "providerId"            TEXT NOT NULL,
  "planId"                TEXT NOT NULL,
  "productType"           "SponsorshipProductType" NOT NULL,
  "billingMode"           "SponsorshipBillingMode" NOT NULL,
  "status"                "SponsorshipStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
  "priceCentsSnapshot"    INTEGER NOT NULL,
  "currency"              TEXT NOT NULL DEFAULT 'USD',
  "slotCountSnapshot"     INTEGER NOT NULL,
  "currentPeriodStart"    TIMESTAMP(3),
  "currentPeriodEnd"      TIMESTAMP(3),
  "canceledAt"            TIMESTAMP(3),
  "endedAt"               TIMESTAMP(3),
  "stripeCustomerId"      TEXT,
  "stripeSubscriptionId"  TEXT,
  "stripePaymentIntentId" TEXT,
  "stripePriceId"         TEXT,
  "isComped"              BOOLEAN NOT NULL DEFAULT false,
  "compedByUserId"        TEXT,
  "compReason"            TEXT,
  "createdByAdmin"        BOOLEAN NOT NULL DEFAULT false,
  "createdByUserId"       TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Sponsorship_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Sponsorship_stripeSubscriptionId_key"
  ON "Sponsorship"("stripeSubscriptionId");
CREATE INDEX IF NOT EXISTS "Sponsorship_providerId_status_idx"
  ON "Sponsorship"("providerId", "status");
CREATE INDEX IF NOT EXISTS "Sponsorship_status_currentPeriodEnd_idx"
  ON "Sponsorship"("status", "currentPeriodEnd");
CREATE INDEX IF NOT EXISTS "Sponsorship_stripeSubscriptionId_idx"
  ON "Sponsorship"("stripeSubscriptionId");

-- SponsorshipItem (each filled slot)
CREATE TABLE IF NOT EXISTS "SponsorshipItem" (
  "id"            TEXT NOT NULL,
  "sponsorshipId" TEXT NOT NULL,
  "entityType"    "SponsoredEntityType" NOT NULL,
  "entityId"      TEXT NOT NULL,
  "addedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removedAt"     TIMESTAMP(3),
  CONSTRAINT "SponsorshipItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SponsorshipItem_sponsorshipId_entityType_entityId_key"
  ON "SponsorshipItem"("sponsorshipId", "entityType", "entityId");
CREATE INDEX IF NOT EXISTS "SponsorshipItem_entityType_entityId_idx"
  ON "SponsorshipItem"("entityType", "entityId");

-- Foreign keys (idempotent)
DO $$ BEGIN
  ALTER TABLE "Sponsorship" ADD CONSTRAINT "Sponsorship_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "Sponsorship" ADD CONSTRAINT "Sponsorship_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "SponsorshipPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "SponsorshipItem" ADD CONSTRAINT "SponsorshipItem_sponsorshipId_fkey"
    FOREIGN KEY ("sponsorshipId") REFERENCES "Sponsorship"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Denormalized boost columns on each sponsorable entity
ALTER TABLE "EggDonor"       ADD COLUMN IF NOT EXISTS "sponsoredUntil" TIMESTAMP(3);
ALTER TABLE "EggDonor"       ADD COLUMN IF NOT EXISTS "sponsorBoostSeed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Surrogate"      ADD COLUMN IF NOT EXISTS "sponsoredUntil" TIMESTAMP(3);
ALTER TABLE "Surrogate"      ADD COLUMN IF NOT EXISTS "sponsorBoostSeed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SpermDonor"     ADD COLUMN IF NOT EXISTS "sponsoredUntil" TIMESTAMP(3);
ALTER TABLE "SpermDonor"     ADD COLUMN IF NOT EXISTS "sponsorBoostSeed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "sponsoredUntil" TIMESTAMP(3);
ALTER TABLE "ProviderMember" ADD COLUMN IF NOT EXISTS "sponsorBoostSeed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Provider"       ADD COLUMN IF NOT EXISTS "sponsoredUntil" TIMESTAMP(3);
ALTER TABLE "Provider"       ADD COLUMN IF NOT EXISTS "sponsorBoostSeed" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "EggDonor_sponsoredUntil_idx"       ON "EggDonor"("sponsoredUntil");
CREATE INDEX IF NOT EXISTS "Surrogate_sponsoredUntil_idx"      ON "Surrogate"("sponsoredUntil");
CREATE INDEX IF NOT EXISTS "SpermDonor_sponsoredUntil_idx"     ON "SpermDonor"("sponsoredUntil");
CREATE INDEX IF NOT EXISTS "ProviderMember_sponsoredUntil_idx" ON "ProviderMember"("sponsoredUntil");
CREATE INDEX IF NOT EXISTS "Provider_sponsoredUntil_idx"       ON "Provider"("sponsoredUntil");
