-- Agreements gain the supersede concept cost sheets already had.
--
-- Before this, an agency that sent an agreement twice left the first one
-- SENT forever: nothing marked it replaced when the second was signed, so
-- the parents table showed a permanent "Awaiting" beside the "Signed".
--
-- serviceType already existed on the model but the legacy generateAgreement
-- path never populated it, so agreements could not be attributed to a
-- service line. The backfill below derives it from the agreement's own chat
-- session, which is where the document was actually generated.

ALTER TABLE "Agreement" ADD COLUMN IF NOT EXISTS "supersededAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Agreement_supersededAt_idx" ON "Agreement"("supersededAt");

-- Backfill 1: service line from the session the agreement was generated in.
-- Only fills NULLs - a template-generated agreement already knows its type.
UPDATE "Agreement" a
SET "serviceType" = CASE
    WHEN s."subjectType" ILIKE '%egg%'                                       THEN 'EGG_DONATION'
    WHEN s."subjectType" ILIKE '%surrog%'                                    THEN 'SURROGACY'
    WHEN s."subjectType" ILIKE '%sperm%'                                     THEN 'SPERM_DONATION'
    WHEN s."subjectType" ILIKE '%ivf%' OR s."subjectType" ILIKE '%clinic%'
      OR s."subjectType" ILIKE '%doctor%'                                    THEN 'IVF_CLINIC'
  END
FROM "AiChatSession" s
WHERE s.id = a."sessionId"
  AND a."serviceType" IS NULL
  AND s."subjectType" IS NOT NULL;

-- Backfill 2: an unsigned agreement is superseded by a LATER signed one for
-- the same parent + provider + documentType. Stamped with the signed one's
-- signedAt so the audit trail reads correctly.
UPDATE "Agreement" stale
SET "supersededAt" = winner."signedAt"
FROM "Agreement" winner
WHERE winner."parentUserId" = stale."parentUserId"
  AND winner."providerId"   = stale."providerId"
  AND winner."documentType" = stale."documentType"
  AND winner.status = 'SIGNED'
  AND winner."signedAt" IS NOT NULL
  AND winner.id <> stale.id
  AND stale.status <> 'SIGNED'
  AND stale."supersededAt" IS NULL
  AND stale."createdAt" < winner."createdAt";
