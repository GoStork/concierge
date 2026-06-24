/**
 * AWS Rekognition look-alike face matching.
 *
 * One managed face collection holds every donor/surrogate face. Each indexed
 * face is tagged with an ExternalImageId of the form `${PREFIX}:${entityId}`
 * (PREFIX = EGGDONOR | SPERMDONOR | SURROGATE) so a search hit maps back to a
 * marketplace profile. The collection IS the index - there is no pgvector
 * column for faces.
 *
 * This module is framework-agnostic (plain functions + a lazy client) so it can
 * be imported by the MCP server (separate bundle), the profile-sync service,
 * and the backfill script alike.
 */
import {
  RekognitionClient,
  CreateCollectionCommand,
  DescribeCollectionCommand,
  DeleteCollectionCommand,
  IndexFacesCommand,
  SearchFacesByImageCommand,
  DeleteFacesCommand,
  QualityFilter,
} from "@aws-sdk/client-rekognition";
import sharp from "sharp";
import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { StorageService } from "../storage/storage.service";

export type FaceEntityType = "Egg Donor" | "Sperm Donor" | "Surrogate";

const TYPE_TO_PREFIX: Record<FaceEntityType, string> = {
  "Egg Donor": "EGGDONOR",
  "Sperm Donor": "SPERMDONOR",
  "Surrogate": "SURROGATE",
};
const PREFIX_TO_TYPE: Record<string, FaceEntityType> = {
  EGGDONOR: "Egg Donor",
  SPERMDONOR: "Sperm Donor",
  SURROGATE: "Surrogate",
};

const COLLECTION_ID = process.env.REKOGNITION_COLLECTION_ID || "gostork-donor-faces";

// Look-alike != identity. Same-person matching defaults to ~80%; for
// resemblance across different people we cast a wider net and rank, with a
// soft floor to drop noise. Tune from logged scores (see plan step 5).
const DEFAULT_MATCH_THRESHOLD = Number(process.env.REKOGNITION_FACE_THRESHOLD ?? 1);
const DEFAULT_SOFT_FLOOR = Number(process.env.REKOGNITION_FACE_SOFT_FLOOR ?? 0);

let _client: RekognitionClient | null = null;
let _storage: StorageService | null = null;

function client(): RekognitionClient {
  if (!_client) {
    _client = new RekognitionClient({
      region: process.env.AWS_REGION || "us-east-1",
      // Falls back to the standard AWS credential chain if these are unset.
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });
  }
  return _client;
}

function storage(): StorageService {
  if (!_storage) _storage = new StorageService();
  return _storage;
}

export function isFaceMatchingConfigured(): boolean {
  return !!(
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
    process.env.AWS_REGION // allow instance-role / shared-config credential chains
  );
}

export function externalImageId(type: FaceEntityType, id: string): string {
  return `${TYPE_TO_PREFIX[type]}:${id}`;
}

function parseExternalImageId(extId: string): { type: FaceEntityType; id: string } | null {
  const idx = extId.indexOf(":");
  if (idx < 0) return null;
  const prefix = extId.slice(0, idx);
  const id = extId.slice(idx + 1);
  const type = PREFIX_TO_TYPE[prefix];
  if (!type || !id) return null;
  return { type, id };
}

/** Idempotent - creates the collection if it does not already exist. */
export async function ensureCollection(): Promise<void> {
  try {
    await client().send(new DescribeCollectionCommand({ CollectionId: COLLECTION_ID }));
    return; // exists
  } catch (e: any) {
    if (e?.name !== "ResourceNotFoundException") throw e;
  }
  await client().send(new CreateCollectionCommand({ CollectionId: COLLECTION_ID }));
}

/** Delete the entire collection (used for a clean rebuild). Needs the
 * rekognition:DeleteCollection IAM permission. */
export async function deleteCollection(): Promise<void> {
  try {
    await client().send(new DeleteCollectionCommand({ CollectionId: COLLECTION_ID }));
  } catch (e: any) {
    if (e?.name !== "ResourceNotFoundException") throw e;
  }
}

export async function collectionFaceCount(): Promise<number> {
  const res = await client().send(new DescribeCollectionCommand({ CollectionId: COLLECTION_ID }));
  return res.FaceCount ?? 0;
}

/**
 * Fetch image bytes from a stored photo URL and normalize to a JPEG well under
 * Rekognition's 5MB Bytes limit. Returns null on any failure (caller decides
 * how to surface it - we never fabricate).
 */
export async function fetchImageBytes(url: string): Promise<Buffer | null> {
  try {
    let raw: Buffer | null = null;
    if (/^https?:\/\//i.test(url)) {
      // Private GCS object? Read it through the storage service (credentialed).
      const gcs = url.match(/storage\.googleapis\.com\/[^/]+\/(.+)$/);
      if (gcs && storage().isConfigured()) {
        try {
          const { buffer } = await storage().downloadObject(decodeURIComponent(gcs[1]));
          raw = buffer;
        } catch {
          /* fall through to anonymous fetch */
        }
      }
      if (!raw) {
        const res = await fetch(url);
        if (!res.ok) return null;
        raw = Buffer.from(await res.arrayBuffer());
      }
    } else {
      // Local /uploads/... path served from public/.
      const rel = url.startsWith("/") ? url.slice(1) : url;
      raw = await fs.readFile(path.join(process.cwd(), "public", rel));
    }
    if (!raw || raw.length === 0) return null;
    return await sharp(raw)
      .rotate() // honor EXIF orientation
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    return null;
  }
}

// Donors can carry 20-30 photos; for resemblance matching the primary headshot
// plus a couple of alternates is plenty. Indexing all of them is ~10x slower and
// costlier for no real gain (search dedupes by entity anyway).
const MAX_PHOTOS_PER_ENTITY = Number(process.env.REKOGNITION_MAX_PHOTOS_PER_ENTITY ?? 3);

/**
 * The distinct photo URLs we actually index for an entity: de-duplicated (the
 * scraper often repeats the primary photo into the photos[] array) then capped.
 * Deduping first means the cap selects DISTINCT images - better face coverage,
 * no duplicate face IDs, and no wasted re-indexing of the same image.
 */
function indexablePhotos(photoUrls: string[]): string[] {
  return [...new Set((photoUrls || []).filter(Boolean))].slice(0, MAX_PHOTOS_PER_ENTITY);
}

/**
 * Stable hash of the photos that would actually be indexed. Used to detect when
 * a donor's photos have changed so the sync hook can skip unchanged donors.
 */
export function photoSetHash(photoUrls: string[]): string {
  return createHash("sha1").update(indexablePhotos(photoUrls).join("\n")).digest("hex");
}

/**
 * Index up to MAX_PHOTOS_PER_ENTITY photos for one entity (primary first).
 * Returns the FaceIds Rekognition assigned (one image can yield zero faces -
 * those are skipped, not an error).
 */
export async function indexEntityPhotos(
  type: FaceEntityType,
  id: string,
  photoUrls: string[],
): Promise<string[]> {
  const faceIds: string[] = [];
  for (const url of indexablePhotos(photoUrls)) {
    if (!url) continue;
    const bytes = await fetchImageBytes(url);
    if (!bytes) continue;
    try {
      const res = await client().send(
        new IndexFacesCommand({
          CollectionId: COLLECTION_ID,
          ExternalImageId: externalImageId(type, id),
          Image: { Bytes: bytes },
          DetectionAttributes: [],
          MaxFaces: 1, // donor headshots: index the primary face only
          QualityFilter: QualityFilter.AUTO,
        }),
      );
      for (const rec of res.FaceRecords ?? []) {
        if (rec.Face?.FaceId) faceIds.push(rec.Face.FaceId);
      }
    } catch (e: any) {
      // Per-photo failure should not abort the whole entity.
      console.error(`[face] IndexFaces failed for ${type} ${id} (${url}):`, e?.message || e);
    }
  }
  return [...new Set(faceIds)];
}

export async function deleteEntityFaces(faceIds: string[]): Promise<void> {
  const ids = faceIds.filter(Boolean);
  if (ids.length === 0) return;
  // DeleteFaces accepts up to 4096 ids per call.
  for (let i = 0; i < ids.length; i += 1000) {
    await client().send(
      new DeleteFacesCommand({ CollectionId: COLLECTION_ID, FaceIds: ids.slice(i, i + 1000) }),
    );
  }
}

export interface LookAlikeMatch {
  entityType: FaceEntityType;
  entityId: string;
  similarity: number; // 0-100
}

export type FaceSearchResult =
  | { ok: true; matches: LookAlikeMatch[] }
  | { ok: false; reason: "no_face" | "error"; message: string };

/**
 * Search the collection for faces resembling the supplied image. Filters to the
 * requested entity types, dedupes by entity (best score wins), returns top N.
 */
export async function searchByImage(
  bytes: Buffer,
  opts: { types: FaceEntityType[]; limit?: number; threshold?: number; softFloor?: number },
): Promise<FaceSearchResult> {
  const wantPrefixes = new Set(opts.types.map((t) => TYPE_TO_PREFIX[t]));
  try {
    const res = await client().send(
      new SearchFacesByImageCommand({
        CollectionId: COLLECTION_ID,
        Image: { Bytes: bytes },
        // Pull a wide pool, then filter/dedupe/rank in code (coloring re-rank
        // needs enough same-color candidates, even at low geometry).
        MaxFaces: 200,
        FaceMatchThreshold: opts.threshold ?? DEFAULT_MATCH_THRESHOLD,
        QualityFilter: QualityFilter.AUTO,
      }),
    );
    const floor = opts.softFloor ?? DEFAULT_SOFT_FLOOR;
    const bestByEntity = new Map<string, LookAlikeMatch>();
    for (const m of res.FaceMatches ?? []) {
      const extId = m.Face?.ExternalImageId;
      const sim = m.Similarity ?? 0;
      if (!extId || sim < floor) continue;
      const parsed = parseExternalImageId(extId);
      if (!parsed) continue;
      if (!wantPrefixes.has(TYPE_TO_PREFIX[parsed.type])) continue;
      const key = `${parsed.type}:${parsed.id}`;
      const existing = bestByEntity.get(key);
      if (!existing || sim > existing.similarity) {
        bestByEntity.set(key, { entityType: parsed.type, entityId: parsed.id, similarity: sim });
      }
    }
    const matches = Array.from(bestByEntity.values())
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, Math.min(opts.limit ?? 3, 200));
    return { ok: true, matches };
  } catch (e: any) {
    // Rekognition throws InvalidParameterException when it finds no face.
    if (e?.name === "InvalidParameterException") {
      return { ok: false, reason: "no_face", message: "No face detected in the uploaded image." };
    }
    console.error("[face] SearchFacesByImage failed:", e?.message || e);
    return { ok: false, reason: "error", message: e?.message || "Face search failed." };
  }
}
