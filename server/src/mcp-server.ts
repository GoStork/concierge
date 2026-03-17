import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

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

      const where: any = { hiddenFromSearch: { not: true } };
      if (agreesToTwins !== undefined) where.agreesToTwins = agreesToTwins;
      if (agreesToAbortion !== undefined) where.agreesToAbortion = agreesToAbortion;
      if (openToSameSexCouple !== undefined) where.openToSameSexCouple = openToSameSexCouple;
      if (isExperienced !== undefined) where.isExperienced = isExperienced;
      if (location) where.location = { contains: location, mode: "insensitive" };
      if (maxCompensation) where.baseCompensation = { lte: maxCompensation };

      let surrogates = await prisma.surrogate.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        select: {
          id: true, firstName: true, age: true, location: true,
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
            id: true, firstName: true, age: true, location: true,
            baseCompensation: true, agreesToTwins: true, agreesToAbortion: true,
            agreesToSelectiveReduction: true, openToSameSexCouple: true,
            isExperienced: true, ethnicity: true, race: true, liveBirths: true,
            photoUrl: true, religion: true,
          },
        });
      }

      const results = surrogates.map((s: any) => ({
        ...s,
        displayName: s.firstName || `Surrogate #${s.id.slice(-4)}`,
        baseCompensation: s.baseCompensation ? Number(s.baseCompensation) : null,
      }));

      return {
        content: [{ type: "text", text: `Found ${results.length} surrogates:\n${JSON.stringify(results, null, 2)}\n\nIMPORTANT: Use the "id" field as "providerId" and set type to "Surrogate" in your MATCH_CARDs. Use the "displayName" as the name.` }],
      };
    }

    if (name === "search_egg_donors") {
      const { eyeColor, hairColor, ethnicity, maxAge, education, limit: rawLimit } = args as any;
      const take = Math.min(rawLimit || 3, 5);

      const where: any = { hiddenFromSearch: { not: true } };
      if (eyeColor) where.eyeColor = { contains: eyeColor, mode: "insensitive" };
      if (hairColor) where.hairColor = { contains: hairColor, mode: "insensitive" };
      if (ethnicity) where.ethnicity = { contains: ethnicity, mode: "insensitive" };
      if (maxAge) where.age = { lte: maxAge };
      if (education) where.education = { contains: education, mode: "insensitive" };

      let donors = await prisma.eggDonor.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        select: {
          id: true, firstName: true, age: true, location: true,
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
            id: true, firstName: true, age: true, location: true,
            eyeColor: true, hairColor: true, height: true, weight: true,
            ethnicity: true, race: true, education: true,
            donorCompensation: true, eggLotCost: true, totalCost: true,
            isExperienced: true, photoUrl: true, numberOfEggs: true,
          },
        });
      }

      const results = donors.map((d: any) => ({
        ...d,
        displayName: d.firstName || `Donor #${d.id.slice(-4)}`,
      }));

      return {
        content: [{ type: "text", text: `Found ${results.length} egg donors:\n${JSON.stringify(results, null, 2)}\n\nIMPORTANT: Use the "id" field as "providerId" and set type to "Egg Donor" in your MATCH_CARDs. Use the "displayName" as the name.` }],
      };
    }

    if (name === "search_sperm_donors") {
      const { eyeColor, hairColor, ethnicity, maxAge, education, height, limit: rawLimit } = args as any;
      const take = Math.min(rawLimit || 3, 5);

      const where: any = { hiddenFromSearch: { not: true } };
      if (eyeColor) where.eyeColor = { contains: eyeColor, mode: "insensitive" };
      if (hairColor) where.hairColor = { contains: hairColor, mode: "insensitive" };
      if (ethnicity) where.ethnicity = { contains: ethnicity, mode: "insensitive" };
      if (maxAge) where.age = { lte: maxAge };
      if (education) where.education = { contains: education, mode: "insensitive" };
      if (height) where.height = { contains: height, mode: "insensitive" };

      let donors = await prisma.spermDonor.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        select: {
          id: true, firstName: true, age: true, location: true,
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
            id: true, firstName: true, age: true, location: true,
            eyeColor: true, hairColor: true, height: true, weight: true,
            ethnicity: true, race: true, education: true,
            compensation: true, isExperienced: true, photoUrl: true,
          },
        });
      }

      const results = donors.map((d: any) => ({
        ...d,
        displayName: d.firstName || `Donor #${d.id.slice(-4)}`,
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

      let clinics = await prisma.provider.findMany({
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
