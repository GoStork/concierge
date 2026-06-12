/**
 * Shared IVF success-rate selection helper.
 *
 * Factored out of the `search_clinics` MCP tool so that doctor cards
 * (which surface the success rate of each clinic a doctor practices at)
 * reuse the EXACT same CDC-rate selection logic - never a forked copy.
 *
 * Given a clinic's IvfSuccessRate rows and the parent's context
 * (eggSource / ageGroup / isNewPatient), it picks the single primary rate
 * the way the clinic matcher does, and returns the display-ready fields
 * the cards render (label, this-clinic %, national average, top-10% flag,
 * cycle count, and the full age-group breakdown).
 */

export type EggSource = "own_eggs" | "donor";
export type AgeGroup = "under_35" | "35_37" | "38_40" | "over_40";

export interface IvfRateRow {
  profileType: string; // "own_eggs" | "donor"
  metricCode: string;
  ageGroup?: string | null;
  isNewPatient?: boolean;
  successRate: number | string | { toString(): string };
  nationalAverage: number | string | { toString(): string };
  top10pct?: boolean | null;
  cycleCount?: number | null;
}

export interface SuccessRateContext {
  eggSource: EggSource;
  ageGroup: AgeGroup;
  isNewPatient: boolean;
}

export interface ComputedSuccessRate {
  /** This clinic's live-birth rate for the parent's profile, e.g. "55%" (null if no CDC data). */
  successRate: string | null;
  /** Human label for which metric the rate represents, e.g. "Own eggs, 35-37" or "Donor eggs". */
  successRateLabel: string;
  /** National average for the same metric, e.g. "48%" (null if no CDC data). */
  nationalAverage: string | null;
  /** Whether this clinic is in the top 10% nationally for the primary metric. */
  top10pct: boolean;
  /** Number of cycles backing the primary metric (sample size). */
  cycleCount: number | null;
  /** Age-group breakdown of own-egg rates (+ "Donor eggs"), e.g. { "Under 35": 55, "35-37": 48 }. */
  successRatesByAge: Record<string, number> | null;
  /** Numeric form of successRate (0-100) for sorting; null when no data. */
  successPct: number | null;
}

const AGE_LABELS: Record<string, string> = {
  under_35: "Under 35",
  "35_37": "35-37",
  "38_40": "38-40",
  over_40: "Over 40",
};

function ageLabelOf(ageGroup: string | null | undefined): string {
  return (ageGroup && AGE_LABELS[ageGroup]) || ageGroup || "Under 35";
}

/**
 * Select the primary success-rate row for a parent profile and return the
 * display-ready fields. Pure function over the clinic's IvfSuccessRate rows.
 */
export function computeClinicSuccessRate(
  rates: IvfRateRow[] | null | undefined,
  ctx: SuccessRateContext,
): ComputedSuccessRate {
  const { eggSource, ageGroup, isNewPatient } = ctx;
  const rows = rates || [];

  let primaryRate: IvfRateRow | null = null;
  if (eggSource === "donor") {
    // Donor egg rates are not age-specific.
    primaryRate =
      rows.find((r) => r.profileType === "donor" && r.metricCode === "pct_transfers_live_births_donor") || null;
  } else {
    // Own eggs: prefer the new-patient metric when first-time IVF, then fall back.
    if (isNewPatient) {
      primaryRate =
        rows.find(
          (r) =>
            r.profileType === "own_eggs" &&
            r.ageGroup === ageGroup &&
            r.metricCode === "pct_new_patients_live_birth_after_1_retrieval",
        ) || null;
    }
    if (!primaryRate) {
      primaryRate =
        rows.find(
          (r) =>
            r.profileType === "own_eggs" &&
            r.ageGroup === ageGroup &&
            r.metricCode === "pct_intended_retrievals_live_births",
        ) || null;
    }
    // Fallback to under_35 if the target age group has no data.
    if (!primaryRate) {
      primaryRate =
        rows.find(
          (r) =>
            r.profileType === "own_eggs" &&
            r.ageGroup === "under_35" &&
            r.metricCode === "pct_new_patients_live_birth_after_1_retrieval",
        ) ||
        rows.find(
          (r) =>
            r.profileType === "own_eggs" &&
            r.ageGroup === "under_35" &&
            r.metricCode === "pct_intended_retrievals_live_births",
        ) ||
        null;
    }
  }

  const successPct = primaryRate ? Number(primaryRate.successRate) * 100 : null;
  const nationalAvgPct = primaryRate ? Number(primaryRate.nationalAverage) * 100 : null;

  // Age-group breakdown (own eggs only) + donor-egg rate.
  const ratesByAge: Record<string, number> = {};
  for (const r of rows) {
    if (
      r.profileType === "own_eggs" &&
      (r.metricCode === "pct_new_patients_live_birth_after_1_retrieval" ||
        r.metricCode === "pct_intended_retrievals_live_births")
    ) {
      const label = ageLabelOf(r.ageGroup);
      if (!ratesByAge[label]) ratesByAge[label] = Math.round(Number(r.successRate) * 100);
    }
  }
  const donorRate = rows.find(
    (r) => r.profileType === "donor" && r.metricCode === "pct_transfers_live_births_donor",
  );
  if (donorRate) ratesByAge["Donor eggs"] = Math.round(Number(donorRate.successRate) * 100);

  const rateLabel = eggSource === "donor" ? "Donor eggs" : `Own eggs, ${ageLabelOf(ageGroup)}`;

  return {
    successRate: successPct !== null ? `${Math.round(successPct)}%` : null,
    successRateLabel: rateLabel,
    nationalAverage: nationalAvgPct !== null ? `${Math.round(nationalAvgPct)}%` : null,
    top10pct: primaryRate?.top10pct || false,
    cycleCount: primaryRate?.cycleCount ?? null,
    successRatesByAge: Object.keys(ratesByAge).length > 0 ? ratesByAge : null,
    successPct: successPct !== null ? Math.round(successPct) : null,
  };
}
