-- IP form: track whether the parent manually overrode the two-vs-solo
-- inference. When false, hasSecondParent is derived from IP1's marital status.
ALTER TABLE "IpFormResponse" ADD COLUMN IF NOT EXISTS "hasSecondParentManual" BOOLEAN NOT NULL DEFAULT false;
