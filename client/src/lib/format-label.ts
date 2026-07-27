/**
 * Turning a stored key into something a parent can read.
 *
 * Scraped and imported data arrives in whatever shape the source used -
 * camelCase from an API, snake_case from a cost sheet, Title Case from an HTML
 * label. A parent should never see which. This is the single formatter; it was
 * previously duplicated in profile-detail-page and profile-database-panel, and
 * cost line items had no formatting at all, which is how "agency_fee" and
 * "gs_miscellaneous" ended up on a $200,000 quote.
 *
 * It must be safe to run over labels that are ALREADY written for humans, since
 * most are: a naive camelCase split turns "IVF Cycle" into "I V F  Cycle" and
 * "Embryo Transfer (One Cycle)" into "Embryo  Transfer ( One  Cycle)".
 */

/** Words that are initialisms in this domain and should stay upper-case. */
const ACRONYMS = new Set([
  "ivf", "iui", "ici", "pgt", "gs", "npi", "id", "dna", "hiv", "aids", "tb",
  "bmi", "lgbtq", "cdc", "abog", "asrm", "md", "do", "us", "usa", "hcg", "fet",
]);

export function formatFieldLabel(key: string): string {
  const raw = String(key ?? "").trim();
  if (!raw) return "";

  // Only split identifiers. Anything already containing a space was written by
  // a human (or a scraper reading a human label) and keeps its own spacing.
  const spaced = raw.includes(" ")
    ? raw
    : raw
        .replace(/[_-]+/g, " ")
        // camelCase -> camel Case
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        // ACRONYMFollowed -> ACRONYM Followed
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

  return spaced
    .split(/\s+/)
    .map((word) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      // Leave any word the source already capitalised alone - that includes
      // acronyms we don't know about and names like "McKinney".
      if (/[A-Z]/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/**
 * True when a value still looks like a raw identifier rather than a written
 * label - underscores, or camelCase with no spaces. Used to flag cost-sheet
 * rows for the reviewer so the source data gets cleaned, rather than relying on
 * the render-time fallback forever.
 */
export function looksLikeRawKey(key: string): boolean {
  const raw = String(key ?? "").trim();
  if (!raw) return false;
  if (raw.includes("_")) return true;
  return !raw.includes(" ") && /[a-z][A-Z]/.test(raw);
}
