-- One sentence in the person's own words, chosen once by the enrichment model
-- and stored, so the quote a parent reads is stable across page loads.
ALTER TABLE "EggDonor"   ADD COLUMN IF NOT EXISTS "highlightQuote" TEXT;
ALTER TABLE "Surrogate"  ADD COLUMN IF NOT EXISTS "highlightQuote" TEXT;
ALTER TABLE "SpermDonor" ADD COLUMN IF NOT EXISTS "highlightQuote" TEXT;
