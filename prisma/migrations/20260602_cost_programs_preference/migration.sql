-- Persistence for the parent-facing cost-programs tailor form on
-- provider profiles. Three valid string values: null (ask), "tailored"
-- (don't re-ask, use matcher), "show_all" (don't ask, bypass matcher).
ALTER TABLE "IntendedParentProfile"
  ADD COLUMN IF NOT EXISTS "costProgramsPreference" TEXT;
