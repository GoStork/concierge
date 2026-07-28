// De-duplicates the photos already stored on egg donor, surrogate and sperm
// donor profiles. New and re-synced profiles are handled by the sync itself
// (dedupeEntityPhotos in profile-sync.service.ts); this is for the back
// catalogue, which was written before that existed.
//
// It removes three things:
//   1. the same URL repeated inside one photos[] array,
//   2. the same picture stored twice as different files (one photo uploaded to
//      the agency at two resolutions - matched by perceptual hash, keeping the
//      larger copy and repointing photoUrl at it if the hero was the smaller),
//   3. raw agency URLs left in profileData._sections.Photos, which are the same
//      gallery again in presigned links that expire within a day.
//
// Usage:
//   npx tsx scripts/dedupe-profile-photos.ts                    # dry run, all models
//   npx tsx scripts/dedupe-profile-photos.ts --apply            # write the changes
//   npx tsx scripts/dedupe-profile-photos.ts --model surrogate  # one model
//   npx tsx scripts/dedupe-profile-photos.ts --id <uuid>        # one profile
//   npx tsx scripts/dedupe-profile-photos.ts --exact-only       # no downloads
//   npx tsx scripts/dedupe-profile-photos.ts --include-manual   # hand-edited galleries too
//   npx tsx scripts/dedupe-profile-photos.ts --limit 100 --verbose
//
// Dry run is the default and prints every group it would collapse. Fingerprints
// are cached in PhotoFingerprint, so the expensive first pass (one download per
// photo) is paid once; re-runs are fast.
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { StorageService } from "../server/src/modules/storage/storage.service";
import {
  ensureFingerprints,
  planDedupe,
  thumbCorrelation,
  worstBlockDeviation,
  DEDUP_CORRELATION,
  DEDUP_MAX_BLOCK_DEVIATION,
  type Fingerprint,
} from "../server/src/modules/providers/photo-dedup";

const MODELS = ["eggDonor", "surrogate", "spermDonor"] as const;
type Model = (typeof MODELS)[number];

const shortUrl = (u: string) => u.replace(/^https?:\/\/storage\.googleapis\.com\/[^/]+\//, "").slice(0, 60);
const dims = (fp: Fingerprint | undefined) =>
  fp?.width && fp?.height ? `${fp.width}x${fp.height}` : fp?.bytes ? `${Math.round(fp.bytes / 1024)}KB` : "?";

(async () => {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const apply = flag("apply");
  const exactOnly = flag("exact-only");
  const includeManual = flag("include-manual");
  const verbose = flag("verbose");
  const onlyId = arg("id");
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const onlyModel = arg("model") as Model | undefined;
  const models = onlyModel ? [onlyModel] : [...MODELS];

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  const prisma = app.get(PrismaService);
  const storage = app.get(StorageService);

  console.log(
    `${apply ? "APPLYING" : "DRY RUN"} - ${exactOnly ? "exact URL repeats only" : `same picture: correlation >= ${DEDUP_CORRELATION} and every block within ${DEDUP_MAX_BLOCK_DEVIATION}`}`,
  );
  if (!apply) console.log("(re-run with --apply to write these changes)\n");

  const totals = { scanned: 0, changed: 0, exact: 0, near: 0, heroes: 0, sections: 0, skippedManual: 0 };

  for (const model of models) {
    const rows = await (prisma as any)[model].findMany({
      where: onlyId ? { id: onlyId } : undefined,
      select: {
        id: true,
        externalId: true,
        photoUrl: true,
        photos: true,
        profileData: true,
        manuallyEditedFields: true,
      },
      ...(limit ? { take: limit } : {}),
    });

    for (const row of rows) {
      totals.scanned++;
      // A gallery an admin curated by hand is theirs, not ours to prune - same
      // rule the sync follows.
      if (!includeManual && (row.manuallyEditedFields || []).includes("photos")) {
        totals.skippedManual++;
        continue;
      }
      const photos: string[] = Array.isArray(row.photos) ? row.photos.filter((p: any) => typeof p === "string" && p) : [];
      const pd = row.profileData && typeof row.profileData === "object" ? { ...(row.profileData as any) } : null;
      const sections = pd && pd["_sections"] && typeof pd["_sections"] === "object" ? { ...pd["_sections"] } : null;
      const sectionPhotos: string[] = Array.isArray(sections?.["Photos"]) ? sections!["Photos"] : [];

      // _sections.Photos is the same gallery in the agency's own (expiring)
      // URLs. Once the photos[] column holds persisted copies, keeping the raw
      // list only re-lists every photo a second time, so point it at photos[].
      // Only when the column IS persisted, though - a profile whose photos were
      // never migrated has nothing better to point at, and rewriting the same
      // URLs would report a change on every run for ever.
      const persisted = (u: string) => /storage\.googleapis\.com/i.test(u) || u.startsWith("/uploads/");
      const sectionsStale =
        sectionPhotos.length > 0 &&
        photos.length > 0 &&
        photos.every(persisted) &&
        sectionPhotos.some((u) => !persisted(u));

      const fingerprints = exactOnly
        ? new Map<string, Fingerprint>()
        : await ensureFingerprints(prisma, [row.photoUrl, ...photos].filter(Boolean), storage);

      const plan = planDedupe(photos, fingerprints);
      const heroReplacement = row.photoUrl ? plan.replacements.get(row.photoUrl) : undefined;

      const changed = plan.keep.length !== photos.length || !!heroReplacement || sectionsStale;
      if (!changed) continue;

      totals.changed++;
      totals.exact += plan.exactRepeats;
      totals.near += plan.nearDuplicates;
      if (heroReplacement) totals.heroes++;
      if (sectionsStale) totals.sections++;

      const dropped = photos.filter((p) => !plan.keep.includes(p));
      console.log(
        `${model} ${row.externalId ?? row.id}: ${photos.length} -> ${plan.keep.length} photos` +
          `${plan.exactRepeats ? ` (${plan.exactRepeats} repeated URL)` : ""}` +
          `${plan.nearDuplicates ? ` (${plan.nearDuplicates} same picture)` : ""}` +
          `${heroReplacement ? " [hero repointed to the larger copy]" : ""}` +
          `${sectionsStale ? " [source gallery normalised]" : ""}`,
      );
      if (verbose || plan.nearDuplicates > 0) {
        for (const d of dropped) {
          const kept = plan.replacements.get(d);
          const a = fingerprints.get(d)?.thumb, b = kept ? fingerprints.get(kept)?.thumb : null;
          const score = a && b ? ` corr=${thumbCorrelation(a, b).toFixed(3)} block=${worstBlockDeviation(a, b).toFixed(3)}` : "";
          console.log(
            `    drop ${shortUrl(d)} (${dims(fingerprints.get(d))})` +
              (kept ? ` -> kept ${shortUrl(kept)} (${dims(fingerprints.get(kept))})${score}` : " (repeat)"),
          );
        }
      }

      if (!apply) continue;

      const data: Record<string, any> = {};
      if (plan.keep.length !== photos.length) data.photos = plan.keep;
      if (heroReplacement) data.photoUrl = heroReplacement;
      if (model === "eggDonor" && plan.keep.length !== photos.length) data.photoCount = plan.keep.length;
      if (pd) {
        let pdChanged = false;
        for (const key of ["All Photos", "Photos"]) {
          if (Array.isArray(pd[key])) {
            const sub = planDedupe(pd[key].filter((p: any) => typeof p === "string" && p), fingerprints);
            if (sub.keep.length !== pd[key].length) {
              pd[key] = sub.keep;
              pdChanged = true;
            }
          }
        }
        if (sectionsStale && sections) {
          sections["Photos"] = plan.keep;
          pd["_sections"] = sections;
          pdChanged = true;
        }
        if (pdChanged) data.profileData = pd;
      }
      if (Object.keys(data).length > 0) {
        await (prisma as any)[model].update({ where: { id: row.id }, data });
      }
    }
  }

  console.log(
    `\nScanned ${totals.scanned} profiles, ${totals.changed} ${apply ? "updated" : "would change"}: ` +
      `${totals.exact} repeated URLs, ${totals.near} duplicate pictures, ` +
      `${totals.heroes} heroes repointed, ${totals.sections} source galleries normalised` +
      `${totals.skippedManual ? `, ${totals.skippedManual} hand-curated galleries left alone` : ""}.`,
  );

  await app.close();
  process.exit(0);
})();
