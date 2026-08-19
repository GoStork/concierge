-- express-session store (connect-pg-simple). The app passes createTableIfMissing:true,
-- but the bundled dist/index.cjs cannot find connect-pg-simple's table.sql at runtime
-- (ENOENT /srv/gostork/app/dist/table.sql -> "Login session error" 500 on every login
-- against a fresh DB - hit on the first production login 2026-08-19). Dev never noticed
-- because the dev DB already had the table. Own the table in migrations instead.
-- Schema = connect-pg-simple/table.sql verbatim.
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey') THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
