// One-off: run the GoStork remainder sweep immediately (same logic as the
// daily 06:00 scheduler and the POST /api/admin/payouts/remainder-sweep
// endpoint) and print the decision.
// Usage: npx tsx scripts/run-remainder-sweep-once.ts
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { runRemainderSweep } from "../server/src/modules/billing/remainder-sweep.scheduler";

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  const result = await runRemainderSweep(app.get(PrismaService));
  console.log("SWEEP RESULT:", JSON.stringify(result, null, 2));
  await app.close();
  process.exit(0);
})();
