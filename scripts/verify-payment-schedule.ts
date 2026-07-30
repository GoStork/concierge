/**
 * Truth table for the payment-schedule reconciliation guard.
 *
 * Every case here is taken from a real cost sheet in the corpus that drove
 * this feature, so the numbers are the ones the system will actually meet.
 * The guard's whole job is to tell a schedule that partitions the program
 * total from one that splits a single fee - get that wrong and either a
 * provider's total doubles or a legitimate schedule is rejected.
 *
 * Run: npx tsx scripts/verify-payment-schedule.ts
 * Exits non-zero on any mismatch.
 */

import {
  formatTiming,
  formatTrancheAmount,
  reconcileSchedule,
  triggerLabel,
  triggerOrder,
  type ReconciliationVerdict,
} from "../shared/payment-schedule";

const $ = (dollars: number) => Math.round(dollars * 100);

interface Case {
  name: string;
  source: string;
  tranches: number[];
  programTotal: number;
  items?: Array<{ key: string; cents: number }>;
  expect: ReconciliationVerdict;
}

const CASES: Case[] = [
  // --- Pattern A: tranche as container, sums to the program total ---------
  {
    name: "Genesis Group - three deposits partition the total",
    source: "First 35,200-50,200 / second 117,670-158,670 / third 41,700-50,700 against a 194,570-259,570 total",
    tranches: [$(42700), $(138170), $(46200)],
    programTotal: $(227070),
    expect: "PARTITIONS_TOTAL",
  },
  {
    name: "The Fertility Solutions - opening + second + third installment",
    source: "62,300 + 79,400 + 12,000 = 153,700",
    tranches: [$(62300), $(79400), $(12000)],
    programTotal: $(153700),
    expect: "PARTITIONS_TOTAL",
  },
  {
    name: "Giving Tree - two payments make the fixed program fee",
    source: "41,500 + 138,500 = 180,000 exactly",
    tranches: [$(41500), $(138500)],
    programTotal: $(180000),
    expect: "PARTITIONS_TOTAL",
  },
  {
    name: "ACRC surrogacy - deposits exceed a 'starting at' total",
    source:
      "12,000 + 60,000 + 95,000 = 167,000 against 'Total Estimate Fee $155,110+'. The second deposit is " +
      "explicitly 'starting from $95,000, varies depending on the Surrogate's Base Compensation', so " +
      "running 7.7% over the floor is correct, not a double-count.",
    tranches: [$(12000), $(60000), $(95000)],
    programTotal: $(155110),
    expect: "PARTITIONS_TOTAL",
  },

  // --- Pattern B: trailing subtotal, the double-count trap ---------------
  {
    name: "OneWorld Generation - three installment totals",
    source: "32,500 + 65,350 + 56,090 = 153,940 stated total",
    tranches: [$(32500), $(65350), $(56090)],
    programTotal: $(153940),
    expect: "PARTITIONS_TOTAL",
  },
  {
    name: "OneWorld with its installment rows ALSO parsed as line items",
    source: "The exact double-count failure the guard exists to catch: total inflated to ~307,880",
    tranches: [$(32500), $(65350), $(56090)],
    programTotal: $(307880),
    // Tranches now cover only half the (inflated) total, and match no single
    // item, so this reads as PARTIAL rather than clean. Either way it must
    // NOT read as PARTITIONS_TOTAL - that would publish a corrupted sheet.
    expect: "PARTIAL",
  },

  // --- Patterns C/D: split of ONE fee, not of the program ----------------
  {
    name: "NESA - agency fee split four ways",
    source: "1,500 + 4,500 + 6,000 + 6,000 = 18,000 agency fee, inside a ~107,000 program",
    tranches: [$(1500), $(4500), $(6000), $(6000)],
    programTotal: $(107000),
    items: [
      { key: "Agency Fees", cents: $(18000) },
      { key: "Legal Fees", cents: $(5900) },
      { key: "Surrogate Compensation", cents: $(64600) },
      { key: "Surrogate Screening", cents: $(4500) },
    ],
    expect: "SPLITS_ITEM",
  },
  {
    name: "Fertility Source - agency fee retainer/match/contract split",
    source: "5,000 + 15,000 + 10,000 = 30,000 agency fee within a larger program",
    tranches: [$(5000), $(15000), $(10000)],
    programTotal: $(95000),
    items: [
      { key: "Agency Fee", cents: $(30000) },
      { key: "Gestational Carrier Compensation", cents: $(50000) },
      { key: "Intended Parent Attorney Fees", cents: $(4000) },
    ],
    expect: "SPLITS_ITEM",
  },
  {
    name: "EGGVISE - 50/50 split of the agency fee",
    source: "5,000 on reservation + 5,000 on medical clearance = the 10,000 EGGVISE fee",
    tranches: [$(5000), $(5000)],
    programTotal: $(45000),
    items: [
      { key: "EGGVISE Fee", cents: $(10000) },
      { key: "Donor Compensation", cents: $(25000) },
      { key: "Travel Expenses", cents: $(10000) },
    ],
    expect: "SPLITS_ITEM",
  },
  {
    name: "The Egg Asiancy - donor compensation split",
    source: "1,000 at medication start + 34,000 after retrieval = the 35,000 compensation line",
    tranches: [$(1000), $(34000)],
    programTotal: $(58000),
    items: [
      { key: "Compensation", cents: $(35000) },
      { key: "Agency fee", cents: $(12000) },
      { key: "Travel", cents: $(11000) },
    ],
    expect: "SPLITS_ITEM",
  },

  // --- Partial schedules: legitimate, but must be labelled ---------------
  {
    name: "Signature - two payments that do not reconcile to the stated total",
    source: "Real sheet: 13,550 + 10,000 stated against a 33,550 total. Travel is open-ended.",
    tranches: [$(13550), $(10000)],
    programTotal: $(33550),
    items: [
      { key: "Signature Agency Fee", cents: $(9000) },
      { key: "Screening Expenses", cents: $(1150) },
      { key: "Attorney Fees", cents: $(2425) },
      { key: "Donor Compensation", cents: $(10000) },
      { key: "Donor Travel Expenses", cents: $(10000) },
    ],
    expect: "PARTIAL",
  },

  // --- Overshoot: the model mixed schedule rows into line items ----------
  {
    name: "Schedule captured twice - tranche headers AND their subtotals",
    source: "Synthetic over-extraction: schedule reads ~2x the program, the signature of counting the same money twice",
    tranches: [$(100000), $(100000)],
    programTotal: $(105000),
    expect: "OVERSHOOT",
  },
  {
    name: "Modest overage stays acceptable, large overage does not",
    source: "20% over a firm total is within the 'starting at' band; 100% over is not",
    tranches: [$(60000), $(60000)],
    programTotal: $(100000),
    expect: "PARTITIONS_TOTAL",
  },

  // --- Pattern H: no schedule at all -------------------------------------
  {
    name: "PFCLA quote - no payment schedule stated",
    source: "Cancellation policy and card fees only, no stages",
    tranches: [],
    programTotal: $(42000),
    expect: "NONE",
  },
  {
    name: "Futura - flat price list",
    source: "No payment timing anywhere in the document",
    tranches: [],
    programTotal: $(22025),
    expect: "NONE",
  },

  // --- Tolerance edges ---------------------------------------------------
  {
    name: "Rounding drift inside tolerance still partitions",
    source: "Sub-2% drift must not demote a complete schedule to partial",
    tranches: [$(50000), $(50000)],
    programTotal: $(101500),
    expect: "PARTITIONS_TOTAL",
  },
  {
    name: "Small program, small absolute drift",
    source: "The $500 floor keeps tiny sheets from tripping the 2% band",
    tranches: [$(2000), $(3000)],
    programTotal: $(5300),
    expect: "PARTITIONS_TOTAL",
  },
];

let failures = 0;
let passes = 0;

console.log("\nPayment schedule reconciliation\n" + "=".repeat(70));

for (const c of CASES) {
  const result = reconcileSchedule(c.tranches, c.programTotal, c.items ?? []);
  const ok = result.verdict === c.expect;
  if (ok) {
    passes++;
    console.log(`  PASS  ${c.name}`);
    console.log(`        -> ${result.verdict}${result.matchedItemKey ? ` ("${result.matchedItemKey}")` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${c.name}`);
    console.log(`        ${c.source}`);
    console.log(`        expected ${c.expect}, got ${result.verdict}`);
    console.log(`        tranches=$${(result.trancheTotalCents / 100).toLocaleString()} program=$${(result.programTotalCents / 100).toLocaleString()}`);
  }
}

// --- Display helpers ------------------------------------------------------
console.log("\nDisplay helpers\n" + "=".repeat(70));

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US")}`;

const displayChecks: Array<{ label: string; got: string; want: string }> = [
  {
    label: "Range stays a range (never a midpoint)",
    got: formatTrancheAmount({ minValueCents: $(30000), maxValueCents: $(45000), amountBasis: "STATED" }, money),
    want: "$30,000 - $45,000",
  },
  {
    label: "Single amount renders plain",
    got: formatTrancheAmount({ minValueCents: $(62300), maxValueCents: $(62300), amountBasis: "STATED" }, money),
    want: "$62,300",
  },
  {
    label: "Remainder is never given a fake figure",
    got: formatTrancheAmount({ minValueCents: null, maxValueCents: null, amountBasis: "REMAINDER" }, money),
    want: "Remaining balance",
  },
  {
    label: "TBD reads as varies",
    got: formatTrancheAmount({ minValueCents: null, maxValueCents: null, amountBasis: "TBD" }, money),
    want: "Varies",
  },
  {
    label: "The provider's own wording wins over the enum",
    got: formatTiming({
      triggerType: "AT_LEGAL_CLEARANCE",
      triggerLabel: "within 5 days of legal sign off, before legal clearance issue",
    }),
    want: "within 5 days of legal sign off, before legal clearance issue",
  },
  {
    label: "Offset composes when no verbatim label exists",
    got: formatTiming({
      triggerType: "AT_MEDICAL_CLEARANCE",
      triggerLabel: null,
      offsetDays: 5,
      offsetBasis: "BUSINESS",
      offsetDirection: "AFTER",
    }),
    want: "Within 5 business days after at medical clearance",
  },
  {
    label: "Unknown trigger degrades to Other, never a wrong milestone",
    got: triggerLabel("NOT_A_REAL_TRIGGER"),
    want: "Other",
  },
];

for (const d of displayChecks) {
  if (d.got === d.want) {
    passes++;
    console.log(`  PASS  ${d.label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${d.label}`);
    console.log(`        expected: ${JSON.stringify(d.want)}`);
    console.log(`        got:      ${JSON.stringify(d.got)}`);
  }
}

// Journey ordering must be monotonic, or the parent timeline renders in a
// nonsensical order.
const journey = [
  "AT_SIGNING", "AT_MATCH", "AT_MEDICAL_CLEARANCE", "AT_LEGAL_CLEARANCE",
  "AT_MEDICATION_START", "AT_TRANSFER", "AT_HEARTBEAT", "AT_BIRTH",
];
let monotonic = true;
for (let i = 1; i < journey.length; i++) {
  if (triggerOrder(journey[i]) < triggerOrder(journey[i - 1])) monotonic = false;
}
if (monotonic) {
  passes++;
  console.log("  PASS  Trigger ordering follows the journey");
} else {
  failures++;
  console.log("  FAIL  Trigger ordering is not monotonic along the journey");
}

console.log("\n" + "=".repeat(70));
console.log(`${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
