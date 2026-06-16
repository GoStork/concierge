const COUNTRY_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bUnited States of America\b/gi, "USA"],
  [/\bUnited States\b/gi, "USA"],
  [/\bUnited Kingdom\b/gi, "UK"],
  [/\bUnited Arab Emirates\b/gi, "UAE"],
  [/\bTaiwan,?\s*Republic of China\b/gi, "Taiwan"],
  [/\bTaiwan\s*\(\s*R\.?\s*O\.?\s*C\.?\s*\)/gi, "Taiwan"],
  [/\bRepublic of China\b/gi, "Taiwan"],
];

export function formatLocationDisplay(location: string | null | undefined): string | null {
  if (!location) return null;
  let out = String(location);
  for (const [re, abbr] of COUNTRY_ABBREVIATIONS) {
    out = out.replace(re, abbr);
  }
  // Drop empty comma segments so a missing city doesn't leave a dangling comma
  // (e.g. ", CA" -> "CA", "Ocala, , FL" -> "Ocala, FL").
  out = out
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");
  return out.replace(/\s{2,}/g, " ").trim() || null;
}

export interface ProviderLocationLike {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

// A "state" that's really a country-level token marks a served-region label
// (e.g. "Mid-West, USA"), not a pinnable location - those get dropped when they
// carry no street address.
const REGION_STATE_TOKENS = new Set([
  "usa",
  "us",
  "u.s.",
  "u.s.a.",
  "united states",
  "united states of america",
]);

// A provider's location list often mixes precise street addresses with coarse,
// address-less city/region entries (e.g. a "Los Angeles, CA" or "Mid-West, USA"
// line alongside a full "21300 Victory Blvd. #760, Woodland Hills, CA" address).
// We drop a coarse, address-less entry when either:
//   1. its state is already pinned by another entry that DOES carry a street
//      address (so "Los Angeles, CA" is redundant once a CA address exists), or
//   2. its "state" is a country-level token like "USA" - a served-region label
//      ("Mid-West, USA") rather than a real, pinnable location.
// Coarse entries with a real, otherwise-uncovered state are kept (they convey a
// place no street address represents). Order is preserved. Shared by the
// provider profile page and the marketplace swipe cards so the same
// de-duplication runs everywhere a location list is rendered.
export function dedupeProviderLocations<T extends ProviderLocationLike>(locations: T[]): T[] {
  if (!Array.isArray(locations)) return [];
  const hasAddress = (l: ProviderLocationLike) => !!(l.address && l.address.trim());
  const norm = (s: string | null | undefined) => (s || "").trim().toLowerCase();
  const statesWithAddress = new Set(
    locations.filter(hasAddress).map((l) => norm(l.state)).filter(Boolean),
  );
  return locations.filter((l) => {
    if (hasAddress(l)) return true;
    const st = norm(l.state);
    if (REGION_STATE_TOKENS.has(st)) return false;
    return !(st && statesWithAddress.has(st));
  });
}
