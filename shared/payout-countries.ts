/**
 * Where a provider's legal entity lives decides HOW GoStork can pay them.
 *
 * GoStork is a US Stripe Connect platform. Per Stripe's cross-border payout
 * rules (docs.stripe.com/connect/cross-border-payouts, checked 2026-08-19) a
 * US platform can transfer to connected accounts in the US, Canada, the UK,
 * Switzerland and the EEA - nowhere else, even countries where Stripe itself
 * operates (Mexico, Japan, ...). Providers outside that set are paid through
 * the international payout rail (Trolley) instead.
 *
 * Same ISO-3166 alpha-2 codes the Legal tab stores in
 * ProviderLegalIdentity.businessAddressCountry. One list, used by the
 * Legal tab, the Payouts page, connect.service and the tax-form picker, so
 * the four can never disagree about who is "international".
 */

export const EEA_COUNTRIES: readonly string[] = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES",
  "SE", // EU-27
  "IS", "LI", "NO", // EEA non-EU
];

/** Countries a US Stripe Connect platform may transfer to. */
export const STRIPE_CONNECT_PAYOUT_COUNTRIES: readonly string[] = [
  "US", "CA", "GB", "CH", ...EEA_COUNTRIES,
];

export type PayoutRail = "STRIPE" | "INTERNATIONAL";

export function normalizeCountry(code: string | null | undefined): string {
  const c = (code || "").trim().toUpperCase();
  return c || "US";
}

export function isUsEntity(code: string | null | undefined): boolean {
  return normalizeCountry(code) === "US";
}

/**
 * STRIPE = Connect transfer; INTERNATIONAL = Trolley.
 *
 * Product rule (Eran, 2026-08-20): US entities are paid through Stripe
 * Connect, EVERY non-US entity through the international payout partner -
 * even countries Stripe could technically reach (Cyprus, Canada, UK...).
 * One onboarding flow, one ops process, one fee model and one tax-form path
 * for all international providers beats a per-country split.
 * STRIPE_CONNECT_PAYOUT_COUNTRIES is kept as reference (and for the Stripe
 * account-country code path) should that decision ever change.
 */
export function payoutRailFor(code: string | null | undefined): PayoutRail {
  return isUsEntity(code) ? "STRIPE" : "INTERNATIONAL";
}

/**
 * The IRS form a provider signs before GoStork can pay them: W-9 for US
 * persons/entities, W-8BEN-E for foreign entities (W-8BEN for foreign
 * individuals - we treat both as the W-8 family; the PandaDoc template
 * configured for foreign providers decides which).
 */
export type TaxFormType = "W9" | "W8BENE";
export function taxFormFor(code: string | null | undefined): TaxFormType {
  return isUsEntity(code) ? "W9" : "W8BENE";
}
export const TAX_FORM_LABELS: Record<TaxFormType, string> = { W9: "W-9", W8BENE: "W-8BEN-E" };

/**
 * What the provider's tax identifier is called locally - label only, the
 * field accepts any format for non-US entities (Stripe / Trolley validate
 * the real thing during their own onboarding).
 */
export function taxIdLabelFor(code: string | null | undefined): string {
  switch (normalizeCountry(code)) {
    case "US": return "EIN / Tax ID";
    case "MX": return "RFC";
    case "CO": return "NIT";
    case "CA": return "Business Number (BN)";
    case "GB": return "Company / UTR number";
    case "UA": return "EDRPOU / tax number";
    case "GE": return "Identification number";
    case "IL": return "Company number (ח.פ.)";
    case "AR": return "CUIT";
    case "BR": return "CNPJ";
    case "IN": return "PAN / GSTIN";
    default: return EEA_COUNTRIES.includes(normalizeCountry(code)) ? "VAT / tax number" : "Tax identification number";
  }
}

/**
 * Default payout currency by country - the currency a provider in that
 * country is paid in (Stripe pays connected accounts in their local
 * currency; Trolley pays in the recipient's local currency). Used ONLY for
 * the "you receive approx." estimate; invoices are always USD.
 */
const CURRENCY_BY_COUNTRY: Record<string, string> = {
  US: "USD", CA: "CAD", GB: "GBP", CH: "CHF", MX: "MXN", CO: "COP", UA: "UAH", GE: "GEL",
  IL: "ILS", AR: "ARS", BR: "BRL", IN: "INR", AU: "AUD", NZ: "NZD", JP: "JPY", SG: "SGD",
  HK: "HKD", AE: "AED", TH: "THB", MY: "MYR", ZA: "ZAR", NG: "NGN", KE: "KES", PL: "PLN",
  CZ: "CZK", HU: "HUF", RO: "RON", BG: "BGN", DK: "DKK", SE: "SEK", NO: "NOK", IS: "ISK",
  TR: "TRY", PH: "PHP", CL: "CLP", PE: "PEN", CR: "CRC", EC: "USD", PA: "USD", SV: "USD",
};
export function currencyFor(code: string | null | undefined): string {
  const c = normalizeCountry(code);
  if (CURRENCY_BY_COUNTRY[c]) return CURRENCY_BY_COUNTRY[c];
  if (EEA_COUNTRIES.includes(c)) return "EUR";
  return "USD";
}
