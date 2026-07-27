/**
 * The three reading bands a donor or surrogate profile is organised into.
 *
 * A profile answers three different questions and used to present all three at
 * one weight, in whatever order the scraper emitted: 31 medical answers carried
 * the same visual authority as her letter. Parents decide in band 1, commit in
 * band 2, and hand band 3 to their doctor - so that is the order.
 *
 * Band 3 stays fully visible (Eran's call) - moved down, not hidden.
 *
 * Extracted from profile-detail-page so the ordering can be tested directly:
 * it is the one part of the band work that a regression could silently undo
 * (a new section name matching the wrong pattern reads as "the scraper changed",
 * not "the page reordered itself").
 */

export type Band = 1 | 2 | 3;

const BAND_PERSONAL_PATTERN =
  /(letter|things\s*about\s*me|about\s*me|general\s*interests|interests|hobbies|favorites?|personal\s*statement|support\s*system|agency\s*comment|significant\s*other|my\s*story|in\s*her\s*own\s*words|message\s*to)/i;
const BAND_DILIGENCE_PATTERN =
  /(medical|health|histor|pregnanc|donation|famil|genetic|screening|surger|medication|diagnos|allerg|infection|vaccin|lab\b)/i;

/** 1 = is this a fit, 2 = who she is, 3 = due diligence. */
export function sectionBand(name: string): Band {
  const n = (name || "").replace(/^__|__$/g, "").replace(/_/g, " ");
  if (BAND_PERSONAL_PATTERN.test(n)) return 2;
  if (BAND_DILIGENCE_PATTERN.test(n)) return 3;
  return 1;
}

export const BAND_LABEL: Record<Band, string> = {
  1: "At a glance",
  2: "In her own words",
  3: "Medical & background",
};

export const BAND_MARKER = /^__BAND_([123])__$/;

/**
 * Sort sections into band order and insert a `__BAND_n__` marker before the
 * first section of each band. Order WITHIN a band is the source order - the
 * agency chose it, and re-sorting inside a band would scramble question/answer
 * pairs that read as a sequence.
 *
 * Only bands that actually have sections get a heading; an empty band heading
 * reads to a parent as missing data rather than as an absent category.
 */
export function orderSectionsIntoBands(sectionNames: string[]): string[] {
  const sorted = sectionNames
    .map((name, i) => ({ name, i, band: sectionBand(name) }))
    .sort((a, b) => (a.band - b.band) || (a.i - b.i))
    .map((x) => x.name);

  const out: string[] = [];
  let lastBand: Band | null = null;
  for (const name of sorted) {
    const band = sectionBand(name);
    if (band !== lastBand) {
      out.push(`__BAND_${band}__`);
      lastBand = band;
    }
    out.push(name);
  }
  return out;
}
