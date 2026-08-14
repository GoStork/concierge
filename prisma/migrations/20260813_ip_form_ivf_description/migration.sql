-- IVF-only copy variant for shared Parent Form sections (surrogate-free
-- wording on the IVF clinic form and PDF). Null = use description.
ALTER TABLE "IpFormSection" ADD COLUMN IF NOT EXISTS "descriptionIvf" TEXT;
