-- The 20260601_cost_sheet_subtypes migration backfilled subType to
-- 'ivf_cycle_own_eggs_own_carry' on every program in the table, including
-- programs that only belong to sperm-bank, egg-bank, or surrogacy-only
-- packages. The IVF subtype taxonomy doesn't apply to those, and the
-- stale value broke matching - the parent-programs matcher's subType
-- filter excluded every non-IVF program for any parent without IVF
-- eligibility. Clear the column for any program whose serviceTypes does
-- NOT include 'ivf_clinic' so the data matches reality.
UPDATE "CostProgram"
SET "subType" = NULL
WHERE NOT ('ivf_clinic' = ANY("serviceTypes"));
