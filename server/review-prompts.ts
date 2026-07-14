/**
 * Phase 8 Reviews - Eva's collection prompts (docs/reviews-ratings-spec.md).
 *
 * A review_prompt card is posted in the PARENT'S concierge chat at journey
 * checkpoints (consultation completed, matched, one week after handoff).
 * The cards are parent-private: providers never see them (excluded from
 * every provider-facing message feed).
 *
 * Idempotency: one prompt per (parent account x provider x stage), tracked
 * by the cards themselves. One reminder, only for the post-handoff ask.
 */
import { prisma } from "./db";
import { emitJourneyEvent } from "./journey-events";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Post-handoff check-in fires this long after handoffCompletedAt. */
const HANDOFF_CHECKIN_DELAY_MS = 7 * DAY_MS;
/** Ignore handoffs older than this (don't spam ancient/test journeys). */
const HANDOFF_CHECKIN_MAX_AGE_MS = 60 * DAY_MS;
/** Single reminder for an unanswered post-handoff ask. */
const REMINDER_AFTER_MS = 3 * DAY_MS;

export type ReviewStage = "consult_completed" | "matched" | "handed_off";

async function accountIdsFor(parentUserId: string): Promise<{ accountId: string; memberIds: string[] }> {
  const u = await prisma.user.findUnique({ where: { id: parentUserId }, select: { id: true, parentAccountId: true } });
  if (!u) return { accountId: parentUserId, memberIds: [parentUserId] };
  const accountId = u.parentAccountId || u.id;
  const members = u.parentAccountId
    ? await prisma.user.findMany({ where: { parentAccountId: u.parentAccountId }, select: { id: true } })
    : [{ id: u.id }];
  return { accountId, memberIds: members.map((m) => m.id) };
}

/** The parent's primary concierge chat - where review prompts live. */
async function findEvaSession(memberIds: string[]): Promise<string | null> {
  const s = await prisma.aiChatSession.findFirst({
    where: { userId: { in: memberIds }, status: "ACTIVE", sessionType: "PARENT", matchmakerId: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  return s?.id || null;
}

function promptCopy(stage: ReviewStage, providerName: string, hasExisting: boolean): string {
  if (stage === "consult_completed") {
    return `Now that you've had your first call with ${providerName} - how was it? A quick rating helps other families choose well, and you can update it any time as your journey continues. Only families who actually worked with a provider can review them.`;
  }
  if (stage === "matched") {
    return hasExisting
      ? `Congratulations on your match with ${providerName}! Would you like to update your review now that you've gone further together?`
      : `Congratulations on your match with ${providerName}! How has the experience been so far? A quick rating helps other families - and you can update it any time.`;
  }
  return hasExisting
    ? `It's been about a week since everything with ${providerName} became official - how are you feeling? If your impressions have evolved, this is a great moment to update your review.`
    : `It's been about a week since everything with ${providerName} became official - how did the whole experience feel? A quick rating (and a sentence or two, if you're up for it) makes a real difference for families deciding who to trust.`;
}

/**
 * Post a review prompt if this account+provider+stage hasn't been asked yet.
 * Fire-and-forget safe.
 */
export async function maybePostReviewPrompt(opts: {
  parentUserId: string;
  providerId: string;
  stage: ReviewStage;
}): Promise<void> {
  try {
    const provider = await prisma.provider.findUnique({ where: { id: opts.providerId }, select: { id: true, name: true } });
    if (!provider) return;
    if ((provider.name || "").trim().toLowerCase() === "gostork") return; // house = never reviewed

    const { accountId, memberIds } = await accountIdsFor(opts.parentUserId);

    // Already asked at this stage (or later)? Cards carry providerId + stage.
    const STAGE_ORDER: ReviewStage[] = ["consult_completed", "matched", "handed_off"];
    const existingPrompts = await prisma.aiChatMessage.findMany({
      where: {
        uiCardType: "review_prompt",
        session: { userId: { in: memberIds } },
        uiCardData: { path: ["providerId"], equals: opts.providerId },
      },
      select: { uiCardData: true },
    });
    const askedIdx = existingPrompts.reduce((max, p) => {
      const idx = STAGE_ORDER.indexOf(((p.uiCardData as any) || {}).stage);
      return Math.max(max, idx);
    }, -1);
    if (askedIdx >= STAGE_ORDER.indexOf(opts.stage)) return;

    const existingReview = await prisma.providerReview.findFirst({
      where: { parentAccountId: accountId, providerId: opts.providerId, memberId: null },
      select: { id: true, rating: true },
    });

    const sessionId = await findEvaSession(memberIds);
    if (!sessionId) return;

    await prisma.aiChatMessage.create({
      data: {
        sessionId,
        role: "assistant",
        content: promptCopy(opts.stage, provider.name, !!existingReview),
        senderType: "system",
        senderName: "GoStork",
        uiCardType: "review_prompt",
        uiCardData: {
          providerId: opts.providerId,
          providerName: provider.name,
          memberId: null,
          stage: opts.stage,
          existingReviewId: existingReview?.id || null,
          existingRating: existingReview?.rating || null,
          submitted: false,
          remindedAt: null,
        },
      },
    });
    void emitJourneyEvent({
      eventType: "REVIEW_PROMPTED",
      parentAccountId: accountId,
      providerId: opts.providerId,
      sessionId,
      metadata: { stage: opts.stage },
    });
    console.log(`[reviews] Prompted ${accountId} to review ${provider.name} (${opts.stage})`);
  } catch (e: any) {
    console.error(`[reviews] maybePostReviewPrompt failed: ${e?.message}`);
  }
}

/**
 * Every 10 min: (a) post-handoff check-ins one week after handoff,
 * (b) one reminder for unanswered post-handoff prompts after 3 days.
 */
export async function runReviewCheckinSweep(prismaArg?: any): Promise<void> {
  const db = prismaArg || prisma;
  const now = Date.now();

  // (a) Handoffs that crossed the 7-day mark (and aren't ancient).
  const handoffs = await db.aiChatSession.findMany({
    where: {
      handoffCompletedAt: {
        lte: new Date(now - HANDOFF_CHECKIN_DELAY_MS),
        gte: new Date(now - HANDOFF_CHECKIN_MAX_AGE_MS),
      },
      providerId: { not: null },
    },
    select: { userId: true, providerId: true },
  });
  const seen = new Set<string>();
  for (const h of handoffs) {
    if (!h.userId || !h.providerId) continue;
    const key = `${h.userId}:${h.providerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await maybePostReviewPrompt({ parentUserId: h.userId, providerId: h.providerId, stage: "handed_off" });
  }

  // (b) One reminder for post-handoff prompts still unanswered after 3 days.
  const stale = await db.aiChatMessage.findMany({
    where: {
      uiCardType: "review_prompt",
      createdAt: { lte: new Date(now - REMINDER_AFTER_MS) },
      uiCardData: { path: ["stage"], equals: "handed_off" },
    },
    select: { id: true, sessionId: true, uiCardData: true },
  });
  for (const card of stale) {
    const d = (card.uiCardData as any) || {};
    if (d.submitted || d.remindedAt) continue;
    await db.aiChatMessage.update({
      where: { id: card.id },
      data: { uiCardData: { ...d, remindedAt: new Date().toISOString() } },
    }).catch(() => {});
    await db.aiChatMessage.create({
      data: {
        sessionId: card.sessionId,
        role: "assistant",
        content: `No pressure at all - but if you have thirty seconds, your review of ${d.providerName || "your provider"} would mean a lot to families starting out. The card is just above whenever you're ready.`,
        senderType: "system",
        senderName: "GoStork",
      },
    }).catch(() => {});
    console.log(`[reviews] Reminded about unanswered review prompt ${card.id}`);
  }
}
