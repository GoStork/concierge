// Donor / surrogate / sperm-donor free-text search, shared by the client's
// omniSearch and the marketplace list endpoints.
//
// Why it is shared: donor search used to run ONLY in the browser. The list
// endpoints had no `search` param, so the client pulled the whole table 100 rows
// at a time and filtered locally - and because DonorGrid auto-loaded another
// page whenever fewer than 12 profiles matched, any specific search (a donor id,
// a name) walked all ~16 pages one sequential request at a time. That is the
// 15-second search.
//
// The fix is to narrow server-side. The contract is deliberately one-directional:
//
//   the server filter must return a SUPERSET of what omniSearch accepts.
//
// The client still runs omniSearch over what comes back, so it remains the
// single source of truth for what "matches" - the server only avoids shipping
// (and paging through) rows that could never match. A field added to omniSearch
// without being added here would silently drop results, so both live in this
// file, side by side.

export const ETHNICITY_SYNONYMS: Record<string, string[]> = {
  "white": ["white", "caucasian"],
  "caucasian": ["caucasian", "white"],
  "black": ["black", "african american", "african"],
  "african american": ["african american", "black", "african"],
  "african": ["african", "black", "african american"],
  "hispanic": ["hispanic", "latino", "latina"],
  "latino": ["latino", "latina", "hispanic"],
  "latina": ["latina", "latino", "hispanic"],
  "middle eastern": ["middle eastern", "arab", "arabic"],
  "arab": ["arab", "arabic", "middle eastern"],
  "mixed": ["mixed", "biracial", "multiracial"],
  "biracial": ["biracial", "mixed", "multiracial"],
  "multiracial": ["multiracial", "mixed", "biracial"],
};

export function resolveEthnicityTerms(val: string): string[] {
  const lower = val.toLowerCase().trim();
  return ETHNICITY_SYNONYMS[lower] || [lower];
}

/**
 * Scalar columns omniSearch scans. Every one of these exists on EggDonor,
 * Surrogate AND SpermDonor except where noted, so the same clause works for all
 * three lists.
 *
 * omniSearch also reads donor.interests and donor.eggType - neither is a column
 * on any of the three models, so those branches never match a real row and have
 * nothing to mirror here.
 */
const COMMON_TEXT_FIELDS = [
  "firstName", "lastName", "location", "ethnicity", "race",
  "education", "occupation", "religion", "externalId", "relationshipStatus",
] as const;

// Present on EggDonor + SpermDonor, absent on Surrogate.
const DONOR_ONLY_TEXT_FIELDS = ["eyeColor", "hairColor", "donorType"] as const;

// Present on EggDonor only.
const EGG_ONLY_TEXT_FIELDS = ["bloodType", "donationTypes"] as const;

export type DonorSearchKind = "egg-donor" | "surrogate" | "sperm-donor";

/**
 * A Prisma `where` fragment matching any row omniSearch could accept for this
 * query. Returns null when there is nothing to narrow by.
 */
export function buildDonorSearchWhere(rawQuery: string | undefined | null, kind: DonorSearchKind): any | null {
  const q = (rawQuery || "").trim();
  if (!q) return null;

  const fields: string[] = [...COMMON_TEXT_FIELDS];
  if (kind !== "surrogate") fields.push(...DONOR_ONLY_TEXT_FIELDS);
  if (kind === "egg-donor") fields.push(...EGG_ONLY_TEXT_FIELDS);

  const or: any[] = fields.map((f) => ({ [f]: { contains: q, mode: "insensitive" } }));

  // The agency / bank name is part of the searchable surface ("Fairfax").
  or.push({ provider: { name: { contains: q, mode: "insensitive" } } });

  // omniSearch reads the location through resolveLocationValue, which falls back
  // to the profileData JSON blob (profileData.Location / _sections[*].Location)
  // whenever the location COLUMN is empty. That blob is not practically
  // filterable in Prisma, so rather than risk dropping a row the client would
  // have matched, every row with no location column stays in and omniSearch
  // decides. It is ~20 rows across all three lists, so it costs nothing.
  or.push({ location: null });
  or.push({ location: "" });

  // Ethnicity synonyms: searching "White" has to reach donors stored as
  // "Caucasian". omniSearch applies a word-boundary test on top of this; a plain
  // contains is broader, which keeps us on the superset side of the contract.
  const synonyms = resolveEthnicityTerms(q);
  if (synonyms.length > 1) {
    for (const term of synonyms) {
      or.push({ ethnicity: { contains: term, mode: "insensitive" } });
      or.push({ race: { contains: term, mode: "insensitive" } });
    }
  }

  return { OR: or };
}
