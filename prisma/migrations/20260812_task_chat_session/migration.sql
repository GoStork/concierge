-- A task can point at its artifact AND at the conversation it came out of.
-- "Agreement out for signature" opens the agreement; it should also be able to
-- open the thread it was sent from, the way every other activity card can.
ALTER TABLE "ParentTask" ADD COLUMN IF NOT EXISTS "chatSessionId" TEXT;

UPDATE "ParentTask" t SET "chatSessionId" = a."sessionId"
FROM "Agreement" a
WHERE t."systemKey" = 'agreement:' || a.id AND t."chatSessionId" IS NULL;
