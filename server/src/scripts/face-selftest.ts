import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { fetchImageBytes, searchByImage } from "../modules/face/face-recognition.service";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) }) as any;

// For a given donor, search using EACH of its photos and report whether that
// same donor comes back (and at what rank/similarity). Shows whether matching
// generalizes across all photos or only the indexed ones.
const DONOR_ID = process.argv[2] || "0f41684e-b3cb-4552-ab98-87f1bcc92578";

async function main() {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT "photoUrl", photos, "rekognitionFaceIds" FROM "EggDonor" WHERE id = $1`,
    DONOR_ID,
  );
  const row = rows[0];
  const photos: string[] = [...new Set([...(row.photoUrl ? [row.photoUrl] : []), ...(row.photos || [])].filter(Boolean))];
  const indexedSet = new Set(photos.slice(0, 3)); // first 3 distinct = what we indexed
  console.log(`Donor ${DONOR_ID}: ${photos.length} distinct photos, ${row.rekognitionFaceIds?.length || 0} indexed faces\n`);

  for (let i = 0; i < photos.length; i++) {
    const url = photos[i];
    const bytes = await fetchImageBytes(url);
    if (!bytes) { console.log(`#${i} ${indexedSet.has(url) ? "[indexed]" : "         "} fetch FAILED`); continue; }
    const res = await searchByImage(bytes, { types: ["Egg Donor"], limit: 5 });
    if (!res.ok) { console.log(`#${i} ${indexedSet.has(url) ? "[indexed]" : "         "} ${res.reason}`); continue; }
    const self = res.matches.find((m) => m.entityId === DONOR_ID);
    const top = res.matches[0];
    const selfRank = self ? res.matches.indexOf(self) + 1 : 0;
    console.log(
      `#${i} ${indexedSet.has(url) ? "[indexed]" : "         "} ` +
      `self: ${self ? `#${selfRank} @ ${self.similarity.toFixed(1)}%` : "NOT in top 5"}  | ` +
      `top: ${top ? `${top.entityId === DONOR_ID ? "SELF" : top.entityId.slice(0, 8)} @ ${top.similarity.toFixed(1)}%` : "none"}`,
    );
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
