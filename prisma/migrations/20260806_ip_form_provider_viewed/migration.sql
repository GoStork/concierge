-- Per-provider "viewed" receipts for submitted Intended Parent Forms.
-- providerId -> ISO timestamp; used to clear the provider home work-queue item.
ALTER TABLE "IpFormResponse" ADD COLUMN IF NOT EXISTS "providerViewedAt" JSONB NOT NULL DEFAULT '{}';
