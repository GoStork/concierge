import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { collectionFaceCount } from "../modules/face/face-recognition.service";
import { RekognitionClient, ListFacesCommand } from "@aws-sdk/client-rekognition";

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
  // Authoritative count via ListFaces (DescribeCollection.FaceCount is laggy).
  const lf = new RekognitionClient({ region: process.env.AWS_REGION });
  let listed = 0; let token: string | undefined;
  do {
    const r: any = await lf.send(new ListFacesCommand({ CollectionId: collection, MaxResults: 1000, NextToken: token }));
    listed += (r.Faces || []).length;
    token = r.NextToken;
  } while (token);
  console.log(`ListFaces actual count: ${listed}`);
  for (const r of await prisma.$queryRawUnsafe(
    `SELECT 'EggDonor' t, COUNT(*) FILTER (WHERE "faceIndexedAt" IS NOT NULL)::int indexed FROM "EggDonor"
     UNION ALL SELECT 'SpermDonor', COUNT(*) FILTER (WHERE "faceIndexedAt" IS NOT NULL)::int FROM "SpermDonor"
     UNION ALL SELECT 'Surrogate', COUNT(*) FILTER (WHERE "faceIndexedAt" IS NOT NULL)::int FROM "Surrogate"`,
  ) as any[]) console.log(`  DB ${r.t}: ${r.indexed} indexed rows`);
  // Distinct face IDs across all donors - this is what should equal the AWS
  // collection count (SUM(array_length) over-counts any ID stored under >1 row).
  const distinctRow: any[] = await prisma.$queryRawUnsafe(
    `WITH f AS (
       SELECT unnest("rekognitionFaceIds") fid FROM "EggDonor"
       UNION ALL SELECT unnest("rekognitionFaceIds") FROM "SpermDonor"
       UNION ALL SELECT unnest("rekognitionFaceIds") FROM "Surrogate"
     ) SELECT count(*)::int total, count(DISTINCT fid)::int distinct_ids FROM f`,
  );
  const { total, distinct_ids } = distinctRow[0];
  console.log(`AWS collection "${collection}" (${region}) actual faces: ${aws}`);
  console.log(`DB face IDs: ${total} total, ${distinct_ids} distinct (${total - distinct_ids} duplicate entries)`);
  console.log(distinct_ids === aws ? "MATCH - distinct DB face IDs == collection." : `GAP of ${distinct_ids - aws} distinct IDs vs collection.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
