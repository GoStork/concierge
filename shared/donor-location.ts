/**
 * Donor / surrogate location - ONE resolver shared by the sync writer, the
 * marketplace filter and the card display.
 *
 * Scrapers routinely persist only the state into the `location` scalar ("FL")
 * while the full "Ocala, FL" survives in profileData ("Location" / "Current
 * City"). Display code recovered the city; the FILTER did not, so a city filter
 * matched nothing and the donor vanished from her own search - even though her
 * card and profile both read "Ocala, FL". Everything resolves through here now
 * so the two can never drift again.
 */

// US states. Both 2-letter abbreviations (a token like "MD" is a US state in
// this product, not Moldova) and full names - sources store either.
export const US_STATE_ABBR = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN",
  "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV",
  "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN",
  "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC", "PR",
]);
export const US_STATE_NAMES = new Set([
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

export function isUsState(region: string): boolean {
  return US_STATE_ABBR.has(region.trim().toUpperCase()) || US_STATE_NAMES.has(region.trim().toLowerCase());
}

// Placeholders sources leave behind when they have no location at all. Treated
// as "no value" so a real city always wins over them.
const JUNK_LOCATIONS = new Set(["", "-", "--", "---", ".", "..", "n/a", "n\\a", "na", "none", "null", "unknown", "tbd"]);

export function isJunkLocation(value: unknown): boolean {
  if (typeof value !== "string") return true;
  return JUNK_LOCATIONS.has(value.trim().toLowerCase());
}

/**
 * Build a clean "City, State" label from a raw source value. `raw` is the richer
 * source (e.g. profileData "Location" = "Hemet CA | $70,000" or "Bakersfield,
 * CA"); `fallbackState` is the sparse stored value (e.g. "CA"). Strips the
 * "| $comp" suffix, inserts a missing comma before a trailing state abbreviation
 * ("Hemet CA" -> "Hemet, CA"), and appends the known state to a city-only value
 * ("South Lyon" + "MI" -> "South Lyon, MI"). Falls back to the stored value when
 * nothing richer is available.
 *
 * `isCountryName` guards the city-only branch so a country ("Mexico") never gets
 * a US state stapled to it. Callers with a country table pass one in; the
 * default is conservative and simply skips that branch's country check.
 */
export function normalizeCityState(
  raw: string | null | undefined,
  fallbackState?: string | null,
  isCountryName?: (value: string) => boolean,
): string | null {
  const fallback = (fallbackState || "").trim();
  if (!raw || typeof raw !== "string") return fallback || null;
  let s = raw.split("|")[0].trim();
  if (!s) return fallback || null;
  if (!s.includes(",")) {
    const words = s.split(/\s+/);
    const last = words[words.length - 1];
    if (words.length > 1 && US_STATE_ABBR.has(last.toUpperCase())) {
      s = `${words.slice(0, -1).join(" ")}, ${last.toUpperCase()}`;
    } else if (
      !isUsState(s) && !(isCountryName ? isCountryName(s) : false) &&
      fallback && s.toLowerCase() !== fallback.toLowerCase()
    ) {
      // City-only value plus a known state -> "City, State".
      s = `${s}, ${fallback}`;
    }
  }
  return s;
}

// profileData keys that carry the donor's CURRENT location. "Place of Birth" is
// deliberately absent - where someone was born is not where they live.
const LOCATION_KEYS = ["Location", "Current City", "City"];

/**
 * Every location string a profile carries, richest first: the top-level keys,
 * then the same keys inside any `_sections` block (the shape the scrapers
 * write - e.g. _sections["Basic Information"]["Current City"]).
 */
export function collectLocationCandidates(profileData: any): string[] {
  const pd = profileData && typeof profileData === "object" ? profileData : null;
  if (!pd) return [];
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== "string" || isJunkLocation(v)) return;
    const t = v.trim();
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  for (const key of LOCATION_KEYS) push(pd[key]);
  const sections = pd._sections;
  if (sections && typeof sections === "object" && !Array.isArray(sections)) {
    for (const section of Object.values(sections)) {
      if (!section || typeof section !== "object" || Array.isArray(section)) continue;
      for (const key of LOCATION_KEYS) push((section as any)[key]);
    }
  }
  return out;
}

/**
 * The value that BELONGS in the `location` scalar: the stored value, upgraded to
 * a "City, State" from profileData when the scalar lost the city (or is junk).
 * Deliberately conservative - it only overwrites to gain a city, never to swap
 * "AL" for "Alabama", so re-running it is a no-op.
 */
export function resolveDonorLocation(
  rawLocation: string | null | undefined,
  profileData: any,
  isCountryName?: (value: string) => boolean,
): string | null {
  const scalar = isJunkLocation(rawLocation) ? null : String(rawLocation).trim();
  for (const candidate of collectLocationCandidates(profileData)) {
    const cleaned = normalizeCityState(candidate, scalar, isCountryName);
    if (!cleaned || isJunkLocation(cleaned)) continue;
    if (!scalar) return cleaned;
    if (cleaned.toLowerCase() === scalar.toLowerCase()) continue;
    if (cleaned.includes(",") && !scalar.includes(",")) return cleaned;
  }
  return scalar;
}

/**
 * Every location string a record can be MATCHED against: the scalar plus each
 * profileData candidate. Filtering unions them so a city filter still works on
 * rows whose scalar is state-only (manually-edited rows the backfill skips, and
 * anything a future scraper drops the city on).
 */
export function donorLocationHaystack(record: any): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== "string" || isJunkLocation(v)) return;
    const t = v.trim();
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  push(record?.location);
  push(record?.displayLocation);
  for (const c of collectLocationCandidates(record?.profileData)) push(c);
  // Last resort only: a birth place is better than matching nothing at all,
  // but it must never outrank a real current-location value.
  if (out.length === 0) {
    const pd = record?.profileData;
    if (pd && typeof pd === "object") {
      push(pd["Place of Birth"]);
      const sections = pd._sections;
      if (sections && typeof sections === "object" && !Array.isArray(sections)) {
        for (const section of Object.values(sections)) {
          if (section && typeof section === "object" && !Array.isArray(section)) push((section as any)["Place of Birth"]);
        }
      }
    }
  }
  return out;
}

/**
 * Word-boundary containment. Substring matching turned "Flagstaff, AZ" into a
 * Florida match (the "FL" term) and "Irvine" into an Indiana one - state
 * abbreviations are two letters and hide inside ordinary city names.
 */
export function locationTermMatches(haystack: string, term: string): boolean {
  const h = haystack.toLowerCase();
  const t = term.trim().toLowerCase();
  if (!h || !t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(h);
}
