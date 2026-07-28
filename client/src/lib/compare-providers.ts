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

const text = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s && s !== "-" && s !== "--" ? s : null;
};
const yesNo = (v: unknown): string | null => (v === true ? "Yes" : v === false ? "No" : null);

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
          return describeRateDelta(Number(r.successRate) * 100, Number(r.nationalAverage) * 100).label;
        } },
        { label: "Cycles in this group", get: (c) => {
          const r = rateOf(c);
          return r && Number(r.cycleCount) > 0 ? String(r.cycleCount) : null;
        } },
        { label: "Top 10% nationally", get: (c) => (rateOf(c)?.top10pct === true ? "Yes" : null) },
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
        { label: "Practises at", get: (d) => text(d?.clinicName ?? d?.provider?.name) },
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
        { label: "Specialties", get: (d) => {
          const s = d?.specialties;
          return Array.isArray(s) && s.length ? s.join(", ") : null;
        } },
      ],
    },
    {
      group: "Access",
      rows: [
        { label: "Location", get: (d) => formatLocationDisplay(text(d?.location)) || text(d?.location) },
        { label: "Accepting new patients", get: (d) => yesNo(d?.acceptingNewPatients) },
        { label: "Languages", get: (d) => {
          const l = d?.languages;
          return Array.isArray(l) && l.length ? l.join(", ") : text(l);
        } },
      ],
    },
    {
      group: "Credentials",
      rows: [
        { label: "Medical school", get: (d) => text(d?.medicalSchool) },
        { label: "Residency", get: (d) => text(d?.residency) },
        { label: "Board certification", get: (d) => {
          const b = d?.boardCertifications;
          return Array.isArray(b) && b.length ? b.join(", ") : text(b);
        } },
        { label: "Years in practice", get: (d) => text(d?.yearsInPractice) },
      ],
    },
  ], doctors);
}
