/**
 * Curated US insurance reference data for the two-step (carrier -> plan) picker.
 *
 * There is no single clean free "all carriers + all plans" feed - the CMS
 * Marketplace API is ACA-only and omits the fertility benefit managers that
 * matter most here (Progyny, Carrot, Maven, WIN). ZocDoc curates its list from
 * payor data; we do the same, focused on what fertility patients actually carry:
 * the major medical carriers + fertility benefit managers + their common plans.
 *
 * Stored value format (used in Provider.acceptedInsurance and, later, the parent
 * insurance filter): the carrier name alone (e.g. "Aetna") means "all plans";
 * a specific plan is "Carrier - Plan" (e.g. "Aetna - PPO"). Hyphen separator,
 * never an em dash.
 */

export interface InsuranceCarrier {
  carrier: string;
  /** Fertility benefit managers are flagged so the UI can group them. */
  fertilityBenefit?: boolean;
  plans: string[];
}

export const ALL_PLANS = "All plans";
export const PLAN_SEPARATOR = " - ";

export const INSURANCE_CARRIERS: InsuranceCarrier[] = [
  // Major medical carriers
  { carrier: "Aetna", plans: ["PPO", "Open Choice PPO", "Choice POS II", "Aetna Select", "Managed Choice POS", "Elect Choice EPO", "Open Access Elect Choice EPO", "HMO", "Premier"] },
  { carrier: "Anthem Blue Cross Blue Shield", plans: ["PPO", "EPO", "HMO", "Blue Access", "Blue Priority", "Pathway"] },
  { carrier: "Blue Cross Blue Shield", plans: ["PPO", "EPO", "HMO", "POS", "BlueCard PPO"] },
  { carrier: "Empire Blue Cross Blue Shield", plans: ["PPO", "EPO", "HMO", "Pathway"] },
  { carrier: "Horizon Blue Cross Blue Shield", plans: ["PPO", "EPO", "HMO", "OMNIA"] },
  { carrier: "Cigna", plans: ["Open Access Plus", "PPO", "EPO", "HMO", "LocalPlus", "Cigna Connect"] },
  { carrier: "UnitedHealthcare", plans: ["Choice Plus", "Options PPO", "Navigate", "Select Plus", "Charter", "Core"] },
  { carrier: "UnitedHealthcare Oxford", plans: ["Freedom", "Liberty", "Metro", "Garden State"] },
  { carrier: "EmblemHealth", plans: ["PPO", "EPO", "HMO", "GHI", "HIP"] },
  { carrier: "Kaiser Permanente", plans: ["HMO", "PPO", "Added Choice"] },
  { carrier: "Humana", plans: ["PPO", "HMO", "POS", "ChoiceCare"] },
  { carrier: "Health Net", plans: ["PPO", "HMO", "EPO"] },
  { carrier: "Oscar Health", plans: ["PPO", "EPO"] },
  { carrier: "Independence Blue Cross", plans: ["PPO", "EPO", "HMO", "Keystone"] },
  { carrier: "Highmark Blue Cross Blue Shield", plans: ["PPO", "EPO", "HMO"] },
  { carrier: "Premera Blue Cross", plans: ["PPO", "HMO"] },
  { carrier: "Florida Blue", plans: ["PPO", "HMO", "BlueOptions"] },
  { carrier: "GEHA", plans: ["Elevate", "Elevate Plus", "Standard", "High"] },
  { carrier: "MagnaCare", plans: ["PPO"] },
  { carrier: "MultiPlan / PHCS", plans: ["PHCS PPO", "PPO"] },
  { carrier: "Tricare", plans: ["Prime", "Select"] },
  { carrier: "Medicare", plans: ["Original Medicare", "Medicare Advantage"] },
  { carrier: "Medicaid", plans: ["Managed Care"] },
  { carrier: "Fidelis Care", plans: ["Essential Plan", "Medicaid Managed Care", "Metal-Level Plans"] },
  { carrier: "Healthfirst", plans: ["PPO", "HMO", "Leaf Plans"] },
  { carrier: "MetroPlus Health", plans: ["HMO", "Essential Plan"] },
  // Fertility benefit managers (often the actual fertility coverage)
  { carrier: "Progyny", fertilityBenefit: true, plans: ["Smart Cycle"] },
  { carrier: "Carrot Fertility", fertilityBenefit: true, plans: ["Carrot Plan"] },
  { carrier: "Maven", fertilityBenefit: true, plans: ["Maven Wallet"] },
  { carrier: "WINFertility", fertilityBenefit: true, plans: ["WIN Managed Benefit"] },
  { carrier: "Kindbody", fertilityBenefit: true, plans: ["Kind Benefit"] },
  { carrier: "Stork Club", fertilityBenefit: true, plans: ["Stork Club Benefit"] },
  { carrier: "Gaia", fertilityBenefit: true, plans: ["Gaia Plan"] },
  // Catch-all
  { carrier: "Self-pay / No insurance", plans: [] },
];

export function carrierNames(): string[] {
  return INSURANCE_CARRIERS.map((c) => c.carrier);
}

export function plansForCarrier(carrier: string): string[] {
  return INSURANCE_CARRIERS.find((c) => c.carrier === carrier)?.plans ?? [];
}

/** Build the stored value: carrier alone = all plans; otherwise "Carrier - Plan". */
export function makeInsuranceValue(carrier: string, plan?: string | null): string {
  if (!plan || plan === ALL_PLANS) return carrier;
  return `${carrier}${PLAN_SEPARATOR}${plan}`;
}

/** Split a stored value back into { carrier, plan }. */
export function parseInsuranceValue(value: string): { carrier: string; plan: string | null } {
  const idx = value.indexOf(PLAN_SEPARATOR);
  if (idx === -1) return { carrier: value, plan: null };
  return { carrier: value.slice(0, idx), plan: value.slice(idx + PLAN_SEPARATOR.length) };
}
