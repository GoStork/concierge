/**
 * The family's own stated interests, mapped onto service keys.
 *
 * `IntendedParentProfile.interestedServices` is free text chosen in
 * onboarding - "Surrogate", "Fertility Clinic", "Egg Donor" - while the rest
 * of the platform filters on enum keys. Both the parents list and the parent
 * record need the same translation, and they had it written out twice; when
 * one grew a case the other silently disagreed about what a family wants.
 *
 * Used as a FALLBACK, after the service types derived from actual chat
 * threads: a plain concierge thread carries no serviceType, so a family whose
 * only conversation is a concierge one would otherwise show no services at
 * all, on a record whose own profile block lists them two inches below.
 */
const KEY_BY_LABEL: [RegExp, string][] = [
  [/egg/i, "EGG_DONATION"],
  [/surrog/i, "SURROGACY"],
  [/sperm/i, "SPERM_DONATION"],
  [/ivf|clinic|doctor/i, "IVF_CLINIC"],
];

export function serviceKeysFromLabels(labels: readonly string[] | null | undefined): string[] {
  if (!labels?.length) return [];
  return Array.from(new Set(
    labels
      .map((l) => KEY_BY_LABEL.find(([re]) => re.test(l))?.[1])
      .filter(Boolean) as string[],
  ));
}
