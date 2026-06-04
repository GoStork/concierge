-- Live progress for the background Gemini parse on a ProviderCostSheet.
-- Populated by costs.controller.backgroundParseAndSave as items stream in;
-- read by the client poll to drive a real (non-fake) progress bar.
ALTER TABLE "ProviderCostSheet" ADD COLUMN IF NOT EXISTS "parseStage" TEXT;
ALTER TABLE "ProviderCostSheet" ADD COLUMN IF NOT EXISTS "parseProgress" INTEGER DEFAULT 0;
ALTER TABLE "ProviderCostSheet" ADD COLUMN IF NOT EXISTS "parseItemsCount" INTEGER DEFAULT 0;
