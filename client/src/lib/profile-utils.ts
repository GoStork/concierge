export type ProfileType = "egg-donor" | "surrogate" | "sperm-donor";

const TYPE_TO_SLUG: Record<string, string> = {
  "egg-donor": "eggdonor",
  "surrogate": "surrogate",
  "sperm-donor": "spermdonor",
};

const SLUG_TO_TYPE: Record<string, ProfileType> = {
  "eggdonor": "egg-donor",
  "surrogate": "surrogate",
  "spermdonor": "sperm-donor",
};

export function typeToUrlSlug(type: string): string {
  return TYPE_TO_SLUG[type] || type;
}

export function urlSlugToType(slug: string): ProfileType {
  return SLUG_TO_TYPE[slug] || (slug as ProfileType);
}

export function deriveTypeFromPath(pathname: string, paramType?: string): ProfileType {
  if (paramType) return urlSlugToType(paramType);
  if (pathname.includes("/eggdonor/")) return "egg-donor";
  if (pathname.includes("/surrogate/")) return "surrogate";
  if (pathname.includes("/spermdonor/")) return "sperm-donor";
  return "egg-donor";
}

export function normalizeRelationshipStatus(val: string | null | undefined): string | null {
  if (!val) return null;
  const s = val.trim().toLowerCase();
  if (/^single|^never\s*married/.test(s)) return "Single";
  if (/^married/.test(s)) return "Married";
  if (/^divorced|^separated/.test(s)) return "Divorced";
  if (/partner|cohabitat|domestic|common.?law|engaged|relationship|living\s*together|boyfriend|girlfriend|significant/.test(s)) return "Partnered";
  if (/^widow/.test(s)) return "Divorced";
  return val.trim();
}

export function getPhotoSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("/")) return url;
  if (url.startsWith("data:")) return url;
  if (/storage\.googleapis\.com\/gostork/i.test(url)) {
    // Extract GCS path and serve through authenticated endpoint
    const match = url.match(/storage\.googleapis\.com\/[^/]+\/(.+)/);
    if (match) return `/api/uploads/gcs/${match[1]}`;
    return url;
  }
  return `/api/uploads/proxy?url=${encodeURIComponent(url)}`;
}

export function getProfileTypeLabel(type: string): string {
  if (type === "egg-donor") return "Egg Donor";
  if (type === "surrogate") return "Surrogate";
  return "Sperm Donor";
}

export function extractFromSections(profileData: any, fieldName: string): string | null {
  if (!profileData) return null;
  const pd = profileData?.profileData?._sections ? profileData.profileData : profileData;
  const sections = pd?._sections;
  if (!sections || typeof sections !== "object") return null;
  for (const section of Object.values(sections)) {
    if (typeof section === "object" && section && !Array.isArray(section) && (section as any)[fieldName]) {
      return String((section as any)[fieldName]);
    }
  }
  return null;
}

function F(val: any): string | null {
  if (val == null || val === "") return null;
  return String(val);
}

function resolveBool(val: any): boolean | null {
  if (val === true || val === false) return val;
  if (val == null) return null;
  const s = String(val).trim().toLowerCase();
  if (s === "yes" || s === "true") return true;
  if (s === "no" || s === "false") return false;
  return null;
}

export interface ResolvedSurrogateFields {
  age: string | null;
  location: string | null;
  bmi: string | null;
  race: string | null;
  ethnicity: string | null;
  religion: string | null;
  education: string | null;
  occupation: string | null;
  relationshipStatus: string | null;
  covidVaccinated: boolean | null;
  liveBirths: number | null;
  cSections: number | null;
  miscarriages: number | null;
  agreesToAbortion: boolean | null;
  lastDeliveryYear: string | null;
  agreesToTwins: boolean | null;
  agreesToSelectiveReduction: boolean | null;
  openToSameSexCouple: boolean | null;
  agreesToInternationalParents: boolean | null;
  resolvedCompensation: number | null;
  baseCompensation: number | null;
  totalCompensationMin: number | null;
  totalCompensationMax: number | null;
  calculatedTotalCost: { min: number; max: number } | null;
}

export function resolveSurrogateFields(d: any): ResolvedSurrogateFields {
  const pd = d.profileData || {};

  const embryoKey = Object.keys(pd).find(k => /embryo.*transfer|how\s*many\s*embryo/i.test(k));
  let twinsVal: boolean | null = d.agreesToTwins ?? null;
  if (twinsVal == null) {
    let embryoAnswer: string | null = null;
    if (embryoKey) {
      embryoAnswer = String(pd[embryoKey] || "").trim();
    } else {
      embryoAnswer = extractFromSections(pd, "How many embryos are you willing to transfer?") || extractFromSections(pd, "Embryos willing to transfer");
    }
    if (embryoAnswer) {
      twinsVal = /^1$|^one$/i.test(embryoAnswer.trim()) ? false : true;
    }
  }

  return {
    age: F(d.age),
    location: F(d.location),
    bmi: d.bmi != null ? String(Math.round(Number(d.bmi))) : null,
    race: F(d.race) || F(pd["Race"]) || extractFromSections(pd, "Race"),
    ethnicity: F(d.ethnicity) || F(pd["Ethnicity"]) || F(pd["Ethnic Background"]) || extractFromSections(pd, "Ethnicity"),
    religion: F(d.religion) || F(pd["Religion"]) || F(pd["Religious affiliation"]) || extractFromSections(pd, "Religion"),
    education: F(d.education) || F(pd["Education"]) || F(pd["Education Level"]) || extractFromSections(pd, "Education") || extractFromSections(pd, "Education Level"),
    occupation: F(d.occupation) || F(pd["Occupation"]) || extractFromSections(pd, "Occupation"),
    relationshipStatus: normalizeRelationshipStatus(F(d.relationshipStatus) || F(pd["Relationship Status"]) || extractFromSections(pd, "Relationship Status")),
    covidVaccinated: d.covidVaccinated ?? resolveBool(pd["COVID vaccinated"] ?? pd["COVID Vaccinated"]),
    liveBirths: d.liveBirths ?? null,
    cSections: d.cSections ?? (pd["C-Sections"] != null ? Number(pd["C-Sections"]) : null),
    miscarriages: d.miscarriages ?? (pd["Miscarriages"] != null ? Number(pd["Miscarriages"]) : null),
    agreesToAbortion: d.agreesToAbortion ?? resolveBool(pd["Agrees to abortion/selective reduction"]),
    lastDeliveryYear: d.lastDeliveryYear != null ? String(d.lastDeliveryYear) : F(pd["Last Delivery Year"]) || extractFromSections(pd, "Last Delivery Year"),
    agreesToTwins: twinsVal,
    agreesToSelectiveReduction: d.agreesToSelectiveReduction ?? resolveBool(pd["Agrees to selective reduction"]),
    openToSameSexCouple: d.openToSameSexCouple ?? resolveBool(pd["Open to Same Sex Couple"]),
    agreesToInternationalParents: d.agreesToInternationalParents ?? resolveBool(pd["International Parents"]),
    resolvedCompensation: d.resolvedCompensation != null ? Number(d.resolvedCompensation) : null,
    baseCompensation: d.baseCompensation != null ? Number(d.baseCompensation) : null,
    totalCompensationMin: d.totalCompensationMin != null ? Number(d.totalCompensationMin) : null,
    totalCompensationMax: d.totalCompensationMax != null ? Number(d.totalCompensationMax) : null,
    calculatedTotalCost: d.calculatedTotalCost ?? null,
  };
}

export interface ResolvedEggDonorFields {
  age: string | null;
  location: string | null;
  height: string | null;
  weight: string | null;
  hairColor: string | null;
  eyeColor: string | null;
  ethnicity: string | null;
  race: string | null;
  religion: string | null;
  education: string | null;
  occupation: string | null;
  relationshipStatus: string | null;
  donorType: string | null;
  donationTypes: string | null;
  resolvedCompensation: number | null;
  donorCompensation: number | null;
  totalCost: number | null;
  eggLotCost: number | null;
  numberOfEggs: number | null;
  bloodType: string | null;
  calculatedTotalCost: { min: number; max: number } | null;
}

export function resolveEggDonorFields(d: any): ResolvedEggDonorFields {
  const pd = d.profileData || {};
  return {
    age: F(d.age),
    location: F(d.location),
    height: F(d.height),
    weight: F(d.weight),
    hairColor: F(d.hairColor) || F(pd["Hair Color"]),
    eyeColor: F(d.eyeColor) || F(pd["Eye Color"]),
    ethnicity: F(d.ethnicity) || F(pd["Ethnicity"]) || extractFromSections(pd, "Ethnicity"),
    race: F(d.race) || F(pd["Race"]) || extractFromSections(pd, "Race"),
    religion: F(d.religion) || F(pd["Religion"]) || extractFromSections(pd, "Religion"),
    education: F(d.education) || F(pd["Education Level"]) || F(pd["Education"]) || extractFromSections(pd, "Education") || extractFromSections(pd, "Education Level"),
    occupation: F(d.occupation) || F(pd["Occupation"]) || extractFromSections(pd, "Occupation"),
    relationshipStatus: normalizeRelationshipStatus(F(d.relationshipStatus) || F(pd["Relationship Status"]) || extractFromSections(pd, "Relationship Status")),
    donorType: F(d.donorType),
    donationTypes: F(d.donationTypes) || F(pd["Type of Donation"]) || F(pd["Donation Type"]),
    resolvedCompensation: d.resolvedCompensation != null ? Number(d.resolvedCompensation) : null,
    donorCompensation: d.donorCompensation != null ? Number(d.donorCompensation) : null,
    totalCost: d.totalCost != null ? Number(d.totalCost) : null,
    eggLotCost: d.eggLotCost != null ? Number(d.eggLotCost) : null,
    numberOfEggs: d.numberOfEggs != null ? Number(d.numberOfEggs) : (pd["Number of Eggs in Egg Lot"] != null ? Number(pd["Number of Eggs in Egg Lot"]) : (pd["Number of Eggs"] != null ? Number(pd["Number of Eggs"]) : null)),
    bloodType: F(d.bloodType),
    calculatedTotalCost: d.calculatedTotalCost ?? null,
  };
}

export interface ResolvedSpermDonorFields {
  age: string | null;
  location: string | null;
  height: string | null;
  weight: string | null;
  hairColor: string | null;
  eyeColor: string | null;
  ethnicity: string | null;
  race: string | null;
  religion: string | null;
  education: string | null;
  occupation: string | null;
  relationshipStatus: string | null;
  donorType: string | null;
  resolvedCompensation: number | null;
  compensation: number | null;
  totalCost: number | null;
  calculatedTotalCost: { min: number; max: number } | null;
}

export function resolveSpermDonorFields(d: any): ResolvedSpermDonorFields {
  const pd = d.profileData || {};
  return {
    age: F(d.age),
    location: F(d.location),
    height: F(d.height),
    weight: F(d.weight),
    hairColor: F(d.hairColor) || F(pd["Hair Color"]),
    eyeColor: F(d.eyeColor) || F(pd["Eye Color"]),
    ethnicity: F(d.ethnicity) || F(pd["Ethnicity"]) || extractFromSections(pd, "Ethnicity"),
    race: F(d.race) || F(pd["Race"]) || extractFromSections(pd, "Race"),
    religion: F(d.religion) || F(pd["Religion"]) || extractFromSections(pd, "Religion"),
    education: F(d.education) || F(pd["Education Level"]) || F(pd["Education"]) || extractFromSections(pd, "Education") || extractFromSections(pd, "Education Level"),
    occupation: F(d.occupation) || F(pd["Occupation"]) || extractFromSections(pd, "Occupation"),
    relationshipStatus: normalizeRelationshipStatus(F(d.relationshipStatus) || F(pd["Relationship Status"]) || extractFromSections(pd, "Relationship Status")),
    donorType: F(d.donorType),
    resolvedCompensation: d.resolvedCompensation != null ? Number(d.resolvedCompensation) : null,
    compensation: d.compensation != null ? Number(d.compensation) : null,
    totalCost: d.totalCost != null ? Number(d.totalCost) : null,
    calculatedTotalCost: d.calculatedTotalCost ?? null,
  };
}

export function getProfileCardSummary(d: any, type: string): { label: string; value: string }[] {
  const items: { label: string; value: string | null }[] = [];

  if (type === "egg-donor") {
    const r = resolveEggDonorFields(d);
    items.push(
      { label: "Age", value: r.age },
      { label: "Ethnicity", value: r.ethnicity },
      { label: "Hair / Eyes", value: [r.hairColor, r.eyeColor].filter(Boolean).join(" / ") || null },
      { label: "Height", value: r.height },
      { label: "Education", value: r.education },
      { label: "Location", value: r.location },
    );
  } else if (type === "surrogate") {
    const r = resolveSurrogateFields(d);
    items.push(
      { label: "Age", value: r.age },
      { label: "Location", value: r.location },
      { label: "BMI", value: r.bmi },
      { label: "Occupation", value: r.occupation },
      { label: "Relationship", value: r.relationshipStatus },
      { label: "Compensation", value: (r.resolvedCompensation ?? r.baseCompensation) ? `$${(r.resolvedCompensation ?? r.baseCompensation)!.toLocaleString()}` : null },
    );
  } else {
    const r = resolveSpermDonorFields(d);
    items.push(
      { label: "Age", value: r.age },
      { label: "Ethnicity", value: r.ethnicity },
      { label: "Height", value: r.height },
      { label: "Education", value: r.education },
      { label: "Location", value: r.location },
      { label: "Price", value: (r.resolvedCompensation ?? r.compensation) ? `$${(r.resolvedCompensation ?? r.compensation)!.toLocaleString()}` : null },
    );
  }

  return items.filter((i): i is { label: string; value: string } => i.value !== null && i.value !== "");
}

function fmtTotalCostRange(tc: { min: number; max: number } | null): string {
  if (!tc) return "-";
  if (tc.min === tc.max || tc.max === 0) return `$${tc.min.toLocaleString()}`;
  return `$${tc.min.toLocaleString()} – $${tc.max.toLocaleString()}`;
}

export function getProfileDetails(d: any, type: ProfileType): { label: string; value: string }[] {
  const result: { label: string; value: string | null }[] = [];
  const V = (val: any) => (val != null && val !== "") ? String(val) : "-";
  const B = (val: boolean | null) => val === true ? "Yes" : val === false ? "No" : "-";

  if (type === "egg-donor") {
    const r = resolveEggDonorFields(d);
    result.push(
      { label: "Age", value: V(r.age) },
      { label: "Hair Color", value: V(r.hairColor) },
      { label: "Eye Color", value: V(r.eyeColor) },
      { label: "Ethnicity", value: V(r.ethnicity) },
      { label: "Race", value: V(r.race) },
      { label: "Religion", value: V(r.religion) },
      { label: "Height", value: V(r.height) },
      { label: "Weight", value: V(r.weight) },
      { label: "Education", value: V(r.education) },
      { label: "Location", value: V(r.location) },
      { label: "Egg Type", value: V(r.donorType) },
      { label: "Type of Donation", value: V(r.donationTypes) },
    );
    const isFrozenOnly = r.donorType && /frozen/i.test(r.donorType) && !/fresh/i.test(r.donorType);
    if (isFrozenOnly) {
      result.push(
        { label: "Number of Eggs", value: r.numberOfEggs ? String(r.numberOfEggs) : "-" },
        { label: "Egg Lot Cost", value: r.eggLotCost ? `$${r.eggLotCost.toLocaleString()}` : "-" },
      );
    } else {
      result.push(
        { label: "Donor Compensation", value: (r.resolvedCompensation ?? r.donorCompensation) ? `$${(r.resolvedCompensation ?? r.donorCompensation)!.toLocaleString()}` : "-" },
        { label: "Total Cost", value: r.calculatedTotalCost ? fmtTotalCostRange(r.calculatedTotalCost) : (r.totalCost ? `$${r.totalCost.toLocaleString()}` : "-") },
      );
    }
  } else if (type === "surrogate") {
    const r = resolveSurrogateFields(d);
    result.push(
      { label: "Age", value: V(r.age) },
      { label: "Location", value: V(r.location) },
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
      { label: "Base Compensation", value: (r.resolvedCompensation ?? r.baseCompensation) ? `$${(r.resolvedCompensation ?? r.baseCompensation)!.toLocaleString()}` : "-" },
      { label: "Total Cost", value: r.calculatedTotalCost ? fmtTotalCostRange(r.calculatedTotalCost) : (r.totalCompensationMin ? `$${r.totalCompensationMin.toLocaleString()}${r.totalCompensationMax && r.totalCompensationMax !== r.totalCompensationMin ? ` – $${r.totalCompensationMax.toLocaleString()}` : ""}` : "-") },
    );
  } else {
    const r = resolveSpermDonorFields(d);
    result.push(
      { label: "Age", value: V(r.age) },
      { label: "Type", value: V(r.donorType) },
      { label: "Location", value: V(r.location) },
      { label: "Ethnicity", value: V(r.ethnicity) },
      { label: "Race", value: V(r.race) },
      { label: "Height", value: V(r.height) },
      { label: "Hair Color", value: V(r.hairColor) },
      { label: "Eye Color", value: V(r.eyeColor) },
      { label: "Education", value: V(r.education) },
      { label: "Religion", value: V(r.religion) },
      { label: "Occupation", value: V(r.occupation) },
      { label: "Price", value: (r.resolvedCompensation ?? r.compensation) ? `$${(r.resolvedCompensation ?? r.compensation)!.toLocaleString()}` : "-" },
      { label: "Total Cost", value: r.calculatedTotalCost ? fmtTotalCostRange(r.calculatedTotalCost) : (r.totalCost ? `$${r.totalCost.toLocaleString()}` : "-") },
    );
  }

  return result as { label: string; value: string }[];
}
