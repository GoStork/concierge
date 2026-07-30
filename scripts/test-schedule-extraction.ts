/**
 * End-to-end check of payment-schedule extraction against real cost sheets.
 *
 * Runs the live Gemini parser over documents from the corpus and reports what
 * it found: line items, tranches, triggers, payees, and the reconciliation
 * verdict. The point is to confirm two things at once -
 *   1. schedules ARE extracted where they exist, and
 *   2. line-item totals are UNCHANGED by the schedule work.
 *
 * Usage:
 *   npx tsx scripts/test-schedule-extraction.ts                    # a default sample
 *   npx tsx scripts/test-schedule-extraction.ts "path/to/sheet.pdf"
 */

import * as fs from "fs";
import * as path from "path";
import { CostsAiService } from "../server/src/modules/costs/costs-ai.service";
import { reconcileSchedule } from "../shared/payment-schedule";
import { prisma } from "../server/db";

const COSTS_DIR = "/Users/eranamir/Desktop/Costs";

// One per structural pattern, so a regression in any shape shows up here.
const DEFAULT_SAMPLE: Array<{ file: string; type: string; expectSchedule: boolean; note: string }> = [
  { file: "Genesis Group - Sample Cost Sheet for Lloyds or Cash Pay_Domestic.pdf", type: "Surrogacy Agency", expectSchedule: true, note: "A: deposit headers with items beneath" },
  { file: "OneWorld Generation Surrogacy Costs.pdf", type: "Surrogacy Agency", expectSchedule: true, note: "B: trailing INSTALLMENT TOTAL rows" },
  { file: "NESA Surrogacy Costs.pdf", type: "Surrogacy Agency", expectSchedule: true, note: "D: agency fee split four ways" },
  { file: "Signature Pricing Breakdown.pdf", type: "Egg Donor Agency", expectSchedule: true, note: "A: two payment sections" },
  { file: "PFCLA - IVF Surrogacy- Single Cycle with Unlimited Transfers.pdf", type: "IVF Clinic", expectSchedule: false, note: "H: no schedule, must stay empty" },
];

const money = (n: number) => `$${n.toLocaleString("en-US")}`;

async function run() {
  const arg = process.argv[2];
  const sample = arg
    ? [{ file: path.basename(arg), type: "Surrogacy Agency", expectSchedule: true, note: "ad hoc" }]
    : DEFAULT_SAMPLE;
  const baseDir = arg ? path.dirname(path.resolve(arg)) : COSTS_DIR;

  // The parser reads CostTemplate rows to build its mapping context, so it
  // needs the real client rather than a stub.
  const ai = new CostsAiService({
    providerType: prisma.providerType,
    costTemplate: prisma.costTemplate,
  } as any);
  let failures = 0;

  for (const s of sample) {
    const full = path.join(baseDir, s.file);
    if (!fs.existsSync(full)) {
      console.log(`\nSKIP  ${s.file} (not found)`);
      continue;
    }

    console.log(`\n${"=".repeat(74)}\n${s.file}\n  pattern: ${s.note}\n${"=".repeat(74)}`);
    const buffer = fs.readFileSync(full);

    try {
      const { items, tranches, paymentTerms, classification } = await ai.parseAndClassifyDocument(
        buffer,
        "application/pdf",
        s.type,
        s.file,
      );

      // Program total from LINE ITEMS ONLY - this is the number that must be
      // unaffected by the schedule work.
      let programTotal = 0;
      const tierVals: number[] = [];
      for (const it of items) {
        if (!it.isIncluded) continue;
        const v = ((it.minValue ?? it.maxValue ?? 0) + (it.maxValue ?? it.minValue ?? 0)) / 2;
        if (it.isTier) tierVals.push(v);
        else programTotal += v;
      }
      if (tierVals.length > 0) programTotal += Math.min(...tierVals);

      console.log(`  program: "${classification?.programName ?? "?"}"  tags=${JSON.stringify(classification?.serviceTypes ?? [])}`);
      console.log(`  line items: ${items.length}   total from items: ${money(Math.round(programTotal))}`);

      const recurring = items.filter((i) => i.recurrence);
      if (recurring.length > 0) {
        console.log(`  recurring items: ${recurring.length}`);
        for (const r of recurring) {
          console.log(`     - ${r.key}: ${money((r.recurrence!.amountCents) / 100)}/${r.recurrence!.period.toLowerCase()}${r.recurrence!.count ? ` x${r.recurrence!.count}` : ""}`);
        }
      }

      console.log(`  tranches: ${tranches.length}`);
      for (const [i, t] of tranches.entries()) {
        const amt =
          t.minValue != null && t.maxValue != null && t.minValue !== t.maxValue
            ? `${money(t.minValue)} - ${money(t.maxValue)}`
            : t.minValue != null
              ? money(t.minValue)
              : t.amountBasis;
        console.log(`     ${i + 1}. ${t.name}  ${amt}`);
        console.log(`        trigger=${t.triggerType} payTo=${t.payTo} basis=${t.amountBasis} items=${t.itemKeys.length}`);
        if (t.triggerLabel) console.log(`        "${t.triggerLabel}"`);
      }

      if (paymentTerms) {
        console.log(`  payment terms: ${JSON.stringify(paymentTerms)}`);
      }

      if (tranches.length > 0) {
        const amounts = tranches
          .filter((t) => t.amountBasis !== "REMAINDER" && t.amountBasis !== "TBD")
          .map((t) => Math.round((((t.minValue ?? t.maxValue ?? 0) + (t.maxValue ?? t.minValue ?? 0)) / 2) * 100))
          .filter((c) => c > 0);
        const rec = reconcileSchedule(
          amounts,
          Math.round(programTotal * 100),
          items.filter((i) => i.isIncluded).map((i) => ({
            key: i.key,
            cents: Math.round((((i.minValue ?? i.maxValue ?? 0) + (i.maxValue ?? i.minValue ?? 0)) / 2) * 100),
          })),
        );
        console.log(`  reconciliation: ${rec.verdict}${rec.matchedItemKey ? ` -> "${rec.matchedItemKey}"` : ""}`);
        console.log(`     ${rec.message}`);
        if (rec.verdict === "OVERSHOOT") {
          console.log(`  >> OVERSHOOT: would be withheld from parents pending provider review`);
        }
      }

      const gotSchedule = tranches.length > 0;
      if (gotSchedule !== s.expectSchedule) {
        failures++;
        console.log(`  >> MISMATCH: expected ${s.expectSchedule ? "a schedule" : "NO schedule"}, got ${tranches.length} tranche(s)`);
      } else {
        console.log(`  >> OK (${s.expectSchedule ? "schedule extracted" : "correctly empty"})`);
      }
    } catch (err: any) {
      failures++;
      console.log(`  >> ERROR: ${err.message}`);
    }
  }

  console.log(`\n${"=".repeat(74)}\n${failures === 0 ? "All sampled sheets behaved as expected." : `${failures} sheet(s) did not behave as expected.`}\n`);
  process.exit(failures > 0 ? 1 : 0);
}

run();
