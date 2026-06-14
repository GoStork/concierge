// Same-person name-variant detection for clinic doctor rosters.
//
// A scraped roster + SART roster + CDC medical-director fallback can list the
// SAME doctor under different name forms - "Jeff McKeeby M.D." vs "Jeffrey L.
// McKeeby" - which the exact-key dedup (normalizeMemberKey) misses because the
// first names normalize differently ("jeff" vs "jeffrey"). This module clusters
// such variants so callers can collapse them.
//
// Shared by mergeTeamMembers (live enrichment) and the dedup-doctor-names cleanup
// script so both use identical matching - no forked logic.

// Common short-form -> formal first names where a prefix test alone misses
// (the nickname doesn't start with the formal name). Deliberately omits
// ambiguous stems that map to multiple distinct names (chris -> christopher OR
// christine; pat -> patrick OR patricia; sam -> samuel OR samantha; alex ->
// alexander OR alexandra) so we never merge two different people.
const NICKNAMES: Record<string, string> = {
  bill: "william", billy: "william", will: "william", liam: "william",
  bob: "robert", bobby: "robert", rob: "robert", robby: "robert",
  dick: "richard", rick: "richard", ricky: "richard", rich: "richard",
  jim: "james", jimmy: "james", jamie: "james",
  tom: "thomas", tommy: "thomas",
  mike: "michael", mickey: "michael",
  dave: "david",
  joe: "joseph", joey: "joseph",
  jack: "john", johnny: "john",
  ben: "benjamin", benny: "benjamin",
  tony: "anthony",
  ed: "edward", eddie: "edward", ted: "edward", teddy: "edward",
  fred: "frederick", freddie: "frederick",
  greg: "gregory",
  ken: "kenneth", kenny: "kenneth",
  larry: "lawrence",
  matt: "matthew",
  nick: "nicholas",
  ron: "ronald", ronnie: "ronald",
  steve: "stephen",
  andy: "andrew", drew: "andrew",
  charlie: "charles", chuck: "charles",
  hank: "henry",
  harry: "harold",
  betty: "elizabeth", beth: "elizabeth", liz: "elizabeth", lizzie: "elizabeth", eliza: "elizabeth",
  peggy: "margaret", maggie: "margaret", meg: "margaret",
  kathy: "katherine", kate: "katherine", katie: "katherine", cathy: "katherine",
  sue: "susan", susie: "susan",
  abby: "abigail",
  becky: "rebecca",
  cindy: "cynthia",
  deb: "deborah", debbie: "deborah", debra: "deborah",
  jen: "jennifer", jenny: "jennifer", jenn: "jennifer",
  jess: "jessica", jessie: "jessica",
  judy: "judith",
  kim: "kimberly",
  sandy: "sandra",
  vicky: "victoria", vickie: "victoria",
  tina: "christina",
  trish: "patricia",
  gus: "augustine",
};

const CREDENTIALS = new Set([
  "md", "do", "phd", "mba", "msc", "ms", "mph", "msce", "mscr", "msctr", "mscr",
  "rn", "np", "pa", "facs", "facog", "hcld", "ts", "eld", "dnp", "msn", "fnp",
  "dds", "dmd", "mbbs", "frcsc", "frcog", "mrmed", "mha", "rd", "lcsw", "psyd",
  "jr", "sr", "ii", "iii", "iv", "esq",
]);

const TITLES = /\b(dr|doctor|mr|mrs|ms|prof|professor)\.?\b/gi;

/**
 * Reduce a raw name to its first + last name tokens, stripping titles,
 * credentials, accents, middle initials, and punctuation. Handles both
 * "First Last" and "Last, First" (SART) orderings.
 */
export function parsePersonName(raw: string): { first: string; last: string } {
  const base = (raw || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(TITLES, " ");

  const commaIdx = base.indexOf(",");
  let firstSide = base;
  let lastSide = "";
  // "Last, First M." -> last name is before the comma, first name(s) after.
  if (commaIdx > 0) {
    lastSide = base.slice(0, commaIdx);
    firstSide = base.slice(commaIdx + 1);
  }

  const toTokens = (s: string) =>
    s.toLowerCase().split(/[^a-z]+/).filter(t => t.length >= 2 && !CREDENTIALS.has(t));

  if (commaIdx > 0) {
    const firsts = toTokens(firstSide);
    const lasts = toTokens(lastSide);
    return { first: firsts[0] || "", last: lasts[lasts.length - 1] || "" };
  }

  const tokens = toTokens(base);
  if (tokens.length === 0) return { first: "", last: "" };
  if (tokens.length === 1) return { first: tokens[0], last: "" };
  return { first: tokens[0], last: tokens[tokens.length - 1] };
}

/** Two first names refer to the same person: equal, a >=3-char prefix of the
 * other (jeff/jeffrey, rob/robert), a bare initial of the other (j/john), or a
 * known nickname pair (bill/william). */
export function firstNamesCompatible(f1: string, f2: string): boolean {
  if (!f1 || !f2) return false;
  if (f1 === f2) return true;
  const [short, long] = f1.length <= f2.length ? [f1, f2] : [f2, f1];
  // Bare initial: "j" matches "john".
  if (short.length === 1) return long.startsWith(short);
  // Prefix: shorter must be a real stem (>=3) to avoid "jo" eating everything.
  if (short.length >= 3 && long.startsWith(short)) return true;
  // Nickname map (resolve both to their formal form, then compare).
  const r1 = NICKNAMES[f1] || f1;
  const r2 = NICKNAMES[f2] || f2;
  if (r1 === r2) return true;
  if (r1 === f2 || r2 === f1) return true;
  return false;
}

/** Same person if last names match exactly and first names are compatible. A
 * last name is REQUIRED on both sides - we never merge on first name alone. */
export function isSamePerson(a: string, b: string): boolean {
  const pa = parsePersonName(a);
  const pb = parsePersonName(b);
  if (!pa.last || !pb.last) return false;
  if (pa.last !== pb.last) return false;
  return firstNamesCompatible(pa.first, pb.first);
}

/**
 * Pick the best DISPLAY name among a cluster of same-person variants: the fullest
 * (most name tokens, e.g. a real middle name), with the longest given name
 * ("Jeffrey" over "Jeff"), penalizing title prefixes ("Dr."), trailing
 * credentials ("M.D."), and all-caps / all-lowercase forms.
 */
export function pickBestDisplayName(names: string[]): string {
  const score = (raw: string): number => {
    const noDots = raw.toLowerCase().replace(/\./g, "");
    const titleCt = (raw.match(/\b(dr|doctor|mr|mrs|ms|prof|professor)\b/gi) || []).length;
    const credCt = (noDots.match(/\b(md|do|phd|mba|msc|ms|mph|msce|mscr|msctr|rn|np|pa|facs|facog|hcld|dds|dmd|mbbs|frcsc|frcog|jr|sr|ii|iii|iv)\b/g) || []).length;
    const tokens = noDots
      .replace(/\b(dr|doctor|mr|mrs|ms|prof|professor)\b/g, " ")
      .split(/[^a-z]+/).filter(t => t.length >= 2 && !CREDENTIALS.has(t));
    const badCase = (raw === raw.toUpperCase() || raw === raw.toLowerCase()) ? 1 : 0;
    return tokens.length * 10 + parsePersonName(raw).first.length * 2 - titleCt * 3 - credCt * 3 - badCase * 2;
  };
  return [...names].sort((a, b) => score(b) - score(a) || b.length - a.length)[0];
}

/**
 * Cluster a list of names so every entry that refers to the same person lands in
 * the same group. Returns groups of indices into the input array (every index
 * appears in exactly one group; singletons included). O(n^2) - fine for a single
 * clinic's roster.
 */
export function clusterPersonVariants(names: string[]): number[][] {
  const parent = names.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };

  const parsed = names.map(parsePersonName);
  for (let i = 0; i < names.length; i++) {
    if (!parsed[i].last) continue;
    for (let j = i + 1; j < names.length; j++) {
      if (!parsed[j].last) continue;
      if (parsed[i].last === parsed[j].last && firstNamesCompatible(parsed[i].first, parsed[j].first)) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < names.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }
  return Array.from(groups.values());
}
