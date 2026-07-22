/**
 * Diagnostic + fill for ZERO-PHOTO clinics (scripts/diagnose-zero-photo-clinics.ts):
 * approved IVF clinics that have a team roster but not a single doctor photo.
 * Runs the SAME refreshTeamPhotos pipeline the live "photos" targeted mode
 * uses (non-destructive: only fills missing headshots) and buckets outcomes:
 *
 *   NO_WEBSITE    - nothing to scrape (needs a websiteUrl fix first)
 *   FILLED n      - photos recovered on this run
 *   RAN_NO_MATCH  - site scraped but no photos matched the roster
 *                   (SART-only doctors, or site has no headshots)
 *   SCRAPE_FAILED - fetch/render failed even with the Playwright lane
 *
 * Run:  npx tsx --env-file=.env scripts/diagnose-zero-photo-clinics.ts --limit=12
 *       npx tsx --env-file=.env scripts/diagnose-zero-photo-clinics.ts --all --concurrency=3
 */
import "dotenv/config";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { StorageService } from "../server/src/modules/storage/storage.service";
import { ClinicEnrichmentService } from "../server/src/modules/providers/clinic-enrichment.service";

const arg = (k: string) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split("=")[1] : undefined;
};
const LIMIT = process.argv.includes("--all") ? undefined : parseInt(arg("limit") || "12", 10);
const CONCURRENCY = parseInt(arg("concurrency") || "2", 10);
/** --any-missing: also process partly-covered clinics (any photo-less doctor), not just zero-photo ones. */
const ANY_MISSING = process.argv.includes("--any-missing");

const prisma = new PrismaService();
const storage = new StorageService();
const svc = new ClinicEnrichmentService(prisma, storage);

async function main() {
  const allClinics = await prisma.provider.findMany({
    where: { services: { some: { status: "APPROVED", providerType: { name: { contains: "IVF", mode: "insensitive" } } } } },
    select: { id: true, name: true, websiteUrl: true, members: { select: { photoUrl: true, highResPhotoUrl: true } } },
    orderBy: { name: "asc" },
  });
  const clinics = allClinics
    .filter((c: any) => {
      if (c.members.length === 0) return false;
      const hasPhoto = (m: any) => (m.photoUrl && m.photoUrl.trim() !== "") || m.highResPhotoUrl;
      return ANY_MISSING ? c.members.some((m: any) => !hasPhoto(m)) : !c.members.some(hasPhoto);
    })
    .map((c: any) => ({ id: c.id, name: c.name, websiteUrl: c.websiteUrl }));
  const targets = LIMIT ? clinics.slice(0, LIMIT) : clinics;
  console.log(`${clinics.length} zero-photo clinics; processing ${targets.length} (concurrency ${CONCURRENCY})\n`);

  const buckets: Record<string, string[]> = { NO_WEBSITE: [], FILLED: [], RAN_NO_MATCH: [], SCRAPE_FAILED: [] };
  let totalFilled = 0;

  let idx = 0;
  const worker = async () => {
    while (idx < targets.length) {
      const c = targets[idx++];
      if (!c.websiteUrl) {
        buckets.NO_WEBSITE.push(c.name);
        console.log(`[${idx}/${targets.length}] ${c.name}: NO_WEBSITE`);
        continue;
      }
      const before = await prisma.providerMember.count({
        where: { providerId: c.id, OR: [{ photoUrl: null }, { photoUrl: "" }] },
      });
      try {
        const ok = await (svc as any).refreshTeamPhotosWithRetry(c.id, c.name);
        const after = await prisma.providerMember.count({
          where: { providerId: c.id, OR: [{ photoUrl: null }, { photoUrl: "" }] },
        });
        const filled = before - after;
        if (filled > 0) {
          buckets.FILLED.push(`${c.name} (+${filled})`);
          totalFilled += filled;
          console.log(`[${idx}/${targets.length}] ${c.name}: FILLED +${filled} (${after} still missing)`);
        } else if (ok === false) {
          buckets.SCRAPE_FAILED.push(c.name);
          console.log(`[${idx}/${targets.length}] ${c.name}: SCRAPE_FAILED`);
        } else {
          buckets.RAN_NO_MATCH.push(c.name);
          console.log(`[${idx}/${targets.length}] ${c.name}: RAN_NO_MATCH (${before} doctors, 0 photos found)`);
        }
      } catch (e: any) {
        buckets.SCRAPE_FAILED.push(`${c.name} [${(e?.message || "").slice(0, 60)}]`);
        console.log(`[${idx}/${targets.length}] ${c.name}: SCRAPE_FAILED (${(e?.message || "").slice(0, 80)})`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\n===== SUMMARY =====`);
  console.log(`Photos filled: ${totalFilled}`);
  for (const [k, v] of Object.entries(buckets)) {
    console.log(`${k}: ${v.length}${v.length ? `\n  - ${v.join("\n  - ")}` : ""}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
