import { GoogleGenerativeAI } from "@google/generative-ai";
import { PrismaService } from "../prisma/prisma.service";
import { scrapeProviderWebsite } from "./scrape.service";

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

export async function verifyClinicUrl(url: string, clinicName: string): Promise<VerifyResult> {
  const domainRelevant = domainHasFertilityKeyword(url) || domainContainsClinicNameWords(url, clinicName);

  if (domainRelevant) {
    console.log(`[clinic-enrichment] verifyClinicUrl: "${url}" accepted — domain name matches fertility/clinic keywords`);
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
      if (domainRelevant) {
        console.log(`[clinic-enrichment] verifyClinicUrl: "${url}" HTTP ${response.status} but domain is relevant — accepting`);
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
      console.log(`[clinic-enrichment] verifyClinicUrl: "${url}" has minimal content (${strippedText.length} chars) — likely SPA, accepting`);
      return { valid: true, reason: "minimal-content-spa" };
    }

    console.log(`[clinic-enrichment] verifyClinicUrl: "${url}" failed relevance check for "${clinicName}" (${strippedText.length} chars, ${nameWordMatches}/${significantNameWords.length} name words matched)`);
    return { valid: false, reason: "failed-relevance-check" };
  } catch (err: any) {
    const errMsg = String(err?.cause?.code || err?.cause?.message || err.message || "");
    if (errMsg.includes("ENOTFOUND") || errMsg.includes("ENODATA") || errMsg.includes("getaddrinfo")) {
      console.log(`[clinic-enrichment] verifyClinicUrl: DNS resolution failed for "${url}" — domain does not exist`);
      return { valid: false, reason: "dns-resolution-failed" };
    }
    if (domainRelevant) {
      console.log(`[clinic-enrichment] verifyClinicUrl: fetch error for "${url}": ${err.message} — accepting (domain is relevant)`);
      return { valid: true, reason: "domain-relevant-despite-fetch-error" };
    }
    console.log(`[clinic-enrichment] verifyClinicUrl: fetch error for "${url}": ${err.message} — accepting URL (cannot verify from this network)`);
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
    .replace(/,?\s*(LLC|Inc\.?|PC|PA|SC|LTD|LLP|Corporation|Corp\.?|PLLC|dba\b.*)/gi, "")
    .replace(/,?\s*(MD|DO|PhD|FACOG|FACS|MBA|MSc|RN|NP)\b/gi, "")
    .replace(/[.,'"]/g, "")
    .replace(/[-–—]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
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
          console.log(`[clinic-enrichment] SART search for "${searchTerm}": ${clinics.length} result(s) — [${clinics.slice(0, 3).map((c: any) => c.Name).join(", ")}${clinics.length > 3 ? "..." : ""}]`);
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
    return { url: sartResult.websiteUrl, sartPhone: sartResult.phone, sartEmail: sartResult.email, sartMembers };
  }

  console.log(`[clinic-enrichment] SART miss for "${clinicName}", falling back to Gemini search...`);

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

        return url;
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
    const prompt = `Find the official website URL for the fertility clinic: "${searchName}" ${locationPart ? `located in ${locationPart}` : ""}. \n\nINSTRUCTIONS FOR SEARCHING:\n1. The name is from a government database and is messy. You MUST clean it before searching.\n2. Remove legal suffixes: LLC, Inc, PC, PA, SC, LTD, LLP, Corporation.\n3. Remove doctor credentials: MD, DO, FACOG, FACS.\n4. Handle "dba": If the name contains "dba", search ONLY for the name AFTER "dba" (e.g., "X dba Y" -> search for "Y").\n5. Handle commas/acronyms: If there are multiple names (e.g., "F.I.R.S.T., Florida Institute..."), search the distinct parts.\n6. For hospital networks (e.g., AHN, Aurora Health, Brooke Army), find the specific sub-page for their Reproductive Medicine or Fertility department.\n7. For franchises (e.g., Boston IVF), find the specific location page.\n\nOUTPUT FORMAT:\nReturn ONLY the bare URL string starting with https:// or www. Do not include any other words. NEVER return aggregator sites (Yelp, Healthgrades, FertilityIQ, WebMD, Facebook, Vitals, Doximity). If you absolutely cannot find it, return exactly "null".`;

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

          if (searchName !== searchNames[0] || attempt > 1) {
            console.log(`[clinic-enrichment] findClinicWebsite succeeded for "${originalClinicName}" using search name "${searchName}" (attempt ${attempt}, verify: ${verifyResult.reason})`);
          }
          return url;
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

export function mergeTeamMembers(
  sartMembers: SartMember[],
  scrapedMembers: Array<{ name: string; title: string | null; bio: string | null; photoUrl: string | null; isMedicalDirector: boolean; locationHints: string[] }>,
  providerName: string,
): Array<{ name: string; title: string | null; bio: string | null; photoUrl: string | null; isMedicalDirector: boolean; locationHints: string[] }> {
  const normalizeKey = (name: string): string =>
    name
      .replace(/,?\s*(MD|DO|PhD|MBA|FACOG|MSc|RN|NP|PA|FACS|HCLD|TS|ELD|Jr\.?|Sr\.?|III|II|IV)\b/gi, "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");

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

export class ClinicEnrichmentService {
  private activeRunId: string | null = null;

  constructor(private readonly prisma: PrismaService) {}

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
      console.log(`[clinic-enrichment] Found website: ${websiteUrl} — scraping profile...`);
      try {
        scraped = await scrapeProviderWebsite(websiteUrl);
      } catch (scrapeErr: any) {
        console.log(`[clinic-enrichment] Scrape failed for "${provider.name}" (${scrapeErr.message}) — saving SART data only`);
      }
    } else {
      console.log(`[clinic-enrichment] No website for "${provider.name}" — saving SART data only`);
    }

    const updateData: Record<string, any> = {};
    if (websiteUrl) updateData.websiteUrl = websiteUrl;
    if (scraped?.about) updateData.about = scraped.about;
    if (scraped?.phone) updateData.phone = scraped.phone;
    else if (sartPhone) updateData.phone = sartPhone;
    if (scraped?.logoUrl) updateData.logoUrl = scraped.logoUrl;
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

    await this.syncLocations(providerId, provider.name, provider.locations, scraped?.locations || []);

    const mergedTeam = mergeTeamMembers(sartMembers, scraped?.teamMembers || [], provider.name);

    if (mergedTeam.length > 0) {
      await this.prisma.providerMemberLocation.deleteMany({
        where: { member: { providerId } },
      });
      await this.prisma.providerMember.deleteMany({
        where: { providerId },
      });

      for (let i = 0; i < mergedTeam.length; i++) {
        const tm = mergedTeam[i];
        await this.prisma.providerMember.create({
          data: {
            providerId,
            name: tm.name,
            title: tm.title,
            bio: tm.bio,
            photoUrl: tm.photoUrl,
            isMedicalDirector: tm.isMedicalDirector,
            sortOrder: i,
          },
        });
      }
      console.log(`[clinic-enrichment] Refreshed ${mergedTeam.length} team members for "${provider.name}"`);
    }

    return true;
  }


  private async syncLocations(
    providerId: string,
    providerName: string,
    existingLocations: Array<{ id: string; address: string | null; city: string | null; state: string | null; zip: string | null; sortOrder: number }>,
    scrapedLocations: Array<{ address: string | null; city: string | null; state: string | null; zip: string | null }>,
  ): Promise<void> {
    if (scrapedLocations.length === 0) return;

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

  async runTargetedEnrichment(jobId: string, mode: "skipped" | "team" | "logo" | "about" | "phone"): Promise<void> {
    const runId = crypto.randomUUID();
    this.activeRunId = runId;
    const modeLabels: Record<string, string> = {
      skipped: "skipped (no website)",
      team: "missing team members",
      logo: "missing logo",
      about: "missing about",
      phone: "missing phone",
    };
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
          data: { enrichmentStatus: "COMPLETED", enrichmentProcessed: 0, enrichmentTotal: 0 },
        });
        return;
      }

      let processed = 0;
      let errors = 0;
      let skipped = 0;

      for (const provider of providersToEnrich) {
        if (this.activeRunId !== runId) {
          console.log(`[clinic-enrichment] Run ${runId.slice(0, 8)} superseded, stopping at ${processed}/${total}`);
          return;
        }

        const currentJob = await this.prisma.cdcSyncJob.findUnique({
          where: { id: jobId },
          select: { enrichmentStatus: true },
        });
        if (currentJob?.enrichmentStatus !== "PROCESSING") {
          console.log(`[clinic-enrichment] Enrichment cancelled (status: ${currentJob?.enrichmentStatus}), halting at ${processed}/${total}`);
          return;
        }

        try {
          const enriched = await this.enrichWithRetry(provider.id, provider.name);
          if (!enriched) skipped++;
        } catch (err: any) {
          errors++;
          console.error(`[clinic-enrichment] Error enriching "${provider.name}" (after retries):`, err.message);
        }

        if (this.activeRunId !== runId) return;

        processed++;
        await this.prisma.cdcSyncJob.updateMany({
          where: { id: jobId, enrichmentStatus: "PROCESSING" },
          data: { enrichmentProcessed: processed, enrichmentErrors: errors, enrichmentSkipped: skipped },
        });

        if (processed < total) {
          await sleep(3000);
        }
      }

      if (this.activeRunId !== runId) return;

      const finalUpdate = await this.prisma.cdcSyncJob.updateMany({
        where: { id: jobId, enrichmentStatus: "PROCESSING" },
        data: { enrichmentStatus: "COMPLETED", enrichmentProcessed: processed, enrichmentErrors: errors, enrichmentSkipped: skipped },
      });

      if (finalUpdate.count > 0) {
        console.log(`[clinic-enrichment] Targeted enrichment (${modeLabel}) complete: ${processed} processed, ${errors} errors, ${skipped} skipped`);
      }
    } catch (err: any) {
      console.error(`[clinic-enrichment] Fatal targeted enrichment error:`, err.message);
      await this.prisma.cdcSyncJob.update({
        where: { id: jobId },
        data: { enrichmentStatus: "FAILED", enrichmentErrorMessage: err.message?.slice(0, 500) || "Unknown error" },
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
          console.log(`[clinic-enrichment] Found ${missedFromEarlier.length} previously-processed clinics with no website — will re-enrich them`);
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
          enrichmentTotal: total,
          enrichmentErrorMessage: null,
        },
      });

      if (providersToEnrich.length === 0) {
        await this.prisma.cdcSyncJob.update({
          where: { id: jobId },
          data: {
            enrichmentStatus: "COMPLETED",
            enrichmentTotal: total,
            enrichmentProcessed: total,
          },
        });
        return;
      }

      let processed = Math.min(previousProcessed, total);
      let errors = previousErrors;
      let skipped = previousSkipped;

      for (const provider of providersToEnrich) {
        if (this.activeRunId !== runId) {
          console.log(`[clinic-enrichment] Run ${runId.slice(0, 8)} superseded by newer run, stopping at ${processed}/${total}`);
          return;
        }

        const currentJob = await this.prisma.cdcSyncJob.findUnique({
          where: { id: jobId },
          select: { enrichmentStatus: true },
        });
        if (currentJob?.enrichmentStatus !== "PROCESSING") {
          console.log(`[clinic-enrichment] Enrichment cancelled or stopped (status: ${currentJob?.enrichmentStatus}), halting at ${processed}/${total}`);
          return;
        }

        try {
          const enriched = await this.enrichWithRetry(provider.id, provider.name);
          if (!enriched) {
            skipped++;
          }
        } catch (err: any) {
          errors++;
          console.error(`[clinic-enrichment] Error enriching "${provider.name}" (after retries):`, err.message);
        }

        if (this.activeRunId !== runId) {
          console.log(`[clinic-enrichment] Run ${runId.slice(0, 8)} superseded by newer run, stopping at ${processed}/${total}`);
          return;
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

        if (processed < total) {
          await sleep(3000);
        }
      }

      if (this.activeRunId !== runId) {
        console.log(`[clinic-enrichment] Run ${runId.slice(0, 8)} superseded before final update, skipping COMPLETED write`);
        return;
      }

      const finalUpdate = await this.prisma.cdcSyncJob.updateMany({
        where: { id: jobId, enrichmentStatus: "PROCESSING" },
        data: {
          enrichmentStatus: "COMPLETED",
          enrichmentProcessed: processed,
          enrichmentErrors: errors,
          enrichmentSkipped: skipped,
        },
      });

      if (finalUpdate.count > 0) {
        console.log(`[clinic-enrichment] Enrichment complete: ${processed} processed, ${errors} errors, ${skipped} skipped`);
      } else {
        console.log(`[clinic-enrichment] Enrichment loop finished but job was cancelled — skipping COMPLETED update`);
      }
    } catch (err: any) {
      console.error(`[clinic-enrichment] Fatal enrichment error:`, err.message);
      await this.prisma.cdcSyncJob.update({
        where: { id: jobId },
        data: {
          enrichmentStatus: "FAILED",
          enrichmentErrorMessage: err.message?.slice(0, 500) || "Unknown error",
        },
      });
    }
  }
}
