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

/** Converts a country name (e.g. "United States") to an ISO 3166-1 alpha-2 code (e.g. "US"). */
export function countryNameToIsoCode(name: string): string | null {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  return OVERRIDES[lower] ?? buildNameToCode().get(lower) ?? null;
}
