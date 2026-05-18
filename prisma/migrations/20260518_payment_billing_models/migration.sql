-- GoStork Payment & Billing Models
-- Phase 1: ReferralFeeConfig, Invoice, InvoiceReminder, ProviderBankAccount
-- Also: Provider billing fields, Booking meetingSubtype, Agreement invoiceId

-- Add billing fields to Provider
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "depositMilestone" TEXT;
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "averageClearanceDays" INTEGER;

-- Add meetingSubtype to Booking
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "meetingSubtype" TEXT;

-- ReferralFeeConfig: configurable referral fee per provider
CREATE TABLE IF NOT EXISTS "ReferralFeeConfig" (
  "id"         TEXT        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "providerId" TEXT        NOT NULL UNIQUE,
  "feeType"    TEXT        NOT NULL,
  "flatAmount" DECIMAL,
  "percentage" DECIMAL,
  "currency"   TEXT        NOT NULL DEFAULT 'USD',
  "isActive"   BOOLEAN     NOT NULL DEFAULT true,
  "notes"      TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferralFeeConfig_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE
);

-- Invoice: tracks parent payments and provider payouts
CREATE TABLE IF NOT EXISTS "Invoice" (
  "id"                          TEXT        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "paymentToken"                TEXT        NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  "providerId"                  TEXT        NOT NULL,
  "parentUserId"                TEXT        NOT NULL,
  "sessionId"                   TEXT        NOT NULL,
  "referralFeeConfigId"         TEXT,
  "serviceAmount"               INTEGER     NOT NULL,
  "referralFeeAmount"           INTEGER     NOT NULL,
  "providerPayoutAmount"        INTEGER     NOT NULL,
  "currency"                    TEXT        NOT NULL DEFAULT 'USD',
  "serviceType"                 TEXT        NOT NULL,
  "providerName"                TEXT        NOT NULL,
  "description"                 TEXT,
  "dueAt"                       TIMESTAMP(3),
  "status"                      TEXT        NOT NULL DEFAULT 'AWAITING_PAYMENT',
  "paymentMethod"               TEXT,
  "braintreeTransactionId"      TEXT        UNIQUE,
  "braintreeAuthorizationId"    TEXT,
  "braintreePaymentLinkUrl"     TEXT,
  "isProtected"                 BOOLEAN     NOT NULL DEFAULT true,
  "medicalClearanceStatus"      TEXT,
  "clearanceConfirmedAt"        TIMESTAMP(3),
  "creditTransferredToInvoiceId" TEXT,
  "dwollaPaymentTransferUrl"    TEXT,
  "dwollaPayoutTransferUrl"     TEXT,
  "authorizedAt"                TIMESTAMP(3),
  "capturedAt"                  TIMESTAMP(3),
  "paidAt"                      TIMESTAMP(3),
  "payoutInitiatedAt"           TIMESTAMP(3),
  "payoutCompletedAt"           TIMESTAMP(3),
  "adminNotes"                  TEXT,
  "manualOverride"              BOOLEAN     NOT NULL DEFAULT false,
  "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Invoice_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id"),
  CONSTRAINT "Invoice_parentUserId_fkey"
    FOREIGN KEY ("parentUserId") REFERENCES "User"("id"),
  CONSTRAINT "Invoice_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "AiChatSession"("id"),
  CONSTRAINT "Invoice_referralFeeConfigId_fkey"
    FOREIGN KEY ("referralFeeConfigId") REFERENCES "ReferralFeeConfig"("id")
);

CREATE INDEX IF NOT EXISTS "Invoice_providerId_idx"    ON "Invoice"("providerId");
CREATE INDEX IF NOT EXISTS "Invoice_parentUserId_idx"  ON "Invoice"("parentUserId");
CREATE INDEX IF NOT EXISTS "Invoice_sessionId_idx"     ON "Invoice"("sessionId");
CREATE INDEX IF NOT EXISTS "Invoice_status_idx"        ON "Invoice"("status");
CREATE INDEX IF NOT EXISTS "Invoice_paymentToken_idx"  ON "Invoice"("paymentToken");

-- InvoiceReminder: tracks all automated reminder messages sent
CREATE TABLE IF NOT EXISTS "InvoiceReminder" (
  "id"           TEXT        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "invoiceId"    TEXT        NOT NULL,
  "sentAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "channel"      TEXT        NOT NULL,
  "reminderType" TEXT        NOT NULL,
  CONSTRAINT "InvoiceReminder_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "InvoiceReminder_invoiceId_idx" ON "InvoiceReminder"("invoiceId");

-- ProviderBankAccount: for Phase 2 Dwolla ACH payouts
CREATE TABLE IF NOT EXISTS "ProviderBankAccount" (
  "id"                    TEXT        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "providerId"            TEXT        NOT NULL UNIQUE,
  "dwollaCustomerId"      TEXT,
  "dwollaFundingSourceId" TEXT,
  "bankName"              TEXT,
  "accountLast4"          TEXT,
  "accountType"           TEXT,
  "status"                TEXT        NOT NULL DEFAULT 'PENDING',
  "verifiedAt"            TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderBankAccount_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE
);

-- Add invoiceId to Agreement (payment gate) - done after Invoice table is created
ALTER TABLE "Agreement" ADD COLUMN IF NOT EXISTS "invoiceId" TEXT UNIQUE;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Agreement_invoiceId_fkey'
  ) THEN
    ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_invoiceId_fkey"
      FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id");
  END IF;
END $$;
