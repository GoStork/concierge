/**
 * Exhaustive verification of the subtype matcher against every family
 * type x biology x embryo state combination. Runs deterministically and
 * exits non-zero on any mismatch so we can spot matcher regressions.
 *
 * Run: npx tsx scripts/verify-subtype-matcher.ts
 */

import {
  matchSubtypes,
  type MatcherInput,
} from "../server/src/modules/costs/cost-sheet-subtype-matcher";
import {
  ALL_SUBTYPES,
  type SubType,
} from "../server/src/modules/costs/cost-templates-config";

type FamilyType = "solo_man" | "solo_woman" | "two_dads" | "two_moms" | "straight_couple";

const FAMILY_GENDERS: Record<FamilyType, { gender: string; partnerGender: string | null }> = {
  solo_man:        { gender: "I'm a man",   partnerGender: null },
  solo_woman:      { gender: "I'm a woman", partnerGender: null },
  two_dads:        { gender: "I'm a man",   partnerGender: "man" },
  two_moms:        { gender: "I'm a woman", partnerGender: "woman" },
  straight_couple: { gender: "I'm a woman", partnerGender: "man" },
};

// Derived household traits per family type (what should always be true).
const TRAITS: Record<FamilyType, { hasOvaries: boolean; hasUterus: boolean; hasSperm: boolean; isTwoMoms: boolean }> = {
  solo_man:        { hasOvaries: false, hasUterus: false, hasSperm: true,  isTwoMoms: false },
  solo_woman:      { hasOvaries: true,  hasUterus: true,  hasSperm: false, isTwoMoms: false },
  two_dads:        { hasOvaries: false, hasUterus: false, hasSperm: true,  isTwoMoms: false },
  two_moms:        { hasOvaries: true,  hasUterus: true,  hasSperm: false, isTwoMoms: true  },
  straight_couple: { hasOvaries: true,  hasUterus: true,  hasSperm: true,  isTwoMoms: false },
};

// -------------------------------------------------------------------------
// Truth table: which subtypes SHOULD match for a given (family, ip-state)?
// Derived from the product requirements, NOT from the matcher code, so we
// can detect drift between rules and implementation.
// -------------------------------------------------------------------------

interface Scenario {
  label: string;
  hasEmbryos: boolean;
  eggSource: "own" | "donor";
  spermSource: "own" | "donor";
  carrier: "self" | "partner" | "surrogate";
  shippingEggs?: boolean;
  shippingSperm?: boolean;
  interestedServices?: string[];
}

function expectedSubtypes(family: FamilyType, s: Scenario): Set<SubType> {
  const t = TRAITS[family];
  const out = new Set<SubType>();

  // ---- IVF Cycle (no embryos yet) ----
  if (!s.hasEmbryos) {
    if (t.hasOvaries && t.hasUterus && s.eggSource === "own" && s.carrier === "self") {
      out.add("ivf_cycle_own_eggs_own_carry");
    }
    if (t.hasOvaries && s.eggSource === "own" && s.carrier === "surrogate") {
      out.add("ivf_cycle_own_eggs_surrogate_carry");
    }
    if (t.hasUterus && s.eggSource === "donor" && s.carrier === "self") {
      out.add("ivf_cycle_donor_eggs_own_carry");
    }
    if (s.eggSource === "donor" && s.carrier === "surrogate") {
      out.add("ivf_cycle_donor_eggs_surrogate_carry");
    }
    if (t.isTwoMoms && s.eggSource === "own" && s.carrier === "partner") {
      out.add("ivf_cycle_reciprocal");
    }

    // ---- Embryo Creation Only (parent freezes, no transfer) ----
    if (t.hasOvaries && s.eggSource === "own") out.add("embryo_creation_only_own_eggs");
    if (s.eggSource === "donor") out.add("embryo_creation_only_donor_eggs");
  }

  // ---- FET (in-house embryos) - parent already has embryos ----
  if (s.hasEmbryos) {
    if (t.hasUterus && s.carrier === "self") out.add("fet_to_self");
    if (s.carrier === "surrogate") out.add("fet_to_surrogate");

    // ---- Shipping Embryos (embryos elsewhere) ----
    if (t.hasUterus && s.carrier === "self") out.add("shipping_embryos_to_self");
    if (s.carrier === "surrogate") out.add("shipping_embryos_to_surrogate");
  }

  // ---- Shipping Eggs+Sperm (only when explicitly shipping gametes) ----
  if (!s.hasEmbryos && (s.shippingEggs || s.shippingSperm)) {
    if (t.hasUterus && s.carrier === "self") out.add("shipping_eggs_sperm_to_self");
    if (s.carrier === "surrogate") out.add("shipping_eggs_sperm_to_surrogate");
  }

  // ---- Agency leaves (surrogacy / egg donor / sperm donor) ----
  // Surrogacy applies whenever the carrier is a surrogate - embryos still
  // need a carrier. Gamete leaves (egg/sperm donor) only apply while the
  // parent still needs to CREATE embryos; hasEmbryos=true means the donor
  // stage is behind them (eggSource then records history, not a need).
  if (s.carrier === "surrogate") out.add("surrogacy");
  if (!s.hasEmbryos && s.eggSource === "donor") {
    out.add("egg_donor_fresh");
    out.add("egg_donor_frozen");
  }
  if (!s.hasEmbryos && s.spermSource === "donor") out.add("sperm_donor");

  // ---- Egg Freezing ----
  // Eligible when the parent has ovaries. Gated by interested-services
  // when that field is populated; surfaces by default for early profiles.
  if (t.hasOvaries) {
    const interests = s.interestedServices;
    const explicit = Array.isArray(interests) && interests.includes("egg_freezing");
    const noSignalYet = !interests || interests.length === 0;
    if (explicit || noSignalYet) {
      out.add("egg_freezing_retrieval_storage");
    }
  }

  return out;
}

// -------------------------------------------------------------------------
// Build the test grid: 5 family types x a representative set of scenarios.
// -------------------------------------------------------------------------

function scenariosFor(family: FamilyType): Scenario[] {
  const t = TRAITS[family];
  const scenarios: Scenario[] = [];

  // Carry options for this family. "self" requires a uterus; "partner" is
  // reciprocal-only (2 moms); "surrogate" is always valid.
  const carriers: Array<"self" | "partner" | "surrogate"> = [];
  if (t.hasUterus) carriers.push("self");
  if (t.isTwoMoms) carriers.push("partner");
  carriers.push("surrogate");

  const eggSources: Array<"own" | "donor"> = t.hasOvaries ? ["own", "donor"] : ["donor"];
  const spermSources: Array<"own" | "donor"> = t.hasSperm ? ["own", "donor"] : ["donor"];

  // Cross product of journey states. Skips meaningless combos (e.g.
  // partner-carrier for non-reciprocal, own-eggs without ovaries).
  for (const hasEmbryos of [false, true]) {
    for (const eggSource of eggSources) {
      for (const spermSource of spermSources) {
        for (const carrier of carriers) {
          // Reciprocal needs eggSource=own + carrier=partner. Skip impossible mixes.
          if (carrier === "partner" && (!t.isTwoMoms || eggSource !== "own")) continue;

          scenarios.push({
            label: `embryos=${hasEmbryos} egg=${eggSource} sperm=${spermSource} carry=${carrier}`,
            hasEmbryos,
            eggSource,
            spermSource,
            carrier,
          });
        }
      }
    }
  }

  // Shipping-gametes variant on top of one carry option per family.
  scenarios.push({
    label: `embryos=false egg=donor sperm=donor carry=${carriers[0]} (shipping eggs+sperm)`,
    hasEmbryos: false,
    eggSource: "donor",
    spermSource: "donor",
    carrier: carriers[0],
    shippingEggs: true,
    shippingSperm: true,
  });

  return scenarios;
}

// -------------------------------------------------------------------------
// Run the grid and report.
// -------------------------------------------------------------------------

function fmt(s: Set<SubType>): string {
  return [...s].sort().join(", ") || "(none)";
}

interface Failure {
  family: FamilyType;
  scenario: Scenario;
  expected: Set<SubType>;
  actual: Set<SubType>;
  missing: SubType[];
  extra: SubType[];
}

const failures: Failure[] = [];
const families: FamilyType[] = ["solo_man", "solo_woman", "two_dads", "two_moms", "straight_couple"];
let scenarioCount = 0;

for (const family of families) {
  const { gender, partnerGender } = FAMILY_GENDERS[family];
  for (const s of scenariosFor(family)) {
    scenarioCount++;
    const input: MatcherInput = {
      userGender: gender,
      partnerGender,
      hasEmbryos: s.hasEmbryos,
      eggSource: s.eggSource,
      spermSource: s.spermSource,
      carrier: s.carrier,
      shippingEggs: s.shippingEggs,
      shippingSperm: s.shippingSperm,
      interestedServices: s.interestedServices,
    };
    const expected = expectedSubtypes(family, s);
    const actual = new Set(matchSubtypes(input).subtypes);

    const missing = [...expected].filter((x) => !actual.has(x));
    const extra = [...actual].filter((x) => !expected.has(x));
    if (missing.length > 0 || extra.length > 0) {
      failures.push({ family, scenario: s, expected, actual, missing, extra });
    }
  }
}

console.log(`[verify] ran ${scenarioCount} scenarios across ${families.length} family types`);
console.log(`[verify] failures: ${failures.length}\n`);

if (failures.length === 0) {
  console.log("✅ Matcher matches the expected truth table on every scenario.");
  // Spot-print a summary per family for visibility.
  for (const family of families) {
    console.log(`\n--- ${family} ---`);
    const sample = scenariosFor(family).slice(0, 4);
    for (const s of sample) {
      const { gender, partnerGender } = FAMILY_GENDERS[family];
      const input: MatcherInput = {
        userGender: gender, partnerGender,
        hasEmbryos: s.hasEmbryos, eggSource: s.eggSource, spermSource: s.spermSource,
        carrier: s.carrier, shippingEggs: s.shippingEggs, shippingSperm: s.shippingSperm,
        interestedServices: s.interestedServices,
      };
      const r = matchSubtypes(input);
      console.log(`  ${s.label}`);
      console.log(`    -> ${fmt(new Set(r.subtypes))}`);
    }
  }
  process.exit(0);
} else {
  console.log("❌ Mismatches:\n");
  for (const f of failures.slice(0, 50)) {
    console.log(`[${f.family}] ${f.scenario.label}`);
    if (f.missing.length) console.log(`   MISSING: ${f.missing.join(", ")}`);
    if (f.extra.length) console.log(`   EXTRA:   ${f.extra.join(", ")}`);
  }
  if (failures.length > 50) console.log(`... and ${failures.length - 50} more`);
  process.exit(1);
}
