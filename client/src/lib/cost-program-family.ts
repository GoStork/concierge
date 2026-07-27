import type { ProgramCardData, ProgramCardLineItem } from "@/components/cost-sheet-program-card";

/**
 * Grouping several variants of ONE product into a price ladder.
 *
 * PFCLA published four programs - one, two, three and unlimited transfers - as
 * four cards of ~14 rows each, of which almost every row was identical. That
 * asks a parent to diff 56 lines by hand to find four numbers, at the exact
 * moment cost is the thing making them stall.
 *
 * The safety property this file exists to protect: a row only moves into the
 * shared block when it is identical in EVERY variant. Anything that differs
 * stays visible against its own variant, so collapsing can never hide a real
 * difference in what a parent is being charged. That is worth a direct test -
 * a subtle change to the signature (dropping isIncluded, say) would silently
 * merge rows that differ, and the card would still look correct.
 */

export const itemKey = (i: ProgramCardLineItem) => `${i.category}::${i.key}`;
export const itemSignature = (i: ProgramCardLineItem) =>
  `${itemKey(i)}::${i.minValue ?? ""}::${i.maxValue ?? ""}::${i.isIncluded}`;

/** The part of each program name that differs, e.g. "One Cycle" / "Two Cycles". */
export function variantLabels(names: string[]): string[] {
  if (names.length < 2) return names;
  const words = names.map((n) => n.split(/\s+/));
  let shared = 0;
  while (words.every((w) => w[shared] && w[shared] === words[0][shared]) && shared < words[0].length - 1) shared++;
  const trimmed = words.map((w) => w.slice(shared).join(" ").replace(/^[-·:]\s*/, "").trim());
  // If trimming left anything empty, the names weren't a common family - keep
  // them whole. Same if the trimmed labels are no longer distinct: two rows
  // both labelled "Risk" tell a parent nothing about which price is which, and
  // that happens whenever a provider publishes two programs under one name.
  const distinct = new Set(trimmed).size === trimmed.length;
  return trimmed.some((t) => !t) || !distinct ? names : trimmed;
}

export type FamilySplit = {
  /** Identical in every variant, and included in the price. */
  sharedIncluded: ProgramCardLineItem[];
  /** Identical in every variant, and NOT included. */
  sharedExtra: ProgramCardLineItem[];
  /** Per variant, in the order given: the rows that are not shared. */
  perVariant: ProgramCardLineItem[][];
};

export function splitSharedItems(programs: ProgramCardData[]): FamilySplit {
  const counts = new Map<string, number>();
  for (const p of programs) {
    // A signature is counted once per program: a program listing the same row
    // twice must not make it look present in two variants.
    for (const sig of new Set(p.lineItems.map(itemSignature))) {
      counts.set(sig, (counts.get(sig) || 0) + 1);
    }
  }
  const isShared = (i: ProgramCardLineItem) => counts.get(itemSignature(i)) === programs.length;

  const sharedItems = (programs[0]?.lineItems || []).filter(isShared);
  return {
    sharedIncluded: sharedItems.filter((i) => i.isIncluded),
    sharedExtra: sharedItems.filter((i) => !i.isIncluded),
    perVariant: programs.map((p) => p.lineItems.filter((i) => !isShared(i))),
  };
}

/**
 * Group programs into families. Same tab + subtype + country + cost shape is
 * one product in several sizes; anything else is its own product.
 *
 * Genuinely different products - Fixed vs Regular Egg Donation - stay separate
 * cards, because merging them would imply they are interchangeable options when
 * they carry different terms.
 */
export function groupProgramFamilies(programs: ProgramCardData[]): ProgramCardData[][] {
  const groups = new Map<string, ProgramCardData[]>();
  for (const p of programs) {
    // The name's first word joins the key. Tab + subtype + country alone merged
    // "Fixed Egg Donation Program" with "Regular Egg Donation Program" - two
    // products with different terms, presented as two rungs of one ladder, which
    // reads as "same thing, pick a size". Variants of one product share a
    // leading stem ("IVF Program - One Cycle" / "- Two Cycles"); genuinely
    // different products diverge at the first word.
    const stem = (p.programName || "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const key = [p.tab ?? "", p.subType ?? "", p.country ?? "", p.isFixedCost ? "fixed" : "var", stem].join("::");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  return Array.from(groups.values());
}
