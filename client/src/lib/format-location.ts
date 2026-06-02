const COUNTRY_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bUnited States of America\b/gi, "USA"],
  [/\bUnited States\b/gi, "USA"],
  [/\bUnited Kingdom\b/gi, "UK"],
  [/\bUnited Arab Emirates\b/gi, "UAE"],
];

export function formatLocationDisplay(location: string | null | undefined): string | null {
  if (!location) return null;
  let out = String(location);
  for (const [re, abbr] of COUNTRY_ABBREVIATIONS) {
    out = out.replace(re, abbr);
  }
  return out;
}
