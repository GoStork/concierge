-- Parent CRM: notes, next steps, lead owners and tags on a parent account.
--
-- Backs the record page at /parents/:id, which one GoStork admin and one
-- provider org both read. Every row carries a `scope`:
--
--   GOSTORK  - GoStork staff only, providerId always NULL.
--   PROVIDER - GoStork staff AND the single org in providerId.
--
-- KEYING: "parentAccountId" holds parentAccountKey(user) = parentAccountId ??
-- userId, with NO foreign key to "ParentAccount". A solo parent's key IS their
-- User.id, so an FK would reject every solo row. "ParentContactRelease" and
-- "JourneyEvent" both already work this way.
--
-- No backfill: this is a new concept with no historical rows to preserve.

-- ─── Notes ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ParentNote" (
  "id"               TEXT NOT NULL,
  "parentAccountId"  TEXT NOT NULL,
  "scope"            TEXT NOT NULL,
  "providerId"       TEXT,
  "body"             TEXT NOT NULL,
  "pinned"           BOOLEAN NOT NULL DEFAULT false,
  "authorUserId"     TEXT NOT NULL,
  "authorName"       TEXT,
  "authorProviderId" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"        TIMESTAMP(3),
  CONSTRAINT "ParentNote_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "ParentNote"
    ADD CONSTRAINT "ParentNote_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "ParentNote_parentAccountId_createdAt_idx"
  ON "ParentNote"("parentAccountId", "createdAt");
CREATE INDEX IF NOT EXISTS "ParentNote_parentAccountId_scope_idx"
  ON "ParentNote"("parentAccountId", "scope");
CREATE INDEX IF NOT EXISTS "ParentNote_providerId_parentAccountId_idx"
  ON "ParentNote"("providerId", "parentAccountId");

-- ─── Follow-ups ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ParentFollowUp" (
  "id"                TEXT NOT NULL,
  "parentAccountId"   TEXT NOT NULL,
  "scope"             TEXT NOT NULL,
  "providerId"        TEXT,
  "body"              TEXT NOT NULL,
  "dueAt"             TIMESTAMP(3) NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'OPEN',
  "assigneeUserId"    TEXT,
  "assigneeName"      TEXT,
  "completedAt"       TIMESTAMP(3),
  "completedByUserId" TEXT,
  "createdByUserId"   TEXT NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ParentFollowUp_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "ParentFollowUp"
    ADD CONSTRAINT "ParentFollowUp_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "ParentFollowUp_parentAccountId_status_dueAt_idx"
  ON "ParentFollowUp"("parentAccountId", "status", "dueAt");
CREATE INDEX IF NOT EXISTS "ParentFollowUp_providerId_status_dueAt_idx"
  ON "ParentFollowUp"("providerId", "status", "dueAt");
CREATE INDEX IF NOT EXISTS "ParentFollowUp_scope_providerId_status_dueAt_idx"
  ON "ParentFollowUp"("scope", "providerId", "status", "dueAt");

-- ─── Lead owners ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ParentOwner" (
  "id"               TEXT NOT NULL,
  "parentAccountId"  TEXT NOT NULL,
  "scope"            TEXT NOT NULL,
  "providerId"       TEXT,
  "ownerUserId"      TEXT NOT NULL,
  "ownerName"        TEXT,
  "assignedByUserId" TEXT,
  "assignedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ParentOwner_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "ParentOwner"
    ADD CONSTRAINT "ParentOwner_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ParentOwner"
    ADD CONSTRAINT "ParentOwner_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "ParentOwner_ownerUserId_scope_idx"
  ON "ParentOwner"("ownerUserId", "scope");
CREATE INDEX IF NOT EXISTS "ParentOwner_providerId_parentAccountId_idx"
  ON "ParentOwner"("providerId", "parentAccountId");
CREATE INDEX IF NOT EXISTS "ParentOwner_parentAccountId_scope_idx"
  ON "ParentOwner"("parentAccountId", "scope");

-- ─── Tags ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ParentTagDefinition" (
  "id"              TEXT NOT NULL,
  "scope"           TEXT NOT NULL,
  "providerId"      TEXT,
  "label"           TEXT NOT NULL,
  "colorToken"      TEXT NOT NULL DEFAULT 'accent',
  "sortOrder"       INTEGER NOT NULL DEFAULT 0,
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ParentTagDefinition_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "ParentTagDefinition"
    ADD CONSTRAINT "ParentTagDefinition_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "ParentTagDefinition_scope_providerId_isActive_idx"
  ON "ParentTagDefinition"("scope", "providerId", "isActive");

CREATE TABLE IF NOT EXISTS "ParentTagAssignment" (
  "id"               TEXT NOT NULL,
  "parentAccountId"  TEXT NOT NULL,
  "tagId"            TEXT NOT NULL,
  "scope"            TEXT NOT NULL,
  "providerId"       TEXT,
  "assignedByUserId" TEXT,
  "assignedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ParentTagAssignment_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "ParentTagAssignment"
    ADD CONSTRAINT "ParentTagAssignment_tagId_fkey"
    FOREIGN KEY ("tagId") REFERENCES "ParentTagDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ParentTagAssignment"
    ADD CONSTRAINT "ParentTagAssignment_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ParentTagAssignment_parentAccountId_tagId_key"
  ON "ParentTagAssignment"("parentAccountId", "tagId");
CREATE INDEX IF NOT EXISTS "ParentTagAssignment_parentAccountId_idx"
  ON "ParentTagAssignment"("parentAccountId");
CREATE INDEX IF NOT EXISTS "ParentTagAssignment_scope_providerId_parentAccountId_idx"
  ON "ParentTagAssignment"("scope", "providerId", "parentAccountId");

-- ─── One-per-scope rules ────────────────────────────────────────────────────
--
-- These CANNOT be Prisma @@unique constraints. Postgres treats NULLs as
-- distinct in a unique index, so a unique on (parentAccountId, scope,
-- providerId) would happily admit two GOSTORK rows - both have providerId NULL,
-- and NULL <> NULL. Prisma cannot express a partial index, so they live here.
--
-- Same trap the ProviderAutoReply scope guard hit, which is why that one uses
-- hand-written COALESCE indexes.
--
-- They also make the parents-table join 1:1, so the list endpoints can build a
-- plain Map with no in-memory dedup, and they make the follow-up upsert safe
-- under concurrent writes.

CREATE UNIQUE INDEX IF NOT EXISTS "ParentOwner_gostork_key"
  ON "ParentOwner"("parentAccountId") WHERE "scope" = 'GOSTORK';
CREATE UNIQUE INDEX IF NOT EXISTS "ParentOwner_provider_key"
  ON "ParentOwner"("parentAccountId", "providerId") WHERE "scope" = 'PROVIDER';

CREATE UNIQUE INDEX IF NOT EXISTS "ParentFollowUp_open_gostork_key"
  ON "ParentFollowUp"("parentAccountId") WHERE "scope" = 'GOSTORK' AND "status" = 'OPEN';
CREATE UNIQUE INDEX IF NOT EXISTS "ParentFollowUp_open_provider_key"
  ON "ParentFollowUp"("parentAccountId", "providerId") WHERE "scope" = 'PROVIDER' AND "status" = 'OPEN';
