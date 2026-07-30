import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  CostSheetPaymentTerms,
  ReconciliationResult,
  isAmountBasis,
  isPayTo,
  isPaymentTrigger,
  isParentVisibleSchedule,
  reconcileSchedule,
  trancheMidpointCents,
} from "../../../../shared/payment-schedule";
import type { ParsedTranche } from "./costs-ai.service";

/**
 * True for the line that carries a donor's or surrogate's base compensation.
 *
 * Matches the rule `getProviderParentPrograms` already uses to swap in a
 * specific person's actual comp: category "compensation", or any key
 * containing "compensation". Catches "Surrogate Compensation", "Donor
 * Compensation", "Egg Donor Compensation" without false-positiving on lines
 * like "Health Insurance".
 */
export function isCompensationItem(item: { category?: string | null; key?: string | null }): boolean {
  const cat = (item.category || "").toLowerCase();
  const key = (item.key || "").toLowerCase();
  return cat === "compensation" || key.includes("compensation");
}

/**
 * Rows whose value is a COUNT, not money - "Number of Transfers Included: 3"
 * means three transfers, not three dollars.
 *
 * getProviderParentPrograms already excludes these from the total it shows
 * providers and parents. Reconciliation has to exclude them too, or the
 * "payments total X against a program total of Y" line quotes a Y that
 * disagrees with the figure on the same screen.
 */
const COUNTED_ONLY_KEYS = new Set([
  "Number of Egg Retrievals Included",
  "Number of Sperm Collections Included",
  "Number of Transfers Included",
]);

function isCountedOnlyItem(item: { key?: string | null }): boolean {
  // Variant suffixes ("(Standard)", "(Variant 2)") are stripped the same way
  // the totals path strips them.
  const baseKey = (item.key || "").replace(/\s*\((?:Standard|Variant \d+)\)$/, "");
  return COUNTED_ONLY_KEYS.has(baseKey);
}

/**
 * Rewrite a tranche's amount for a KNOWN person's compensation.
 *
 * Real schedules are stated as ranges because the surrogate's or donor's
 * compensation is not yet known - Genesis pays "80% of fixed surrogate
 * compensation" in deposit 2 and 20% in deposit 3, giving a $41,000-wide
 * band. Once the person is known, that band is mostly noise, and leaving it
 * would also contradict the line items on the same card, which already show
 * that person's real comp.
 *
 * Only the compensation-driven share of the amount moves; any other
 * variability in the tranche is preserved. Returns null when this tranche has
 * no compensation exposure, so callers can leave it untouched.
 */
function personaliseTrancheAmount(
  tranche: { minValueCents: number | null; maxValueCents: number | null; amountBasis: string; itemPayments?: Array<any> },
  actualCompensationCents: number,
): { minValueCents: number; maxValueCents: number } | null {
  const payments = tranche.itemPayments ?? [];
  const compPayment = payments.find((p) => isCompensationItem(p.costItem ?? {}));
  if (!compPayment) return null;

  const origMinCents = Math.round((compPayment.costItem?.minValue ?? compPayment.costItem?.maxValue ?? 0) * 100);
  const origMaxCents = Math.round((compPayment.costItem?.maxValue ?? compPayment.costItem?.minValue ?? 0) * 100);
  const origMidCents = Math.round((origMinCents + origMaxCents) / 2);
  if (origMidCents <= 0) return null;

  // What share of the compensation line this tranche carries.
  //   percent  -> stated directly (the 80/20 and 50/50 splits)
  //   amounts  -> a stated portion, scaled proportionally
  //   neither  -> the whole line falls in this tranche
  let share: number;
  if (compPayment.percent != null && compPayment.percent > 0) {
    share = compPayment.percent / 100;
  } else if (compPayment.minValueCents != null || compPayment.maxValueCents != null) {
    const portionMid =
      ((compPayment.minValueCents ?? compPayment.maxValueCents ?? 0) +
        (compPayment.maxValueCents ?? compPayment.minValueCents ?? 0)) / 2;
    share = portionMid / origMidCents;
  } else {
    share = 1;
  }
  if (!Number.isFinite(share) || share <= 0) return null;

  // Read the bounds through the same normalization the display and maths
  // layers use, so a malformed upper bound cannot skew the personalised
  // figure the way it skewed the rendered one.
  const rawMin = tranche.minValueCents ?? null;
  const rawMax = tranche.maxValueCents ?? null;
  const safeMax = rawMin != null && rawMax != null && rawMax < rawMin ? null : rawMax;
  const statedMin = rawMin ?? safeMax;
  const statedMax = safeMax ?? rawMin;
  if (statedMin == null || statedMax == null) return null;

  // Swap this tranche's compensation share out at the published range and
  // back in at the real figure. The comp-driven part of the band collapses;
  // everything else about the tranche stays exactly as published.
  const newMin = statedMin - Math.round(share * origMinCents) + Math.round(share * actualCompensationCents);
  const newMax = statedMax - Math.round(share * origMaxCents) + Math.round(share * actualCompensationCents);

  // A published range can be narrower than the comp range it contains (the
  // provider rounded), which would invert min and max. Order defensively
  // rather than showing a backwards range.
  const lo = Math.min(newMin, newMax);
  const hi = Math.max(newMin, newMax);
  if (lo < 0) return null;
  return { minValueCents: lo, maxValueCents: hi };
}

/**
 * Shape a loaded cost sheet's schedule for parent consumption, or null when
 * there isn't one to show.
 *
 * A standalone function (rather than a service method) so the parent-programs
 * query, which already has the sheet in hand with its tranches included, can
 * reuse it without a second round trip - and so the sent-quote snapshot and
 * the profile card can never drift into two different shapes.
 *
 * Returns null unless the provider has confirmed or authored the schedule.
 */
export function buildParentPaymentSchedule(
  sheet: {
    scheduleSource?: string | null;
    paymentTerms?: any;
    tranches?: Array<any>;
    items?: Array<{ minValue: number | null; maxValue: number | null; isIncluded: boolean; isTier: boolean; key: string; category?: string }>;
  },
  /**
   * The matched donor's or surrogate's actual compensation, in DOLLARS, when
   * one is known. Tranche amounts are rewritten around it so the schedule
   * agrees with the line items on the same card, which already swap in this
   * person's real compensation. Omit while browsing generally.
   */
  specificCompensation?: number | null,
): {
  tranches: Array<any>;
  paymentTerms: any;
  coversWholeProgram: boolean;
  scheduleNote: string | null;
  isPersonalised: boolean;
} | null {
  if (!isParentVisibleSchedule(sheet.scheduleSource)) return null;
  const tranches = sheet.tranches ?? [];
  if (tranches.length === 0) return null;

  const items = sheet.items ?? [];
  const mid = (min: number | null, max: number | null) =>
    (((min ?? max ?? 0) + (max ?? min ?? 0)) / 2);

  // Program total from LINE ITEMS only - the same basis the rest of the cost
  // system uses. Tranches are never summed into a total.
  //
  // Two totals, because a schedule and the card's total can legitimately be
  // stated on different bases: the PUBLISHED total, and the total recomputed
  // at a matched person's real compensation (which is what the card shows).
  // The reconciliation has to be judged against whichever basis the tranche
  // amounts themselves are in, or it reports a mismatch that isn't real.
  const totalOn = (useSpecific: boolean): number => {
    let sum = 0;
    const tiers: number[] = [];
    for (const it of items) {
      if (!it.isIncluded) continue;
      if (isCountedOnlyItem(it)) continue;
      const v =
        useSpecific && specificCompensation != null && specificCompensation > 0 && isCompensationItem(it)
          ? specificCompensation
          : mid(it.minValue, it.maxValue);
      if (it.isTier) tiers.push(v);
      else sum += v;
    }
    if (tiers.length > 0) sum += Math.min(...tiers);
    return Math.round(sum * 100);
  };
  const publishedTotalCents = totalOn(false);
  const personalisedTotalCents = totalOn(true);

  // Rewrite compensation-driven amounts around the matched person, so the
  // schedule agrees with the line items beside it and a parent gets a figure
  // they can actually plan against instead of a band tens of thousands wide.
  //
  // This can only fire for a tranche that has the compensation line assigned
  // to it. A schedule whose stages carry no item assignments - common when
  // the source document lists deposits in prose - cannot be personalised, and
  // is handled honestly below rather than silently mismatched.
  const actualCompCents =
    specificCompensation != null && specificCompensation > 0
      ? Math.round(specificCompensation * 100)
      : null;
  let isPersonalised = false;
  const resolved = tranches.map((t) => {
    if (actualCompCents == null) return t;
    const adjusted = personaliseTrancheAmount(t, actualCompCents);
    if (!adjusted) return t;
    isPersonalised = true;
    return { ...t, minValueCents: adjusted.minValueCents, maxValueCents: adjusted.maxValueCents };
  });

  // Judge the stages against the basis they are actually stated in. When the
  // stages personalised, that is the personalised total; when they stayed at
  // published figures, it is the published total. Comparing published stages
  // against a personalised total made a complete schedule report as covering
  // only part of the program.
  const programTotalCents = isPersonalised ? personalisedTotalCents : publishedTotalCents;

  // A card whose totals moved for this person but whose stages could not:
  // the amounts are still the provider's published estimate, and saying so is
  // the honest alternative to either faking precision or letting the two
  // halves of the card quietly disagree.
  const showsPublishedAmountsOnPersonalisedCard =
    actualCompCents != null && !isPersonalised && personalisedTotalCents !== publishedTotalCents;

  const statedAmounts = resolved
    .filter((t) => t.amountBasis !== "REMAINDER" && t.amountBasis !== "TBD")
    .map((t) => trancheMidpointCents(t))
    .filter((c) => c > 0);

  const rec = reconcileSchedule(
    statedAmounts,
    programTotalCents,
    items
      .filter((i) => i.isIncluded && !isCountedOnlyItem(i))
      .map((i) => ({
        key: i.key,
        // Same basis as the total above, so a SPLITS_ITEM match compares
        // like with like.
        cents: Math.round(
          (isPersonalised && specificCompensation != null && specificCompensation > 0 && isCompensationItem(i)
            ? specificCompensation
            : mid(i.minValue, i.maxValue)) * 100,
        ),
      })),
  );
  const hasRemainder = tranches.some((t) => t.amountBasis === "REMAINDER");
  const coversWholeProgram = rec.verdict === "PARTITIONS_TOTAL" || hasRemainder;

  return {
    isPersonalised,
    tranches: resolved.map((t) => ({
      id: t.id,
      name: t.name,
      triggerType: t.triggerType,
      triggerLabel: t.triggerLabel,
      offsetDays: t.offsetDays,
      offsetBasis: t.offsetBasis,
      offsetDirection: t.offsetDirection,
      minValueCents: t.minValueCents,
      maxValueCents: t.maxValueCents,
      amountBasis: t.amountBasis,
      payTo: t.payTo,
      payToLabel: t.payToLabel,
      isRefundable: t.isRefundable,
      refundNote: t.refundNote,
      notes: t.notes,
      items: (t.itemPayments ?? []).map((p: any) => ({
        key: p.costItem?.key ?? "",
        category: p.costItem?.category ?? null,
        minValueCents: p.minValueCents,
        maxValueCents: p.maxValueCents,
        percent: p.percent,
        label: p.label,
      })),
    })),
    paymentTerms: sheet.paymentTerms ?? null,
    coversWholeProgram,
    // Parents are told plainly what they are looking at: a schedule that only
    // covers part of the bill, a split of one fee, or - when the card's totals
    // moved for their match but these stages could not - that the amounts are
    // still the provider's published estimate.
    scheduleNote: showsPublishedAmountsOnPersonalisedCard
      ? "These amounts are the provider's published estimate. Your match's compensation differs, so the actual payments will vary."
      : !coversWholeProgram && rec.verdict === "PARTIAL"
        ? "This schedule covers part of the program. Remaining costs are billed separately."
        : rec.verdict === "SPLITS_ITEM"
          ? rec.message
          : null,
  };
}

/**
 * The provider's published installment plan, shaped for a parent and ready to
 * be frozen onto a quote at send time.
 *
 * Shared by every path that creates a ProviderQuote - the manual send, the
 * auto-draft approval and bank checkout - so a parent's experience does not
 * depend on which button the provider happened to press.
 *
 * `preferredSheetId` targets the exact sheet a quote was drafted from when the
 * caller knows it; otherwise the provider's most recently updated approved
 * sheet carrying a confirmed schedule stands in. Returns null when they have
 * none, which renders as no timeline rather than an invented one.
 */
export async function resolveQuotePaymentSchedule(
  db: any,
  providerId: string,
  opts: { sessionId?: string | null; preferredSheetId?: string | null } = {},
): Promise<ReturnType<typeof buildParentPaymentSchedule>> {
  const include = {
    items: { orderBy: [{ category: "asc" as const }, { sortOrder: "asc" as const }] },
    tranches: {
      orderBy: { sortOrder: "asc" as const },
      include: {
        itemPayments: {
          orderBy: { sortOrder: "asc" as const },
          include: { costItem: { select: { key: true, category: true } } },
        },
      },
    },
  };
  const publishedSources = ["provider_confirmed", "provider_authored"];

  try {
    let sheet: any = null;
    if (opts.preferredSheetId) {
      sheet = await db.providerCostSheet.findFirst({
        where: { id: opts.preferredSheetId, scheduleSource: { in: publishedSources } },
        include,
      });
    }
    if (!sheet) {
      sheet = await db.providerCostSheet.findFirst({
        where: {
          providerId,
          status: "APPROVED",
          parentClientId: null,
          scheduleSource: { in: publishedSources },
        },
        orderBy: { updatedAt: "desc" },
        include,
      });
    }
    if (!sheet) return null;

    // Resolve at the matched person's real compensation when the conversation
    // has established one, so the schedule agrees with the line items.
    let specificCompensation: number | null = null;
    if (opts.sessionId) {
      try {
        const { extractFromChatMessages } = await import("../billing/cost-sheet-chat-extractor");
        const messages = await db.aiChatMessage.findMany({
          where: { sessionId: opts.sessionId },
          orderBy: { createdAt: "asc" },
          select: { content: true },
        });
        const extracted = extractFromChatMessages(messages);
        const compCents = extracted.surrogateCompCents ?? extracted.donorCompCents;
        if (compCents && compCents > 0) specificCompensation = compCents / 100;
      } catch {
        // Opportunistic. The published range is a fine answer.
      }
    }

    return buildParentPaymentSchedule(sheet, specificCompensation);
  } catch {
    // A schedule is additive information on a quote. Never let this block a
    // provider from sending a cost sheet.
    return null;
  }
}

/**
 * Payment schedules (installment plans) attached to a provider cost sheet.
 *
 * CORE INVARIANT enforced throughout this file: a tranche NEVER contributes
 * to any total. Program totals stay derived from CostItem rows; a tranche is
 * a view over money already counted. Nothing here writes to CostItem values,
 * and no total-cost path reads a tranche.
 */
@Injectable()
export class PaymentScheduleService {
  private readonly logger = new Logger(PaymentScheduleService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * Full schedule for a sheet: tranches in order, each with the line items it
   * pays for, plus sheet-level terms and a live reconciliation verdict.
   */
  async getSchedule(sheetId: string) {
    const sheet = await this.prisma.providerCostSheet.findUnique({
      where: { id: sheetId },
      select: { id: true, paymentTerms: true, scheduleSource: true },
    });
    if (!sheet) return null;

    const [tranches, items] = await Promise.all([
      this.prisma.costTranche.findMany({
        where: { providerCostSheetId: sheetId },
        orderBy: { sortOrder: "asc" },
        include: {
          itemPayments: {
            orderBy: { sortOrder: "asc" },
            include: {
              costItem: { select: { id: true, category: true, key: true, minValue: true, maxValue: true } },
            },
          },
        },
      }),
      this.prisma.costItem.findMany({
        where: { providerCostSheetId: sheetId },
        orderBy: { sortOrder: "asc" },
        select: {
          id: true, category: true, key: true, minValue: true, maxValue: true,
          isIncluded: true, isTier: true, recurrence: true,
        },
      }),
    ]);

    return {
      sheetId,
      scheduleSource: sheet.scheduleSource ?? null,
      isParentVisible: isParentVisibleSchedule(sheet.scheduleSource),
      paymentTerms: (sheet.paymentTerms as CostSheetPaymentTerms | null) ?? null,
      tranches,
      // Every item on the sheet, so the editor can offer assignment targets
      // and show which ones aren't covered by any payment yet.
      items,
      reconciliation: this.reconcile(tranches, items),
    };
  }

  /**
   * Program total in cents, derived from line items ONLY - the same basis the
   * rest of the cost system uses. Tier items are alternatives rather than
   * additive, so the cheapest tier stands in for the group; excluded
   * (optional/contingency) items are out.
   */
  private programTotalCents(
    items: Array<{ minValue: number | null; maxValue: number | null; isIncluded: boolean; isTier: boolean; key?: string }>,
  ): number {
    const dollarsToCents = (v: number) => Math.round(v * 100);
    let total = 0;
    const tierValues: number[] = [];
    for (const it of items) {
      if (!it.isIncluded) continue;
      // Count rows ("Number of Transfers Included: 3") are not money.
      if (isCountedOnlyItem(it)) continue;
      const min = it.minValue ?? it.maxValue ?? 0;
      const max = it.maxValue ?? it.minValue ?? 0;
      const mid = (min + max) / 2;
      if (it.isTier) tierValues.push(mid);
      else total += mid;
    }
    if (tierValues.length > 0) total += Math.min(...tierValues);
    return dollarsToCents(total);
  }

  /** Classify the schedule against the sheet's own line items, by arithmetic. */
  private reconcile(
    tranches: Array<{ minValueCents: number | null; maxValueCents: number | null; amountBasis: string }>,
    items: Array<{ key: string; minValue: number | null; maxValue: number | null; isIncluded: boolean; isTier: boolean }>,
  ): ReconciliationResult {
    // REMAINDER / TBD tranches have no stated figure to reconcile against;
    // excluding them keeps a deposit-plus-remainder sheet from reading as a
    // wildly partial schedule.
    const amounts = tranches
      .filter((t) => t.amountBasis !== "REMAINDER" && t.amountBasis !== "TBD")
      .map((t) => trancheMidpointCents(t))
      .filter((c) => c > 0);

    const programTotal = this.programTotalCents(items);
    const itemAmounts = items
      .filter((i) => i.isIncluded && !isCountedOnlyItem(i))
      .map((i) => ({
        key: i.key,
        cents: Math.round((((i.minValue ?? i.maxValue ?? 0) + (i.maxValue ?? i.minValue ?? 0)) / 2) * 100),
      }));

    const result = reconcileSchedule(amounts, programTotal, itemAmounts);

    // A deposit-plus-remainder schedule is complete by construction even
    // though its stated amounts fall short of the total - the remainder
    // tranche absorbs the difference. Don't label that "partial".
    const hasRemainder = tranches.some((t) => t.amountBasis === "REMAINDER");
    if (hasRemainder && result.verdict === "PARTIAL") {
      return {
        ...result,
        verdict: "PARTITIONS_TOTAL",
        message: "A deposit plus the remaining balance, which covers the program total.",
      };
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Write - AI ingest
  // -------------------------------------------------------------------------

  /**
   * Persist the tranches the parser extracted from an uploaded document.
   *
   * Runs during the background parse, so it lands as "ai_proposed": visible
   * to the provider for review and correction, invisible to parents until
   * they confirm. Payment terms are higher-stakes than a subtype label, and
   * this mirrors the existing isFixedCostSource confirmation pattern.
   *
   * Never overwrites a schedule the provider has already confirmed or
   * authored - a re-parse must not silently discard their corrections.
   */
  async saveParsedSchedule(
    sheetId: string,
    tranches: ParsedTranche[],
    paymentTerms: CostSheetPaymentTerms | null,
  ): Promise<void> {
    const sheet = await this.prisma.providerCostSheet.findUnique({
      where: { id: sheetId },
      select: { scheduleSource: true },
    });
    if (!sheet) return;
    if (sheet.scheduleSource === "provider_confirmed" || sheet.scheduleSource === "provider_authored") {
      this.logger.log(
        `saveParsedSchedule(${sheetId}): skipped - the provider has already confirmed or authored this schedule`,
      );
      return;
    }

    if (tranches.length === 0 && !paymentTerms) {
      // Pattern H: the document states no payment timing. Leave it empty
      // rather than synthesising a plausible deposit - a fabricated schedule
      // about someone's money is the worst version of a made-up fallback.
      return;
    }

    await this.prisma.costTranche.deleteMany({ where: { providerCostSheetId: sheetId } });

    const itemRows = await this.prisma.costItem.findMany({
      where: { providerCostSheetId: sheetId },
      select: { id: true, category: true, key: true },
    });
    const itemIdByKey = new Map(itemRows.map((i) => [`${i.category}::${i.key}`, i.id]));

    const toCents = (v: number | null): number | null => (v == null ? null : Math.round(v * 100));

    for (let i = 0; i < tranches.length; i++) {
      const t = tranches[i];
      const created = await this.prisma.costTranche.create({
        data: {
          providerCostSheetId: sheetId,
          sortOrder: i,
          name: t.name,
          triggerType: t.triggerType,
          triggerLabel: t.triggerLabel,
          offsetDays: t.offsetDays,
          offsetBasis: t.offsetBasis ?? "CALENDAR",
          offsetDirection: t.offsetDirection ?? "AFTER",
          minValueCents: toCents(t.minValue),
          maxValueCents: toCents(t.maxValue),
          amountBasis: t.amountBasis,
          payTo: t.payTo,
          isRefundable: t.isRefundable,
          refundNote: t.refundNote,
          notes: t.notes,
        },
      });

      const links = t.itemKeys
        .map((k, idx) => {
          const costItemId = itemIdByKey.get(k);
          return costItemId ? { costItemId, trancheId: created.id, sortOrder: idx } : null;
        })
        .filter((l): l is { costItemId: string; trancheId: string; sortOrder: number } => l !== null);
      if (links.length > 0) {
        await this.prisma.costItemPayment.createMany({ data: links, skipDuplicates: true });
      }
    }

    await this.prisma.providerCostSheet.update({
      where: { id: sheetId },
      data: {
        paymentTerms: (paymentTerms as any) ?? undefined,
        scheduleSource: "ai_proposed",
      },
    });

    this.logger.log(
      `saveParsedSchedule(${sheetId}): saved ${tranches.length} tranche(s) as ai_proposed (awaiting provider confirmation)`,
    );
  }

  // -------------------------------------------------------------------------
  // Write - provider editing
  // -------------------------------------------------------------------------

  /**
   * Replace a sheet's schedule wholesale with what the provider has in the
   * editor. A single atomic save keeps the editor's optimistic state and the
   * DB from drifting mid-edit, and lets reordering, adding and deleting all
   * flow through one code path.
   *
   * `source` distinguishes a corrected AI parse from one built from scratch,
   * purely so we can tell later how much of the corpus the parser handles
   * unaided. Both are equally parent-visible.
   */
  async replaceSchedule(
    sheetId: string,
    input: {
      tranches: Array<{
        name: string;
        triggerType?: string;
        triggerLabel?: string | null;
        offsetDays?: number | null;
        offsetBasis?: string | null;
        offsetDirection?: string | null;
        minValueCents?: number | null;
        maxValueCents?: number | null;
        amountBasis?: string;
        payTo?: string;
        payToLabel?: string | null;
        isRefundable?: boolean | null;
        refundNote?: string | null;
        notes?: string | null;
        itemIds?: string[];
        itemPayments?: Array<{
          costItemId: string;
          minValueCents?: number | null;
          maxValueCents?: number | null;
          percent?: number | null;
          label?: string | null;
        }>;
      }>;
      paymentTerms?: CostSheetPaymentTerms | null;
      source?: "provider_confirmed" | "provider_authored";
    },
  ) {
    const sheet = await this.prisma.providerCostSheet.findUnique({
      where: { id: sheetId },
      select: { id: true, scheduleSource: true },
    });
    if (!sheet) throw new Error("Cost sheet not found");

    // Only accept assignments to items that actually live on this sheet -
    // a stale or cross-sheet id would otherwise attach a parent's payment to
    // someone else's line item.
    const ownItems = await this.prisma.costItem.findMany({
      where: { providerCostSheetId: sheetId },
      select: { id: true },
    });
    const ownItemIds = new Set(ownItems.map((i) => i.id));

    await this.prisma.costTranche.deleteMany({ where: { providerCostSheetId: sheetId } });

    for (let i = 0; i < input.tranches.length; i++) {
      const t = input.tranches[i];
      const name = String(t.name ?? "").trim().slice(0, 120);
      if (!name) continue;

      const created = await this.prisma.costTranche.create({
        data: {
          providerCostSheetId: sheetId,
          sortOrder: i,
          name,
          triggerType: isPaymentTrigger(t.triggerType) ? t.triggerType : "OTHER",
          triggerLabel: t.triggerLabel ? String(t.triggerLabel).slice(0, 400) : null,
          offsetDays: Number.isFinite(Number(t.offsetDays)) && Number(t.offsetDays) > 0 ? Math.round(Number(t.offsetDays)) : null,
          offsetBasis: t.offsetBasis === "BUSINESS" ? "BUSINESS" : "CALENDAR",
          offsetDirection: t.offsetDirection === "BEFORE" ? "BEFORE" : "AFTER",
          minValueCents: this.intOrNull(t.minValueCents),
          maxValueCents: this.intOrNull(t.maxValueCents),
          amountBasis: isAmountBasis(t.amountBasis) ? t.amountBasis : "STATED",
          payTo: isPayTo(t.payTo) ? t.payTo : "PROVIDER",
          payToLabel: t.payToLabel ? String(t.payToLabel).slice(0, 120) : null,
          isRefundable: typeof t.isRefundable === "boolean" ? t.isRefundable : null,
          refundNote: t.refundNote ? String(t.refundNote).slice(0, 400) : null,
          notes: t.notes ? String(t.notes).slice(0, 600) : null,
        },
      });

      // Two accepted shapes: plain itemIds (whole item paid in this tranche)
      // or itemPayments carrying a portion/percentage for split fees.
      const payments = (t.itemPayments && t.itemPayments.length > 0
        ? t.itemPayments.map((p, idx) => ({
            costItemId: p.costItemId,
            trancheId: created.id,
            minValueCents: this.intOrNull(p.minValueCents),
            maxValueCents: this.intOrNull(p.maxValueCents),
            percent: Number.isFinite(Number(p.percent)) && Number(p.percent) > 0 ? Number(p.percent) : null,
            label: p.label ? String(p.label).slice(0, 200) : null,
            sortOrder: idx,
          }))
        : (t.itemIds ?? []).map((id, idx) => ({
            costItemId: id,
            trancheId: created.id,
            minValueCents: null,
            maxValueCents: null,
            percent: null,
            label: null,
            sortOrder: idx,
          }))
      ).filter((p) => ownItemIds.has(p.costItemId));

      if (payments.length > 0) {
        await this.prisma.costItemPayment.createMany({ data: payments, skipDuplicates: true });
      }
    }

    // Once a human has touched it, it stops being an AI proposal. Preserve an
    // existing provider_authored marker so a from-scratch schedule doesn't
    // get relabelled as a confirmed parse on its next edit.
    const nextSource =
      input.source ??
      (sheet.scheduleSource === "provider_authored" ? "provider_authored" : "provider_confirmed");

    // Prisma types the clear-value of a nullable Json column as DbNull rather
    // than a bare null, so the update payload is built loosely.
    const sheetUpdate: Record<string, unknown> = { scheduleSource: nextSource };
    if (input.paymentTerms !== undefined) {
      sheetUpdate.paymentTerms = input.paymentTerms ?? null;
    }
    await this.prisma.providerCostSheet.update({
      where: { id: sheetId },
      data: sheetUpdate as any,
    });

    this.logger.log(
      `replaceSchedule(${sheetId}): ${input.tranches.length} tranche(s) saved as ${nextSource}`,
    );
    return this.getSchedule(sheetId);
  }

  /** Confirm an AI-parsed schedule as-is, making it parent-visible. */
  async confirmSchedule(sheetId: string) {
    await this.prisma.providerCostSheet.update({
      where: { id: sheetId },
      data: { scheduleSource: "provider_confirmed" },
    });
    return this.getSchedule(sheetId);
  }

  /** Remove the schedule entirely and return the sheet to having none. */
  async clearSchedule(sheetId: string) {
    await this.prisma.costTranche.deleteMany({ where: { providerCostSheetId: sheetId } });
    await this.prisma.providerCostSheet.update({
      where: { id: sheetId },
      // Prisma types the clear-value of a nullable Json column as DbNull
      // rather than a bare null, so this payload is built loosely.
      data: { scheduleSource: null, paymentTerms: null } as any,
    });
    return this.getSchedule(sheetId);
  }

  /**
   * Starter tranches for a provider building a schedule from scratch on a
   * sheet whose document had none.
   *
   * Deliberately empty on amounts. The stages are the common shape for the
   * service type (drawn from how real sheets in this category stage their
   * payments), but every figure is the provider's to enter - pre-filling
   * money we invented is exactly the fabrication this system avoids.
   */
  suggestStarterTranches(serviceTypes: string[]): Array<{
    name: string;
    triggerType: string;
    triggerLabel: string;
    payTo: string;
  }> {
    const tags = new Set(serviceTypes ?? []);

    if (tags.has("surrogacy")) {
      return [
        { name: "First Deposit", triggerType: "AT_MATCH", triggerLabel: "Due at match", payTo: "ESCROW" },
        { name: "Second Deposit", triggerType: "AT_LEGAL_CLEARANCE", triggerLabel: "Due at legal clearance", payTo: "ESCROW" },
        { name: "Third Deposit", triggerType: "AT_HEARTBEAT", triggerLabel: "Due at heartbeat confirmation", payTo: "ESCROW" },
      ];
    }
    if (tags.has("egg_donor") || tags.has("sperm_donor")) {
      return [
        { name: "First Payment", triggerType: "AT_SIGNING", triggerLabel: "Due at agency sign-on", payTo: "PROVIDER" },
        { name: "Second Payment", triggerType: "AT_MEDICAL_CLEARANCE", triggerLabel: "Due at donor medical clearance", payTo: "ESCROW" },
      ];
    }
    if (tags.has("ivf_clinic")) {
      return [
        { name: "Deposit", triggerType: "AT_SIGNING", triggerLabel: "Due when you decide to move forward", payTo: "PROVIDER" },
        { name: "Balance", triggerType: "BEFORE_CYCLE_START", triggerLabel: "Due before your cycle starts", payTo: "PROVIDER" },
      ];
    }
    return [
      { name: "First Payment", triggerType: "AT_SIGNING", triggerLabel: "Due at signing", payTo: "PROVIDER" },
    ];
  }

  private intOrNull(v: unknown): number | null {
    // Guard the empty cases BEFORE coercing: Number(null) and Number("") are
    // both 0, which would turn "no upper bound given" into a real $0 and make
    // a single-amount payment render as the range "$17,500 - $0" and
    // reconcile at half its value.
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  }

  // -------------------------------------------------------------------------
  // Parent-facing
  // -------------------------------------------------------------------------

}
