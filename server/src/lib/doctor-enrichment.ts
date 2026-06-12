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

// The Prisma select every caller must use so enrichDoctorRows has the fields it
// needs (member identity + per-clinic success-rate rows).
export const DOCTOR_MEMBER_SELECT = {
  id: true,
  slug: true,
  name: true,
  title: true,
  photoUrl: true,
  highResPhotoUrl: true,
  credential: true,
  npiTaxonomy: true,
  specialties: true,
  personKey: true,
  languagesSpoken: true,
  boardCertifications: true,
  education: true,
  yearsExperience: true,
  providerGender: true,
  offersVideoVisits: true,
  acceptingNewPatients: true,
  reviewCount: true,
  recommendPct: true,
  avgOverallScore: true,
  isMedicalDirector: true,
  provider: {
    select: {
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
          top10pct: true,
          cycleCount: true,
          profileType: true,
        },
      },
    },
  },
};

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
  name: string;
  title: string | null;
  photoUrl: string | null;
  credential: string | null;
  npiTaxonomy: string | null;
  specialties: string[];
  matchedSpecialties: string[];
  languagesSpoken: string[];
  boardCertifications: string[];
  education: string | null;
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
      name: m.name,
      title: m.title,
      // Prefer the AI-upscaled crisp variant; fall back to the original.
      photoUrl: m.highResPhotoUrl || m.photoUrl,
      credential: m.credential,
      npiTaxonomy: m.npiTaxonomy,
      specialties: m.specialties || [],
      matchedSpecialties: matchedSpecialtiesOf(m.specialties || []),
      languagesSpoken: m.languagesSpoken || [],
      boardCertifications: m.boardCertifications || [],
      education: m.education || null,
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
      clinics,
      clinicCount: clinics.length,
    };
  });
}
