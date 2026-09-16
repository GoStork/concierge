-- Expiry + revocation for login-free signing links (OWASP A07).
-- ProviderAgreement.guestToken and ProviderW9.guestToken were minted once and
-- valid forever, with no way to switch one off. They open executed contracts
-- and tax forms carrying an EIN or SSN.
--
-- Existing rows deliberately get NULL rather than a backfilled deadline:
-- expiring every outstanding link on deploy would strand providers mid
-- signature. They pick one up the next time the link is sent or reminded.
ALTER TABLE "ProviderW9"        ADD COLUMN IF NOT EXISTS "guestTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "ProviderW9"        ADD COLUMN IF NOT EXISTS "guestTokenRevokedAt" TIMESTAMP(3);
ALTER TABLE "ProviderAgreement" ADD COLUMN IF NOT EXISTS "guestTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "ProviderAgreement" ADD COLUMN IF NOT EXISTS "guestTokenRevokedAt" TIMESTAMP(3);
