import { GoogleGenerativeAI } from "@google/generative-ai";
import { createHash } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { scrapeProviderWebsite, getRootDomain, normalizeHostname } from "./scrape.service";
import { buildDoctorEnrichment } from "./doctor-data";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err: any): boolean {
  const message = (err.message || "").toLowerCase();
  const status = err.status || err.statusCode || 0;
  if (status === 429 || status === 503 || status === 500 || status === 504 || status === 408) return true;
  if (/rate.limit|too many requests|quota|resource.exhausted/i.test(message)) return true;
  if (/econnreset|etimedout|enotfound|socket hang up|fetch failed|network|timed out|abort|deadline|connection.fail|connection.reset|connection.refused|ECONNREFUSED/i.test(message)) return true;
  if (/no url found|invalid url format|invalid or parked|url verification failed|failed-relevance/i.test(message)) return true;
  return false;
}

interface VerifyResult {
  valid: boolean;
  reason: string;
}

const DOMAIN_FERTILITY_KEYWORDS = [
  "fertility", "fertile", "ivf", "reproductive", "repro", "surrogacy", "surrogate",
  "eggdonor", "spermbank", "embryo", "obgyn", "gynecol", "obstetric", "pregnan",
  "conceive", "conception", "newborn", "maternal", "neonatal",
];

function domainHasFertilityKeyword(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return DOMAIN_FERTILITY_KEYWORDS.some(kw => hostname.includes(kw));
  } catch {
    return false;
  }
}

function domainContainsClinicNameWords(url: string, clinicName: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/\.(com|org|net|health|med|clinic|center)$/i, "");
    const nameWords = normalizeName(clinicName).split(" ").filter(w => w.length >= 3);
    const significantWords = nameWords.filter(w => !["the", "and", "for", "center", "clinic", "institute", "associates", "group", "practice", "medical"].includes(w));
    if (significantWords.length === 0) return false;
    const matchCount = significantWords.filter(w => hostname.includes(w)).length;
    return matchCount >= Math.min(2, significantWords.length);
  } catch {
    return false;
  }
}

function rootDomainOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/`;
  } catch {
    return null;
  }
}

async function normalizeToRootIfPossible(url: string, clinicName: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  // Already at root (path is "/" or empty) - nothing to do.
  if (parsed.pathname === "/" || parsed.pathname === "") return url;

  const rootUrl = `${parsed.protocol}//${parsed.hostname}/`;
  if (rootUrl === url) return url;

  const rootVerify = await verifyClinicUrl(rootUrl, clinicName);
  if (rootVerify.valid) {
    console.log(`[clinic-enrichment] Normalized "${url}" -> root "${rootUrl}" (${rootVerify.reason})`);
    return rootUrl;
  }
  console.log(`[clinic-enrichment] Kept deep link "${url}" - root rejected (${rootVerify.reason})`);
  return url;
}

export async function verifyClinicUrl(url: string, clinicName: string): Promise<VerifyResult> {
  const domainRelevant = domainHasFertilityKeyword(url) || domainContainsClinicNameWords(url, clinicName);

  if (domainRelevant) {
    console.log(`[clinic-enrichment] verifyClinicUrl: "${url}" accepted - domain name matches fertility/clinic keywords`);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Platform": '"macOS"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!response.ok) {
      // 404/410 are HARD rejects regardless of domain - a dead page can't be scraped.
      if (response.status === 404 || response.status === 410) {
        console.log(`[clinic-enrichment] verifyClinicUrl: "${url}" HTTP ${response.status} - rejecting (dead page)`);
        return { valid: false, reason: `HTTP ${response.status} (dead page)` };
      }
      if (domainRelevant) {
        console.log(`[clinic-enrichment] verifyClinicUrl: "${url}" HTTP ${response.status} but domain is relevant - accepting`);
        return { valid: true, reason: "domain-relevant-despite-http-error" };
      }
      return { valid: false, reason: `HTTP ${response.status}` };
    }

    const text = (await response.text()).toLowerCase();

    const squatterPhrases = [
      "domain is for sale",
      "buy this domain",
      "this domain may be for sale",
      "parked free",
      "hugedomains",
    ];
    for (const phrase of squatterPhrases) {
      if (text.includes(phrase)) {
        console.log(`[clinic-enrichment] verifyClinicUrl: "${url}" flagged as parked/squatter (matched "${phrase}")`);
        return { valid: false, reason: `parked/squatter domain (matched "${phrase}")` };
      }
    }

    if (domainRelevant) {
      return { valid: true, reason: "domain-relevant" };
    }

    const contentRelevant = /\b(fertility|ivf|reproductive|infertility|surrogacy|surrogate|egg donor|egg donation|sperm bank|sperm donor|egg bank|donor|agency|family building|third party reproduction|family|gynecology|obgyn|obstetrics|women'?s health|pregnancy)\b/i.test(text);

    if (contentRelevant) {
      return { valid: true, reason: "content-relevant" };
    }

    if (text.includes(clinicName.toLowerCase())) {
      return { valid: true, reason: "clinic-name-in-content" };
    }

    const nameWords = normalizeName(clinicName).split(" ").filter(w => w.length >= 3);
    const significantNameWords = nameWords.filter(w => !["the", "and", "for", "center", "clinic", "institute", "associates", "group", "practice", "medical"].includes(w));
    const nameWordMatches = significantNameWords.filter(w => text.includes(w)).length;
    if (significantNameWords.length > 0 && nameWordMatches >= Math.min(2, significantNameWords.length)) {
      return { valid: true, reason: "clinic-name-words-in-content" };
    }

    const strippedText = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (strippedText.length < 500) {
      console.log(`[clinic-enrichment] verifyClinicUrl: "${url}" has minimal content (${strippedText.length} chars) - likely SPA, accepting`);
      return { valid: true, reason: "minimal-content-spa" };
    }

    console.log(`[clinic-enrichment] verifyClinicUrl: "${url}" failed relevance check for "${clinicName}" (${strippedText.length} chars, ${nameWordMatches}/${significantNameWords.length} name words matched)`);
    return { valid: false, reason: "failed-relevance-check" };
  } catch (err: any) {
    const errMsg = String(err?.cause?.code || err?.cause?.message || err.message || "");
    if (errMsg.includes("ENOTFOUND") || errMsg.includes("ENODATA") || errMsg.includes("getaddrinfo")) {
      console.log(`[clinic-enrichment] verifyClinicUrl: DNS resolution failed for "${url}" - domain does not exist`);
      return { valid: false, reason: "dns-resolution-failed" };
    }
    if (domainRelevant) {
      console.log(`[clinic-enrichment] verifyClinicUrl: fetch error for "${url}": ${err.message} - accepting (domain is relevant)`);
      return { valid: true, reason: "domain-relevant-despite-fetch-error" };
    }
    console.log(`[clinic-enrichment] verifyClinicUrl: fetch error for "${url}": ${err.message} - accepting URL (cannot verify from this network)`);
    return { valid: true, reason: "fetch-error-accepted" };
  }
}

export interface SartMember {
  name: string;
  title: string | null;
  bio: string | null;
  isMedicalDirector: boolean;
}

interface SartResult {
  websiteUrl: string | null;
  phone: string | null;
  email: string | null;
  members: SartMember[];
}

function normalizeName(name: string): string {
  return name
    .replace(/^\s*(?:Dr|Doctor)\b\.?\s*/i, "") // strip leading "Dr."/"Doctor" so "Dr. X" and "X" match
    .replace(/,?\s*(LLC|Inc\.?|PC|PA|SC|LTD|LLP|Corporation|Corp\.?|PLLC|dba\b.*)/gi, "")
    .replace(/,?\s*(MD|DO|PhD|FACOG|FACS|MBA|MSc|RN|NP)\b/gi, "")
    .replace(/[.,'"]/g, "")
    .replace(/[\-–]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Doctor profile identity: slug is the URL key, personKey links the same human
// across clinics. Mirrors scripts/backfill-doctor-slugs.ts so re-enrichment
// produces the same keys the backfill did.
function slugifyName(name: string): string {
  return normalizeName(name)
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function personKeyOf(name: string): string {
  return createHash("sha1").update(normalizeName(name)).digest("hex").slice(0, 16);
}

// Create a ProviderMember with a globally-unique slug + personKey. Enrichment
// deletes+recreates a clinic's members on every run, so without this the
// backfilled slugs would be lost. Retries with a numeric suffix on slug
// collision; falls back to no slug only for pathological (empty/colliding) names.
async function createMemberWithSlug(
  prisma: PrismaService,
  data: {
    providerId: string;
    name: string;
    title: string | null;
    bio: string | null;
    photoUrl: string | null;
    isMedicalDirector: boolean;
    sortOrder: number;
  },
): Promise<void> {
  const base = slugifyName(data.name);
  const personKey = personKeyOf(data.name);
  if (!base) {
    await prisma.providerMember.create({ data: { ...data, personKey } });
    return;
  }
  for (let attempt = 1; attempt <= 100; attempt++) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`;
    try {
      await prisma.providerMember.create({ data: { ...data, slug, personKey } });
      return;
    } catch (e: any) {
      if (e?.code === "P2002") continue; // slug already taken - try next suffix
      throw e;
    }
  }
  await prisma.providerMember.create({ data: { ...data, personKey } });
}

const STATE_ABBREV_TO_FULL: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california",
  co: "colorado", ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia",
  hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa",
  ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland",
  ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri",
  mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey",
  nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio",
  ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina",
  sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont",
  va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming",
  dc: "district of columbia",
};
const STATE_FULL_TO_ABBREV: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_ABBREV_TO_FULL).map(([k, v]) => [v, k])
);

/**
 * Parse the lab's geographic region from a CDC clinic name.
 *
 * CDC ships one row per lab; multi-lab networks like Boston IVF appear as
 * separate rows ("Boston IVF - The NH Center", "Boston IVF, The Albany Center")
 * with the lab's city or state embedded in the name. We extract it so we can
 * scope satellite offices and doctors to the correct lab.
 *
 * Returns { city, stateAbbrev } where at most one is non-null.
 */
export function parseLabRegionFromName(clinicName: string): { city: string | null; stateAbbrev: string | null } {
  // Strip legal suffixes BEFORE pattern matching, otherwise the
  // "[-,]\s*(the)?\s*<region>\s*center" pattern greedily captures things
  // like "LLC The Maine" as the region. Example before-fix:
  //   "Boston IVF, LLC The Maine Center" -> region="LLC The Maine" (wrong)
  // After stripping ", LLC" first:
  //   "Boston IVF The Maine Center"     -> region="Maine"           (right)
  const stripped = clinicName
    .replace(/,?\s*(LLC|Inc\.?|PC|PA|SC|LTD|LLP|Corporation|Corp\.?|PLLC)\.?\b/gi, "")
    .replace(/,?\s*(MD|DO|PhD|FACOG|FACS|MBA|MSc|RN|NP)\.?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  // Match patterns like "... - The NH Center", "..., The Albany Center", "... The Maine Center"
  const patterns = [
    /[-–—,]\s*(?:the\s+)?([A-Za-z][A-Za-z .]{1,30}?)\s+(?:fertility\s+(?:center|centre|services)|center|centre|office|branch)\b/i,
    /\b(?:the\s+)([A-Za-z][A-Za-z .]{1,30}?)\s+(?:fertility\s+(?:center|centre|services)|center|centre|office|branch)\b/i,
  ];
  let region: string | null = null;
  for (const re of patterns) {
    const m = stripped.match(re);
    if (m) {
      region = m[1].trim();
      break;
    }
  }
  if (!region) return { city: null, stateAbbrev: null };

  // Two-letter state abbreviation (e.g. "NH")?
  if (/^[A-Z]{2}$/.test(region)) {
    return { city: null, stateAbbrev: region.toUpperCase() };
  }
  const lower = region.toLowerCase();
  if (STATE_FULL_TO_ABBREV[lower]) {
    return { city: null, stateAbbrev: STATE_FULL_TO_ABBREV[lower].toUpperCase() };
  }
  // Multi-word like "Long Island" or "New York City": treat as city only if
  // the lowercased form isn't a state name (handled above).
  return { city: region, stateAbbrev: null };
}

function statesMatch(a: string, b: string): boolean {
  const la = a.toLowerCase().trim();
  const lb = b.toLowerCase().trim();
  if (la === lb) return true;
  const aExpanded = STATE_ABBREV_TO_FULL[la];
  const bExpanded = STATE_ABBREV_TO_FULL[lb];
  if (aExpanded && aExpanded === lb) return true;
  if (bExpanded && bExpanded === la) return true;
  if (aExpanded && bExpanded && aExpanded === bExpanded) return true;
  const aAbbrev = STATE_FULL_TO_ABBREV[la];
  const bAbbrev = STATE_FULL_TO_ABBREV[lb];
  if (aAbbrev && aAbbrev === lb) return true;
  if (bAbbrev && bAbbrev === la) return true;
  return false;
}

export async function searchSartForClinic(
  clinicName: string,
  city: string | null,
  state: string | null,
): Promise<SartResult | null> {
  try {
    const normalizedFull = normalizeName(clinicName);
    const normalizedWords = normalizedFull.split(" ");
    const commonFillerWords = ["center", "clinic", "institute", "associates", "group", "practice", "medical", "health", "services", "program"];
    const withoutFillers = normalizedWords.filter(w => !commonFillerWords.includes(w));
    const searchVariants = [
      normalizedFull,
      normalizedWords.slice(0, 4).join(" "),
      ...(normalizedWords.length > 3 ? [normalizedWords.slice(0, 3).join(" ")] : []),
      ...(normalizedWords.length > 2 ? [normalizedWords.slice(0, 2).join(" ")] : []),
      ...(withoutFillers.length >= 2 && withoutFillers.join(" ") !== normalizedFull ? [withoutFillers.join(" ")] : []),
    ];
    const uniqueVariants = [...new Set(searchVariants)];

    let clinics: any[] = [];
    let usedTerm = "";

    for (const searchTerm of uniqueVariants) {
      await sleep(500);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const response = await fetch("https://www.sartcorsonline.com/Membersearch/ClinicSearch", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Origin": "https://www.sartcorsonline.com",
            "Referer": "https://www.sartcorsonline.com/members/ClinicSearch",
          },
          body: JSON.stringify({
            SearchTerm: searchTerm,
            Latitude: 0,
            Longitude: 0,
            MileRadius: 999999,
            SortBy: 0,
            Page: 0,
            PageSize: 10,
          }),
        });

        clearTimeout(timeout);

        if (!response.ok) {
          console.log(`[clinic-enrichment] SART search returned ${response.status} for "${searchTerm}"`);
          continue;
        }

        const data = await response.json();
        if (Array.isArray(data?.Clinics) && data.Clinics.length > 0) {
          clinics = data.Clinics;
          usedTerm = searchTerm;
          console.log(`[clinic-enrichment] SART search for "${searchTerm}": ${clinics.length} result(s) - [${clinics.slice(0, 3).map((c: any) => c.Name).join(", ")}${clinics.length > 3 ? "..." : ""}]`);
          break;
        } else {
          console.log(`[clinic-enrichment] SART search for "${searchTerm}": 0 results`);
        }
      } catch (fetchErr: any) {
        clearTimeout(timeout);
        console.log(`[clinic-enrichment] SART search fetch error for "${searchTerm}": ${fetchErr.message}`);
        continue;
      }
    }

    if (clinics.length === 0) {
      console.log(`[clinic-enrichment] SART: no results for "${clinicName}" (tried: ${uniqueVariants.join(", ")})`);
      return null;
    }

    const normalizedInput = normalizeName(clinicName);
    const inputWords = new Set(normalizedInput.split(" ").filter(w => w.length >= 3));

    let bestMatch: any = null;
    let bestScore = 0;

    for (const clinic of clinics) {
      const normalizedClinic = normalizeName(clinic.Name || "");
      const clinicWords = new Set(normalizedClinic.split(" ").filter((w: string) => w.length >= 3));

      let matchingWords = 0;
      for (const word of inputWords) {
        if (clinicWords.has(word)) matchingWords++;
      }

      const score = inputWords.size > 0 ? matchingWords / inputWords.size : 0;

      if (state && clinic.State && !statesMatch(state, clinic.State)) {
        continue;
      }
      if (city && clinic.City) {
        const cityMatch = clinic.City.toLowerCase() === city.toLowerCase();
        if (score >= 0.3 || (score >= 0.2 && cityMatch)) {
          const adjustedScore = cityMatch ? score + 0.2 : score;
          if (adjustedScore > bestScore) {
            bestScore = adjustedScore;
            bestMatch = clinic;
          }
        }
      } else if (score >= 0.4) {
        if (score > bestScore) {
          bestScore = score;
          bestMatch = clinic;
        }
      }
    }

    if (!bestMatch) {
      if (clinics.length === 1) {
        bestMatch = clinics[0];
        console.log(`[clinic-enrichment] SART: single result "${bestMatch.Name}", using as match for "${clinicName}"`);
      } else {
        console.log(`[clinic-enrichment] SART: no confident match among ${clinics.length} results for "${clinicName}" (best score: ${bestScore.toFixed(2)})`);
        return null;
      }
    } else {
      console.log(`[clinic-enrichment] SART: matched "${bestMatch.Name}" (score: ${bestScore.toFixed(2)}) for "${clinicName}"`);
    }

    let websiteUrl: string | null = bestMatch.Website || null;
    if (websiteUrl && !websiteUrl.startsWith("http")) {
      websiteUrl = "https://" + websiteUrl;
    }

    const phone: string | null = bestMatch.Phone || null;
    const email: string | null = bestMatch.Email || null;

    const members: SartMember[] = Array.isArray(bestMatch.Members)
      ? bestMatch.Members.map((m: any) => ({
          name: (m.NameFirstLast || m.FullName || "").replace(/,?\s*(MD|DO|PhD|FACOG|FACS|MBA|MSc|RN|NP|PA|HCLD|TS|ELD)\b/gi, "").replace(/[,]+$/, "").trim(),
          title: m.Title || m.Role || null,
          bio: m.Bio && m.Bio.trim().length > 5 ? m.Bio.trim() : null,
          isMedicalDirector: /medical director/i.test(m.Role || "") || /medical director/i.test(m.Title || ""),
        })).filter((m: SartMember) => m.name.length >= 3)
      : [];

    if (members.length > 0) {
      console.log(`[clinic-enrichment] SART: collected ${members.length} staff members for "${clinicName}"`);
    }

    return { websiteUrl, phone, email, members };
  } catch (err: any) {
    console.log(`[clinic-enrichment] SART search error for "${clinicName}": ${err.message}`);
    return null;
  }
}

async function findClinicWebsite(
  clinicName: string,
  city: string | null,
  state: string | null,
): Promise<{ url: string | null; sartPhone: string | null; sartEmail: string | null; sartMembers: SartMember[] }> {
  const sartResult = await searchSartForClinic(clinicName, city, state);
  const sartMembers = sartResult?.members || [];

  if (sartResult?.websiteUrl) {
    console.log(`[clinic-enrichment] SART provided website for "${clinicName}": ${sartResult.websiteUrl}`);
    // SART's directory occasionally lists deep links or truncated URLs (e.g.
    // bostonivf.com/locations/the-brookline-). Run them through the same
    // verify + root-normalize chain we apply to Gemini URLs so admins get the
    // root domain that the scraper can actually traverse.
    const sartVerify = await verifyClinicUrl(sartResult.websiteUrl, clinicName);
    if (sartVerify.valid) {
      const normalizedSartUrl = await normalizeToRootIfPossible(sartResult.websiteUrl, clinicName);
      return { url: normalizedSartUrl, sartPhone: sartResult.phone, sartEmail: sartResult.email, sartMembers };
    }
    console.log(`[clinic-enrichment] SART URL rejected for "${clinicName}" (${sartVerify.reason}), falling back to Gemini search...`);
  } else {
    console.log(`[clinic-enrichment] SART miss for "${clinicName}", falling back to Gemini search...`);
  }

  const nameParts = clinicName.includes(",")
    ? clinicName.split(",").map(p => p.trim().replace(/\.+$/, "")).filter(p => p.length >= 3 && !/^(LLC|Inc|PC|PA|SC|LTD|LLP|Corp|Corporation|PLLC|MD|DO|PhD|FACOG|FACS|MBA|MSc|RN|NP)\.?$/i.test(p))
    : [];

  const cleanedName = clinicName
    .replace(/,?\s*(LLC|Inc\.?|PC|PA|SC|LTD|LLP|Corporation|Corp\.?|PLLC)\.?\b/gi, "")
    .replace(/,?\s*(MD|DO|PhD|FACOG|FACS|MBA|MSc|RN|NP)\.?\b/gi, "")
    .replace(/[,.\s]+$/, "")
    .trim();
  const useCleanedFirst = cleanedName.length >= 3 && cleanedName.toLowerCase() !== clinicName.toLowerCase();

  const searchNames = useCleanedFirst
    ? [cleanedName, ...nameParts.filter(p => p.toLowerCase() !== cleanedName.toLowerCase()), clinicName]
    : [clinicName, ...nameParts];

  const url = await geminiWebsiteSearch(searchNames, city, state, clinicName);
  if (url) {
    return { url, sartPhone: sartResult?.phone || null, sartEmail: sartResult?.email || null, sartMembers };
  }

  console.log(`[clinic-enrichment] Normal search failed for "${clinicName}", trying acquisition/merger search...`);
  const acquisitionUrl = await geminiAcquisitionSearch(clinicName, city, state);
  if (acquisitionUrl) {
    console.log(`[clinic-enrichment] Acquisition detected: "${clinicName}" now at ${acquisitionUrl}`);
  }
  return { url: acquisitionUrl, sartPhone: sartResult?.phone || null, sartEmail: sartResult?.email || null, sartMembers };
}

async function geminiAcquisitionSearch(
  clinicName: string,
  city: string | null,
  state: string | null,
): Promise<string | null> {
  const MAX_RETRIES = 2;
  const BASE_DELAY_MS = 2000;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { temperature: 0 } as any,
    tools: [{ googleSearch: {} } as any],
  });

  const locationPart = [city, state].filter(Boolean).join(", ");

  const prompt = `The fertility clinic "${clinicName}"${locationPart ? ` located in ${locationPart}` : ""} appears to no longer operate independently. It may have been acquired by, merged with, or transitioned its services to another fertility practice.

SEARCH INSTRUCTIONS:
1. Search for "${clinicName}" acquisition, merger, or transition announcements.
2. If this clinic was acquired or merged, find the specific location page of the acquiring/new fertility practice that now serves this clinic's patients${locationPart ? ` in or near ${locationPart}` : ""}.
3. Look for the specific location/center page, NOT the main homepage of the acquiring practice.

OUTPUT FORMAT:
Return ONLY the specific location page URL. Do not include any other words. NEVER return aggregator sites (Yelp, Healthgrades, FertilityIQ, WebMD, Facebook, Vitals, Doximity). If you cannot determine an acquisition or find the new location page, return exactly "null".`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let timeoutId: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([
        model.generateContent(prompt),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("Gemini request timed out after 30s")), 30000);
        }),
      ]);
      clearTimeout(timeoutId!);
      let text = result.response.text().trim();

      console.log(`[clinic-enrichment] Gemini acquisition raw response for "${clinicName}": "${text.substring(0, 200)}"`);

      if (/^null$/i.test(text)) return null;

      const urlMatch = text.match(/(?:https?:\/\/|www\.)[^\s"'<>]+/);
      if (urlMatch) {
        let url = urlMatch[0].replace(/[.,;:!?)}\]]+$/, "");
        if (url.startsWith("www.")) url = "https://" + url;
        try {
          new URL(url);
        } catch {
          return null;
        }

        const verifyResult = await verifyClinicUrl(url, clinicName);
        if (!verifyResult.valid) {
          console.log(`[clinic-enrichment] Acquisition URL rejected by verification: ${url} (${verifyResult.reason})`);
          return null;
        }

        const normalizedUrl = await normalizeToRootIfPossible(url, clinicName);
        return normalizedUrl;
      }
      return null;
    } catch (err: any) {
      clearTimeout(timeoutId!);
      if (isRetryableError(err) && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[clinic-enrichment] Acquisition search attempt ${attempt}/${MAX_RETRIES} failed for "${clinicName}" (${err.message}), retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      console.log(`[clinic-enrichment] Acquisition search failed for "${clinicName}": ${err.message}`);
      return null;
    }
  }
  return null;
}

async function geminiWebsiteSearch(
  searchNames: string[],
  city: string | null,
  state: string | null,
  originalClinicName: string,
): Promise<string | null> {
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 2000;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { temperature: 0 } as any,
    tools: [{ googleSearch: {} } as any],
  });

  const locationPart = [city, state].filter(Boolean).join(", ");

  for (const searchName of searchNames) {
    const prompt = `Find the official website ROOT URL for the fertility clinic: "${searchName}" ${locationPart ? `located in ${locationPart}` : ""}.\n\nINSTRUCTIONS FOR SEARCHING:\n1. The name is from a government database and is messy. You MUST clean it before searching.\n2. Remove legal suffixes: LLC, Inc, PC, PA, SC, LTD, LLP, Corporation.\n3. Remove doctor credentials: MD, DO, FACOG, FACS.\n4. Handle "dba": If the name contains "dba", search ONLY for the name AFTER "dba" (e.g., "X dba Y" -> search for "Y").\n5. Handle commas/acronyms: If there are multiple names (e.g., "F.I.R.S.T., Florida Institute..."), search the distinct parts.\n6. For hospital networks (e.g., AHN, Aurora Health, Brooke Army), return the ROOT DOMAIN of the hospital network's fertility/reproductive medicine sub-site (e.g., "ahn.org" or "ahnfertility.com"), NOT a deep sub-page.\n7. For multi-location networks/franchises (e.g., "Boston IVF - The NH Center" or "RMA Long Island"), return the NETWORK ROOT DOMAIN (e.g., "https://www.bostonivf.com" or "https://www.rmany.com"). DO NOT return a specific location sub-page like "/locations/new-hampshire/bedford-nh-fertility-center" - those URLs often 404 or change. Always prefer the root domain.\n8. Prefer the shortest valid URL: scheme + host only (e.g., "https://www.bostonivf.com/"). Avoid query strings, fragments, and deep paths.\n\nOUTPUT FORMAT:\nReturn ONLY the bare ROOT URL string starting with https:// or www. No paths, no query strings, no other words. NEVER return aggregator sites (Yelp, Healthgrades, FertilityIQ, WebMD, Facebook, Vitals, Doximity). If you absolutely cannot find it, return exactly "null".`;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      let timeoutId: ReturnType<typeof setTimeout>;
      try {
        const result = await Promise.race([
          model.generateContent(prompt),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error("Gemini request timed out after 30s")), 30000);
          }),
        ]);
        clearTimeout(timeoutId!);
        let text = result.response.text().trim();

        console.log(`[clinic-enrichment] Gemini raw response for "${searchName}": "${text.substring(0, 200)}"`);

        text = text
          .replace(/^(?:here\s+is\s+(?:the\s+)?(?:website|url|link)\s*[:=]\s*)/i, "")
          .replace(/^(?:the\s+(?:official\s+)?(?:website|url|link)\s+(?:is|for)\s*[:=]?\s*)/i, "")
          .replace(/^(?:sure[!,.]?\s*)/i, "")
          .replace(/^(?:of course[!,.]?\s*)/i, "")
          .trim();

        const urlMatch = text.match(/(?:https?:\/\/|www\.)[^\s"'<>]+/);
        if (urlMatch) {
          let url = urlMatch[0].replace(/[.,;:!?)}\]]+$/, "");
          if (url.startsWith('www.')) url = 'https://' + url;
          try {
            new URL(url);
          } catch {
            throw new Error("Invalid URL format");
          }

          const verifyResult = await verifyClinicUrl(url, originalClinicName);
          if (!verifyResult.valid) {
            throw new Error(`URL verification failed for ${url}: ${verifyResult.reason}`);
          }

          const normalizedUrl = await normalizeToRootIfPossible(url, originalClinicName);

          if (searchName !== searchNames[0] || attempt > 1) {
            console.log(`[clinic-enrichment] findClinicWebsite succeeded for "${originalClinicName}" using search name "${searchName}" (attempt ${attempt}, verify: ${verifyResult.reason})`);
          }
          return normalizedUrl;
        }
        throw new Error("No URL found in Gemini response");
      } catch (err: any) {
        clearTimeout(timeoutId!);
        if (isRetryableError(err) && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.log(`[clinic-enrichment] findClinicWebsite attempt ${attempt}/${MAX_RETRIES} failed for "${searchName}" (${err.message}), retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        if (searchName !== searchNames[searchNames.length - 1]) {
          console.log(`[clinic-enrichment] findClinicWebsite: "${searchName}" failed (${err.message}), trying next name variant...`);
          break;
        }
        console.log(`[clinic-enrichment] findClinicWebsite error for "${originalClinicName}" after all variants:`, err.message);
        return null;
      }
    }
  }
  return null;
}

// Normalize a person's name to a comparison key (strips credentials, accents,
// punctuation). Shared by mergeTeamMembers and scopeTeamToLab so SART-origin
// matching uses the exact same keying as the merge.
function normalizeMemberKey(name: string): string {
  return name
    .replace(/,?\s*(MD|DO|PhD|MBA|FACOG|MSc|RN|NP|PA|FACS|HCLD|TS|ELD|Jr\.?|Sr\.?|III|II|IV)\b/gi, "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

export function mergeTeamMembers(
  sartMembers: SartMember[],
  scrapedMembers: Array<{ name: string; title: string | null; bio: string | null; photoUrl: string | null; isMedicalDirector: boolean; locationHints: string[] }>,
  providerName: string,
): Array<{ name: string; title: string | null; bio: string | null; photoUrl: string | null; isMedicalDirector: boolean; locationHints: string[] }> {
  const normalizeKey = normalizeMemberKey;

  const mergedMap = new Map<string, { name: string; title: string | null; bio: string | null; photoUrl: string | null; isMedicalDirector: boolean; locationHints: string[]; fromSart: boolean }>();

  for (const sm of sartMembers) {
    const key = normalizeKey(sm.name);
    if (key.length < 4) continue;
    mergedMap.set(key, {
      name: sm.name,
      title: sm.title,
      bio: sm.bio,
      photoUrl: null,
      isMedicalDirector: sm.isMedicalDirector,
      locationHints: [],
      fromSart: true,
    });
  }

  let enrichedFromScraper = 0;
  let newFromScraper = 0;

  for (const scraped of scrapedMembers) {
    const key = normalizeKey(scraped.name);
    if (key.length < 4) continue;

    const existing = mergedMap.get(key);
    if (existing) {
      if (scraped.photoUrl) existing.photoUrl = scraped.photoUrl;
      if (scraped.bio && (!existing.bio || scraped.bio.length > existing.bio.length)) existing.bio = scraped.bio;
      if (scraped.title && (!existing.title || scraped.title.length > existing.title.length)) existing.title = scraped.title;
      if (scraped.isMedicalDirector) existing.isMedicalDirector = true;
      if (scraped.locationHints.length > 0) existing.locationHints = scraped.locationHints;
      if (scraped.name.length > existing.name.length) existing.name = scraped.name;
      existing.fromSart = true;
      enrichedFromScraper++;
    } else {
      mergedMap.set(key, { ...scraped, fromSart: false });
      newFromScraper++;
    }
  }

  const result = Array.from(mergedMap.values());
  const sartOnlyKept = result.filter(m => m.fromSart).length - enrichedFromScraper;
  const finalMembers = result.map(({ fromSart, ...rest }) => rest);

  finalMembers.sort((a, b) => {
    if (a.isMedicalDirector && !b.isMedicalDirector) return -1;
    if (!a.isMedicalDirector && b.isMedicalDirector) return 1;
    return 0;
  });

  console.log(`[clinic-enrichment] Team merge for "${providerName}": ${sartMembers.length} from SART, ${scrapedMembers.length} from scraper → ${finalMembers.length} total (${enrichedFromScraper} enriched by scraper, ${sartOnlyKept > 0 ? sartOnlyKept : 0} SART-only, ${newFromScraper} scraper-only)`);

  return finalMembers;
}

async function persistPhotoToGcs(
  url: string | null | undefined,
  storageService: StorageService | null,
): Promise<string | null> {
  if (!url) return null;
  // Already persisted
  if (url.startsWith("/uploads")) return url;
  if (/storage\.googleapis\.com/i.test(url) && /gostork/i.test(url)) return url;
  if (!storageService?.isConfigured()) return url;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return url;
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length < 200) return url; // too small, probably not a real image
    const ct = resp.headers.get("content-type") || "image/jpeg";
    const ext = ct.includes("png") ? ".png" : ct.includes("webp") ? ".webp" : ct.includes("svg") ? ".svg" : ".jpg";
    const hash = createHash("md5").update(buffer).digest("hex");
    const gcsPath = `profile-photos/${hash}${ext}`;
    return await storageService.uploadBufferPublic(buffer, gcsPath, ct);
  } catch (err: any) {
    console.warn(`[clinic-enrichment] Failed to persist photo ${url}: ${err.message}`);
    return url; // fall back to external URL
  }
}

/**
 * Fetch a clinic logo from logo.dev by domain. Used ONLY as a fallback to fill
 * the logo gap when our HTML scraper couldn't find one (inline SVG / CSS
 * background-image / JS-rendered / CDN-hosted logos it can't see).
 *
 * Key param: fallback=404 - logo.dev returns a generated letter-monogram by
 * default when it has no real logo; fallback=404 makes it return 404 instead,
 * so we only ever persist REAL logos, never placeholder monograms.
 *
 * Returns a GCS URL (persisted) on success, or null if logo.dev has no logo /
 * the request fails. Never throws.
 */
async function fetchLogoDevLogo(
  websiteUrl: string | null | undefined,
  storageService: StorageService | null,
): Promise<string | null> {
  if (!websiteUrl) return null;
  const token = process.env.VITE_LOGODEV_TOKEN;
  if (!token) {
    console.warn("[clinic-enrichment] logo.dev: VITE_LOGODEV_TOKEN not set, skipping");
    return null;
  }

  let domain: string;
  try {
    domain = new URL(websiteUrl).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
  if (!domain) return null;

  const apiUrl = `https://img.logo.dev/${encodeURIComponent(domain)}?token=${token}&format=png&size=256&fallback=404`;
  try {
    const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
    if (resp.status === 404) {
      console.log(`[clinic-enrichment] logo.dev: no logo for ${domain}`);
      return null;
    }
    if (!resp.ok) {
      console.log(`[clinic-enrichment] logo.dev: HTTP ${resp.status} for ${domain}`);
      return null;
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length < 200) return null; // too small to be a real logo

    if (!storageService?.isConfigured()) {
      // No GCS configured - return the stable public logo.dev URL directly.
      return apiUrl;
    }
    const ct = resp.headers.get("content-type") || "image/png";
    const ext = ct.includes("png") ? ".png" : ct.includes("webp") ? ".webp" : ct.includes("svg") ? ".svg" : ct.includes("jpeg") || ct.includes("jpg") ? ".jpg" : ".png";
    const hash = createHash("md5").update(buffer).digest("hex");
    const gcsPath = `clinic-logos/${hash}${ext}`;
    const persisted = await storageService.uploadBufferPublic(buffer, gcsPath, ct);
    console.log(`[clinic-enrichment] logo.dev: filled logo for ${domain}`);
    return persisted;
  } catch (err: any) {
    console.log(`[clinic-enrichment] logo.dev fetch error for ${domain}: ${err.message}`);
    return null;
  }
}

export class ClinicEnrichmentService {
  private activeRunId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService | null = null,
  ) {}

  async enrichClinicProfile(providerId: string): Promise<boolean> {
    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
      include: {
        locations: { orderBy: { sortOrder: "asc" } },
        members: true,
      },
    });

    if (!provider) {
      console.log(`[clinic-enrichment] Provider ${providerId} not found, skipping`);
      return false;
    }

    const firstLocation = provider.locations[0];
    const city = firstLocation?.city || null;
    const state = firstLocation?.state || null;

    console.log(`[clinic-enrichment] Looking up website for "${provider.name}" (${city}, ${state})...`);
    const { url: websiteUrl, sartPhone, sartEmail, sartMembers } = await findClinicWebsite(provider.name, city, state);

    if (!websiteUrl && !sartPhone && !sartEmail && sartMembers.length === 0) {
      console.log(`[clinic-enrichment] Could not find website or SART data for "${provider.name}", skipping`);
      return false;
    }

    let scraped: Awaited<ReturnType<typeof scrapeProviderWebsite>> | null = null;
    if (websiteUrl) {
      console.log(`[clinic-enrichment] Found website: ${websiteUrl} - scraping profile...`);
      try {
        scraped = await scrapeProviderWebsite(websiteUrl, { doctorsOnly: true });
      } catch (scrapeErr: any) {
        console.log(`[clinic-enrichment] Scrape failed for "${provider.name}" (${scrapeErr.message}) - saving SART data only`);
      }
    } else {
      console.log(`[clinic-enrichment] No website for "${provider.name}" - saving SART data only`);
    }

    const updateData: Record<string, any> = {};
    if (websiteUrl) updateData.websiteUrl = websiteUrl;
    if (scraped?.about) updateData.about = scraped.about;
    if (scraped?.phone) updateData.phone = scraped.phone;
    else if (sartPhone) updateData.phone = sartPhone;
    if (scraped?.logoUrl) {
      updateData.logoUrl = await persistPhotoToGcs(scraped.logoUrl, this.storageService);
    } else if (!provider.logoUrl) {
      // Fallback-only: the scraper found no logo and the clinic currently has
      // none. Try logo.dev by domain to fill the gap. Never overwrites an
      // existing logo (guarded by !provider.logoUrl + the scraped-logo branch).
      const logoDevUrl = await fetchLogoDevLogo(websiteUrl || provider.websiteUrl, this.storageService);
      if (logoDevUrl) updateData.logoUrl = logoDevUrl;
    }
    if (scraped?.yearFounded) updateData.yearFounded = scraped.yearFounded;
    if (scraped?.email) updateData.email = scraped.email;
    else if (sartEmail) updateData.email = sartEmail;

    if (Object.keys(updateData).length > 0) {
      await this.prisma.provider.update({
        where: { id: providerId },
        data: updateData,
      });
      console.log(`[clinic-enrichment] Updated provider "${provider.name}" with fields: ${Object.keys(updateData).join(", ")}`);
    }

    const { keptLocations, keptLocationKeys, hasSiblings } = await this.scopeToLab(
      { id: providerId, name: provider.name, websiteUrl: websiteUrl || provider.websiteUrl },
      city,
      state,
      scraped?.locations || [],
    );

    await this.syncLocations(providerId, provider.name, provider.locations, keptLocations, hasSiblings);

    const mergedTeam = mergeTeamMembers(sartMembers, scraped?.teamMembers || [], provider.name);

    // Scope team to this lab's satellites when the network has multiple labs.
    let scopedTeam = this.scopeTeamToLab(mergedTeam, keptLocationKeys, hasSiblings, sartMembers);
    scopedTeam = this.trimToReproductiveSpecialty(scopedTeam, sartMembers);
    if (hasSiblings) {
      console.log(`[clinic-enrichment] Scoped team for "${provider.name}": ${scopedTeam.length}/${mergedTeam.length} kept`);
    }

    if (scopedTeam.length > 0) {
      const snapshot = await this.snapshotEnrichedTeam(providerId);
      await this.prisma.providerMemberLocation.deleteMany({
        where: { member: { providerId } },
      });
      await this.prisma.providerMember.deleteMany({
        where: { providerId },
      });

      for (let i = 0; i < scopedTeam.length; i++) {
        const tm = scopedTeam[i];
        const persistedPhoto = await persistPhotoToGcs(tm.photoUrl, this.storageService);
        await createMemberWithSlug(this.prisma, {
          providerId,
          name: tm.name,
          title: tm.title,
          bio: tm.bio,
          photoUrl: persistedPhoto,
          isMedicalDirector: tm.isMedicalDirector,
          sortOrder: i,
        });
      }
      console.log(`[clinic-enrichment] Refreshed ${scopedTeam.length} team members for "${provider.name}"`);
      await this.enrichTeamDoctorData(providerId, snapshot);
    } else if (mergedTeam.length > 0) {
      // Scrape found a team but scoping attributed none to this lab (network
      // over-keep). Clear the stale roster rather than leaving a wrong one.
      await this.prisma.providerMemberLocation.deleteMany({ where: { member: { providerId } } });
      await this.prisma.providerMember.deleteMany({ where: { providerId } });
      console.log(`[clinic-enrichment] Cleared stale ${mergedTeam.length}-member roster for "${provider.name}" - none attributable to this lab`);
    }

    return true;
  }


  /**
   * Scope scraped locations + team to THIS lab (CDC row) when the website is a
   * shared multi-lab network like bostonivf.com.
   *
   * Returns:
   *   - keptLocations: scraped locations that belong to this lab. A location is kept if:
   *       (a) its city matches this lab's parsed/CDC city, OR
   *       (b) its state matches this lab's state AND no sibling lab has a stronger
   *           city-match claim on it.
   *   - keptLocationKeys: lowercased "city|state" keys for the kept set, used to
   *       filter team members by their locationHints.
   *   - hasSiblings: true if other IVF clinics share the same root domain. When
   *       false the scope is a no-op (single-lab network).
   */
  private async scopeToLab(
    provider: { id: string; name: string; websiteUrl: string | null },
    cdcCity: string | null,
    cdcState: string | null,
    scrapedLocations: Array<{ address: string | null; city: string | null; state: string | null; zip: string | null }>,
  ): Promise<{
    keptLocations: typeof scrapedLocations;
    keptLocationKeys: Set<string>;
    hasSiblings: boolean;
  }> {
    const allKey = (city: string | null, state: string | null) =>
      `${(city || "").trim().toLowerCase()}|${(state || "").trim().toLowerCase()}`;
    const allKeys = new Set(scrapedLocations.map(l => allKey(l.city, l.state)));

    if (!provider.websiteUrl) {
      return { keptLocations: scrapedLocations, keptLocationKeys: allKeys, hasSiblings: false };
    }

    let rootDomain: string;
    try {
      rootDomain = getRootDomain(normalizeHostname(new URL(provider.websiteUrl).hostname));
    } catch {
      return { keptLocations: scrapedLocations, keptLocationKeys: allKeys, hasSiblings: false };
    }
    if (!rootDomain) {
      return { keptLocations: scrapedLocations, keptLocationKeys: allKeys, hasSiblings: false };
    }

    // Find sibling IVF clinics that share this root domain.
    const candidates = await this.prisma.provider.findMany({
      where: {
        id: { not: provider.id },
        services: { some: { providerType: { name: "IVF Clinic" } } },
        websiteUrl: { contains: rootDomain },
      },
      select: {
        id: true,
        name: true,
        websiteUrl: true,
        locations: {
          take: 1,
          orderBy: { sortOrder: "asc" },
          select: { city: true, state: true },
        },
      },
    });

    const siblings = candidates
      .filter(s => {
        if (!s.websiteUrl) return false;
        try {
          return getRootDomain(normalizeHostname(new URL(s.websiteUrl).hostname)) === rootDomain;
        } catch {
          return false;
        }
      })
      .map(s => {
        const parsed = parseLabRegionFromName(s.name);
        const cdcLoc = s.locations[0] || null;
        return {
          name: s.name,
          labCity: (parsed.city || cdcLoc?.city || "").toLowerCase() || null,
          labState: (parsed.stateAbbrev || cdcLoc?.state || "").toUpperCase() || null,
        };
      });

    if (siblings.length === 0) {
      return { keptLocations: scrapedLocations, keptLocationKeys: allKeys, hasSiblings: false };
    }

    const thisParsed = parseLabRegionFromName(provider.name);
    const thisCity = (thisParsed.city || cdcCity || "").toLowerCase() || null;
    const thisState = (thisParsed.stateAbbrev || cdcState || "").toUpperCase() || null;

    console.log(
      `[clinic-enrichment] scopeToLab: "${provider.name}" lab=${thisCity || "?"}/${thisState || "?"}; ` +
      `${siblings.length} siblings on ${rootDomain}: ${siblings.map(s => `${s.labCity || "?"}/${s.labState || "?"}`).join(", ")}`,
    );

    const kept: typeof scrapedLocations = [];
    for (const loc of scrapedLocations) {
      const lCity = (loc.city || "").trim().toLowerCase();
      const lState = (loc.state || "").trim().toUpperCase();

      // Direct city match always wins.
      if (thisCity && lCity && lCity === thisCity) {
        kept.push(loc);
        continue;
      }

      // Same state? Keep unless a different sibling lab claims this city.
      if (thisState && lState && statesMatch(lState, thisState)) {
        const claimedByOther = siblings.some(
          s => s.labCity && lCity && s.labCity === lCity && s.labCity !== thisCity,
        );
        if (!claimedByOther) {
          kept.push(loc);
        }
      }
    }

    const keptKeys = new Set(kept.map(l => allKey(l.city, l.state)));
    console.log(
      `[clinic-enrichment] scopeToLab: "${provider.name}" kept ${kept.length}/${scrapedLocations.length} scraped locations`,
    );
    return { keptLocations: kept, keptLocationKeys: keptKeys, hasSiblings: true };
  }

  /**
   * Scope a merged team roster to a single lab when the website is a shared
   * multi-lab network. Used by both the full and re-sync enrichment paths.
   *
   * The hard part: a doctor can only be attributed to a lab when we have a
   * trustworthy signal. We have two:
   *   1. SART - the SART directory lists doctors keyed to the SPECIFIC clinic
   *      (CDC lab), so SART members are authoritative for THIS lab.
   *   2. locationHints - the scraper maps a scraped doctor to a location page /
   *      bio city. Reliable when present.
   *
   * A previous version kept the ENTIRE scraped roster when no doctor had a hint,
   * which dumped whole network rosters onto one lab (SGF Houston got 98 doctors,
   * CCRM labs 49-67 - the full Shady Grove / CCRM physician lists). That is
   * worse than useless.
   *
   * Rule:
   *  - No sibling labs -> keep everyone (single clinic, nothing to scope).
   *  - Siblings -> keep a member only if:
   *      * it is a SART member (authoritative for this lab), OR
   *      * it has a locationHint matching one of this lab's kept locations.
   *    Everything else (scraped-only doctors we cannot attribute) is dropped.
   *
   * Result for a big network with a global team page and no per-doctor mapping:
   * the lab keeps just its SART doctors (SGF Houston -> 3) instead of 98.
   */
  private scopeTeamToLab<T extends { name: string; locationHints: string[] }>(
    mergedTeam: T[],
    keptLocationKeys: Set<string>,
    hasSiblings: boolean,
    sartMembers: SartMember[],
  ): T[] {
    if (!hasSiblings) return mergedTeam;

    const sartKeys = new Set(sartMembers.map(m => normalizeMemberKey(m.name)).filter(k => k.length >= 4));
    const keptCities = Array.from(keptLocationKeys).map(k => k.split("|")[0]).filter(Boolean);

    return mergedTeam.filter(m => {
      if (sartKeys.has(normalizeMemberKey(m.name))) return true; // authoritative per-lab
      if (m.locationHints.length === 0) return false; // scraped-only, unattributable -> drop
      return m.locationHints.some(hint => {
        const h = hint.toLowerCase();
        return keptCities.some(city => h.includes(city));
      });
    });
  }

  /**
   * Trim hospital / university "over-pull". When a fertility clinic is hosted on
   * a big health-system domain (massgeneral.org, uwmedicine.org, montefiore.org,
   * sbivf.com, siumed.edu ...), the scraper grabs the WHOLE institution's
   * physician directory - cardiologists, surgeons, pediatricians - not just the
   * REI department, so a fertility center ends up with 30-50 unrelated doctors.
   * These are single-domain clinics, so scopeTeamToLab (multi-lab) does not
   * catch them.
   *
   * Heuristic: only engages for suspiciously large rosters (> THRESHOLD). For a
   * large roster, keep a doctor only if it is a SART member (authoritative for
   * THIS fertility clinic) OR its name/title/bio shows a reproductive-medicine
   * specialty. Small rosters are left untouched - a dedicated clinic's own site
   * lists its own fertility doctors even when a bio snippet lacks a keyword, so
   * we don't risk dropping them. If the filter would remove everyone (no SART,
   * no keyword anywhere) we keep the original rather than show an empty card.
   */
  private trimToReproductiveSpecialty<T extends { name: string; title: string | null; bio: string | null }>(
    team: T[],
    sartMembers: SartMember[],
  ): T[] {
    const THRESHOLD = 12;
    if (team.length <= THRESHOLD) return team;

    const sartKeys = new Set(sartMembers.map(m => normalizeMemberKey(m.name)).filter(k => k.length >= 4));
    const REPRO = /\b(reproductive|fertility|infertil|ivf|in[\s-]?vitro|REI|ob[\s-]?gyn|obstetric|gynecolog|androlog|embryolog)\b/i;

    const trimmed = team.filter(m => {
      if (sartKeys.has(normalizeMemberKey(m.name))) return true;
      return REPRO.test(`${m.name} ${m.title || ""} ${m.bio || ""}`);
    });

    if (trimmed.length === 0) return team; // never make a clinic worse than before
    if (trimmed.length < team.length) {
      console.log(`[clinic-enrichment] Trimmed hospital over-pull: ${team.length} -> ${trimmed.length} reproductive-relevant`);
    }
    return trimmed;
  }

  private async syncLocations(
    providerId: string,
    providerName: string,
    existingLocations: Array<{ id: string; address: string | null; city: string | null; state: string | null; zip: string | null; sortOrder: number }>,
    scrapedLocations: Array<{ address: string | null; city: string | null; state: string | null; zip: string | null }>,
    cleanStaleEnriched = false,
  ): Promise<void> {
    if (scrapedLocations.length === 0 && !cleanStaleEnriched) return;

    const normalize = (s: string | null) => (s || "").trim().toLowerCase();
    const locationKey = (city: string | null, state: string | null) => `${normalize(city)}|${normalize(state)}`;

    const existingByKey = new Map<string, typeof existingLocations[0]>();
    for (const loc of existingLocations) {
      const key = locationKey(loc.city, loc.state);
      if (key !== "|") existingByKey.set(key, loc);
    }

    const matchedExistingIds = new Set<string>();
    let nextSortOrder = existingLocations.reduce((max, loc) => Math.max(max, loc.sortOrder), 0) + 1;

    for (const scraped of scrapedLocations) {
      const key = locationKey(scraped.city, scraped.state);
      if (key === "|") continue;

      const existing = existingByKey.get(key);
      if (existing) {
        matchedExistingIds.add(existing.id);

        if (existing.sortOrder === 0) {
          const cdcUpdates: Record<string, any> = {};
          if (!existing.zip && scraped.zip) cdcUpdates.zip = scraped.zip;
          if (Object.keys(cdcUpdates).length > 0) {
            await this.prisma.providerLocation.update({
              where: { id: existing.id },
              data: cdcUpdates,
            });
          }
        } else {
          const updates: Record<string, any> = {};
          if (scraped.address) updates.address = scraped.address;
          if (scraped.city) updates.city = scraped.city;
          if (scraped.state) updates.state = scraped.state;
          if (scraped.zip) updates.zip = scraped.zip;

          if (Object.keys(updates).length > 0) {
            await this.prisma.providerLocation.update({
              where: { id: existing.id },
              data: updates,
            });
          }
        }
      } else {
        await this.prisma.providerLocation.create({
          data: {
            providerId,
            address: scraped.address,
            city: scraped.city,
            state: scraped.state,
            zip: scraped.zip,
            sortOrder: nextSortOrder++,
          },
        });
      }
    }

    const scrapedKeys = new Set(
      scrapedLocations
        .map((s) => locationKey(s.city, s.state))
        .filter((k) => k !== "|"),
    );

    for (const loc of existingLocations) {
      const key = locationKey(loc.city, loc.state);
      if (loc.sortOrder === 0) continue;
      if (scrapedKeys.has(key)) continue;
      if (matchedExistingIds.has(loc.id)) continue;

      await this.prisma.providerMemberLocation.deleteMany({
        where: { locationId: loc.id },
      });
      await this.prisma.providerLocation.delete({
        where: { id: loc.id },
      });
    }

    const finalCount = await this.prisma.providerLocation.count({ where: { providerId } });
    console.log(`[clinic-enrichment] Synced locations for "${providerName}": ${finalCount} total`);
  }

  private async reSyncLocationsAndTeamWithRetry(providerId: string, providerName: string, maxRetries = 3): Promise<boolean | null> {
    const BASE_DELAY = 5000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.reSyncLocationsAndTeam(providerId);
      } catch (err: any) {
        if (isRetryableError(err) && attempt < maxRetries) {
          const delay = BASE_DELAY * Math.pow(2, attempt - 1);
          console.log(`[clinic-enrichment] Re-sync retry for "${providerName}" (attempt ${attempt}/${maxRetries}): ${err.message}, waiting ${delay}ms...`);
          await sleep(delay);
        } else if (isRetryableError(err)) {
          // Retries exhausted on a transient failure (site rate-limited us with
          // 429 or stayed unreachable). This is a SKIP, not an error - the site
          // blocked the scrape, the clinic keeps its existing data. Returning
          // false (vs throwing) keeps it out of the scary "errors" count.
          console.log(`[clinic-enrichment] Re-sync for "${providerName}" still failing after ${maxRetries} attempts (${err.message}) - skipping`);
          return false;
        } else {
          throw err; // genuine unexpected error
        }
      }
    }
    return null;
  }

  private async reSyncLocationsAndTeam(providerId: string): Promise<boolean> {
    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
      include: {
        locations: { orderBy: { sortOrder: "asc" } },
        members: true,
      },
    });

    if (!provider) {
      console.log(`[clinic-enrichment] reSync: Provider ${providerId} not found, skipping`);
      return false;
    }

    if (!provider.websiteUrl) {
      console.log(`[clinic-enrichment] reSync: "${provider.name}" has no website URL, skipping`);
      return false;
    }

    console.log(`[clinic-enrichment] reSync: Re-scraping "${provider.name}" from ${provider.websiteUrl}...`);
    let scraped: Awaited<ReturnType<typeof scrapeProviderWebsite>> | null = null;
    try {
      scraped = await scrapeProviderWebsite(provider.websiteUrl, { doctorsOnly: true });
    } catch (scrapeErr: any) {
      // Transient failures (429 rate-limit, connection resets, timeouts) get
      // re-thrown so reSyncLocationsAndTeamWithRetry retries them with backoff -
      // these are often self-inflicted by high concurrency and recover on retry.
      // Persistent failures (403 bot-block, 404) are NOT retryable; skip them.
      if (isRetryableError(scrapeErr)) {
        throw scrapeErr;
      }
      console.log(`[clinic-enrichment] reSync: Scrape failed for "${provider.name}" (${scrapeErr.message}), skipping`);
      return false;
    }

    if (!scraped) return false;

    const cdcCity = provider.locations[0]?.city || null;
    const cdcState = provider.locations[0]?.state || null;

    const { keptLocations, keptLocationKeys, hasSiblings } = await this.scopeToLab(
      { id: providerId, name: provider.name, websiteUrl: provider.websiteUrl },
      cdcCity,
      cdcState,
      scraped.locations || [],
    );

    await this.syncLocations(providerId, provider.name, provider.locations, keptLocations, hasSiblings);

    const sartResult = await searchSartForClinic(provider.name, cdcCity, cdcState);
    const sartMembers = sartResult?.members || [];

    const mergedTeam = mergeTeamMembers(sartMembers, scraped.teamMembers || [], provider.name);

    let scopedTeam = this.scopeTeamToLab(mergedTeam, keptLocationKeys, hasSiblings, sartMembers);
    scopedTeam = this.trimToReproductiveSpecialty(scopedTeam, sartMembers);
    if (hasSiblings) {
      console.log(`[clinic-enrichment] reSync: Scoped team for "${provider.name}": ${scopedTeam.length}/${mergedTeam.length} kept`);
    }

    if (scopedTeam.length > 0) {
      const snapshot = await this.snapshotEnrichedTeam(providerId);
      await this.prisma.providerMemberLocation.deleteMany({
        where: { member: { providerId } },
      });
      await this.prisma.providerMember.deleteMany({
        where: { providerId },
      });

      for (let i = 0; i < scopedTeam.length; i++) {
        const tm = scopedTeam[i];
        const persistedPhoto = await persistPhotoToGcs(tm.photoUrl, this.storageService);
        await createMemberWithSlug(this.prisma, {
          providerId,
          name: tm.name,
          title: tm.title,
          bio: tm.bio,
          photoUrl: persistedPhoto,
          isMedicalDirector: tm.isMedicalDirector,
          sortOrder: i,
        });
      }
      console.log(`[clinic-enrichment] reSync: Refreshed ${scopedTeam.length} team members for "${provider.name}"`);
      await this.enrichTeamDoctorData(providerId, snapshot);
    } else if (mergedTeam.length > 0) {
      // The scrape DID find a team, but scoping attributed NONE of them to this
      // lab (network over-keep: e.g. CCRM Dallas, whose whole-network roster has
      // no per-lab signal and no SART entry). Clear the stale roster instead of
      // leaving a wrong over-kept one from a prior run. (mergedTeam === 0 falls
      // through and keeps the existing team - that's a scraper miss, not a
      // genuine "no doctors here".)
      await this.prisma.providerMemberLocation.deleteMany({ where: { member: { providerId } } });
      await this.prisma.providerMember.deleteMany({ where: { providerId } });
      console.log(`[clinic-enrichment] reSync: Cleared stale ${mergedTeam.length}-member roster for "${provider.name}" - none attributable to this lab`);
    }

    return true;
  }

  // Snapshot the doctor-profile fields (NPPES/ABOG/bio/self-sourced) of a
  // clinic's current members, keyed by personKey, BEFORE the delete+recreate
  // team refresh. Lets enrichTeamDoctorData carry the data forward so a routine
  // re-enrichment never wipes resolved doctor data.
  private async snapshotEnrichedTeam(providerId: string): Promise<Map<string, Record<string, any>>> {
    const prev = await this.prisma.providerMember.findMany({
      where: { providerId },
      select: {
        personKey: true,
        npiNumber: true, npiTaxonomy: true, credential: true, licenseState: true,
        medicalSchool: true, graduationYear: true, providerGender: true, yearsExperience: true,
        specialties: true, languagesSpoken: true, boardCertifications: true,
        education: true, professionalMemberships: true, fieldSources: true,
      },
    });
    const snap = new Map<string, Record<string, any>>();
    for (const m of prev) {
      if (!m.personKey) continue;
      // Keep the row that actually carries resolved data (npi or specialties).
      const hasData = m.npiNumber || (m.specialties && m.specialties.length > 0);
      if (!hasData && snap.has(m.personKey)) continue;
      const { personKey, ...data } = m;
      snap.set(m.personKey, data);
    }
    return snap;
  }

  // After a team refresh, restore carried-forward doctor data for known people
  // and resolve fresh authoritative data (NPPES + ABOG + bio) for new doctors.
  private async enrichTeamDoctorData(providerId: string, snapshot: Map<string, Record<string, any>>): Promise<void> {
    const loc = await this.prisma.providerLocation.findFirst({
      where: { providerId },
      orderBy: { sortOrder: "asc" },
      select: { city: true, state: true },
    });
    const members = await this.prisma.providerMember.findMany({
      where: { providerId },
      select: { id: true, name: true, bio: true, personKey: true, fieldSources: true },
    });

    // Pass 1: carry forward prior enrichment for known people (cheap, no lookups).
    const newDoctors: typeof members = [];
    for (const m of members) {
      const carried = m.personKey ? snapshot.get(m.personKey) : undefined;
      if (carried && (carried.npiNumber || (carried.specialties?.length ?? 0) > 0)) {
        const { fieldSources, ...rest } = carried;
        await this.prisma.providerMember.updateMany({
          where: { id: m.id },
          data: { ...rest, fieldSources: fieldSources ?? undefined },
        });
      } else {
        newDoctors.push(m);
      }
    }

    // Pass 2: resolve authoritative data for new doctors (NPPES + ABOG + bio),
    // bounded-concurrent so a large team doesn't serialize into many slow calls.
    const CONCURRENCY = 4;
    for (let i = 0; i < newDoctors.length; i += CONCURRENCY) {
      await Promise.all(
        newDoctors.slice(i, i + CONCURRENCY).map(async (m) => {
          try {
            const { data } = await buildDoctorEnrichment({
              name: m.name,
              bio: m.bio,
              city: loc?.city ?? null,
              state: loc?.state ?? null,
              existingSources: (m.fieldSources as any) || null,
              genAI,
            });
            if (Object.keys(data).length > 0) {
              await this.prisma.providerMember.updateMany({ where: { id: m.id }, data });
            }
          } catch (err: any) {
            console.log(`[clinic-enrichment] doctor-data enrichment failed for "${m.name}": ${err?.message}`);
          }
        }),
      );
    }
  }

  // Enrich a clinic's EXISTING team members from the chosen doctor-data source(s)
  // - NPPES / ABOG / bio - without re-scraping the clinic website. Backs the
  // targeted "doctors-*" enrichment modes. Respects "self" provenance.
  private async enrichClinicDoctorData(providerId: string, only?: ("nppes" | "abog" | "bio")[]): Promise<void> {
    const loc = await this.prisma.providerLocation.findFirst({
      where: { providerId },
      orderBy: { sortOrder: "asc" },
      select: { city: true, state: true },
    });
    const members = await this.prisma.providerMember.findMany({
      where: { providerId },
      select: { id: true, name: true, bio: true, fieldSources: true },
    });
    const CONCURRENCY = 4;
    for (let i = 0; i < members.length; i += CONCURRENCY) {
      await Promise.all(
        members.slice(i, i + CONCURRENCY).map(async (m) => {
          try {
            const { data } = await buildDoctorEnrichment({
              name: m.name,
              bio: m.bio,
              city: loc?.city ?? null,
              state: loc?.state ?? null,
              existingSources: (m.fieldSources as any) || null,
              genAI,
              only,
            });
            if (Object.keys(data).length > 0) {
              await this.prisma.providerMember.updateMany({ where: { id: m.id }, data });
            }
          } catch (err: any) {
            console.log(`[clinic-enrichment] doctor-data (${only?.join(",") ?? "all"}) failed for "${m.name}": ${err?.message}`);
          }
        }),
      );
    }
  }

  private async enrichWithRetry(providerId: string, providerName: string, maxRetries = 3): Promise<boolean | null> {
    const BASE_DELAY = 5000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.enrichClinicProfile(providerId);
      } catch (err: any) {
        if (isRetryableError(err) && attempt < maxRetries) {
          const delay = BASE_DELAY * Math.pow(2, attempt - 1);
          console.log(`[clinic-enrichment] Retrying "${providerName}" (attempt ${attempt}/${maxRetries}) after error: ${err.message}, waiting ${delay}ms...`);
          await sleep(delay);
        } else {
          throw err;
        }
      }
    }
    return null;
  }

  /**
   * Process a list of clinics with bounded concurrency, shared by the full and
   * targeted enrichment paths. Each clinic is handed to `processOne`, which
   * returns whether the clinic was enriched (false/null = skipped).
   *
   * Concurrency is env-configurable via ENRICHMENT_CONCURRENCY (default 10,
   * capped 1..20). N workers pull from a shared index; counters and the job's
   * progress row are updated as each clinic completes. JS is single-threaded so
   * the shared counters need no locking. Supersession (a newer run took over)
   * and admin-cancel (job status flipped away from PROCESSING) are checked
   * before each clinic is picked up; the cancel check is throttled so we don't
   * hammer the DB with one findUnique per clinic per worker.
   *
   * No inter-clinic sleep: concurrency provides natural pacing and the per-call
   * retry/backoff (isRetryableError) absorbs transient Gemini/SART rate limits.
   */
  private async processConcurrently(
    jobId: string,
    runId: string,
    providers: Array<{ id: string; name: string }>,
    total: number,
    start: { processed: number; errors: number; skipped: number },
    processOne: (provider: { id: string; name: string }) => Promise<boolean | null>,
  ): Promise<{ processed: number; errors: number; skipped: number; stopped: boolean }> {
    const concurrency = Math.max(1, Math.min(20, parseInt(process.env.ENRICHMENT_CONCURRENCY || "10", 10) || 10));
    let processed = start.processed;
    let errors = start.errors;
    let skipped = start.skipped;
    let next = 0;
    let stopped = false;
    let lastCancelCheckAt = 0;
    let cancelStatusOk = true;

    const stillRunning = async (): Promise<boolean> => {
      if (this.activeRunId !== runId) return false;
      const now = Date.now();
      if (now - lastCancelCheckAt > 2500) {
        lastCancelCheckAt = now;
        const job = await this.prisma.cdcSyncJob.findUnique({
          where: { id: jobId },
          select: { enrichmentStatus: true },
        });
        cancelStatusOk = job?.enrichmentStatus === "PROCESSING";
      }
      return cancelStatusOk;
    };

    console.log(`[clinic-enrichment] Processing ${providers.length} clinics with concurrency=${concurrency}`);

    const worker = async (): Promise<void> => {
      while (true) {
        if (!(await stillRunning())) { stopped = true; return; }
        const i = next++;
        if (i >= providers.length) return;
        const provider = providers[i];
        try {
          const enriched = await processOne(provider);
          if (!enriched) skipped++;
        } catch (err: any) {
          errors++;
          console.error(`[clinic-enrichment] Error enriching "${provider.name}" (after retries):`, err.message);
        }
        processed++;
        await this.prisma.cdcSyncJob.updateMany({
          where: { id: jobId, enrichmentStatus: "PROCESSING" },
          data: {
            enrichmentProcessed: Math.min(processed, total),
            enrichmentErrors: errors,
            enrichmentSkipped: skipped,
          },
        });
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, providers.length) }, () => worker()));
    return { processed, errors, skipped, stopped };
  }

  async runTargetedEnrichment(jobId: string, mode: "skipped" | "team" | "logo" | "about" | "phone" | "locations" | "urls" | "doctors-nppes" | "doctors-abog" | "doctors-bio" | "doctors-all"): Promise<void> {
    const runId = crypto.randomUUID();
    this.activeRunId = runId;
    const modeLabels: Record<string, string> = {
      skipped: "skipped (no website)",
      team: "missing team members",
      logo: "missing logo",
      about: "missing about",
      phone: "missing phone",
      locations: "re-scrape locations + team",
      urls: "re-discover website URLs",
      "doctors-nppes": "doctor NPI + specialty (NPPES)",
      "doctors-abog": "doctor board certifications (ABOG)",
      "doctors-bio": "doctor focus areas (AI from bios)",
      "doctors-all": "all doctor data (NPPES + ABOG + AI)",
    };
    const doctorSourceFilter: Record<string, ("nppes" | "abog" | "bio")[] | undefined> = {
      "doctors-nppes": ["nppes"],
      "doctors-abog": ["abog"],
      "doctors-bio": ["bio"],
      "doctors-all": undefined, // all sources
    };
    const isDoctorMode = mode.startsWith("doctors-");
    const modeLabel = modeLabels[mode];
    console.log(`[clinic-enrichment] Starting targeted enrichment (${modeLabel}) run ${runId.slice(0, 8)} for job ${jobId}`);

    try {
      const allIvfClinics = await this.prisma.provider.findMany({
        where: {
          services: { some: { providerType: { name: "IVF Clinic" } } },
        },
        select: { id: true, name: true, websiteUrl: true, logoUrl: true, about: true, phone: true },
        orderBy: { name: "asc" },
      });

      let providersToEnrich: typeof allIvfClinics;
      if (mode === "skipped") {
        providersToEnrich = allIvfClinics.filter(p => !p.websiteUrl);
      } else if (mode === "logo") {
        providersToEnrich = allIvfClinics.filter(p => !p.logoUrl);
      } else if (mode === "about") {
        providersToEnrich = allIvfClinics.filter(p => !p.about);
      } else if (mode === "phone") {
        providersToEnrich = allIvfClinics.filter(p => !p.phone);
      } else if (mode === "urls") {
        providersToEnrich = allIvfClinics;
      } else if (mode === "locations") {
        providersToEnrich = allIvfClinics.filter(p => !!p.websiteUrl);
      } else if (isDoctorMode) {
        // Doctor-data modes enrich the existing team, so only clinics that have members.
        const withTeam = await this.prisma.providerMember.groupBy({ by: ["providerId"], _count: true });
        const providerIdsWithTeam = new Set(withTeam.map(t => t.providerId));
        providersToEnrich = allIvfClinics.filter(p => providerIdsWithTeam.has(p.id));
      } else {
        const withTeam = await this.prisma.providerMember.groupBy({
          by: ["providerId"],
          _count: true,
        });
        const providerIdsWithTeam = new Set(withTeam.map(t => t.providerId));
        providersToEnrich = allIvfClinics.filter(p => !providerIdsWithTeam.has(p.id));
      }

      const total = providersToEnrich.length;
      console.log(`[clinic-enrichment] Targeted enrichment (${modeLabel}): ${total} clinics to process`);

      await this.prisma.cdcSyncJob.update({
        where: { id: jobId },
        data: {
          enrichmentStatus: "PROCESSING",
          enrichmentMode: mode,
          enrichmentTotal: total,
          enrichmentProcessed: 0,
          enrichmentErrors: 0,
          enrichmentSkipped: 0,
          enrichmentErrorMessage: null,
        },
      });

      if (total === 0) {
        await this.prisma.cdcSyncJob.update({
          where: { id: jobId },
          data: { enrichmentStatus: "COMPLETED", enrichmentMode: null, enrichmentProcessed: 0, enrichmentTotal: 0 },
        });
        return;
      }

      // NOTE: We deliberately do NOT bulk-clear the target field before the loop.
      // An earlier version wiped every target clinic's data upfront (so the live
      // Field Coverage counter would drop to ~0 and visibly climb). That was
      // CATASTROPHIC on failure: when a run died at clinic 16/455, the other 439
      // clinics had already been wiped and never restored, leaving the data far
      // worse than before the run. Each mode already clears its own field
      // per-clinic AS it is processed (urls nulls the websiteUrl inside the loop;
      // locations/team clear-and-replace inside reSyncLocationsAndTeam via
      // syncLocations). So a mid-run failure now only affects clinics actually
      // re-processed - untouched clinics keep their existing data. The live
      // counter no longer animates from zero, which is an acceptable trade for
      // not destroying data on a transient infra hiccup.

      const processOne = async (provider: { id: string; name: string }): Promise<boolean | null> => {
        if (isDoctorMode) {
          await this.enrichClinicDoctorData(provider.id, doctorSourceFilter[mode]);
          return true; // doctor modes have no skip concept
        }
        if (mode === "urls") {
          await this.prisma.provider.update({ where: { id: provider.id }, data: { websiteUrl: null } });
          return await this.enrichWithRetry(provider.id, provider.name);
        }
        if (mode === "locations") {
          return await this.reSyncLocationsAndTeamWithRetry(provider.id, provider.name);
        }
        return await this.enrichWithRetry(provider.id, provider.name);
      };

      const { processed, errors, skipped, stopped } = await this.processConcurrently(
        jobId, runId, providersToEnrich, total, { processed: 0, errors: 0, skipped: 0 }, processOne,
      );

      if (stopped || this.activeRunId !== runId) {
        console.log(`[clinic-enrichment] Targeted run ${runId.slice(0, 8)} stopped early at ${processed}/${total}`);
        return;
      }

      const finalUpdate = await this.prisma.cdcSyncJob.updateMany({
        where: { id: jobId, enrichmentStatus: "PROCESSING" },
        data: { enrichmentStatus: "COMPLETED", enrichmentMode: null, enrichmentProcessed: processed, enrichmentErrors: errors, enrichmentSkipped: skipped },
      });

      if (finalUpdate.count > 0) {
        console.log(`[clinic-enrichment] Targeted enrichment (${modeLabel}) complete: ${processed} processed, ${errors} errors, ${skipped} skipped`);
      }
    } catch (err: any) {
      console.error(`[clinic-enrichment] Fatal targeted enrichment error:`, err.message);
      await this.prisma.cdcSyncJob.update({
        where: { id: jobId },
        data: { enrichmentStatus: "FAILED", enrichmentMode: null, enrichmentErrorMessage: err.message?.slice(0, 500) || "Unknown error" },
      });
    }
  }

  async runEnrichment(jobId: string): Promise<void> {
    const runId = crypto.randomUUID();
    this.activeRunId = runId;
    console.log(`[clinic-enrichment] Starting enrichment run ${runId.slice(0, 8)} for job ${jobId}`);

    try {
      const job = await this.prisma.cdcSyncJob.findUnique({
        where: { id: jobId },
        select: { enrichmentProcessed: true, enrichmentErrors: true, enrichmentSkipped: true, enrichmentTotal: true },
      });

      const previousProcessed = job?.enrichmentProcessed || 0;
      const previousErrors = job?.enrichmentErrors || 0;
      const previousSkipped = job?.enrichmentSkipped || 0;
      const isResume = previousProcessed > 0;

      const allProviders = await this.prisma.provider.findMany({
        where: {
          services: {
            some: {
              providerType: { name: "IVF Clinic" },
            },
          },
        },
        select: { id: true, name: true, websiteUrl: true },
        orderBy: { name: "asc" },
      });

      const total = allProviders.length;
      let providersToEnrich: typeof allProviders;
      if (isResume) {
        const remaining = allProviders.slice(previousProcessed);
        const missedFromEarlier = allProviders.slice(0, previousProcessed).filter(p => !p.websiteUrl);
        providersToEnrich = [...missedFromEarlier, ...remaining];
        if (missedFromEarlier.length > 0) {
          console.log(`[clinic-enrichment] Found ${missedFromEarlier.length} previously-processed clinics with no website - will re-enrich them`);
        }
      } else {
        providersToEnrich = allProviders;
      }

      if (!isResume && total > 0) {
        const providerIds = allProviders.map((p) => p.id);
        console.log(`[clinic-enrichment] Clearing enrichment data for ${total} clinics before fresh start...`);
        await this.prisma.providerMemberLocation.deleteMany({
          where: { member: { providerId: { in: providerIds } } },
        });
        await this.prisma.providerMember.deleteMany({
          where: { providerId: { in: providerIds } },
        });
        // Drop ALL enriched satellite locations (sortOrder > 0). The CDC origin
        // row at sortOrder=0 is preserved so success rates stay attached.
        // Without this, stale satellites from previous (pre-scope-to-lab) runs
        // hang around forever - sortOrders 14..21 we saw on Syracuse Center
        // were leftovers from broken full runs that never got cleaned up.
        await this.prisma.providerLocation.deleteMany({
          where: { providerId: { in: providerIds }, sortOrder: { gt: 0 } },
        });
        await this.prisma.provider.updateMany({
          where: { id: { in: providerIds } },
          data: {
            websiteUrl: null,
            about: null,
            phone: null,
            logoUrl: null,
            email: null,
            yearFounded: null,
          },
        });
        console.log(`[clinic-enrichment] Cleared enrichment data for ${total} clinics`);
      }

      console.log(`[clinic-enrichment] ${isResume ? "Resuming" : "Starting"} enrichment: ${providersToEnrich.length} remaining, ${total} total (${previousProcessed} previously processed)`);

      await this.prisma.cdcSyncJob.update({
        where: { id: jobId },
        data: {
          enrichmentStatus: "PROCESSING",
          enrichmentMode: isResume ? undefined : "full",
          enrichmentTotal: total,
          enrichmentErrorMessage: null,
        },
      });

      if (providersToEnrich.length === 0) {
        await this.prisma.cdcSyncJob.update({
          where: { id: jobId },
          data: {
            enrichmentStatus: "COMPLETED",
            enrichmentMode: null,
            enrichmentTotal: total,
            enrichmentProcessed: total,
          },
        });
        return;
      }

      const { processed, errors, skipped, stopped } = await this.processConcurrently(
        jobId,
        runId,
        providersToEnrich,
        total,
        { processed: Math.min(previousProcessed, total), errors: previousErrors, skipped: previousSkipped },
        (provider) => this.enrichWithRetry(provider.id, provider.name),
      );

      if (stopped || this.activeRunId !== runId) {
        console.log(`[clinic-enrichment] Run ${runId.slice(0, 8)} stopped early at ${processed}/${total}, skipping COMPLETED write`);
        return;
      }

      const finalUpdate = await this.prisma.cdcSyncJob.updateMany({
        where: { id: jobId, enrichmentStatus: "PROCESSING" },
        data: {
          enrichmentStatus: "COMPLETED",
          enrichmentMode: null,
          enrichmentProcessed: processed,
          enrichmentErrors: errors,
          enrichmentSkipped: skipped,
        },
      });

      if (finalUpdate.count > 0) {
        console.log(`[clinic-enrichment] Enrichment complete: ${processed} processed, ${errors} errors, ${skipped} skipped`);
      } else {
        console.log(`[clinic-enrichment] Enrichment loop finished but job was cancelled - skipping COMPLETED update`);
      }
    } catch (err: any) {
      console.error(`[clinic-enrichment] Fatal enrichment error:`, err.message);
      await this.prisma.cdcSyncJob.update({
        where: { id: jobId },
        data: {
          enrichmentStatus: "FAILED",
          enrichmentMode: null,
          enrichmentErrorMessage: err.message?.slice(0, 500) || "Unknown error",
        },
      });
    }
  }
}
