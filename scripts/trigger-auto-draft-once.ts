// One-off: re-fire the Phase 2 cost-sheet auto-draft for a specific booking.
// Usage: npx tsx scripts/trigger-auto-draft-once.ts <bookingId>
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { CostSheetAutoDraftService } from "../server/src/modules/billing/cost-sheet-auto-draft.service";

(async () => {
  const bookingId = process.argv[2];
  if (!bookingId) {
    console.error("Usage: npx tsx scripts/trigger-auto-draft-once.ts <bookingId>");
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn", "log"] });
  const svc = app.get(CostSheetAutoDraftService);
  console.log(`Firing auto-draft for booking ${bookingId}...`);
  const result = await svc.tryAutoDraftForBooking(bookingId);
  console.log("RESULT:", JSON.stringify(result, null, 2));
  await app.close();
  process.exit(0);
})();
