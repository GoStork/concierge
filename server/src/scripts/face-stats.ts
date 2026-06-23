import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { collectionFaceCount } from "../modules/face/face-recognition.service";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) }) as any;

// Diagnostic: compare the AWS collection's face count against the sum of face
// IDs stored in the DB. They should match if everything indexes into the SAME
// collection (region + REKOGNITION_COLLECTION_ID). A large DB > AWS gap means
// faces were written to a different collection (e.g. a host with mismatched env).
async function main() {
  const region = process.env.AWS_REGION;
  const collection = process.env.REKOGNITION_COLLECTION_ID || "gostork-donor-faces";
  const aws = await collectionFaceCount();
  const dbRows: any[] = await prisma.$queryRawUnsafe(
    `SELECT 'EggDonor' t, COALESCE(SUM(array_length("rekognitionFaceIds",1)),0)::int faces, COUNT(*) FILTER (WHERE "faceIndexedAt" IS NOT NULL)::int indexed FROM "EggDonor"
     UNION ALL SELECT 'SpermDonor', COALESCE(SUM(array_length("rekognitionFaceIds",1)),0)::int, COUNT(*) FILTER (WHERE "faceIndexedAt" IS NOT NULL)::int FROM "SpermDonor"
     UNION ALL SELECT 'Surrogate', COALESCE(SUM(array_length("rekognitionFaceIds",1)),0)::int, COUNT(*) FILTER (WHERE "faceIndexedAt" IS NOT NULL)::int FROM "Surrogate"`,
  );
  const dbFaces = dbRows.reduce((s, r) => s + Number(r.faces), 0);
  console.log(`AWS collection "${collection}" (${region}) face count: ${aws}`);
  for (const r of dbRows) console.log(`  DB ${r.t}: ${r.faces} face IDs across ${r.indexed} indexed rows`);
  console.log(`DB total face IDs: ${dbFaces}`);
  console.log(dbFaces === aws ? "MATCH - same collection." : `GAP of ${dbFaces - aws} (note: a sync re-indexing right now causes a small transient gap).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
