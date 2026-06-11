/**
 * Bulk doctor-data enrichment over EXISTING members, using the same shared
 * implementation the live clinic-enrichment pipeline uses (server/src/modules/
 * providers/doctor-data.ts) - NPPES + ABOG + bio, with per-field provenance.
 *
 * This is just a batch driver for back-filling data that predates the pipeline
 * integration; new/re-enriched clinics get the same treatment automatically.
 *
 * Run:
 *   npx tsx -r dotenv/config scripts/enrich-doctor-data.ts --provider-name "Pacific Fertility"
 *   npx tsx -r dotenv/config scripts/enrich-doctor-data.ts --limit 500
 *   npx tsx -r dotenv/config scripts/enrich-doctor-data.ts --missing-only
 *   npx tsx -r dotenv/config scripts/enrich-doctor-data.ts --dry-run --provider-name "CCRM"
 *
 * --missing-only : only members with no NPI yet (skip already-resolved).
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildDoctorEnrichment } from "../server/src/modules/providers/doctor-data";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const MISSING_ONLY = args.includes("--missing-only");
function argVal(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const providerId = argVal("--provider");
const providerName = argVal("--provider-name");
const limit = argVal("--limit") ? parseInt(argVal("--limit")!, 10) : undefined;
const CONCURRENCY = 3;

async function main() {
  console.log(`[doctor-data] enrichment ${DRY_RUN ? "(DRY RUN)" : ""} starting`);

  const where: any = { isPublicProfile: true };
  if (MISSING_ONLY) where.npiNumber = null;
  if (providerId) where.providerId = providerId;
  if (providerName) where.provider = { name: { contains: providerName, mode: "insensitive" } };

  const members = await prisma.providerMember.findMany({
    where,
    select: {
      id: true, name: true, bio: true, fieldSources: true,
      provider: { select: { locations: { orderBy: { sortOrder: "asc" }, take: 1 } } },
    },
    take: limit,
    orderBy: { sortOrder: "asc" },
  });
  console.log(`[doctor-data] ${members.length} members to process`);

  const stats = { updated: 0, empty: 0 };
  async function one(m: any) {
    const loc = (m.provider?.locations || [])[0] || {};
    const { data } = await buildDoctorEnrichment({
      name: m.name, bio: m.bio, city: loc.city ?? null, state: loc.state ?? null,
      existingSources: (m.fieldSources as any) || null, genAI,
    });
    if (Object.keys(data).length === 0) { stats.empty++; return; }
    const src = data.fieldSources || {};
    console.log(`[doctor-data]   ${m.name}: ${Object.keys(data).filter(k => k !== "fieldSources").map(k => `${k}=${src[k] || "?"}`).join(" ")}`);
    if (!DRY_RUN) await prisma.providerMember.updateMany({ where: { id: m.id }, data });
    stats.updated++;
  }

  for (let i = 0; i < members.length; i += CONCURRENCY) {
    await Promise.all(members.slice(i, i + CONCURRENCY).map(one));
    if ((i + CONCURRENCY) % 30 === 0) console.log(`[doctor-data] progress ${Math.min(i + CONCURRENCY, members.length)}/${members.length}`);
  }
  console.log(`[doctor-data] done. updated=${stats.updated} empty=${stats.empty} ${DRY_RUN ? "(NO WRITES)" : ""}`);
}

main()
  .catch((e) => { console.error("[doctor-data] fatal:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
