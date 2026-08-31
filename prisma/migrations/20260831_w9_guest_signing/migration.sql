-- Login-free W-9 signing: token-gated public link + opened-at tracking (mirrors ProviderAgreement).
ALTER TABLE "ProviderW9" ADD COLUMN IF NOT EXISTS "guestToken" TEXT;
ALTER TABLE "ProviderW9" ADD COLUMN IF NOT EXISTS "guestOpenedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderW9_guestToken_key" ON "ProviderW9"("guestToken");
