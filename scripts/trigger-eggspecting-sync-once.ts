// One-off: trigger an Eggspecting egg-donor sync once and wait for it to finish.
// Verifies the per-donor profileUrl capture fix backfills existing records.
// Run with: npx tsx scripts/trigger-eggspecting-sync-once.ts
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { StorageService } from "../server/src/modules/storage/storage.service";
import { startSync, getSyncJob } from "../server/src/modules/providers/profile-sync.service";

const PROVIDER_ID = "448564e2-4e7f-42d2-9578-5197161ea0ec"; // Eggspecting

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn", "log"] });
  const prisma = app.get(PrismaService);
  const storage = app.get(StorageService);

  console.log("Starting Eggspecting egg-donor sync...");
  const jobId = await startSync(prisma, PROVIDER_ID, "egg-donor", undefined, storage, "manual");
  console.log("Job started:", jobId);

  // Poll until terminal
  let job = getSyncJob(jobId);
  while (job && (job.status === "running" || job.status === "pending")) {
    await new Promise((r) => setTimeout(r, 5000));
    job = getSyncJob(jobId);
    console.log(`  status=${job?.status} processed=${job?.processed}/${job?.total} new=${job?.newProfiles} failed=${job?.failed} step="${job?.currentStep || ""}"`);
  }
  console.log("Final:", JSON.stringify({ status: job?.status, processed: job?.processed, succeeded: job?.succeeded, newProfiles: job?.newProfiles, failed: job?.failed, errors: job?.errors?.slice(0, 5) }, null, 2));

  // Report how many now have a profileUrl
  const total = await prisma.eggDonor.count({ where: { providerId: PROVIDER_ID } });
  const withUrl = await prisma.eggDonor.count({ where: { providerId: PROVIDER_ID, profileUrl: { not: null } } });
  const sample = await prisma.eggDonor.findMany({ where: { providerId: PROVIDER_ID, profileUrl: { not: null } }, select: { externalId: true, profileUrl: true }, take: 5 });
  console.log(`profileUrl populated: ${withUrl}/${total}`);
  console.log("Sample:", JSON.stringify(sample, null, 2));

  await app.close();
  process.exit(0);
})();
