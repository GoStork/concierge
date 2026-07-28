import { Award, Baby, Calendar, Heart, HeartHandshake, Scale, Scissors, ShieldCheck, Snowflake, Syringe, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Single source of truth for the CDC-derived clinic facts a parent sees:
 * Services, "Experience with your needs", Parents Matching Requirements and
 * "How they practice".
 *
 * BOTH the clinic swipe card (getClinicTabs in marketplace/swipe-mappers) and
 * the clinic's full profile page (components/clinic-cdc-sections) build their
 * sections from these helpers, so the card and the profile can never disagree
 * about which services a clinic offers or what its rules are. Add a new fact
 * HERE and both surfaces pick it up.
 */

// CDC "Services & Profiles" flags -> parent-facing labels.
export const CLINIC_SERVICE_CHIPS: { key: string; label: string }[] = [
  { key: "donorEgg", label: "Donor Eggs" },
  { key: "donatedEmbryo", label: "Donated Embryos" },
  { key: "eggCryo", label: "Egg Freezing" },
  { key: "embryoCryo", label: "Embryo Freezing" },
  { key: "gestationalCarrier", label: "Gestational Carrier" },
  { key: "singleWomen", label: "Single Women" },
  { key: "femaleCouple", label: "Female Couples" },
];

export function clinicServiceLabels(cdcServices: Record<string, boolean> | null | undefined): string[] {
  if (!cdcServices) return [];
  return CLINIC_SERVICE_CHIPS.filter((s) => cdcServices[s.key] === true).map((s) => s.label);
}

export interface ClinicExperienceBar {
  label: string;
  value: number;
  // true = this parent's own diagnosis (rendered in the clinic/primary color).
  isClinic: boolean;
}

/**
 * "Experience with your needs" - share of THIS clinic's IVF patients by
 * diagnosis (CDC "Reason for Using ART"). Personalized: the parent's own
 * diagnoses come first and are highlighted; the clinic's next strongest areas
 * follow. `max` caps the list on the fixed-height card; the profile page passes
 * `max: null` and shows every meaningful row.
 */
export function buildClinicExperience(
  cdcExperience: Record<string, number> | null | undefined,
  patientDiagnoses: string[] = [],
  opts: { max?: number | null } = {},
): { title: string; subtitle: string; bars: ClinicExperienceBar[] } | null {
  const exp = cdcExperience;
  if (!exp || Object.keys(exp).length === 0) return null;

  const patientDx = patientDiagnoses.filter((d) => d in exp);
  const matched = patientDx
    .map((d) => ({ label: d, value: Math.round(exp[d]), isClinic: true }))
    .sort((a, b) => b.value - a.value);
  const others = Object.entries(exp)
    .filter(([d, v]) => !patientDx.includes(d) && v >= 5 && !/other factor|unexplained/i.test(d))
    .map(([d, v]) => ({ label: d, value: Math.round(v), isClinic: false }))
    .sort((a, b) => b.value - a.value);

  const all = [...matched, ...others];
  // undefined -> the card's default cap; null -> no cap (the full profile).
  const cap = opts.max === undefined ? (matched.length > 0 ? 5 : 4) : opts.max;
  const bars = cap == null ? all : all.slice(0, cap);
  if (bars.length === 0) return null;

  return {
    title: patientDx.length > 0 ? "Experience with your needs" : "Clinic Experience",
    subtitle: patientDx.length > 0
      ? "Share of this clinic's IVF patients with your diagnosis"
      : "What this clinic's patients most need help with",
    bars,
  };
}

export interface ClinicIvfMatching {
  twinsAllowed?: boolean | null;
  genderSelectionAllowed?: boolean | null;
  transferFromOtherClinics?: boolean | null;
  maxAgeIp1?: number | null;
  maxAgeIp2?: number | null;
  biologicalConnection?: string | null;
  acceptingPatients?: string[] | null;
  // Informational only (NOT a matching rule): what donor type this clinic's egg
  // donor program offers, so a parent wanting a KNOWN donor learns upfront that
  // a clinic only has anonymous donors.
  eggDonorType?: string | null;
}

const ACCEPT_LABELS: Record<string, string> = {
  single_woman: "Single women", single_man: "Single men", straight_couple: "Straight couples",
  straight_married_couple: "Married straight couples", gay_couple: "Gay couples", lesbian_couple: "Lesbian couples",
};

/** "Parents Matching Requirements" - the clinic's IVF program rules. */
export function buildParentMatchingItems(
  matching: ClinicIvfMatching | null | undefined,
): { label: string; icon: LucideIcon }[] {
  const m = matching || {};
  const items: { label: string; icon: LucideIcon }[] = [];
  if (m.twinsAllowed != null) items.push({ label: m.twinsAllowed ? "Twin pregnancies allowed" : "Singleton pregnancies only", icon: Baby });
  if (m.genderSelectionAllowed != null) items.push({ label: m.genderSelectionAllowed ? "Gender selection allowed" : "No gender selection", icon: Users });
  if (m.transferFromOtherClinics != null) items.push({ label: m.transferFromOtherClinics ? "Accepts embryo transfers from other clinics" : "No outside embryo transfers", icon: Snowflake });
  if (m.maxAgeIp1 != null) items.push({ label: `Max age (IP1): ${m.maxAgeIp1}`, icon: Calendar });
  if (m.maxAgeIp2 != null) items.push({ label: `Max age (IP2): ${m.maxAgeIp2}`, icon: Calendar });
  if (m.biologicalConnection) {
    const bc = m.biologicalConnection === "at_least_one" ? "At least one biological parent required"
      : m.biologicalConnection === "at_least_two" ? "Both parents must be biologically connected"
      : m.biologicalConnection === "none" ? "No biological connection to embryos needed"
      : m.biologicalConnection;
    items.push({ label: bc, icon: HeartHandshake });
  }
  const accepting = (m.acceptingPatients || []).map((a) => ACCEPT_LABELS[a] || a).filter(Boolean);
  if (accepting.length > 0) items.push({ label: `Accepts: ${accepting.join(", ")}`, icon: Users });
  if (m.eggDonorType) {
    const edt = m.eggDonorType === "anonymous" ? "Anonymous egg donors only"
      : m.eggDonorType === "known" ? "Known egg donors only"
      : m.eggDonorType === "both" ? "Anonymous & known egg donors"
      : m.eggDonorType;
    items.push({ label: edt, icon: Heart });
  }
  return items;
}

export interface ClinicSurrogateMatching {
  minAge?: number | null;
  maxAge?: number | null;
  minBmi?: number | null;
  maxBmi?: number | null;
  minDeliveries?: number | null;
  maxDeliveries?: number | null;
  maxCSections?: number | null;
  maxMiscarriages?: number | null;
  maxAbortions?: number | null;
  maxYearsFromLastPregnancy?: number | null;
  monthsPostVaginal?: number | null;
  covidVaccination?: boolean;
  gdDiet?: boolean;
  gdMedication?: boolean;
  highBloodPressure?: boolean;
  preeclampsia?: boolean;
  placentaPrevia?: boolean;
  healthHistoryNotes?: string | null;
}

// "Age 20-42" / "Age 20+" / "Age up to 42" - a one-sided threshold is still a
// real rule, so never drop it just because its pair is missing.
function rangeLabel(prefix: string, min: number | null | undefined, max: number | null | undefined): string | null {
  if (min != null && max != null) return `${prefix} ${min}-${max}`;
  if (min != null) return `${prefix} ${min}+`;
  if (max != null) return `${prefix} up to ${max}`;
  return null;
}

/**
 * "Surrogate Matching Requirements" - the clinic's thresholds for the surrogate
 * it will accept, as compact chips. Each threshold is its OWN chip so the
 * boundaries stay unambiguous (paired "·" rows read as a run-on).
 */
export function buildSurrogateRequirementChips(
  surrogateMatching: ClinicSurrogateMatching | null | undefined,
): { label: string; icon: LucideIcon }[] {
  const sm = surrogateMatching;
  if (!sm) return [];
  const chips: { label: string; icon: LucideIcon }[] = [];
  const age = rangeLabel("Age", sm.minAge, sm.maxAge);
  if (age) chips.push({ label: age, icon: Calendar });
  const bmi = rangeLabel("BMI", sm.minBmi, sm.maxBmi);
  if (bmi) chips.push({ label: bmi, icon: Scale });
  if (sm.minDeliveries != null && sm.maxDeliveries != null) {
    chips.push({ label: `${sm.minDeliveries}-${sm.maxDeliveries} deliveries`, icon: Baby });
  } else if (sm.minDeliveries != null) {
    chips.push({ label: `At least ${sm.minDeliveries} ${sm.minDeliveries === 1 ? "delivery" : "deliveries"}`, icon: Baby });
  } else if (sm.maxDeliveries != null) {
    chips.push({ label: `Up to ${sm.maxDeliveries} deliveries`, icon: Baby });
  }
  if (sm.maxCSections != null) chips.push({ label: `Up to ${sm.maxCSections} C-sections`, icon: Scissors });
  if (sm.maxMiscarriages != null) chips.push({ label: `Up to ${sm.maxMiscarriages} miscarriages`, icon: Heart });
  if (sm.maxAbortions != null) chips.push({ label: `Up to ${sm.maxAbortions} abortions`, icon: Heart });
  if (sm.maxYearsFromLastPregnancy != null) chips.push({ label: `Within ${sm.maxYearsFromLastPregnancy} yrs of last pregnancy`, icon: Calendar });
  if (sm.monthsPostVaginal != null) chips.push({ label: `${sm.monthsPostVaginal}mo post-vaginal delivery`, icon: Calendar });
  return chips;
}

/**
 * "Accepted Surrogate History Of" - the prior-health-history conditions this
 * clinic still accepts. Only the accepted ones are listed (that IS the section);
 * anything absent is not accepted.
 */
export function buildSurrogateAcceptedChips(
  surrogateMatching: ClinicSurrogateMatching | null | undefined,
): { label: string; icon: LucideIcon }[] {
  const sm = surrogateMatching;
  if (!sm) return [];
  const chips: { label: string; icon: LucideIcon }[] = [];
  if (sm.covidVaccination) chips.push({ label: "COVID vaccinated", icon: ShieldCheck });
  if (sm.gdDiet) chips.push({ label: "Gestational diabetes (diet)", icon: ShieldCheck });
  if (sm.gdMedication) chips.push({ label: "Gestational diabetes (medication)", icon: ShieldCheck });
  if (sm.highBloodPressure) chips.push({ label: "High blood pressure", icon: ShieldCheck });
  if (sm.preeclampsia) chips.push({ label: "Preeclampsia", icon: ShieldCheck });
  if (sm.placentaPrevia) chips.push({ label: "Placenta previa", icon: ShieldCheck });
  return chips;
}

/** Every ivfSurrogate* field on a Provider row -> the shared chip input. */
export function surrogateMatchingFromProvider(provider: any): ClinicSurrogateMatching {
  return {
    minAge: provider.ivfSurrogateMinAge ?? null,
    maxAge: provider.ivfSurrogateMaxAge ?? null,
    minBmi: provider.ivfSurrogateMinBmi ?? null,
    maxBmi: provider.ivfSurrogateMaxBmi ?? null,
    minDeliveries: provider.ivfSurrogateMinDeliveries ?? null,
    maxDeliveries: provider.ivfSurrogateMaxDeliveries ?? null,
    maxCSections: provider.ivfSurrogateMaxCSections ?? null,
    maxMiscarriages: provider.ivfSurrogateMaxMiscarriages ?? null,
    maxAbortions: provider.ivfSurrogateMaxAbortions ?? null,
    maxYearsFromLastPregnancy: provider.ivfSurrogateMaxYearsFromLastPregnancy ?? null,
    monthsPostVaginal: provider.ivfSurrogateMonthsPostVaginal ?? null,
    covidVaccination: provider.ivfSurrogateCovidVaccination ?? false,
    gdDiet: provider.ivfSurrogateGdDiet ?? false,
    gdMedication: provider.ivfSurrogateGdMedication ?? false,
    highBloodPressure: provider.ivfSurrogateHighBloodPressure ?? false,
    preeclampsia: provider.ivfSurrogatePreeclampsia ?? false,
    placentaPrevia: provider.ivfSurrogatePlacentaPrevia ?? false,
    healthHistoryNotes: provider.ivfSurrogateMentalHealthHistory ?? null,
  };
}

// CDC cycle characteristics -> "How they practice".
export const CLINIC_PRACTICE_ROWS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: "pgtPct", label: "Genetic testing (PGT)", icon: Award },
  { key: "icsiPct", label: "ICSI", icon: Syringe },
  { key: "singleEmbryoPct", label: "Single-embryo transfers", icon: Baby },
  { key: "frozenPct", label: "Frozen-embryo transfers", icon: Snowflake },
  { key: "gestationalCarrierPct", label: "Gestational carrier", icon: HeartHandshake },
];

export function buildClinicPracticeItems(
  cdcCycleStats: Record<string, number> | null | undefined,
): { label: string; value: string; icon: LucideIcon }[] {
  const cyc = cdcCycleStats;
  if (!cyc) return [];
  return CLINIC_PRACTICE_ROWS
    .filter((r) => typeof cyc[r.key] === "number")
    .map((r) => ({ label: r.label, value: `${Math.round(cyc[r.key])}%`, icon: r.icon }));
}
