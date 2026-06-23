import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { computeClinicSuccessRate, type EggSource, type AgeGroup } from "./lib/ivf-success-rate.js";
import { DOCTOR_MEMBER_SELECT, enrichDoctorRows } from "./lib/doctor-enrichment.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const cleanExternalId = (eid: string | null | undefined) => eid ? eid.replace(/^[a-zA-Z]+-/, "") : null;

function parseHeightToInches(h: string | null | undefined): number {
  if (!h) return 0;
  const match = h.match(/(\d+)[''′]?\s*(\d+)?/);
  if (match) return Number(match[1]) * 12 + (Number(match[2]) || 0);
  const cmMatch = h.match(/([\d.]+)\s*cm/i);
  if (cmMatch) return Number(cmMatch[1]) / 2.54;
  return 0;
}


async function generateSearchEmbedding(text: string): Promise<number[] | null> {
  if (!text || !process.env.GEMINI_API_KEY) return null;
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
    const result = await model.embedContent({ content: { parts: [{ text }], role: "user" }, outputDimensionality: 768 } as any);
    return result.embedding.values;
  } catch (e) {
    return null;
  }
}

const ALLOWED_TABLES = new Set(["EggDonor", "Surrogate", "SpermDonor", "Provider"]);

const ETHNICITY_SYNONYMS: Record<string, string[]> = {
  "white": ["white", "caucasian"],
  "caucasian": ["caucasian", "white"],
  "black": ["black", "african american", "african"],
  "african american": ["african american", "black", "african"],
  "african": ["african", "black", "african american"],
  "hispanic": ["hispanic", "latino", "latina"],
  "latino": ["latino", "latina", "hispanic"],
  "latina": ["latina", "latino", "hispanic"],
  "middle eastern": ["middle eastern", "arab", "arabic"],
  "arab": ["arab", "arabic", "middle eastern"],
  "mixed": ["mixed", "biracial", "multiracial"],
  "biracial": ["biracial", "mixed", "multiracial"],
  "multiracial": ["multiracial", "mixed", "biracial"],
};

function resolveEthnicityTerms(val: string): string[] {
  const lower = val.toLowerCase().trim();
  return ETHNICITY_SYNONYMS[lower] || [lower];
}

async function vectorSearch(
  table: string,
  queryText: string,
  limit: number,
  extraWhere?: string,
  selectColumns?: string,
): Promise<any[] | null> {
  if (!ALLOWED_TABLES.has(table)) return null;
  const embedding = await generateSearchEmbedding(queryText);
  if (!embedding) return null;
  const vectorStr = `[${embedding.join(",")}]`;
  const cols = selectColumns || "*";
  const whereClause = extraWhere ? `WHERE "profileEmbedding" IS NOT NULL AND ${extraWhere}` : `WHERE "profileEmbedding" IS NOT NULL`;
  try {
    const results: any[] = await prisma.$queryRawUnsafe(
      `SELECT ${cols}, 1 - ("profileEmbedding" <=> $1::vector) as similarity
       FROM "${table}"
       ${whereClause}
       ORDER BY "profileEmbedding" <=> $1::vector
       LIMIT $2`,
      vectorStr,
      limit,
    );
    if (results.length > 0 && Number(results[0].similarity) > 0.1) {
      return results;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Filter-first, rank-second: run vector search scoped to a pre-filtered set of IDs.
// Guarantees zero false negatives - only ranks within the exact attribute-matched pool.
async function vectorSearchByIds(
  table: string,
  ids: string[],
  queryText: string,
  limit: number,
  selectColumns: string,
): Promise<any[] | null> {
  if (!ALLOWED_TABLES.has(table) || ids.length === 0) return null;
  const embedding = await generateSearchEmbedding(queryText);
  if (!embedding) return null;
  const vectorStr = `[${embedding.join(",")}]`;
  try {
    const results: any[] = await prisma.$queryRawUnsafe(
      `SELECT ${selectColumns}, 1 - ("profileEmbedding" <=> $1::vector) as similarity
       FROM "${table}"
       WHERE id = ANY($2::uuid[]) AND "profileEmbedding" IS NOT NULL
       ORDER BY "profileEmbedding" <=> $1::vector
       LIMIT $3`,
      vectorStr,
      ids,
      limit,
    );
    return results.length > 0 ? results : null;
  } catch (e) {
    return null;
  }
}

function buildEthnicityWhere(ethnicityTerms: string[]): any {
  return { AND: [{ OR: ethnicityTerms.flatMap(t => [
    { ethnicity: { contains: t, mode: "insensitive" } },
    { race: { contains: t, mode: "insensitive" } },
  ]) }] };
}

// Shared location resolution - maps any input to all synonymous search terms.
// "TX" → ["TX","Texas"], "Texas" → ["Texas","TX"], "USA" → ["usa","united states",...]
// City or unknown input → [input] (search as-is)
const STATE_ABBREV_MAP: Record<string, string> = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",
  CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",
  IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",
  ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",
  MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",
  NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",
  NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",
  PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",
  TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",
  WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",DC:"District of Columbia",
};
const STATE_FULL_TO_ABBREV: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_ABBREV_MAP).map(([k, v]) => [v.toLowerCase(), k])
);
const LOCATION_SYNONYMS: Record<string, string[]> = {
  "united states": ["united states","usa","us","u.s.","u.s.a.","united states of america","america"],
  "mexico":        ["mexico","méxico"],
  "colombia":      ["colombia"],
  "taiwan":        ["taiwan","taiwan (r.o.c.)","台灣"],
  "canada":        ["canada"],
  "united kingdom":["united kingdom","uk","great britain","england","scotland","wales"],
  "cyprus":        ["cyprus"],
  "israel":        ["israel"],
  "australia":     ["australia"],
  "germany":       ["germany","deutschland"],
  "spain":         ["spain","españa"],
  "greece":        ["greece"],
  "ukraine":       ["ukraine"],
  "czech republic":["czech republic","czechia"],
};
function resolveLocationTerms(location: string): string[] {
  if (!location) return [];
  const trimmed = location.trim();
  const lower = trimmed.toLowerCase();
  for (const synonyms of Object.values(LOCATION_SYNONYMS)) {
    if (synonyms.includes(lower)) return synonyms;
  }
  const upper = trimmed.toUpperCase();
  if (STATE_ABBREV_MAP[upper]) return [upper, STATE_ABBREV_MAP[upper]];
  if (STATE_FULL_TO_ABBREV[lower]) return [trimmed, STATE_FULL_TO_ABBREV[lower]];
  return [trimmed];
}
const USA_SYNONYMS = new Set(["united states","usa","us","u.s.","u.s.a.","united states of america","america"]);
// Build Prisma OR clause for a flat `location` text field (surrogates, egg donors, sperm donors)
function buildLocationWhere(location: string): any {
  const terms = resolveLocationTerms(location);
  if (!terms.length) return {};
  // Special case: USA query - surrogate/donor locations store "City, State" not "USA".
  // Match any record whose location contains a US state name or abbreviation.
  if (terms.some(t => USA_SYNONYMS.has(t.toLowerCase()))) {
    const stateTerms = [
      ...Object.keys(STATE_ABBREV_MAP),   // "TX", "CA", etc.
      ...Object.values(STATE_ABBREV_MAP),  // "Texas", "California", etc.
    ];
    return { OR: stateTerms.map(s => ({ location: { contains: s, mode: "insensitive" } })) };
  }
  if (terms.length === 1) return { location: { contains: terms[0], mode: "insensitive" } };
  return { OR: terms.map(t => ({ location: { contains: t, mode: "insensitive" } })) };
}
// Build Prisma OR clause for ProviderLocation table (clinics - separate city + state columns)
function buildClinicLocationWhere(location: string): any {
  const terms = resolveLocationTerms(location);
  if (!terms.length) return {};
  return { some: { OR: terms.flatMap(t => [
    { state: { contains: t, mode: "insensitive" } },
    { city:  { contains: t, mode: "insensitive" } },
  ]) } };
}

// Word-boundary match: prevents "Asian" from matching "Caucasian"
function wordBoundaryMatch(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${escaped}($|[^a-z])`).test(haystack.toLowerCase());
}

function ethnicityPostFilter(candidates: any[], ethnicityTerms: string[]): any[] {
  if (!ethnicityTerms.length) return candidates;
  return candidates.filter(d => {
    const raceVal = (d.race || "").toLowerCase();
    const ethVal = (d.ethnicity || "").toLowerCase();
    return ethnicityTerms.some(t => wordBoundaryMatch(raceVal, t) || wordBoundaryMatch(ethVal, t));
  });
}

// Ethnicity purity: 1.0 = pure match (only the requested ethnicity), lower = more mixed.
// e.g. "Caucasian" with requested "white" → 1.0; "Asian (50%), Caucasian (50%)" → 0.5
function scoreEthnicityPurity(candidate: any, ethnicityTerms: string[]): number {
  if (!ethnicityTerms.length) return 0;
  const splitEthnicities = (val: string): string[] => {
    if (!val) return [];
    return val.replace(/\s*\(\s*\d+%?\s*\)/g, "").split(/[,;\/|&+]/).map(s => s.trim()).filter(Boolean);
  };
  const allParts = [
    ...splitEthnicities((candidate.race || "").toLowerCase()),
    ...splitEthnicities((candidate.ethnicity || "").toLowerCase()),
  ];
  if (allParts.length === 0) return 0;
  const matchingCount = allParts.filter(part => ethnicityTerms.some(t => wordBoundaryMatch(part, t))).length;
  return matchingCount / allParts.length;
}

// Scores a donor (egg or sperm) against EVERY criterion the parent requested.
// matchScore = average of per-criterion scores (0.0-1.0). 1.0 = all criteria fully satisfied.
// unmatchedCriteria = human-readable list of mismatches so the AI can call them out explicitly.
//
// Normalize blond/blonde synonyms so "Blonde" and "Blond" always match each other.
function normalizeHairColor(s: string): string {
  return s.replace(/\bblonde\b/gi, "Blond");
}

// Binary criteria (eyeColor, hairColor, education, location, age, height): 1.0 or 0.0
// Ethnicity: continuous purity score (0.0-1.0)
// In Phase 1 all hard-filtered candidates score 1.0 on hard criteria; the differentiator is
// ethnicity purity. In Phase 2 (fallback) relaxed criteria score 0.0 for non-matching candidates.
function scoreDonorMatch(
  candidate: any,
  filters: {
    ethnicityTerms?: string[];
    eyeColor?: string;
    hairColor?: string;
    education?: string;
    location?: string;
    maxAge?: number;
    minHeightInches?: number;
  },
): { matchScore: number; unmatchedCriteria: string[] } {
  const criteria: Array<{ score: number; unmatchedLabel?: string }> = [];

  // Ethnicity purity: pure single-ethnicity = 1.0, mixed = fractional
  if (filters.ethnicityTerms?.length) {
    const purity = scoreEthnicityPurity(candidate, filters.ethnicityTerms);
    criteria.push({
      score: purity,
      unmatchedLabel: purity < 0.99
        ? `pure ${filters.ethnicityTerms[0]} ethnicity (donor has mixed heritage: ${[candidate.race, candidate.ethnicity].filter(Boolean).join(" / ")})`
        : undefined,
    });
  }

  if (filters.eyeColor) {
    const matched = wordBoundaryMatch((candidate.eyeColor || "").toLowerCase(), filters.eyeColor.toLowerCase());
    criteria.push({ score: matched ? 1 : 0, unmatchedLabel: matched ? undefined : `${filters.eyeColor} eyes (donor has ${candidate.eyeColor || "unspecified"} eyes)` });
  }

  if (filters.hairColor) {
    const normCandidate = normalizeHairColor(candidate.hairColor || "").toLowerCase();
    const normFilter = normalizeHairColor(filters.hairColor).toLowerCase();
    const matched = wordBoundaryMatch(normCandidate, normFilter);
    criteria.push({ score: matched ? 1 : 0, unmatchedLabel: matched ? undefined : `${filters.hairColor} hair (donor has ${candidate.hairColor || "unspecified"} hair)` });
  }

  if (filters.education) {
    const matched = (candidate.education || "").toLowerCase().includes(filters.education.toLowerCase());
    criteria.push({ score: matched ? 1 : 0, unmatchedLabel: matched ? undefined : `${filters.education} education (donor has ${candidate.education || "unspecified"})` });
  }

  if (filters.location) {
    const terms = resolveLocationTerms(filters.location);
    const loc = (candidate.location || "").toLowerCase();
    const matched = terms.some(t => loc.includes(t.toLowerCase()));
    criteria.push({ score: matched ? 1 : 0, unmatchedLabel: matched ? undefined : `${filters.location} location (donor is in ${candidate.location || "unknown location"})` });
  }

  if (filters.maxAge != null && candidate.age != null) {
    const matched = Number(candidate.age) <= filters.maxAge;
    criteria.push({ score: matched ? 1 : 0, unmatchedLabel: matched ? undefined : `age under ${filters.maxAge} (donor is ${candidate.age})` });
  }

  if (filters.minHeightInches != null) {
    const h = parseHeightToInches(candidate.height);
    const matched = h === 0 || h >= filters.minHeightInches;
    const ft = Math.floor(filters.minHeightInches / 12);
    const inch = filters.minHeightInches % 12;
    criteria.push({ score: matched ? 1 : 0, unmatchedLabel: matched ? undefined : `height ${ft}'${inch}"+ (donor is ${candidate.height || "height unknown"})` });
  }

  if (criteria.length === 0) return { matchScore: 1.0, unmatchedCriteria: [] };
  const totalScore = criteria.reduce((sum, c) => sum + c.score, 0);
  return {
    matchScore: totalScore / criteria.length,
    unmatchedCriteria: criteria.filter(c => c.unmatchedLabel).map(c => c.unmatchedLabel!),
  };
}

// Scores a surrogate against every criterion the parent requested.
// Surrogates are ranked by health/quality metrics (BMI lower = healthier, age margin, experience)
// since most boolean requirements are already hard-filtered. Also scores ethnicity, location,
// c-sections, miscarriages, recency of last pregnancy, and covid vaccination when applicable.
function scoreSurrogateMatch(
  candidate: any,
  filters: {
    ethnicityTerms?: string[];
    maxAge?: number;
    minAge?: number;
    maxBmi?: number;
    location?: string;
    requireCovidVaccinated?: boolean;
  },
): { matchScore: number; unmatchedCriteria: string[] } {
  const criteria: Array<{ score: number; unmatchedLabel?: string }> = [];

  // BMI: always scored when available — lower is healthier (0.0-1.0)
  if (candidate.bmi != null) {
    const bmi = Number(candidate.bmi);
    if (bmi > 0) {
      const bmiMax = filters.maxBmi ?? 32;
      criteria.push({ score: Math.max(0, Math.min(1, (bmiMax - bmi) / (bmiMax - 18))) });
    }
  }

  // Age: younger within the allowed range ranks higher (quality score)
  if (filters.maxAge != null && candidate.age != null) {
    const floor = filters.minAge ?? 18;
    const range = filters.maxAge - floor;
    criteria.push({ score: range > 0 ? Math.max(0, (filters.maxAge - Number(candidate.age)) / range) : 1 });
  }

  // Live births: more prior surrogacies = more experience (0.0-1.0, capped at 4)
  if (candidate.liveBirths != null) {
    criteria.push({ score: Math.min(1, Number(candidate.liveBirths) / 4) });
  }

  // C-sections: always scored when available — fewer is better (0 = 1.0, 3+ = 0.0)
  if (candidate.cSections != null) {
    const cs = Number(candidate.cSections);
    const csScore = Math.max(0, 1 - cs / 3);
    criteria.push({
      score: csScore,
      unmatchedLabel: cs >= 3 ? `high c-section count (${cs} c-sections)` : undefined,
    });
  }

  // Miscarriages: fewer is better (0 = 1.0, 3+ = 0.0)
  if (candidate.miscarriages != null) {
    const m = Number(candidate.miscarriages);
    const mScore = Math.max(0, 1 - m / 3);
    criteria.push({
      score: mScore,
      unmatchedLabel: m >= 3 ? `high miscarriage count (${m} miscarriages)` : undefined,
    });
  }

  // Last delivery recency: more recent = better (0-2 years = 1.0, 5+ years = 0.0)
  if (candidate.lastDeliveryYear != null) {
    const currentYear = new Date().getFullYear();
    const yearsAgo = currentYear - Number(candidate.lastDeliveryYear);
    const recencyScore = yearsAgo <= 0 ? 1.0 : Math.max(0, 1 - (yearsAgo - 1) / 4);
    criteria.push({
      score: recencyScore,
      unmatchedLabel: yearsAgo > 5 ? `last pregnancy ${yearsAgo} years ago (less recent)` : undefined,
    });
  }

  // Covid vaccination: if parent explicitly requires it, binary 1.0/0.0
  if (filters.requireCovidVaccinated === true) {
    const vaccinated = candidate.covidVaccinated === true;
    criteria.push({
      score: vaccinated ? 1 : 0,
      unmatchedLabel: vaccinated ? undefined : "covid vaccination not confirmed",
    });
  }

  // Ethnicity: purity score (softer for surrogates since they don't contribute genetics)
  if (filters.ethnicityTerms?.length) {
    const purity = scoreEthnicityPurity(candidate, filters.ethnicityTerms);
    criteria.push({
      score: purity,
      unmatchedLabel: purity < 0.99 ? `pure ${filters.ethnicityTerms[0]} ethnicity (surrogate has mixed heritage)` : undefined,
    });
  }

  // Location: exact match (1.0/0.0)
  if (filters.location) {
    const terms = resolveLocationTerms(filters.location);
    const loc = (candidate.location || "").toLowerCase();
    const matched = terms.some(t => loc.includes(t.toLowerCase()));
    criteria.push({ score: matched ? 1 : 0, unmatchedLabel: matched ? undefined : `${filters.location} location (surrogate is in ${candidate.location || "unknown location"})` });
  }

  if (criteria.length === 0) return { matchScore: 1.0, unmatchedCriteria: [] };
  const totalScore = criteria.reduce((sum, c) => sum + c.score, 0);
  return {
    matchScore: totalScore / criteria.length,
    unmatchedCriteria: criteria.filter(c => c.unmatchedLabel).map(c => c.unmatchedLabel!),
  };
}

// Cascade fallback search:
// Phase 1 - try with ALL soft criteria as hard Prisma filters (100% match attempt).
// Phase 2 - if Phase 1 returns zero results, relax ONE soft criterion at a time (in order provided)
//           and retry. Returns the first non-empty result set and the relaxed criterion label.
// postFilterFn receives the relaxed criterion label so it can skip corresponding in-memory filters.
type SoftFilter = { label: string; applyToWhere: (w: any) => void };

async function searchWithFallback(
  findManyFn: (where: any) => Promise<any[]>,
  baseWhere: any,
  softFilters: SoftFilter[],
  postFilterFn?: (candidates: any[], relaxedLabel: string | null) => any[],
): Promise<{ candidates: any[]; relaxedFilter: string | null }> {
  const applyPost = (c: any[], relaxed: string | null) => postFilterFn ? postFilterFn(c, relaxed) : c;

  // Phase 1: full match — all soft criteria applied as hard Prisma filters
  const fullWhere = { ...baseWhere };
  for (const sf of softFilters) sf.applyToWhere(fullWhere);
  const fullResults = applyPost(await findManyFn(fullWhere), null);
  if (fullResults.length > 0) return { candidates: fullResults, relaxedFilter: null };

  // Phase 2: relax one criterion at a time (most expendable first per the softFilters order)
  for (const relaxed of softFilters) {
    const where = { ...baseWhere };
    for (const sf of softFilters) {
      if (sf !== relaxed) sf.applyToWhere(where);
    }
    const results = applyPost(await findManyFn(where), relaxed.label);
    if (results.length > 0) return { candidates: results, relaxedFilter: relaxed.label };
  }

  return { candidates: [], relaxedFilter: null };
}

const server = new Server(
  {
    name: "gostork-database-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_ip_profile",
        description:
          "Retrieve the Intended Parent's biological profile and preferences",
        inputSchema: {
          type: "object",
          properties: {
            userId: {
              type: "string",
              description: "The ID of the Intended Parent user",
            },
          },
          required: ["userId"],
        },
      },
      {
        name: "search_surrogates",
        description:
          "Search the database for available surrogates. Attribute filters (booleans, compensation, ethnicity, age) use exact database matching - zero false negatives. The optional 'query' parameter adds semantic ranking within the matched pool for soft attributes like personality, insurance, or health history. Use the returned IDs in MATCH_CARDs with type 'Surrogate'. DO NOT pass any location or country parameter - surrogates are matched by agency network, not by location.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Optional semantic ranking query for soft attributes not covered by other filters (e.g. 'has medical insurance', 'vaginal delivery history', 'nurse or healthcare worker', 'vegetarian'). Applied AFTER hard filters to rank results by relevance.",
            },
            parentCountry: {
              type: "string",
              description: "The parent's country of citizenship/nationality (e.g. 'Italy', 'Germany', 'France'). Used to filter out surrogacy agencies that do not serve citizens from that country. Pass this from the parent's profile country field whenever available.",
            },
            agreesToTwins: {
              type: "boolean",
              description: "Filter for surrogates who agree to carry twins",
            },
            agreesToAbortion: {
              type: "boolean",
              description: "Filter for pro-choice (true) or pro-life (false) surrogates",
            },
            openToSameSexCouple: {
              type: "boolean",
              description: "Filter for surrogates open to same-sex couples",
            },
            isExperienced: {
              type: "boolean",
              description: "Filter for experienced surrogates only",
            },
            location: {
              type: "string",
              description: "Filter by surrogate location - accepts state abbreviation ('TX'), state full name ('Texas'), or country ('USA', 'Colombia', 'Mexico'). For USA: matches any surrogate whose location contains a US state name. For specific state: matches that state. Do NOT pass this unless the parent explicitly requested a specific country or state.",
            },
            maxAge: {
              type: "number",
              description: "Maximum surrogate age (inclusive). Use when parent requests a surrogate 'not older than X' or 'under X years old'.",
            },
            minAge: {
              type: "number",
              description: "Minimum surrogate age (inclusive). Use when parent requests a surrogate 'at least X years old'.",
            },
            maxCompensation: {
              type: "number",
              description: "Maximum base compensation in USD",
            },
            ethnicity: {
              type: "string",
              description: "Filter by ethnicity or race (e.g. 'Hispanic', 'Caucasian', 'Asian', 'Black', 'White'). Checked against both ethnicity and race fields with synonym resolution.",
            },
            maxBmi: {
              type: "number",
              description: "Maximum surrogate BMI (inclusive). Use when parent requests a surrogate with a BMI under X or no higher than X. After applying advisory, use the parent's confirmed final preference.",
            },
            maxCsections: {
              type: "number",
              description: "Maximum number of c-sections (inclusive). Clinics cap approval at 2. Use after advisory when parent specifies a c-section preference.",
            },
            maxMiscarriages: {
              type: "number",
              description: "Maximum number of miscarriages (inclusive). Use only if the parent insists on this filter after the advisory explains miscarriages are not a disqualifier.",
            },
            requireCovidVaccinated: {
              type: "boolean",
              description: "Pass true if the parent explicitly requires the surrogate to be covid vaccinated. Only use when the parent specifically requests this - do not assume.",
            },
            openToInternationalParents: {
              type: "boolean",
              description: "Pass true if the parent is from a country other than the USA (i.e. they are international intended parents). Surrogates who have not indicated openness to international parents will be excluded. Determine from the parent's profile 'country' field - if it is not US/USA/United States, pass true.",
            },
            limit: {
              type: "number",
              description: "Number of results to return (default 3, max 5)",
            },
            excludeIds: {
              type: "array",
              items: { type: "string" },
              description: "Array of surrogate IDs to exclude from results (already presented profiles)",
            },
            parentClinicName: {
              type: "string",
              description: "Name of the parent's IVF clinic. When provided, the clinic's surrogate medical requirements (age range, BMI, c-sections, etc.) are automatically applied as hard filters. Always pass this when the parent has an existing IVF clinic.",
            },
          },
        },
      },
      {
        name: "get_surrogate_profile",
        description:
          "Look up a specific surrogate's FULL profile by their ID or external ID (e.g. '19331'). Returns complete pregnancy history (birth weights, delivery types, gestational ages), health details, support system, motivation, letter to intended parents, preferences, and all other profile sections. Use this tool when a parent asks follow-up questions about a specific surrogate's details - DO NOT whisper if this tool can answer the question.",
        inputSchema: {
          type: "object",
          properties: {
            surrogateId: {
              type: "string",
              description: "The surrogate's UUID (id field) from a previous search result or MATCH_CARD",
            },
            externalId: {
              type: "string",
              description: "The surrogate's external ID number (e.g. '19331' from 'Surrogate #19331'). Use this if you don't have the UUID.",
            },
          },
        },
      },
      {
        name: "get_egg_donor_profile",
        description:
          "Look up a specific egg donor's FULL profile by their ID or external ID (e.g. 'S19907' or '19722'). Returns complete health history, family medical history, education, physical traits, personality, hobbies, and all other profile sections. Use this tool when a parent asks follow-up questions about a specific egg donor's details - DO NOT whisper if this tool can answer the question.",
        inputSchema: {
          type: "object",
          properties: {
            donorId: {
              type: "string",
              description: "The egg donor's UUID (id field) from a previous search result or MATCH_CARD",
            },
            externalId: {
              type: "string",
              description: "The egg donor's external ID (e.g. 'S19907' or '19722' from 'Donor #S19907'). Use this if you don't have the UUID.",
            },
          },
        },
      },
      {
        name: "search_egg_donors",
        description:
          "Search the database for available egg donors. Attribute filters (ethnicity, eyeColor, hairColor, height, age, education) use exact database matching - zero false negatives. The optional 'query' parameter adds semantic ranking within the matched pool for soft attributes like personality or hobbies. Use the returned IDs in MATCH_CARDs with type 'Egg Donor'.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Optional semantic ranking query for soft attributes not covered by other filters (e.g. 'athletic and artistic', 'loves animals', 'warm personality'). Applied AFTER hard filters to rank results by relevance.",
            },
            eyeColor: {
              type: "string",
              description: "Filter by eye color (e.g. 'Brown', 'Blue', 'Green', 'Light Blue', 'Hazel')",
            },
            hairColor: {
              type: "string",
              description: "Filter by hair color (e.g. 'Black', 'Brown', 'Blonde', 'Dark Brown')",
            },
            ethnicity: {
              type: "string",
              description: "Filter by ethnicity or race (e.g. 'Caucasian', 'Hispanic', 'Asian', 'Black', 'White'). Checked against both ethnicity and race fields with synonym resolution (White = Caucasian).",
            },
            minHeightInches: {
              type: "number",
              description: "Minimum height in inches. Examples: 53=4'5\", 60=5'0\", 63=5'3\", 65=5'5\", 66=5'6\", 72=6'0\".",
            },
            maxAge: {
              type: "number",
              description: "Maximum donor age",
            },
            education: {
              type: "string",
              description: "Filter by education level (e.g. 'Bachelor', 'Master', 'College', 'Graduate')",
            },
            isExperienced: {
              type: "boolean",
              description: "Filter for donors who have donated before (experienced donors only)",
            },
            donationType: {
              type: "string",
              description: "Filter by donation type (e.g. 'Fresh', 'Frozen')",
            },
            location: {
              type: "string",
              description: "Filter by location - accepts country ('USA', 'Taiwan', 'Canada'), state abbreviation ('CA'), state full name ('California'), or city. Smart synonym resolution handles variants (USA = United States, TX = Texas, etc.).",
            },
            limit: {
              type: "number",
              description: "Number of results to return (default 3, max 5)",
            },
            excludeIds: {
              type: "array",
              items: { type: "string" },
              description: "Array of egg donor IDs to exclude from results (already presented profiles)",
            },
          },
        },
      },
      {
        name: "search_sperm_donors",
        description:
          "Search the database for available sperm donors. Attribute filters use exact database matching - zero false negatives. The optional 'query' parameter adds semantic ranking within the matched pool for soft attributes like personality or hobbies. Use the returned IDs in MATCH_CARDs with type 'Sperm Donor'.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Optional semantic ranking query for soft attributes (e.g. 'athletic', 'artistic', 'medical background'). Applied AFTER hard filters to rank results by relevance.",
            },
            eyeColor: {
              type: "string",
              description: "Filter by eye color (e.g. 'Brown', 'Blue', 'Green')",
            },
            hairColor: {
              type: "string",
              description: "Filter by hair color (e.g. 'Black', 'Brown', 'Blonde')",
            },
            ethnicity: {
              type: "string",
              description: "Filter by ethnicity or race (e.g. 'Caucasian', 'Hispanic', 'Asian', 'Black', 'White'). Checked against both ethnicity and race fields.",
            },
            minHeightInches: {
              type: "number",
              description: "Minimum height in inches. Examples: 60=5'0\", 63=5'3\", 65=5'5\", 66=5'6\", 72=6'0\". Use when parent specifies a minimum height.",
            },
            maxAge: {
              type: "number",
              description: "Maximum donor age",
            },
            education: {
              type: "string",
              description: "Filter by education level",
            },
            height: {
              type: "string",
              description: "Filter by exact height string (use minHeightInches for minimum height ranges)",
            },
            location: {
              type: "string",
              description: "Filter by location - accepts country, state abbreviation, state full name, or city. Smart synonym resolution handles variants (USA = United States, TX = Texas, etc.).",
            },
            limit: {
              type: "number",
              description: "Number of results to return (default 3, max 5)",
            },
            excludeIds: {
              type: "array",
              items: { type: "string" },
              description: "Array of sperm donor IDs to exclude from results (already presented profiles)",
            },
          },
        },
      },
      {
        name: "search_clinics",
        description:
          "Search the database for IVF fertility clinics using semantic vector search across ALL profile data including success rates, services, team members, and specializations. Returns real clinic profiles with their IDs, logos, and locations. Use the 'query' parameter to search by ANY attribute. Use the returned IDs in MATCH_CARDs with type 'Clinic'.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Free-text search query matched against the clinic's FULL profile via semantic vector search. Use this for ANY attribute: specializations, success rates, specific services, team expertise, insurance acceptance, treatment types, etc.",
            },
            location: {
              type: "string",
              description: "Unified location filter - accepts state abbreviation ('TX'), state full name ('Texas'), country ('Colombia', 'Mexico', 'Taiwan'), or city name ('Los Angeles'). Preferred over state/city for non-US locations. Smart synonym resolution handles all variants.",
            },
            state: {
              type: "string",
              description: "Filter by US state abbreviation or name (e.g. 'CA', 'NY', 'Texas'). Use location param instead for non-US countries.",
            },
            city: {
              type: "string",
              description: "Filter by city name",
            },
            name: {
              type: "string",
              description: "Search by clinic name (partial match)",
            },
            minSuccessRate: {
              type: "number",
              description: "Minimum success rate percentage to filter by (e.g. 50 for 50%+). Applies to the selected ageGroup and eggSource.",
            },
            ageGroup: {
              type: "string",
              enum: ["under_35", "35_37", "38_40", "over_40"],
              description: "Parent's age group for success rate matching. MUST be provided when searching for clinics. Determines which age-specific success rate is shown as the primary rate.",
            },
            eggSource: {
              type: "string",
              enum: ["own_eggs", "donor"],
              description: "Whether the parent is using own eggs or donor eggs. Affects which success rate metric is used. Default: own_eggs.",
            },
            isNewPatient: {
              type: "boolean",
              description: "Whether the parent is a first-time IVF patient (true) or has done IVF before (false). When true, shows new-patient-specific success rates.",
            },
            wantsTwins: {
              type: "boolean",
              description: "Pass true if the parent said they are hoping for twins (from question A3). Clinics with ivfTwinsAllowed=false will be excluded.",
            },
            wantsEmbryoTransfer: {
              type: "boolean",
              description: "Pass true if the parent wants to transfer embryos from another clinic. Clinics that do not allow transfers from other clinics will be excluded.",
            },
            parentAge1: {
              type: "number",
              description: "Age of the first intended parent (IP1). Used to filter out clinics whose maximum age for IP1 is lower than this value.",
            },
            parentAge2: {
              type: "number",
              description: "Age of the second intended parent (IP2), if applicable. Used to filter out clinics whose maximum age for IP2 is lower than this value.",
            },
            patientType: {
              type: "string",
              enum: ["single_woman", "single_man", "gay_couple", "straight_couple", "straight_married_couple"],
              description: "Family type of the intended parents inferred from the conversation. Clinics that do not list this patient type in their accepted patients will be excluded.",
            },
            limit: {
              type: "number",
              description: "Number of results to return (default 5, max 10)",
            },
            excludeIds: {
              type: "array",
              items: { type: "string" },
              description: "Array of clinic/provider IDs to exclude from results (already presented profiles)",
            },
          },
        },
      },
      {
        name: "resolve_match_card",
        description:
          "Internal tool: Look up photo URL, display name, and owner provider ID for a match card by entity ID and type.",
        inputSchema: {
          type: "object",
          properties: {
            entityId: { type: "string", description: "The surrogate/donor/provider UUID" },
            entityType: { type: "string", description: "One of: Surrogate, Egg Donor, Sperm Donor, Clinic" },
            entityName: { type: "string", description: "Display name for fallback name-based provider lookup" },
          },
          required: ["entityId", "entityType"],
        },
      },
      {
        name: "search_doctors",
        description:
          "Search for individual FERTILITY DOCTORS (reproductive endocrinologists / REIs) across approved IVF clinics. Use this - NOT search_clinics - when the parent's need maps to a doctor attribute: a specialty (male factor, PCOS, recurrent pregnancy loss, LGBTQ family building, endometriosis, etc.), a spoken language, doctor gender preference, video visits, or an explicit 'find me a doctor'. Returns enriched doctor profiles (specialties, languages, video visits, the clinic(s) they practice at WITH that clinic's success rate for this parent's profile, and reviews). Use the returned 'slug' in a [[DOCTOR_CARD]] tag - NEVER recommend a doctor in plain text.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Free-text need, e.g. 'male factor specialist', 'Spanish-speaking REI', 'recurrent miscarriage expert'. Matched against the doctor's name, specialties, and clinic name.",
            },
            specialty: { type: "string", description: "Filter to doctors with this specialty (e.g. 'Male Factor Infertility', 'PCOS', 'Recurrent Pregnancy Loss', 'LGBTQ Family Building')." },
            language: { type: "string", description: "Filter to doctors who speak this language (e.g. 'Spanish', 'Mandarin')." },
            location: { type: "string", description: "State abbreviation/name or city (e.g. 'CA', 'California', 'Los Angeles')." },
            state: { type: "string", description: "US state abbreviation or name." },
            city: { type: "string", description: "City name." },
            offersVideoVisits: { type: "boolean", description: "Only doctors who offer video / telehealth visits." },
            acceptingNewPatients: { type: "boolean", description: "Only doctors accepting new patients." },
            lgbtqFriendly: { type: "boolean", description: "Only doctors at clinics that serve LGBTQ family-building." },
            providerGender: { type: "string", description: "Preferred doctor gender ('female' / 'male'), when the parent expressed a preference." },
            ageGroup: { type: "string", enum: ["under_35", "35_37", "38_40", "over_40"], description: "Parent's age group - used to compute each clinic's success rate. Default under_35." },
            eggSource: { type: "string", enum: ["own_eggs", "donor"], description: "Own eggs vs donor eggs - affects the success-rate metric. Default own_eggs." },
            isNewPatient: { type: "boolean", description: "First-time IVF (true) vs prior cycles (false)." },
            limit: { type: "number", description: "Number of results (default 3, max 5)." },
            excludeIds: { type: "array", items: { type: "string" }, description: "Doctor slugs already presented, to exclude." },
          },
        },
      },
      {
        name: "resolve_doctor_card",
        description:
          "Internal tool: Re-resolve a single doctor's enriched card data (DB-truth) by slug, given the parent's success-rate context. Returns the canonical doctor shape (name, photo, specialties, matched specialties, languages, video visits, clinics[] with success rates, reviews). Used to verify an AI-emitted [[DOCTOR_CARD]] slug before rendering.",
        inputSchema: {
          type: "object",
          properties: {
            slug: { type: "string", description: "The doctor's slug (from search_doctors)." },
            ageGroup: { type: "string", enum: ["under_35", "35_37", "38_40", "over_40"], description: "Parent's age group for success-rate computation. Default under_35." },
            eggSource: { type: "string", enum: ["own_eggs", "donor"], description: "own_eggs or donor. Default own_eggs." },
            isNewPatient: { type: "boolean", description: "First-time IVF patient." },
          },
          required: ["slug"],
        },
      },
      {
        name: "resolve_provider",
        description:
          "Internal tool: Look up provider details by ID or by name (partial match). Returns id, name, logoUrl, email, consultationBookingUrl, and consultationIframeEnabled.",
        inputSchema: {
          type: "object",
          properties: {
            providerId: { type: "string", description: "The provider UUID" },
            providerName: { type: "string", description: "Partial name match (used if providerId not provided)" },
          },
        },
      },
      {
        name: "search_knowledge_base",
        description:
          "Internal tool: Semantic vector search over the knowledge base (KnowledgeChunk). Returns relevant content chunks for RAG context.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query text" },
            providerId: { type: "string", description: "Optional provider ID to include tier-1 (provider-specific) chunks" },
            maxResults: { type: "number", description: "Max results to return (default 5)" },
          },
          required: ["query"],
        },
      },
      {
        name: "get_provider_users",
        description:
          "Internal tool: Get user IDs and emails for all users belonging to a provider.",
        inputSchema: {
          type: "object",
          properties: {
            providerId: { type: "string", description: "The provider UUID" },
          },
          required: ["providerId"],
        },
      },
      {
        name: "get_cost_ranges",
        description:
          "Get the minimum and maximum TOTAL journey cost ranges from our database for a given service type (surrogacy, egg-donor, sperm-donor). Returns aggregate min/max across ALL available profiles. Use this tool when a parent asks a GENERAL cost question like 'how much does surrogacy cost?' or 'what are egg donor prices?' - do NOT show individual match cards for general cost questions.",
        inputSchema: {
          type: "object",
          properties: {
            serviceType: {
              type: "string",
              enum: ["surrogacy", "egg-donor", "sperm-donor"],
              description: "The service type to get cost ranges for",
            },
          },
          required: ["serviceType"],
        },
      },
      {
        name: "get_expert_guidance_rules",
        description:
          "Internal tool: Get all active expert guidance rules for system prompt enrichment.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "search_surrogacy_agencies",
        description:
          "Search the database for surrogacy agencies. Use this when the parent asks about agencies - not individual surrogates. Supports filtering by where the agency is located, which parent nationalities the agency accepts, and whether twins are allowed.",
        inputSchema: {
          type: "object",
          properties: {
            agencyLocation: {
              type: "string",
              description: "Where the agency is physically based. Accepts a US state abbreviation ('CA'), full state name ('California'), country name ('Colombia', 'Ukraine'), or 'USA' for all US-based agencies.",
            },
            servesParentFromCountry: {
              type: "string",
              description: "The parent's country of citizenship (e.g. 'Italy', 'Germany'). Excludes agencies that have this country in their surrogacyCitizensNotAllowed list.",
            },
            twinsAllowed: {
              type: "boolean",
              description: "If true, only return agencies where surrogacyTwinsAllowed is true.",
            },
            limit: {
              type: "number",
              description: "Number of agencies to return (default 5, max 10).",
            },
            excludeIds: {
              type: "array",
              items: { type: "string" },
              description: "Array of provider IDs to exclude (already shown to parent).",
            },
          },
        },
      },
      {
        name: "get_parent_meetings",
        description:
          "Look up the parent's OWN scheduled meetings/consultations/calls (the Booking records). Use this WHENEVER the parent asks about an existing or upcoming meeting with a specific provider or person - its time, date, day, timezone, location, or video/join link - or asks to reschedule, move, or cancel it. Optionally filter by providerName (fuzzy, e.g. 'PFCLA' or 'Pacific Fertility'). Returns each booking with bookingId, providerName, scheduledAt (ISO), bookerTimezone, duration, status, meetingType, joinPath (in-app link for confirmed video calls), bookingPageSlug, and publicToken. After answering, ALWAYS emit a [[MEETING_CARD:<bookingId>]] tag so the interactive card (join/reschedule/cancel) renders. The userId is supplied automatically by the server - do not ask the parent for it.",
        inputSchema: {
          type: "object",
          properties: {
            userId: { type: "string", description: "The authenticated parent's user ID (injected by the server)." },
            providerName: { type: "string", description: "Optional fuzzy provider/person name filter (e.g. 'PFCLA', 'Pacific Fertility', a doctor's name)." },
            status: {
              type: "string",
              enum: ["upcoming", "past", "all"],
              description: "Which meetings to return. 'upcoming' (default) = active future/recent bookings excluding cancelled/rescheduled; 'past' = already-happened; 'all' = everything.",
            },
          },
          required: ["userId"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "get_ip_profile") {
      const userId = String(args?.userId);

      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          parentAccount: {
            include: {
              intendedParentProfile: true,
              journeyPreferences: true,
            },
          },
        },
      });

      if (!user || !user.parentAccount) {
        return { content: [{ type: "text", text: "Profile not found." }] };
      }

      return {
        content: [
          { type: "text", text: JSON.stringify(user.parentAccount, null, 2) },
        ],
      };
    }

    if (name === "search_surrogates") {
      const { query, parentCountry, agreesToTwins, agreesToAbortion, openToSameSexCouple, openToInternationalParents, isExperienced, location, maxCompensation, maxAge, minAge, ethnicity, maxBmi, maxCsections, maxMiscarriages, requireCovidVaccinated, limit: rawLimit, excludeIds, parentClinicName } = args as any;
      const take = Math.min(rawLimit || 3, 5);
      const excludeSet = new Set<string>(Array.isArray(excludeIds) ? excludeIds : []);

      // Fetch IVF clinic surrogate requirements when parentClinicName is provided.
      // Clinic requirements are hard constraints (non-negotiable) that override advisory defaults.
      let clinicSurrogateReqs: any = null;
      let clinicRequirementsNote = "";
      if (parentClinicName) {
        const clinic = await prisma.provider.findFirst({
          where: {
            name: { contains: parentClinicName, mode: "insensitive" },
            type: { in: ["IVF_CLINIC", "FERTILITY_CLINIC"] },
          },
          select: {
            name: true,
            ivfSurrogateMinAge: true, ivfSurrogateMaxAge: true,
            ivfSurrogateMinBmi: true, ivfSurrogateMaxBmi: true,
            ivfSurrogateMaxDeliveries: true, ivfSurrogateMaxCSections: true,
            ivfSurrogateMaxMiscarriages: true, ivfSurrogateMaxAbortions: true,
            ivfSurrogateCovidVaccination: true,
          },
        });
        if (clinic) {
          clinicSurrogateReqs = clinic;
          const reqs: string[] = [];
          if (clinic.ivfSurrogateMinAge != null || clinic.ivfSurrogateMaxAge != null) {
            reqs.push(`age ${clinic.ivfSurrogateMinAge ?? "?"}-${clinic.ivfSurrogateMaxAge ?? "?"}`);
          }
          if (clinic.ivfSurrogateMinBmi != null || clinic.ivfSurrogateMaxBmi != null) {
            reqs.push(`BMI ${clinic.ivfSurrogateMinBmi ?? "?"}-${clinic.ivfSurrogateMaxBmi ?? "?"}`);
          }
          if (clinic.ivfSurrogateMaxCSections != null) reqs.push(`max ${clinic.ivfSurrogateMaxCSections} c-sections`);
          if (clinic.ivfSurrogateMaxMiscarriages != null) reqs.push(`max ${clinic.ivfSurrogateMaxMiscarriages} miscarriages`);
          if (clinic.ivfSurrogateMaxDeliveries != null) reqs.push(`max ${clinic.ivfSurrogateMaxDeliveries} deliveries`);
          if (clinic.ivfSurrogateCovidVaccination === true) reqs.push("covid vaccinated required");
          clinicRequirementsNote = reqs.length > 0
            ? ` CLINIC REQUIREMENTS APPLIED (${clinic.name}): ${reqs.join(", ")}. These are non-negotiable hard filters set by the parent's IVF clinic.`
            : ` Clinic "${clinic.name}" found but has no specific surrogate requirements configured.`;
        } else {
          clinicRequirementsNote = ` NOTE: Clinic "${parentClinicName}" not found in database - no clinic requirements applied.`;
        }
      }
      const ethnicityTerms = ethnicity ? resolveEthnicityTerms(ethnicity) : [];

      const surrogateSelect = {
        id: true, providerId: true, externalId: true, firstName: true, age: true, location: true,
        baseCompensation: true, agreesToTwins: true, agreesToAbortion: true,
        agreesToSelectiveReduction: true, openToSameSexCouple: true,
        agreesToInternationalParents: true,
        isExperienced: true, ethnicity: true, race: true, liveBirths: true,
        photoUrl: true, religion: true, bmi: true,
        cSections: true, miscarriages: true, covidVaccinated: true, lastDeliveryYear: true, sponsoredUntil: true,
      };
      const surrogateSelectCols = `id, "providerId", "firstName", "externalId", age, location, "baseCompensation", "agreesToTwins", "agreesToAbortion", "agreesToSelectiveReduction", "openToSameSexCouple", "agreesToInternationalParents", "isExperienced", ethnicity, race, "liveBirths", "photoUrl", religion, bmi, "cSections", miscarriages, "covidVaccinated", "lastDeliveryYear", "sponsoredUntil"`;

      // Base WHERE: medical/legal hard limits only (age, BMI, c-sections, miscarriages, max compensation).
      // Preferences that can be relaxed for "close match" presentation are added as softFilters below.
      // AI concierge ONLY recommends bookable inventory: AVAILABLE (ready now)
      // or PENDING (not yet approved but coming back). MATCHED is committed to
      // another parent so we never surface it; INACTIVE is soft-deleted.
      const baseWhere: any = { hiddenFromSearch: { not: true }, status: { in: ["AVAILABLE", "PENDING"] } };
      if (excludeSet.size > 0) baseWhere.id = { notIn: Array.from(excludeSet) };
      if (openToSameSexCouple !== undefined) baseWhere.openToSameSexCouple = openToSameSexCouple;
      if (openToInternationalParents === true) {
        baseWhere.OR = [
          { agreesToInternationalParents: true },
          { agreesToInternationalParents: null },
        ];
      }
      if (isExperienced !== undefined) baseWhere.isExperienced = isExperienced;
      if (maxCompensation) baseWhere.baseCompensation = { lte: maxCompensation };
      if (maxAge != null || minAge != null) {
        baseWhere.age = {};
        if (maxAge != null) baseWhere.age.lte = Number(maxAge);
        if (minAge != null) baseWhere.age.gte = Number(minAge);
      }
      if (maxBmi != null) baseWhere.bmi = { lte: Number(maxBmi) };
      if (maxCsections != null) baseWhere.cSections = { lte: Number(maxCsections) };
      if (maxMiscarriages != null) baseWhere.miscarriages = { lte: Number(maxMiscarriages) };

      // Apply IVF clinic surrogate requirements as hard filters (clinic requirements always win)
      if (clinicSurrogateReqs) {
        const c = clinicSurrogateReqs;
        if (c.ivfSurrogateMinAge != null || c.ivfSurrogateMaxAge != null) {
          baseWhere.age = {
            ...(baseWhere.age || {}),
            ...(c.ivfSurrogateMinAge != null ? { gte: Math.max(c.ivfSurrogateMinAge, baseWhere.age?.gte ?? 0) } : {}),
            ...(c.ivfSurrogateMaxAge != null ? { lte: Math.min(c.ivfSurrogateMaxAge, baseWhere.age?.lte ?? 999) } : {}),
          };
        }
        if (c.ivfSurrogateMinBmi != null || c.ivfSurrogateMaxBmi != null) {
          const existingLte = baseWhere.bmi?.lte ?? 999;
          baseWhere.bmi = {
            ...(c.ivfSurrogateMinBmi != null ? { gte: c.ivfSurrogateMinBmi } : {}),
            ...(c.ivfSurrogateMaxBmi != null ? { lte: Math.min(c.ivfSurrogateMaxBmi, existingLte) } : {}),
          };
        }
        if (c.ivfSurrogateMaxCSections != null) {
          const existing = baseWhere.cSections?.lte ?? 999;
          baseWhere.cSections = { lte: Math.min(c.ivfSurrogateMaxCSections, existing) };
        }
        if (c.ivfSurrogateMaxMiscarriages != null) {
          const existing = baseWhere.miscarriages?.lte ?? 999;
          baseWhere.miscarriages = { lte: Math.min(c.ivfSurrogateMaxMiscarriages, existing) };
        }
        if (c.ivfSurrogateMaxDeliveries != null) {
          baseWhere.liveBirths = { lte: c.ivfSurrogateMaxDeliveries };
        }
        if (c.ivfSurrogateCovidVaccination === true) {
          baseWhere.covidVaccinated = true;
        }
      }

      // Soft filters: relaxed one-at-a-time if no full-match results.
      // Order is "most expendable first": covid → ethnicity → location → twins → abortion.
      // Twins and abortion are LAST so they're only relaxed as a final fallback to avoid
      // returning empty results. The relaxedFilter label is reported back so the AI can be
      // transparent ("I couldn't find a pro-life surrogate, but here's a close match...").
      const softFilters: SoftFilter[] = [];
      if (requireCovidVaccinated === true) softFilters.push({
        label: "covid vaccinated",
        applyToWhere: (w) => { w.covidVaccinated = true; },
      });
      if (ethnicity) softFilters.push({
        label: `${ethnicity} ethnicity`,
        applyToWhere: (w) => { Object.assign(w, buildEthnicityWhere(ethnicityTerms)); },
      });
      if (location) softFilters.push({
        label: `location (${location})`,
        applyToWhere: (w) => { Object.assign(w, buildLocationWhere(location)); },
      });
      if (agreesToTwins !== undefined) softFilters.push({
        label: agreesToTwins ? "agrees to twins" : "singleton only (no twins)",
        applyToWhere: (w) => { w.agreesToTwins = agreesToTwins; },
      });
      if (agreesToAbortion !== undefined) softFilters.push({
        label: agreesToAbortion ? "pro-choice (agrees to termination)" : "pro-life (does not agree to termination)",
        applyToWhere: (w) => { w.agreesToAbortion = agreesToAbortion; },
      });

      const { candidates, relaxedFilter: surrogateRelaxedFilter } = await searchWithFallback(
        (w) => prisma.surrogate.findMany({ where: w, orderBy: [{ sponsoredUntil: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }], take: take * 8, select: surrogateSelect }),
        baseWhere, softFilters,
        (cands, relaxedLabel) => {
          // Skip ethnicityPostFilter when ethnicity itself was the relaxed criterion
          if (ethnicityTerms.length > 0 && !relaxedLabel?.includes("ethnicity")) {
            return ethnicityPostFilter(cands, ethnicityTerms);
          }
          return cands;
        },
      );

      // Score every candidate against ALL requested criteria: BMI, age, experience, c-sections,
      // miscarriages, last delivery recency, covid vaccination, ethnicity, location
      const scoredCandidates = candidates.map((s: any) => {
        const { matchScore, unmatchedCriteria } = scoreSurrogateMatch(s, {
          ethnicityTerms, maxAge, minAge, maxBmi, location,
          requireCovidVaccinated: requireCovidVaccinated === true ? true : undefined,
        });
        return { ...s, matchScore, unmatchedCriteria };
      });
      scoredCandidates.sort((a: any, b: any) => b.matchScore - a.matchScore);

      let surrogates: any[];
      if (scoredCandidates.length === 0) {
        surrogates = [];
      } else if (!query) {
        surrogates = scoredCandidates.slice(0, take);
      } else {
        const topPool = scoredCandidates.slice(0, Math.max(take * 4, 20));
        const queryText = ["surrogate carrier", query].join(", ");
        const ranked = await vectorSearchByIds("Surrogate", topPool.map((s: any) => s.id), queryText, take, surrogateSelectCols);
        if (ranked) {
          surrogates = ranked.map((r: any) => {
            const sc = topPool.find((c: any) => c.id === r.id);
            return sc ? { ...r, matchScore: sc.matchScore, unmatchedCriteria: sc.unmatchedCriteria } : r;
          });
        } else {
          surrogates = topPool.slice(0, take);
        }
      }

      // Agency-level matching requirements: filter surrogates from agencies that exclude the parent
      if (parentCountry || agreesToTwins !== undefined) {
        const providerIds = [...new Set(surrogates.map((s: any) => s.providerId).filter(Boolean))];
        if (providerIds.length > 0) {
          const agencies = await prisma.provider.findMany({
            where: { id: { in: providerIds } },
            select: {
              id: true,
              surrogacyCitizensNotAllowed: true,
              surrogacyTwinsAllowed: true,
            },
          });
          const agencyMap = new Map(agencies.map((a: any) => [a.id, a]));
          surrogates = surrogates.filter((s: any) => {
            const agency = agencyMap.get(s.providerId);
            if (!agency) return true;
            // Citizens not allowed: if the agency explicitly excludes the parent's country, skip it
            if (parentCountry && Array.isArray(agency.surrogacyCitizensNotAllowed) && agency.surrogacyCitizensNotAllowed.length > 0) {
              const notAllowedLower = (agency.surrogacyCitizensNotAllowed as string[]).map((c: string) => c.toLowerCase());
              if (notAllowedLower.includes(parentCountry.toLowerCase())) return false;
            }
            // Twins: if parent wants twins and agency does not allow it, skip it
            if (agreesToTwins === true && agency.surrogacyTwinsAllowed === false) return false;
            return true;
          });
        }
      }

      const surrogateIds = surrogates.map((s: any) => s.id);
      const profileRows = surrogateIds.length > 0
        ? await prisma.surrogate.findMany({
            where: { id: { in: surrogateIds } },
            select: { id: true, profileData: true },
          })
        : [];
      const profileMap = Object.fromEntries(profileRows.map((r: any) => [r.id, r.profileData]));

      const results = surrogates.map((s: any) => {
        const pd = profileMap[s.id];
        const sections = pd?._sections || {};
        const supportSystem = sections["Support System"] || null;
        const surrogacyDetails = sections["Surrogacy Details"] || sections["Surrogacy"] || null;
        const pregnancyHistory = sections["Pregnancy History"] || null;
        const letterToIPs = sections["Letter to Intended Parents"] || null;

        const profileHighlights: Record<string, any> = {};
        if (supportSystem && typeof supportSystem === "object") {
          profileHighlights.supportSystem = supportSystem;
        }
        if (surrogacyDetails && typeof surrogacyDetails === "object") {
          const motivation = Object.entries(surrogacyDetails as Record<string, any>)
            .filter(([k]) => /motivation|why.*surrogate|decision.*become/i.test(k))
            .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {} as Record<string, any>);
          if (Object.keys(motivation).length > 0) profileHighlights.motivation = motivation;
        }
        if (pregnancyHistory && typeof pregnancyHistory === "object") {
          profileHighlights.pregnancyHistory = pregnancyHistory;
        }
        if (letterToIPs) {
          const letterText = typeof letterToIPs === "string" ? letterToIPs
            : typeof letterToIPs === "object" && letterToIPs._letterText ? letterToIPs._letterText
            : null;
          if (letterText && typeof letterText === "string") {
            profileHighlights.letterExcerpt = letterText.slice(0, 300) + (letterText.length > 300 ? "..." : "");
          }
        }

        const { photoUrl: _photoUrl, matchScore: _ms, unmatchedCriteria: _uc, sponsoredUntil, ...sRest } = s;
        return {
          ...sRest,
          displayName: s.firstName || (cleanExternalId(s.externalId) ? `Surrogate #${cleanExternalId(s.externalId)}` : `Surrogate #${s.id.slice(-4)}`),
          baseCompensation: s.baseCompensation ? Number(s.baseCompensation) : null,
          matchScore: s.matchScore ?? 1.0,
          unmatchedCriteria: s.unmatchedCriteria ?? [],
          sponsored: !!sponsoredUntil && new Date(sponsoredUntil).getTime() > Date.now(),
          ...(Object.keys(profileHighlights).length > 0 ? { profileHighlights } : {}),
        };
      });

      return {
        content: [{ type: "text", text: `Found ${results.length} surrogates:\n${JSON.stringify(results, null, 2)}\n\nIMPORTANT: Use the "id" field as "providerId" and set type to "Surrogate" in your MATCH_CARDs. Use the "displayName" as the name. Use the "profileHighlights" (supportSystem, motivation, pregnancyHistory, letterExcerpt) to write a warm, personalized introduction. ALWAYS mention the support system if available. Results are sorted by matchScore (lowest BMI = healthiest, most experience, youngest age within range). If unmatchedCriteria is non-empty, tell the parent which criteria differ before showing the MATCH_CARD.${surrogateRelaxedFilter ? ` NOTE: No 100% match found. Search broadened by relaxing "${surrogateRelaxedFilter}" - clearly inform the parent.` : ""}${clinicRequirementsNote}` }],
      };
    }

    if (name === "get_surrogate_profile") {
      const { surrogateId, externalId } = args as any;
      if (!surrogateId && !externalId) {
        return { content: [{ type: "text", text: "Error: Provide either surrogateId (UUID) or externalId (number like '19331')." }] };
      }

      const where: any = {};
      if (surrogateId) where.id = surrogateId;
      else if (externalId) where.externalId = externalId;

      const surrogate = await prisma.surrogate.findFirst({
        where,
        select: {
          id: true, providerId: true, externalId: true, firstName: true, age: true,
          location: true, baseCompensation: true, agreesToTwins: true, agreesToAbortion: true,
          agreesToSelectiveReduction: true, openToSameSexCouple: true,
          isExperienced: true, ethnicity: true, race: true, liveBirths: true,
          photoUrl: true, religion: true, profileData: true,
        },
      });

      if (!surrogate) {
        return { content: [{ type: "text", text: `No surrogate found with ${surrogateId ? 'ID ' + surrogateId : 'external ID ' + externalId}.` }] };
      }

      const pd = (surrogate as any).profileData;
      const sections = pd?._sections || {};

      const profileSections: Record<string, any> = {};
      const skipSections = new Set(["Photos"]);
      for (const [sectionName, sectionData] of Object.entries(sections)) {
        if (skipSections.has(sectionName) || !sectionData) continue;
        profileSections[sectionName] = sectionData;
      }

      const topLevelData: Record<string, any> = {};
      if (pd && typeof pd === "object") {
        for (const [key, value] of Object.entries(pd)) {
          if (key === "_sections" || key === "Photos" || key === "SKIP") continue;
          if (value !== undefined && value !== null && value !== "") {
            topLevelData[key] = value;
          }
        }
      }

      const { profileData, ...surrogateBasic } = surrogate as any;
      const result = {
        ...surrogateBasic,
        displayName: surrogateBasic.firstName || (cleanExternalId(surrogateBasic.externalId) ? `Surrogate #${cleanExternalId(surrogateBasic.externalId)}` : `Surrogate`),
        baseCompensation: surrogateBasic.baseCompensation ? Number(surrogateBasic.baseCompensation) : null,
        profileSections,
        additionalDetails: topLevelData,
      };

      return {
        content: [{ type: "text", text: `Full profile for ${result.displayName}:\n${JSON.stringify(result, null, 2)}\n\nThis profile contains COMPLETE data including pregnancy history (birth weights, delivery types, gestational ages), health info, support system, and more. Use this data to answer the parent's questions DIRECTLY - do NOT whisper unless the specific answer is truly not in this profile.` }],
      };
    }

    if (name === "get_egg_donor_profile") {
      const { donorId, externalId } = args as any;
      if (!donorId && !externalId) {
        return { content: [{ type: "text", text: "Error: Provide either donorId (UUID) or externalId (e.g. 'S19907' or '19722')." }] };
      }

      const where: any = {};
      if (donorId) where.id = donorId;
      else if (externalId) where.externalId = externalId;

      const donor = await prisma.eggDonor.findFirst({
        where,
        select: {
          id: true, providerId: true, externalId: true, firstName: true, age: true,
          location: true, donorType: true, eyeColor: true, hairColor: true,
          height: true, weight: true, ethnicity: true, race: true, religion: true,
          education: true, occupation: true, relationshipStatus: true, bloodType: true,
          donorCompensation: true, eggLotCost: true, totalCost: true, numberOfEggs: true,
          isExperienced: true, photoUrl: true, donationTypes: true,
          profileData: true,
        },
      });

      if (!donor) {
        return { content: [{ type: "text", text: `No egg donor found with ${donorId ? 'ID ' + donorId : 'external ID ' + externalId}.` }] };
      }

      const pd = (donor as any).profileData;
      const sections = pd?._sections || {};

      const profileSections: Record<string, any> = {};
      const skipSections = new Set(["Photos"]);
      for (const [sectionName, sectionData] of Object.entries(sections)) {
        if (skipSections.has(sectionName) || !sectionData) continue;
        profileSections[sectionName] = sectionData;
      }

      const topLevelData: Record<string, any> = {};
      if (pd && typeof pd === "object") {
        for (const [key, value] of Object.entries(pd)) {
          if (key === "_sections" || key === "Photos" || key === "SKIP") continue;
          if (value !== undefined && value !== null && value !== "") {
            topLevelData[key] = value;
          }
        }
      }

      const { profileData, ...donorBasic } = donor as any;
      const result = {
        ...donorBasic,
        displayName: donorBasic.firstName || (cleanExternalId(donorBasic.externalId) ? `Donor #${cleanExternalId(donorBasic.externalId)}` : `Donor`),
        profileSections,
        additionalDetails: topLevelData,
      };

      return {
        content: [{ type: "text", text: `Full profile for ${result.displayName}:\n${JSON.stringify(result, null, 2)}\n\nThis profile contains COMPLETE data including physical traits, health history, family medical history, education, personality, hobbies, and more. Use this data to answer the parent's questions DIRECTLY - do NOT whisper unless the specific answer is truly not in this profile.` }],
      };
    }

    if (name === "search_egg_donors") {
      const { query, eyeColor, hairColor, ethnicity, minHeightInches, maxAge, education, isExperienced, donationType, location, limit: rawLimit, excludeIds } = args as any;
      const take = Math.min(rawLimit || 3, 5);
      const excludeSet = new Set<string>(Array.isArray(excludeIds) ? excludeIds : []);
      const ethnicityTerms = ethnicity ? resolveEthnicityTerms(ethnicity) : [];

      const eggDonorSelect = {
        id: true, providerId: true, externalId: true, firstName: true, age: true, location: true,
        eyeColor: true, hairColor: true, height: true, weight: true,
        ethnicity: true, race: true, education: true,
        donorCompensation: true, eggLotCost: true, totalCost: true,
        isExperienced: true, photoUrl: true, numberOfEggs: true, sponsoredUntil: true,
      };
      const eggDonorSelectCols = `id, "providerId", "firstName", "externalId", age, location, "eyeColor", "hairColor", height, weight, ethnicity, race, education, "donorCompensation", "eggLotCost", "totalCost", "isExperienced", "photoUrl", "numberOfEggs", "sponsoredUntil"`;

      // Base WHERE: absolute requirements that are NEVER relaxed.
      // age and height are medical/physical absolutes; isExperienced and donationType are functional.
      // Bookability rule: surface a donor if there's ANY purchasable path -
      // fresh-cycle status is AVAILABLE/PENDING (Fresh Donor + Fresh & Frozen)
      // OR frozenLotStatus = AVAILABLE (Frozen Eggs + Fresh & Frozen). A
      // "Fresh & Frozen" donor whose fresh is MATCHED but whose frozen
      // lot is AVAILABLE is still bookable via frozen eggs, so we surface
      // her. INACTIVE is soft-deleted and always excluded.
      const baseWhere: any = {
        hiddenFromSearch: { not: true },
        OR: [
          { status: { in: ["AVAILABLE", "PENDING"] } },
          { frozenLotStatus: "AVAILABLE" },
        ],
        NOT: { status: "INACTIVE" },
      };
      if (excludeSet.size > 0) baseWhere.id = { notIn: Array.from(excludeSet) };
      if (maxAge) baseWhere.age = { lte: maxAge };
      if (isExperienced) baseWhere.isExperienced = true;
      if (donationType) baseWhere.donationTypes = { contains: donationType, mode: "insensitive" };

      // Soft filters: ALL parent-requested visual/preference criteria, tried as hard filters first.
      // If Phase 1 returns zero results, relaxed one-at-a-time (most expendable first):
      //   eye color → hair color → education → location → ethnicity (genetic, last resort)
      const softFilters: SoftFilter[] = [];
      if (eyeColor) softFilters.push({ label: `${eyeColor} eye color`, applyToWhere: (w) => { w.eyeColor = { contains: eyeColor, mode: "insensitive" }; } });
      if (hairColor) softFilters.push({ label: `${hairColor} hair color`, applyToWhere: (w) => { w.hairColor = { contains: normalizeHairColor(hairColor), mode: "insensitive" }; } });
      if (education) softFilters.push({ label: `${education} education`, applyToWhere: (w) => { w.education = { contains: education, mode: "insensitive" }; } });
      if (location) softFilters.push({ label: `${location} location`, applyToWhere: (w) => { Object.assign(w, buildLocationWhere(location)); } });
      if (ethnicity) softFilters.push({ label: `${ethnicity} ethnicity`, applyToWhere: (w) => { Object.assign(w, buildEthnicityWhere(ethnicityTerms)); } });

      // postFilter receives the relaxed criterion label so it can skip ethnicityPostFilter when
      // ethnicity itself was relaxed (otherwise we'd filter out the donors we just fetched broadly).
      const postFilter = (cands: any[], relaxedLabel: string | null) => {
        let out = cands;
        if (minHeightInches) out = out.filter((d: any) => { const h = parseHeightToInches(d.height); return h === 0 || h >= minHeightInches; });
        const ethnicityWasRelaxed = relaxedLabel?.includes("ethnicity");
        if (ethnicityTerms.length > 0 && !ethnicityWasRelaxed) out = ethnicityPostFilter(out, ethnicityTerms);
        return out;
      };

      const { candidates, relaxedFilter } = await searchWithFallback(
        (w) => prisma.eggDonor.findMany({ where: w, orderBy: [{ sponsoredUntil: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }], take: 200, select: eggDonorSelect }),
        baseWhere, softFilters, postFilter,
      );

      // Score every candidate against ALL requested criteria, sort best first
      const scoredCandidates = candidates.map((d: any) => {
        const { matchScore, unmatchedCriteria } = scoreDonorMatch(d, { ethnicityTerms, eyeColor, hairColor, education, location, maxAge, minHeightInches });
        return { ...d, matchScore, unmatchedCriteria };
      });
      scoredCandidates.sort((a: any, b: any) => b.matchScore - a.matchScore);

      let donors: any[];
      if (scoredCandidates.length === 0) {
        donors = [];
      } else if (!query) {
        donors = scoredCandidates.slice(0, take);
      } else {
        const topPool = scoredCandidates.slice(0, Math.max(take * 4, 20));
        const queryText = ["egg donor", query].join(", ");
        const ranked = await vectorSearchByIds("EggDonor", topPool.map((d: any) => d.id), queryText, take, eggDonorSelectCols);
        if (ranked) {
          donors = ranked.map((r: any) => {
            const s = topPool.find((c: any) => c.id === r.id);
            return s ? { ...r, matchScore: s.matchScore, unmatchedCriteria: s.unmatchedCriteria } : r;
          });
        } else {
          donors = topPool.slice(0, take);
        }
      }

      const results = donors.map((d: any) => {
        const { photoUrl: _p, sponsoredUntil, ...dRest } = d;
        return {
          ...dRest,
          displayName: d.firstName || (cleanExternalId(d.externalId) ? `Donor #${cleanExternalId(d.externalId)}` : `Donor #${d.id.slice(-4)}`),
          matchScore: d.matchScore ?? 1.0,
          unmatchedCriteria: d.unmatchedCriteria ?? [],
          sponsored: !!sponsoredUntil && new Date(sponsoredUntil).getTime() > Date.now(),
        };
      });

      const relaxedNote = relaxedFilter ? ` NOTE: No 100% match found. Search was broadened by relaxing "${relaxedFilter}" - present the best available result and clearly tell the parent which property differs from their request.` : "";
      return {
        content: [{ type: "text", text: `Found ${results.length} egg donors:\n${JSON.stringify(results, null, 2)}\n\nIMPORTANT: Use the "id" field as "providerId" and set type to "Egg Donor" in your MATCH_CARDs. Use the "displayName" as the name. Results sorted by matchScore (1.0 = all criteria matched). If unmatchedCriteria is non-empty, tell the parent which criteria differ before showing the MATCH_CARD.${relaxedNote}` }],
      };
    }

    if (name === "search_sperm_donors") {
      const { query, eyeColor, hairColor, ethnicity, minHeightInches, maxAge, education, height, location, limit: rawLimit, excludeIds } = args as any;
      const take = Math.min(rawLimit || 3, 5);
      const excludeSet = new Set<string>(Array.isArray(excludeIds) ? excludeIds : []);
      const ethnicityTerms = ethnicity ? resolveEthnicityTerms(ethnicity) : [];

      const spermDonorSelect = {
        id: true, providerId: true, externalId: true, firstName: true, age: true, location: true,
        eyeColor: true, hairColor: true, height: true, weight: true,
        ethnicity: true, race: true, education: true, donorType: true, vialTypes: true,
        compensation: true, iciCost: true, iuiCost: true, ivfCost: true, totalCost: true, isExperienced: true, photoUrl: true, sponsoredUntil: true,
      };
      const spermDonorSelectCols = `id, "providerId", "firstName", "externalId", age, location, "eyeColor", "hairColor", height, weight, ethnicity, race, education, compensation, "iciCost", "iuiCost", "ivfCost", "totalCost", "isExperienced", "photoUrl", "sponsoredUntil"`;

      // Base WHERE: absolute requirements never relaxed.
      // Sperm donors only have AVAILABLE | SOLD_OUT | INACTIVE. AI concierge
      // recommends AVAILABLE only - SOLD_OUT means no vials in stock (not
      // bookable), INACTIVE is soft-deleted. PENDING / MATCHED don't apply
      // to sperm (those are egg-donor / surrogate states).
      const baseWhere: any = { hiddenFromSearch: { not: true }, status: "AVAILABLE" };
      if (excludeSet.size > 0) baseWhere.id = { notIn: Array.from(excludeSet) };
      if (maxAge) baseWhere.age = { lte: maxAge };
      if (height) baseWhere.height = { contains: height, mode: "insensitive" };

      // Soft filters: all parent-requested preferences, relaxed one-at-a-time if needed
      // Order: eye color → hair color → education → location → ethnicity (most to least expendable)
      const softFilters: SoftFilter[] = [];
      if (eyeColor) softFilters.push({ label: `${eyeColor} eye color`, applyToWhere: (w) => { w.eyeColor = { contains: eyeColor, mode: "insensitive" }; } });
      if (hairColor) softFilters.push({ label: `${hairColor} hair color`, applyToWhere: (w) => { w.hairColor = { contains: normalizeHairColor(hairColor), mode: "insensitive" }; } });
      if (education) softFilters.push({ label: `${education} education`, applyToWhere: (w) => { w.education = { contains: education, mode: "insensitive" }; } });
      if (location) softFilters.push({ label: `${location} location`, applyToWhere: (w) => { Object.assign(w, buildLocationWhere(location)); } });
      if (ethnicity) softFilters.push({ label: `${ethnicity} ethnicity`, applyToWhere: (w) => { Object.assign(w, buildEthnicityWhere(ethnicityTerms)); } });

      const postFilter = (cands: any[], relaxedLabel: string | null) => {
        let out = cands;
        if (minHeightInches) out = out.filter((d: any) => { const h = parseHeightToInches(d.height); return h === 0 || h >= minHeightInches; });
        if (ethnicityTerms.length > 0 && !relaxedLabel?.includes("ethnicity")) out = ethnicityPostFilter(out, ethnicityTerms);
        return out;
      };

      const { candidates, relaxedFilter } = await searchWithFallback(
        (w) => prisma.spermDonor.findMany({ where: w, orderBy: [{ sponsoredUntil: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }], take: 200, select: spermDonorSelect }),
        baseWhere, softFilters, postFilter,
      );

      const scoredCandidates = candidates.map((d: any) => {
        const { matchScore, unmatchedCriteria } = scoreDonorMatch(d, { ethnicityTerms, eyeColor, hairColor, education, location, maxAge, minHeightInches });
        return { ...d, matchScore, unmatchedCriteria };
      });
      scoredCandidates.sort((a: any, b: any) => b.matchScore - a.matchScore);

      let donors: any[];
      if (scoredCandidates.length === 0) {
        donors = [];
      } else if (!query) {
        donors = scoredCandidates.slice(0, take);
      } else {
        const topPool = scoredCandidates.slice(0, Math.max(take * 4, 20));
        const queryText = ["sperm donor", query].join(", ");
        const ranked = await vectorSearchByIds("SpermDonor", topPool.map((d: any) => d.id), queryText, take, spermDonorSelectCols);
        if (ranked) {
          donors = ranked.map((r: any) => {
            const s = topPool.find((c: any) => c.id === r.id);
            return s ? { ...r, matchScore: s.matchScore, unmatchedCriteria: s.unmatchedCriteria } : r;
          });
        } else {
          donors = topPool.slice(0, take);
        }
      }

      const results = donors.map((d: any) => {
        const { photoUrl: _p, sponsoredUntil, ...dRest } = d;
        return {
          ...dRest,
          displayName: d.firstName || (cleanExternalId(d.externalId) ? `Donor #${cleanExternalId(d.externalId)}` : `Donor #${d.id.slice(-4)}`),
          matchScore: d.matchScore ?? 1.0,
          unmatchedCriteria: d.unmatchedCriteria ?? [],
          sponsored: !!sponsoredUntil && new Date(sponsoredUntil).getTime() > Date.now(),
        };
      });

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No sperm donors currently available matching those criteria. Inform the parent that GoStork is actively building its sperm donor network and suggest they check back soon, or offer to broaden the search." }],
        };
      }

      const relaxedNote = relaxedFilter ? ` NOTE: No 100% match found. Search broadened by relaxing "${relaxedFilter}" - present the best available result and clearly tell the parent which property differs.` : "";
      return {
        content: [{ type: "text", text: `Found ${results.length} sperm donors:\n${JSON.stringify(results, null, 2)}\n\nIMPORTANT: Use the "id" field as "providerId" and set type to "Sperm Donor" in your MATCH_CARDs. Use the "displayName" as the name. Results sorted by matchScore (1.0 = all criteria matched). If unmatchedCriteria is non-empty, tell the parent which criteria differ before showing the MATCH_CARD.${relaxedNote}` }],
      };
    }

    if (name === "search_clinics") {
      const { query, location: clinicLocation, state, city, name: clinicName, limit: rawLimit, minSuccessRate, excludeIds, ageGroup, eggSource, isNewPatient, wantsTwins, wantsEmbryoTransfer, parentAge1, parentAge2, patientType } = args as any;
      const excludeSet = new Set<string>(Array.isArray(excludeIds) ? excludeIds : []);
      const targetAgeGroup = ageGroup || "under_35";
      const targetEggSource = eggSource || "own_eggs";
      const take = Math.min(rawLimit || 5, 10);
      const clinicSelect = {
        id: true, name: true, logoUrl: true, about: true, sponsoredUntil: true,
        locations: { select: { city: true, state: true, address: true }, orderBy: { sortOrder: "asc" as const } },
        members: { select: { name: true, title: true, bio: true, isMedicalDirector: true }, orderBy: { sortOrder: "asc" as const }, take: 10 },
        ivfSuccessRates: {
          where: { metricCode: { in: ["pct_new_patients_live_birth_after_1_retrieval", "pct_intended_retrievals_live_births", "pct_transfers_live_births_donor"] } },
          select: { successRate: true, nationalAverage: true, ageGroup: true, isNewPatient: true, metricCode: true, top10pct: true, cycleCount: true, profileType: true },
        },
        ivfTwinsAllowed: true,
        ivfTransferFromOtherClinics: true,
        ivfMaxAgeIp1: true,
        ivfMaxAgeIp2: true,
        ivfAcceptingPatients: true,
      };

      let clinics: any[];

      // When location is specified, use direct DB query (vector search doesn't know about ProviderLocation)
      const hasLocationFilter = !!(clinicLocation || city || state);

      if (!hasLocationFilter && !clinicName) {
        // Generic search - use vector search
        const queryParts: string[] = ["IVF clinic fertility center"];
        if (query) queryParts.push(query);
        const queryText = queryParts.join(", ");

        const ivfClinicTypeCheck = `EXISTS (SELECT 1 FROM "ProviderService" ps JOIN "ProviderType" pt ON pt.id = ps."providerTypeId" WHERE ps."providerId" = "Provider".id AND pt.name = 'IVF Clinic' AND ps.status = 'APPROVED')`;
        const vectorResults = await vectorSearch(
          "Provider", queryText, take,
          ivfClinicTypeCheck,
          `"Provider".id, "Provider".name, "Provider"."logoUrl", "Provider".about`,
        );

        if (vectorResults && vectorResults.length > 0) {
          const ids = vectorResults.map((r: any) => r.id).filter((id: string) => !excludeSet.has(id));
          const withDetails = await prisma.provider.findMany({
            where: { id: { in: ids } },
            select: clinicSelect,
          });
          const detailMap = new Map(withDetails.map((c: any) => [c.id, c]));
          clinics = ids.map((id: string) => detailMap.get(id)).filter(Boolean);
        } else {
          clinics = [];
        }
      } else {
        const providerWhere: any = {
          services: {
            some: { providerType: { name: "IVF Clinic" }, status: "APPROVED" },
          },
        };
        if (excludeSet.size > 0) providerWhere.id = { notIn: Array.from(excludeSet) };
        if (clinicName) {
          const nameTerms = clinicName.trim().split(/[\s\-_]+/).filter(Boolean);
          if (nameTerms.length > 1) {
            providerWhere.AND = nameTerms.map((term: string) => ({ name: { contains: term, mode: "insensitive" } }));
          } else {
            providerWhere.name = { contains: clinicName.trim(), mode: "insensitive" };
          }
        }

        // unified location param takes priority; fall back to separate state/city
        if (clinicLocation) {
          providerWhere.locations = buildClinicLocationWhere(clinicLocation);
        } else if (state || city) {
          const terms = state ? resolveLocationTerms(state) : [];
          const stateConditions = terms.flatMap(t => [
            { state: { contains: t, mode: "insensitive" as const } },
          ]);
          const cityCondition = city ? [{ city: { contains: city, mode: "insensitive" as const } }] : [];
          providerWhere.locations = { some: { OR: [...stateConditions, ...cityCondition] } };
        }

        clinics = await prisma.provider.findMany({
          where: providerWhere,
          orderBy: { name: "asc" },
          take: 50, // fetch all matching clinics so we can sort by success rate and pick the best
          select: clinicSelect,
        });

        if (clinics.length === 0 && (state || city || clinicName)) {
          const fallbackWhere: any = {
            services: {
              some: { providerType: { name: "IVF Clinic" }, status: "APPROVED" },
            },
          };
          if (excludeSet.size > 0) fallbackWhere.id = { notIn: Array.from(excludeSet) };
          clinics = await prisma.provider.findMany({
            where: fallbackWhere,
            orderBy: { name: "asc" },
            take,
            select: clinicSelect,
          });
        }
      }

      // Apply matching requirement filters
      const excludedByRequirements: string[] = [];
      clinics = clinics.filter((c: any) => {
        // Twins: if parent wants twins and clinic does not allow it, exclude
        if (wantsTwins === true && c.ivfTwinsAllowed === false) {
          excludedByRequirements.push(`${c.name} (does not allow twins)`);
          return false;
        }
        // Embryo transfer: if parent wants to transfer embryos from another clinic and clinic doesn't allow it, exclude
        if (wantsEmbryoTransfer === true && c.ivfTransferFromOtherClinics === false) {
          excludedByRequirements.push(`${c.name} (does not accept embryo transfers from other clinics)`);
          return false;
        }
        // IP1 max age: if clinic has a max age for IP1 and parent exceeds it, exclude
        if (parentAge1 != null && c.ivfMaxAgeIp1 != null && parentAge1 > c.ivfMaxAgeIp1) {
          excludedByRequirements.push(`${c.name} (max age for IP1 is ${c.ivfMaxAgeIp1})`);
          return false;
        }
        // IP2 max age: if clinic has a max age for IP2 and parent exceeds it, exclude
        if (parentAge2 != null && c.ivfMaxAgeIp2 != null && parentAge2 > c.ivfMaxAgeIp2) {
          excludedByRequirements.push(`${c.name} (max age for IP2 is ${c.ivfMaxAgeIp2})`);
          return false;
        }
        // Patient type: if clinic has a restricted accepting list and parent type is not in it, exclude
        if (patientType && Array.isArray(c.ivfAcceptingPatients) && c.ivfAcceptingPatients.length > 0) {
          if (!c.ivfAcceptingPatients.includes(patientType)) {
            excludedByRequirements.push(`${c.name} (does not serve ${patientType.replace(/_/g, " ")} patients)`);
            return false;
          }
        }
        return true;
      });

      // Build rich results with locations, doctors, and success rates
      let results = clinics.map((c: any) => {
        const locations = (c.locations || []).map((l: any) => [l.city, l.state].filter(Boolean).join(", ")).filter(Boolean);
        const doctors = (c.members || []).map((m: any) => ({
          name: m.name,
          title: m.title || null,
          isMedicalDirector: m.isMedicalDirector,
        }));

        // Pick the primary success rate based on parent's age group and egg source.
        // Uses the shared helper so doctor cards surface the identical rate.
        const sr = computeClinicSuccessRate(c.ivfSuccessRates, {
          eggSource: targetEggSource as EggSource,
          ageGroup: targetAgeGroup as AgeGroup,
          isNewPatient,
        });

        return {
          id: c.id,
          name: c.name,
          logoUrl: c.logoUrl,
          about: c.about ? c.about.slice(0, 200) : null,
          locations,
          doctors: doctors.slice(0, 5),
          successRate: sr.successRate,
          successRateLabel: sr.successRateLabel,
          nationalAverage: sr.nationalAverage,
          top10pct: sr.top10pct,
          cycleCount: sr.cycleCount,
          successRatesByAge: sr.successRatesByAge,
          sponsored: !!c.sponsoredUntil && new Date(c.sponsoredUntil).getTime() > Date.now(),
        };
      });

      // Sort by success rate, with sponsorship as a TIEBREAKER ONLY: among clinics
      // whose success rate rounds to the same percentage for this parent's profile
      // (i.e. an equally good fit), the sponsored one is surfaced first. Sponsorship
      // never up-ranks a clinic with a lower rate.
      results.sort((a: any, b: any) => {
        const aRate = a.successRate ? parseFloat(a.successRate) : 0;
        const bRate = b.successRate ? parseFloat(b.successRate) : 0;
        const roundDelta = Math.round(bRate) - Math.round(aRate);
        if (roundDelta !== 0) return roundDelta;
        const spDelta = (b.sponsored ? 1 : 0) - (a.sponsored ? 1 : 0);
        if (spDelta !== 0) return spDelta;
        return bRate - aRate;
      });

      // Filter by minimum success rate if requested, with fallback to top results
      let minRateNote = "";
      if (minSuccessRate && typeof minSuccessRate === "number") {
        const filtered = results.filter((r: any) => {
          const pct = r.successRate ? parseFloat(r.successRate) : 0;
          return pct >= minSuccessRate;
        });
        if (filtered.length > 0) {
          results = filtered;
        } else {
          minRateNote = `\n\nNOTE: No clinics met the ${minSuccessRate}% minimum success rate threshold for this age group and egg source. The results below are the TOP clinics sorted by success rate. Present the best available options and be transparent about the rates - do NOT say "no clinics found". Instead say something like: "The highest success rates in your area for your profile are around X%. Here's the top clinic..."`;
        }
      }

      results = results.slice(0, take);

      const ageLabel = targetAgeGroup === "under_35" ? "Under 35" : targetAgeGroup === "35_37" ? "35-37" : targetAgeGroup === "38_40" ? "38-40" : "Over 40";
      const excludedNote = excludedByRequirements.length > 0
        ? `\n\nNOTE: The following clinics were excluded because they do not meet the parent's requirements: ${excludedByRequirements.join("; ")}.`
        : "";
      return {
        content: [{ type: "text", text: `Found ${results.length} IVF clinics (success rates shown for: ${targetEggSource === "donor" ? "donor eggs" : `own eggs, age group ${ageLabel}`}${isNewPatient ? ", first-time IVF" : ""}):\n${JSON.stringify(results, null, 2)}\n\nIMPORTANT: Use the "id" field as "providerId" and set type to "Clinic" in your MATCH_CARDs. Present ONE clinic at a time. Use the "successRateLabel" to tell the parent which metric the rate represents (e.g., "For patients in your age group (${ageLabel}) using ${targetEggSource === "donor" ? "donor eggs" : "their own eggs"}, this clinic has a X% live birth rate"). Use the locations, doctors, and successRatesByAge to write a personalized blurb.${minRateNote}${excludedNote}` }],
      };
    }

    if (name === "search_doctors") {
      const a = args as any;
      const eggSource: EggSource = a.eggSource === "donor" ? "donor" : "own_eggs";
      const ageGroup: AgeGroup = (a.ageGroup as AgeGroup) || "under_35";
      const isNewPatient = a.isNewPatient === false ? false : true;
      const limit = Math.min(Math.max(Number(a.limit) || 3, 1), 5);
      const excludeSlugs: string[] = Array.isArray(a.excludeIds) ? a.excludeIds : [];

      // Public doctors with a slug, at APPROVED IVF clinics.
      const memberWhere: any = {
        isPublicProfile: true,
        slug: { not: null },
        provider: {
          services: { some: { status: "APPROVED", providerType: { name: "IVF Clinic" } } },
        },
      };
      const locationStr = a.location || a.state || a.city;
      if (locationStr) memberWhere.provider.locations = buildClinicLocationWhere(locationStr);
      if (a.specialty) memberWhere.specialties = { has: a.specialty };
      if (a.language) memberWhere.languagesSpoken = { has: a.language };
      if (a.offersVideoVisits === true) memberWhere.offersVideoVisits = true;
      if (a.acceptingNewPatients === true) memberWhere.acceptingNewPatients = true;
      if (a.providerGender) memberWhere.providerGender = { equals: a.providerGender, mode: "insensitive" };
      if (a.lgbtqFriendly === true) {
        memberWhere.provider.ivfAcceptingPatients = { has: "gay_couple" };
      }

      const memberRows = await prisma.providerMember.findMany({
        where: memberWhere,
        take: 600,
        orderBy: [{ isMedicalDirector: "desc" }, { name: "asc" }],
        select: DOCTOR_MEMBER_SELECT as any,
      });

      const searchTerms = (a.query || "").trim().toLowerCase().split(/[\s\-_]+/).filter(Boolean);
      let doctors = enrichDoctorRows(memberRows, {
        eggSource,
        ageGroup,
        isNewPatient,
        specialtyFilter: a.specialty,
        searchTerms,
      });

      // Free-text query: rank doctors whose name / specialties / clinic match the
      // query terms; keep all but sort matches first. (DB already hard-filtered
      // specialty/language/location; this orders the remaining set.)
      if (searchTerms.length) {
        const scoreDoctor = (d: any) => {
          const hay = [d.name, ...(d.specialties || []), ...(d.clinics || []).map((c: any) => c.providerName)].join(" ").toLowerCase();
          return searchTerms.reduce((acc: number, t: string) => acc + (hay.includes(t) ? 1 : 0), 0);
        };
        doctors = doctors
          .map((d) => ({ d, s: scoreDoctor(d) }))
          .sort((x, y) => y.s - x.s)
          .map((x) => x.d);
      }

      // Prefer doctors who actually have a photo (the card leads with the face),
      // then those with a known success rate, without dropping the rest.
      doctors = doctors
        .filter((d) => !excludeSlugs.includes(d.slug))
        .sort((a2, b2) => {
          const photoDelta = (b2.photoUrl ? 1 : 0) - (a2.photoUrl ? 1 : 0);
          if (photoDelta !== 0) return photoDelta;
          const rateA = a2.successRate ? parseInt(a2.successRate) : -1;
          const rateB = b2.successRate ? parseInt(b2.successRate) : -1;
          if (rateB !== rateA) return rateB - rateA;
          // Sponsorship is a TIEBREAKER ONLY: among equally-ranked doctors (same
          // photo presence + same clinic success rate), surface the sponsored one
          // first. It never up-ranks a worse-fit doctor.
          return ((b2 as any).sponsored ? 1 : 0) - ((a2 as any).sponsored ? 1 : 0);
        });

      const results = doctors.slice(0, limit);
      const ageLbl = ageGroup === "under_35" ? "Under 35" : ageGroup === "35_37" ? "35-37" : ageGroup === "38_40" ? "38-40" : "Over 40";
      return {
        content: [{ type: "text", text: `Found ${results.length} doctor(s) (clinic success rates shown for: ${eggSource === "donor" ? "donor eggs" : `own eggs, ${ageLbl}`}${isNewPatient ? ", first-time IVF" : ""}):\n${JSON.stringify(results, null, 2)}\n\nIMPORTANT: To recommend a doctor, emit a [[DOCTOR_CARD:{"slug":"<slug>","reasons":["..."]}]] tag using the "slug" field - NEVER describe a doctor in plain text without the card. Lead with the doctor (the human/face); the clinic + its success rate appear inside the card. Use "matchedSpecialties", "languagesSpoken", and the primary clinic's "successRate" to write a short, positive blurb tied to what the parent asked for.` }],
      };
    }

    if (name === "resolve_doctor_card") {
      const a = args as any;
      const eggSource: EggSource = a.eggSource === "donor" ? "donor" : "own_eggs";
      const ageGroup: AgeGroup = (a.ageGroup as AgeGroup) || "under_35";
      const isNewPatient = a.isNewPatient === false ? false : true;
      if (!a.slug) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "slug required" }) }] };
      }

      // Fetch the identity row by slug, then ALL rows for the same person (across
      // clinics) so enrichDoctorRows can build every affiliation with its rate.
      const identity = await prisma.providerMember.findFirst({
        where: { slug: a.slug, isPublicProfile: true },
        select: { id: true, personKey: true },
      });
      if (!identity) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "not found" }) }] };
      }
      const personRows = await prisma.providerMember.findMany({
        where: identity.personKey
          ? { personKey: identity.personKey }
          : { id: identity.id },
        select: DOCTOR_MEMBER_SELECT as any,
      });
      const enriched = enrichDoctorRows(personRows, { eggSource, ageGroup, isNewPatient });
      // enrichDoctorRows dedupes by personKey -> exactly one doctor here.
      const doctor = enriched.find((d) => d.slug === a.slug) || enriched[0] || null;
      if (!doctor) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "not found" }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(doctor) }] };
    }

    if (name === "resolve_match_card") {
      const { entityId, entityType, entityName } = args as any;
      const type = (entityType || "").toLowerCase();
      let result: any = null;

      if (type === "surrogate") {
        const s = await prisma.surrogate.findUnique({
          where: { id: entityId },
          select: { photoUrl: true, firstName: true, externalId: true, providerId: true, age: true, location: true },
        });
        if (s) {
          const eid = cleanExternalId(s.externalId);
          result = {
            photo: s.photoUrl || null,
            name: s.firstName || (eid ? `Surrogate #${eid}` : `Surrogate #${entityId.slice(-4)}`),
            ownerProviderId: s.providerId,
          };
        }
      } else if (type === "egg donor") {
        const d = await prisma.eggDonor.findUnique({
          where: { id: entityId },
          select: { photoUrl: true, firstName: true, externalId: true, providerId: true, age: true, location: true },
        });
        if (d) {
          const eid = cleanExternalId(d.externalId);
          result = {
            photo: d.photoUrl || null,
            name: d.firstName || (eid ? `Donor #${eid}` : `Donor #${entityId.slice(-4)}`),
            ownerProviderId: d.providerId,
          };
        }
      } else if (type === "sperm donor") {
        const d = await prisma.spermDonor.findUnique({
          where: { id: entityId },
          select: { photoUrl: true, firstName: true, externalId: true, providerId: true, age: true, location: true },
        });
        if (d) {
          const eid = cleanExternalId(d.externalId);
          result = {
            photo: d.photoUrl || null,
            name: d.firstName || (eid ? `Donor #${eid}` : `Donor #${entityId.slice(-4)}`),
            ownerProviderId: d.providerId,
          };
        }
      } else {
        const p = await prisma.provider.findUnique({
          where: { id: entityId },
          select: { logoUrl: true, name: true, id: true },
        });
        if (p) {
          result = { photo: p.logoUrl || null, name: p.name, ownerProviderId: p.id };
        }
        if (!result && entityName) {
          const pByName = await prisma.provider.findFirst({
            where: { name: { contains: entityName, mode: "insensitive" } },
            select: { logoUrl: true, name: true, id: true },
          });
          if (pByName) {
            result = { photo: pByName.logoUrl || null, name: pByName.name, ownerProviderId: pByName.id };
          }
        }
      }

      return {
        content: [{ type: "text", text: result ? JSON.stringify(result) : '{"error":"not found"}' }],
      };
    }

    if (name === "resolve_provider") {
      const { providerId, providerName } = args as any;
      let provider: any = null;

      if (providerId) {
        provider = await prisma.provider.findUnique({
          where: { id: providerId },
          select: { id: true, name: true, logoUrl: true, email: true, consultationBookingUrl: true, consultationIframeEnabled: true },
        });
      } else if (providerName) {
        provider = await prisma.provider.findFirst({
          where: { name: { contains: providerName, mode: "insensitive" } },
          select: { id: true, name: true, logoUrl: true, email: true, consultationBookingUrl: true, consultationIframeEnabled: true },
        });
      }

      return {
        content: [{ type: "text", text: provider ? JSON.stringify(provider) : '{"error":"not found"}' }],
      };
    }

    if (name === "get_parent_meetings") {
      const userId = String(args?.userId || "");
      const providerNameFilter = (args as any)?.providerName ? String((args as any).providerName).trim() : "";
      const statusFilter = ((args as any)?.status as string) || "upcoming";
      if (!userId) {
        return { content: [{ type: "text", text: '{"error":"userId required"}' }] };
      }

      // Scope to all members of the parent's shared account (mirrors
      // getParentAccountMemberIds in calendar.controller.ts) so a booking made
      // by any account member is visible.
      const me = await prisma.user.findUnique({ where: { id: userId }, select: { parentAccountId: true } });
      const memberIds = me?.parentAccountId
        ? (await prisma.user.findMany({
            where: { parentAccountId: me.parentAccountId, isDisabled: false },
            select: { id: true },
          })).map((u) => u.id)
        : [userId];

      const where: any = { parentUserId: { in: memberIds } };
      const now = new Date();
      if (statusFilter === "upcoming") {
        // Active bookings (not cancelled/rescheduled) that have not yet ended.
        // Use a 2h grace so an in-progress or just-finished call still answers.
        where.status = { notIn: ["CANCELLED", "RESCHEDULED", "EXPIRED"] };
        where.scheduledAt = { gte: new Date(now.getTime() - 2 * 60 * 60 * 1000) };
      } else if (statusFilter === "past") {
        where.scheduledAt = { lt: now };
      }

      let bookings = await prisma.booking.findMany({
        where,
        include: {
          providerUser: {
            select: {
              id: true,
              name: true,
              dailyRoomUrl: true,
              provider: { select: { id: true, name: true } },
              scheduleConfig: { select: { bookingPageSlug: true } },
            },
          },
        },
        orderBy: { scheduledAt: "asc" },
        take: 25,
      });

      if (providerNameFilter) {
        const needle = providerNameFilter.toLowerCase();
        bookings = bookings.filter((b: any) => {
          const provName = (b.providerUser?.provider?.name || "").toLowerCase();
          const userName = (b.providerUser?.name || "").toLowerCase();
          const subj = (b.subject || "").toLowerCase();
          return provName.includes(needle) || userName.includes(needle) || subj.includes(needle);
        });
      }

      const results = bookings.map((b: any) => ({
        bookingId: b.id,
        providerName: b.providerUser?.provider?.name || b.providerUser?.name || "Provider",
        contactName: b.providerUser?.name || null,
        scheduledAt: b.scheduledAt?.toISOString?.() || b.scheduledAt,
        bookerTimezone: b.bookerTimezone || null,
        duration: b.duration || 30,
        status: b.status,
        meetingType: b.meetingType || "video",
        subject: b.subject || null,
        // In-app join link, valid once the booking is CONFIRMED and is a video call.
        joinPath: b.status === "CONFIRMED" && b.meetingType !== "phone" ? `/room/${b.id}` : null,
        bookingPageSlug: b.providerUser?.scheduleConfig?.bookingPageSlug || null,
        publicToken: b.publicToken || null,
      }));

      return {
        content: [{
          type: "text",
          text: `Found ${results.length} meeting(s) for this parent${providerNameFilter ? ` matching "${providerNameFilter}"` : ""}:\n${JSON.stringify(results, null, 2)}\n\nIMPORTANT: Answer the parent's question (time, date, timezone, link, etc.) directly using these fields. Times are stored in UTC (scheduledAt) - present them in the booking's bookerTimezone when given. For EACH relevant meeting, emit a [[MEETING_CARD:<bookingId>]] tag (using the exact bookingId) so the interactive join/reschedule/cancel card renders. If the list is empty, tell the parent you don't see a scheduled meeting matching that and offer to book one - never invent a time or link.` }],
      };
    }

    if (name === "search_knowledge_base") {
      const { query: kbQuery, providerId: kbProviderId, maxResults: kbMaxResults } = args as any;
      const maxRes = kbMaxResults || 5;

      try {
        const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
        const embeddingResult = await embeddingModel.embedContent({ content: { parts: [{ text: kbQuery }], role: "user" }, outputDimensionality: 768 } as any);
        const embedding = embeddingResult.embedding.values;
        const vectorStr = `[${embedding.join(",")}]`;

        let results: any[];
        if (kbProviderId) {
          results = await pool.query(
            `SELECT content, "sourceTier", "sourceType",
                    1 - (embedding <=> $1::vector) as score
             FROM "KnowledgeChunk"
             WHERE ("providerId" = $2 AND "sourceTier" = 1)
                OR "sourceTier" IN (2, 3)
             ORDER BY embedding <=> $1::vector
             LIMIT $3`,
            [vectorStr, kbProviderId, maxRes],
          ).then(r => r.rows);
        } else {
          results = await pool.query(
            `SELECT content, "sourceTier", "sourceType",
                    1 - (embedding <=> $1::vector) as score
             FROM "KnowledgeChunk"
             WHERE "sourceTier" IN (2, 3)
             ORDER BY embedding <=> $1::vector
             LIMIT $2`,
            [vectorStr, maxRes],
          ).then(r => r.rows);
        }

        const parsed = results.map((r: any) => ({
          content: r.content,
          sourceTier: r.sourceTier,
          sourceType: r.sourceType,
          score: parseFloat(r.score),
        }));

        return {
          content: [{ type: "text", text: JSON.stringify(parsed) }],
        };
      } catch (e: any) {
        console.error("search_knowledge_base error:", e.message);
        return {
          content: [{ type: "text", text: "[]" }],
        };
      }
    }

    if (name === "get_provider_users") {
      const { providerId: puProviderId } = args as any;
      const users = await prisma.user.findMany({
        where: { providerId: puProviderId },
        select: { id: true, email: true },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(users) }],
      };
    }

    if (name === "get_cost_ranges") {
      const { serviceType } = args as any;

      let query = "";
      let label = "";
      if (serviceType === "surrogacy") {
        label = "surrogacy journey";
        query = `
          WITH costs AS (
            SELECT "totalCostMin"::float AS cost_low, "totalCostMax"::float AS cost_high
            FROM "Surrogate"
            WHERE "hiddenFromSearch" IS NOT TRUE AND status != 'INACTIVE'
              AND "totalCostMin" IS NOT NULL
          ),
          bounds AS (
            SELECT
              percentile_cont(0.10) WITHIN GROUP (ORDER BY cost_low) AS p10,
              percentile_cont(0.90) WITHIN GROUP (ORDER BY cost_high) AS p90
            FROM costs
          )
          SELECT
            ROUND(MIN(b.p10)) AS "minTotalCost",
            ROUND(MAX(b.p90)) AS "maxTotalCost",
            ROUND(AVG((c.cost_low + c.cost_high) / 2)) AS "avgTotalCost",
            COUNT(*)::int AS "profileCount"
          FROM costs c, bounds b
          WHERE c.cost_low >= b.p10 AND c.cost_high <= b.p90`;
      } else if (serviceType === "egg-donor") {
        label = "egg donation";
        query = `
          WITH costs AS (
            SELECT "totalCost"::float AS cost
            FROM "EggDonor"
            WHERE "hiddenFromSearch" IS NOT TRUE AND status != 'INACTIVE'
              AND "totalCost" IS NOT NULL
          ),
          bounds AS (
            SELECT
              percentile_cont(0.10) WITHIN GROUP (ORDER BY cost) AS p10,
              percentile_cont(0.90) WITHIN GROUP (ORDER BY cost) AS p90
            FROM costs
          )
          SELECT
            ROUND(MIN(b.p10)) AS "minTotalCost",
            ROUND(MAX(b.p90)) AS "maxTotalCost",
            ROUND(AVG(c.cost)) AS "avgTotalCost",
            COUNT(*)::int AS "profileCount"
          FROM costs c, bounds b
          WHERE c.cost >= b.p10 AND c.cost <= b.p90`;
      } else if (serviceType === "sperm-donor") {
        label = "sperm donation";
        query = `
          WITH costs AS (
            SELECT "totalCost"::float AS cost
            FROM "SpermDonor"
            WHERE "hiddenFromSearch" IS NOT TRUE AND status != 'INACTIVE'
              AND "totalCost" IS NOT NULL
          ),
          bounds AS (
            SELECT
              percentile_cont(0.10) WITHIN GROUP (ORDER BY cost) AS p10,
              percentile_cont(0.90) WITHIN GROUP (ORDER BY cost) AS p90
            FROM costs
          )
          SELECT
            ROUND(MIN(b.p10)) AS "minTotalCost",
            ROUND(MAX(b.p90)) AS "maxTotalCost",
            ROUND(AVG(c.cost)) AS "avgTotalCost",
            COUNT(*)::int AS "profileCount"
          FROM costs c, bounds b
          WHERE c.cost >= b.p10 AND c.cost <= b.p90`;
      }

      if (!query) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Invalid serviceType" }) }] };
      }

      const rows: any[] = await prisma.$queryRawUnsafe(query);
      const row = rows[0] || {};
      const result = {
        serviceType,
        label,
        minTotalCost: row.minTotalCost != null ? Number(row.minTotalCost) : null,
        maxTotalCost: row.maxTotalCost != null ? Number(row.maxTotalCost) : null,
        avgTotalCost: row.avgTotalCost != null ? Number(row.avgTotalCost) : null,
        profileCount: row.profileCount ?? 0,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    if (name === "get_expert_guidance_rules") {
      const rules = await prisma.expertGuidanceRule.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(rules) }],
      };
    }

    if (name === "search_surrogacy_agencies") {
      const { agencyLocation, servesParentFromCountry, twinsAllowed, limit: rawLimit, excludeIds } = args as any;
      const take = Math.min(rawLimit || 5, 10);
      const excludeSet = new Set<string>(Array.isArray(excludeIds) ? excludeIds : []);

      const baseAgencyWhere: any = {
        services: {
          some: {
            providerType: { name: "Surrogacy Agency" },
            status: "APPROVED",
          },
        },
      };

      const agencySelect = {
        id: true,
        name: true,
        logoUrl: true,
        surrogacyTwinsAllowed: true,
        surrogacyCitizensNotAllowed: true,
        partnerProviderIds: true,
        locations: {
          orderBy: { sortOrder: "asc" as const },
          select: { city: true, state: true },
        },
        surrogacyProfile: {
          select: {
            numberOfBabiesBorn: true,
            timeToMatch: true,
            familiesPerCoordinator: true,
            screening: {
              select: {
                criminalBackgroundCheck: true,
                homeVisits: true,
                financialsReview: true,
                socialWorkerScreening: true,
                medicalRecordsReview: true,
                surrogateInsuranceReview: true,
                psychologicalScreening: true,
              },
            },
          },
        },
      };

      // Soft filters: relaxed one at a time if no full-match results.
      // Twins is most expendable (just a preference); location is last (most semantically meaningful).
      const agencySoftFilters: SoftFilter[] = [];
      if (twinsAllowed === true) agencySoftFilters.push({
        label: "twins allowed",
        applyToWhere: (w) => { w.surrogacyTwinsAllowed = true; },
      });
      if (agencyLocation) {
        const locationClause = buildClinicLocationWhere(agencyLocation);
        if (locationClause && Object.keys(locationClause).length) {
          agencySoftFilters.push({
            label: `location (${agencyLocation})`,
            applyToWhere: (w) => { w.locations = locationClause; },
          });
        }
      }

      const { candidates: agencies, relaxedFilter: agencyRelaxedFilter } = await searchWithFallback(
        (w) => prisma.provider.findMany({ where: w, take: take * 3, select: agencySelect }),
        baseAgencyWhere,
        agencySoftFilters,
      );

      let filtered = agencies.filter((a: any) => !excludeSet.has(a.id));

      if (servesParentFromCountry) {
        const countryLower = servesParentFromCountry.trim().toLowerCase();
        filtered = filtered.filter(a => {
          const notAllowed = Array.isArray(a.surrogacyCitizensNotAllowed)
            ? (a.surrogacyCitizensNotAllowed as string[]).map(c => c.toLowerCase())
            : [];
          return !notAllowed.includes(countryLower);
        });
      }

      // For each agency with linked partner clinics, fetch the clinic's parent matching requirements
      const agencyIds = filtered.map((a: any) => a.id);
      const allPartnerIds = filtered.flatMap((a: any) =>
        Array.isArray(a.partnerProviderIds) ? a.partnerProviderIds as string[] : []
      );
      const uniquePartnerIds = [...new Set(allPartnerIds)];
      const partnerClinics = uniquePartnerIds.length > 0
        ? await prisma.provider.findMany({
            where: { id: { in: uniquePartnerIds } },
            select: {
              id: true,
              name: true,
              ivfTwinsAllowed: true,
              ivfMaxAgeIp1: true,
              ivfMaxAgeIp2: true,
              ivfAcceptingPatients: true,
              ivfBiologicalConnection: true,
              ivfTransferFromOtherClinics: true,
              locations: { select: { city: true, state: true }, orderBy: { sortOrder: "asc" as const }, take: 3 },
            },
          })
        : [];
      const partnerClinicMap = new Map(partnerClinics.map((c: any) => [c.id, c]));

      const results = filtered.slice(0, take).map((a: any) => {
        const linkedClinics = Array.isArray(a.partnerProviderIds)
          ? (a.partnerProviderIds as string[]).map((pid: string) => partnerClinicMap.get(pid)).filter(Boolean)
          : [];
        return {
          id: a.id,
          name: a.name,
          logoUrl: a.logoUrl,
          locations: a.locations,
          surrogacyTwinsAllowed: a.surrogacyTwinsAllowed,
          surrogacyCitizensNotAllowed: a.surrogacyCitizensNotAllowed,
          numberOfBabiesBorn: a.surrogacyProfile?.numberOfBabiesBorn ?? null,
          timeToMatch: a.surrogacyProfile?.timeToMatch ?? null,
          familiesPerCoordinator: a.surrogacyProfile?.familiesPerCoordinator ?? null,
          screening: a.surrogacyProfile?.screening ?? null,
          // Partner IVF clinic(s) for this international program
          partnerClinics: linkedClinics.map((c: any) => ({
            id: c.id,
            name: c.name,
            locations: c.locations,
            ivfTwinsAllowed: c.ivfTwinsAllowed,
            ivfMaxAgeIp1: c.ivfMaxAgeIp1,
            ivfMaxAgeIp2: c.ivfMaxAgeIp2,
            ivfAcceptingPatients: c.ivfAcceptingPatients,
            ivfBiologicalConnection: c.ivfBiologicalConnection,
          })),
        };
      });

      const agencyRelaxedNote = agencyRelaxedFilter
        ? ` NOTE: The "${agencyRelaxedFilter}" filter was relaxed because no agencies fully matched. The returned results may NOT satisfy that preference - you MUST run the AGENCY HARD-REJECT CHECK on each result and skip any that violate the parent's requirements.`
        : "";

      return {
        content: [{ type: "text", text: `Found ${results.length} surrogacy agencies:\n${JSON.stringify(results, null, 2)}\n\nIMPORTANT: Before showing any MATCH_CARD, run the COMBINED PROGRAM HARD-REJECT CHECK on each result:\nAGENCY checks:\n- If parent wants twins AND surrogacyTwinsAllowed = false → REJECT.\n- If parent's citizenship is in surrogacyCitizensNotAllowed → REJECT.\nPARTNER CLINIC checks (if partnerClinics array is non-empty, ALSO check each linked clinic):\n- If parent's age (IP1) exceeds ivfMaxAgeIp1 → REJECT entire program.\n- If parent's age (IP2) exceeds ivfMaxAgeIp2 → REJECT entire program.\n- If parent's family type is NOT in ivfAcceptingPatients (and array is non-empty) → REJECT entire program.\n- If parent wants twins AND clinic's ivfTwinsAllowed = false → REJECT entire program.\nOnly show a MATCH_CARD for programs that pass ALL checks. Use type "CountryProgram" with the agency "id" as providerId and a "country" field (the country the parent selected) - this renders a country-level card with the COMBINED agency + IVF clinic cost. NEVER write any dollar amount yourself; the card pulls authoritative combined costs from the DB. If rejecting due to a CLINIC requirement, say which clinic rejected it and why. If ALL results fail, educate the parent and offer alternatives.${agencyRelaxedNote}` }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error executing tool ${name}: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GoStork MCP Database Server running on stdio");
}

run().catch((error) => console.error("Fatal error running MCP server:", error));
