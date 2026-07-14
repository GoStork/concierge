-- Phase 8 Reviews & Ratings: extend the (empty) ProviderReview table with
-- the milestone-review fields: 1-5 rating, journey context, anonymity,
-- private-feedback visibility, AI-screen notes, provider reply + flag.
ALTER TABLE "ProviderReview" ADD COLUMN IF NOT EXISTS "parentAccountId" TEXT;
ALTER TABLE "ProviderReview" ADD COLUMN IF NOT EXISTS "rating" INTEGER;
ALTER TABLE "ProviderReview" ADD COLUMN IF NOT EXISTS "journeyType" TEXT;
ALTER TABLE "ProviderReview" ADD COLUMN IF NOT EXISTS "stage" TEXT;
ALTER TABLE "ProviderReview" ADD COLUMN IF NOT EXISTS "anonymous" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProviderReview" ADD COLUMN IF NOT EXISTS "visibility" TEXT NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE "ProviderReview" ADD COLUMN IF NOT EXISTS "aiScreenNotes" TEXT;
ALTER TABLE "ProviderReview" ADD COLUMN IF NOT EXISTS "flaggedByProviderAt" TIMESTAMP(3);
ALTER TABLE "ProviderReview" ADD COLUMN IF NOT EXISTS "flagReason" TEXT;
ALTER TABLE "ProviderReview" ADD COLUMN IF NOT EXISTS "providerReply" TEXT;
ALTER TABLE "ProviderReview" ADD COLUMN IF NOT EXISTS "providerReplyAt" TIMESTAMP(3);
ALTER TABLE "ProviderReview" ADD COLUMN IF NOT EXISTS "providerReplyUserId" TEXT;
CREATE INDEX IF NOT EXISTS "ProviderReview_parentAccountId_idx" ON "ProviderReview"("parentAccountId");
