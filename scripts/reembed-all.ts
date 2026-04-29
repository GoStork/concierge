/**
 * Re-embed all existing records using Gemini gemini-embedding-001 (768 dims).
 * Run after applying the 20260429_embedding_768 migration.
 *
 * Usage: npx tsx scripts/reembed-all.ts
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { profileDataToText } from "../server/src/modules/providers/profile-sync.service";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter }) as any;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

async function embed(text: string): Promise<number[] | null> {
  if (!text || text.length < 10) return null;
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
    const result = await model.embedContent({ content: { parts: [{ text: text.slice(0, 9000) }], role: "user" }, outputDimensionality: 768 } as any);
    return result.embedding.values;
  } catch (e: any) {
    console.error("  embed error:", e.message);
    return null;
  }
}

async function reembedTable(
  label: string,
  findMany: () => Promise<{ id: string; profileData: any }[]>,
  updateFn: (id: string, vec: string) => Promise<void>,
) {
  const rows = await findMany();
  console.log(`\n[${label}] ${rows.length} records to re-embed`);
  let ok = 0;
  for (const row of rows) {
    const text = profileDataToText(row.profileData);
    const vec = await embed(text);
    if (!vec) { console.log(`  skip ${row.id} (no text)`); continue; }
    await updateFn(row.id, `[${vec.join(",")}]`);
    ok++;
    if (ok % 10 === 0) console.log(`  ${ok}/${rows.length}`);
    await new Promise(r => setTimeout(r, 50)); // respect rate limit
  }
  console.log(`  done: ${ok}/${rows.length} embedded`);
}

async function reembedKnowledge() {
  const chunks = await prisma.knowledgeChunk.findMany({ select: { id: true, content: true } });
  console.log(`\n[KnowledgeChunk] ${chunks.length} records to re-embed`);
  let ok = 0;
  for (const chunk of chunks) {
    const vec = await embed(chunk.content);
    if (!vec) { console.log(`  skip ${chunk.id}`); continue; }
    await prisma.$executeRawUnsafe(
      `UPDATE "KnowledgeChunk" SET embedding = $1::vector WHERE id = $2`,
      `[${vec.join(",")}]`, chunk.id,
    );
    ok++;
    if (ok % 20 === 0) console.log(`  ${ok}/${chunks.length}`);
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`  done: ${ok}/${chunks.length} embedded`);
}

async function main() {
  console.log("Starting re-embedding with Gemini gemini-embedding-001 (768 dims)...");

  await reembedTable(
    "EggDonor",
    () => prisma.eggDonor.findMany({ select: { id: true, profileData: true } }),
    (id, vec) => prisma.$executeRawUnsafe(`UPDATE "EggDonor" SET "profileEmbedding" = $1::vector WHERE id = $2`, vec, id).then(() => {}),
  );

  await reembedTable(
    "Surrogate",
    () => prisma.surrogate.findMany({ select: { id: true, profileData: true } }),
    (id, vec) => prisma.$executeRawUnsafe(`UPDATE "Surrogate" SET "profileEmbedding" = $1::vector WHERE id = $2`, vec, id).then(() => {}),
  );

  await reembedTable(
    "SpermDonor",
    () => prisma.spermDonor.findMany({ select: { id: true, profileData: true } }),
    (id, vec) => prisma.$executeRawUnsafe(`UPDATE "SpermDonor" SET "profileEmbedding" = $1::vector WHERE id = $2`, vec, id).then(() => {}),
  );

  const { updateProfileEmbedding } = await import("../server/src/modules/providers/profile-sync.service");
  const providers: any[] = await prisma.$queryRawUnsafe(`SELECT id, name FROM "Provider" ORDER BY name`);
  console.log(`\n[Provider] ${providers.length} records to re-embed`);
  let providerOk = 0;
  for (const p of providers) {
    try {
      await updateProfileEmbedding(prisma, "Provider", p.id, null);
      providerOk++;
      if (providerOk % 10 === 0) console.log(`  ${providerOk}/${providers.length}`);
      await new Promise(r => setTimeout(r, 100));
    } catch (e: any) {
      console.error(`  failed ${p.name}: ${e.message}`);
    }
  }
  console.log(`  done: ${providerOk}/${providers.length} embedded`);

  await reembedKnowledge();

  console.log("\nAll done. You can now remove OPENAI_API_KEY from .env and uninstall the openai package.");
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
