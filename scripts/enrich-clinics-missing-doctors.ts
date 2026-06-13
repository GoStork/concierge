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
 */

import "dotenv/config";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { StorageService } from "../server/src/modules/storage/storage.service";
import { ClinicEnrichmentService } from "../server/src/modules/providers/clinic-enrichment.service";

const arg = (k: string) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split("=")[1] : undefined;
};
const LIMIT = arg("limit") ? parseInt(arg("limit")!, 10) : undefined;
const CONCURRENCY = arg("concurrency") ? parseInt(arg("concurrency")!, 10) : 2;

const prisma = new PrismaService();
const storage = new StorageService();
const svc = new ClinicEnrichmentService(prisma, storage);

async function shownDoctorCount(providerId: string): Promise<number> {
  return prisma.providerMember.count({
    where: { providerId, isPublicProfile: { not: false } },
  });
}

async function main() {
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
