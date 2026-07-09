// ASRM surrogate minimum requirements - single shared evaluator used by the
// profile ingestion hooks (website sync, bulk PDF upload, manual edits), the
// backfill/re-evaluation pass, and the provider-facing UI (requirements
// banner + hidden-profile label).
//
// The requirements themselves live on the GoStork house provider's
// "Surrogate Matching Requirements" settings (ivfSurrogate* fields), so the
// GoStork team can tune them from the UI. They encode the ASRM gestational
// carrier committee-opinion minimums (age 21-45, at least one prior
// delivery, max 5 deliveries, max 3 c-sections, healthy BMI).
//
// Rules are conservative: a rule only fails when we POSITIVELY know the
// surrogate violates it. Unknown profile data always passes - wrongly hiding
// a qualified surrogate is worse than letting a borderline profile through
// for the clinic to screen.

export interface SurrogateAsrmRequirements {
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
  covidVaccinationRequired?: boolean | null;
}

export interface SurrogateAsrmFacts {
  age?: number | null;
  bmi?: number | null;
  liveBirths?: number | null;
  cSections?: number | null;
  miscarriages?: number | null;
  abortions?: number | null;
  lastDeliveryYear?: number | null;
  covidVaccinated?: boolean | null;
}

export interface SurrogateAsrmResult {
  pass: boolean;
  /** Human-readable sentences, e.g. "Age 47 is above the maximum of 45". */
  failures: string[];
  /** Profile fields required to check an ACTIVE requirement but absent from
   *  the profile, e.g. "BMI". A profile with missing fields is hidden until
   *  the provider fills them in - unverifiable is treated as non-compliant. */
  missing: string[];
}

/** All rules AND together; returns every failed rule as a human sentence,
 *  plus every profile field that an active rule needs but the profile lacks. */
export function evaluateSurrogateAsrm(
  req: SurrogateAsrmRequirements | null | undefined,
  facts: SurrogateAsrmFacts | null | undefined,
  opts?: { currentYear?: number },
): SurrogateAsrmResult {
  const failures: string[] = [];
  const missing: string[] = [];
  if (!req) return { pass: true, failures, missing };
  const f = facts || {};

  const rawBmi = f.bmi != null ? Number(f.bmi) : null;
  const bmi = rawBmi != null && !isNaN(rawBmi) ? rawBmi : null;

  // Strict mode: an active requirement whose profile field is unknown makes
  // the profile unverifiable -> flag the exact field so the provider adds it.
  if ((req.minAge != null || req.maxAge != null) && f.age == null) missing.push("Age");
  if ((req.minBmi != null || req.maxBmi != null) && bmi == null) missing.push("BMI");
  if ((req.minDeliveries != null || req.maxDeliveries != null) && f.liveBirths == null) missing.push("Live Births");
  if (req.maxCSections != null && f.cSections == null) missing.push("C-Sections");
  if (req.maxMiscarriages != null && f.miscarriages == null) missing.push("Miscarriages");
  if (req.maxAbortions != null && f.abortions == null) missing.push("Abortions");
  if (req.maxYearsFromLastPregnancy != null && f.lastDeliveryYear == null) missing.push("Last Delivery Year");
  if (req.covidVaccinationRequired === true && f.covidVaccinated == null) missing.push("COVID Vaccinated");

  if (f.age != null && req.minAge != null && f.age < req.minAge) {
    failures.push(`Age ${f.age} is below the minimum of ${req.minAge}`);
  }
  if (f.age != null && req.maxAge != null && f.age > req.maxAge) {
    failures.push(`Age ${f.age} is above the maximum of ${req.maxAge}`);
  }
  if (bmi != null && req.minBmi != null && bmi < req.minBmi) {
    failures.push(`BMI ${bmi} is below the minimum of ${req.minBmi}`);
  }
  if (bmi != null && req.maxBmi != null && bmi > req.maxBmi) {
    failures.push(`BMI ${bmi} is above the maximum of ${req.maxBmi}`);
  }
  if (f.liveBirths != null && req.minDeliveries != null && f.liveBirths < req.minDeliveries) {
    failures.push(req.minDeliveries === 1
      ? "No prior delivery (at least one term delivery is required)"
      : `Only ${f.liveBirths} prior deliveries (minimum is ${req.minDeliveries})`);
  }
  if (f.liveBirths != null && req.maxDeliveries != null && f.liveBirths > req.maxDeliveries) {
    failures.push(`${f.liveBirths} prior deliveries exceeds the maximum of ${req.maxDeliveries}`);
  }
  if (f.cSections != null && req.maxCSections != null && f.cSections > req.maxCSections) {
    failures.push(`${f.cSections} c-sections exceeds the maximum of ${req.maxCSections}`);
  }
  if (f.miscarriages != null && req.maxMiscarriages != null && f.miscarriages > req.maxMiscarriages) {
    failures.push(`${f.miscarriages} miscarriages exceeds the maximum of ${req.maxMiscarriages}`);
  }
  if (f.abortions != null && req.maxAbortions != null && f.abortions > req.maxAbortions) {
    failures.push(`${f.abortions} abortions exceeds the maximum of ${req.maxAbortions}`);
  }
  if (f.lastDeliveryYear != null && req.maxYearsFromLastPregnancy != null) {
    const currentYear = opts?.currentYear ?? new Date().getFullYear();
    const years = currentYear - f.lastDeliveryYear;
    if (years > req.maxYearsFromLastPregnancy) {
      failures.push(`Last delivery was ${years} years ago (maximum is ${req.maxYearsFromLastPregnancy})`);
    }
  }
  if (req.covidVaccinationRequired === true && f.covidVaccinated === false) {
    failures.push("Not COVID vaccinated (vaccination is required)");
  }

  return { pass: failures.length === 0 && missing.length === 0, failures, missing };
}

/** Build the requirements object from the GoStork house Provider row's ivfSurrogate* fields. */
export function surrogateAsrmRequirementsFromProvider(p: any): SurrogateAsrmRequirements {
  return {
    minAge: p?.ivfSurrogateMinAge ?? null,
    maxAge: p?.ivfSurrogateMaxAge ?? null,
    minBmi: p?.ivfSurrogateMinBmi ?? null,
    maxBmi: p?.ivfSurrogateMaxBmi ?? null,
    minDeliveries: p?.ivfSurrogateMinDeliveries ?? null,
    maxDeliveries: p?.ivfSurrogateMaxDeliveries ?? null,
    maxCSections: p?.ivfSurrogateMaxCSections ?? null,
    maxMiscarriages: p?.ivfSurrogateMaxMiscarriages ?? null,
    maxAbortions: p?.ivfSurrogateMaxAbortions ?? null,
    maxYearsFromLastPregnancy: p?.ivfSurrogateMaxYearsFromLastPregnancy ?? null,
    covidVaccinationRequired: p?.ivfSurrogateCovidVaccination ?? null,
  };
}

/** Build the facts object from a Surrogate row (or an upsert payload with the same field names). */
export function surrogateAsrmFactsFromRow(s: any): SurrogateAsrmFacts {
  return {
    age: s?.age ?? null,
    bmi: s?.bmi != null ? Number(s.bmi) : null,
    liveBirths: s?.liveBirths ?? null,
    cSections: s?.cSections ?? null,
    miscarriages: s?.miscarriages ?? null,
    abortions: s?.abortions ?? null,
    lastDeliveryYear: s?.lastDeliveryYear ?? null,
    covidVaccinated: s?.covidVaccinated ?? null,
  };
}

/** Human-readable requirement lines for the provider-facing banner. */
export function describeSurrogateAsrmRequirements(req: SurrogateAsrmRequirements): string[] {
  const lines: string[] = [];
  if (req.minAge != null || req.maxAge != null) {
    if (req.minAge != null && req.maxAge != null) lines.push(`Age between ${req.minAge} and ${req.maxAge}`);
    else if (req.minAge != null) lines.push(`Age at least ${req.minAge}`);
    else lines.push(`Age at most ${req.maxAge}`);
  }
  if (req.minBmi != null || req.maxBmi != null) {
    if (req.minBmi != null && req.maxBmi != null) lines.push(`BMI between ${req.minBmi} and ${req.maxBmi}`);
    else if (req.minBmi != null) lines.push(`BMI at least ${req.minBmi}`);
    else lines.push(`BMI at most ${req.maxBmi}`);
  }
  if (req.minDeliveries != null) {
    lines.push(req.minDeliveries === 1 ? "At least one prior delivery" : `At least ${req.minDeliveries} prior deliveries`);
  }
  if (req.maxDeliveries != null) lines.push(`No more than ${req.maxDeliveries} total deliveries`);
  if (req.maxCSections != null) lines.push(`No more than ${req.maxCSections} c-sections`);
  if (req.maxMiscarriages != null) lines.push(`No more than ${req.maxMiscarriages} miscarriages`);
  if (req.maxAbortions != null) lines.push(`No more than ${req.maxAbortions} abortions`);
  if (req.maxYearsFromLastPregnancy != null) lines.push(`Last delivery within the past ${req.maxYearsFromLastPregnancy} years`);
  if (req.covidVaccinationRequired === true) lines.push("COVID vaccination required");
  return lines;
}
