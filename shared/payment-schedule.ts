/**
 * Payment schedules (installment plans) on provider cost sheets.
 *
 * Shared by the server (AI extraction, reconciliation, CRUD) and the client
 * (provider editor, parent-facing timeline) so the milestone vocabulary can
 * never drift between the two.
 *
 * CORE INVARIANT, restated here because every consumer depends on it:
 * a tranche NEVER contributes to any total. Program totals stay derived from
 * CostItem rows. A tranche is a *view over money already counted* - it holds
 * a stated amount for display and references the items it covers. This is
 * what makes it safe to extract installment rows that (in most sheets)
 * restate money already captured as line items.
 */

// ---------------------------------------------------------------------------
// Trigger vocabulary
// ---------------------------------------------------------------------------

/**
 * Canonical payment triggers, in journey order. Ordering is load-bearing:
 * it's what lets the parent-facing card render a timeline rather than a list,
 * and what lets the editor sort tranches sensibly after an edit.
 *
 * Derived from the trigger language actually used across the real cost-sheet
 * corpus (surrogacy agencies, egg donation agencies, IVF clinics).
 */
export const PAYMENT_TRIGGERS = [
  {
    id: "AT_SIGNING",
    label: "At signing",
    description: "Retainer or agency agreement signed, program sign-on",
    order: 10,
  },
  {
    id: "AT_MATCH",
    label: "At match",
    description: "Matched with a surrogate or donor",
    order: 20,
  },
  {
    id: "AT_MEDICAL_CLEARANCE",
    label: "At medical clearance",
    description: "Clinic approval, medically cleared, pre-approval by clinic",
    order: 30,
  },
  {
    id: "AT_LEGAL_CLEARANCE",
    label: "At legal clearance",
    description: "Agreement executed, legal clearance issued",
    order: 40,
  },
  {
    id: "AT_MEDICATION_START",
    label: "At medication start",
    description: "Injectable medications commence",
    order: 50,
  },
  {
    id: "AT_TRANSFER",
    label: "At embryo transfer",
    description: "Embryo transfer performed",
    order: 60,
  },
  {
    id: "AT_RETRIEVAL",
    label: "At egg retrieval",
    description: "Egg retrieval completed (donor cycles end here)",
    order: 60,
  },
  {
    id: "AT_HEARTBEAT",
    label: "At heartbeat confirmation",
    description: "Fetal heartbeat confirmed by ultrasound, around week 6",
    order: 70,
  },
  {
    id: "AT_GESTATIONAL_WEEK",
    label: "At a gestational week",
    description: "Week-indexed, e.g. the 26th week following transfer",
    order: 80,
  },
  {
    id: "AT_BIRTH",
    label: "At birth",
    description: "Delivery",
    order: 90,
  },
  {
    id: "POST_BIRTH",
    label: "After birth",
    description: "A stated period after delivery",
    order: 100,
  },
  {
    id: "BEFORE_CYCLE_START",
    label: "Before cycle start",
    description: "Time-relative rather than milestone-reached, e.g. two weeks before the cycle begins",
    order: 55,
  },
  {
    id: "OTHER",
    label: "Other",
    description: "Anything else - the written trigger carries the meaning",
    order: 999,
  },
] as const;

export type PaymentTriggerId = (typeof PAYMENT_TRIGGERS)[number]["id"];

export const PAYMENT_TRIGGER_IDS: PaymentTriggerId[] = PAYMENT_TRIGGERS.map((t) => t.id);

const TRIGGER_BY_ID = new Map(PAYMENT_TRIGGERS.map((t) => [t.id as string, t]));

export function isPaymentTrigger(value: unknown): value is PaymentTriggerId {
  return typeof value === "string" && TRIGGER_BY_ID.has(value);
}

export function triggerLabel(id: string | null | undefined): string {
  return (id && TRIGGER_BY_ID.get(id)?.label) || "Other";
}

export function triggerOrder(id: string | null | undefined): number {
  if (!id) return 999;
  return TRIGGER_BY_ID.get(id)?.order ?? 999;
}

// ---------------------------------------------------------------------------
// Payee routing
// ---------------------------------------------------------------------------

/**
 * Who actually receives the money.
 *
 * Not cosmetic. Most surrogacy tranches fund an escrow account that then
 * disburses - the agency never holds the funds - and real sheets tag every
 * line with a distinct payee (agency / escrow company / attorney / broker /
 * carrier). A UI that shows "Payment 1: $62,300" against the provider's name
 * misstates who holds the money on the largest financial decision these
 * parents will make.
 */
export const PAY_TO_OPTIONS = [
  { id: "ESCROW", label: "Escrow account", hint: "Funds the escrow/trust account, which then disburses" },
  { id: "PROVIDER", label: "Us directly", hint: "Paid to your organization" },
  { id: "ATTORNEY", label: "Attorney", hint: "Paid directly to the law firm" },
  { id: "CLINIC", label: "IVF clinic", hint: "Paid directly to the clinic" },
  { id: "PHARMACY", label: "Pharmacy", hint: "Paid directly to the pharmacy" },
  { id: "BROKER", label: "Insurance broker", hint: "Paid directly to the insurance broker" },
  { id: "SURROGATE", label: "Surrogate or donor", hint: "Paid to the carrier or donor" },
  { id: "OTHER", label: "Someone else", hint: "Describe who receives it" },
] as const;

export type PayToId = (typeof PAY_TO_OPTIONS)[number]["id"];

export const PAY_TO_IDS: PayToId[] = PAY_TO_OPTIONS.map((p) => p.id);

const PAY_TO_BY_ID = new Map(PAY_TO_OPTIONS.map((p) => [p.id as string, p]));

export function isPayTo(value: unknown): value is PayToId {
  return typeof value === "string" && PAY_TO_BY_ID.has(value);
}

export function payToLabel(id: string | null | undefined, custom?: string | null): string {
  if (custom && custom.trim()) return custom.trim();
  return (id && PAY_TO_BY_ID.get(id)?.label) || "Us directly";
}

// ---------------------------------------------------------------------------
// Amount basis
// ---------------------------------------------------------------------------

/**
 * How a tranche's amount is arrived at. STATED covers the majority; the rest
 * exist so we never store a fabricated literal for an amount the document
 * expresses as a relationship.
 */
export const AMOUNT_BASIS_OPTIONS = [
  { id: "STATED", label: "A set amount", hint: "The amount is written on the sheet" },
  { id: "SUM_OF_ITEMS", label: "Total of its line items", hint: "Adds up whatever is assigned to this payment" },
  { id: "REMAINDER", label: "The remaining balance", hint: "Whatever is left after the earlier payments" },
  { id: "PERCENT_OF", label: "A percentage of its line items", hint: "For example 80% of surrogate compensation" },
  { id: "TBD", label: "Varies", hint: "Not knowable up front" },
] as const;

export type AmountBasisId = (typeof AMOUNT_BASIS_OPTIONS)[number]["id"];

export const AMOUNT_BASIS_IDS: AmountBasisId[] = AMOUNT_BASIS_OPTIONS.map((a) => a.id);

export function isAmountBasis(value: unknown): value is AmountBasisId {
  return typeof value === "string" && (AMOUNT_BASIS_IDS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Recurrence (pattern F - drip payments on a single line item)
// ---------------------------------------------------------------------------

export const RECURRENCE_PERIODS = [
  { id: "WEEKLY", label: "Weekly", plural: "weeks" },
  { id: "MONTHLY", label: "Monthly", plural: "months" },
] as const;

export type RecurrencePeriodId = (typeof RECURRENCE_PERIODS)[number]["id"];

export interface CostItemRecurrence {
  amountCents: number;
  period: RecurrencePeriodId;
  /** Number of payments, when the sheet states one ("10 monthly installments"). */
  count?: number | null;
  /** Milestone the stream starts from. */
  startTrigger?: PaymentTriggerId | null;
  /** Gestational week the stream starts at ("commencing the 26th week"). */
  startWeek?: number | null;
  note?: string | null;
}

export function isRecurrence(value: unknown): value is CostItemRecurrence {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.amountCents === "number" &&
    typeof r.period === "string" &&
    (RECURRENCE_PERIODS as readonly { id: string }[]).some((p) => p.id === r.period)
  );
}

/** Human sentence for a recurring item, e.g. "$300/month for 12 months, from legal clearance". */
export function describeRecurrence(r: CostItemRecurrence, money: (cents: number) => string): string {
  const per = r.period === "WEEKLY" ? "week" : "month";
  const plural = r.period === "WEEKLY" ? "weeks" : "months";
  const head = `${money(r.amountCents)}/${per}`;
  const dur = r.count ? ` for ${r.count} ${plural}` : "";
  const from = r.startWeek
    ? `, from week ${r.startWeek}`
    : r.startTrigger
      ? `, from ${triggerLabel(r.startTrigger).toLowerCase()}`
      : "";
  return `${head}${dur}${from}`;
}

// ---------------------------------------------------------------------------
// Sheet-level payment terms
// ---------------------------------------------------------------------------

export interface CostSheetPaymentTerms {
  /** "The escrow balance shall not fall under $10k at any given moment." */
  escrowFloorCents?: number | null;
  /** "Prospective parents will be given 5 business days to deposit more funds." */
  replenishDays?: number | null;
  /** "Remainder refunded six months after birth; $2,000 held for eighteen months." */
  refundPolicy?: string | null;
  /** "Price sheet is valid for 90 days from date of receipt." */
  quoteValidDays?: number | null;
  acceptedMethods?: string[] | null;
  /** "A 3% convenience fee will be assessed to any payment made by credit card." */
  cardFeePercent?: number | null;
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// Trust gate
// ---------------------------------------------------------------------------

/**
 * Payment terms are higher-stakes than a subtype label, so an AI-parsed
 * schedule stays provider-only until the provider has reviewed it - mirroring
 * the existing isFixedCostSource confirmation pattern.
 */
export type ScheduleSource = "ai_proposed" | "provider_confirmed" | "provider_authored";

export function isParentVisibleSchedule(source: string | null | undefined): boolean {
  return source === "provider_confirmed" || source === "provider_authored";
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type ReconciliationVerdict =
  /** Tranches partition the whole program. Safe to publish as a sheet schedule. */
  | "PARTITIONS_TOTAL"
  /** Tranches sum to a single line item - a split of that fee, not of the program. */
  | "SPLITS_ITEM"
  /** Only part of the program is scheduled. Legitimate, but must be labelled. */
  | "PARTIAL"
  /** Tranches exceed the program total: the model mixed schedule rows into items. */
  | "OVERSHOOT"
  /** No schedule in the document. */
  | "NONE";

export interface ReconciliationResult {
  verdict: ReconciliationVerdict;
  /** Sum of tranche amounts, in cents (midpoint of any ranges). */
  trancheTotalCents: number;
  /** Program total from line items, in cents (midpoint of any ranges). */
  programTotalCents: number;
  /** When SPLITS_ITEM, the item the tranches add up to. */
  matchedItemKey?: string | null;
  /** Share of the program total the schedule accounts for, 0-1. */
  coverage: number;
  message: string;
}

/** Tranche/total agreement tolerance: 2% or $500, whichever is larger. */
export function reconciliationTolerance(programTotalCents: number): number {
  return Math.max(50_000, Math.round(programTotalCents * 0.02));
}

/**
 * How far ABOVE the program total a schedule may sit and still be read as
 * covering it.
 *
 * Deliberately far more permissive than the tolerance below the total,
 * because real sheets state their totals as floors: ACRC prints "Total
 * Estimate Fee $155,110+" while its three deposits sum to $167,000, and its
 * second deposit is explicitly "starting from $95,000... varies depending on
 * the Surrogate's Base Compensation". Flagging that as a double-count would
 * reject a perfectly good schedule.
 *
 * A genuine over-extraction (the same money captured twice) roughly doubles
 * the figure, so 25% cleanly separates the two.
 */
export function overshootTolerance(programTotalCents: number): number {
  return Math.max(50_000, Math.round(programTotalCents * 0.25));
}

/**
 * Classify an extracted schedule by arithmetic alone.
 *
 * This is the deterministic guard that replaces the old blanket
 * "skip all installments" prompt rule. The prompt was right that installment
 * rows usually restate money already captured as line items - so rather than
 * trusting the model to tell schedule from service, we extract both and let
 * the numbers decide what we're looking at.
 *
 * Never throws and never mutates totals; the worst case is OVERSHOOT, which
 * the caller surfaces to the provider instead of publishing.
 */
export function reconcileSchedule(
  trancheAmountsCents: number[],
  programTotalCents: number,
  itemAmountsCents: Array<{ key: string; cents: number }> = [],
): ReconciliationResult {
  const trancheTotalCents = trancheAmountsCents.reduce((sum, c) => sum + (c || 0), 0);

  if (trancheAmountsCents.length === 0 || trancheTotalCents <= 0) {
    return {
      verdict: "NONE",
      trancheTotalCents: 0,
      programTotalCents,
      coverage: 0,
      message: "No payment schedule found in this document.",
    };
  }

  const tol = reconciliationTolerance(programTotalCents);
  const overTol = overshootTolerance(programTotalCents);
  const coverage = programTotalCents > 0 ? trancheTotalCents / programTotalCents : 0;

  // Asymmetric on purpose. Below the total, a 2% gap means the schedule
  // genuinely doesn't cover everything. Above it, a gap that size means
  // nothing - published totals are routinely "starting at" floors while the
  // deposits are sized for a real surrogate's compensation.
  if (
    trancheTotalCents >= programTotalCents - tol &&
    trancheTotalCents <= programTotalCents + overTol
  ) {
    return {
      verdict: "PARTITIONS_TOTAL",
      trancheTotalCents,
      programTotalCents,
      coverage,
      message:
        trancheTotalCents > programTotalCents + tol
          ? "The payments cover the whole program. They come to a little more than the estimated total, which is normal when the total is a starting figure."
          : "The payments add up to the program total.",
    };
  }

  if (trancheTotalCents > programTotalCents + overTol) {
    return {
      verdict: "OVERSHOOT",
      trancheTotalCents,
      programTotalCents,
      coverage,
      message:
        "These payments add up to far more than the program total, so some of them may have been read as line items too. Worth a check before parents see it.",
    };
  }

  // Under the total: either a split of one specific fee, or a genuinely
  // partial schedule (common - agencies often schedule only their own fee).
  const itemMatch = itemAmountsCents.find(
    (it) => it.cents > 0 && Math.abs(it.cents - trancheTotalCents) <= Math.max(5_000, Math.round(it.cents * 0.02)),
  );
  if (itemMatch) {
    return {
      verdict: "SPLITS_ITEM",
      trancheTotalCents,
      programTotalCents,
      matchedItemKey: itemMatch.key,
      coverage,
      message: `These payments split "${itemMatch.key}" rather than the whole program.`,
    };
  }

  return {
    verdict: "PARTIAL",
    trancheTotalCents,
    programTotalCents,
    coverage,
    message: "The schedule covers part of the program. The rest is billed separately.",
  };
}

// ---------------------------------------------------------------------------
// Display helpers (shared by editor and parent card)
// ---------------------------------------------------------------------------

export interface TrancheLike {
  minValueCents?: number | null;
  maxValueCents?: number | null;
  amountBasis?: string | null;
}

/** Midpoint in cents, used for reconciliation maths only - never for display. */
export function trancheMidpointCents(t: TrancheLike): number {
  const min = t.minValueCents ?? t.maxValueCents ?? 0;
  const max = t.maxValueCents ?? t.minValueCents ?? 0;
  return Math.round((min + max) / 2);
}

/**
 * What a parent should read for this payment's amount. Ranges stay ranges -
 * real sheets state tranches as ranges up to $41k wide, and inventing a
 * midpoint would be false precision about someone's money.
 */
export function formatTrancheAmount(t: TrancheLike, money: (cents: number) => string): string {
  if (t.amountBasis === "REMAINDER") return "Remaining balance";
  if (t.amountBasis === "TBD") return "Varies";
  const min = t.minValueCents;
  const max = t.maxValueCents;
  if (min == null && max == null) return "Varies";
  if (min != null && max != null && min !== max) return `${money(min)} - ${money(max)}`;
  return money((min ?? max) as number);
}

/** "within 5 business days after legal clearance" */
export function formatTiming(t: {
  triggerType?: string | null;
  triggerLabel?: string | null;
  offsetDays?: number | null;
  offsetBasis?: string | null;
  offsetDirection?: string | null;
}): string {
  // The provider's own wording always wins - it carries nuance no enum holds.
  if (t.triggerLabel && t.triggerLabel.trim()) return t.triggerLabel.trim();
  const base = triggerLabel(t.triggerType).toLowerCase();
  if (!t.offsetDays) return base.charAt(0).toUpperCase() + base.slice(1);
  const unit = t.offsetBasis === "BUSINESS" ? "business days" : "days";
  const dir = t.offsetDirection === "BEFORE" ? "before" : "after";
  return `Within ${t.offsetDays} ${unit} ${dir} ${base}`;
}
