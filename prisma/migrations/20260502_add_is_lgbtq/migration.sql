-- Add isLGBTQ field to capture LGBTQ+ identity for both solo and coupled parents.
-- Replaces the narrow sameSexCouple flag for surrogate matching (openToSameSexCouple
-- filter now applies to any LGBTQ+ parent, not just same-sex couples).
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "isLGBTQ" BOOLEAN;
