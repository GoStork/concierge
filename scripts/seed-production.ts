/**
 * Production content seeder - Phase A of the launch runbook
 * (docs/production-launch-runbook.md, section 3).
 *
 * Copies PLATFORM CONTENT from the dev database to the production database.
 * Never copies user/transactional data: no User rows, no chat, no bookings,
 * no notifications, no invoices/agreements, no tasks.
 *
 * Usage:
 *   npx tsx scripts/seed-production.ts                  # dry-run against SOURCE only
 *   TARGET_DATABASE_URL=postgres://... npx tsx scripts/seed-production.ts           # dry-run incl. target schema compare
 *   TARGET_DATABASE_URL=postgres://... npx tsx scripts/seed-production.ts --execute # actually copy
 *
 * SOURCE defaults to DATABASE_URL from .env (the dev DB). TARGET must be given
 * explicitly - there is no default on purpose.
 *
 * Design:
 * - Explicit table manifest below - a table not listed is not copied. When the
 *   schema grows, the launch runbook says to revisit this list.
 * - Copy runs with session_replication_role=replica on the target so FK order
 *   does not matter; a post-copy orphan report surfaces anything dangling.
 * - Column-intersection inserts: only columns present in BOTH schemas copy,
 *   and the dry-run report lists any mismatches so drift is visible.
 * - USER_REF_NULL_COLUMNS: content tables that carry optional references to
 *   User rows (which are NOT copied) get those columns nulled.
 * - Idempotent: ON CONFLICT (id) DO NOTHING by default (content edits made in
 *   prod after a first seed are never clobbered by a re-run).
 */
import { Client } from "pg";
import * as dotenv from "dotenv";
dotenv.config();

// Platform content, grouped for readability. Order is cosmetic (FKs are
// bypassed during copy) but roughly parent-first for the orphan report.
const CONTENT_TABLES: string[] = [
  // Brand + AI configuration
  "SiteSettings", "BrandTemplate", "Matchmaker", "ConciergePromptSection",
  "ConciergeAsset", "AutomationDefaults",
  // Provider catalog
  "ProviderType", "Provider", "ProviderService", "ProviderLocation",
  "SurrogacyAgencyProfile", "ProviderBrandSettings", "ProviderAgreementTemplate",
  "ReferralFeeConfig",
  // Cost sheet templates (templates only - ProviderCostSheet quotes are
  // per-parent transactional data and are NOT copied)
  "CostTemplate", "CostProgram",
  // Donor / surrogate profiles + their scraper configs
  "EggDonor", "EggDonorSyncConfig", "Surrogate", "SurrogateSyncConfig",
  "SpermDonor", "SpermDonorSyncConfig", "PhotoFingerprint",
  // Knowledge base / RAG (pgvector)
  "KnowledgeChunk", "ExpertGuidanceRule",
  // CDC datasets
  "CdcDatasetMap", "IvfSuccessRate", "RawCdcData",
  // IP form definition (the form itself, not responses)
  "IpFormSection", "IpFormQuestion", "IpFormProviderOverride",
  // Ops content
  "SponsorshipPlan", "TaskPlaybook", "TaskPlaybookStep", "SilenceConfig",
  "SecuritySetting", "SecurityCountryPolicy", "SecurityEmailAllow",
];

// Content tables sometimes point at User rows (audit/ownership refs). Users
// are not copied, so these columns are nulled during the copy. Verified
// nullable in prisma/schema.prisma before listing here.
const USER_REF_NULL_COLUMNS: Record<string, string[]> = {
  Surrogate: ["reservedByUserId"],
};

const EXECUTE = process.argv.includes("--execute");
const SOURCE_URL = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL;
const TARGET_URL = process.env.TARGET_DATABASE_URL;

async function columnsOf(c: Client, table: string): Promise<string[]> {
  const r = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((x) => x.column_name);
}

async function main() {
  if (!SOURCE_URL) throw new Error("No SOURCE_DATABASE_URL / DATABASE_URL");
  const source = new Client({ connectionString: SOURCE_URL });
  await source.connect();
  const target = TARGET_URL ? new Client({ connectionString: TARGET_URL }) : null;
  if (target) await target.connect();

  console.log(`Mode: ${EXECUTE ? "EXECUTE" : "dry-run"}   Target: ${TARGET_URL ? "connected" : "(none - source report only)"}\n`);
  if (EXECUTE && !target) throw new Error("--execute requires TARGET_DATABASE_URL");

  if (EXECUTE && target) {
    await target.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await target.query(`SET session_replication_role = replica`);
  }

  let totalRows = 0;
  for (const table of CONTENT_TABLES) {
    const srcCols = await columnsOf(source, table);
    if (!srcCols.length) { console.log(`!! ${table}: MISSING in source - check manifest`); continue; }
    const cnt = Number((await source.query(`SELECT count(*) c FROM "${table}"`)).rows[0].c);
    totalRows += cnt;

    if (!target) { console.log(`   ${table}: ${cnt} rows`); continue; }

    const tgtCols = await columnsOf(target, table);
    if (!tgtCols.length) { console.log(`!! ${table}: MISSING in target - run migrations first`); continue; }
    const common = srcCols.filter((c) => tgtCols.includes(c));
    const srcOnly = srcCols.filter((c) => !tgtCols.includes(c));
    const drift = srcOnly.length ? `  [source-only cols dropped: ${srcOnly.join(",")}]` : "";
    console.log(`   ${table}: ${cnt} rows, ${common.length} cols${drift}`);

    if (!EXECUTE || cnt === 0) continue;

    const nullCols = USER_REF_NULL_COLUMNS[table] || [];
    const selectList = common
      .map((c) => (nullCols.includes(c) ? `NULL AS "${c}"` : `"${c}"`))
      .join(", ");
    const { rows } = await source.query(`SELECT ${selectList} FROM "${table}"`);
    const colList = common.map((c) => `"${c}"`).join(", ");
    let inserted = 0;
    for (const row of rows) {
      const vals = common.map((c) => row[c]);
      const params = common.map((_, i) => `$${i + 1}`).join(", ");
      const conflictTarget = common.includes("id") ? `("id")` : "";
      const r = await target.query(
        conflictTarget
          ? `INSERT INTO "${table}" (${colList}) VALUES (${params}) ON CONFLICT ${conflictTarget} DO NOTHING`
          : `INSERT INTO "${table}" (${colList}) VALUES (${params}) ON CONFLICT DO NOTHING`,
        vals,
      );
      inserted += r.rowCount || 0;
    }
    console.log(`      -> inserted ${inserted}/${cnt}`);
  }

  if (EXECUTE && target) {
    await target.query(`SET session_replication_role = DEFAULT`);
    // Orphan report: any FK in a copied table pointing at a missing row.
    const fks = await target.query(`
      SELECT tc.table_name AS tbl, kcu.column_name AS col,
             ccu.table_name AS ref_tbl, ccu.column_name AS ref_col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema='public'
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'`);
    let orphans = 0;
    for (const fk of fks.rows) {
      if (!CONTENT_TABLES.includes(fk.tbl)) continue;
      const q = `SELECT count(*) c FROM "${fk.tbl}" t LEFT JOIN "${fk.ref_tbl}" r ON t."${fk.col}" = r."${fk.ref_col}" WHERE t."${fk.col}" IS NOT NULL AND r."${fk.ref_col}" IS NULL`;
      const c = Number((await target.query(q)).rows[0].c);
      if (c > 0) { console.log(`!! ORPHANS: ${fk.tbl}.${fk.col} -> ${fk.ref_tbl}: ${c} rows`); orphans += c; }
    }
    console.log(orphans ? `\nOrphan refs found: ${orphans} - resolve before launch.` : `\nNo orphan references. Copy is clean.`);
  }

  console.log(`\nTotal content rows in source: ${totalRows}`);
  await source.end();
  if (target) await target.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
