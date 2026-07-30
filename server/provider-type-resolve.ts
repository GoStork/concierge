/**
 * Single source of truth for "which service line is this?".
 *
 * Three places needed this and each grew its own copy:
 *   - auto-reply.service.ts  (subjectType -> ProviderType.name regex map)
 *   - video.controller.ts    (a priority list for multi-service orgs)
 *   - the consultation focus lock (needs BOTH, and cannot afford to be wrong)
 *
 * An org routinely runs several lines - Eggspecting is IVF Clinic + Surrogacy
 * Agency + Egg Donor Agency on one Provider row - so "the provider's type" is
 * not a property of the provider at all. It is a property of the CONVERSATION,
 * and the only reliable signal is the chat thread's subjectType.
 */

/** The service lines the consultation lock recognises. */
export type LockedProviderType =
  | "Surrogacy Agency"
  | "Egg Donor Agency"
  | "IVF Clinic"
  | "Egg Bank"
  | "Sperm Bank"
  | "Legal Services";

/**
 * Session subjectType -> ProviderType.name.
 *
 * Session values are loose and historically inconsistent ("egg_donor", "egg",
 * "surrog", "surrogate"), so match on substrings rather than an exact set.
 * ORDER MATTERS: /egg.*bank/ must beat /egg|donor/, and /clinic|doctor|ivf/
 * sits last so "egg donor clinic" resolves to the donor line.
 */
export const SUBJECT_TYPE_TO_PROVIDER_TYPE: Array<{ test: RegExp; typeName: LockedProviderType }> = [
  { test: /egg.*bank/i, typeName: "Egg Bank" },
  { test: /sperm/i, typeName: "Sperm Bank" },
  { test: /egg|donor/i, typeName: "Egg Donor Agency" },
  { test: /surrog/i, typeName: "Surrogacy Agency" },
  { test: /legal|lawyer|attorney/i, typeName: "Legal Services" },
  { test: /clinic|doctor|ivf/i, typeName: "IVF Clinic" },
];

/**
 * Most-specific-first ordering for DISPLAY and labelling only.
 *
 * Do NOT use this to decide a lock. It is a guess, and a wrong lock is a hard
 * dead end for a parent (see resolveLockProviderType).
 */
export const PROVIDER_TYPE_PRIORITY: string[] = [
  "IVF Clinic",
  "Egg Donor Agency",
  "Egg Bank",
  "Sperm Bank",
  "Surrogacy Agency",
];

/** Every service line the lock recognises, for exact-name checks. */
export const LOCKED_PROVIDER_TYPES: readonly LockedProviderType[] = [
  "Surrogacy Agency",
  "Egg Donor Agency",
  "IVF Clinic",
  "Egg Bank",
  "Sperm Bank",
  "Legal Services",
];

export function isLockedProviderType(name: string | null | undefined): name is LockedProviderType {
  return !!name && (LOCKED_PROVIDER_TYPES as readonly string[]).includes(name);
}

/** Map a loose subjectType string onto a service line, or null. */
export function providerTypeFromSubject(subjectType?: string | null): LockedProviderType | null {
  const subject = (subjectType || "").trim();
  if (!subject) return null;
  return SUBJECT_TYPE_TO_PROVIDER_TYPE.find((m) => m.test.test(subject))?.typeName ?? null;
}

/**
 * Pick the most specific service line for display purposes. Guesses when the
 * org runs several - acceptable for a label, never for a gate.
 */
export function displayProviderType(serviceTypeNames: string[]): string {
  return PROVIDER_TYPE_PRIORITY.find((t) => serviceTypeNames.includes(t)) || serviceTypeNames[0] || "";
}

/**
 * Which service line does a (provider, conversation) pair belong to, for the
 * purposes of the consultation focus lock?
 *
 * Resolution order:
 *   1. The thread's subjectType, when it maps to a line the org actually runs.
 *   2. The org's single approved service - one line means no ambiguity.
 *   3. null.
 *
 * WHY NULL RATHER THAN A GUESS: returning a wrong line locks a lane the family
 * never entered, and the parent has no way to see or undo it. Returning null
 * lets one extra consultation through. A missed lock is a soft product miss; a
 * wrong lock is a support ticket and a lost family. Callers MUST treat null as
 * "allow" and log it.
 */
export async function resolveLockProviderType(
  providerId: string,
  subjectType?: string | null,
  client?: any,
): Promise<LockedProviderType | null> {
  if (!providerId) return null;
  const db = client ?? (await import("./db")).prisma;

  const services = await db.providerService.findMany({
    where: { providerId, status: "APPROVED" },
    select: { providerType: { select: { name: true } } },
  });
  const names = (services || [])
    .map((s: any) => s.providerType?.name)
    .filter(Boolean) as string[];
  if (names.length === 0) return null;

  const fromSubject = providerTypeFromSubject(subjectType);
  if (fromSubject && names.includes(fromSubject)) return fromSubject;

  if (names.length === 1) {
    // Only lock on a line the lock actually knows about.
    return isLockedProviderType(names[0]) ? names[0] : null;
  }

  console.warn(
    `[provider-type] Ambiguous service line for provider ${providerId} (runs ${names.join(", ")}, subjectType="${subjectType ?? ""}") - failing OPEN, no lock applied`,
  );
  return null;
}
