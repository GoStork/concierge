/**
 * Backfill: copy doctor headshots that are still hotlinked to an external clinic
 * website into our own GCS bucket, so they (a) survive the clinic redesigning its
 * site and (b) become upscalable (the upscaler only processes GCS-hosted images).
 *
 * For every public ProviderMember whose photoUrl is an external http(s) URL (not
 * already in our GCS bucket), fetch the image and persist it via the SAME helper
 * the enrichment pipeline uses (persistPhotoToGcs), then update photoUrl to the
 * returned GCS URL. Dead/blocked links are left untouched (helper returns the
 * original URL on failure). Run the photo upscaler afterwards to crisp them.
 *
 *   npx tsx -r dotenv/config scripts/persist-external-doctor-photos.ts            # dry run
 *   npx tsx -r dotenv/config scripts/persist-external-doctor-photos.ts --apply
 */
import "dotenv/config";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { StorageService } from "../server/src/modules/storage/storage.service";
import { persistPhotoToGcs } from "../server/src/modules/providers/clinic-enrichment.service";

const APPLY = process.argv.includes("--apply");
const CONCURRENCY = (() => { const m = process.argv.find(a => a.startsWith("--concurrency=")); return m ? parseInt(m.split("=")[1], 10) : 4; })();

const prisma = new PrismaService();
const storage = new StorageService();

const isExternal = (u: string) =>
  /^https?:\/\//i.test(u) && !(/storage\.googleapis\.com/i.test(u) && /gostork/i.test(u));

async function main() {
  if (!storage.isConfigured()) { console.error("[persist] GCS not configured - aborting"); process.exit(1); }
  const rows = await prisma.providerMember.findMany({
    where: { isPublicProfile: { not: false }, photoUrl: { not: null }, highResPhotoUrl: null },
    select: { id: true, name: true, photoUrl: true },
  });
  const targets = rows.filter(r => r.photoUrl && isExternal(r.photoUrl));
  console.log(`[persist] ${targets.length} doctors with an EXTERNAL photoUrl (${APPLY ? "APPLY" : "DRY RUN"})`);

  let persisted = 0, deadLink = 0, failed = 0;
  const processOne = async (d: { id: string; name: string; photoUrl: string | null }) => {
    try {
      const gcs = await persistPhotoToGcs(d.photoUrl, storage);
      if (gcs && gcs !== d.photoUrl && /storage\.googleapis\.com/i.test(gcs)) {
        if (APPLY) await prisma.providerMember.update({ where: { id: d.id }, data: { photoUrl: gcs } });
        persisted++;
        console.log(`[persist]  [ok]   ${d.name}`);
      } else {
        deadLink++;
        console.log(`[persist]  [dead] ${d.name}: external link not fetchable`);
      }
    } catch (e: any) {
      failed++;
      console.log(`[persist]  [fail] ${d.name}: ${e?.message || e}`);
    }
  };

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    await Promise.all(targets.slice(i, i + CONCURRENCY).map(processOne));
  }
  console.log(`\n[persist] ${APPLY ? "DONE" : "DRY RUN"}: ${persisted} persisted to GCS, ${deadLink} dead/unfetchable, ${failed} errors`);
  if (!APPLY) console.log(`[persist] Re-run with --apply to write, then run backfill-doctor-photos.ts to upscale.`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
