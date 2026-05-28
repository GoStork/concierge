// One-shot: applies prisma/migrations/20260527_invoice_bank_payout/migration.sql
// against DATABASE_URL using the existing pg pool. ADD COLUMN IF NOT EXISTS
// makes it safe to re-run.
import fs from "fs";
import path from "path";
import pg from "pg";

// Resolve relative to the repo root so this works on any machine
// (Mac local, Replit, CI, etc.). Script lives in <repo>/scripts/, so
// the migration is one level up under prisma/migrations/.
const SQL_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "prisma",
  "migrations",
  "20260527_invoice_bank_payout",
  "migration.sql",
);

(async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(SQL_PATH, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("Migration applied successfully");
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
