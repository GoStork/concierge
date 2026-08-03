// One-off: run the full nightly sync (all providers, all donor types) once, now.
// Uses the normal (non-force) path so the atomic NightlySyncLock claim and the
// 20h dedup both apply - i.e. it behaves exactly like the 2 AM cron firing.
// Run with: npx tsx scripts/trigger-nightly-sync-once.ts
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { StorageService } from "../server/src/modules/storage/storage.service";
import { runNightlySync, getNightlySyncStatus } from "../server/src/modules/providers/profile-sync.service";

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn", "log"] });
  const prisma = app.get(PrismaService);
  const storage = app.get(StorageService);

  console.log("[trigger] Starting nightly sync at", new Date().toISOString());

  const poll = setInterval(() => {
    const s = getNightlySyncStatus();
    const rows = (s.results || []).map(
      (r: any) => `  ${r.providerName} (${r.type}): ${r.status} ${r.succeeded}/${r.total} failed=${r.failed}`,
    );
    console.log(`[trigger] isRunning=${s.isRunning}\n${rows.join("\n")}`);
  }, 60_000);

  await runNightlySync(prisma, storage);

  clearInterval(poll);
  const final = getNightlySyncStatus();
  console.log("[trigger] DONE at", new Date().toISOString());
  console.log(JSON.stringify(final.results, null, 2));

  await app.close();
  process.exit(0);
})();
