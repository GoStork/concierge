-- International providers: W-8BEN-E template set + per-row form type.
ALTER TABLE "ProviderW9" ADD COLUMN IF NOT EXISTS "formType" TEXT NOT NULL DEFAULT 'W9';
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "w8beneTemplateUrl" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "w8beneTemplateOriginalName" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "w8benePandaDocTemplateId" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "w8benePandaDocRoles" TEXT;
ALTER TABLE "SiteSettings" ADD COLUMN IF NOT EXISTS "w8beneTemplateUpdatedAt" TIMESTAMP(3);
