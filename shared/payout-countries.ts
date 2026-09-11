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
 * The country the PAYOUT/TAX machinery should treat the provider as.
 *
 * A provider whose operating business is abroad may still own a US legal
 * entity and prefer to be paid into its US bank (Eran, 2026-08-20: the
 * "I have a US entity" checkbox on the Payouts page). When
 * ProviderLegalIdentity.usPayoutEntity is set, everything downstream -
 * payout rail, Stripe account country, W-9 vs W-8BEN-E, tax-ID label -
 * behaves as US, while the address on file stays their real one.
 */
export function effectivePayoutCountry(code: string | null | undefined, usPayoutEntity?: boolean | null): string {
  return usPayoutEntity ? "US" : normalizeCountry(code);
}

/**
 * STRIPE = Connect transfer; INTERNATIONAL = manual bank wire by GoStork.
 *
 * History: the 2026-08-20 rule was "US = Stripe, everything else = Trolley",
 * but Trolley REJECTED GoStork's bank-transfer application (2026-08-20), so
 * the Trolley rail is parked behind TROLLEY_ENABLED and the rule reverted:
 * every country a US Stripe platform can self-serve pay (US/CA/GB/CH/EEA -
 * from Eran's target list that covers Cyprus) goes through Stripe, and the
 * rest (Mexico, Colombia, Georgia, Ukraine, ...) are paid by a manual
 * international wire arranged by GoStork admin (the notifyAdminTransferFailed
 * path raises the to-do when their invoice is paid).
 * NOTE for non-US Stripe countries: account creation uses the recipient
 * service agreement (transfers-only); verify the first real transfer to a
 * CY/EEA account actually lands - if Stripe refuses, that provider simply
 * falls back to the same manual-wire path.
 */
export function payoutRailFor(code: string | null | undefined): PayoutRail {
  return STRIPE_CONNECT_PAYOUT_COUNTRIES.includes(normalizeCountry(code)) ? "STRIPE" : "INTERNATIONAL";
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

/**
 * Reverse of Intl.DisplayNames: an English country name ("Colombia",
 * "United States") -> ISO-3166 alpha-2, or null when
 * the text is not a country. Used to pre-select the legal-entity country
 * from a provider's profile location, which stores the country as free
 * text (ProviderLocation has no country column - the geocoder's country
 * name lands in `state`, e.g. "Cajicá" / "Colombia").
 */
const COUNTRY_ALIASES: Record<string, string> = {
  "usa": "US", "u.s.": "US", "u.s.a.": "US", "united states of america": "US", "america": "US",
  "uk": "GB", "u.k.": "GB", "united kingdom": "GB", "great britain": "GB", "england": "GB", "scotland": "GB", "wales": "GB",
  "türkiye": "TR", "turkiye": "TR",
  "czechia": "CZ", "czech republic": "CZ",
  "south korea": "KR", "korea": "KR",
  "russia": "RU", "vietnam": "VN", "iran": "IR", "syria": "SY", "laos": "LA", "moldova": "MD",
  "bolivia": "BO", "venezuela": "VE", "tanzania": "TZ", "macedonia": "MK", "north macedonia": "MK",
  "ivory coast": "CI", "cape verde": "CV", "swaziland": "SZ", "burma": "MM", "holland": "NL",
  "hong kong": "HK", "macau": "MO", "taiwan": "TW", "palestine": "PS",
  "uae": "AE", "u.a.e.": "AE", "emirates": "AE",
};
let countryNameIndex: Map<string, string> | null = null;
function buildCountryNameIndex(): Map<string, string> {
  const index = new Map<string, string>(Object.entries(COUNTRY_ALIASES));
  const names = typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;
  if (!names) return index;
  // Every alpha-2 region Intl knows about; non-countries (e.g. "EU", "UN",
  // unassigned pairs) are skipped because DisplayNames echoes the code back.
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a) + String.fromCharCode(b);
      let name: string | undefined;
      try { name = names.of(code) ?? undefined; } catch { continue; }
      if (!name || name === code) continue;
      // First code wins: ICU also names alias codes ("UK" -> "United
      // Kingdom") and the canonical one sorts first, plus explicit aliases
      // above must not be clobbered.
      const key = name.toLowerCase();
      if (!index.has(key)) index.set(key, code);
    }
  }
  return index;
}
/** Names only, never bare codes: a US state abbreviation ("CA", "CO", "DE",
 *  "IN", ...) is also a valid ISO country code, so a 2-letter `state` must
 *  not be read as a country. */
export function countryNameToIso(text: string | null | undefined): string | null {
  const t = (text || "").trim();
  if (t.length < 3) return null;
  countryNameIndex ??= buildCountryNameIndex();
  return countryNameIndex.get(t.toLowerCase()) ?? null;
}

const US_STATES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia", "ks", "ky", "la",
  "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok",
  "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc", "pr",
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida",
  "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
  "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska",
  "nevada", "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio",
  "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas",
  "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia",
  "puerto rico",
]);

/**
 * Best-effort country for a provider from its profile locations, checking
 * the parts a geocoder may have put the country name in. First location
 * wins (that is the one the Company tab shows as primary). A US state or a
 * US-shaped ZIP resolves to "US" since US locations never carry the
 * country name.
 */
export function countryFromLocations(
  locations: ReadonlyArray<{ state?: string | null; city?: string | null; address?: string | null; zip?: string | null }>,
): string | null {
  for (const loc of locations) {
    for (const part of [loc.state, loc.city]) {
      const iso = countryNameToIso(part);
      if (iso) return iso;
    }
    // "Cra 7 #12-34, Bogotá, Colombia" style single-line addresses
    const tail = (loc.address || "").split(",").pop();
    const iso = countryNameToIso(tail);
    if (iso) return iso;
    if (US_STATES.has((loc.state || "").trim().toLowerCase())) return "US";
    if (/^\d{5}(-\d{4})?$/.test((loc.zip || "").trim())) return "US";
  }
  return null;
}
