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
  /** Shown in the "Popular carriers" logo grid. */
  popular?: boolean;
  /** Domain used to fetch the carrier logo (Clearbit), with an initials fallback. */
  domain?: string;
  plans: string[];
}

export const ALL_PLANS = "All plans";
export const PLAN_SEPARATOR = " - ";

export const INSURANCE_CARRIERS: InsuranceCarrier[] = [
  // Major medical carriers
  { carrier: "Aetna", popular: true, domain: "aetna.com", plans: ["PPO", "Open Choice PPO", "Choice POS II", "Aetna Select", "Managed Choice POS", "Elect Choice EPO", "Open Access Elect Choice EPO", "HMO", "Premier"] },
  { carrier: "UnitedHealthcare", popular: true, domain: "uhc.com", plans: ["Choice Plus", "Options PPO", "Navigate", "Select Plus", "Charter", "Core"] },
  { carrier: "Cigna", popular: true, domain: "cigna.com", plans: ["Open Access Plus", "PPO", "EPO", "HMO", "LocalPlus", "Cigna Connect"] },
  { carrier: "Blue Cross Blue Shield", popular: true, domain: "bcbs.com", plans: ["PPO", "EPO", "HMO", "POS", "BlueCard PPO"] },
  { carrier: "Anthem Blue Cross Blue Shield", popular: true, domain: "anthem.com", plans: ["PPO", "EPO", "HMO", "Blue Access", "Blue Priority", "Pathway"] },
  { carrier: "Empire Blue Cross Blue Shield", domain: "empireblue.com", plans: ["PPO", "EPO", "HMO", "Pathway"] },
  { carrier: "Horizon Blue Cross Blue Shield", domain: "horizonblue.com", plans: ["PPO", "EPO", "HMO", "OMNIA"] },
  { carrier: "Kaiser Permanente", popular: true, domain: "kp.org", plans: ["HMO", "PPO", "Added Choice"] },
  { carrier: "EmblemHealth", popular: true, domain: "emblemhealth.com", plans: ["PPO", "EPO", "HMO", "GHI", "HIP"] },
  { carrier: "UnitedHealthcare Oxford", domain: "oxhp.com", plans: ["Freedom", "Liberty", "Metro", "Garden State"] },
  { carrier: "Humana", domain: "humana.com", plans: ["PPO", "HMO", "POS", "ChoiceCare"] },
  { carrier: "Health Net", domain: "healthnet.com", plans: ["PPO", "HMO", "EPO"] },
  { carrier: "Oscar Health", domain: "hioscar.com", plans: ["PPO", "EPO"] },
  { carrier: "Independence Blue Cross", domain: "ibx.com", plans: ["PPO", "EPO", "HMO", "Keystone"] },
  { carrier: "Highmark Blue Cross Blue Shield", domain: "highmark.com", plans: ["PPO", "EPO", "HMO"] },
  { carrier: "Premera Blue Cross", domain: "premera.com", plans: ["PPO", "HMO"] },
  { carrier: "Florida Blue", domain: "floridablue.com", plans: ["PPO", "HMO", "BlueOptions"] },
  { carrier: "GEHA", domain: "geha.com", plans: ["Elevate", "Elevate Plus", "Standard", "High"] },
  { carrier: "MagnaCare", domain: "magnacare.com", plans: ["PPO"] },
  { carrier: "MultiPlan / PHCS", domain: "multiplan.com", plans: ["PHCS PPO", "PPO"] },
  { carrier: "Tricare", domain: "tricare.mil", plans: ["Prime", "Select"] },
  { carrier: "Medicare", domain: "medicare.gov", plans: ["Original Medicare", "Medicare Advantage"] },
  { carrier: "Medicaid", domain: "medicaid.gov", plans: ["Managed Care"] },
  { carrier: "Fidelis Care", domain: "fideliscare.org", plans: ["Essential Plan", "Medicaid Managed Care", "Metal-Level Plans"] },
  { carrier: "Healthfirst", domain: "healthfirst.org", plans: ["PPO", "HMO", "Leaf Plans"] },
  { carrier: "MetroPlus Health", domain: "metroplus.org", plans: ["HMO", "Essential Plan"] },
  // Fertility benefit managers (often the actual fertility coverage)
  { carrier: "Progyny", fertilityBenefit: true, popular: true, domain: "progyny.com", plans: ["Smart Cycle"] },
  { carrier: "Carrot Fertility", fertilityBenefit: true, popular: true, domain: "get-carrot.com", plans: ["Carrot Plan"] },
  { carrier: "Maven", fertilityBenefit: true, domain: "mavenclinic.com", plans: ["Maven Wallet"] },
  { carrier: "WINFertility", fertilityBenefit: true, domain: "winfertility.com", plans: ["WIN Managed Benefit"] },
  { carrier: "Kindbody", fertilityBenefit: true, domain: "kindbody.com", plans: ["Kind Benefit"] },
  { carrier: "Stork Club", fertilityBenefit: true, domain: "storkclub.com", plans: ["Stork Club Benefit"] },
  { carrier: "Gaia", fertilityBenefit: true, domain: "gaiafamily.com", plans: ["Gaia Plan"] },
  // Catch-all
  { carrier: "Self-pay / No insurance", plans: [] },
];

export function popularCarriers(): InsuranceCarrier[] {
  return INSURANCE_CARRIERS.filter((c) => c.popular);
}

export function logoUrl(domain?: string): string | null {
  return domain ? `https://logo.clearbit.com/${domain}` : null;
}

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
