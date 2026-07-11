/**
 * Lawyer intro (Phase 6 - Legal Services activation).
 *
 * Two entry points:
 *
 * 1. maybeOfferLawyerIntro(parentUserId, providerId) - fired after a
 *    consultation chat session is created. If the provider is a Surrogacy
 *    or Egg Donor AGENCY and this parent account has never been offered a
 *    lawyer (IntendedParentProfile.lawyerIntroOfferedAt), Eva posts a
 *    one-time yes/no offer into the parent's own Eva session. Surrogacy and
 *    egg donation both legally require independent counsel - the offer
 *    fires at the first real commitment signal (booking the first call),
 *    NOT waiting for a match.
 *
 * 2. pickLawyerWithBooking(parentUserId) - the auto-pick used by the
 *    lawyer-connect presentation in ai-router (firm profile card + booking
 *    calendar). The 3-way legal chat is created ONLY when the parent books
 *    the call (calendar.controller), exactly like every other provider type
 *    - booking is the consent moment.
 */
import { prisma } from "./db";

const LAWYER_TRIGGER_AGENCY_TYPES = ["Surrogacy Agency", "Egg Donor Agency"];

async function accountIdsFor(parentUserId: string): Promise<{ accountIds: string[]; parentAccountId: string | null }> {
  const me = await prisma.user.findUnique({ where: { id: parentUserId }, select: { parentAccountId: true } });
  if (!me?.parentAccountId) return { accountIds: [parentUserId], parentAccountId: null };
  const members = await prisma.user.findMany({ where: { parentAccountId: me.parentAccountId }, select: { id: true } });
  return { accountIds: members.map(m => m.id), parentAccountId: me.parentAccountId };
}

export async function maybeOfferLawyerIntro(parentUserId: string, providerId: string): Promise<void> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { name: true, services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } } },
  });
  // The GoStork HOUSE provider is approved for every service type but is
  // not a real agency - concierge calls must never trigger the lawyer offer.
  if ((provider?.name || "").trim().toLowerCase() === "gostork") return;
  const isTriggerAgency = !!provider?.services.some(sv => LAWYER_TRIGGER_AGENCY_TYPES.includes(sv.providerType?.name || ""));
  if (!isTriggerAgency) return;

  const { accountIds, parentAccountId } = await accountIdsFor(parentUserId);
  if (!parentAccountId) return;

  // Find the target chat FIRST - engaged parents often have NO provider-free
  // session left (match flows attach a provider to the matchmaker session),
  // so fall back to their most recent active matchmaker chat. Only claim
  // the one-time flag once a target exists, otherwise a skipped offer burns
  // the flag and the parent never gets asked.
  const evaSession =
    (await prisma.aiChatSession.findFirst({
      where: { userId: { in: accountIds }, providerId: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    })) ??
    (await prisma.aiChatSession.findFirst({
      where: { userId: { in: accountIds }, matchmakerId: { not: null }, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    }));
  if (!evaSession) {
    console.log(`[lawyer-intro] No suitable session found for parent ${parentUserId} - offer NOT claimed (will retry on next booking)`);
    return;
  }

  // One-time gate, claimed atomically so double-fired booking hooks (or two
  // account members booking simultaneously) can't post the offer twice.
  const claimed = await prisma.intendedParentProfile.updateMany({
    where: { parentAccountId, lawyerIntroOfferedAt: null },
    data: { lawyerIntroOfferedAt: new Date() },
  });
  if (claimed.count !== 1) return;

  const isSurrogacy = !!provider?.services.some(sv => sv.providerType?.name === "Surrogacy Agency");
  const journeyWord = isSurrogacy ? "surrogacy" : "egg donation";
  await prisma.aiChatMessage.create({
    data: {
      sessionId: evaSession.id,
      role: "assistant",
      content: `One more thing while that call gets set up: ${journeyWord} journeys require a legal agreement, and it's smart to have your own fertility lawyer lined up early. I can connect you with a vetted attorney right here on GoStork - no obligation. Want me to?`,
      senderType: "ai",
      uiCardData: { quickReplies: ["Yes, connect me with a lawyer", "Not right now"] },
    },
  });
  await prisma.aiChatSession.update({ where: { id: evaSession.id }, data: { updatedAt: new Date() } }).catch(() => {});
  console.log(`[lawyer-intro] Offered lawyer intro to parent ${parentUserId} (trigger: first call with ${provider?.name})`);
}

/**
 * Picks the approved Legal Services provider best matching the parent (same
 * state first, else the first one) plus their bookable team member. Used by
 * the lawyer-connect presentation (firm card + booking calendar) in ai-router.
 */
export async function pickLawyerWithBooking(parentUserId: string): Promise<{
  provider: { id: string; name: string; logoUrl: string | null };
  member: { name: string | null; photoUrl: string | null; slug: string } | null;
} | null> {
  const lawyers = await prisma.provider.findMany({
    where: { services: { some: { status: "APPROVED", providerType: { name: "Legal Services" } } } },
    select: { id: true, name: true, logoUrl: true, locations: { select: { state: true, city: true } } },
  });
  if (lawyers.length === 0) return null;
  const parentState = (await prisma.user.findUnique({ where: { id: parentUserId }, select: { state: true } }).catch(() => null) as any)?.state || null;
  const lawyer =
    (parentState && lawyers.find(l => l.locations.some(loc => (loc.state || "").toLowerCase() === String(parentState).toLowerCase()))) ||
    lawyers[0];
  const member = await prisma.user.findFirst({
    where: { providerId: lawyer.id, scheduleConfig: { bookingPageSlug: { not: null } } },
    select: { name: true, photoUrl: true, scheduleConfig: { select: { bookingPageSlug: true } } },
  }).catch(() => null);
  return {
    provider: { id: lawyer.id, name: lawyer.name, logoUrl: lawyer.logoUrl },
    member: member?.scheduleConfig?.bookingPageSlug
      ? { name: member.name, photoUrl: member.photoUrl, slug: member.scheduleConfig.bookingPageSlug }
      : null,
  };
}
