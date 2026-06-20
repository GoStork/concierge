import {
  DollarSign, Wallet, GraduationCap, Briefcase,
  Snowflake, HeartHandshake, Baby, Scissors, Users, Award,
  Ruler, Scale, Hash, Globe, Heart, Syringe,
  Video, Stethoscope, UserCheck, ThumbsUp, Star,
  Calendar, FileText, ShieldCheck, Building2, MapPin,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { getPhotoSrc, resolveSurrogateFields, resolveEggDonorFields, resolveSpermDonorFields } from "@/lib/profile-utils";
import { parseHeightToInches, resolveEthnicityTerms } from "@/lib/marketplace-filters";
import { formatMoneyDollars } from "@/lib/format-money";
import { formatLocationDisplay, dedupeProviderLocations } from "@/lib/format-location";
import { getLocationFlag, cleanCityState, getCountryFlag } from "@/lib/country-flag";

// True while the provider is paying to boost this profile (denormalized sponsoredUntil in the future).
export function isSponsored(row: any): boolean {
  const until = row?.sponsoredUntil;
  return !!until && new Date(until).getTime() > Date.now();
}

// "🇺🇸 California" - location label with its country flag prefixed (no flag -> plain).
function flaggedLocation(location: string | null | undefined): string {
  const label = formatLocationDisplay(location) || (location ? String(location) : "");
  const flag = getLocationFlag(location);
  return flag ? `${flag} ${label}` : label;
}

// Recover the city the scraper dropped: the raw profile keeps "City, State" in
// profileData.Location / "Current City" while the stored `location` scalar often
// has only the state. Used for the card's display label (NOT for filtering).
function deriveDisplayLocation(rawLocation: string | null | undefined, profileData: any): string | null {
  const pd = profileData && typeof profileData === "object" ? profileData : null;
  const richer = pd ? (pd["Location"] ?? pd["Current City"] ?? null) : null;
  return cleanCityState(typeof richer === "string" ? richer : null, rawLocation ?? null) ?? (rawLocation ?? null);
}

// Build the shared "Costs" tab. When the card components supply structured
// program data (country + name + total) it renders as mini program cards that
// mirror the profile page (flag, "Program N" pill, name, big price) minus the
// line items. Otherwise it falls back to the flat $ icon_list, and to a
// consultation note when there are no programs at all - so the tab is always
// present. Capped on the fixed-height card with a "+N more" overflow.
function buildCostsTab(costs: CostInput[] | undefined, compact?: boolean): TabSection {
  const hasRich = !!costs && costs.length > 0 && costs.some((c) => c.programName && c.total);
  if (hasRich) {
    const CAP = compact ? 4 : 5;
    const programs: CostProgramCard[] = (costs as CostInput[]).slice(0, CAP).map((c) => {
      // Program names are often "<subtype> · <option>" (e.g. "Frozen Embryo
      // Transfer (Surrogate) · Embryo Transfer (One Cycle)"). The country heading
      // already covers the lead; show only the trailing option so the compact
      // one-line name stays distinguishable across programs.
      const full = c.programName || c.label || "Program";
      const programName = full.includes(" · ") ? (full.split(" · ").pop() || full).trim() : full;
      return {
        country: c.country || "",
        flag: c.country ? getCountryFlag(c.country) : "",
        programName,
        subLabel: c.subLabel ?? null,
        total: c.total || "",
      };
    });
    const overflow = (costs as CostInput[]).length - CAP;
    return { layoutType: "cost_cards", title: "Costs", items: [], costPrograms: programs, costOverflow: overflow > 0 ? overflow : 0 };
  }
  let costItems: TabItem[];
  if (costs && costs.length > 0) {
    const CAP = compact ? 4 : 6;
    costItems = costs.slice(0, CAP).map((c) => ({ label: c.label, value: "", icon: DollarSign }));
    if (costs.length > CAP) costItems.push({ label: `+${costs.length - CAP} more programs`, value: "" });
  } else {
    costItems = [{ label: "Pricing shared on your free consultation", value: "", icon: DollarSign }];
  }
  return { layoutType: "icon_list", title: "Costs", items: costItems };
}

export type LayoutType = "matched_bubbles" | "icon_list" | "standard_bubbles" | "success_bars" | "sections" | "matched_compact" | "cost_cards";

// One mini program card on the "Costs" tab - mirrors the profile's program card
// (flag + country, "Program N" pill, program name, big total) but with NO line
// items. Cheapest-first; capped on the card with a "+N more" note.
export interface CostProgramCard {
  country: string;
  flag: string;
  programName: string;
  subLabel?: string | null;
  total: string;
}

// Rich cost input from the card components - `label` is the legacy flat string
// (kept as a fallback); the structured fields drive the cost_cards layout.
export interface CostInput {
  label: string;
  value?: string;
  country?: string | null;
  programName?: string | null;
  subLabel?: string | null;
  total?: string | null;
}

// Compact "Matched to you" stat block: success rate (clinic vs national) + the
// per-year cycles/babies, in a few lines so it never covers half the photo.
export interface MatchedStat {
  pct: number | null;
  natAvg: number | null;
  cycles: number | null;
  babies: number | null;
  context?: string;
}

export interface TabItem {
  label: string;
  value: string;
  icon?: LucideIcon;
  lineBreakBefore?: boolean;
}

// One sub-section inside a "sections" tab (a tab that stacks several titled
// groups - e.g. the agency Overview tab shows Overview / Services / Locations,
// or the Matched tab shows Success rate + per-year volume).
export interface TabGroup {
  title?: string;
  subtitle?: string;
  layoutType: "standard_bubbles" | "icon_list" | "success_bars" | "text";
  items: TabItem[];
  bars?: SuccessBar[];
}

// A single horizontal bar in the "success_bars" layout (clinic vs national avg).
export interface SuccessBar {
  label: string;
  value: number;
  isClinic: boolean;
}

export interface TabSection {
  layoutType: LayoutType;
  title?: string;
  // Small caption under the title - used by success_bars to show the context
  // ("Own eggs · Under 35 · First-time IVF").
  subtitle?: string;
  items: TabItem[];
  // Only for the "success_bars" layout.
  bars?: SuccessBar[];
  // Only for the "sections" layout - the stacked titled groups.
  groups?: TabGroup[];
  // Only for the "matched_compact" layout.
  matchedStat?: MatchedStat;
  // Only for the "cost_cards" layout - the mini program cards + overflow count.
  costPrograms?: CostProgramCard[];
  costOverflow?: number;
  // Per-tab background photo (opt-in). When set, THIS tab renders over this
  // photo (face hero) instead of the cream cover; photoless tabs stay cream.
  // Used by the clinic card to put each doctor's own info on their face tab.
  photo?: string | null;
  // Name shown in the header when this tab has a photo (e.g. the doctor's name).
  faceLabel?: string;
}

// Coerce a raw DB status string to the canonical UI set. Anything outside
// AVAILABLE/PENDING/MATCHED/SOLD_OUT (e.g. an unexpected upstream label
// that escaped normalization, or a null) collapses to AVAILABLE so the
// card still renders cleanly - INACTIVE rows are excluded at the API layer
// and never reach the mapper. SOLD_OUT only applies to sperm donors and
// pure Frozen Eggs donors but the type union is shared so all three
// mappers can route through here.
export function normalizeProfileStatus(raw: string | null | undefined): "AVAILABLE" | "PENDING" | "MATCHED" | "SOLD_OUT" {
  if (raw === "PENDING" || raw === "MATCHED" || raw === "SOLD_OUT") return raw;
  return "AVAILABLE";
}

function normalizeFrozenLotStatus(raw: string | null | undefined): "AVAILABLE" | "SOLD_OUT" | null {
  if (raw === "AVAILABLE" || raw === "SOLD_OUT") return raw;
  return null;
}

// Resolve the headline `donorStatus` badge for an egg donor based on type:
//   - "Fresh Donor"      -> fresh status (AVAILABLE/PENDING/MATCHED)
//   - "Frozen Eggs"      -> frozen lot status (AVAILABLE/SOLD_OUT), since
//                           the donor has no fresh cycle and the DB's
//                           `status` column is meaningless for them
//   - "Fresh & Frozen"   -> fresh status (the frozen side is rendered
//                           as a second badge on the card)
export function resolveEggDonorHeadlineStatus(
  dbDonor: any,
): "AVAILABLE" | "PENDING" | "MATCHED" | "SOLD_OUT" {
  const dt = (dbDonor.donorType || "").toLowerCase();
  if (dt === "frozen eggs") {
    const fl = normalizeFrozenLotStatus(dbDonor.frozenLotStatus);
    return fl === "SOLD_OUT" ? "SOLD_OUT" : "AVAILABLE";
  }
  return normalizeProfileStatus(dbDonor.status);
}

export interface SwipeDeckProfile {
  id: string;
  providerType: "donor" | "surrogate";
  // Timestamp the profile row was created in our DB. Used together with the
  // parent's viewed-profile set to decide whether to render the "New" badge:
  // a profile is "New" iff createdAt > now - 24h AND the parent hasn't yet
  // tapped, hearted, passed, scrolled-past, or received it as a MATCH_CARD.
  // See client/src/lib/profile-views.tsx (isProfileNew).
  createdAt: string | null;
  // Legacy marker - kept on the type for back-compat with prior callers,
  // but the per-parent "New" decision is now computed at render time via
  // isProfileNew(). The mapper leaves this null; consumers should use the
  // helper instead of reading statusBadge directly.
  statusBadge: "New" | "Experienced" | null;
  // Canonical donor/surrogate status from the DB (AVAILABLE | PENDING | MATCHED).
  // Drives the colored status pill on the card. AVAILABLE renders nothing
  // (presence on the marketplace is the signal); PENDING and MATCHED render
  // an explicit badge so parents see at a glance that the donor can't be
  // booked right now (or is not yet approved).
  donorStatus: "AVAILABLE" | "PENDING" | "MATCHED" | "SOLD_OUT" | null;
  // Frozen-lot inventory state, only populated for egg donors who offer
  // frozen eggs (donorType "Frozen Eggs" or "Fresh & Frozen"). null when
  // the donor has no frozen offering. For "Fresh & Frozen" donors this
  // lives ALONGSIDE donorStatus so the card can render both badges:
  // donorStatus carries the fresh-cycle state, frozenLotStatus carries the
  // frozen-lot state. For pure "Frozen Eggs" donors, donorStatus mirrors
  // frozenLotStatus (since fresh has no meaning) so existing single-badge
  // render paths still work.
  frozenLotStatus: "AVAILABLE" | "SOLD_OUT" | null;
  // Raw "Frozen Egg Availability" string from the scraper - preserved so
  // the profile detail can show "Less than 6 eggs available" as a low-
  // stock signal next to the numberOfEggs count, without needing a
  // separate LOW_STOCK status state. null when the donor has no frozen
  // offering or we have no raw label.
  frozenEggAvailabilityRaw: string | null;
  isExperienced: boolean;
  firstName: string | null;
  externalId: string | null;
  age: number | null;
  // `location` is the raw stored value, kept for filtering / Matched Preferences
  // (it must mirror matchesFilter). `displayLocation` is the richer "City, State"
  // recovered from the scraped profile for the card chip only.
  location: string | null;
  displayLocation: string | null;
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
  vialTypes: string[];
  vialCosts: { label: string; cost: number }[];
  iciCost: number | null;
  iuiCost: number | null;
  ivfCost: number | null;
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
  // Sponsorship: true while the provider is paying to boost this profile.
  sponsored: boolean;
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
    createdAt: dbDonor.createdAt ?? null,
    statusBadge: null,
    donorStatus: resolveEggDonorHeadlineStatus(dbDonor),
    frozenLotStatus: normalizeFrozenLotStatus(dbDonor.frozenLotStatus),
    frozenEggAvailabilityRaw: (dbDonor.profileData as any)?.["Frozen Egg Availability"] || null,
    isExperienced: !!(dbDonor as any).isExperienced,
    firstName: dbDonor.firstName ?? null,
    externalId: dbDonor.externalId ?? null,
    age: r.age ? Number(r.age) : null,
    location: r.location,
    displayLocation: deriveDisplayLocation(r.location, dbDonor.profileData),
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
    vialTypes: [],
    vialCosts: [],
    iciCost: null,
    iuiCost: null,
    ivfCost: null,
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
    sponsored: isSponsored(dbDonor),
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
    createdAt: dbSurrogate.createdAt ?? null,
    statusBadge: null,
    donorStatus: normalizeProfileStatus(dbSurrogate.status),
    frozenLotStatus: null,
    frozenEggAvailabilityRaw: null,
    isExperienced: !!(dbSurrogate as any).isExperienced,
    firstName: dbSurrogate.firstName ?? null,
    externalId: dbSurrogate.externalId ?? null,
    age: r.age ? Number(r.age) : null,
    location: r.location,
    displayLocation: deriveDisplayLocation(r.location, dbSurrogate.profileData),
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
    vialTypes: [],
    vialCosts: [],
    iciCost: null,
    iuiCost: null,
    ivfCost: null,
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
    sponsored: isSponsored(dbSurrogate),
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
    createdAt: dbSperm.createdAt ?? null,
    statusBadge: null,
    donorStatus: normalizeProfileStatus(dbSperm.status),
    frozenLotStatus: null,
    frozenEggAvailabilityRaw: null,
    isExperienced: !!(dbSperm as any).isExperienced,
    firstName: dbSperm.firstName ?? null,
    externalId: dbSperm.externalId ?? null,
    age: r.age ? Number(r.age) : null,
    location: r.location,
    displayLocation: deriveDisplayLocation(r.location, dbSperm.profileData),
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
    eggType: r.donorType,
    experienceLevel: null,
    donationType: null,
    vialTypes: r.vialTypes,
    vialCosts: r.vialCosts,
    iciCost: r.iciCost,
    iuiCost: r.iuiCost,
    ivfCost: r.ivfCost,
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
    sponsored: isSponsored(dbSperm),
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

// Only render an age when it falls in a plausible donor range. Guards against
// junk that slips in from a bad scrape (e.g. a stored -1976) so the card never
// shows "Age -1976".
function isValidAge(val: any): boolean {
  if (!isNonEmpty(val)) return false;
  const n = Number(val);
  return Number.isFinite(n) && n >= 18 && n <= 99;
}

function formatCurrency(val: number | null): string | null {
  if (val == null) return null;
  return formatMoneyDollars(Number(val));
}

function boolLabel(val: boolean | null | undefined): string {
  if (val === true) return "Yes";
  if (val === false) return "No";
  return "-";
}

export function isExpiredPresignedAwsUrl(url: string): boolean {
  if (!/amazonaws\.com/i.test(url) || !/[?&]X-Amz-/i.test(url)) return false;
  const dateMatch = url.match(/[?&]X-Amz-Date=(\d{8}T\d{6}Z)/i);
  const expiresMatch = url.match(/[?&]X-Amz-Expires=(\d+)/i);
  if (!dateMatch || !expiresMatch) return true;
  const d = dateMatch[1];
  const signedAt = new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${d.slice(9,11)}:${d.slice(11,13)}:${d.slice(13,15)}Z`);
  const expiresAt = new Date(signedAt.getTime() + parseInt(expiresMatch[1]) * 1000);
  return Date.now() > expiresAt.getTime();
}

export function pickFirstValidPhoto(photos: string[] | null | undefined, photoUrl: string | null | undefined): string | null {
  if (Array.isArray(photos)) {
    for (const p of photos) {
      if (p && !isExpiredPresignedAwsUrl(p)) return p;
    }
  }
  if (photoUrl && !isExpiredPresignedAwsUrl(photoUrl)) return photoUrl;
  return null;
}

export function getPhotoList(profile: SwipeDeckProfile): string[] {
  const list: string[] = [];
  if (profile.photos?.length) {
    for (const p of profile.photos) {
      if (isExpiredPresignedAwsUrl(p)) continue;
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
    agreesToTwins: profile.agreesToTwins,
    agreesToAbortion: profile.agreesToReduction, // surrogate.agreesToAbortion maps to profile.agreesToReduction
    eggType: profile.eggType,
    donorType: profile.eggType,
    vialTypes: profile.vialTypes?.length ? profile.vialTypes.join(", ") : null,
    donorCompensation: profile.donorCompensation ?? 0,
    maxCost: profile.totalCost ?? profile.eggLotCost ?? 0,
    baseCompensation: profile.baseCompensation ?? 0,
  };

  const fmtCurrency = (v: number) => formatMoneyDollars(Number(v));

  const displayMap: Record<string, (val: any) => string> = {
    age: (v) => `Age ${v}`,
    location: (v) => formatLocationDisplay(String(v)) || String(v),
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
    donorType: (v) => String(v),
    vialTypes: (v) => `Available for: ${v}`,
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
    } else if (typeof pref.value === "string") {
      const normalizeHair = (s: string) => s.replace(/\bblonde\b/gi, "blond");
      isMatch = normalizeHair(String(val).toLowerCase()).includes(normalizeHair(pref.value.toLowerCase()));
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

// Compute the purple "New" label for the card. A profile is "New" iff
// it was created after the parent's previous marketplace visit AND the
// parent hasn't yet seen this specific profile. previousVisitAt is the
// server-controlled watermark from useMarketplaceViewContext - it slides
// forward only when the parent starts a fresh session (30 min sliding
// window), so reloads within the same session keep the same set of New
// badges visible.
// Callers that don't have a watermark (e.g. unauthenticated previews)
// can omit it - in that case nothing renders as New, which is the safe
// default.
export function buildStatusLabel(
  profile: SwipeDeckProfile,
  viewedIds: Set<string> = new Set(),
  previousVisitAt: Date | null = null,
): string | null {
  if (!profile.createdAt || !previousVisitAt) return null;
  if (viewedIds.has(profile.id)) return null;
  const createdMs = new Date(profile.createdAt).getTime();
  if (Number.isNaN(createdMs)) return null;
  if (createdMs <= previousVisitAt.getTime()) return null;
  return "New";
}

export function getDonorTabs(profile: SwipeDeckProfile, matchedPrefs: MatchedPref[], isSpermDonor = false): TabSection[] {
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
  if (!matchedKeys.has("age") && isValidAge(profile.age)) overviewItems.push({ label: `Age ${profile.age}`, value: "" });
  if (!matchedKeys.has("location") && isNonEmpty(profile.location)) overviewItems.push({ label: flaggedLocation(profile.displayLocation || profile.location), value: "" });
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
  if (isSpermDonor) {
    // Show all matching vial cost programs from the cost sheet
    if (profile.vialCosts?.length > 0) {
      for (const vc of profile.vialCosts) {
        costItems.push({ label: `${vc.label}: ${formatCurrency(vc.cost)}`, value: "", icon: Wallet });
      }
    } else if (isNonEmpty(profile.totalCost)) {
      // Fall back to totalCost if no per-vial costs available yet
      costItems.push({ label: `Vial Cost: ${formatCurrency(profile.totalCost)}`, value: "", icon: Wallet });
    }
  } else {
    if (profile.numberOfEggs != null && profile.numberOfEggs > 0) {
      costItems.push({ label: `Eggs: ${profile.numberOfEggs}`, value: "", icon: Hash });
    }
    // Surface low-stock signal as a separate item. Mirrors the raw scraper
    // label ("Less than 6 eggs available") so parents see the warning next
    // to the count - not a separate canonical status, just a metric.
    if (profile.frozenEggAvailabilityRaw && /less than/i.test(profile.frozenEggAvailabilityRaw)) {
      costItems.push({ label: profile.frozenEggAvailabilityRaw, value: "", icon: Hash });
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
    if (isNonEmpty(profile.location)) overviewItems.push({ label: flaggedLocation(profile.displayLocation || profile.location), value: "" });
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

// One doctor's "Overview" tab (About / Works at / Locations / Languages) for
// embedding on the CLINIC card - the SAME first tab the doctor's own card shows.
// The doctor's face becomes this tab's background; clinic context fills Works
// at / Locations. Returns null when the member has nothing to show.
export function buildClinicDoctorTab(
  member: { name?: string | null; bio?: string | null; languagesSpoken?: string[] | null },
  clinicName: string | null,
  clinicLocations: { city?: string | null; state?: string | null }[],
  facePhoto: string | null,
): TabSection | null {
  const doctorData: DoctorCardData = {
    slug: "",
    name: member.name || "Doctor",
    bio: member.bio ?? null,
    languagesSpoken: (member.languagesSpoken || []).filter(Boolean),
    clinics: clinicName
      ? [{ providerId: "", providerName: clinicName, location: (clinicLocations[0] ? [clinicLocations[0].city, clinicLocations[0].state].filter(Boolean).join(", ") : null) }]
      : [],
  };
  // getDoctorTabs[0] is the condensed Overview icon_list tab (Works at /
  // Locations / Languages as icon rows). Bail only when there's nothing to show.
  const overview = getDoctorTabs(doctorData)[0];
  if (!overview || overview.layoutType !== "icon_list" || overview.items.length === 0) return null;
  return { ...overview, photo: facePhoto, faceLabel: member.name || undefined };
}

// The shared "Matched to you" tab for clinics AND doctors. A COMPACT stat block
// (success rate hero + a slim clinic-vs-national bar + one inline cycles/babies
// line) so it never covers half the photo. contextLabel spells out who
// "patients like you" are (e.g. "Own eggs · Under 35 · First-time IVF").
function buildMatchedTab(contextLabel: string | null | undefined, bars: SuccessBar[], cycles: number | null, babies: number | null): TabSection {
  const clinic = bars.find((b) => b.isClinic);
  const nat = bars.find((b) => !b.isClinic);
  return {
    layoutType: "matched_compact",
    items: [],
    matchedStat: {
      pct: clinic ? clinic.value : null,
      natAvg: nat ? nat.value : null,
      cycles: cycles != null && cycles > 0 ? cycles : null,
      babies: babies != null && babies > 0 ? babies : null,
      context: contextLabel || undefined,
    },
  };
}

// Tabs for a clinic SwipeDeckCard. The first tab pairs the parent-matched
// preferences with the clinic-vs-national success-rate bars (success_bars
// layout); then Locations and Doctors-at-clinic. Callers compute pct/natAvg
// from the parent's eggSource/ageGroup/isNewPatient context before calling.
export function getClinicTabs(opts: {
  pct: number | null;
  natAvg: number | null;
  contextLabel: string;
  reasons: string[];
  // Clinic year founded + about blurb - the Overview section of the first tab.
  yearFounded?: number | null;
  about?: string | null;
  // Matched-context volume shown under the success bars: cycles (exact, the CDC
  // denominator) and babies born for the SAME parent journey as the rates.
  matchedCycles?: number | null;
  matchedBabies?: number | null;
  locations: { address?: string | null; city?: string | null; state?: string | null }[];
  // The clinic's primary location, shown as the first matched-preference bubble.
  primaryLocationLabel?: string | null;
  // Published cost programs (parent-matched). One row per program - label is the
  // program/country name + total. Falls back to a consultation note when empty.
  costs?: CostInput[];
  // Accepted insurances (carrier names) -> the Insurance tab.
  insurances?: string[];
  // IVF parent-matching requirements -> the "Parents Matching Requirements" tab.
  matching?: {
    twinsAllowed?: boolean | null;
    transferFromOtherClinics?: boolean | null;
    maxAgeIp1?: number | null;
    maxAgeIp2?: number | null;
    biologicalConnection?: string | null;
    acceptingPatients?: string[] | null;
  } | null;
  // IVF surrogate-matching requirements -> the "Surrogate Matching Requirements"
  // tab, shown ONLY when showSurrogateMatching is true (parent seeks surrogacy).
  showSurrogateMatching?: boolean;
  surrogateMatching?: {
    minAge?: number | null;
    maxAge?: number | null;
    minBmi?: number | null;
    maxBmi?: number | null;
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
  } | null;
  // Mobile cards are shorter - cap the Locations/Doctors lists tighter so the
  // bubbles don't overflow up into the header.
  compact?: boolean;
  // CDC ART profile (from Provider.cdcServices / cdcExperience / cdcCycleStats).
  cdcServices?: Record<string, boolean> | null;
  cdcExperience?: Record<string, number> | null;
  cdcCycleStats?: Record<string, number> | null;
  // This parent's diagnoses (CDC labels) - the Clinic Experience tab pulls these
  // to the top and highlights them, so the parent sees the clinic's experience in
  // exactly what THEY are looking for.
  patientDiagnoses?: string[];
}): TabSection[] {
  const tabs: TabSection[] = [];

  // Services this clinic offers (CDC Services & Profiles) - chips.
  const SERVICE_CHIPS: { key: string; label: string }[] = [
    { key: "donorEgg", label: "Donor Eggs" },
    { key: "donatedEmbryo", label: "Donated Embryos" },
    { key: "eggCryo", label: "Egg Freezing" },
    { key: "embryoCryo", label: "Embryo Freezing" },
    { key: "gestationalCarrier", label: "Gestational Carrier" },
    { key: "singleWomen", label: "Single Women" },
    { key: "femaleCouple", label: "Female Couples" },
  ];

  // Tab 1 (Overview) - Founded year + the About description (plain text) below it.
  const overviewStats: TabItem[] = [];
  if (opts.yearFounded != null) overviewStats.push({ label: `Founded ${opts.yearFounded}`, value: "" });
  const tab1Groups: TabGroup[] = [];
  if (overviewStats.length > 0) tab1Groups.push({ title: "Overview", layoutType: "text", items: overviewStats });
  if (opts.about && opts.about.trim()) {
    const blurb = opts.about.trim().replace(/\s+/g, " ").slice(0, 300);
    tab1Groups.push({ title: "About", layoutType: "text", items: [{ label: blurb.length === 300 ? blurb + "…" : blurb, value: "" }] });
  }
  if (tab1Groups.length > 0) tabs.push({ layoutType: "sections", title: undefined, items: [], groups: tab1Groups });

  // Tab 2 - Services + Locations (each location chip carries its country flag).
  const serviceChipItems: TabItem[] = opts.cdcServices
    ? SERVICE_CHIPS.filter((s) => opts.cdcServices![s.key] === true).map((s) => ({ label: s.label, value: "" }))
    : [];
  const allClinicLocationLabels = dedupeProviderLocations(opts.locations || [])
    .map((l) => [l.city, l.state].filter(Boolean).join(", "))
    .filter((s) => s.trim() !== "");
  const tab2Groups: TabGroup[] = [];
  if (serviceChipItems.length > 0) tab2Groups.push({ title: "Services", layoutType: "standard_bubbles", items: serviceChipItems });
  if (allClinicLocationLabels.length > 0) {
    const LOC_CAP = opts.compact ? 3 : 5;
    const locItems: TabItem[] = allClinicLocationLabels.slice(0, LOC_CAP).map((l) => {
      const flag = getLocationFlag(l);
      return { label: flag ? `${flag} ${l}` : l, value: "" };
    });
    if (allClinicLocationLabels.length > LOC_CAP) locItems.push({ label: `+${allClinicLocationLabels.length - LOC_CAP} more`, value: "" });
    tab2Groups.push({ title: "Locations", layoutType: "standard_bubbles", items: locItems });
  }
  if (tab2Groups.length > 0) tabs.push({ layoutType: "sections", title: undefined, items: [], groups: tab2Groups });

  const bars: SuccessBar[] = [];
  if (opts.pct != null) bars.push({ label: "This clinic", value: opts.pct, isClinic: true });
  if (opts.natAvg != null && opts.natAvg > 0) bars.push({ label: "National average", value: opts.natAvg, isClinic: false });
  // "Matched to you": success rate + per-year cycles/babies for this journey.
  tabs.push(buildMatchedTab(opts.contextLabel, bars, opts.matchedCycles ?? null, opts.matchedBabies ?? null));

  // Clinic Experience: share of THIS clinic's IVF patients by diagnosis (CDC
  // "Reason for Using ART"). Personalized - the parent's own diagnoses are pulled
  // to the top and shown in the clinic color (isClinic:true), so they see the
  // clinic's experience in exactly what they're looking for; the clinic's next
  // strongest areas follow in the accent color.
  const exp = opts.cdcExperience;
  if (exp && Object.keys(exp).length > 0) {
    const patientDx = (opts.patientDiagnoses || []).filter((d) => d in exp);
    const matched = patientDx
      .map((d) => ({ label: d, value: Math.round(exp[d]), isClinic: true }))
      .sort((a, b) => b.value - a.value);
    const others = Object.entries(exp)
      .filter(([d, v]) => !patientDx.includes(d) && v >= 5 && !/other factor|unexplained/i.test(d))
      .map(([d, v]) => ({ label: d, value: Math.round(v), isClinic: false }))
      .sort((a, b) => b.value - a.value);
    const expBars = [...matched, ...others].slice(0, matched.length > 0 ? 5 : 4);
    if (expBars.length > 0) {
      tabs.push({
        layoutType: "success_bars",
        title: patientDx.length > 0 ? "Experience with your needs" : "Clinic Experience",
        subtitle: patientDx.length > 0
          ? "Share of this clinic's IVF patients with your diagnosis"
          : "What this clinic's patients most need help with",
        items: [],
        bars: expBars,
      });
    }
  }

  // Costs tab - mini program cards (flag, Program N, name, total) like the profile.
  tabs.push(buildCostsTab(opts.costs, opts.compact));

  // Parents Matching Requirements - the clinic's IVF program rules (mirrors the
  // agency card's matching tab).
  const m = opts.matching || {};
  const matchItems: TabItem[] = [];
  if (m.twinsAllowed != null) matchItems.push({ label: m.twinsAllowed ? "Twin pregnancies allowed" : "Singleton pregnancies only", value: "", icon: Baby });
  if (m.transferFromOtherClinics != null) matchItems.push({ label: m.transferFromOtherClinics ? "Accepts embryo transfers from other clinics" : "No outside embryo transfers", value: "", icon: Snowflake });
  if (m.maxAgeIp1 != null) matchItems.push({ label: `Max age (IP1): ${m.maxAgeIp1}`, value: "", icon: Calendar });
  if (m.maxAgeIp2 != null) matchItems.push({ label: `Max age (IP2): ${m.maxAgeIp2}`, value: "", icon: Calendar });
  if (m.biologicalConnection) {
    const bc = m.biologicalConnection === "at_least_one" ? "At least one biological parent required"
      : m.biologicalConnection === "at_least_two" ? "Both parents must be biologically connected"
      : m.biologicalConnection === "none" ? "No biological connection to embryos needed"
      : m.biologicalConnection;
    matchItems.push({ label: bc, value: "", icon: HeartHandshake });
  }
  const ACCEPT_LABELS: Record<string, string> = {
    single_woman: "Single women", single_man: "Single men", straight_couple: "Straight couples",
    straight_married_couple: "Married straight couples", gay_couple: "Gay couples", lesbian_couple: "Lesbian couples",
  };
  const accepting = (m.acceptingPatients || []).map((a) => ACCEPT_LABELS[a] || a).filter(Boolean);
  if (accepting.length > 0) matchItems.push({ label: `Accepts: ${accepting.join(", ")}`, value: "", icon: Users });
  if (matchItems.length > 0) tabs.push({ layoutType: "icon_list", title: "Parents Matching Requirements", items: matchItems });

  // Surrogate Matching Requirements - the clinic's rules for the surrogate they
  // accept. ONLY shown to parents who are seeking surrogacy (showSurrogateMatching).
  const sm = opts.surrogateMatching;
  if (opts.showSurrogateMatching && sm) {
    // Each threshold is its own chip so boundaries are unambiguous (the paired
    // "·" rows read as a run-on). Chips wrap and stay compact.
    const reqChips: TabItem[] = [];
    if (sm.minAge != null && sm.maxAge != null) reqChips.push({ label: `Age ${sm.minAge}-${sm.maxAge}`, value: "", icon: Calendar });
    if (sm.minBmi != null && sm.maxBmi != null) reqChips.push({ label: `BMI ${sm.minBmi}-${sm.maxBmi}`, value: "", icon: Scale });
    if (sm.maxDeliveries != null) reqChips.push({ label: `Up to ${sm.maxDeliveries} deliveries`, value: "", icon: Baby });
    if (sm.maxCSections != null) reqChips.push({ label: `Up to ${sm.maxCSections} C-sections`, value: "", icon: Scissors });
    if (sm.maxMiscarriages != null) reqChips.push({ label: `Up to ${sm.maxMiscarriages} miscarriages`, value: "", icon: Heart });
    if (sm.maxAbortions != null) reqChips.push({ label: `Up to ${sm.maxAbortions} abortions`, value: "", icon: Heart });
    if (sm.maxYearsFromLastPregnancy != null) reqChips.push({ label: `Within ${sm.maxYearsFromLastPregnancy} yrs of last pregnancy`, value: "", icon: Calendar });
    if (sm.monthsPostVaginal != null) reqChips.push({ label: `${sm.monthsPostVaginal}mo post-vaginal delivery`, value: "", icon: Calendar });

    // Accepted prior-health-history conditions as compact wrapping chips.
    const acceptedChips: TabItem[] = [];
    if (sm.covidVaccination) acceptedChips.push({ label: "COVID vaccinated", value: "", icon: ShieldCheck });
    if (sm.gdDiet) acceptedChips.push({ label: "Gestational diabetes (diet)", value: "", icon: ShieldCheck });
    if (sm.gdMedication) acceptedChips.push({ label: "Gestational diabetes (medication)", value: "", icon: ShieldCheck });
    if (sm.highBloodPressure) acceptedChips.push({ label: "High blood pressure", value: "", icon: ShieldCheck });
    if (sm.preeclampsia) acceptedChips.push({ label: "Preeclampsia", value: "", icon: ShieldCheck });
    if (sm.placentaPrevia) acceptedChips.push({ label: "Placenta previa", value: "", icon: ShieldCheck });

    if (reqChips.length > 0) tabs.push({ layoutType: "standard_bubbles", title: "Surrogate Matching Requirements", items: reqChips });
    // Accepted prior-health-history gets its own tab so neither list crowds the card.
    // The clinic's free-text "Health History Notes" renders beneath the chips.
    const note = (sm.healthHistoryNotes || "").trim();
    if (acceptedChips.length > 0 || note) {
      const acceptedGroups: TabGroup[] = [];
      if (acceptedChips.length > 0) acceptedGroups.push({ layoutType: "standard_bubbles", items: acceptedChips });
      if (note) acceptedGroups.push({ subtitle: "Notes", layoutType: "text", items: [{ label: note, value: "" }] });
      tabs.push({ layoutType: "sections", title: "Accepted Surrogate History Of", items: [], groups: acceptedGroups });
    }
  }

  // Insurance - the major insurances the clinic accepts (carrier chips).
  const insChips = Array.from(new Set((opts.insurances || []).filter((s) => s && s.trim() !== "")));
  if (insChips.length > 0) {
    const INS_CAP = opts.compact ? 6 : 10;
    const insItems: TabItem[] = insChips.slice(0, INS_CAP).map((s) => ({ label: s, value: "" }));
    if (insChips.length > INS_CAP) insItems.push({ label: `+${insChips.length - INS_CAP} more`, value: "" });
    tabs.push({ layoutType: "standard_bubbles", title: "Insurance accepted", items: insItems });
  }

  // How they practice (CDC cycle characteristics) - stats with a leading icon.
  const PRACTICE_ROWS: { key: string; label: string; icon: LucideIcon }[] = [
    { key: "pgtPct", label: "Genetic testing (PGT)", icon: Award },
    { key: "icsiPct", label: "ICSI", icon: Syringe },
    { key: "singleEmbryoPct", label: "Single-embryo transfers", icon: Baby },
    { key: "frozenPct", label: "Frozen-embryo transfers", icon: Snowflake },
    { key: "gestationalCarrierPct", label: "Gestational carrier", icon: HeartHandshake },
  ];
  const cyc = opts.cdcCycleStats;
  if (cyc) {
    const practiceItems: TabItem[] = PRACTICE_ROWS
      .filter((r) => typeof cyc[r.key] === "number")
      .map((r) => ({ label: r.label, value: `${Math.round(cyc[r.key])}%`, icon: r.icon }));
    if (practiceItems.length > 0) tabs.push({ layoutType: "icon_list", title: "How they practice", items: practiceItems });
  }

  // Each doctor now gets their own face tab (built in clinic-swipe-card), so the
  // old "Doctors at this clinic" list tab is gone.
  return tabs;
}

// One clinic a doctor practices at, with that clinic's success rate computed
// for the parent's profile (eggSource/ageGroup/isNewPatient). Mirrors the
// server's canonical enriched doctor shape (marketplaceDoctors / resolve_doctor_card).
export interface DoctorClinicData {
  providerId: string;
  providerName: string;
  providerLogoUrl?: string | null;
  location?: string | null;
  lgbtqCare?: boolean;
  successRate?: string | null; // "55%"
  successRateLabel?: string | null;
  nationalAverage?: string | null; // "48%"
  top10pct?: boolean;
  cycleCount?: number | null;
  successPct?: number | null; // 55
}

// Canonical enriched doctor shape consumed by the doctor SwipeDeckCard - the
// SAME object the server returns from marketplaceDoctors and resolve_doctor_card.
export interface DoctorCardData {
  slug: string;
  name: string;
  credential?: string | null;
  title?: string | null;
  bio?: string | null;
  photoUrl?: string | null;
  specialties?: string[];
  matchedSpecialties?: string[];
  languagesSpoken?: string[];
  boardCertifications?: string[];
  education?: string | string[] | null;
  yearsExperience?: number | null;
  providerGender?: string | null;
  npiTaxonomy?: string | null;
  offersVideoVisits?: boolean;
  acceptingNewPatients?: boolean;
  reviewCount?: number;
  recommendPct?: number | null;
  avgOverallScore?: number | null;
  clinics?: DoctorClinicData[];
  matchedReasons?: string[];
}

// Tabs for a Surrogacy Agency SwipeDeckCard - the SAME card shell the clinics
// use (cream cover + tabs), only the CONTENT differs. Built from the agency's
// SurrogacyAgencyProfile (babies born / time-to-match / families-per-coordinator),
// its screening practices, and locations. Used by BOTH the marketplace agency
// deck and the AI Concierge's agency match card so they render identically.
const AGENCY_SCREENING_LABELS: { key: string; label: string }[] = [
  { key: "criminalBackgroundCheck", label: "Criminal background check" },
  { key: "homeVisits", label: "Home visits" },
  { key: "financialsReview", label: "Financial review" },
  { key: "socialWorkerScreening", label: "Social worker screening" },
  { key: "medicalRecordsReview", label: "Medical records review" },
  { key: "surrogateInsuranceReview", label: "Insurance review" },
  { key: "psychologicalScreening", label: "Psychological screening" },
];

export function getAgencyTabs(opts: {
  reasons?: string[];
  about?: string | null;
  services?: string[];
  yearFounded?: number | null;
  numberOfBabiesBorn?: number | null;
  timeToMatch?: string | null;
  familiesPerCoordinator?: number | null;
  screening?: Record<string, boolean> | null;
  locations?: { address?: string | null; city?: string | null; state?: string | null }[];
  // Published cost programs (parent-matched). One row per program - label is the
  // program/country name, value is the formatted total. When empty, falls back
  // to a "shared on consultation" note so the tab is always present.
  costs?: CostInput[];
  // Parents Matching Requirements - the agency's surrogacy program rules.
  matching?: {
    twinsAllowed?: boolean | null;
    citizensNotAllowed?: string[] | null;
    stayAfterBirthMonths?: number | null;
    surrogateRemovableFromCert?: boolean | null;
    bothParentsOnBirthCert?: boolean | null;
  } | null;
  // Team members (leadership first) shown as chips, mirroring the clinic's
  // "Doctors at this clinic" tab. Names pair with the rotating face backgrounds.
  team?: { name: string; title?: string | null }[];
  // Mobile cards are shorter - cap the team/locations lists tighter.
  compact?: boolean;
}): TabSection[] {
  const tabs: TabSection[] = [];

  // "Matched to you" - the AI's reasons (chips). Only when present (matcher).
  const matched = (opts.reasons || []).filter((r) => r && r.trim() !== "").slice(0, 6);
  if (matched.length > 0) {
    tabs.push({
      layoutType: "matched_bubbles",
      title: "Matched to you",
      items: matched.map((r) => ({ label: r, value: "" })),
    });
  }

  // Overview (the first tab) - three stacked sections: Overview stats, the
  // services the agency offers, and where it operates (each location chip
  // carries its country flag). Rendered as one "sections" tab so all three
  // read as distinct groups instead of a single chip pile.
  const services = (opts.services || []).filter((s) => s && s.trim() !== "");
  const allLocationLabels = dedupeProviderLocations(opts.locations || [])
    .map((l) => [l.city, l.state].filter(Boolean).join(", "))
    .filter((s) => s.trim() !== "");
  const stats: TabItem[] = [];
  if (opts.yearFounded != null) stats.push({ label: `Founded ${opts.yearFounded}`, value: "" });
  if (opts.numberOfBabiesBorn != null) stats.push({ label: `${opts.numberOfBabiesBorn}+ babies born`, value: "" });
  if (opts.timeToMatch) stats.push({ label: `Match in ${opts.timeToMatch}`, value: "" });
  if (opts.familiesPerCoordinator != null) stats.push({ label: `${opts.familiesPerCoordinator} families / coordinator`, value: "" });
  // Tab 1 (Overview) - headline stats + the About description (plain text) below.
  const tab1Groups: TabGroup[] = [];
  if (stats.length > 0) tab1Groups.push({ title: "Overview", layoutType: "text", items: stats });
  if (opts.about && opts.about.trim()) {
    const blurb = opts.about.trim().replace(/\s+/g, " ").slice(0, 300);
    tab1Groups.push({ title: "About", layoutType: "text", items: [{ label: blurb.length === 300 ? blurb + "…" : blurb, value: "" }] });
  }
  if (tab1Groups.length > 0) tabs.push({ layoutType: "sections", title: undefined, items: [], groups: tab1Groups });

  // Tab 2 - Services + Locations (each location chip carries its country flag).
  const tab2Groups: TabGroup[] = [];
  if (services.length > 0) tab2Groups.push({ title: "Services", layoutType: "standard_bubbles", items: services.map((s) => ({ label: s, value: "" })) });
  if (allLocationLabels.length > 0) {
    const LOC_CAP = opts.compact ? 3 : 5;
    const locItems: TabItem[] = allLocationLabels.slice(0, LOC_CAP).map((l) => {
      const flag = getLocationFlag(l);
      return { label: flag ? `${flag} ${l}` : l, value: "" };
    });
    if (allLocationLabels.length > LOC_CAP) locItems.push({ label: `+${allLocationLabels.length - LOC_CAP} more`, value: "" });
    tab2Groups.push({ title: "Locations", layoutType: "standard_bubbles", items: locItems });
  }
  if (tab2Groups.length > 0) tabs.push({ layoutType: "sections", title: undefined, items: [], groups: tab2Groups });

  // Costs - mini program cards (flag, Program N, name, total) like the profile.
  tabs.push(buildCostsTab(opts.costs, opts.compact));

  // Parents Matching Requirements - the agency's surrogacy program rules that
  // determine which intended parents they accept.
  const m = opts.matching || {};
  const matchItems: TabItem[] = [];
  if (m.twinsAllowed != null) {
    matchItems.push({ label: m.twinsAllowed ? "Twin pregnancies allowed" : "Singleton pregnancies only", value: "", icon: Baby });
  }
  const restricted = (m.citizensNotAllowed || []).filter((c) => c && c.trim() !== "");
  if (restricted.length > 0) {
    // Same label the provider profile uses for this field ("Citizens not allowed").
    matchItems.push({ label: `Citizens not allowed: ${restricted.join(", ")}`, value: "", icon: Globe });
  } else if (m.citizensNotAllowed != null) {
    matchItems.push({ label: "Serves parents of all nationalities", value: "", icon: Globe });
  }
  if (m.stayAfterBirthMonths != null) {
    matchItems.push({ label: m.stayAfterBirthMonths > 0 ? `Stay ~${m.stayAfterBirthMonths} mo after birth` : "No stay required after birth", value: "", icon: Calendar });
  }
  if (m.bothParentsOnBirthCert != null) {
    matchItems.push({ label: m.bothParentsOnBirthCert ? "Both parents on birth certificate" : "Birth certificate rules vary", value: "", icon: FileText });
  }
  if (m.surrogateRemovableFromCert != null) {
    matchItems.push({ label: m.surrogateRemovableFromCert ? "Surrogate removable from certificate" : "Surrogate stays on certificate", value: "", icon: ShieldCheck });
  }
  if (matchItems.length > 0) tabs.push({ layoutType: "icon_list", title: "Parents Matching Requirements", items: matchItems });

  // Screening - what the agency screens surrogates for (only the enabled ones).
  const screening = opts.screening || {};
  const screeningItems: TabItem[] = AGENCY_SCREENING_LABELS
    .filter((s) => screening[s.key])
    .map((s) => ({ label: s.label, value: "" }));
  if (screeningItems.length > 0) tabs.push({ layoutType: "standard_bubbles", title: "Surrogate Screening", items: screeningItems });

  // Our Team - leadership-first member names (paired with the rotating faces).
  const seenTeam = new Set<string>();
  const teamNames = (opts.team || [])
    .map((t) => (t.name || "").trim())
    .filter(Boolean)
    .filter((name) => {
      const key = name.toLowerCase().replace(/^(dr\.?|prof\.?)\s+/i, "").replace(/[.,]/g, "").trim();
      if (seenTeam.has(key)) return false;
      seenTeam.add(key);
      return true;
    });
  if (teamNames.length > 0) {
    const TEAM_CAP = opts.compact ? 4 : 6;
    const teamItems: TabItem[] = teamNames.slice(0, TEAM_CAP).map((name) => ({ label: name, value: "" }));
    if (teamNames.length > TEAM_CAP) teamItems.push({ label: `+${teamNames.length - TEAM_CAP} more`, value: "" });
    tabs.push({ layoutType: "standard_bubbles", title: "Our Team", items: teamItems });
  }

  // Always render at least one tab so the card body is never blank.
  if (tabs.length === 0) {
    tabs.push({ layoutType: "standard_bubbles", title: "Overview", items: [{ label: "Surrogacy Agency", value: "" }] });
  }

  return tabs;
}

// Parse a "55%" string to the number 55 (null if absent / unparseable).
function pctNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const n = parseInt(String(v).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

// Tabs for a doctor SwipeDeckCard. SAME card shell + design as the clinic card's
// doctor-face tabs (face hero, name + clinic logo/location/badge pinned header);
// only the CONTENT differs. First tab "Matched to you" is the default, then the
// doctor's clinic + that clinic's success rate, specialties, credentials,
// languages & visits, and (when present) verified reviews.
export function getDoctorTabs(
  doctor: DoctorCardData,
  opts: { reasons?: string[]; contextLabel?: string | null; compact?: boolean; costs?: CostInput[] } = {},
): TabSection[] {
  const tabs: TabSection[] = [];
  const clinics = doctor.clinics || [];
  const primary = clinics[0] || null;
  const contextLabel = opts.contextLabel || primary?.successRateLabel || undefined;

  // 1) Overview (first tab) - kept SHORT so the face stays visible (like the
  // egg-donor / surrogate first card). Condensed to a single icon_list (no
  // "Works at" / "Locations" / "Languages" headers): each clinic is a Building2
  // row, each location a MapPin row, each language a Globe row. Reads in far
  // less vertical space than the old titled-bubble sections. The bio (the tall
  // block) lives on its own "About" tab below.
  const overviewItems: TabItem[] = [];
  const seenClinics = new Set<string>();
  clinics
    .map((c) => (c.providerName || "").trim())
    .filter(Boolean)
    .filter((n) => { const k = n.toLowerCase(); if (seenClinics.has(k)) return false; seenClinics.add(k); return true; })
    .forEach((n) => overviewItems.push({ label: n, value: "", icon: Building2 }));
  const seenLoc = new Set<string>();
  clinics
    .map((c) => (c.location || "").trim())
    .filter(Boolean)
    .filter((l) => { const k = l.toLowerCase(); if (seenLoc.has(k)) return false; seenLoc.add(k); return true; })
    .forEach((l) => { const flag = getLocationFlag(l); overviewItems.push({ label: flag ? `${flag} ${l}` : l, value: "", icon: MapPin }); });
  const langs = (doctor.languagesSpoken || []).filter(Boolean);
  langs.forEach((l) => overviewItems.push({ label: String(l), value: "", icon: Globe }));
  if (overviewItems.length > 0) tabs.push({ layoutType: "icon_list", items: overviewItems });

  // 1b) About - the bio on its OWN tab (it's the tall block that would otherwise
  // cover the doctor's face on the first tab).
  if (doctor.bio && doctor.bio.trim()) {
    // Plain text on its own tab (not a bubble), same as the clinic About tab.
    const blurb = doctor.bio.trim().replace(/\s+/g, " ").slice(0, 300);
    tabs.push({ layoutType: "sections", items: [], groups: [{ title: "About", layoutType: "text", items: [{ label: blurb.length === 300 ? blurb + "…" : blurb, value: "" }] }] });
  }

  // 2) Credentials - board certs, role, experience, education, NPI, + visits
  // (moved here from the eliminated "Languages & visits" tab).
  const cred: TabItem[] = [];
  for (const bc of (doctor.boardCertifications || []).filter(Boolean).slice(0, 3)) {
    cred.push({ label: `Board Certified: ${String(bc)}`, value: "", icon: Award });
  }
  if (doctor.title) cred.push({ label: String(doctor.title), value: "", icon: Briefcase });
  if (doctor.yearsExperience) cred.push({ label: `${doctor.yearsExperience} years experience`, value: "", icon: Briefcase });
  const eduStr = Array.isArray(doctor.education)
    ? doctor.education.filter(Boolean).join(", ")
    : doctor.education;
  if (eduStr) cred.push({ label: String(eduStr), value: "", icon: GraduationCap });
  if (doctor.npiTaxonomy) cred.push({ label: String(doctor.npiTaxonomy), value: "", icon: Stethoscope });
  if (doctor.offersVideoVisits) cred.push({ label: "Video visits available", value: "", icon: Video });
  if (doctor.acceptingNewPatients) cred.push({ label: "Accepting new patients", value: "", icon: UserCheck });
  if (cred.length > 0) tabs.push({ layoutType: "icon_list", title: "Credentials", items: cred });

  // 3) Matched to you - success rate + per-year cycles/babies (this doctor's
  // primary clinic), using the SAME 2-section tab as the clinic card.
  const bars: SuccessBar[] = [];
  let mCycles: number | null = null;
  let mBabies: number | null = null;
  if (primary) {
    const pct = primary.successPct ?? pctNum(primary.successRate);
    const nat = pctNum(primary.nationalAverage);
    if (pct != null) bars.push({ label: "This clinic", value: pct, isClinic: true });
    if (nat != null && nat > 0) bars.push({ label: "National average", value: nat, isClinic: false });
    if (primary.cycleCount != null && primary.cycleCount > 0) {
      mCycles = primary.cycleCount;
      if (pct != null) mBabies = Math.round((pct / 100) * primary.cycleCount);
    }
  }
  tabs.push(buildMatchedTab(contextLabel, bars, mCycles, mBabies));

  // 3b) Costs - the doctor's clinic cost programs as mini program cards (profile-style).
  if (opts.costs && opts.costs.length > 0) tabs.push(buildCostsTab(opts.costs, opts.compact));

  // 4) Specialties - the doctor's full focus areas (key differentiator).
  const specialties = (doctor.specialties || []).filter(Boolean);
  if (specialties.length > 0) {
    const SPEC_CAP = opts.compact ? 6 : 10;
    const items: TabItem[] = specialties.slice(0, SPEC_CAP).map((s) => ({ label: s, value: "" }));
    if (specialties.length > SPEC_CAP) items.push({ label: `+${specialties.length - SPEC_CAP} more`, value: "" });
    tabs.push({ layoutType: "standard_bubbles", title: "Specialties", items });
  }

  // 5) Reviews - only when this doctor has verified reviews.
  if ((doctor.reviewCount || 0) > 0) {
    const rev: TabItem[] = [];
    if (doctor.recommendPct != null) rev.push({ label: `${doctor.recommendPct}% would recommend`, value: "", icon: ThumbsUp });
    if (doctor.avgOverallScore != null) rev.push({ label: `${Number(doctor.avgOverallScore).toFixed(1)}/10 overall`, value: "", icon: Star });
    rev.push({ label: `${doctor.reviewCount} verified review${doctor.reviewCount !== 1 ? "s" : ""}`, value: "", icon: Award });
    tabs.push({ layoutType: "icon_list", title: "Reviews", items: rev });
  }

  return tabs;
}

// Build the shared SwipeDeckCard inputs for a doctor, so the AI matcher
// (DoctorMatchCard) and the marketplace Doctors deck/grid render IDENTICALLY
// without duplicating the prop assembly. The doctor's face is the hero on every
// slide; photoLabels maps it to the doctor's name so the pinned header shows the
// name at 18px (same look as the clinic card's doctor-face tabs).
export function buildDoctorCardProps(
  doctor: DoctorCardData,
  opts: { contextLabel?: string | null; compact?: boolean; reasons?: string[]; costs?: CostInput[] } = {},
): {
  photos: string[];
  photoLabels: Record<string, string>;
  logoSrc: string | null;
  primary: DoctorClinicData | null;
  successBadge: string | null;
  tabs: TabSection[];
  // The pinned-header sub-line: the doctor's primary clinic NAME + city, so the
  // clinic is identified on every tab (the logo alone is not recognizable).
  headerLocation: string | null;
  // When the doctor has NO photo, render the clinic-style cream COVER as the
  // first slide (dark text, centered) instead of a face hero - identical to the
  // clinic card's first tab.
  firstSlidePlain: boolean;
} {
  const primary = doctor.clinics?.[0] || null;
  const photoSrc = doctor.photoUrl ? getPhotoSrc(doctor.photoUrl) : null;
  const photos = photoSrc ? [photoSrc] : [];
  const photoLabels: Record<string, string> = {};
  if (photoSrc) photoLabels[photoSrc] = doctor.name;
  // No clinic logo in the doctor header - the clinic is shown in the "Works at"
  // section of the Overview tab instead.
  const logoSrc = null;
  const successBadge = primary?.top10pct ? "Top 10%" : null;
  const tabs = getDoctorTabs(doctor, { reasons: opts.reasons, contextLabel: opts.contextLabel, compact: opts.compact, costs: opts.costs });
  // The clinic name lives in the first tab's "Works at" section now, so the
  // header shows only the centered doctor name (+ clinic logo), no sub-line.
  const headerLocation = null;
  // The doctor's photo is the hero from the first slide (the Overview sections
  // render over it in white). Only fall back to the cream cover when there's no
  // photo at all. The face name is centered in the overlay header.
  return { photos, photoLabels, logoSrc, primary, successBadge, tabs, headerLocation, firstSlidePlain: photos.length === 0 };
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
  return formatMoneyDollars(Number(v));
}

function isNonEmptyStr(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim() !== "";
}

export function buildSidebarSections(profile: SwipeDeckProfile, isSpermDonor = false): SidebarSection[] {
  const sections: SidebarSection[] = [];
  const isSurrogate = profile.providerType === "surrogate";

  // Overview
  const overview: SidebarRow[] = [];
  if (profile.age != null) overview.push({ label: "Age", value: String(profile.age) });
  if (isNonEmptyStr(profile.location)) overview.push({ label: "Location", value: formatLocationDisplay(profile.location)! });
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
  } else if (isSpermDonor) {
    // Show all matching vial cost programs from the cost sheet
    if (profile.vialCosts?.length > 0) {
      for (const vc of profile.vialCosts) {
        costs.push({ label: vc.label, value: fmtCurrency(vc.cost) });
      }
    } else if (profile.totalCost != null) {
      costs.push({ label: "Vial Cost", value: fmtCurrency(profile.totalCost) });
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
