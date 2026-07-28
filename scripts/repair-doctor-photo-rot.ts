/**
 * Repair link-rot in ProviderMember.photoUrl.
 *
 * Most doctor headshots are already mirrored into our own GCS bucket
 * (https://storage.googleapis.com/gostork-recordings/profile-photos/...) by the
 * scraper. A long tail of rows still hotlinks the clinic's own website. Those
 * rot: Aaron Styer's CCRM URL started returning 404 and his profile page
 * rendered a broken image.
 *
 * For every ProviderMember whose photoUrl is NOT a gostork GCS URL:
 *
 *   1. BOGUS values are dropped without a fetch (see classifyBogus): non-URL
 *      garbage, site placeholder assets, and files that belong to a DIFFERENT
 *      doctor. Mirroring those would just make the wrong face permanent.
 *   2. The rest are probed for liveness with the same request the image proxy
 *      (`GET /api/uploads/proxy`) makes, because that proxy is what actually
 *      renders the photo in the UI - if it can't fetch the URL, the user sees a
 *      broken image regardless of what curl says.
 *   3. ALIVE -> mirrored into gostork-recordings/profile-photos via the
 *      scraper's own persistSinglePhoto(), and photoUrl is repointed at GCS.
 *   4. DEAD (and BOGUS) -> adopt the working GCS mirror of the same human on
 *      another clinic's roster when one exists (doctors are commonly listed at
 *      several clinics, linked by personKey), otherwise NULL so the profile
 *      falls back to the DoctorAvatar monogram.
 *   5. INDETERMINATE (429 / 5xx / timeout) -> left completely untouched. A
 *      rate-limited host is not a dead link, and nulling on a 429 would wipe
 *      good photos wholesale: iflg.net alone throttles ~30 rows in one pass.
 *
 * Two things worth knowing before editing this:
 *   - gostork-recordings is a PRIVATE bucket. An anonymous HEAD on a
 *     storage.googleapis.com URL answers 403 for every object we own, so a GCS
 *     mirror's liveness must be asked through StorageService.objectExists().
 *     The client never hits those URLs directly either; getPhotoSrc() routes
 *     them through /api/uploads/gcs.
 *   - Some stored URLs still carry raw HTML entities ("&amp;") from the
 *     scraper. Those 400 at the origin until decoded, which reads as "dead".
 *
 *   npx tsx -r dotenv/config scripts/repair-doctor-photo-rot.ts            # dry run
 *   npx tsx -r dotenv/config scripts/repair-doctor-photo-rot.ts --apply
 *   npx tsx -r dotenv/config scripts/repair-doctor-photo-rot.ts --apply --concurrency=6
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { StorageService } from "../server/src/modules/storage/storage.service";
import { persistSinglePhoto } from "../server/src/modules/providers/profile-sync.service";
import { normalizeName } from "../server/src/modules/providers/clinic-enrichment.service";

const APPLY = process.argv.includes("--apply");
const CONCURRENCY = (() => {
  const m = process.argv.find((a) => a.startsWith("--concurrency="));
  return m ? Math.max(1, parseInt(m.split("=")[1], 10) || 4) : 4;
})();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const storage = new StorageService();

type Row = {
  id: string;
  providerId: string;
  name: string;
  personKey: string | null;
  photoUrl: string | null;
};

const isGcs = (u?: string | null) =>
  !!u && /storage\.googleapis\.com/i.test(u) && /gostork/i.test(u);

// ---------------------------------------------------------------------------
// Liveness probe - mirrors GET /api/uploads/proxy (uploads.controller.ts)
// ---------------------------------------------------------------------------

// Same headers/timeout the proxy uses, so "alive" here means "the UI can
// actually render it". HEAD first to avoid pulling megabytes for a yes/no, but
// plenty of WordPress/CDN hosts answer HEAD with 403/405 while serving GET
// fine, so any non-2xx HEAD falls through to a real GET.
const PROXY_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (compatible; GoStork/1.0)",
  Accept: "image/*",
};
const PROXY_TIMEOUT_MS = 10000;

type Verdict = "alive" | "dead" | "indeterminate";

// 429 and 5xx mean "ask again later", never "this photo is gone". Timeouts and
// socket resets are the same class. Everything else (404/401/403/400, a soft-404
// HTML body) is a real verdict.
function verdictForStatus(status: number): Verdict {
  if (status === 429 || status >= 500) return "indeterminate";
  return "dead";
}

// Stored URLs occasionally contain HTML entities the scraper never decoded
// ("...?width=600&amp;height=900"), which the origin rejects with a 400. Decode
// before probing, and mirror/store the decoded form.
function decodeStoredUrl(url: string): string {
  return url
    .replace(/&amp;/g, "&")
    .replace(/&#0?38;/g, "&")
    .replace(/&quot;/g, '"')
    .trim();
}

async function probeOnce(url: string): Promise<{ verdict: Verdict; detail: string }> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const resp = await fetch(url, {
        method,
        headers: PROXY_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
      // Drain GET bodies so the socket is released promptly.
      if (method === "GET") await resp.arrayBuffer().catch(() => undefined);
      if (resp.ok) {
        const ct = resp.headers.get("content-type") || "";
        // An HTML body on an image URL is a soft-404 landing page, not a photo.
        if (/^text\/html/i.test(ct)) return { verdict: "dead", detail: `soft-404 (${ct})` };
        return { verdict: "alive", detail: `${method} ${resp.status}` };
      }
      // A HEAD that comes back 429/5xx is already conclusive enough to back off;
      // repeating it as a GET just spends another request against the limiter.
      const v = verdictForStatus(resp.status);
      if (v === "indeterminate" || method === "GET") {
        const ra = resp.headers.get("retry-after");
        return { verdict: v, detail: `HTTP ${resp.status}${ra ? ` (retry-after=${ra})` : ""}` };
      }
    } catch (err: any) {
      if (method === "GET") return { verdict: "indeterminate", detail: err?.message || String(err) };
    }
  }
  return { verdict: "indeterminate", detail: "unreachable" };
}

// Hosts are probed one request at a time with a small gap. Fanning 30 parallel
// requests at one WordPress site is what produced the 429 wall in the first
// place - the throttle was self-inflicted.
const HOST_GAP_MS = 750;
const hostChain = new Map<string, Promise<unknown>>();

function onHost<T>(url: string, fn: () => Promise<T>): Promise<T> {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    return fn();
  }
  const prev = hostChain.get(host) || Promise.resolve();
  const next = prev.then(async () => {
    const out = await fn();
    await new Promise((r) => setTimeout(r, HOST_GAP_MS));
    return out;
  });
  hostChain.set(host, next.catch(() => undefined));
  return next as Promise<T>;
}

const RETRY_BACKOFF_MS = [5000, 20000, 60000];

async function probe(url: string): Promise<{ verdict: Verdict; detail: string }> {
  let last = { verdict: "indeterminate" as Verdict, detail: "unreachable" };
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    last = await onHost(url, () => probeOnce(url));
    if (last.verdict !== "indeterminate") return last;
    if (attempt === RETRY_BACKOFF_MS.length) break;
    const ra = last.detail.match(/retry-after=(\d+)/i);
    const waitMs = Math.max(RETRY_BACKOFF_MS[attempt], ra ? parseInt(ra[1], 10) * 1000 : 0);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return last;
}

// ---------------------------------------------------------------------------
// Bogus-value detection
// ---------------------------------------------------------------------------

// Path words that carry no identity - they must never be read as somebody's
// name, or "wp-content/uploads/.../hero.jpg" starts matching people.
const PATH_STOPWORDS = new Set([
  "content", "uploads", "upload", "wp", "sites", "assets", "images", "image", "img",
  "photo", "photos", "headshot", "headshots", "media", "files", "file", "thumb",
  "thumbnail", "thumbs", "static", "public", "cdn", "gateway", "api", "final",
  "website", "web", "hero", "main", "circle", "square", "round", "gold", "new",
  "edited", "edit", "scaled", "crop", "cropped", "resized", "large", "small",
  "medium", "team", "staff", "doctor", "doctors", "dr", "our", "about", "profile",
  "profiles", "bio", "portrait", "business", "quality", "auto", "default", "png",
  "jpg", "jpeg", "webp", "gif", "avif", "filters", "upscale", "no",
]);

// Obvious non-photos: framework placeholders and board-certification badges
// that some clinic sites drop into the <img> slot when a doctor has no picture.
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\/soliloquy\//i,
  /\bholder\.(gif|png|jpe?g)$/i,
  /\bplaceholder\b/i,
  /\bno[-_]?(photo|image|avatar)\b/i,
  /\bdefault[-_]?(photo|image|avatar|user)\b/i,
  /\bblank\.(gif|png|jpe?g)$/i,
  /\bspacer\.(gif|png)$/i,
  /\babog\.(png|jpe?g)$/i,
];

// Filenames that announce they are not a headshot. Barry Ripps' row pointed at
// "LittleCarla-Baby-Railey-Ann2-...jpg" - a live URL, so probing alone would
// have happily mirrored a photo of somebody's baby onto a doctor's profile.
const NOT_A_HEADSHOT_TOKENS = new Set([
  "baby", "babies", "newborn", "logo", "banner", "building", "exterior",
  "office", "lobby", "clinic", "map", "icon", "award", "badge", "brochure",
]);

// Tokens from the URL path that could plausibly be a person's name.
function pathNameTokens(url: string): string[] {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return [];
  }
  return decodeURIComponent(pathname)
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 4 && !PATH_STOPWORDS.has(t));
}

function ownNameTokens(name: string): Set<string> {
  return new Set(
    normalizeName(name)
      .split(/[^a-z]+/)
      .filter((t) => t.length >= 3),
  );
}

type Bogus = { reason: string } | null;

function classifyBogus(
  row: Row,
  url: string,
  sharedUrlNames: Map<string, Set<string>>,
  nameTokenOwners: Map<string, string[]>,
): Bogus {
  // 1. Not a URL at all. The three "i:true/qt=q:1/ll=n:true" rows are a
  //    scraper reading an image-optimizer query fragment as the src.
  if (!/^https?:\/\//i.test(url)) return { reason: `not a URL ("${url.slice(0, 60)}")` };
  try {
    new URL(url);
  } catch {
    return { reason: "unparseable URL" };
  }

  // 2. Known placeholder / badge assets.
  for (const p of PLACEHOLDER_PATTERNS) {
    if (p.test(url)) return { reason: `placeholder asset (${p.source})` };
  }

  // 3. One URL claimed by several different humans. We can't tell which one it
  //    really is, and showing two doctors the same stranger's face is worse
  //    than showing both a monogram.
  const claimants = sharedUrlNames.get(url);
  if (claimants && claimants.size > 1) {
    return { reason: `shared by ${claimants.size} different people (${[...claimants].join(", ")})` };
  }

  // 4. The file is named after somebody else, or after something that is not a
  //    person at all. Own-name tokens are checked FIRST so
  //    "Dr-Nasab-Gold-Circle.png" stays with Dr. Nasab even though "Gold" is a
  //    surname somewhere on the platform.
  const own = ownNameTokens(row.name);
  const tokens = pathNameTokens(url);
  if (!tokens.some((t) => own.has(t))) {
    const notPerson = tokens.find((t) => NOT_A_HEADSHOT_TOKENS.has(t));
    if (notPerson) return { reason: `not a headshot ("${notPerson}" in filename)` };
    for (const t of tokens) {
      const owners = nameTokenOwners.get(t);
      if (owners?.length) {
        return { reason: `file named for ${owners[0]}${owners.length > 1 ? ` (+${owners.length - 1} more)` : ""}, not ${row.name}` };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) await fn(items[cursor++]);
    }),
  );
}

async function main() {
  if (!storage.isConfigured()) {
    console.error("[photo-rot] GCS is not configured - aborting (would write to public/uploads instead)");
    process.exit(1);
  }

  const all: Row[] = await prisma.providerMember.findMany({
    select: { id: true, providerId: true, name: true, personKey: true, photoUrl: true },
  });
  const targets = all.filter((r) => r.photoUrl && !isGcs(r.photoUrl));

  console.log(
    `[photo-rot] ${all.length} members, ${all.filter((r) => isGcs(r.photoUrl)).length} already mirrored, ` +
      `${targets.length} to repair (${APPLY ? "APPLY" : "DRY RUN"})\n`,
  );
  if (!targets.length) return;

  // Index: same human on another clinic's roster, with a GCS mirror. personKey
  // is the canonical link; normalized name covers rows enrichment never keyed.
  const siblings = new Map<string, Row[]>();
  const addSibling = (key: string, row: Row) => {
    const a = siblings.get(key) || [];
    a.push(row);
    siblings.set(key, a);
  };
  for (const r of all) {
    if (!isGcs(r.photoUrl)) continue;
    if (r.personKey) addSibling(`k:${r.personKey}`, r);
    addSibling(`n:${normalizeName(r.name)}`, r);
  }

  // Index: which non-GCS URLs are claimed by more than one distinct human.
  const sharedUrlNames = new Map<string, Set<string>>();
  for (const r of targets) {
    const s = sharedUrlNames.get(r.photoUrl!) || new Set<string>();
    s.add(normalizeName(r.name));
    sharedUrlNames.set(r.photoUrl!, s);
  }

  // Index: distinctive name tokens -> the members they belong to. Built from
  // EVERY member so a misfiled photo is matched against the whole platform.
  const nameTokenOwners = new Map<string, string[]>();
  for (const r of all) {
    for (const t of new Set(normalizeName(r.name).split(/[^a-z]+/).filter((x) => x.length >= 4))) {
      const a = nameTokenOwners.get(t) || [];
      if (!a.includes(r.name)) a.push(r.name);
      nameTokenOwners.set(t, a);
    }
  }

  // "Working mirror" is asked of the bucket itself - see objectExists().
  const gcsAliveCache = new Map<string, boolean>();
  async function gcsIsWorking(url: string): Promise<boolean> {
    const cached = gcsAliveCache.get(url);
    if (cached !== undefined) return cached;
    const objectPath = storage.objectPathFrom(url);
    let ok = false;
    if (objectPath) {
      try {
        ok = await storage.objectExists(objectPath);
      } catch (err: any) {
        console.log(`[warn       ] could not stat ${objectPath}: ${err?.message || err}`);
      }
    }
    gcsAliveCache.set(url, ok);
    return ok;
  }

  async function findAdoptable(row: Row): Promise<string | null> {
    const keys = [row.personKey ? `k:${row.personKey}` : null, `n:${normalizeName(row.name)}`];
    for (const key of keys) {
      if (!key) continue;
      for (const peer of siblings.get(key) || []) {
        if (peer.id === row.id) continue;
        if (await gcsIsWorking(peer.photoUrl!)) return peer.photoUrl!;
      }
    }
    return null;
  }

  const stats = { mirrored: 0, adopted: 0, nulled: 0, bogus: 0, dead: 0, skipped: 0, failed: 0 };
  const write = async (id: string, photoUrl: string | null) => {
    if (APPLY) await prisma.providerMember.update({ where: { id }, data: { photoUrl } });
  };

  // Bogus rows are settled first and serially: no network for the
  // classification, and the log reads as one clean block.
  const survivors: Row[] = [];
  for (const row of targets) {
    const bogus = classifyBogus(row, row.photoUrl!, sharedUrlNames, nameTokenOwners);
    if (!bogus) {
      survivors.push(row);
      continue;
    }
    stats.bogus++;
    const adopted = await findAdoptable(row);
    if (adopted) {
      await write(row.id, adopted);
      stats.adopted++;
      console.log(`[bogus->adopt] ${row.name}: ${bogus.reason} -> sibling mirror`);
    } else {
      await write(row.id, null);
      stats.nulled++;
      console.log(`[bogus->null ] ${row.name}: ${bogus.reason}`);
    }
  }

  await mapLimit(survivors, CONCURRENCY, async (row) => {
    const url = decodeStoredUrl(row.photoUrl!);
    try {
      const { verdict, detail } = await probe(url);

      if (verdict === "indeterminate") {
        // Rate-limited or flaking host. Leaving the row exactly as it is means
        // the next run gets another shot; nulling here would be destroying a
        // photo on the strength of a 429.
        stats.skipped++;
        console.log(`[skip       ] ${row.name}: ${detail} - inconclusive, left untouched`);
        return;
      }

      if (verdict === "alive") {
        const gcs = await persistSinglePhoto(url, row.providerId, storage);
        if (gcs && isGcs(gcs)) {
          await write(row.id, gcs);
          stats.mirrored++;
          console.log(`[mirror     ] ${row.name}: ${detail} -> ${gcs.split("/").pop()}`);
          return;
        }
        // Probe said alive but the mirror fetch came back empty (rate limit,
        // size guard, transient). Leave the row alone rather than nulling a
        // photo that is probably fine - the next run retries it.
        stats.failed++;
        console.log(`[mirror-fail] ${row.name}: probe ok (${detail}) but persist returned nothing - left as-is`);
        return;
      }

      stats.dead++;
      const adopted = await findAdoptable(row);
      if (adopted) {
        await write(row.id, adopted);
        stats.adopted++;
        console.log(`[dead->adopt] ${row.name}: ${detail} -> sibling mirror`);
      } else {
        await write(row.id, null);
        stats.nulled++;
        console.log(`[dead->null ] ${row.name}: ${detail}`);
      }
    } catch (err: any) {
      stats.failed++;
      console.log(`[error      ] ${row.name}: ${err?.message || err}`);
    }
  });

  console.log(
    `\n[photo-rot] ${APPLY ? "DONE" : "DRY RUN"} over ${targets.length} rows:\n` +
      `  ${stats.mirrored} alive -> mirrored to GCS\n` +
      `  ${stats.adopted} adopted a sibling row's working mirror\n` +
      `  ${stats.nulled} nulled -> DoctorAvatar monogram\n` +
      `  ${stats.skipped + stats.failed} left untouched (${stats.skipped} inconclusive/rate-limited, ${stats.failed} errored)\n` +
      `  (of the repaired: ${stats.bogus} classified bogus without a fetch, ${stats.dead} probed dead)`,
  );
  if (stats.skipped) {
    console.log("[photo-rot] Re-run later to settle the inconclusive rows - the host was throttling us.");
  }
  if (!APPLY) console.log("[photo-rot] Re-run with --apply to write.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
