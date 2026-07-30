import { cn } from "@/lib/utils";
import { formatMoneyDollars } from "@/lib/format-money";
import { formatFieldLabel } from "@/lib/format-label";
import { formatTiming, formatTrancheAmount, payToLabel } from "@shared/payment-schedule";
import { Info, RotateCcw } from "lucide-react";

/**
 * Parent-facing payment schedule.
 *
 * The single renderer for an installment plan wherever a parent sees one -
 * the provider profile's program card and the cost sheet sent into chat.
 * Adding to a schedule (a new field, a new caveat) should mean editing this
 * one file, not chasing two divergent copies.
 *
 * Rendered as an ordered timeline because the order is real: these payments
 * happen in sequence along the parent's journey, and the sequence is the
 * information they came for.
 */

export interface TimelineTrancheItem {
  key: string;
  category?: string | null;
  minValueCents?: number | null;
  maxValueCents?: number | null;
  percent?: number | null;
  label?: string | null;
}

export interface TimelineTranche {
  id?: string;
  name: string;
  triggerType?: string | null;
  triggerLabel?: string | null;
  offsetDays?: number | null;
  offsetBasis?: string | null;
  offsetDirection?: string | null;
  minValueCents?: number | null;
  maxValueCents?: number | null;
  amountBasis?: string | null;
  payTo?: string | null;
  payToLabel?: string | null;
  isRefundable?: boolean | null;
  refundNote?: string | null;
  notes?: string | null;
  items?: TimelineTrancheItem[];
}

export interface PaymentScheduleData {
  tranches: TimelineTranche[];
  paymentTerms?: {
    escrowFloorCents?: number | null;
    replenishDays?: number | null;
    refundPolicy?: string | null;
    quoteValidDays?: number | null;
    cardFeePercent?: number | null;
    notes?: string | null;
  } | null;
  coversWholeProgram?: boolean;
  scheduleNote?: string | null;
}

const money = (cents: number) => formatMoneyDollars(cents / 100);

export function PaymentScheduleTimeline({
  schedule,
  className,
  compact = false,
}: {
  schedule: PaymentScheduleData | null | undefined;
  className?: string;
  /** Tighter spacing and no per-payment item breakdown, for chat cards. */
  compact?: boolean;
}) {
  if (!schedule || !schedule.tranches || schedule.tranches.length === 0) return null;

  const terms = schedule.paymentTerms;
  const hasTerms =
    !!terms &&
    (terms.escrowFloorCents != null ||
      terms.refundPolicy ||
      terms.quoteValidDays != null ||
      terms.cardFeePercent != null ||
      terms.notes);

  return (
    <div className={cn("space-y-3", className)} data-testid="payment-schedule-timeline">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <p className="t-micro-label">Payment schedule</p>
        {schedule.coversWholeProgram === false && (
          <span className="t-helper">Covers part of the program</span>
        )}
      </div>

      <ol className="relative space-y-0">
        {schedule.tranches.map((t, idx) => {
          const isLast = idx === schedule.tranches.length - 1;
          return (
            <li key={t.id ?? idx} className="relative flex gap-3 pb-3 last:pb-0" data-testid={`schedule-step-${idx}`}>
              {/* Rail + node */}
              <div className="flex flex-col items-center shrink-0">
                <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center tabular-nums">
                  {idx + 1}
                </span>
                {!isLast && <span className="w-px flex-1 bg-border mt-1" aria-hidden />}
              </div>

              <div className="min-w-0 flex-1 pb-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{t.name}</p>
                    <p className="t-helper">{formatTiming(t)}</p>
                  </div>
                  <p className="text-sm font-semibold text-foreground tabular-nums shrink-0 text-right">
                    {formatTrancheAmount(t, money)}
                  </p>
                </div>

                {/* Who holds the money. Most surrogacy payments fund an escrow
                    account rather than the agency, and saying so plainly is
                    the difference between a schedule parents trust and one
                    their attorney has to correct. */}
                <p className="t-helper mt-0.5">Paid to {payToLabel(t.payTo, t.payToLabel).toLowerCase()}</p>

                {t.isRefundable && (
                  <p className="t-helper mt-1 flex items-start gap-1 text-[hsl(var(--brand-success))]">
                    <RotateCcw className="w-3 h-3 mt-0.5 shrink-0" />
                    {t.refundNote || "Refundable"}
                  </p>
                )}

                {!compact && t.items && t.items.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {t.items.map((it, i) => (
                      <li key={`${it.key}-${i}`} className="t-helper flex items-baseline justify-between gap-2">
                        <span className="truncate">{it.label || formatFieldLabel(it.key)}</span>
                        {it.percent != null ? (
                          <span className="tabular-nums shrink-0">{it.percent}%</span>
                        ) : it.minValueCents != null ? (
                          <span className="tabular-nums shrink-0">{money(it.minValueCents)}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}

                {t.notes && <p className="t-helper mt-1 italic">{t.notes}</p>}
              </div>
            </li>
          );
        })}
      </ol>

      {schedule.scheduleNote && (
        <p className="t-helper flex items-start gap-1.5">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {schedule.scheduleNote}
        </p>
      )}

      {hasTerms && !compact && (
        <div className="rounded-[var(--radius)] bg-secondary/50 p-3 space-y-1">
          {terms!.escrowFloorCents != null && (
            <p className="t-helper">
              Your escrow balance needs to stay above {money(terms!.escrowFloorCents)}
              {terms!.replenishDays != null ? `, with ${terms!.replenishDays} days to top it up if it drops below` : ""}.
            </p>
          )}
          {terms!.refundPolicy && <p className="t-helper">{terms!.refundPolicy}</p>}
          {terms!.cardFeePercent != null && (
            <p className="t-helper">Card payments carry a {terms!.cardFeePercent}% fee.</p>
          )}
          {terms!.quoteValidDays != null && (
            <p className="t-helper">This estimate is valid for {terms!.quoteValidDays} days.</p>
          )}
          {terms!.notes && <p className="t-helper">{terms!.notes}</p>}
        </div>
      )}
    </div>
  );
}
