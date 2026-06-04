-- Add partnerProviderIds to Provider for linking surrogacy agencies to their IVF clinic partners
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "partnerProviderIds" jsonb;
