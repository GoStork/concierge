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
 * 2. connectLawyer(sessionId, parentUserId) - fired when Eva emits
 *    [[LAWYER_CONNECT]] (parent said yes to the offer, or asked for legal
 *    help via keywords). Auto-picks the best-matching approved Legal
 *    Services provider (prefers one with a location in the parent's state,
 *    then any) and creates the 3-way chat, revealing the parent to the
 *    lawyer (the connect IS the consent moment, same as consultation
 *    booking).
 *
 * Honest failures: no approved Legal Services provider on the platform ->
 * Eva says so plainly and the GoStork team is notified; nothing is faked.
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
 * state first, else the first one) plus their bookable team member. Shared by
 * connectLawyer and the deterministic lawyer-connect bypass in ai-router so
 * both always agree on the same attorney.
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

/**
 * Picks the approved Legal Services provider best matching the parent and
 * opens the 3-way chat. Returns the new session id, or null when no legal
 * provider exists (a plain-text explanation is posted instead).
 * opts.skipBreadcrumb: the deterministic bypass already told the parent the
 * chat is open (with the calendar card) - don't post a second note under it.
 */
export async function connectLawyer(currentSessionId: string, parentUserId: string, opts?: { skipBreadcrumb?: boolean }): Promise<string | null> {
  const postNote = (content: string) =>
    prisma.aiChatMessage.create({ data: { sessionId: currentSessionId, role: "assistant", content, senderType: "ai" } });

  const pick = await pickLawyerWithBooking(parentUserId);
  if (!pick) {
    await postNote(
      "I don't have a fertility attorney on the platform yet - I've flagged this to the GoStork team and they'll reach out with a personal recommendation instead.",
    );
    const admins = await prisma.user.findMany({ where: { roles: { has: "GOSTORK_ADMIN" } }, select: { id: true } });
    for (const a of admins) {
      await prisma.inAppNotification.create({
        data: {
          userId: a.id,
          eventType: "LAWYER_REQUEST_UNSERVED",
          payload: { sessionId: currentSessionId, parentUserId, message: "A parent asked for a lawyer but no approved Legal Services provider exists." },
        },
      }).catch(() => {});
    }
    return null;
  }

  const lawyer = pick.provider;
  const parent = await prisma.user.findUnique({
    where: { id: parentUserId },
    select: { id: true, name: true, firstName: true, parentAccountId: true },
  }).catch(() => null as any);
  const parentName = parent?.firstName || parent?.name || "The parent";
  const { accountIds } = await accountIdsFor(parentUserId);

  // Reuse an existing session with this lawyer if one exists. The intro
  // message and the lawyer notification fire ONLY on first creation -
  // re-connecting (parent asks again, retest, etc.) must not repost the
  // intro or re-ping the firm.
  let session = await prisma.aiChatSession.findFirst({
    where: { userId: { in: accountIds }, providerId: lawyer.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  const isNewSession = !session;
  if (session) {
    await prisma.aiChatSession.update({ where: { id: session.id }, data: { status: "CONSULTATION_BOOKED", updatedAt: new Date() } });
  } else {
    session = await prisma.aiChatSession.create({
      data: {
        userId: parentUserId,
        providerId: lawyer.id,
        providerName: lawyer.name,
        status: "CONSULTATION_BOOKED",
        title: `Legal - ${lawyer.name}`,
        subjectType: "legal",
      },
      select: { id: true },
    });
  }

  if (isNewSession) {
    // Dual-audience intro in the NEW session.
    await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: `You're connected with ${lawyer.name}! They specialize in fertility law and can walk you through contracts, parental rights, and everything legal on your journey. Say hello and share where you are in the process.`,
        senderType: "system",
        senderName: "GoStork",
        uiCardData: {
          providerContent: `${parentName} was just connected with you by Eva for legal guidance on their fertility journey. Say hello and let them know how you can help.`,
        },
      },
    });

    // Notify the lawyer's users.
    const lawyerUsers = await prisma.user.findMany({ where: { providerId: lawyer.id }, select: { id: true } });
    for (const lu of lawyerUsers) {
      await prisma.inAppNotification.create({
        data: {
          userId: lu.id,
          eventType: "LAWYER_INTRO_CREATED",
          payload: { sessionId: session.id, parentName, message: `${parentName} was connected with you for legal guidance.` },
        },
      }).catch(() => {});
    }
  }

  // Confirmation breadcrumb in the CURRENT Eva chat (skipped when the
  // deterministic bypass already announced the connection with a calendar card).
  if (!opts?.skipBreadcrumb) {
    await postNote(`Done! I've opened a chat with ${lawyer.name} - you'll find it in your conversations list. They're expecting you.`);
  }

  console.log(`[lawyer-intro] Connected parent ${parentUserId} with ${lawyer.name} (session ${session.id})`);
  return session.id;
}
