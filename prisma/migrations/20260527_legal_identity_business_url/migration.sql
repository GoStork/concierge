-- Business website URL on ProviderLegalIdentity.
-- Required by Stripe Connect Custom for business_profile.url. UI pre-fills
-- this from Provider.websiteUrl (Company tab) on first read; provider can
-- override if the legal-entity site differs from the marketing site.
ALTER TABLE "ProviderLegalIdentity"
  ADD COLUMN IF NOT EXISTS "businessUrl" TEXT;
