-- Provider-level (agency) authorization for look-alike face matching. The
-- agency attests it has obtained biometric consent from its donors/surrogates;
-- GoStork only indexes faces for authorized agencies. Default off (opt-in).

ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "biometricMatchingAuthorized" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "biometricMatchingAuthorizedAt" TIMESTAMP(3);
