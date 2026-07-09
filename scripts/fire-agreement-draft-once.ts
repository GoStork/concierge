// One-off: fire the Phase 5 agreement auto-draft engine for an invoice,
// exactly as the PAID transition would (Stripe webhook / clearance capture /
// admin mark-paid). Useful for retro-testing against an already-PAID invoice.
// Usage: npx tsx scripts/fire-agreement-draft-once.ts <invoiceId>
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { BillingService } from "../server/src/modules/billing/billing.service";

(async () => {
  const invoiceId = process.argv[2];
  if (!invoiceId) {
    console.error("Usage: npx tsx scripts/fire-agreement-draft-once.ts <invoiceId>");
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn", "log"] });
  const billing = app.get(BillingService);
  console.log(`Firing agreement auto-draft for invoice ${invoiceId}...`);
  const result = await billing.tryDraftAgreementOnPaid(invoiceId);
  console.log("RESULT:", JSON.stringify(result, null, 2));
  await app.close();
  process.exit(0);
})();
