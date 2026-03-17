import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { updateProfileEmbedding, profileDataToText } from "../modules/providers/profile-sync.service";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter }) as any;

const BATCH_SIZE = 50;

async function backfillTable(table: "EggDonor" | "Surrogate" | "SpermDonor") {
  let totalProcessed = 0;
  let totalFailed = 0;

  while (true) {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT id, "profileData" FROM "${table}" WHERE "profileEmbedding" IS NULL ORDER BY "createdAt" DESC LIMIT $1`,
      BATCH_SIZE,
    );
    if (rows.length === 0) break;
    console.log(`[${table}] Processing batch of ${rows.length} (total done: ${totalProcessed})`);

    for (const row of rows) {
      try {
        await updateProfileEmbedding(prisma, table, row.id, row.profileData);
        totalProcessed++;
        if (totalProcessed % 50 === 0) console.log(`[${table}] Total processed: ${totalProcessed}`);
        await new Promise((r) => setTimeout(r, 100));
      } catch (e: any) {
        totalFailed++;
        console.error(`[${table}] Failed for ${row.id}: ${e.message?.slice(0, 100)}`);
      }
    }
  }
  console.log(`[${table}] Complete. Success: ${totalProcessed}, Failed: ${totalFailed}`);
}

async function main() {
  await backfillTable("Surrogate");
  await backfillTable("EggDonor");
  await backfillTable("SpermDonor");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
