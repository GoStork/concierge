-- Tags are removed from the product.
--
-- The CRM kept a per-audience tag vocabulary and per-parent assignments. In
-- practice nobody used them: both tables were empty, and what the tables were
-- reached for (who owns this family, what happens next) is answered by the
-- owner and task columns instead. Dropping rather than hiding, so nothing is
-- left half-wired for the next person to wonder about.
DROP TABLE IF EXISTS "ParentTagAssignment";
DROP TABLE IF EXISTS "ParentTagDefinition";

-- One event from testing the feature, pointing at a tag id that no longer
-- exists. It has nothing left to render.
DELETE FROM "JourneyEvent" WHERE "eventType" = 'CRM_TAG_ADDED';
