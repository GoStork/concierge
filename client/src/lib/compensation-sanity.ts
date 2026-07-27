/**
 * A published compensation figure is a trust signal, so a wrong one is
 * expensive. A parent who has read one industry article knows US egg-donor
 * compensation runs roughly $8k-$50k; a profile advertising $200,000 doesn't
 * read as a premium donor, it reads as broken software - and having caught us
 * once, they discount the medical data they cannot check.
 *
 * Measured across the live catalogue when these bands were set:
 *   egg donor  - median $10,000, 40 profiles above $60k, max $300,000
 *   surrogate  - median $70,000, max $150,000 (all plausible)
 *
 * So the donor band is the one doing real work today; the surrogate band exists
 * to catch the same parse failure if it ever lands on that side.
 *
 * Deliberately NOT a clamp or a guess: an out-of-band figure is suppressed and
 * reported, never rewritten into something plausible. A fabricated number is
 * worse than a missing one.
 */

export type CompensationKind = "egg-donor" | "sperm-donor" | "surrogate";

const BANDS: Record<CompensationKind, { min: number; max: number }> = {
  // Elite / repeat donors reach ~$50k; $60k leaves headroom above the real market.
  "egg-donor": { min: 250, max: 60_000 },
  // Sperm donors are compensated per donation, an order of magnitude lower.
  "sperm-donor": { min: 25, max: 15_000 },
  // US surrogate base compensation legitimately reaches six figures.
  surrogate: { min: 5_000, max: 200_000 },
};

/** True when the figure is inside the plausible band for this profile type. */
export function isPlausibleCompensation(value: number | null | undefined, kind: CompensationKind): boolean {
  if (value == null) return false;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return false;
  const band = BANDS[kind];
  return n >= band.min && n <= band.max;
}

/**
 * The figure to publish, or null to show nothing.
 *
 * Callers render "-" (or omit the row) for null, exactly as they already do for
 * a missing value - an implausible figure and an absent one look the same to a
 * parent, which is the intent.
 */
export function safeCompensation(value: number | null | undefined, kind: CompensationKind): number | null {
  return isPlausibleCompensation(value, kind) ? Number(value) : null;
}

/** For the admin/provider side: why a figure was withheld. */
export function compensationWarning(value: number | null | undefined, kind: CompensationKind): string | null {
  if (value == null || Number(value) <= 0) return null;
  if (isPlausibleCompensation(value, kind)) return null;
  const band = BANDS[kind];
  return `${Number(value).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} is outside the plausible range for a ${kind.replace("-", " ")} (${band.min.toLocaleString()}-${band.max.toLocaleString()}). Hidden from parents until corrected - likely a cost-sheet parsing error.`;
}
