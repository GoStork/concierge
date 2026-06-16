/**
 * Returns a flag emoji for a given country name using the Unicode Regional Indicator Symbols.
 * Uses Intl.DisplayNames to build a reverse map from country name -> ISO 3166-1 alpha-2 code.
 */

let nameToCode: Map<string, string> | null = null;

function buildNameToCode(): Map<string, string> {
  if (nameToCode) return nameToCode;
  nameToCode = new Map();
  try {
    const display = new Intl.DisplayNames(["en"], { type: "region" });
    // ISO 3166-1 alpha-2 codes (A-Z x A-Z, filtered to valid ones)
    for (let i = 65; i <= 90; i++) {
      for (let j = 65; j <= 90; j++) {
        const code = String.fromCharCode(i) + String.fromCharCode(j);
        try {
          const name = display.of(code);
          if (name && name !== code) {
            nameToCode!.set(name.toLowerCase(), code);
          }
        } catch {
          // skip invalid codes
        }
      }
    }
  } catch {
    // Intl.DisplayNames not supported
  }
  return nameToCode;
}

function codeToFlagEmoji(code: string): string {
  // Regional Indicator Symbol A starts at U+1F1E6
  const offset = 0x1f1e6 - 65;
  return (
    String.fromCodePoint(code.charCodeAt(0) + offset) +
    String.fromCodePoint(code.charCodeAt(1) + offset)
  );
}

// Manual overrides for names that differ from Intl.DisplayNames
const OVERRIDES: Record<string, string> = {
  "united states": "US",
  "united kingdom": "GB",
  "south korea": "KR",
  "north korea": "KP",
  "russia": "RU",
  "taiwan": "TW",
  "iran": "IR",
  "syria": "SY",
  "vietnam": "VN",
  "czech republic": "CZ",
  "tanzania": "TZ",
  "bolivia": "BO",
  "laos": "LA",
  "moldova": "MD",
  "palestine": "PS",
};

export function getCountryFlag(name: string): string {
  if (!name) return "";
  const lower = name.trim().toLowerCase();
  const code = OVERRIDES[lower] ?? buildNameToCode().get(lower);
  if (!code) return "";
  return codeToFlagEmoji(code);
}

// US states -> the US flag. Both 2-letter abbreviations (a token like "MD" is a
// US state in this product, not Moldova) and full names (cards store either
// "CA" or "California" / "Dayton, Nevada").
const US_STATE_ABBR = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN",
  "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV",
  "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN",
  "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC", "PR",
]);
const US_STATE_NAMES = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
  "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
  "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
  "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada",
  "new hampshire", "new jersey", "new mexico", "new york", "north carolina",
  "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island",
  "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "west virginia", "wisconsin", "wyoming",
  "district of columbia", "washington dc", "washington, d.c.", "puerto rico",
]);

function isUsState(region: string): boolean {
  return US_STATE_ABBR.has(region.trim().toUpperCase()) || US_STATE_NAMES.has(region.trim().toLowerCase());
}

/**
 * Resolve a flag emoji from a marketplace location string. Handles the shapes
 * cards use: "CA" / "California" / "Dayton, Nevada" (US -> 🇺🇸), "South Africa" /
 * "Taiwan" (country), and "City, Country" (uses the last comma segment). Returns
 * "" when nothing matches so callers can omit the flag cleanly.
 */
export function getLocationFlag(location?: string | null): string {
  if (!location) return "";
  const parts = location.split(",").map((s) => s.trim()).filter(Boolean);
  const region = (parts.length ? parts[parts.length - 1] : location.trim());
  if (isUsState(region)) return getCountryFlag("United States");
  const direct = getCountryFlag(region);
  if (direct) return direct;
  // Strip parenthetical suffixes like "Taiwan (R.O.C.)" and retry.
  const cleaned = region.replace(/\(.*?\)/g, "").trim();
  if (cleaned && cleaned !== region) {
    const f = getCountryFlag(cleaned);
    if (f) return f;
  }
  return getCountryFlag(location.trim());
}

/** Converts a country name (e.g. "United States") to an ISO 3166-1 alpha-2 code (e.g. "US"). */
export function countryNameToIsoCode(name: string): string | null {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  return OVERRIDES[lower] ?? buildNameToCode().get(lower) ?? null;
}

/**
 * Compact display name for a country, optimized for tight UI chips (e.g. the
 * country badge in the provider costs program rows where horizontal space is
 * fought for by the toggles, totals, and action icons).
 *
 * Returns common abbreviations for the long multi-word names that are most
 * common in this product (United States, United Kingdom, UAE), and the
 * original name for everything else so we don't accidentally hide useful
 * detail for less-common countries.
 */
const SHORT_NAMES: Record<string, string> = {
  "united states": "USA",
  "united states of america": "USA",
  "united kingdom": "UK",
  "great britain": "UK",
  "united arab emirates": "UAE",
  "dominican republic": "DR",
  "czech republic": "Czechia",
  "south korea": "S. Korea",
  "north korea": "N. Korea",
  "russian federation": "Russia",
};
export function getCountryShortName(name: string): string {
  if (!name) return "";
  const lower = name.trim().toLowerCase();
  return SHORT_NAMES[lower] ?? name;
}
