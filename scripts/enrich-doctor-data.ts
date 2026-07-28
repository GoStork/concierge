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
 *   npx tsx -r dotenv/config scripts/enrich-doctor-data.ts --bio-only --needs-profile-fields
 *
 * --missing-only         : only members with no NPI yet (skip already-resolved).
 * --needs-profile-fields : only members missing specialties/languages/education
 *                          who have text to extract from. This is the re-run
 *                          after a vocabulary or extractor change.
 * --bio-only             : skip the NPPES/ABOG network lookups and re-extract
 *                          from text only. Much faster and the right mode when
 *                          only the text-extraction side changed.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildDoctorEnrichment, medicalSchoolFromEducation } from "../server/src/modules/providers/doctor-data";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const MISSING_ONLY = args.includes("--missing-only");
const NEEDS_PROFILE_FIELDS = args.includes("--needs-profile-fields");
const BIO_ONLY = args.includes("--bio-only");
// Pure re-derivation from data already in the row. No AI, no network - so it is
// safe and instant to re-run whenever the derivation rules change.
const DERIVE_ONLY = args.includes("--derive-only");
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
  if (NEEDS_PROFILE_FIELDS) {
    // Missing at least one text-derived field, AND has text to derive it from.
    // Without the second half this would burn lookups on members that have
    // nothing to read, which is the 35% with no bio at all.
    where.AND = [
      {
        OR: [
          { specialties: { isEmpty: true } },
          { languagesSpoken: { isEmpty: true } },
          { education: { isEmpty: true } },
        ],
      },
      { OR: [{ bioRaw: { not: null } }, { bio: { not: null } }] },
    ];
  }
  if (DERIVE_ONLY) {
    // Only rows that actually hold an education list to derive from.
    where.NOT = { education: { isEmpty: true } };
  }

  const members = await prisma.providerMember.findMany({
    where,
    select: {
      id: true, name: true, bio: true, bioRaw: true, education: true, medicalSchool: true, fieldSources: true,
      provider: { select: { locations: { orderBy: { sortOrder: "asc" }, take: 1 } } },
    },
    take: limit,
    orderBy: { sortOrder: "asc" },
  });
  console.log(`[doctor-data] ${members.length} members to process`);

  if (DERIVE_ONLY) {
    let set = 0, unchanged = 0, noMatch = 0;
    for (const m of members) {
      const school = medicalSchoolFromEducation(m.education);
      if (!school) { noMatch++; continue; }
      if (m.medicalSchool === school) { unchanged++; continue; }
      const sources = { ...((m.fieldSources as any) || {}) };
      if (sources.medicalSchool === "self") { unchanged++; continue; } // never clobber a human entry
      sources.medicalSchool = "bio";
      if (set < 25) console.log(`[doctor-data]   ${m.name}: medicalSchool="${school}"`);
      if (!DRY_RUN) {
        await prisma.providerMember.updateMany({
          where: { id: m.id },
          data: { medicalSchool: school, fieldSources: sources },
        });
      }
      set++;
    }
    console.log(`[doctor-data] derive-only done. set=${set} unchanged=${unchanged} noEducationMatch=${noMatch} ${DRY_RUN ? "(NO WRITES)" : ""}`);
    return;
  }

  const stats = { updated: 0, empty: 0 };
  async function one(m: any) {
    const loc = (m.provider?.locations || [])[0] || {};
    const { data } = await buildDoctorEnrichment({
      name: m.name, bio: m.bio, bioRaw: m.bioRaw, existingEducation: m.education,
      city: loc.city ?? null, state: loc.state ?? null,
      existingSources: (m.fieldSources as any) || null, genAI,
      only: BIO_ONLY ? ["bio"] : undefined,
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
