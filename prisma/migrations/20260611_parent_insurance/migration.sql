-- Parent's own insurance (drives the marketplace insurance filter)
ALTER TABLE "IntendedParentProfile" ADD COLUMN IF NOT EXISTS "insurance" TEXT;
