/**
 * Persistence + visibility-gating check for payment schedules.
 *
 * Exercises the paths the extraction test can't: saving a parsed schedule,
 * the provider confirmation gate, item re-linking across a line-item rewrite,
 * and the parent-facing payload shape. Runs against a real cost sheet in a
 * scratch program that it creates and removes.
 *
 * Usage: npx tsx --env-file=.env scripts/test-schedule-persistence.ts
 */

import { prisma } from "../server/db";
import { PaymentScheduleService, buildParentPaymentSchedule } from "../server/src/modules/costs/payment-schedule.service";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

async function run() {
  const svc = new PaymentScheduleService({
    providerCostSheet: prisma.providerCostSheet,
    costTranche: prisma.costTranche,
    costItem: prisma.costItem,
    costItemPayment: prisma.costItemPayment,
  } as any);

  const provider = await prisma.provider.findFirst({ select: { id: true, name: true } });
  if (!provider) throw new Error("No provider in the database to test against");

  console.log(`\nPayment schedule persistence\n${"=".repeat(70)}`);
  console.log(`  scratch program on provider: ${provider.name}\n`);

  const program = await prisma.costProgram.create({
    data: {
      providerId: provider.id,
      name: "__schedule_test__",
      country: "United States",
      serviceTypes: ["surrogacy"],
    },
  });
  const sheet = await prisma.providerCostSheet.create({
    data: { providerId: provider.id, programId: program.id, status: "DRAFT" },
  });

  try {
    // Line items mirroring a real surrogacy sheet.
    await prisma.costItem.createMany({
      data: [
        { providerCostSheetId: sheet.id, category: "Agency", key: "Agency Fee", minValue: 30000, maxValue: 30000, isIncluded: true, sortOrder: 0 },
        { providerCostSheetId: sheet.id, category: "Compensation", key: "Surrogate Compensation", minValue: 60000, maxValue: 60000, isIncluded: true, sortOrder: 1 },
        { providerCostSheetId: sheet.id, category: "Legal", key: "Legal Fees", minValue: 10000, maxValue: 10000, isIncluded: true, sortOrder: 2 },
      ],
    });
    const items = await prisma.costItem.findMany({ where: { providerCostSheetId: sheet.id } });
    const agencyFee = items.find((i) => i.key === "Agency Fee")!;
    const comp = items.find((i) => i.key === "Surrogate Compensation")!;

    // --- Save a parsed schedule -----------------------------------------
    await svc.saveParsedSchedule(
      sheet.id,
      [
        {
          name: "First Deposit", triggerType: "AT_MATCH", triggerLabel: "Due at match",
          offsetDays: 5, offsetBasis: "BUSINESS", offsetDirection: "AFTER",
          minValue: 40000, maxValue: 40000, amountBasis: "STATED", payTo: "ESCROW",
          isRefundable: true, refundNote: "Refundable if no match is made", itemKeys: ["Agency:Agency Fee"], notes: null,
        },
        {
          name: "Second Deposit", triggerType: "AT_LEGAL_CLEARANCE", triggerLabel: "Due at legal clearance",
          offsetDays: 10, offsetBasis: "BUSINESS", offsetDirection: "AFTER",
          minValue: 60000, maxValue: 60000, amountBasis: "STATED", payTo: "ESCROW",
          isRefundable: null, refundNote: null,
          itemKeys: [`Compensation::${comp.key}`], notes: null,
        },
      ].map((t) => ({ ...t, itemKeys: t.itemKeys.map((k) => (k.includes("::") ? k : `${k.split(":")[0]}::${k.split(":")[1]}`)) })) as any,
      { escrowFloorCents: 1_000_000, replenishDays: 5, refundPolicy: "Remainder returned six months after birth" },
    );

    let sched = await svc.getSchedule(sheet.id);
    check("Parsed schedule saved", sched!.tranches.length === 2, `got ${sched!.tranches.length}`);
    check("Lands as ai_proposed", sched!.scheduleSource === "ai_proposed", `got ${sched!.scheduleSource}`);
    check("NOT visible to parents before confirmation", sched!.isParentVisible === false);
    check("Payment terms persisted", (sched!.paymentTerms as any)?.escrowFloorCents === 1_000_000);
    check("Item assignment resolved", sched!.tranches[1].itemPayments.length === 1);

    // Parent payload must be null while unconfirmed - the whole point of the gate.
    const sheetRow = await prisma.providerCostSheet.findUnique({
      where: { id: sheet.id },
      include: { items: true, tranches: { include: { itemPayments: { include: { costItem: true } } } } },
    });
    check("Parent payload withheld while unconfirmed", buildParentPaymentSchedule(sheetRow as any) === null);

    // --- Re-parse must not clobber a confirmed schedule -------------------
    await svc.confirmSchedule(sheet.id);
    sched = await svc.getSchedule(sheet.id);
    check("Confirmation makes it parent-visible", sched!.isParentVisible === true);

    await svc.saveParsedSchedule(sheet.id, [{ name: "Bogus Reparse", triggerType: "AT_SIGNING", triggerLabel: null, offsetDays: null, offsetBasis: "CALENDAR", offsetDirection: "AFTER", minValue: 1, maxValue: 1, amountBasis: "STATED", payTo: "PROVIDER", isRefundable: null, refundNote: null, itemKeys: [], notes: null }] as any, null);
    sched = await svc.getSchedule(sheet.id);
    check("Re-parse does NOT overwrite a confirmed schedule", sched!.tranches.length === 2 && sched!.tranches[0].name === "First Deposit",
      `got ${sched!.tranches.length} tranche(s), first="${sched!.tranches[0]?.name}"`);

    // --- Reconciliation on real numbers -----------------------------------
    // Items total 100,000; tranches total 100,000.
    check("Reconciles as partitioning the total", sched!.reconciliation.verdict === "PARTITIONS_TOTAL",
      `got ${sched!.reconciliation.verdict} (tranches=${sched!.reconciliation.trancheTotalCents} program=${sched!.reconciliation.programTotalCents})`);

    // --- Parent payload now populated -------------------------------------
    const sheetRow2 = await prisma.providerCostSheet.findUnique({
      where: { id: sheet.id },
      include: { items: true, tranches: { orderBy: { sortOrder: "asc" }, include: { itemPayments: { include: { costItem: true } } } } },
    });
    const parent = buildParentPaymentSchedule(sheetRow2 as any);
    check("Parent payload populated after confirmation", !!parent && parent.tranches.length === 2);
    check("Parent payload carries the payee", parent?.tranches[0].payTo === "ESCROW");
    check("Parent payload marks whole-program coverage", parent?.coversWholeProgram === true);
    check("Parent payload keeps the verbatim timing", parent?.tranches[0].triggerLabel === "Due at match");

    // --- Provider edit, including building from scratch --------------------
    const replaced = await svc.replaceSchedule(sheet.id, {
      tranches: [
        { name: "Corrected Deposit", triggerType: "AT_SIGNING", triggerLabel: "On signing", minValueCents: 5_000_00, maxValueCents: 7_500_00, amountBasis: "STATED", payTo: "PROVIDER", itemIds: [agencyFee.id] },
      ],
      paymentTerms: null,
      source: "provider_authored",
    });
    check("Provider edit replaces the schedule", replaced!.tranches.length === 1 && replaced!.tranches[0].name === "Corrected Deposit");
    check("Range amounts survive the round trip", replaced!.tranches[0].minValueCents === 500000 && replaced!.tranches[0].maxValueCents === 750000);

    // A single-amount payment: the editor leaves "highest, if it varies" blank
    // and sends null. Number(null) is 0, so a naive coercion turns "no upper
    // bound" into a real $0 - which rendered as "$17,500 - $0" and halved the
    // payment in reconciliation. Found by clicking through the real UI.
    const singleAmount = await svc.replaceSchedule(sheet.id, {
      tranches: [
        // Keeps an item assigned so the assignment-preservation check further
        // down still has something to preserve.
        { name: "Flat Payment", triggerType: "AT_SIGNING", minValueCents: 17_500_00, maxValueCents: null, amountBasis: "STATED", payTo: "PROVIDER", itemIds: [agencyFee.id] },
      ],
      source: "provider_confirmed",
    });
    check("A blank upper bound stays null, never becomes $0",
      singleAmount!.tranches[0].minValueCents === 1750000 && singleAmount!.tranches[0].maxValueCents === null,
      `got min=${singleAmount!.tranches[0].minValueCents} max=${singleAmount!.tranches[0].maxValueCents}`);
    check("A single-amount payment reconciles at full value",
      singleAmount!.reconciliation.trancheTotalCents === 1750000,
      `expected 1750000, got ${singleAmount!.reconciliation.trancheTotalCents}`);
    check("provider_authored marker preserved", replaced!.scheduleSource === "provider_authored");

    // --- The trap: rewriting line items must NOT wipe assignments ----------
    const beforeLinks = await prisma.costItemPayment.count({ where: { tranche: { providerCostSheetId: sheet.id } } });
    const { CostsService } = await import("../server/src/modules/costs/costs.service");
    const costsSvc = new CostsService(
      { providerCostSheet: prisma.providerCostSheet, costItem: prisma.costItem, costItemPayment: prisma.costItemPayment, costTemplate: prisma.costTemplate } as any,
      {} as any, {} as any, {} as any,
    );
    await costsSvc.updateSheetItems(sheet.id, [
      { category: "Agency", key: "Agency Fee", minValue: 32000, maxValue: 32000, isIncluded: true, sortOrder: 0 },
      { category: "Compensation", key: "Surrogate Compensation", minValue: 60000, maxValue: 60000, isIncluded: true, sortOrder: 1 },
    ]);
    const afterLinks = await prisma.costItemPayment.count({ where: { tranche: { providerCostSheetId: sheet.id } } });
    check("Line-item edit preserves tranche assignments", beforeLinks > 0 && afterLinks === beforeLinks,
      `before=${beforeLinks} after=${afterLinks}`);

    // --- Personalisation to a matched person's compensation ----------------
    // updateSheetItems above rewrote the item rows, so the ids captured
    // earlier are stale. Re-read them.
    const liveItems = await prisma.costItem.findMany({ where: { providerCostSheetId: sheet.id } });
    const comp2 = liveItems.find((i) => i.key === "Surrogate Compensation")!;
    const agencyFee2 = liveItems.find((i) => i.key === "Agency Fee")!;

    // Genesis-shaped: a deposit that carries 80% of surrogate compensation,
    // published as a range because the surrogate isn't known yet.
    await svc.replaceSchedule(sheet.id, {
      tranches: [
        {
          name: "Second Deposit", triggerType: "AT_LEGAL_CLEARANCE", triggerLabel: "Due at legal clearance",
          minValueCents: 117_670_00, maxValueCents: 158_670_00, amountBasis: "STATED", payTo: "ESCROW",
          itemPayments: [{ costItemId: comp2.id, percent: 80 }],
        },
      ],
      source: "provider_confirmed",
    });
    // Restore the compensation line to a published RANGE so there is a band
    // to collapse (the earlier edit left the sheet at two items).
    await prisma.costItem.update({ where: { id: comp2.id }, data: { minValue: 55000, maxValue: 100000 } });

    const load = async () =>
      prisma.providerCostSheet.findUnique({
        where: { id: sheet.id },
        include: { items: true, tranches: { orderBy: { sortOrder: "asc" }, include: { itemPayments: { include: { costItem: true } } } } },
      });

    const generic = buildParentPaymentSchedule((await load()) as any);
    check("Without a match, the published range is untouched",
      generic?.tranches[0].minValueCents === 117_670_00 && generic?.tranches[0].maxValueCents === 158_670_00,
      `got ${generic?.tranches[0].minValueCents} - ${generic?.tranches[0].maxValueCents}`);
    check("Without a match, not flagged as personalised", generic?.isPersonalised === false);

    // Matched surrogate at $65,000. 80% share: swap out 80% of the published
    // 55,000-100,000 band, swap in 80% of 65,000.
    //   min: 117,670 - 44,000 + 52,000 = 125,670
    //   max: 158,670 - 80,000 + 52,000 = 130,670
    const personalised = buildParentPaymentSchedule((await load()) as any, 65000);
    check("Matched compensation rewrites the amount",
      personalised?.tranches[0].minValueCents === 125_670_00 && personalised?.tranches[0].maxValueCents === 130_670_00,
      `expected 12567000 - 13067000, got ${personalised?.tranches[0].minValueCents} - ${personalised?.tranches[0].maxValueCents}`);
    check("Matched compensation is flagged as personalised", personalised?.isPersonalised === true);

    const genericWidth = (generic!.tranches[0].maxValueCents - generic!.tranches[0].minValueCents) / 100;
    const personalWidth = (personalised!.tranches[0].maxValueCents - personalised!.tranches[0].minValueCents) / 100;
    check("The compensation-driven band collapses", personalWidth < genericWidth / 4,
      `range width went from $${genericWidth.toLocaleString()} to $${personalWidth.toLocaleString()}`);
    console.log(`        range width $${genericWidth.toLocaleString()} -> $${personalWidth.toLocaleString()}`);

    // A schedule whose stages carry NO item assignments cannot personalise -
    // real documents often list deposits in prose. The card's totals still
    // move for the matched person, so the two halves are on different bases.
    // Judging published stages against a personalised total made a complete
    // schedule report as "covers part of the program", which was simply false.
    // Pin the line items so this block does not inherit earlier mutations:
    // 30,000 agency + 60,000 compensation = 90,000 published.
    await prisma.costItem.update({ where: { id: agencyFee2.id }, data: { minValue: 30000, maxValue: 30000 } });
    await prisma.costItem.update({ where: { id: comp2.id }, data: { minValue: 60000, maxValue: 60000 } });

    await svc.replaceSchedule(sheet.id, {
      tranches: [
        { name: "Escrow Deposit", triggerType: "AT_SIGNING", minValueCents: 12_000_00, amountBasis: "STATED", payTo: "ESCROW" },
        { name: "First Deposit", triggerType: "AT_MATCH", minValueCents: 50_000_00, amountBasis: "STATED", payTo: "ESCROW" },
        { name: "Second Deposit", triggerType: "AT_LEGAL_CLEARANCE", minValueCents: 28_000_00, amountBasis: "STATED", payTo: "ESCROW" },
      ],
      source: "provider_confirmed",
    });
    // The three stages sum to exactly the 90,000 published total.
    const unassignedGeneric = buildParentPaymentSchedule((await load()) as any);
    check("Unassigned stages reconcile against the published total",
      unassignedGeneric?.coversWholeProgram === true,
      `coversWholeProgram=${unassignedGeneric?.coversWholeProgram}`);

    const unassignedScoped = buildParentPaymentSchedule((await load()) as any, 105000);
    check("A match that cannot personalise still reports covering the program",
      unassignedScoped?.coversWholeProgram === true,
      `coversWholeProgram=${unassignedScoped?.coversWholeProgram}, note=${unassignedScoped?.scheduleNote}`);
    check("...and says plainly that the amounts are the published estimate",
      (unassignedScoped?.scheduleNote ?? "").includes("published estimate"),
      `note=${unassignedScoped?.scheduleNote}`);
    check("...without claiming to be personalised", unassignedScoped?.isPersonalised === false);

    // A tranche with no compensation exposure must not move.
    await svc.replaceSchedule(sheet.id, {
      tranches: [
        { name: "Retainer", triggerType: "AT_SIGNING", triggerLabel: "On signing", minValueCents: 5_000_00, maxValueCents: 5_000_00, amountBasis: "STATED", payTo: "PROVIDER", itemIds: [agencyFee2.id] },
      ],
      source: "provider_confirmed",
    });
    const untouched = buildParentPaymentSchedule((await load()) as any, 65000);
    check("A payment with no compensation exposure is left alone",
      untouched?.tranches[0].minValueCents === 5_000_00 && untouched?.isPersonalised === false,
      `got ${untouched?.tranches[0].minValueCents}, personalised=${untouched?.isPersonalised}`);

    // --- Clearing ----------------------------------------------------------
    const cleared = await svc.clearSchedule(sheet.id);
    check("Clearing removes every tranche", cleared!.tranches.length === 0);
    check("Clearing resets the visibility gate", cleared!.scheduleSource === null);
  } finally {
    await prisma.costItem.deleteMany({ where: { providerCostSheetId: sheet.id } });
    await prisma.providerCostSheet.delete({ where: { id: sheet.id } });
    await prisma.costProgram.delete({ where: { id: program.id } });
    console.log(`\n  scratch program removed`);
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(failures === 0 ? "All persistence checks passed.\n" : `${failures} check(s) failed.\n`);
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
