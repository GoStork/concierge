-- Look-alike face matching is now opt-OUT: authorized by default for all
-- providers (donor agencies), backed by the agency agreement's biometric
-- rep/warranty. Agencies without donor consent turn it off explicitly.

ALTER TABLE "Provider" ALTER COLUMN "biometricMatchingAuthorized" SET DEFAULT true;

UPDATE "Provider"
SET "biometricMatchingAuthorized" = true,
    "biometricMatchingAuthorizedAt" = COALESCE("biometricMatchingAuthorizedAt", NOW())
WHERE "biometricMatchingAuthorized" = false;
