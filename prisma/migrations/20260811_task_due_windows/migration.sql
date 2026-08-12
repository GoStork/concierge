-- System tasks were due the moment their work appeared, so every one of them
-- was overdue on arrival. The materializer now adds a per-kind window; these
-- rows were written before it did, and their dueAt is still the raw appeared-at
-- instant, so add the same window here rather than leaving a mix of both rules.
UPDATE "ParentTask" SET "dueAt" = "dueAt" + interval '24 hours'
  WHERE source = 'SYSTEM' AND status = 'OPEN' AND "systemKey" LIKE 'approval:%';
UPDATE "ParentTask" SET "dueAt" = "dueAt" + interval '2 hours'
  WHERE source = 'SYSTEM' AND status = 'OPEN' AND "systemKey" LIKE 'whisper:%';
UPDATE "ParentTask" SET "dueAt" = "dueAt" + interval '72 hours'
  WHERE source = 'SYSTEM' AND status = 'OPEN' AND "systemKey" LIKE 'review:%';
UPDATE "ParentTask" SET "dueAt" = "dueAt" + interval '120 hours'
  WHERE source = 'SYSTEM' AND status = 'OPEN' AND "systemKey" LIKE 'agreement:%';
