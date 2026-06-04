/**
 * Cost-sheet subtype matcher.
 *
 * Pure module. Given a parent's account state (gender + partnerGender from
 * the primary User, plus IntendedParentProfile journey flags), returns the
 * list of cost-sheet subtypes that apply to them.
 *
 * Used by:
 *   - Parent profile page: filter clinic's APPROVED programs to the ones
 *     the current parent qualifies for.
 *   - Phase 2 auto-draft: pick a sheet for Eva when a booking is created.
 *   - Provider editor (admin view): preview which parents a given sheet
 *     would match.
 *
 * When any input is null/unknown, the matcher returns the *union* of every
 * subtype consistent with what IS known. The parent UI shows a "complete
 * your profile to narrow these down" banner in that case. We err toward
 * showing more cards (false positives) rather than hiding cards that the
 * parent might actually want (false negatives).
 */

import { SubType } from "./cost-templates-config";

// Input shape - intentionally minimal so callers can pass a slim payload
// without dragging the full Prisma types through the function signature.
export interface MatcherInput {
  // From User (the primary account holder)
  userGender: string | null | undefined;          // 'male' | 'female' | null
  partnerGender: string | null | undefined;       // 'male' | 'female' | null

  // From IntendedParentProfile
  hasEmbryos: boolean | null | undefined;
  // Source values are the controlled tokens Eva captures during onboarding:
  //   eggSource:   'own' | 'donor' | 'partner' | null
  //   spermSource: 'own' | 'donor' | 'partner' | null
  //   carrier:     'self' | 'partner' | 'surrogate' | null
  eggSource: string | null | undefined;
  spermSource: string | null | undefined;
  carrier: string | null | undefined;
  // True when the parent has gametes (eggs OR sperm) to ship in. Either
  // an explicit profile flag (future) or derived from `eggSource === "own"`
  // / `spermSource === "own"` plus journey context.
  shippingEggs?: boolean | null;
  shippingSperm?: boolean | null;

  // Optional explicit interest filter (egg freezing only shows if the
  // parent flagged it during onboarding, to avoid cluttering the grid).
  interestedServices?: string[] | null;
}

export interface MatchResult {
  subtypes: SubType[];
  // True when one or more relevant fields were null/undefined, so the
  // result is the union of possibilities rather than a single concrete
  // match. UI uses this to show the "complete your profile" banner.
  isPartialProfile: boolean;
}

// -------------------------------------------------------------------------
// Derived household traits
// -------------------------------------------------------------------------

interface Household {
  hasOvaries: boolean;       // anyone in the household has ovaries
  hasUterus: boolean;        // anyone has a uterus (same as ovaries for now)
  hasSperm: boolean;         // anyone has sperm
  isTwoMoms: boolean;        // both partners female
  isSolo: boolean;           // single parent (no partner)
  genderKnown: boolean;
}

function normalizeGender(g: string | null | undefined): "male" | "female" | null {
  if (!g) return null;
  // Accept: "male"/"female"/"m"/"f", "man"/"woman" (partnerGender wire format),
  // and the User.gender legacy form "I'm a man" / "I'm a woman" that the
  // existing onboarding question persists.
  const lower = g.toLowerCase().trim();
  if (lower === "male" || lower === "m" || lower === "man" || lower === "i'm a man" || lower.endsWith(" man")) return "male";
  if (lower === "female" || lower === "f" || lower === "woman" || lower === "i'm a woman" || lower.endsWith(" woman")) return "female";
  return null;
}

function deriveHousehold(input: MatcherInput): Household {
  const user = normalizeGender(input.userGender);
  const partner = normalizeGender(input.partnerGender);
  const isSolo = !partner;

  // For matching, "has ovaries" === "has uterus" (we don't model trans or
  // surgical history separately yet). hasSperm just means there's a male
  // in the household. When gender is null we assume both possibilities
  // are open (drives partial-profile flag).
  const hasOvaries = user === "female" || partner === "female";
  const hasUterus = hasOvaries;
  const hasSperm = user === "male" || partner === "male";
  const isTwoMoms = user === "female" && partner === "female";
  const genderKnown = !!user;

  return { hasOvaries, hasUterus, hasSperm, isTwoMoms, isSolo, genderKnown };
}

// -------------------------------------------------------------------------
// Eligibility checks per subtype
//
// Each returns true if the subtype IS or MIGHT BE applicable to the parent.
// "Might be" means a relevant input was null/unknown and we can't rule it
// out yet. Callers cumulate isPartialProfile separately based on which
// inputs were null and actually affected the result.
// -------------------------------------------------------------------------

function eqOrUnknown<T>(value: T | null | undefined, expected: T): boolean {
  return value == null || value === expected;
}

function notEqOrUnknown<T>(value: T | null | undefined, expected: T): boolean {
  return value == null || value !== expected;
}

/**
 * Eva's intake stores eggSource / spermSource / carrier as natural-language
 * strings ("Own eggs", "Egg donor", "Partner eggs", "My sperm", "Sperm donor",
 * "Self", "Self carrying", "Gestational surrogate", "Partner/Spouse").
 * Normalize them to the short canonical tokens this matcher checks against,
 * so equality comparisons work regardless of how Eva phrased the answer.
 */
function normEgg(v: string | null | undefined): "own" | "donor" | "partner" | null {
  if (!v) return null;
  const lower = v.toLowerCase().trim();
  if (lower.includes("own")) return "own";
  if (lower.includes("partner")) return "partner";
  if (lower.includes("donor")) return "donor";
  return null;
}

function normSperm(v: string | null | undefined): "own" | "donor" | "partner" | null {
  if (!v) return null;
  const lower = v.toLowerCase().trim();
  if (lower.includes("my sperm") || lower.startsWith("own")) return "own";
  if (lower.includes("partner") || lower.includes("spouse")) return "partner";
  if (lower.includes("donor")) return "donor";
  return null;
}

function normCarrier(v: string | null | undefined): "self" | "partner" | "surrogate" | null {
  if (!v) return null;
  const lower = v.toLowerCase().trim();
  if (lower.includes("self") || lower === "carry myself" || lower === "i'll carry") return "self";
  if (lower.includes("partner")) return "partner";
  if (lower.includes("surrogate") || lower.includes("gestational")) return "surrogate";
  return null;
}

export function matchSubtypes(rawInput: MatcherInput): MatchResult {
  // Normalize Eva's free-text values into the canonical tokens the rest of
  // this function works with. Without this, real parents whose profile
  // says "Own eggs" / "Egg donor" / "Gestational surrogate" silently fail
  // every equality check and the matcher returns no subtypes.
  const input: MatcherInput = {
    ...rawInput,
    eggSource: normEgg(rawInput.eggSource),
    spermSource: normSperm(rawInput.spermSource),
    carrier: normCarrier(rawInput.carrier),
  };
  const h = deriveHousehold(input);
  const subtypes: SubType[] = [];

  // hasEmbryos drives the big fork: shipping vs creating.
  // null means "could be either".
  const couldNeedToCreate = input.hasEmbryos !== true;   // null or false
  const couldHaveEmbryos = input.hasEmbryos !== false;   // null or true

  // -------- IVF Cycle (creating embryos) --------
  if (couldNeedToCreate) {
    // own eggs, own carry
    if (
      h.hasOvaries &&
      h.hasUterus &&
      eqOrUnknown(input.eggSource, "own") &&
      eqOrUnknown(input.carrier, "self")
    ) {
      subtypes.push("ivf_cycle_own_eggs_own_carry");
    }
    // own eggs, surrogate carry
    if (
      h.hasOvaries &&
      eqOrUnknown(input.eggSource, "own") &&
      eqOrUnknown(input.carrier, "surrogate")
    ) {
      subtypes.push("ivf_cycle_own_eggs_surrogate_carry");
    }
    // donor eggs, own carry
    if (
      h.hasUterus &&
      eqOrUnknown(input.eggSource, "donor") &&
      eqOrUnknown(input.carrier, "self")
    ) {
      subtypes.push("ivf_cycle_donor_eggs_own_carry");
    }
    // donor eggs, surrogate carry
    if (
      eqOrUnknown(input.eggSource, "donor") &&
      eqOrUnknown(input.carrier, "surrogate")
    ) {
      subtypes.push("ivf_cycle_donor_eggs_surrogate_carry");
    }
    // Reciprocal: 2 moms only, own eggs, partner carries
    if (
      h.isTwoMoms &&
      eqOrUnknown(input.eggSource, "own") &&
      eqOrUnknown(input.carrier, "partner")
    ) {
      subtypes.push("ivf_cycle_reciprocal");
    }
  }

  // -------- Embryo Creation Only (create + freeze, no transfer) --------
  // Surfaces alongside IVF Cycle for parents who need to create embryos.
  // Parents pick based on whether they want to transfer now (IVF Cycle) or
  // freeze for later (Embryo Creation Only). Same biological prerequisites
  // as the IVF Cycle creation subtypes - just no transfer step.
  if (couldNeedToCreate) {
    if (h.hasOvaries && eqOrUnknown(input.eggSource, "own")) {
      subtypes.push("embryo_creation_only_own_eggs");
    }
    if (eqOrUnknown(input.eggSource, "donor")) {
      subtypes.push("embryo_creation_only_donor_eggs");
    }
  }

  // -------- Frozen Embryo Transfer (FET) - in-house embryos --------
  // Distinct from Shipping Embryos: these are programs for embryos that are
  // ALREADY at this clinic (created in a prior cycle or moved here long ago,
  // not shipped in fresh). User direction: show to anyone with hasEmbryos
  // alongside Shipping - parents pick based on which describes their
  // situation.
  if (couldHaveEmbryos) {
    if (h.hasUterus && eqOrUnknown(input.carrier, "self")) {
      subtypes.push("fet_to_self");
    }
    if (eqOrUnknown(input.carrier, "surrogate")) {
      subtypes.push("fet_to_surrogate");
    }
  }

  // -------- Shipping Embryos (parent already has embryos elsewhere) --------
  if (couldHaveEmbryos) {
    if (h.hasUterus && eqOrUnknown(input.carrier, "self")) {
      subtypes.push("shipping_embryos_to_self");
    }
    if (eqOrUnknown(input.carrier, "surrogate")) {
      subtypes.push("shipping_embryos_to_surrogate");
    }
  }

  // -------- Shipping Eggs + Sperm (parent ships gametes, not embryos) --------
  // Only show when the parent has explicitly indicated they have gametes
  // to ship. When the flags are null we don't know - skip rather than
  // pollute the result with a hypothetical category. (Differs from the
  // other subtypes, which default to "show" when unknown.)
  const isShippingGametes = input.shippingEggs === true || input.shippingSperm === true;
  if (isShippingGametes && couldNeedToCreate) {
    if (h.hasUterus && eqOrUnknown(input.carrier, "self")) {
      subtypes.push("shipping_eggs_sperm_to_self");
    }
    if (eqOrUnknown(input.carrier, "surrogate")) {
      subtypes.push("shipping_eggs_sperm_to_surrogate");
    }
  }

  // -------- Egg Freezing --------
  // Confirmed scope: Solo Woman / 2 moms / straight couple qualify. Solo Man
  // / 2 dads do not. We also gate by explicit interest when the field is
  // populated, to avoid cluttering the grid with a service the parent isn't
  // asking about - but if interestedServices is null/empty (early in
  // onboarding) we still surface it for the eligible 3 family types.
  if (h.hasOvaries) {
    const interests = input.interestedServices;
    const explicitlyInterested =
      Array.isArray(interests) && interests.includes("egg_freezing");
    const noInterestSignalYet = !interests || interests.length === 0;
    if (explicitlyInterested || noInterestSignalYet) {
      subtypes.push("egg_freezing_retrieval_storage");
    }
  }

  // -------- Non-IVF leaves (surrogacy / egg donor / sperm donor) --------
  // These leaves live on agency / bank cost programs. A program's
  // subTypes[] can carry any combination (e.g. surrogacy + egg_donor_fresh
  // for a combined-package program). We return every leaf the parent could
  // plausibly need so the auto-draft matcher can intersect with the
  // provider's programs via hasSome.
  //
  // Conservative defaults: when a relevant signal is unknown, include the
  // leaf (false positive in matching is recoverable; false negative means
  // a relevant agency program is silently skipped).

  // Surrogacy: anyone whose carrier is (or could be) "surrogate".
  if (eqOrUnknown(input.carrier, "surrogate")) {
    subtypes.push("surrogacy");
  }

  // Egg donor: anyone whose eggSource is (or could be) "donor".
  // We don't yet distinguish fresh vs frozen at the profile level, so we
  // include BOTH leaves - the provider's program chooses which fits.
  if (eqOrUnknown(input.eggSource, "donor")) {
    subtypes.push("egg_donor_fresh");
    subtypes.push("egg_donor_frozen");
  }

  // Sperm donor: anyone whose spermSource is (or could be) "donor".
  if (eqOrUnknown(input.spermSource, "donor")) {
    subtypes.push("sperm_donor");
  }

  // -------- Partial-profile detection --------
  // We mark partial when a *relevant* field was null AND that nullness
  // actually influenced the result (i.e. expanded the set). Conservative
  // version: any null in the core fields counts as partial.
  const isPartialProfile =
    input.hasEmbryos == null ||
    input.eggSource == null ||
    input.carrier == null ||
    !h.genderKnown;

  return { subtypes, isPartialProfile };
}

// -------------------------------------------------------------------------
// Reverse direction: given a subtype + an input, does the parent qualify?
// Used by the provider-side "preview matches" admin tool.
// -------------------------------------------------------------------------

export function parentQualifiesForSubtype(
  input: MatcherInput,
  subtype: SubType,
): boolean {
  return matchSubtypes(input).subtypes.includes(subtype);
}

// -------------------------------------------------------------------------
// Family-type helpers - keep the onboarding-question vocabulary in sync
// with the gender / partnerGender fields.
// -------------------------------------------------------------------------

export type FamilyType =
  | "solo_man"
  | "solo_woman"
  | "two_dads"
  | "two_moms"
  | "straight_couple";

export function genderFieldsFromFamilyType(
  ft: FamilyType,
  // Straight-couple needs to know which side the signing-up user is on.
  // Defaults to "female" because most fertility-journey signups are women.
  primaryGenderForStraight: "male" | "female" = "female",
): { gender: "male" | "female"; partnerGender: "male" | "female" | null } {
  switch (ft) {
    case "solo_man":
      return { gender: "male", partnerGender: null };
    case "solo_woman":
      return { gender: "female", partnerGender: null };
    case "two_dads":
      return { gender: "male", partnerGender: "male" };
    case "two_moms":
      return { gender: "female", partnerGender: "female" };
    case "straight_couple":
      return {
        gender: primaryGenderForStraight,
        partnerGender: primaryGenderForStraight === "female" ? "male" : "female",
      };
  }
}

export function familyTypeFromGenderFields(
  gender: string | null | undefined,
  partnerGender: string | null | undefined,
): FamilyType | null {
  const g = normalizeGender(gender);
  const p = normalizeGender(partnerGender);
  if (!g) return null;
  if (!p) {
    return g === "male" ? "solo_man" : "solo_woman";
  }
  if (g === "male" && p === "male") return "two_dads";
  if (g === "female" && p === "female") return "two_moms";
  return "straight_couple";
}
