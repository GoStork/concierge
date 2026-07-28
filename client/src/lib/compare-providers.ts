import { pickClinicRate, type ClinicRateContext } from "@/lib/clinic-rate";
import { describeRateDelta } from "@/lib/rate-delta";
import { formatMoneyDollars } from "@/lib/format-money";
import { formatLocationDisplay } from "@/lib/format-location";
import { parseInsuranceValue } from "@shared/insurance-data";

/**
 * What a parent compares when choosing a clinic or a doctor.
 *
 * Deliberately not the donor rows. Nobody picks a clinic on eye colour: the
 * order here is outcomes, then cost, then access, then scale - outcomes first
 * because it is the question, cost and access next because they disqualify
 * fastest, scale last because it is context rather than a decision.
 *
 * The rate comes from pickClinicRate, the same lookup the clinic card uses.
 * Two lookups for one number is how a card and a comparison start quietly
 * disagreeing about the most important figure on the page.
 */

export type CompareGroup = { group: string; rows: { label: string; values: (string | null)[] }[] };

/** Rendered as the green pill the marketplace card uses, not as plain text. */
export const TOP_10_BADGE = "Top 10%";

const text = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s && s !== "-" && s !== "--" ? s : null;
};
const yesNo = (v: unknown): string | null => (v === true ? "Yes" : v === false ? "No" : null);
/**
 * Arrays and scalars both arrive here depending on the scraper.
 *
 * Joined with newlines, not commas: an education history reads as three
 * separate facts (medical school, residency, fellowship) and running them into
 * one comma paragraph makes a parent parse a sentence to find them. The cell
 * renderer splits on the newline and gives each its own line.
 */
export const LIST_SEPARATOR = "\n";
const list = (v: unknown): string | null => {
  if (Array.isArray(v)) {
    const items = v.filter(Boolean).map((x) => String(x).trim()).filter(Boolean);
    return items.length ? items.join(LIST_SEPARATOR) : null;
  }
  // Some scrapers store the whole history as one comma string - split it back
  // out so it reads the same as the array form does.
  const t = text(v);
  if (!t) return null;
  const parts = t.split(/\s*,\s*(?=[A-Z])/).map((x) => x.trim()).filter(Boolean);
  return parts.length > 1 ? parts.join(LIST_SEPARATOR) : t;
};

type Row<T> = { label: string; get: (item: T) => string | null };

function build<T>(groups: { group: string; rows: Row<T>[] }[], items: T[]): CompareGroup[] {
  return groups
    .map(({ group, rows }) => ({
      group,
      rows: rows
        .filter((r) => items.some((i) => r.get(i)))
        .map((r) => ({ label: r.label, values: items.map((i) => r.get(i)) })),
    }))
    .filter((g) => g.rows.length > 0);
}

/** True when no clinic could match this parent's own profile - the caller must say so. */
export function clinicRatesAreGeneric(clinics: any[], ctx: ClinicRateContext): boolean {
  return clinics.every((c) => pickClinicRate(c?.ivfSuccessRates || [], ctx).isFallback);
}

export function buildClinicCompare(clinics: any[], ctx: ClinicRateContext): CompareGroup[] {
  const rateOf = (c: any) => pickClinicRate(c?.ivfSuccessRates || [], ctx).rate;

  return build<any>([
    {
      group: "Outcomes",
      rows: [
        { label: "Live birth rate", get: (c) => {
          const r = rateOf(c);
          return r ? `${Math.round(Number(r.successRate) * 100)}%` : null;
        } },
        { label: "vs. national average", get: (c) => {
          const r = rateOf(c);
          if (!r || r.nationalAverage == null) return null;
          // Below national is stated plainly, never as a failure - CDC rates are
          // not risk-adjusted, so a clinic taking hard cases scores lower.
          // Just the number: the row label already reads "vs. national
          // average", and repeating it per cell wrapped to one word per line
          // on a phone.
          const d = describeRateDelta(Number(r.successRate) * 100, Number(r.nationalAverage) * 100);
          return `${d.diff >= 0 ? "+" : ""}${d.diff}%`;
        } },
        { label: "Cycles in this group", get: (c) => {
          const r = rateOf(c);
          return r && Number(r.cycleCount) > 0 ? String(r.cycleCount) : null;
        } },
        // The card's own badge text, so the comparison shows the same pill a
        // parent already recognises rather than a bare "Yes".
        { label: "Top 10% nationally", get: (c) => (rateOf(c)?.top10pct === true ? TOP_10_BADGE : null) },
      ],
    },
    {
      group: "Cost",
      rows: [
        { label: "Program cost", get: (c) => {
          const min = Number(c?.costMin ?? c?.minTotal);
          const max = Number(c?.costMax ?? c?.maxTotal);
          if (!Number.isFinite(min) || min <= 0) return null;
          return Number.isFinite(max) && max > min ? `${formatMoneyDollars(min)} - ${formatMoneyDollars(max)}` : formatMoneyDollars(min);
        } },
      ],
    },
    {
      group: "Access",
      rows: [
        { label: "Location", get: (c) => formatLocationDisplay(text(c?.location)) || text(c?.location) },
        { label: "Accepting new patients", get: (c) => {
          const v = c?.ivfAcceptingPatients;
          return Array.isArray(v) && v.length > 0 ? v.join(", ") : null;
        } },
        { label: "Insurance accepted", get: (c) => {
          const carriers = Array.from(new Set((c?.acceptedInsurance || []).map((v: string) => parseInsuranceValue(v).carrier).filter(Boolean)));
          return carriers.length ? carriers.join(", ") : null;
        } },
      ],
    },
    {
      group: "Scale & services",
      rows: [
        { label: "Annual cycles", get: (c) => {
          const total = c?.cdcCycleStats?.totalCycles;
          return Number(total) > 0 ? String(total) : null;
        } },
        { label: "Donor eggs", get: (c) => yesNo(c?.cdcServices?.donorEgg) },
        { label: "Gestational carrier", get: (c) => yesNo(c?.cdcServices?.gestationalCarrier) },
        { label: "Genetic testing (PGT)", get: (c) => yesNo(c?.cdcServices?.pgt ?? c?.cdcServices?.embryoCryo) },
        { label: "Founded", get: (c) => text(c?.yearFounded) },
        { label: "Physicians", get: (c) => {
          const n = Array.isArray(c?.members) ? c.members.length : null;
          return n ? String(n) : null;
        } },
      ],
    },
  ], clinics);
}

export function buildDoctorCompare(doctors: any[], parentDiagnoses: string[] = []): CompareGroup[] {
  const wanted = parentDiagnoses.map((d) => d.toLowerCase()).filter(Boolean);

  return build<any>([
    {
      group: "Clinic & outcomes",
      rows: [
        // CDC reports at CLINIC level. Presenting anything here as a
        // physician-level statistic would invent a number we do not have.
        { label: "Practises at", get: (d) => text(d?.clinicName ?? d?.providerName ?? d?.provider?.name ?? d?.clinic?.name) },
        { label: "Their clinic's live birth rate", get: (d) => {
          const r = pickClinicRate(d?.provider?.ivfSuccessRates || d?.ivfSuccessRates || [], {}).rate;
          return r ? `${Math.round(Number(r.successRate) * 100)}%` : null;
        } },
      ],
    },
    {
      group: "Specialties",
      rows: [
        { label: "Matches your diagnoses", get: (d) => {
          if (wanted.length === 0) return null;
          const specialties = (d?.specialties || []).map((s: string) => String(s).toLowerCase());
          const hits = parentDiagnoses.filter((diag) => specialties.some((s: string) => s.includes(diag.toLowerCase())));
          return hits.length ? hits.join(", ") : "None listed";
        } },
        { label: "Specialties", get: (d) => list(d?.specialties) },
      ],
    },
    {
      group: "Access",
      rows: [
        { label: "Location", get: (d) => formatLocationDisplay(text(d?.location)) || text(d?.location) },
        { label: "Accepting new patients", get: (d) => yesNo(d?.acceptingNewPatients) },
        // The column is languagesSpoken; `languages` was a guess and every row
        // silently dropped because nothing ever filled it.
        { label: "Languages", get: (d) => list(d?.languagesSpoken ?? d?.languages) },
      ],
    },
    {
      group: "Education & background",
      rows: [
        { label: "Education", get: (d) => list(d?.education) },
        { label: "Medical school", get: (d) => text(d?.medicalSchool) },
        { label: "Graduated", get: (d) => text(d?.graduationYear) },
        { label: "Board certification", get: (d) => list(d?.boardCertifications) },
        { label: "Years of experience", get: (d) => text(d?.yearsExperience) },
        { label: "Professional memberships", get: (d) => list(d?.professionalMemberships) },
        { label: "NPI", get: (d) => text(d?.npiNumber) },
      ],
    },
  ], doctors);
}
