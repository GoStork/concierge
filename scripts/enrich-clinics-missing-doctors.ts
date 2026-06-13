/**
 * Targeted re-enrichment for approved IVF clinics that currently have NO doctor
 * records (so they show no "Doctors at this clinic" tab). Runs the SAME
 * enrichClinicProfile pipeline the live service uses - scrapes the clinic site +
 * SART, extracts the team roster, and persists doctors - for just these clinics.
 *
 * Non-destructive + idempotent: re-enriching a clinic refreshes its roster; safe
 * to re-run. After this, run backfill-doctor-photos.ts to upscale any new photos.
 *
 * Run:  npx tsx -r dotenv/config scripts/enrich-clinics-missing-doctors.ts
 *       npx tsx -r dotenv/config scripts/enrich-clinics-missing-doctors.ts --limit=10
 *       npx tsx -r dotenv/config scripts/enrich-clinics-missing-doctors.ts --concurrency=2
 *
 * --diagnose : READ-ONLY. Per doctor-less clinic, scrape the site + SART and log
 *   scraped roster size vs SART hit, WITHOUT persisting. Buckets the clinics:
 *     B1 (scraped 0)  -> JS/SPA page the scraper can't read  -> needs scraper work
 *     B2 (scraped N)  -> roster found but scoping cleared it  -> needs scoping fix
 *     B0 (no website) -> nothing to scrape
 */

import "dotenv/config";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { StorageService } from "../server/src/modules/storage/storage.service";
import { ClinicEnrichmentService, searchSartForClinic } from "../server/src/modules/providers/clinic-enrichment.service";
import { scrapeProviderWebsite } from "../server/src/modules/providers/scrape.service";

const arg = (k: string) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split("=")[1] : undefined;
};
const LIMIT = arg("limit") ? parseInt(arg("limit")!, 10) : undefined;
const CONCURRENCY = arg("concurrency") ? parseInt(arg("concurrency")!, 10) : 2;
const DIAGNOSE = process.argv.includes("--diagnose");
const INSPECT = arg("inspect"); // clinic name substring: scrape + dump per-doctor data

const prisma = new PrismaService();
const storage = new StorageService();
const svc = new ClinicEnrichmentService(prisma, storage);

async function shownDoctorCount(providerId: string): Promise<number> {
  return prisma.providerMember.count({
    where: { providerId, isPublicProfile: { not: false } },
  });
}

// READ-ONLY diagnostic: scrape each doctor-less clinic + SART, bucket by why it's
// empty. Does NOT persist anything.
async function runDiagnose() {
  const clinics = await prisma.provider.findMany({
    where: {
      services: { some: { status: "APPROVED", providerType: { name: "IVF Clinic" } } },
      members: { none: { isPublicProfile: { not: false } } },
    },
    select: {
      id: true, name: true, websiteUrl: true,
      locations: { orderBy: { sortOrder: "asc" }, take: 1, select: { city: true, state: true } },
    },
    orderBy: { name: "asc" },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  console.log(`[diagnose] ${clinics.length} doctor-less IVF clinics (concurrency=${CONCURRENCY})`);
  let b0 = 0, b1 = 0, b2 = 0, errs = 0;
  const b1List: string[] = [], b2List: string[] = [];

  const diagnoseOne = async (c: any) => {
    const city = c.locations[0]?.city || null;
    const state = c.locations[0]?.state || null;
    let sartCount = 0;
    try { const sart = await searchSartForClinic(c.name, city, state); sartCount = sart?.members?.length || 0; } catch { /* ignore */ }
    if (!c.websiteUrl) { b0++; console.log(`[diagnose]  [B0 no-site]  ${c.name} (SART=${sartCount})`); return; }
    let scrapedCount = -1;
    try {
      const scraped = await scrapeProviderWebsite(c.websiteUrl, { doctorsOnly: true });
      scrapedCount = scraped?.teamMembers?.length || 0;
    } catch (e: any) {
      errs++; console.log(`[diagnose]  [ERR]        ${c.name}: ${e?.message || e}`); return;
    }
    if (scrapedCount > 0) { b2++; b2List.push(`${c.name} (${scrapedCount} scraped, SART=${sartCount})`); console.log(`[diagnose]  [B2 scoping] ${c.name}: ${scrapedCount} scraped, SART=${sartCount} -> scoping cleared`); }
    else { b1++; b1List.push(`${c.name} (SART=${sartCount})`); console.log(`[diagnose]  [B1 scraper] ${c.name}: 0 scraped (SPA/no roster), SART=${sartCount}`); }
  };

  for (let i = 0; i < clinics.length; i += CONCURRENCY) {
    await Promise.all(clinics.slice(i, i + CONCURRENCY).map((c) => diagnoseOne(c).catch((e) => { errs++; console.log(`[diagnose] err ${e?.message || e}`); })));
    console.log(`[diagnose] progress ${Math.min(i + CONCURRENCY, clinics.length)}/${clinics.length}`);
  }

  console.log(`\n[diagnose] ===== BUCKET SPLIT =====`);
  console.log(`[diagnose] B1 scraper-fix (scraped 0, SPA/no roster): ${b1}`);
  console.log(`[diagnose] B2 scoping-fix (scraped N, scoped to 0):    ${b2}`);
  console.log(`[diagnose] B0 no website:                              ${b0}`);
  console.log(`[diagnose] errors:                                     ${errs}`);
  console.log(`\n[diagnose] --- B2 (scoping fix recovers these) ---\n${b2List.join("\n") || "(none)"}`);
  console.log(`\n[diagnose] --- B1 (need scraper/SPA work) ---\n${b1List.join("\n") || "(none)"}`);
  process.exit(0);
}

async function runInspect(substr: string) {
  const c = await prisma.provider.findFirst({
    where: { name: { contains: substr, mode: "insensitive" } },
    select: { id: true, name: true, websiteUrl: true, locations: { orderBy: { sortOrder: "asc" }, take: 1, select: { city: true, state: true } } },
  });
  if (!c) { console.log(`[inspect] no clinic matching "${substr}"`); process.exit(0); }
  console.log(`[inspect] ${c.name} | site=${c.websiteUrl} | CDC loc=${c.locations[0]?.city}, ${c.locations[0]?.state}`);
  const scraped = await scrapeProviderWebsite(c.websiteUrl!, { doctorsOnly: true });
  console.log(`[inspect] scraped ${scraped.teamMembers.length} members; scraped locations: ${(scraped.locations || []).map((l: any) => `${l.city},${l.state}`).join(" | ") || "(none)"}`);
  for (const m of scraped.teamMembers as any[]) {
    console.log(`  - ${m.name} | title="${m.title || ""}" | locHints=[${(m.locationHints || []).join(", ")}] | bio="${(m.bio || "").slice(0, 80)}"`);
  }
  process.exit(0);
}

async function main() {
  if (INSPECT) return runInspect(INSPECT);
  if (DIAGNOSE) return runDiagnose();
  // Approved IVF clinics with zero shown doctors.
  const clinics = await prisma.provider.findMany({
    where: {
      services: { some: { status: "APPROVED", providerType: { name: "IVF Clinic" } } },
      members: { none: { isPublicProfile: { not: false } } },
    },
    select: { id: true, name: true, websiteUrl: true },
    orderBy: { name: "asc" },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  console.log(`[enrich-missing] ${clinics.length} doctor-less IVF clinics to re-enrich (concurrency=${CONCURRENCY})`);
  let recovered = 0, stillEmpty = 0, failed = 0, totalNewDoctors = 0;

  const processOne = async (c: { id: string; name: string }) => {
    try {
      await svc.enrichClinicProfile(c.id);
      const after = await shownDoctorCount(c.id);
      if (after > 0) {
        recovered++;
        totalNewDoctors += after;
        console.log(`[enrich-missing]  [recovered] ${c.name}: ${after} doctors`);
      } else {
        stillEmpty++;
        console.log(`[enrich-missing]  [empty]     ${c.name}: still 0 doctors`);
      }
    } catch (e: any) {
      failed++;
      console.log(`[enrich-missing]  [fail]      ${c.name}: ${e?.message || e}`);
    }
  };

  for (let i = 0; i < clinics.length; i += CONCURRENCY) {
    const batch = clinics.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(processOne));
    console.log(`[enrich-missing] progress ${Math.min(i + CONCURRENCY, clinics.length)}/${clinics.length} (recovered=${recovered} stillEmpty=${stillEmpty} fail=${failed})`);
  }

  console.log(`[enrich-missing] COMPLETE: ${recovered} clinics recovered (${totalNewDoctors} doctors total), ${stillEmpty} still empty, ${failed} failed`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
