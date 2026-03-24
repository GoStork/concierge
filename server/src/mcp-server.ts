import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import OpenAI from "openai";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const cleanExternalId = (eid: string | null | undefined) => eid ? eid.replace(/^[a-zA-Z]+-/, "") : null;

async function generateSearchEmbedding(text: string): Promise<number[] | null> {
  if (!text || !process.env.OPENAI_API_KEY) return null;
  try {
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    return response.data[0].embedding;
  } catch (e) {
    return null;
  }
}

const ALLOWED_TABLES = new Set(["EggDonor", "Surrogate", "SpermDonor", "Provider"]);

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
          "Search the database for available surrogates using semantic vector search across ALL profile data. Returns real surrogate profiles with their IDs, photos, and attributes. Use the 'query' parameter to search by ANY profile attribute (insurance, health history, pregnancy details, education, personality, etc.). Use the returned IDs in MATCH_CARDs with type 'Surrogate'.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Free-text search query matched against the surrogate's FULL profile via semantic vector search. Use this for ANY attribute: insurance type, health conditions, pregnancy history, delivery types, education, occupation, personality traits, motivation, support system, dietary preferences, etc. Examples: 'has medical insurance', 'vaginal delivery history', 'nurse or healthcare worker', 'vegetarian', 'experienced with twins'",
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
              description: "Filter by location (state abbreviation or city name)",
            },
            maxCompensation: {
              type: "number",
              description: "Maximum base compensation in USD",
            },
            limit: {
              type: "number",
              description: "Number of results to return (default 3, max 5)",
            },
          },
        },
      },
      {
        name: "get_surrogate_profile",
        description:
          "Look up a specific surrogate's FULL profile by their ID or external ID (e.g. '19331'). Returns complete pregnancy history (birth weights, delivery types, gestational ages), health details, support system, motivation, letter to intended parents, preferences, and all other profile sections. Use this tool when a parent asks follow-up questions about a specific surrogate's details — DO NOT whisper if this tool can answer the question.",
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
          "Look up a specific egg donor's FULL profile by their ID or external ID (e.g. 'S19907' or '19722'). Returns complete health history, family medical history, education, physical traits, personality, hobbies, and all other profile sections. Use this tool when a parent asks follow-up questions about a specific egg donor's details — DO NOT whisper if this tool can answer the question.",
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
          "Search the database for available egg donors using semantic vector search across ALL profile data. Returns real donor profiles with their IDs, photos, and attributes. Use the 'query' parameter to search by ANY profile attribute. Use the returned IDs in MATCH_CARDs with type 'Egg Donor'.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Free-text search query matched against the donor's FULL profile via semantic vector search. Use this for ANY attribute: health history, education details, hobbies, personality, family medical history, etc.",
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
              description: "Filter by ethnicity (e.g. 'Caucasian', 'Hispanic', 'Asian')",
            },
            maxAge: {
              type: "number",
              description: "Maximum donor age",
            },
            education: {
              type: "string",
              description: "Filter by education level",
            },
            limit: {
              type: "number",
              description: "Number of results to return (default 3, max 5)",
            },
          },
        },
      },
      {
        name: "search_sperm_donors",
        description:
          "Search the database for available sperm donors using semantic vector search across ALL profile data. Returns real donor profiles with their IDs, photos, and attributes. Use the 'query' parameter to search by ANY profile attribute. Use the returned IDs in MATCH_CARDs with type 'Sperm Donor'.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Free-text search query matched against the donor's FULL profile via semantic vector search. Use this for ANY attribute: health history, education, hobbies, personality, family medical history, athletic background, etc.",
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
              description: "Filter by ethnicity (e.g. 'Caucasian', 'Hispanic', 'Asian')",
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
              description: "Filter by height",
            },
            limit: {
              type: "number",
              description: "Number of results to return (default 3, max 5)",
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
            state: {
              type: "string",
              description: "Filter by state (e.g. 'CA', 'NY', 'TX', 'AZ')",
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
              description: "Minimum success rate percentage to filter by (e.g. 50 for 50%+). Based on live birth rate per intended egg retrieval, own eggs, new patients, under 35.",
            },
            limit: {
              type: "number",
              description: "Number of results to return (default 5, max 10)",
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
        name: "get_expert_guidance_rules",
        description:
          "Internal tool: Get all active expert guidance rules for system prompt enrichment.",
        inputSchema: {
          type: "object",
          properties: {},
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
      const { query, agreesToTwins, agreesToAbortion, openToSameSexCouple, isExperienced, location, maxCompensation, limit: rawLimit } = args as any;
      const take = Math.min(rawLimit || 3, 5);

      const queryParts: string[] = ["surrogate carrier"];
      if (query) queryParts.push(query);
      if (agreesToTwins) queryParts.push("open to twins");
      if (agreesToAbortion !== undefined) queryParts.push(agreesToAbortion ? "pro-choice" : "pro-life");
      if (openToSameSexCouple) queryParts.push("open to same-sex couples LGBTQ friendly");
      if (isExperienced) queryParts.push("experienced surrogate previous pregnancies");
      if (location) queryParts.push(`located in ${location}`);
      const queryText = queryParts.join(", ");

      const vectorResults = await vectorSearch(
        "Surrogate", queryText, take * 3,
        `"hiddenFromSearch" IS NOT TRUE AND status != 'INACTIVE'`,
        `id, "providerId", "firstName", "externalId", age, location, "baseCompensation", "agreesToTwins", "agreesToAbortion", "agreesToSelectiveReduction", "openToSameSexCouple", "isExperienced", ethnicity, race, "liveBirths", "photoUrl", religion`,
      );

      let surrogates: any[];
      if (vectorResults && vectorResults.length > 0) {
        let filtered = vectorResults.filter((s: any) => {
          if (agreesToTwins !== undefined && s.agreesToTwins !== agreesToTwins) return false;
          if (agreesToAbortion !== undefined && s.agreesToAbortion !== agreesToAbortion) return false;
          if (openToSameSexCouple !== undefined && s.openToSameSexCouple !== openToSameSexCouple) return false;
          if (isExperienced !== undefined && s.isExperienced !== isExperienced) return false;
          if (maxCompensation && s.baseCompensation && Number(s.baseCompensation) > maxCompensation) return false;
          if (location && s.location && !s.location.toLowerCase().includes(location.toLowerCase())) return false;
          return true;
        });
        surrogates = filtered.length > 0 ? filtered.slice(0, take) : vectorResults.slice(0, take);
      } else {
        const where: any = { hiddenFromSearch: { not: true }, status: { not: "INACTIVE" } };
        if (agreesToTwins !== undefined) where.agreesToTwins = agreesToTwins;
        if (agreesToAbortion !== undefined) where.agreesToAbortion = agreesToAbortion;
        if (openToSameSexCouple !== undefined) where.openToSameSexCouple = openToSameSexCouple;
        if (isExperienced !== undefined) where.isExperienced = isExperienced;
        if (location) where.location = { contains: location, mode: "insensitive" };
        if (maxCompensation) where.baseCompensation = { lte: maxCompensation };

        surrogates = await prisma.surrogate.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true, providerId: true, externalId: true, firstName: true, age: true, location: true,
            baseCompensation: true, agreesToTwins: true, agreesToAbortion: true,
            agreesToSelectiveReduction: true, openToSameSexCouple: true,
            isExperienced: true, ethnicity: true, race: true, liveBirths: true,
            photoUrl: true, religion: true,
          },
        });

        if (surrogates.length === 0) {
          surrogates = await prisma.surrogate.findMany({
            where: { hiddenFromSearch: { not: true }, status: { not: "INACTIVE" } },
            orderBy: { createdAt: "desc" },
            take,
            select: {
              id: true, providerId: true, externalId: true, firstName: true, age: true, location: true,
              baseCompensation: true, agreesToTwins: true, agreesToAbortion: true,
              agreesToSelectiveReduction: true, openToSameSexCouple: true,
              isExperienced: true, ethnicity: true, race: true, liveBirths: true,
              photoUrl: true, religion: true,
            },
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

        return {
          ...s,
          displayName: s.firstName || (cleanExternalId(s.externalId) ? `Surrogate #${cleanExternalId(s.externalId)}` : `Surrogate #${s.id.slice(-4)}`),
          baseCompensation: s.baseCompensation ? Number(s.baseCompensation) : null,
          ...(Object.keys(profileHighlights).length > 0 ? { profileHighlights } : {}),
        };
      });

      return {
        content: [{ type: "text", text: `Found ${results.length} surrogates:\n${JSON.stringify(results, null, 2)}\n\nIMPORTANT: Use the "id" field as "providerId" and set type to "Surrogate" in your MATCH_CARDs. Use the "displayName" as the name. Use the "profileHighlights" (supportSystem, motivation, pregnancyHistory, letterExcerpt) to write a warm, personalized introduction. ALWAYS mention the support system if available.` }],
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
        content: [{ type: "text", text: `Full profile for ${result.displayName}:\n${JSON.stringify(result, null, 2)}\n\nThis profile contains COMPLETE data including pregnancy history (birth weights, delivery types, gestational ages), health info, support system, and more. Use this data to answer the parent's questions DIRECTLY — do NOT whisper unless the specific answer is truly not in this profile.` }],
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
        content: [{ type: "text", text: `Full profile for ${result.displayName}:\n${JSON.stringify(result, null, 2)}\n\nThis profile contains COMPLETE data including physical traits, health history, family medical history, education, personality, hobbies, and more. Use this data to answer the parent's questions DIRECTLY — do NOT whisper unless the specific answer is truly not in this profile.` }],
      };
    }

    if (name === "search_egg_donors") {
      const { query, eyeColor, hairColor, ethnicity, maxAge, education, limit: rawLimit } = args as any;
      const take = Math.min(rawLimit || 3, 5);

      const queryParts: string[] = ["egg donor"];
      if (query) queryParts.push(query);
      if (eyeColor) queryParts.push(`${eyeColor} eyes`);
      if (hairColor) queryParts.push(`${hairColor} hair`);
      if (ethnicity) queryParts.push(`${ethnicity} ethnicity`);
      if (education) queryParts.push(`${education} education`);
      if (maxAge) queryParts.push(`under ${maxAge} years old`);
      const queryText = queryParts.join(", ");

      const vectorResults = await vectorSearch(
        "EggDonor", queryText, take * 3,
        `"hiddenFromSearch" IS NOT TRUE AND status != 'INACTIVE'`,
        `id, "providerId", "firstName", "externalId", age, location, "eyeColor", "hairColor", height, weight, ethnicity, race, education, "donorCompensation", "eggLotCost", "totalCost", "isExperienced", "photoUrl", "numberOfEggs"`,
      );

      let donors: any[];
      if (vectorResults && vectorResults.length > 0) {
        let filtered = vectorResults.filter((d: any) => {
          if (eyeColor && d.eyeColor && !d.eyeColor.toLowerCase().includes(eyeColor.toLowerCase())) return false;
          if (hairColor && d.hairColor && !d.hairColor.toLowerCase().includes(hairColor.toLowerCase())) return false;
          if (ethnicity && d.ethnicity && !d.ethnicity.toLowerCase().includes(ethnicity.toLowerCase())) return false;
          if (maxAge && d.age && d.age > maxAge) return false;
          if (education && d.education && !d.education.toLowerCase().includes(education.toLowerCase())) return false;
          return true;
        });
        donors = filtered.length > 0 ? filtered.slice(0, take) : vectorResults.slice(0, take);
      } else {
        const where: any = { hiddenFromSearch: { not: true }, status: { not: "INACTIVE" } };
        if (eyeColor) where.eyeColor = { contains: eyeColor, mode: "insensitive" };
        if (hairColor) where.hairColor = { contains: hairColor, mode: "insensitive" };
        if (ethnicity) where.ethnicity = { contains: ethnicity, mode: "insensitive" };
        if (maxAge) where.age = { lte: maxAge };
        if (education) where.education = { contains: education, mode: "insensitive" };

        donors = await prisma.eggDonor.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true, providerId: true, externalId: true, firstName: true, age: true, location: true,
            eyeColor: true, hairColor: true, height: true, weight: true,
            ethnicity: true, race: true, education: true,
            donorCompensation: true, eggLotCost: true, totalCost: true,
            isExperienced: true, photoUrl: true, numberOfEggs: true,
          },
        });

        if (donors.length === 0) {
          donors = await prisma.eggDonor.findMany({
            where: { hiddenFromSearch: { not: true }, status: { not: "INACTIVE" } },
            orderBy: { createdAt: "desc" },
            take,
            select: {
              id: true, providerId: true, externalId: true, firstName: true, age: true, location: true,
              eyeColor: true, hairColor: true, height: true, weight: true,
              ethnicity: true, race: true, education: true,
              donorCompensation: true, eggLotCost: true, totalCost: true,
              isExperienced: true, photoUrl: true, numberOfEggs: true,
            },
          });
        }
      }

      const results = donors.map((d: any) => ({
        ...d,
        displayName: d.firstName || (cleanExternalId(d.externalId) ? `Donor #${cleanExternalId(d.externalId)}` : `Donor #${d.id.slice(-4)}`),
      }));

      return {
        content: [{ type: "text", text: `Found ${results.length} egg donors:\n${JSON.stringify(results, null, 2)}\n\nIMPORTANT: Use the "id" field as "providerId" and set type to "Egg Donor" in your MATCH_CARDs. Use the "displayName" as the name.` }],
      };
    }

    if (name === "search_sperm_donors") {
      const { query, eyeColor, hairColor, ethnicity, maxAge, education, height, limit: rawLimit } = args as any;
      const take = Math.min(rawLimit || 3, 5);

      const queryParts: string[] = ["sperm donor"];
      if (query) queryParts.push(query);
      if (eyeColor) queryParts.push(`${eyeColor} eyes`);
      if (hairColor) queryParts.push(`${hairColor} hair`);
      if (ethnicity) queryParts.push(`${ethnicity} ethnicity`);
      if (education) queryParts.push(`${education} education`);
      if (height) queryParts.push(`${height} tall`);
      if (maxAge) queryParts.push(`under ${maxAge} years old`);
      const queryText = queryParts.join(", ");

      const vectorResults = await vectorSearch(
        "SpermDonor", queryText, take * 3,
        `"hiddenFromSearch" IS NOT TRUE AND status != 'INACTIVE'`,
        `id, "providerId", "firstName", "externalId", age, location, "eyeColor", "hairColor", height, weight, ethnicity, race, education, compensation, "isExperienced", "photoUrl"`,
      );

      let donors: any[];
      if (vectorResults && vectorResults.length > 0) {
        let filtered = vectorResults.filter((d: any) => {
          if (eyeColor && d.eyeColor && !d.eyeColor.toLowerCase().includes(eyeColor.toLowerCase())) return false;
          if (hairColor && d.hairColor && !d.hairColor.toLowerCase().includes(hairColor.toLowerCase())) return false;
          if (ethnicity && d.ethnicity && !d.ethnicity.toLowerCase().includes(ethnicity.toLowerCase())) return false;
          if (maxAge && d.age && d.age > maxAge) return false;
          if (education && d.education && !d.education.toLowerCase().includes(education.toLowerCase())) return false;
          return true;
        });
        donors = filtered.length > 0 ? filtered.slice(0, take) : vectorResults.slice(0, take);
      } else {
        const where: any = { hiddenFromSearch: { not: true }, status: { not: "INACTIVE" } };
        if (eyeColor) where.eyeColor = { contains: eyeColor, mode: "insensitive" };
        if (hairColor) where.hairColor = { contains: hairColor, mode: "insensitive" };
        if (ethnicity) where.ethnicity = { contains: ethnicity, mode: "insensitive" };
        if (maxAge) where.age = { lte: maxAge };
        if (education) where.education = { contains: education, mode: "insensitive" };
        if (height) where.height = { contains: height, mode: "insensitive" };

        donors = await prisma.spermDonor.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true, providerId: true, externalId: true, firstName: true, age: true, location: true,
            eyeColor: true, hairColor: true, height: true, weight: true,
            ethnicity: true, race: true, education: true,
            compensation: true, isExperienced: true, photoUrl: true,
          },
        });

        if (donors.length === 0) {
          donors = await prisma.spermDonor.findMany({
            where: { hiddenFromSearch: { not: true }, status: { not: "INACTIVE" } },
            orderBy: { createdAt: "desc" },
            take,
            select: {
              id: true, providerId: true, externalId: true, firstName: true, age: true, location: true,
              eyeColor: true, hairColor: true, height: true, weight: true,
              ethnicity: true, race: true, education: true,
              compensation: true, isExperienced: true, photoUrl: true,
            },
          });
        }
      }

      const results = donors.map((d: any) => ({
        ...d,
        displayName: d.firstName || (cleanExternalId(d.externalId) ? `Donor #${cleanExternalId(d.externalId)}` : `Donor #${d.id.slice(-4)}`),
      }));

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No sperm donors currently available in the database. Inform the parent that GoStork is actively building its sperm donor network and suggest they check back soon, or offer to connect them with a sperm bank partner." }],
        };
      }

      return {
        content: [{ type: "text", text: `Found ${results.length} sperm donors:\n${JSON.stringify(results, null, 2)}\n\nIMPORTANT: Use the "id" field as "providerId" and set type to "Sperm Donor" in your MATCH_CARDs. Use the "displayName" as the name.` }],
      };
    }

    if (name === "search_clinics") {
      const { query, state, city, name: clinicName, limit: rawLimit, minSuccessRate } = args as any;
      const take = Math.min(rawLimit || 5, 10);
      const clinicSelect = {
        id: true, name: true, logoUrl: true, about: true,
        locations: { select: { city: true, state: true, address: true }, orderBy: { sortOrder: "asc" as const } },
        members: { select: { name: true, title: true, bio: true, isMedicalDirector: true }, orderBy: { sortOrder: "asc" as const }, take: 10 },
        ivfSuccessRates: {
          where: { metricCode: { in: ["pct_new_patients_live_birth_after_1_retrieval", "pct_intended_retrievals_live_births"] }, profileType: "own_eggs" },
          select: { successRate: true, nationalAverage: true, ageGroup: true, isNewPatient: true, metricCode: true, top10pct: true, cycleCount: true },
        },
      };

      let clinics: any[];

      // When location is specified, use direct DB query (vector search doesn't know about ProviderLocation)
      const hasLocationFilter = !!(city || state);

      if (!hasLocationFilter && !clinicName) {
        // Generic search — use vector search
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
          const ids = vectorResults.map((r: any) => r.id);
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
          providerServices: {
            some: { providerType: { name: "IVF Clinic" }, status: "APPROVED" },
          },
        };
        if (clinicName) {
          const nameTerms = clinicName.trim().split(/[\s\-_]+/).filter(Boolean);
          if (nameTerms.length > 1) {
            providerWhere.AND = nameTerms.map((term: string) => ({ name: { contains: term, mode: "insensitive" } }));
          } else {
            providerWhere.name = { contains: clinicName.trim(), mode: "insensitive" };
          }
        }

        const locationWhere: any = {};
        if (state) locationWhere.state = { contains: state, mode: "insensitive" };
        if (city) locationWhere.city = { contains: city, mode: "insensitive" };

        if (state || city) {
          providerWhere.locations = { some: locationWhere };
        }

        clinics = await prisma.provider.findMany({
          where: providerWhere,
          orderBy: { name: "asc" },
          take: take * 2, // fetch extra so we can filter by success rate
          select: clinicSelect,
        });

        if (clinics.length === 0 && (state || city || clinicName)) {
          clinics = await prisma.provider.findMany({
            where: {
              providerServices: {
                some: { providerType: { name: "IVF Clinic" }, status: "APPROVED" },
              },
            },
            orderBy: { name: "asc" },
            take,
            select: clinicSelect,
          });
        }
      }

      // Build rich results with locations, doctors, and success rates
      let results = clinics.map((c: any) => {
        const locations = (c.locations || []).map((l: any) => [l.city, l.state].filter(Boolean).join(", ")).filter(Boolean);
        const doctors = (c.members || []).map((m: any) => ({
          name: m.name,
          title: m.title || null,
          isMedicalDirector: m.isMedicalDirector,
        }));

        // Pick the primary success rate (new patient under 35, or all patients under 35)
        const rates = c.ivfSuccessRates || [];
        const primaryRate = rates.find((r: any) => r.ageGroup === "under_35" && r.isNewPatient === true && r.metricCode === "pct_new_patients_live_birth_after_1_retrieval")
          || rates.find((r: any) => r.ageGroup === "under_35" && r.metricCode === "pct_intended_retrievals_live_births");
        const successPct = primaryRate ? Number(primaryRate.successRate) * 100 : null;
        const nationalAvgPct = primaryRate ? Number(primaryRate.nationalAverage) * 100 : null;

        // Build age-group breakdown
        const ratesByAge: Record<string, number> = {};
        for (const r of rates) {
          if (r.metricCode === "pct_new_patients_live_birth_after_1_retrieval" || r.metricCode === "pct_intended_retrievals_live_births") {
            const label = r.ageGroup === "under_35" ? "Under 35" : r.ageGroup === "35_37" ? "35-37" : r.ageGroup === "38_40" ? "38-40" : r.ageGroup === "over_40" ? "Over 40" : r.ageGroup;
            if (!ratesByAge[label]) ratesByAge[label] = Number(r.successRate) * 100;
          }
        }

        return {
          id: c.id,
          name: c.name,
          logoUrl: c.logoUrl,
          about: c.about ? c.about.slice(0, 200) : null,
          locations,
          doctors: doctors.slice(0, 5),
          successRate: successPct !== null ? `${successPct.toFixed(1)}%` : null,
          nationalAverage: nationalAvgPct !== null ? `${nationalAvgPct.toFixed(1)}%` : null,
          top10pct: primaryRate?.top10pct || false,
          cycleCount: primaryRate?.cycleCount || null,
          successRatesByAge: Object.keys(ratesByAge).length > 0 ? ratesByAge : null,
        };
      });

      // Filter by minimum success rate if requested
      if (minSuccessRate && typeof minSuccessRate === "number") {
        results = results.filter((r: any) => {
          const pct = r.successRate ? parseFloat(r.successRate) : 0;
          return pct >= minSuccessRate;
        });
      }

      // Sort by success rate descending
      results.sort((a: any, b: any) => {
        const aRate = a.successRate ? parseFloat(a.successRate) : 0;
        const bRate = b.successRate ? parseFloat(b.successRate) : 0;
        return bRate - aRate;
      });

      results = results.slice(0, take);

      return {
        content: [{ type: "text", text: `Found ${results.length} IVF clinics:\n${JSON.stringify(results, null, 2)}\n\nIMPORTANT: Use the "id" field as "providerId" and set type to "Clinic" in your MATCH_CARDs. Present ONE clinic at a time. Use the locations, doctors, and success rates to write a personalized blurb.` }],
      };
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

    if (name === "search_knowledge_base") {
      const { query: kbQuery, providerId: kbProviderId, maxResults: kbMaxResults } = args as any;
      const maxRes = kbMaxResults || 5;

      try {
        const embeddingResponse = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: kbQuery,
        });
        const embedding = embeddingResponse.data[0].embedding;
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

    if (name === "get_expert_guidance_rules") {
      const rules = await prisma.expertGuidanceRule.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(rules) }],
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
