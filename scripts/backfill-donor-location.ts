/**
 * One-time backfill (safe to re-run, idempotent): repair `location` scalars that
 * lost the city.
 *
 * Extraction routinely persisted only the state ("FL") while the raw profile
 * kept the full "Ocala, FL" in profileData.Location / _sections["Basic
 * Information"]["Current City"]. Cards and profile pages recovered the city for
 * DISPLAY, so a donor read "Ocala, FL" everywhere - but the marketplace location
 * filter and the AI's location search both query the scalar, so filtering by
 * her own city returned nothing.
 *
 * New/updated profiles are fixed at the source now (resolveDonorLocation in
 * profile-sync.service.ts); this covers the rows that predate it.
 *
 * Rows whose `location` a provider edited by hand (manuallyEditedFields) are
 * never touched. Only upgrades that GAIN a city are written - "AL" is never
 * rewritten to "Alabama" - so re-running changes nothing.
 *
 * Run:     npx tsx -r dotenv/config scripts/backfill-donor-location.ts
 * Dry run: npx tsx -r dotenv/config scripts/backfill-donor-location.ts --dry
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { resolveDonorLocation } from "../shared/donor-location";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const DRY = process.argv.includes("--dry");

type Table = "eggDonor" | "surrogate" | "spermDonor";

async function backfill(table: Table) {
  const rows: any[] = await (prisma as any)[table].findMany({
    select: { id: true, location: true, profileData: true, manuallyEditedFields: true },
  });

  let scanned = 0, skippedManual = 0, unchanged = 0, updated = 0;
  const samples: string[] = [];

  for (const row of rows) {
    scanned++;
    if ((row.manuallyEditedFields || []).includes("location")) { skippedManual++; continue; }
    const resolved = resolveDonorLocation(row.location, row.profileData);
    if (!resolved || resolved === row.location) { unchanged++; continue; }
    if (samples.length < 5) samples.push(`${JSON.stringify(row.location)} -> ${JSON.stringify(resolved)}`);
    if (!DRY) {
      await (prisma as any)[table].update({ where: { id: row.id }, data: { location: resolved } });
    }
    updated++;
  }

  console.log(
    `${table}: scanned=${scanned} updated=${updated} unchanged=${unchanged} skippedManualEdit=${skippedManual}`,
  );
  for (const s of samples) console.log(`  e.g. ${s}`);
}

async function main() {
  if (DRY) console.log("DRY RUN - no writes\n");
  for (const table of ["eggDonor", "surrogate", "spermDonor"] as Table[]) {
    await backfill(table);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
