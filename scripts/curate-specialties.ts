/**
 * One-time cleanup: re-curate existing ProviderMember.specialties through the
 * controlled vocabulary (curateSpecialties), dropping the noisy bio-extracted
 * phrases ("Social Infertility", "Advanced Maternal Age", ...) and mapping the
 * rest to canonical labels. Going forward, the enrichment applies this at
 * extraction time; this fixes rows already populated.
 *
 * Run: npx tsx -r dotenv/config scripts/curate-specialties.ts
 *      npx tsx -r dotenv/config scripts/curate-specialties.ts --dry-run
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { curateSpecialties } from "../server/src/modules/providers/doctor-data";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const DRY_RUN = process.argv.includes("--dry-run");

function sameArr(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function main() {
  console.log(`[curate] re-curating specialties ${DRY_RUN ? "(DRY RUN)" : ""}`);
  const members = await prisma.providerMember.findMany({
    where: { NOT: { specialties: { isEmpty: true } } },
    select: { id: true, name: true, specialties: true },
  });
  console.log(`[curate] ${members.length} members with specialties`);

  let changed = 0;
  for (const m of members) {
    const curated = curateSpecialties(m.specialties);
    if (sameArr(curated, m.specialties)) continue;
    changed++;
    if (changed <= 30) console.log(`[curate]   ${m.name}: [${m.specialties.join(", ")}] -> [${curated.join(", ")}]`);
    if (!DRY_RUN) {
      await prisma.providerMember.updateMany({ where: { id: m.id }, data: { specialties: curated } });
    }
  }
  console.log(`[curate] done. changed=${changed}/${members.length} ${DRY_RUN ? "(NO WRITES)" : ""}`);
}

main()
  .catch((e) => { console.error("[curate] fatal:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
