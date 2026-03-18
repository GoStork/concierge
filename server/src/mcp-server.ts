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
          "Search the database for available surrogates. Returns real surrogate profiles with their IDs, photos, and attributes. Use the returned IDs in MATCH_CARDs with type 'Surrogate'.",
        inputSchema: {
          type: "object",
          properties: {
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
        name: "search_egg_donors",
        description:
          "Search the database for available egg donors. Returns real donor profiles with their IDs, photos, and attributes. Use the returned IDs in MATCH_CARDs with type 'Egg Donor'.",
        inputSchema: {
          type: "object",
          properties: {
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
          "Search the database for available sperm donors. Returns real donor profiles with their IDs, photos, and attributes. Use the returned IDs in MATCH_CARDs with type 'Sperm Donor'.",
        inputSchema: {
          type: "object",
          properties: {
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
          "Search the database for IVF fertility clinics. Returns real clinic profiles with their IDs, logos, and locations. Use the returned IDs in MATCH_CARDs with type 'Clinic'.",
        inputSchema: {
          type: "object",
          properties: {
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
            limit: {
              type: "number",
              description: "Number of results to return (default 3, max 5)",
            },
          },
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
      const { agreesToTwins, agreesToAbortion, openToSameSexCouple, isExperienced, location, maxCompensation, limit: rawLimit } = args as any;
      const take = Math.min(rawLimit || 3, 5);

      const queryParts: string[] = ["surrogate carrier"];
      if (agreesToTwins) queryParts.push("open to twins");
      if (agreesToAbortion !== undefined) queryParts.push(agreesToAbortion ? "pro-choice" : "pro-life");
      if (openToSameSexCouple) queryParts.push("open to same-sex couples LGBTQ friendly");
      if (isExperienced) queryParts.push("experienced surrogate previous pregnancies");
      if (location) queryParts.push(`located in ${location}`);
      const queryText = queryParts.join(", ");

      const vectorResults = await vectorSearch(
        "Surrogate", queryText, take * 3,
        `"hiddenFromSearch" IS NOT TRUE`,
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
        const where: any = { hiddenFromSearch: { not: true } };
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
            where: { hiddenFromSearch: { not: true } },
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
          displayName: s.firstName || (s.externalId ? `Surrogate #${s.externalId}` : `Surrogate #${s.id.slice(-4)}`),
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
        displayName: surrogateBasic.firstName || (surrogateBasic.externalId ? `Surrogate #${surrogateBasic.externalId}` : `Surrogate`),
        baseCompensation: surrogateBasic.baseCompensation ? Number(surrogateBasic.baseCompensation) : null,
        profileSections,
        additionalDetails: topLevelData,
      };

      return {
        content: [{ type: "text", text: `Full profile for ${result.displayName}:\n${JSON.stringify(result, null, 2)}\n\nThis profile contains COMPLETE data including pregnancy history (birth weights, delivery types, gestational ages), health info, support system, and more. Use this data to answer the parent's questions DIRECTLY — do NOT whisper unless the specific answer is truly not in this profile.` }],
      };
    }

    if (name === "search_egg_donors") {
      const { eyeColor, hairColor, ethnicity, maxAge, education, limit: rawLimit } = args as any;
      const take = Math.min(rawLimit || 3, 5);

      const queryParts: string[] = ["egg donor"];
      if (eyeColor) queryParts.push(`${eyeColor} eyes`);
      if (hairColor) queryParts.push(`${hairColor} hair`);
      if (ethnicity) queryParts.push(`${ethnicity} ethnicity`);
      if (education) queryParts.push(`${education} education`);
      if (maxAge) queryParts.push(`under ${maxAge} years old`);
      const queryText = queryParts.join(", ");

      const vectorResults = await vectorSearch(
        "EggDonor", queryText, take * 3,
        `"hiddenFromSearch" IS NOT TRUE`,
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
        const where: any = { hiddenFromSearch: { not: true } };
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
            where: { hiddenFromSearch: { not: true } },
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
        displayName: d.firstName || (d.externalId ? `Donor #${d.externalId}` : `Donor #${d.id.slice(-4)}`),
      }));

      return {
        content: [{ type: "text", text: `Found ${results.length} egg donors:\n${JSON.stringify(results, null, 2)}\n\nIMPORTANT: Use the "id" field as "providerId" and set type to "Egg Donor" in your MATCH_CARDs. Use the "displayName" as the name.` }],
      };
    }

    if (name === "search_sperm_donors") {
      const { eyeColor, hairColor, ethnicity, maxAge, education, height, limit: rawLimit } = args as any;
      const take = Math.min(rawLimit || 3, 5);

      const queryParts: string[] = ["sperm donor"];
      if (eyeColor) queryParts.push(`${eyeColor} eyes`);
      if (hairColor) queryParts.push(`${hairColor} hair`);
      if (ethnicity) queryParts.push(`${ethnicity} ethnicity`);
      if (education) queryParts.push(`${education} education`);
      if (height) queryParts.push(`${height} tall`);
      if (maxAge) queryParts.push(`under ${maxAge} years old`);
      const queryText = queryParts.join(", ");

      const vectorResults = await vectorSearch(
        "SpermDonor", queryText, take * 3,
        `"hiddenFromSearch" IS NOT TRUE`,
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
        const where: any = { hiddenFromSearch: { not: true } };
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
            where: { hiddenFromSearch: { not: true } },
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
        displayName: d.firstName || (d.externalId ? `Donor #${d.externalId}` : `Donor #${d.id.slice(-4)}`),
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
      const { state, city, name: clinicName, limit: rawLimit } = args as any;
      const take = Math.min(rawLimit || 3, 5);

      const queryParts: string[] = ["IVF clinic fertility center"];
      if (city) queryParts.push(`in ${city}`);
      if (state) queryParts.push(`in ${state}`);
      if (clinicName) queryParts.push(clinicName);
      const queryText = queryParts.join(", ");

      const ivfClinicTypeCheck = `EXISTS (SELECT 1 FROM "ProviderService" ps JOIN "ProviderType" pt ON pt.id = ps."providerTypeId" WHERE ps."providerId" = "Provider".id AND pt.name = 'IVF Clinic')`;
      const vectorResults = await vectorSearch(
        "Provider", queryText, take,
        ivfClinicTypeCheck,
        `"Provider".id, "Provider".name, "Provider"."logoUrl", "Provider".about`,
      );

      let clinics: any[];
      if (vectorResults && vectorResults.length > 0) {
        const ids = vectorResults.map((r: any) => r.id);
        const withLocations = await prisma.provider.findMany({
          where: { id: { in: ids } },
          select: {
            id: true, name: true, logoUrl: true, about: true,
            locations: {
              select: { city: true, state: true, address: true },
              take: 1,
            },
          },
        });
        const locMap = new Map(withLocations.map((c: any) => [c.id, c]));
        clinics = ids.map((id: string) => locMap.get(id)).filter(Boolean);
      } else {
        const providerWhere: any = {
          providerServices: {
            some: { providerType: { name: "IVF Clinic" } },
          },
        };
        if (clinicName) providerWhere.name = { contains: clinicName, mode: "insensitive" };

        const locationWhere: any = {};
        if (state) locationWhere.state = { contains: state, mode: "insensitive" };
        if (city) locationWhere.city = { contains: city, mode: "insensitive" };

        if (state || city) {
          providerWhere.locations = { some: locationWhere };
        }

        clinics = await prisma.provider.findMany({
          where: providerWhere,
          orderBy: { name: "asc" },
          take,
          select: {
            id: true, name: true, logoUrl: true, about: true,
            locations: {
              select: { city: true, state: true, address: true },
              take: 1,
            },
          },
        });

        if (clinics.length === 0 && (state || city || clinicName)) {
          clinics = await prisma.provider.findMany({
            where: {
              providerServices: {
                some: { providerType: { name: "IVF Clinic" } },
              },
            },
            orderBy: { name: "asc" },
            take,
            select: {
              id: true, name: true, logoUrl: true, about: true,
              locations: {
                select: { city: true, state: true, address: true },
                take: 1,
              },
            },
          });
        }
      }

      const results = clinics.map((c: any) => {
        const loc = c.locations?.[0];
        return {
          id: c.id,
          name: c.name,
          logoUrl: c.logoUrl,
          city: loc?.city || null,
          state: loc?.state || null,
          location: loc ? [loc.city, loc.state].filter(Boolean).join(", ") : "N/A",
        };
      });

      return {
        content: [{ type: "text", text: `Found ${results.length} IVF clinics:\n${JSON.stringify(results, null, 2)}\n\nIMPORTANT: Use the "id" field as "providerId" and set type to "Clinic" in your MATCH_CARDs.` }],
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
