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
import { trackGemini } from "../../lib/gemini-usage";

// "default" means assumed, not observed - currently only English on a
// US-practising doctor. It is a distinct value on purpose: it keeps assumed
// values countable, so `languagesSpoken` coverage can still be measured against
// what we actually found on a page rather than what we filled in.
export type FieldSource = "nppes" | "abog" | "bio" | "cms" | "self" | "default";

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

// stateCode() accepts ANY two-letter string, so "BC" (British Columbia) and
// "DF" (Distrito Federal) come back looking like US states. Membership in the
// real set is what decides whether a doctor practises in the US.
const US_STATE_CODES = new Set([...Object.values(STATE_TO_CODE), "PR", "VI", "GU", "AS", "MP"]);
export function isUsState(state: string | null | undefined): boolean {
  const code = stateCode(state);
  return !!code && US_STATE_CODES.has(code);
}

/**
 * Ensure a US-practising doctor lists English.
 *
 * Every physician licensed and practising in the US speaks English, so omitting
 * it reads as missing data rather than as a fact. This is an ASSUMPTION, not an
 * observation - callers mark it with the "default" provenance when English is
 * the only entry, so the genuine coverage gap stays measurable.
 *
 * Applied only to US locations: adding English to a Colombian or Mexican partner
 * clinic's doctors would be inventing a fact, not restating a certainty.
 */
export function withDefaultEnglish(languages: string[], state: string | null | undefined): string[] {
  if (!isUsState(state)) return languages;
  if (languages.some((l) => l.toLowerCase() === "english")) return languages;
  return ["English", ...languages];
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
  graduationYear: number | null;
  providerGender: "Male" | "Female" | null;
}

// Controlled vocabulary for doctor specialties. Bio extraction is noisy and
// pulls generic patient-population phrases ("Social Infertility", "Advanced
// Maternal Age") that aren't useful specialties. Map what's extracted to a
// curated set of meaningful fertility specialties and drop everything else.
// Order matters only for readability - every matching rule contributes.
// IMPORTANT: this list is a filter, not a suggestion. Anything a doctor lists
// that has no rule here is DELETED (see scripts/curate-specialties.ts), so a
// missing rule silently blanks a real specialty. Add a rule before assuming an
// extracted value is noise.
const SPECIALTY_RULES: { canonical: string; match: RegExp }[] = [
  { canonical: "LGBTQ+ Family Building", match: /lgbtq|same[\s-]?sex|\bgay\b|lesbian|two mom|family building/i },
  { canonical: "Male Factor Infertility", match: /male (factor|fertility|infertility)|men'?s (health|sexual|reproductive)|andrology|azoospermia|vasectomy|sperm retrieval|\bteseE?\b|microtese/i },
  { canonical: "PCOS", match: /pcos|polycystic/i },
  { canonical: "Recurrent Pregnancy Loss", match: /recurrent (pregnancy )?(loss|miscarriage)|recurrent implantation|repeated (miscarriage|implantation)|pregnancy loss/i },
  { canonical: "Endometriosis", match: /endometriosis/i },
  { canonical: "Diminished Ovarian Reserve", match: /diminished ovarian reserve|low ovarian reserve|\bdor\b|poor responder|ovarian aging/i },
  { canonical: "Egg Freezing", match: /egg freezing|oocyte (cryopreservation|freezing)|elective (egg|oocyte)/i },
  { canonical: "Fertility Preservation", match: /fertility preservation|oncofertility|cancer (and )?fertility/i },
  { canonical: "Egg & Embryo Donation", match: /egg donation|donor egg|oocyte donation|embryo donation|donor embryo|third[\s-]?party reproduction/i },
  { canonical: "Surrogacy & Gestational Carriers", match: /surrogacy|gestational carrier|gestational surrogate/i },
  { canonical: "Reproductive Surgery", match: /reproductive surg|surgical procedure|hysteroscop|laparoscop|fibroid|myomectomy|robotic surg|minimally invasive|adhesio|septum/i },
  { canonical: "Genetic Testing (PGT)", match: /\bpgt(-[am])?\b|preimplantation|genetic (testing|screening|counseling)|carrier screening|chromosom/i },
  { canonical: "Tubal Factor", match: /tubal factor|tubal (disease|blockage|reanastomosis|ligation)|hydrosalpin/i },
  // --- Added after the curation pass blanked 102 doctors whose real, correctly
  // extracted specialties simply had no rule. These are the most common ones.
  { canonical: "IVF", match: /\bivf\b|in[\s-]?vitro fertili|embryo transfer|blastocyst|ovarian stimulation|\bicsi\b|frozen embryo/i },
  { canonical: "Reproductive Endocrinology", match: /reproductive endocrinolog|\brei\b|reproductive medicine|endocrine disorder/i },
  // The bare-word alternative is anchored: an unanchored /infertility/ would
  // also fire on "Male Factor Infertility" and tag every such doctor twice.
  { canonical: "Infertility Evaluation & Treatment", match: /infertility (evaluation|treatment|care|diagnos|management)|unexplained infertility|fertility (evaluation|testing|treatment|workup)|\biui\b|intrauterine insemination|ovulation induction|^\s*(?:in)?fertility\s*$/i },
  { canonical: "Ovulation Disorders", match: /ovulat(ory|ion) (disorder|dysfunction)|anovulat|amenorrhea|irregular (cycle|period)/i },
  { canonical: "Uterine & Fibroid Conditions", match: /uterine (fibroid|anomal|factor|abnormal)|\basherman|adenomyosis|endometrial (receptiv|lining|polyp)|polyp/i },
  { canonical: "Secondary Infertility", match: /secondary infertility/i },
  { canonical: "Advanced Maternal Age", match: /advanced (maternal|reproductive) age|age[\s-]related (fertility|infertility)|fertility over 40/i },
  { canonical: "Reproductive Immunology", match: /reproductive immunolog|immunolog(ic|y) (factor|cause)|autoimmun/i },
  { canonical: "Menopause & Hormone Health", match: /menopaus|perimenopaus|hormone (replacement|therapy|imbalance)|\bhrt\b|thyroid/i },
  { canonical: "Single Parents by Choice", match: /single (parent|mother|father|woman|women) by choice|solo (parent|mother)/i },
  { canonical: "Transgender Family Building", match: /transgender|gender[\s-]affirming|non[\s-]?binary/i },
  { canonical: "Obstetrics & Gynecology", match: /obstetric|\bob[\s\/-]?gyn\b|gynecolog|general women'?s health|well[\s-]woman/i },
];

export function curateSpecialties(raw: string[]): string[] {
  const out: string[] = [];
  for (const s of raw || []) {
    const rule = SPECIALTY_RULES.find((r) => r.match.test(s));
    if (rule && !out.includes(rule.canonical)) out.push(rule.canonical);
  }
  return out;
}

// Languages are the one profile field no registry carries - NPPES and ABOG have
// nothing, so prose extraction was the only source and it found 16 doctors in
// 1,453. Clinic pages almost always DO state languages, just as a headed field
// ("Languages Spoken: English, Spanish") that reads as a list, not a sentence -
// exactly the shape a bio summariser drops and an LLM prose-reader overlooks.
// This runs deterministically over the raw page text and costs nothing.
const KNOWN_LANGUAGES = [
  "English", "Spanish", "Mandarin", "Cantonese", "Chinese", "French", "German", "Italian",
  "Portuguese", "Russian", "Arabic", "Hebrew", "Hindi", "Urdu", "Punjabi", "Gujarati",
  "Bengali", "Tamil", "Telugu", "Marathi", "Malayalam", "Kannada", "Korean", "Japanese",
  "Vietnamese", "Thai", "Tagalog", "Filipino", "Polish", "Ukrainian", "Romanian", "Greek",
  "Turkish", "Persian", "Armenian", "Georgian", "Dutch", "Swedish", "Norwegian",
  "Danish", "Finnish", "Hungarian", "Czech", "Slovak", "Serbian", "Croatian", "Bosnian",
  "Bulgarian", "Albanian", "Lithuanian", "Latvian", "Estonian", "Amharic", "Somali",
  "Swahili", "Yoruba", "Igbo", "Nepali", "Sinhala", "Burmese", "Khmer", "Lao", "Indonesian",
  "Malay", "Creole", "Haitian Creole", "Yiddish", "Ladino", "Afrikaans", "Catalan", "Basque",
  "Sign Language", "American Sign Language",
];
// Native-name and adjective spellings that appear on clinic pages.
const LANGUAGE_ALIASES: Record<string, string> = {
  espanol: "Spanish", español: "Spanish", castellano: "Spanish", francais: "French",
  français: "French", deutsch: "German", italiano: "Italian", portugues: "Portuguese",
  português: "Portuguese", "mandarin chinese": "Mandarin", putonghua: "Mandarin",
  farsi: "Persian", asl: "American Sign Language", filipino: "Tagalog",
  hokkien: "Fukien", taiwanese: "Taiwanese", "brazilian portuguese": "Portuguese",
  "simplified chinese": "Mandarin", "traditional chinese": "Cantonese",
};

// Qualifiers clinics and the model attach to a language ("Medical Spanish",
// "conversational French"). The qualifier is not part of the language's name.
const LANGUAGE_QUALIFIER = /^(?:medical|conversational|basic|working|fluent|native|business|some)\s+/i;

/**
 * Canonicalize and dedupe a language list.
 *
 * Applied to BOTH sources. The deterministic extractor already canonicalizes,
 * but the model returns whatever the page said, so unioning them raw stored
 * "Farsi" next to "Persian" and "Deutsch" next to "German" - the same language
 * listed twice on one profile. Unrecognized entries are kept rather than
 * dropped: "Taiwanese" and "Fukien" are real answers we should not silently
 * discard just because they are not in the known list.
 */
export function canonicalizeLanguages(list: string[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list || []) {
    if (typeof raw !== "string") continue;
    let t = raw.trim().replace(/[.,;:]+$/, "").replace(LANGUAGE_QUALIFIER, "").trim();
    if (t.length < 2 || t.length > 30) continue;
    const lower = t.toLowerCase();
    const canonical =
      LANGUAGE_ALIASES[lower] || KNOWN_LANGUAGES.find((l) => l.toLowerCase() === lower) || null;
    const value = canonical || t.replace(/\b\w/g, (c) => c.toUpperCase());
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function extractLanguagesFromText(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  const canonical = (raw: string): string | null => {
    const t = raw.trim().toLowerCase().replace(/[.,;:)\]]+$/, "");
    if (!t) return null;
    if (LANGUAGE_ALIASES[t]) return LANGUAGE_ALIASES[t];
    const hit = KNOWN_LANGUAGES.find((l) => l.toLowerCase() === t);
    return hit || null;
  };

  // 1. Headed field: "Languages: English, Spanish", "Languages Spoken - ...",
  //    the newline-list variant, and the run-on variant where the next label
  //    follows immediately ("Languages Spoken: English Practice Started: ...").
  //
  //    Splitting the captured run on punctuation does NOT handle that last case:
  //    "English Practice Started" has no separator, so it stays one token and the
  //    language is lost. Instead take a window, cut it at the next "Label:" or
  //    blank line, then scan the window for known language names by word
  //    boundary - order- and separator-independent.
  //    Do NOT try to cut the window at "the next capitalised label" - language
  //    names are themselves capitalised, so "English Practice Started:" looks
  //    exactly like a label and the split swallows the answer. Scan the window
  //    for known language names instead; word-boundary matching means "Germany"
  //    does not read as "German".
  //
  //    The header must carry either an explicit separator or the word "spoken".
  //    Bare "Language" with neither is site chrome - "Back Language Search" on a
  //    page with a language picker - and matching it would attribute the site's
  //    UI languages to the doctor.
  const HEADERS = [
    /\blanguages?\s+spoken(?:\s+fluently)?\b\s*[:\-–]?\s*([\s\S]{0,140})/gi,
    /\b(?:languages?|speaks?|idiomas)\b\s*[:\-–]\s*([\s\S]{0,140})/gi,
  ];
  const LOOKUP = [...KNOWN_LANGUAGES, ...Object.keys(LANGUAGE_ALIASES)];
  // A site language PICKER also reads as "Languages: ...". Two things give it
  // away, and both must be rejected or every doctor at the clinic inherits the
  // site's UI languages (observed: "Languages: 中文 עברית Pусский Español" in a
  // footer next to the social icons and copyright line).
  //
  //  - Non-Latin script in the value. A picker writes each language in its own
  //    script; a doctor's profile field writes them in English ("Chinese",
  //    "Hebrew"), and every name we match is Latin-script, so a legitimate value
  //    never needs these characters.
  //  - Footer furniture immediately around the value.
  const PICKER_SCRIPT = /[Ѐ-ӿ֐-׿؀-ۿ　-鿿가-힯]/;
  const FOOTER_MARKER = /\b(?:copyright|all rights reserved|privacy|terms|phone\s*:|fax\s*:|©)/i;

  for (const header of HEADERS) {
    for (const m of text.matchAll(header)) {
      const segment = m[1];
      if (!segment) continue;
      if (PICKER_SCRIPT.test(segment) || FOOTER_MARKER.test(segment)) continue;
      for (const name of LOOKUP) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`(?:^|[^A-Za-z])${escaped}(?:[^A-Za-z]|$)`, "i").test(segment)) {
          const c = canonical(name);
          if (c) found.add(c);
        }
      }
    }
  }

  // 2. Prose: "fluent in Spanish and Portuguese", "bilingual in English and Hebrew".
  const prose = text.matchAll(
    /\b(?:fluent|fluency|bilingual|trilingual|conversant|proficient|native speaker)\b[^.]{0,80}/gi,
  );
  for (const m of prose) {
    for (const part of m[0].split(/[,;/&]|\band\b|\bin\b/i)) {
      const c = canonical(part);
      if (c) found.add(c);
    }
  }

  // 3. "Se habla español" is deliberately NOT matched. It reads like a language
  //    signal but it is a CLINIC-level banner that lives in site chrome - it was
  //    observed in a nav strip ("Recommended Resources Se Habla Espanol
  //    Locations Our Locations"), which means it appears on every doctor's page
  //    at that clinic and would tag all of them as Spanish speakers. Same
  //    attribution failure as harvesting the roster block: a whole-site fact
  //    silently becomes a per-person claim. Clinic-level language support
  //    belongs on the clinic, not on the doctor.

  // A page that lists every language on earth is a site-wide selector, not a
  // doctor attribute - reject rather than write junk onto the profile.
  if (found.size > 8) return [];
  return [...found];
}

/**
 * Pull the medical school out of an already-extracted education[] list.
 * Entries are written as "Medical School - <institution>" by the bio extractor,
 * so this is a parse of data we hold, not a new lookup - which is why it is
 * preferred over CMS: the CMS National Downloadable File covers only Medicare-
 * billing clinicians (~12% of our doctors, since REIs rarely bill Medicare) and
 * codes most schools as the literal string "OTHER".
 *
 * Residency and fellowship lines are deliberately NOT accepted as a fallback:
 * showing a fellowship hospital under "Medical school" is wrong, not partial.
 */
export function medicalSchoolFromEducation(education: string[] | null | undefined): string | null {
  for (const entry of education || []) {
    if (typeof entry !== "string") continue;
    const m = entry.match(/^\s*(?:medical|med)\s*school\s*[-–—:]\s*(.+)$/i);
    if (!m) continue;
    const school = m[1]
      .replace(/\s*\(\s*\d{4}\s*\)\s*$/, "") // trailing "(2003)"
      .replace(/[.,;\s]+$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (school.length >= 4) return school;
  }
  return null;
}

export async function extractDoctorFieldsFromBio(
  genAI: GoogleGenerativeAI,
  name: string,
  bio: string,
): Promise<BioFields | null> {
  if (!bio || bio.trim().length < 60) return null;
  const model = genAI.getGenerativeModel({
    model: "gemini-3.5-flash",
    generationConfig: { temperature: 0, maxOutputTokens: 8192, responseMimeType: "application/json" } as any,
  });
  const prompt = `You are extracting structured facts about a fertility doctor from the text of their professional profile. Extract ONLY facts explicitly stated. Do NOT infer, guess, or add anything not literally present. Empty array / null if not stated.

The text may be a short bio OR the raw text of the doctor's profile page. Raw pages carry headed sections - "Education", "Education and Experience", "Training", "Languages", "Board Certification", "Memberships", "Areas of Expertise" - often as terse lists rather than sentences. Read those sections: they are usually where education and languages actually live. Raw pages also carry site navigation, appointment CTAs, address blocks and cookie notices; ignore those, and never attribute another person's details to this doctor.

Doctor name: ${name}
Profile text:
"""${bio}"""

Return STRICT JSON: {
  "specialties": string[],          // clinical focus areas mentioned, Title Case (e.g. "Male Factor Infertility","LGBTQ+ Family Building","PCOS","Recurrent Pregnancy Loss","Egg Freezing","Fertility Preservation","Advanced Maternal Age","Endometriosis","Diminished Ovarian Reserve","Social Infertility")
  "languagesSpoken": string[],
  "boardCertifications": string[],
  "education": string[],            // "Medical School - <inst>","Residency - <inst>","Fellowship - <inst>"
  "professionalMemberships": string[],
  "yearsExperience": number,        // integer only if explicitly stated, else null
  "graduationYear": number,         // 4-digit year they graduated MEDICAL SCHOOL (not residency, fellowship, college or any other degree). Only if the text ties a year to medical school / the MD; else null
  "providerGender": string          // "Male"/"Female" only if clear he/him or she/her pronouns, else null
}
Return ONLY the JSON object.`;
  let text: string;
  try {
    const result = await model.generateContent(prompt);
    trackGemini("doctor-data", "gemini-3.5-flash", result);
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
    // Range-check hard: bios are full of stray 4-digit numbers (founding years,
    // publication dates, addresses) and a wrong graduation year silently ages a
    // doctor by decades wherever it is shown.
    const gradRaw = typeof o.graduationYear === "number" ? Math.round(o.graduationYear) : null;
    const thisYear = new Date().getUTCFullYear();
    const grad = gradRaw != null && gradRaw >= 1940 && gradRaw <= thisYear ? gradRaw : null;
    return {
      specialties: curateSpecialties(arr(o.specialties)),
      languagesSpoken: arr(o.languagesSpoken),
      boardCertifications: arr(o.boardCertifications),
      education: arr(o.education),
      professionalMemberships: arr(o.professionalMemberships),
      yearsExperience: yrs,
      graduationYear: grad,
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
  // Verbatim profile-page text. Preferred over `bio` for extraction: `bio` is a
  // display summary, and summarising is what drops education and languages.
  bioRaw?: string | null;
  // Education already stored for this member. Lets medicalSchool be derived on a
  // re-run that resolves no new bio fields (the backfill case).
  existingEducation?: string[] | null;
  city: string | null;
  state: string | null;
  existingSources: Record<string, string> | null | undefined;
  genAI: GoogleGenerativeAI;
  only?: ("nppes" | "abog" | "bio")[]; // restrict to specific sources; default = all
}): Promise<{ data: Record<string, any>; sources: Record<string, string> }> {
  const wants = (s: "nppes" | "abog" | "bio") => !opts.only || opts.only.includes(s);
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
    if (wants("nppes")) {
      const npi = await resolveDoctorNpi(parsed.first, parsed.last, opts.state, opts.city);
      if (npi) {
        set("npiNumber", npi.npi, "nppes");
        set("credential", npi.credential, "nppes");
        set("npiTaxonomy", npi.taxonomy, "nppes");
        set("providerGender", npi.gender, "nppes");
        set("licenseState", npi.licenseState, "nppes");
      }
    }
    // ABOG (authoritative board certification)
    if (wants("abog")) {
      const abog = await lookupAbog(parsed.last, opts.state, opts.city);
      if (abog) {
        set("boardCertifications", abog.boardCertifications, "abog");
        certYear = abog.certStartYear;
      }
    }
  }

  // Bio (supplement: focus areas, languages, education, + fallbacks).
  // Read the verbatim page text when we captured one - it carries the headed
  // Education / Languages sections that a display bio has already thrown away.
  const extractionText = (opts.bioRaw && opts.bioRaw.trim().length >= 200 ? opts.bioRaw : opts.bio) || null;
  const bioFields =
    wants("bio") && extractionText ? await extractDoctorFieldsFromBio(opts.genAI, opts.name, extractionText) : null;

  // Deterministic language pass over the same text, unioned with the model's.
  // Headed "Languages: ..." lists are reliably parseable and reliably missed by
  // prose reading, so neither source alone is sufficient. Runs even when the
  // model returned nothing at all.
  const deterministicLangs = wants("bio") && extractionText ? extractLanguagesFromText(extractionText) : [];
  // Canonicalize the UNION, not each half - otherwise the model's "Farsi" and
  // the extractor's "Persian" both survive as separate entries.
  const observedLanguages = canonicalizeLanguages([...(bioFields?.languagesSpoken || []), ...deterministicLangs]);
  // Every doctor practising in the US speaks English, so a page that never says
  // so leaves a cell that reads as broken rather than as a fact. Add it.
  // Provenance records whether anything was OBSERVED: "default" when English is
  // the only entry and we assumed it, "bio" when a page actually told us
  // something. Without that split, filling English everywhere would make
  // coverage read ~100% and erase the ability to see the real gap.
  const allLanguages = withDefaultEnglish(observedLanguages, opts.state);
  if (allLanguages.length > 0) {
    const src: FieldSource = observedLanguages.length === 0 ? "default" : "bio";
    // Never downgrade a previously OBSERVED list to the assumed default just
    // because this run found nothing - a moved page or a failed fetch would
    // otherwise quietly replace ["Spanish","Portuguese"] with ["English"].
    const wouldDowngrade = src === "default" && sources["languagesSpoken"] === "bio";
    if (!wouldDowngrade) set("languagesSpoken", allLanguages, src);
  }

  if (bioFields) {
    set("specialties", bioFields.specialties, "bio");
    set("education", bioFields.education, "bio");
    set("professionalMemberships", bioFields.professionalMemberships, "bio");
    // fill these only if a higher-confidence source didn't already
    if (sources["boardCertifications"] !== "abog") set("boardCertifications", bioFields.boardCertifications, "bio");
    if (sources["providerGender"] !== "nppes") set("providerGender", bioFields.providerGender, "bio");
    set("yearsExperience", bioFields.yearsExperience, "bio");
    set("graduationYear", bioFields.graduationYear, "bio");
  }

  // medicalSchool is a scalar view of a fact education[] already holds. Deriving
  // it costs nothing and keeps the two consistent by construction; the doctor
  // profile page and the comparison table both read the scalar, so without this
  // they render blank for doctors whose school we are already displaying in the
  // education list two rows below.
  const educationForSchool = bioFields?.education ?? opts.existingEducation ?? [];
  set("medicalSchool", medicalSchoolFromEducation(educationForSchool), "bio");

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
