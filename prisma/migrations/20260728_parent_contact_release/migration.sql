-- Gate B (CONTACT) of the two-tier parent privacy model.
--
-- One row per (provider org, parent account) pair that has earned the parent's
-- contact details. Until a row exists the provider sees a name and never an
-- email, phone, date of birth, address or IP-form PDF.

CREATE TABLE IF NOT EXISTS "ParentContactRelease" (
  "id"               TEXT NOT NULL,
  "providerId"       TEXT NOT NULL,
  "parentAccountId"  TEXT NOT NULL,
  "reason"           TEXT NOT NULL,
  "releasedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedByUserId" TEXT,
  "note"             TEXT,
  CONSTRAINT "ParentContactRelease_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "ParentContactRelease"
    ADD CONSTRAINT "ParentContactRelease_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ParentContactRelease_providerId_parentAccountId_key"
  ON "ParentContactRelease"("providerId", "parentAccountId");
CREATE INDEX IF NOT EXISTS "ParentContactRelease_parentAccountId_idx"
  ON "ParentContactRelease"("parentAccountId");

-- ── Backfill ────────────────────────────────────────────────────────────────
-- Must ship in the SAME migration as the table. The read paths start hiding
-- contact the moment they deploy, so without this every provider who already
-- holds an invoice, a sent agreement or a submitted IP form would abruptly lose
-- an address they have legitimately had for months.

-- Any Invoice row means the provider sent one: drafts live in
-- AiChatMessage.uiCardData and only become an Invoice on provider approval.
INSERT INTO "ParentContactRelease" (id, "providerId", "parentAccountId", reason, "releasedAt")
SELECT gen_random_uuid()::text, i."providerId", COALESCE(u."parentAccountId", u.id), 'INVOICE', MIN(i."createdAt")
FROM "Invoice" i
JOIN "User" u ON u.id = i."parentUserId"
GROUP BY i."providerId", COALESCE(u."parentAccountId", u.id)
ON CONFLICT ("providerId", "parentAccountId") DO NOTHING;

-- Agreements: DRAFT and CREATED exist before anything is sent to the parent,
-- and ERROR never reached them. Everything else has been sent.
INSERT INTO "ParentContactRelease" (id, "providerId", "parentAccountId", reason, "releasedAt")
SELECT gen_random_uuid()::text, a."providerId", COALESCE(u."parentAccountId", u.id), 'AGREEMENT', MIN(a."createdAt")
FROM "Agreement" a
JOIN "User" u ON u.id = a."parentUserId"
WHERE a.status NOT IN ('DRAFT', 'CREATED', 'ERROR')
GROUP BY a."providerId", COALESCE(u."parentAccountId", u.id)
ON CONFLICT ("providerId", "parentAccountId") DO NOTHING;

-- Submitted IP forms, crossed with the form-collecting providers the parent has
-- actually met. The status filter matters: the form is ONE global submission per
-- account with no provider column, and the notify fan-out has historically had
-- no status filter at all, so without this an agency that answered a single
-- anonymous whisper would be backfilled a home address.
INSERT INTO "ParentContactRelease" (id, "providerId", "parentAccountId", reason, "releasedAt")
SELECT gen_random_uuid()::text, x."providerId", x."parentAccountId", 'IP_FORM', MIN(x."submittedAt")
FROM (
  SELECT p.id AS "providerId", r."parentAccountId", r."submittedAt"
  FROM "IpFormResponse" r
  JOIN "User" u ON COALESCE(u."parentAccountId", u.id) = r."parentAccountId"
  JOIN "AiChatSession" s ON s."userId" = u.id AND s."providerId" IS NOT NULL
    AND s.status IN ('CONSULTATION_BOOKED', 'PROVIDER_CONNECTED')
  JOIN "Provider" p ON p.id = s."providerId" AND p."collectsIntendedParentForm" = true
  WHERE r.status = 'SUBMITTED' AND r."submittedAt" IS NOT NULL

  UNION

  SELECT p.id AS "providerId", r."parentAccountId", r."submittedAt"
  FROM "IpFormResponse" r
  JOIN "User" u ON COALESCE(u."parentAccountId", u.id) = r."parentAccountId"
  JOIN "Booking" b ON b."parentUserId" = u.id
  JOIN "User" pu ON pu.id = b."providerUserId" AND pu."providerId" IS NOT NULL
  JOIN "Provider" p ON p.id = pu."providerId" AND p."collectsIntendedParentForm" = true
  WHERE r.status = 'SUBMITTED' AND r."submittedAt" IS NOT NULL
) x
GROUP BY x."providerId", x."parentAccountId"
ON CONFLICT ("providerId", "parentAccountId") DO NOTHING;
