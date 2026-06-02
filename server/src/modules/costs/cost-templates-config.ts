/**
 * Cost-sheet template config for IVF clinics.
 *
 * Single source of truth for:
 *   - The 4 tabs (IVF Cycle / Shipping Embryos / Shipping Eggs+Sperm / Egg Freezing)
 *   - The 10 subtypes that live under those tabs
 *   - The base field list per tab + the overlay per subtype that decides
 *     which fields are shown, which are mandatory always, and which are
 *     mandatory only when the clinic marks the program as Fixed-Cost.
 *
 * Shape is intentionally hybrid: a base template per tab (the union of all
 * fields any subtype under that tab might need) plus a per-subtype overlay
 * that selects + flags. Clinics can still add custom items at edit time.
 */

export type Tab =
  | "ivf_cycle"
  | "embryo_creation_only"
  | "fet"
  | "shipping_embryos"
  | "shipping_eggs_sperm"
  | "egg_freezing";

export type SubType =
  // IVF Cycle (create + transfer in one visit)
  | "ivf_cycle_own_eggs_own_carry"
  | "ivf_cycle_own_eggs_surrogate_carry"
  | "ivf_cycle_donor_eggs_own_carry"
  | "ivf_cycle_donor_eggs_surrogate_carry"
  | "ivf_cycle_reciprocal"
  // Embryo Creation Only (create + freeze, no transfer)
  | "embryo_creation_only_own_eggs"
  | "embryo_creation_only_donor_eggs"
  // Frozen Embryo Transfer (in-house embryos, no shipping, no creation)
  | "fet_to_self"
  | "fet_to_surrogate"
  // Shipping Embryos (embryos shipped in from another clinic)
  | "shipping_embryos_to_self"
  | "shipping_embryos_to_surrogate"
  // Shipping Eggs + Sperm (gametes shipped in, embryos created here)
  | "shipping_eggs_sperm_to_self"
  | "shipping_eggs_sperm_to_surrogate"
  // Egg Freezing (retrieval + storage, no embryos)
  | "egg_freezing_retrieval_storage";

export const ALL_SUBTYPES: SubType[] = [
  "ivf_cycle_own_eggs_own_carry",
  "ivf_cycle_own_eggs_surrogate_carry",
  "ivf_cycle_donor_eggs_own_carry",
  "ivf_cycle_donor_eggs_surrogate_carry",
  "ivf_cycle_reciprocal",
  "embryo_creation_only_own_eggs",
  "embryo_creation_only_donor_eggs",
  "fet_to_self",
  "fet_to_surrogate",
  "shipping_embryos_to_self",
  "shipping_embryos_to_surrogate",
  "shipping_eggs_sperm_to_self",
  "shipping_eggs_sperm_to_surrogate",
  "egg_freezing_retrieval_storage",
];

export const TAB_OF: Record<SubType, Tab> = {
  ivf_cycle_own_eggs_own_carry: "ivf_cycle",
  ivf_cycle_own_eggs_surrogate_carry: "ivf_cycle",
  ivf_cycle_donor_eggs_own_carry: "ivf_cycle",
  ivf_cycle_donor_eggs_surrogate_carry: "ivf_cycle",
  ivf_cycle_reciprocal: "ivf_cycle",
  embryo_creation_only_own_eggs: "embryo_creation_only",
  embryo_creation_only_donor_eggs: "embryo_creation_only",
  fet_to_self: "fet",
  fet_to_surrogate: "fet",
  shipping_embryos_to_self: "shipping_embryos",
  shipping_embryos_to_surrogate: "shipping_embryos",
  shipping_eggs_sperm_to_self: "shipping_eggs_sperm",
  shipping_eggs_sperm_to_surrogate: "shipping_eggs_sperm",
  egg_freezing_retrieval_storage: "egg_freezing",
};

export const TAB_LABEL: Record<Tab, string> = {
  ivf_cycle: "IVF Cycle",
  embryo_creation_only: "Embryo Creation Only",
  fet: "Frozen Embryo Transfer (FET)",
  shipping_embryos: "Shipping Embryos",
  shipping_eggs_sperm: "Shipping Eggs + Sperm",
  egg_freezing: "Egg Freezing",
};

export const SUBTYPE_LABEL: Record<SubType, string> = {
  ivf_cycle_own_eggs_own_carry: "Own eggs, own/self carry",
  ivf_cycle_own_eggs_surrogate_carry: "Own eggs, surrogate carries",
  ivf_cycle_donor_eggs_own_carry: "Donor eggs, own/self carry",
  ivf_cycle_donor_eggs_surrogate_carry: "Donor eggs, surrogate carries",
  ivf_cycle_reciprocal: "Reciprocal (own eggs, partner carries)",
  embryo_creation_only_own_eggs: "Own eggs (create + freeze, no transfer)",
  embryo_creation_only_donor_eggs: "Donor eggs (create + freeze, no transfer)",
  fet_to_self: "Transfer to own/self (in-house embryos)",
  fet_to_surrogate: "Transfer to surrogate (in-house embryos)",
  shipping_embryos_to_self: "Transfer shipped-in embryos to own/self",
  shipping_embryos_to_surrogate: "Transfer shipped-in embryos to surrogate",
  shipping_eggs_sperm_to_self: "Create embryos + transfer to own/self",
  shipping_eggs_sperm_to_surrogate: "Create embryos + transfer to surrogate",
  egg_freezing_retrieval_storage: "Egg retrieval + storage",
};

export interface FieldDef {
  category: string;
  fieldName: string;
  isBaseCompensation?: boolean;
  allowMultiple?: boolean;
  isNumericOnly?: boolean;
}

export interface SubtypeOverlay {
  includeFields: string[];
  mandatoryAlways?: string[];
  mandatoryFixed: string[];
  extraFields?: FieldDef[];
}

// Canonical names for the three count fields whose mandatory-ness depends
// on (a) the subtype involving that step at all and (b) isFixedCost=true.
export const RETRIEVALS_INCLUDED = "Number of Egg Retrievals Included";
export const SPERM_COLLECTIONS_INCLUDED = "Number of Sperm Collections Included";
export const TRANSFERS_INCLUDED = "Number of Transfers Included";

// -------------------------------------------------------------------------
// Tab base templates - the union of fields any subtype under the tab might
// surface. Per-subtype overlays decide which subset shows + mandatory rules.
// -------------------------------------------------------------------------

const IVF_CYCLE_BASE: FieldDef[] = [
  // Headline package line
  { category: "Medical", fieldName: "Creating Embryos + Embryo Transfer", isBaseCompensation: true },
  // Quantity guards (counted, not summed into total)
  { category: "Medical", fieldName: RETRIEVALS_INCLUDED, isNumericOnly: true },
  { category: "Medical", fieldName: SPERM_COLLECTIONS_INCLUDED, isNumericOnly: true },
  { category: "Medical", fieldName: TRANSFERS_INCLUDED, isNumericOnly: true },
  { category: "Medical", fieldName: "Each Additional Transfer" },
  { category: "Medical", fieldName: "Double Embryo Transfer Allowed" },
  // Lab / procedure
  { category: "Lab", fieldName: "ICSI - Selecting Best Sperm" },
  { category: "Lab", fieldName: "Assisted Hatching" },
  { category: "Lab", fieldName: "Embryo Cryopreservation Fees" },
  { category: "Lab", fieldName: "Cryo First Year" },
  { category: "Lab", fieldName: "Genetic Testing (PGT-A)" },
  { category: "Lab", fieldName: "In-House Genetic Testing" },
  { category: "Lab", fieldName: "Genetic Testing Biopsy Fees" },
  // Standard cycle costs
  { category: "Medical", fieldName: "Consultation" },
  { category: "Medical", fieldName: "Ultrasound" },
  { category: "Medical", fieldName: "Hormone Panel Testing" },
  { category: "Medical", fieldName: "Medication" },
  { category: "Medical", fieldName: "Operating Room Fee" },
  { category: "Medical", fieldName: "Anesthesia" },
  { category: "Medical", fieldName: "Egg Retrieval" },
  { category: "Medical", fieldName: "FET" },
  { category: "Medical", fieldName: "Monitoring" },
  { category: "Medical", fieldName: "Medical Management Fees" },
  { category: "Administrative", fieldName: "Administrative Fees" },
  // Donor-eggs only (overlay decides visibility)
  { category: "Egg Donor", fieldName: "Egg Donor Compensation", isBaseCompensation: true, allowMultiple: true },
  { category: "Egg Donor", fieldName: "Egg Donor Agency Fees" },
  { category: "Egg Donor", fieldName: "Egg Donor Screening" },
  { category: "Egg Donor", fieldName: "Donor Sperm" },
  // Surrogate-carry only (overlay decides visibility)
  { category: "Surrogacy", fieldName: "Surrogacy" },
  { category: "Surrogacy", fieldName: "Rematch Fee With Surrogate" },
  { category: "Surrogacy", fieldName: "Surrogate's Insurance" },
  // Legal (often present when surrogacy or donor eggs involved)
  { category: "Legal", fieldName: "Legal" },
  { category: "Legal", fieldName: "Establishing Parental Rights" },
  { category: "Legal", fieldName: "Who Is Listed On The Birth Certificate" },
  { category: "Legal", fieldName: "Can Surrogate Name Be Removed" },
];

const SHIPPING_EMBRYOS_BASE: FieldDef[] = [
  // Headline
  { category: "Medical", fieldName: "Embryo Shipping + Embryo Transfer", isBaseCompensation: true },
  // Counted quantities (no retrieval / sperm collection - parent already has embryos)
  { category: "Medical", fieldName: TRANSFERS_INCLUDED, isNumericOnly: true },
  { category: "Medical", fieldName: "Each Additional Transfer" },
  { category: "Medical", fieldName: "Double Embryo Transfer Allowed" },
  // Shipping-specific
  { category: "Shipping", fieldName: "Embryo Receiving Fee" },
  { category: "Shipping", fieldName: "Embryo Storage - First Year" },
  { category: "Lab", fieldName: "Embryo Thawing" },
  { category: "Lab", fieldName: "Assisted Hatching" },
  // Cycle prep / transfer
  { category: "Medical", fieldName: "Consultation" },
  { category: "Medical", fieldName: "Ultrasound" },
  { category: "Medical", fieldName: "Hormone Panel Testing" },
  { category: "Medical", fieldName: "Medication" },
  { category: "Medical", fieldName: "FET" },
  { category: "Medical", fieldName: "Monitoring" },
  { category: "Medical", fieldName: "Medical Management Fees" },
  { category: "Administrative", fieldName: "Administrative Fees" },
  // Surrogate-carry only (overlay decides)
  { category: "Surrogacy", fieldName: "Surrogacy" },
  { category: "Surrogacy", fieldName: "Rematch Fee With Surrogate" },
  { category: "Surrogacy", fieldName: "Surrogate's Insurance" },
  { category: "Legal", fieldName: "Legal" },
  { category: "Legal", fieldName: "Establishing Parental Rights" },
];

const SHIPPING_EGGS_SPERM_BASE: FieldDef[] = [
  // Headline
  { category: "Medical", fieldName: "Creating Embryos + Embryo Transfer", isBaseCompensation: true },
  // No retrievals / collections (gametes already shipped in)
  { category: "Medical", fieldName: TRANSFERS_INCLUDED, isNumericOnly: true },
  { category: "Medical", fieldName: "Each Additional Transfer" },
  { category: "Medical", fieldName: "Double Embryo Transfer Allowed" },
  // Shipping-specific
  { category: "Shipping", fieldName: "Gamete Receiving Fee (Eggs)" },
  { category: "Shipping", fieldName: "Gamete Receiving Fee (Sperm)" },
  { category: "Shipping", fieldName: "Embryo Storage - First Year" },
  // Lab + cycle prep
  { category: "Lab", fieldName: "ICSI - Selecting Best Sperm" },
  { category: "Lab", fieldName: "Assisted Hatching" },
  { category: "Lab", fieldName: "Embryo Cryopreservation Fees" },
  { category: "Lab", fieldName: "Cryo First Year" },
  { category: "Lab", fieldName: "Genetic Testing (PGT-A)" },
  { category: "Lab", fieldName: "Genetic Testing Biopsy Fees" },
  { category: "Medical", fieldName: "Consultation" },
  { category: "Medical", fieldName: "Medication" },
  { category: "Medical", fieldName: "FET" },
  { category: "Medical", fieldName: "Monitoring" },
  { category: "Medical", fieldName: "Medical Management Fees" },
  { category: "Administrative", fieldName: "Administrative Fees" },
  // Surrogate-carry only (overlay decides)
  { category: "Surrogacy", fieldName: "Surrogacy" },
  { category: "Surrogacy", fieldName: "Rematch Fee With Surrogate" },
  { category: "Surrogacy", fieldName: "Surrogate's Insurance" },
  { category: "Legal", fieldName: "Legal" },
  { category: "Legal", fieldName: "Establishing Parental Rights" },
];

const EGG_FREEZING_BASE: FieldDef[] = [
  // Headline
  { category: "Medical", fieldName: "Egg Retrieval + Storage", isBaseCompensation: true },
  // Counted quantity (no transfer for freezing-only)
  { category: "Medical", fieldName: RETRIEVALS_INCLUDED, isNumericOnly: true },
  // Cycle
  { category: "Medical", fieldName: "Consultation" },
  { category: "Medical", fieldName: "Ultrasound" },
  { category: "Medical", fieldName: "Hormone Panel Testing" },
  { category: "Medical", fieldName: "Medication" },
  { category: "Medical", fieldName: "Operating Room Fee" },
  { category: "Medical", fieldName: "Anesthesia" },
  { category: "Medical", fieldName: "Monitoring" },
  // Lab + storage
  { category: "Lab", fieldName: "Egg Vitrification" },
  { category: "Storage", fieldName: "Egg Storage - First Year" },
  { category: "Storage", fieldName: "Egg Storage - Per Year After" },
  { category: "Administrative", fieldName: "Administrative Fees" },
];

// Embryo Creation Only: create embryos + freeze, NO transfer step. Parent
// will come back later for a transfer (often years later). No transfer
// fields; storage line is the natural endpoint.
const EMBRYO_CREATION_ONLY_BASE: FieldDef[] = [
  { category: "Medical", fieldName: "Creating Embryos (No Transfer)", isBaseCompensation: true },
  { category: "Medical", fieldName: RETRIEVALS_INCLUDED, isNumericOnly: true },
  { category: "Medical", fieldName: SPERM_COLLECTIONS_INCLUDED, isNumericOnly: true },
  { category: "Lab", fieldName: "ICSI - Selecting Best Sperm" },
  { category: "Lab", fieldName: "Embryo Cryopreservation Fees" },
  { category: "Lab", fieldName: "Cryo First Year" },
  { category: "Lab", fieldName: "Genetic Testing (PGT-A)" },
  { category: "Lab", fieldName: "Genetic Testing Biopsy Fees" },
  { category: "Medical", fieldName: "Consultation" },
  { category: "Medical", fieldName: "Ultrasound" },
  { category: "Medical", fieldName: "Hormone Panel Testing" },
  { category: "Medical", fieldName: "Medication" },
  { category: "Medical", fieldName: "Operating Room Fee" },
  { category: "Medical", fieldName: "Anesthesia" },
  { category: "Medical", fieldName: "Egg Retrieval" },
  { category: "Medical", fieldName: "Monitoring" },
  { category: "Medical", fieldName: "Medical Management Fees" },
  { category: "Storage", fieldName: "Embryo Storage - First Year" },
  { category: "Storage", fieldName: "Embryo Storage - Per Year After" },
  { category: "Administrative", fieldName: "Administrative Fees" },
  // Donor-eggs only (overlay decides visibility)
  { category: "Egg Donor", fieldName: "Egg Donor Compensation", isBaseCompensation: true, allowMultiple: true },
  { category: "Egg Donor", fieldName: "Egg Donor Agency Fees" },
  { category: "Egg Donor", fieldName: "Egg Donor Screening" },
];

// Frozen Embryo Transfer (FET): the embryos are already at this clinic
// (no shipping in, no creation step). Just thaw + transfer.
const FET_BASE: FieldDef[] = [
  { category: "Medical", fieldName: "Frozen Embryo Transfer", isBaseCompensation: true },
  { category: "Medical", fieldName: TRANSFERS_INCLUDED, isNumericOnly: true },
  { category: "Medical", fieldName: "Each Additional Transfer" },
  { category: "Medical", fieldName: "Double Embryo Transfer Allowed" },
  { category: "Lab", fieldName: "Embryo Thawing" },
  { category: "Lab", fieldName: "Assisted Hatching" },
  { category: "Storage", fieldName: "Embryo Storage - First Year" },
  { category: "Medical", fieldName: "Consultation" },
  { category: "Medical", fieldName: "Ultrasound" },
  { category: "Medical", fieldName: "Hormone Panel Testing" },
  { category: "Medical", fieldName: "Medication" },
  { category: "Medical", fieldName: "FET" },
  { category: "Medical", fieldName: "Monitoring" },
  { category: "Medical", fieldName: "Medical Management Fees" },
  { category: "Administrative", fieldName: "Administrative Fees" },
  // Surrogate-carry only (overlay decides)
  { category: "Surrogacy", fieldName: "Surrogacy" },
  { category: "Surrogacy", fieldName: "Rematch Fee With Surrogate" },
  { category: "Surrogacy", fieldName: "Surrogate's Insurance" },
  { category: "Legal", fieldName: "Legal" },
  { category: "Legal", fieldName: "Establishing Parental Rights" },
];

export const TAB_BASE: Record<Tab, FieldDef[]> = {
  ivf_cycle: IVF_CYCLE_BASE,
  embryo_creation_only: EMBRYO_CREATION_ONLY_BASE,
  fet: FET_BASE,
  shipping_embryos: SHIPPING_EMBRYOS_BASE,
  shipping_eggs_sperm: SHIPPING_EGGS_SPERM_BASE,
  egg_freezing: EGG_FREEZING_BASE,
};

// -------------------------------------------------------------------------
// Per-subtype overlays. includeFields is the explicit allowlist drawn from
// the tab base; anything in the base but not listed here is hidden for
// this subtype. mandatoryFixed[] applies only when isFixedCost=true.
// -------------------------------------------------------------------------

// IVF Cycle base sans donor-egg-only fields, sans surrogate-only fields
const IVF_CORE = [
  "Creating Embryos + Embryo Transfer",
  RETRIEVALS_INCLUDED,
  SPERM_COLLECTIONS_INCLUDED,
  TRANSFERS_INCLUDED,
  "Each Additional Transfer",
  "Double Embryo Transfer Allowed",
  "ICSI - Selecting Best Sperm",
  "Assisted Hatching",
  "Embryo Cryopreservation Fees",
  "Cryo First Year",
  "Genetic Testing (PGT-A)",
  "In-House Genetic Testing",
  "Genetic Testing Biopsy Fees",
  "Consultation",
  "Ultrasound",
  "Hormone Panel Testing",
  "Medication",
  "Operating Room Fee",
  "Anesthesia",
  "Egg Retrieval",
  "FET",
  "Monitoring",
  "Medical Management Fees",
  "Administrative Fees",
];

const DONOR_EGG_FIELDS = [
  "Egg Donor Compensation",
  "Egg Donor Agency Fees",
  "Egg Donor Screening",
];

const SURROGACY_FIELDS = [
  "Surrogacy",
  "Rematch Fee With Surrogate",
  "Surrogate's Insurance",
  "Legal",
  "Establishing Parental Rights",
  "Who Is Listed On The Birth Certificate",
  "Can Surrogate Name Be Removed",
];

const SHIPPING_EMBRYOS_CORE = [
  "Embryo Shipping + Embryo Transfer",
  TRANSFERS_INCLUDED,
  "Each Additional Transfer",
  "Double Embryo Transfer Allowed",
  "Embryo Receiving Fee",
  "Embryo Storage - First Year",
  "Embryo Thawing",
  "Assisted Hatching",
  "Consultation",
  "Ultrasound",
  "Hormone Panel Testing",
  "Medication",
  "FET",
  "Monitoring",
  "Medical Management Fees",
  "Administrative Fees",
];

const SHIPPING_EGGS_SPERM_CORE = [
  "Creating Embryos + Embryo Transfer",
  TRANSFERS_INCLUDED,
  "Each Additional Transfer",
  "Double Embryo Transfer Allowed",
  "Gamete Receiving Fee (Eggs)",
  "Gamete Receiving Fee (Sperm)",
  "Embryo Storage - First Year",
  "ICSI - Selecting Best Sperm",
  "Assisted Hatching",
  "Embryo Cryopreservation Fees",
  "Cryo First Year",
  "Genetic Testing (PGT-A)",
  "Genetic Testing Biopsy Fees",
  "Consultation",
  "Medication",
  "FET",
  "Monitoring",
  "Medical Management Fees",
  "Administrative Fees",
];

export const SUBTYPE_OVERLAY: Record<SubType, SubtypeOverlay> = {
  // ===== IVF Cycle =====
  ivf_cycle_own_eggs_own_carry: {
    includeFields: IVF_CORE,
    mandatoryFixed: [RETRIEVALS_INCLUDED, SPERM_COLLECTIONS_INCLUDED, TRANSFERS_INCLUDED],
    mandatoryAlways: ["Creating Embryos + Embryo Transfer"],
  },
  ivf_cycle_own_eggs_surrogate_carry: {
    includeFields: [...IVF_CORE, ...SURROGACY_FIELDS],
    mandatoryFixed: [RETRIEVALS_INCLUDED, SPERM_COLLECTIONS_INCLUDED, TRANSFERS_INCLUDED],
    mandatoryAlways: ["Creating Embryos + Embryo Transfer"],
  },
  ivf_cycle_donor_eggs_own_carry: {
    // Donor eggs: no retrievals counted (eggs come from donor lot)
    includeFields: [
      ...IVF_CORE.filter((f) => f !== RETRIEVALS_INCLUDED),
      ...DONOR_EGG_FIELDS,
    ],
    mandatoryFixed: [SPERM_COLLECTIONS_INCLUDED, TRANSFERS_INCLUDED],
    mandatoryAlways: ["Creating Embryos + Embryo Transfer"],
  },
  ivf_cycle_donor_eggs_surrogate_carry: {
    includeFields: [
      ...IVF_CORE.filter((f) => f !== RETRIEVALS_INCLUDED),
      ...DONOR_EGG_FIELDS,
      ...SURROGACY_FIELDS,
    ],
    mandatoryFixed: [SPERM_COLLECTIONS_INCLUDED, TRANSFERS_INCLUDED],
    mandatoryAlways: ["Creating Embryos + Embryo Transfer"],
  },
  ivf_cycle_reciprocal: {
    // Reciprocal: own eggs (from partner A) -> embryo -> partner B carries.
    // Sperm is donor; retrievals from the egg-providing partner are counted.
    includeFields: [...IVF_CORE, "Donor Sperm"],
    mandatoryFixed: [RETRIEVALS_INCLUDED, TRANSFERS_INCLUDED],
    mandatoryAlways: ["Creating Embryos + Embryo Transfer"],
  },

  // ===== Shipping Embryos =====
  shipping_embryos_to_self: {
    includeFields: SHIPPING_EMBRYOS_CORE,
    mandatoryFixed: [TRANSFERS_INCLUDED],
    mandatoryAlways: ["Embryo Shipping + Embryo Transfer"],
  },
  shipping_embryos_to_surrogate: {
    includeFields: [...SHIPPING_EMBRYOS_CORE, ...SURROGACY_FIELDS],
    mandatoryFixed: [TRANSFERS_INCLUDED],
    mandatoryAlways: ["Embryo Shipping + Embryo Transfer"],
  },

  // ===== Shipping Eggs + Sperm =====
  shipping_eggs_sperm_to_self: {
    includeFields: SHIPPING_EGGS_SPERM_CORE,
    mandatoryFixed: [TRANSFERS_INCLUDED],
    mandatoryAlways: ["Creating Embryos + Embryo Transfer"],
  },
  shipping_eggs_sperm_to_surrogate: {
    includeFields: [...SHIPPING_EGGS_SPERM_CORE, ...SURROGACY_FIELDS],
    mandatoryFixed: [TRANSFERS_INCLUDED],
    mandatoryAlways: ["Creating Embryos + Embryo Transfer"],
  },

  // ===== Egg Freezing =====
  egg_freezing_retrieval_storage: {
    includeFields: [
      "Egg Retrieval + Storage",
      RETRIEVALS_INCLUDED,
      "Consultation",
      "Ultrasound",
      "Hormone Panel Testing",
      "Medication",
      "Operating Room Fee",
      "Anesthesia",
      "Monitoring",
      "Egg Vitrification",
      "Egg Storage - First Year",
      "Egg Storage - Per Year After",
      "Administrative Fees",
    ],
    mandatoryFixed: [RETRIEVALS_INCLUDED],
    mandatoryAlways: ["Egg Retrieval + Storage"],
  },

  // ===== Embryo Creation Only (no transfer step) =====
  embryo_creation_only_own_eggs: {
    includeFields: [
      "Creating Embryos (No Transfer)",
      RETRIEVALS_INCLUDED,
      SPERM_COLLECTIONS_INCLUDED,
      "ICSI - Selecting Best Sperm",
      "Embryo Cryopreservation Fees",
      "Cryo First Year",
      "Genetic Testing (PGT-A)",
      "Genetic Testing Biopsy Fees",
      "Consultation",
      "Ultrasound",
      "Hormone Panel Testing",
      "Medication",
      "Operating Room Fee",
      "Anesthesia",
      "Egg Retrieval",
      "Monitoring",
      "Medical Management Fees",
      "Embryo Storage - First Year",
      "Embryo Storage - Per Year After",
      "Administrative Fees",
    ],
    mandatoryFixed: [RETRIEVALS_INCLUDED, SPERM_COLLECTIONS_INCLUDED],
    mandatoryAlways: ["Creating Embryos (No Transfer)"],
  },
  embryo_creation_only_donor_eggs: {
    // Donor eggs: no own retrieval counted (eggs from donor lot)
    includeFields: [
      "Creating Embryos (No Transfer)",
      SPERM_COLLECTIONS_INCLUDED,
      "ICSI - Selecting Best Sperm",
      "Embryo Cryopreservation Fees",
      "Cryo First Year",
      "Genetic Testing (PGT-A)",
      "Genetic Testing Biopsy Fees",
      "Consultation",
      "Medication",
      "Medical Management Fees",
      "Embryo Storage - First Year",
      "Embryo Storage - Per Year After",
      "Administrative Fees",
      "Egg Donor Compensation",
      "Egg Donor Agency Fees",
      "Egg Donor Screening",
    ],
    mandatoryFixed: [SPERM_COLLECTIONS_INCLUDED],
    mandatoryAlways: ["Creating Embryos (No Transfer)"],
  },

  // ===== Frozen Embryo Transfer (FET) - embryos already at this clinic =====
  fet_to_self: {
    includeFields: [
      "Frozen Embryo Transfer",
      TRANSFERS_INCLUDED,
      "Each Additional Transfer",
      "Double Embryo Transfer Allowed",
      "Embryo Thawing",
      "Assisted Hatching",
      "Embryo Storage - First Year",
      "Consultation",
      "Ultrasound",
      "Hormone Panel Testing",
      "Medication",
      "FET",
      "Monitoring",
      "Medical Management Fees",
      "Administrative Fees",
    ],
    mandatoryFixed: [TRANSFERS_INCLUDED],
    mandatoryAlways: ["Frozen Embryo Transfer"],
  },
  fet_to_surrogate: {
    includeFields: [
      "Frozen Embryo Transfer",
      TRANSFERS_INCLUDED,
      "Each Additional Transfer",
      "Double Embryo Transfer Allowed",
      "Embryo Thawing",
      "Assisted Hatching",
      "Embryo Storage - First Year",
      "Consultation",
      "Medication",
      "FET",
      "Monitoring",
      "Medical Management Fees",
      "Administrative Fees",
      "Surrogacy",
      "Rematch Fee With Surrogate",
      "Surrogate's Insurance",
      "Legal",
      "Establishing Parental Rights",
    ],
    mandatoryFixed: [TRANSFERS_INCLUDED],
    mandatoryAlways: ["Frozen Embryo Transfer"],
  },
};

// -------------------------------------------------------------------------
// Resolved-template helper. Returns the fields to render for a given
// subtype with mandatory flags resolved for the current isFixedCost state.
// -------------------------------------------------------------------------

export interface ResolvedField extends FieldDef {
  isMandatoryAlways: boolean;
  isMandatoryWhenFixed: boolean;
  isMandatoryNow: boolean;
  sortOrder: number;
}

export interface ResolvedTemplate {
  tab: Tab;
  subType: SubType;
  isFixedCost: boolean;
  fields: ResolvedField[];
}

export function resolveTemplate(
  subType: SubType,
  isFixedCost: boolean,
): ResolvedTemplate {
  const tab = TAB_OF[subType];
  const overlay = SUBTYPE_OVERLAY[subType];
  const base = TAB_BASE[tab];

  const baseByName = new Map(base.map((f) => [f.fieldName, f]));
  const include = new Set(overlay.includeFields);
  const mandatoryAlways = new Set(overlay.mandatoryAlways ?? []);
  const mandatoryFixed = new Set(overlay.mandatoryFixed);

  const fields: ResolvedField[] = [];
  let sortOrder = 0;

  // Preserve the order in which fields are listed in includeFields so the
  // overlay author controls display order.
  for (const fieldName of overlay.includeFields) {
    const def = baseByName.get(fieldName);
    if (!def) {
      // Field listed in overlay but not in base - skip rather than crash.
      // Surfaces as a missing config bug in tests.
      continue;
    }
    fields.push({
      ...def,
      isMandatoryAlways: mandatoryAlways.has(fieldName),
      isMandatoryWhenFixed: mandatoryFixed.has(fieldName),
      isMandatoryNow:
        mandatoryAlways.has(fieldName) ||
        (isFixedCost && mandatoryFixed.has(fieldName)),
      sortOrder: sortOrder++,
    });
  }

  for (const extra of overlay.extraFields ?? []) {
    fields.push({
      ...extra,
      isMandatoryAlways: mandatoryAlways.has(extra.fieldName),
      isMandatoryWhenFixed: mandatoryFixed.has(extra.fieldName),
      isMandatoryNow:
        mandatoryAlways.has(extra.fieldName) ||
        (isFixedCost && mandatoryFixed.has(extra.fieldName)),
      sortOrder: sortOrder++,
    });
    include.add(extra.fieldName);
  }

  return { tab, subType, isFixedCost, fields };
}

export function isValidSubType(value: string | null | undefined): value is SubType {
  return !!value && (ALL_SUBTYPES as string[]).includes(value);
}

export function isValidTab(value: string | null | undefined): value is Tab {
  return value === "ivf_cycle"
    || value === "embryo_creation_only"
    || value === "fet"
    || value === "shipping_embryos"
    || value === "shipping_eggs_sperm"
    || value === "egg_freezing";
}

export function subtypesForTab(tab: Tab): SubType[] {
  return ALL_SUBTYPES.filter((s) => TAB_OF[s] === tab);
}
