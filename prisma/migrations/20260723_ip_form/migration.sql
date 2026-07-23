-- Intended Parent Form: global admin-editable template (sections/questions),
-- one response per parent account, per-slot answers, native signatures,
-- guest tokens for parent 2, and the reminder dedupe ledger.

CREATE TABLE IF NOT EXISTS "IpFormSection" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "perParent" BOOLEAN NOT NULL DEFAULT false,
  "excludeFromSurrogatePdf" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IpFormSection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "IpFormSection_key_key" ON "IpFormSection"("key");

CREATE TABLE IF NOT EXISTS "IpFormQuestion" (
  "id" TEXT NOT NULL,
  "sectionId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "helpText" TEXT,
  "widget" TEXT NOT NULL,
  "options" JSONB,
  "required" BOOLEAN NOT NULL DEFAULT false,
  "perParent" BOOLEAN NOT NULL DEFAULT false,
  "excludeFromSurrogatePdf" BOOLEAN NOT NULL DEFAULT false,
  "conditionalOnQuestionId" TEXT,
  "conditionalTriggerValue" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IpFormQuestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IpFormQuestion_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "IpFormSection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "IpFormQuestion_key_key" ON "IpFormQuestion"("key");
CREATE INDEX IF NOT EXISTS "IpFormQuestion_sectionId_sortOrder_idx" ON "IpFormQuestion"("sectionId", "sortOrder");

CREATE TABLE IF NOT EXISTS "IpFormResponse" (
  "id" TEXT NOT NULL,
  "parentAccountId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "hasSecondParent" BOOLEAN NOT NULL DEFAULT true,
  "parent2Mode" TEXT,
  "promptedAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IpFormResponse_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "IpFormResponse_parentAccountId_key" ON "IpFormResponse"("parentAccountId");

CREATE TABLE IF NOT EXISTS "IpFormAnswer" (
  "id" TEXT NOT NULL,
  "responseId" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  "parentSlot" INTEGER NOT NULL DEFAULT 0,
  "value" JSONB NOT NULL,
  "updatedByUserId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IpFormAnswer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IpFormAnswer_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "IpFormResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "IpFormAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "IpFormQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "IpFormAnswer_responseId_questionId_parentSlot_key" ON "IpFormAnswer"("responseId", "questionId", "parentSlot");
CREATE INDEX IF NOT EXISTS "IpFormAnswer_responseId_idx" ON "IpFormAnswer"("responseId");

CREATE TABLE IF NOT EXISTS "IpFormSignature" (
  "id" TEXT NOT NULL,
  "responseId" TEXT NOT NULL,
  "parentSlot" INTEGER NOT NULL,
  "fullLegalName" TEXT NOT NULL,
  "signatureImageUrl" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "signedByUserId" TEXT,
  "guestTokenId" TEXT,
  CONSTRAINT "IpFormSignature_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IpFormSignature_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "IpFormResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "IpFormSignature_responseId_parentSlot_key" ON "IpFormSignature"("responseId", "parentSlot");

CREATE TABLE IF NOT EXISTS "IpFormGuestToken" (
  "id" TEXT NOT NULL,
  "responseId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT,
  "parentSlot" INTEGER NOT NULL DEFAULT 2,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "lastAccessAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IpFormGuestToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IpFormGuestToken_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "IpFormResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "IpFormGuestToken_token_key" ON "IpFormGuestToken"("token");
CREATE INDEX IF NOT EXISTS "IpFormGuestToken_responseId_idx" ON "IpFormGuestToken"("responseId");

CREATE TABLE IF NOT EXISTS "IpFormReminder" (
  "id" TEXT NOT NULL,
  "responseId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "reminderType" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IpFormReminder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IpFormReminder_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "IpFormResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "IpFormReminder_responseId_reminderType_channel_key" ON "IpFormReminder"("responseId", "reminderType", "channel");
CREATE INDEX IF NOT EXISTS "IpFormReminder_responseId_idx" ON "IpFormReminder"("responseId");
