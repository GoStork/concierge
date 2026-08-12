-- Notes and tasks belong to a service line, like everything else on the record.
-- Without it the scope filter showed an egg-donation task while you were
-- looking at surrogacy, because it had nothing to filter them on.
ALTER TABLE "ParentTask" ADD COLUMN IF NOT EXISTS "serviceLine" TEXT;
ALTER TABLE "ParentNote" ADD COLUMN IF NOT EXISTS "serviceLine" TEXT;

-- Backfill what the system already knows: an agreement task follows its
-- agreement's service type. Approvals and whispers are backfilled from their
-- session's subject in the same spirit; anything unattributable stays null,
-- and null always shows.
UPDATE "ParentTask" t SET "serviceLine" = CASE a."serviceType"
    WHEN 'SURROGACY' THEN 'surrogacy'
    WHEN 'EGG_DONATION' THEN 'egg_donation'
    WHEN 'SPERM_DONATION' THEN 'sperm_donation'
    WHEN 'IVF_CLINIC' THEN 'ivf'
    WHEN 'LEGAL' THEN 'legal'
  END
FROM "Agreement" a
WHERE t."systemKey" = 'agreement:' || a.id AND t."serviceLine" IS NULL;

UPDATE "ParentTask" t SET "serviceLine" = CASE
    WHEN lower(s."subjectType") LIKE '%legal%' OR lower(s."subjectType") LIKE '%lawyer%' THEN 'legal'
    WHEN lower(s."subjectType") LIKE '%surrog%' THEN 'surrogacy'
    WHEN lower(s."subjectType") LIKE '%sperm%' THEN 'sperm_donation'
    WHEN lower(s."subjectType") LIKE '%egg%' OR lower(s."subjectType") LIKE '%donor%' THEN 'egg_donation'
    WHEN lower(s."subjectType") LIKE '%ivf%' OR lower(s."subjectType") LIKE '%clinic%' OR lower(s."subjectType") LIKE '%doctor%' THEN 'ivf'
  END
FROM "AiChatMessage" m
JOIN "AiChatSession" s ON s.id = m."sessionId"
WHERE t."systemKey" = 'approval:' || m.id AND t."serviceLine" IS NULL;
