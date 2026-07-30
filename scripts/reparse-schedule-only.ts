/**
 * Re-read the payment schedule out of a cost sheet's original document,
 * WITHOUT touching its line items.
 *
 * Existing sheets were all parsed before schedules were a thing, so they have
 * none. This runs the same parse the upload path runs but persists only the
 * tranches and payment terms - saveParseResults is never called, so not one
 * line item, price or total can move.
 *
 * Lands as "ai_proposed": provider-only until they review it. Sheets whose
 * schedule the provider has already confirmed or authored are skipped.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/reparse-schedule-only.ts --sheet <id>
 *   npx tsx --env-file=.env scripts/reparse-schedule-only.ts --provider "Family Creations"
 *   npx tsx --env-file=.env scripts/reparse-schedule-only.ts --all [--limit 10]
 *   ... add --dry-run to see what would happen without writing.
 */

import { prisma } from "../server/db";
import { CostsAiService } from "../server/src/modules/costs/costs-ai.service";
import { PaymentScheduleService } from "../server/src/modules/costs/payment-schedule.service";
import { StorageService } from "../server/src/modules/storage/storage.service";

// The project's storage wrapper, which reads the service-account credentials
// out of the environment. A bare Storage() client authenticates anonymously
// and cannot see the private bucket.
const storage = new StorageService();

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? "") : null;
}
const DRY = process.argv.includes("--dry-run");

async function loadFile(sheet: { filePath: string | null; fileUrl: string | null }): Promise<Buffer | null> {
  if (!sheet.filePath) return null;
  try {
    return await storage.downloadToBuffer(sheet.filePath);
  } catch (err: any) {
    console.log(`      could not fetch the document: ${err.message}`);
    return null;
  }
}

async function run() {
  const sheetId = arg("sheet");
  const providerName = arg("provider");
  const all = process.argv.includes("--all");
  const limit = Number(arg("limit") ?? "0") || undefined;

  if (!sheetId && !providerName && !all) {
    console.log("Pick a target: --sheet <id>, --provider <name>, or --all");
    process.exit(1);
  }

  const where: any = {
    status: { in: ["APPROVED", "DRAFT"] },
    filePath: { not: null },
    // Never overwrite a schedule a human owns.
    OR: [{ scheduleSource: null }, { scheduleSource: "ai_proposed" }],
  };
  if (sheetId) where.id = sheetId;
  if (providerName) where.provider = { name: { contains: providerName, mode: "insensitive" } };

  const sheets = await prisma.providerCostSheet.findMany({
    where,
    take: limit,
    orderBy: { updatedAt: "desc" },
    include: {
      provider: { select: { name: true } },
      program: { select: { name: true } },
      _count: { select: { items: true } },
    },
  });

  console.log(`\n${sheets.length} sheet(s) to process${DRY ? " (dry run)" : ""}\n${"=".repeat(70)}`);

  const ai = new CostsAiService({ providerType: prisma.providerType, costTemplate: prisma.costTemplate } as any);
  const schedules = new PaymentScheduleService({
    providerCostSheet: prisma.providerCostSheet,
    costTranche: prisma.costTranche,
    costItem: prisma.costItem,
    costItemPayment: prisma.costItemPayment,
  } as any);

  let found = 0, empty = 0, failed = 0;

  for (const sheet of sheets) {
    const label = `${sheet.provider?.name} / ${sheet.program?.name ?? "?"}`;
    console.log(`\n${label}`);
    console.log(`  ${sheet.originalFileName ?? "(no filename)"}  ${sheet._count.items} line items`);

    const buffer = await loadFile(sheet);
    if (!buffer) { failed++; continue; }

    // Totals before, so we can prove nothing moved.
    const before = await prisma.costItem.aggregate({
      where: { providerCostSheetId: sheet.id },
      _sum: { minValue: true, maxValue: true },
      _count: true,
    });

    try {
      const { tranches, paymentTerms } = await ai.parseAndClassifyDocument(
        buffer,
        "application/pdf",
        "Egg Donor Agency",
        sheet.originalFileName ?? "cost-sheet.pdf",
      );

      if (tranches.length === 0 && !paymentTerms) {
        console.log(`  -> no payment terms in this document`);
        empty++;
        continue;
      }

      for (const t of tranches) {
        const amt = t.minValue != null
          ? (t.maxValue != null && t.maxValue !== t.minValue
              ? `$${t.minValue.toLocaleString()} - $${t.maxValue.toLocaleString()}`
              : `$${t.minValue.toLocaleString()}`)
          : t.amountBasis;
        console.log(`  -> ${t.name}: ${amt}  [${t.triggerType} / ${t.payTo}]`);
      }

      if (!DRY) {
        await schedules.saveParsedSchedule(sheet.id, tranches, paymentTerms);

        // Prove the line items are untouched. This script must be incapable
        // of moving a price a provider already approved.
        const after = await prisma.costItem.aggregate({
          where: { providerCostSheetId: sheet.id },
          _sum: { minValue: true, maxValue: true },
          _count: true,
        });
        const same =
          before._count === after._count &&
          before._sum.minValue === after._sum.minValue &&
          before._sum.maxValue === after._sum.maxValue;
        console.log(`  -> line items unchanged: ${same ? "yes" : "NO - INVESTIGATE"}`);
        if (!same) failed++;
      }
      found++;
    } catch (err: any) {
      console.log(`  -> parse failed: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`${found} schedule(s) extracted, ${empty} document(s) with no payment terms, ${failed} failure(s)`);
  console.log(DRY ? "Dry run - nothing written.\n" : "Saved as ai_proposed - each provider still has to review and confirm.\n");
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
