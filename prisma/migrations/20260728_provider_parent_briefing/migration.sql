-- Private parent briefing: an AI-written summary of the parent, posted into the
-- 3-way thread as a provider-only message when the first consultation is booked.

CREATE TABLE IF NOT EXISTS "ProviderParentBriefing" (
  "id"              TEXT NOT NULL,
  "providerId"      TEXT NOT NULL,
  "parentAccountId" TEXT,
  "parentUserId"    TEXT NOT NULL,
  "providerTypeId"  TEXT,
  "sessionId"       TEXT NOT NULL,
  "bookingId"       TEXT,
  "messageId"       TEXT,
  "sentAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderParentBriefing_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ProviderParentBriefing_providerId_parentAccountId_idx"
  ON "ProviderParentBriefing" ("providerId", "parentAccountId");
CREATE INDEX IF NOT EXISTS "ProviderParentBriefing_providerId_parentUserId_idx"
  ON "ProviderParentBriefing" ("providerId", "parentUserId");

-- "Once per parent + provider + service line", enforced in the DB so a
-- duplicate booking POST (or the other Mac's process) cannot double-post a
-- second briefing. COALESCE because NULL <> NULL in Postgres would let a plain
-- UNIQUE through. Keyed on the parent ACCOUNT when there is one, else the user.
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderParentBriefing_once_key"
  ON "ProviderParentBriefing" (
    "providerId",
    COALESCE("parentAccountId", "parentUserId"),
    COALESCE("providerTypeId", '')
  );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProviderParentBriefing_providerId_fkey') THEN
    ALTER TABLE "ProviderParentBriefing" ADD CONSTRAINT "ProviderParentBriefing_providerId_fkey"
      FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
