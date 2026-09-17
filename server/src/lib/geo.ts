/**
 * Offline geocoding + distance for provider locations.
 *
 * Built because "that's too far" had nowhere to land: the concierge could
 * filter clinics by state or city name, but never by how far a clinic actually
 * is from the parent. A parent in Manhattan asking for a New York clinic was
 * correctly offered one 193 miles away in Syracuse, and had no way to say so in
 * a way the search could act on.
 *
 * Deliberately offline (the `zipcodes` US dataset) rather than a geocoding API:
 * no key to rotate, no per-call cost or latency on a search turn, and the test
 * suite gets the same answers every run. The tradeoff is that coverage is US
 * only - a non-US location returns null and callers must treat that as "cannot
 * filter by distance", never as "zero miles away".
 */
import zipcodes from "zipcodes";

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface GeocodeInput {
  zip?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

const EARTH_RADIUS_MILES = 3958.7613;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in miles. */
export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

function isUsCountry(country?: string | null): boolean {
  if (!country) return true; // our rows are overwhelmingly US and often leave it blank
  return /^(us|usa|united states)/i.test(String(country).trim());
}

const US_STATE_BY_NAME: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY", "puerto rico": "PR",
};

/** "New York" -> "NY"; "ny" -> "NY"; anything else -> null. */
export function normalizeUsState(state?: string | null): string | null {
  const s = String(state ?? "").trim();
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return US_STATE_BY_NAME[s.toLowerCase()] ?? null;
}

/**
 * Resolve a place to a point. ZIP wins when we have one (it is the most precise
 * thing we store); otherwise the city centroid, averaged over that city's ZIPs
 * so a sprawling city does not resolve to whichever ZIP happens to sort first.
 * Returns null when the place is not a US place we can resolve - callers must
 * skip distance filtering rather than guess.
 */
export function geocodePlace(input: GeocodeInput): (GeoPoint & { source: "zip" | "city" }) | null {
  if (!isUsCountry(input.country)) return null;

  const zip = String(input.zip ?? "").trim().match(/\b\d{5}\b/)?.[0];
  if (zip) {
    const hit = zipcodes.lookup(zip);
    if (hit?.latitude != null && hit?.longitude != null) {
      return { latitude: hit.latitude, longitude: hit.longitude, source: "zip" };
    }
  }

  const city = String(input.city ?? "").trim();
  const state = normalizeUsState(input.state);
  if (!city || !state) return null;
  const matches = zipcodes.lookupByName(city, state) || [];
  const points = matches.filter((m: any) => m?.latitude != null && m?.longitude != null);
  if (points.length === 0) return null;
  const latitude = points.reduce((t: number, m: any) => t + m.latitude, 0) / points.length;
  const longitude = points.reduce((t: number, m: any) => t + m.longitude, 0) / points.length;
  return { latitude, longitude, source: "city" };
}

/** Distance between two places, or null when either side cannot be resolved. */
export function milesBetweenPlaces(a: GeocodeInput, b: GeocodeInput): number | null {
  const pa = geocodePlace(a);
  const pb = geocodePlace(b);
  if (!pa || !pb) return null;
  return haversineMiles(pa, pb);
}
