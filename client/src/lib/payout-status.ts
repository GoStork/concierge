/**
 * Single source of truth for the "where is the provider's payout right now?"
 * status badge. Used by both the Billing tab ("GoStork paid you" column)
 * and the Payouts tab history table so the two views stay in lockstep.
 *
 * Five terminal states, in priority order (most-final first):
 *   Received       - bank credited the provider's account (payout.paid)
 *   Failed at bank - bank rejected the credit (payout.failed)
 *   Failed         - platform->Connect transfer errored (payoutFailedAt)
 *   Sent           - platform->Connect transfer succeeded, Stripe's payout
 *                    schedule is now sweeping it to the provider's bank
 *   Pending        - parent paid the invoice but GoStork hasn't transferred
 *                    the provider's share yet (auto-fire pending or skipped
 *                    e.g. provider not onboarded at the time)
 *
 * "-" if the invoice isn't PAID yet (nothing to show).
 */

export type PayoutStatusLabel = "Refunded" | "Partially refunded" | "Received" | "Failed at bank" | "Failed" | "Sent" | "Pending" | "-";

export interface PayoutStatus {
  label: PayoutStatusLabel;
  /** Brand CSS color reference, e.g. "hsl(var(--brand-success))" */
  color: string;
  /** Hover tooltip text shown on the status pill */
  tooltip: string;
  /** True when the status represents the bank-side final confirmation */
  isReceived: boolean;
}

interface PayoutStatusInput {
  status?: string | null;
  stripeTransferId?: string | null;
  payoutFailedAt?: string | Date | null;
  bankPayoutCompletedAt?: string | Date | null;
  bankPayoutFailedAt?: string | Date | null;
  refundedAt?: string | Date | null;
  refundedAmount?: number | null;
  serviceAmount?: number | null;
}

export function derivePayoutStatus(inv: PayoutStatusInput): PayoutStatus {
  // Refunds win over everything else - once money goes back to the parent,
  // that's the user-facing reality regardless of whether the provider's
  // transfer fired earlier. We surface "Partially refunded" distinctly so
  // the provider sees they've kept part of the payout.
  if (inv.status === "REFUNDED" || (inv.refundedAt && inv.refundedAmount && inv.serviceAmount && inv.refundedAmount >= inv.serviceAmount)) {
    return {
      label: "Refunded",
      color: "hsl(var(--muted-foreground))",
      tooltip: "GoStork fully refunded the parent. Your share of the payout was reversed back to the platform proportionally.",
      isReceived: false,
    };
  }
  if (inv.status === "PARTIALLY_REFUNDED" || (inv.refundedAt && inv.refundedAmount)) {
    return {
      label: "Partially refunded",
      color: "hsl(var(--muted-foreground))",
      tooltip: "GoStork issued a partial refund to the parent. A proportional share was reversed from your payout.",
      isReceived: false,
    };
  }
  if (inv.bankPayoutCompletedAt) {
    return {
      label: "Received",
      color: "hsl(var(--brand-success))",
      tooltip: "Your bank received the payout. The money is in your account.",
      isReceived: true,
    };
  }
  if (inv.bankPayoutFailedAt) {
    return {
      label: "Failed at bank",
      color: "hsl(var(--destructive))",
      tooltip: "Your bank rejected the credit (closed account, wrong routing, or NSF). The money is still on Stripe's side. GoStork support has been notified.",
      isReceived: false,
    };
  }
  if (inv.payoutFailedAt) {
    return {
      label: "Failed",
      color: "hsl(var(--destructive))",
      tooltip: "GoStork couldn't send the payout (most often: parent's payment hasn't settled yet, or your bank info needs review). GoStork support has been notified.",
      isReceived: false,
    };
  }
  if (inv.stripeTransferId) {
    return {
      label: "Sent",
      color: "hsl(var(--brand-success))",
      tooltip: "GoStork's part is done. Stripe is sending the money to your bank, usually within 2 business days.",
      isReceived: false,
    };
  }
  if (inv.status === "PAID") {
    return {
      label: "Pending",
      color: "hsl(var(--brand-warning))",
      tooltip: "GoStork hasn't sent this payout yet. It will move to your bank within 2 business days of the parent's payment clearing.",
      isReceived: false,
    };
  }
  return {
    label: "-",
    color: "hsl(var(--muted-foreground))",
    tooltip: "No payout yet - the parent hasn't paid this invoice.",
    isReceived: false,
  };
}
