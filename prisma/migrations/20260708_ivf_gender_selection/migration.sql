-- IVF clinic matching requirement: is embryo gender selection allowed?
-- Nullable: null means the clinic hasn't answered, and unknown skips the rule.
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "ivfGenderSelectionAllowed" BOOLEAN;
