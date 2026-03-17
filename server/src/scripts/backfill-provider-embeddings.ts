import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { updateProfileEmbedding } from "../modules/providers/profile-sync.service";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter }) as any;

async function backfillProviderEmbeddings() {
  const providers: any[] = await prisma.$queryRawUnsafe(
    `SELECT id, name FROM "Provider" WHERE "profileEmbedding" IS NULL ORDER BY name`
  );
  console.log(`Found ${providers.length} providers without embeddings`);

  let success = 0;
  let failed = 0;
  for (const p of providers) {
    try {
      await updateProfileEmbedding(prisma, "Provider", p.id, null);
      success++;
      if (success % 10 === 0) console.log(`Processed ${success}/${providers.length} (${p.name})`);
      await new Promise((r) => setTimeout(r, 200));
    } catch (e: any) {
      failed++;
      console.error(`Failed for ${p.name}: ${e.message}`);
    }
  }
  console.log(`Done. Success: ${success}, Failed: ${failed}`);
}

backfillProviderEmbeddings()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
