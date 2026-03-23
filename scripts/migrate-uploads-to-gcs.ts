/**
 * One-time script to migrate /uploads/ photos from local disk to GCS
 * and update all DB references.
 *
 * Usage: npx tsx scripts/migrate-uploads-to-gcs.ts
 */
import "dotenv/config";
import { Storage } from "@google-cloud/storage";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import * as fs from "fs";
import * as path from "path";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const keyJson = process.env.GCS_SERVICE_ACCOUNT_KEY;
if (!keyJson) {
  console.error("GCS_SERVICE_ACCOUNT_KEY not set");
  process.exit(1);
}
const credentials = JSON.parse(keyJson);
const storage = new Storage({ credentials });
const bucketName = process.env.GCS_BUCKET_NAME || "gostork-recordings";
const bucket = storage.bucket(bucketName);
const UPLOADS_DIR = path.resolve(process.cwd(), "public/uploads");

async function uploadToGcs(localFilename: string): Promise<string | null> {
  const localPath = path.join(UPLOADS_DIR, localFilename);
  if (!fs.existsSync(localPath)) {
    console.warn(`  File not found locally: ${localFilename}`);
    return null;
  }
  const buffer = fs.readFileSync(localPath);
  const ext = path.extname(localFilename).toLowerCase();
  const ct = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".svg" ? "image/svg+xml" : "image/jpeg";
  const gcsPath = `uploads/${localFilename}`;
  const file = bucket.file(gcsPath);
  await file.save(buffer, { contentType: ct });
  const url = `https://storage.googleapis.com/${bucketName}/${gcsPath}`;
  console.log(`  Uploaded ${localFilename} → ${url}`);
  return url;
}

async function migrateField(
  model: string,
  idField: string,
  urlField: string,
  findMany: () => Promise<any[]>,
  update: (id: string, url: string) => Promise<void>,
) {
  const records = await findMany();
  if (records.length === 0) return;
  console.log(`\n${model}.${urlField}: ${records.length} records to migrate`);
  for (const rec of records) {
    const localUrl: string = rec[urlField];
    const filename = localUrl.replace(/^\/uploads\//, "");
    const gcsUrl = await uploadToGcs(filename);
    if (gcsUrl) {
      await update(rec[idField], gcsUrl);
      console.log(`  Updated ${model} ${rec[idField]}`);
    }
  }
}

async function migrateArrayField(
  model: string,
  idField: string,
  arrayField: string,
  findMany: () => Promise<any[]>,
  update: (id: string, urls: string[]) => Promise<void>,
) {
  const records = await findMany();
  if (records.length === 0) return;
  console.log(`\n${model}.${arrayField}: ${records.length} records to migrate`);
  for (const rec of records) {
    const oldUrls: string[] = rec[arrayField];
    const newUrls: string[] = [];
    for (const url of oldUrls) {
      if (url.startsWith("/uploads/")) {
        const filename = url.replace(/^\/uploads\//, "");
        const gcsUrl = await uploadToGcs(filename);
        newUrls.push(gcsUrl || url);
      } else {
        newUrls.push(url);
      }
    }
    await update(rec[idField], newUrls);
    console.log(`  Updated ${model} ${rec[idField]} (${newUrls.length} photos)`);
  }
}

async function main() {
  console.log("=== Migrating /uploads/ references to GCS ===\n");

  // User.photoUrl
  await migrateField("User", "id", "photoUrl",
    () => prisma.user.findMany({ where: { photoUrl: { startsWith: "/uploads/" } }, select: { id: true, photoUrl: true } }),
    (id, url) => prisma.user.update({ where: { id }, data: { photoUrl: url } }).then(() => {}),
  );

  // Provider.logoUrl
  await migrateField("Provider", "id", "logoUrl",
    () => prisma.provider.findMany({ where: { logoUrl: { startsWith: "/uploads/" } }, select: { id: true, logoUrl: true } }),
    (id, url) => prisma.provider.update({ where: { id }, data: { logoUrl: url } }).then(() => {}),
  );

  // ProviderMember.photoUrl
  await migrateField("ProviderMember", "id", "photoUrl",
    () => prisma.providerMember.findMany({ where: { photoUrl: { startsWith: "/uploads/" } }, select: { id: true, photoUrl: true } }),
    (id, url) => prisma.providerMember.update({ where: { id }, data: { photoUrl: url } }).then(() => {}),
  );

  // Matchmaker.avatarUrl
  await migrateField("Matchmaker", "id", "avatarUrl",
    () => prisma.matchmaker.findMany({ where: { avatarUrl: { startsWith: "/uploads/" } }, select: { id: true, avatarUrl: true } }),
    (id, url) => prisma.matchmaker.update({ where: { id }, data: { avatarUrl: url } }).then(() => {}),
  );

  // SiteSettings — multiple URL fields
  const siteSettings = await prisma.siteSettings.findMany({ select: { id: true, logoUrl: true, darkLogoUrl: true, faviconUrl: true, logoWithNameUrl: true, darkLogoWithNameUrl: true } });
  for (const ss of siteSettings) {
    const updates: Record<string, string> = {};
    for (const field of ["logoUrl", "darkLogoUrl", "faviconUrl", "logoWithNameUrl", "darkLogoWithNameUrl"] as const) {
      const val = (ss as any)[field];
      if (val && val.startsWith("/uploads/")) {
        const filename = val.replace(/^\/uploads\//, "");
        const gcsUrl = await uploadToGcs(filename);
        if (gcsUrl) updates[field] = gcsUrl;
      }
    }
    if (Object.keys(updates).length > 0) {
      await prisma.siteSettings.update({ where: { id: ss.id }, data: updates });
      console.log(`  Updated SiteSettings ${ss.id}: ${Object.keys(updates).join(", ")}`);
    }
  }

  // ProviderBrandSettings — same fields
  const brandSettings = await prisma.providerBrandSettings.findMany({ select: { id: true, logoUrl: true, darkLogoUrl: true, faviconUrl: true, logoWithNameUrl: true, darkLogoWithNameUrl: true } });
  for (const bs of brandSettings) {
    const updates: Record<string, string> = {};
    for (const field of ["logoUrl", "darkLogoUrl", "faviconUrl", "logoWithNameUrl", "darkLogoWithNameUrl"] as const) {
      const val = (bs as any)[field];
      if (val && val.startsWith("/uploads/")) {
        const filename = val.replace(/^\/uploads\//, "");
        const gcsUrl = await uploadToGcs(filename);
        if (gcsUrl) updates[field] = gcsUrl;
      }
    }
    if (Object.keys(updates).length > 0) {
      await prisma.providerBrandSettings.update({ where: { id: bs.id }, data: updates });
      console.log(`  Updated ProviderBrandSettings ${bs.id}: ${Object.keys(updates).join(", ")}`);
    }
  }

  // EggDonor.photoUrl + photos[]
  await migrateField("EggDonor", "id", "photoUrl",
    () => prisma.eggDonor.findMany({ where: { photoUrl: { startsWith: "/uploads/" } }, select: { id: true, photoUrl: true } }),
    (id, url) => prisma.eggDonor.update({ where: { id }, data: { photoUrl: url } }).then(() => {}),
  );
  await migrateArrayField("EggDonor", "id", "photos",
    () => prisma.eggDonor.findMany({ where: { photos: { hasSome: [] } }, select: { id: true, photos: true } }).then(rows => rows.filter(r => r.photos.some((p: string) => p.startsWith("/uploads/")))),
    (id, urls) => prisma.eggDonor.update({ where: { id }, data: { photos: urls } }).then(() => {}),
  );

  // Surrogate.photoUrl + photos[]
  await migrateField("Surrogate", "id", "photoUrl",
    () => prisma.surrogate.findMany({ where: { photoUrl: { startsWith: "/uploads/" } }, select: { id: true, photoUrl: true } }),
    (id, url) => prisma.surrogate.update({ where: { id }, data: { photoUrl: url } }).then(() => {}),
  );
  await migrateArrayField("Surrogate", "id", "photos",
    () => prisma.surrogate.findMany({ where: { photos: { hasSome: [] } }, select: { id: true, photos: true } }).then(rows => rows.filter(r => r.photos.some((p: string) => p.startsWith("/uploads/")))),
    (id, urls) => prisma.surrogate.update({ where: { id }, data: { photos: urls } }).then(() => {}),
  );

  // SpermDonor.photoUrl + photos[]
  await migrateField("SpermDonor", "id", "photoUrl",
    () => prisma.spermDonor.findMany({ where: { photoUrl: { startsWith: "/uploads/" } }, select: { id: true, photoUrl: true } }),
    (id, url) => prisma.spermDonor.update({ where: { id }, data: { photoUrl: url } }).then(() => {}),
  );
  await migrateArrayField("SpermDonor", "id", "photos",
    () => prisma.spermDonor.findMany({ where: { photos: { hasSome: [] } }, select: { id: true, photos: true } }).then(rows => rows.filter(r => r.photos.some((p: string) => p.startsWith("/uploads/")))),
    (id, urls) => prisma.spermDonor.update({ where: { id }, data: { photos: urls } }).then(() => {}),
  );

  console.log("\n=== Migration complete ===");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  prisma.$disconnect();
  process.exit(1);
});
