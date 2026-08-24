-- Login-free provider agreement signing: token-gated public link + opened-at tracking.
ALTER TABLE "ProviderAgreement" ADD COLUMN IF NOT EXISTS "guestToken" TEXT;
ALTER TABLE "ProviderAgreement" ADD COLUMN IF NOT EXISTS "guestOpenedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderAgreement_guestToken_key" ON "ProviderAgreement"("guestToken");
