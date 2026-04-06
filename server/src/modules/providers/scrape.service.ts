import { GoogleGenerativeAI } from "@google/generative-ai";
import * as cheerio from "cheerio";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

interface JsonLdData {
  phones: string[];
  addresses: Array<{ address: string | null; city: string | null; state: string | null; zip: string | null }>;
  teamMembers: Array<{ name: string; title: string | null; photoUrl: string | null }>;
  logoUrl: string | null;
  name: string | null;
  description: string | null;
  url: string | null;
}

function extractJsonLd(html: string): JsonLdData {
  const result: JsonLdData = {
    phones: [],
    addresses: [],
    teamMembers: [],
    logoUrl: null,
    name: null,
    description: null,
    url: null,
  };

  try {
    const $ = cheerio.load(html);
    const scripts = $('script[type="application/ld+json"]');

    const entities: any[] = [];

    scripts.each((_, el) => {
      try {
        const raw = $(el).html();
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item["@graph"] && Array.isArray(item["@graph"])) {
            entities.push(...item["@graph"]);
          }
          entities.push(item);
        }
      } catch {}
    });

    const relevantTypes = /physician|medicalclinic|localbusiness|organization|medicalbusiness|medicalorganization|hospital|dentist|healthbusiness/i;

    for (const entity of entities) {
      try {
        const type = Array.isArray(entity["@type"]) ? entity["@type"].join(" ") : (entity["@type"] || "");
        const isRelevant = relevantTypes.test(type);

        if (entity.telephone) {
          const phones = Array.isArray(entity.telephone) ? entity.telephone : [entity.telephone];
          for (const p of phones) {
            if (typeof p === "string" && p.trim()) result.phones.push(p.trim());
          }
        }

        if (isRelevant) {
          if (entity.name && !result.name) result.name = entity.name;
          if (entity.description && !result.description) result.description = entity.description;
          if (entity.url && !result.url) result.url = entity.url;

          if (entity.logo) {
            const logoVal = typeof entity.logo === "string" ? entity.logo : entity.logo?.url;
            if (logoVal && !result.logoUrl) result.logoUrl = logoVal;
          }
          if (entity.image && !result.logoUrl) {
            const imgVal = typeof entity.image === "string" ? entity.image : entity.image?.url;
            if (imgVal) result.logoUrl = imgVal;
          }
        }

        if (entity.address) {
          const addrs = Array.isArray(entity.address) ? entity.address : [entity.address];
          for (const addr of addrs) {
            if (typeof addr === "object" && addr !== null) {
              result.addresses.push({
                address: addr.streetAddress || null,
                city: addr.addressLocality || null,
                state: addr.addressRegion || null,
                zip: addr.postalCode || null,
              });
            } else if (typeof addr === "string" && addr.trim()) {
              result.addresses.push({ address: addr.trim(), city: null, state: null, zip: null });
            }
          }
        }

        if (/physician|person/i.test(type) && entity.name) {
          result.teamMembers.push({
            name: entity.name,
            title: entity.jobTitle || entity.honorificSuffix || null,
            photoUrl: typeof entity.image === "string" ? entity.image : entity.image?.url || null,
          });
        }

        const members = entity.member || entity.employee || entity.members || entity.employees;
        if (members) {
          const memberList = Array.isArray(members) ? members : [members];
          for (const m of memberList) {
            if (m && m.name) {
              result.teamMembers.push({
                name: m.name,
                title: m.jobTitle || m.honorificSuffix || null,
                photoUrl: typeof m.image === "string" ? m.image : m.image?.url || null,
              });
            }
          }
        }
      } catch {}
    }
  } catch (err: any) {
    console.log(`[scraper] extractJsonLd error (non-fatal):`, err.message);
  }

  result.phones = [...new Set(result.phones)];
  return result;
}

function extractTelLinks(html: string): string[] {
  const phones: string[] = [];
  try {
    const $ = cheerio.load(html);
    $('footer a[href^="tel:"], a[href^="tel:"]').each((_, el) => {
      const href = $(el).attr("href");
      if (href) {
        const phone = href.replace(/^tel:\s*/i, "").trim();
        if (phone && phone.length >= 7) phones.push(phone);
      }
    });
  } catch {}
  return [...new Set(phones)];
}

function buildImgAltMap(html: string, baseUrl: string): Map<string, string> {
  const altMap = new Map<string, string>();
  try {
    const $ = cheerio.load(html);
    $("img").each((_, el) => {
      const alt = $(el).attr("alt")?.trim();
      if (!alt || alt.length < 4) return;
      const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-lazy-src");
      if (!src) return;
      if (/icon|logo|arrow|chevron|social|badge|button|decorative/i.test(alt)) return;
      try {
        const absoluteSrc = new URL(src, baseUrl).toString();
        const key = alt
          .replace(/,?\s*(MD|DO|PhD|MBA|FACOG|MSc|RN|NP|PA|FACS|Jr\.?|Sr\.?|III|II|IV)\b/gi, "")
          .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
          .toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
        if (key.length >= 4 && !altMap.has(key)) {
          altMap.set(key, absoluteSrc);
        }
      } catch {}
    });
  } catch {}
  return altMap;
}

async function checkImageExists(url: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
      });
      if (resp.ok) {
        const ct = resp.headers.get("content-type") || "";
        return ct.startsWith("image/");
      }
      return false;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

async function guessPhotoUrls(
  name: string,
  baseUrl: string,
): Promise<string | null> {
  const parts = name
    .replace(/,?\s*(MD|DO|PhD|MBA|FACOG|MSc|RN|NP|PA|FACS|Jr\.?|Sr\.?|III|II|IV)\b/gi, "")
    .replace(/^Dr\.?\s+/i, "")
    .trim()
    .toLowerCase()
    .split(/\s+/);
  if (parts.length < 2) return null;

  const firstName = parts[0];
  const lastName = parts[parts.length - 1];
  const fullSlug = parts.join("-");
  const firstLast = `${firstName}-${lastName}`;

  const base = new URL(baseUrl).origin;
  const candidates = [
    `${base}/wp-content/uploads/${firstLast}.jpg`,
    `${base}/wp-content/uploads/${firstLast}.png`,
    `${base}/wp-content/uploads/${firstLast}.webp`,
    `${base}/wp-content/uploads/${fullSlug}.jpg`,
    `${base}/wp-content/uploads/${fullSlug}.png`,
    `${base}/images/team/${firstLast}.jpg`,
    `${base}/images/team/${firstLast}.png`,
    `${base}/images/staff/${firstLast}.jpg`,
    `${base}/images/staff/${firstLast}.png`,
    `${base}/images/doctors/${firstLast}.jpg`,
    `${base}/images/doctors/${firstLast}.png`,
  ];

  for (let i = 0; i < candidates.length; i += 10) {
    const batch = candidates.slice(i, i + 10);
    const results = await Promise.all(batch.map(async (url) => {
      const exists = await checkImageExists(url);
      return exists ? url : null;
    }));
    const found = results.find(r => r !== null);
    if (found) return found;
  }
  return null;
}

export interface ScrapedTeamMember {
  name: string;
  title: string | null;
  bio: string | null;
  photoUrl: string | null;
  isMedicalDirector: boolean;
  locationHints: string[];
}

export interface ScrapedProviderData {
  name: string;
  about: string | null;
  logoUrl: string | null;
  logoWithNameUrl: string | null;
  faviconUrl: string | null;
  email: string | null;
  phone: string | null;
  yearFounded: number | null;
  websiteUrl: string;
  locations: Array<{
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  }>;
  suggestedServices: string[];
  teamMembers: ScrapedTeamMember[];
}

function normalizeUrl(url: string): string {
  let normalized = url.trim();
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    normalized = "https://" + normalized;
  }
  return normalized;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

const getRootDomain = (hostname: string) => hostname.split('.').slice(-2).join('.');

async function fetchHtml(url: string, timeoutMs = 45000): Promise<{ html: string; finalUrl: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
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
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    return { html: html.slice(0, 500000), finalUrl: response.url || url };
  } finally {
    clearTimeout(timeout);
  }
}

async function searchYearFounded(companyName: string, websiteUrl: string): Promise<number | null> {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { temperature: 0 } as any,
      tools: [{ googleSearch: {} } as any],
    });
    const prompt = `Which year was "${companyName}" (${websiteUrl}) founded? Respond with ONLY the 4-digit year number. If you cannot determine it with certainty, respond with just "null".`;
    const result = await model.generateContent(prompt);
    const yearText = result.response.text().trim();
    const yearMatch = yearText.match(/(19|20)\d{2}/);
    if (yearMatch) {
      const year = parseInt(yearMatch[0]);
      if (year >= 1900 && year <= new Date().getFullYear()) return year;
    }
    return null;
  } catch (err) {
    console.log(`[scraper] searchYearFounded error:`, err);
    return null;
  }
}

function findSubpageUrls(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const linkRegex = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const candidates: string[] = [];
  const subpagePatterns = /contact|about|nosotros|quienes-somos|equipo|locations?|offices?|find-us|visit|our-team|meet-us|teams?|staff|doctors?|providers?|physicians?|specialists?|leadership|why|who-we-are|our-story|people|founders/i;

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const linkText = match[2].replace(/<[^>]+>/g, "").trim().toLowerCase();

    const matchesPattern = subpagePatterns.test(href) || subpagePatterns.test(linkText);
    if (!matchesPattern) continue;

    try {
      const resolved = new URL(href, baseUrl);
      const isCcrmNetwork = resolved.hostname.includes('ccrmivf.com');
      if ((getRootDomain(normalizeHostname(resolved.hostname)) === getRootDomain(normalizeHostname(base.hostname)) || isCcrmNetwork) && resolved.pathname !== base.pathname) {
        candidates.push(resolved.toString());
      }
    } catch {}
  }

  const unique = [...new Set(candidates)];
  return unique.slice(0, 20);
}

function findLocationSubpageUrls(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const linkRegex = /<a[^>]+href=["']([^"'#]+)["'][^>]*>/gi;
  const candidates: string[] = [];
  const locationPatterns = /\/(?:locations?|sedes?|offices?|centers?|clinics?|centres?|sucursales?)\//i;

  // Skip SEO landing page patterns like /surrogacy-in-california, /ivf-in-texas, etc.
  const seoStatePattern = /\/(?:surrogacy|ivf|fertility|egg-donation?|sperm|clinic|treatment|donor)[-_](?:in|by|for)[-_][a-z]/i;

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    if (!locationPatterns.test(href)) continue;
    if (/\?state=/.test(href)) continue;
    if (seoStatePattern.test(href)) continue;

    try {
      const resolved = new URL(href, baseUrl);
      if (getRootDomain(normalizeHostname(resolved.hostname)) === getRootDomain(normalizeHostname(base.hostname)) && resolved.pathname !== base.pathname) {
        candidates.push(resolved.toString());
      }
    } catch {}
  }

  const unique = [...new Set(candidates)];
  return unique.slice(0, 8);
}

function findDoctorSubpageUrls(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const linkRegex = /<a[^>]+href=["']([^"'#]+)["'][^>]*>/gi;
  const candidates: string[] = [];
  const doctorPathPatterns = /\/(?:physicians?|doctors?|specialists?|providers?|teams?|staff|members?|people|faculty|experts?)[^/]*\/[^/]+\/?$/i;

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    if (!doctorPathPatterns.test(href)) continue;

    try {
      const resolved = new URL(href, baseUrl);
      if (getRootDomain(normalizeHostname(resolved.hostname)) === getRootDomain(normalizeHostname(base.hostname))) {
        const isTranslated = /^\/(en|fr|de|es|pt|it|ja|ko|zh|ru|ar|nl|sv|da|no|fi|pl|cs|tr|he|th|vi|uk|ro|hu|el|bg|hr|sk|sl|lt|lv|et|ga|mt)\//i.test(resolved.pathname);
        if (!isTranslated) {
          candidates.push(resolved.toString());
        }
      }
    } catch {}
  }

  return [...new Set(candidates)].slice(0, 60);
}

function extractMetaAndLogos(html: string): string {
  const metaTags = html.match(/<meta[^>]*>/gi) || [];
  const metaInfo = metaTags.map(tag => {
    const name = tag.match(/(?:name|property)=["']([^"']+)["']/i)?.[1] || "";
    const content = tag.match(/content=["']([^"']+)["']/i)?.[1] || "";
    return name && content ? `${name}: ${content}` : "";
  }).filter(Boolean).join("\n");

  const imgTags = html.match(/<img[^>]*>/gi) || [];
  const logos = imgTags.filter(tag =>
    /logo/i.test(tag)
  ).map(tag => {
    const src = tag.match(/src=["']([^"']+)["']/i)?.[1] || "";
    const alt = tag.match(/alt=["']([^"']+)["']/i)?.[1] || "";
    return `Logo image: src="${src}" alt="${alt}"`;
  }).join("\n");

  const linkTags = html.match(/<link[^>]*>/gi) || [];
  const favicons = linkTags.filter(tag =>
    /rel=["'][^"']*icon[^"']*["']/i.test(tag)
  ).map(tag => {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1] || "";
    const rel = tag.match(/rel=["']([^"']+)["']/i)?.[1] || "";
    const sizes = tag.match(/sizes=["']([^"']+)["']/i)?.[1] || "";
    return `Favicon: href="${href}" rel="${rel}" sizes="${sizes}"`;
  }).join("\n");

  const appleTouchIcons = linkTags.filter(tag =>
    /rel=["'][^"']*apple-touch-icon[^"']*["']/i.test(tag)
  ).map(tag => {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1] || "";
    const sizes = tag.match(/sizes=["']([^"']+)["']/i)?.[1] || "";
    return `Apple Touch Icon: href="${href}" sizes="${sizes}"`;
  }).join("\n");

  return `META:\n${metaInfo}\n\nLOGOS:\n${logos}\n\nFAVICONS:\n${favicons}\n${appleTouchIcons}`;
}

function extractMainBodyContent(html: string): string {
  let body = html
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  const mainMatch = body.match(/<main[\s\S]*?<\/main>/i) ||
    body.match(/<article[\s\S]*?<\/article>/i) ||
    body.match(/<div[^>]*(?:class|id)="[^"]*(?:content|entry|post|article|biography|bio|profile)[^"]*"[\s\S]*?<\/div>/i);
  if (mainMatch) body = mainMatch[0];
  return body
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);
}

function extractCleanText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getBestImageUrl(imgTag: string, baseUrl: string): string {
  const srcsetMatch = imgTag.match(/srcset=["']([^"']+)["']/i);
  if (srcsetMatch) {
    const entries = srcsetMatch[1].split(",").map(e => e.trim()).filter(Boolean);
    let bestUrl = "";
    let bestWidth = 0;
    for (const entry of entries) {
      const parts = entry.split(/\s+/);
      const url = parts[0];
      const widthStr = parts[1] || "";
      const width = parseInt(widthStr.replace("w", ""), 10) || 0;
      if (width > bestWidth) {
        bestWidth = width;
        bestUrl = url;
      }
    }
    if (bestUrl) {
      try {
        return new URL(bestUrl, baseUrl).toString();
      } catch {}
    }
  }

  for (const attr of ["data-src", "data-lazy-src", "data-original", "src"]) {
    const attrMatch = imgTag.match(new RegExp(`${attr}=["']([^"']+)["']`, "i"));
    if (attrMatch?.[1] && !attrMatch[1].startsWith("data:")) {
      try {
        return new URL(attrMatch[1], baseUrl).toString();
      } catch {}
    }
  }
  return "";
}

function looksLikePersonName(text: string): boolean {
  const cleaned = text
    .replace(/-\d+x\d+$/, "")
    .replace(/-\d+$/, "")
    .replace(/-circle|-round|-min|-updated|-headshot|-photo|-portrait/gi, "")
    .replace(/[_-]/g, " ")
    .replace(/\./g, "")
    .trim();
  const words = cleaned.split(/\s+/).filter(w => w.length > 0);
  const credentialPattern = /^(MD|DO|PhD|MS|MA|MBA|MPH|RN|NP|PA|CGC|FACOG|FACS|BSN|DNP|DrPH|JD|ESQ|LLM|CPA|RD|RDMS|HCLD|ELD|TS)$/i;
  const nameWords = words.filter(w => !credentialPattern.test(w));
  if (nameWords.length < 1 || nameWords.length > 5) return false;
  return nameWords.every(w => /^[A-Z][a-z]*$/.test(w));
}

function extractTeamSectionHtml(html: string, baseUrl: string): string {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const imgRegex = /<img[^>]+>/gi;
  const allImgs: { tag: string; pos: number; src: string; alt: string }[] = [];
  let imgMatch;
  while ((imgMatch = imgRegex.exec(cleaned)) !== null) {
    const tag = imgMatch[0];
    let src = getBestImageUrl(tag, baseUrl);
    const alt = tag.match(/alt=["']([^"']+)["']/i)?.[1] || "";
    if (!src && alt && looksLikePersonName(alt)) {
      const lookback = cleaned.slice(Math.max(0, imgMatch.index! - 2000), imgMatch.index!);
      const bgUrlMatch = lookback.match(/data-bg-url=["']([^"']+)["']/gi);
      if (bgUrlMatch) {
        const lastBg = bgUrlMatch[bgUrlMatch.length - 1];
        const urlVal = lastBg.match(/data-bg-url=["']([^"']+)["']/i)?.[1];
        if (urlVal && /\.(jpg|jpeg|png|webp)(\?|$)/i.test(urlVal)) {
          try { src = new URL(urlVal, baseUrl).toString(); } catch {}
        }
      }
    }
    if (!src) continue;
    const combined = src + " " + alt + " " + tag;
    const isIcon = /icon|logo|arrow|chevron|social|facebook|twitter|instagram|linkedin|badge|flag|button|decorative/i.test(combined);
    if (isIcon) continue;
    allImgs.push({ tag, pos: imgMatch.index!, src, alt });
  }

  const teamSectionStart = (() => {
    const teamHeadingMatch = cleaned.match(/<h[1-4][^>]*>[\s\S]*?(?:meet\s+(?:our\s+)?team|our\s+team|nuestro\s+equipo|conozca\s+(?:a\s+)?(?:nuestro\s+)?equipo|(?:our\s+)?staff|(?:our\s+)?doctors?|(?:our\s+)?physicians?|(?:our\s+)?providers?)[\s\S]*?<\/h[1-4]>/i);
    return teamHeadingMatch ? teamHeadingMatch.index! : -1;
  })();

  const personImgs = allImgs.filter(img => {
    const srcFilename = decodeURIComponent(img.src.split("/").pop() || "");
    const combined = img.src + " " + img.alt + " " + img.tag;
    const isHeadshot = /headshot|portrait|team|staff|photo|doctor|profile|member|bio|physician|expert|thumb/i.test(combined);
    const hasPersonName = looksLikePersonName(img.alt) || looksLikePersonName(srcFilename.replace(/\.\w+$/, ""));
    const isBanner = /banner|hero|bg-|background|sidebar|cta|header/i.test(combined);
    const isPersonPhoto = /\.(jpg|jpeg|png|webp)(\?|$)/i.test(img.src) && !isBanner;
    const srcFilenameClean = srcFilename.replace(/\.\w+$/, "").replace(/-\d+x\d+/, "").replace(/-circle|-round|-min|-updated/gi, "");
    const hasSinglePersonName = /^[A-Z][a-z]+$/.test(srcFilenameClean.replace(/[_-]/g, " ").trim());
    const inTeamSection = teamSectionStart >= 0 && img.pos > teamSectionStart && isPersonPhoto;
    return isHeadshot || hasPersonName || hasSinglePersonName || (isPersonPhoto && img.alt.length > 3) || inTeamSection;
  });

  if (personImgs.length === 0) {
    if (teamSectionStart >= 0) {
      const teamText = cleaned
        .slice(teamSectionStart, teamSectionStart + 30000)
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&#?\w+;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (teamText.length > 50) {
        return `[TEAM TEXT (no photos found)]\n${teamText}`.slice(0, 60000);
      }
    }
    return "";
  }

  const blocks: string[] = [];
  for (const img of personImgs) {
    const contextStart = Math.max(0, img.pos - 1000);
    const contextEnd = Math.min(cleaned.length, img.pos + img.tag.length + 1000);
    const context = cleaned.slice(contextStart, contextEnd);
    const text = context.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&#?\w+;/g, " ").replace(/\s+/g, " ").trim();
    blocks.push(`[PERSON] photoUrl="${img.src}" alt="${img.alt}" NEARBY_TEXT: ${text}`);
  }

  return blocks.join("\n\n").slice(0, 60000);
}


function isLocationPage(url: string): boolean {
  return /\/locations?\/[a-z]/i.test(url);
}

function extractAddressFromHtml(html: string): string {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const addressSections = cleaned.match(/<[^>]*(?:address|location-info|contact-info|location-detail)[^>]*>[\s\S]*?<\/(?:div|section|address)>/gi);
  if (addressSections) {
    return addressSections.map(s => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).join("\n");
  }

  const text = cleaned.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const addressPatterns = text.match(/\d+\s+[\w\s]+(?:St|Ave|Blvd|Rd|Dr|Way|Lane|Ln|Court|Ct|Circle|Pkwy|Suite|Ste|Highway|Hwy|Boulevard|Avenue|Street|Road|Drive|Place|Pl)[^,]*,\s*[\w\s]+,\s*[A-Z]{2}\s*\d{5}/g);
  if (addressPatterns) {
    return addressPatterns.join("\n");
  }

  return "";
}

function cleanAddressPrefix(addr: string): string {
  return addr.replace(/^[\d\s()-]{4,}\s+(?=\d)/, "").replace(/^.*?(?:appointment|call|phone|fax|tel)\s+/i, "").trim();
}

function parseUsAddressFromText(text: string): { address: string | null; city: string | null; state: string | null; zip: string | null } | null {
  const withZip = text.match(/(\d+[\w\s.,#'-]+),\s*([A-Za-z\s]+),\s*([A-Z]{2})\s+(\d{5})/);
  if (withZip) {
    return { address: cleanAddressPrefix(withZip[1].trim()), city: withZip[2].trim(), state: withZip[3], zip: withZip[4] };
  }
  const withUsa = text.match(/(\d+[\w\s.,#'-]+),\s*([A-Za-z\s]+),\s*([A-Z]{2}),?\s*USA/);
  if (withUsa) {
    return { address: cleanAddressPrefix(withUsa[1].trim()), city: withUsa[2].trim(), state: withUsa[3], zip: null };
  }
  const suiteCity = text.match(/((?:Suite|Ste)\s+\w+),\s*([A-Za-z\s]+),\s*([A-Z]{2}),?\s*(?:USA|\d{5})?/);
  if (suiteCity) {
    return { address: suiteCity[1].trim(), city: suiteCity[2].trim(), state: suiteCity[3], zip: null };
  }
  return null;
}

function extractStructuredAddress(html: string): { address: string | null; city: string | null; state: string | null; zip: string | null } | null {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const addrBlocks = cleaned.match(/<[^>]*(?:address|location-info|contact-info|location-detail|hero-address|clinic-address)[^>]*>[\s\S]*?<\/(?:div|section|address|p|span)>/gi);
  if (addrBlocks) {
    for (const block of addrBlocks) {
      const blockText = block.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      const parsed = parseUsAddressFromText(blockText);
      if (parsed) return parsed;
    }
  }

  const text = cleaned.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#?\w+;/g, " ").replace(/\s+/g, " ");
  const usaPatterns = text.match(/\d+\s+[\w\s.,#'-]+,\s*[A-Za-z\s]+,\s*[A-Z]{2},?\s*USA/g);
  if (usaPatterns) {
    for (const p of usaPatterns) {
      const parsed = parseUsAddressFromText(p.trim());
      if (parsed) return parsed;
    }
  }

  const zipPatterns = text.match(/\d+\s+[\w\s.,#'-]+,\s*[A-Za-z\s]+,\s*[A-Z]{2}\s+\d{5}/g);
  if (zipPatterns) {
    for (const p of zipPatterns) {
      const parsed = parseUsAddressFromText(p.trim());
      if (parsed) return parsed;
    }
  }

  return null;
}

export async function scrapeProviderWebsite(websiteUrl: string): Promise<ScrapedProviderData> {
  const normalizedUrl = normalizeUrl(websiteUrl);

  const mainFetch = await fetchHtml(normalizedUrl);
  const mainHtml = mainFetch.html;
  const effectiveUrl = mainFetch.finalUrl || normalizedUrl;
  if (effectiveUrl !== normalizedUrl) {
    console.log(`[scraper] Redirect detected: ${normalizedUrl} → ${effectiveUrl}`);
  }
  const subpageUrls = findSubpageUrls(mainHtml, effectiveUrl);

  const jsonLdData = extractJsonLd(mainHtml);
  const allTelPhones: string[] = [...extractTelLinks(mainHtml)];
  const globalImgAltMap = buildImgAltMap(mainHtml, effectiveUrl);

  if (jsonLdData.phones.length > 0) console.log(`[scraper] JSON-LD phones found: ${jsonLdData.phones.join(", ")}`);
  if (jsonLdData.addresses.length > 0) console.log(`[scraper] JSON-LD addresses found: ${jsonLdData.addresses.length}`);
  if (jsonLdData.teamMembers.length > 0) console.log(`[scraper] JSON-LD team members found: ${jsonLdData.teamMembers.length}`);
  if (allTelPhones.length > 0) console.log(`[scraper] tel: link phones found: ${allTelPhones.join(", ")}`);

  const pages: { url: string; text: string; teamHtml: string }[] = [];

  const mainMeta = extractMetaAndLogos(mainHtml);
  const mainText = extractCleanText(mainHtml);
  const mainTeamHtml = extractTeamSectionHtml(mainHtml, effectiveUrl);
  pages.push({ url: effectiveUrl, text: `${mainMeta}\n\nTEXT:\n${mainText}`, teamHtml: mainTeamHtml });

  const subpageFetches = subpageUrls.map(async (url) => {
    try {
      const fetched = await fetchHtml(url);
      const text = extractCleanText(fetched.html);
      const teamHtml = extractTeamSectionHtml(fetched.html, url);
      return { url, text, teamHtml, html: fetched.html };
    } catch {
      return null;
    }
  });

  const subpageResults = await Promise.all(subpageFetches);

  let locationSubpageUrls: string[] = [];
  const mainLocUrls = findLocationSubpageUrls(mainHtml, effectiveUrl);
  console.log(`[scraper] Found ${mainLocUrls.length} location links on main page`);
  locationSubpageUrls.push(...mainLocUrls);

  for (const result of subpageResults) {
    if (result) {
      pages.push({ url: result.url, text: result.text, teamHtml: result.teamHtml });
      console.log(`[scraper] Fetched subpage: ${result.url} (${result.text.length} chars, team: ${result.teamHtml.length} chars)`);
      const locUrls = findLocationSubpageUrls(result.html, result.url);
      if (locUrls.length > 0) {
        console.log(`[scraper] Found ${locUrls.length} location sub-links on ${result.url}`);
        locationSubpageUrls.push(...locUrls);
      }
      allTelPhones.push(...extractTelLinks(result.html));
      const subAltMap = buildImgAltMap(result.html, result.url);
      for (const [k, v] of subAltMap) {
        if (!globalImgAltMap.has(k)) globalImgAltMap.set(k, v);
      }
    }
  }

  const alreadyFetched = new Set(pages.map(p => p.url));
  locationSubpageUrls = [...new Set(locationSubpageUrls)].filter(u => !alreadyFetched.has(u));
  console.log(`[scraper] Total unique location sub-pages to fetch: ${locationSubpageUrls.length}`);

  let locationAddresses: string[] = [];
  let locationTeamHtmlParts: string[] = [];
  const memberLocationMap = new Map<string, Set<string>>();
  const locationCityMap = new Map<string, string>();
  let scrapedLocationPages: Array<{ url: string; locationName: string; address: string; html: string }> = [];
  if (locationSubpageUrls.length > 0) {
    const locFetches = locationSubpageUrls.slice(0, 8).map(async (url) => {
      try {
        const fetched = await fetchHtml(url, 15000);
        const html = fetched.html;
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const locationName = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").replace(/\|.*$/, "").trim() : url.split("/").pop()?.replace(/-/g, " ") || "";
        const address = extractAddressFromHtml(html);
        const text = extractCleanText(html);
        const teamHtml = extractTeamSectionHtml(html, url);
        console.log(`[scraper] Location page: ${locationName} | address: ${address ? 'found' : 'not found'} | team: ${teamHtml ? 'found' : 'none'}`);
        return { url, locationName, address, text: text.slice(0, 3000), teamHtml, html };
      } catch (err: any) {
        console.log(`[scraper] Failed to fetch location page ${url}: ${err.message}`);
        return null;
      }
    });
    const locResults = await Promise.all(locFetches);
    for (const loc of locResults) {
      if (loc) {
        const entry = `Location: ${loc.locationName}${loc.address ? " | Address: " + loc.address : ""}\n${loc.text}`;
        locationAddresses.push(entry);
        scrapedLocationPages.push({ url: loc.url, locationName: loc.locationName, address: loc.address, html: loc.html });
        const cityFromUrl = loc.url.split("/").pop()?.replace(/-/g, " ") || "";
        const cityFromName = loc.locationName
          .replace(/^.*(?:in|en|–|-)\s+/i, "")
          .replace(/\s*\|.*$/, "")
          .trim();
        if (cityFromName.length > 2) {
          locationCityMap.set(cityFromName.toLowerCase(), loc.locationName);
        }
        if (cityFromUrl.length > 2 && cityFromUrl !== cityFromName.toLowerCase()) {
          locationCityMap.set(cityFromUrl.toLowerCase(), loc.locationName);
        }
        if (loc.teamHtml) {
          locationTeamHtmlParts.push(loc.teamHtml);
          const altMatches = loc.teamHtml.match(/alt="([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)"/g) || [];
          for (const m of altMatches) {
            const personName = m.replace(/alt="([^"]+)"/, "$1").trim();
            const key = personName.toLowerCase().replace(/[^a-z]/g, "");
            if (!memberLocationMap.has(key)) memberLocationMap.set(key, new Set());
            memberLocationMap.get(key)!.add(loc.locationName);
          }
        }
      }
    }
  }
  console.log(`[scraper] Extracted ${locationAddresses.length} location entries for AI prompt`);
  console.log(`[scraper] Location city keywords: ${[...locationCityMap.keys()].join(", ")}`);
  console.log(`[scraper] Mapped ${memberLocationMap.size} members to locations from location pages`);

  let doctorSubpageUrls: string[] = [];
  const doctorPagePattern = /\/(?:physicians?|doctors?|specialists?|providers?|teams?|staff|members?|people|faculty)\//i;
  for (const result of subpageResults) {
    if (result && doctorPagePattern.test(result.url)) {
      const docUrls = findDoctorSubpageUrls(result.html, result.url);
      doctorSubpageUrls.push(...docUrls);
    }
  }
  const mainDocUrls = findDoctorSubpageUrls(mainHtml, effectiveUrl);
  console.log(`[scraper] findDoctorSubpageUrls found ${mainDocUrls.length} from main page`);
  doctorSubpageUrls.push(...mainDocUrls);

  const physicianBasePath = doctorSubpageUrls.length > 0
    ? new URL(doctorSubpageUrls[0]).pathname.replace(/\/[^/]+$/, "")
    : null;

  const allTeamSources = [
    ...pages.filter(p => p.teamHtml).map(p => p.teamHtml),
    ...locationTeamHtmlParts,
  ].join("\n");
  const altNames = allTeamSources.match(/alt="([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)"/g) || [];
  const discoveredNames = new Set<string>();
  for (const m of altNames) {
    const name = m.replace(/alt="([^"]+)"/, "$1").trim();
    if (name.length > 3) discoveredNames.add(name);
  }

  const personBlocksForNames = allTeamSources.match(/\[PERSON\][^\n]+/g) || [];
  for (const block of personBlocksForNames) {
    const altMatch = block.match(/alt="([^"]+)"/);
    if (altMatch && looksLikePersonName(altMatch[1])) {
      discoveredNames.add(altMatch[1].trim());
    }
    const nearbyText = block.replace(/.*NEARBY_TEXT:\s*/, "");
    const leadingNames = nearbyText.match(/^(?:Dr\.?\s+)?([A-Z][a-z]{1,15}\s+(?:[A-Z]\.?\s+)?[A-Z][a-z]{1,20})/);
    if (leadingNames) {
      const cleaned = leadingNames[0].replace(/^Dr\.?\s+/, "").trim();
      if (cleaned.length > 5 && looksLikePersonName(cleaned)) {
        discoveredNames.add(cleaned);
      }
    }
    const drNames = nearbyText.match(/Dr\.?\s+([A-Z][a-z]{1,15}\s+(?:[A-Z]\.?\s+)?[A-Z][a-z]{1,20})/g) || [];
    for (const raw of drNames) {
      const cleaned = raw.replace(/^Dr\.?\s+/, "").trim();
      if (cleaned.length > 5 && looksLikePersonName(cleaned)) {
        discoveredNames.add(cleaned);
      }
    }
  }
  console.log(`[scraper] Discovered ${discoveredNames.size} unique team member names for physician page lookup`);

  if (physicianBasePath) {
    const base = new URL(effectiveUrl);
    for (const name of discoveredNames) {
      const slug = name.toLowerCase().replace(/\s+/g, "-");
      const candidateUrl = `${base.origin}${physicianBasePath}/${slug}`;
      doctorSubpageUrls.push(candidateUrl);
    }
  }

  function extractBioFromHtml(html: string): string {
    let bio = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1] || "";
    const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)?.[1] || "";
    if (ogDesc.length > bio.length && !/✓|telehealth|consult.*available/i.test(ogDesc)) {
      bio = ogDesc;
    }
    const shouldFallbackToBody = !bio || bio.length < 50 || /^✓|telehealth|consult.*available/i.test(bio);
    if (shouldFallbackToBody) {
      if (/^✓/.test(bio)) bio = bio.replace(/^(?:✓[^.]*\.?\s*)+/g, "").trim();
      const bodyText = extractCleanText(html);
      const bioSection = bodyText.match(/(?:biograf[íiy]a?|about|bio|background|profile|experience|trayectoria)\s*[:\-]?\s*([\s\S]{50,2000}?)(?=\n\n|\b(?:education|publicat|awards?|contact|schedule|book|certificat|formaci[oó]n|estudios)\b)/i);
      if (bioSection) {
        const cleaned = bioSection[1].replace(/\s+/g, " ").trim();
        if (cleaned.length > bio.length) bio = cleaned;
      }
      if (!bio || bio.length < 50) {
        const cleanBody = bodyText.replace(/^[\s\S]*?(?=Dr[a.]?\.|Board|Specializ|is a |graduated|has more than|[Ee]s un|[Ee]specialista|[Mm][eé]dic[oa])/i, "").slice(0, 3000);
        const sentences = cleanBody.split(/(?<=[.!?])\s+/).filter(s => s.length > 20 && s.length < 500);
        const bioSentences = sentences
          .filter(s => /board.certified|reproductive|endocrinolog|specializ|fellowship|medical school|residency|professor|clinical|university|graduated|surgeon|gynecolog|obstet|fertility|experience|ginec[oó]log|reproducci[oó]n|universidad|especialista|subespecialidad/i.test(s))
          .slice(0, 4);
        if (bioSentences.length > 0 && bioSentences.join(" ").length > bio.length) {
          bio = bioSentences.join(" ");
        }
      }
    }
    return bio;
  }

  let doctorProfiles: string[] = [];
  let doctorTeamHtmlParts: string[] = [];

  for (const result of subpageResults) {
    if (result && doctorPagePattern.test(result.url)) {
      const titleMatch = result.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const pageTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";
      if (/not found|404|error/i.test(pageTitle)) continue;
      const bio = extractBioFromHtml(result.html);
      const doctorName = pageTitle.replace(/\|.*$/, "").trim() || result.url.split("/").filter(Boolean).pop()?.replace(/-/g, " ") || "";
      const text = extractCleanText(result.html).slice(0, 4000);
      const bodyContent = extractMainBodyContent(result.html);
      console.log(`[scraper] Doctor page (subpage): ${doctorName} | bio: ${bio ? bio.slice(0, 80) : 'not found'}`);
      doctorProfiles.push(`Doctor: ${doctorName}\nBio: ${bio}\nBody: ${bodyContent}\n${text}`);
      alreadyFetched.add(result.url);
    }
  }

  doctorSubpageUrls = [...new Set(doctorSubpageUrls)].filter(u => !alreadyFetched.has(u) && !u.includes("//", 8));
  console.log(`[scraper] Found ${doctorSubpageUrls.length} additional doctor sub-pages to fetch`);

  if (doctorSubpageUrls.length > 0) {
    const docFetches = doctorSubpageUrls.slice(0, 50).map(async (url) => {
      try {
        const fetched = await fetchHtml(url);
        const html = fetched.html;
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const pageTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";
        if (/not found|404|error/i.test(pageTitle)) {
          console.log(`[scraper] Doctor page 404: ${url}`);
          return null;
        }
        const bio = extractBioFromHtml(html);
        const doctorName = pageTitle.replace(/\|.*$/, "").trim() || url.split("/").pop()?.replace(/-/g, " ") || "";
        const teamHtml = extractTeamSectionHtml(html, url);
        const text = extractCleanText(html).slice(0, 4000);
        const bodyContent = extractMainBodyContent(html);
        console.log(`[scraper] Doctor page: ${doctorName} | bio: ${bio ? bio.slice(0, 80) : 'not found'}`);
        return { url, doctorName, bio, text, bodyContent, teamHtml };
      } catch (err: any) {
        console.log(`[scraper] Failed to fetch doctor page ${url}: ${err.message}`);
        return null;
      }
    });
    const docResults = await Promise.all(docFetches);
    for (const doc of docResults) {
      if (doc) {
        doctorProfiles.push(`Doctor: ${doc.doctorName}\nBio: ${doc.bio}\nBody: ${doc.bodyContent}\n${doc.text}`);
        if (doc.teamHtml) {
          doctorTeamHtmlParts.push(`\n=== TEAM DATA FROM: ${doc.url} ===\n${doc.teamHtml}\n`);
        }
      }
    }
  }
  console.log(`[scraper] Extracted ${doctorProfiles.length} doctor profiles total`);

  if (locationCityMap.size > 0) {
    const cityKeywords = [...locationCityMap.entries()];
    for (const profile of doctorProfiles) {
      const nameMatch = profile.match(/^Doctor:\s*(.+)/m);
      if (!nameMatch) continue;
      const rawName = nameMatch[1].trim();
      const bioMatch = profile.match(/^Bio:\s*(.+)/m);
      const bodyMatch = profile.match(/^Body:\s*(.+)/m);
      const searchText = (bioMatch?.[1] || "") + " " + (bodyMatch?.[1] || "");
      const nameKey = rawName
        .replace(/,?\s*(MD|DO|PhD|MBA|FACOG|MSc|RN|NP|PA|FACS|Jr\.?|Sr\.?|III|II|IV)\b/gi, "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z]/g, "");
      const matchedLocs: string[] = [];
      for (const [city, locationName] of cityKeywords) {
        const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const cityRegex = new RegExp(`(?:^|[\\s,.:;\\-()/"'])${escaped}(?:[\\s,.:;\\-()/"']|$)`, "i");
        if (cityRegex.test(searchText)) {
          if (!memberLocationMap.has(nameKey)) memberLocationMap.set(nameKey, new Set());
          memberLocationMap.get(nameKey)!.add(locationName);
          matchedLocs.push(city);
        }
      }
      if (matchedLocs.length > 0) {
        console.log(`[scraper] Bio location match: ${rawName} → ${matchedLocs.join(", ")}`);
      }
    }
    console.log(`[scraper] After bio-based extraction: ${memberLocationMap.size} members mapped to locations`);
  }

  function normalizeNameKey(name: string): string {
    return name
      .replace(/,?\s*(MD|DO|PhD|MBA|FACOG|MSc|RN|NP|PA|FACS|Jr\.?|Sr\.?|III|II|IV)\b/gi, "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
  }

  const doctorBioMap = new Map<string, string>();
  const doctorTitleMap = new Map<string, string>();
  const doctorPhotoMap = new Map<string, string>();
  for (const profile of doctorProfiles) {
    const nameMatch = profile.match(/^Doctor:\s*(.+)/m);
    const bioMatch = profile.match(/^Bio:\s*(.+)/m);
    if (nameMatch) {
      const rawName = nameMatch[1].trim();
      const nameKey = normalizeNameKey(rawName);
      if (bioMatch && bioMatch[1].trim().length > 10) {
        doctorBioMap.set(nameKey, bioMatch[1].trim());
      }
      const credMatch = rawName.match(/,?\s*((?:MD|DO|PhD|MBA|FACOG|MSc|HCLD)[A-Za-z,\s]*)/);
      if (credMatch) {
        const creds = credMatch[1].replace(/^,?\s*/, "").trim();
        if (creds.length > 0 && !doctorTitleMap.has(nameKey)) {
          doctorTitleMap.set(nameKey, creds);
        }
      }
    }
  }

  console.log(`[scraper] Built maps from doctor profiles: ${doctorBioMap.size} bios, ${doctorTitleMap.size} titles`);

  let combinedText = "";
  let combinedTeamHtml = "";
  for (const page of pages) {
    combinedText += `\n=== PAGE: ${page.url} ===\n${page.text}\n`;
    if (page.teamHtml) {
      combinedTeamHtml += `\n=== TEAM DATA FROM: ${page.url} ===\n${page.teamHtml}\n`;
    }
  }
  for (const part of doctorTeamHtmlParts) {
    combinedTeamHtml += part;
  }

  const allLocationPersonBlocks = locationTeamHtmlParts.join("\n");
  const personBlockRegex = /\[PERSON\][^\n]+/g;
  const locPersonBlocks = allLocationPersonBlocks.match(personBlockRegex) || [];
  const seenPhotoUrls = new Set<string>();
  const existingPhotos = combinedTeamHtml.match(/photoUrl="([^"]+)"/g) || [];
  existingPhotos.forEach(m => seenPhotoUrls.add(m.replace(/photoUrl="([^"]+)"/, "$1")));
  const uniqueLocPersonBlocks: string[] = [];
  for (const block of locPersonBlocks) {
    const urlMatch = block.match(/photoUrl="([^"]+)"/);
    if (urlMatch && !seenPhotoUrls.has(urlMatch[1])) {
      seenPhotoUrls.add(urlMatch[1]);
      uniqueLocPersonBlocks.push(block);
    }
  }
  if (uniqueLocPersonBlocks.length > 0) {
    combinedTeamHtml += `\n=== ADDITIONAL TEAM FROM LOCATION PAGES ===\n${uniqueLocPersonBlocks.join("\n\n")}\n`;
    console.log(`[scraper] Found ${uniqueLocPersonBlocks.length} additional unique team members from location pages`);
  }

  const personBlocks = combinedTeamHtml.match(/\[PERSON\][^\n]+/g) || [];
  for (const block of personBlocks) {
    const photoMatch = block.match(/photoUrl="([^"]+)"/);
    const altMatch = block.match(/alt="([^"]+)"/);
    const nearbyText = block.replace(/.*NEARBY_TEXT:\s*/, "");

    if (!altMatch && !nearbyText) continue;

    const candidates = [altMatch?.[1] || ""];
    const namePatterns = nearbyText.match(/(?:Dr\.?\s+)?[A-Z][a-z]+\s+(?:[A-Z]\.?\s+)?[A-Z][a-z]+/g) || [];
    candidates.push(...namePatterns);

    for (const rawCandidate of candidates) {
      const candidate = rawCandidate.trim();
      if (candidate.length < 4 || !/[A-Z]/.test(candidate)) continue;
      const nameKey = normalizeNameKey(candidate);
      if (nameKey.length < 4) continue;

      if (photoMatch && !doctorPhotoMap.has(nameKey)) {
        doctorPhotoMap.set(nameKey, photoMatch[1]);
      }

      if (!doctorTitleMap.has(nameKey)) {
        const titleMatch = nearbyText.match(new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s,]+((?:MD|DO|PhD|FACOG|MBA|HCLD|REI|Reproductive Endocrinologist|Board Certified)[A-Za-z,\\s]*?)(?:\\s{2,}|Read |View |Learn |Schedule |Book |Contact |Meet |Our |$)", "i"));
        if (titleMatch) {
          let title = titleMatch[1].replace(/\s+/g, " ").trim();
          title = title.replace(/\s+(Read|View|Learn|Schedule|Book|Contact|Meet|Our).*$/i, "").trim();
          if (title.length > 1) doctorTitleMap.set(nameKey, title);
        }
      }

      if (!doctorBioMap.has(nameKey)) {
        const sentences = nearbyText.split(/(?<=[.!])\s+/).filter(s =>
          s.length > 30 && s.length < 500 &&
          /board.certified|reproductive|endocrinolog|specializ|fellowship|medical school|residency|fertility|obstetrics/i.test(s) &&
          !/Our team|every step|here for you|Learn more|Read more|Schedule|Book|Contact us/i.test(s)
        );
        if (sentences.length > 0) {
          doctorBioMap.set(nameKey, sentences.slice(0, 2).join(" "));
        }
      }
    }
  }
  console.log(`[scraper] After team HTML parsing: ${doctorBioMap.size} bios, ${doctorTitleMap.size} titles, ${doctorPhotoMap.size} photos`);

  if (locationAddresses.length > 0) {
    combinedText += `\n=== INDIVIDUAL LOCATION PAGES (${locationAddresses.length} locations found) ===\n`;
    combinedText += locationAddresses.join("\n---\n");
    combinedText += "\n";
  }

  if (doctorProfiles.length > 0) {
    combinedText += `\n=== INDIVIDUAL DOCTOR/PHYSICIAN PAGES (${doctorProfiles.length} found) ===\n`;
    combinedText += doctorProfiles.join("\n---\n");
    combinedText += "\n";
  }

  combinedText = combinedText.slice(0, 400000);
  combinedTeamHtml = combinedTeamHtml.slice(0, 40000);

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      thinkingConfig: { thinkingBudget: 0 },
    } as any,
  });

  const teamSection = combinedTeamHtml
    ? `\n\nTEAM MEMBER RAW DATA (contains img tags with src URLs near team member names - use these to find photo URLs):\n---\n${combinedTeamHtml}\n---`
    : "";

  let jsonLdSection = "";
  if (jsonLdData.phones.length > 0 || jsonLdData.addresses.length > 0 || jsonLdData.teamMembers.length > 0 || jsonLdData.name) {
    const parts: string[] = [];
    if (jsonLdData.name) parts.push(`Name: ${jsonLdData.name}`);
    if (jsonLdData.description) parts.push(`Description: ${jsonLdData.description}`);
    if (jsonLdData.phones.length > 0) parts.push(`Phone(s): ${jsonLdData.phones.join(", ")}`);
    if (jsonLdData.logoUrl) parts.push(`Logo: ${jsonLdData.logoUrl}`);
    if (jsonLdData.addresses.length > 0) {
      parts.push(`Addresses:\n${jsonLdData.addresses.map(a => `  - ${[a.address, a.city, a.state, a.zip].filter(Boolean).join(", ")}`).join("\n")}`);
    }
    if (jsonLdData.teamMembers.length > 0) {
      parts.push(`Team Members:\n${jsonLdData.teamMembers.map(m => `  - ${m.name}${m.title ? ` (${m.title})` : ""}${m.photoUrl ? ` [photo: ${m.photoUrl}]` : ""}`).join("\n")}`);
    }
    jsonLdSection = `\n\nHIGH-CONFIDENCE STRUCTURED DATA (from JSON-LD - this data is machine-readable and highly reliable, prefer it over scraped text when available):\n---\n${parts.join("\n")}\n---`;
  }

  let telSection = "";
  const uniqueTelPhones = [...new Set(allTelPhones)];
  if (uniqueTelPhones.length > 0) {
    telSection = `\n\nPHONE NUMBERS FROM TEL: LINKS (found in clickable phone links on the site):\n${uniqueTelPhones.join(", ")}`;
  }

  const prompt = `You are analyzing a fertility clinic/agency website to extract structured profile information.

Website URL: ${effectiveUrl}
Pages analyzed: ${pages.map(p => p.url).join(", ")}

Here is the extracted text content from the website pages:
---
${combinedText}
---${teamSection}${jsonLdSection}${telSection}

Extract the following information and return ONLY a valid JSON object (no markdown, no code fences):

{
  "name": "The official business name of the provider",
  "about": "A 2-4 sentence professional description of the provider and what they do. Write it in third person.",
  "logoUrl": "The full absolute URL to their icon-only logo image (just the symbol/mark, without the company name text), or null if not found. Make sure to resolve relative URLs against ${effectiveUrl}",
  "logoWithNameUrl": "The full absolute URL to a logo image that includes the company name text next to or below the icon (a combined logo+wordmark image). This is typically a wider/horizontal image used in the website header. Return null if no such image is found or if it's the same as logoUrl. Resolve relative URLs against ${effectiveUrl}",
  "faviconUrl": "The full absolute URL to the website's favicon or apple-touch-icon. Look for <link rel='icon'>, <link rel='shortcut icon'>, or <link rel='apple-touch-icon'> tags. Prefer the largest PNG/ICO favicon available (not SVG). Resolve relative URLs against ${effectiveUrl}. Return null if not found.",
  "email": "Their contact email address, or null",
  "phone": "Their phone number, or null",
  "yearFounded": null or a number (the year they were founded/established, if mentioned),
  "locations": [
    {
      "address": "Street address or null",
      "city": "City name",
      "state": "State/province/region or null",
      "zip": "ZIP/postal code or null"
    }
  ],
  "suggestedServices": ["Choose ONLY the primary business type(s) from: IVF Clinic, Surrogacy Agency, Egg Donor Agency, Egg Bank, Sperm Bank"],
  "teamMembers": [
    {
      "name": "Full name of the team member",
      "title": "Their professional title (e.g. MD, CEO, Founder, Medical Director, etc.) or null",
      "bio": "A brief 1-2 sentence professional bio or null",
      "photoUrl": "Full absolute URL to their headshot/photo or null"
    }
  ]
}

Important rules:
- Only extract factual information visible on the pages. Do NOT make up information.
- For the "about" field, write a clean professional summary based on what you find. Do not copy marketing fluff.
- For logoUrl, look for img tags with "logo" in the src, alt, or class. Prefer the icon-only version (just the symbol/mark without text). Convert relative URLs to absolute.
- For logoWithNameUrl, look for a wider/horizontal logo image that includes the company name as part of the image (often found in the website header or navigation). This is typically a different file from the icon-only logo. If no separate logo+name image exists, set to null.
- For faviconUrl, look for <link rel="icon">, <link rel="shortcut icon">, or <link rel="apple-touch-icon"> tags in the FAVICONS section. Prefer the largest size available (e.g. 180x180, 192x192). If only /favicon.ico is available, resolve it to the full URL. Prefer PNG over ICO format when both exist.
- For locations, look for physical addresses EVERYWHERE: in the footer, contact page, individual location pages, anywhere on the site. Providers can be INTERNATIONAL - addresses may not follow US format. For international addresses, use the local street address format for "address", the city name for "city", and the country or region for "state". Examples: Colombian address "Calle 12 No. 39-60, Medellín" → address: "Calle 12 No. 39-60", city: "Medellín", state: "Colombia". If there is an "INDIVIDUAL LOCATION PAGES" section in the data, extract the address and city/state from each location listed there. IMPORTANT: Even if exact street addresses are not available, you MUST still create location entries using just the city and country/state. If the site mentions they have offices/clinics in multiple cities, create a location entry for EACH city with at least the city name filled in. Do NOT leave locations empty when city names are mentioned anywhere in the text. Extract ALL locations - do not skip any.
- For suggestedServices, classify the provider's PRIMARY business type(s). This is critical - understand the distinction:
  * "IVF Clinic" = A medical fertility clinic that performs IVF procedures, egg retrievals, embryo transfers. They may ALSO offer egg donation programs, surrogacy support, or egg freezing as part of their clinic services - but that does NOT make them an Egg Donor Agency, Surrogacy Agency, or Egg Bank.
  * "Surrogacy Agency" = A dedicated agency whose PRIMARY business is matching intended parents with gestational surrogates and managing the surrogacy journey. NOT an IVF clinic that works with surrogates.
  * "Egg Donor Agency" = A dedicated agency whose PRIMARY business is recruiting, screening, and matching egg donors with intended parents. NOT an IVF clinic that has an egg donor program.
  * "Egg Bank" = A dedicated bank that stores and ships frozen donor eggs. NOT an IVF clinic that offers egg freezing.
  * "Sperm Bank" = A dedicated bank that collects, stores, and distributes donor sperm.
  Most IVF clinics should ONLY be classified as "IVF Clinic" even if they mention egg donation, surrogacy, or egg freezing services.
- For teamMembers: Extract ALL team members found, including doctors, physicians, medical directors, and other staff. Look carefully at ALL data sources:
  * The TEAM MEMBER RAW DATA section contains img tags with src URLs near team member names and bios - use these to find photo URLs AND bios.
  * The INDIVIDUAL DOCTOR/PHYSICIAN PAGES section contains detailed bios from individual doctor pages - use these to populate the "bio" field.
  * The main text content may mention additional team members.
  * For photoUrl: look in the RAW DATA section for img src URLs near each person's name. The URLs are absolute. Do NOT leave photoUrl as null if there is an image near their name.
  * For bio: use the meta description or text from individual doctor pages. Write a clean 1-2 sentence professional bio. Do NOT leave bio as null if description text is available.
  * Include ALL doctors/physicians/specialists found - do not limit to a subset.
  * If the TEAM MEMBER RAW DATA block is empty or missing photos, explicitly scan the main text content for lists of doctors, embryologists, and nurses. Extract them even if no photo URL is available.
- Return ONLY the JSON object, nothing else.`;

  const yearFoundedPromise = searchYearFounded(jsonLdData.name || new URL(effectiveUrl).hostname, effectiveUrl);

  const result = await model.generateContent(prompt);
  const responseText = result.response.text().trim();

  let cleaned = responseText;
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Failed to parse AI response. Please try again.");
  }

  function cleanDoctorName(name: string): string {
    return name
      .replace(/,?\s*(MD|DO|PhD|MBA|FACOG|MSc|RN|NP|PA|FACS)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const isDonorOrClient = (name: string): boolean => {
    return /^(Donor|Surrogate|Client|Patient|Parent|Baby|Egg\s*Donor)\s*#?\d/i.test(name) ||
      /^#?\d+$/.test(name.trim()) ||
      /\bdonor\b.*#?\d/i.test(name);
  };

  const isMedicalDirectorTitle = (title: string | null, bio: string | null): boolean => {
    const combined = `${title || ""} ${bio || ""}`;
    return /medical director|chief medical|chief scientific|CMO\b/i.test(combined);
  };

  const isNonDoctorStaff = (title: string | null, name: string): boolean => {
    if (!title) return false;
    const t = title.toLowerCase();
    const nonDoctorPatterns = /\b(bacteri[oó]log|microbi[oó]log|bioanalista|andr[oó]log|psic[oó]log|lab\s*tech|laboratory\s*tech|sonograph|ultrasound\s*tech|medical\s*assistant|receptionist|billing|insurance\s*coord|office\s*manager|admin\s*assistant|scheduler|phlebotom|social\s*worker|nurse\s*aide|ma\b|cma\b)/i;
    if (!nonDoctorPatterns.test(t)) return false;
    const doctorOverride = /\b(doctor|médic[oa]|m[eé]dico|dr\.?|physician|ginec[oó]log|gynecolog|obstet|urolog|surgeon|cirujano|endocrinolog|director\s*(?:médic|medic|cient[ií]fic|scientific)|chief\s*(?:medical|scientific)|CMO|CEO|founder|co-?founder|president)\b/i;
    return !doctorOverride.test(t) && !doctorOverride.test(name);
  };

  const rawTeam: ScrapedTeamMember[] = Array.isArray(parsed.teamMembers)
    ? parsed.teamMembers
        .filter((m: any) => !isDonorOrClient(m.name || ""))
        .filter((m: any) => !isNonDoctorStaff(m.title, m.name || ""))
        .map((m: any) => ({
          name: cleanDoctorName(m.name || "Unknown"),
          title: m.title || null,
          bio: m.bio || null,
          photoUrl: m.photoUrl || null,
          isMedicalDirector: isMedicalDirectorTitle(m.title, m.bio),
          locationHints: [],
        }))
    : [];

  const teamMap = new Map<string, ScrapedTeamMember>();
  for (const m of rawTeam) {
    const nameKey = normalizeNameKey(m.name);
    const existing = teamMap.get(nameKey);
    if (!existing) {
      teamMap.set(nameKey, m);
    } else {
      if (!existing.photoUrl && m.photoUrl) existing.photoUrl = m.photoUrl;
      if (!existing.bio && m.bio) existing.bio = m.bio;
      if (!existing.title && m.title) existing.title = m.title;
      if (m.isMedicalDirector) existing.isMedicalDirector = true;
      if (m.name.length < existing.name.length) existing.name = m.name;
    }
  }

  for (const [nameKey, member] of teamMap) {
    if (!member.bio) {
      const bio = doctorBioMap.get(nameKey);
      if (bio) member.bio = bio;
    }
    const isTitleEmpty = !member.title || /^Dr\.?$/i.test(member.title.trim());
    if (isTitleEmpty) {
      const title = doctorTitleMap.get(nameKey);
      if (title) {
        member.title = title;
      } else if (member.bio) {
        const roleMatch = member.bio.match(/(?:is\s+(?:the\s+|a\s+)?)(Chief\s+\w+\s+Officer|(?:Medical|Scientific|Executive|Clinical|Lab(?:oratory)?)\s+Director|(?:Reproductive\s+)?Endocrinologist|(?:Laboratory|Lab)\s+Manager|Nurse\s+Practitioner|Physician\s+Assistant|(?:Embryology\s+)?Lab\s+Manager)/i);
        if (roleMatch) {
          member.title = roleMatch[1].trim();
        }
      }
    }
    if (!member.photoUrl) {
      const photo = doctorPhotoMap.get(nameKey);
      if (photo) member.photoUrl = photo;
    }
    if (!member.isMedicalDirector) {
      member.isMedicalDirector = isMedicalDirectorTitle(member.title, member.bio);
    }
    let locHints = memberLocationMap.get(nameKey);
    if (!locHints) {
      for (const [mapKey, mapValue] of memberLocationMap) {
        if (nameKey.startsWith(mapKey) || mapKey.startsWith(nameKey)) {
          locHints = mapValue;
          break;
        }
      }
    }
    if (locHints) {
      member.locationHints = Array.from(locHints);
    }
  }

  if (locationCityMap.size > 0) {
    const cityKeywords = [...locationCityMap.entries()];
    for (const [, member] of teamMap) {
      if (member.locationHints.length > 0) continue;
      const searchText = (member.bio || "") + " " + (member.title || "");
      if (!searchText.trim()) continue;
      for (const [city, locationName] of cityKeywords) {
        const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const cityRegex = new RegExp(`(?:^|[\\s,.:;\\-()/"'])${escaped}(?:[\\s,.:;\\-()/"']|$)`, "i");
        if (cityRegex.test(searchText)) {
          member.locationHints.push(locationName);
        }
      }
      if (member.locationHints.length > 0) {
        member.locationHints = [...new Set(member.locationHints)];
        console.log(`[scraper] AI bio location match: ${member.name} → ${member.locationHints.join(", ")}`);
      }
    }
  }

  const teamMembers = Array.from(teamMap.values());
  const biosFilledCount = teamMembers.filter(m => m.bio).length;
  const withLocCount = teamMembers.filter(m => m.locationHints.length > 0).length;
  console.log(`[scraper] Final team: ${teamMembers.length} members, ${biosFilledCount} with bios, ${withLocCount} with location hints`);

  let rawLocations: Array<{ address: string | null; city: string | null; state: string | null; zip: string | null }> =
    Array.isArray(parsed.locations) ? parsed.locations : [];

  rawLocations = rawLocations.filter(l => l.city || l.state || l.address);

  const stateNameToAbbr: Record<string, string> = {
    "alabama":"al","alaska":"ak","arizona":"az","arkansas":"ar","california":"ca","colorado":"co",
    "connecticut":"ct","delaware":"de","florida":"fl","georgia":"ga","hawaii":"hi","idaho":"id",
    "illinois":"il","indiana":"in","iowa":"ia","kansas":"ks","kentucky":"ky","louisiana":"la",
    "maine":"me","maryland":"md","massachusetts":"ma","michigan":"mi","minnesota":"mn","mississippi":"ms",
    "missouri":"mo","montana":"mt","nebraska":"ne","nevada":"nv","new hampshire":"nh","new jersey":"nj",
    "new mexico":"nm","new york":"ny","north carolina":"nc","north dakota":"nd","ohio":"oh","oklahoma":"ok",
    "oregon":"or","pennsylvania":"pa","rhode island":"ri","south carolina":"sc","south dakota":"sd",
    "tennessee":"tn","texas":"tx","utah":"ut","vermont":"vt","virginia":"va","washington":"wa",
    "west virginia":"wv","wisconsin":"wi","wyoming":"wy","district of columbia":"dc"
  };
  function normalizeState(s: string): string {
    const lower = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    return stateNameToAbbr[lower] || lower;
  }
  function makeCityKey(city: string, state: string): string {
    return `${city.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()}|${normalizeState(state)}`;
  }

  const cityMap = new Map<string, typeof rawLocations[0]>();

  if (scrapedLocationPages.length > 0) {
    for (const sp of scrapedLocationPages) {
      const directParsed = extractStructuredAddress(sp.html);
      if (directParsed && directParsed.city) {
        const cityKey = makeCityKey(directParsed.city, directParsed.state || "");
        if (!cityMap.has(cityKey)) {
          cityMap.set(cityKey, directParsed);
        }
      }
    }
    const directParsedCount = cityMap.size;
    console.log(`[scraper] Parsed ${directParsedCount} locations directly from ${scrapedLocationPages.length} scraped location pages`);

    const aiLocationsWithCity = rawLocations.filter(l => l.city);
    for (const loc of aiLocationsWithCity) {
      const cityKey = makeCityKey(loc.city || "", loc.state || "");
      const existing = cityMap.get(cityKey);
      if (!existing) {
        const city = (loc.city || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
        if (directParsedCount === 0) {
          const knownCityKeys = [...locationCityMap.keys()];
          if (knownCityKeys.includes(city) || knownCityKeys.some(k => k.includes(city))) {
            cityMap.set(cityKey, loc);
          }
        } else {
          const alreadyCoveredByScrapedPage = scrapedLocationPages.some(sp => {
            const nameNorm = sp.locationName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
            return nameNorm.includes(city);
          });
          if (!alreadyCoveredByScrapedPage) {
            const knownCityKeys = [...locationCityMap.keys()];
            if (knownCityKeys.includes(city) || knownCityKeys.some(k => k.includes(city))) {
              cityMap.set(cityKey, loc);
            }
          }
        }
      } else if (loc.address && !existing.address) {
        cityMap.set(cityKey, loc);
      }
    }

    if (directParsedCount === 0 && cityMap.size < scrapedLocationPages.length) {
      for (const sp of scrapedLocationPages) {
        const cityFromName = sp.locationName
          .replace(/^.*(?:in|en|–|-)\s+/i, "")
          .replace(/\s*\|.*$/, "")
          .trim();
        if (cityFromName.length <= 2) continue;
        const cityNorm = cityFromName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
        const alreadyHas = [...cityMap.keys()].some(k => {
          const existingCity = k.split("|")[0];
          return existingCity === cityNorm;
        });
        if (!alreadyHas) {
          const guessedState = rawLocations.find(l => l.state)?.state || null;
          cityMap.set(`${cityNorm}|${normalizeState(guessedState || "")}`, {
            address: null, city: cityFromName, state: guessedState, zip: null
          });
        }
      }
    }
    console.log(`[scraper] After merging AI locations: ${cityMap.size} total locations`);
  } else {
    if (locationCityMap.size > 0) {
      rawLocations = rawLocations.filter(l => l.city);
      const knownCityKeys = [...locationCityMap.keys()];
      const mainPageCities = mainText.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const filteredLocations = rawLocations.filter(l => {
        const city = (l.city || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
        if (!city) return true;
        if (knownCityKeys.includes(city)) return true;
        if (knownCityKeys.some(k => k.includes(city))) return true;
        const cityRegex = new RegExp(`(?:^|[\\s,.:;\\-()/"'])${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[\\s,.:;\\-()/"']|$)`, "i");
        return cityRegex.test(mainPageCities);
      });
      if (filteredLocations.length > 0) {
        rawLocations = filteredLocations;
        console.log(`[scraper] Filtered locations to ${rawLocations.length} matching known/main-page cities`);
      }
    }
    for (const loc of rawLocations) {
      const cityKey = makeCityKey(loc.city || "", loc.state || "");
      const existing = cityMap.get(cityKey);
      if (!existing) {
        cityMap.set(cityKey, loc);
      } else if (loc.address && !existing.address) {
        cityMap.set(cityKey, loc);
      }
    }
  }

  const usStates = new Set(["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC","alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware","florida","georgia","hawaii","idaho","illinois","indiana","iowa","kansas","kentucky","louisiana","maine","maryland","massachusetts","michigan","minnesota","mississippi","missouri","montana","nebraska","nevada","new hampshire","new jersey","new mexico","new york","north carolina","north dakota","ohio","oklahoma","oregon","pennsylvania","rhode island","south carolina","south dakota","tennessee","texas","utah","vermont","virginia","washington","west virginia","wisconsin","wyoming"]);
  const tldCountryMap: Record<string, string> = {
    ".co": "Colombia", ".mx": "Mexico", ".ar": "Argentina", ".br": "Brazil", ".cl": "Chile",
    ".pe": "Peru", ".ec": "Ecuador", ".ve": "Venezuela", ".uy": "Uruguay", ".py": "Paraguay",
    ".bo": "Bolivia", ".cr": "Costa Rica", ".pa": "Panama", ".gt": "Guatemala", ".do": "Dominican Republic",
    ".es": "Spain", ".pt": "Portugal", ".fr": "France", ".de": "Germany", ".it": "Italy",
    ".uk": "United Kingdom", ".au": "Australia", ".nz": "New Zealand", ".ca": "Canada",
    ".in": "India", ".jp": "Japan", ".kr": "South Korea", ".cn": "China", ".sg": "Singapore",
    ".za": "South Africa", ".il": "Israel", ".ae": "UAE", ".tr": "Turkey", ".gr": "Greece",
    ".cz": "Czech Republic", ".pl": "Poland", ".se": "Sweden", ".dk": "Denmark", ".no": "Norway",
    ".fi": "Finland", ".nl": "Netherlands", ".be": "Belgium", ".at": "Austria", ".ch": "Switzerland",
    ".ie": "Ireland", ".th": "Thailand", ".ph": "Philippines", ".my": "Malaysia", ".tw": "Taiwan",
  };
  const hostname = new URL(effectiveUrl).hostname;
  let detectedCountry: string | null = null;
  for (const [tld, country] of Object.entries(tldCountryMap)) {
    if (hostname.endsWith(tld) || hostname.endsWith(`.com${tld}`)) {
      detectedCountry = country;
      break;
    }
  }
  if (!detectedCountry) {
    const allStateValues = Array.from(cityMap.values()).map(l => (l.state || "").trim().toLowerCase()).filter(Boolean);
    const countryValues = Object.values(tldCountryMap).map(c => c.toLowerCase());
    for (const sv of allStateValues) {
      if (countryValues.includes(sv)) {
        detectedCountry = Object.values(tldCountryMap).find(c => c.toLowerCase() === sv) || null;
        break;
      }
    }
  }
  const knownCountries = new Set(Object.values(tldCountryMap).map(c => c.toLowerCase()));
  knownCountries.add("united states");
  knownCountries.add("usa");
  const dedupedLocations = Array.from(cityMap.values()).map(loc => {
    const stateVal = (loc.state || "").trim();
    const isUS = usStates.has(stateVal) || usStates.has(stateVal.toLowerCase());
    if (isUS) return loc;
    const isCountryAlready = knownCountries.has(stateVal.toLowerCase());
    if (!isCountryAlready && detectedCountry) {
      loc = { ...loc, state: detectedCountry };
    }
    if (loc.address) {
      loc = { ...loc, address: null };
    }
    return loc;
  });

  let yearFounded: number | null = typeof parsed.yearFounded === "number" ? parsed.yearFounded : await yearFoundedPromise;

  let finalPhone = parsed.phone || null;
  if (!finalPhone && jsonLdData.phones.length > 0) {
    finalPhone = jsonLdData.phones[0];
    console.log(`[scraper] Phone fallback: using JSON-LD phone: ${finalPhone}`);
  }
  if (!finalPhone && uniqueTelPhones.length > 0) {
    finalPhone = uniqueTelPhones[0];
    console.log(`[scraper] Phone fallback: using tel: link phone: ${finalPhone}`);
  }

  const normalizeNameKeyForAlt = (name: string): string => {
    return name
      .replace(/,?\s*(MD|DO|PhD|MBA|FACOG|MSc|RN|NP|PA|FACS|Jr\.?|Sr\.?|III|II|IV)\b/gi, "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
  };

  for (const member of teamMembers) {
    if (member.photoUrl) continue;
    const altKey = normalizeNameKeyForAlt(member.name);
    if (altKey.length >= 4) {
      const altMatch = globalImgAltMap.get(altKey);
      if (altMatch) {
        member.photoUrl = altMatch;
        console.log(`[scraper] Alt-tag photo match for ${member.name}: ${altMatch}`);
      }
    }
  }

  const membersNeedingPhotos = teamMembers.filter(m => !m.photoUrl);
  if (membersNeedingPhotos.length > 0 && membersNeedingPhotos.length <= 15) {
    console.log(`[scraper] Attempting photo directory guessing for ${membersNeedingPhotos.length} members...`);
    for (let i = 0; i < membersNeedingPhotos.length; i += 15) {
      const batch = membersNeedingPhotos.slice(i, i + 15);
      const results = await Promise.all(
        batch.map(async (member) => {
          const found = await guessPhotoUrls(member.name, effectiveUrl);
          return { member, found };
        })
      );
      for (const { member, found } of results) {
        if (found) {
          member.photoUrl = found;
          console.log(`[scraper] Directory guess photo found for ${member.name}: ${found}`);
        }
      }
    }
  }

  const finalPhotosCount = teamMembers.filter(m => m.photoUrl).length;
  console.log(`[scraper] Final team photos: ${finalPhotosCount}/${teamMembers.length}`);

  return {
    name: parsed.name || effectiveUrl,
    about: parsed.about || null,
    logoUrl: parsed.logoUrl || null,
    logoWithNameUrl: parsed.logoWithNameUrl || null,
    faviconUrl: parsed.faviconUrl || null,
    email: parsed.email || null,
    phone: finalPhone,
    yearFounded,
    websiteUrl: effectiveUrl,
    locations: dedupedLocations,
    suggestedServices: Array.isArray(parsed.suggestedServices) ? parsed.suggestedServices : [],
    teamMembers,
  };
}
