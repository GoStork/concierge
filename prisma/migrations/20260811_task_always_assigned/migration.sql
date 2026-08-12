-- Every task names who it is waiting on. "Unassigned" was a queue nobody read,
-- and it was wrong besides: an agreement sitting unsigned is the FAMILY's move,
-- not nobody's. The materializer now writes these names; this brings the rows
-- that were raised before it did into line.
UPDATE "ParentTask" t
SET "assigneeName" = COALESCE(u."firstName", split_part(u.name, ' ', 1), 'the family'),
    "assigneeUserId" = NULL
FROM "Agreement" a
JOIN "User" u ON u.id = a."parentUserId"
WHERE t."systemKey" = 'agreement:' || a.id AND t.status = 'OPEN';

-- Work that is the team's rather than one person's wears the org's name. It is
-- not a user, so no reminder is ever addressed to it.
UPDATE "ParentTask" t
SET "assigneeName" = p.name
FROM "Provider" p
WHERE t."providerId" = p.id AND t.source = 'SYSTEM' AND t.status = 'OPEN' AND t."assigneeName" IS NULL;
