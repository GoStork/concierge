/**
 * Recognising one picture stored twice.
 *
 * A profile's photos come from the agency, and agencies routinely carry the
 * same picture more than once - a 768x512 upload and a 1500x1000 upload of the
 * identical shot, or the primary headshot repeated into the gallery list. The
 * cheap defences we already have only catch the easy half of that:
 *
 *   - persisted objects are named after the md5 of their bytes, so two source
 *     URLs serving IDENTICAL bytes converge on one GCS URL, and
 *   - the galleries de-duplicate by URL string.
 *
 * Neither sees two encodings of one photo, because the bytes differ. That is
 * what this module is for: a 64-bit dHash per stored photo, compared inside a
 * single profile, keeping the largest copy and dropping the rest.
 *
 * Two deliberate conservatisms, because a false positive deletes a real photo
 * from someone's profile:
 *   - a photo we could not fingerprint is never dropped, and
 *   - the distance threshold is tight (near-identical, not merely similar).
 */
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import type { PrismaService } from "../prisma/prisma.service";
import type { StorageService } from "../storage/storage.service";

/**
 * Maximum Hamming distance (out of 64) at which two photos are called the same
 * picture. A resize of one image scores 0-2; genuinely different photos of the
 * same scene sit well above this. Raising it trades missed duplicates for
 * deleted photos, so it stays low.
 */
export const DEDUP_DISTANCE = Number(process.env.PHOTO_DEDUP_DISTANCE ?? 4);

const FINGERPRINT_CONCURRENCY = Number(process.env.PHOTO_FINGERPRINT_CONCURRENCY ?? 6);
const FAILED_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;
const UPLOADS_DIR = path.resolve(process.cwd(), "public/uploads");

export type Fingerprint = {
  url: string;
  phash: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  failed: boolean;
};

/**
 * dHash: downscale to 9x8 greyscale, then take one bit per horizontal
 * neighbour pair (is this pixel brighter than the next?). 8 rows x 8
 * comparisons = 64 bits, rendered as 16 hex chars.
 *
 * Chosen over an average hash because it keys on gradients rather than
 * absolute brightness, so it survives the re-compression and slight exposure
 * shifts you get when the same photo is uploaded through two different tools.
 */
export async function computeDHash(buffer: Buffer): Promise<string | null> {
  try {
    const raw = await sharp(buffer, { failOn: "none" })
      .greyscale()
      .resize(9, 8, { fit: "fill" })
      .raw()
      .toBuffer();
    if (raw.length < 72) return null;
    let hex = "";
    let nibble = 0;
    let bitsInNibble = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const bit = raw[y * 9 + x] > raw[y * 9 + x + 1] ? 1 : 0;
        nibble = (nibble << 1) | bit;
        if (++bitsInNibble === 4) {
          hex += nibble.toString(16);
          nibble = 0;
          bitsInNibble = 0;
        }
      }
    }
    return hex.length === 16 ? hex : null;
  } catch {
    return null;
  }
}

/** Fingerprint image bytes: perceptual hash plus the dimensions we rank by. */
export async function fingerprintBuffer(
  buffer: Buffer,
): Promise<{ phash: string | null; width: number | null; height: number | null; bytes: number }> {
  const phash = await computeDHash(buffer);
  let width: number | null = null;
  let height: number | null = null;
  try {
    const meta = await sharp(buffer, { failOn: "none" }).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
  } catch {
    /* dimensions are a ranking hint, not a requirement */
  }
  return { phash, width, height, bytes: buffer.length };
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** The object path inside our bucket, for a URL we persisted there. */
function gcsObjectPath(url: string): string | null {
  const m = url.match(/^https?:\/\/storage\.googleapis\.com\/[^/]+\/(.+)$/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1].split("?")[0]);
  } catch {
    return m[1].split("?")[0];
  }
}

/**
 * Read the bytes behind a stored photo. The bucket is private, so persisted
 * photos are read through the storage service rather than their public-looking
 * URL; local /uploads/ paths and (for the backfill) plain remote URLs are
 * handled too.
 */
async function readPhotoBytes(url: string, storage: StorageService | null): Promise<Buffer | null> {
  const objectPath = gcsObjectPath(url);
  if (objectPath) {
    if (!storage?.isConfigured()) return null;
    try {
      const { buffer } = await storage.downloadObject(objectPath);
      return buffer;
    } catch {
      return null;
    }
  }
  if (url.startsWith("/uploads/")) {
    try {
      const p = path.join(UPLOADS_DIR, url.replace(/^\/uploads\//, ""));
      return fs.existsSync(p) ? fs.readFileSync(p) : null;
    } catch {
      return null;
    }
  }
  if (/^https?:\/\//i.test(url)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!resp.ok) return null;
      return Buffer.from(await resp.arrayBuffer());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Fingerprints for these URLs, computing and caching any we do not have yet.
 * Cached rows (including previous failures) are returned as-is, so a profile
 * whose photos have not changed costs one indexed query and no downloads.
 */
export async function ensureFingerprints(
  prisma: PrismaService,
  urls: string[],
  storage: StorageService | null,
  opts: { refresh?: boolean } = {},
): Promise<Map<string, Fingerprint>> {
  const distinct = Array.from(new Set(urls.filter((u) => typeof u === "string" && u.length > 0)));
  const out = new Map<string, Fingerprint>();
  if (distinct.length === 0) return out;

  if (!opts.refresh) {
    const rows = await prisma.photoFingerprint.findMany({ where: { url: { in: distinct } } });
    const retryFailedBefore = Date.now() - FAILED_RETRY_AFTER_MS;
    for (const row of rows) {
      // A failure is usually permanent (an expired source link, an image sharp
      // cannot decode), but it can also be a bad minute for storage. Let an old
      // failure be retried rather than blinding dedup to that photo forever.
      if (row.failed && row.updatedAt.getTime() < retryFailedBefore) continue;
      out.set(row.url, {
        url: row.url,
        phash: row.phash,
        width: row.width,
        height: row.height,
        bytes: row.bytes,
        failed: row.failed,
      });
    }
  }

  const missing = distinct.filter((u) => !out.has(u));
  if (missing.length === 0) return out;

  let cursor = 0;
  const worker = async () => {
    while (cursor < missing.length) {
      const url = missing[cursor++];
      const buffer = await readPhotoBytes(url, storage);
      const fp = buffer ? await fingerprintBuffer(buffer) : null;
      const record: Fingerprint = {
        url,
        phash: fp?.phash ?? null,
        width: fp?.width ?? null,
        height: fp?.height ?? null,
        bytes: fp?.bytes ?? null,
        failed: !fp?.phash,
      };
      out.set(url, record);
      try {
        const data = {
          phash: record.phash,
          width: record.width,
          height: record.height,
          bytes: record.bytes,
          failed: record.failed,
        };
        await prisma.photoFingerprint.upsert({ where: { url }, create: { url, ...data }, update: data });
      } catch {
        /* the cache is an optimisation; a write failure must not break a sync */
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FINGERPRINT_CONCURRENCY, missing.length) }, () => worker()),
  );
  return out;
}

export type DedupePlan = {
  /** The photos to keep, in their original order. */
  keep: string[];
  /** Dropped URL -> the URL kept in its place (empty for exact repeats). */
  replacements: Map<string, string>;
  exactRepeats: number;
  nearDuplicates: number;
};

const area = (fp: Fingerprint | undefined): number =>
  fp && fp.width && fp.height ? fp.width * fp.height : fp?.bytes ?? 0;

/**
 * Decide which of a profile's photos to keep. Order is preserved and each
 * duplicate group keeps its EARLIEST position, so de-duplicating never
 * reshuffles a gallery - the winner simply takes the loser's place when it is
 * the larger copy of a photo that appeared earlier.
 */
export function planDedupe(
  urls: string[],
  fingerprints: Map<string, Fingerprint>,
  distance: number = DEDUP_DISTANCE,
): DedupePlan {
  const keep: string[] = [];
  const replacements = new Map<string, string>();
  let exactRepeats = 0;
  let nearDuplicates = 0;

  for (const url of urls) {
    if (typeof url !== "string" || !url) continue;
    if (keep.includes(url)) {
      exactRepeats++;
      continue;
    }
    const fp = fingerprints.get(url);
    if (!fp?.phash) {
      // Unknown or unreadable: keep it. Never drop a photo we cannot compare.
      keep.push(url);
      continue;
    }
    const matchIdx = keep.findIndex((k) => {
      const other = fingerprints.get(k);
      return !!other?.phash && hammingDistance(fp.phash!, other.phash) <= distance;
    });
    if (matchIdx === -1) {
      keep.push(url);
      continue;
    }
    nearDuplicates++;
    const incumbent = keep[matchIdx];
    if (area(fp) > area(fingerprints.get(incumbent))) {
      // Bigger copy wins, but inherits the incumbent's slot.
      keep[matchIdx] = url;
      replacements.set(incumbent, url);
      // Anything already pointed at the incumbent now points at its replacement,
      // so a chain of copies still resolves to the one photo we kept.
      Array.from(replacements.entries()).forEach(([dropped, kept]) => {
        if (kept === incumbent) replacements.set(dropped, url);
      });
    } else {
      replacements.set(url, incumbent);
    }
  }

  return { keep, replacements, exactRepeats, nearDuplicates };
}

export type EntityPhotoFields = {
  photoUrl?: string | null;
  photos?: string[] | null;
  additionalPhotos?: string[] | null;
  photoCount?: number | null;
  profileData?: any;
};

/**
 * De-duplicate one profile's photos in place, across every list that feeds the
 * gallery, and repoint photoUrl when the hero turns out to be the smaller copy
 * of a photo we kept at a higher resolution.
 *
 * Returns how many photos were dropped (0 when there was nothing to do), and
 * fails open: any error leaves the entity exactly as it was.
 */
export async function dedupeEntityPhotos(
  prisma: PrismaService,
  entity: EntityPhotoFields,
  storage: StorageService | null,
): Promise<{ dropped: number; heroRepointed: boolean }> {
  try {
    const pd = entity.profileData && typeof entity.profileData === "object" ? entity.profileData : null;
    const sections = pd && typeof pd["_sections"] === "object" && pd["_sections"] ? pd["_sections"] : null;
    const lists: Array<{ get: () => any; set: (v: string[]) => void }> = [
      { get: () => entity.photos, set: (v) => { entity.photos = v; } },
      { get: () => entity.additionalPhotos, set: (v) => { entity.additionalPhotos = v; } },
    ];
    if (pd) {
      for (const key of ["All Photos", "Photos"]) {
        lists.push({ get: () => pd[key], set: (v) => { pd[key] = v; } });
      }
    }
    if (sections) {
      lists.push({ get: () => sections["Photos"], set: (v) => { sections["Photos"] = v; } });
    }

    // Only photos we already hold. Anything still on an agency host is left
    // un-fingerprinted (and therefore never dropped) rather than having a sync
    // fetch from their servers just to compare pictures.
    const ours = (u: string) => /storage\.googleapis\.com/i.test(u) || u.startsWith("/uploads/");
    const candidates: string[] = [];
    if (entity.photoUrl) candidates.push(entity.photoUrl);
    for (const list of lists) {
      const val = list.get();
      if (Array.isArray(val)) candidates.push(...val.filter((v: any) => typeof v === "string" && v));
    }
    if (candidates.length < 2) return { dropped: 0, heroRepointed: false };

    const fingerprints = await ensureFingerprints(prisma, candidates.filter(ours), storage);

    let dropped = 0;
    let replacements = new Map<string, string>();
    for (const list of lists) {
      const val = list.get();
      if (!Array.isArray(val) || val.length < 2) continue;
      const plan = planDedupe(val.filter((v: any) => typeof v === "string" && v), fingerprints);
      if (plan.keep.length === val.length) continue;
      dropped += val.length - plan.keep.length;
      list.set(plan.keep);
      plan.replacements.forEach((kept, droppedUrl) => replacements.set(droppedUrl, kept));
    }

    let heroRepointed = false;
    if (entity.photoUrl && replacements.has(entity.photoUrl)) {
      entity.photoUrl = replacements.get(entity.photoUrl)!;
      heroRepointed = true;
    }
    if (typeof entity.photoCount === "number" && Array.isArray(entity.photos)) {
      entity.photoCount = entity.photos.length;
    }
    return { dropped, heroRepointed };
  } catch {
    return { dropped: 0, heroRepointed: false };
  }
}
