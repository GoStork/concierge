import {
  MapPin, DollarSign, Wallet, GraduationCap, Briefcase,
  Snowflake, HeartHandshake, Baby, Scissors, Users, Award,
  Ruler, Scale, Hash, Globe, Heart, Syringe,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { getPhotoSrc, resolveSurrogateFields, resolveEggDonorFields, resolveSpermDonorFields } from "@/lib/profile-utils";
import { parseHeightToInches, resolveEthnicityTerms } from "@/lib/marketplace-filters";

export type LayoutType = "matched_bubbles" | "icon_list" | "standard_bubbles";

export interface TabItem {
  label: string;
  value: string;
  icon?: LucideIcon;
  lineBreakBefore?: boolean;
}

export interface TabSection {
  layoutType: LayoutType;
  title?: string;
  items: TabItem[];
}

export interface SwipeDeckProfile {
  id: string;
  providerType: "donor" | "surrogate";
  statusBadge: "New" | "Experienced" | null;
  isExperienced: boolean;
  firstName: string | null;
  externalId: string | null;
  age: number | null;
  location: string | null;
  photos: string[];
  photoUrl: string | null;

  height: string | null;
  weight: string | null;
  hairColor: string | null;
  eyeColor: string | null;
  ethnicity: string | null;
  race: string | null;
  religion: string | null;
  education: string | null;
  occupation: string | null;
  eggType: string | null;
  experienceLevel: string | null;
  donationType: string | null;
  donorCompensation: number | null;
  totalCost: number | null;
  eggLotCost: number | null;
  numberOfEggs: number | null;
  interests: string[];

  bmi: number | null;
  covidVaccinated: boolean | null;
  liveBirths: number | null;
  cSections: number | null;
  lastDeliveryYear: number | null;
  relationshipStatus: string | null;
  agreesToTwins: boolean | null;
  agreesToReduction: boolean | null;
  openToSameSexCouple: boolean | null;
  agreesToInternationalParents: boolean | null;
  miscarriages: number | null;
  occupation: string | null;
  baseCompensation: number | null;
  totalCostMin: number | null;
  totalCostMax: number | null;
  isPremium: boolean;
}

export interface UserPreference {
  key: string;
  value: string | number | boolean;
  rangeMin?: number;
  rangeMax?: number;
}

export interface MatchedPref {
  key: string;
  displayLabel: string;
}

export function mapDatabaseDonorToSwipeProfile(dbDonor: any): SwipeDeckProfile {
  const photos: string[] = [];
  if (Array.isArray(dbDonor.photos) && dbDonor.photos.length > 0) {
    photos.push(...dbDonor.photos);
  }
  if (photos.length === 0) {
    const allPhotos = dbDonor.profileData?.["All Photos"];
    if (Array.isArray(allPhotos) && allPhotos.length > 0) {
      photos.push(...allPhotos);
    }
  }
  if (photos.length === 0 && dbDonor.photoUrl) {
    photos.push(dbDonor.photoUrl);
  }

  const r = resolveEggDonorFields(dbDonor);

  return {
    id: dbDonor.id,
    providerType: "donor",
    statusBadge: dbDonor.status === "AVAILABLE" ? "New" : null,
    isExperienced: !!(dbDonor as any).isExperienced,
    firstName: dbDonor.firstName ?? null,
    externalId: dbDonor.externalId ?? null,
    age: r.age ? Number(r.age) : null,
    location: r.location,
    photos,
    photoUrl: dbDonor.photoUrl ?? null,
    height: r.height,
    weight: r.weight,
    hairColor: r.hairColor,
    eyeColor: r.eyeColor,
    ethnicity: r.ethnicity,
    race: r.race,
    religion: r.religion,
    education: r.education,
    occupation: r.occupation,
    eggType: r.donorType,
    experienceLevel: null,
    donationType: r.donationTypes,
    donorCompensation: r.resolvedCompensation ?? r.donorCompensation,
    totalCost: r.totalCost,
    eggLotCost: r.eggLotCost,
    numberOfEggs: r.numberOfEggs,
    interests: [],
    bmi: null,
    covidVaccinated: null,
    liveBirths: null,
    cSections: null,
    lastDeliveryYear: null,
    relationshipStatus: r.relationshipStatus,
    agreesToTwins: null,
    agreesToReduction: null,
    openToSameSexCouple: null,
    agreesToInternationalParents: null,
    miscarriages: null,
    baseCompensation: null,
    totalCostMin: null,
    totalCostMax: null,
    isPremium: !!dbDonor.isPremium,
  };
}

export function mapDatabaseSurrogateToSwipeProfile(dbSurrogate: any): SwipeDeckProfile {
  const photos: string[] = [];
  if (Array.isArray(dbSurrogate.photos) && dbSurrogate.photos.length > 0) {
    photos.push(...dbSurrogate.photos);
  }
  if (photos.length === 0) {
    const allPhotos = dbSurrogate.profileData?.["All Photos"];
    if (Array.isArray(allPhotos) && allPhotos.length > 0) {
      photos.push(...allPhotos);
    }
  }
  if (photos.length === 0 && dbSurrogate.photoUrl) {
    photos.push(dbSurrogate.photoUrl);
  }

  const r = resolveSurrogateFields(dbSurrogate);

  return {
    id: dbSurrogate.id,
    providerType: "surrogate",
    statusBadge: dbSurrogate.status === "AVAILABLE" ? "New" : null,
    isExperienced: !!(dbSurrogate as any).isExperienced,
    firstName: dbSurrogate.firstName ?? null,
    externalId: dbSurrogate.externalId ?? null,
    age: r.age ? Number(r.age) : null,
    location: r.location,
    photos,
    photoUrl: dbSurrogate.photoUrl ?? null,
    height: null,
    weight: null,
    hairColor: null,
    eyeColor: null,
    ethnicity: r.ethnicity,
    race: r.race,
    religion: r.religion,
    education: r.education,
    eggType: null,
    experienceLevel: null,
    donationType: null,
    donorCompensation: null,
    totalCost: null,
    eggLotCost: null,
    numberOfEggs: null,
    interests: [],
    bmi: r.bmi ? Number(r.bmi) : null,
    covidVaccinated: r.covidVaccinated,
    liveBirths: r.liveBirths,
    cSections: r.cSections,
    lastDeliveryYear: r.lastDeliveryYear ? Number(r.lastDeliveryYear) : null,
    relationshipStatus: r.relationshipStatus,
    agreesToTwins: r.agreesToTwins,
    agreesToReduction: r.agreesToAbortion,
    openToSameSexCouple: r.openToSameSexCouple,
    agreesToInternationalParents: r.agreesToInternationalParents,
    miscarriages: r.miscarriages,
    occupation: r.occupation,
    baseCompensation: r.resolvedCompensation ?? r.baseCompensation,
    totalCostMin: r.totalCostMin,
    totalCostMax: r.totalCostMax,
    isPremium: !!dbSurrogate.isPremium,
  };
}

export function mapDatabaseSpermDonorToSwipeProfile(dbSperm: any): SwipeDeckProfile {
  const photos: string[] = [];
  if (Array.isArray(dbSperm.photos) && dbSperm.photos.length > 0) {
    photos.push(...dbSperm.photos);
  }
  if (photos.length === 0) {
    const allPhotos = dbSperm.profileData?.["All Photos"];
    if (Array.isArray(allPhotos) && allPhotos.length > 0) {
      photos.push(...allPhotos);
    }
  }
  if (photos.length === 0 && dbSperm.photoUrl) {
    photos.push(dbSperm.photoUrl);
  }

  const r = resolveSpermDonorFields(dbSperm);

  return {
    id: dbSperm.id,
    providerType: "donor",
    statusBadge: dbSperm.status === "AVAILABLE" ? "New" : null,
    isExperienced: !!(dbSperm as any).isExperienced,
    firstName: dbSperm.firstName ?? null,
    externalId: dbSperm.externalId ?? null,
    age: r.age ? Number(r.age) : null,
    location: r.location,
    photos,
    photoUrl: dbSperm.photoUrl ?? null,
    height: r.height,
    weight: r.weight,
    hairColor: r.hairColor,
    eyeColor: r.eyeColor,
    ethnicity: r.ethnicity,
    race: r.race,
    religion: r.religion,
    education: r.education,
    occupation: r.occupation,
    eggType: null,
    experienceLevel: null,
    donationType: null,
    donorCompensation: r.resolvedCompensation ?? r.compensation,
    totalCost: r.totalCost,
    eggLotCost: null,
    numberOfEggs: null,
    interests: [],
    bmi: null,
    covidVaccinated: null,
    liveBirths: null,
    cSections: null,
    lastDeliveryYear: null,
    relationshipStatus: r.relationshipStatus,
    agreesToTwins: null,
    agreesToReduction: null,
    openToSameSexCouple: null,
    agreesToInternationalParents: null,
    miscarriages: null,
    baseCompensation: null,
    totalCostMin: null,
    totalCostMax: null,
    isPremium: !!dbSperm.isPremium,
  };
}

function isNonEmpty(val: any): val is string | number {
  if (val == null) return false;
  if (typeof val === "string") return val.trim().length > 0;
  return typeof val === "number";
}

function V(val: any): string | null {
  if (val == null) return null;
  const s = String(val).trim();
  return s.length > 0 ? s : null;
}

function formatCurrency(val: number | null): string | null {
  if (val == null) return null;
  return `$${Number(val).toLocaleString()}`;
}

function boolLabel(val: boolean | null | undefined): string {
  if (val === true) return "Yes";
  if (val === false) return "No";
  return "-";
}

export function getPhotoList(profile: SwipeDeckProfile): string[] {
  const list: string[] = [];
  if (profile.photos?.length) {
    for (const p of profile.photos) {
      const src = getPhotoSrc(p);
      if (src) list.push(src);
    }
  }
  if (list.length === 0 && profile.photoUrl) {
    const src = getPhotoSrc(profile.photoUrl);
    if (src) list.push(src);
  }
  return list;
}

export function getMatchedPreferences(profile: SwipeDeckProfile, prefs: UserPreference[]): MatchedPref[] {
  const matched: MatchedPref[] = [];
  const attrMap: Record<string, any> = {
    age: profile.age,
    location: profile.location,
    ethnicity: profile.ethnicity,
    race: profile.race,
    religion: profile.religion,
    education: profile.education,
    hairColor: profile.hairColor,
    eyeColor: profile.eyeColor,
    height: parseHeightToInches(profile.height) || null,
    bmi: profile.bmi,
    covidVaccinated: profile.covidVaccinated,
    eggType: profile.eggType,
    donorCompensation: profile.donorCompensation ?? 0,
    maxCost: profile.totalCost ?? profile.eggLotCost ?? 0,
    baseCompensation: profile.baseCompensation ?? 0,
  };

  const fmtCurrency = (v: number) => `$${Number(v).toLocaleString()}`;

  const displayMap: Record<string, (val: any) => string> = {
    age: (v) => `Age ${v}`,
    location: (v) => String(v),
    ethnicity: (v) => String(v),
    race: (v) => String(v),
    religion: (v) => String(v),
    education: (v) => String(v),
    hairColor: (v) => `${v} Hair`,
    eyeColor: (v) => `${v} Eyes`,
    height: (v) => { const ft = Math.floor(Number(v) / 12); const inches = Number(v) % 12; return `Height ${ft}'${inches}"`; },
    bmi: (v) => `BMI ${Math.round(Number(v))}`,
    covidVaccinated: (v) => v ? "COVID Vaccinated" : "Not COVID Vaccinated",
    eggType: (v) => String(v),
    donorCompensation: (v) => `${fmtCurrency(v)} Compensation`,
    maxCost: (v) => `${fmtCurrency(v)} Total Cost`,
    baseCompensation: (v) => `${fmtCurrency(v)} Base Comp.`,
  };

  const wmEth = (haystack: string, needle: string) => {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z])${escaped}($|[^a-z])`).test(haystack);
  };

  const seenKeys = new Set<string>();
  for (const pref of prefs) {
    if (seenKeys.has(pref.key)) continue;

    // Race/ethnicity: check race field first, ethnicity as fallback, display the actual matched value
    if (typeof pref.value === "string" && (pref.key === "race" || pref.key === "ethnicity")) {
      const raceVal = String(profile.race || "").toLowerCase();
      const ethVal = String(profile.ethnicity || "").toLowerCase();
      const terms = resolveEthnicityTerms(pref.value as string);
      const matchedViaRace = terms.some(t => wmEth(raceVal, t));
      const matchedViaEthnicity = !matchedViaRace && terms.some(t => wmEth(ethVal, t));
      if (matchedViaRace || matchedViaEthnicity) {
        seenKeys.add(pref.key);
        // Display the donor's actual value from the matched field
        const displayVal = matchedViaRace ? (profile.race || pref.value) : (profile.ethnicity || pref.value);
        matched.push({ key: pref.key, displayLabel: String(displayVal) });
      }
      continue;
    }

    const val = attrMap[pref.key];
    if (val == null) continue;
    let isMatch = false;
    if (pref.value === "range" && pref.rangeMin != null && pref.rangeMax != null) {
      const numVal = Number(val);
      if (!isNaN(numVal) && numVal >= pref.rangeMin && numVal <= pref.rangeMax) {
        isMatch = true;
      }
    } else if (typeof pref.value === "boolean" && val === pref.value) {
      isMatch = true;
    } else if (typeof pref.value === "string" && String(val).toLowerCase().includes(pref.value.toLowerCase())) {
      isMatch = true;
    } else if (typeof pref.value === "number" && Number(val) === pref.value) {
      isMatch = true;
    }
    if (isMatch) {
      seenKeys.add(pref.key);
      const formatter = displayMap[pref.key];
      matched.push({
        key: pref.key,
        displayLabel: formatter ? formatter(val) : String(val),
      });
    }
  }
  return matched;
}

export function buildTitle(profile: SwipeDeckProfile): string {
  const typeLabel = profile.providerType === "surrogate" ? "Surrogate" : "Donor";
  const rawId = profile.externalId || profile.id.slice(0, 8);
  const numericId = rawId.replace(/^[A-Za-z]+-/, "");
  return `${typeLabel} #${numericId}`;
}

export function buildStatusLabel(profile: SwipeDeckProfile): string | null {
  if (profile.statusBadge === "Experienced") {
    return profile.providerType === "surrogate" ? "Experienced Surrogate" : "Experienced Donor";
  }
  if (profile.statusBadge === "New") return "New";
  return null;
}

export function getDonorTabs(profile: SwipeDeckProfile, matchedPrefs: MatchedPref[]): TabSection[] {
  const tabs: TabSection[] = [];
  const matchedKeys = new Set(matchedPrefs.map(mp => mp.key));
  const isFrozen = profile.eggType != null && profile.eggType.toLowerCase().includes("frozen");

  if (matchedPrefs.length > 0) {
    tabs.push({
      layoutType: "matched_bubbles",
      title: `Matched ${matchedPrefs.length} Preference${matchedPrefs.length !== 1 ? "s" : ""}`,
      items: matchedPrefs.map(mp => ({ label: mp.displayLabel, value: "" })),
    });
  }

  const overviewItems: TabItem[] = [];
  if (!matchedKeys.has("age") && isNonEmpty(profile.age)) overviewItems.push({ label: `Age ${profile.age}`, value: "" });
  if (!matchedKeys.has("location") && isNonEmpty(profile.location)) overviewItems.push({ label: profile.location!, value: "" });
  if (isNonEmpty(profile.eggType)) overviewItems.push({ label: profile.eggType!, value: "" });
  if (overviewItems.length > 0) tabs.push({ layoutType: "standard_bubbles", title: "Overview", items: overviewItems });

  const physicalItems: TabItem[] = [];
  if (!matchedKeys.has("height") && V(profile.height)) physicalItems.push({ label: `Height ${V(profile.height)}`, value: "", icon: Ruler });
  if (!matchedKeys.has("weight") && V(profile.weight)) physicalItems.push({ label: V(profile.weight)!, value: "", icon: Scale });
  if (!matchedKeys.has("hairColor") && V(profile.hairColor)) physicalItems.push({ label: `${V(profile.hairColor)} Hair`, value: "" });
  if (!matchedKeys.has("eyeColor") && V(profile.eyeColor)) physicalItems.push({ label: `${V(profile.eyeColor)} Eyes`, value: "" });
  if (physicalItems.length > 0) tabs.push({ layoutType: "standard_bubbles", title: "Physical Traits", items: physicalItems });

  const bgItems: TabItem[] = [];
  if (!matchedKeys.has("race") && V(profile.race)) bgItems.push({ label: V(profile.race)!, value: "" });
  if (!matchedKeys.has("ethnicity") && V(profile.ethnicity)) bgItems.push({ label: V(profile.ethnicity)!, value: "" });
  if (!matchedKeys.has("education") && V(profile.education)) bgItems.push({ label: V(profile.education)!, value: "", icon: GraduationCap });
  if (!matchedKeys.has("religion") && V(profile.religion)) bgItems.push({ label: V(profile.religion)!, value: "" });
  if (bgItems.length > 0) tabs.push({ layoutType: "standard_bubbles", title: "Background & Education", items: bgItems });

  const costItems: TabItem[] = [];
  if (profile.numberOfEggs != null && profile.numberOfEggs > 0) {
    costItems.push({ label: `Eggs: ${profile.numberOfEggs}`, value: "", icon: Hash });
  }
  const isFreshAndFrozen = profile.eggType != null
    && profile.eggType.toLowerCase().includes("fresh")
    && profile.eggType.toLowerCase().includes("frozen");
  const isFrozenOnly = isFrozen && !isFreshAndFrozen;

  if (isFrozenOnly) {
    if (isNonEmpty(profile.eggLotCost)) costItems.push({ label: `Egg Lot Cost: ${formatCurrency(profile.eggLotCost)}`, value: "", icon: Wallet });
  } else if (isFreshAndFrozen) {
    if (isNonEmpty(profile.eggLotCost)) costItems.push({ label: `Egg Lot Cost: ${formatCurrency(profile.eggLotCost)}`, value: "", icon: Wallet });
    if (isNonEmpty(profile.donorCompensation)) costItems.push({ label: `Compensation: ${formatCurrency(profile.donorCompensation)}`, value: "", icon: DollarSign });
    if (isNonEmpty(profile.totalCost)) costItems.push({ label: `Total Journey Cost: ${formatCurrency(profile.totalCost)}`, value: "", icon: Wallet });
  } else {
    if (isNonEmpty(profile.donorCompensation)) costItems.push({ label: `Compensation: ${formatCurrency(profile.donorCompensation)}`, value: "", icon: DollarSign });
    if (isNonEmpty(profile.totalCost)) costItems.push({ label: `Total Journey Cost: ${formatCurrency(profile.totalCost)}`, value: "", icon: Wallet });
  }
  if (costItems.length > 0) tabs.push({ layoutType: "icon_list", title: "Journey Costs", items: costItems });

  const interestItems: TabItem[] = [];
  if (isNonEmpty(profile.occupation)) interestItems.push({ label: profile.occupation!, value: "", icon: Briefcase });
  const validHobbies = profile.interests.filter(i => i != null && i.trim() !== "");
  if (validHobbies.length > 0) {
    for (const h of validHobbies) interestItems.push({ label: h, value: "" });
  }
  if (interestItems.length > 0) tabs.push({ layoutType: "standard_bubbles", title: "Personal Interests", items: interestItems });

  return tabs;
}

export function getSurrogateTabs(profile: SwipeDeckProfile, matchedPrefs: MatchedPref[]): TabSection[] {
  const tabs: TabSection[] = [];
  const matchedKeys = new Set(matchedPrefs.map(mp => mp.key));

  if (matchedPrefs.length > 0) {
    tabs.push({
      layoutType: "matched_bubbles",
      title: `Matched ${matchedPrefs.length} Preference${matchedPrefs.length !== 1 ? "s" : ""}`,
      items: matchedPrefs.map(mp => ({ label: mp.displayLabel, value: "" })),
    });
  } else {
    const overviewItems: TabItem[] = [];
    if (isNonEmpty(profile.age)) overviewItems.push({ label: `Age ${profile.age}`, value: "" });
    if (isNonEmpty(profile.location)) overviewItems.push({ label: profile.location!, value: "" });
    if (profile.bmi) overviewItems.push({ label: `BMI ${Math.round(Number(profile.bmi))}`, value: "", lineBreakBefore: true });
    if (isNonEmpty(profile.relationshipStatus)) overviewItems.push({ label: profile.relationshipStatus!, value: "" });
    if (isNonEmpty(profile.occupation)) overviewItems.push({ label: profile.occupation!, value: "" });
    if (overviewItems.length > 0) tabs.push({ layoutType: "standard_bubbles", title: "Overview", items: overviewItems });
  }

  const bgItems: TabItem[] = [];
  if (!matchedKeys.has("race") && V(profile.race)) bgItems.push({ label: V(profile.race)!, value: "" });
  if (!matchedKeys.has("ethnicity") && V(profile.ethnicity)) bgItems.push({ label: V(profile.ethnicity)!, value: "" });
  if (!matchedKeys.has("education") && V(profile.education)) bgItems.push({ label: V(profile.education)!, value: "", icon: GraduationCap });
  if (!matchedKeys.has("religion") && V(profile.religion)) bgItems.push({ label: V(profile.religion)!, value: "" });
  if (bgItems.length > 0) tabs.push({ layoutType: "standard_bubbles", title: "Background & Education", items: bgItems });

  const costItems: TabItem[] = [];
  if (isNonEmpty(profile.baseCompensation)) costItems.push({ label: `Base Compensation: ${formatCurrency(profile.baseCompensation)}`, value: "", icon: DollarSign });
  if (profile.totalCostMin && profile.totalCostMax && Number(profile.totalCostMax) !== Number(profile.totalCostMin)) {
    costItems.push({ label: `Total Cost: ${formatCurrency(profile.totalCostMin)} – ${formatCurrency(profile.totalCostMax)}`, value: "", icon: Wallet });
  } else if (profile.totalCostMin) {
    costItems.push({ label: `Total Cost: ${formatCurrency(profile.totalCostMin)}`, value: "", icon: Wallet });
  }
  if (costItems.length > 0) tabs.push({ layoutType: "icon_list", title: "Journey Costs", items: costItems });

  const medicalItems: TabItem[] = [];
  if (!matchedKeys.has("liveBirths") && profile.liveBirths != null) medicalItems.push({ label: `Live Births: ${String(profile.liveBirths)}`, value: "" });
  if (!matchedKeys.has("cSections") && profile.cSections != null) medicalItems.push({ label: `C-Sections: ${String(profile.cSections)}`, value: "" });
  if (profile.miscarriages != null) medicalItems.push({ label: `Miscarriages: ${String(profile.miscarriages)}`, value: "" });
  medicalItems.push({ label: `Abortions: 0`, value: "" });
  if (!matchedKeys.has("covidVaccinated") && profile.covidVaccinated != null) medicalItems.push({ label: `COVID Vaccinated: ${boolLabel(profile.covidVaccinated)}`, value: "", icon: Syringe });
  if (profile.lastDeliveryYear) medicalItems.push({ label: `Last Delivery: ${String(profile.lastDeliveryYear)}`, value: "" });
  if (medicalItems.length > 0) tabs.push({ layoutType: "standard_bubbles", title: "Medical", items: medicalItems });

  const agreesItems: TabItem[] = [];
  if (profile.agreesToTwins != null) agreesItems.push({ label: `Carry Twins: ${boolLabel(profile.agreesToTwins)}`, value: "", icon: Baby });
  if (profile.agreesToReduction != null) agreesItems.push({ label: `Abortion: ${boolLabel(profile.agreesToReduction)}`, value: "", icon: Heart });
  if (profile.agreesToReduction != null) agreesItems.push({ label: `Selective Reduction: ${boolLabel(profile.agreesToReduction)}`, value: "", icon: Scissors });
  if (profile.openToSameSexCouple != null) agreesItems.push({ label: `Same Sex Couple: ${boolLabel(profile.openToSameSexCouple)}`, value: "", icon: Users });
  if (profile.agreesToInternationalParents != null) agreesItems.push({ label: `International Parents: ${boolLabel(profile.agreesToInternationalParents)}`, value: "", icon: Globe });
  if (agreesItems.length > 0) tabs.push({ layoutType: "icon_list", title: "Agrees To", items: agreesItems });

  const validInterests = profile.interests.filter(i => i != null && i.trim() !== "");
  if (validInterests.length > 0) {
    tabs.push({
      layoutType: "standard_bubbles",
      title: "Interests",
      items: validInterests.map(i => ({ label: i, value: "" })),
    });
  }

  return tabs;
}

export interface SidebarRow {
  label: string;
  value: string;
  icon?: LucideIcon;
}

export interface SidebarSection {
  title: string;
  rows: SidebarRow[];
}

function boolStr(v: boolean | null | undefined): string {
  return v == null ? "-" : v ? "Yes" : "No";
}

function fmtCurrency(v: number | null | undefined): string {
  if (v == null) return "-";
  return `$${Number(v).toLocaleString()}`;
}

function isNonEmptyStr(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim() !== "";
}

export function buildSidebarSections(profile: SwipeDeckProfile): SidebarSection[] {
  const sections: SidebarSection[] = [];
  const isSurrogate = profile.providerType === "surrogate";

  // Overview
  const overview: SidebarRow[] = [];
  if (profile.age != null) overview.push({ label: "Age", value: String(profile.age) });
  if (isNonEmptyStr(profile.location)) overview.push({ label: "Location", value: profile.location });
  if (!isSurrogate && isNonEmptyStr(profile.eggType)) overview.push({ label: "Egg Type", value: profile.eggType });
  if (isSurrogate && profile.bmi != null) overview.push({ label: "BMI", value: String(Math.round(Number(profile.bmi))) });
  if (isSurrogate && isNonEmptyStr(profile.relationshipStatus)) overview.push({ label: "Relationship Status", value: profile.relationshipStatus });
  if (isSurrogate && isNonEmptyStr(profile.occupation)) overview.push({ label: "Occupation", value: profile.occupation });
  if (overview.length > 0) sections.push({ title: "Overview", rows: overview });

  // Physical Traits (donors only)
  if (!isSurrogate) {
    const physical: SidebarRow[] = [];
    if (isNonEmptyStr(profile.height)) physical.push({ label: "Height", value: profile.height });
    if (isNonEmptyStr(profile.weight)) physical.push({ label: "Weight", value: profile.weight });
    if (isNonEmptyStr(profile.hairColor)) physical.push({ label: "Hair Color", value: profile.hairColor });
    if (isNonEmptyStr(profile.eyeColor)) physical.push({ label: "Eye Color", value: profile.eyeColor });
    if (physical.length > 0) sections.push({ title: "Physical Traits", rows: physical });
  }

  // Background & Education
  const bg: SidebarRow[] = [];
  if (isNonEmptyStr(profile.race)) bg.push({ label: "Race", value: profile.race });
  if (isNonEmptyStr(profile.ethnicity)) bg.push({ label: "Ethnicity", value: profile.ethnicity });
  if (isNonEmptyStr(profile.education)) bg.push({ label: "Education", value: profile.education });
  if (isNonEmptyStr(profile.religion)) bg.push({ label: "Religion", value: profile.religion });
  if (bg.length > 0) sections.push({ title: "Background & Education", rows: bg });

  // Journey Costs
  const costs: SidebarRow[] = [];
  if (isSurrogate) {
    if (profile.baseCompensation != null) costs.push({ label: "Base Compensation", value: fmtCurrency(profile.baseCompensation) });
    if (profile.totalCostMin != null && profile.totalCostMax != null && profile.totalCostMin !== profile.totalCostMax) {
      costs.push({ label: "Total Cost", value: `${fmtCurrency(profile.totalCostMin)} - ${fmtCurrency(profile.totalCostMax)}` });
    } else if (profile.totalCostMin != null) {
      costs.push({ label: "Total Cost", value: fmtCurrency(profile.totalCostMin) });
    }
  } else {
    if (profile.numberOfEggs != null && profile.numberOfEggs > 0) costs.push({ label: "Available Eggs", value: String(profile.numberOfEggs) });
    if (profile.eggLotCost != null) costs.push({ label: "Egg Lot Cost", value: fmtCurrency(profile.eggLotCost) });
    if (profile.donorCompensation != null) costs.push({ label: "Compensation", value: fmtCurrency(profile.donorCompensation) });
    if (profile.totalCost != null) costs.push({ label: "Total Journey Cost", value: fmtCurrency(profile.totalCost) });
  }
  if (costs.length > 0) sections.push({ title: "Journey Costs", rows: costs });

  // Medical (surrogates only)
  if (isSurrogate) {
    const medical: SidebarRow[] = [];
    if (profile.liveBirths != null) medical.push({ label: "Live Births", value: String(profile.liveBirths) });
    if (profile.cSections != null) medical.push({ label: "C-Sections", value: String(profile.cSections) });
    if (profile.miscarriages != null) medical.push({ label: "Miscarriages", value: String(profile.miscarriages) });
    medical.push({ label: "Abortions", value: "0" });
    if (profile.covidVaccinated != null) medical.push({ label: "COVID Vaccinated", value: boolStr(profile.covidVaccinated) });
    if (profile.lastDeliveryYear != null) medical.push({ label: "Last Delivery", value: String(profile.lastDeliveryYear) });
    if (medical.length > 0) sections.push({ title: "Medical", rows: medical });
  }

  // Agrees To (surrogates only)
  if (isSurrogate) {
    const agrees: SidebarRow[] = [];
    if (profile.agreesToTwins != null) agrees.push({ label: "Carry Twins", value: boolStr(profile.agreesToTwins) });
    if (profile.agreesToReduction != null) agrees.push({ label: "Abortion", value: boolStr(profile.agreesToReduction) });
    if (profile.agreesToReduction != null) agrees.push({ label: "Selective Reduction", value: boolStr(profile.agreesToReduction) });
    if (profile.openToSameSexCouple != null) agrees.push({ label: "Same Sex Couple", value: boolStr(profile.openToSameSexCouple) });
    if (profile.agreesToInternationalParents != null) agrees.push({ label: "International Parents", value: boolStr(profile.agreesToInternationalParents) });
    if (agrees.length > 0) sections.push({ title: "Agrees To", rows: agrees });
  }

  // Personal Interests (donors only)
  if (!isSurrogate) {
    const interests: SidebarRow[] = [];
    if (isNonEmptyStr(profile.occupation)) interests.push({ label: "Occupation", value: profile.occupation });
    (profile.interests || []).filter(i => isNonEmptyStr(i)).forEach(i => interests.push({ label: "Interest", value: i }));
    if (interests.length > 0) sections.push({ title: "Personal Interests", rows: interests });
  }

  return sections;
}
