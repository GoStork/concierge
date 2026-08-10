-- ProviderQuote.serviceType: which service line a quote prices.
--
-- Agreements and invoices already carry this; quotes did not, so the parent
-- record had to infer it from the source cost sheet - which over half of
-- quotes do not have (they are typed straight into a thread), leaving their
-- document card unable to say what the money was for.
ALTER TABLE "ProviderQuote" ADD COLUMN IF NOT EXISTS "serviceType" TEXT;

-- Backfill from the thread's subject, the same signal serviceTypeOfSession
-- uses for agreements, so history matches what new sends will store.
UPDATE "ProviderQuote" q
SET "serviceType" = CASE
    WHEN lower(s."subjectType") LIKE '%egg%'    THEN 'EGG_DONATION'
    WHEN lower(s."subjectType") LIKE '%surrog%' THEN 'SURROGACY'
    WHEN lower(s."subjectType") LIKE '%sperm%'  THEN 'SPERM_DONATION'
    WHEN lower(s."subjectType") LIKE '%ivf%'
      OR lower(s."subjectType") LIKE '%clinic%'
      OR lower(s."subjectType") LIKE '%doctor%' THEN 'IVF_CLINIC'
  END
FROM "AiChatSession" s
WHERE s.id = q."sessionId" AND q."serviceType" IS NULL;

-- Anything the thread could not answer falls back to the source sheet's
-- canonical coverage.
UPDATE "ProviderQuote" q
SET "serviceType" = CASE
    WHEN lower(cs."subTypes"[1]) LIKE '%egg%'    THEN 'EGG_DONATION'
    WHEN lower(cs."subTypes"[1]) LIKE '%surrog%' THEN 'SURROGACY'
    WHEN lower(cs."subTypes"[1]) LIKE '%sperm%'  THEN 'SPERM_DONATION'
    WHEN lower(cs."subTypes"[1]) LIKE '%ivf%'    THEN 'IVF_CLINIC'
  END
FROM "ProviderCostSheet" cs
WHERE cs.id = q."sourceCostSheetId" AND q."serviceType" IS NULL;
