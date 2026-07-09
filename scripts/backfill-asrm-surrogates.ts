/**
 * One-time backfill (safe to re-run): evaluate every existing surrogate
 * against the platform-wide ASRM minimum requirements (the GoStork house
 * provider's Surrogate Matching Requirements) and set asrmHidden +
 * asrmFailReasons. New/updated profiles are gated automatically by
 * upsertSurrogate / updateDonor; this covers rows that predate the gate.
 *
 * Run: npx tsx -r dotenv/config scripts/backfill-asrm-surrogates.ts
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { reevaluateAllSurrogatesAsrm } from "../server/src/modules/providers/asrm";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const result = await reevaluateAllSurrogatesAsrm(prisma);
  console.log(`Done. total=${result.total} belowMinimums=${result.hidden} rowsUpdated=${result.changed}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
