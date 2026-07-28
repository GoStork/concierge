import { formatLocationDisplay } from "@/lib/format-location";
import { formatMoneyDollars } from "@/lib/format-money";
import { safeCompensation } from "@/lib/compensation-sanity";
import { resolveEggDonorFields, resolveSurrogateFields, resolveSpermDonorFields } from "@/lib/profile-utils";
import { cleanCityState } from "@/lib/country-flag";

/**
 * The Summary block's rows, for one profile.
 *
 * Lives here rather than on the profile page because the comparison needs the
 * same rows: a parent comparing four surrogates should see every fact the
 * Summary shows them individually, and a hand-picked subset of it - which is
 * what the comparison shipped with - leaves out exactly the answers people
 * choose on (twins, selective reduction, prior c-sections, vaccination).
 *
 * One builder, so the two surfaces can never drift.
 */
export function getMandatoryFields(donor: any, type: string): { label: string; value: string }[] {
  const V = (val: any) => (val != null && val !== "") ? String(val) : "-";
  const profileData = donor.profileData || {};

  // Recover the city the scraper dropped (kept in profileData) and normalize to
  // the consistent "City, ST" form - same logic the marketplace card uses, so the
  // detail page no longer shows just the bare state.
  const richLoc = profileData?.["Location"] ?? profileData?.["Current City"] ?? null;
  const locDisplay = (raw: any) =>
    formatLocationDisplay(cleanCityState(typeof richLoc === "string" ? richLoc : null, raw ?? null)) || V(raw);

  const fmtUSD = (val: number | null | undefined) => val != null ? formatMoneyDollars(Number(val)) : "-";
  const fmtTotalCost = (tc: { min: number; max: number } | null | undefined) => {
    if (!tc) return "-";
    if (tc.min === tc.max || tc.max === 0) return fmtUSD(tc.min);
    return `${fmtUSD(tc.min)} – ${fmtUSD(tc.max)}`;
  };

  if (type === "egg-donor") {
    const r = resolveEggDonorFields(donor);
    return [
      { label: "Age", value: V(r.age) },
      { label: "Education Level", value: V(r.education) },
      { label: "Eye Color", value: V(r.eyeColor) },
      { label: "Location", value: locDisplay(r.location) },
      { label: "Hair Color", value: V(r.hairColor) },
      { label: "Donation Types", value: V(r.donationTypes) },
      { label: "Race", value: V(r.race) },
      { label: "Relationship Status", value: V(r.relationshipStatus) },
      { label: "Ethnicity", value: V(r.ethnicity) },
      { label: "Occupation", value: V(r.occupation) },
      { label: "Religion", value: V(r.religion) },
      // Same band check the cards use. This row published $200,000 for an egg
      // donor - the exact figure the guard exists to withhold - because the
      // guard lived in the swipe mapper and this summary builds its own rows.
      { label: "Egg Donor Compensation", value: fmtUSD(safeCompensation(r.resolvedCompensation ?? r.donorCompensation, "egg-donor")) },
      { label: "Height", value: V(r.height) },
      { label: "Total Cost", value: r.calculatedTotalCost ? fmtTotalCost(r.calculatedTotalCost) : (r.totalCost ? fmtUSD(r.totalCost) : "-") },
      { label: "Weight", value: V(r.weight) },
      { label: "Blood Type", value: V(r.bloodType) },
    ];
  } else if (type === "surrogate") {
    const B = (val: boolean | null) => val === true ? "Yes" : val === false ? "No" : "-";
    const r = resolveSurrogateFields(donor);
    return [
      { label: "Age", value: V(r.age) },
      { label: "Location", value: locDisplay(r.location) },
      { label: "BMI", value: V(r.bmi) },
      { label: "Race", value: V(r.race) },
      { label: "Ethnicity", value: V(r.ethnicity) },
      { label: "Religion", value: V(r.religion) },
      { label: "Education", value: V(r.education) },
      { label: "Occupation", value: V(r.occupation) },
      { label: "Relationship Status", value: V(r.relationshipStatus) },
      { label: "COVID Vaccinated", value: B(r.covidVaccinated) },
      { label: "Live Births", value: r.liveBirths != null ? String(r.liveBirths) : "-" },
      { label: "C-Sections", value: r.cSections != null ? String(r.cSections) : "-" },
      { label: "Miscarriages", value: r.miscarriages != null ? String(r.miscarriages) : "-" },
      { label: "Abortions", value: "0" },
      { label: "Agrees to Abortion", value: B(r.agreesToAbortion) },
      { label: "Last Delivery Year", value: V(r.lastDeliveryYear) },
      { label: "Twins", value: B(r.agreesToTwins) },
      { label: "Selective Reduction", value: B(r.agreesToSelectiveReduction) },
      { label: "Same Sex Couple", value: B(r.openToSameSexCouple) },
      { label: "International Parents", value: B(r.agreesToInternationalParents) },
      { label: "Base Compensation", value: fmtUSD(safeCompensation(r.resolvedCompensation ?? r.baseCompensation, "surrogate")) },
      { label: "Total Cost", value: r.calculatedTotalCost ? fmtTotalCost(r.calculatedTotalCost) : (r.totalCostMin ? `${fmtUSD(r.totalCostMin)}${r.totalCostMax && r.totalCostMax !== r.totalCostMin ? ` – ${fmtUSD(r.totalCostMax)}` : ""}` : "-") },
    ];
  } else {
    const r = resolveSpermDonorFields(donor);
    const vialCostItems = (() => {
      if (r.vialCosts && r.vialCosts.length > 0) {
        return r.vialCosts.map((vc: { label: string; cost: number }) => ({ label: vc.label, value: fmtUSD(vc.cost) }));
      } else if (r.totalCost) {
        return [{ label: "Vial Cost", value: fmtUSD(r.totalCost) }];
      }
      return [];
    })();
    // Left-column items first (1..ceil(N/2)), then right-column items (rest).
    // Cost fields go at the very end so they land in the bottom of the right column.
    // The renderer interleaves [left..., right...] into the 2-col grid.
    return [
      // Left column (top to bottom)
      // Guard junk ages from a bad scrape (e.g. a stored -1976) - show "-" instead.
      { label: "Age", value: (Number.isFinite(Number(r.age)) && Number(r.age) >= 18 && Number(r.age) <= 99) ? V(r.age) : "-" },
      { label: "Type", value: V(r.donorType) },
      { label: "Race", value: V(r.race) },
      { label: "Ethnicity", value: V(r.ethnicity) },
      { label: "Hair Color", value: V(r.hairColor) },
      { label: "Eye Color", value: V(r.eyeColor) },
      { label: "Religion", value: V(r.religion) },
      { label: "Education", value: V(r.education) },
      { label: "Occupation", value: V(r.occupation) },
      // Right column (top to bottom) - costs at very end
      { label: "Location", value: locDisplay(r.location) },
      { label: "Height", value: V(r.height) },
      { label: "Weight", value: V(r.weight) },
      { label: "Donation Types", value: V(r.donationTypes) },
      ...(vialCostItems.length > 0
        ? [{ label: "Available for", value: r.vialTypes.length > 0 ? r.vialTypes.join(", ") : "-" }, ...vialCostItems]
        : [{ label: "Available for", value: r.vialTypes.length > 0 ? r.vialTypes.join(", ") : "-" }]),
    ];
  }
}
