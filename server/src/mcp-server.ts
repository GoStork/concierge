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

// Initialize the MCP Server
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

// Define the tools the AI is allowed to use
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
        name: "search_egg_donors",
        description:
          "Search the database for available egg donors based on strict criteria",
        inputSchema: {
          type: "object",
          properties: {
            maxAge: { type: "number" },
            eyeColor: { type: "string" },
            hairColor: { type: "string" },
          },
        },
      },
    ],
  };
});

// Execute the database logic when the AI calls a tool
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

    if (name === "search_egg_donors") {
      const { maxAge, eyeColor, hairColor } = args as any;

      const donors = await prisma.eggDonor.findMany({
        where: {
          status: "AVAILABLE",
          ...(maxAge ? { age: { lte: maxAge } } : {}),
          ...(eyeColor
            ? { eyeColor: { contains: eyeColor, mode: "insensitive" } }
            : {}),
          ...(hairColor
            ? { hairColor: { contains: hairColor, mode: "insensitive" } }
            : {}),
        },
        take: 3, // Limit to top 3 for the chat interface
        select: {
          id: true,
          firstName: true,
          age: true,
          eyeColor: true,
          hairColor: true,
          totalCost: true,
        },
      });

      return {
        content: [{ type: "text", text: JSON.stringify(donors, null, 2) }],
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

// Start the server using standard I/O (this is how the NestJS app will communicate with it)
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GoStork MCP Database Server running on stdio");
}

run().catch((error) => console.error("Fatal error running MCP server:", error));
