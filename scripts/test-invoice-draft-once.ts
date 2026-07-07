// One-off: fire the Phase 3 invoice auto-draft engine for a provider session,
// exactly as parent-confirm-ready would after a "Yes, I'm ready" click.
// Usage: npx tsx scripts/test-invoice-draft-once.ts <providerSessionId> [parentName]
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { BillingService } from "../server/src/modules/billing/billing.service";

(async () => {
  const sessionId = process.argv[2];
  const parentName = process.argv[3] || "Test Parent";
  if (!sessionId) {
    console.error("Usage: npx tsx scripts/test-invoice-draft-once.ts <providerSessionId> [parentName]");
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn", "log"] });
  const billing = app.get(BillingService);
  console.log(`Firing invoice auto-draft for session ${sessionId} (parent: ${parentName})...`);
  const result = await billing.tryDraftInvoiceForReadiness(sessionId, parentName);
  console.log("RESULT:", JSON.stringify(result, null, 2));
  await app.close();
  process.exit(0);
})();
