/**
 * Which CDC rate applies to THIS parent, at this clinic.
 *
 * One source, used by the clinic card and the comparison. CDC publishes a rate
 * per (egg source, age band, first-cycle-or-not, metric), and picking a
 * different row gives a materially different number for the same clinic - so a
 * card and a comparison that each did their own lookup would quietly disagree
 * about the most important figure on the page.
 *
 * The fallback to the under-35 first-cycle row is deliberate and must be
 * LABELLED wherever it is shown: it describes a population this parent may not
 * be in, so presenting it bare would be worse than showing nothing.
 */
export type ClinicRateContext = {
  eggSource?: string | null;
  ageGroup?: string | null;
  isNewPatient?: boolean;
};

export type PickedClinicRate = {
  rate: any;
  /** True when we fell back to the generic row rather than matching her profile. */
  isFallback: boolean;
};

export function pickClinicRate(allRates: any[], ctx: ClinicRateContext): PickedClinicRate {
  const rates = Array.isArray(allRates) ? allRates : [];
  const eggSource = ctx.eggSource || "own_eggs";
  const ageGroup = ctx.ageGroup || "under_35";
  const isNew = ctx.isNewPatient !== undefined ? ctx.isNewPatient : true;

  let hit: any = null;
  if (eggSource === "donor") {
    hit = rates.find((r) => r.profileType === "donor" && r.metricCode === "pct_transfers_live_births_donor");
  } else if (isNew) {
    hit = rates.find((r) => r.profileType === "own_eggs" && r.ageGroup === ageGroup && r.isNewPatient === true && r.metricCode === "pct_new_patients_live_birth_after_1_retrieval")
      || rates.find((r) => r.profileType === "own_eggs" && r.ageGroup === ageGroup && r.metricCode === "pct_intended_retrievals_live_births");
  } else {
    hit = rates.find((r) => r.profileType === "own_eggs" && r.ageGroup === ageGroup && !r.isNewPatient && r.metricCode === "pct_intended_retrievals_live_births");
  }
  if (hit) return { rate: hit, isFallback: false };

  const fallback = rates.find((r) => r.profileType === "own_eggs" && r.ageGroup === "under_35" && r.isNewPatient === true && r.metricCode === "pct_new_patients_live_birth_after_1_retrieval") || null;
  return { rate: fallback, isFallback: !!fallback };
}
