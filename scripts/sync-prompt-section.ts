import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { getDefaultPromptSections } from "../server/ai-prompt-defaults";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const key = process.argv[2];
  if (!key) throw new Error("usage: tsx scripts/sync-prompt-section.ts <section-key>");
  const sections = getDefaultPromptSections();
  const target = sections.find((s: any) => s.key === key);
  if (!target) throw new Error(`section not found: ${key}`);
  const res = await prisma.conciergePromptSection.update({
    where: { key },
    data: { content: target.content },
  });
  console.log("Updated:", res.key, "len=", res.content.length);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
