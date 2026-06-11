/**
 * Phase 4c: NPI-anchored authoritative enrichment via the NPPES NPI Registry.
 *
 * For each ProviderMember we resolve the doctor's NPI from the free, official
 * CMS NPPES API (https://npiregistry.cms.hhs.gov/api/) using name + the clinic's
 * state, then write the authoritative fields it returns:
 *   - npiNumber, credential (MD/DO), npiTaxonomy (specialty classification),
 *     providerGender, licenseState
 *
 * Matching is CONSERVATIVE - we only assign an NPI when there is a single
 * confident match (exact last name + a fertility/OB-GYN taxonomy, disambiguated
 * by clinic city/state when needed). No guessing: an ambiguous or absent match
 * leaves the row untouched, so we never attach the wrong doctor's record.
 *
 * Per-field provenance is recorded in fieldSources; a value marked "self"
 * (provider-entered) is never overwritten by NPPES.
 *
 * Run:
 *   npx tsx -r dotenv/config scripts/enrich-doctors-nppes.ts --provider-name "Pacific Fertility"
 *   npx tsx -r dotenv/config scripts/enrich-doctors-nppes.ts --limit 500
 *   npx tsx -r dotenv/config scripts/enrich-doctors-nppes.ts --dry-run --provider-name "CCRM"
 *
 * Idempotent: only processes members without an npiNumber.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
function argVal(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const providerId = argVal("--provider");
const providerName = argVal("--provider-name");
const limit = argVal("--limit") ? parseInt(argVal("--limit")!, 10) : undefined;
const CONCURRENCY = 3;

// Taxonomies that count as a fertility/OB-GYN physician match.
const OK_TAXONOMY = /reproductive endocrinology|obstetrics|gynecolog/i;

function parseName(name: string): { first: string; last: string } | null {
  const cleaned = name
    .replace(/^\s*(dr|doctor)\b\.?\s*/i, "")
    .replace(/,?\s*(MD|DO|PhD|FACOG|FACS|MBA|MSc|RN|NP|HCLD|MS)\b\.?/gi, "")
    .replace(/[.,]/g, "")
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts[parts.length - 1] };
}

function normCred(c: string | undefined | null): string | null {
  if (!c) return null;
  const up = c.toUpperCase().replace(/[.\s]/g, "");
  if (up.includes("MD")) return "MD";
  if (up.includes("DO")) return "DO";
  return null;
}

interface NppesPick {
  npi: string;
  credential: string | null;
  taxonomy: string | null;
  gender: string | null;
  licenseState: string | null;
}

async function nppesLookup(
  first: string,
  last: string,
  state: string | null,
  city: string | null,
): Promise<NppesPick | null> {
  const params = new URLSearchParams({ version: "2.1", first_name: first, last_name: last, limit: "20" });
  if (state) params.set("state", state);
  let json: any;
  try {
    const res = await fetch(`https://npiregistry.cms.hhs.gov/api/?${params.toString()}`);
    if (!res.ok) return null;
    json = await res.json();
  } catch {
    return null;
  }
  const results: any[] = json?.results || [];
  if (results.length === 0) return null;

  // Keep only individual providers with a fertility/OB-GYN taxonomy and matching last name.
  const candidates = results.filter((r) => {
    if (r.enumeration_type && r.enumeration_type !== "NPI-1") return false; // individuals only
    const b = r.basic || {};
    if ((b.last_name || "").toLowerCase() !== last.toLowerCase()) return false;
    return (r.taxonomies || []).some((t: any) => OK_TAXONOMY.test(t.desc || ""));
  });
  if (candidates.length === 0) return null;

  let chosen: any;
  if (candidates.length === 1) {
    chosen = candidates[0];
  } else if (city) {
    // Disambiguate by clinic city among the candidates.
    const byCity = candidates.filter((r) =>
      (r.addresses || []).some((a: any) => (a.city || "").toLowerCase() === city.toLowerCase()),
    );
    if (byCity.length === 1) chosen = byCity[0];
  }
  if (!chosen) return null; // ambiguous - do not guess

  const b = chosen.basic || {};
  const primaryTax = (chosen.taxonomies || []).find((t: any) => t.primary) || (chosen.taxonomies || [])[0] || {};
  const gender = b.gender === "M" ? "Male" : b.gender === "F" ? "Female" : null;
  return {
    npi: String(chosen.number),
    credential: normCred(b.credential),
    taxonomy: primaryTax.desc || null,
    gender,
    licenseState: primaryTax.state || null,
  };
}

async function enrichOne(member: any, stats: { matched: number; skipped: number }): Promise<void> {
  const parsed = parseName(member.name);
  if (!parsed) {
    stats.skipped++;
    return;
  }
  const loc = (member.locations || [])[0]?.location || {};
  const provLoc = (member.provider?.locations || [])[0] || {};
  const state = loc.state || provLoc.state || null;
  const city = loc.city || provLoc.city || null;

  const pick = await nppesLookup(parsed.first, parsed.last, state, city);
  if (!pick) {
    console.log(`[nppes]   ${member.name}: no confident match (skipped)`);
    stats.skipped++;
    return;
  }

  // Provenance: never overwrite provider-entered ("self") values.
  const sources: Record<string, string> = (member.fieldSources as any) || {};
  const data: any = {};
  const set = (field: string, value: any) => {
    if (value == null) return;
    if (sources[field] === "self") return;
    data[field] = value;
    sources[field] = "nppes";
  };
  set("npiNumber", pick.npi);
  set("credential", pick.credential);
  set("npiTaxonomy", pick.taxonomy);
  set("providerGender", pick.gender);
  set("licenseState", pick.licenseState);
  data.fieldSources = sources;

  console.log(`[nppes]   ${member.name}: NPI ${pick.npi} | ${pick.credential ?? "-"} | ${pick.taxonomy ?? "-"} | ${pick.gender ?? "-"}`);
  if (!DRY_RUN) {
    await prisma.providerMember.updateMany({ where: { id: member.id }, data });
  }
  stats.matched++;
}

async function main() {
  console.log(`[nppes] NPI-anchored enrichment ${DRY_RUN ? "(DRY RUN)" : ""} starting`);

  const where: any = { npiNumber: null, isPublicProfile: true };
  if (providerId) where.providerId = providerId;
  if (providerName) where.provider = { name: { contains: providerName, mode: "insensitive" } };

  const members = await prisma.providerMember.findMany({
    where,
    select: {
      id: true,
      name: true,
      fieldSources: true,
      locations: { include: { location: true } },
      provider: { select: { locations: { orderBy: { sortOrder: "asc" }, take: 1 } } },
    },
    take: limit,
    orderBy: { sortOrder: "asc" },
  });
  console.log(`[nppes] ${members.length} members without an NPI to resolve`);

  const stats = { matched: 0, skipped: 0 };
  for (let i = 0; i < members.length; i += CONCURRENCY) {
    const batch = members.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((m) => enrichOne(m, stats)));
    if ((i + CONCURRENCY) % 30 === 0) console.log(`[nppes] progress ${Math.min(i + CONCURRENCY, members.length)}/${members.length} (matched=${stats.matched})`);
  }

  console.log(`[nppes] done. matched=${stats.matched} skipped=${stats.skipped} ${DRY_RUN ? "(NO WRITES)" : ""}`);
}

main()
  .catch((e) => {
    console.error("[nppes] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
