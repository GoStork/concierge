/**
 * Seed the AWS Rekognition look-alike face collection from existing
 * donor/surrogate photos. Idempotent: skips entities already indexed
 * (faceIndexedAt set) unless run with --force.
 *
 *   tsx server/src/scripts/backfill-face-index.ts            # only un-indexed
 *   tsx server/src/scripts/backfill-face-index.ts --force    # re-index all
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import {
  ensureCollection,
  collectionFaceCount,
  indexEntityPhotos,
  deleteEntityFaces,
  isFaceMatchingConfigured,
  type FaceEntityType,
} from "../modules/face/face-recognition.service";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter }) as any;

const FORCE = process.argv.includes("--force");
const BATCH_SIZE = 50;
// Index this many entities at once. Rekognition IndexFaces allows ~50 TPS by
// default, so a modest concurrency stays well within limits.
const CONCURRENCY = Number(process.env.FACE_BACKFILL_CONCURRENCY ?? 6);

const TYPE_OF: Record<string, FaceEntityType> = {
  EggDonor: "Egg Donor",
  SpermDonor: "Sperm Donor",
  Surrogate: "Surrogate",
};

type RowResult = "faces" | "nofaces" | "skipped" | "failed";

async function processRow(table: "EggDonor" | "Surrogate" | "SpermDonor", row: any): Promise<RowResult> {
  const photoUrls: string[] = [
    ...(row.photoUrl ? [row.photoUrl] : []),
    ...(Array.isArray(row.photos) ? row.photos : []),
  ].filter(Boolean);
  if (photoUrls.length === 0) return "skipped";
  try {
    if (FORCE && Array.isArray(row.rekognitionFaceIds) && row.rekognitionFaceIds.length > 0) {
      await deleteEntityFaces(row.rekognitionFaceIds).catch(() => {});
    }
    const faceIds = await indexEntityPhotos(TYPE_OF[table], row.id, photoUrls);
    await prisma.$executeRawUnsafe(
      `UPDATE "${table}" SET "rekognitionFaceIds" = $1, "faceIndexedAt" = NOW() WHERE id = $2`,
      faceIds,
      row.id,
    );
    return faceIds.length > 0 ? "faces" : "nofaces";
  } catch (e: any) {
    console.error(`[${table}] failed for ${row.id}: ${e?.message?.slice(0, 120)}`);
    return "failed";
  }
}

async function backfillTable(table: "EggDonor" | "Surrogate" | "SpermDonor") {
  let processed = 0;
  let withFaces = 0;
  let skipped = 0;
  let failed = 0;

  while (true) {
    // Non-FORCE: processed rows get faceIndexedAt set and drop out of the
    // filter, so only skipped+failed rows reappear -> offset = skipped+failed.
    // FORCE: no filter, every row reappears -> offset = all consumed so far.
    const offset = FORCE ? processed + skipped + failed : skipped + failed;
    // Donor-consent gate: only index donors of agencies that have authorized
    // biometric matching (Provider.biometricMatchingAuthorized = true).
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT e.id, e."photoUrl", e."photos", e."rekognitionFaceIds" FROM "${table}" e
       JOIN "Provider" p ON p.id = e."providerId" AND p."biometricMatchingAuthorized" = true
       WHERE e."hiddenFromSearch" IS NOT TRUE
         AND (e."status" IS NULL OR e."status" <> 'INACTIVE')
         ${FORCE ? "" : `AND e."faceIndexedAt" IS NULL`}
       ORDER BY e."createdAt" DESC
       LIMIT $1 OFFSET $2`,
      BATCH_SIZE,
      offset,
    );
    if (rows.length === 0) break;

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map((r) => processRow(table, r)));
      for (const r of results) {
        if (r === "skipped") skipped++;
        else if (r === "failed") failed++;
        else { processed++; if (r === "faces") withFaces++; }
      }
    }
    console.log(`[${table}] progress: indexed=${processed} (faces=${withFaces}), skipped=${skipped}, failed=${failed}`);
  }
  console.log(`[${table}] done. indexed=${processed} (faces found: ${withFaces}), skipped(no photo)=${skipped}, failed=${failed}`);
}

// Delete faces for entities whose agency has NOT authorized biometric matching
// (e.g. cleaning up records indexed before the donor-consent gate existed).
async function pruneUnauthorized(table: "EggDonor" | "Surrogate" | "SpermDonor") {
  let removed = 0;
  while (true) {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT e.id, e."rekognitionFaceIds" FROM "${table}" e
       JOIN "Provider" p ON p.id = e."providerId"
       WHERE COALESCE(p."biometricMatchingAuthorized", false) = false
         AND array_length(e."rekognitionFaceIds",1) > 0
       LIMIT $1`,
      BATCH_SIZE,
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      await deleteEntityFaces(r.rekognitionFaceIds).catch(() => {});
      await prisma.$executeRawUnsafe(
        `UPDATE "${table}" SET "rekognitionFaceIds" = ARRAY[]::text[], "faceIndexedAt" = NULL WHERE id = $1`,
        r.id,
      );
      removed++;
    }
    console.log(`[${table}] pruned ${removed} unauthorized so far...`);
  }
  console.log(`[${table}] prune done. removed=${removed}`);
}

async function main() {
  if (!isFaceMatchingConfigured()) {
    console.error("Face matching is not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION (and optionally REKOGNITION_COLLECTION_ID).");
    process.exit(1);
  }
  await ensureCollection();
  const prune = process.argv.includes("--prune-unauthorized");
  console.log(`Collection ready. Faces before: ${await collectionFaceCount()} (force=${FORCE}, prune=${prune})`);
  if (prune) {
    await pruneUnauthorized("EggDonor");
    await pruneUnauthorized("SpermDonor");
    await pruneUnauthorized("Surrogate");
  }
  await backfillTable("EggDonor");
  await backfillTable("SpermDonor");
  await backfillTable("Surrogate");
  console.log(`Faces after: ${await collectionFaceCount()}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
