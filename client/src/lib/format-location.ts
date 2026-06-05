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
