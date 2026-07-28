/**
 * Returns a flag emoji for a given country name using the Unicode Regional Indicator Symbols.
 * Uses Intl.DisplayNames to build a reverse map from country name -> ISO 3166-1 alpha-2 code.
 */

import { US_STATE_ABBR, isUsState, normalizeCityState } from "@shared/donor-location";

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
// "CA" or "California" / "Dayton, Nevada"). The tables live in
// @shared/donor-location so the server's sync writer matches this exactly.

// Full US state name -> 2-letter abbreviation, so locations render consistently
// as "City, ST" (the standard form) regardless of how the source stored them.
const US_STATE_NAME_TO_ABBR: Record<string, string> = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
  "colorado": "CO", "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA",
  "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
  "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
  "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", "tennessee": "TN",
  "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
  "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
  "puerto rico": "PR",
};

/** Returns the 2-letter abbreviation for a US state name or abbrev, else null. */
export function abbreviateUsState(token: string): string | null {
  const t = (token || "").trim();
  if (US_STATE_ABBR.has(t.toUpperCase())) return t.toUpperCase();
  return US_STATE_NAME_TO_ABBR[t.toLowerCase()] ?? null;
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
  // Space-separated "City ST" with no comma (e.g. "Hemet CA"): check the last word.
  const lastWord = region.split(/\s+/).pop() || "";
  if (lastWord !== region && isUsState(lastWord)) return getCountryFlag("United States");
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

/**
 * Build a clean "City, State" label, recovering the city the scraper dropped into
 * the raw profile field. The implementation is @shared/donor-location's
 * `normalizeCityState` (the sync writer and the backfill run the same code); this
 * wrapper only supplies the browser's country table so a country name never gets
 * a US state appended to it.
 */
export function cleanCityState(raw: string | null | undefined, fallbackState?: string | null): string | null {
  return normalizeCityState(raw, fallbackState, (v) => !!getCountryFlag(v));
}

/** Converts a country name (e.g. "United States") to an ISO 3166-1 alpha-2 code (e.g. "US"). */
export function countryNameToIsoCode(name: string): string | null {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  return OVERRIDES[lower] ?? buildNameToCode().get(lower) ?? null;
}

// ISO code -> the canonical country name used across the app (the COUNTRIES
// list in country-autocomplete-input). Only codes whose Intl.DisplayNames
// spelling diverges from ours need an entry; everything else falls through
// to Intl with "&" / "St." normalized.
const CODE_TO_NAME_OVERRIDES: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  KR: "South Korea",
  KP: "North Korea",
  RU: "Russia",
  TW: "Taiwan",
  IR: "Iran",
  SY: "Syria",
  VN: "Vietnam",
  CZ: "Czech Republic",
  TZ: "Tanzania",
  BO: "Bolivia",
  LA: "Laos",
  MD: "Moldova",
  PS: "Palestine",
  TR: "Turkey",
  MM: "Myanmar",
  CV: "Cabo Verde",
  CG: "Congo",
  ST: "Sao Tome and Principe",
  KN: "Saint Kitts and Nevis",
  LC: "Saint Lucia",
  VC: "Saint Vincent and the Grenadines",
};

/** Converts an ISO 3166-1 alpha-2 code (e.g. "US") to the country name used in our pickers (e.g. "United States"). */
export function isoCodeToCountryName(code: string): string | null {
  const c = (code || "").trim().toUpperCase();
  if (c.length !== 2) return null;
  if (CODE_TO_NAME_OVERRIDES[c]) return CODE_TO_NAME_OVERRIDES[c];
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(c);
    if (!name || name === c || name === "Unknown Region") return null;
    return name.replace(/\s*&\s*/g, " and ").replace(/\bSt\./g, "Saint");
  } catch {
    return null;
  }
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
