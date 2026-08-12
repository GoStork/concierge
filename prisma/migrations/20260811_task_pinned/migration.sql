-- Tasks can be pinned, the way notes already could. One pinned activity per
-- audience is enforced in the pin endpoint rather than by a constraint: it has
-- to span two tables (a note and a task compete for the same single pin), and
-- the user is asked before the other one is displaced.
ALTER TABLE "ParentTask" ADD COLUMN IF NOT EXISTS "pinned" BOOLEAN NOT NULL DEFAULT false;
