// The `zipcodes` package ships no types. Only the surface server/src/lib/geo.ts
// uses is declared here; widen it if another call site needs more.
declare module "zipcodes" {
  export interface ZipRecord {
    zip: string;
    latitude: number;
    longitude: number;
    city: string;
    state: string;
    country: string;
  }
  export function lookup(zip: string | number): ZipRecord | undefined;
  export function lookupByName(city: string, state: string): ZipRecord[];
  export function distance(zipA: string, zipB: string): number | null;
  const _default: {
    lookup: typeof lookup;
    lookupByName: typeof lookupByName;
    distance: typeof distance;
  };
  export default _default;
}
