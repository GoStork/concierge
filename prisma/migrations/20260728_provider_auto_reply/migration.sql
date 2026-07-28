-- Provider booking auto-reply: a provider-authored first message (plus optional
-- attachments) posted into the parent's 3-way chat the moment they book a call.

CREATE TABLE IF NOT EXISTS "ProviderAutoReply" (
  "id"              TEXT NOT NULL,
  "providerId"      TEXT NOT NULL,
  "staffUserId"     TEXT,
  "providerTypeId"  TEXT,
  "body"            TEXT NOT NULL,
  "attachments"     JSONB NOT NULL DEFAULT '[]',
  "isEnabled"       BOOLEAN NOT NULL DEFAULT true,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderAutoReply_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProviderAutoReplySend" (
  "id"              TEXT NOT NULL,
  "autoReplyId"     TEXT,
  "providerId"      TEXT NOT NULL,
  "parentAccountId" TEXT,
  "parentUserId"    TEXT NOT NULL,
  "providerTypeId"  TEXT,
  "sessionId"       TEXT NOT NULL,
  "bookingId"       TEXT,
  "sentAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderAutoReplySend_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ProviderAutoReply_providerId_idx"
  ON "ProviderAutoReply" ("providerId");
CREATE INDEX IF NOT EXISTS "ProviderAutoReply_providerId_staffUserId_idx"
  ON "ProviderAutoReply" ("providerId", "staffUserId");

-- One template per (org|staff) x (service|any) scope. A plain UNIQUE would not
-- dedupe here because NULL <> NULL in Postgres, so COALESCE the nullable scope
-- columns to '' first. This is the real guard - the API also checks, but two
-- concurrent saves would otherwise both pass that check.
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderAutoReply_scope_key"
  ON "ProviderAutoReply" ("providerId", COALESCE("staffUserId", ''), COALESCE("providerTypeId", ''));

CREATE INDEX IF NOT EXISTS "ProviderAutoReplySend_providerId_parentAccountId_idx"
  ON "ProviderAutoReplySend" ("providerId", "parentAccountId");
CREATE INDEX IF NOT EXISTS "ProviderAutoReplySend_providerId_parentUserId_idx"
  ON "ProviderAutoReplySend" ("providerId", "parentUserId");

-- The "send once per parent + provider + service type" rule, enforced in the DB
-- so a duplicate booking POST (or the other Mac's process) cannot double-post.
-- Keyed on the parent ACCOUNT when there is one, else the individual user.
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderAutoReplySend_once_key"
  ON "ProviderAutoReplySend" (
    "providerId",
    COALESCE("parentAccountId", "parentUserId"),
    COALESCE("providerTypeId", '')
  );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProviderAutoReply_providerId_fkey') THEN
    ALTER TABLE "ProviderAutoReply" ADD CONSTRAINT "ProviderAutoReply_providerId_fkey"
      FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProviderAutoReply_staffUserId_fkey') THEN
    ALTER TABLE "ProviderAutoReply" ADD CONSTRAINT "ProviderAutoReply_staffUserId_fkey"
      FOREIGN KEY ("staffUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProviderAutoReply_providerTypeId_fkey') THEN
    ALTER TABLE "ProviderAutoReply" ADD CONSTRAINT "ProviderAutoReply_providerTypeId_fkey"
      FOREIGN KEY ("providerTypeId") REFERENCES "ProviderType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProviderAutoReplySend_autoReplyId_fkey') THEN
    ALTER TABLE "ProviderAutoReplySend" ADD CONSTRAINT "ProviderAutoReplySend_autoReplyId_fkey"
      FOREIGN KEY ("autoReplyId") REFERENCES "ProviderAutoReply"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProviderAutoReplySend_providerId_fkey') THEN
    ALTER TABLE "ProviderAutoReplySend" ADD CONSTRAINT "ProviderAutoReplySend_providerId_fkey"
      FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
