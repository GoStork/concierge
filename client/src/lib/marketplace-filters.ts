const ETHNICITY_SYNONYMS: Record<string, string[]> = {
  "white": ["white", "caucasian"],
  "caucasian": ["caucasian", "white"],
  "black": ["black", "african american", "african"],
  "african american": ["african american", "black", "african"],
  "african": ["african", "black", "african american"],
  "hispanic": ["hispanic", "latino", "latina"],
  "latino": ["latino", "latina", "hispanic"],
  "latina": ["latina", "latino", "hispanic"],
  "middle eastern": ["middle eastern", "arab", "arabic"],
  "arab": ["arab", "arabic", "middle eastern"],
  "mixed": ["mixed", "biracial", "multiracial"],
  "biracial": ["biracial", "mixed", "multiracial"],
  "multiracial": ["multiracial", "mixed", "biracial"],
};

export function resolveEthnicityTerms(val: string): string[] {
  const lower = val.toLowerCase().trim();
  return ETHNICITY_SYNONYMS[lower] || [lower];
}

function extractCountryFromLocation(location: string | null | undefined): string | null {
  if (!location) return null;
  const loc = location.trim();
  const US_STATES = new Set([
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
    "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
    "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
    "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware","florida",
    "georgia","hawaii","idaho","illinois","indiana","iowa","kansas","kentucky","louisiana","maine",
    "maryland","massachusetts","michigan","minnesota","mississippi","missouri","montana","nebraska",
    "nevada","new hampshire","new jersey","new mexico","new york","north carolina","north dakota",
    "ohio","oklahoma","oregon","pennsylvania","rhode island","south carolina","south dakota",
    "tennessee","texas","utah","vermont","virginia","washington","west virginia","wisconsin","wyoming",
    "district of columbia"
  ]);
  const parts = loc.split(",").map(p => p.trim()).filter(Boolean);
  if (parts.length >= 3) {
    return parts[parts.length - 1].toLowerCase();
  }
  if (parts.length === 2) {
    const lastPart = parts[1].toLowerCase().replace(/\d/g, "").trim();
    if (US_STATES.has(lastPart) || US_STATES.has(parts[1].trim().toUpperCase())) {
      return "united states";
    }
    return lastPart;
  }
  if (parts.length === 1) {
    if (US_STATES.has(loc.toLowerCase()) || US_STATES.has(loc.toUpperCase())) {
      return "united states";
    }
  }
  return null;
}

function countriesMatch(c1: string | null | undefined, c2: string | null | undefined): boolean {
  if (!c1 || !c2) return true;
  const normalize = (c: string) => {
    const n = c.toLowerCase().trim();
    if (n === "us" || n === "usa" || n === "united states of america" || n === "u.s." || n === "u.s.a.") return "united states";
    if (n === "uk" || n === "great britain" || n === "england" || n === "scotland" || n === "wales" || n === "northern ireland") return "united kingdom";
    return n;
  };
  return normalize(c1) === normalize(c2);
}

export function matchesFilter(donor: any, key: string, values: string[]): boolean {
  if (!values || values.length === 0) return true;

  if (key === "age") {
    const age = donor.age;
    if (age == null) return true;
    const [min, max] = values.map(Number);
    return age >= min && age <= max;
  }
  if (key === "bmi") {
    const bmi = Number(donor.bmi);
    if (!bmi) return true;
    const [min, max] = values.map(Number);
    return bmi >= min && bmi <= max;
  }
  if (key === "height") {
    const inches = parseHeightToInches(donor.height);
    if (inches === 0) return true;
    const [min, max] = values.map(Number);
    return inches >= min && inches <= max;
  }
  if (key === "donorCompensation") {
    const comp = Number(donor.donorCompensation || 0);
    const [min, max] = values.map(Number);
    return comp >= min && comp <= max;
  }
  if (key === "maxCost") {
    const cost = Number(donor.totalCost || donor.eggLotCost || donor.compensation || donor.totalCostMax || 0);
    const [min, max] = values.map(Number);
    return cost >= min && cost <= max;
  }
  if (key === "baseCompensation") {
    const comp = Number(donor.baseCompensation || 0);
    const [min, max] = values.map(Number);
    return comp >= min && comp <= max;
  }
  if (key === "agreesToTwins") return donor.agreesToTwins === true;
  if (key === "agreesToSelectiveReduction") return donor.agreesToSelectiveReduction === true;
  if (key === "openToSameSexCouple") return donor.openToSameSexCouple === true;
  if (key === "agreesToInternationalParents") return donor.agreesToInternationalParents === true;
  if (key === "covidVaccinated") return donor.covidVaccinated === true;
  if (key === "maxLiveBirths") {
    const lb = donor.liveBirths;
    if (lb == null) return true;
    return lb <= Number(values[0]);
  }
  if (key === "maxCSections") {
    const cs = donor.cSections;
    if (cs == null) return true;
    return cs <= Number(values[0]);
  }
  if (key === "maxMiscarriages") {
    const mc = donor.miscarriages;
    if (mc == null) return true;
    return mc <= Number(values[0]);
  }
  if (key === "maxAbortions") {
    const profileData = donor.profileData || {};
    const sections = profileData._sections || profileData["Profile Details"] || {};
    let abortions: number | null = null;
    for (const section of Object.values(sections)) {
      if (typeof section === "object" && section !== null && !Array.isArray(section)) {
        const val = (section as any)["Abortions"] || (section as any)["Number of Abortions"] || (section as any)["Terminations"];
        if (val != null) { abortions = parseInt(String(val)) || 0; break; }
      }
    }
    if (abortions == null) return true;
    return abortions <= Number(values[0]);
  }
  if (key === "lastDeliveryYear") {
    const ldy = donor.lastDeliveryYear;
    if (ldy == null) return true;
    return ldy >= Number(values[0]);
  }

  if (key === "ethnicity" || key === "race") {
    // Always check race first (race is the primary field), then ethnicity as fallback
    const raceVal = (donor.race || "").toString().toLowerCase();
    const ethVal = (donor.ethnicity || "").toString().toLowerCase();
    const wordMatch = (haystack: string, needle: string) => {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z])${escaped}($|[^a-z])`).test(haystack);
    };
    return values.some((v) => {
      if (v.includes(" + ")) {
        const parts = v.split(" + ").map(p => p.trim());
        return parts.every(p => {
          const terms = resolveEthnicityTerms(p);
          return terms.some(t => wordMatch(raceVal, t) || wordMatch(ethVal, t));
        });
      }
      const terms = resolveEthnicityTerms(v);
      return terms.some(t => wordMatch(raceVal, t) || wordMatch(ethVal, t));
    });
  }

  const comboKeys = new Set(["eyeColor", "hairColor", "education"]);
  if (comboKeys.has(key)) {
    const fieldVal = (donor[key] || "").toString().toLowerCase();
    return values.some((v) => {
      if (v.includes(" + ")) {
        const parts = v.split(" + ").map(p => p.trim().toLowerCase());
        return parts.every(part => fieldVal.includes(part));
      }
      return fieldVal.includes(v.toLowerCase());
    });
  }

  const fieldName = key === "eggType" ? "donorType" : key === "donationType" ? "donationTypes" : key;
  const fieldVal = (donor[fieldName] || "").toString().toLowerCase();
  return values.some((v) => fieldVal.includes(v.toLowerCase()));
}

export function matchesSameSexCoupleRequirement(donor: any, userIdentification: string | null | undefined): boolean {
  if (!userIdentification) return true;
  const straight = userIdentification.toLowerCase() === "straight";
  if (straight) return true;
  if (donor.openToSameSexCouple === false) return false;
  return true;
}

export function matchesInternationalRequirement(donor: any, userCountry: string | null | undefined): boolean {
  if (!userCountry) return true;
  const surrogateCountry = extractCountryFromLocation(donor.location);
  if (!surrogateCountry) return true;
  if (countriesMatch(userCountry, surrogateCountry)) return true;
  if (donor.agreesToInternationalParents === false) return false;
  return true;
}

export function omniSearch(donor: any, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  const searchableFields = [
    donor.firstName, donor.lastName, donor.location, donor.ethnicity, donor.race,
    donor.education, donor.occupation, donor.religion, donor.externalId,
    donor.bloodType, donor.eyeColor, donor.hairColor, donor.relationshipStatus,
    donor.donorType, donor.eggType,
    donor.provider?.name,
    ...(Array.isArray(donor.interests) ? donor.interests : []),
  ];
  if (searchableFields.some((field) => field && String(field).toLowerCase().includes(q))) return true;
  // Check ethnicity/race synonyms so "White" matches "Caucasian" donors and vice versa
  const synonyms = resolveEthnicityTerms(q);
  if (synonyms.length > 1) {
    const ethnicity = (donor.ethnicity || "").toLowerCase();
    const race = (donor.race || "").toLowerCase();
    const wordMatch = (haystack: string, needle: string) => {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z])${escaped}($|[^a-z])`).test(haystack);
    };
    if (synonyms.some(t => wordMatch(ethnicity, t) || wordMatch(race, t))) return true;
  }
  return false;
}

export function parseHeightToInches(h: string | null | undefined): number {
  if (!h) return 0;
  const match = h.match(/(\d+)[''′]?\s*(\d+)?/);
  if (match) return Number(match[1]) * 12 + (Number(match[2]) || 0);
  const cmMatch = h.match(/([\d.]+)\s*cm/i);
  if (cmMatch) return Number(cmMatch[1]) / 2.54;
  return 0;
}

export function parseWeight(w: string | null | undefined): number {
  if (!w) return 0;
  const match = w.match(/([\d.]+)/);
  return match ? Number(match[1]) : 0;
}

export function getDonorCost(d: any): number {
  return Number(d.totalCost || d.eggLotCost || d.compensation || d.totalCostMax || d.baseCompensation || 0);
}

export function sortDonors(donors: any[], sortBy: string): any[] {
  const sorted = [...donors];
  switch (sortBy) {
    case "age_asc": return sorted.sort((a, b) => (a.age || 0) - (b.age || 0));
    case "age_desc": return sorted.sort((a, b) => (b.age || 0) - (a.age || 0));
    case "height_asc": return sorted.sort((a, b) => parseHeightToInches(a.height) - parseHeightToInches(b.height));
    case "height_desc": return sorted.sort((a, b) => parseHeightToInches(b.height) - parseHeightToInches(a.height));
    case "weight_asc": return sorted.sort((a, b) => parseWeight(a.weight) - parseWeight(b.weight));
    case "weight_desc": return sorted.sort((a, b) => parseWeight(b.weight) - parseWeight(a.weight));
    case "cost_asc": return sorted.sort((a, b) => getDonorCost(a) - getDonorCost(b));
    case "cost_desc": return sorted.sort((a, b) => getDonorCost(b) - getDonorCost(a));
    case "oldest": return sorted.sort((a, b) =>
      new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
    );
    case "newest":
    default: return sorted.sort((a, b) =>
      new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );
  }
}
