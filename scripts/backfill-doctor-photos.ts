/**
 * Backfill: AI-upscale existing doctor headshots (ProviderMember.photoUrl) into
 * a crisp highResPhotoUrl using Gemini (server/src/lib/photo-upscale.ts).
 *
 * For each public doctor that has a photoUrl but no highResPhotoUrl, this
 * downloads the original from the (private) GCS bucket with the service-account
 * credentials, upscales it, uploads the result to profile-photos-hires/, and
 * sets highResPhotoUrl. The original photoUrl is never touched.
 *
 * Idempotent + non-destructive: skips any doctor that already has a
 * highResPhotoUrl (unless --force). Safe to re-run; stop/resume any time.
 *
 * Run:   npx tsx -r dotenv/config scripts/backfill-doctor-photos.ts
 *        npx tsx -r dotenv/config scripts/backfill-doctor-photos.ts --limit=10
 *        npx tsx -r dotenv/config scripts/backfill-doctor-photos.ts --slug=ivan-huang --force
 *        npx tsx -r dotenv/config scripts/backfill-doctor-photos.ts --dry-run
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import crypto from "crypto";
import { Storage } from "@google-cloud/storage";
import { upscaleImageBuffer } from "../server/src/lib/photo-upscale";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const arg = (k: string) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split("=")[1] : undefined;
};
const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const LIMIT = arg("limit") ? parseInt(arg("limit")!, 10) : undefined;
const SLUG = arg("slug");
const CONCURRENCY = arg("concurrency") ? parseInt(arg("concurrency")!, 10) : 3;

const BUCKET = process.env.GCS_BUCKET_NAME || "gostork-recordings";
const creds = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_KEY || "{}");
const storage = new Storage({ credentials: creds });
const bucket = storage.bucket(BUCKET);

// Pull the object path ("profile-photos/<hash>.png") out of a stored GCS URL.
function objectPathOf(url: string): string | null {
  const marker = `storage.googleapis.com/${BUCKET}/`;
  const i = url.indexOf(marker);
  if (i === -1) return null;
  return url.slice(i + marker.length);
}

async function uploadPublic(buf: Buffer, dest: string, contentType: string): Promise<string> {
  const file = bucket.file(dest);
  try {
    await file.save(buf, { contentType, predefinedAcl: "publicRead" });
  } catch (err: any) {
    // Uniform bucket-level access: save without per-object ACL (served via proxy).
    if (err?.code === 400 || /uniform|ACL|BucketPolicyOnly/i.test(err?.message || "")) {
      await file.save(buf, { contentType });
    } else {
      throw err;
    }
  }
  return `https://storage.googleapis.com/${BUCKET}/${dest}`;
}

async function processOne(d: { id: string; slug: string | null; name: string; photoUrl: string | null }): Promise<"done" | "skip" | "fail"> {
  if (!d.photoUrl) return "skip";
  const objPath = objectPathOf(d.photoUrl);
  if (!objPath) {
    console.log(`  [skip] ${d.name}: photoUrl is not a GCS object (${d.photoUrl.slice(0, 60)})`);
    return "skip";
  }
  let srcBuf: Buffer;
  let mime: string;
  try {
    [srcBuf] = await bucket.file(objPath).download();
    const [meta] = await bucket.file(objPath).getMetadata();
    mime = meta.contentType || (objPath.endsWith(".png") ? "image/png" : "image/jpeg");
  } catch (e: any) {
    console.log(`  [fail] ${d.name}: download error ${e?.message || e}`);
    return "fail";
  }
  if (srcBuf.length < 1024) {
    console.log(`  [skip] ${d.name}: source too small (${srcBuf.length}b) - broken/placeholder photo`);
    return "skip";
  }

  const up = await upscaleImageBuffer(srcBuf, mime);
  if (!up) {
    console.log(`  [fail] ${d.name}: upscale returned no image`);
    return "fail";
  }
  const hash = crypto.createHash("md5").update(up.buffer).digest("hex");
  const ext = up.mime.includes("png") ? ".png" : up.mime.includes("webp") ? ".webp" : ".jpg";
  const dest = `profile-photos-hires/${hash}${ext}`;
  if (DRY_RUN) {
    console.log(`  [dry] ${d.name}: ${srcBuf.length}b -> ${up.buffer.length}b would upload ${dest}`);
    return "done";
  }
  const url = await uploadPublic(up.buffer, dest, up.mime);
  await prisma.providerMember.update({ where: { id: d.id }, data: { highResPhotoUrl: url } });
  console.log(`  [ok]  ${d.name}: ${srcBuf.length}b -> ${up.buffer.length}b -> ${dest}`);
  return "done";
}

async function main() {
  const where: any = {
    isPublicProfile: true,
    slug: { not: null },
    photoUrl: { not: null },
  };
  if (!FORCE) where.highResPhotoUrl = null;
  if (SLUG) where.slug = SLUG;

  const doctors = await prisma.providerMember.findMany({
    where,
    select: { id: true, slug: true, name: true, photoUrl: true },
    orderBy: { name: "asc" },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  console.log(`[upscale] ${doctors.length} doctor(s) to process (concurrency=${CONCURRENCY}${DRY_RUN ? ", DRY RUN" : ""}${FORCE ? ", FORCE" : ""})`);
  let done = 0, skip = 0, fail = 0, i = 0;
  for (let start = 0; start < doctors.length; start += CONCURRENCY) {
    const batch = doctors.slice(start, start + CONCURRENCY);
    const results = await Promise.all(batch.map((d) => processOne(d).catch(() => "fail" as const)));
    for (const r of results) { if (r === "done") done++; else if (r === "skip") skip++; else fail++; }
    i += batch.length;
    console.log(`[upscale] progress ${i}/${doctors.length} (ok=${done} skip=${skip} fail=${fail})`);
  }
  console.log(`[upscale] COMPLETE: ${done} upscaled, ${skip} skipped, ${fail} failed`);
  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); await pool.end(); process.exit(1); });
