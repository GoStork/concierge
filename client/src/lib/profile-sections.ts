/**
 * The order a donor or surrogate profile's sections are read in.
 *
 * This replaced a three-band model (at a glance / in her own words / medical &
 * background) that sorted by the KIND of content. That was the wrong axis: it
 * treated "medical" as due diligence to hand a doctor later, and pushed it to
 * the bottom - when a surrogate's pregnancy history and an egg donor's donation
 * history are the first things a parent actually needs. The bands were tidy and
 * they buried the decision.
 *
 * So the order is now an explicit priority list per profile type, in the words
 * of someone choosing one. Anything unlisted keeps its source order and follows
 * - the agency chose that order and re-sorting inside the tail would scramble
 * question/answer pairs that read as a sequence.
 *
 * There are no headings. A priority list does not need labelling: the sections
 * already carry their own names, and a heading over "Pregnancy History" only
 * repeats it.
 */

export type ProfileKind = "surrogate" | "egg-donor" | "sperm-donor";

const MEDICAL = /medical|health|surger|medication|diagnos|allerg|infection|vaccin|screening|lab\b/i;
const LETTER = /letter|message\s*to|own\s*words|personal\s*statement|my\s*story/i;

/**
 * Ranked patterns, most important first. The first pattern a section name
 * matches gives it its rank; unmatched sections rank last.
 *
 * Deliberately loose: scrapers emit "Pregnancy History", "Pregnancies",
 * "Previous Pregnancies" and "Birth History" for the same thing, and a section
 * that fails to match does not disappear - it just falls to the tail.
 */
/** A rank is matched by a pattern, optionally excluding names another rank owns. */
type Rule = { match: RegExp; not?: RegExp };

const PRIORITY: Record<ProfileKind, Rule[]> = {
  surrogate: [
    { match: /pregnan|deliver|birth|c-?section/i },
    { match: MEDICAL, not: /famil/i },
    { match: /support\s*system|significant\s*other|spouse|partner/i },
    { match: LETTER },
  ],
  "egg-donor": [
    { match: /donation|donor\s*histor|previous\s*cycle|retriev/i },
    // "Family Medical History" is a family section, not a medical one - without
    // the exclusion it matched MEDICAL first and tied with her own history.
    { match: MEDICAL, not: /famil/i },
    { match: /famil/i },
    { match: LETTER },
    { match: /education|school|degree|academic/i },
  ],
  // Sperm donors are bank profiles: medical screening and family history are
  // the whole substance, and there is rarely a letter to speak of.
  "sperm-donor": [
    { match: MEDICAL, not: /famil/i },
    { match: /famil/i },
    { match: /donation|donor\s*histor/i },
    { match: /education|school|degree|academic/i },
  ],
};

/** Lower is earlier. Unranked sections share the last rank and keep source order. */
export function sectionRank(name: string, kind: ProfileKind): number {
  const n = (name || "").replace(/^__|__$/g, "").replace(/_/g, " ");
  const patterns = PRIORITY[kind] || PRIORITY["egg-donor"];
  const i = patterns.findIndex((r) => r.match.test(n) && !(r.not && r.not.test(n)));
  return i === -1 ? patterns.length : i;
}

/** True when the priority list actually names this section, rather than it just falling to the tail. */
export function isRankedSection(name: string, kind: ProfileKind): boolean {
  return sectionRank(name, kind) < (PRIORITY[kind] || PRIORITY["egg-donor"]).length;
}

/**
 * Order the profile's sections for this kind of profile.
 *
 * A stable sort by rank: sections that rank the same - including everything
 * unranked - stay in the order the agency published them.
 */
export function orderProfileSections(sectionNames: string[], kind: ProfileKind): string[] {
  return sectionNames
    .map((name, i) => ({ name, i, rank: sectionRank(name, kind) }))
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
    .map((x) => x.name);
}
