// One-off: re-run the scrapers that failed in the 2026-06-18 nightly with a
// bounded test limit (10 profiles) to prove login + extraction work again now
// that connectivity is restored. Eggceptional is skipped on purpose (it
// succeeded today; re-login risks the per-day rate-limit lockout).
// Run with: npx tsx scripts/verify-failed-scrapers-once.ts
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { StorageService } from "../server/src/modules/storage/storage.service";
import { startSync, getSyncJob } from "../server/src/modules/providers/profile-sync.service";

const TARGETS: { name: string; providerId: string; type: "egg-donor" | "surrogate" | "sperm-donor" }[] = [
  { name: "Asian Egg Bank",        providerId: "130506a2-3137-4ed9-b5c7-1f16c0703c78", type: "egg-donor" },
  { name: "Eggspecting",           providerId: "448564e2-4e7f-42d2-9578-5197161ea0ec", type: "egg-donor" },
  { name: "Family Creations (egg)", providerId: "d0af900d-41bf-43cb-9051-d52c8cda3f24", type: "egg-donor" },
  { name: "Family Creations (surr)", providerId: "d0af900d-41bf-43cb-9051-d52c8cda3f24", type: "surrogate" },
  { name: "Sperm Bank California", providerId: "25dacdbf-e1d6-4189-987b-934b12d99022", type: "sperm-donor" },
];

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  const prisma = app.get(PrismaService);
  const storage = app.get(StorageService);

  const results: any[] = [];
  for (const t of TARGETS) {
    console.log(`\n=== ${t.name} [${t.type}] - test sync (limit 10) ===`);
    try {
      const jobId = await startSync(prisma, t.providerId, t.type, 10, storage, "manual");
      let job = getSyncJob(jobId);
      const startedMs = Date.now();
      while (job && (job.status === "running" || job.status === "pending")) {
        await new Promise((r) => setTimeout(r, 5000));
        job = getSyncJob(jobId);
        process.stdout.write(`  status=${job?.status} ${job?.processed}/${job?.total} new=${job?.newProfiles} step="${(job?.currentStep || "").slice(0, 60)}"\r`);
        if (Date.now() - startedMs > 5 * 60_000) { console.log("\n  (timeout 5min - moving on)"); break; }
      }
      const r = { name: t.name, type: t.type, status: job?.status, processed: job?.processed, succeeded: job?.succeeded, newProfiles: job?.newProfiles, failed: job?.failed, firstError: job?.errors?.[0]?.slice?.(0, 200) || null };
      results.push(r);
      console.log(`\n  -> ${JSON.stringify(r)}`);
    } catch (e: any) {
      results.push({ name: t.name, type: t.type, status: "throw", firstError: e.message?.slice(0, 200) });
      console.log(`  -> THREW: ${e.message}`);
    }
  }

  console.log("\n\n========== SUMMARY ==========");
  for (const r of results) {
    const ok = r.status === "completed" || r.status === "partial";
    console.log(`${ok ? "PASS" : "FAIL"}  ${r.name} [${r.type}]  status=${r.status} succeeded=${r.succeeded ?? "-"}${r.firstError ? `  err="${r.firstError}"` : ""}`);
  }
  await app.close();
  process.exit(0);
})();
