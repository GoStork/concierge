-- Supabase security advisor (2026-08-23): every table in the public schema had
-- RLS disabled, leaving all data readable/writable through Supabase's PostgREST
-- API to anyone holding the project's anon key. The app never uses that API
-- (all access is Prisma as the `postgres` table owner, which bypasses RLS), so
-- enabling RLS with no policies closes the public API path with zero app impact.
-- Idempotent: already applied to PROD (itlnituvybtnzmrzbkoz) and DEV
-- (bryzqwfzvgjenijciwaa) via Supabase MCP on 2026-08-26; safe to re-run.

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;

-- Defense in depth: strip PostgREST roles of all grants, now and for tables
-- created in the future by the postgres role. Skipped when the roles do not
-- exist (e.g. plain Postgres in CI).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
  END IF;
END $$;
