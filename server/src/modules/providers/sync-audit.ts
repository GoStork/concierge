/**
 * Sync acceptance audit - the machine-checkable half of the contract in
 * docs/scraper-playbook.md ("Definition of a successful sync").
 *
 * Runs automatically when every sync run finalizes (finalizeSyncLog) and its
 * verdict is stored on the SyncLog row, shown in Run History, and included in
 * the nightly digest. scripts/audit-sync.ts is a CLI wrapper around the same
 * function for ad-hoc checks.
 *
 * Scores ALL profiles of one provider + type (never a sample) against the
 * hard gates, and classifies every required field/section as:
 *   ok  - filled on >= 90% of profiles
 *   GAP - below threshold AND the raw profile data still carries it on rows
 *         where the column is empty: the mapper dropped it. OUR bug.
 *   VAR - below threshold, no raw evidence: donors left it blank. Not a bug.
 *   SRC - 0% filled: the source never publishes it. A provider ask.
 */
import type { PrismaService } from "../prisma/prisma.service";

export type AuditDonorType = "egg-donor" | "surrogate" | "sperm-donor";

export interface AuditGate {
  label: string;
  ok: boolean;
  detail: string;
}

export interface AuditField {
  label: string;
  fillPct: number; // 0-100
  tag: "ok" | "GAP" | "VAR" | "SRC";
  unmapped: number; // rows with raw evidence but an empty column
}

export interface SyncAuditResult {
  accepted: boolean;
  auditedAt: string;
  rows: number;
  gates: AuditGate[];
  fields: AuditField[];
  failures: string[];
  mappingGaps: string[];
  sourceLimited: string[];
  sourceVariance: string[];
  statusCounts: Record<string, number>;
}

export const AUDIT_GATES = {
  minCoverageOfSource: 0.98,
  maxFailedRatio: 0.02,
  minPhotoRatio: 0.95,
  minRequiredFieldFill: 0.9,
};

const JUNK_KEY_RE = /^(thumb|views?|likes|unique|impressions|clicks|real|key|photo)$/i;

const PRICE_FIELD: Record<AuditDonorType, string> = {
  "egg-donor": "totalCost",
  surrogate: "totalCostMin",
  "sperm-donor": "compensation",
};

// Raw-data evidence per required field: a profileData key (any depth) matching
// this regex with a non-empty value means the source GAVE us the field.
const RAW_EVIDENCE: Record<string, RegExp> = {
  // "major(?!\s*city)": FC's "Closest Major City" is a location, not education -
  // it made 18 clean rows read as unmapped (Sep 4 2026).
  "Education Level": /education|degree|school|college|university|major(?!\s*city)/i,
  Education: /education|degree|school|college|university|major(?!\s*city)/i,
  "Eye Color": /eye/i,
  Location: /location|city|state of residence|residence|country/i,
  "Hair Color": /hair.*colou?r|natural colou?r/i,
  "Donation Types": /donation type|type of donation|donation openness|anonymity|open donation/i,
  Race: /\brace\b/i,
  // "relationship status|marital": bare /relationship/ matched the family-health
  // matrix key "Condition Relationship".
  "Relationship Status": /relationship status|marital/i,
  Ethnicity: /ethnic|ancestry/i,
  Occupation: /occupation|profession|\bjob\b/i,
  Religion: /religio/i,
  "Egg Donor Compensation": /compensation|donor fee/i,
  Height: /height/i,
  Weight: /weight/i,
  "Blood Type": /blood type/i,
  Type: /donor type|type of donor/i,
  Price: /price|cost|compensation/i,
  BMI: /\bbmi\b/i,
  "COVID Vaccinated": /covid|vaccin/i,
  "C-Sections": /c-?section|cesarean/i,
  "Live Births": /live birth|deliver/i,
  Miscarriages: /miscarriage/i,
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

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

export async function auditSync(
  prisma: PrismaService,
  providerId: string,
  type: AuditDonorType,
  checks: { label: string; check: (d: any) => boolean }[],
  lastRunId?: string | null,
): Promise<SyncAuditResult> {
  const rows: any[] =
    type === "egg-donor"
      ? await prisma.eggDonor.findMany({ where: { providerId } })
      : type === "surrogate"
        ? await prisma.surrogate.findMany({ where: { providerId } })
        : await prisma.spermDonor.findMany({ where: { providerId } });

  const lastRun = lastRunId
    ? await prisma.syncLog.findUnique({ where: { id: lastRunId } })
    : await prisma.syncLog.findFirst({ where: { providerId, type }, orderBy: { startedAt: "desc" } });

  const gates: AuditGate[] = [];
  const failures: string[] = [];
  const gate = (ok: boolean, label: string, detail: string) => {
    gates.push({ label, ok, detail });
    if (!ok) failures.push(`${label}: ${detail}`);
  };
  const n = rows.length;

  // 1. Run outcome + coverage
  gate(!!lastRun && lastRun.status !== "failed", "Run finished", lastRun ? `status=${lastRun.status}` : "no run record");
  if (lastRun && lastRun.total > 0) {
    const covered = lastRun.succeeded + (lastRun.skipped || 0);
    gate(
      covered / lastRun.total >= AUDIT_GATES.minCoverageOfSource,
      "Coverage of source list",
      `${lastRun.succeeded} imported + ${lastRun.skipped || 0} unchanged of ${lastRun.total} (${pct(covered, lastRun.total)}%)`,
    );
    gate(lastRun.failed / lastRun.total <= AUDIT_GATES.maxFailedRatio, "Failed ratio", `${lastRun.failed}/${lastRun.total}`);
  }
  const errs = Array.isArray(lastRun?.errors) ? (lastRun!.errors as any[]) : [];
  gate(errs.length === 0, "No run errors", errs.length ? `${errs.length} error(s): ${String(errs[0]).slice(0, 160)}` : "clean");

  // 2. Identity + de-dupe
  const ids = rows.map((r) => r.externalId).filter(Boolean);
  const dupes = ids.length - new Set(ids).size;
  gate(n > 0, "Profiles imported", `${n}`);
  gate(ids.length === n, "Every profile has an externalId", `${ids.length}/${n}`);
  gate(dupes === 0, "No duplicate externalIds", `${dupes} duplicate(s)`);

  // 3. Photos persisted to OUR storage
  const withPhoto = rows.filter((r) => !!r.photoUrl).length;
  const persisted = rows.filter((r) => typeof r.photoUrl === "string" && /storage\.googleapis\.com|\/uploads\//.test(r.photoUrl)).length;
  gate(withPhoto / Math.max(n, 1) >= AUDIT_GATES.minPhotoRatio, "Profiles with a photo", `${pct(withPhoto, n)}%`);
  gate(persisted >= withPhoto * 0.98, "Photos persisted to our storage", `${persisted}/${withPhoto}`);

  // 4. Status distribution
  const statusCounts: Record<string, number> = {};
  for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;

  // 5. Pricing present
  const priceField = PRICE_FIELD[type];
  const priced = rows.filter((r) => r[priceField] != null).length;
  gate(priced / Math.max(n, 1) >= 0.9, `Price present (${priceField})`, `${pct(priced, n)}%`);

  // 6. Profile hygiene
  let junkRows = 0;
  const junkKeys = new Set<string>();
  for (const r of rows) {
    const junk = Object.keys((r.profileData as any) || {}).filter((k) => JUNK_KEY_RE.test(k.replace(/\s+/g, "")));
    if (junk.length) {
      junkRows++;
      junk.forEach((k) => junkKeys.add(k));
    }
  }
  gate(junkRows === 0, "No platform-internal keys on profiles", junkRows ? `${junkRows} rows carry ${[...junkKeys].join(", ")}` : "clean");

  // 7. Required fields + sections: ours vs source
  const fields: AuditField[] = [];
  const mappingGaps: string[] = [];
  const sourceLimited: string[] = [];
  const sourceVariance: string[] = [];
  for (const c of checks) {
    const filled = rows.filter((r) => c.check(r)).length;
    const ratio = n ? filled / n : 0;
    const evidence = RAW_EVIDENCE[c.label];
    const unmapped = evidence ? rows.filter((r) => !c.check(r) && hasRawEvidence(r.profileData, evidence)).length : 0;
    let tag: AuditField["tag"];
    if (ratio >= AUDIT_GATES.minRequiredFieldFill) tag = "ok";
    else if (unmapped > 0) tag = "GAP";
    else if (filled === 0) tag = "SRC";
    else tag = "VAR";
    fields.push({ label: c.label, fillPct: pct(filled, n), tag, unmapped });
    if (tag === "GAP") mappingGaps.push(`${c.label} (${pct(filled, n)}%, ${unmapped} unmapped)`);
    else if (tag === "SRC") sourceLimited.push(c.label);
    else if (tag === "VAR") sourceVariance.push(`${c.label} (${pct(filled, n)}%)`);
  }
  if (mappingGaps.length) failures.push(`Fields present in raw data but not mapped: ${mappingGaps.join(", ")}`);

  return {
    accepted: failures.length === 0,
    auditedAt: new Date().toISOString(),
    rows: n,
    gates,
    fields,
    failures,
    mappingGaps,
    sourceLimited,
    sourceVariance,
    statusCounts,
  };
}

/** Plain-text rendering shared by the CLI and log lines. */
export function formatAuditReport(providerName: string, type: string, a: SyncAuditResult): string {
  const lines: string[] = [];
  lines.push(`== Sync audit: ${providerName} / ${type} ==  rows=${a.rows}`);
  for (const g of a.gates) lines.push(`${g.ok ? "PASS" : "FAIL"}  ${g.label}  ${g.detail}`);
  lines.push(`      status distribution: ${JSON.stringify(a.statusCounts)}`);
  lines.push("-- required field fill rates --");
  for (const f of a.fields) {
    lines.push(`  ${f.tag.padEnd(3)}  ${f.label.padEnd(38)} ${String(f.fillPct + "%").padStart(6)}${f.unmapped ? `   (${f.unmapped} rows have it in raw data but not mapped)` : ""}`);
  }
  lines.push("== Verdict ==");
  if (a.accepted) lines.push("SYNC ACCEPTED - all hard gates pass.");
  else {
    lines.push("SYNC NOT ACCEPTED:");
    a.failures.forEach((f) => lines.push(`  - ${f}`));
  }
  if (a.sourceLimited.length) lines.push(`Source-limited (absent on EVERY record - the provider does not publish these; ask them, do not fake them):\n  ${a.sourceLimited.join(", ")}`);
  if (a.sourceVariance.length) lines.push(`Source variance (donors left these blank; nothing to map): ${a.sourceVariance.join(", ")}`);
  return lines.join("\n");
}
