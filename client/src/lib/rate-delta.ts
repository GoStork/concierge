/**
 * How a clinic's live-birth rate is described against the national average.
 *
 * Above national stays a positive signal; below it is stated plainly rather
 * than in alarm red. CDC rates are NOT risk-adjusted - a clinic that accepts
 * complex cases scores lower than one that declines them - so a red minus sign
 * both misinforms the parent and punishes the provider for taking hard
 * patients. The number is unchanged; only the verdict attached to it is.
 *
 * Pure and separate from the component so the rule "a shortfall is never
 * styled as a failure" can be asserted directly.
 */

export type RateDelta = {
  /** Rounded percentage-point difference, signed. */
  diff: number;
  /** "+4% vs. national average" */
  label: string;
  /** Never "negative": a shortfall is neutral, not bad. */
  tone: "positive" | "neutral";
  /** Shown only when the clinic is below national, to explain why. */
  context: string | null;
};

const COMPLEXITY_NOTE =
  "CDC rates aren't adjusted for case complexity - clinics treating harder cases often report lower rates.";

export function describeRateDelta(clinicPct: number, nationalPct: number): RateDelta {
  const diff = clinicPct - nationalPct;
  const rounded = Math.round(diff);
  const atOrAbove = diff >= 0;
  return {
    diff: rounded,
    label: `${atOrAbove ? "+" : ""}${rounded}% vs. national average`,
    tone: atOrAbove ? "positive" : "neutral",
    context: atOrAbove ? null : COMPLEXITY_NOTE,
  };
}

/** The brand token each tone renders in. Never a destructive/red colour. */
export const RATE_TONE_CLASS: Record<RateDelta["tone"], string> = {
  positive: "text-[hsl(var(--brand-success))]",
  neutral: "text-foreground",
};
