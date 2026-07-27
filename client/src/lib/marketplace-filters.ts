import { resolveEthnicityTerms } from "@shared/donor-search";
const STATE_ABBREV_MAP: Record<string, string> = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",
  CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",
  IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",
  ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",
  MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",
  NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",
  NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",
  PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",
  TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",
  WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",DC:"District of Columbia",
};
const STATE_FULL_TO_ABBREV: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_ABBREV_MAP).map(([k, v]) => [v.toLowerCase(), k])
);
const LOCATION_SYNONYMS: Record<string, string[]> = {
  "united states": ["united states","usa","us","u.s.","u.s.a.","united states of america","america"],
  "mexico":        ["mexico","méxico"],
  "colombia":      ["colombia"],
  "taiwan":        ["taiwan","taiwan (r.o.c.)","台灣"],
  "canada":        ["canada"],
  "united kingdom":["united kingdom","uk","great britain","england","scotland","wales"],
  "cyprus":        ["cyprus"],
  "israel":        ["israel"],
  "australia":     ["australia"],
  "germany":       ["germany","deutschland"],
  "spain":         ["spain","españa"],
  "greece":        ["greece"],
  "ukraine":       ["ukraine"],
  "czech republic":["czech republic","czechia"],
};
function resolveLocationTerms(input: string): string[] {
  if (!input) return [];
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  for (const synonyms of Object.values(LOCATION_SYNONYMS)) {
    if (synonyms.includes(lower)) return synonyms;
  }
  const upper = trimmed.toUpperCase();
  if (STATE_ABBREV_MAP[upper]) return [upper, STATE_ABBREV_MAP[upper]];
  if (STATE_FULL_TO_ABBREV[lower]) return [trimmed, STATE_FULL_TO_ABBREV[lower]];
  return [trimmed];
}

// Ethnicity synonyms live in shared/donor-search so the marketplace list
// endpoints narrow by the same table this filter matches on.
export { resolveEthnicityTerms };

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

function extractFromSections(profileData: any, fieldName: string): string | null {
  if (!profileData) return null;
  const sections = profileData?._sections;
  if (!sections || typeof sections !== "object") return null;
  for (const section of Object.values(sections)) {
    if (typeof section === "object" && section && !Array.isArray(section) && (section as any)[fieldName]) {
      return String((section as any)[fieldName]);
    }
  }
  return null;
}

function resolveLocationValue(donor: any): string {
  if (donor.location) return donor.location;
  const pd = donor.profileData || {};
  return (
    pd["Location"] ||
    pd["Place of Birth"] ||
    extractFromSections(pd, "Location") ||
    extractFromSections(pd, "Place of Birth") ||
    ""
  );
}

export function matchesFilter(donor: any, key: string, values: string[]): boolean {
  if (!values || values.length === 0) return true;

  // GoStork-admin "Provider" filter: keep only donors owned by a selected provider.
  if (key === "providerId") {
    return values.includes(String(donor.providerId));
  }

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
  if (key === "agreesToAbortion") return donor.agreesToAbortion === true;
  if (key === "agreesToSelectiveReduction") return donor.agreesToSelectiveReduction === true;
  if (key === "openToSameSexCouple") return donor.openToSameSexCouple === true;
  if (key === "agreesToInternationalParents") return donor.agreesToInternationalParents === true;
  if (key === "covidVaccinated") return donor.covidVaccinated === true;
  if (key === "maxLiveBirths") {
    const lb = donor.liveBirths;
    if (lb == null) return true;
    if (values.length === 2) {
      return lb >= Number(values[0]) && lb <= Number(values[1]);
    }
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

  if (key === "location") {
    const locationVal = resolveLocationValue(donor).toLowerCase();
    if (!locationVal) return false;
    return values.some(v => {
      const terms = resolveLocationTerms(v);
      return terms.some(t => locationVal.includes(t.toLowerCase()));
    });
  }

  if (key === "status") {
    // Canonical donor status. An egg donor can independently carry a
    // frozen-lot inventory state (frozenLotStatus). A donor matches the
    // "Sold Out" filter if EITHER their primary status OR their frozen
    // lot is SOLD_OUT (Fresh & Frozen donors have both columns set).
    // For other states (AVAILABLE / PENDING / MATCHED) match against
    // the primary status column only - frozen-lot doesn't carry those.
    const wanted = values.map(v => v.toUpperCase());
    const status = (donor.status || "AVAILABLE").toString().toUpperCase();
    const frozen = (donor.frozenLotStatus || "").toString().toUpperCase();
    if (wanted.includes(status)) return true;
    if (frozen && wanted.includes(frozen)) return true;
    return false;
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
    // Normalize blond/blonde synonyms so filters always match regardless of spelling
    const normalizeHair = (s: string) => s.replace(/\bblonde\b/gi, "blond");
    const fieldVal = normalizeHair((donor[key] || "").toString().toLowerCase());
    return values.some((v) => {
      if (v.includes(" + ")) {
        const parts = v.split(" + ").map(p => normalizeHair(p.trim().toLowerCase()));
        return parts.every(part => fieldVal.includes(part));
      }
      return fieldVal.includes(normalizeHair(v.toLowerCase()));
    });
  }

  if (key === "vialTypes") {
    const donorVials: string[] = Array.isArray(donor.vialTypes) ? donor.vialTypes : [];
    if (donorVials.length === 0) return true; // no data - don't exclude
    return values.some((v) => donorVials.some((dv) => dv.toUpperCase() === v.toUpperCase()));
  }

  const fieldName = key === "eggType" ? "donorType" : key === "donationType" ? "donationTypes" : key;
  const fieldVal = (donor[fieldName] || "").toString().toLowerCase();
  return values.some((v) => fieldVal.includes(v.toLowerCase()));
}

// Surrogacy-agency filtering. Agencies are providers, not donor rows, so their
// fields (locations[], services, surrogacy* program rules, lgbtqCare, attached
// totalCost) don't fit the donor-centric matchesFilter. One agency passes when
// it satisfies EVERY active filter. parentCountry powers the "Accepts my
// citizenship" toggle (agencyCitizenship).
export function agencyMatchesFilters(
  agency: any,
  filters: Record<string, string[]>,
  parentCountry?: string | null,
): boolean {
  for (const [key, values] of Object.entries(filters)) {
    if (!values || values.length === 0) continue;

    // GoStork-admin "Provider" filter: the agency itself is the provider.
    if (key === "providerId") {
      if (!values.includes(String(agency.id))) return false;
      continue;
    }

    if (key === "location") {
      const locs: string[] = (agency.locations || [])
        .map((l: any) => [l.city, l.state].filter(Boolean).join(", ").toLowerCase())
        .filter(Boolean);
      const ok = values.some((v) => {
        const terms = resolveLocationTerms(v);
        return locs.some((loc) => terms.some((t) => loc.includes(t.toLowerCase())));
      });
      if (!ok) return false;
      continue;
    }

    if (key === "maxCost") {
      const cost = Number(agency.totalCost || 0);
      // No priced program yet -> don't exclude on cost (mirrors donor behavior).
      if (cost > 0) {
        const [min, max] = values.map(Number);
        if (!(cost >= min && cost <= max)) return false;
      }
      continue;
    }

    if (key === "agencyTwins") {
      if (values[0] === "true" && agency.surrogacyTwinsAllowed !== true) return false;
      continue;
    }

    if (key === "agencyLgbtq") {
      if (values[0] === "true" && agency.lgbtqCare !== true) return false;
      continue;
    }

    if (key === "agencyCitizenship") {
      // "Accepts my citizenship" - exclude agencies that bar the parent's country.
      if (values[0] === "true" && parentCountry) {
        const notAllowed: string[] = Array.isArray(agency.surrogacyCitizensNotAllowed)
          ? agency.surrogacyCitizensNotAllowed
          : [];
        if (notAllowed.some((c) => countriesMatch(c, parentCountry))) return false;
      }
      continue;
    }
  }
  return true;
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
    donor.firstName, donor.lastName, resolveLocationValue(donor), donor.ethnicity, donor.race,
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

// True while the provider is paying to boost this profile.
function isSponsoredRow(d: any): boolean {
  const until = d?.sponsoredUntil ?? d?.sponsored;
  if (typeof until === "boolean") return until;
  return !!until && new Date(until).getTime() > Date.now();
}

export function sortDonors(donors: any[], sortBy: string): any[] {
  const comparatorFor = (key: string): ((a: any, b: any) => number) => {
    switch (key) {
      case "age_asc": return (a, b) => (a.age || 0) - (b.age || 0);
      case "age_desc": return (a, b) => (b.age || 0) - (a.age || 0);
      case "height_asc": return (a, b) => parseHeightToInches(a.height) - parseHeightToInches(b.height);
      case "height_desc": return (a, b) => parseHeightToInches(b.height) - parseHeightToInches(a.height);
      case "weight_asc": return (a, b) => parseWeight(a.weight) - parseWeight(b.weight);
      case "weight_desc": return (a, b) => parseWeight(b.weight) - parseWeight(a.weight);
      case "cost_asc": return (a, b) => getDonorCost(a) - getDonorCost(b);
      case "cost_desc": return (a, b) => getDonorCost(b) - getDonorCost(a);
      case "oldest": return (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
      case "newest":
      default: return (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    }
  };
  const cmp = comparatorFor(sortBy);
  // Sponsored profiles stay pinned on top across ANY filter/sort the parent picks
  // (search-filter pinning). The server already rotates order WITHIN the sponsored
  // group; a stable sort preserves that incoming order among equal-priority rows.
  return [...donors].sort((a, b) => {
    const as = isSponsoredRow(a) ? 1 : 0;
    const bs = isSponsoredRow(b) ? 1 : 0;
    if (as !== bs) return bs - as;
    return cmp(a, b);
  });
}
