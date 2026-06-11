/**
 * Shared doctor-data enrichment: resolves authoritative physician fields from
 * free public sources, keyed on the NPI. Used by BOTH the ongoing clinic
 * enrichment pipeline (so every run keeps doctor profiles current) and the
 * one-off backfill scripts - single implementation, no duplication.
 *
 * Sources (in priority order per field):
 *   - NPPES  (CMS NPI Registry): NPI, credential, specialty taxonomy, gender, license state
 *   - ABOG   (American Board of OB/GYN): board certification + valid-since year
 *   - Bio    (Gemini, strictly extractive): focus areas, languages, education when stated
 *
 * Everything is conservative: ambiguous matches are skipped, never guessed, so
 * we never attach the wrong physician's record. Per-field provenance is tracked
 * and a provider-entered ("self") value is never overwritten.
 */

import type { GoogleGenerativeAI } from "@google/generative-ai";

export type FieldSource = "nppes" | "abog" | "bio" | "cms" | "self";

const OK_TAXONOMY = /reproductive endocrinology|obstetrics|gynecolog/i;

export function parseDoctorName(name: string): { first: string; last: string } | null {
  const cleaned = name
    .replace(/^\s*(dr|doctor)\b\.?\s*/i, "")
    .replace(/,?\s*(MD|DO|PhD|FACOG|FACS|MBA|MSc|RN|NP|HCLD|MS)\b\.?/gi, "")
    .replace(/[.,]/g, "")
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts[parts.length - 1] };
}

export function normCredential(c: string | undefined | null): string | null {
  if (!c) return null;
  const up = c.toUpperCase().replace(/[.\s]/g, "");
  if (up.includes("MD")) return "MD";
  if (up.includes("DO")) return "DO";
  return null;
}

// US state full-name -> 2-letter, so clinic locations stored either way resolve.
const STATE_TO_CODE: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};
export function stateCode(state: string | null | undefined): string | null {
  if (!state) return null;
  const s = state.trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return STATE_TO_CODE[s.toLowerCase()] || null;
}

export interface NppesPick {
  npi: string;
  credential: string | null;
  taxonomy: string | null;
  gender: string | null;
  licenseState: string | null;
}

export async function resolveDoctorNpi(
  first: string,
  last: string,
  state: string | null,
  city: string | null,
): Promise<NppesPick | null> {
  const params = new URLSearchParams({ version: "2.1", first_name: first, last_name: last, limit: "20" });
  const code = stateCode(state);
  if (code) params.set("state", code);
  let json: any;
  try {
    const res = await fetch(`https://npiregistry.cms.hhs.gov/api/?${params.toString()}`);
    if (!res.ok) return null;
    json = await res.json();
  } catch {
    return null;
  }
  const results: any[] = json?.results || [];
  const candidates = results.filter((r) => {
    if (r.enumeration_type && r.enumeration_type !== "NPI-1") return false;
    const b = r.basic || {};
    if ((b.last_name || "").toLowerCase() !== last.toLowerCase()) return false;
    return (r.taxonomies || []).some((t: any) => OK_TAXONOMY.test(t.desc || ""));
  });
  if (candidates.length === 0) return null;

  let chosen: any;
  if (candidates.length === 1) chosen = candidates[0];
  else if (city) {
    const byCity = candidates.filter((r) =>
      (r.addresses || []).some((a: any) => (a.city || "").toLowerCase() === city.toLowerCase()),
    );
    if (byCity.length === 1) chosen = byCity[0];
  }
  if (!chosen) return null;

  const b = chosen.basic || {};
  const primaryTax = (chosen.taxonomies || []).find((t: any) => t.primary) || (chosen.taxonomies || [])[0] || {};
  return {
    npi: String(chosen.number),
    credential: normCredential(b.credential),
    taxonomy: primaryTax.desc || null,
    gender: b.gender === "M" ? "Male" : b.gender === "F" ? "Female" : null,
    licenseState: primaryTax.state || null,
  };
}

export interface AbogResult {
  boardCertifications: string[];
  certStartYear: number | null;
}

// ABOG (American Board of Obstetrics & Gynecology) public verification.
export async function lookupAbog(
  last: string,
  state: string | null,
  city: string | null,
): Promise<AbogResult | null> {
  const code = stateCode(state);
  if (!code) return null;
  let arr: any[];
  try {
    const res = await fetch(
      `https://api.abog.org/diplomate/verify?name=${encodeURIComponent(last)}&state=${code}`,
      { headers: { Origin: "https://www.abog.org" } },
    );
    if (!res.ok) return null;
    arr = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;

  let match = arr;
  if (arr.length > 1 && city) {
    const byCity = arr.filter((d) => (d.city || "").toLowerCase() === city.toLowerCase());
    if (byCity.length >= 1) match = byCity;
  }
  if (match.length !== 1) return null; // ambiguous - skip
  const d = match[0];
  const valid = typeof d.certStatus === "string" && /valid/i.test(d.certStatus);
  if (!valid) return null;
  const year = d.startDate ? new Date(d.startDate).getUTCFullYear() : null;
  return {
    boardCertifications: ["American Board of Obstetrics and Gynecology"],
    certStartYear: Number.isFinite(year as number) ? (year as number) : null,
  };
}

export interface BioFields {
  specialties: string[];
  languagesSpoken: string[];
  boardCertifications: string[];
  education: string[];
  professionalMemberships: string[];
  yearsExperience: number | null;
  providerGender: "Male" | "Female" | null;
}

export async function extractDoctorFieldsFromBio(
  genAI: GoogleGenerativeAI,
  name: string,
  bio: string,
): Promise<BioFields | null> {
  if (!bio || bio.trim().length < 60) return null;
  const model = genAI.getGenerativeModel({
    model: "gemini-3.5-flash",
    generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: "application/json" } as any,
  });
  const prompt = `You are extracting structured facts from a fertility doctor's professional bio. Extract ONLY facts explicitly stated. Do NOT infer, guess, or add anything not literally present. Empty array / null if not stated.

Doctor name: ${name}
Bio:
"""${bio}"""

Return STRICT JSON: {
  "specialties": string[],          // clinical focus areas mentioned, Title Case (e.g. "Male Factor Infertility","LGBTQ+ Family Building","PCOS","Recurrent Pregnancy Loss","Egg Freezing","Fertility Preservation","Advanced Maternal Age","Endometriosis","Diminished Ovarian Reserve","Social Infertility")
  "languagesSpoken": string[],
  "boardCertifications": string[],
  "education": string[],            // "Medical School - <inst>","Residency - <inst>","Fellowship - <inst>"
  "professionalMemberships": string[],
  "yearsExperience": number,        // integer only if explicitly stated, else null
  "providerGender": string          // "Male"/"Female" only if clear he/him or she/her pronouns, else null
}
Return ONLY the JSON object.`;
  let text: string;
  try {
    const result = await model.generateContent(prompt);
    text = result.response.text();
  } catch {
    return null;
  }
  try {
    const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const o = JSON.parse(cleaned);
    const arr = (v: any): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
    const gender = o.providerGender === "Male" || o.providerGender === "Female" ? o.providerGender : null;
    const yrs = typeof o.yearsExperience === "number" && Number.isFinite(o.yearsExperience) ? Math.round(o.yearsExperience) : null;
    return {
      specialties: arr(o.specialties),
      languagesSpoken: arr(o.languagesSpoken),
      boardCertifications: arr(o.boardCertifications),
      education: arr(o.education),
      professionalMemberships: arr(o.professionalMemberships),
      yearsExperience: yrs,
      providerGender: gender,
    };
  } catch {
    return null;
  }
}

/**
 * Run all sources for one doctor and return the fields to write plus updated
 * provenance. Never overwrites a field whose existing source is "self".
 * Returns null data if nothing resolved.
 */
export async function buildDoctorEnrichment(opts: {
  name: string;
  bio: string | null;
  city: string | null;
  state: string | null;
  existingSources: Record<string, string> | null | undefined;
  genAI: GoogleGenerativeAI;
}): Promise<{ data: Record<string, any>; sources: Record<string, string> }> {
  const sources: Record<string, string> = { ...(opts.existingSources || {}) };
  const data: Record<string, any> = {};
  const set = (field: string, value: any, src: FieldSource) => {
    if (value == null) return;
    if (Array.isArray(value) && value.length === 0) return;
    if (sources[field] === "self") return; // never clobber human entry
    data[field] = value;
    sources[field] = src;
  };

  const parsed = parseDoctorName(opts.name);
  let certYear: number | null = null;

  if (parsed) {
    // NPPES (authoritative identity)
    const npi = await resolveDoctorNpi(parsed.first, parsed.last, opts.state, opts.city);
    if (npi) {
      set("npiNumber", npi.npi, "nppes");
      set("credential", npi.credential, "nppes");
      set("npiTaxonomy", npi.taxonomy, "nppes");
      set("providerGender", npi.gender, "nppes");
      set("licenseState", npi.licenseState, "nppes");
    }
    // ABOG (authoritative board certification)
    const abog = await lookupAbog(parsed.last, opts.state, opts.city);
    if (abog) {
      set("boardCertifications", abog.boardCertifications, "abog");
      certYear = abog.certStartYear;
    }
  }

  // Bio (supplement: focus areas, languages, education, + fallbacks)
  const bioFields = opts.bio ? await extractDoctorFieldsFromBio(opts.genAI, opts.name, opts.bio) : null;
  if (bioFields) {
    set("specialties", bioFields.specialties, "bio");
    set("languagesSpoken", bioFields.languagesSpoken, "bio");
    set("education", bioFields.education, "bio");
    set("professionalMemberships", bioFields.professionalMemberships, "bio");
    // fill these only if a higher-confidence source didn't already
    if (sources["boardCertifications"] !== "abog") set("boardCertifications", bioFields.boardCertifications, "bio");
    if (sources["providerGender"] !== "nppes") set("providerGender", bioFields.providerGender, "bio");
    set("yearsExperience", bioFields.yearsExperience, "bio");
  }

  // Derive yearsExperience from ABOG cert year if nothing better set it.
  if (certYear && sources["yearsExperience"] !== "self" && data["yearsExperience"] == null) {
    const yrs = new Date().getUTCFullYear() - certYear;
    if (yrs > 0 && yrs < 70) {
      data["yearsExperience"] = yrs;
      sources["yearsExperience"] = "abog";
    }
  }

  if (Object.keys(data).length > 0) data["fieldSources"] = sources;
  return { data, sources };
}
