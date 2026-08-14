ALTER TABLE "AutomationDefaults" ADD COLUMN IF NOT EXISTS "costSheetAutomation" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "AutomationDefaults" ADD COLUMN IF NOT EXISTS "invoiceAutomation" TEXT NOT NULL DEFAULT 'auto_send';
UPDATE "AutomationDefaults" SET "costSheetAutomation" = 'approval' WHERE "autoCostSheetDraft" = true;
UPDATE "AutomationDefaults" SET "invoiceAutomation" = 'approval' WHERE "autoInvoiceDraft" = true;
ALTER TABLE "AutomationDefaults" DROP COLUMN IF EXISTS "autoCostSheetDraft";
ALTER TABLE "AutomationDefaults" DROP COLUMN IF EXISTS "autoInvoiceDraft";
