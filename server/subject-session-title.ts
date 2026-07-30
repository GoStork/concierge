/**
 * The title of a parent-provider thread, derived from its subject profile.
 *
 * Two paths now open a subject thread - a booked consultation
 * (calendar.controller createConsultationChatSession) and the
 * already-connected-agency shortcut (connected-agency-shortcut.ts) - and the
 * session dedupe key is (accountUserIds, providerId, TITLE). If the two paths
 * ever derive a different title for the same surrogate, the dedupe silently
 * misses and the parent ends up with two threads about one person.
 *
 * So the derivation lives here, once.
 */

/**
 * "Surrogate #1234" / "Egg Donor #1234" / "Sperm Donor #1234", falling back to
 * the provider's name.
 *
 * Never accepts a generic label: some booking paths (the win-back reschedule
 * card) carry none, and one path once passed the Eva chat's OWN title through,
 * which created a 3-way session called "AI Concierge Chat" that looked like a
 * duplicate Eva session and hid the whole provider flow inside "the AI chat".
 */
export async function deriveSubjectSessionTitle(input: {
  proposedLabel?: string | null;
  subjectProfileId?: string | null;
  subjectType?: string | null;
  providerName?: string | null;
  client?: any;
}): Promise<string | null> {
  const proposed = (input.proposedLabel || "").trim();
  if (proposed && !/^ai concierge/i.test(proposed)) return proposed;

  if (input.subjectProfileId) {
    const prisma = input.client ?? (await import("./db")).prisma;
    const subjType = (input.subjectType || "").toLowerCase();
    const lookup = subjType.includes("egg")
      ? prisma.eggDonor
      : subjType.includes("sperm")
        ? prisma.spermDonor
        : prisma.surrogate;
    const subj = await (lookup as any)
      .findUnique({ where: { id: input.subjectProfileId }, select: { externalId: true } })
      .catch(() => null);
    if (subj?.externalId) {
      const prefix = subjType.includes("egg")
        ? "Egg Donor"
        : subjType.includes("sperm")
          ? "Sperm Donor"
          : "Surrogate";
      return `${prefix} #${subj.externalId}`;
    }
  }
  return input.providerName || null;
}
