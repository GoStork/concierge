/**
 * Sync acceptance audit - the machine-checkable half of the "what is a
 * successful sync" contract in docs/scraper-playbook.md ("Definition of a
 * successful sync"). Run it after ANY scraper/API sync work, before reporting.
 *
 * It scores one provider + profile type against the acceptance gates and
 * prints PASS/FAIL per gate, the per-field fill rates, and - critically - which
 * missing fields are OUR bug (present for some records, so the source has
 * them) versus SOURCE-LIMITED (absent for every record, so the source does not
 * publish them and only the provider can fix it).
 *
 * Run:  npx tsx -r dotenv/config scripts/audit-sync.ts <providerId|name> <egg-donor|surrogate|sperm-donor>
 * Exit code 1 when any hard gate fails, so it can gate automation.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { getMandatoryFieldChecks } from "../server/src/modules/providers/profile-sync.service";

type DonorType = "egg-donor" | "surrogate" | "sperm-donor";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// Hard gates: a sync that misses any of these is NOT done, regardless of what
// the run status says.
const GATES = {
  minCoverageOfSource: 0.98, // imported rows / rows the source listed (SyncLog.total)
  maxFailedRatio: 0.02,
  minPhotoPersistedRatio: 0.95, // photoUrl on our storage, not hotlinked
  minRequiredFieldFill: 0.9, // per required field, unless source-limited
  maxJunkKeyRatio: 0, // platform-internal keys on profileData
  maxDuplicateExternalIdRatio: 0,
};

// profileData keys that must never reach a parent-facing profile.
const JUNK_KEY_RE = /^(thumb|views?|likes|unique|impressions|clicks|real|key|photo)$/i;

const PRICE_FIELD: Record<DonorType, string> = {
  "egg-donor": "totalCost",
  surrogate: "totalCostMin",
  "sperm-donor": "compensation",
};

// Raw-data evidence per required field: a profileData key (any depth) matching
// this regex with a non-empty value means the source GAVE us the field. If the
// mapped column is still empty on that row, the mapper dropped it - our bug.
const RAW_EVIDENCE: Record<string, RegExp> = {
  "Education Level": /education|degree|major|school|college|university/i,
  "Education": /education|degree|major|school|college|university/i,
  "Eye Color": /eye/i,
  "Location": /location|city|state of residence|residence|country/i,
  "Hair Color": /hair.*colou?r|natural colou?r/i,
  "Donation Types": /donation type|type of donation|donation openness|anonymity|open donation/i,
  "Race": /\brace\b/i,
  "Relationship Status": /relationship|marital/i,
  "Ethnicity": /ethnic|ancestry/i,
  "Occupation": /occupation|profession|\bjob\b/i,
  "Religion": /religio/i,
  "Egg Donor Compensation": /compensation|donor fee/i,
  "Height": /height/i,
  "Weight": /weight/i,
  "Blood Type": /blood type/i,
  "Type": /donor type|type of donor/i,
  "Price": /price|cost|compensation/i,
  "BMI": /\bbmi\b/i,
  "COVID Vaccinated": /covid|vaccin/i,
  "C-Sections": /c-?section|cesarean/i,
  "Live Births": /live birth|deliver/i,
  "Miscarriages": /miscarriage/i,
  "Agrees to Twins": /twins/i,
  "Base Compensation": /compensation/i,
};

function hasRawEvidence(pd: any, re: RegExp): boolean {
  if (!pd || typeof pd !== "object") return false;
  const walk = (obj: any, depth: number): boolean => {
    if (depth > 3 || !obj || typeof obj !== "object") return false;
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
      if (re.test(k) && (typeof v !== "object" || Array.isArray(v))) return true;
      if (typeof v === "object" && walk(v, depth + 1)) return true;
    }
    return false;
  };
  return walk(pd, 0);
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 1000) / 10}%`;
}

async function main() {
  const [providerArg, typeArg] = process.argv.slice(2);
  if (!providerArg || !typeArg) {
    console.error("usage: audit-sync.ts <providerId|providerName> <egg-donor|surrogate|sperm-donor>");
    process.exit(2);
  }
  const type = typeArg as DonorType;
  if (!["egg-donor", "surrogate", "sperm-donor"].includes(type)) {
    console.error(`invalid type ${typeArg}`);
    process.exit(2);
  }

  const provider = await prisma.provider.findFirst({
    where: { OR: [{ id: providerArg }, { name: { contains: providerArg, mode: "insensitive" } }] },
    select: { id: true, name: true },
  });
  if (!provider) {
    console.error(`provider not found: ${providerArg}`);
    process.exit(2);
  }

  const rows: any[] =
    type === "egg-donor"
      ? await prisma.eggDonor.findMany({ where: { providerId: provider.id } })
      : type === "surrogate"
        ? await prisma.surrogate.findMany({ where: { providerId: provider.id } })
        : await prisma.spermDonor.findMany({ where: { providerId: provider.id } });

  const lastRun = await prisma.syncLog.findFirst({
    where: { providerId: provider.id, type },
    orderBy: { startedAt: "desc" },
  });

  const failures: string[] = [];
  const warnings: string[] = [];
  const gate = (ok: boolean, label: string, detail: string) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${detail}`);
    if (!ok) failures.push(`${label}: ${detail}`);
  };

  console.log(`\n== Sync audit: ${provider.name} / ${type} ==`);
  console.log(`rows in DB: ${rows.length}`);
  if (lastRun) {
    console.log(
      `last run: ${lastRun.status} (${lastRun.source}) started ${lastRun.startedAt.toISOString()} total=${lastRun.total} ok=${lastRun.succeeded} failed=${lastRun.failed} new=${lastRun.newProfiles} stale=${lastRun.staleMarked}`,
    );
  } else {
    console.log("last run: none");
  }
  console.log("");

  // 1. Run outcome + coverage
  gate(!!lastRun && lastRun.status !== "failed", "Run finished", lastRun ? `status=${lastRun.status}` : "no SyncLog row");
  if (lastRun && lastRun.total > 0) {
    // "skipped" = unchanged since the last run (card hash matched) - those
    // profiles are covered, they just did not need re-importing.
    const covered = lastRun.succeeded + (lastRun.skipped || 0);
    const coverage = covered / lastRun.total;
    gate(coverage >= GATES.minCoverageOfSource, "Coverage of source list", `${lastRun.succeeded} imported + ${lastRun.skipped || 0} unchanged of ${lastRun.total} (${pct(covered, lastRun.total)})`);
    gate(lastRun.failed / lastRun.total <= GATES.maxFailedRatio, "Failed ratio", `${lastRun.failed}/${lastRun.total}`);
  }
  const errs = Array.isArray(lastRun?.errors) ? (lastRun!.errors as any[]) : [];
  gate(errs.length === 0, "No run errors", errs.length ? `${errs.length} error(s): ${String(errs[0]).slice(0, 160)}` : "clean");

  // 2. Identity + de-dupe
  const ids = rows.map((r) => r.externalId).filter(Boolean);
  const dupes = ids.length - new Set(ids).size;
  gate(rows.length > 0, "Profiles imported", `${rows.length}`);
  gate(ids.length === rows.length, "Every profile has an externalId", `${ids.length}/${rows.length}`);
  gate(dupes === 0, "No duplicate externalIds", `${dupes} duplicate(s)`);

  // 3. Photos persisted to OUR storage (never hotlinked to the source)
  const withPhoto = rows.filter((r) => !!r.photoUrl).length;
  const persisted = rows.filter((r) => typeof r.photoUrl === "string" && /storage\.googleapis\.com|\/uploads\//.test(r.photoUrl)).length;
  gate(withPhoto / Math.max(rows.length, 1) >= GATES.minPhotoPersistedRatio, "Profiles with a photo", pct(withPhoto, rows.length));
  gate(persisted >= withPhoto * 0.98, "Photos persisted to our storage", `${persisted}/${withPhoto}`);

  // 4. Status + availability sanity
  const statusCounts: Record<string, number> = {};
  for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  console.log(`      status distribution: ${JSON.stringify(statusCounts)}`);
  const available = statusCounts["AVAILABLE"] || 0;
  if (rows.length > 0 && available === 0) warnings.push("No profile is AVAILABLE - check status mapping");

  // 5. Pricing present (marketplace cards and Eva need a number)
  const priceField = PRICE_FIELD[type];
  const priced = rows.filter((r) => r[priceField] != null).length;
  gate(priced / Math.max(rows.length, 1) >= 0.9, `Price present (${priceField})`, pct(priced, rows.length));

  // 6. No platform-internal junk on the profile
  let junkRows = 0;
  const junkKeys = new Set<string>();
  for (const r of rows) {
    const keys = Object.keys((r.profileData as any) || {});
    const junk = keys.filter((k) => JUNK_KEY_RE.test(k.replace(/\s+/g, "")));
    if (junk.length) {
      junkRows++;
      junk.forEach((k) => junkKeys.add(k));
    }
  }
  gate(junkRows === 0, "No platform-internal keys on profiles", junkRows ? `${junkRows} rows carry ${[...junkKeys].join(", ")}` : "clean");

  // 7. Required fields - ours vs source-limited vs source variance.
  // A field below threshold is OUR bug only when the raw profile data still
  // carries it (a key matching the field with a non-empty value) on rows where
  // the mapped column is empty - i.e. we scraped it and then dropped it. When
  // the raw data does not have it either, the donor simply did not provide it
  // (source variance) or the source never publishes it (source-limited).
  console.log("\n-- required field fill rates --");
  const checks = getMandatoryFieldChecks(type);
  const ourGaps: string[] = [];
  const sourceLimited: string[] = [];
  const sourceVariance: string[] = [];
  for (const c of checks) {
    const filled = rows.filter((r) => c.check(r)).length;
    const ratio = rows.length ? filled / rows.length : 0;
    const evidence = RAW_EVIDENCE[c.label];
    const mappingMisses = evidence ? rows.filter((r) => !c.check(r) && hasRawEvidence(r.profileData, evidence)).length : 0;
    let tag: string;
    if (ratio >= GATES.minRequiredFieldFill) tag = "ok ";
    else if (mappingMisses > 0) tag = "GAP";
    else if (filled === 0) tag = "SRC";
    else tag = "VAR";
    console.log(`  ${tag}  ${c.label.padEnd(38)} ${pct(filled, rows.length).padStart(6)}${mappingMisses ? `   (${mappingMisses} rows have it in raw data but not mapped)` : ""}`);
    if (ratio < GATES.minRequiredFieldFill) {
      if (mappingMisses > 0) ourGaps.push(`${c.label} (${pct(filled, rows.length)}, ${mappingMisses} unmapped)`);
      else if (filled === 0) sourceLimited.push(c.label);
      else sourceVariance.push(`${c.label} (${pct(filled, rows.length)})`);
    }
  }
  if (ourGaps.length) failures.push(`Fields present in raw data but not mapped - fix before reporting: ${ourGaps.join(", ")}`);
  if (sourceVariance.length) warnings.push(`Source variance (donors left these blank; nothing to map): ${sourceVariance.join(", ")}`);

  console.log("\n== Verdict ==");
  if (failures.length === 0) console.log("SYNC ACCEPTED - all hard gates pass.");
  else {
    console.log("SYNC NOT ACCEPTED:");
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  if (sourceLimited.length) {
    console.log(`\nSource-limited (absent on EVERY record - the provider does not publish these; ask them, do not fake them):\n  ${sourceLimited.join(", ")}`);
  }
  warnings.forEach((w) => console.log(`WARN: ${w}`));
  process.exitCode = failures.length ? 1 : 0;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
