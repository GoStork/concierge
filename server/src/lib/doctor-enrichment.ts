/**
 * Shared doctor-enrichment helper.
 *
 * One canonical place that turns raw ProviderMember rows (across the clinics a
 * doctor practices at) into the enriched doctor shape the doctor SwipeDeckCard
 * consumes - deduped by personKey, with each clinic's success rate computed for
 * the parent's profile via the shared `computeClinicSuccessRate` helper.
 *
 * Consumed by BOTH the marketplace `marketplaceDoctors` endpoint and the
 * `search_doctors` / `resolve_doctor_card` MCP tools, so the card renders
 * identically in the marketplace and in the AI matcher. Each caller builds its
 * own Prisma `where` (their filter params differ) and runs its own post-fetch
 * insurance/LGBTQ filtering, then hands the rows here for the common shaping.
 */

import { computeClinicSuccessRate, type EggSource, type AgeGroup } from "./ivf-success-rate";
import { isClinicianMember } from "../modules/providers/clinician";

// Member-level fields (identity, credentials, sponsorship) - everything the
// enriched card needs from the ProviderMember row itself. `providerId` is here
// so callers can stitch the clinic record on afterwards (see
// fetchDoctorRowsWithClinics).
export const DOCTOR_MEMBER_FIELDS = {
  id: true,
  slug: true,
  name: true,
  title: true,
  bio: true,
  photoUrl: true,
  highResPhotoUrl: true,
  credential: true,
  npiNumber: true, // strongest "is a doctor" signal - see clinician.ts
  npiTaxonomy: true,
  specialties: true,
  personKey: true,
  languagesSpoken: true,
  boardCertifications: true,
  education: true,
  // These three are read by the comparison table (compare-providers.ts). Leaving
  // them out of the select does not fail loudly - the row just renders empty for
  // every doctor, which looks identical to "we have no data" even when the
  // column is populated. Keep this select in sync with that row list.
  professionalMemberships: true,
  medicalSchool: true,
  graduationYear: true,
  yearsExperience: true,
  providerGender: true,
  offersVideoVisits: true,
  acceptingNewPatients: true,
  reviewCount: true,
  recommendPct: true,
  avgOverallScore: true,
  isMedicalDirector: true,
  sponsoredUntil: true,
  sponsorBoostSeed: true,
  providerId: true,
};

// Clinic-level fields (locations + the success-rate rows the card ranks on).
// Fetched ONCE per clinic by fetchDoctorRowsWithClinics rather than once per
// member: a clinic with 40 doctors used to ship its ~45 success-rate rows 40
// times through Prisma's nested select (19,560 rows for 433 clinics on DEV),
// which was most of the wire time on the Doctors tab.
export const DOCTOR_CLINIC_SELECT = {
  id: true,
  name: true,
  logoUrl: true,
  acceptedInsurance: true,
  ivfAcceptingPatients: true,
  locations: { orderBy: { sortOrder: "asc" as const }, select: { city: true, state: true } },
  ivfSuccessRates: {
    where: {
      metricCode: {
        in: [
          "pct_new_patients_live_birth_after_1_retrieval",
          "pct_intended_retrievals_live_births",
          "pct_transfers_live_births_donor",
        ],
      },
    },
    select: {
      successRate: true,
      nationalAverage: true,
      ageGroup: true,
      isNewPatient: true,
      metricCode: true,
      submetric: true,
      top10pct: true,
      cycleCount: true,
      profileType: true,
    },
  },
};

// The nested Prisma select for callers that fetch a HANDFUL of rows (the MCP
// resolve_doctor_card / search_doctors tools). enrichDoctorRows accepts rows
// shaped either by this select or by fetchDoctorRowsWithClinics - both end up
// as `member + provider: { ...DOCTOR_CLINIC_SELECT fields }`.
export const DOCTOR_MEMBER_SELECT = {
  ...DOCTOR_MEMBER_FIELDS,
  provider: { select: DOCTOR_CLINIC_SELECT },
};

/**
 * Directory-scale fetch: members in one query, their clinics in a second one
 * keyed on the distinct providerIds, stitched back into the DOCTOR_MEMBER_SELECT
 * shape. Use this whenever the row count is in the hundreds or more; use the
 * nested select for point lookups.
 */
export async function fetchDoctorRowsWithClinics(
  prisma: any,
  args: { where: any; take?: number; orderBy?: any },
): Promise<any[]> {
  const members: any[] = await prisma.providerMember.findMany({
    where: args.where,
    take: args.take,
    orderBy: args.orderBy,
    select: DOCTOR_MEMBER_FIELDS,
  });
  if (!members.length) return [];
  const clinicIds = [...new Set(members.map((m) => m.providerId as string))];
  // Two flat queries in parallel beat one nested select: Prisma fetches a
  // nested relation as its own sequential round trip anyway, and the flat
  // shape ships each rate row once. Measured on DEV (1,634 members / 434
  // clinics): nested 1.5-2.7s, flat pair ~1s, on a ~150ms link.
  const { ivfSuccessRates: ratesSelect, ...clinicSelect } = DOCTOR_CLINIC_SELECT as any;
  const [clinics, rates]: [any[], any[]] = await Promise.all([
    prisma.provider.findMany({ where: { id: { in: clinicIds } }, select: clinicSelect }),
    prisma.ivfSuccessRate.findMany({
      where: { providerId: { in: clinicIds }, ...ratesSelect.where },
      select: { providerId: true, ...ratesSelect.select },
    }),
  ]);
  const ratesByClinic = new Map<string, any[]>();
  for (const r of rates) {
    const { providerId, ...row } = r;
    if (!ratesByClinic.has(providerId)) ratesByClinic.set(providerId, []);
    ratesByClinic.get(providerId)!.push(row);
  }
  const clinicById = new Map(clinics.map((c) => [c.id, { ...c, ivfSuccessRates: ratesByClinic.get(c.id) || [] }]));
  return members
    .map((m) => ({ ...m, provider: clinicById.get(m.providerId) }))
    // A member whose clinic vanished between the two queries has nothing to render.
    .filter((m) => m.provider);
}

export interface DoctorEnrichmentContext {
  eggSource: EggSource;
  ageGroup: AgeGroup;
  isNewPatient: boolean;
  // Active specialty filter / free-text terms, used to compute matchedSpecialties.
  specialtyFilter?: string;
  searchTerms?: string[];
}

export interface EnrichedDoctorClinic {
  providerId: string;
  providerName: string;
  providerLogoUrl: string | null;
  location: string | null;
  lgbtqCare: boolean;
  successRate: string | null;
  successRateLabel: string | null;
  nationalAverage: string | null;
  top10pct: boolean;
  cycleCount: number | null;
  successPct: number | null;
}

export interface EnrichedDoctor {
  slug: string;
  // Stable identity across a doctor's per-clinic member rows - the key these
  // rows were merged on. Callers that fetched a SUBSET of a person's rows (the
  // Saved / Hidden views ask by slug) use it to re-key the merged card.
  personKey: string;
  name: string;
  title: string | null;
  bio: string | null;
  photoUrl: string | null;
  credential: string | null;
  npiTaxonomy: string | null;
  specialties: string[];
  matchedSpecialties: string[];
  languagesSpoken: string[];
  boardCertifications: string[];
  education: string[];
  professionalMemberships: string[];
  medicalSchool: string | null;
  graduationYear: number | null;
  yearsExperience: number | null;
  providerGender: string | null;
  offersVideoVisits: boolean;
  acceptingNewPatients: boolean;
  reviewCount: number;
  recommendPct: number | null;
  avgOverallScore: number | null;
  // Primary clinic mirrored to the top level for the always-visible badge.
  providerId: string;
  providerName: string;
  providerLogoUrl: string | null;
  location: string | null;
  successRate: string | null;
  successRateLabel: string | null;
  nationalAverage: string | null;
  top10pct: boolean;
  sponsoredUntil: Date | string | null;
  sponsorBoostSeed: number;
  clinics: EnrichedDoctorClinic[];
  clinicCount: number;
}

// Richest-row score: prefer a row with a photo, more specialties, a credential.
const scoreRow = (m: any) => (m.photoUrl ? 100 : 0) + (m.specialties?.length || 0) * 10 + (m.credential ? 5 : 0);

/**
 * Dedupe member rows by personKey and build the canonical enriched doctor shape.
 * `rows` must have been selected with DOCTOR_MEMBER_SELECT.
 */
export function enrichDoctorRows(rows: any[], ctx: DoctorEnrichmentContext): EnrichedDoctor[] {
  // Every caller of this shape is a DOCTOR surface (marketplace directory, MCP
  // search_doctors / resolve_doctor_card, comparison table). Enforce the
  // clinician rule here once so no caller can leak a lab director or practice
  // manager as a doctor card.
  rows = rows.filter((m) => isClinicianMember(m));
  const srContext = { eggSource: ctx.eggSource, ageGroup: ctx.ageGroup, isNewPatient: ctx.isNewPatient };
  const specialtyFilter = (ctx.specialtyFilter || "").trim().toLowerCase();
  const searchTerms = ctx.searchTerms || [];

  const matchedSpecialtiesOf = (specialties: string[]): string[] => {
    if (!Array.isArray(specialties)) return [];
    return specialties.filter((s) => {
      const sl = s.toLowerCase();
      if (specialtyFilter && (sl === specialtyFilter || sl.includes(specialtyFilter))) return true;
      if (searchTerms.length && searchTerms.some((t) => t && sl.includes(t))) return true;
      return false;
    });
  };

  // One identity row per person (richest), but collect EVERY clinic row so the
  // card can list each affiliation with that clinic's success rate.
  const byPerson = new Map<string, any>();
  const rowsByProviderByPerson = new Map<string, Map<string, any>>();
  for (const m of rows) {
    const key = m.personKey || m.id;
    if (!rowsByProviderByPerson.has(key)) rowsByProviderByPerson.set(key, new Map());
    const byProvider = rowsByProviderByPerson.get(key)!;
    const curForProvider = byProvider.get(m.provider.id);
    if (!curForProvider || scoreRow(m) > scoreRow(curForProvider)) byProvider.set(m.provider.id, m);
    const cur = byPerson.get(key);
    if (!cur || scoreRow(m) > scoreRow(cur)) byPerson.set(key, m);
  }

  return [...byPerson.values()].map((m) => {
    const key = m.personKey || m.id;
    const clinicRows = [...(rowsByProviderByPerson.get(key)?.values() || [m])];
    const clinics: EnrichedDoctorClinic[] = clinicRows.map((row: any) => {
      const p = row.provider;
      const sr = computeClinicSuccessRate(p.ivfSuccessRates, srContext);
      const loc = p.locations[0] || null;
      return {
        providerId: p.id,
        providerName: p.name,
        providerLogoUrl: p.logoUrl,
        location: loc ? [loc.city, loc.state].filter(Boolean).join(", ") : null,
        lgbtqCare: Array.isArray(p.ivfAcceptingPatients) && (p.ivfAcceptingPatients as string[]).includes("gay_couple"),
        successRate: sr.successRate,
        successRateLabel: sr.successRateLabel,
        nationalAverage: sr.nationalAverage,
        top10pct: sr.top10pct,
        cycleCount: sr.cycleCount,
        successPct: sr.successPct,
      };
    });
    // Lead clinic = highest success rate (drives the pinned badge + primary tab).
    clinics.sort((a, b) => (b.successPct ?? -1) - (a.successPct ?? -1));
    const primary = clinics[0] || null;

    return {
      slug: m.slug,
      personKey: key,
      name: m.name,
      title: m.title,
      bio: m.bio ?? null,
      // Prefer the AI-upscaled crisp variant; fall back to the original.
      photoUrl: m.highResPhotoUrl || m.photoUrl,
      credential: m.credential,
      npiTaxonomy: m.npiTaxonomy,
      specialties: m.specialties || [],
      matchedSpecialties: matchedSpecialtiesOf(m.specialties || []),
      languagesSpoken: m.languagesSpoken || [],
      boardCertifications: m.boardCertifications || [],
      // education is a String[] column; the interface used to declare it as
      // `string | null`, which typechecked only because the value is passed
      // straight through untyped.
      education: m.education || [],
      professionalMemberships: m.professionalMemberships || [],
      medicalSchool: m.medicalSchool || null,
      graduationYear: m.graduationYear ?? null,
      yearsExperience: m.yearsExperience ?? null,
      providerGender: m.providerGender || null,
      offersVideoVisits: !!m.offersVideoVisits,
      acceptingNewPatients: m.acceptingNewPatients !== false,
      reviewCount: m.reviewCount || 0,
      recommendPct: m.recommendPct ?? null,
      avgOverallScore: m.avgOverallScore != null ? Number(m.avgOverallScore) : null,
      providerId: primary?.providerId || m.provider.id,
      providerName: primary?.providerName || m.provider.name,
      providerLogoUrl: primary?.providerLogoUrl || m.provider.logoUrl,
      location: primary?.location || null,
      successRate: primary?.successRate || null,
      successRateLabel: primary?.successRateLabel || null,
      nationalAverage: primary?.nationalAverage || null,
      top10pct: primary?.top10pct || false,
      // Sponsorship boost (denormalized) - drives the marketplace "Sponsored" badge + ordering.
      sponsoredUntil: m.sponsoredUntil ?? null,
      sponsorBoostSeed: m.sponsorBoostSeed ?? 0,
      // Convenience boolean the AI concierge keys off for its sponsored tiebreaker.
      sponsored: !!m.sponsoredUntil && new Date(m.sponsoredUntil).getTime() > Date.now(),
      clinics,
      clinicCount: clinics.length,
    };
  });
}

/**
 * Marketplace sort for the Doctors directory.
 *
 * A doctor has no success rate of their own - they inherit their clinics'.
 * `clinics[]` is already ordered best-rate-first by enrichDoctorRows, so
 * `clinics[0]` is the LEAD clinic, which is also the one whose rate the card
 * badge shows. Ranking on the lead clinic keeps the list order consistent with
 * the number the parent is actually reading off the card - a doctor at six
 * clinics sorts by their strongest one.
 *
 * Doctors with no rate at all sink to the bottom in BOTH directions: "lowest
 * success rate" means the lowest KNOWN rate, not "no data reported".
 *
 * Ties keep their incoming order (sponsored, then medical director, then name),
 * because Array.prototype.sort is stable - so equal-rate doctors still read
 * alphabetically instead of shuffling per request.
 */
export function sortEnrichedDoctors<T extends EnrichedDoctor>(doctors: T[], sortBy?: string): T[] {
  const leadRate = (d: T) => d.clinics?.[0]?.successPct ?? null;
  const leadCycles = (d: T) => d.clinics?.[0]?.cycleCount ?? null;

  // Nulls last in both directions - see the note above.
  const by = (get: (d: T) => number | null, dir: "desc" | "asc") => (a: T, b: T) => {
    const av = get(a);
    const bv = get(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return dir === "desc" ? bv - av : av - bv;
  };

  switch (sortBy) {
    case "highest_success": return [...doctors].sort(by(leadRate, "desc"));
    case "lowest_success": return [...doctors].sort(by(leadRate, "asc"));
    case "highest_cycles": return [...doctors].sort(by(leadCycles, "desc"));
    case "lowest_cycles": return [...doctors].sort(by(leadCycles, "asc"));
    case "alphabetical": return [...doctors].sort((a, b) => a.name.localeCompare(b.name));
    // Absent or not-yet-implemented (the distance options need geocoding that
    // does not exist yet): keep the query's own ordering.
    default: return doctors;
  }
}
