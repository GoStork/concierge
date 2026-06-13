/**
 * Backfill: AI-upscale existing doctor headshots (ProviderMember.photoUrl) into
 * a crisp highResPhotoUrl. Thin wrapper over the shared upscaleMissingDoctorPhotos
 * helper (server/src/lib/upscale-doctors.ts) - the SAME code the enrichment
 * service runs after each clinic-enrichment run, so behavior is identical.
 *
 * Downloads originals from the (private) GCS bucket with the service-account
 * credentials, upscales, uploads to profile-photos-hires/, sets highResPhotoUrl.
 * Idempotent + non-destructive: skips doctors that already have a highResPhotoUrl
 * (unless --force) and never touches the original photoUrl.
 *
 * Run:   npx tsx -r dotenv/config scripts/backfill-doctor-photos.ts
 *        npx tsx -r dotenv/config scripts/backfill-doctor-photos.ts --limit=10
 *        npx tsx -r dotenv/config scripts/backfill-doctor-photos.ts --slug=ivan-huang --force
 *        npx tsx -r dotenv/config scripts/backfill-doctor-photos.ts --dry-run
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { Storage } from "@google-cloud/storage";
import { upscaleMissingDoctorPhotos } from "../server/src/lib/upscale-doctors";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const arg = (k: string) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split("=")[1] : undefined;
};

const BUCKET = process.env.GCS_BUCKET_NAME || "gostork-recordings";
const creds = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_KEY || "{}");
const bucket = new Storage({ credentials: creds }).bucket(BUCKET);

async function uploadPublic(buf: Buffer, dest: string, contentType: string): Promise<string> {
  const file = bucket.file(dest);
  try {
    await file.save(buf, { contentType, predefinedAcl: "publicRead" });
  } catch (err: any) {
    if (err?.code === 400 || /uniform|ACL|BucketPolicyOnly/i.test(err?.message || "")) {
      await file.save(buf, { contentType });
    } else {
      throw err;
    }
  }
  return `https://storage.googleapis.com/${BUCKET}/${dest}`;
}

async function downloadObject(objectPath: string): Promise<{ buffer: Buffer; contentType: string }> {
  const file = bucket.file(objectPath);
  const [buffer] = await file.download();
  const [meta] = await file.getMetadata();
  return { buffer, contentType: meta.contentType || (objectPath.endsWith(".png") ? "image/png" : "image/jpeg") };
}

async function main() {
  const result = await upscaleMissingDoctorPhotos(
    { prisma, bucketName: BUCKET, downloadObject, uploadPublic, log: (m) => console.log(m) },
    {
      limit: arg("limit") ? parseInt(arg("limit")!, 10) : undefined,
      slug: arg("slug"),
      force: process.argv.includes("--force"),
      dryRun: process.argv.includes("--dry-run"),
      concurrency: arg("concurrency") ? parseInt(arg("concurrency")!, 10) : 3,
    },
  );
  console.log(`[upscale] COMPLETE: ${result.done} upscaled, ${result.skip} skipped, ${result.fail} failed`);
  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); await pool.end(); process.exit(1); });
