/**
 * The name a tiered program's card carries.
 *
 * A program with tier line items becomes one card per tier, named
 * "<program> - <tier>" so a parent can tell the options apart. But the tier key
 * is frequently the program's own name (a single-tier sheet whose one priced
 * row repeats the heading), which rendered as "Fixed Egg Donation Program -
 * Fixed Egg Donation Program" on a live donor profile.
 *
 * The suffix only earns its place when it distinguishes something: drop it when
 * it repeats the name, and when there is only one tier to choose between.
 */
export function programDisplayName(programName: string, tierKey: string, tierCount: number): string {
  const name = (programName || "").trim();
  const tier = (tierKey || "").trim();
  if (!tier) return name;
  if (tierCount <= 1) return name;
  const norm = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();
  // Equality only. A looser "name contains tier" test collapsed "IUI Premium -
  // Premium" to "IUI Premium" while its sibling stayed "IUI Premium - Platinum",
  // which is worse than the redundancy it removed.
  if (norm(tier) === norm(name)) return name;
  return `${name} \u00b7 ${tier}`;
}
