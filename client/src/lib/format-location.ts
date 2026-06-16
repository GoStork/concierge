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
  return out.replace(/\s{2,}/g, " ").trim();
}

export interface ProviderLocationLike {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

// A provider's location list often mixes precise street addresses with coarse,
// address-less city/region entries (e.g. a "Los Angeles, CA" or "Mid-West, USA"
// line alongside a full "21300 Victory Blvd. #760, Woodland Hills, CA" address).
// When a coarse entry shares its state with another entry that DOES carry a
// street address, it's a redundant duplicate of an area already pinned - drop
// it. Coarse entries whose state isn't covered by any precise address are kept
// (they convey a region no street address represents). Order is preserved.
// Shared by the provider profile page and the marketplace swipe cards so the
// same de-duplication runs everywhere a location list is rendered.
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
    return !(st && statesWithAddress.has(st));
  });
}
