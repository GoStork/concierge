import { GoogleGenerativeAI } from "@google/generative-ai";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import { PrismaService } from "../prisma/prisma.service";
import { recalcAndPersistTotalCostsForProvider } from "../costs/total-cost.utils";
import type { StorageService } from "../storage/storage.service";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export function profileDataToText(profileData: any): string {
  if (!profileData) return "";
  const skipKeys = new Set(["Photos", "_sections", "photos", "All Photos"]);
  const parts: string[] = [];

  function flatten(obj: any, prefix = "") {
    if (!obj || typeof obj !== "object") return;
    for (const [key, value] of Object.entries(obj)) {
      if (skipKeys.has(key)) continue;
      if (Array.isArray(value)) {
        const stringVals = value.filter((v) => typeof v === "string" && !v.startsWith("/uploads/"));
        if (stringVals.length > 0) parts.push(`${prefix}${key}: ${stringVals.join(", ")}`);
      } else if (typeof value === "object" && value !== null) {
        flatten(value, `${key} > `);
      } else if (value !== null && value !== undefined && value !== "" && value !== "—" && value !== "--") {
        parts.push(`${prefix}${key}: ${value}`);
      }
    }
  }

  flatten(profileData);
  return parts.join("\n").slice(0, 8000);
}

async function generateProfileEmbedding(text: string): Promise<number[] | null> {
  if (!text || text.length < 20 || !process.env.OPENAI_API_KEY) return null;
  try {
    const response = await openaiClient.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    return response.data[0].embedding;
  } catch (e: any) {
    console.error("Embedding generation failed:", e.message);
    return null;
  }
}

export async function updateProfileEmbedding(
  prisma: PrismaService,
  table: "EggDonor" | "Surrogate" | "SpermDonor" | "Provider",
  id: string,
  profileData: any,
  extraText?: string,
): Promise<void> {
  let text = extraText || profileDataToText(profileData);

  if (table === "Provider") {
    try {
      const provider = await prisma.provider.findUnique({
        where: { id },
        select: {
          name: true,
          about: true,
          locations: { select: { city: true, state: true } },
          members: { select: { name: true, title: true, bio: true } },
          ivfSuccessRates: {
            where: { profileType: "own_eggs", metricCode: "live_births_per_intended_retrieval" },
            select: { ageGroup: true, successRate: true, cycleCount: true, nationalAverage: true, year: true },
            orderBy: { year: "desc" },
            take: 20,
          },
          services: { include: { providerType: { select: { name: true } } } },
        },
      });
      if (provider) {
        const parts: string[] = [];
        parts.push(`Clinic: ${provider.name}`);
        if (provider.about) parts.push(`About: ${provider.about}`);

        const serviceTypes = provider.services?.map((s: any) => s.providerType?.name).filter(Boolean);
        if (serviceTypes?.length) parts.push(`Services: ${serviceTypes.join(", ")}`);

        const locs = provider.locations?.map((l: any) => [l.city, l.state].filter(Boolean).join(", ")).filter(Boolean);
        if (locs?.length) parts.push(`Locations: ${locs.join("; ")}`);

        if (provider.members?.length) {
          for (const m of provider.members) {
            let memberLine = `Team member: ${m.name}`;
            if (m.title) memberLine += `, ${m.title}`;
            if (m.bio) memberLine += `. ${m.bio}`;
            parts.push(memberLine);
          }
        }

        if (provider.ivfSuccessRates?.length) {
          const ratesByAge: Record<string, any> = {};
          for (const r of provider.ivfSuccessRates) {
            const key = r.ageGroup || "unknown";
            if (!ratesByAge[key]) ratesByAge[key] = r;
          }
          const rateLines = Object.entries(ratesByAge).map(([age, r]: [string, any]) => {
            const rate = Number(r.successRate);
            const natl = Number(r.nationalAverage);
            const cycles = r.cycleCount;
            const comparison = rate > natl ? "above national average" : rate < natl ? "below national average" : "at national average";
            return `Age ${age.replace("_", "-")}: ${(rate * 100).toFixed(1)}% live birth rate (${comparison} of ${(natl * 100).toFixed(1)}%), ${cycles} cycles`;
          });
          parts.push(`IVF Success Rates: ${rateLines.join("; ")}`);
        }

        text = parts.join("\n").slice(0, 8000);
      }
    } catch (e: any) {
      console.error(`Failed to build provider embedding text for ${id}:`, e.message);
    }
  }

  if (!text) return;
  const embedding = await generateProfileEmbedding(text);
  if (!embedding) return;
  const vectorStr = `[${embedding.join(",")}]`;
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "${table}" SET "profileEmbedding" = $1::vector WHERE id = $2`,
      vectorStr,
      id,
    );
  } catch (e: any) {
    console.error(`Failed to save embedding for ${table} ${id}:`, e.message);
  }
}

export type DonorType = "egg-donor" | "surrogate" | "sperm-donor";

export interface MissingFieldSummary {
  field: string;
  count: number;
  donorIds: string[];
  donorUrls: Record<string, string>;
}

export interface SyncJob {
  id: string;
  providerId: string;
  type: DonorType;
  status: "running" | "completed" | "failed";
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  newProfiles: number;
  errors: string[];
  missingFields: MissingFieldSummary[];
  staleDonorsMarked: number;
  startedAt: Date;
  completedAt?: Date;
  isPdfUpload?: boolean;
  currentStep?: string;
  stepProgress?: number;
}

const syncJobs = new Map<string, SyncJob>();
const cancelledJobs = new Set<string>();

export function isJobCancelled(jobId: string): boolean {
  return cancelledJobs.has(jobId);
}

function generateJobId(): string {
  return `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

async function fetchHtml(url: string, cookies?: string, timeoutMs = 20000, maxChars = 500000): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (!url.startsWith('http')) {
    console.warn(`[donor-sync] fetchHtml caught invalid relative URL: ${url}`);
    return "";
  }
  try {
    const headers: Record<string, string> = { ...DEFAULT_HEADERS };
    if (cookies) {
      headers["Cookie"] = cookies;
    }
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const html = await response.text();
    return html.slice(0, maxChars);
  } finally {
    clearTimeout(timeout);
  }
}

function extractSetCookies(response: Response): string[] {
  const cookies: string[] = [];
  const setCookieHeaders = (response.headers as any).getSetCookie
    ? (response.headers as any).getSetCookie()
    : (response.headers.get("set-cookie") || "").split(/,(?=\s*\w+=)/);

  for (const header of setCookieHeaders) {
    if (!header) continue;
    const nameVal = header.trim().split(";")[0];
    if (nameVal && nameVal.includes("=")) {
      cookies.push(nameVal);
    }
  }
  return cookies;
}

async function authenticateAndGetCookies(
  loginPageUrl: string,
  username: string,
  password: string,
): Promise<string | null> {
  try {
    console.log(`[donor-sync] Attempting login at ${loginPageUrl}`);

    const loginResp = await fetch(loginPageUrl, {
      headers: DEFAULT_HEADERS,
      redirect: "follow",
    });
    const loginHtml = await loginResp.text();
    const initialCookies = extractSetCookies(loginResp);

    const formsWithAction = [...loginHtml.matchAll(/<form[^>]*action="([^"]*)"[^>]*method="post"/gi)];
    const formsWithActionReversed = [...loginHtml.matchAll(/<form[^>]*method="post"[^>]*action="([^"]*)"/gi)];
    const allForms = [...formsWithAction, ...formsWithActionReversed];
    const oauthKeywords = ["google", "facebook", "oauth", "saml", "sso", "openid", "microsoft"];
    const passwordFormAction = allForms
      .map((m) => m[1])
      .find((action) => !oauthKeywords.some((kw) => action.toLowerCase().includes(kw)));
    const formActionMatch = passwordFormAction || (allForms.length > 0 ? allForms[allForms.length - 1][1] : null);

    const hasPostFormWithoutAction = !formActionMatch &&
      /<form[^>]*method=["']?post["']?/i.test(loginHtml);

    const loginUrl = new URL(loginPageUrl);
    let postUrl: string;
    if (formActionMatch) {
      postUrl = new URL(formActionMatch, loginUrl).href;
    } else if (hasPostFormWithoutAction) {
      postUrl = loginPageUrl;
    } else {
      postUrl = loginUrl.origin + "/Account/Login";
    }
    let tokenValue: string | null = null;
    if (formActionMatch) {
      const formIdx = loginHtml.indexOf(`action="${formActionMatch}"`);
      if (formIdx >= 0) {
        const formSlice = loginHtml.substring(formIdx, formIdx + 2000);
        const sliceTokenMatch = formSlice.match(/name="__RequestVerificationToken"[^>]*value="([^"]*)"/);
        if (sliceTokenMatch) tokenValue = sliceTokenMatch[1];
      }
    }
    if (!tokenValue) {
      const globalTokenMatch = loginHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]*)"/);
      if (globalTokenMatch) tokenValue = globalTokenMatch[1];
    }

    const emailFieldMatch = loginHtml.match(
      /<input[^>]*name="([^"]*(?:email|username|user)[^"]*)"/i,
    );
    const passwordFieldMatch = loginHtml.match(
      /<input[^>]*type="password"[^>]*name="([^"]*)"/i,
    );

    const emailField = emailFieldMatch ? emailFieldMatch[1] : "Email";
    const passwordField = passwordFieldMatch ? passwordFieldMatch[1] : "Password";

    const body = new URLSearchParams();
    if (tokenValue) {
      body.set("__RequestVerificationToken", tokenValue);
    }
    body.set(emailField, username);
    body.set(passwordField, password);

    const cookieHeader = initialCookies.join("; ");

    const authResp = await fetch(postUrl, {
      method: "POST",
      headers: {
        ...DEFAULT_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        Referer: loginPageUrl,
        Origin: loginUrl.origin,
      },
      body: body.toString(),
      redirect: "manual",
    });

    const authCookies = extractSetCookies(authResp);
    const allCookies = [...initialCookies, ...authCookies];

    if (authResp.status >= 300 && authResp.status < 400) {
      const location = authResp.headers.get("location") || "";
      if (location.toLowerCase().includes("login")) {
        console.error(`[donor-sync] Login failed — redirected back to login page`);
        return null;
      }
      console.log(`[donor-sync] Login successful (redirect to ${location})`);

      const followResp = await fetch(new URL(location, loginUrl).href, {
        headers: {
          ...DEFAULT_HEADERS,
          Cookie: allCookies.join("; "),
        },
        redirect: "manual",
      });
      const followCookies = extractSetCookies(followResp);
      const authCookieNames = new Set(authCookies.map(c => c.split("=", 1)[0]));
      const safeFollowCookies = followCookies.filter(c => !authCookieNames.has(c.split("=", 1)[0]));
      allCookies.push(...safeFollowCookies);
    } else if (authResp.status === 200) {
      const responseText = await authResp.text();
      if (responseText.toLowerCase().includes("sign in") && responseText.toLowerCase().includes("password")) {
        console.error(`[donor-sync] Login failed — still on login page`);
        return null;
      }
      console.log(`[donor-sync] Login successful (200 OK)`);
    } else {
      console.error(`[donor-sync] Login returned unexpected status ${authResp.status}`);
      return null;
    }

    const cookieMap = new Map<string, string>();
    for (const c of allCookies) {
      const [name] = c.split("=", 1);
      cookieMap.set(name, c);
    }
    const dedupedCookies = Array.from(cookieMap.values()).join("; ");
    console.log(`[donor-sync] Authenticated with ${cookieMap.size} cookies`);
    return dedupedCookies;
  } catch (err: any) {
    console.error(`[donor-sync] Authentication error: ${err.message}`);
    return null;
  }
}

function cleanHtml(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 100000);
}

function findProfileLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const linkRegex = /<a[^>]+href=["']([^"'#]+)["'][^>]*>/gi;
  const links: string[] = [];
  const seen = new Set<string>();
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1];
    if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;
    try {
      const resolved = new URL(href, base).href;
      if (!seen.has(resolved) && resolved.startsWith(base.origin)) {
        seen.add(resolved);
        links.push(resolved);
      }
    } catch {}
  }
  return links;
}

const EGG_DONOR_EXTRACTION_PROMPT = `You are extracting egg donor profiles from a fertility clinic/agency website. 
Extract ALL donor profiles visible on this page. For each donor, extract the following GoStork fields:

- externalId: The donor's ID number/code (e.g. "048762", "D-1234")
- donorType: "Fresh Donor" or "Frozen Eggs" or "Fresh & Frozen" if indicated
- age: Integer age
- eyeColor: Eye color
- hairColor: Hair color
- race: Race(s)
- ethnicity: Ethnicity/ethnicities
- religion: Religion
- height: Height (include units)
- weight: Weight (include units)
- education: Education level
- location: City/State/Country
- donationTypes: Types of donation (e.g. "Semi Open, Anonymous")
- relationshipStatus: Relationship status
- occupation: Occupation
- donorCompensation: For Fresh Donors - the egg donor compensation amount as a number (no $ sign). This is a fee paid to the donor and is part of the total cost. NULL for frozen egg donors.
- eggLotCost: For Frozen Egg Donors - the egg lot cost/price as a number (no $ sign). This is the price for the frozen egg lot. NULL for fresh donors.
- totalCost: Total cost/compensation as a number (no $ sign). For fresh donors this includes donor compensation + agency fees. For frozen donors this equals the egg lot cost.
- status: "AVAILABLE", "MATCHED", "ON_HOLD", or "INACTIVE"
- photoUrl: URL to the donor's photo if visible

Return a JSON object with this exact structure:
{
  "donors": [
    {
      "externalId": "string or null",
      "donorType": "string or null",
      "age": number or null,
      "eyeColor": "string or null",
      "hairColor": "string or null",
      "race": "string or null",
      "ethnicity": "string or null",
      "religion": "string or null",
      "height": "string or null",
      "weight": "string or null",
      "education": "string or null",
      "location": "string or null",
      "donationTypes": "string or null",
      "relationshipStatus": "string or null",
      "occupation": "string or null",
      "donorCompensation": number or null,
      "eggLotCost": number or null,
      "totalCost": number or null,
      "status": "AVAILABLE",
      "photoUrl": "string or null"
    }
  ],
  "profileLinks": ["array of URLs to individual donor profile pages found on this page"],
  "paginationLinks": ["array of URLs to next pages of donor listings"],
  "totalDonorsOnPage": number
}

IMPORTANT RULES:
- Extract ALL donors visible, even if only partial information is shown
- If a listing page shows donor cards/thumbnails with links to detail pages, include those URLs in profileLinks
- If you see pagination (Next, page 2, etc.), include those URLs in paginationLinks  
- Resolve all relative URLs to absolute using the base URL provided
- Return ONLY the JSON object, no markdown formatting or explanation`;

const SURROGATE_EXTRACTION_PROMPT = `You are extracting surrogate profiles from a surrogacy agency website.
Extract ALL surrogate profiles visible on this page. For each surrogate, extract the following GoStork fields:

- externalId: The surrogate's ID number/code (e.g. "001088", "S-1234")
- age: Integer age
- bmi: BMI as a number
- baseCompensation: Base compensation amount as a number (no $ sign)
- totalCompensationMin: Minimum total compensation as a number (no $ sign)
- totalCompensationMax: Maximum total compensation as a number (no $ sign)
- location: City, State, Country
- agreesToAbortion: true/false/null - whether they agree to abortion/selective reduction
- agreesToTwins: true/false/null - whether they agree to carry twins
- covidVaccinated: true/false/null
- liveBirths: Number of live births (integer)
- miscarriages: Number of miscarriages (integer)
- cSections: Number of C-sections (integer)
- relationshipStatus: Relationship status (e.g. "Married", "Single")
- openToSameSexCouple: true/false/null
- occupation: Occupation or job title
- lastDeliveryYear: Year of last delivery (integer, e.g. 2024)
- agreesToSelectiveReduction: true/false/null - whether they agree to selective reduction
- agreesToInternationalParents: true/false/null - whether they are open to international parents
- status: "AVAILABLE", "MATCHED", "ON_HOLD", or "INACTIVE"
- photoUrl: URL to the surrogate's photo if visible

Return a JSON object with this exact structure:
{
  "surrogates": [
    {
      "externalId": "string or null",
      "age": number or null,
      "bmi": number or null,
      "baseCompensation": number or null,
      "totalCompensationMin": number or null,
      "totalCompensationMax": number or null,
      "location": "string or null",
      "agreesToAbortion": boolean or null,
      "agreesToTwins": boolean or null,
      "covidVaccinated": boolean or null,
      "liveBirths": number or null,
      "miscarriages": number or null,
      "cSections": number or null,
      "relationshipStatus": "string or null",
      "race": "string or null",
      "ethnicity": "string or null",
      "religion": "string or null",
      "education": "string or null",
      "openToSameSexCouple": boolean or null,
      "occupation": "string or null",
      "lastDeliveryYear": number or null,
      "agreesToSelectiveReduction": boolean or null,
      "agreesToInternationalParents": boolean or null,
      "status": "AVAILABLE",
      "photoUrl": "string or null"
    }
  ],
  "profileLinks": ["array of URLs to individual surrogate profile pages"],
  "paginationLinks": ["array of URLs to next pages"],
  "totalSurrogatesOnPage": number
}

IMPORTANT RULES:
- Extract ALL surrogates visible, even if only partial information is shown
- Include profile detail page URLs in profileLinks
- Include pagination URLs in paginationLinks
- Resolve all relative URLs to absolute using the base URL provided
- Return ONLY the JSON object, no markdown formatting or explanation`;

const SPERM_DONOR_EXTRACTION_PROMPT = `You are extracting sperm donor profiles from a sperm bank website.
Extract ALL sperm donor profiles visible on this page. For each donor, extract:

- externalId: The donor's ID number/code
- donorType: Type (e.g. "IUI Ready", "ICI Ready", etc.)
- age: Integer age
- race: Race(s)
- ethnicity: Ethnicity/ethnicities
- height: Height (include units)
- weight: Weight (include units)
- eyeColor: Eye color
- hairColor: Hair color
- education: Education level
- location: Location
- relationshipStatus: Relationship status
- occupation: Occupation
- compensation: Price per vial as a number (no $ sign)
- status: "AVAILABLE" or "SOLD_OUT"
- photoUrl: URL to donor's photo if visible

Return a JSON object:
{
  "donors": [
    {
      "externalId": "string or null",
      "donorType": "string or null",
      "age": number or null,
      "race": "string or null",
      "ethnicity": "string or null",
      "height": "string or null",
      "weight": "string or null",
      "eyeColor": "string or null",
      "hairColor": "string or null",
      "education": "string or null",
      "location": "string or null",
      "relationshipStatus": "string or null",
      "occupation": "string or null",
      "compensation": number or null,
      "status": "AVAILABLE",
      "photoUrl": "string or null"
    }
  ],
  "profileLinks": ["URLs to individual donor profiles"],
  "paginationLinks": ["URLs to next pages"],
  "totalDonorsOnPage": number
}

IMPORTANT: Extract ALL donors visible. Include profile and pagination URLs. Return ONLY JSON.`;

function getPromptForType(type: DonorType): string {
  switch (type) {
    case "egg-donor":
      return EGG_DONOR_EXTRACTION_PROMPT;
    case "surrogate":
      return SURROGATE_EXTRACTION_PROMPT;
    case "sperm-donor":
      return SPERM_DONOR_EXTRACTION_PROMPT;
  }
}

async function extractDonorsFromPage(
  html: string,
  pageUrl: string,
  type: DonorType,
): Promise<any> {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { temperature: 0 } as any,
  });

  const cleanedText = cleanHtml(html);
  const imgTags = (html.match(/<img[^>]+>/gi) || []).slice(0, 100).join("\n");

  const prompt = `${getPromptForType(type)}

BASE URL: ${pageUrl}

PAGE CONTENT:
${cleanedText.slice(0, 80000)}

IMAGE TAGS FOUND ON PAGE:
${imgTags.slice(0, 10000)}`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (err: any) {
    console.error(`[donor-sync] Gemini extraction error:`, err.message);
    return null;
  }
}

function skipIfManual(field: string, value: any, manualFields: string[]): any {
  return manualFields.includes(field) ? undefined : value;
}

const VALID_IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|heic|svg|bmp|tiff?|avif)/i;
const TRUSTED_S3_BLOB_HOSTS = /tfc-jms\.s3\.amazonaws\.com|s3\.[a-z0-9-]+\.amazonaws\.com/i;

function isValidImageUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith(".blob") && TRUSTED_S3_BLOB_HOSTS.test(parsed.hostname)) {
      return true;
    }
    return VALID_IMAGE_EXTENSIONS.test(parsed.pathname);
  } catch {
    return VALID_IMAGE_EXTENSIONS.test(url);
  }
}

function extractPhotosArray(entity: any): string[] {
  const filterValid = (arr: any[]) => arr.filter((p: any) => typeof p === "string" && p.length > 0 && isValidImageUrl(p));
  const toArray = (val: any): any[] | null => {
    if (Array.isArray(val) && val.length > 0) return val;
    if (typeof val === "string" && val.length > 0) return [val];
    return null;
  };

  const allPhotos = toArray(entity.profileData?.["All Photos"]);
  if (allPhotos) return filterValid(allPhotos);

  const profilePhotos = toArray(entity.profileData?.["Photos"]);
  if (profilePhotos) return filterValid(profilePhotos);

  if (entity.additionalPhotos && Array.isArray(entity.additionalPhotos) && entity.photoUrl) {
    const all = [entity.photoUrl, ...entity.additionalPhotos];
    return filterValid(all);
  }
  if (entity.photoUrl && isValidImageUrl(entity.photoUrl)) {
    return [entity.photoUrl];
  }
  return [];
}

function isAlreadyPersisted(url: string): boolean {
  if (!url) return false;
  if (url.startsWith("/uploads")) return true;
  if (/storage\.googleapis\.com/i.test(url) && /gostork/i.test(url)) return true;
  return false;
}

function guessContentType(buffer: Buffer): string {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "image/gif";
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return "image/webp";
  return "image/jpeg";
}

function guessExtension(contentType: string): string {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("webp")) return ".webp";
  return ".jpg";
}

const UPLOADS_DIR = path.resolve(process.cwd(), "public/uploads");

async function persistSinglePhoto(
  url: string,
  providerId: string,
  storageService: StorageService | null,
): Promise<string> {
  if (!url || isAlreadyPersisted(url)) return url;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(url, {
      headers: { ...DEFAULT_HEADERS, Accept: "image/*" },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!resp.ok) return url;
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length < 500 || buffer.length > 20 * 1024 * 1024) return url;
    const ct = guessContentType(buffer);
    const ext = guessExtension(ct);
    const hash = createHash("md5").update(buffer).digest("hex");
    const filename = `${hash}${ext}`;

    if (storageService?.isConfigured()) {
      const gcsPath = `profile-photos/${filename}`;
      return await storageService.uploadBufferPublic(buffer, gcsPath, ct);
    }

    const filePath = path.join(UPLOADS_DIR, filename);
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, buffer);
    }
    return `/uploads/${filename}`;
  } catch (err: any) {
    console.warn(`[photo-persist] Failed to persist photo: ${err.message}`);
    return url;
  }
}

async function persistPhotoUrls(
  entity: any,
  providerId: string,
  storageService: StorageService | null,
): Promise<void> {
  if (!storageService?.isConfigured()) return;
  if (entity.photoUrl && !isAlreadyPersisted(entity.photoUrl)) {
    entity.photoUrl = await persistSinglePhoto(entity.photoUrl, providerId, storageService);
  }
  if (Array.isArray(entity.photos)) {
    for (let i = 0; i < entity.photos.length; i++) {
      if (!isAlreadyPersisted(entity.photos[i])) {
        entity.photos[i] = await persistSinglePhoto(entity.photos[i], providerId, storageService);
      }
    }
  }
  if (entity.additionalPhotos && Array.isArray(entity.additionalPhotos)) {
    for (let i = 0; i < entity.additionalPhotos.length; i++) {
      if (!isAlreadyPersisted(entity.additionalPhotos[i])) {
        entity.additionalPhotos[i] = await persistSinglePhoto(entity.additionalPhotos[i], providerId, storageService);
      }
    }
  }
  const pd = entity.profileData;
  if (pd) {
    for (const key of ["All Photos", "Photos"]) {
      if (Array.isArray(pd[key])) {
        for (let i = 0; i < pd[key].length; i++) {
          if (typeof pd[key][i] === "string" && !isAlreadyPersisted(pd[key][i])) {
            pd[key][i] = await persistSinglePhoto(pd[key][i], providerId, storageService);
          }
        }
      }
    }
  }
}

function normalizeRelationshipStatus(val: string | null | undefined): string | null {
  if (!val) return null;
  const s = val.trim().toLowerCase();
  if (/^single|^never\s*married/.test(s)) return "Single";
  if (/^married/.test(s)) return "Married";
  if (/^divorced|^separated/.test(s)) return "Divorced";
  if (/partner|cohabitat|domestic|common.?law|engaged|relationship|living\s*together|boyfriend|girlfriend|significant/.test(s)) return "Partnered";
  if (/^widow/.test(s)) return "Divorced";
  return val.trim();
}

function detectExperienced(profileData: any, type: "egg-donor" | "surrogate" | "sperm-donor"): boolean {
  if (!profileData) return false;
  const sections = profileData["_sections"] as Record<string, any> | undefined;
  if (!sections) return false;

  if (type === "egg-donor" || type === "sperm-donor") {
    const dh = sections["Donation History"];
    if (dh) {
      if (Array.isArray(dh) && dh.length > 0) return true;
      if (typeof dh === "object") {
        const prevDonor = dh["Previous Donor"];
        if (prevDonor && /yes/i.test(String(prevDonor))) return true;
        if (dh["Entries"] && Array.isArray(dh["Entries"]) && dh["Entries"].length > 0) return true;
      }
    }
  }

  if (type === "surrogate") {
    const sh = sections["Surrogacy History"];
    if (sh) {
      if (Array.isArray(sh) && sh.length > 0) return true;
      if (typeof sh === "object") {
        const prev = sh["Previous Surrogate"] || sh["Previous GC"];
        if (prev && /yes/i.test(String(prev))) return true;
        if (sh["Entries"] && Array.isArray(sh["Entries"]) && sh["Entries"].length > 0) return true;
      }
    }
    const sd = sections["Surrogacy Details"];
    if (sd && typeof sd === "object" && !Array.isArray(sd)) {
      for (const [key, val] of Object.entries(sd)) {
        if (/repeat\s*surrogate|previous\s*surroga|prior\s*surroga/i.test(key) && /yes/i.test(String(val))) return true;
      }
    }
    const checkPregnancyEntries = (entries: any[]) => {
      for (const entry of entries) {
        if (typeof entry !== "object" || !entry) continue;
        for (const [key, val] of Object.entries(entry)) {
          if (/surrogate\s*delivery/i.test(key) && /yes/i.test(String(val))) return true;
          if (/child.*name|first\s*name|baby/i.test(key) && /surro/i.test(String(val))) return true;
        }
      }
      return false;
    };
    const ph = sections["Pregnancy History"];
    if (ph && typeof ph === "object" && !Array.isArray(ph)) {
      const entries = ph["Entries"];
      if (Array.isArray(entries) && checkPregnancyEntries(entries)) return true;
      const detailsPer = ph["Details per pregnancy"];
      if (Array.isArray(detailsPer) && checkPregnancyEntries(detailsPer)) return true;
    }
    if (Array.isArray(ph) && checkPregnancyEntries(ph)) return true;
  }

  return false;
}

async function upsertEggDonor(
  prisma: PrismaService,
  providerId: string,
  donor: any,
  storageService?: StorageService | null,
): Promise<{ isNew: boolean }> {
  await persistPhotoUrls(donor, providerId, storageService || null);
  const extId = donor.externalId || `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const existing = await prisma.eggDonor.findUnique({
    where: { providerId_externalId: { providerId, externalId: extId } },
    select: { manuallyEditedFields: true, profileData: true },
  });
  const isNew = !existing;
  const mf = existing?.manuallyEditedFields || [];
  const normalizedProfile = await normalizeProfileFields(donor.profileData || donor);
  const mergedProfile = mf.includes("profileData")
    ? { ...(normalizedProfile as any), ...(existing?.profileData as any || {}) }
    : normalizedProfile;

  const upsertedDonor = await prisma.eggDonor.upsert({
    where: {
      providerId_externalId: { providerId, externalId: extId },
    },
    update: {
      donorType: skipIfManual("donorType", donor.donorType || undefined, mf),
      age: skipIfManual("age", donor.age ? parseInt(String(donor.age)) || null : undefined, mf),
      race: skipIfManual("race", donor.race || undefined, mf),
      ethnicity: skipIfManual("ethnicity", donor.ethnicity || null, mf),
      religion: skipIfManual("religion", donor.religion || null, mf),
      height: skipIfManual("height", donor.height || null, mf),
      weight: skipIfManual("weight", donor.weight || null, mf),
      eyeColor: skipIfManual("eyeColor", donor.eyeColor || null, mf),
      hairColor: skipIfManual("hairColor", donor.hairColor || null, mf),
      education: skipIfManual("education", donor.education || null, mf),
      location: skipIfManual("location", donor.location || null, mf),
      bloodType: skipIfManual("bloodType", donor.bloodType || null, mf),
      donationTypes: skipIfManual("donationTypes", donor.donationTypes || null, mf),
      relationshipStatus: skipIfManual("relationshipStatus", normalizeRelationshipStatus(donor.relationshipStatus) || null, mf),
      occupation: skipIfManual("occupation", donor.occupation || null, mf),
      donorCompensation: skipIfManual("donorCompensation", donor.donorCompensation ? parseFloat(String(donor.donorCompensation)) : null, mf),
      eggLotCost: skipIfManual("eggLotCost", donor.eggLotCost ? parseFloat(String(donor.eggLotCost)) : null, mf),
      totalCost: skipIfManual("totalCost", donor.totalCost ? parseFloat(String(donor.totalCost)) : null, mf),
      photoUrl: skipIfManual("photoUrl", donor.photoUrl || null, mf),
      photos: skipIfManual("photos", extractPhotosArray(donor), mf),
      photoCount: skipIfManual("photoCount", donor.photoCount || null, mf),
      hasVideo: skipIfManual("hasVideo", donor.hasVideo || false, mf),
      videoUrl: skipIfManual("videoUrl", donor.videoUrl || (donor.profileData?.["Video URL"] as string) || null, mf),
      profileUrl: donor.profileUrl || null,
      status: skipIfManual("status", donor.status || "AVAILABLE", mf),
      isExperienced: skipIfManual("isExperienced", detectExperienced(mergedProfile, "egg-donor"), mf),
      profileData: mergedProfile,
      cardHash: donor.cardHash || undefined,
      updatedAt: new Date(),
    },
    create: {
      providerId,
      externalId: extId,
      donorType: donor.donorType || null,
      age: donor.age ? parseInt(String(donor.age)) || null : null,
      race: donor.race || null,
      ethnicity: donor.ethnicity || null,
      religion: donor.religion || null,
      height: donor.height || null,
      weight: donor.weight || null,
      eyeColor: donor.eyeColor || null,
      hairColor: donor.hairColor || null,
      education: donor.education || null,
      location: donor.location || null,
      bloodType: donor.bloodType || null,
      donationTypes: donor.donationTypes || null,
      relationshipStatus: normalizeRelationshipStatus(donor.relationshipStatus) || null,
      occupation: donor.occupation || null,
      donorCompensation: donor.donorCompensation ? parseFloat(String(donor.donorCompensation)) : null,
      eggLotCost: donor.eggLotCost ? parseFloat(String(donor.eggLotCost)) : null,
      totalCost: donor.totalCost ? parseFloat(String(donor.totalCost)) : null,
      photoUrl: donor.photoUrl || null,
      photos: extractPhotosArray(donor),
      photoCount: donor.photoCount || null,
      hasVideo: donor.hasVideo || false,
      videoUrl: donor.videoUrl || (donor.profileData?.["Video URL"] as string) || null,
      profileUrl: donor.profileUrl || null,
      status: donor.status || "AVAILABLE",
      isExperienced: detectExperienced(normalizedProfile, "egg-donor"),
      profileData: normalizedProfile,
      cardHash: donor.cardHash || null,
    },
  });
  updateProfileEmbedding(prisma, "EggDonor", upsertedDonor.id, mergedProfile).catch(() => {});
  return { isNew };
}

interface PregnancyHistoryStats {
  liveBirths: number;
  cSections: number;
  miscarriages: number;
  lastDeliveryYear: number | null;
}

function calcPregnancyHistoryStats(profileData: any): PregnancyHistoryStats | null {
  const sections = profileData?._sections;
  if (!sections) return null;
  const ph = sections["Pregnancy History"];
  if (!ph || typeof ph !== "object") return null;
  const entries: any[] = Array.isArray(ph) ? ph : (Array.isArray(ph.Entries) ? ph.Entries : null);
  if (!entries || entries.length === 0) return null;

  let liveBirths = 0;
  let cSections = 0;
  let miscarriages = 0;
  let lastDeliveryYear: number | null = null;

  for (const entry of entries) {
    if (typeof entry !== "object") continue;

    const delivery = String(entry.Delivery || entry.delivery || "").toLowerCase();
    const outcome = String(entry.Outcome || entry.outcome || entry["Pregnancy Outcome"] || "").toLowerCase();

    if (outcome.includes("miscarriage") || outcome.includes("miscarried")) {
      miscarriages++;
      continue;
    }

    if (outcome.includes("abortion") || outcome.includes("terminated") || outcome.includes("termination")) {
      continue;
    }

    const hasDOB = entry.DOB || entry.dob;
    const hasWeight = entry.Weight || entry.weight;
    const hasSex = entry.Sex || entry.sex;
    if (hasDOB || hasWeight || hasSex) {
      liveBirths++;
    }

    if (delivery.includes("c-section") || delivery.includes("cesarean") || delivery.includes("caesarean") || delivery.includes("c section")) {
      cSections++;
    }

    if (hasDOB) {
      const dobStr = String(hasDOB);
      const yearMatch = dobStr.match(/(\d{4})/);
      if (yearMatch) {
        const year = parseInt(yearMatch[1]);
        if (year > 1900 && (!lastDeliveryYear || year > lastDeliveryYear)) {
          lastDeliveryYear = year;
        }
      }
    }
  }

  return { liveBirths, cSections, miscarriages, lastDeliveryYear };
}

async function upsertSurrogate(
  prisma: PrismaService,
  providerId: string,
  surrogate: any,
  storageService?: StorageService | null,
): Promise<{ isNew: boolean }> {
  await persistPhotoUrls(surrogate, providerId, storageService || null);
  const extId = surrogate.externalId || `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const existing = await prisma.surrogate.findUnique({
    where: { providerId_externalId: { providerId, externalId: extId } },
    select: { manuallyEditedFields: true, profileData: true },
  });
  const isNew = !existing;
  const mf = existing?.manuallyEditedFields || [];
  const normalizedProfile = await normalizeProfileFields(surrogate.profileData || surrogate);
  const mergedProfile = mf.includes("profileData")
    ? { ...(normalizedProfile as any), ...(existing?.profileData as any || {}) }
    : normalizedProfile;

  const phStats = calcPregnancyHistoryStats(mergedProfile);
  const resolvedLiveBirths = surrogate.liveBirths != null ? parseInt(String(surrogate.liveBirths)) || 0 : (phStats?.liveBirths ?? 0);
  const resolvedCSections = surrogate.cSections != null ? parseInt(String(surrogate.cSections)) || 0 : (phStats?.cSections ?? 0);
  const resolvedMiscarriages = surrogate.miscarriages != null ? parseInt(String(surrogate.miscarriages)) || 0 : (phStats?.miscarriages ?? 0);
  const resolvedLastDeliveryYear = surrogate.lastDeliveryYear != null ? (parseInt(String(surrogate.lastDeliveryYear)) || null) : (phStats?.lastDeliveryYear ?? null);

  const upsertedSurrogate = await prisma.surrogate.upsert({
    where: {
      providerId_externalId: { providerId, externalId: extId },
    },
    update: {
      age: skipIfManual("age", surrogate.age ? parseInt(String(surrogate.age)) || null : undefined, mf),
      bmi: skipIfManual("bmi", surrogate.bmi ? parseFloat(String(surrogate.bmi)) : undefined, mf),
      baseCompensation: skipIfManual("baseCompensation", surrogate.baseCompensation ? parseFloat(String(surrogate.baseCompensation)) : undefined, mf),
      totalCompensationMin: skipIfManual("totalCompensationMin", surrogate.totalCompensationMin ? parseFloat(String(surrogate.totalCompensationMin)) : undefined, mf),
      totalCompensationMax: skipIfManual("totalCompensationMax", surrogate.totalCompensationMax ? parseFloat(String(surrogate.totalCompensationMax)) : undefined, mf),
      location: skipIfManual("location", surrogate.location || undefined, mf),
      agreesToAbortion: skipIfManual("agreesToAbortion", surrogate.agreesToAbortion ?? undefined, mf),
      agreesToTwins: skipIfManual("agreesToTwins", surrogate.agreesToTwins ?? undefined, mf),
      covidVaccinated: skipIfManual("covidVaccinated", surrogate.covidVaccinated ?? undefined, mf),
      liveBirths: skipIfManual("liveBirths", resolvedLiveBirths, mf),
      miscarriages: skipIfManual("miscarriages", resolvedMiscarriages, mf),
      cSections: skipIfManual("cSections", resolvedCSections, mf),
      relationshipStatus: skipIfManual("relationshipStatus", normalizeRelationshipStatus(surrogate.relationshipStatus) || undefined, mf),
      openToSameSexCouple: skipIfManual("openToSameSexCouple", surrogate.openToSameSexCouple ?? undefined, mf),
      race: skipIfManual("race", surrogate.race || undefined, mf),
      ethnicity: skipIfManual("ethnicity", surrogate.ethnicity || undefined, mf),
      religion: skipIfManual("religion", surrogate.religion || undefined, mf),
      education: skipIfManual("education", surrogate.education || undefined, mf),
      occupation: skipIfManual("occupation", surrogate.occupation || undefined, mf),
      lastDeliveryYear: skipIfManual("lastDeliveryYear", resolvedLastDeliveryYear ?? undefined, mf),
      agreesToSelectiveReduction: skipIfManual("agreesToSelectiveReduction", surrogate.agreesToSelectiveReduction ?? undefined, mf),
      agreesToInternationalParents: skipIfManual("agreesToInternationalParents", surrogate.agreesToInternationalParents ?? undefined, mf),
      photoUrl: skipIfManual("photoUrl", surrogate.photoUrl || undefined, mf),
      photos: skipIfManual("photos", extractPhotosArray(surrogate), mf),
      videoUrl: skipIfManual("videoUrl", surrogate.videoUrl || (surrogate.profileData?.["Video URL"] as string) || undefined, mf),
      profileUrl: surrogate.profileUrl || undefined,
      status: skipIfManual("status", surrogate.status || "AVAILABLE", mf),
      isExperienced: skipIfManual("isExperienced", detectExperienced(mergedProfile, "surrogate"), mf),
      profileData: mergedProfile,
      cardHash: surrogate.cardHash || undefined,
      updatedAt: new Date(),
    },
    create: {
      providerId,
      externalId: extId,
      age: surrogate.age ? parseInt(String(surrogate.age)) || null : null,
      bmi: surrogate.bmi ? parseFloat(String(surrogate.bmi)) : null,
      baseCompensation: surrogate.baseCompensation ? parseFloat(String(surrogate.baseCompensation)) : null,
      totalCompensationMin: surrogate.totalCompensationMin ? parseFloat(String(surrogate.totalCompensationMin)) : null,
      totalCompensationMax: surrogate.totalCompensationMax ? parseFloat(String(surrogate.totalCompensationMax)) : null,
      location: surrogate.location || null,
      agreesToAbortion: surrogate.agreesToAbortion ?? null,
      agreesToTwins: surrogate.agreesToTwins ?? null,
      covidVaccinated: surrogate.covidVaccinated ?? null,
      liveBirths: resolvedLiveBirths,
      miscarriages: resolvedMiscarriages,
      cSections: resolvedCSections,
      relationshipStatus: normalizeRelationshipStatus(surrogate.relationshipStatus) || null,
      openToSameSexCouple: surrogate.openToSameSexCouple ?? null,
      race: surrogate.race || null,
      ethnicity: surrogate.ethnicity || null,
      religion: surrogate.religion || null,
      education: surrogate.education || null,
      occupation: surrogate.occupation || null,
      lastDeliveryYear: resolvedLastDeliveryYear,
      agreesToSelectiveReduction: surrogate.agreesToSelectiveReduction ?? null,
      agreesToInternationalParents: surrogate.agreesToInternationalParents ?? null,
      photoUrl: surrogate.photoUrl || null,
      profileUrl: surrogate.profileUrl || null,
      photos: extractPhotosArray(surrogate),
      videoUrl: surrogate.videoUrl || (surrogate.profileData?.["Video URL"] as string) || null,
      status: surrogate.status || "AVAILABLE",
      isExperienced: detectExperienced(normalizedProfile, "surrogate"),
      profileData: normalizedProfile,
      cardHash: surrogate.cardHash || null,
    },
  });
  updateProfileEmbedding(prisma, "Surrogate", upsertedSurrogate.id, mergedProfile).catch(() => {});
  return { isNew };
}

async function upsertSpermDonor(
  prisma: PrismaService,
  providerId: string,
  donor: any,
  storageService?: StorageService | null,
): Promise<{ isNew: boolean }> {
  await persistPhotoUrls(donor, providerId, storageService || null);
  const extId = donor.externalId || `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const existing = await prisma.spermDonor.findUnique({
    where: { providerId_externalId: { providerId, externalId: extId } },
    select: { manuallyEditedFields: true, profileData: true },
  });
  const isNew = !existing;
  const mf = existing?.manuallyEditedFields || [];
  const normalizedProfile = await normalizeProfileFields(donor.profileData || donor);
  const mergedProfile = mf.includes("profileData")
    ? { ...(normalizedProfile as any), ...(existing?.profileData as any || {}) }
    : normalizedProfile;

  const upsertedSpermDonor = await prisma.spermDonor.upsert({
    where: {
      providerId_externalId: { providerId, externalId: extId },
    },
    update: {
      donorType: skipIfManual("donorType", donor.donorType || undefined, mf),
      age: skipIfManual("age", donor.age ? parseInt(String(donor.age)) || null : undefined, mf),
      race: skipIfManual("race", donor.race || undefined, mf),
      ethnicity: skipIfManual("ethnicity", donor.ethnicity || undefined, mf),
      height: skipIfManual("height", donor.height || undefined, mf),
      weight: skipIfManual("weight", donor.weight || undefined, mf),
      eyeColor: skipIfManual("eyeColor", donor.eyeColor || undefined, mf),
      hairColor: skipIfManual("hairColor", donor.hairColor || undefined, mf),
      education: skipIfManual("education", donor.education || undefined, mf),
      location: skipIfManual("location", donor.location || undefined, mf),
      relationshipStatus: skipIfManual("relationshipStatus", normalizeRelationshipStatus(donor.relationshipStatus) || undefined, mf),
      occupation: skipIfManual("occupation", donor.occupation || undefined, mf),
      compensation: skipIfManual("compensation", donor.compensation ? parseFloat(String(donor.compensation)) : undefined, mf),
      photoUrl: skipIfManual("photoUrl", donor.photoUrl || undefined, mf),
      photos: skipIfManual("photos", extractPhotosArray(donor), mf),
      videoUrl: skipIfManual("videoUrl", donor.videoUrl || (donor.profileData?.["Video URL"] as string) || undefined, mf),
      profileUrl: donor.profileUrl || undefined,
      status: skipIfManual("status", donor.status || "AVAILABLE", mf),
      isExperienced: skipIfManual("isExperienced", detectExperienced(mergedProfile, "sperm-donor"), mf),
      profileData: mergedProfile,
      cardHash: donor.cardHash || undefined,
      updatedAt: new Date(),
    },
    create: {
      providerId,
      externalId: extId,
      donorType: donor.donorType || null,
      age: donor.age ? parseInt(String(donor.age)) || null : null,
      race: donor.race || null,
      ethnicity: donor.ethnicity || null,
      height: donor.height || null,
      weight: donor.weight || null,
      eyeColor: donor.eyeColor || null,
      hairColor: donor.hairColor || null,
      education: donor.education || null,
      location: donor.location || null,
      relationshipStatus: normalizeRelationshipStatus(donor.relationshipStatus) || null,
      occupation: donor.occupation || null,
      compensation: donor.compensation ? parseFloat(String(donor.compensation)) : null,
      photoUrl: donor.photoUrl || null,
      profileUrl: donor.profileUrl || null,
      photos: extractPhotosArray(donor),
      videoUrl: donor.videoUrl || (donor.profileData?.["Video URL"] as string) || null,
      status: donor.status || "AVAILABLE",
      isExperienced: detectExperienced(normalizedProfile, "sperm-donor"),
      profileData: normalizedProfile,
      cardHash: donor.cardHash || null,
    },
  });
  updateProfileEmbedding(prisma, "SpermDonor", upsertedSpermDonor.id, mergedProfile).catch(() => {});
  return { isNew };
}

export async function getSyncConfig(
  prisma: PrismaService,
  providerId: string,
  type: DonorType,
) {
  switch (type) {
    case "egg-donor":
      return prisma.eggDonorSyncConfig.findUnique({ where: { providerId } });
    case "surrogate":
      return prisma.surrogateSyncConfig.findUnique({ where: { providerId } });
    case "sperm-donor":
      return prisma.spermDonorSyncConfig.findUnique({ where: { providerId } });
  }
}

export async function saveSyncConfig(
  prisma: PrismaService,
  providerId: string,
  type: DonorType,
  data: { databaseUrl: string; username?: string; password?: string },
) {
  const payload = {
    databaseUrl: data.databaseUrl,
    username: data.username || null,
    encryptedPassword: data.password || null,
  };

  switch (type) {
    case "egg-donor":
      return prisma.eggDonorSyncConfig.upsert({
        where: { providerId },
        update: payload,
        create: { providerId, ...payload },
      });
    case "surrogate":
      return prisma.surrogateSyncConfig.upsert({
        where: { providerId },
        update: payload,
        create: { providerId, ...payload },
      });
    case "sperm-donor":
      return prisma.spermDonorSyncConfig.upsert({
        where: { providerId },
        update: payload,
        create: { providerId, ...payload },
      });
  }
}

export function getSyncJob(jobId: string): SyncJob | undefined {
  return syncJobs.get(jobId);
}

export function getActiveSyncJob(providerId: string, type: DonorType): SyncJob | undefined {
  for (const job of syncJobs.values()) {
    if (job.providerId === providerId && job.type === type && job.status === "running" && !job.isPdfUpload) {
      return job;
    }
  }
  return undefined;
}

export function getActivePdfJob(providerId: string, type: DonorType): SyncJob | undefined {
  for (const job of syncJobs.values()) {
    if (job.providerId === providerId && job.type === type && job.status === "running" && job.isPdfUpload) {
      return job;
    }
  }
  return undefined;
}

export function cancelSync(providerId: string, type: DonorType): boolean {
  const job = getActiveSyncJob(providerId, type);
  const pdfJob = getActivePdfJob(providerId, type);
  let cancelled = false;
  if (job) {
    cancelledJobs.add(job.id);
    job.status = "failed";
    job.errors.push("Sync cancelled by admin");
    job.completedAt = new Date();
    cancelled = true;
  }
  if (pdfJob) {
    cancelledJobs.add(pdfJob.id);
    pdfJob.status = "failed";
    pdfJob.errors.push("PDF sync cancelled by admin");
    pdfJob.completedAt = new Date();
    cancelled = true;
  }
  return cancelled;
}

export async function deleteAllDonors(
  prisma: PrismaService,
  providerId: string,
  type: DonorType,
): Promise<number> {
  const activeJob = getActiveSyncJob(providerId, type);
  if (activeJob) {
    cancelSync(providerId, type);
    await new Promise((r) => setTimeout(r, 2000));
  }

  let count = 0;
  switch (type) {
    case "egg-donor":
      const edResult = await prisma.eggDonor.deleteMany({ where: { providerId } });
      count = edResult.count;
      break;
    case "surrogate":
      const surResult = await prisma.surrogate.deleteMany({ where: { providerId } });
      count = surResult.count;
      break;
    case "sperm-donor":
      const spResult = await prisma.spermDonor.deleteMany({ where: { providerId } });
      count = spResult.count;
      break;
  }

  await recalcAndPersistTotalCostsForProvider(prisma, providerId);
  return count;
}

export function getLatestCompletedSyncJob(providerId: string, type: DonorType): SyncJob | undefined {
  let latest: SyncJob | undefined;
  for (const job of syncJobs.values()) {
    if (job.providerId === providerId && job.type === type && job.status !== "running") {
      if (!latest || (job.completedAt && latest.completedAt && job.completedAt > latest.completedAt)) {
        latest = job;
      }
    }
  }
  return latest;
}

export async function startSync(
  prisma: PrismaService,
  providerId: string,
  type: DonorType,
  profileLimit?: number,
  storageService?: StorageService | null,
): Promise<string> {
  const config = await getSyncConfig(prisma, providerId, type);
  if (!config) {
    throw new Error("Sync configuration not found. Please save configuration first.");
  }

  const jobId = generateJobId();
  const job: SyncJob = {
    id: jobId,
    providerId,
    type,
    status: "running",
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    newProfiles: 0,
    errors: [],
    missingFields: [],
    staleDonorsMarked: 0,
    startedAt: new Date(),
  };
  syncJobs.set(jobId, job);

  const syncStartUpdate = { lastSyncStartedAt: new Date(), lastSyncEndedAt: null as Date | null };
  switch (type) {
    case "egg-donor":
      await prisma.eggDonorSyncConfig.update({ where: { providerId }, data: syncStartUpdate });
      break;
    case "surrogate":
      await prisma.surrogateSyncConfig.update({ where: { providerId }, data: syncStartUpdate });
      break;
    case "sperm-donor":
      await prisma.spermDonorSyncConfig.update({ where: { providerId }, data: syncStartUpdate });
      break;
  }

  const credentials = config.username && config.encryptedPassword
    ? { username: config.username, password: config.encryptedPassword }
    : undefined;

  runSyncJob(prisma, job, config.databaseUrl, credentials, profileLimit, storageService || null).catch((err) => {
    job.status = "failed";
    job.errors.push(`Fatal error: ${err.message}`);
    job.completedAt = new Date();
  });

  return jobId;
}

async function tryFetchEdcDonorData(
  pageHtml: string,
  sourceUrl: string,
  cookies?: string,
  syncType: DonorType = "egg-donor",
): Promise<string | null> {
  try {
    const base = new URL(sourceUrl);

    const edcEndpoints: Record<DonorType, { dashboards: string[]; ajaxPartials: string[]; linkPatterns: RegExp }> = {
      "egg-donor": {
        dashboards: ["/Recipient/DonorDashboardMatching", "/Recipient/DonorDashboard", "/Recipient/Dashboard"],
        ajaxPartials: ["/Recipient/_DonorDashboardMatching", "/Recipient/_DonorDashboard"],
        linkPatterns: /DonorDashboardMatching|DonorDashboard|Dashboard/i,
      },
      "surrogate": {
        dashboards: ["/Recipient/SurrogateDashboardMatching", "/Recipient/SurrogateDashboard", "/Recipient/GCDashboard"],
        ajaxPartials: ["/Recipient/_SurrogateDashboardMatching", "/Recipient/_SurrogateDashboard", "/Recipient/_GCDashboard"],
        linkPatterns: /SurrogateDashboardMatching|SurrogateDashboard|GCDashboard/i,
      },
      "sperm-donor": {
        dashboards: ["/Recipient/SpermDonorDashboardMatching", "/Recipient/SpermDonorDashboard", "/Recipient/SpermDashboard"],
        ajaxPartials: ["/Recipient/_SpermDonorDashboardMatching", "/Recipient/_SpermDonorDashboard", "/Recipient/_SpermDashboard"],
        linkPatterns: /SpermDonorDashboardMatching|SpermDonorDashboard|SpermDashboard/i,
      },
    };
    const endpoints = edcEndpoints[syncType];

    if (pageHtml.includes("donorCardDiv") && pageHtml.includes("donorStatus")) {
      console.log(`[donor-sync] Current page already contains donor cards, returning directly`);
      return pageHtml;
    }

    let ajaxEndpoint: string | null = null;
    for (const partial of endpoints.ajaxPartials) {
      const partialName = partial.split("/").pop() || "";
      if (pageHtml.includes(partialName) || pageHtml.includes(`${partialName}.js`) || pageHtml.includes(`${partialName}.css`)) {
        ajaxEndpoint = partial;
        break;
      }
    }
    if (!ajaxEndpoint) {
      if (pageHtml.includes("_DonorDashboardMatching") || pageHtml.includes("DonorDashboardMatching.js") || pageHtml.includes("DonorDashboardMatching.css")) {
        ajaxEndpoint = "/Recipient/_DonorDashboardMatching";
      } else if (pageHtml.includes("_DonorDashboard") || pageHtml.includes("DonorDashboard.js") || pageHtml.includes("DonorDashboard.css")) {
        ajaxEndpoint = "/Recipient/_DonorDashboard";
      }
    }

    if (ajaxEndpoint) {
      console.log(`[donor-sync] Found AJAX partial view endpoint for ${syncType}: ${ajaxEndpoint}`);
      return await fetchEdcAjaxDonors(pageHtml, base.origin, ajaxEndpoint, cookies);
    }

    console.log(`[donor-sync] No AJAX endpoint found in page, searching for ${syncType} dashboard link...`);
    const allDashLinks = [...pageHtml.matchAll(new RegExp(`href="([^"]*(?:${endpoints.linkPatterns.source})[^"]*)"`, "gi"))]
      .map(m => m[1])
      .filter(url => !/\.(css|js|png|jpg|svg|ico|woff|ttf)\b/i.test(url));
    if (allDashLinks.length === 0) {
      const fallbackLinks = [...pageHtml.matchAll(/href="([^"]*(?:DonorDashboardMatching|DonorDashboard|Dashboard)[^"]*)"/gi)]
        .map(m => m[1])
        .filter(url => !/\.(css|js|png|jpg|svg|ico|woff|ttf)\b/i.test(url));
      allDashLinks.push(...fallbackLinks);
    }
    const dashboardLink = allDashLinks.length > 0 ? [null, allDashLinks[0]] : null;
    if (dashboardLink) {
      console.log(`[donor-sync] Found EDC ${syncType} dashboard link: ${dashboardLink[1]}`);
      const dashUrl = new URL(dashboardLink[1], base).href;
      const dashHtml = await fetchHtml(dashUrl, cookies);
      
      if (dashHtml.includes("donorCardDiv")) return dashHtml;
      
      for (const partial of endpoints.ajaxPartials) {
        const partialName = partial.split("/").pop() || "";
        if (dashHtml.includes(partialName)) {
          return await fetchEdcAjaxDonors(dashHtml, base.origin, partial, cookies);
        }
      }
      if (dashHtml.includes("_DonorDashboardMatching")) {
        return await fetchEdcAjaxDonors(dashHtml, base.origin, "/Recipient/_DonorDashboardMatching", cookies);
      } else if (dashHtml.includes("_DonorDashboard")) {
        return await fetchEdcAjaxDonors(dashHtml, base.origin, "/Recipient/_DonorDashboard", cookies);
      }
    }

    if (syncType !== "egg-donor") {
      for (const dashPath of endpoints.dashboards) {
        try {
          const dashUrl = base.origin + dashPath;
          console.log(`[donor-sync] Trying EDC ${syncType} dashboard directly: ${dashUrl}`);
          const dashHtml = await fetchHtml(dashUrl, cookies);
          if (dashHtml.includes("donorCardDiv")) return dashHtml;
          for (const partial of endpoints.ajaxPartials) {
            const partialName = partial.split("/").pop() || "";
            if (dashHtml.includes(partialName)) {
              return await fetchEdcAjaxDonors(dashHtml, base.origin, partial, cookies);
            }
          }
        } catch (err: any) {
          console.warn(`[donor-sync] EDC ${syncType} dashboard ${dashPath} failed: ${err.message}`);
        }
      }
    }

    return null;
  } catch (err: any) {
    console.error(`[donor-sync] EDC fetch error: ${err.message}`);
    return null;
  }
}

function parseEdcDonorCards(html: string, origin: string): any[] {
  const cardRegex = /class="([^"]*donorCardDiv[^"]*)"/g;
  const splitPoints: { index: number; classes: string }[] = [];
  let cardMatch;
  while ((cardMatch = cardRegex.exec(html)) !== null) {
    splitPoints.push({ index: cardMatch.index + cardMatch[0].length, classes: cardMatch[1] });
  }
  console.log(`[donor-sync] Card split found ${splitPoints.length} donorCardDiv elements`);
  const donors: any[] = [];
  let skippedNoStatus = 0;
  let skippedNoDonorType = 0;

  for (let i = 0; i < splitPoints.length; i++) {
    const start = splitPoints[i].index;
    const end = i + 1 < splitPoints.length ? splitPoints[i + 1].index - 100 : html.length;
    const card = html.substring(start, end);
    const cardClasses = splitPoints[i].classes;
    const isInactive = cardClasses.includes("inactiveDonor");
    try {
      const donorIdMatch = card.match(/id="divDonor(\d+)"/);
      const externalIdMatch = card.match(/<h5>\s*(\d+)/);
      const statusMatch = card.match(/<b class="donorStatus">(.*?)<\/b>/s);
      const photoMatch = card.match(/background-image:url\('([^']+)'\)/);
      const profileUrlMatch = card.match(/DonorProfile\?donorid=(\d+)[^'"]*/);
      const photoCountMatch = card.match(/(\d+)\s*Photos/);
      const hasVideo = card.includes("Video");

      const status = statusMatch ? statusMatch[1].replace(/&amp;/g, "&").trim() : "";
      if (!statusMatch) { skippedNoStatus++; continue; }

      let donorType: string | null = null;
      const statusLower = status.toLowerCase();
      if (statusLower.includes("fresh") && statusLower.includes("frozen")) donorType = "Fresh & Frozen";
      else if (statusLower.includes("frozen")) donorType = "Frozen Eggs";
      else if (statusLower.includes("fresh")) donorType = "Fresh Donor";
      else donorType = "Fresh Donor";

      const donorStatus = isInactive ? "INACTIVE" :
        (statusLower.includes("reserved") || statusLower.includes("cycling") || statusLower.includes("pending")) ? "MATCHED" : "AVAILABLE";

      const clean = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();

      const fieldMap: Record<string, string> = {};

      const tableRegex = /<thead[^>]*>\s*<tr>\s*([\s\S]*?)<\/tr>\s*<\/thead>\s*<tbody[^>]*>\s*<tr>\s*([\s\S]*?)<\/tr>/g;
      let tableMatch;
      while ((tableMatch = tableRegex.exec(card)) !== null) {
        const headerRow = tableMatch[1];
        const dataRow = tableMatch[2];
        const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/g;
        const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
        const headers: string[] = [];
        const values: string[] = [];
        let m;
        while ((m = thRegex.exec(headerRow)) !== null) headers.push(clean(m[1]));
        while ((m = tdRegex.exec(dataRow)) !== null) values.push(clean(m[1]));
        for (let h = 0; h < headers.length; h++) {
          const key = headers[h];
          const val = values[h];
          if (key && val && !fieldMap[key]) fieldMap[key] = val;
        }
      }


      const ethnicity = [fieldMap["Mother's Ethnicity"], fieldMap["Father's Ethnicity"]]
        .filter(Boolean)
        .join(" / ");

      const heightRaw = fieldMap["Height"] || null;
      const ageStr = fieldMap["Current Age"] || fieldMap["Age at Last Retrieval"] || fieldMap["Age"] || null;

      let weightVal = fieldMap["Weight"] || null;
      if (weightVal) {
        weightVal = weightVal.replace(/\s*lbs\s*/gi, "").trim();
        if (weightVal) weightVal = `${weightVal} lbs`;
      }

      const internalDonorId = donorIdMatch ? donorIdMatch[1] : null;
      const profilePath = profileUrlMatch ? `/Recipient/DonorProfile?donorid=${profileUrlMatch[1]}` : null;

      let locationVal = fieldMap["Residing Country"] || fieldMap["Location"] || null;
      if (locationVal && /^\d'\d+$/.test(locationVal)) locationVal = null;

      const cardHashValue = createHash("md5").update(card).digest("hex");

      const donor: any = {
        externalId: externalIdMatch ? externalIdMatch[1] : (internalDonorId || null),
        donorType,
        age: ageStr ? parseInt(ageStr) || null : null,
        race: fieldMap["Race"] || null,
        ethnicity: ethnicity || null,
        height: heightRaw,
        weight: weightVal,
        eyeColor: fieldMap["Eye Color"] || null,
        hairColor: fieldMap["Hair Color"] || null,
        education: fieldMap["Education"] || null,
        location: locationVal,
        bloodType: fieldMap["Blood Type"] || null,
        donationTypes: fieldMap["Open ID or Anonymous?"] || null,
        religion: fieldMap["Religion"] || null,
        photoUrl: photoMatch ? photoMatch[1] : null,
        photoCount: photoCountMatch ? parseInt(photoCountMatch[1]) || null : null,
        hasVideo,
        profileUrl: profilePath ? `${origin}${profilePath}` : null,
        status: donorStatus,
        cardHash: cardHashValue,
      };

      if (!donorType) { skippedNoDonorType++; continue; }

      donors.push(donor);
    } catch (err: any) {
      console.error(`[donor-sync] Error parsing EDC donor card ${i}: ${err.message}`);
    }
  }

  console.log(`[donor-sync] Parsed ${donors.length} donors, skipped ${skippedNoStatus} (no status), ${skippedNoDonorType} (no donorType/mobile duplicates)`);
  return donors;
}

function isOrchidJmsSite(html: string): boolean {
  return html.includes("gc-ed-v2") || html.includes("data-gc-case-id") || html.includes("o-jms.com") || html.includes("tfcui.bundle");
}

async function tryFetchOrchidJmsData(
  pageHtml: string,
  sourceUrl: string,
  cookies?: string,
  syncType: DonorType = "egg-donor",
): Promise<{ donors: any[]; origin: string } | null> {
  try {
    const base = new URL(sourceUrl);
    const origin = base.origin;
    const matchingSlug = syncType === "surrogate" ? "gc" : syncType === "sperm-donor" ? "sd" : "ed";

    if (pageHtml.includes("gc-ed-v2") && pageHtml.includes("data-gc-case-id")) {
      console.log(`[donor-sync] Current page is an Orchid JMS ${syncType} gallery`);
      const hasPageLimit = pageHtml.includes("page_limit=");
      const currentUrl = new URL(sourceUrl);
      const hasHighLimit = currentUrl.searchParams.get("page_limit") === "1000";

      if (hasPageLimit && !hasHighLimit) {
        const allDonorsUrl = `${base.origin}${base.pathname}?page_limit=1000`;
        console.log(`[donor-sync] Re-fetching with page_limit=1000 to get all profiles: ${allDonorsUrl}`);
        const allHtml = await fetchHtml(allDonorsUrl, cookies, 60000, 5000000);
        if (allHtml.includes("gc-ed-v2")) {
          const allDonors = parseOrchidJmsCards(allHtml, origin);
          console.log(`[donor-sync] Fetched all ${allDonors.length} profiles in single request`);
          return { donors: allDonors, origin };
        }
      }

      const donors = parseOrchidJmsCards(pageHtml, origin);
      const allDonors = [...donors];
      let pageNum = 2;
      const maxPages = 100;
      while (pageNum <= maxPages) {
        const pageUrl = `${base.origin}${base.pathname}?page=${pageNum}`;
        try {
          const pageData = await fetchHtml(pageUrl, cookies);
          const pageDonors = parseOrchidJmsCards(pageData, origin);
          if (pageDonors.length === 0) break;
          console.log(`[donor-sync] Page ${pageNum}: ${pageDonors.length} profiles`);
          allDonors.push(...pageDonors);
          pageNum++;
        } catch (err: any) {
          console.warn(`[donor-sync] Failed to fetch page ${pageNum}: ${err.message}`);
          break;
        }
      }
      return { donors: allDonors, origin };
    }

    const matchingLink = pageHtml.match(new RegExp(`href="([^"]*\\/matching\\/${matchingSlug}[^"]*)"`));
    if (matchingLink) {
      console.log(`[donor-sync] Found Orchid JMS ${syncType} matching link: ${matchingLink[1]}`);
      const matchUrl = new URL(matchingLink[1], base).href;
      const matchHtml = await fetchHtml(matchUrl, cookies);
      if (matchHtml.includes("gc-ed-v2")) {
        return tryFetchOrchidJmsData(matchHtml, matchUrl, cookies, syncType);
      }
    }

    const navLinks = [...pageHtml.matchAll(new RegExp(`href="([^"]*\\/(\\d+)\\/matching\\/${matchingSlug}[^"]*)"`, "g"))];
    if (navLinks.length > 0) {
      const matchUrl = new URL(navLinks[0][1], base).href;
      console.log(`[donor-sync] Found Orchid JMS ${syncType} matching page from nav: ${matchUrl}`);
      const matchHtml = await fetchHtml(matchUrl, cookies);
      if (matchHtml.includes("gc-ed-v2")) {
        return tryFetchOrchidJmsData(matchHtml, matchUrl, cookies, syncType);
      }
    }

    const hasSelectCase = pageHtml.includes("select-case");
    const userPaths = ["/user/select-case", "/user/"];
    for (const userPath of userPaths) {
      try {
        const targetUrl = origin + userPath;
        console.log(`[donor-sync] Orchid JMS: trying ${syncType} discovery via ${targetUrl}`);
        const scHtml = hasSelectCase && userPath === "/user/select-case" ? pageHtml : await fetchHtml(targetUrl, cookies);
        const navMatch = scHtml.match(new RegExp(`href="([^"]*\\/matching\\/${matchingSlug}[^"]*)"`));
        if (navMatch) {
          const matchUrl = new URL(navMatch[1], base).href;
          console.log(`[donor-sync] Found ${syncType} matching page via ${userPath}: ${matchUrl}`);
          const matchHtml = await fetchHtml(matchUrl, cookies);
          if (matchHtml.includes("gc-ed-v2")) {
            return tryFetchOrchidJmsData(matchHtml, matchUrl, cookies, syncType);
          }
        } else {
          console.log(`[donor-sync] No ${syncType} matching link found at ${userPath} (${scHtml.length} chars)`);
        }
      } catch (err: any) {
        console.warn(`[donor-sync] Discovery via ${userPath} failed: ${err.message}`);
      }
    }

    return null;
  } catch (err: any) {
    console.error(`[donor-sync] Orchid JMS fetch error: ${err.message}`);
    return null;
  }
}

function parseOrchidJmsCards(html: string, origin: string): any[] {
  const cardRegex = /<section[^>]*class="card gc-ed-v2[^"]*"[^>]*data-gc-case-id="(\d+)"[^>]*>([\s\S]*?)<\/section>/g;
  const donors: any[] = [];
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    try {
      const caseId = match[1];
      const card = match[2];

      const imgMatch = card.match(/<img[^>]*src="([^"]*)"[^>]*class="card-image"/);
      const photoUrl = imgMatch ? imgMatch[1].replace(/&amp;/g, "&") : null;

      const profileUrlMatch = card.match(/href="([^"]*\/profile\/[^/]+\/(\d+))"/);
      const profilePath = profileUrlMatch ? profileUrlMatch[1] : null;
      const donorId = profileUrlMatch ? profileUrlMatch[2] : caseId;

      const nameMatch = card.match(/<a[^>]*>\s*([\s\S]*?)\s*<\/a>\s*<\/h3>|<a[^>]*style="[^"]*color:\s*black[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/a>/);
      let donorName = "";
      if (nameMatch) {
        donorName = (nameMatch[1] || nameMatch[2] || "").replace(/<[^>]*>/g, "").trim();
      }

      const externalIdMatch = donorName.match(/(?:ED|S|D)?(\d{4,})/i);
      const externalId = externalIdMatch ? externalIdMatch[0] : `OJMS-${donorId}`;

      const statusBadgeMatch = card.match(/donor-status-badge[^>]*>[\s\S]*?<span[^>]*>(.*?)<\/span>/);
      const statusText = statusBadgeMatch ? statusBadgeMatch[1].replace(/<[^>]*>/g, "").trim() : "";
      const statusLower = statusText.toLowerCase();
      const donorStatus = (statusLower.includes("reserved") || statusLower.includes("cycling") || statusLower.includes("pending") || statusLower.includes("matched"))
        ? "MATCHED" : (statusLower.includes("unavail") || statusLower.includes("inactive") ? "INACTIVE" : "AVAILABLE");

      const fields: Record<string, string> = {};
      const fieldRegex = /<div class="key">(.*?)<\/div>\s*<div class="value">\s*([\s\S]*?)\s*<\/div>/g;
      let fieldMatch;
      while ((fieldMatch = fieldRegex.exec(card)) !== null) {
        const key = fieldMatch[1].replace(/:$/, "").trim();
        const value = fieldMatch[2].replace(/<[^>]*>/g, "").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, "&").trim();
        if (key && value) fields[key] = value;
      }

      const heightRaw = fields["Height"] || null;
      const ageStr = fields["Age"] || null;

      const cardHashValue = createHash("md5").update(card).digest("hex");

      const donor: any = {
        externalId,
        donorType: "Fresh Donor",
        age: ageStr ? parseInt(ageStr) || null : null,
        race: fields["Race"] || null,
        ethnicity: fields["Ethnicity"] || null,
        height: heightRaw,
        weight: fields["Weight"] || null,
        eyeColor: fields["Eyes"] || fields["Eye Color"] || null,
        hairColor: fields["Hair"] || fields["Hair Color"] || null,
        education: fields["Education"] || fields["Education Level"] || null,
        location: fields["Location"] || null,
        bloodType: fields["Blood Type"] || null,
        religion: fields["Religion"] || null,
        photoUrl,
        profileUrl: profilePath ? `${origin}${profilePath}` : null,
        status: donorStatus,
        cardHash: cardHashValue,
        _orchidCaseId: caseId,
        _orchidDonorName: donorName,
      };

      donors.push(donor);
    } catch (err: any) {
      console.error(`[donor-sync] Error parsing Orchid JMS card: ${err.message}`);
    }
  }

  console.log(`[donor-sync] Parsed ${donors.length} donors from Orchid JMS HTML`);
  return donors;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&emsp;/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, "\u201D")
    .replace(/&ldquo;/g, "\u201C")
    .replace(/&#\d+;/g, (m) => String.fromCharCode(parseInt(m.slice(2, -1))));
}

function stripTags(str: string): string {
  return str.replace(/<[^>]*>/g, "").trim();
}

function cleanValue(raw: string): string {
  return decodeHtmlEntities(stripTags(raw)).replace(/\s+/g, " ").trim();
}

function extractColBlocks(html: string): string[] {
  const blocks: string[] = [];
  const colOpenRegex = /<div class="col-\d+[^"]*"[^>]*data-profile-question-id/g;
  let m;
  while ((m = colOpenRegex.exec(html)) !== null) {
    let depth = 0;
    let end = m.index;
    for (let i = m.index; i < Math.min(m.index + 5000, html.length); i++) {
      if (html.substring(i, i + 4) === "<div") depth++;
      if (html.substring(i, i + 6) === "</div>") {
        depth--;
        if (depth === 0) { end = i + 6; break; }
      }
    }
    blocks.push(html.substring(m.index, end));
  }
  return blocks;
}

function parseOrchidProfileFields(html: string): Record<string, any> {
  const profile: Record<string, any> = {};
  const sections: Record<string, Record<string, any>> = {};
  let m;

  const keyValueRegex = /<label class="key">(.*?)<\/label>\s*<div class="value">([\s\S]*?)<\/div>/g;
  while ((m = keyValueRegex.exec(html)) !== null) {
    const key = cleanValue(m[1]);
    const value = cleanValue(m[2]);
    if (key && value) profile[key] = value;
  }

  const titleRegex = /<div class="title">([\s\S]*?)<\/div>/g;
  const sectionPositions: { name: string; startPos: number }[] = [];
  while ((m = titleRegex.exec(html)) !== null) {
    const name = cleanValue(m[1]);
    if (name && name !== "WARNING") sectionPositions.push({ name, startPos: m.index });
  }

  for (let si = 0; si < sectionPositions.length; si++) {
    const sec = sectionPositions[si];
    const sectionEnd = si + 1 < sectionPositions.length ? sectionPositions[si + 1].startPos : html.length;
    const sectionHtml = html.substring(sec.startPos, sectionEnd);

    const allFields: { key: string; value: string }[] = [];
    const keyCounts = new Map<string, number>();

    const colBlocks = extractColBlocks(sectionHtml);
    for (const block of colBlocks) {
      const fieldMatch = block.match(/<label class="field">([\s\S]*?)<\/label>/);
      if (!fieldMatch) continue;
      const key = cleanValue(fieldMatch[1]);
      if (!key) continue;

      const answerMatch = block.match(/<div class="answer">([\s\S]*?)<\/div>/);
      if (answerMatch) {
        const val = cleanValue(answerMatch[1]);
        if (val) {
          allFields.push({ key, value: val });
          keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
          if (!profile[key]) profile[key] = val;
          continue;
        }
      }

      if (block.includes("print-checkbox") || block.includes("check-group")) {
        const checked: string[] = [];
        const checkRegex = /checked\s+class="[^"]*check-input[^"]*"[^>]*>\s*<label[^>]*><\/label>\s*<label[^>]*class="checkbox-value">([\s\S]*?)<\/label>/g;
        let cm;
        while ((cm = checkRegex.exec(block)) !== null) {
          const val = cleanValue(cm[1]);
          if (val) checked.push(val);
        }
        if (checked.length > 0) {
          allFields.push({ key, value: checked.join(", ") });
          keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
          if (!profile[key]) profile[key] = checked.join(", ");
        }
      }
    }

    const nonColFieldRegex = /<label class="field">([\s\S]*?)<\/label>\s*(?:<\/?\w[^>]*>\s*)*<div class="answer">([\s\S]*?)<\/div>/g;
    const colBlockRanges: { start: number; end: number }[] = [];
    for (const block of colBlocks) {
      const blockIdx = sectionHtml.indexOf(block);
      if (blockIdx >= 0) {
        colBlockRanges.push({ start: blockIdx, end: blockIdx + block.length });
      }
    }
    let fm;
    while ((fm = nonColFieldRegex.exec(sectionHtml)) !== null) {
      if (colBlockRanges.some(r => fm!.index >= r.start && fm!.index < r.end)) continue;
      const key = cleanValue(fm[1]);
      let value = fm[2];
      if (value.includes("<br") || value.includes("</p>")) {
        value = decodeHtmlEntities(
          value.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]*>/g, "")
        ).trim();
      } else {
        value = cleanValue(value);
      }
      if (key && value) {
        allFields.push({ key, value });
        keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
        if (!profile[key]) profile[key] = value;
      }
    }

    const hasRepeatingKeys = [...keyCounts.values()].some(c => c > 1);

    const HISTORY_HEADER_FIELDS: Record<string, Set<string>> = {
      "Donation History": new Set(["Previous Donor"]),
      "Pregnancy History": new Set(["Have you ever been pregnant", "Number of Pregnancies"]),
      "Surrogacy History": new Set(["Previous Surrogate"]),
    };
    const historyHeaderSet = HISTORY_HEADER_FIELDS[sec.name];

    if (historyHeaderSet && allFields.length > 0) {
      const headerFields: Record<string, any> = {};
      const entryFields: { key: string; value: string }[] = [];
      for (const f of allFields) {
        if (historyHeaderSet.has(f.key)) {
          headerFields[f.key] = f.value;
        } else {
          entryFields.push(f);
        }
      }

      if (hasRepeatingKeys) {
        const firstRepeatingKey = [...keyCounts.entries()].find(([, c]) => c > 1)?.[0];
        if (firstRepeatingKey) {
          const rows: Record<string, string>[] = [];
          let currentRow: Record<string, string> = {};
          for (const f of entryFields) {
            if (f.key === firstRepeatingKey && Object.keys(currentRow).length > 0) {
              rows.push(currentRow);
              currentRow = {};
            }
            currentRow[f.key] = f.value;
          }
          if (Object.keys(currentRow).length > 0) rows.push(currentRow);
          if (rows.length > 0) {
            headerFields["Entries"] = rows;
          }
        }
      } else if (entryFields.length > 0) {
        const singleRow: Record<string, string> = {};
        for (const f of entryFields) singleRow[f.key] = f.value;
        headerFields["Entries"] = [singleRow];
      }

      if (Object.keys(headerFields).length > 0) {
        sections[sec.name] = headerFields;
      }
    } else if (hasRepeatingKeys && allFields.length > 0) {
      const firstRepeatingKey = [...keyCounts.entries()].find(([, c]) => c > 1)?.[0];
      if (firstRepeatingKey) {
        const headerFields: Record<string, any> = {};
        const entryFields: { key: string; value: string }[] = [];
        let foundFirstRepeat = false;

        for (const f of allFields) {
          if (f.key === firstRepeatingKey && !foundFirstRepeat) {
            foundFirstRepeat = true;
          }
          if (!foundFirstRepeat) {
            headerFields[f.key] = f.value;
          } else {
            entryFields.push(f);
          }
        }

        const rows: Record<string, string>[] = [];
        let currentRow: Record<string, string> = {};
        for (const f of entryFields) {
          if (f.key === firstRepeatingKey && Object.keys(currentRow).length > 0) {
            rows.push(currentRow);
            currentRow = {};
          }
          currentRow[f.key] = f.value;
        }
        if (Object.keys(currentRow).length > 0) rows.push(currentRow);

        if (rows.length > 0) {
          if (Object.keys(headerFields).length > 0) {
            headerFields["Entries"] = rows;
            sections[sec.name] = headerFields;
          } else {
            sections[sec.name] = rows;
          }
        } else if (Object.keys(headerFields).length > 0) {
          sections[sec.name] = headerFields;
        }
      }
    } else if (allFields.length > 0) {
      const sectionData: Record<string, any> = {};
      for (const f of allFields) {
        if (!sectionData[f.key]) sectionData[f.key] = f.value;
      }
      sections[sec.name] = sectionData;
    }
  }

  if (Object.keys(sections).length > 0) {
    profile["_sections"] = sections;
  }

  return profile;
}

function parseOrchidProfileTables(html: string): Record<string, any[]> {
  const tableData: Record<string, any[]> = {};
  const tableSections: { name: string; label: string }[] = [
    { name: "family-members", label: "Family Members" },
    { name: "health-history", label: "Family Health History" },
    { name: "education", label: "Education Details" },
    { name: "test-results", label: "Test Results" },
    { name: "preferences", label: "Preferences" },
    { name: "miscarriage", label: "Miscarriage" },
  ];

  for (const { name, label } of tableSections) {
    const sectionMarker = `section-card-${name}"`;
    const sectionIdx = html.indexOf(sectionMarker);
    if (sectionIdx < 0) continue;

    const nextSectionIdx = html.indexOf("section-card-body section-card-", sectionIdx + sectionMarker.length);
    const sectionHtml = nextSectionIdx > 0
      ? html.substring(sectionIdx, nextSectionIdx)
      : html.substring(sectionIdx, sectionIdx + 50000);

    const headers: string[] = [];
    let m;
    const headerRegex = /ed-profile-header">([\s\S]*?)<\/div>/g;
    while ((m = headerRegex.exec(sectionHtml)) !== null) {
      headers.push(cleanValue(m[1]));
    }
    if (headers.length === 0) continue;

    const rows: Record<string, string>[] = [];
    const bodyRowStarts: number[] = [];
    const bodyRowMarker = /class="row ed-profile-body-row/g;
    while ((m = bodyRowMarker.exec(sectionHtml)) !== null) {
      bodyRowStarts.push(m.index);
    }

    for (let ri = 0; ri < bodyRowStarts.length; ri++) {
      const rowStart = bodyRowStarts[ri];
      const rowEnd = ri + 1 < bodyRowStarts.length ? bodyRowStarts[ri + 1] : sectionHtml.length;
      const rowHtml = sectionHtml.substring(rowStart, rowEnd);
      const cells: string[] = [];
      const cellRegex = /ed-profile-item\s*">([\s\S]*?)<\/div>/g;
      while ((m = cellRegex.exec(rowHtml)) !== null) {
        cells.push(cleanValue(m[1]));
      }
      if (cells.length > 0 && cells.length >= headers.length) {
        const row: Record<string, string> = {};
        for (let i = 0; i < headers.length; i++) {
          row[headers[i]] = cells[i] || "";
        }
        rows.push(row);
      }
    }

    if (rows.length > 0) tableData[label] = rows;
  }

  return tableData;
}

function parseOrchidProfileLetter(html: string): { title?: string; text?: string } {
  const letterIdx = html.indexOf("section-card-letter-to-intended-parents");
  if (letterIdx < 0) return {};

  const nextIdx = html.indexOf("section-card-body section-card-", letterIdx + 40);
  const letterSection = nextIdx > 0 ? html.substring(letterIdx, nextIdx) : html.substring(letterIdx, letterIdx + 20000);

  const titleMatch = letterSection.match(/<label class="field">([\s\S]*?)<\/label>/);
  const letterTitle = titleMatch ? cleanValue(titleMatch[1]) : undefined;
  const answerMatch = letterSection.match(/<div class="answer">([\s\S]*?)<\/div>/);
  if (!answerMatch) return {};

  const letterText = decodeHtmlEntities(
    answerMatch[1]
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]*>/g, "")
  ).trim();

  if (letterText.length < 20) return {};
  return { title: letterTitle, text: letterText };
}

async function fetchOrchidJmsProfile(
  profileUrl: string,
  cookies?: string,
): Promise<Record<string, any> | null> {
  try {
    const html = await fetchHtml(profileUrl, cookies, 30000);
    if (!html || html.length < 200) return null;

    const profile = parseOrchidProfileFields(html);

    const tables = parseOrchidProfileTables(html);
    if (Object.keys(tables).length > 0) {
      profile["_tables"] = tables;
      if (profile["_sections"]) {
        for (const [tableName, tableRows] of Object.entries(tables)) {
          (profile["_sections"] as Record<string, any>)[tableName] = tableRows;
        }
      }
    }

    const letter = parseOrchidProfileLetter(html);
    if (letter.text) {
      profile["Letter to Intended Parents"] = letter.text;
      if (letter.title) profile["Letter Title"] = letter.title;
      if (profile["_sections"]) {
        const letterSection = (profile["_sections"] as Record<string, any>)["Letter to Intended Parents"] || {};
        letterSection["_letterText"] = letter.text;
        if (letter.title) letterSection["_letterTitle"] = letter.title;
        (profile["_sections"] as Record<string, any>)["Letter to Intended Parents"] = letterSection;
      }
    }

    let m;
    const photos: string[] = [];
    const lazyImgRegex = /data-img-src="([^"]*tfc-jms\.s3[^"]*)"/g;
    while ((m = lazyImgRegex.exec(html)) !== null) {
      const url = m[1].replace(/&amp;/g, "&");
      if (!url.includes("logo") && !url.includes("favicon")) {
        photos.push(url);
      }
    }
    const directImgRegex = /<img[^>]*src="([^"]*tfc-jms\.s3[^"]*)"[^>]*>/g;
    while ((m = directImgRegex.exec(html)) !== null) {
      const url = m[1].replace(/&amp;/g, "&");
      if (!url.includes("logo") && !url.includes("favicon") && !photos.includes(url)) photos.push(url);
    }
    if (photos.length > 0) {
      profile["Photos"] = photos;
      if (profile["_sections"]) {
        (profile["_sections"] as Record<string, any>)["Photos"] = photos;
      }
    }

    if (profile["Request Fee Amount"]) {
      profile["Donor Compensation"] = profile["Request Fee Amount"];
    }
    if (profile["Natural Hair Color"] && !profile["Hair Color"]) {
      profile["Hair Color"] = profile["Natural Hair Color"];
    }
    if (profile["Education Level"] && !profile["Education"]) {
      profile["Education"] = profile["Education Level"];
    }

    return profile;
  } catch (err: any) {
    console.error(`[donor-sync] Error fetching Orchid JMS profile ${profileUrl}: ${err.message}`);
    return null;
  }
}

function getMandatoryFieldChecks(type: DonorType): { label: string; check: (d: any) => boolean }[] {
  const has = (val: any) => val != null && val !== "";
  if (type === "egg-donor") {
    return [
      { label: "Age", check: (d) => has(d.age) },
      { label: "Education Level", check: (d) => has(d.education) || has(d.profileData?.["Education Level"]) || has(d.profileData?.["Education"]) },
      { label: "Eye Color", check: (d) => has(d.eyeColor) || has(d.profileData?.["Eye Color"]) },
      { label: "Location", check: (d) => has(d.location) },
      { label: "Hair Color", check: (d) => has(d.hairColor) || has(d.profileData?.["Hair Color"]) },
      { label: "Donation Types", check: (d) => has(d.donationTypes) || has(d.profileData?.["Type of Donation"]) || has(d.profileData?.["Donation Type"]) },
      { label: "Race", check: (d) => has(d.race) || has(d.profileData?.["Race"]) },
      { label: "Relationship Status", check: (d) => has(d.relationshipStatus) || has(d.profileData?.["Relationship Status"]) },
      { label: "Ethnicity", check: (d) => has(d.ethnicity) },
      { label: "Occupation", check: (d) => has(d.occupation) || has(d.profileData?.["Occupation"]) },
      { label: "Religion", check: (d) => has(d.religion) || has(d.profileData?.["Religion"]) },
      { label: "Egg Donor Compensation", check: (d) => has(d.donorCompensation) },
      { label: "Height", check: (d) => has(d.height) },
      { label: "Total Compensation", check: (d) => has(d.totalCost) },
      { label: "Weight", check: (d) => has(d.weight) },
      { label: "Blood Type", check: (d) => has(d.bloodType) },
    ];
  } else if (type === "surrogate") {
    return [
      { label: "Age", check: (d) => has(d.age) },
      { label: "Location", check: (d) => has(d.location) },
      { label: "BMI", check: (d) => has(d.bmi) },
      { label: "Relationship Status", check: (d) => has(d.relationshipStatus) || has(d.profileData?.["Relationship Status"]) },
      { label: "Height", check: (d) => has(d.height) || has(d.profileData?.["Height"]) },
      { label: "COVID Vaccinated", check: (d) => has(d.profileData?.["COVID vaccinated"]) || has(d.profileData?.["COVID Vaccinated"]) || d.covidVaccinated != null },
      { label: "Weight", check: (d) => has(d.weight) || has(d.profileData?.["Weight"]) },
      { label: "C-Sections", check: (d) => has(d.profileData?.["C-Sections"]) || d.cSections != null },
      { label: "Live Births", check: (d) => d.liveBirths != null },
      { label: "Miscarriages", check: (d) => has(d.profileData?.["Miscarriages"]) || d.miscarriages != null },
      { label: "Agrees to Twins", check: (d) => d.agreesToTwins != null },
      { label: "Base Compensation", check: (d) => has(d.baseCompensation) },
    ];
  } else {
    return [
      { label: "Age", check: (d) => has(d.age) },
      { label: "Education", check: (d) => has(d.education) },
      { label: "Type", check: (d) => has(d.donorType) },
      { label: "Location", check: (d) => has(d.location) },
      { label: "Ethnicity", check: (d) => has(d.ethnicity) },
      { label: "Hair Color", check: (d) => has(d.hairColor) },
      { label: "Height", check: (d) => has(d.height) },
      { label: "Eye Color", check: (d) => has(d.eyeColor) },
      { label: "Weight", check: (d) => has(d.weight) },
      { label: "Price", check: (d) => has(d.compensation) },
    ];
  }
}

export async function analyzeMissingFields(
  prisma: PrismaService,
  providerId: string,
  type: DonorType,
): Promise<MissingFieldSummary[]> {
  let donors: any[];
  if (type === "egg-donor") {
    donors = await prisma.eggDonor.findMany({ where: { providerId } });
  } else if (type === "surrogate") {
    donors = await prisma.surrogate.findMany({ where: { providerId } });
  } else {
    donors = await prisma.spermDonor.findMany({ where: { providerId } });
  }

  const checks = getMandatoryFieldChecks(type);
  const results: MissingFieldSummary[] = [];

  for (const { label, check } of checks) {
    const missingDonors: string[] = [];
    const missingUrls: Record<string, string> = {};
    for (const donor of donors) {
      if (!check(donor)) {
        const donorId = donor.externalId || donor.id.slice(0, 8);
        missingDonors.push(donorId);
        if (donor.profileUrl) {
          missingUrls[donorId] = donor.profileUrl;
        }
      }
    }
    if (missingDonors.length > 0) {
      results.push({
        field: label,
        count: missingDonors.length,
        donorIds: missingDonors,
        donorUrls: missingUrls,
      });
    }
  }

  results.sort((a, b) => b.count - a.count);
  return results;
}

const FIELD_SYNONYMS: Record<string, string> = {
  "marital status": "Relationship Status",
  "martial status": "Relationship Status",
  "marital": "Relationship Status",
  "partner status": "Relationship Status",
  "current relationship": "Relationship Status",
  "ethnicity": "Race",
  "ethnic background": "Race",
  "racial background": "Race",
  "ethnic origin": "Race",
  "date of birth": "Date of Birth",
  "dob": "Date of Birth",
  "birth date": "Date of Birth",
  "birthday": "Date of Birth",
  "educational level": "Education",
  "education level": "Education",
  "highest education": "Education",
  "degree": "Education",
  "school": "Education",
  "educational background": "Education",
  "eye colour": "Eye Color",
  "eye color": "Eye Color",
  "eyes": "Eye Color",
  "hair colour": "Hair Color",
  "hair color": "Hair Color",
  "hair": "Hair Color",
  "natural hair color": "Hair Color",
  "natural hair colour": "Hair Color",
  "body weight": "Weight",
  "current weight": "Weight",
  "weight (lbs)": "Weight",
  "weight (kg)": "Weight",
  "body height": "Height",
  "current height": "Height",
  "height (ft)": "Height",
  "height (cm)": "Height",
  "blood group": "Blood Type",
  "blood type": "Blood Type",
  "abo/rh": "Blood Type",
  "smoker": "Smoking",
  "smoking status": "Smoking",
  "tobacco use": "Smoking",
  "drinker": "Alcohol Use",
  "alcohol": "Alcohol Use",
  "alcohol consumption": "Alcohol Use",
  "drug use": "Drug Use",
  "recreational drugs": "Drug Use",
  "substance use": "Drug Use",
  "occupation": "Occupation",
  "current occupation": "Occupation",
  "job": "Occupation",
  "profession": "Occupation",
  "employment": "Occupation",
  "what is your employment status?": "Occupation",
  "employment status": "Occupation",
  "current employment": "Occupation",
  "if unemployed/stay at home parent, how are you financially supported?": "SKIP",
  "how are you financially supported?": "SKIP",
  "how are you financially supported": "SKIP",
  "if employed, please provide employer name and your job title?": "Occupation",
  "employer name and job title": "Occupation",
  "religion": "Religion",
  "religious background": "Religion",
  "faith": "Religion",
  "religious affiliation": "Religion",
  "location": "Location",
  "city": "Location",
  "state": "Location",
  "country of birth": "Country of Birth",
  "birthplace": "Country of Birth",
  "place of birth": "Country of Birth",
  "born in": "Country of Birth",
  "nationality": "Nationality",
  "citizenship": "Nationality",
  "bmi": "BMI",
  "body mass index": "BMI",
  "number of children": "Number of Children",
  "children": "Number of Children",
  "kids": "Number of Children",
  "prior pregnancies": "Previous Pregnancies",
  "previous pregnancies": "Previous Pregnancies",
  "pregnancies": "Previous Pregnancies",
  "c-sections": "C-Sections",
  "cesarean sections": "C-Sections",
  "c-section": "C-Sections",
  "caesarean": "C-Sections",
  "live births": "Live Births",
  "successful births": "Live Births",
  "miscarriages": "Miscarriages",
  "pregnancy losses": "Miscarriages",
  "agrees to carry twins": "Agrees to Twins",
  "willing to carry twins": "Agrees to Twins",
  "open to twins": "Agrees to Twins",
  "twins": "Agrees to Twins",
  "willing to carry multiple fetuses?": "Agrees to Twins",
  "would you be willing to carry twins?": "Agrees to Twins",
  "transfer type": "Transfer Type",
  "embryo transfer type": "Transfer Type",
  "base compensation": "Base Compensation",
  "surrogate compensation": "Base Compensation",
  "compensation": "Base Compensation",
  "covid vaccination": "COVID Vaccination",
  "covid vaccine": "COVID Vaccination",
  "covid vaccinated": "COVID Vaccination",
  "vaccination status": "COVID Vaccination",
  "donor id": "Donor ID",
  "id": "Donor ID",
  "donor number": "Donor ID",
  "reference number": "Donor ID",
  "donor compensation": "Donor Compensation",
  "egg donor compensation": "Donor Compensation",
  "fresh cycle compensation": "Donor Compensation",
  "compensation amount": "Donor Compensation",
  "egg lot cost": "Egg Lot Cost",
  "lot cost": "Egg Lot Cost",
  "frozen egg lot cost": "Egg Lot Cost",
  "total cost": "Total Cost",
  "total price": "Total Cost",
  "total fee": "Total Cost",
  "donation type": "Donation Types",
  "type of donation": "Donation Types",
  "open id or anonymous?": "Donation Types",
  "open id or anonymous": "Donation Types",
  "would you prefer to do an anonymous donation": "Donation Types",
  "would you prefer to do an anonymous donation?": "Donation Types",
  "anonymous or open": "Donation Types",
  "anonymous or open?": "Donation Types",
};

const CANONICAL_FIELDS = [
  "Relationship Status", "Occupation", "Religion", "Race", "Education",
  "Eye Color", "Hair Color", "Blood Type", "Height", "Weight", "BMI",
  "Location", "Country of Birth", "Nationality", "Date of Birth",
  "Smoking", "Alcohol Use", "Drug Use", "Number of Children",
  "Previous Pregnancies", "C-Sections", "Live Births", "Miscarriages",
  "Agrees to Twins", "Base Compensation", "COVID Vaccination",
  "Donor ID", "Donor Compensation", "Egg Lot Cost", "Total Cost",
  "Donation Types", "All Photos",
];

const aiFieldCache = new Map<string, string>();

async function normalizeFieldsWithAI(fields: string[]): Promise<Record<string, string>> {
  if (fields.length === 0) return {};
  const uncached = fields.filter((f) => !aiFieldCache.has(f.toLowerCase()));
  if (uncached.length === 0) {
    const result: Record<string, string> = {};
    for (const f of fields) {
      const cached = aiFieldCache.get(f.toLowerCase());
      if (cached && cached !== f) result[f] = cached;
    }
    return result;
  }

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { temperature: 0 } as any,
    });

    const prompt = `You are a data normalization assistant. Map each input field name to the closest canonical field name from the list below, or return "SKIP" if no match exists.

Canonical fields: ${CANONICAL_FIELDS.join(", ")}

Input fields (one per line):
${uncached.map((f, i) => `${i + 1}. "${f}"`).join("\n")}

Return ONLY a valid JSON object mapping each input field string to either the matching canonical field name or "SKIP". Example: {"What is your job?": "Occupation", "Favorite color": "SKIP"}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, string>;
    const mapping: Record<string, string> = {};

    for (const f of uncached) {
      const mapped = parsed[f];
      if (mapped && mapped !== "SKIP" && CANONICAL_FIELDS.includes(mapped)) {
        aiFieldCache.set(f.toLowerCase(), mapped);
        mapping[f] = mapped;
      } else {
        aiFieldCache.set(f.toLowerCase(), f);
      }
    }

    for (const f of fields) {
      const cached = aiFieldCache.get(f.toLowerCase());
      if (cached && cached !== f && !mapping[f]) mapping[f] = cached;
    }

    return mapping;
  } catch (err: any) {
    console.error(`[donor-sync] AI field normalization failed: ${err.message}`);
    return {};
  }
}

function deriveDonationTypeFromProfile(profileDetails: Record<string, any>): string | null {
  let prefersAnonymous: boolean | null = null;
  let willingToMeet: boolean | null = null;
  let openIdValue: string | null = null;

  for (const section of Object.values(profileDetails) as any[]) {
    if (typeof section !== "object" || !section) continue;
    for (const [key, val] of Object.entries(section)) {
      const kl = key.toLowerCase();
      const vl = typeof val === "string" ? val.toLowerCase().trim() : "";

      if (kl.includes("open id or anonymous")) {
        openIdValue = typeof val === "string" ? val.trim() : null;
      }

      if (kl.includes("anonymous donation") || (kl.includes("prefer") && kl.includes("anonymous"))) {
        prefersAnonymous = vl === "yes" || vl === "true";
      }

      if (kl === "donation types" && (vl === "yes" || vl === "no")) {
        if (prefersAnonymous === null) {
          prefersAnonymous = vl === "yes";
        }
      }

      if ((kl.includes("willing") && kl.includes("meet")) || (kl.includes("willing") && kl.includes("talk"))) {
        willingToMeet = vl === "yes" || vl === "true";
      }
    }
  }

  if (openIdValue && openIdValue !== "Yes" && openIdValue !== "No") {
    return openIdValue;
  }

  if (prefersAnonymous === true && willingToMeet === true) {
    return "Semi-Open";
  } else if (prefersAnonymous === true) {
    return "Anonymous";
  } else if (prefersAnonymous === false && willingToMeet === true) {
    return "Open";
  } else if (prefersAnonymous === false) {
    return "Open";
  }

  return null;
}

async function normalizeProfileFields(profileData: Record<string, any>): Promise<Record<string, any>> {
  const normalized: Record<string, any> = {};
  const unmatchedKeys: string[] = [];

  for (const [key, value] of Object.entries(profileData)) {
    const lowerKey = key.toLowerCase().trim();
    const canonicalKey = FIELD_SYNONYMS[lowerKey];
    if (canonicalKey && !(canonicalKey in normalized)) {
      normalized[canonicalKey] = value;
    } else if (!canonicalKey) {
      if (!(key in normalized)) {
        normalized[key] = value;
        if (key.length > 3 && typeof value !== "object") {
          unmatchedKeys.push(key);
        }
      }
    }
  }

  if (unmatchedKeys.length > 0) {
    try {
      const aiMappings = await normalizeFieldsWithAI(unmatchedKeys);
      for (const [originalKey, canonicalKey] of Object.entries(aiMappings)) {
        if (canonicalKey in normalized && originalKey in normalized) {
          continue;
        }
        if (originalKey in normalized && !(canonicalKey in normalized)) {
          normalized[canonicalKey] = normalized[originalKey];
          delete normalized[originalKey];
        }
      }
    } catch (err: any) {
      console.error(`[donor-sync] AI normalization pass failed: ${err.message}`);
    }
  }

  reclassifySupportSystemFields(normalized);

  return normalized;
}

const SUPPORT_SYSTEM_PATTERNS = [
  /how\s+do\s+you\s+expect.*(?:people|family|friends|children|employer|partner|spouse|husband|wife).*react/i,
  /how\s+will.*(?:family|friends|children|employer|partner|spouse|husband|wife).*(?:react|feel|respond|support)/i,
  /(?:family|friends|children|employer|partner|spouse|husband|wife).*(?:reaction|react|response|support|feel about).*surrog/i,
  /support.*(?:during|throughout).*(?:pregnancy|surrogacy|journey)/i,
  /who\s+will\s+(?:help|support|care|assist|take\s+care)/i,
  /(?:childcare|bedrest|caretaker).*(?:plan|support|assistance|help)/i,
  /(?:^|\s)support\s+(?:system|network|team)\b/i,
  /(?:emotional|mental|psychological)\s+support/i,
];

function isSupportSystemField(key: string): boolean {
  const lk = key.toLowerCase();
  if (SUPPORT_SYSTEM_PATTERNS.some(p => p.test(lk))) return true;
  if (/react.*surrogate|surrogate.*react/i.test(lk)) return true;
  if (/following\s+people\s+will\s+react/i.test(lk)) return true;
  return false;
}

function reclassifySupportSystemFields(profileData: Record<string, any>): void {
  const sections = profileData._sections;
  if (!sections || typeof sections !== "object") return;

  const supportSection: Record<string, any> = sections["Support System"] && typeof sections["Support System"] === "object"
    ? { ...sections["Support System"] }
    : {};
  let moved = false;

  for (const [sectionName, sectionData] of Object.entries(sections)) {
    if (sectionName === "Support System") continue;
    if (!sectionData || typeof sectionData !== "object" || Array.isArray(sectionData)) continue;

    const keysToMove: string[] = [];
    for (const key of Object.keys(sectionData)) {
      if (key.startsWith("_")) continue;
      if (isSupportSystemField(key)) {
        keysToMove.push(key);
      }
    }

    for (const key of keysToMove) {
      supportSection[key] = sectionData[key];
      delete sectionData[key];
      moved = true;
    }
  }

  if (moved && Object.keys(supportSection).length > 0) {
    sections["Support System"] = supportSection;
  }
}

function extractVideoUrl(html: string): string | null {
  const vimeoMatch = html.match(/(?:src|href)=["']?(https?:\/\/(?:player\.)?vimeo\.com\/(?:video\/)?(\d+)[^"'\s]*)/i);
  if (vimeoMatch) return decodeHtmlEntities(vimeoMatch[1]);

  const youtubeMatch = html.match(/(?:src|href)=["']?(https?:\/\/(?:www\.)?(?:youtube\.com\/(?:embed|watch\?v=)|youtu\.be\/)[^"'\s]+)/i);
  if (youtubeMatch) return decodeHtmlEntities(youtubeMatch[1]);

  const videoSrcMatch = html.match(/<video[^>]*>\s*<source[^>]*src=["']([^"']+)["']/i);
  if (videoSrcMatch) return decodeHtmlEntities(videoSrcMatch[1]);

  const videoAttrMatch = html.match(/<video[^>]*src=["']([^"']+)["']/i);
  if (videoAttrMatch) return decodeHtmlEntities(videoAttrMatch[1]);

  const cdnVideoMatch = html.match(/["'](https?:\/\/[^"'\s]*?\.(?:mp4|webm|mov)[^"'\s]*)["']/i);
  if (cdnVideoMatch) return decodeHtmlEntities(cdnVideoMatch[1]);

  const iframeSrc = html.match(/<iframe[^>]*src=["']([^"']*(?:video|embed|player)[^"']*)["']/i);
  if (iframeSrc) return decodeHtmlEntities(iframeSrc[1]);

  return null;
}

function parseEdcProfilePage(html: string): Record<string, any> {
  const clean = (s: string) =>
    s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

  const profileData: Record<string, any> = {};

  const overviewMatch = html.match(
    /<th[^>]*>Donor Overview<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i,
  );
  if (overviewMatch) {
    const overviewText = clean(overviewMatch[1]);
    if (overviewText.length > 10) {
      profileData["Donor Overview"] = overviewText;
    }
  }

  const blocks: { type: "thead" | "tbody"; content: string }[] = [];
  const blockRegex = /<(thead|tbody)[^>]*>([\s\S]*?)<\/\1>/g;
  let bm;
  while ((bm = blockRegex.exec(html)) !== null) {
    blocks.push({ type: bm[1] as "thead" | "tbody", content: bm[2] });
  }
  for (let bi = 0; bi < blocks.length; bi++) {
    if (blocks[bi].type !== "thead") continue;
    const headerBlock = blocks[bi].content;
    if (headerBlock.includes("colspan")) continue;
    const nextTbody = bi + 1 < blocks.length && blocks[bi + 1].type === "tbody" ? blocks[bi + 1].content : null;
    if (!nextTbody) continue;
    const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/g;
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const headers: string[] = [];
    const values: string[] = [];
    let hm;
    while ((hm = thRegex.exec(headerBlock)) !== null) {
      headers.push(clean(hm[1]));
    }
    let dm;
    while ((dm = tdRegex.exec(nextTbody)) !== null) {
      values.push(clean(dm[1]));
    }
    for (let idx = 0; idx < headers.length; idx++) {
      const h = headers[idx];
      const v = idx < values.length ? values[idx] : "";
      if (h && v) {
        profileData[h] = v;
      }
    }
  }

  const contactMatch = html.match(
    /Contact[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i,
  );
  if (contactMatch) {
    const contactText = clean(contactMatch[1]);
    const phone = contactText.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
    const email = contactText.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (phone) profileData["Contact Phone"] = phone[0];
    if (email) profileData["Contact Email"] = email[0];
  }

  const geneticImages: string[] = [];
  const geneticSection = html.match(
    /Genetic Report[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i,
  );
  if (geneticSection) {
    const imgRegex = /src="([^"]+)"/g;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(geneticSection[1])) !== null) {
      geneticImages.push(imgMatch[1]);
    }
  }
  if (geneticImages.length > 0) {
    profileData["Genetic Report Images"] = geneticImages;
  }

  const photoUrls: string[] = [];
  const photoSection = html.match(
    /id="DonorPhotoGallery"[^>]*>([\s\S]*?)<\/td>/i,
  );
  if (photoSection) {
    const imgRegex = /src="([^"]+)"/g;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(photoSection[1])) !== null) {
      photoUrls.push(imgMatch[1]);
    }
  }
  if (photoUrls.length > 0) {
    profileData["All Photos"] = photoUrls;
  }

  const videoUrl = extractVideoUrl(html);
  if (videoUrl) {
    profileData["Video URL"] = videoUrl;
  }

  return profileData;
}

async function parseEdcProfileTab(html: string): Promise<Record<string, any>> {
  const result: Record<string, any> = {};
  const clean = (s: string) =>
    s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

  const sectionRegex = /<blockquote[^>]*class="[^"]*bq2[^"]*"[^>]*>([\s\S]*?)<\/blockquote>/g;
  let sm;
  while ((sm = sectionRegex.exec(html)) !== null) {
    const sectionHtml = sm[1];
    const nameMatch = sectionHtml.match(/<span[^>]*source-page[^>]*>([\s\S]*?)<\/span>/);
    const sectionName = nameMatch ? clean(nameMatch[1]) : "General";
    if (!sectionName) continue;

    const sectionData: Record<string, any> = {};

    const hasTable = sectionHtml.includes("answerTable");
    if (hasTable) {
      const tableLabelRegex = /<label[^>]*clinicLabelFontColor[^>]*>([\s\S]*?)<\/label>/g;
      const allLabels: { text: string; index: number }[] = [];
      let lblm;
      while ((lblm = tableLabelRegex.exec(sectionHtml)) !== null) {
        allLabels.push({ text: clean(lblm[1]), index: lblm.index });
      }

      const tableRegex = /<table[^>]*answerTable[^>]*>([\s\S]*?)<\/table>/g;
      let tblm;
      while ((tblm = tableRegex.exec(sectionHtml)) !== null) {
        const tableHtml = tblm[1];
        let lastTableLabel = sectionName;
        for (let li = allLabels.length - 1; li >= 0; li--) {
          if (allLabels[li].index < tblm.index && allLabels[li].text) {
            lastTableLabel = allLabels[li].text;
            break;
          }
        }

        const theadMatch = tableHtml.match(/<thead[^>]*>([\s\S]*?)<\/thead>/);
        const headerLabels: string[] = [];
        if (theadMatch) {
          const headerRegex = /<td[^>]*><label>([^<]*)<\/label><\/td>/g;
          let hm;
          while ((hm = headerRegex.exec(theadMatch[1])) !== null) {
            headerLabels.push(hm[1].trim());
          }
        }
        const isMatrixTable = headerLabels.filter(h => h.length > 1).length >= 3;

        if (isMatrixTable) {
          const matrixData: Record<string, string[]> = {};
          const rowRegex = /<tr[^>]*>\s*<td[^>]*><label>([^<]*)<\/label><\/td>([\s\S]*?)<\/tr>/g;
          let rm;
          while ((rm = rowRegex.exec(tableHtml)) !== null) {
            const condition = clean(rm[1]);
            const checkedMembers: string[] = [];
            const cellRegex = /<td class=""[^>]*data-label="([^"]*)"/g;
            let cellm;
            while ((cellm = cellRegex.exec(rm[2])) !== null) {
              const member = cellm[1].trim();
              if (member && member !== "None") checkedMembers.push(member);
            }
            if (checkedMembers.length > 0) {
              matrixData[condition] = checkedMembers;
            }
          }
          if (Object.keys(matrixData).length > 0) {
            sectionData[lastTableLabel] = matrixData;
          }
        } else {
          const rowData: Record<string, string> = {};
          const rowRegex = /<tr[^>]*>\s*<td[^>]*><label>([^<]*)<\/label><\/td>([\s\S]*?)<\/tr>/g;
          let rm;
          while ((rm = rowRegex.exec(tableHtml)) !== null) {
            const rowLabel = clean(rm[1]);
            const valMatch = rm[2].match(/<td[^>]*>([^<]*)<\/td>/);
            const val = valMatch ? clean(valMatch[1]) : "";
            if (rowLabel && val) rowData[rowLabel] = val;
          }
          if (Object.keys(rowData).length > 0) {
            sectionData[lastTableLabel] = rowData;
          }
        }
      }

      const simpleRegex = /<label[^>]*clinicLabelFontColor[^>]*>([\s\S]*?)<\/label>\s*<br\s*\/?>\s*<span>([\s\S]*?)<\/span>/g;
      let sqm;
      while ((sqm = simpleRegex.exec(sectionHtml)) !== null) {
        const q = clean(sqm[1]);
        const a = clean(sqm[2]);
        if (q && a && !sectionData[q]) {
          sectionData[q] = a;
        }
      }
    } else {
      const cellPositions: number[] = [];
      const cellPosRegex = /<div[^>]*answerCell/g;
      let cp;
      while ((cp = cellPosRegex.exec(sectionHtml)) !== null) {
        cellPositions.push(cp.index);
      }

      for (let ci = 0; ci < cellPositions.length; ci++) {
        const start = cellPositions[ci];
        const end = ci + 1 < cellPositions.length ? cellPositions[ci + 1] : sectionHtml.length;
        const cellHtml = sectionHtml.substring(start, end);

        const labelMatch = cellHtml.match(/<label[^>]*clinicLabelFontColor[^>]*>([\s\S]*?)<\/label>/);
        if (!labelMatch) continue;
        const question = clean(labelMatch[1]);
        if (!question) continue;

        const afterLabel = cellHtml.substring(cellHtml.indexOf(labelMatch[0]) + labelMatch[0].length);
        const spanMatch = afterLabel.match(/<span>([\s\S]*?)<\/span>/);
        const answer = spanMatch ? clean(spanMatch[1]) : "";

        const explanationMatch = afterLabel.match(/<em>([\s\S]*?)<\/em>/);
        const explanation = explanationMatch ? clean(explanationMatch[1]).replace(/^Donor Explanation:\s*/i, "").replace(/^If yes,\s*please explain[^:]*:\s*/i, "") : "";

        if (answer) {
          sectionData[question] = explanation ? `${answer} — ${explanation}` : answer;
        }
      }
    }

    if (Object.keys(sectionData).length > 0) {
      result[sectionName] = await normalizeProfileFields(sectionData);
    }
  }

  return result;
}

async function fetchEdcDonorProfile(
  profileUrl: string,
  cookies?: string,
): Promise<Record<string, any> | null> {
  try {
    const html = await fetchHtml(profileUrl, cookies, 15000);
    if (html.includes('type="password"') || html.length < 5000) {
      return null;
    }
    const overviewData = parseEdcProfilePage(html);

    const donorIdMatch = html.match(/id="hDonorId"[^>]*value="([^"]*)"/);
    if (donorIdMatch) {
      const hDonorId = donorIdMatch[1];
      const origin = new URL(profileUrl).origin;
      const profileTabUrl = `${origin}/Recipient/_DonorProfileHTML?DonorId=${hDonorId}`;
      try {
        const profileTabHtml = await fetchHtml(profileTabUrl, cookies, 15000);
        if (profileTabHtml && !profileTabHtml.includes('type="password"') && profileTabHtml.length > 200) {
          const profileTabData = await parseEdcProfileTab(profileTabHtml);
          if (Object.keys(profileTabData).length > 0) {
            overviewData["Profile Details"] = profileTabData;
          }
        }
      } catch (err: any) {
        console.error(`[donor-sync] Failed to fetch profile tab for donor ${hDonorId}: ${err.message}`);
      }
    }

    return await normalizeProfileFields(overviewData);
  } catch (err: any) {
    console.error(`[donor-sync] Failed to fetch profile ${profileUrl}: ${err.message}`);
    return null;
  }
}

async function fetchEdcAjaxDonors(
  dashboardHtml: string,
  origin: string,
  ajaxEndpoint: string,
  cookies?: string,
): Promise<string | null> {
  const recipientIdMatch = dashboardHtml.match(
    /id="RecipientId"[^>]*value="([^"]*)"/,
  );
  const clinicIdMatch = dashboardHtml.match(
    /id="dashboardClinicId"[^>]*value="([^"]*)"/,
  );

  const recipientId = recipientIdMatch ? recipientIdMatch[1] : "0";
  const clinicId = clinicIdMatch ? clinicIdMatch[1] : "0";

  console.log(`[donor-sync] EDC AJAX call: RecipientId=${recipientId}, ClinicId=${clinicId}`);

  const payload = {
    CustomFilters: [],
    SortBy: null,
    Heritages: [],
    OnlyShowRecipientFrozen: false,
    OnlyShowRecipientFresh: false,
    TertiaryStatuses: [],
    IPPhotoIdForFacialMatching: null,
    AffiliateClinicIdOverride: null,
    ScriptsOnly: false,
    tabNumber: 0,
    ShowLiveBirthGuarantee: false,
    EducationLevels: [],
    AllEducationLevels: true,
    ClinicField1: null,
    BloodTypes: [],
    AllBloodTypes: true,
    DonorCodeSearch: null,
    ClinicId: clinicId,
    FreshOrFrozen: null,
    AllEthnicities: true,
    Ethnicities: [],
    AdditionalClinicId: null,
    useMetricSystem: false,
    ContactOptions: [],
    AllContactOptions: true,
    PreviewAccessOnly: false,
    KnownOnly: false,
    RecipientId: recipientId,
    SplitOnly: null,
    AllHeights: true,
    minHeight: 48,
    maxHeight: 84,
    HairColors: [],
    AllHair: true,
    EyeColors: [],
    AllEyes: true,
    AllRaces: true,
    Races: [],
    ProvenDonor: null,
  };

  const headers: Record<string, string> = {
    ...DEFAULT_HEADERS,
    "Content-Type": "application/json; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    Accept: "text/html, */*; q=0.01",
    Referer: `${origin}${ajaxEndpoint.replace('/_', '/')}`,
    Origin: origin,
  };
  if (cookies) {
    headers["Cookie"] = cookies;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const fetchUrl = new URL(ajaxEndpoint, origin).href;
    console.log(`[donor-sync] Firing EDC AJAX request to: ${fetchUrl}`);
    const response = await fetch(fetchUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: "follow",
      },
    );
    if (!response.ok) {
      console.error(`[donor-sync] EDC AJAX returned ${response.status}`);
      return null;
    }
    const html = await response.text();
    console.log(`[donor-sync] EDC AJAX returned ${html.length} chars of donor HTML`);
    return html.slice(0, 5000000);
  } catch (err: any) {
    console.error(`[donor-sync] EDC AJAX error: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function markStaleDonors(
  prisma: PrismaService,
  providerId: string,
  type: DonorType,
  scrapedExternalIds: Set<string>,
): Promise<number> {
  if (scrapedExternalIds.size === 0) {
    console.log(`[donor-sync] Skipping stale detection — no scraped IDs to compare against`);
    return 0;
  }

  let existingCount: number;
  if (type === "egg-donor") {
    existingCount = await prisma.eggDonor.count({ where: { providerId, status: { not: "INACTIVE" } } });
  } else if (type === "surrogate") {
    existingCount = await prisma.surrogate.count({ where: { providerId, status: { not: "INACTIVE" } } });
  } else {
    existingCount = await prisma.spermDonor.count({ where: { providerId, status: { not: "INACTIVE" } } });
  }

  if (existingCount > 0 && scrapedExternalIds.size < existingCount * 0.5) {
    console.warn(`[donor-sync] Skipping stale detection — scraped only ${scrapedExternalIds.size} donors but ${existingCount} exist in DB (possible partial scrape)`);
    return 0;
  }

  let staleDonors: { id: string; externalId: string | null }[];

  if (type === "egg-donor") {
    staleDonors = await prisma.eggDonor.findMany({
      where: {
        providerId,
        status: { not: "INACTIVE" },
        externalId: { notIn: Array.from(scrapedExternalIds) },
      },
      select: { id: true, externalId: true },
    });
  } else if (type === "surrogate") {
    staleDonors = await prisma.surrogate.findMany({
      where: {
        providerId,
        status: { not: "INACTIVE" },
        externalId: { notIn: Array.from(scrapedExternalIds) },
      },
      select: { id: true, externalId: true },
    });
  } else {
    staleDonors = await prisma.spermDonor.findMany({
      where: {
        providerId,
        status: { not: "INACTIVE" },
        externalId: { notIn: Array.from(scrapedExternalIds) },
      },
      select: { id: true, externalId: true },
    });
  }

  if (staleDonors.length === 0) return 0;

  const staleIds = staleDonors.map((d) => d.id);
  const staleExtIds = staleDonors.map((d) => d.externalId || d.id.slice(0, 8));
  console.log(`[donor-sync] Marking ${staleDonors.length} stale ${type} donors as INACTIVE: ${staleExtIds.slice(0, 10).join(", ")}${staleExtIds.length > 10 ? ` +${staleExtIds.length - 10} more` : ""}`);

  if (type === "egg-donor") {
    await prisma.eggDonor.updateMany({
      where: { id: { in: staleIds } },
      data: { status: "INACTIVE" },
    });
  } else if (type === "surrogate") {
    await prisma.surrogate.updateMany({
      where: { id: { in: staleIds } },
      data: { status: "INACTIVE" },
    });
  } else {
    await prisma.spermDonor.updateMany({
      where: { id: { in: staleIds } },
      data: { status: "INACTIVE" },
    });
  }

  return staleDonors.length;
}

async function runSyncJob(
  prisma: PrismaService,
  job: SyncJob,
  sourceUrl: string,
  credentials?: { username: string; password: string },
  profileLimit?: number,
  storageService?: StorageService | null,
): Promise<void> {
  try {
    console.log(`[donor-sync] Starting ${job.type} sync for provider ${job.providerId} from ${sourceUrl}`);

    let sessionCookies: string | undefined;

    if (credentials) {
      const loginUrl = new URL(sourceUrl);
      const loginCandidates: string[] = [];
      const sourcePath = loginUrl.pathname.toLowerCase();
      if (sourcePath.includes("login") || sourcePath.includes("signin") || sourcePath.includes("sign-in")) {
        loginCandidates.push(sourceUrl);
      }
      loginCandidates.push(loginUrl.origin + "/Account/Login");
      if (!loginCandidates.includes(loginUrl.origin + "/login")) {
        loginCandidates.push(loginUrl.origin + "/login");
      }

      let authenticated = false;
      for (const candidate of loginCandidates) {
        console.log(`[donor-sync] Trying login at ${candidate}`);
        const cookies = await authenticateAndGetCookies(
          candidate,
          credentials.username,
          credentials.password,
        );
        if (cookies) {
          sessionCookies = cookies;
          authenticated = true;
          break;
        }
      }
      if (!authenticated) {
        job.status = "failed";
        job.errors.push("Login failed. Please verify your username and password are correct.");
        job.completedAt = new Date();
        console.error(`[donor-sync] Login failed for ${credentials.username} — aborting sync`);

        const syncConfigUpdate = {
          lastSyncAt: new Date(),
          lastSyncEndedAt: new Date(),
          syncStatus: "FAILED",
        };
        switch (job.type) {
          case "egg-donor":
            await prisma.eggDonorSyncConfig.update({ where: { providerId: job.providerId }, data: syncConfigUpdate });
            break;
          case "surrogate":
            await prisma.surrogateSyncConfig.update({ where: { providerId: job.providerId }, data: syncConfigUpdate });
            break;
          case "sperm-donor":
            await prisma.spermDonorSyncConfig.update({ where: { providerId: job.providerId }, data: syncConfigUpdate });
            break;
        }
        return;
      }
    }

    let mainHtml = "";
    try {
      mainHtml = await fetchHtml(sourceUrl, sessionCookies);
    } catch (err: any) {
      console.warn(`[donor-sync] Failed to fetch source URL (${err.message}), will try dashboard URLs directly`);
    }
    console.log(`[donor-sync] Fetched main page (${mainHtml.length} chars)`);

    const isLoginPage = mainHtml.length === 0 || (mainHtml.includes('type="password"') &&
      (mainHtml.toLowerCase().includes("sign in") || mainHtml.toLowerCase().includes("log in")));
    if (isLoginPage && sessionCookies) {
      console.log(`[donor-sync] Page appears to be a login form, trying known EDC dashboard URLs for ${job.type} after auth...`);
      const origin = new URL(sourceUrl).origin;
      const typeEndpoints: Record<DonorType, string[]> = {
        "egg-donor": [
          "/Recipient/DonorDashboardMatching",
          "/Recipient/DonorDashboard",
          "/Recipient/Dashboard",
        ],
        "surrogate": [
          "/Recipient/SurrogateDashboardMatching",
          "/Recipient/SurrogateDashboard",
          "/Recipient/GCDashboard",
          "/Recipient/Dashboard",
        ],
        "sperm-donor": [
          "/Recipient/SpermDonorDashboardMatching",
          "/Recipient/SpermDonorDashboard",
          "/Recipient/SpermDashboard",
          "/Recipient/Dashboard",
        ],
      };
      const endpoints = typeEndpoints[job.type];
      
      let foundDashboard = false;
      for (const endpoint of endpoints) {
        try {
          const dashHtml = await fetchHtml(origin + endpoint, sessionCookies);
          if (!dashHtml.includes('type="password"')) {
            mainHtml = dashHtml;
            sourceUrl = origin + endpoint;
            foundDashboard = true;
            console.log(`[donor-sync] Dashboard found at ${endpoint} (${dashHtml.length} chars)`);
            break;
          }
        } catch (err: any) {
          console.warn(`[donor-sync] Endpoint ${endpoint} failed: ${err.message}`);
        }
      }
      
      if (!foundDashboard) {
        try {
          mainHtml = await fetchHtml(origin + "/", sessionCookies);
        } catch (err: any) {
          console.warn(`[donor-sync] Root URL also failed: ${err.message}`);
        }
        sourceUrl = origin + "/";
      }
      console.log(`[donor-sync] Fetched post-auth page from ${sourceUrl} (${mainHtml.length} chars)`);
    } else if (isLoginPage) {
      job.status = "failed";
      job.errors.push("The source URL leads to a login page but no credentials were provided. Please add a username and password in the sync configuration.");
      job.completedAt = new Date();
      return;
    }

    if (sessionCookies && mainHtml.length > 0 && !isOrchidJmsSite(mainHtml) && !sourceUrl.includes("o-jms.com") && !mainHtml.includes("donorCardDiv")) {
      const typeNavKeywords: Record<DonorType, RegExp> = {
        "egg-donor": /egg\s*donor|donor\s*match|donor\s*database|donor\s*search|find\s*(?:a\s*)?donor|browse\s*donor/i,
        "surrogate": /surrogate|gestational\s*carrier|\bgc\b|surrogate\s*match|find\s*(?:a\s*)?surrogate|browse\s*surrogate/i,
        "sperm-donor": /sperm\s*donor|sperm\s*bank|sperm\s*match|find\s*sperm|browse\s*sperm/i,
      };
      const navPattern = typeNavKeywords[job.type];
      const linkMatches = [...mainHtml.matchAll(/href="([^"]+)"[^>]*>([^<]*)</gi)];
      const navCandidates = linkMatches
        .filter(m => navPattern.test(m[2]) || navPattern.test(m[1]))
        .filter(m => !/\.(css|js|png|jpg|svg|ico|woff|ttf|pdf)\b/i.test(m[1]))
        .filter(m => !m[1].startsWith("#") && !m[1].startsWith("javascript:"));

      if (navCandidates.length > 0) {
        const navUrl = new URL(navCandidates[0][1], new URL(sourceUrl)).href;
        console.log(`[donor-sync] Found type-aware nav link for ${job.type}: "${navCandidates[0][2].trim()}" → ${navUrl}`);
        try {
          const navHtml = await fetchHtml(navUrl, sessionCookies);
          if (navHtml.length > mainHtml.length / 2 && !navHtml.includes('type="password"')) {
            mainHtml = navHtml;
            sourceUrl = navUrl;
            console.log(`[donor-sync] Navigated to ${job.type} listing page (${navHtml.length} chars)`);
          }
        } catch (err: any) {
          console.warn(`[donor-sync] Type-aware nav link failed: ${err.message}`);
        }
      }
    }

    let orchidResult: { donors: any[]; origin: string } | null = null;
    if (isOrchidJmsSite(mainHtml) || sourceUrl.includes("o-jms.com")) {
      console.log(`[donor-sync] Detected Orchid JMS site, trying Orchid JMS scraper...`);
      orchidResult = await tryFetchOrchidJmsData(mainHtml, sourceUrl, sessionCookies, job.type);
      if (orchidResult && orchidResult.donors.length > 0) {
        console.log(`[donor-sync] Orchid JMS: found ${orchidResult.donors.length} donors total across all pages`);
      }
    }

    if (orchidResult && orchidResult.donors.length > 0) {
      const seenIds = new Set<string>();
      const uniqueItems = orchidResult.donors.filter((d) => {
        const key = d.externalId;
        if (!key || seenIds.has(key)) return false;
        seenIds.add(key);
        return true;
      });
      if (profileLimit && profileLimit > 0 && uniqueItems.length > profileLimit) {
        console.log(`[donor-sync] Limiting to ${profileLimit} profiles (test mode)`);
        uniqueItems.splice(profileLimit);
      }
      job.total = uniqueItems.length;
      job.processed = 0;

      const existingHashes = new Map<string, string>();
      const existingProfilesQuery = job.type === "surrogate"
        ? prisma.surrogate.findMany({
            where: { providerId: job.providerId, externalId: { in: uniqueItems.map((d: any) => d.externalId).filter(Boolean) } },
            select: { externalId: true, cardHash: true },
          })
        : job.type === "sperm-donor"
        ? prisma.spermDonor.findMany({
            where: { providerId: job.providerId, externalId: { in: uniqueItems.map((d: any) => d.externalId).filter(Boolean) } },
            select: { externalId: true, cardHash: true },
          })
        : prisma.eggDonor.findMany({
            where: { providerId: job.providerId, externalId: { in: uniqueItems.map((d: any) => d.externalId).filter(Boolean) } },
            select: { externalId: true, cardHash: true },
          });
      const existingDonors = await existingProfilesQuery;
      for (const d of existingDonors) {
        if (d.externalId && d.cardHash) existingHashes.set(d.externalId, d.cardHash);
      }

      let skippedUnchanged = 0;
      console.log(`[donor-sync] Found ${uniqueItems.length} unique Orchid JMS ${job.type} profiles to import`);
      console.log(`[donor-sync] Fetching profiles and importing...`);

      const BATCH_SIZE = 3;
      for (let i = 0; i < uniqueItems.length; i += BATCH_SIZE) {
        if (isJobCancelled(job.id)) {
          console.log(`[donor-sync] Sync cancelled at ${i}/${uniqueItems.length}`);
          break;
        }
        const batch = uniqueItems.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (item) => {
          const oldHash = item.externalId ? existingHashes.get(item.externalId) : null;
          if (oldHash && oldHash === item.cardHash) {
            skippedUnchanged++;
            job.processed++;
            return;
          }
          if (item.profileUrl) {
            const fullProfile = await fetchOrchidJmsProfile(item.profileUrl, sessionCookies);
            if (fullProfile && Object.keys(fullProfile).length > 0) {
              item.profileData = fullProfile;
              const sections = fullProfile["_sections"] as Record<string, Record<string, any>> | undefined;
              const pt = sections?.["Physical Traits"] || {};
              const bi = sections?.["Basic Information"] || {};
              const pi = sections?.["Personal Information"] || {};
              const dh = sections?.["Donation History"] || {};
              const pref = sections?.["Preferences"] || {};
              const surr = sections?.["Surrogacy"] || {};
              const health = sections?.["My Health History"] || {};
              const insur = sections?.["Insurance"] || {};
              const addInfo = sections?.["Additional Information"] || {};
              const so = sections?.["Significant Other"] || {};

              if (!item.ethnicity) item.ethnicity = fullProfile["Ethnicity"] || pt["Ethnicity"] || bi["Ethnicity"] || pi["Ethnic Background"] || null;
              if (!item.race) item.race = fullProfile["Race"] || pt["Race"] || bi["Race"] || null;
              if (!item.education) item.education = fullProfile["Education"] || fullProfile["Education Level"] || bi["Education"] || bi["Education Level"] || null;
              if (!item.eyeColor) item.eyeColor = fullProfile["Eye Color"] || pt["Eye Color"] || null;
              if (!item.hairColor) item.hairColor = fullProfile["Hair Color"] || fullProfile["Natural Hair Color"] || pt["Natural Hair Color"] || pt["Hair Color"] || null;
              if (!item.bloodType) item.bloodType = fullProfile["Blood Type"] || bi["Blood Type"] || addInfo["Blood Type"] || null;
              if (!item.location) item.location = fullProfile["Location"] || fullProfile["Current City"] || fullProfile["Current Location"] || bi["Current City"] || pi["Current Location"] || null;
              if (!item.religion) {
                const relField = fullProfile["Religion"] || fullProfile["Religious affiliation"] || bi["Religion"] || pi["Religious affiliation"] || null;
                if (relField) item.religion = relField;
              }
              if (!item.occupation) {
                const eduOcc = sections?.["Education and Occupation"] || {};
                const empStatus = eduOcc["What is your employment status?"] || eduOcc["Employment Status"] || eduOcc["Current Employment"] || null;
                const jobTitle = eduOcc["If employed, please provide employer name and your Job Title?"] || eduOcc["Job Title"] || null;
                const rawOcc = fullProfile["Occupation"] || fullProfile["Job Title"] || bi["Occupation"] || pi["Occupation"] || eduOcc["Occupation"] || null;
                const empLower = empStatus ? String(empStatus).toLowerCase() : "";
                const isNotEmployed = /stay.?at.?home|unemployed|homemaker|not.?employed|self.?employed.*parent/i.test(empLower);
                if (isNotEmployed) {
                  item.occupation = String(empStatus);
                } else if (empStatus && rawOcc) {
                  const rawLower = String(rawOcc).toLowerCase();
                  const mentionsOther = /\b(husband|wife|spouse|partner|family|parent[s']|father|mother)\b/i.test(rawLower);
                  item.occupation = mentionsOther ? (jobTitle ? String(jobTitle) : String(empStatus)) : String(rawOcc);
                } else {
                  item.occupation = rawOcc || empStatus || null;
                }
              }
              if (!item.relationshipStatus) item.relationshipStatus = fullProfile["Relationship Status"] || bi["Relationship Status"] || pi["Relationship Status"] || so["Relationship Status"] || null;
              if (!item.height) item.height = fullProfile["Height"] || pt["Height"] || bi["Height"] || null;
              if (!item.weight) item.weight = fullProfile["Weight"] || pt["Weight"] || bi["Weight"] || null;

              if (job.type === "surrogate") {
                if (!item.bmi) {
                  const bmiVal = fullProfile["BMI"] || bi["BMI"] || null;
                  if (bmiVal) {
                    const parsed = parseFloat(String(bmiVal));
                    if (!isNaN(parsed)) item.bmi = parsed;
                  }
                }
                if (!item.baseCompensation) {
                  const compVal = fullProfile["Compensation"] || fullProfile["Base Compensation"] || surr["Compensation"] || bi["Base Compensation"] || null;
                  if (compVal) {
                    const comp = String(compVal).replace(/[$,\s]/g, "");
                    if (comp && !isNaN(parseFloat(comp))) item.baseCompensation = parseFloat(comp);
                  }
                }
                const covidField = fullProfile["Have you been vaccinated for Coronavirus (COVID-19)?"] || health["Have you been vaccinated for Coronavirus (COVID-19)?"] || null;
                if (covidField && item.covidVaccinated == null) {
                  const cv = String(covidField).toLowerCase();
                  item.covidVaccinated = cv.includes("yes") || cv.includes("vaccinated");
                }
                if (item.liveBirths == null) {
                  const lb = fullProfile["Live Births"] || fullProfile["Number of Pregnancies"] || bi["Live Births"] || null;
                  if (lb != null) {
                    const parsed = parseInt(String(lb));
                    if (!isNaN(parsed)) item.liveBirths = parsed;
                  }
                }
                if (item.cSections == null) {
                  const cs = fullProfile["C-Sections"] || bi["C-Sections"] || null;
                  if (cs != null) {
                    const parsed = parseInt(String(cs));
                    if (!isNaN(parsed)) item.cSections = parsed;
                  }
                }
                if (item.miscarriages == null) {
                  const ms = fullProfile["Miscarriages"] || bi["Miscarriages"] || null;
                  if (ms != null) {
                    const parsed = parseInt(String(ms));
                    if (!isNaN(parsed)) item.miscarriages = parsed;
                  }
                }
                if (item.agreesToTwins == null) {
                  const twins = fullProfile["Willing to carry Multiple Fetuses?"] || fullProfile["Twins"]
                    || pref["Willing to carry Multiple Fetuses?"] || bi["Twins"]
                    || fullProfile["Willing to carry twins?"] || pref["Willing to carry twins?"]
                    || fullProfile["Open to twins"] || pref["Open to twins"]
                    || fullProfile["Agrees to carry twins"] || pref["Agrees to carry twins"]
                    || fullProfile["Would you be willing to carry twins?"] || pref["Would you be willing to carry twins?"]
                    || null;
                  if (twins != null) {
                    const tv = String(twins).toLowerCase();
                    item.agreesToTwins = tv.includes("yes") || tv === "true";
                  }
                }
                if (item.agreesToTwins == null) {
                  const transferType = fullProfile["Transfer Type"] || pref["Transfer Type"] || bi["Transfer Type"]
                    || fullProfile["Embryo Transfer Type"] || pref["Embryo Transfer Type"] || null;
                  if (transferType != null) {
                    const tt = String(transferType).toLowerCase().trim();
                    if (tt === "det" || tt.includes("double") || tt.includes("dual") || tt.includes("multiple")) {
                      item.agreesToTwins = true;
                    } else if (tt === "set" || tt.includes("single")) {
                      item.agreesToTwins = false;
                    }
                  }
                }
                if (item.agreesToAbortion == null) {
                  const abort = fullProfile["Willing to terminate the pregnancy at the sole discretion of the Intended Parents?"]
                    || pref["Willing to terminate the pregnancy at the sole discretion of the Intended Parents?"]
                    || fullProfile["Willing to Reduce?"] || pref["Willing to Reduce?"] || null;
                  if (abort != null) {
                    const av = String(abort).toLowerCase();
                    item.agreesToAbortion = av.includes("yes") || av === "true";
                  }
                }
                if (item.agreesToSelectiveReduction == null) {
                  const sr = fullProfile["Selective Reduction"] || fullProfile["Willing to Reduce?"] || pref["Willing to Reduce?"] || bi["Selective Reduction"] || null;
                  if (sr != null) {
                    const sv = String(sr).toLowerCase();
                    item.agreesToSelectiveReduction = sv.includes("yes") || sv === "true";
                  }
                }
                if (item.openToSameSexCouple == null) {
                  const ssc = fullProfile["Same Sex Couple"] || bi["Same Sex Couple"] || null;
                  if (ssc != null) {
                    const sv = String(ssc).toLowerCase();
                    item.openToSameSexCouple = sv.includes("yes") || sv === "true";
                  }
                }
                if (item.openToSameSexCouple == null) {
                  const allSections = { ...fullProfile, ...surr, ...pref, ...bi };
                  for (const [key, val] of Object.entries(allSections)) {
                    if (/intended parent.*willing|type of intended parent/i.test(key) && val) {
                      const v = String(val).toLowerCase();
                      if (v.includes("lgtbq") || v.includes("lgbtq") || v.includes("same sex") || v.includes("same-sex")) {
                        item.openToSameSexCouple = true;
                        break;
                      }
                    }
                    if (/open to same.?sex|same.?sex couple|lgbtq/i.test(key) && val) {
                      const v = String(val).toLowerCase();
                      item.openToSameSexCouple = v.includes("yes") || v === "true";
                      break;
                    }
                  }
                }
                if (item.agreesToInternationalParents == null) {
                  const ip = fullProfile["International Parents"] || fullProfile["Would you be open to working with intended parents who are based internationally?"]
                    || surr["Would you be open to working with intended parents who are based internationally?"] || bi["International Parents"] || null;
                  if (ip != null) {
                    const iv = String(ip).toLowerCase();
                    item.agreesToInternationalParents = iv.includes("yes") || iv === "true";
                  }
                }
                if (!item.lastDeliveryYear) {
                  const ldy = fullProfile["Last Delivery Year"] || bi["Last Delivery Year"] || null;
                  if (ldy) {
                    const parsed = parseInt(String(ldy));
                    if (!isNaN(parsed) && parsed > 1900) item.lastDeliveryYear = parsed;
                  }
                }
              }

              if (!item.donorCompensation) {
                const compVal = fullProfile["Donor Compensation"] || fullProfile["Request Fee Amount"] || bi["Request Fee Amount"] || null;
                if (compVal) {
                  const comp = String(compVal).replace(/[$,\s]/g, "");
                  if (comp && !isNaN(parseFloat(comp))) item.donorCompensation = parseFloat(comp);
                }
              }
              if (!item.donationTypes) {
                const dt = fullProfile["Type of Donation"] || fullProfile["Donation Type"] || pi["Donation Type"] || pref["Donation Type"] || null;
                if (dt) item.donationTypes = dt;
              }
              if (fullProfile["Photos"] && Array.isArray(fullProfile["Photos"]) && fullProfile["Photos"].length > 0) {
                const validPhotos = fullProfile["Photos"].filter((p: string) => isValidImageUrl(p));
                if (validPhotos.length > 0) {
                  item.photoUrl = validPhotos[0];
                  item.photoCount = validPhotos.length;
                  item.additionalPhotos = validPhotos.slice(1);
                }
              }
              if (fullProfile["Availability"] || fullProfile["Current Cycle Availability"] || pi["Current Cycle Availability"]) {
                const avail = (fullProfile["Availability"] || fullProfile["Current Cycle Availability"] || pi["Current Cycle Availability"]).toLowerCase();
                if (avail.includes("unavail") || avail.includes("inactive")) item.status = "INACTIVE";
                else if (avail.includes("reserved") || avail.includes("matched") || avail.includes("cycling")) item.status = "MATCHED";
              }
              if (fullProfile["Previous Egg Donor"]) {
                item.profileData["Previous Egg Donor"] = fullProfile["Previous Egg Donor"];
              }
            }
          }
          try {
            const result = job.type === "surrogate"
              ? await upsertSurrogate(prisma, job.providerId, item, storageService)
              : job.type === "sperm-donor"
              ? await upsertSpermDonor(prisma, job.providerId, item, storageService)
              : await upsertEggDonor(prisma, job.providerId, item, storageService);
            job.succeeded++;
            if (result.isNew) job.newProfiles++;
          } catch (err: any) {
            job.failed++;
            job.errors.push(`Failed to import ${item.externalId || "unknown"}: ${err.message}`);
          }
          job.processed++;
        }));
        if ((i + BATCH_SIZE) % 30 === 0 || i + BATCH_SIZE >= uniqueItems.length) {
          console.log(`[donor-sync] Progress: ${Math.min(i + BATCH_SIZE, uniqueItems.length)}/${uniqueItems.length} (succeeded: ${job.succeeded}, failed: ${job.failed}, skipped: ${skippedUnchanged})`);
        }
      }

      if (skippedUnchanged > 0) {
        console.log(`[donor-sync] ${skippedUnchanged} of ${uniqueItems.length} profiles unchanged (skipped)`);
      }

      try {
        const scrapedIds = new Set(uniqueItems.map((d: any) => d.externalId).filter(Boolean));
        job.staleDonorsMarked = await markStaleDonors(prisma, job.providerId, job.type, scrapedIds);
      } catch (e: any) {
        job.errors.push(`Stale donor detection error: ${e.message}`);
      }

      const syncConfigUpdate = {
        lastSyncAt: new Date(),
        lastSyncEndedAt: new Date(),
        syncStatus: job.failed === 0 ? "SUCCESS" : "PARTIAL",
      };
      if (job.type === "surrogate") {
        await prisma.surrogateSyncConfig.update({
          where: { providerId: job.providerId },
          data: syncConfigUpdate,
        });
      } else if (job.type === "sperm-donor") {
        await prisma.spermDonorSyncConfig.update({
          where: { providerId: job.providerId },
          data: syncConfigUpdate,
        });
      } else {
        await prisma.eggDonorSyncConfig.update({
          where: { providerId: job.providerId },
          data: syncConfigUpdate,
        });
      }

      job.status = "completed";
      job.completedAt = new Date();
      console.log(`[donor-sync] Orchid JMS ${job.type} sync complete: ${job.succeeded} imported, ${job.failed} failed, ${skippedUnchanged} unchanged`);
      return;
    }

    const edcDonorHtml = await tryFetchEdcDonorData(mainHtml, sourceUrl, sessionCookies, job.type);
    let edcParsedDonors: any[] | null = null;
    if (edcDonorHtml) {
      console.log(`[donor-sync] Loaded EDC donor data via AJAX (${edcDonorHtml.length} chars)`);
      edcParsedDonors = parseEdcDonorCards(edcDonorHtml, new URL(sourceUrl).origin);
      console.log(`[donor-sync] Parsed ${edcParsedDonors.length} donors from EDC HTML`);
    }

    if (edcParsedDonors && edcParsedDonors.length > 0) {
      const seenIds = new Set<string>();
      const uniqueItems = edcParsedDonors.filter((d) => {
        const key = d.externalId;
        if (!key || seenIds.has(key)) return false;
        seenIds.add(key);
        return true;
      });
      if (profileLimit && profileLimit > 0 && uniqueItems.length > profileLimit) {
        console.log(`[donor-sync] Limiting to ${profileLimit} profiles (test mode)`);
        uniqueItems.splice(profileLimit);
      }
      job.total = uniqueItems.length;
      job.processed = 0;

      const existingHashes = new Map<string, string>();
      const existingProfilesQuery = job.type === "surrogate"
        ? prisma.surrogate.findMany({
            where: { providerId: job.providerId, externalId: { in: uniqueItems.map((d: any) => d.externalId).filter(Boolean) } },
            select: { externalId: true, cardHash: true },
          })
        : job.type === "sperm-donor"
        ? prisma.spermDonor.findMany({
            where: { providerId: job.providerId, externalId: { in: uniqueItems.map((d: any) => d.externalId).filter(Boolean) } },
            select: { externalId: true, cardHash: true },
          })
        : prisma.eggDonor.findMany({
            where: { providerId: job.providerId, externalId: { in: uniqueItems.map((d: any) => d.externalId).filter(Boolean) } },
            select: { externalId: true, cardHash: true },
          });
      const existingDonors = await existingProfilesQuery;
      for (const d of existingDonors) {
        if (d.externalId && d.cardHash) existingHashes.set(d.externalId, d.cardHash);
      }

      let skippedUnchanged = 0;
      console.log(`[donor-sync] Found ${uniqueItems.length} unique ${job.type} profiles to import`);
      console.log(`[donor-sync] Fetching full profile pages for each donor...`);

      const BATCH_SIZE = 5;
      for (let i = 0; i < uniqueItems.length; i += BATCH_SIZE) {
        if (isJobCancelled(job.id)) {
          console.log(`[donor-sync] Sync cancelled, stopping at ${i}/${uniqueItems.length}`);
          break;
        }
        const batch = uniqueItems.slice(i, i + BATCH_SIZE);
        const profilePromises = batch.map(async (item) => {
          const oldHash = item.externalId ? existingHashes.get(item.externalId) : null;
          if (oldHash && oldHash === item.cardHash) {
            skippedUnchanged++;
            return;
          }
          if (item.profileUrl) {
            const fullProfile = await fetchEdcDonorProfile(item.profileUrl, sessionCookies);
            if (fullProfile && Object.keys(fullProfile).length > 0) {
              item.profileData = fullProfile;
              if (!item.relationshipStatus && fullProfile["Relationship Status"]) item.relationshipStatus = fullProfile["Relationship Status"];
              if (!item.occupation && fullProfile["Occupation"]) item.occupation = fullProfile["Occupation"];
              if (!item.religion && fullProfile["Religion"]) item.religion = fullProfile["Religion"];
              if (!item.race && fullProfile["Race"]) item.race = fullProfile["Race"];
              if (!item.education && fullProfile["Education"]) item.education = fullProfile["Education"];
              if (!item.eyeColor && fullProfile["Eye Color"]) item.eyeColor = fullProfile["Eye Color"];
              if (!item.hairColor && fullProfile["Hair Color"]) item.hairColor = fullProfile["Hair Color"];
              if (!item.bloodType && fullProfile["Blood Type"]) item.bloodType = fullProfile["Blood Type"];
              if (!item.location && fullProfile["Location"]) item.location = fullProfile["Location"];
              if (!item.videoUrl && fullProfile["Video URL"]) item.videoUrl = fullProfile["Video URL"];
              if (!item.donorCompensation && fullProfile["Donor Compensation"]) {
                const comp = String(fullProfile["Donor Compensation"]).replace(/[$,\s]/g, "");
                if (comp && !isNaN(parseFloat(comp))) item.donorCompensation = parseFloat(comp);
              }
              if (!item.eggLotCost && fullProfile["Egg Lot Cost"]) {
                const cost = String(fullProfile["Egg Lot Cost"]).replace(/[$,\s]/g, "");
                if (cost && !isNaN(parseFloat(cost))) item.eggLotCost = parseFloat(cost);
              }
              if (!item.totalCost && fullProfile["Total Cost"]) {
                const cost = String(fullProfile["Total Cost"]).replace(/[$,\s]/g, "");
                if (cost && !isNaN(parseFloat(cost))) item.totalCost = parseFloat(cost);
              }
              if (!item.donationTypes && fullProfile["Donation Types"] && fullProfile["Donation Types"] !== "Yes" && fullProfile["Donation Types"] !== "No") {
                item.donationTypes = fullProfile["Donation Types"];
              }
              const pd = fullProfile["Profile Details"];
              if (pd && typeof pd === "object") {
                for (const section of Object.values(pd) as any[]) {
                  if (typeof section !== "object" || !section) continue;
                  if (!item.relationshipStatus && section["Relationship Status"]) item.relationshipStatus = section["Relationship Status"];
                  if (!item.occupation && section["Occupation"]) item.occupation = section["Occupation"];
                  if (!item.religion && section["Religion"]) item.religion = section["Religion"];
                  if (!item.race && section["Race"]) item.race = section["Race"];
                  if (!item.education && section["Education"]) item.education = section["Education"];
                  if (!item.bloodType && section["Blood Type"]) item.bloodType = section["Blood Type"];
                  if (!item.location && section["Location"]) item.location = section["Location"];
                }
              }
              if (!item.donationTypes && pd) {
                item.donationTypes = deriveDonationTypeFromProfile(pd);
              }
            }
          }
        });
        await Promise.all(profilePromises);

        for (let j = 0; j < batch.length; j++) {
          const item = batch[j];
          const oldHash = item.externalId ? existingHashes.get(item.externalId) : null;
          if (oldHash && oldHash === item.cardHash && !item.profileData) {
            job.processed = i + j + 1;
            continue;
          }
          try {
            const result = job.type === "surrogate"
              ? await upsertSurrogate(prisma, job.providerId, item, storageService)
              : job.type === "sperm-donor"
              ? await upsertSpermDonor(prisma, job.providerId, item, storageService)
              : await upsertEggDonor(prisma, job.providerId, item, storageService);
            job.succeeded++;
            if (result.isNew) job.newProfiles++;
          } catch (err: any) {
            job.failed++;
            job.errors.push(`Failed to import ${item.externalId || "unknown"}: ${err.message}`);
          }
          job.processed = i + j + 1;
        }

        if (i + BATCH_SIZE < uniqueItems.length) {
          await new Promise((r) => setTimeout(r, 200));
        }

        if ((i + BATCH_SIZE) % 50 === 0 || i + BATCH_SIZE >= uniqueItems.length) {
          console.log(`[donor-sync] Progress: ${Math.min(i + BATCH_SIZE, uniqueItems.length)}/${uniqueItems.length} profiles fetched`);
        }
      }

      if (skippedUnchanged > 0) {
        console.log(`[donor-sync] ${skippedUnchanged} of ${uniqueItems.length} profiles unchanged (skipped), ${uniqueItems.length - skippedUnchanged} profiles updated`);
      }

      try {
        const scrapedIds = new Set(uniqueItems.map((d: any) => d.externalId).filter(Boolean));
        job.staleDonorsMarked = await markStaleDonors(prisma, job.providerId, job.type, scrapedIds);
      } catch (e: any) {
        job.errors.push(`Stale donor detection error: ${e.message}`);
        console.error(`[donor-sync] Stale donor detection error: ${e.message}`);
      }

      const syncConfigUpdate = {
        lastSyncAt: new Date(),
        lastSyncEndedAt: new Date(),
        syncStatus: job.failed === 0 ? "SUCCESS" : "PARTIAL",
      };
      if (job.type === "surrogate") {
        await prisma.surrogateSyncConfig.update({
          where: { providerId: job.providerId },
          data: syncConfigUpdate,
        });
      } else if (job.type === "sperm-donor") {
        await prisma.spermDonorSyncConfig.update({
          where: { providerId: job.providerId },
          data: syncConfigUpdate,
        });
      } else {
        await prisma.eggDonorSyncConfig.update({
          where: { providerId: job.providerId },
          data: syncConfigUpdate,
        });
      }

      try {
        job.missingFields = await analyzeMissingFields(prisma, job.providerId, job.type);
      } catch (e: any) {
        console.error(`[donor-sync] Missing fields analysis error: ${e.message}`);
      }

      try {
        await recalcAndPersistTotalCostsForProvider(prisma, job.providerId, [job.type]);
        console.log(`[donor-sync] Recalculated total costs for ${job.type} after EDC sync`);
      } catch (e: any) {
        console.error(`[donor-sync] Total cost recalc error: ${e.message}`);
      }

      if (!isJobCancelled(job.id)) {
        job.status = "completed";
        job.completedAt = new Date();
      }
      cancelledJobs.delete(job.id);
      console.log(`[donor-sync] Sync complete: ${job.succeeded} succeeded, ${job.failed} failed, ${job.staleDonorsMarked} marked inactive out of ${job.total}`);
      return;
    }

    const extraction = await extractDonorsFromPage(mainHtml, sourceUrl, job.type);
    if (!extraction) {
      job.status = "failed";
      job.errors.push("Failed to extract data from the source page. The page may not contain donor/surrogate profiles.");
      job.completedAt = new Date();
      return;
    }

    const items =
      job.type === "surrogate"
        ? extraction.surrogates || []
        : extraction.donors || [];

    const profileLinks: string[] = extraction.profileLinks || [];
    const paginationLinks: string[] = extraction.paginationLinks || [];

    let allItems = [...items];

    if (profileLinks.length > 0 && items.length < 3) {
      const maxProfiles = Math.min(profileLinks.length, profileLimit && profileLimit > 0 ? profileLimit : 50);
      job.total = maxProfiles;

      for (let i = 0; i < maxProfiles; i++) {
        const profileUrl = profileLinks[i];
        try {
          const profileHtml = await fetchHtml(profileUrl, sessionCookies);
          const profileData = await extractDonorsFromPage(profileHtml, profileUrl, job.type);
          if (profileData) {
            const profileItems =
              job.type === "surrogate"
                ? profileData.surrogates || []
                : profileData.donors || [];
            allItems.push(...profileItems);
          }
          job.processed = i + 1;
        } catch (err: any) {
          job.processed = i + 1;
          job.errors.push(`Failed to fetch profile ${profileUrl}: ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (paginationLinks.length > 0) {
      const maxPages = Math.min(paginationLinks.length, 10);
      for (let i = 0; i < maxPages; i++) {
        try {
          const pageHtml = await fetchHtml(paginationLinks[i], sessionCookies);
          const pageData = await extractDonorsFromPage(pageHtml, paginationLinks[i], job.type);
          if (pageData) {
            const pageItems =
              job.type === "surrogate"
                ? pageData.surrogates || []
                : pageData.donors || [];
            allItems.push(...pageItems);

            if (pageData.profileLinks?.length > 0) {
              const maxNewProfiles = Math.min(pageData.profileLinks.length, 30);
              for (let j = 0; j < maxNewProfiles; j++) {
                try {
                  const profHtml = await fetchHtml(pageData.profileLinks[j], sessionCookies);
                  const profData = await extractDonorsFromPage(profHtml, pageData.profileLinks[j], job.type);
                  if (profData) {
                    const profItems =
                      job.type === "surrogate"
                        ? profData.surrogates || []
                        : profData.donors || [];
                    allItems.push(...profItems);
                  }
                } catch (err: any) {
                  job.errors.push(`Profile fetch error: ${err.message}`);
                }
                await new Promise((r) => setTimeout(r, 500));
              }
            }
          }
        } catch (err: any) {
          job.errors.push(`Pagination page error: ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const seen = new Set<string>();
    let uniqueItems = allItems.filter((item) => {
      const key = item.externalId || JSON.stringify(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (profileLimit && profileLimit > 0 && uniqueItems.length > profileLimit) {
      console.log(`[donor-sync] Limiting to ${profileLimit} profiles (test mode)`);
      uniqueItems = uniqueItems.slice(0, profileLimit);
    }

    job.total = uniqueItems.length;
    job.processed = 0;

    console.log(`[donor-sync] Found ${uniqueItems.length} unique ${job.type} profiles to import`);

    for (let i = 0; i < uniqueItems.length; i++) {
      if (isJobCancelled(job.id)) {
        console.log(`[donor-sync] Sync cancelled, stopping import at ${i}/${uniqueItems.length}`);
        break;
      }
      const item = uniqueItems[i];
      try {
        let isNew = false;
        switch (job.type) {
          case "egg-donor": {
            const r = await upsertEggDonor(prisma, job.providerId, item, storageService);
            isNew = r.isNew;
            break;
          }
          case "surrogate": {
            const r = await upsertSurrogate(prisma, job.providerId, item, storageService);
            isNew = r.isNew;
            break;
          }
          case "sperm-donor": {
            const r = await upsertSpermDonor(prisma, job.providerId, item, storageService);
            isNew = r.isNew;
            break;
          }
        }
        job.succeeded++;
        if (isNew) job.newProfiles++;
      } catch (err: any) {
        job.failed++;
        job.errors.push(
          `Failed to import ${item.externalId || "unknown"}: ${err.message}`,
        );
      }
      job.processed = i + 1;
    }

    try {
      const scrapedIds = new Set(uniqueItems.map((d: any) => d.externalId).filter(Boolean));
      job.staleDonorsMarked = await markStaleDonors(prisma, job.providerId, job.type, scrapedIds);
    } catch (e: any) {
      job.errors.push(`Stale donor detection error: ${e.message}`);
      console.error(`[donor-sync] Stale donor detection error: ${e.message}`);
    }

    const syncConfigUpdate = {
      lastSyncAt: new Date(),
      lastSyncEndedAt: new Date(),
      syncStatus: job.failed === 0 ? "SUCCESS" : "PARTIAL",
    };

    switch (job.type) {
      case "egg-donor":
        await prisma.eggDonorSyncConfig.update({
          where: { providerId: job.providerId },
          data: syncConfigUpdate,
        });
        break;
      case "surrogate":
        await prisma.surrogateSyncConfig.update({
          where: { providerId: job.providerId },
          data: syncConfigUpdate,
        });
        break;
      case "sperm-donor":
        await prisma.spermDonorSyncConfig.update({
          where: { providerId: job.providerId },
          data: syncConfigUpdate,
        });
        break;
    }

    try {
      job.missingFields = await analyzeMissingFields(prisma, job.providerId, job.type);
    } catch (e: any) {
      console.error(`[donor-sync] Missing fields analysis error: ${e.message}`);
    }

    try {
      await recalcAndPersistTotalCostsForProvider(prisma, job.providerId, [job.type]);
      console.log(`[donor-sync] Recalculated total costs for ${job.type} after sync`);
    } catch (e: any) {
      console.error(`[donor-sync] Total cost recalc error: ${e.message}`);
    }

    if (!isJobCancelled(job.id)) {
      job.status = "completed";
      job.completedAt = new Date();
    }
    cancelledJobs.delete(job.id);
    console.log(
      `[donor-sync] Sync complete: ${job.succeeded} succeeded, ${job.failed} failed, ${job.staleDonorsMarked} marked inactive out of ${job.total}`,
    );
  } catch (err: any) {
    if (!isJobCancelled(job.id)) {
      job.status = "failed";
      job.errors.push(`Fatal error: ${err.message}`);
      job.completedAt = new Date();
    }
    cancelledJobs.delete(job.id);
    console.error(`[donor-sync] Sync failed:`, err);
  }
}

export interface NightlySyncResult {
  providerId: string;
  providerName: string;
  type: DonorType;
  jobId: string;
  status: "running" | "completed" | "failed";
  succeeded: number;
  failed: number;
  total: number;
  errors: string[];
  startedAt: Date;
  completedAt?: Date;
}

const nightlySyncResults: NightlySyncResult[] = [];
let lastNightlySyncAt: Date | null = null;
let nightlySyncRunning = false;

export function getNightlySyncStatus() {
  return {
    lastRunAt: lastNightlySyncAt,
    isRunning: nightlySyncRunning,
    results: nightlySyncResults,
  };
}

export async function runNightlySync(prisma: PrismaService, storageService?: StorageService | null) {
  if (nightlySyncRunning) {
    console.log("[nightly-sync] Already running, skipping");
    return;
  }
  nightlySyncRunning = true;
  nightlySyncResults.length = 0;
  lastNightlySyncAt = new Date();
  console.log("[nightly-sync] Starting nightly sync for all providers...");

  try {
    const allConfigs: { providerId: string; type: DonorType; providerName: string }[] = [];

    const eggConfigs = await prisma.eggDonorSyncConfig.findMany({
      include: { provider: { select: { name: true } } },
    });
    for (const c of eggConfigs) {
      allConfigs.push({ providerId: c.providerId, type: "egg-donor", providerName: c.provider.name });
    }

    const surConfigs = await prisma.surrogateSyncConfig.findMany({
      include: { provider: { select: { name: true } } },
    });
    for (const c of surConfigs) {
      allConfigs.push({ providerId: c.providerId, type: "surrogate", providerName: c.provider.name });
    }

    const spermConfigs = await prisma.spermDonorSyncConfig.findMany({
      include: { provider: { select: { name: true } } },
    });
    for (const c of spermConfigs) {
      allConfigs.push({ providerId: c.providerId, type: "sperm-donor", providerName: c.provider.name });
    }

    console.log(`[nightly-sync] Found ${allConfigs.length} sync configurations`);

    for (const config of allConfigs) {
      const result: NightlySyncResult = {
        providerId: config.providerId,
        providerName: config.providerName,
        type: config.type,
        jobId: "",
        status: "running",
        succeeded: 0,
        failed: 0,
        total: 0,
        errors: [],
        startedAt: new Date(),
      };
      nightlySyncResults.push(result);

      try {
        console.log(`[nightly-sync] Syncing ${config.providerName} (${config.type})...`);
        const jobId = await startSync(prisma, config.providerId, config.type, undefined, storageService);
        result.jobId = jobId;

        await new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            const job = getSyncJob(jobId);
            if (!job || job.status !== "running") {
              clearInterval(interval);
              if (job) {
                result.status = job.status;
                result.succeeded = job.succeeded;
                result.failed = job.failed;
                result.total = job.total;
                result.errors = job.errors;
                result.completedAt = job.completedAt;
              } else {
                result.status = "failed";
                result.errors = ["Job disappeared"];
                result.completedAt = new Date();
              }
              resolve();
            }
          }, 5000);

          setTimeout(() => {
            clearInterval(interval);
            const job = getSyncJob(jobId);
            if (job && job.status === "running") {
              result.status = "failed";
              result.errors = ["Timed out after 60 minutes"];
              result.completedAt = new Date();
            }
            resolve();
          }, 60 * 60 * 1000);
        });

        console.log(`[nightly-sync] ${config.providerName} (${config.type}): ${result.status} - ${result.succeeded}/${result.total}`);

        await new Promise((r) => setTimeout(r, 2000));
      } catch (err: any) {
        result.status = "failed";
        result.errors = [err.message];
        result.completedAt = new Date();
        console.error(`[nightly-sync] Error syncing ${config.providerName}:`, err.message);
      }
    }
  } finally {
    nightlySyncRunning = false;
    console.log("[nightly-sync] Nightly sync complete");
  }
}

export async function getScrapersSummary(prisma: PrismaService) {
  const providers = await prisma.provider.findMany({
    select: {
      id: true,
      name: true,
      eggDonorSyncConfig: true,
      surrogateSyncConfig: true,
      spermDonorSyncConfig: true,
    },
  });

  const summaries: {
    providerId: string;
    providerName: string;
    type: DonorType;
    syncStatus: string;
    lastSyncAt: Date | null;
    lastSyncStartedAt: Date | null;
    lastSyncEndedAt: Date | null;
    totalProfiles: number;
    totalErrors: number;
    latestDonorCreatedAt: Date | null;
    syncProgress?: { total: number; processed: number; succeeded: number; failed: number } | null;
  }[] = [];

  for (const p of providers) {
    if (p.eggDonorSyncConfig) {
      const count = await prisma.eggDonor.count({ where: { providerId: p.id } });
      const latest = await prisma.eggDonor.findFirst({
        where: { providerId: p.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      summaries.push({
        providerId: p.id,
        providerName: p.name,
        type: "egg-donor",
        syncStatus: p.eggDonorSyncConfig.syncStatus,
        lastSyncAt: p.eggDonorSyncConfig.lastSyncAt,
        lastSyncStartedAt: p.eggDonorSyncConfig.lastSyncStartedAt,
        lastSyncEndedAt: p.eggDonorSyncConfig.lastSyncEndedAt,
        totalProfiles: count,
        totalErrors: 0,
        latestDonorCreatedAt: latest?.createdAt || null,
      });
    }
    if (p.surrogateSyncConfig) {
      const count = await prisma.surrogate.count({ where: { providerId: p.id } });
      const latest = await prisma.surrogate.findFirst({
        where: { providerId: p.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      summaries.push({
        providerId: p.id,
        providerName: p.name,
        type: "surrogate",
        syncStatus: p.surrogateSyncConfig.syncStatus,
        lastSyncAt: p.surrogateSyncConfig.lastSyncAt,
        lastSyncStartedAt: p.surrogateSyncConfig.lastSyncStartedAt,
        lastSyncEndedAt: p.surrogateSyncConfig.lastSyncEndedAt,
        totalProfiles: count,
        totalErrors: 0,
        latestDonorCreatedAt: latest?.createdAt || null,
      });
    }
    if (p.spermDonorSyncConfig) {
      const count = await prisma.spermDonor.count({ where: { providerId: p.id } });
      const latest = await prisma.spermDonor.findFirst({
        where: { providerId: p.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      summaries.push({
        providerId: p.id,
        providerName: p.name,
        type: "sperm-donor",
        syncStatus: p.spermDonorSyncConfig.syncStatus,
        lastSyncAt: p.spermDonorSyncConfig.lastSyncAt,
        lastSyncStartedAt: p.spermDonorSyncConfig.lastSyncStartedAt,
        lastSyncEndedAt: p.spermDonorSyncConfig.lastSyncEndedAt,
        totalProfiles: count,
        totalErrors: 0,
        latestDonorCreatedAt: latest?.createdAt || null,
      });
    }
  }

  const nightlyResults = nightlySyncResults;
  for (const summary of summaries) {
    const lastNightly = nightlyResults.find(
      (r) => r.providerId === summary.providerId && r.type === summary.type
    );
    if (lastNightly) {
      summary.totalErrors = lastNightly.failed;
    }

    const activeJob = getActiveSyncJob(summary.providerId, summary.type);
    if (activeJob) {
      summary.syncProgress = {
        total: activeJob.total,
        processed: activeJob.processed,
        succeeded: activeJob.succeeded,
        failed: activeJob.failed,
      };
    } else {
      summary.syncProgress = null;
    }
  }

  return {
    summaries,
    lastNightlySyncAt,
    nightlySyncRunning,
  };
}

export async function getDonors(
  prisma: PrismaService,
  providerId: string,
  type: DonorType,
  options?: { excludeHidden?: boolean },
) {
  const where: any = { providerId };
  if (options?.excludeHidden) {
    where.hiddenFromSearch = false;
  }
  switch (type) {
    case "egg-donor":
      return prisma.eggDonor.findMany({
        where,
        orderBy: { createdAt: "desc" },
      });
    case "surrogate":
      return prisma.surrogate.findMany({
        where,
        orderBy: { createdAt: "desc" },
      });
    case "sperm-donor":
      return prisma.spermDonor.findMany({
        where,
        orderBy: { createdAt: "desc" },
      });
  }
}

export function startPdfSync(
  prisma: PrismaService,
  storageService: StorageService,
  providerId: string,
  files: Array<{ originalname: string; buffer: Buffer }>,
): string {
  const jobId = generateJobId();
  const job: SyncJob = {
    id: jobId,
    providerId,
    type: "surrogate",
    status: "running",
    total: files.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    newProfiles: 0,
    errors: [],
    missingFields: [],
    staleDonorsMarked: 0,
    startedAt: new Date(),
    isPdfUpload: true,
  };
  syncJobs.set(jobId, job);

  runPdfSyncJob(prisma, storageService, job, files).catch((err) => {
    job.status = "failed";
    job.errors.push(`Fatal error: ${err.message}`);
    job.completedAt = new Date();
  });

  return jobId;
}

async function isLikelyLogo(imgBuffer: Buffer, sharpMod: any): Promise<boolean> {
  try {
    const meta = await sharpMod(imgBuffer).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (w === 0 || h === 0) return true;

    if (w > 10000 || h > 10000) return true;

    const aspect = w / h;
    if (aspect > 2.5 || aspect < 0.28) return true;

    if (w < 200 && h < 200) return true;

    const stats = await sharpMod(imgBuffer).stats();

    if (stats.channels && stats.channels.length >= 3) {
      const [rCh, gCh, bCh] = stats.channels;
      const totalStdDev = rCh.stdev + gCh.stdev + bCh.stdev;
      if (totalStdDev < 15) {
        console.log(`[pdf-sync] Filtering logo-like image: low color diversity (stddev=${totalStdDev.toFixed(1)})`);
        return true;
      }

      const avgMean = (rCh.mean + gCh.mean + bCh.mean) / 3;
      if (avgMean < 25 || avgMean > 235) {
        console.log(`[pdf-sync] Filtering banner-like image: ${avgMean < 25 ? "dark" : "light"} background (mean=${avgMean.toFixed(1)}, stddev=${totalStdDev.toFixed(1)})`);
        return true;
      }

      if (stats.dominant) {
        const { r, g, b } = stats.dominant;
        if (r > 240 && g > 240 && b > 240 && totalStdDev < 80) return true;
      }

      try {
        const thumbSize = 200;
        const { data: rawData, info } = await sharpMod(imgBuffer)
          .resize(thumbSize, thumbSize, { fit: "cover" })
          .raw()
          .toBuffer({ resolveWithObject: true });
        let lightPixels = 0;
        const totalPixels = info.width * info.height;
        for (let i = 0; i < rawData.length; i += 3) {
          if (rawData[i] > 200 && rawData[i + 1] > 190 && rawData[i + 2] > 170) lightPixels++;
        }
        const lightPct = lightPixels / totalPixels;
        if (lightPct > 0.40) {
          console.log(`[pdf-sync] Filtering intro/cover page image: ${(lightPct * 100).toFixed(1)}% light/cream pixels`);
          return true;
        }
      } catch {}
    } else if (stats.dominant) {
      const { r, g, b } = stats.dominant;
      if (r > 240 && g > 240 && b > 240) return true;
    }

    return false;
  } catch {
    return false;
  }
}

async function extractImagesFromPdf(pdfBuffer: Buffer, existingDoc?: any): Promise<Array<{ data: Buffer; contentType: string }>> {
  const images: Array<{ data: Buffer; contentType: string }> = [];
  const sharp = (await import("sharp")).default;

  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = existingDoc || await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer), useSystemFonts: true }).promise;
    const sharpPdfjs = (await import("sharp")).default;

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const ops = await page.getOperatorList();
      const { OPS } = pdfjsLib;
      const viewport = page.getViewport({ scale: 1 });
      const pageW = viewport.width;
      const pageH = viewport.height;

      const ctmStack: number[][] = [];
      let ctm = [1, 0, 0, 1, 0, 0];
      let insideAnnotation = false;

      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];

        if (fn === 80) {
          insideAnnotation = true;
          continue;
        } else if (fn === 81) {
          insideAnnotation = false;
          continue;
        }

        if (fn === OPS.save) {
          ctmStack.push([...ctm]);
        } else if (fn === OPS.restore) {
          if (ctmStack.length > 0) ctm = ctmStack.pop()!;
        } else if (fn === OPS.transform) {
          const [a, b, c, d, e, f] = ops.argsArray[i] as number[];
          const [ca, cb, cc, cd, ce, cf] = ctm;
          ctm = [
            ca * a + cc * b,
            cb * a + cd * b,
            ca * c + cc * d,
            cb * c + cd * d,
            ca * e + cc * f + ce,
            cb * e + cd * f + cf,
          ];
        } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
          try {
            if (insideAnnotation) {
              console.log(`[pdf-sync] Page ${pageNum}: skipping annotation-embedded image`);
              continue;
            }

            const renderedW = Math.sqrt(ctm[0] * ctm[0] + ctm[1] * ctm[1]);
            const renderedH = Math.sqrt(ctm[2] * ctm[2] + ctm[3] * ctm[3]);
            const renderedX = ctm[4];
            const renderedY = ctm[5];

            console.log(`[pdf-sync] Page ${pageNum}: image CTM=[${ctm.map(v => v.toFixed(1)).join(',')}] renderedSize=${renderedW.toFixed(1)}x${renderedH.toFixed(1)} pos=(${renderedX.toFixed(0)},${renderedY.toFixed(0)}) pageSize=${pageW.toFixed(0)}x${pageH.toFixed(0)}`);

            if (renderedW < 50 || renderedH < 50) {
              console.log(`[pdf-sync] Page ${pageNum}: skipping small/hidden image (rendered ${renderedW.toFixed(1)}x${renderedH.toFixed(1)} on page)`);
              continue;
            }

            if (renderedX + renderedW < -10 || renderedX > pageW + 10 ||
                renderedY < -renderedH - 10 || renderedY > pageH + 10) {
              console.log(`[pdf-sync] Page ${pageNum}: skipping off-page image at (${renderedX.toFixed(0)},${renderedY.toFixed(0)})`);
              continue;
            }

            const imgName = ops.argsArray[i][0];
            let imgData: any;

            if (fn === OPS.paintInlineImageXObject) {
              imgData = imgName;
            } else {
              imgData = await new Promise<any>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("Timeout getting image obj")), 5000);
                (page as any).objs.get(imgName, (obj: any) => {
                  clearTimeout(timeout);
                  if (obj) resolve(obj);
                  else reject(new Error("Image object not found"));
                });
              });
            }

            if (!imgData || !imgData.data) {
              console.log(`[pdf-sync] Page ${pageNum}, img ${imgName}: no data`);
              continue;
            }

            const width = imgData.width;
            const height = imgData.height;
            if (width < 100 || height < 100) continue;

            const rawLen = imgData.data.length;
            const channels = Math.round(rawLen / (width * height));
            let imgBuffer: Buffer;

            const ctmAngle = Math.round(Math.atan2(ctm[1], ctm[0]) * 180 / Math.PI);
            let sharpRotation = 0;
            if (Math.abs(ctmAngle - 90) < 5 || Math.abs(ctmAngle + 270) < 5) sharpRotation = 270;
            else if (Math.abs(ctmAngle - 180) < 5 || Math.abs(ctmAngle + 180) < 5) sharpRotation = 180;
            else if (Math.abs(ctmAngle - 270) < 5 || Math.abs(ctmAngle + 90) < 5) sharpRotation = 90;

            if (sharpRotation !== 0) {
              console.log(`[pdf-sync] Page ${pageNum}: applying ${sharpRotation}° CTM rotation for image ${width}x${height}`);
            }

            if (channels >= 1 && channels <= 4) {
              let pipeline = sharpPdfjs(Buffer.from(imgData.data), {
                raw: { width, height, channels: channels as 1 | 2 | 3 | 4 },
              });
              if (sharpRotation !== 0) pipeline = pipeline.rotate(sharpRotation);
              imgBuffer = await pipeline.jpeg({ quality: 85 }).toBuffer();
            } else {
              console.log(`[pdf-sync] Page ${pageNum}, img ${imgName}: unusual channels=${rawLen / (width * height)}, trying as RGB`);
              try {
                let pipeline = sharpPdfjs(Buffer.from(imgData.data.slice(0, width * height * 3)), {
                  raw: { width, height, channels: 3 },
                });
                if (sharpRotation !== 0) pipeline = pipeline.rotate(sharpRotation);
                imgBuffer = await pipeline.jpeg({ quality: 85 }).toBuffer();
              } catch {
                continue;
              }
            }

            if (imgBuffer.length < 10240) continue;

            if (await isLikelyLogo(imgBuffer, sharpPdfjs)) {
              console.log(`[pdf-sync] Skipping logo-like image from pdfjs (page ${pageNum}, ${width}x${height})`);
              continue;
            }

            const hash = createHash("md5").update(imgBuffer).digest("hex");
            console.log(`[pdf-sync] Page ${pageNum}: keeping image ${width}x${height} hash=${hash} (rendered ${renderedW.toFixed(1)}x${renderedH.toFixed(1)} at ${renderedX.toFixed(0)},${renderedY.toFixed(0)})`);

            const isDuplicate = images.some(
              (existing) => createHash("md5").update(existing.data).digest("hex") === hash,
            );
            if (!isDuplicate) {
              images.push({ data: imgBuffer, contentType: "image/jpeg" });
            }
          } catch (imgErr: any) {
            console.log(`[pdf-sync] Page ${pageNum} image extraction error: ${imgErr.message}`);
          }
        }
      }
      page.cleanup();
    }
    if (!existingDoc) doc.destroy();
  } catch (err: any) {
    console.error("[pdf-sync] pdfjs image extraction error:", err.message);
  }

  if (images.length === 0) {
    console.log(`[pdf-sync] pdfjs found no images, falling back to raw JPEG stream scanning`);
    const jpegImages = extractRawJpegStreams(pdfBuffer);
    if (jpegImages.length > 0) {
      console.log(`[pdf-sync] Found ${jpegImages.length} raw JPEG streams in PDF`);
      for (const jpeg of jpegImages) {
        try {
          const meta = await sharp(jpeg).metadata();
          if (!meta.width || !meta.height || meta.width < 100 || meta.height < 100) continue;
          const optimized = await sharp(jpeg).rotate().jpeg({ quality: 85 }).toBuffer();
          if (optimized.length < 10240) continue;
          if (await isLikelyLogo(optimized, sharp)) {
            console.log(`[pdf-sync] Skipping logo-like JPEG (${meta.width}x${meta.height})`);
            continue;
          }
          images.push({ data: optimized, contentType: "image/jpeg" });
        } catch (e: any) {
          console.log(`[pdf-sync] Skipping invalid JPEG stream: ${e.message}`);
        }
      }
    }
  } else {
    console.log(`[pdf-sync] pdfjs extracted ${images.length} images, skipping raw JPEG fallback`);
  }

  return images;
}

function extractRawJpegStreams(pdfBuffer: Buffer): Buffer[] {
  const jpegs: Buffer[] = [];
  const SOI = Buffer.from([0xFF, 0xD8, 0xFF]);
  const EOI = Buffer.from([0xFF, 0xD9]);

  let offset = 0;
  while (offset < pdfBuffer.length - 3) {
    const soiIdx = pdfBuffer.indexOf(SOI, offset);
    if (soiIdx === -1) break;

    const eoiIdx = pdfBuffer.indexOf(EOI, soiIdx + 3);
    if (eoiIdx === -1) {
      offset = soiIdx + 3;
      continue;
    }

    const jpegData = pdfBuffer.slice(soiIdx, eoiIdx + 2);
    if (jpegData.length > 10240) {
      jpegs.push(jpegData);
    }
    offset = eoiIdx + 2;
  }
  return jpegs;
}

const PDF_CONCURRENCY = 3;

const pdfPromptTemplate = `You are extracting a surrogate profile from a PDF document.
Extract ALL information from this surrogate profile. Return a JSON object with this structure:

{
  "surrogates": [
    {
      "externalId": "string or null - The surrogate's ID/code number",
      "age": number or null,
      "bmi": number or null,
      "baseCompensation": number or null,
      "totalCompensationMin": number or null,
      "totalCompensationMax": number or null,
      "location": "City, State or null",
      "agreesToAbortion": boolean or null,
      "agreesToTwins": boolean or null,
      "covidVaccinated": boolean or null,
      "liveBirths": number or null,
      "miscarriages": number or null,
      "cSections": number or null,
      "relationshipStatus": "string or null",
      "race": "string or null - Race(s)",
      "ethnicity": "string or null - Ethnicity/ethnic background",
      "religion": "string or null - Religion/religious affiliation",
      "education": "string or null - Education level/degree",
      "openToSameSexCouple": boolean or null,
      "occupation": "string or null",
      "lastDeliveryYear": number or null,
      "agreesToSelectiveReduction": boolean or null,
      "agreesToInternationalParents": boolean or null,
      "status": "AVAILABLE",
      "photoUrl": null,
      "profileData": {
        "_sections": {
          "Personal Information": { "key": "value pairs for all personal details like Name, Age, DOB, Height, Weight, BMI, Blood Type, Race, Ethnicity, etc." },
          "Contact & Location": { "key": "value pairs for address, city, state, country, phone, email etc." },
          "Health & Medical": { "key": "value pairs for medical history, health conditions, medications, surgeries, mental health, etc." },
          "Pregnancy History": { "key": "value pairs for pregnancies, deliveries, c-sections, complications, miscarriages, live births, last delivery year, etc." },
          "Surrogacy Details": { "key": "value pairs for surrogacy preferences, compensation, agreements, prior surrogacy experience, etc." },
          "Support System": { "key": "value pairs for all questions about who will support the surrogate during the journey — e.g. partner support, family support, childcare assistance, bedrest support, support person, emotional support, counseling, support system during pregnancy, etc. ALSO include any questions about how family, friends, children, employer, or others will REACT to the surrogacy (e.g. 'How do you expect the following people will react to you being a surrogate?' for Family, Friends, Children, Employer, etc.) — these are support system questions. Look for keywords like 'support', 'supportive', 'childcare', 'bedrest', 'who will help', 'caretaker', 'react', 'reaction', 'how will they feel'. Only applicable to surrogates." },
          "Family & Background": { "key": "value pairs for marital status, children, partner info, family medical history, etc." },
          "Lifestyle": { "key": "value pairs for diet, exercise, smoking, alcohol, drugs, hobbies, etc." },
          "Legal & Insurance": { "key": "value pairs for insurance, legal history, criminal background, etc." },
          "Letter to Intended Parents": "Full text of any personal letter or essay from the surrogate",
          "Additional Information": "Any 'Additional Information', 'Additional Notes', 'Agency Comments', 'Agency Recommendations', or 'Recommendation Points' section — these are comments written BY THE AGENCY about the surrogate (third-person perspective), NOT written by the surrogate herself. Keep the full text as a single string value under a descriptive key. If no such section exists, omit this."
        }
      }
    }
  ]
}

IMPORTANT RULES:
- Extract EVERY piece of information from the PDF - do not skip any fields, questions, or answers
- Organize all extracted data into the _sections structure above
- Create additional sections if the PDF has sections that don't fit the categories above
- If the PDF has an "Additional Information" section with third-person commentary about the surrogate (e.g. "Her recent match...", "She does not have..."), preserve it as the "Additional Information" section — do NOT merge its content into other sections
- For each section, include ALL question/answer pairs exactly as they appear in the PDF
- Include personal essays, letters, and long-form text responses in full
- The flat fields (age, bmi, etc.) should also be extracted at the top level for database columns
- Return ONLY the JSON object, no markdown formatting or explanation`;

function parseJsonRobust(text: string): any {
  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(cleaned); } catch {}

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    let jsonStr = cleaned.substring(firstBrace, lastBrace + 1);
    try { return JSON.parse(jsonStr); } catch {}
    jsonStr = jsonStr.replace(/[\x00-\x1f]/g, (ch) => ch === '\n' || ch === '\r' || ch === '\t' ? ch : ' ');
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(jsonStr); } catch {}
  }
  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try { return JSON.parse(cleaned.substring(firstBracket, lastBracket + 1)); } catch {}
  }
  return null;
}

async function extractTextFromPdfDoc(
  doc: any,
  buffer: Buffer,
  fileName: string,
): Promise<{ text: string; garbageRatio: number }> {
  let extractedText = "";
  try {
    const textParts: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const pageText = content.items
        .filter((item: any) => "str" in item)
        .map((item: any) => item.str)
        .join(" ");
      if (pageText.trim()) textParts.push(pageText);
    }
    extractedText = textParts.join("\n\n");
    console.log(`[pdf-sync] pdfjs extracted ${extractedText.length} chars from ${fileName}`);
  } catch (pdfjsErr: any) {
    console.warn(`[pdf-sync] pdfjs text extraction failed for ${fileName}: ${pdfjsErr.message}`);
  }

  if (!extractedText.trim() || extractedText.replace(/\s/g, "").length < 100) {
    try {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buffer });
      await parser.load();
      const textResult = await parser.getText();
      extractedText = (typeof textResult === "string" ? textResult : textResult?.text) || "";
      console.log(`[pdf-sync] pdf-parse fallback extracted ${extractedText.length} chars from ${fileName}`);
    } catch (parseErr: any) {
      console.warn(`[pdf-sync] pdf-parse also failed for ${fileName}: ${parseErr.message}`);
    }
  }

  extractedText = extractedText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, " ");
  extractedText = extractedText.replace(/ {3,}/g, " ");

  const printableChars = extractedText.replace(/\s/g, "").length;
  const nonAsciiCount = (extractedText.match(/[^\x20-\x7E\n\r\t]/g) || []).length;
  const garbageRatio = printableChars > 0 ? nonAsciiCount / printableChars : 1;

  if (garbageRatio > 0.3) {
    console.warn(`[pdf-sync] High garbage ratio (${(garbageRatio * 100).toFixed(0)}%) in ${fileName}, cleaning...`);
    extractedText = extractedText.replace(/[^\x20-\x7E\n\r\t]/g, "").replace(/ {2,}/g, " ");
  }

  return { text: extractedText, garbageRatio };
}

async function saveExtractedImages(
  extractedImages: Array<{ data: Buffer; contentType: string }>,
  storageService: StorageService | null,
): Promise<string[]> {
  const photoUrls: string[] = [];
  const uploadsDir = path.resolve(process.cwd(), "public/uploads");
  const sharpMod = (await import("sharp")).default;
  for (let imgIdx = 0; imgIdx < extractedImages.length; imgIdx++) {
    try {
      const img = extractedImages[imgIdx];
      const oriented = await sharpMod(img.data).rotate().toBuffer();
      const ext = img.contentType === "image/png" ? "png" : "jpg";
      const hash = createHash("md5").update(oriented).digest("hex");
      const filename = `${hash}.${ext}`;
      const ct = ext === "png" ? "image/png" : "image/jpeg";

      if (storageService?.isConfigured()) {
        const gcsUrl = await storageService.uploadBufferPublic(oriented, `pdf-photos/${filename}`, ct);
        photoUrls.push(gcsUrl);
      } else {
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        const localPath = path.join(uploadsDir, filename);
        if (!fs.existsSync(localPath)) {
          fs.writeFileSync(localPath, oriented);
        }
        photoUrls.push(`/uploads/${filename}`);
      }
    } catch (imgErr: any) {
      console.error(`[pdf-sync] Failed to save image ${imgIdx}: ${imgErr.message}`);
    }
  }
  return photoUrls;
}

interface FileProgressTracker {
  fileWeights: Map<number, number>;
  fileStages: Map<number, string>;
  setStage: (fileIndex: number, stage: string, weight: number) => void;
  removeFile: (fileIndex: number) => void;
}

function createFileProgressTracker(job: SyncJob): FileProgressTracker {
  const fileWeights = new Map<number, number>();
  const fileStages = new Map<number, string>();

  const recalc = () => {
    if (job.total <= 0) return;
    const completedWeight = job.processed * 100;
    let inFlightWeight = 0;
    for (const w of fileWeights.values()) inFlightWeight += w;
    job.stepProgress = Math.round((completedWeight + inFlightWeight) / job.total);

    const stageEntries: string[] = [];
    const sortedIndices = Array.from(fileStages.keys()).sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      const stage = fileStages.get(idx)!;
      if (job.total === 1) {
        stageEntries.push(stage);
      } else {
        stageEntries.push(`File ${idx + 1}: ${stage}`);
      }
    }
    if (stageEntries.length > 0) {
      const suffix = job.total > 1 ? ` (${job.processed}/${job.total} done)` : "";
      job.currentStep = stageEntries.join(" · ") + suffix;
    }
  };

  return {
    fileWeights,
    fileStages,
    setStage(fileIndex: number, stage: string, weight: number) {
      fileWeights.set(fileIndex, weight);
      fileStages.set(fileIndex, stage);
      recalc();
    },
    removeFile(fileIndex: number) {
      fileWeights.delete(fileIndex);
      fileStages.delete(fileIndex);
      recalc();
    },
  };
}

async function processSinglePdf(
  prisma: PrismaService,
  storageService: StorageService,
  job: SyncJob,
  file: { originalname: string; buffer: Buffer },
  fileIndex: number,
  idCounter: { value: number },
  tracker: FileProgressTracker,
): Promise<void> {
  const fileName = file.originalname || `upload-${fileIndex}.pdf`;
  const shortName = fileName.length > 25 ? fileName.substring(0, 22) + "..." : fileName;
  const startTime = Date.now();
  console.log(`[pdf-sync] Processing file ${fileIndex + 1}/${job.total}: ${fileName}`);

  try {
    tracker.setStage(fileIndex, `Uploading ${shortName}`, 5);

    let pdfCloudUrl: string | undefined;
    if (storageService.isConfigured()) {
      const pdfPath = `pdf-uploads/${job.providerId}/${Date.now()}-${fileName}`;
      await storageService.uploadBuffer(file.buffer, pdfPath, "application/pdf");
      pdfCloudUrl = await storageService.getSignedUrl(pdfPath, 60 * 24 * 365);
    }

    if (isJobCancelled(job.id)) return;

    tracker.setStage(fileIndex, `Parsing ${shortName}`, 10);

    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(file.buffer), useSystemFonts: true }).promise;

    tracker.setStage(fileIndex, `Extracting text from ${shortName}`, 15);

    const textResult = await extractTextFromPdfDoc(pdfDoc, file.buffer, fileName);
    const { text: extractedText, garbageRatio } = textResult;

    tracker.setStage(fileIndex, `Extracting images from ${shortName}`, 25);

    const extractedImages = await extractImagesFromPdf(file.buffer, pdfDoc);
    console.log(`[pdf-sync] Extracted ${extractedImages.length} images from ${fileName}`);

    pdfDoc.destroy();

    if (isJobCancelled(job.id)) return;

    const printableChars = extractedText.replace(/\s/g, "").length;
    if ((!extractedText.trim() || printableChars < 50) && garbageRatio <= 0.3) {
      job.errors.push(`${fileName}: No text content extracted from PDF`);
      job.failed++;
      job.processed++;
      return;
    }

    tracker.setStage(fileIndex, `Analyzing ${shortName} with AI`, 35);

    const [photoUrls, aiData] = await Promise.all([
      saveExtractedImages(extractedImages, storageService),
      (async () => {
        if (isJobCancelled(job.id)) return null;
        const model = genAI.getGenerativeModel({
          model: "gemini-2.5-flash",
          generationConfig: { responseMimeType: "application/json" },
        });
        let result: any;
        const wordCount = extractedText.replace(/[^a-zA-Z\s]/g, "").split(/\s+/).filter(w => w.length > 2).length;
        if (wordCount < 80 || garbageRatio > 0.3) {
          console.log(`[pdf-sync] Text quality poor (words=${wordCount}, garbage=${(garbageRatio * 100).toFixed(0)}%), using PDF vision mode for ${fileName} (${(file.buffer.length / 1024).toFixed(0)}KB)`);
          const pdfBase64 = Buffer.from(file.buffer).toString("base64");
          const pdfPart = {
            inlineData: { data: pdfBase64, mimeType: "application/pdf" },
          };
          const visionPrompt = pdfPromptTemplate + `\n\nThe surrogate profile PDF is attached. Read ALL text from the PDF pages and extract the surrogate profile data. Pay careful attention to every field, question, and answer visible in the document.`;
          result = await model.generateContent([visionPrompt, pdfPart]);
        } else {
          const prompt = pdfPromptTemplate + `\n\nHere is the text content extracted from a surrogate profile PDF:\n\n${extractedText.substring(0, 30000)}`;
          result = await model.generateContent(prompt);
        }
        return parseJsonRobust(result.response.text());
      })(),
    ]);

    if (isJobCancelled(job.id)) return;

    tracker.setStage(fileIndex, `Saving profiles from ${shortName}`, 90);

    if (!aiData) {
      job.errors.push(`${fileName}: Failed to parse AI response as JSON`);
      job.failed++;
      job.processed++;
      return;
    }

    const surrogates = aiData.surrogates || [aiData];
    if (!Array.isArray(surrogates) || surrogates.length === 0) {
      job.errors.push(`${fileName}: AI did not extract any surrogate profiles`);
      job.failed++;
      job.processed++;
      return;
    }

    for (const surrogate of surrogates) {
      if (isJobCancelled(job.id)) return;
      try {
        const agencyId = surrogate.externalId || null;

        let pdfExtId: string;
        idCounter.value++;
        pdfExtId = `pdf-${String(idCounter.value).padStart(5, "0")}`;

        const profileData: Record<string, any> = surrogate.profileData || {};
        if (agencyId) {
          profileData["Agency ID"] = agencyId;
        }
        if (pdfCloudUrl) {
          profileData["Original PDF"] = pdfCloudUrl;
        }
        profileData["Source"] = "PDF Upload";
        profileData["Source File"] = fileName;

        surrogate.externalId = pdfExtId;
        surrogate.profileUrl = pdfCloudUrl || null;
        surrogate.profileData = profileData;

        if (photoUrls.length > 0 && !surrogate.photoUrl) {
          surrogate.photoUrl = photoUrls[0];
        }
        if (photoUrls.length > 0) {
          surrogate.photos = photoUrls;
          profileData["All Photos"] = photoUrls;
          if (profileData["_sections"]) {
            profileData["_sections"]["Photos"] = photoUrls;
          }
        }

        const upsertResult = await upsertSurrogate(prisma, job.providerId, surrogate, storageService);
        job.succeeded++;
        if (upsertResult.isNew) job.newProfiles++;
      } catch (upsertErr: any) {
        job.errors.push(`${fileName}: Upsert failed — ${upsertErr.message}`);
        job.failed++;
      }
    }

    job.processed++;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[pdf-sync] Finished ${fileName} in ${elapsed}s`);
  } catch (err: any) {
    console.error(`[pdf-sync] Error processing ${fileName}:`, err.message);
    job.errors.push(`${fileName}: ${err.message}`);
    job.failed++;
    job.processed++;
  }
}

async function runPdfSyncJob(
  prisma: PrismaService,
  storageService: StorageService,
  job: SyncJob,
  files: Array<{ originalname: string; buffer: Buffer }>,
): Promise<void> {
  const startTime = Date.now();
  console.log(`[pdf-sync] Starting PDF sync for provider ${job.providerId}, ${files.length} files (concurrency=${PDF_CONCURRENCY})`);

  const allExisting = await prisma.surrogate.findMany({
    where: { providerId: job.providerId },
    select: { externalId: true },
  });
  const idCounter = { value: 0 };
  for (const s of allExisting) {
    if (!s.externalId) continue;
    const raw = s.externalId.replace(/^pdf-/, "");
    const numMatch = raw.match(/^(\d+)$/);
    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      if (n > idCounter.value) idCounter.value = n;
    }
  }

  const tracker = createFileProgressTracker(job);

  if (files.length === 1) {
    await processSinglePdf(prisma, storageService, job, files[0], 0, idCounter, tracker);
    tracker.removeFile(0);
  } else {
    let nextIndex = 0;
    const runNext = async (): Promise<void> => {
      while (nextIndex < files.length) {
        if (isJobCancelled(job.id) || job.status !== "running") return;
        const idx = nextIndex++;
        await processSinglePdf(prisma, storageService, job, files[idx], idx, idCounter, tracker);
        tracker.removeFile(idx);
      }
    };

    const concurrency = Math.min(PDF_CONCURRENCY, files.length);
    const workers = Array.from({ length: concurrency }, () => runNext());
    await Promise.all(workers);
  }

  if (isJobCancelled(job.id)) {
    job.status = "failed";
    job.errors.push("Job was cancelled by user");
  } else {
    job.status = job.errors.length > 0 && job.succeeded === 0 ? "failed" : "completed";
  }
  job.currentStep = undefined;
  job.completedAt = new Date();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[pdf-sync] Completed in ${elapsed}s: ${job.succeeded} succeeded, ${job.failed} failed`);
}

export async function repairPhotoUrls(
  prisma: PrismaService,
  storageService: StorageService,
  providerId: string,
): Promise<{ repaired: number; failed: number }> {
  let repaired = 0;
  let failed = 0;

  const tables = [
    { model: prisma.eggDonor, name: "eggDonor" },
    { model: prisma.surrogate, name: "surrogate" },
    { model: prisma.spermDonor, name: "spermDonor" },
  ] as const;

  for (const table of tables) {
    const records = await (table.model as any).findMany({
      where: { providerId },
      select: { id: true, photoUrl: true, photos: true, profileData: true },
    });

    for (const record of records) {
      const needsRepair = (url: string) =>
        url && typeof url === "string" && !isAlreadyPersisted(url) && /s3[.\-].*amazonaws\.com|X-Amz-/i.test(url);

      let changed = false;
      const updates: any = {};

      if (needsRepair(record.photoUrl)) {
        const newUrl = await persistSinglePhoto(record.photoUrl, providerId, storageService);
        if (newUrl !== record.photoUrl) {
          updates.photoUrl = newUrl;
          changed = true;
        }
      }

      if (Array.isArray(record.photos)) {
        const newPhotos = [...record.photos];
        for (let i = 0; i < newPhotos.length; i++) {
          if (needsRepair(newPhotos[i])) {
            const newUrl = await persistSinglePhoto(newPhotos[i], providerId, storageService);
            if (newUrl !== newPhotos[i]) {
              newPhotos[i] = newUrl;
              changed = true;
            }
          }
        }
        if (changed) updates.photos = newPhotos;
      }

      if (record.profileData) {
        const pd = { ...record.profileData } as any;
        const repairPhotoArray = async (arr: string[]) => {
          for (let i = 0; i < arr.length; i++) {
            if (needsRepair(arr[i])) {
              const newUrl = await persistSinglePhoto(arr[i], providerId, storageService);
              if (newUrl !== arr[i]) {
                arr[i] = newUrl;
                changed = true;
              }
            }
          }
        };

        for (const key of ["All Photos", "Photos"]) {
          if (Array.isArray(pd[key])) await repairPhotoArray(pd[key]);
        }

        if (pd._sections && typeof pd._sections === "object") {
          for (const sectionKey of Object.keys(pd._sections)) {
            const section = pd._sections[sectionKey];
            if (section && typeof section === "object") {
              for (const field of ["All Photos", "Photos"]) {
                if (Array.isArray(section[field])) await repairPhotoArray(section[field]);
              }
            }
          }
        }

        if (changed) updates.profileData = pd;
      }

      if (changed) {
        try {
          await (table.model as any).update({ where: { id: record.id }, data: updates });
          repaired++;
        } catch (err: any) {
          console.error(`[photo-repair] Failed to update ${table.name} ${record.id}: ${err.message}`);
          failed++;
        }
      }
    }
  }

  return { repaired, failed };
}

export async function deletePdfSurrogates(
  prisma: PrismaService,
  providerId: string,
): Promise<number> {
  const result = await prisma.surrogate.deleteMany({
    where: {
      providerId,
      externalId: { startsWith: "pdf-" },
    },
  });
  await recalcAndPersistTotalCostsForProvider(prisma, providerId);
  return result.count;
}
