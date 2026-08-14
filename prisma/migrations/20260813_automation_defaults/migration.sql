CREATE TABLE IF NOT EXISTS "AutomationDefaults" (
  "id" TEXT NOT NULL DEFAULT 'defaults',
  "autoCostSheetDraft" BOOLEAN NOT NULL DEFAULT false,
  "autoInvoiceDraft" BOOLEAN NOT NULL DEFAULT false,
  "agreementAutomation" TEXT NOT NULL DEFAULT 'off',
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AutomationDefaults_pkey" PRIMARY KEY ("id")
);
