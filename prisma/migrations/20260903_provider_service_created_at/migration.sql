-- ProviderService.createdAt: when a service line was requested. Lets the
-- admin Home "Needs attention" queue show and order pending service requests.
ALTER TABLE "ProviderService" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
