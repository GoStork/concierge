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

  // A row with no rate is not an answer - keep looking rather than returning a
  // "hit" the caller has to render as blank.
  const has = (r: any) => r && r.successRate != null;

  let hit: any = null;
  if (eggSource === "donor" || eggSource === "donated_embryos") {
    // CDC splits donor live births across four submetrics (donated embryos,
    // fresh/frozen eggs, frozen embryos) with NO age band, and taking the first
    // in array order showed a false 0%.
    //
    // This ladder MIRRORS computeClinicSuccessRate in server/src/lib/
    // ivf-success-rate.ts, which is what computes the card's "Top 10%" badge.
    // The two must agree row-for-row: picking simply the highest submetric here
    // disagreed with the server on 150 of 377 clinics and flipped the Top 10%
    // badge on 33 of them, so the badge showed on a card and vanished inside the
    // profile. Frozen embryos is the canonical modern donor-egg metric; the
    // others are commonly 0 for a given clinic.
    const submetric = eggSource === "donated_embryos" ? "donated_embryos" : null;
    const donorRows = rates.filter(
      (r) => r.profileType === "donor" && r.metricCode === "pct_transfers_live_births_donor" &&
        (submetric ? r.submetric === submetric : true) && has(r),
    );
    hit =
      donorRows.find((r) => r.submetric === "frozen_embryos" && (r.cycleCount ?? 0) > 0) ||
      donorRows.find((r) => (r.cycleCount ?? 0) > 0 && Number(r.successRate) > 0) ||
      donorRows.find((r) => r.submetric === "frozen_embryos") ||
      donorRows.find((r) => Number(r.successRate) > 0) ||
      donorRows[0] ||
      null;
  } else if (isNew) {
    hit = rates.find((r) => r.profileType === "own_eggs" && r.ageGroup === ageGroup && r.isNewPatient === true && r.metricCode === "pct_new_patients_live_birth_after_1_retrieval" && has(r))
      || rates.find((r) => r.profileType === "own_eggs" && r.ageGroup === ageGroup && r.metricCode === "pct_intended_retrievals_live_births" && has(r));
  } else {
    hit = rates.find((r) => r.profileType === "own_eggs" && r.ageGroup === ageGroup && !r.isNewPatient && r.metricCode === "pct_intended_retrievals_live_births" && has(r));
  }
  if (hit) return { rate: hit, isFallback: false };

  const fallback = rates.find((r) => r.profileType === "own_eggs" && r.ageGroup === "under_35" && r.isNewPatient === true && r.metricCode === "pct_new_patients_live_birth_after_1_retrieval" && has(r)) || null;
  return { rate: fallback, isFallback: !!fallback };
}
