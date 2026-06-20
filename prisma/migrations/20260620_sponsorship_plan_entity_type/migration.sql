-- Scope slot-bundle plans to a specific sub-profile type (egg donors / sperm
-- donors / surrogates / doctors) so tiers can be sized per roster.
ALTER TABLE "SponsorshipPlan" ADD COLUMN IF NOT EXISTS "slotEntityType" "SponsoredEntityType";
