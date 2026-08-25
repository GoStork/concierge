/**
 * Phase 8: Reviews & Ratings API (docs/reviews-ratings-spec.md).
 *
 * Verified-journey reviews of provider orgs and doctors (ProviderMember).
 * Eligibility is DERIVED from journey evidence via buildJourneyTimelines -
 * never self-declared. Auto-publish with a Gemini screen; failures land in
 * PENDING for the admin queue; admins are notified on every publish.
 * 1-2 star reviews may be sent as PRIVATE_FEEDBACK instead (never public,
 * provider never notified). Providers get one editable public reply and a
 * flag-for-recheck. Aggregates are denormalized onto Provider /
 * ProviderMember (avgOverallScore = 1-5 avg, reviewCount, recommendPct).
 */
import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "./db";
import { emitJourneyEvent } from "./journey-events";
import { blockContactInfo } from "./contact-guard";
import { trackGemini } from "./src/lib/gemini-usage";

export const reviewsRouter = Router();

// JWT Bearer fallback (mobile clients + test scripts) - same contract as
// aiRouter's middleware; Passport session auth still takes precedence.
reviewsRouter.use(async (req: any, _res: any, next: any) => {
  if (!req.isAuthenticated?.()) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const token = authHeader.slice(7);
        const secret = process.env.JWT_SECRET || "dev-jwt-secret-change-me";
        const payload = jwt.verify(token, secret) as any;
        if (payload?.sub) {
          const user = await prisma.user.findUnique({ where: { id: payload.sub } });
          if (user && !user.isDisabled) {
            req.user = user;
            req.isAuthenticated = () => true;
          }
        }
      } catch { /* invalid token - continue unauthenticated */ }
    }
  }
  next();
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const ORG_CATEGORIES = ["communication", "transparency", "responsiveness", "support"] as const;
const DOCTOR_CATEGORIES = ["communication", "expertise", "care"] as const;
const STAGE_ORDER = ["consult_completed", "matched", "handed_off"] as const;

function requireAuth(req: Request, res: Response, next: () => void) {
  if (!(req as any).isAuthenticated?.() || !(req as any).user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

function rolesOf(user: any): string[] {
  return user?.roles || [];
}
function isAdmin(user: any): boolean {
  const r = rolesOf(user);
  return r.includes("GOSTORK_ADMIN") || r.includes("GOSTORK_CONCIERGE");
}
function isParentUser(user: any): boolean {
  return !user?.providerId && !isAdmin(user);
}

async function accountOf(userId: string): Promise<{ accountId: string; memberIds: string[] }> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, parentAccountId: true } });
  const accountId = u?.parentAccountId || userId;
  const memberIds = u?.parentAccountId
    ? (await prisma.user.findMany({ where: { parentAccountId: u.parentAccountId }, select: { id: true } })).map((m) => m.id)
    : [userId];
  return { accountId, memberIds };
}

function recommendationFor(rating: number): string {
  return rating >= 4 ? "STRONGLY_RECOMMEND" : rating === 3 ? "NEUTRAL" : "DONT_RECOMMEND";
}

function reviewerLabel(author: { firstName?: string | null; name?: string | null } | null, anonymous: boolean): string {
  if (anonymous || !author) return "Verified GoStork Parent";
  const first = author.firstName || (author.name || "").split(" ")[0] || "A parent";
  const last = (author.name || "").split(" ").slice(1).join(" ");
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}

/**
 * Journey-derived eligibility: which review stage has this account reached
 * with this provider? Banks have no consultations - Invoice Paid acts as
 * their "matched" unlock.
 */
export async function eligibleStage(accountId: string, providerId: string): Promise<{ eligible: boolean; stage: string | null; journeyType: string | null }> {
  const { buildJourneyTimelines } = await import("./journey-timeline");
  const { journeys } = await buildJourneyTimelines(accountId, { providerId });
  const j = journeys[0];
  if (!j) return { eligible: false, stage: null, journeyType: null };
  const done = new Set(j.stages.filter((s) => s.state === "done" || s.state === "current").map((s) => s.id));
  // "current" counts only when it has evidence (reachedAt) - the deriver
  // marks the highest evidenced rung current unless terminal.
  const evidenced = new Set(j.stages.filter((s) => s.reachedAt).map((s) => s.id));
  const has = (id: string) => done.has(id) && evidenced.has(id);
  let stage: string | null = null;
  if (has("handed_off")) stage = "handed_off";
  else if (has("matched") || (j.journeyType === "bank" && has("invoice_paid"))) stage = "matched";
  else if (has("consult_completed")) stage = "consult_completed";
  return { eligible: !!stage, stage, journeyType: j.journeyType };
}

/** Recompute denormalized aggregates for an org or a doctor. */
export async function updateReviewAggregates(providerId: string, memberId?: string | null): Promise<void> {
  const where = {
    providerId,
    memberId: memberId ?? null,
    status: "PUBLISHED",
    visibility: "PUBLIC",
    rating: { not: null },
  } as any;
  const rows = await prisma.providerReview.findMany({ where, select: { rating: true } });
  const count = rows.length;
  const avg = count ? rows.reduce((s, r) => s + (r.rating || 0), 0) / count : null;
  const recommendPct = count ? Math.round((rows.filter((r) => (r.rating || 0) >= 4).length / count) * 100) : null;
  const data = { reviewCount: count, avgOverallScore: avg, recommendPct } as any;
  if (memberId) {
    await prisma.providerMember.update({ where: { id: memberId }, data }).catch(() => {});
  } else {
    await prisma.provider.update({ where: { id: providerId }, data }).catch(() => {});
  }
}

/**
 * Gemini content screen. Fail-safe: any screening error -> NOT ok, so the
 * review lands in the admin queue instead of publishing unreviewed.
 */
async function aiScreenReview(text: string | null | undefined): Promise<{ ok: boolean; notes: string | null }> {
  const body = (text || "").trim();
  if (!body) return { ok: true, notes: null };
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-3.5-flash",
      generationConfig: { temperature: 0, maxOutputTokens: 512, responseMimeType: "application/json" } as any,
    });
    const res = await model.generateContent(
      `You are a content moderator for a fertility marketplace's provider reviews.\n` +
      `Flag the review ONLY if it contains: profanity or hate speech; personal contact info (emails, phone numbers, addresses); ` +
      `full names of surrogates or egg/sperm donors (staff and doctor names are fine); threats; or spam/advertising.\n` +
      `Honest criticism, negative experiences, and strong opinions are ALLOWED - do not flag them.\n` +
      `Respond as JSON: {"ok": boolean, "reasons": string[]}.\n\nREVIEW:\n${body}`,
    );
    trackGemini("review-moderation", "gemini-3.5-flash", res);
    const parsed = JSON.parse(res.response.text());
    if (parsed.ok === true) return { ok: true, notes: null };
    return { ok: false, notes: (parsed.reasons || []).join("; ") || "flagged by screen" };
  } catch (e: any) {
    console.error(`[reviews] AI screen failed: ${e?.message}`);
    return { ok: false, notes: `screen error: ${e?.message}` };
  }
}

async function notifyAdmins(eventType: string, payload: Record<string, unknown>) {
  const admins = await prisma.user.findMany({
    where: { roles: { hasSome: ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE"] } },
    select: { id: true },
  }).catch(() => [] as { id: string }[]);
  for (const a of admins) {
    await prisma.inAppNotification.create({ data: { userId: a.id, eventType, payload: payload as any } }).catch(() => {});
  }
}

function publicReviewShape(r: any, author: any) {
  return {
    id: r.id,
    rating: r.rating,
    categories: r.subScores || null,
    text: r.bodyText || null,
    stage: r.stage,
    journeyType: r.journeyType,
    reviewerLabel: reviewerLabel(author, r.anonymous),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    providerReply: r.providerReply || null,
    providerReplyAt: r.providerReplyAt || null,
  };
}

async function listPublished(where: any) {
  const rows = await prisma.providerReview.findMany({
    where: { ...where, status: "PUBLISHED", visibility: "PUBLIC", rating: { not: null } },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  const authorIds = [...new Set(rows.filter((r) => !r.anonymous).map((r) => r.authorUserId))];
  const authors = authorIds.length
    ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, firstName: true, name: true } })
    : [];
  const authorById = new Map(authors.map((a) => [a.id, a]));
  const reviews = rows.map((r) => publicReviewShape(r, authorById.get(r.authorUserId) || null));
  const count = rows.length;
  const avg = count ? rows.reduce((s, r) => s + (r.rating || 0), 0) / count : null;
  const distribution = [1, 2, 3, 4, 5].map((star) => rows.filter((r) => r.rating === star).length);
  const catSums: Record<string, { sum: number; n: number }> = {};
  for (const r of rows) {
    const cats = (r.subScores as any) || {};
    for (const [k, v] of Object.entries(cats)) {
      if (typeof v !== "number") continue;
      catSums[k] = catSums[k] || { sum: 0, n: 0 };
      catSums[k].sum += v;
      catSums[k].n += 1;
    }
  }
  const categoryAverages = Object.fromEntries(Object.entries(catSums).map(([k, v]) => [k, +(v.sum / v.n).toFixed(1)]));
  return { aggregates: { count, avg: avg != null ? +avg.toFixed(1) : null, distribution, categoryAverages }, reviews };
}

// ---- Public reads -----------------------------------------------------

reviewsRouter.get("/api/reviews/provider/:providerId", requireAuth, async (req, res) => {
  try {
    res.json(await listPublished({ providerId: String(req.params.providerId), memberId: null }));
  } catch (e: any) {
    console.error("[reviews] provider list failed:", e?.message);
    res.status(500).json({ message: "Failed to load reviews" });
  }
});

reviewsRouter.get("/api/reviews/member/:memberId", requireAuth, async (req, res) => {
  try {
    res.json(await listPublished({ memberId: String(req.params.memberId) }));
  } catch (e: any) {
    console.error("[reviews] member list failed:", e?.message);
    res.status(500).json({ message: "Failed to load reviews" });
  }
});

// ---- Parent: eligibility + create/update ------------------------------

reviewsRouter.get("/api/reviews/eligibility", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    if (!isParentUser(user)) return res.status(403).json({ message: "Parents only" });
    const providerId = (req.query.providerId as string) || null;
    const memberId = (req.query.memberId as string) || null;
    if (!providerId && !memberId) return res.status(400).json({ message: "providerId or memberId required" });

    let targetProviderId = providerId;
    if (memberId) {
      const member = await prisma.providerMember.findUnique({ where: { id: memberId }, select: { providerId: true } });
      if (!member) return res.status(404).json({ message: "Doctor not found" });
      targetProviderId = member.providerId;
    }
    const { accountId } = await accountOf(user.id);
    const elig = await eligibleStage(accountId, targetProviderId!);
    const existing = await prisma.providerReview.findFirst({
      where: { parentAccountId: accountId, providerId: targetProviderId!, memberId: memberId ?? null },
      select: { id: true, rating: true, subScores: true, bodyText: true, anonymous: true, stage: true, status: true, visibility: true, updatedAt: true },
    });
    // providerId echoes the resolved org so doctor-page callers (which only
    // know memberId) can POST the review without a second lookup.
    res.json({ ...elig, providerId: targetProviderId, existing });
  } catch (e: any) {
    console.error("[reviews] eligibility failed:", e?.message);
    res.status(500).json({ message: "Failed to check eligibility" });
  }
});

reviewsRouter.post("/api/reviews", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    if (!isParentUser(user)) return res.status(403).json({ message: "Parents only" });
    const { providerId, memberId, rating, categories, text, anonymous, visibility } = req.body || {};
    if (!providerId || typeof providerId !== "string") return res.status(400).json({ message: "providerId required" });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ message: "rating must be 1-5" });
    const vis = visibility === "PRIVATE_FEEDBACK" ? "PRIVATE_FEEDBACK" : "PUBLIC";

    // Validate the doctor belongs to the org.
    if (memberId) {
      const member = await prisma.providerMember.findUnique({ where: { id: memberId }, select: { providerId: true } });
      if (!member || member.providerId !== providerId) return res.status(400).json({ message: "Doctor does not belong to this provider" });
    }

    // Verified-journey gate: server-derived, never self-declared.
    const { accountId } = await accountOf(user.id);
    const elig = await eligibleStage(accountId, providerId);
    if (!elig.eligible) return res.status(403).json({ message: "You can review a provider once you've completed a consultation with them" });

    // Whitelist categories by target type.
    const allowed = memberId ? DOCTOR_CATEGORIES : ORG_CATEGORIES;
    const cats: Record<string, number> = {};
    for (const key of allowed) {
      const v = (categories || {})[key];
      if (Number.isInteger(v) && v >= 1 && v <= 5) cats[key] = v;
    }

    // Screen public text; private feedback skips straight to the admin inbox.
    let status = "PUBLISHED";
    let aiScreenNotes: string | null = null;
    if (vis === "PUBLIC") {
      const screen = await aiScreenReview(text);
      if (!screen.ok) {
        status = "PENDING";
        aiScreenNotes = screen.notes;
      }
    }

    const existing = await prisma.providerReview.findFirst({
      where: { parentAccountId: accountId, providerId, memberId: memberId ?? null },
      select: { id: true },
    });
    const data = {
      providerId,
      memberId: memberId ?? null,
      authorUserId: user.id,
      parentAccountId: accountId,
      recommendation: recommendationFor(rating),
      rating,
      subScores: Object.keys(cats).length ? cats : undefined,
      bodyText: (text || "").trim() || null,
      journeyType: elig.journeyType,
      stage: elig.stage,
      anonymous: anonymous === true,
      visibility: vis,
      status,
      aiScreenNotes,
    } as any;
    const review = existing
      ? await prisma.providerReview.update({ where: { id: existing.id }, data })
      : await prisma.providerReview.create({ data });

    await updateReviewAggregates(providerId, memberId ?? null);

    // Resolve any open review_prompt cards for this account+target.
    const { memberIds } = await accountOf(user.id);
    const prompts = await prisma.aiChatMessage.findMany({
      where: {
        uiCardType: "review_prompt",
        session: { userId: { in: memberIds } },
        uiCardData: { path: ["providerId"], equals: providerId },
      },
      select: { id: true, uiCardData: true },
    });
    for (const p of prompts) {
      const d = (p.uiCardData as any) || {};
      // Already-resolved cards still refresh their stars: the parent can
      // update the review from the chat chip, and the chip must show the
      // NEW rating, not the one from the first submission.
      if (d.submitted) {
        if (d.submittedRating !== rating) {
          await prisma.aiChatMessage.update({
            where: { id: p.id },
            data: { uiCardData: { ...d, submittedRating: rating, updatedAtIso: new Date().toISOString() } },
          }).catch(() => {});
        }
        continue;
      }
      await prisma.aiChatMessage.update({
        where: { id: p.id },
        data: { uiCardData: { ...d, submitted: true, submittedRating: rating, submittedAt: new Date().toISOString() } },
      }).catch(() => {});
    }

    const providerRow = await prisma.provider.findUnique({ where: { id: providerId }, select: { name: true } });
    const targetLabel = providerRow?.name || "the provider";
    if (vis === "PRIVATE_FEEDBACK") {
      await notifyAdmins("REVIEW_PRIVATE_FEEDBACK", {
        reviewId: review.id, providerId, rating,
        message: `Private feedback (${rating} stars) about ${targetLabel} - not published, provider not notified.`,
      });
    } else if (status === "PUBLISHED") {
      await notifyAdmins("REVIEW_PUBLISHED", {
        reviewId: review.id, providerId, memberId: memberId ?? null, rating,
        message: `A ${rating}-star review of ${targetLabel} just published.`,
      });
      // First publication only (updates don't re-ping): email the coordinator
      // handling this parent (CC provider admins) with a reply link, plus
      // in-app notifications. Fire-and-forget - publishing never blocks on it.
      if (!existing) {
        const authorRow = await prisma.user.findUnique({ where: { id: user.id }, select: { firstName: true, name: true } });
        const memberRow = memberId ? await prisma.providerMember.findUnique({ where: { id: memberId }, select: { name: true } }) : null;
        import("./notify-provider-review")
          .then(({ notifyProviderNewReview }) => notifyProviderNewReview({
            reviewId: review.id,
            providerId,
            authorUserId: user.id,
            reviewerLabel: reviewerLabel(authorRow, anonymous === true),
            rating,
            text: (text || "").trim() || null,
            memberName: memberRow?.name || null,
          }))
          .catch((e) => console.error("[REVIEW NOTIFY] dispatch failed:", e?.message));
      }
    } else {
      await notifyAdmins("REVIEW_PENDING", {
        reviewId: review.id, providerId, rating,
        message: `A review of ${targetLabel} was held for moderation: ${aiScreenNotes}`,
      });
    }
    void emitJourneyEvent({
      eventType: existing ? "REVIEW_UPDATED" : "REVIEW_SUBMITTED",
      parentAccountId: accountId,
      providerId,
      metadata: { reviewId: review.id, rating, stage: elig.stage, memberId: memberId ?? null, visibility: vis },
    });

    res.json({ ok: true, reviewId: review.id, status, visibility: vis });
  } catch (e: any) {
    console.error("[reviews] submit failed:", e?.message);
    res.status(500).json({ message: "Failed to save review" });
  }
});

// ---- Provider: reply + flag -------------------------------------------

reviewsRouter.post("/api/reviews/:id/reply", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const text = (req.body?.text || "").trim();
    if (!user.providerId) return res.status(403).json({ message: "Providers only" });
    if (!text) return res.status(400).json({ message: "text required" });
    // The review BODY has been screened for contact info since Phase 8
    // (aiScreenReview above); the provider's public reply never was. Run the
    // deterministic guard first - it is free and it catches the obfuscated
    // forms the model tends to wave through - then fall through to the same
    // AI screen the body gets.
    if (blockContactInfo(res, text, "review.provider-reply", { reviewId: String(req.params.id), providerId: user.providerId })) return;
    const replyScreen = await aiScreenReview(text);
    if (!replyScreen.ok) {
      return res.status(422).json({ message: "This reply cannot be posted publicly. Please remove any contact details or personal information and try again." });
    }
    const review = await prisma.providerReview.findUnique({ where: { id: String(req.params.id) } });
    if (!review || review.providerId !== user.providerId) return res.status(404).json({ message: "Review not found" });
    if (review.visibility !== "PUBLIC") return res.status(403).json({ message: "Not repliable" });
    await prisma.providerReview.update({
      where: { id: review.id },
      data: { providerReply: text, providerReplyAt: new Date(), providerReplyUserId: user.id },
    });
    // Tell the parent their review got a response.
    await prisma.inAppNotification.create({
      data: {
        userId: review.authorUserId,
        eventType: "REVIEW_REPLY",
        payload: { reviewId: review.id, providerId: review.providerId, message: "The provider replied to your review." },
      },
    }).catch(() => {});
    res.json({ ok: true });
  } catch (e: any) {
    console.error("[reviews] reply failed:", e?.message);
    res.status(500).json({ message: "Failed to save reply" });
  }
});

reviewsRouter.post("/api/reviews/:id/flag", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user.providerId) return res.status(403).json({ message: "Providers only" });
    const review = await prisma.providerReview.findUnique({ where: { id: String(req.params.id) } });
    if (!review || review.providerId !== user.providerId) return res.status(404).json({ message: "Review not found" });
    await prisma.providerReview.update({
      where: { id: review.id },
      data: { flaggedByProviderAt: new Date(), flagReason: (req.body?.reason || "").trim() || null },
    });
    await notifyAdmins("REVIEW_FLAGGED", {
      reviewId: review.id, providerId: review.providerId,
      message: `A provider flagged a review for re-check: ${(req.body?.reason || "no reason given").slice(0, 200)}`,
    });
    // Email the GoStork team too (the flag also lands in the admin home
    // "Needs attention" queue via the dashboard endpoint).
    {
      const providerRow = await prisma.provider.findUnique({ where: { id: review.providerId }, select: { name: true } });
      import("./notify-provider-review")
        .then(({ notifyAdminsReviewFlagged }) => notifyAdminsReviewFlagged({
          reviewId: review.id,
          providerName: providerRow?.name || "A provider",
          rating: review.rating,
          reviewText: review.bodyText,
          flagReason: (req.body?.reason || "").trim() || null,
        }))
        .catch((e) => console.error("[REVIEW FLAG NOTIFY] dispatch failed:", e?.message));
    }
    res.json({ ok: true });
  } catch (e: any) {
    console.error("[reviews] flag failed:", e?.message);
    res.status(500).json({ message: "Failed to flag review" });
  }
});

// ---- Provider: own reviews (dashboard) ---------------------------------

reviewsRouter.get("/api/reviews/mine", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user.providerId) return res.status(403).json({ message: "Providers only" });
    const rows = await prisma.providerReview.findMany({
      where: { providerId: user.providerId, status: "PUBLISHED", visibility: "PUBLIC", rating: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    const authorIds = [...new Set(rows.filter((r) => !r.anonymous).map((r) => r.authorUserId))];
    const authors = authorIds.length
      ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, firstName: true, name: true } })
      : [];
    const authorById = new Map(authors.map((a) => [a.id, a]));
    const memberIds = [...new Set(rows.filter((r) => r.memberId).map((r) => r.memberId!))];
    const members = memberIds.length
      ? await prisma.providerMember.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true } })
      : [];
    const memberById = new Map(members.map((m) => [m.id, m.name]));
    res.json(rows.map((r) => ({
      ...publicReviewShape(r, authorById.get(r.authorUserId) || null),
      memberId: r.memberId,
      memberName: r.memberId ? memberById.get(r.memberId) || null : null,
      flaggedByProviderAt: r.flaggedByProviderAt,
    })));
  } catch (e: any) {
    console.error("[reviews] mine failed:", e?.message);
    res.status(500).json({ message: "Failed to load reviews" });
  }
});

// ---- Admin queue --------------------------------------------------------

reviewsRouter.get("/api/admin/reviews", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    if (!isAdmin(user)) return res.status(403).json({ message: "Admins only" });
    const where: any = {};
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.visibility) where.visibility = String(req.query.visibility);
    if (req.query.flagged === "true") where.flaggedByProviderAt = { not: null };
    if (req.query.providerId) where.providerId = String(req.query.providerId);
    if (req.query.maxRating) where.rating = { lte: parseInt(String(req.query.maxRating), 10) };
    const rows = await prisma.providerReview.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: 200,
      include: { provider: { select: { name: true } }, member: { select: { name: true } } },
    });
    const authorIds = [...new Set(rows.map((r) => r.authorUserId))];
    const authors = await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, firstName: true, name: true, email: true } });
    const authorById = new Map(authors.map((a) => [a.id, a]));
    res.json(rows.map((r) => {
      const a = authorById.get(r.authorUserId);
      return {
        id: r.id,
        providerId: r.providerId,
        providerName: (r as any).provider?.name || null,
        memberId: r.memberId,
        memberName: (r as any).member?.name || null,
        rating: r.rating,
        categories: r.subScores,
        text: r.bodyText,
        stage: r.stage,
        journeyType: r.journeyType,
        anonymous: r.anonymous,
        visibility: r.visibility,
        status: r.status,
        aiScreenNotes: r.aiScreenNotes,
        flaggedByProviderAt: r.flaggedByProviderAt,
        flagReason: r.flagReason,
        providerReply: r.providerReply,
        authorName: a?.name || a?.firstName || null,
        authorEmail: a?.email || null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    }));
  } catch (e: any) {
    console.error("[reviews] admin list failed:", e?.message);
    res.status(500).json({ message: "Failed to load reviews" });
  }
});

reviewsRouter.post("/api/admin/reviews/:id/remove", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    if (!isAdmin(user)) return res.status(403).json({ message: "Admins only" });
    const review = await prisma.providerReview.findUnique({ where: { id: String(req.params.id) } });
    if (!review) return res.status(404).json({ message: "Review not found" });
    await prisma.providerReview.update({
      where: { id: review.id },
      data: { status: "REJECTED", aiScreenNotes: (req.body?.reason || "").trim() || review.aiScreenNotes },
    });
    await updateReviewAggregates(review.providerId, review.memberId);
    // The provider hears the outcome - especially when they flagged it.
    import("./notify-provider-review")
      .then(({ notifyProviderReviewOutcome }) => notifyProviderReviewOutcome({
        reviewId: review.id,
        providerId: review.providerId,
        authorUserId: review.authorUserId,
        rating: review.rating,
        outcome: "removed",
        wasFlagged: !!review.flaggedByProviderAt,
      }))
      .catch((e) => console.error("[REVIEW OUTCOME NOTIFY] dispatch failed:", e?.message));
    res.json({ ok: true });
  } catch (e: any) {
    console.error("[reviews] remove failed:", e?.message);
    res.status(500).json({ message: "Failed to remove review" });
  }
});

reviewsRouter.post("/api/admin/reviews/:id/restore", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    if (!isAdmin(user)) return res.status(403).json({ message: "Admins only" });
    const review = await prisma.providerReview.findUnique({ where: { id: String(req.params.id) } });
    if (!review) return res.status(404).json({ message: "Review not found" });
    await prisma.providerReview.update({
      where: { id: review.id },
      data: { status: "PUBLISHED", flaggedByProviderAt: null, flagReason: null },
    });
    await updateReviewAggregates(review.providerId, review.memberId);
    // Outcome depends on what "restore" resolved: clearing a flag on a live
    // review = "kept after re-check"; re-publishing a removed one = "republished".
    import("./notify-provider-review")
      .then(({ notifyProviderReviewOutcome }) => notifyProviderReviewOutcome({
        reviewId: review.id,
        providerId: review.providerId,
        authorUserId: review.authorUserId,
        rating: review.rating,
        outcome: review.status === "REJECTED" ? "republished" : "kept",
        wasFlagged: !!review.flaggedByProviderAt,
      }))
      .catch((e) => console.error("[REVIEW OUTCOME NOTIFY] dispatch failed:", e?.message));
    res.json({ ok: true });
  } catch (e: any) {
    console.error("[reviews] restore failed:", e?.message);
    res.status(500).json({ message: "Failed to restore review" });
  }
});
