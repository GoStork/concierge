import { sectionRank, isRankedSection, type ProfileKind } from "@/lib/profile-sections";
import { formatFieldLabel, isPlaceholderValue } from "@/lib/format-label";

/**
 * The substantive rows of a comparison, pulled from the profile's own sections.
 *
 * The comparison used to read only the scalar columns - cost, age, height, eye
 * colour - which is everything a parent can already see on the card. The things
 * that actually decide between two surrogates (how many times she has carried,
 * how those pregnancies went, whether she has support at home) live in
 * `profileData` sections and were absent entirely.
 *
 * Sections are ordered by the SAME priority used on the profile page, so the
 * comparison and the profile agree about what matters: pregnancy history first
 * for a surrogate, donation history first for a donor.
 *
 * Nothing is capped. A comparison exists to be exhaustive - a parent who has
 * narrowed to four people wants every difference, and silently trimming to a
 * tidy number would hide exactly the detail they opened it for.
 */

export type CompareCell = { group: string; label: string; value: string | null };

/** One profile's comparable answers, in priority order. */
export function compareCellsFromProfile(profileData: any, kind: ProfileKind): CompareCell[] {
  if (!profileData || typeof profileData !== "object") return [];

  const sections = Object.entries(profileData)
    .filter(([name, data]) => data && typeof data === "object" && !Array.isArray(data) && !name.startsWith("_"))
    .map(([name, data], i) => ({ name, data: data as Record<string, any>, i, rank: sectionRank(name, kind) }))
    // Only sections the priority list actually names. Everything else is
    // already on the card or is not a basis for choosing between people.
    .filter((s) => isRankedSection(s.name, kind))
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i));

  const cells: CompareCell[] = [];
  for (const section of sections) {
    for (const [key, raw] of Object.entries(section.data)) {
      if (key.startsWith("_")) continue;
      if (raw && typeof raw === "object") continue;   // nested tables render on the profile, not here
      if (isPlaceholderValue(raw)) continue;
      const value = String(raw).trim();
      // A whole letter does not compare in a table cell - it is read, not scanned.
      if (value.length > 220) continue;
      cells.push({ group: formatFieldLabel(section.name), label: formatFieldLabel(key), value });
    }
  }
  return cells;
}

/**
 * Merge several profiles' cells into ordered groups of rows.
 *
 * A row appears if ANY profile answers it - a gap where one of them said
 * nothing is itself a difference a parent should see, and blanking the row
 * would hide that.
 */
export function mergeCompareCells(perProfile: CompareCell[][]): { group: string; rows: { label: string; values: (string | null)[] }[] }[] {
  const order: string[] = [];
  const groups = new Map<string, { labels: string[]; byKey: Map<string, (string | null)[]> }>();

  perProfile.forEach((cells, idx) => {
    for (const cell of cells) {
      if (!groups.has(cell.group)) { groups.set(cell.group, { labels: [], byKey: new Map() }); order.push(cell.group); }
      const g = groups.get(cell.group)!;
      if (!g.byKey.has(cell.label)) { g.byKey.set(cell.label, new Array(perProfile.length).fill(null)); g.labels.push(cell.label); }
      g.byKey.get(cell.label)![idx] = cell.value;
    }
  });

  return order.map((group) => {
    const g = groups.get(group)!;
    return { group, rows: g.labels.map((label) => ({ label, values: g.byKey.get(label)! })) };
  });
}
