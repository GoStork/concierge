/**
 * Shared doctor-photo upscaling pass.
 *
 * Finds public doctors that have a photoUrl but no highResPhotoUrl, downloads
 * each original from GCS, runs it through the faithful upscaler (photo-upscale.ts),
 * uploads the crisp result to profile-photos-hires/, and sets highResPhotoUrl.
 *
 * Dependency-injected (downloadObject / uploadPublic / prisma) so it runs from
 * BOTH the standalone backfill script (raw @google-cloud/storage client) and the
 * clinic-enrichment service (StorageService) without forking the logic.
 *
 * Idempotent + non-destructive: skips doctors that already have a highResPhotoUrl
 * (unless force), and never touches the original photoUrl. Safe to re-run.
 */

import crypto from "crypto";
import { upscaleImageBuffer } from "./photo-upscale";

export interface UpscaleDeps {
  prisma: any;
  bucketName: string;
  downloadObject: (objectPath: string) => Promise<{ buffer: Buffer; contentType: string }>;
  uploadPublic: (buffer: Buffer, destPath: string, contentType: string) => Promise<string>;
  log?: (msg: string) => void;
}

export interface UpscaleOpts {
  limit?: number;
  slug?: string;
  force?: boolean;
  /** Restrict to doctors at these clinics (e.g. just-enriched providers). */
  providerIds?: string[];
  concurrency?: number;
  dryRun?: boolean;
}

export interface UpscaleResult {
  done: number;
  skip: number;
  fail: number;
  total: number;
}

// Pull the object path ("profile-photos/<hash>.png") out of a stored GCS URL.
function objectPathOf(url: string, bucketName: string): string | null {
  const marker = `storage.googleapis.com/${bucketName}/`;
  const i = url.indexOf(marker);
  if (i === -1) return null;
  return url.slice(i + marker.length);
}

export async function upscaleMissingDoctorPhotos(deps: UpscaleDeps, opts: UpscaleOpts = {}): Promise<UpscaleResult> {
  const { prisma, bucketName, downloadObject, uploadPublic } = deps;
  const log = deps.log || (() => {});
  const concurrency = Math.max(1, opts.concurrency ?? 3);

  const where: any = {
    isPublicProfile: true,
    slug: { not: null },
    photoUrl: { not: null },
  };
  if (!opts.force) where.highResPhotoUrl = null;
  if (opts.slug) where.slug = opts.slug;
  if (opts.providerIds && opts.providerIds.length) where.providerId = { in: opts.providerIds };

  const doctors = await prisma.providerMember.findMany({
    where,
    select: { id: true, slug: true, name: true, photoUrl: true },
    orderBy: { name: "asc" },
    ...(opts.limit ? { take: opts.limit } : {}),
  });

  let done = 0, skip = 0, fail = 0;

  const processOne = async (d: { id: string; name: string; photoUrl: string | null }): Promise<"done" | "skip" | "fail"> => {
    if (!d.photoUrl) return "skip";
    const objPath = objectPathOf(d.photoUrl, bucketName);
    if (!objPath) return "skip"; // non-GCS photoUrl - nothing to upscale
    let srcBuf: Buffer;
    let mime: string;
    try {
      const r = await downloadObject(objPath);
      srcBuf = r.buffer;
      mime = r.contentType;
    } catch {
      return "fail";
    }
    if (srcBuf.length < 1024) return "skip"; // broken/placeholder
    const up = await upscaleImageBuffer(srcBuf, mime);
    if (!up) return "fail";
    if (opts.dryRun) return "done";
    const hash = crypto.createHash("md5").update(up.buffer).digest("hex");
    const ext = up.mime.includes("png") ? ".png" : up.mime.includes("webp") ? ".webp" : ".jpg";
    const url = await uploadPublic(up.buffer, `profile-photos-hires/${hash}${ext}`, up.mime);
    await prisma.providerMember.update({ where: { id: d.id }, data: { highResPhotoUrl: url } });
    return "done";
  };

  log(`[upscale] ${doctors.length} doctor(s) to process (concurrency=${concurrency}${opts.dryRun ? ", DRY RUN" : ""}${opts.force ? ", FORCE" : ""})`);
  for (let i = 0; i < doctors.length; i += concurrency) {
    const batch = doctors.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((d: any) => processOne(d).catch(() => "fail" as const)));
    for (const r of results) { if (r === "done") done++; else if (r === "skip") skip++; else fail++; }
    log(`[upscale] progress ${Math.min(i + concurrency, doctors.length)}/${doctors.length} (ok=${done} skip=${skip} fail=${fail})`);
  }
  return { done, skip, fail, total: doctors.length };
}
