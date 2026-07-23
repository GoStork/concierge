import { Router, Request, Response } from "express";
import { emitJourneyEvent } from "./journey-events";
import multer from "multer";
import { prisma } from "./db";
import { generateAgreement, syncTemplateToPandaDoc, createTemplateEditingSession, generateAgreementFromTemplate, getAgreementSigningSession, refreshTemplateRoles, syncAgreementStatus } from "./pandadoc-service";
import { StorageService } from "./src/modules/storage/storage.service";
import { isUserOnline, getOnlineUserIds } from "./online-tracker";
import { getBaseUrl as getAppBaseUrlShared } from "./src/lib/get-base-url";
import { buildBrandedEmail, fetchEmailBrandData } from "./src/modules/notifications/email-builder";
import { canProviderAccessSession, canSendProviderMessage, COORDINATOR_SUBJECT_TYPES, ALL_SESSION_PROVIDER_ROLES } from "../shared/roles";

const storageService = new StorageService();

const ALLOWED_MIME_PREFIXES = ["image/", "application/pdf", "application/msword", "application/vnd.openxmlformats", "text/plain"];
const BLOCKED_EXTENSIONS = [".html", ".htm", ".svg", ".js", ".mjs", ".jsx", ".ts", ".tsx", ".xml", ".xhtml", ".php", ".sh", ".bat", ".cmd", ".exe"];
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_PREFIXES.some(p => file.mimetype.startsWith(p))) {
      return cb(new Error(`File type ${file.mimetype} not allowed`));
    }
    const ext = ("." + file.originalname.split(".").pop()).toLowerCase();
    if (BLOCKED_EXTENSIONS.includes(ext)) {
      return cb(new Error(`File extension ${ext} not allowed`));
    }
    cb(null, true);
  },
});

const PROVIDER_ROLES = ["PROVIDER_ADMIN", "IP_SURROGACY_COORDINATOR", "IP_EGG_DONOR_COORDINATOR", "IP_SPERM_DONOR_COORDINATOR", "IP_IVF_COORDINATOR", "IP_LEGAL_COORDINATOR", "SURROGATE_COORDINATOR", "EGG_DONOR_COORDINATOR", "SPERM_DONOR_COORDINATOR", "SCHEDULER", "DOCTOR", "LAWYER", "BILLING_MANAGER"];

function isExpiredPresignedAwsUrl(url: string): boolean {
  if (!/amazonaws\.com/i.test(url) || !/[?&]X-Amz-/i.test(url)) return false;
  const dateMatch = url.match(/[?&]X-Amz-Date=(\d{8}T\d{6}Z)/i);
  const expiresMatch = url.match(/[?&]X-Amz-Expires=(\d+)/i);
  if (!dateMatch || !expiresMatch) return true;
  const d = dateMatch[1];
  const signedAt = new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${d.slice(9,11)}:${d.slice(11,13)}:${d.slice(13,15)}Z`);
  const expiresAt = new Date(signedAt.getTime() + parseInt(expiresMatch[1]) * 1000);
  return Date.now() > expiresAt.getTime();
}

function pickFirstValidPhoto(photos: string[] | null | undefined, photoUrl: string | null | undefined): string | null {
  if (Array.isArray(photos)) {
    for (const p of photos) {
      if (p && !isExpiredPresignedAwsUrl(p)) return p;
    }
  }
  if (photoUrl && !isExpiredPresignedAwsUrl(photoUrl)) return photoUrl;
  return null;
}

function getUserRoles(user: any): string[] {
  return user.roles || [];
}

/**
 * Computes per-profile status for a set of chat-session subject profiles,
 * across ALL types (egg donor, surrogate, sperm donor, IVF clinic, surrogacy
 * agency).
 *
 * For donors/surrogates the result carries the canonical status string
 * (AVAILABLE | PENDING | MATCHED | INACTIVE) plus a boolean `available`
 * meaning "bookable right now" - true only when status === AVAILABLE and
 * !hiddenFromSearch. Pending donors render with a "Pending" badge in chat;
 * matched donors render with a "Matched" badge; soft-deleted profiles that
 * have disappeared from the DB get null status and `available=false`.
 *
 * Providers (clinic/agency) have no per-profile status, so existence drives
 * the boolean and status is left null.
 *
 * Shared by the parent, provider, and admin session endpoints.
 */
type ProfileStatusEntry = { available: boolean; status: string | null };
async function computeProfileAvailability(
  items: { subjectProfileId?: string | null; subjectType?: string | null }[],
): Promise<Map<string, ProfileStatusEntry>> {
  const result = new Map<string, ProfileStatusEntry>();
  const sessions = items.filter(s => s.subjectProfileId && s.subjectType);
  if (sessions.length === 0) return result;
  const t = (s: { subjectType?: string | null }) => (s.subjectType || "").toLowerCase();
  const eggIds = [...new Set(sessions.filter(s => t(s).includes("egg")).map(s => s.subjectProfileId!))];
  const surrIds = [...new Set(sessions.filter(s => t(s).includes("surrogate")).map(s => s.subjectProfileId!))];
  const spermIds = [...new Set(sessions.filter(s => t(s).includes("sperm")).map(s => s.subjectProfileId!))];
  const clinicIds = [...new Set(sessions.filter(s => t(s).includes("clinic") || t(s).includes("agency")).map(s => s.subjectProfileId!))];
  const [existEgg, existSurr, existSperm, existClinic] = await Promise.all([
    eggIds.length   ? prisma.eggDonor.findMany({ where: { id: { in: eggIds } },   select: { id: true, status: true, hiddenFromSearch: true, frozenLotStatus: true } }) : [],
    surrIds.length  ? prisma.surrogate.findMany({ where: { id: { in: surrIds } },  select: { id: true, status: true, hiddenFromSearch: true, asrmHidden: true } }) : [],
    spermIds.length ? prisma.spermDonor.findMany({ where: { id: { in: spermIds } },select: { id: true, status: true, hiddenFromSearch: true } }) : [],
    clinicIds.length? prisma.provider.findMany({ where: { id: { in: clinicIds } }, select: { id: true } }) : [],
  ]);
  const donorMap = new Map<string, { status: string | null; hiddenFromSearch: boolean; frozenLotStatus?: string | null }>();
  for (const e of existEgg) {
    donorMap.set(e.id, { status: e.status, hiddenFromSearch: e.hiddenFromSearch, frozenLotStatus: e.frozenLotStatus });
  }
  for (const e of [...existSurr, ...existSperm]) {
    // ASRM-hidden surrogates are treated exactly like provider-hidden ones
    donorMap.set(e.id, { status: e.status, hiddenFromSearch: e.hiddenFromSearch || (e as any).asrmHidden === true });
  }
  const existingProviderIds = new Set(existClinic.map(e => e.id));
  for (const s of sessions) {
    const id = s.subjectProfileId!;
    const isProviderSubject = t(s).includes("clinic") || t(s).includes("agency");
    if (isProviderSubject) {
      result.set(id, { available: existingProviderIds.has(id), status: null });
      continue;
    }
    const donor = donorMap.get(id);
    if (!donor) {
      // Donor row disappeared entirely from DB
      result.set(id, { available: false, status: null });
      continue;
    }
    const status = donor.status || "AVAILABLE";
    // A donor is bookable if any purchasable path is open. For egg donors
    // that means status===AVAILABLE OR frozenLotStatus===AVAILABLE (a
    // "Fresh & Frozen" donor whose fresh side is MATCHED but who has
    // frozen lots in stock is still bookable via the frozen route).
    const freshAvailable = status === "AVAILABLE";
    const frozenAvailable = donor.frozenLotStatus === "AVAILABLE";
    const available = (freshAvailable || frozenAvailable) && !donor.hiddenFromSearch;
    result.set(id, { available, status });
  }
  return result;
}

/**
 * Viewer-facing status remap: on the thread of the family a profile actually
 * committed to (the session carrying a PAID commitment invoice or a SIGNED
 * agreement), harsh roster statuses read as "Matched" - for the parent,
 * their provider, and admin views of that same thread:
 *  - IN_CYCLE egg donor -> "Matched" (everyone else keeps "In Cycle")
 *  - INACTIVE surrogate/donor (left the roster BECAUSE she matched here) ->
 *    "Matched" (everyone else keeps the red "No Longer Available")
 *  - PENDING (agency roster says pending) -> "Matched" on the committed
 *    thread only; the paying family should never read "Pending" about
 *    their own match (user decision, 7B UAT). Everyone else keeps Pending.
 * Mutates profileStatus in place.
 */
async function applyMatchedLabelForInCycle(
  items: { id?: string | null; profileStatus?: string | null }[],
): Promise<void> {
  const targets = items.filter(s => (s.profileStatus === "IN_CYCLE" || s.profileStatus === "INACTIVE" || s.profileStatus === "PENDING") && s.id);
  if (targets.length === 0) return;
  const sessionIds = targets.map(s => s.id!);
  const [paid, signed] = await Promise.all([
    prisma.invoice.findMany({
      where: { sessionId: { in: sessionIds }, status: "PAID", triggerSource: { not: "BANK_CHECKOUT" } },
      select: { sessionId: true },
    }).catch(() => [] as { sessionId: string }[]),
    prisma.agreement.findMany({
      where: { sessionId: { in: sessionIds }, status: "SIGNED" },
      select: { sessionId: true },
    }).catch(() => [] as { sessionId: string | null }[]),
  ]);
  const committedSessions = new Set([
    ...paid.map(p => p.sessionId),
    ...signed.map(a => a.sessionId).filter(Boolean) as string[],
  ]);
  for (const s of targets) {
    if (committedSessions.has(s.id!)) s.profileStatus = "MATCHED";
  }
}
function isAdminUser(user: any): boolean {
  return getUserRoles(user).includes("GOSTORK_ADMIN");
}
export function isAdminOrConcierge(user: any): boolean {
  const roles = getUserRoles(user);
  return roles.includes("GOSTORK_ADMIN") || roles.includes("GOSTORK_CONCIERGE");
}
function isProviderUser(user: any): boolean {
  if (!user.providerId) return false;
  const roles = getUserRoles(user);
  return roles.some((r: string) => PROVIDER_ROLES.includes(r)) || roles.includes("GOSTORK_ADMIN");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// Clean session titles: strip alphabetic prefixes from IDs (e.g. "Surrogate #pdf-23068" → "Surrogate #23068")
function cleanSessionTitle(title: string | null): string | null {
  if (!title) return null;
  return title.replace(/#([A-Za-z]+-)/g, "#");
}

function requireAuth(req: Request, res: Response, next: () => void) {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  next();
}

// Thin wrapper so existing callers don't need to change. Uses the shared
// auto-detect helper that walks Replit / Render / Vercel / Railway / Fly
// env vars before falling back to localhost or app.gostork.com.
function getAppBaseUrl(): string {
  return getAppBaseUrlShared();
}

/**
 * Resolve the parent-chosen matchmaker name for the given session, used as the
 * `senderName` on system messages relayed by the AI concierge. NEVER returns a
 * hardcoded persona name like "Eva" / "Ariel" - if no matchmaker has been
 * selected on the session we fall back to a generic "AI Concierge" label so the
 * UI doesn't impersonate a specific persona the parent didn't pick.
 *
 * Accepts either a session id or a session-like object that already has
 * `matchmakerId` loaded. Cheap (single point lookup, errors swallowed) so it's
 * safe to inline at message-creation sites.
 */
export async function resolveSessionSenderName(
  sessionOrId: string | { matchmakerId?: string | null } | null | undefined,
): Promise<string> {
  let matchmakerId: string | null | undefined;
  if (typeof sessionOrId === "string") {
    const s = await prisma.aiChatSession
      .findUnique({ where: { id: sessionOrId }, select: { matchmakerId: true } })
      .catch(() => null);
    matchmakerId = s?.matchmakerId;
  } else {
    matchmakerId = sessionOrId?.matchmakerId;
  }
  if (!matchmakerId) return "AI Concierge";
  const mm = await prisma.matchmaker
    .findUnique({ where: { id: matchmakerId }, select: { name: true } })
    .catch(() => null);
  return mm?.name || "AI Concierge";
}

export const chatRouter = Router();

// JWT Bearer fallback (mobile clients + test scripts) - same contract as
// aiRouter / reviewsRouter; Passport session auth still takes precedence.
chatRouter.use(async (req: any, _res: any, next: any) => {
  if (!req.isAuthenticated?.()) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const jwt = (await import("jsonwebtoken")).default;
        const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET || "dev-jwt-secret-change-me") as any;
        if (payload?.sub) {
          const jwtUser = await prisma.user.findUnique({ where: { id: payload.sub } });
          if (jwtUser && !jwtUser.isDisabled) {
            req.user = jwtUser;
            req.isAuthenticated = () => true;
          }
        }
      } catch { /* invalid token - continue unauthenticated */ }
    }
  }
  next();
});

// Returns online status for a list of user IDs (or provider IDs).
// Query: ?userIds=id1,id2 or ?providerIds=id1,id2
chatRouter.get("/api/online-status", requireAuth, async (req, res) => {
  try {
    const result: Record<string, boolean> = {};

    const userIdParam = req.query.userIds as string | undefined;
    if (userIdParam) {
      const userIds = userIdParam.split(",").filter(Boolean);
      for (const id of userIds) {
        result[id] = isUserOnline(id);
      }
    }

    const providerIdParam = req.query.providerIds as string | undefined;
    if (providerIdParam) {
      const providerIds = providerIdParam.split(",").filter(Boolean);
      if (providerIds.length > 0) {
        const onlineUserIds = new Set(getOnlineUserIds());
        const providerUsers = await prisma.user.findMany({
          where: { providerId: { in: providerIds } },
          select: { id: true, providerId: true },
        });
        const providerOnline: Record<string, boolean> = {};
        for (const pid of providerIds) providerOnline[pid] = false;
        for (const u of providerUsers) {
          if (u.providerId && onlineUserIds.has(u.id)) {
            providerOnline[u.providerId] = true;
          }
        }
        Object.assign(result, providerOnline);
      }
    }

    res.json(result);
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

// ─── Phase 7A: journey timeline + event feed ────────────────────────────────
// A journey is a (parent account x provider org) relationship; stages are
// derived on read (journey-timeline.ts). Access: parents see their own
// account; provider users are force-scoped to their own org; GoStork admins
// see any pair.
chatRouter.get("/api/journey/timeline", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN") || roles.includes("GOSTORK_CONCIERGE");
    const isProviderUser = !!user.providerId && !isAdmin;

    let parentAccountId: string | null = null;
    let providerScope: string | null = (req.query.providerId as string) || null;

    if (!isAdmin && !isProviderUser) {
      // Parent: always their own account.
      parentAccountId = user.parentAccountId || user.id;
    } else {
      const parentUserId = (req.query.parentUserId as string) || (req.query.parentAccountId as string) || null;
      if (!parentUserId) return res.status(400).json({ message: "parentUserId required" });
      const parent = await prisma.user.findUnique({ where: { id: parentUserId }, select: { parentAccountId: true } });
      parentAccountId = parent?.parentAccountId || parentUserId;
      if (isProviderUser) providerScope = user.providerId; // never another org's journey
    }

    const { buildJourneyTimelines } = await import("./journey-timeline");
    // Everyone sees the full ladder, Registered included (user decision).
    // sessionId scopes the money/terminal rungs to one chat's evidence -
    // the chat sidebars pass it so a profile thread that never advanced
    // doesn't inherit the org-level "Handed Off" ladder.
    const sessionId = (req.query.sessionId as string) || null;
    const result = await buildJourneyTimelines(parentAccountId!, { providerId: providerScope, sessionId });
    res.json(result);
  } catch (e: any) {
    console.error("[journey-timeline] failed:", e?.message);
    res.status(500).json({ message: "Failed to build journey timeline" });
  }
});

// Phase 7C: journey funnel analytics. Admin sees any scope (aggregate or a
// single provider); provider users are force-scoped to their own org.
chatRouter.get("/api/journey/funnel", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN") || roles.includes("GOSTORK_CONCIERGE");
    const isProviderUser = !!user.providerId && !isAdmin;
    if (!isAdmin && !isProviderUser) return res.status(403).json({ message: "Forbidden" });

    const providerId = isProviderUser ? user.providerId : ((req.query.providerId as string) || null);
    const journeyType = (req.query.journeyType as string) || null;
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;

    const { buildJourneyFunnel } = await import("./journey-funnel");
    const data = await buildJourneyFunnel({
      providerId,
      journeyType,
      from: from && !isNaN(from.getTime()) ? from : null,
      to: to && !isNaN(to.getTime()) ? to : null,
      providerScope: isProviderUser,
    });
    res.json(data);
  } catch (e: any) {
    console.error("[journey-funnel] failed:", e?.message);
    res.status(500).json({ message: "Failed to build funnel" });
  }
});

// Recent journey activity for the provider/admin sidebar feed.
chatRouter.get("/api/journey/events", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN") || roles.includes("GOSTORK_CONCIERGE");
    const isProviderUser = !!user.providerId && !isAdmin;
    if (!isAdmin && !isProviderUser) return res.status(403).json({ message: "Forbidden" });

    const parentUserId = (req.query.parentUserId as string) || null;
    if (!parentUserId) return res.status(400).json({ message: "parentUserId required" });
    const parent = await prisma.user.findUnique({ where: { id: parentUserId }, select: { parentAccountId: true } });
    const parentAccountId = parent?.parentAccountId || parentUserId;
    const providerScope = isProviderUser ? user.providerId : ((req.query.providerId as string) || null);

    const events = await prisma.journeyEvent.findMany({
      where: { parentAccountId, ...(providerScope ? { providerId: providerScope } : {}) },
      orderBy: { createdAt: "desc" },
      take: Math.min(parseInt(String(req.query.limit || "20"), 10) || 20, 50),
      select: { id: true, eventType: true, actorRole: true, metadata: true, createdAt: true, providerId: true },
    });
    res.json({ events });
  } catch (e: any) {
    console.error("[journey-events] feed failed:", e?.message);
    res.status(500).json({ message: "Failed to load journey events" });
  }
});

chatRouter.get("/api/my/chat-sessions", requireAuth, async (req, res) => {
  const user = req.user as any;
  try {
    const accountUserIds = user.parentAccountId
      ? (await prisma.user.findMany({ where: { parentAccountId: user.parentAccountId }, select: { id: true } })).map(u => u.id)
      : [user.id];
    const sessions = await prisma.aiChatSession.findMany({
      where: { userId: { in: accountUserIds } },
      orderBy: { updatedAt: "desc" },
      include: {
        messages: { where: { uiCardType: { notIn: ["provider_assessment", "provider_only", "cost_sheet_draft_approval", "invoice_draft_approval", "agreement_draft_approval", "provider_readiness_prompt", "review_prompt", "ip_form_prompt"] } }, orderBy: { createdAt: "desc" }, take: 1 },
        provider: { select: { id: true, name: true, logoUrl: true } },
      },
    });
    const matchmakerIds = sessions.map(s => s.matchmakerId).filter(Boolean) as string[];
    const matchmakers = matchmakerIds.length > 0
      ? await prisma.matchmaker.findMany({ where: { id: { in: matchmakerIds } } })
      : [];
    const matchmakerMap = Object.fromEntries(matchmakers.map(m => [m.id, m]));
    // Count unread messages per session (messages from others that parent hasn't read)
    const sessionIds = sessions.map(s => s.id);
    const unreadCounts = sessionIds.length > 0
      ? await prisma.aiChatMessage.groupBy({
          by: ["sessionId"],
          where: {
            sessionId: { in: sessionIds },
            readAt: null,
            role: "assistant",
          },
          _count: true,
        })
      : [];
    const unreadMap: Record<string, number> = {};
    for (const uc of unreadCounts) unreadMap[uc.sessionId] = uc._count;

    const result = sessions.map(s => ({
      id: s.id,
      title: cleanSessionTitle(s.title),
      status: s.status,
      matchmakerId: s.matchmakerId,
      matchmakerName: s.matchmakerId ? matchmakerMap[s.matchmakerId]?.name : null,
      matchmakerAvatar: s.matchmakerId ? matchmakerMap[s.matchmakerId]?.avatarUrl : null,
      matchmakerTitle: s.matchmakerId ? matchmakerMap[s.matchmakerId]?.title : null,
      providerId: s.providerId,
      providerName: s.provider?.name || null,
      providerLogo: s.provider?.logoUrl || null,
      profilePhotoUrl: (s as any).profilePhotoUrl || null,
      subjectProfileId: (s as any).subjectProfileId || null,
      subjectType: (s as any).subjectType || null,
      providerJoinedAt: s.providerJoinedAt,
      humanRequested: s.humanRequested,
      humanJoinedAt: s.humanJoinedAt,
      humanConcludedAt: (s as any).humanConcludedAt || null,
      lastMessage: s.messages[0]?.content || null,
      lastMessageAt: s.messages[0]?.createdAt || s.updatedAt,
      lastMessageSenderType: s.messages[0]?.senderType || null,
      lastMessageRole: s.messages[0]?.role || null,
      lastMessageDeliveredAt: s.messages[0]?.deliveredAt || null,
      lastMessageReadAt: s.messages[0]?.readAt || null,
      unreadCount: unreadMap[s.id] || 0,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      profileAvailable: null as boolean | null,
      profileStatus: null as string | null,
    }));

    // Enrich profilePhotoUrl for sessions that have a subject profile but no stored photo
    const needPhoto = result.filter(s => !s.profilePhotoUrl && s.subjectProfileId && s.subjectType);
    if (needPhoto.length > 0) {
      const eggIds = needPhoto.filter(s => s.subjectType!.toLowerCase().includes("egg")).map(s => s.subjectProfileId!);
      const surrogateIds = needPhoto.filter(s => s.subjectType!.toLowerCase().includes("surrogate")).map(s => s.subjectProfileId!);
      const spermIds = needPhoto.filter(s => s.subjectType!.toLowerCase().includes("sperm")).map(s => s.subjectProfileId!);
      const [eggDonors, surrogates, spermDonors] = await Promise.all([
        eggIds.length ? prisma.eggDonor.findMany({ where: { id: { in: eggIds } }, select: { id: true, photos: true, photoUrl: true } }) : [],
        surrogateIds.length ? prisma.surrogate.findMany({ where: { id: { in: surrogateIds } }, select: { id: true, photos: true, photoUrl: true } }) : [],
        spermIds.length ? prisma.spermDonor.findMany({ where: { id: { in: spermIds } }, select: { id: true, photos: true, photoUrl: true } }) : [],
      ]);
      const photoMap: Record<string, string> = {};
      for (const p of [...eggDonors, ...surrogates, ...spermDonors]) {
        const photo = pickFirstValidPhoto(p.photos, p.photoUrl);
        if (photo) photoMap[p.id] = photo;
      }
      for (const s of result) {
        if (!s.profilePhotoUrl && s.subjectProfileId && photoMap[s.subjectProfileId]) {
          s.profilePhotoUrl = photoMap[s.subjectProfileId];
        }
      }
    }

    // Fallback: sessions with no subjectProfileId but title like "Donor #1234" or "Surrogate #1234"
    const titleNeedPhoto = result.filter(s => !s.profilePhotoUrl && !s.subjectProfileId);
    if (titleNeedPhoto.length > 0) {
      const eggTitleSessions = titleNeedPhoto.filter(s => /donor\s*#?\s*(\d+)/i.test(s.title || ""));
      const surrogateTitleSessions = titleNeedPhoto.filter(s => /surrogate\s*#?\s*(\d+)/i.test(s.title || ""));
      const spermTitleSessions = titleNeedPhoto.filter(s => /sperm\s*#?\s*(\d+)/i.test(s.title || ""));
      const extractExternalId = (title: string, pattern: RegExp) => (title.match(pattern) || [])[1] || null;
      const eggExternalIds = eggTitleSessions.map(s => extractExternalId(s.title || "", /donor\s*#?\s*(\d+)/i)).filter(Boolean) as string[];
      const surrogateExternalIds = surrogateTitleSessions.map(s => extractExternalId(s.title || "", /surrogate\s*#?\s*(\d+)/i)).filter(Boolean) as string[];
      const spermExternalIds = spermTitleSessions.map(s => extractExternalId(s.title || "", /sperm\s*#?\s*(\d+)/i)).filter(Boolean) as string[];
      const [eggByExt, surrogateByExt, spermByExt] = await Promise.all([
        eggExternalIds.length ? prisma.eggDonor.findMany({ where: { externalId: { in: eggExternalIds } }, select: { id: true, externalId: true, photos: true, photoUrl: true } }) : [],
        surrogateExternalIds.length ? prisma.surrogate.findMany({ where: { externalId: { in: surrogateExternalIds } }, select: { id: true, externalId: true, photos: true, photoUrl: true } }) : [],
        spermExternalIds.length ? prisma.spermDonor.findMany({ where: { externalId: { in: spermExternalIds } }, select: { id: true, externalId: true, photos: true, photoUrl: true } }) : [],
      ]);
      const extPhotoMap: Record<string, { uuid: string; photo: string }> = {};
      for (const p of [...eggByExt, ...surrogateByExt, ...spermByExt]) {
        if (!p.externalId) continue;
        const photo = pickFirstValidPhoto(p.photos, p.photoUrl);
        if (photo) extPhotoMap[p.externalId] = { uuid: p.id, photo };
      }
      for (const s of result) {
        if (s.profilePhotoUrl || s.subjectProfileId) continue;
        const title = s.title || "";
        const eggMatch = title.match(/donor\s*#?\s*(\d+)/i);
        const surrogateMatch = title.match(/surrogate\s*#?\s*(\d+)/i);
        const spermMatch = title.match(/sperm\s*#?\s*(\d+)/i);
        const extId = (eggMatch || surrogateMatch || spermMatch)?.[1];
        if (extId && extPhotoMap[extId]) {
          s.profilePhotoUrl = extPhotoMap[extId].photo;
          s.subjectProfileId = extPhotoMap[extId].uuid;
        }
      }
    }

    // Mark each session's subject profile with its canonical status and a
    // boolean for "bookable right now" (see computeProfileAvailability).
    const availMap = await computeProfileAvailability(result);
    for (const s of result) {
      if (s.subjectProfileId && availMap.has(s.subjectProfileId)) {
        const entry = availMap.get(s.subjectProfileId)!;
        s.profileAvailable = entry.available;
        s.profileStatus = entry.status;
      }
    }
    await applyMatchedLabelForInCycle(result);

    res.json(result);
  } catch (e) {
    console.error("My chat sessions error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

// Mark messages as read when a user opens/views a chat session
chatRouter.post("/api/chat-sessions/:id/read", requireAuth, async (req, res) => {
  const user = req.user as any;
  try {
    const session = await prisma.aiChatSession.findUnique({
      where: { id: req.params.id },
      select: { userId: true, providerId: true },
    });
    if (!session) return res.status(404).json({ message: "Not found" });

    // Determine which messages to mark as read (messages NOT sent by this viewer)
    const isProvider = !!user.providerId && session.providerId === user.providerId;
    let isAccountMember = false;
    if (!isProvider && user.parentAccountId) {
      const owner = await prisma.user.findUnique({ where: { id: session.userId }, select: { parentAccountId: true } });
      isAccountMember = !!owner && owner.parentAccountId === user.parentAccountId;
    }
    const isOwner = session.userId === user.id;
    const isAdmin = isAdminOrConcierge(user);
    if (!isOwner && !isAccountMember && !isProvider && !isAdmin) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const now = new Date();
    // For providers: mark parent/AI messages as read
    // For admins: mark parent/user messages as read
    // For parents: mark provider/AI/human messages as read
    const updated = await prisma.aiChatMessage.updateMany({
      where: {
        sessionId: req.params.id,
        readAt: null,
        ...(isProvider
          ? { senderType: { not: "provider" } }
          : isAdmin
          ? { senderType: { in: ["parent", "user"] } }
          : { OR: [{ role: "assistant" }, { senderType: { in: ["provider", "system", "human", "ai"] } }] }),
      },
      data: { readAt: now, deliveredAt: now },
    });

    res.json({ updated: updated.count });
  } catch (e: any) {
    console.error("Mark read error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.patch("/api/my/chat-session/matchmaker", requireAuth, async (req, res) => {
  const user = req.user as any;
  const { matchmakerId } = req.body;
  if (!matchmakerId) return res.status(400).json({ message: "matchmakerId required" });
  try {
    const accountUserIds = user.parentAccountId
      ? (await prisma.user.findMany({ where: { parentAccountId: user.parentAccountId }, select: { id: true } })).map(u => u.id)
      : [user.id];
    const session = await prisma.aiChatSession.findFirst({
      where: { userId: { in: accountUserIds }, providerId: null },
      orderBy: { updatedAt: "desc" },
    });
    if (!session) return res.status(404).json({ message: "No concierge session found" });
    const updated = await prisma.aiChatSession.update({
      where: { id: session.id },
      data: { matchmakerId },
    });
    const matchmaker = await prisma.matchmaker.findUnique({ where: { id: matchmakerId } });
    res.json({
      sessionId: updated.id,
      matchmakerId: updated.matchmakerId,
      matchmakerName: matchmaker?.name || null,
      matchmakerAvatar: matchmaker?.avatarUrl || null,
      matchmakerTitle: matchmaker?.title || null,
    });
  } catch (e) {
    console.error("Update matchmaker error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

chatRouter.get("/api/admin/concierge-sessions", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isAdminOrConcierge(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const sessions = await prisma.aiChatSession.findMany({
      where: {
        status: { in: ["ACTIVE", "HUMAN_JOINED", "CONSULTATION_BOOKED", "PROVIDER_CONNECTED"] },
        sessionType: { not: "PROVIDER_CONCIERGE" },
      },
      include: {
        user: { select: { id: true, name: true, email: true, photoUrl: true } },
        provider: { select: { id: true, name: true, logoUrl: true } },
        messages: { where: { uiCardType: { notIn: ["provider_assessment", "provider_only", "cost_sheet_draft_approval", "invoice_draft_approval", "agreement_draft_approval", "provider_readiness_prompt", "review_prompt", "ip_form_prompt"] } }, orderBy: { createdAt: "desc" }, take: 1 },
        _count: { select: { messages: true } },
      },
      orderBy: [{ humanRequested: "desc" }, { updatedAt: "desc" }],
      take: 200,
    });
    // Count unread messages from parents per session (senderType parent/user, readAt null)
    const sessionIds = sessions.map(s => s.id);
    const unreadCounts = sessionIds.length > 0
      ? await prisma.aiChatMessage.groupBy({
          by: ["sessionId"],
          where: { sessionId: { in: sessionIds }, readAt: null, senderType: { in: ["parent", "user"] } },
          _count: true,
        })
      : [];
    const unreadMap: Record<string, number> = {};
    for (const uc of unreadCounts) unreadMap[uc.sessionId] = uc._count;

    // Resolve the parent-selected matchmaker (avatar + name + title) for each
    // session so the admin sidebar / header can show the actual persona the
    // parent picked instead of a generic "AI Concierge" + sparkle icon.
    const adminMatchmakerIds = sessions.map(s => s.matchmakerId).filter(Boolean) as string[];
    const adminMatchmakers = adminMatchmakerIds.length > 0
      ? await prisma.matchmaker.findMany({ where: { id: { in: adminMatchmakerIds } } })
      : [];
    const adminMatchmakerMap = Object.fromEntries(adminMatchmakers.map(m => [m.id, m]));

    const result = sessions.map(s => ({
      id: s.id,
      userId: s.userId,
      userName: s.user.name,
      userEmail: s.user.email,
      userAvatar: (s.user as any).photoUrl,
      status: s.status,
      sessionType: (s as any).sessionType || "PARENT",
      matchmakerId: s.matchmakerId,
      matchmakerName: s.matchmakerId ? adminMatchmakerMap[s.matchmakerId]?.name || null : null,
      matchmakerAvatar: s.matchmakerId ? adminMatchmakerMap[s.matchmakerId]?.avatarUrl || null : null,
      matchmakerTitle: s.matchmakerId ? adminMatchmakerMap[s.matchmakerId]?.title || null : null,
      humanRequested: s.humanRequested,
      humanJoinedAt: s.humanJoinedAt,
      humanConcludedAt: (s as any).humanConcludedAt || null,
      providerId: s.providerId,
      providerName: s.provider?.name || null,
      providerLogo: s.provider?.logoUrl || null,
      providerJoinedAt: s.providerJoinedAt,
      title: cleanSessionTitle(s.title) || null,
      profilePhotoUrl: (s as any).profilePhotoUrl || null,
      subjectProfileId: (s as any).subjectProfileId || null,
      subjectType: (s as any).subjectType || null,
      messageCount: s._count.messages,
      lastMessage: s.messages[0]?.content?.slice(0, 120) || null,
      lastMessageAt: s.messages[0]?.createdAt || s.updatedAt,
      lastMessageSenderType: s.messages[0]?.senderType || null,
      unreadCount: unreadMap[s.id] || 0,
      createdAt: s.createdAt,
      profileAvailable: null as boolean | null,
      profileStatus: null as string | null,
    }));

    // Enrich profilePhotoUrl for sessions that have a subject profile but no stored photo
    const needPhoto = result.filter(s => !s.profilePhotoUrl && s.subjectProfileId && s.subjectType);
    if (needPhoto.length > 0) {
      const eggIds = needPhoto.filter(s => s.subjectType!.toLowerCase().includes("egg")).map(s => s.subjectProfileId!);
      const surrogateIds = needPhoto.filter(s => s.subjectType!.toLowerCase().includes("surrogate")).map(s => s.subjectProfileId!);
      const spermIds = needPhoto.filter(s => s.subjectType!.toLowerCase().includes("sperm")).map(s => s.subjectProfileId!);
      const [eggDonors, surrogates, spermDonors] = await Promise.all([
        eggIds.length ? prisma.eggDonor.findMany({ where: { id: { in: eggIds } }, select: { id: true, photos: true, photoUrl: true } }) : [],
        surrogateIds.length ? prisma.surrogate.findMany({ where: { id: { in: surrogateIds } }, select: { id: true, photos: true, photoUrl: true } }) : [],
        spermIds.length ? prisma.spermDonor.findMany({ where: { id: { in: spermIds } }, select: { id: true, photos: true, photoUrl: true } }) : [],
      ]);
      const photoMap: Record<string, string> = {};
      for (const p of [...eggDonors, ...surrogates, ...spermDonors]) {
        const photo = pickFirstValidPhoto(p.photos, p.photoUrl);
        if (photo) photoMap[p.id] = photo;
      }
      for (const s of result) {
        if (!s.profilePhotoUrl && s.subjectProfileId && photoMap[s.subjectProfileId]) {
          s.profilePhotoUrl = photoMap[s.subjectProfileId];
        }
      }
    }

    // Fallback: sessions with no subjectProfileId but title like "Donor #1234" or "Surrogate #1234"
    const titleNeedPhoto = result.filter(s => !s.profilePhotoUrl && !s.subjectProfileId);
    if (titleNeedPhoto.length > 0) {
      const eggTitleSessions = titleNeedPhoto.filter(s => /donor\s*#?\s*(\d+)/i.test(s.title || ""));
      const surrogateTitleSessions = titleNeedPhoto.filter(s => /surrogate\s*#?\s*(\d+)/i.test(s.title || ""));
      const spermTitleSessions = titleNeedPhoto.filter(s => /sperm\s*#?\s*(\d+)/i.test(s.title || ""));
      const extractExtId = (title: string, pattern: RegExp) => (title.match(pattern) || [])[1] || null;
      const eggExtIds = eggTitleSessions.map(s => extractExtId(s.title || "", /donor\s*#?\s*(\d+)/i)).filter(Boolean) as string[];
      const surrogateExtIds = surrogateTitleSessions.map(s => extractExtId(s.title || "", /surrogate\s*#?\s*(\d+)/i)).filter(Boolean) as string[];
      const spermExtIds = spermTitleSessions.map(s => extractExtId(s.title || "", /sperm\s*#?\s*(\d+)/i)).filter(Boolean) as string[];
      const [eggByExt, surrogateByExt, spermByExt] = await Promise.all([
        eggExtIds.length ? prisma.eggDonor.findMany({ where: { externalId: { in: eggExtIds } }, select: { id: true, externalId: true, photos: true, photoUrl: true } }) : [],
        surrogateExtIds.length ? prisma.surrogate.findMany({ where: { externalId: { in: surrogateExtIds } }, select: { id: true, externalId: true, photos: true, photoUrl: true } }) : [],
        spermExtIds.length ? prisma.spermDonor.findMany({ where: { externalId: { in: spermExtIds } }, select: { id: true, externalId: true, photos: true, photoUrl: true } }) : [],
      ]);
      const extPhotoMap: Record<string, string> = {};
      for (const p of [...eggByExt, ...surrogateByExt, ...spermByExt]) {
        if (!p.externalId) continue;
        const photo = pickFirstValidPhoto(p.photos, p.photoUrl);
        if (photo) extPhotoMap[p.externalId] = photo;
      }
      for (const s of result) {
        if (s.profilePhotoUrl || s.subjectProfileId) continue;
        const title = s.title || "";
        const match = title.match(/(?:donor|surrogate|sperm)\s*#?\s*(\d+)/i);
        if (match?.[1] && extPhotoMap[match[1]]) {
          s.profilePhotoUrl = extPhotoMap[match[1]];
        }
      }
    }

    // Mark each session's subject profile with its canonical status and a
    // boolean for "bookable right now" (see computeProfileAvailability).
    const adminAvailMap = await computeProfileAvailability(result);
    for (const s of result) {
      if (s.subjectProfileId && adminAvailMap.has(s.subjectProfileId)) {
        const entry = adminAvailMap.get(s.subjectProfileId)!;
        s.profileAvailable = entry.available;
        s.profileStatus = entry.status;
      }
    }
    await applyMatchedLabelForInCycle(result);

    res.json(result);
  } catch (e: any) {
    console.error("Admin concierge sessions error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.get("/api/admin/concierge-sessions/:id", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isAdminOrConcierge(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const session = await prisma.aiChatSession.findUnique({
      where: { id: req.params.id },
      include: {
        user: {
          select: {
            id: true, name: true, email: true, photoUrl: true, city: true, state: true, mobileNumber: true, relationshipStatus: true, partnerFirstName: true, partnerAge: true, dateOfBirth: true, parentAccountId: true,
            parentAccount: {
              select: {
                intendedParentProfile: { select: { journeyStage: true, interestedServices: true, isFirstIvf: true, eggSource: true, spermSource: true, carrier: true, hasEmbryos: true, embryoCount: true, embryosTested: true, needsClinic: true, currentClinicName: true, clinicPriority: true, needsEggDonor: true, needsSurrogate: true, surrogateCountries: true, surrogateTermination: true, surrogateTwins: true, surrogateAgeRange: true, surrogateBudget: true, surrogateExperience: true, surrogateMedPrefs: true, donorPreferences: true, donorEyeColor: true, donorHairColor: true, donorHeight: true, donorEducation: true, donorEthnicity: true, spermDonorType: true, currentAgencyName: true, currentAttorneyName: true } },
              },
            },
          },
        },
        messages: { orderBy: { createdAt: "asc" } },
        agreements: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, status: true, signerStatus: true, signedAt: true, pandaDocViewUrl: true, pandaDocDocumentId: true, createdAt: true },
        },
      },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });
    const adminDetailAvail = await computeProfileAvailability([session as any]);
    const adminDetailEntry = (session as any).subjectProfileId ? adminDetailAvail.get((session as any).subjectProfileId) : null;
    const adminDetailRow = { id: session.id, profileStatus: adminDetailEntry ? adminDetailEntry.status : null };
    await applyMatchedLabelForInCycle([adminDetailRow]);
    const adminDetailMatchmaker = session.matchmakerId
      ? await prisma.matchmaker.findUnique({ where: { id: session.matchmakerId }, select: { name: true, avatarUrl: true, title: true } }).catch(() => null)
      : null;
    res.json({
      ...session,
      profileAvailable: adminDetailEntry ? adminDetailEntry.available : null,
      profileStatus: adminDetailRow.profileStatus,
      matchmakerName: adminDetailMatchmaker?.name || null,
      matchmakerAvatar: adminDetailMatchmaker?.avatarUrl || null,
      matchmakerTitle: adminDetailMatchmaker?.title || null,
    });
  } catch (e: any) {
    console.error("Admin concierge session detail error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/admin/concierge-sessions/:id/join", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isAdminOrConcierge(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const session = await prisma.aiChatSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ message: "Session not found" });
    // Block re-join only if already joined AND not yet concluded (active session)
    console.log(`[join] humanJoinedAt=${session.humanJoinedAt}, humanConcludedAt=${(session as any).humanConcludedAt}, humanRequested=${session.humanRequested}`);
    if (session.humanJoinedAt && !(session as any).humanConcludedAt) return res.json({ alreadyJoined: true });

    const expertName = user.name || "GoStork Expert";
    const expertFirstName = expertName.split(" ")[0];
    // Preserve PROVIDER_CONNECTED status if provider is already in the chat
    const newStatus = session.status === "PROVIDER_CONNECTED" ? "PROVIDER_CONNECTED" : "HUMAN_JOINED";
    await prisma.aiChatSession.update({
      where: { id: session.id },
      data: { humanJoinedAt: new Date(), humanConcludedAt: null, humanAgentId: user.id, status: newStatus },
    });

    await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: `${expertFirstName} from the GoStork concierge team has joined our chat. Feel free to talk :)`,
        senderType: "system",
        senderName: "GoStork",
      },
    });

    const sessionOwner = await prisma.user.findUnique({ where: { id: session.userId }, select: { parentAccountId: true } });
    const notifyUserIds = sessionOwner?.parentAccountId
      ? (await prisma.user.findMany({ where: { parentAccountId: sessionOwner.parentAccountId }, select: { id: true } })).map(u => u.id)
      : [session.userId];
    for (const notifyId of notifyUserIds) {
      await prisma.inAppNotification.create({
        data: {
          userId: notifyId,
          eventType: "HUMAN_JOINED",
          payload: {
            sessionId: session.id,
            expertName,
            message: `${expertName} from the GoStork team has joined your chat`,
          },
        },
      });
    }

    res.json({ success: true });
  } catch (e: any) {
    console.error("Admin concierge join error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/admin/concierge-sessions/:id/exit-human", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isAdminOrConcierge(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const session = await prisma.aiChatSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ message: "Session not found" });

    const expertFirstName = (user.name || "GoStork Expert").split(" ")[0];

    await prisma.aiChatSession.update({
      where: { id: session.id },
      data: {
        humanConcludedAt: new Date(),
        humanRequested: false,
        status: session.status === "PROVIDER_CONNECTED" ? "PROVIDER_CONNECTED" : "ACTIVE",
      },
    });

    // Clear any Needs-attention dismissal for this escalation so a FUTURE
    // escalation on the same session surfaces again (the escalation
    // taskKey has no occurrence timestamp - the session id is the key).
    await prisma.adminTaskDismissal.deleteMany({ where: { taskKey: `escalation:${session.id}` } }).catch(() => {});

    await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: `${expertFirstName} from the GoStork concierge team has left our chat. I'm here if you need anything else!`,
        senderType: "system",
        senderName: "GoStork",
      },
    });

    // Notify the parent user via SSE so the button re-enables immediately
    try {
      const { getNestApp } = await import("./nest-app-ref");
      const nestApp = getNestApp();
      if (nestApp) {
        const { AppEventsService } = await import("./src/modules/notifications/app-events.service");
        let appEvents: any = null;
        try { appEvents = nestApp.get(AppEventsService); } catch {}
        if (appEvents) {
          // Get all users on the parent's account to notify all of them
          const sessionOwner = await prisma.user.findUnique({ where: { id: session.userId }, select: { parentAccountId: true } });
          const notifyUserIds = sessionOwner?.parentAccountId
            ? (await prisma.user.findMany({ where: { parentAccountId: sessionOwner.parentAccountId }, select: { id: true } })).map((u: any) => u.id)
            : [session.userId];
          appEvents.emit({
            type: "human_concluded",
            payload: { sessionId: session.id },
            targetUserIds: notifyUserIds,
          }).catch(() => {});
        }
      }
    } catch {}

    console.log(`[exit-human] Session ${session.id}: human concierge exited, AI re-enabled`);
    res.json({ success: true });
  } catch (e: any) {
    console.error("Admin concierge exit error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Parent requests human help - sets humanRequested and notifies admins directly (no AI needed)
chatRouter.post("/api/chat-sessions/:id/request-human", requireAuth, async (req, res) => {
  const user = req.user as any;
  try {
    const session = await prisma.aiChatSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ message: "Session not found" });

    // Verify access: must be session owner or account member
    const accountUserIds = user.parentAccountId
      ? (await prisma.user.findMany({ where: { parentAccountId: user.parentAccountId }, select: { id: true } })).map((u: any) => u.id)
      : [user.id];
    if (!accountUserIds.includes(session.userId) && !isAdminUser(user)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (session.humanRequested) return res.json({ alreadyRequested: true });

    await prisma.aiChatSession.update({
      where: { id: session.id },
      data: { humanRequested: true },
    });

    // Post a system message in the chat so the parent sees confirmation
    await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: "We've notified the GoStork concierge team and someone will join this chat shortly. Feel free to keep chatting or wait here - they'll see the full conversation when they arrive.",
        senderType: "system",
        senderName: "GoStork",
      },
    });

    // Notify admins and concierge team (in-app + email + SMS)
    const admins = await prisma.user.findMany({
      where: { roles: { hasSome: ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE"] } },
      select: { id: true },
    });
    for (const admin of admins) {
      await prisma.inAppNotification.create({
        data: {
          userId: admin.id,
          eventType: "HUMAN_ESCALATION",
          payload: {
            parentName: user.name || "A parent",
            parentUserId: user.id,
            sessionId: session.id,
            message: `${user.name || "A parent"} has requested to speak with a human concierge`,
          },
        },
      });
    }

    // Email + SMS via standalone notifier
    const { notifyAdminsHumanEscalation } = await import("./notify-admin-escalation");
    notifyAdminsHumanEscalation({
      parentName: user.name || "A parent",
      parentEmail: user.email || "",
      parentPhone: user.mobileNumber,
      sessionId: session.id,
    }).catch((e: any) => console.error("[request-human] Email/SMS failed:", e));

    // SSE real-time toast to admins
    try {
      const { getNestApp } = await import("./nest-app-ref");
      const nestApp = getNestApp();
      if (nestApp) {
        const { AppEventsService } = await import("./src/modules/notifications/app-events.service");
        let appEvents: any = null;
        try { appEvents = nestApp.get(AppEventsService); } catch {}
        if (appEvents) {
          appEvents.emit({
            type: "human_escalation",
            payload: {
              parentName: user.name || "A parent",
              sessionId: session.id,
              message: `${user.name || "A parent"} has requested to speak with a human concierge`,
            },
            targetUserIds: admins.map((a: any) => a.id),
          }).catch(() => {});
        }
      }
    } catch {}

    console.log(`[request-human] Session ${session.id}: humanRequested=true, admins notified`);
    res.json({ success: true });
  } catch (e: any) {
    console.error("Request human error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/admin/concierge-sessions/:id/message", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isAdminOrConcierge(user)) return res.status(403).json({ message: "Forbidden" });
  const { content, uiCardType, uiCardData } = req.body;
  if (!content || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ message: "Content is required" });
  }
  try {
    const session = await prisma.aiChatSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ message: "Session not found" });

    const message = await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: content.trim(),
        senderType: "human",
        senderName: user.name || "GoStork Expert",
        ...(uiCardType ? { uiCardType } : {}),
        ...(uiCardData ? { uiCardData } : {}),
      },
    });
    await prisma.aiChatSession.update({
      where: { id: session.id },
      data: { updatedAt: new Date(), ...(!session.humanAgentId ? { humanAgentId: user.id } : {}) },
    });

    await prisma.inAppNotification.create({
      data: {
        userId: session.userId,
        eventType: "HUMAN_MESSAGE",
        payload: {
          sessionId: session.id,
          message: "A GoStork concierge has sent you a message",
          preview: content.trim().slice(0, 100),
        },
      },
    });

    res.json(message);
  } catch (e: any) {
    console.error("Admin concierge message error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/consultation/request-callback", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    const { providerId, providerName, name, email, message } = req.body;
    if (!providerId || !name || !email) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const provider = await prisma.provider.findUnique({
      where: { id: providerId },
      select: { email: true, name: true },
    });
    const recipientEmail = provider?.email;
    if (!recipientEmail) {
      return res.status(400).json({ message: "Provider has no email on file" });
    }

    const sendgridKey = process.env.SENDGRID_API_KEY;
    if (sendgridKey) {
      const fromEmail = process.env.SENDGRID_FROM_EMAIL || "noreply@gostork.com";
      const brand = await fetchEmailBrandData(prisma);
      const html = buildBrandedEmail(brand, {
        title: "New Consultation Request",
        greeting: `A prospective parent has requested a consultation callback through ${brand.companyName}.`,
        body: "",
        detailRows: [
          { label: "Name", value: escapeHtml(name) },
          { label: "Email", value: escapeHtml(email) },
          ...(message ? [{ label: "Message", value: escapeHtml(message) }] : []),
        ],
        footer: "Please reach out to this parent to schedule a consultation.",
      });
      await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sendgridKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: recipientEmail }] }],
          from: { email: fromEmail, name: brand.companyName },
          subject: `Consultation Request from ${name}`,
          content: [{ type: "text/html", value: html }],
        }),
      });
    }

    const parentAccountId = user.parentAccountId;
    if (parentAccountId) {
      await prisma.intendedParentProfile.update({
        where: { parentAccountId },
        data: { journeyStage: "Consultation Requested" },
      }).catch(() => {});
    }

    // Inject AI confirmation message into chat so parent sees it inline
    const { aiSessionId } = req.body;
    if (aiSessionId) {
      const confirmationText = `✅ Your consultation request has been sent to ${escapeHtml(providerName || provider?.name || "the clinic")}! They'll reach out to you shortly to schedule your call.\n\nNow, let's keep the momentum going!`;
      await prisma.aiChatMessage.create({
        data: {
          sessionId: aiSessionId,
          role: "assistant",
          content: confirmationText,
          uiCardData: {},
        },
      }).catch(() => {});
    }

    res.json({ success: true });
  } catch (e: any) {
    console.error("Consultation callback error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.get("/api/provider/concierge-sessions", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const roles: string[] = user.roles || [];
    const isAllSessionRole = (ALL_SESSION_PROVIDER_ROLES as readonly string[]).some(r => roles.includes(r));
    const coordinatorTypes = !isAllSessionRole
      ? roles.flatMap((r: string) => COORDINATOR_SUBJECT_TYPES[r] || [])
      : null;
    const subjectTypeFilter = coordinatorTypes && coordinatorTypes.length > 0
      ? { OR: [{ subjectType: null }, { subjectType: { in: coordinatorTypes } }] }
      : {};

    const sessions = await prisma.aiChatSession.findMany({
      where: {
        providerId: user.providerId,
        status: { in: ["ACTIVE", "HUMAN_JOINED", "CONSULTATION_BOOKED", "PROVIDER_CONNECTED"] },
        sessionType: { not: "PROVIDER_CONCIERGE" },
        ...subjectTypeFilter,
      },
      include: {
        user: { select: { id: true, name: true, email: true, photoUrl: true } },
        messages: { where: { uiCardType: { notIn: ["provider_assessment", "provider_only", "cost_sheet_draft_approval", "invoice_draft_approval", "agreement_draft_approval", "provider_readiness_prompt", "review_prompt", "ip_form_prompt"] } }, orderBy: { createdAt: "desc" }, take: 1 },
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });

    const pendingCounts = await prisma.silentQuery.groupBy({
      by: ["sessionId"],
      where: { providerId: user.providerId, status: "PENDING" },
      _count: true,
      _min: { createdAt: true },
      _max: { reminderCount: true },
    });
    const pendingBySession: Record<string, number> = {};
    const oldestPendingBySession: Record<string, string> = {};
    const nudgeCountBySession: Record<string, number> = {};
    for (const pc of pendingCounts) {
      pendingBySession[pc.sessionId] = pc._count;
      if (pc._min?.createdAt) oldestPendingBySession[pc.sessionId] = pc._min.createdAt.toISOString();
      if (typeof pc._max?.reminderCount === "number") nudgeCountBySession[pc.sessionId] = pc._max.reminderCount;
    }

    // Count unread parent messages per session - but only for sessions where
    // the provider can actually see parent messages (identity revealed, i.e.
    // CONSULTATION_BOOKED or PROVIDER_CONNECTED). During the anonymous whisper
    // phase the provider transcript hides parent messages entirely, and the
    // inbox may hide the session itself, so counting them would badge the
    // provider with unreads they can never see or clear. Provider-actionable
    // items in that phase are counted separately via pendingQuestions.
    const identityRevealedIds = sessions
      .filter(s => s.status === "CONSULTATION_BOOKED" || s.status === "PROVIDER_CONNECTED")
      .map(s => s.id);
    const unreadCounts = identityRevealedIds.length > 0
      ? await prisma.aiChatMessage.groupBy({
          by: ["sessionId"],
          where: {
            sessionId: { in: identityRevealedIds },
            readAt: null,
            OR: [
              { senderType: { in: ["parent", "user"] } },
              // Provider-directed AI/system messages count too: the "parent
              // is ready" notify (provider_only), the readiness question,
              // and the approval cards are exactly what the provider must
              // not miss - a badge that ignores them hides real work.
              {
                uiCardType: {
                  in: [
                    "provider_only",
                    "provider_readiness_prompt",
                    "agreement_draft_approval",
                    "invoice_draft_approval",
                    "cost_sheet_draft_approval",
                  ],
                },
              },
            ],
          },
          _count: true,
        })
      : [];
    const unreadMap: Record<string, number> = {};
    for (const uc of unreadCounts) unreadMap[uc.sessionId] = uc._count;

    // Resolve the parent-selected matchmaker (avatar + name + title) per
    // session - provider list rows should show the persona the parent picked,
    // not a generic sparkle icon.
    const providerMatchmakerIds = sessions.map(s => s.matchmakerId).filter(Boolean) as string[];
    const providerMatchmakers = providerMatchmakerIds.length > 0
      ? await prisma.matchmaker.findMany({ where: { id: { in: providerMatchmakerIds } } })
      : [];
    const providerMatchmakerMap = Object.fromEntries(providerMatchmakers.map(m => [m.id, m]));

    const result = sessions.map(s => {
      const isJoined = s.status === "PROVIDER_CONNECTED";
      const isConsultationBooked = s.status === "CONSULTATION_BOOKED";
      return {
        id: s.id,
        userId: s.userId,
        userName: isJoined || isConsultationBooked ? s.user.name : "Prospective Parent",
        userEmail: isJoined || isConsultationBooked ? s.user.email : null,
        userAvatar: isJoined || isConsultationBooked ? (s.user as any).photoUrl : null,
        status: s.status,
        sessionType: (s as any).sessionType || "PARENT",
        matchmakerId: s.matchmakerId,
        matchmakerName: s.matchmakerId ? providerMatchmakerMap[s.matchmakerId]?.name || null : null,
        matchmakerAvatar: s.matchmakerId ? providerMatchmakerMap[s.matchmakerId]?.avatarUrl || null : null,
        matchmakerTitle: s.matchmakerId ? providerMatchmakerMap[s.matchmakerId]?.title || null : null,
        providerJoinedAt: s.providerJoinedAt,
        providerName: (s as any).providerName,
        title: cleanSessionTitle(s.title) || null,
        profilePhotoUrl: (s as any).profilePhotoUrl || null,
        subjectProfileId: (s as any).subjectProfileId || null,
        subjectType: (s as any).subjectType || null,
        messageCount: s._count.messages,
        lastMessage: s.messages[0]?.content?.slice(0, 120) || null,
        lastMessageAt: s.messages[0]?.createdAt || s.updatedAt,
        lastMessageSenderType: s.messages[0]?.senderType || null,
        unreadCount: unreadMap[s.id] || 0,
        createdAt: s.createdAt,
        pendingQuestions: pendingBySession[s.id] || 0,
        oldestPendingAt: oldestPendingBySession[s.id] || null,
        pendingMaxAgeMinutes: oldestPendingBySession[s.id]
          ? Math.max(0, Math.floor((Date.now() - new Date(oldestPendingBySession[s.id]).getTime()) / 60000))
          : 0,
        pendingNudgeCount: nudgeCountBySession[s.id] || 0,
        profileAvailable: null as boolean | null,
        profileStatus: null as string | null,
      };
    });
    result.sort((a, b) => {
      if (a.status === "CONSULTATION_BOOKED" && b.status !== "CONSULTATION_BOOKED") return -1;
      if (b.status === "CONSULTATION_BOOKED" && a.status !== "CONSULTATION_BOOKED") return 1;
      if (a.pendingQuestions > 0 && b.pendingQuestions === 0) return -1;
      if (b.pendingQuestions > 0 && a.pendingQuestions === 0) return 1;
      // Both have pending whispers -> oldest first so SLA pressure surfaces
      if (a.pendingQuestions > 0 && b.pendingQuestions > 0) {
        if (a.pendingMaxAgeMinutes !== b.pendingMaxAgeMinutes) {
          return b.pendingMaxAgeMinutes - a.pendingMaxAgeMinutes;
        }
      }
      return 0;
    });

    // Enrich profilePhotoUrl for sessions that have a subject profile but no stored photo
    const needPhoto = result.filter(s => !s.profilePhotoUrl && s.subjectProfileId && s.subjectType);
    if (needPhoto.length > 0) {
      const eggIds = needPhoto.filter(s => s.subjectType!.toLowerCase().includes("egg")).map(s => s.subjectProfileId!);
      const surrogateIds = needPhoto.filter(s => s.subjectType!.toLowerCase().includes("surrogate")).map(s => s.subjectProfileId!);
      const spermIds = needPhoto.filter(s => s.subjectType!.toLowerCase().includes("sperm")).map(s => s.subjectProfileId!);
      const [eggDonors, surrogates, spermDonors] = await Promise.all([
        eggIds.length ? prisma.eggDonor.findMany({ where: { id: { in: eggIds } }, select: { id: true, photos: true, photoUrl: true } }) : [],
        surrogateIds.length ? prisma.surrogate.findMany({ where: { id: { in: surrogateIds } }, select: { id: true, photos: true, photoUrl: true } }) : [],
        spermIds.length ? prisma.spermDonor.findMany({ where: { id: { in: spermIds } }, select: { id: true, photos: true, photoUrl: true } }) : [],
      ]);
      const photoMap: Record<string, string> = {};
      for (const p of [...eggDonors, ...surrogates, ...spermDonors]) {
        const photo = pickFirstValidPhoto(p.photos, p.photoUrl);
        if (photo) photoMap[p.id] = photo;
      }
      for (const s of result) {
        if (!s.profilePhotoUrl && s.subjectProfileId && photoMap[s.subjectProfileId]) {
          s.profilePhotoUrl = photoMap[s.subjectProfileId];
        }
      }
    }

    // Fallback: sessions with no subjectProfileId but title like "Donor #1234" or "Surrogate #1234"
    const titleNeedPhoto = result.filter(s => !s.profilePhotoUrl && !s.subjectProfileId);
    if (titleNeedPhoto.length > 0) {
      const eggTitleSessions = titleNeedPhoto.filter(s => /donor\s*#?\s*(\d+)/i.test(s.title || ""));
      const surrogateTitleSessions = titleNeedPhoto.filter(s => /surrogate\s*#?\s*(\d+)/i.test(s.title || ""));
      const spermTitleSessions = titleNeedPhoto.filter(s => /sperm\s*#?\s*(\d+)/i.test(s.title || ""));
      const extractExtId = (title: string, pattern: RegExp) => (title.match(pattern) || [])[1] || null;
      const eggExtIds = eggTitleSessions.map(s => extractExtId(s.title || "", /donor\s*#?\s*(\d+)/i)).filter(Boolean) as string[];
      const surrogateExtIds = surrogateTitleSessions.map(s => extractExtId(s.title || "", /surrogate\s*#?\s*(\d+)/i)).filter(Boolean) as string[];
      const spermExtIds = spermTitleSessions.map(s => extractExtId(s.title || "", /sperm\s*#?\s*(\d+)/i)).filter(Boolean) as string[];
      const [eggByExt, surrogateByExt, spermByExt] = await Promise.all([
        eggExtIds.length ? prisma.eggDonor.findMany({ where: { externalId: { in: eggExtIds } }, select: { id: true, externalId: true, photos: true, photoUrl: true } }) : [],
        surrogateExtIds.length ? prisma.surrogate.findMany({ where: { externalId: { in: surrogateExtIds } }, select: { id: true, externalId: true, photos: true, photoUrl: true } }) : [],
        spermExtIds.length ? prisma.spermDonor.findMany({ where: { externalId: { in: spermExtIds } }, select: { id: true, externalId: true, photos: true, photoUrl: true } }) : [],
      ]);
      const extPhotoMap: Record<string, string> = {};
      for (const p of [...eggByExt, ...surrogateByExt, ...spermByExt]) {
        if (!p.externalId) continue;
        const photo = pickFirstValidPhoto(p.photos, p.photoUrl);
        if (photo) extPhotoMap[p.externalId] = photo;
      }
      for (const s of result) {
        if (s.profilePhotoUrl || s.subjectProfileId) continue;
        const title = s.title || "";
        const match = title.match(/(?:donor|surrogate|sperm)\s*#?\s*(\d+)/i);
        if (match?.[1] && extPhotoMap[match[1]]) {
          s.profilePhotoUrl = extPhotoMap[match[1]];
        }
      }
    }

    // Mark each session's subject profile with its canonical status and a
    // boolean for "bookable right now" (see computeProfileAvailability).
    const provAvailMap = await computeProfileAvailability(result);
    for (const s of result) {
      if (s.subjectProfileId && provAvailMap.has(s.subjectProfileId)) {
        const entry = provAvailMap.get(s.subjectProfileId)!;
        s.profileAvailable = entry.available;
        s.profileStatus = entry.status;
      }
    }
    await applyMatchedLabelForInCycle(result);

    res.json(result);
  } catch (e: any) {
    console.error("Provider concierge sessions error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.get("/api/provider/concierge-sessions/:id", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const session = await prisma.aiChatSession.findUnique({
      where: { id: req.params.id },
      include: {
        user: {
          select: {
            id: true, name: true, email: true, photoUrl: true, city: true, state: true, mobileNumber: true, relationshipStatus: true, partnerFirstName: true, partnerAge: true, dateOfBirth: true, parentAccountId: true,
            parentAccount: {
              select: {
                intendedParentProfile: { select: { journeyStage: true, interestedServices: true, isFirstIvf: true, eggSource: true, spermSource: true, carrier: true, hasEmbryos: true, embryoCount: true, embryosTested: true, needsClinic: true, currentClinicName: true, clinicPriority: true, needsEggDonor: true, needsSurrogate: true, surrogateCountries: true, surrogateTermination: true, surrogateTwins: true, surrogateAgeRange: true, surrogateBudget: true, surrogateExperience: true, surrogateMedPrefs: true, donorPreferences: true, donorEyeColor: true, donorHairColor: true, donorHeight: true, donorEducation: true, donorEthnicity: true, spermDonorType: true, currentAgencyName: true, currentAttorneyName: true } },
              },
            },
          },
        },
        messages: { orderBy: { createdAt: "asc" } },
        agreements: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, status: true, signerStatus: true, signedAt: true, pandaDocViewUrl: true, pandaDocDocumentId: true, createdAt: true },
        },
      },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (session.providerId !== user.providerId) return res.status(403).json({ message: "Forbidden" });
    if (!canProviderAccessSession(user.roles || [], (session as any).subjectType)) return res.status(403).json({ message: "Forbidden" });

    const isJoined = session.status === "PROVIDER_CONNECTED";
    const isConsultationBooked = session.status === "CONSULTATION_BOOKED";
    const showIdentity = isJoined || isConsultationBooked;

    const providerMessages = session.messages.filter(m =>
      (m.senderType === "system" || m.senderType === "provider")
      // Review prompts are parent-private: a provider must never see that
      // (or when) the parent was asked to rate them.
      && m.uiCardType !== "review_prompt"
      // The IP form nudge is likewise parent-private.
      && m.uiCardType !== "ip_form_prompt"
    );

    let accountMembers: { id: string; name: string | null; firstName: string | null; lastName: string | null }[] = [];
    if (showIdentity && session.user) {
      const ownerAccount = await prisma.user.findUnique({ where: { id: session.userId }, select: { parentAccountId: true } });
      if (ownerAccount?.parentAccountId) {
        accountMembers = await prisma.user.findMany({
          where: { parentAccountId: ownerAccount.parentAccountId, roles: { has: "PARENT" } },
          select: { id: true, name: true, firstName: true, lastName: true },
        });
      }
    }

    const formatInitials = (u: { name: string | null; firstName: string | null; lastName: string | null }) => {
      const parts = (u.firstName && u.lastName) ? [u.firstName, u.lastName] : (u.name || "").trim().split(/\s+/);
      return parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0] || "Parent";
    };

    const responseSession = {
      ...session,
      title: cleanSessionTitle(session.title),
      user: showIdentity ? session.user : {
        id: session.user.id,
        name: "Prospective Parent",
        email: null,
        photoUrl: null,
        city: null,
        state: null,
        parentAccount: null,
      },
      // Once the consultation is booked, the parent's identity is already
      // revealed - show all messages (parent + provider + system). Before that
      // (whisper Q&A phase), only show system + provider messages to keep the
      // parent anonymous.
      messages: showIdentity ? session.messages : providerMessages,
      accountMembers: showIdentity ? accountMembers.map(m => ({ id: m.id, displayName: formatInitials(m) })) : [],
    };

    // Auto-mark non-provider messages as delivered when provider views them
    prisma.aiChatMessage.updateMany({
      where: { sessionId: session.id, senderType: { not: "provider" }, deliveredAt: null },
      data: { deliveredAt: new Date() },
    }).catch(() => {});

    const provDetailAvail = await computeProfileAvailability([session as any]);
    const provDetailEntry = (session as any).subjectProfileId ? provDetailAvail.get((session as any).subjectProfileId) : null;
    (responseSession as any).profileAvailable = provDetailEntry ? provDetailEntry.available : null;
    (responseSession as any).profileStatus = provDetailEntry ? provDetailEntry.status : null;
    await applyMatchedLabelForInCycle([responseSession as any]);

    res.json(responseSession);
  } catch (e: any) {
    console.error("Provider concierge session detail error:", e);
    res.status(500).json({ message: e.message });
  }
});

// List the PENDING whisper questions for one session so the provider can answer
// each one individually from the right panel. The /concierge-sessions summary
// only returns aggregate counters - this endpoint returns the actual question
// text and per-question SLA metadata.
chatRouter.get("/api/provider/concierge-sessions/:id/pending-whispers", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const session = await prisma.aiChatSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, providerId: true, subjectType: true },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (session.providerId !== user.providerId) return res.status(403).json({ message: "Forbidden" });
    if (!canProviderAccessSession(user.roles || [], (session as any).subjectType)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const pending = await prisma.silentQuery.findMany({
      where: { sessionId: session.id, providerId: user.providerId, status: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        questionText: true,
        createdAt: true,
        reminderCount: true,
      },
    });

    const now = Date.now();
    const result = pending.map(p => ({
      id: p.id,
      questionText: p.questionText,
      createdAt: p.createdAt,
      ageMinutes: Math.max(0, Math.floor((now - p.createdAt.getTime()) / 60000)),
      nudgeCount: p.reminderCount,
    }));

    res.json(result);
  } catch (e: any) {
    console.error("Provider pending whispers error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Provider/admin parent detail page. Tenant-gated: requesting provider must
// share at least one PROVIDER_CONNECTED chat session or a Booking with this
// parent. Admins bypass. Returns the same SessionUser shape the chat sidebar
// renders so ParentProfileCard can be reused on the new /parents/:id page.
chatRouter.get("/api/provider/parents/:id", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user) && !isAdminOrConcierge(user)) {
    return res.status(403).json({ message: "Forbidden" });
  }
  try {
    const parentId = req.params.id as string;

    // Couples share one journey: the chat session may belong to the
    // partner's login, so both the access check and the booking check run
    // against every login on the same parent account.
    const targetUser = await prisma.user.findUnique({
      where: { id: parentId },
      select: { parentAccountId: true },
    });
    const accountUserIds = targetUser?.parentAccountId
      ? (await prisma.user.findMany({
          where: { parentAccountId: targetUser.parentAccountId },
          select: { id: true },
        })).map(u => u.id)
      : [parentId];

    if (!isAdminOrConcierge(user)) {
      const providerId = user.providerId;
      if (!providerId) return res.status(403).json({ message: "Forbidden" });

      const sharedSession = await prisma.aiChatSession.findFirst({
        where: {
          userId: { in: accountUserIds },
          providerId,
          status: { in: ["PROVIDER_CONNECTED", "CONSULTATION_BOOKED"] },
        },
        select: { id: true },
      });

      let hasRelationship = !!sharedSession;
      if (!hasRelationship) {
        const staff = await prisma.user.findMany({
          where: { providerId },
          select: { id: true },
        });
        const staffIds = staff.map(s => s.id);
        if (staffIds.length > 0) {
          const booking = await prisma.booking.findFirst({
            where: {
              parentUserId: { in: accountUserIds },
              providerUserId: { in: staffIds },
            },
            select: { id: true },
          });
          hasRelationship = !!booking;
        }
      }

      if (!hasRelationship) return res.status(403).json({ message: "Forbidden" });
    }

    const parent = await prisma.user.findUnique({
      where: { id: parentId },
      select: {
        id: true, name: true, email: true, photoUrl: true, city: true, state: true,
        mobileNumber: true, relationshipStatus: true, partnerFirstName: true,
        partnerAge: true, dateOfBirth: true,
        parentAccount: {
          select: {
            intendedParentProfile: {
              select: {
                journeyStage: true, interestedServices: true, isFirstIvf: true,
                eggSource: true, spermSource: true, carrier: true, hasEmbryos: true,
                embryoCount: true, embryosTested: true, needsClinic: true,
                currentClinicName: true, clinicPriority: true, needsEggDonor: true,
                needsSurrogate: true, surrogateCountries: true, surrogateTermination: true,
                surrogateTwins: true, surrogateAgeRange: true, surrogateBudget: true,
                surrogateExperience: true, surrogateMedPrefs: true, donorPreferences: true,
                donorEyeColor: true, donorHairColor: true, donorHeight: true,
                donorEducation: true, donorEthnicity: true, spermDonorType: true,
                currentAgencyName: true, currentAttorneyName: true,
              },
            },
          },
        },
      },
    });

    if (!parent) return res.status(404).json({ message: "Parent not found" });

    // All logins on the shared parent account (couple), requested parent
    // first, so the detail page can show both partners' contact info.
    const accountMembers = accountUserIds.length > 1
      ? (await prisma.user.findMany({
          where: { id: { in: accountUserIds }, roles: { has: "PARENT" } },
          select: { id: true, name: true, email: true, mobileNumber: true, photoUrl: true },
          orderBy: { createdAt: "asc" },
        })).sort((a, b) => (a.id === parentId ? -1 : b.id === parentId ? 1 : 0))
      : [];

    // Intended Parent Form status for the account - surrogacy agencies see
    // download buttons (submitted) or a "match call blocked" notice (not).
    const ipFormAccountId = targetUser?.parentAccountId || parentId;
    const ipFormRow = await prisma.ipFormResponse.findUnique({
      where: { parentAccountId: ipFormAccountId },
      select: { id: true, status: true, submittedAt: true, promptedAt: true },
    }).catch(() => null);
    const ipForm = ipFormRow
      ? { responseId: ipFormRow.id, status: ipFormRow.status, submittedAt: ipFormRow.submittedAt, promptedAt: ipFormRow.promptedAt }
      : { responseId: null, status: "NOT_STARTED", submittedAt: null, promptedAt: null };

    res.json({ ...parent, accountMembers, ipForm });
  } catch (e: any) {
    console.error("Provider parent detail error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/provider/concierge-sessions/:id/message", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  const { content, uiCardType, uiCardData, silentQueryId } = req.body;
  if (!content || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ message: "Content is required" });
  }
  try {
    const session = await prisma.aiChatSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (session.providerId !== user.providerId) return res.status(403).json({ message: "Forbidden" });

    // canSendProviderMessage combines the subjectType access check (so an
    // egg-donor coordinator can't post into a surrogate session) with the
    // "BILLING_MANAGER alone is blocked, but BILLING_MANAGER + coordinator
    // is fine" rule. Replaces the old blanket BILLING_MANAGER block which
    // also blocked users like Julia who are both billing managers and
    // IP_SURROGACY_COORDINATOR.
    if (!canSendProviderMessage(user.roles || [], (session as any).subjectType)) {
      return res.status(403).json({ message: "Your role cannot send messages in this conversation" });
    }

    const isConnected = session.status === "PROVIDER_CONNECTED";
    const isConsultationBooked = session.status === "CONSULTATION_BOOKED";

    const provider = await prisma.provider.findUnique({ where: { id: user.providerId }, select: { name: true } });
    const nameParts = (user.firstName && user.lastName)
      ? [user.firstName, user.lastName]
      : (user.name || "").trim().split(/\s+/);
    const senderDisplayName = nameParts.length >= 2
      ? `${nameParts[0]} ${nameParts[nameParts.length - 1][0]}.`
      : nameParts[0] || provider?.name || "Agency Expert";

    // Whisper answer flow: if the client passed an explicit silentQueryId, answer
    // that specific question (right-panel "answer this question" flow). Otherwise
    // fall back to the legacy oldest-first behavior so the main composer keeps
    // working. Whispers stay answerable in any session state - even after the
    // consultation is booked - so the provider can clear leftover questions.
    let pendingWhispers: { id: string; questionText: string; sessionId: string; providerId: string; status: string }[] = [];
    if (silentQueryId && typeof silentQueryId === "string") {
      const targeted = await prisma.silentQuery.findUnique({ where: { id: silentQueryId } });
      if (
        targeted &&
        targeted.sessionId === session.id &&
        targeted.providerId === user.providerId &&
        targeted.status === "PENDING"
      ) {
        pendingWhispers = [targeted as any];
      } else {
        return res.status(400).json({ message: "Pending whisper not found for this session" });
      }
    } else {
      pendingWhispers = await prisma.silentQuery.findMany({
        where: { sessionId: session.id, providerId: user.providerId, status: "PENDING" },
        orderBy: { createdAt: "asc" },
        take: 1,
      }) as any;
    }

    // Treat any pending whisper (targeted or oldest-first) as the answer target,
    // regardless of session status. Pre-booking this stays anonymous via Eva;
    // post-booking the relay still reads naturally because the parent has been
    // talking to Eva all along.
    if (pendingWhispers.length > 0) {
      const whisper = pendingWhispers[0];

      // Provider may attach a file with the whisper answer. The chat-upload
      // round-trip on the client side already produced { url, originalName,
      // mimeType, size }, which we receive as uiCardData when uiCardType is
      // "attachment". Persist on the SilentQuery for the audit trail and
      // forward it to the parent in the relay message.
      const attachment = (uiCardType === "attachment" && uiCardData && typeof uiCardData === "object")
        ? {
            url: typeof (uiCardData as any).url === "string" ? (uiCardData as any).url : null,
            originalName: typeof (uiCardData as any).originalName === "string" ? (uiCardData as any).originalName : null,
            mimeType: typeof (uiCardData as any).mimeType === "string" ? (uiCardData as any).mimeType : null,
            size: typeof (uiCardData as any).size === "number" ? (uiCardData as any).size : null,
          }
        : null;
      const hasAttachment = !!(attachment && attachment.url);

      // Silently record the answer - do NOT create a visible provider message in the parent's chat
      await prisma.silentQuery.update({
        where: { id: whisper.id },
        data: {
          status: "ANSWERED",
          answerText: content.trim(),
          attachmentUrl: hasAttachment ? attachment!.url : null,
          attachmentName: hasAttachment ? attachment!.originalName : null,
          attachmentMime: hasAttachment ? attachment!.mimeType : null,
        },
      });
      void emitJourneyEvent({ eventType: "WHISPER_ANSWERED", parentUserId: (whisper as any).parentUserId, providerId: (whisper as any).providerId, sessionId: (whisper as any).sessionId, actorRole: "provider" });

      // Show the provider their answer + a confirmation so they can see what
      // was sent. If they attached a file, render it as an attachment card so
      // they get the same visual confirmation the parent receives. This message
      // is for the PROVIDER ONLY - it must never render in the parent's chat.
      // The attachment card type is already excluded by the parent's filter;
      // the plain-text (no-attachment) variant must be explicitly tagged
      // "provider_only" or it leaks through as a generic system notice.
      const providerConfirmText = hasAttachment
        ? `You answered: "${content.trim()}"\n\nFile attached: ${attachment!.originalName || "attachment"}\n\nThis has been relayed to the parent by the AI concierge. Thank you!`
        : `You answered: "${content.trim()}"\n\nThis has been relayed to the parent by the AI concierge. Thank you!`;
      await prisma.aiChatMessage.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          content: providerConfirmText,
          senderType: "system",
          senderName: "System",
          ...(hasAttachment ? { uiCardType: "attachment", uiCardData: attachment as any } : { uiCardType: "provider_only" }),
        },
      });

      // Look up the matchmaker name for the AI concierge's relay message -
      // never fall back to a hardcoded persona name; if no matchmaker is
      // selected we'll surface a generic "AI Concierge" label.
      const matchmakerName = await resolveSessionSenderName(session as any);

      // Proactively relay the answer to the parent - inject an AI message directly so the parent
      // gets the answer immediately without needing to send another message
      const relayContent = hasAttachment
        ? `I heard back from the agency! They said: "${content.trim()}"\n\nThey also shared a file with you - ${attachment!.originalName || "attachment"}.\n\nDoes that help? Do you have any other questions, or would you like to schedule a free consultation call?`
        : `I heard back from the agency! The answer to your question is: "${content.trim()}"\n\nDoes that help? Do you have any other questions, or would you like to schedule a free consultation call?`;
      await prisma.aiChatMessage.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          content: relayContent,
          senderType: "assistant",
          senderName: matchmakerName,
          ...(hasAttachment ? { uiCardType: "attachment", uiCardData: attachment as any } : {}),
        },
      });

      // Mark the SilentQuery as RELAYED so the AI router doesn't relay it again on the next parent message
      await prisma.silentQuery.update({
        where: { id: whisper.id },
        data: { status: "RELAYED" },
      });

      // If the original parent question was about the cost sheet AND the
      // current active quote is still unacknowledged, re-render the
      // cost-sheet card after the relay. This puts the Acknowledge / "I have
      // questions" buttons back in front of the parent so the Q&A loop has a
      // clear next step. We key off the question text ("cost sheet" / "quote"
      // / "invoice" / "price") so unrelated whispers don't re-post the card.
      try {
        const q = (whisper.questionText || "").toLowerCase();
        const isCostSheetQuestion =
          q.includes("cost sheet") || q.includes("quote") ||
          q.includes("the price") || q.includes("the total") || q.includes("the invoice");
        if (isCostSheetQuestion) {
          const activeQuote = await prisma.providerQuote.findFirst({
            where: { sessionId: session.id, supersededAt: null, parentAcknowledgedAt: null },
            orderBy: { createdAt: "desc" },
            include: { provider: { select: { name: true } } },
          });
          if (activeQuote) {
            await prisma.aiChatMessage.create({
              data: {
                sessionId: session.id,
                role: "assistant",
                content: `Here's the cost sheet again so you can acknowledge it or ask another question. Total: $${(activeQuote.totalCostCents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`,
                senderType: "system",
                senderName: activeQuote.provider?.name || "Provider",
                uiCardType: "cost_sheet",
                uiCardData: {
                  quoteId: activeQuote.id,
                  providerName: activeQuote.provider?.name || null,
                  totalCostCents: activeQuote.totalCostCents,
                  costSheetFileUrl: activeQuote.costSheetFileUrl,
                  costSheetFileName: activeQuote.costSheetFileName,
                  notes: activeQuote.notes,
                  parentAcknowledgedAt: null,
                  sentAt: activeQuote.createdAt.toISOString(),
                  isRecap: true,
                },
              },
            });
          }
        }
      } catch (err: any) {
        // Re-posting the card is a nice-to-have; never fail the whisper
        // relay if it errors. Log and continue.
        console.warn(`[whisper-answer] cost-sheet recap failed for session ${session.id}: ${err.message}`);
      }

      // Notify the parent that they have a new message from Eva
      const sessionOwnerForNotify = await prisma.user.findUnique({ where: { id: session.userId }, select: { parentAccountId: true } });
      const notifyUserIds = sessionOwnerForNotify?.parentAccountId
        ? (await prisma.user.findMany({ where: { parentAccountId: sessionOwnerForNotify.parentAccountId }, select: { id: true } })).map(u => u.id)
        : [session.userId];
      for (const notifyId of notifyUserIds) {
        await prisma.inAppNotification.create({
          data: {
            userId: notifyId,
            eventType: "WHISPER_ANSWERED",
            payload: {
              sessionId: session.id,
              message: `${matchmakerName} has an update for you from the agency.`,
            },
          },
        });
      }

      return res.json({ success: true, whisperAnswered: true, silentQueryId: whisper.id });
    }

    const messageData: any = {
      sessionId: session.id,
      role: "assistant",
      content: content.trim(),
      senderType: "provider",
      senderName: senderDisplayName,
    };
    if (uiCardType) messageData.uiCardType = uiCardType;
    if (uiCardData) messageData.uiCardData = uiCardData;

    // Check if the parent (or any shared account member) is online - if so, mark as delivered
    const sessionOwnerForDelivery = await prisma.user.findUnique({ where: { id: session.userId }, select: { parentAccountId: true } });
    const parentUserIds = sessionOwnerForDelivery?.parentAccountId
      ? (await prisma.user.findMany({ where: { parentAccountId: sessionOwnerForDelivery.parentAccountId }, select: { id: true } })).map(u => u.id)
      : [session.userId];
    if (parentUserIds.some(id => isUserOnline(id))) {
      messageData.deliveredAt = new Date();
    }

    const message = await prisma.aiChatMessage.create({ data: messageData });

    // Cost-sheet recap (post-consultation direct chat path). When the
    // provider answers a parent question that was clearly about the cost
    // sheet, re-post the cost-sheet card so the parent sees Acknowledge /
    // "I have questions" buttons again. We key off the most recent parent
    // message in the session - if it mentions cost-sheet keywords AND there
    // is still an unacknowledged active ProviderQuote, post the recap.
    try {
      const lastParentMsg = await prisma.aiChatMessage.findFirst({
        where: { sessionId: session.id, senderType: "parent" },
        orderBy: { createdAt: "desc" },
        select: { content: true, createdAt: true },
      });
      const lastParentText = (lastParentMsg?.content || "").toLowerCase();
      const isCostSheetQuestion =
        lastParentText.includes("cost sheet") || lastParentText.includes("quote") ||
        lastParentText.includes("the price") || lastParentText.includes("the total") ||
        lastParentText.includes("the invoice");
      if (isCostSheetQuestion) {
        const activeQuote = await prisma.providerQuote.findFirst({
          where: { sessionId: session.id, supersededAt: null, parentAcknowledgedAt: null },
          orderBy: { createdAt: "desc" },
          include: { provider: { select: { name: true } } },
        });
        // Don't re-post if the latest quote-card message in this session is
        // already newer than the parent's most recent question - we'd be
        // duplicating an unread card.
        if (activeQuote && lastParentMsg) {
          const latestQuoteCard = await prisma.aiChatMessage.findFirst({
            where: { sessionId: session.id, uiCardType: "cost_sheet" },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
          });
          const needsRecap = !latestQuoteCard || latestQuoteCard.createdAt < lastParentMsg.createdAt;
          if (needsRecap) {
            await prisma.aiChatMessage.create({
              data: {
                sessionId: session.id,
                role: "assistant",
                content: `Here's the cost sheet again so you can acknowledge it or ask another question. Total: $${(activeQuote.totalCostCents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`,
                senderType: "system",
                senderName: activeQuote.provider?.name || "Provider",
                uiCardType: "cost_sheet",
                uiCardData: {
                  quoteId: activeQuote.id,
                  providerName: activeQuote.provider?.name || null,
                  totalCostCents: activeQuote.totalCostCents,
                  costSheetFileUrl: activeQuote.costSheetFileUrl,
                  costSheetFileName: activeQuote.costSheetFileName,
                  notes: activeQuote.notes,
                  parentAcknowledgedAt: null,
                  sentAt: activeQuote.createdAt.toISOString(),
                  isRecap: true,
                },
              },
            });
          }
        }
      }
    } catch (err: any) {
      console.warn(`[provider-direct-msg] cost-sheet recap failed for session ${session.id}: ${err.message}`);
    }

    // Auto-transition: first provider message after booking flips the session to PROVIDER_CONNECTED.
    // CONSULTATION_BOOKED means a call is on the calendar; PROVIDER_CONNECTED means active dialogue.
    if (isConsultationBooked && !session.providerJoinedAt) {
      await prisma.aiChatSession.update({
        where: { id: session.id },
        data: { providerJoinedAt: new Date(), status: "PROVIDER_CONNECTED", updatedAt: new Date() },
      });
      void emitJourneyEvent({ eventType: "PROVIDER_CONNECTED", parentUserId: session.userId, providerId: (session as any).providerId || null, sessionId: session.id, actorRole: "provider" });
      // Belt-and-suspenders with calendar.controller.ts: when this session flips
      // to PROVIDER_CONNECTED, sweep any leftover PENDING whispers on the same
      // parent+provider's OTHER (anonymous) sessions to AUTO_RESOLVED. The
      // sibling-filter in the provider sidebar hides those sessions, so the
      // whispers would otherwise stay pending forever and ghost the badge.
      try {
        const accountOwner = await prisma.user.findUnique({ where: { id: session.userId }, select: { parentAccountId: true } });
        const parentUserIds = accountOwner?.parentAccountId
          ? (await prisma.user.findMany({ where: { parentAccountId: accountOwner.parentAccountId }, select: { id: true } })).map(u => u.id)
          : [session.userId];
        const swept = await prisma.silentQuery.updateMany({
          where: {
            providerId: session.providerId!,
            status: "PENDING",
            sessionId: { not: session.id },
            session: { userId: { in: parentUserIds } },
          },
          data: { status: "AUTO_RESOLVED" },
        });
        if (swept.count > 0) {
          console.log(`[provider-connected] Auto-resolved ${swept.count} sibling whisper(s) for session ${session.id}`);
        }
      } catch (e: any) {
        console.warn(`[provider-connected] Sibling whisper auto-resolve failed: ${e.message}`);
      }
    } else {
      await prisma.aiChatSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
    }

    if (isConnected || isConsultationBooked) {
      const sessionOwner = await prisma.user.findUnique({ where: { id: session.userId }, select: { parentAccountId: true } });
      const notifyUserIds = sessionOwner?.parentAccountId
        ? (await prisma.user.findMany({ where: { parentAccountId: sessionOwner.parentAccountId }, select: { id: true } })).map(u => u.id)
        : [session.userId];
      for (const notifyId of notifyUserIds) {
        await prisma.inAppNotification.create({
          data: {
            userId: notifyId,
            eventType: "PROVIDER_MESSAGE",
            payload: {
              sessionId: session.id,
              message: `${provider?.name || "Your provider"} sent you a message`,
              preview: content.trim().slice(0, 100),
            },
          },
        });
      }
    }

    res.json(message);
  } catch (e: any) {
    console.error("Provider concierge message error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/provider/concierge-sessions/:id/consultation-status", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  const { status } = req.body;
  if (!status || !["READY_FOR_MATCH", "NOT_A_FIT"].includes(status)) {
    return res.status(400).json({ message: "Invalid status. Must be READY_FOR_MATCH or NOT_A_FIT" });
  }
  try {
    const session = await prisma.aiChatSession.findUnique({
      where: { id: req.params.id },
      include: { provider: { select: { name: true } } },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (session.providerId !== user.providerId) return res.status(403).json({ message: "Forbidden" });

    const parentUser = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { parentAccountId: true, name: true },
    });

    if (status === "READY_FOR_MATCH") {
      if (parentUser?.parentAccountId) {
        await prisma.intendedParentProfile.update({
          where: { parentAccountId: parentUser.parentAccountId },
          data: { journeyStage: "Match Eligibility" },
        }).catch(() => {});
      }

      // Dual-audience message: the parent reads `content` (second person),
      // the provider chat renders `uiCardData.providerContent`. A parent must
      // never read about themselves in third person in their own chat.
      const readyParentFirstName = (parentUser?.name || "").trim().split(/\s+/)[0] || "there";
      const readyProviderName = session.provider?.name || "The provider";
      await prisma.aiChatMessage.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          content: `I just heard from ${readyProviderName}, and they loved connecting with you! They're excited to move forward together. This is a big milestone, ${readyParentFirstName} - you're officially ready for matching, and I'll be right here to walk you through what comes next.`,
          senderType: "system",
          senderName: await resolveSessionSenderName(session as any),
          uiCardData: {
            providerContent: `Thank you for confirming the consultation went well! We've shared the good news with ${readyParentFirstName} and moved them to Match Eligibility. We'll guide them through the next steps from here.`,
          },
        },
      });

      const admins = await prisma.user.findMany({ where: { roles: { hasSome: ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE"] } }, select: { id: true } });
      for (const admin of admins) {
        await prisma.inAppNotification.create({
          data: {
            userId: admin.id,
            eventType: "CONSULTATION_COMPLETED",
            payload: {
              parentName: parentUser?.name,
              parentUserId: session.userId,
              providerName: session.provider?.name,
              status: "READY_FOR_MATCH",
              message: `${parentUser?.name || "Parent"} is ready for match after consultation with ${session.provider?.name}`,
            },
          },
        });
      }
      void emitJourneyEvent({ eventType: "MATCH_ACCEPTED_BY_SURROGATE", parentUserId: session.userId, providerId: (session as any).providerId || null, sessionId: session.id, actorRole: "provider", metadata: { reportedBy: "provider" } });
    } else {
      void emitJourneyEvent({ eventType: "MATCH_DECLINED_BY_SURROGATE", parentUserId: session.userId, providerId: (session as any).providerId || null, sessionId: session.id, actorRole: "provider", metadata: { reportedBy: "provider" } });
      if (parentUser?.parentAccountId) {
        await prisma.intendedParentProfile.update({
          where: { parentAccountId: parentUser.parentAccountId },
          data: { journeyStage: "Consultation - Not a Fit" },
        }).catch(() => {});
      }

      // Dual-audience message: parent reads `content`, provider reads
      // `uiCardData.providerContent` (see chat-message-list.tsx).
      const notFitParentFirstName = (parentUser?.name || "").trim().split(/\s+/)[0] || "there";
      await prisma.aiChatMessage.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          content: `Thank you for completing the consultation with ${session.provider?.name || "the provider"}. Based on the discussion, this may not be the ideal match. Don't worry - I can help you explore other providers that might be a better fit for your needs.`,
          senderType: "system",
          senderName: await resolveSessionSenderName(session.id),
          uiCardData: {
            providerContent: `Thanks for letting us know this wasn't the right fit. We've updated ${notFitParentFirstName}'s journey accordingly and will help them explore other options - nothing more is needed on your side.`,
          },
        },
      });
    }

    res.json({ success: true, status });
  } catch (e: any) {
    console.error("Consultation status update error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.get("/api/admin/calendar-slug", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isAdminOrConcierge(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const config = await prisma.scheduleConfig.findUnique({
      where: { userId: user.id },
      select: { bookingPageSlug: true },
    });
    res.json({ slug: config?.bookingPageSlug || null });
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

chatRouter.get("/api/provider/calendar-slug", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const config = await prisma.scheduleConfig.findUnique({
      where: { userId: user.id },
      select: { bookingPageSlug: true },
    });
    res.json({ slug: config?.bookingPageSlug || null });
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

// ─── Phase 4: scheduler-initiated Match Call / Doctor Call ───────────────────
//
// A SCHEDULER (or any provider member) opens a parent chat, picks WHICH
// coordinator/doctor hosts the call, picks a slot from that member's
// calendar, adds the surrogate's email, and books on their behalf. The
// booking carries meetingSubtype so the whole match-call flow (readiness
// gating, 24h hold, both-sides gate) fires exactly as if the host booked it.

// Provider team members who can host a scheduled call (have a booking page).
chatRouter.get("/api/chat-session/:id/schedulable-hosts", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    const session = await prisma.aiChatSession.findUnique({
      where: { id: req.params.id },
      select: { providerId: true },
    });
    if (!session?.providerId) return res.status(404).json({ message: "Session has no provider" });
    const isAdmin = isAdminOrConcierge(user);
    if (!isAdmin && user.providerId !== session.providerId) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const members = await prisma.user.findMany({
      where: { providerId: session.providerId, isDisabled: false },
      select: { id: true, name: true, email: true, roles: true, photoUrl: true },
    });
    const hosts: any[] = [];
    // Pure schedulers / billing managers coordinate but never HOST calls -
    // they must not appear in the host picker at all.
    const canHost = (roles: string[]) =>
      roles.some((r: string) => r.includes("COORDINATOR") || r === "DOCTOR" || r === "PROVIDER_ADMIN" || r === "LAWYER");
    for (const m of members) {
      if (!canHost(m.roles || [])) continue;
      const config = await prisma.scheduleConfig.findUnique({
        where: { userId: m.id },
        select: { bookingPageSlug: true, meetingDuration: true },
      });
      if (config?.bookingPageSlug) {
        hosts.push({
          userId: m.id,
          name: m.name || m.email,
          roles: m.roles || [],
          photoUrl: m.photoUrl || null,
          slug: config.bookingPageSlug,
          meetingDuration: config.meetingDuration || 30,
          isSelf: m.id === user.id,
        });
      }
    }
    // Coordinators/doctors first, admins after.
    const rank = (h: any) =>
      h.roles.some((r: string) => r.includes("COORDINATOR") || r === "DOCTOR") ? 0 : 1;
    hosts.sort((a, b) => rank(a) - rank(b));

    // Default host: the requester themselves when they can host (a
    // coordinator scheduling their own call); otherwise (SCHEDULER flow)
    // the coordinator who's been working with this parent - resolved from
    // their most recent booking together, falling back to the first host.
    let defaultHostUserId: string | null = null;
    const selfHost = hosts.find(h => h.isSelf);
    if (selfHost) {
      defaultHostUserId = selfHost.userId;
    } else {
      const fullSession = await prisma.aiChatSession.findUnique({
        where: { id: req.params.id },
        select: { userId: true },
      });
      if (fullSession) {
        const hostIds = hosts.map(h => h.userId);
        const lastBooking = await prisma.booking.findFirst({
          where: {
            parentUserId: fullSession.userId,
            providerUserId: { in: hostIds },
            status: { notIn: ["CANCELLED"] },
          },
          orderBy: { createdAt: "desc" },
          select: { providerUserId: true },
        });
        defaultHostUserId = lastBooking?.providerUserId || hosts[0]?.userId || null;
      }
    }
    res.json({ hosts, defaultHostUserId });
  } catch (e: any) {
    console.error("[schedulable-hosts]", e.message);
    res.status(500).json({ message: e.message });
  }
});

// Propose candidate time slots to the parent. The scheduler collects the
// surrogate's availability OFFLINE, picks matching open slots on the
// coordinator's calendar, and the parent gets a card with the options.
// NOTHING is booked until the parent accepts one - acceptance creates the
// booking and fires invites to everyone (parent account, surrogate email,
// hosting coordinator/doctor).
chatRouter.post("/api/chat-session/:id/propose-call-times", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    const { hostUserId, slots, meetingSubtype, extraAttendeeEmail, extraAttendeeName, notes } = req.body || {};
    if (!hostUserId || !Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({ message: "hostUserId and at least one slot are required" });
    }
    if (slots.length > 6) return res.status(400).json({ message: "Propose up to 6 time options" });
    const subtype = ["MATCH_CALL", "DOCTOR_CONSULTATION"].includes(meetingSubtype) ? meetingSubtype : null;

    const session = await prisma.aiChatSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, providerId: true, userId: true, subjectType: true, subjectProfileId: true },
    });
    if (!session?.providerId) return res.status(404).json({ message: "Session has no provider" });
    if (!isAdminOrConcierge(user) && user.providerId !== session.providerId) {
      return res.status(403).json({ message: "Forbidden" });
    }
    // Match-call gate: the Intended Parent Form must be SUBMITTED before a
    // match call can be proposed - the agency sends that form to the
    // surrogate so she can decide whether to meet the family.
    if (subtype === "MATCH_CALL") {
      const sessOwner = await prisma.user.findUnique({ where: { id: session.userId }, select: { parentAccountId: true } });
      const acctId = sessOwner?.parentAccountId || session.userId;
      const ipForm = await prisma.ipFormResponse.findUnique({
        where: { parentAccountId: acctId },
        select: { status: true },
      }).catch(() => null);
      if (ipForm?.status !== "SUBMITTED") {
        return res.status(409).json({
          code: "IP_FORM_REQUIRED",
          message: "The parents have not submitted their Intended Parent Form yet. A match call can be scheduled once the form is complete - the parents have been asked to fill it.",
        });
      }
    }
    // The call is WITH the surrogate/doctor's patient side - the coordinator
    // hosts it. Name the subject in all copy.
    let subjectLabel: string | null = null;
    if ((session.subjectType || "").toLowerCase().includes("surrog") && session.subjectProfileId) {
      const surr = await prisma.surrogate.findUnique({
        where: { id: session.subjectProfileId },
        select: { externalId: true, firstName: true },
      }).catch(() => null);
      subjectLabel = surr?.externalId ? `Surrogate #${surr.externalId}` : surr?.firstName || null;
    }
    const parentUserRow = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { firstName: true, name: true },
    }).catch(() => null);
    const parentLabel = parentUserRow?.firstName || parentUserRow?.name || "the parent";
    const host = await prisma.user.findUnique({
      where: { id: hostUserId },
      select: { id: true, name: true, email: true, providerId: true },
    });
    if (!host || host.providerId !== session.providerId) {
      return res.status(400).json({ message: "Host must be a member of this provider" });
    }
    const hostConfig = await prisma.scheduleConfig.findUnique({
      where: { userId: hostUserId },
      select: { meetingDuration: true },
    });
    const parsedSlots: string[] = [];
    for (const raw of slots) {
      const d = new Date(raw);
      if (isNaN(d.getTime()) || d.getTime() < Date.now()) {
        return res.status(400).json({ message: "All proposed times must be valid future times" });
      }
      parsedSlots.push(d.toISOString());
    }
    const extra = typeof extraAttendeeEmail === "string" ? extraAttendeeEmail.trim().toLowerCase() : "";
    if (extra && !/^\S+@\S+\.\S+$/.test(extra)) {
      return res.status(400).json({ message: "Additional attendee email is not valid" });
    }

    const callLabel = subtype === "MATCH_CALL" ? "Match Call" : subtype === "DOCTOR_CONSULTATION" ? "Doctor Call" : "Meeting";
    const hostName = host.name || host.email;
    const who = subjectLabel || hostName;
    const msg = await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: subjectLabel
          ? `We'd love to get your ${callLabel} with ${subjectLabel} on the calendar - ${hostName} will host and guide the conversation. Here are a few times that work on her side. Tap the one that works best for you, hit Confirm, and everyone gets the invite.`
          : `We'd love to get your ${callLabel} with ${hostName} on the calendar! Here are a few times that work on our side - tap the one that works best for you, hit Confirm, and everyone gets the invite.`,
        senderType: "system",
        senderName: "GoStork",
        uiCardType: "proposed_times",
        uiCardData: {
          providerContent: `Time options for the ${callLabel} with ${who}${subjectLabel ? ` (hosted by ${hostName})` : ""} are on their way to ${parentLabel}. The moment they confirm a slot, calendar invites go out to everyone automatically.`,
          subjectLabel,
          meetingSubtype: subtype,
          hostUserId,
          hostName,
          durationMin: hostConfig?.meetingDuration || 30,
          slots: parsedSlots,
          extraAttendeeEmail: extra || null,
          extraAttendeeName: typeof extraAttendeeName === "string" && extraAttendeeName.trim() ? extraAttendeeName.trim() : null,
          notes: typeof notes === "string" && notes.trim() ? notes.trim() : null,
          proposedByName: user.name || null,
          status: "pending",
          chosenSlot: null,
          bookingId: null,
        },
      },
    });
    res.json({ success: true, messageId: msg.id });
  } catch (e: any) {
    console.error("[propose-call-times]", e.message);
    res.status(500).json({ message: e.message });
  }
});

// Parent accepts one of the proposed slots -> the booking is created and
// calendar invites go out to everyone.
chatRouter.post("/api/chat-session/:id/proposed-times/:messageId/accept", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    const { slot } = req.body || {};
    const session = await prisma.aiChatSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, providerId: true, userId: true },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });
    let isParent = session.userId === user.id;
    if (!isParent && user.parentAccountId) {
      const owner = await prisma.user.findUnique({ where: { id: session.userId }, select: { parentAccountId: true } });
      isParent = !!(owner?.parentAccountId && owner.parentAccountId === user.parentAccountId);
    }
    if (!isParent) return res.status(403).json({ message: "Only the parent can pick a time" });

    const msg = await prisma.aiChatMessage.findUnique({ where: { id: req.params.messageId } });
    if (!msg || msg.sessionId !== session.id || msg.uiCardType !== "proposed_times") {
      return res.status(404).json({ message: "Time options not found" });
    }
    const data = (msg.uiCardData as any) || {};
    if (!slot || !Array.isArray(data.slots) || !data.slots.includes(slot)) {
      return res.status(400).json({ message: "Pick one of the offered times" });
    }
    // Already booked + a DIFFERENT offered slot -> the parent changed their
    // mind: reschedule the existing booking to the new time (old invites are
    // cancelled, fresh ones go out, meetingSubtype is preserved).
    if (data.status === "booked") {
      if (!data.bookingId || slot === data.chosenSlot) {
        return res.json({ success: true, alreadyBooked: true, bookingId: data.bookingId });
      }
      const newWhen = new Date(slot);
      if (newWhen.getTime() < Date.now()) {
        return res.status(400).json({ message: "That time has already passed - ask for fresh options" });
      }
      const { getNestApp } = await import("./nest-app-ref");
      const nestApp = getNestApp();
      if (!nestApp) return res.status(503).json({ message: "Scheduling service unavailable - try again shortly" });
      const { CalendarController } = await import("./src/modules/calendar/calendar.controller");
      const calendarController = nestApp.get(CalendarController);
      const newBooking = await calendarController.rescheduleBooking(req as any, data.bookingId, { scheduledAt: slot });
      await prisma.aiChatMessage.update({
        where: { id: msg.id },
        data: { uiCardData: { ...data, chosenSlot: slot, bookingId: newBooking.id } },
      });
      const changedLabel = newWhen.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      await prisma.aiChatMessage.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          content: `Done! Your ${data.meetingSubtype === "MATCH_CALL" ? "Match Call" : data.meetingSubtype === "DOCTOR_CONSULTATION" ? "Doctor Call" : "meeting"} with ${data.subjectLabel || data.hostName} has moved to ${changedLabel}. Updated invites are on their way to everyone.`,
          senderType: "system",
          senderName: "GoStork",
          uiCardData: {
            providerContent: `${(req.user as any)?.name || "The parent"} moved the ${data.meetingSubtype === "MATCH_CALL" ? "Match Call" : data.meetingSubtype === "DOCTOR_CONSULTATION" ? "Doctor Call" : "meeting"} with ${data.subjectLabel || data.hostName} to ${changedLabel}. Updated invites are on their way to everyone.`,
          },
        },
      }).catch(() => {});
      return res.json({ success: true, rescheduled: true, bookingId: newBooking.id });
    }
    const when = new Date(slot);
    if (when.getTime() < Date.now()) {
      return res.status(400).json({ message: "That time has already passed - ask for fresh options" });
    }

    const hostConfig = await prisma.scheduleConfig.findUnique({
      where: { userId: data.hostUserId },
      select: { meetingDuration: true, meetingLink: true },
    });
    const duration = data.durationMin || hostConfig?.meetingDuration || 30;
    // Conflict check - the slot may have been taken since it was proposed.
    const slotEnd = new Date(when.getTime() + duration * 60 * 1000);
    const nearby = await prisma.booking.findMany({
      where: {
        providerUserId: data.hostUserId,
        status: { notIn: ["CANCELLED", "RESCHEDULED", "EXPIRED"] },
        scheduledAt: { lt: slotEnd, gte: new Date(when.getTime() - 4 * 60 * 60 * 1000) },
      },
    });
    const taken = nearby.find(b => {
      const bEnd = new Date(b.scheduledAt.getTime() + b.duration * 60 * 1000);
      return b.scheduledAt < slotEnd && bEnd > when;
    });
    if (taken) {
      return res.status(409).json({ message: "That time was just taken on the host's calendar - please pick another option" });
    }

    const parentUser = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { name: true, email: true, parentAccountId: true },
    });
    let attendeeEmails: string[] = [];
    if (parentUser?.parentAccountId) {
      const members = await prisma.user.findMany({
        where: { parentAccountId: parentUser.parentAccountId, isDisabled: false },
        select: { email: true },
      });
      attendeeEmails = members.map(m => m.email).filter(Boolean);
    } else if (parentUser?.email) {
      attendeeEmails = [parentUser.email];
    }
    if (data.extraAttendeeEmail && !attendeeEmails.includes(data.extraAttendeeEmail)) {
      attendeeEmails.push(data.extraAttendeeEmail);
    }
    const extraDetails = data.extraAttendeeEmail && data.extraAttendeeName
      ? { [data.extraAttendeeEmail]: { name: data.extraAttendeeName } }
      : undefined;

    const callLabel = data.meetingSubtype === "MATCH_CALL" ? "Match Call" : data.meetingSubtype === "DOCTOR_CONSULTATION" ? "Doctor Call" : "Meeting";
    const { getNestApp } = await import("./nest-app-ref");
    const nestApp = getNestApp();
    if (!nestApp) return res.status(503).json({ message: "Scheduling service unavailable - try again shortly" });
    const { CalendarController } = await import("./src/modules/calendar/calendar.controller");
    const calendarController = nestApp.get(CalendarController);
    const booking = await calendarController.createBookingInternal({
      providerUserId: data.hostUserId,
      parentUserId: session.userId,
      scheduledAt: when,
      duration,
      meetingType: "video",
      meetingUrl: hostConfig?.meetingLink || null,
      subject: data.subjectLabel
        ? `${callLabel} with ${data.subjectLabel} (hosted by ${data.hostName || "your coordinator"})`
        : `${callLabel} with ${data.hostName || "your coordinator"}`,
      attendeeName: parentUser?.name || null,
      attendeeEmails,
      invitedByUserId: user.id,
      meetingSubtype: data.meetingSubtype || null,
      attendeeDetails: extraDetails,
    });
    if (data.notes) {
      await prisma.booking.update({ where: { id: booking.id }, data: { notes: data.notes } }).catch(() => {});
    }
    await prisma.aiChatMessage.update({
      where: { id: msg.id },
      data: { uiCardData: { ...data, status: "booked", chosenSlot: slot, bookingId: booking.id } },
    });
    const whenLabel = when.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: `You're all set! Your ${callLabel} with ${data.subjectLabel || data.hostName}${data.subjectLabel ? `, hosted by ${data.hostName},` : ""} is booked for ${whenLabel}. Calendar invites are on their way to everyone.`,
        senderType: "system",
        senderName: "GoStork",
        uiCardData: {
          providerContent: `${parentUser?.name || "The parent"} picked ${whenLabel} for the ${callLabel} with ${data.subjectLabel || data.hostName}${data.subjectLabel ? ` (hosted by ${data.hostName})` : ""}. Calendar invites are on their way to everyone.`,
        },
      },
    }).catch(() => {});
    res.json({ success: true, bookingId: booking.id });
  } catch (e: any) {
    console.error("[proposed-times-accept]", e.message);
    res.status(500).json({ message: e.message });
  }
});

// Book the call on the selected host's behalf.
chatRouter.post("/api/chat-session/:id/schedule-call", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    const { hostUserId, scheduledAt, meetingSubtype, extraAttendeeEmail, extraAttendeeName, notes } = req.body || {};
    if (!hostUserId || !scheduledAt) {
      return res.status(400).json({ message: "hostUserId and scheduledAt are required" });
    }
    const subtype = ["MATCH_CALL", "DOCTOR_CONSULTATION"].includes(meetingSubtype) ? meetingSubtype : null;

    const session = await prisma.aiChatSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, providerId: true, userId: true, title: true },
    });
    if (!session?.providerId) return res.status(404).json({ message: "Session has no provider" });
    const isAdmin = isAdminOrConcierge(user);
    if (!isAdmin && user.providerId !== session.providerId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const host = await prisma.user.findUnique({
      where: { id: hostUserId },
      select: { id: true, name: true, email: true, providerId: true },
    });
    if (!host || host.providerId !== session.providerId) {
      return res.status(400).json({ message: "Host must be a member of this provider" });
    }
    const hostConfig = await prisma.scheduleConfig.findUnique({
      where: { userId: hostUserId },
      select: { meetingDuration: true, meetingLink: true },
    });
    const duration = hostConfig?.meetingDuration || 30;

    const when = new Date(scheduledAt);
    if (isNaN(when.getTime()) || when.getTime() < Date.now() - 60_000) {
      return res.status(400).json({ message: "scheduledAt must be a valid future time" });
    }

    // Light conflict check on the host's calendar.
    const slotEnd = new Date(when.getTime() + duration * 60 * 1000);
    const conflict = await prisma.booking.findFirst({
      where: {
        providerUserId: hostUserId,
        status: { notIn: ["CANCELLED", "RESCHEDULED", "EXPIRED"] },
        scheduledAt: { lt: slotEnd, gte: new Date(when.getTime() - 4 * 60 * 60 * 1000) },
      },
    });
    if (conflict) {
      const cEnd = new Date(conflict.scheduledAt.getTime() + conflict.duration * 60 * 1000);
      if (conflict.scheduledAt < slotEnd && cEnd > when) {
        return res.status(409).json({ message: "That time conflicts with another booking on the host's calendar" });
      }
    }

    // Parent + account members + the surrogate/extra attendee.
    const parentUser = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { name: true, email: true, parentAccountId: true },
    });
    let attendeeEmails: string[] = [];
    if (parentUser?.parentAccountId) {
      const members = await prisma.user.findMany({
        where: { parentAccountId: parentUser.parentAccountId, isDisabled: false },
        select: { email: true },
      });
      attendeeEmails = members.map(m => m.email).filter(Boolean);
    } else if (parentUser?.email) {
      attendeeEmails = [parentUser.email];
    }
    const extra = typeof extraAttendeeEmail === "string" ? extraAttendeeEmail.trim().toLowerCase() : "";
    if (extra) {
      if (!/^\S+@\S+\.\S+$/.test(extra)) {
        return res.status(400).json({ message: "Additional attendee email is not valid" });
      }
      if (!attendeeEmails.includes(extra)) attendeeEmails.push(extra);
    }

    const callLabel = subtype === "MATCH_CALL" ? "Match Call" : subtype === "DOCTOR_CONSULTATION" ? "Doctor Call" : "Meeting";
    const hostName = host.name || host.email;

    const { getNestApp } = await import("./nest-app-ref");
    const nestApp = getNestApp();
    if (!nestApp) return res.status(503).json({ message: "Scheduling service unavailable - try again shortly" });
    const { CalendarController } = await import("./src/modules/calendar/calendar.controller");
    const calendarController = nestApp.get(CalendarController);

    const booking = await calendarController.createBookingInternal({
      providerUserId: hostUserId,
      parentUserId: session.userId,
      scheduledAt: when,
      duration,
      meetingType: "video",
      meetingUrl: hostConfig?.meetingLink || null,
      subject: `${callLabel} with ${hostName}`,
      attendeeName: parentUser?.name || null,
      attendeeEmails,
      invitedByUserId: user.id,
      meetingSubtype: subtype,
      attendeeDetails: extra && typeof extraAttendeeName === "string" && extraAttendeeName.trim()
        ? { [extra]: { name: extraAttendeeName.trim() } }
        : undefined,
    });
    if (notes && typeof notes === "string" && notes.trim()) {
      await prisma.booking.update({ where: { id: booking.id }, data: { notes: notes.trim() } }).catch(() => {});
    }

    // Announce in the chat so both sides see it immediately.
    const whenLabel = when.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: `Great news - your ${callLabel}, hosted by ${hostName}, is scheduled for ${whenLabel}. Calendar invites are on their way to everyone.`,
        senderType: "system",
        senderName: "GoStork",
        uiCardData: {
          providerContent: `${user.name || "The team"} scheduled a ${callLabel} with ${hostName} for ${whenLabel}. Calendar invites are on their way to everyone.`,
        },
      },
    }).catch(() => {});

    res.json({ success: true, bookingId: booking.id });
  } catch (e: any) {
    console.error("[schedule-call]", e.message);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.get("/api/chat-session/:id/provider-calendar-slug", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    const session = await prisma.aiChatSession.findUnique({
      where: { id: req.params.id },
      select: { providerId: true, userId: true },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (session.userId !== user.id) {
      let allowed = false;
      if (user.parentAccountId) {
        const sameAccount = await prisma.user.findFirst({
          where: { id: session.userId, parentAccountId: user.parentAccountId },
        });
        if (sameAccount) allowed = true;
      }
      const roles = user.roles || [];
      if (isAdminOrConcierge(user)) allowed = true;
      if (roles.includes("PROVIDER_ADMIN") && session.providerId && user.providerId === session.providerId) allowed = true;
      if (!allowed) return res.status(403).json({ message: "Forbidden" });
    }
    if (!session.providerId) return res.json({ slug: null, memberName: null });

    const providerUsers = await prisma.user.findMany({
      where: { providerId: session.providerId },
      select: { id: true, name: true },
    });

    for (const pu of providerUsers) {
      const config = await prisma.scheduleConfig.findUnique({
        where: { userId: pu.id },
        select: { bookingPageSlug: true },
      });
      if (config?.bookingPageSlug) {
        return res.json({ slug: config.bookingPageSlug, memberName: pu.name });
      }
    }

    const provider = await prisma.provider.findUnique({
      where: { id: session.providerId },
      select: { name: true },
    });
    res.json({ slug: null, providerName: provider?.name || null });
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/chat-session/:id/message", requireAuth, async (req, res) => {
  const user = req.user as any;
  const { content, uiCardType, uiCardData } = req.body;
  if (!content || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ message: "Content is required" });
  }
  try {
    const session = await prisma.aiChatSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (session.userId !== user.id) {
      let allowed = false;
      if (user.parentAccountId) {
        const sameAccount = await prisma.user.findFirst({
          where: { id: session.userId, parentAccountId: user.parentAccountId },
        });
        if (sameAccount) allowed = true;
      }
      if (!allowed) return res.status(403).json({ message: "Forbidden" });
    }

    const nameParts = (user.firstName && user.lastName)
      ? [user.firstName, user.lastName]
      : (user.name || "").trim().split(/\s+/);
    const senderDisplayName = nameParts.length >= 2
      ? `${nameParts[0]} ${nameParts[nameParts.length - 1][0]}.`
      : nameParts[0] || "Parent";

    const messageData: any = {
      sessionId: session.id,
      role: "user",
      content: content.trim(),
      senderType: "parent",
      senderName: senderDisplayName,
    };
    if (uiCardType) messageData.uiCardType = uiCardType;
    if (uiCardData) messageData.uiCardData = uiCardData;

    // Check if any provider user is online - if so, mark as delivered immediately
    if (session.providerId) {
      const providerUsers = await prisma.user.findMany({
        where: { providerId: session.providerId },
        select: { id: true },
      });
      const anyOnline = providerUsers.some(u => isUserOnline(u.id));
      if (anyOnline) {
        messageData.deliveredAt = new Date();
      }
    }

    const message = await prisma.aiChatMessage.create({ data: messageData });
    await prisma.aiChatSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
    res.json(message);
  } catch (e: any) {
    console.error("Parent chat message error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/chat-upload", requireAuth, (req, res, next) => {
  chatUpload.single("file")(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(413).json({ message: err.code === "LIMIT_FILE_SIZE" ? "File too large (max 16MB)" : err.message });
    }
    if (err) {
      return res.status(400).json({ message: err.message || "Upload error" });
    }
    const file = (req as any).file;
    if (!file) return res.status(400).json({ message: "No file uploaded" });

    try {
      const path = await import("path");
      const crypto = await import("crypto");
      const fs = await import("fs");
      const SAFE_EXT_MAP: Record<string, string> = { "application/pdf": ".pdf", "application/msword": ".doc", "text/plain": ".txt" };
      const UPLOADS_DIR = path.resolve(process.cwd(), "public/uploads");

      const rawExt = path.extname(file.originalname).toLowerCase();
      const ext = SAFE_EXT_MAP[file.mimetype] || (file.mimetype.startsWith("image/") ? rawExt || ".bin" : rawExt || ".bin");
      const hash = crypto.createHash("md5").update(file.buffer).digest("hex");
      const storedName = `${hash}${ext}`;

      let url: string;
      if (storageService.isConfigured()) {
        url = await storageService.uploadBufferPublic(file.buffer, `uploads/${storedName}`, file.mimetype);
      } else {
        if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        fs.writeFileSync(path.join(UPLOADS_DIR, storedName), file.buffer);
        url = `/uploads/${storedName}`;
      }

      return res.json({
        url,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });
});

// Public endpoint to fetch a single donor/surrogate profile by type and ID (used by match cards in AI concierge)
chatRouter.get("/api/marketplace/profile/:type/:id", requireAuth, async (req, res) => {
  const { type, id } = req.params;
  const t = (type || "").toLowerCase();
  try {
    if (t === "egg-donor" || t === "egg donor") {
      let donor = await prisma.eggDonor.findUnique({
        where: { id },
        include: { provider: { select: { id: true, name: true, logoUrl: true } } },
      });
      if (!donor) {
        donor = await prisma.eggDonor.findFirst({
          where: { externalId: id },
          include: { provider: { select: { id: true, name: true, logoUrl: true } } },
        });
      }
      if (!donor) return res.status(404).json({ message: "Not found" });
      return res.json(donor);
    }
    if (t === "sperm-donor" || t === "sperm donor") {
      let donor = await prisma.spermDonor.findUnique({
        where: { id },
        include: { provider: { select: { id: true, name: true, logoUrl: true } } },
      });
      if (!donor) {
        donor = await prisma.spermDonor.findFirst({
          where: { externalId: id },
          include: { provider: { select: { id: true, name: true, logoUrl: true } } },
        });
      }
      if (!donor) return res.status(404).json({ message: "Not found" });
      return res.json(donor);
    }
    if (t === "surrogate") {
      let surrogate = await prisma.surrogate.findUnique({
        where: { id },
        include: { provider: { select: { id: true, name: true, logoUrl: true } } },
      });
      if (!surrogate) {
        surrogate = await prisma.surrogate.findFirst({
          where: { externalId: id },
          include: { provider: { select: { id: true, name: true, logoUrl: true } } },
        });
      }
      if (!surrogate) return res.status(404).json({ message: "Not found" });
      return res.json(surrogate);
    }
    return res.status(400).json({ message: "Unsupported type" });
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/agreements/generate", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });

  const { sessionId } = req.body;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ message: "sessionId is required" });
  }

  try {
    const session = await prisma.aiChatSession.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true, providerId: true },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (session.providerId !== user.providerId) return res.status(403).json({ message: "Not authorized for this session" });

    const agreement = await generateAgreement({
      providerId: user.providerId,
      parentUserId: session.userId,
      sessionId: session.id,
    });

    await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: "The provider has generated the official agreement. Please review and sign it using the button below. You'll also receive it via email.",
        senderType: "system",
        senderName: await resolveSessionSenderName(session.id),
        uiCardType: "agreement",
        uiCardData: {
          agreementCard: {
            agreementId: agreement.id,
            status: agreement.status,
            viewUrl: (agreement as any).pandaDocViewUrl || null,
          },
        },
      },
    });

    // Send email + SMS to parent via NotificationService
    try {
      const { getNestApp } = await import("./nest-app-ref");
      const nestApp = getNestApp();
      if (nestApp) {
        const { NotificationService } = await import("./src/modules/notifications/notification.service");
        const notifService = nestApp.get(NotificationService);
        const parentUser = await prisma.user.findUnique({
          where: { id: session.userId },
          select: { name: true, email: true, mobileNumber: true },
        });
        const providerRecord = await prisma.provider.findUnique({
          where: { id: user.providerId },
          select: { name: true },
        });
        if (parentUser?.email) {
          console.log(`[Agreement notify] OLD generate endpoint -> sending to ${parentUser.email}`);
          await notifService.sendAgreementReadyNotification({
            parentUserId: session.userId,
            parentName: parentUser.name || parentUser.email,
            parentEmail: parentUser.email,
            parentPhone: parentUser.mobileNumber || null,
            providerName: providerRecord?.name || "Your Agency",
            providerId: user.providerId,
            signingUrl: `${getAppBaseUrl()}/agreements/${agreement.id}`,
            sessionId: session.id,
          });
        }
      }
    } catch (notifErr: any) {
      console.error("[Agreement] Notification send failed:", notifErr?.message);
    }

    res.json({ success: true, agreementId: agreement.id, status: agreement.status });
  } catch (e: any) {
    console.error("Agreement generation error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.get("/api/chat-session/:id/bookings", requireAuth, async (req: Request, res: Response) => {
  const user = req.user as any;
  if (!user) return res.status(401).json({ message: "Not authenticated" });

  try {
    const session = await prisma.aiChatSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true, providerId: true, humanAgentId: true },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });

    const isSessionProvider = isProviderUser(user) && session.providerId === user.providerId;
    const sessionOwnerAccount = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { parentAccountId: true },
    });
    const parentAccountUserIds = sessionOwnerAccount?.parentAccountId
      ? (await prisma.user.findMany({
          where: { parentAccountId: sessionOwnerAccount.parentAccountId },
          select: { id: true },
        })).map(u => u.id)
      : [session.userId];
    const isSessionParent = parentAccountUserIds.includes(user.id);
    if (!isSessionProvider && !isSessionParent && !isAdminOrConcierge(user)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    let providerUserIds: string[] = [];
    if (session.providerId) {
      const providerUsers = await prisma.user.findMany({
        where: { providerId: session.providerId, roles: { hasSome: PROVIDER_ROLES } },
        select: { id: true },
      });
      providerUserIds = providerUsers.map(u => u.id);
      // The GoStork HOUSE provider's real "members" are the GoStork staff -
      // their User rows have no providerId, so concierge-call bookings they
      // host would otherwise never surface in the dedicated GoStork chat
      // (no widget for the parent, no confirm/decline card for the admin).
      const houseCheck = await prisma.provider.findUnique({
        where: { id: session.providerId },
        select: { name: true },
      });
      if ((houseCheck?.name || "").trim().toLowerCase() === "gostork") {
        const staff = await prisma.user.findMany({
          where: { OR: [{ roles: { has: "GOSTORK_ADMIN" } }, { roles: { has: "GOSTORK_CONCIERGE" } }] },
          select: { id: true },
        });
        providerUserIds = Array.from(new Set(providerUserIds.concat(staff.map(u => u.id))));
      }
    } else {
      const consultMsgs = await prisma.aiChatMessage.findMany({
        where: { sessionId: session.id, uiCardType: "rich" },
        select: { uiCardData: true },
      });
      const providerIds = new Set<string>();
      const directProviderUserIds = new Set<string>();
      for (const m of consultMsgs) {
        const card = (m.uiCardData as any)?.consultationCard;
        if (card?.providerId) providerIds.add(card.providerId);
        // Admin calendar messages embed their own userId directly (no providerId)
        if (card?.providerUserId) directProviderUserIds.add(card.providerUserId);
      }
      if (providerIds.size > 0) {
        const providerUsers = await prisma.user.findMany({
          where: { providerId: { in: Array.from(providerIds) }, roles: { hasSome: PROVIDER_ROLES } },
          select: { id: true },
        });
        providerUserIds = providerUsers.map(u => u.id);
      }
      for (const uid of directProviderUserIds) {
        if (!providerUserIds.includes(uid)) providerUserIds.push(uid);
      }
    }
    // Always scan rich messages for admin-sent calendar cards (providerUserId with no providerId).
    // This is needed even when session.providerId is set - an admin can send their own calendar
    // into a provider session and those bookings must be included.
    {
      const adminCalendarMsgs = await prisma.aiChatMessage.findMany({
        where: { sessionId: session.id, uiCardType: "rich" },
        select: { uiCardData: true },
      });
      for (const m of adminCalendarMsgs) {
        const card = (m.uiCardData as any)?.consultationCard;
        if (card?.providerUserId && !providerUserIds.includes(card.providerUserId)) {
          providerUserIds.push(card.providerUserId);
        }
      }
    }
    // Also include the human agent (admin) who joined the session - they may have shared their own calendar
    if (session.humanAgentId && !providerUserIds.includes(session.humanAgentId)) {
      providerUserIds.push(session.humanAgentId);
    }

    if (providerUserIds.length === 0) return res.json([]);

    const bookings = await prisma.booking.findMany({
      where: {
        parentUserId: { in: parentAccountUserIds },
        providerUserId: { in: providerUserIds },
        status: { in: ["PENDING", "CONFIRMED", "CANCELLED", "RESCHEDULED"] },
      },
      include: {
        providerUser: {
          select: {
            id: true, name: true, email: true, photoUrl: true, providerId: true, roles: true, dailyRoomUrl: true,
            provider: { select: { id: true, name: true } },
            scheduleConfig: { select: { bookingPageSlug: true } },
          },
        },
        parentUser: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    for (const b of bookings) {
      const parentAccount = await prisma.user.findUnique({
        where: { id: session.userId },
        select: { parentAccountId: true },
      });
      if (parentAccount?.parentAccountId) {
        const members = await prisma.user.findMany({
          where: { parentAccountId: parentAccount.parentAccountId, roles: { has: "PARENT" } },
          select: { id: true, name: true, email: true },
        });
        (b as any).parentAccountMembers = members;
      }
    }

    res.json(bookings);
  } catch (e: any) {
    console.error("Chat session bookings error:", e);
    res.status(500).json({ message: e.message });
  }
});

// ── Concierge Prompt Sections (admin only) ──

chatRouter.get("/api/admin/concierge-prompts", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isAdminUser(user) && !getUserRoles(user).includes("GOSTORK_DEVELOPER")) return res.status(403).json({ message: "Forbidden" });
  try {
    const sections = await prisma.conciergePromptSection.findMany({ orderBy: { sortOrder: "asc" } });
    res.json(sections);
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/admin/concierge-prompts/seed", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isAdminUser(user) && !getUserRoles(user).includes("GOSTORK_DEVELOPER")) return res.status(403).json({ message: "Forbidden" });
  try {
    const existing = await prisma.conciergePromptSection.count();
    if (existing > 0) return res.json({ message: "Already seeded", count: existing });

    const { getDefaultPromptSections } = await import("./ai-prompt-defaults");
    const sections = getDefaultPromptSections();
    for (const s of sections) {
      await prisma.conciergePromptSection.create({ data: s });
    }
    res.json({ message: "Seeded", count: sections.length });
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

// Admin: Delete ALL chats. Developer: Delete only test-flagged sessions and their related records.
chatRouter.delete("/api/admin/reset-all-chats", requireAuth, async (req, res) => {
  const caller = req.user as any;
  const callerRoles = getUserRoles(caller);
  const isAdmin = isAdminUser(caller);
  const isDeveloper = callerRoles.includes("GOSTORK_DEVELOPER");
  if (!isAdmin && !isDeveloper) return res.status(403).json({ message: "Forbidden" });
  try {
    if (isDeveloper && !isAdmin) {
      // Developer: only wipe sessions flagged as test data and their dependents
      const testSessions = await prisma.aiChatSession.findMany({ where: { isTestData: true }, select: { id: true } });
      const testSessionIds = testSessions.map((s: any) => s.id);
      if (testSessionIds.length === 0) return res.json({ message: "No test sessions to reset", deleted: {} });
      const [messages, sessions] = await prisma.$transaction([
        prisma.aiChatMessage.deleteMany({ where: { sessionId: { in: testSessionIds } } }),
        prisma.aiChatSession.deleteMany({ where: { id: { in: testSessionIds } } }),
      ]);
      return res.json({ message: "Test sessions reset", deleted: { messages: messages.count, sessions: sessions.count } });
    }

    // Admin: full reset (existing behavior)
    const [invoiceReminders, invoices, agreements, silentQueries, messages, sessions, bookings, notifications, profiles, parentUsers] = await prisma.$transaction([
      prisma.invoiceReminder.deleteMany({}),
      prisma.invoice.deleteMany({}),
      prisma.agreement.deleteMany({}),
      prisma.silentQuery.deleteMany({}),
      prisma.aiChatMessage.deleteMany({}),
      prisma.aiChatSession.deleteMany({}),
      prisma.booking.deleteMany({}),
      prisma.notification.deleteMany({}),
      prisma.intendedParentProfile.updateMany({
        data: {
          journeyStage: null,
          hasEmbryos: null,
          embryoCount: null,
          embryosTested: null,
          eggSource: null,
          spermSource: null,
          carrier: null,
          clinicReason: null,
          clinicPriority: null,
          donorEyeColor: null,
          donorHairColor: null,
          donorHeight: null,
          donorEducation: null,
          donorEthnicity: null,
          surrogateBudget: null,
          surrogateMedPrefs: null,
          needsSurrogate: null,
          needsEggDonor: null,
          needsClinic: null,
          surrogateTwins: null,
          surrogateCountries: null,
          surrogateTermination: null,
          surrogateAgeRange: null,
          surrogateExperience: null,
          surrogateRace: null,
          surrogateEthnicity: null,
          surrogateRelationship: null,
          surrogateBmiRange: null,
          surrogateTotalCostRange: null,
          surrogateLiveBirthsRange: null,
          surrogateMaxCSections: null,
          surrogateMaxMiscarriages: null,
          surrogateMaxAbortions: null,
          surrogateLastDeliveryYear: null,
          surrogateCovidVaccinated: null,
          surrogateSelectiveReduction: null,
          surrogateInternationalParents: null,
          donorPreferences: null,
          spermDonorType: null,
          spermDonorPreferences: null,
          spermDonorAgeRange: null,
          spermDonorEyeColor: null,
          spermDonorHairColor: null,
          spermDonorHeightRange: null,
          spermDonorRace: null,
          spermDonorEthnicity: null,
          spermDonorEducation: null,
          spermDonorMaxPrice: null,
          spermDonorVialType: null,
          spermDonorCovidVaccinated: null,
          eggDonorAgeRange: null,
          eggDonorCompensationRange: null,
          eggDonorTotalCostRange: null,
          eggDonorLotCostRange: null,
          eggDonorEggType: null,
          eggDonorDonationType: null,
          clinicAgeGroup: null,
          clinicPriorityTags: null,
          sameSexCouple: null,
          isLGBTQ: null,
          isFirstIvf: null,
          hotLeadProviderId: null,
          hotLeadAt: null,
          currentClinicName: null,
          currentAgencyName: null,
          currentAttorneyName: null,
        },
      }),
      // Reset AI-collected fields on User - everything except name, email, password,
      // phone, location, and services (the only true registration fields)
      prisma.user.updateMany({
        where: { roles: { has: "PARENT" } },
        data: {
          gender: null,
          sexualOrientation: null,
          relationshipStatus: null,
          dateOfBirth: null,
          partnerFirstName: null,
          partnerAge: null,
        },
      }),
    ]);
    res.json({
      message: "All chats, meetings, and parent profiles reset successfully",
      deleted: {
        agreements: agreements.count,
        silentQueries: silentQueries.count,
        messages: messages.count,
        sessions: sessions.count,
        bookings: bookings.count,
        notifications: notifications.count,
        parentProfiles: profiles.count,
      },
    });
  } catch (e: any) {
    console.error("[ADMIN RESET] Error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.patch("/api/admin/chat-sessions/:id/test-flag", requireAuth, async (req, res) => {
  const user = req.user as any;
  const roles = getUserRoles(user);
  if (!roles.includes("GOSTORK_ADMIN") && !roles.includes("GOSTORK_DEVELOPER")) {
    return res.status(403).json({ message: "Forbidden" });
  }
  const { isTestData } = req.body;
  if (typeof isTestData !== "boolean") return res.status(400).json({ message: "isTestData must be a boolean" });
  try {
    const session = await prisma.aiChatSession.update({
      where: { id: req.params.id },
      data: { isTestData },
      select: { id: true, isTestData: true },
    });
    res.json(session);
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

chatRouter.put("/api/admin/concierge-prompts/:id", requireAuth, async (req, res) => {
  if (!isAdminUser(req.user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const { content, isActive } = req.body;
    const updated = await prisma.conciergePromptSection.update({
      where: { id: req.params.id },
      data: {
        ...(content !== undefined ? { content } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
    });
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

// --- Agreement routes ---

chatRouter.post("/api/agreements/generate", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  const { sessionId } = req.body;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ message: "sessionId is required" });
  }
  try {
    const session = await prisma.aiChatSession.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true, providerId: true },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (session.providerId !== user.providerId) return res.status(403).json({ message: "Not authorized for this session" });

    const agreement = await generateAgreement({
      providerId: user.providerId,
      parentUserId: session.userId,
      sessionId: session.id,
    });

    await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: "The provider has generated the official agreement. It is being prepared for your signature. You'll receive it shortly via email.",
        senderType: "system",
        senderName: await resolveSessionSenderName(session.id),
      },
    });

    res.json({ success: true, agreementId: agreement?.id, status: agreement?.status });
  } catch (e: any) {
    console.error("Agreement generation error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Phase 5: stream the provider's agreement template as a read-only preview
// (Eva shares this when a parent asks to see the contract before paying).
chatRouter.get("/api/agreements/template-preview/:sessionId", requireAuth, async (req, res) => {
  const user = req.user as any;
  try {
    const session = await prisma.aiChatSession.findUnique({
      where: { id: req.params.sessionId },
      select: { id: true, userId: true, providerId: true, user: { select: { parentAccountId: true } } },
    });
    if (!session?.providerId) return res.status(404).json({ message: "Session not found" });
    const roles: string[] = user?.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN") || roles.includes("GOSTORK_CONCIERGE");
    const isProviderMember = user?.providerId && user.providerId === session.providerId;
    const isOwner = user?.id === session.userId;
    const isAccountMember = !!user?.parentAccountId && user.parentAccountId === session.user?.parentAccountId;
    if (!isAdmin && !isProviderMember && !isOwner && !isAccountMember) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const { agreementServiceTypeForSession } = await import("./agreement-flow");
    const { resolveAgreementTemplate, downloadAgreementTemplateFile } = await import("./pandadoc-service");
    const serviceType = await agreementServiceTypeForSession(session.id);
    const tpl = await resolveAgreementTemplate(session.providerId, serviceType);
    if (!tpl.agreementTemplateUrl) return res.status(404).json({ message: "No agreement template uploaded" });
    const { buffer, contentType, filename } = await downloadAgreementTemplateFile(tpl.agreementTemplateUrl);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="${(tpl.agreementTemplateOriginalName || filename).replace(/"/g, "")}"`);
    res.send(buffer);
  } catch (e: any) {
    console.error("Template preview error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Phase 5: parent-facing agreements list (the Agreements tab in /my/billing).
// Covers every member of the parent account, mirroring shared sessions.
// ─── Phase: Home dashboards ──────────────────────────────────────────────────

// Parent Home: dismiss a prep-doc queue row. Key is scoped to the parent
// account so one member's dismissal clears it for the household, and to the
// message id so a NEW prep guide (new call) always resurfaces.
chatRouter.post("/api/my/dashboard/dismiss", requireAuth, async (req, res) => {
  const user = req.user as any;
  const messageId = String(req.body?.messageId || "").trim();
  if (!messageId) return res.status(400).json({ message: "messageId required" });
  try {
    const me = await prisma.user.findUnique({ where: { id: user.id }, select: { parentAccountId: true } });
    const memberIds = me?.parentAccountId
      ? (await prisma.user.findMany({ where: { parentAccountId: me.parentAccountId }, select: { id: true } })).map(u => u.id)
      : [user.id];
    // The message must live in one of the parent's own sessions.
    const msg = await prisma.aiChatMessage.findUnique({ where: { id: messageId }, select: { session: { select: { userId: true } } } });
    if (!msg || !memberIds.includes(msg.session?.userId || "")) return res.status(404).json({ message: "Not found" });
    const accountKey = me?.parentAccountId || user.id;
    await prisma.adminTaskDismissal.upsert({
      where: { taskKey: `parent-prep:${accountKey}:${messageId}` },
      create: { taskKey: `parent-prep:${accountKey}:${messageId}`, dismissedBy: user.id },
      update: {},
    });
    res.json({ ok: true });
  } catch (e: any) {
    console.error("Parent dismiss error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Parent Home action queue: things only discoverable by scanning chat cards
// (proposed call times, agreements awaiting MY signature). Invoices, cost
// sheets and meetings come from their existing endpoints client-side.
chatRouter.get("/api/my/dashboard-queue", requireAuth, async (req, res) => {
  const user = req.user as any;
  try {
    const me = await prisma.user.findUnique({ where: { id: user.id }, select: { parentAccountId: true, email: true } });
    const memberIds = me?.parentAccountId
      ? (await prisma.user.findMany({ where: { parentAccountId: me.parentAccountId }, select: { id: true } })).map(u => u.id)
      : [user.id];

    const sessions = await prisma.aiChatSession.findMany({
      where: { userId: { in: memberIds } },
      select: { id: true, title: true, status: true, createdAt: true, handoffCompletedAt: true, providerId: true, provider: { select: { name: true } } },
    });
    const sessionIds = sessions.map(s => s.id);
    const providerNameBySession = new Map(sessions.map(s => [s.id, s.provider?.name || null]));
    const sessionById = new Map(sessions.map(s => [s.id, s]));

    // Missed calls that still need rebooking - derived per SESSION, not per
    // org journey: the org journey may already be handed off for a different
    // match while a parallel thread (another surrogate/donor) has a freshly
    // missed call. A session qualifies while its LATEST outcome-bearing call
    // is a parent-side no-show, nothing new is booked, and the thread hasn't
    // progressed (no paid invoice, not handed off).
    const linkedBookings = sessionIds.length
      ? await prisma.booking.findMany({
          where: { parentUserId: { in: memberIds }, sessionId: { in: sessionIds } },
          select: { sessionId: true, scheduledAt: true, duration: true, status: true, outcome: true, meetingSubtype: true },
        })
      : [];
    const bookingsBySession = new Map<string, typeof linkedBookings>();
    for (const bk of linkedBookings) {
      const arr = bookingsBySession.get(bk.sessionId as string) || [];
      arr.push(bk);
      bookingsBySession.set(bk.sessionId as string, arr);
    }
    const nowMs = Date.now();
    const rescheduleCandidates: Array<{ sessionId: string; missedAt: Date; callLabel: string }> = [];
    for (const [sid, bks] of bookingsBySession) {
      const sess = sessionById.get(sid);
      if (!sess || sess.status === "ARCHIVED" || sess.handoffCompletedAt) continue;
      const live = bks.some(bk => ["PENDING", "CONFIRMED"].includes(bk.status) && new Date(bk.scheduledAt).getTime() + (bk.duration || 30) * 60 * 1000 > nowMs);
      if (live) continue;
      const latestOutcome = bks
        .filter(bk => bk.outcome)
        .sort((a, z) => new Date(z.scheduledAt).getTime() - new Date(a.scheduledAt).getTime())[0];
      if (!latestOutcome || !["NO_SHOW_PARENT", "NO_SHOW_BOTH"].includes(latestOutcome.outcome as string)) continue;
      rescheduleCandidates.push({
        sessionId: sid,
        missedAt: latestOutcome.scheduledAt,
        callLabel: latestOutcome.meetingSubtype === "MATCH_CALL" ? "Match Call"
          : latestOutcome.meetingSubtype === "DOCTOR_CONSULTATION" ? "Doctor Call"
          : "consultation",
      });
    }
    // Accountability scope (user decision, 7B UAT): missed calls are per-CHAT
    // until the parent has PAID an invoice with that organization - after
    // that the relationship is per-ORGANIZATION and the provider owns
    // scheduling, so missed calls on parallel threads with the same org are
    // not the parent's action items. The one way back to per-chat is an
    // explicit post-handoff restart ([[JOURNEY_RESTART]] -> JOURNEY_RESTARTED
    // event): threads created after the restart count again.
    let dropPaidOrg: (c: { sessionId: string }) => boolean = () => false;
    if (rescheduleCandidates.length) {
      const paidProviderIds = new Set((await prisma.invoice.findMany({
        where: { parentUserId: { in: memberIds }, status: "PAID" },
        select: { providerId: true },
      })).map(i => i.providerId));
      const restarts = await prisma.journeyEvent.findMany({
        where: { parentAccountId: me?.parentAccountId || user.id, eventType: "JOURNEY_RESTARTED" },
        select: { providerId: true, createdAt: true },
      });
      const latestRestartByProvider = new Map<string, Date>();
      for (const r of restarts) {
        if (!r.providerId) continue;
        const prev = latestRestartByProvider.get(r.providerId);
        if (!prev || r.createdAt > prev) latestRestartByProvider.set(r.providerId, r.createdAt);
      }
      dropPaidOrg = (c) => {
        const sess = sessionById.get(c.sessionId);
        if (!sess?.providerId || !paidProviderIds.has(sess.providerId)) return false;
        const restartAt = latestRestartByProvider.get(sess.providerId);
        // Paid org: drop unless this thread started AFTER an explicit restart.
        return !(restartAt && sess.createdAt > restartAt);
      };
    }
    const callsToReschedule = rescheduleCandidates
      .filter(c => !dropPaidOrg(c))
      .map(c => ({
        sessionId: c.sessionId,
        missedAt: c.missedAt,
        callLabel: c.callLabel,
        providerName: providerNameBySession.get(c.sessionId) || null,
        subjectLabel: sessionById.get(c.sessionId)?.title || null,
      }));

    // Proposed call times the parent hasn't confirmed yet
    const proposedCards = sessionIds.length
      ? await prisma.aiChatMessage.findMany({
          where: { sessionId: { in: sessionIds }, uiCardType: "proposed_times" },
          orderBy: { createdAt: "desc" },
          take: 50,
          select: { id: true, sessionId: true, createdAt: true, uiCardData: true },
        })
      : [];
    const pendingProposals = proposedCards
      .filter(c => (((c.uiCardData as any) || {}).status ?? "pending") === "pending")
      .map(c => ({
        messageId: c.id,
        sessionId: c.sessionId,
        createdAt: c.createdAt,
        providerName: providerNameBySession.get(c.sessionId) || null,
        callLabel: ((c.uiCardData as any) || {}).meetingSubtype === "MATCH_CALL" ? "Match Call"
          : ((c.uiCardData as any) || {}).meetingSubtype === "DOCTOR_CONSULTATION" ? "Doctor Call"
          : "a call",
        subjectLabel: ((c.uiCardData as any) || {}).subjectLabel || null,
      }));

    // Agreements sent where THIS user still has to sign
    const sentAgreements = await prisma.agreement.findMany({
      where: { parentUserId: { in: memberIds }, status: "SENT" },
      select: { id: true, documentType: true, sessionId: true, createdAt: true, signerStatus: true, provider: { select: { name: true } } },
    });
    // Prep guides Eva attached in chat (consultation / match-call / doctor
    // call PDFs) - parents skim past them in the conversation, so surface
    // the recent ones as action items they can read or dismiss.
    const accountKey = me?.parentAccountId || user.id;
    const d30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const prepAttachments = sessionIds.length
      ? await prisma.aiChatMessage.findMany({
          where: {
            sessionId: { in: sessionIds },
            uiCardType: "attachment",
            createdAt: { gte: d30 },
            uiCardData: { path: ["matchCallPrepForBookingId"], string_contains: ":guide" },
          },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: { id: true, sessionId: true, createdAt: true, uiCardData: true },
        })
      : [];
    const prepDismissed = new Set(
      (await prisma.adminTaskDismissal.findMany({
        where: { taskKey: { startsWith: `parent-prep:${accountKey}:` } },
        select: { taskKey: true },
      })).map(d => d.taskKey),
    );
    const prepBookingIds = prepAttachments
      .map(m => String(((m.uiCardData as any) || {}).matchCallPrepForBookingId || "").split(":")[0])
      .filter(Boolean);
    const prepBookings = prepBookingIds.length
      ? await prisma.booking.findMany({ where: { id: { in: prepBookingIds } }, select: { id: true, meetingSubtype: true, scheduledAt: true } })
      : [];
    const bookingById = new Map(prepBookings.map(b => [b.id, b]));
    const prepDocs = prepAttachments
      .filter(m => !prepDismissed.has(`parent-prep:${accountKey}:${m.id}`))
      .map(m => {
        const d = (m.uiCardData as any) || {};
        const bookingId = String(d.matchCallPrepForBookingId || "").split(":")[0];
        const bk = bookingById.get(bookingId);
        const callLabel = bk?.meetingSubtype === "MATCH_CALL" ? "Match Call"
          : bk?.meetingSubtype === "DOCTOR_CONSULTATION" ? "Doctor Call"
          : "consultation";
        return {
          messageId: m.id,
          sessionId: m.sessionId,
          createdAt: m.createdAt,
          providerName: providerNameBySession.get(m.sessionId) || null,
          callLabel,
          scheduledAt: bk?.scheduledAt || null,
          url: d.url || null,
          fileName: d.originalName || "Prep Guide.pdf",
        };
      })
      .filter(p2 => !!p2.url);

    const myEmail = (me?.email || user.email || "").toLowerCase();
    const awaitingMySignature = sentAgreements
      .filter(a => {
        const ss = (a.signerStatus as Record<string, any>) || {};
        const mine = Object.entries(ss).find(([email]) => email.toLowerCase() === myEmail);
        // No signer entry for me -> not my turn / not my doc; entry present and
        // not completed -> action item.
        return mine ? mine[1]?.completed !== true : false;
      })
      .map(a => ({
        agreementId: a.id,
        documentType: a.documentType,
        sessionId: a.sessionId,
        createdAt: a.createdAt,
        providerName: a.provider?.name || null,
      }));

    // Intended Parent Form: pending while a prompted response is unfinished.
    // The row disappears the moment the account submits.
    const accountIdForIpForm = me?.parentAccountId || user.id;
    const ipFormResponse = await prisma.ipFormResponse.findUnique({
      where: { parentAccountId: accountIdForIpForm },
      select: { id: true, status: true, promptedAt: true, hasSecondParent: true },
    }).catch(() => null);
    const ipFormSignatures = ipFormResponse
      ? await prisma.ipFormSignature.findMany({ where: { responseId: ipFormResponse.id }, select: { parentSlot: true } })
      : [];
    const ipFormPending =
      ipFormResponse && ipFormResponse.status === "DRAFT" && ipFormResponse.promptedAt
        ? [{
            responseId: ipFormResponse.id,
            promptedAt: ipFormResponse.promptedAt,
            signedSlots: ipFormSignatures.map(s => s.parentSlot),
            hasSecondParent: ipFormResponse.hasSecondParent,
          }]
        : [];

    res.json({ pendingProposals, awaitingMySignature, prepDocs, callsToReschedule, ipFormPending });
  } catch (e: any) {
    console.error("Parent dashboard queue error:", e);
    res.status(500).json({ message: e.message });
  }
});

// GoStork admin Home: platform-wide command center. Stuck items first
// (escalations, deposit deadlines, unsigned agreements, failed payouts),
// then the 30-day funnel, money tiles, and automation adoption.
chatRouter.get("/api/admin/dashboard", requireAuth, async (req, res) => {
  const user = req.user as any;
  const roles: string[] = user?.roles || [];
  if (!roles.includes("GOSTORK_ADMIN") && !roles.includes("GOSTORK_CONCIERGE")) {
    return res.status(403).json({ message: "GoStork admin only" });
  }
  try {
    const now = new Date();
    const d30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [
      escalations,
      dueInvoices,
      sentAgreements,
      failedPayouts,
      pendingMeetings,
      activeSessions,
      hotLeads30,
      callsBooked30,
      matchedNow,
      onHoldNow,
      deposits30,
      signed30,
      paidInvoices,
      providers,
      flaggedReviewRows,
    ] = await Promise.all([
      prisma.aiChatSession.findMany({
        where: { humanRequested: true, humanConcludedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: { id: true, updatedAt: true, user: { select: { name: true, firstName: true, email: true } }, provider: { select: { name: true } } },
      }),
      prisma.invoice.findMany({
        where: { status: "AWAITING_PAYMENT", dueAt: { not: null } },
        orderBy: { dueAt: "asc" },
        take: 10,
        select: { id: true, dueAt: true, serviceAmount: true, serviceType: true, sessionId: true, parentUser: { select: { name: true, firstName: true, email: true } }, provider: { select: { name: true } } },
      }),
      prisma.agreement.findMany({
        where: { status: "SENT" },
        orderBy: { createdAt: "asc" },
        take: 10,
        select: { id: true, createdAt: true, documentType: true, signerStatus: true, parentUser: { select: { name: true, firstName: true, email: true } }, provider: { select: { name: true } } },
      }),
      prisma.invoice.findMany({
        // Still-unresolved failures only: a later successful transfer (or a
        // completed bank payout) clears the item from the queue even though
        // payoutFailedAt stays stamped.
        where: { status: "PAID", payoutFailedAt: { not: null }, stripeTransferId: null, bankPayoutCompletedAt: null },
        orderBy: { payoutFailedAt: "desc" },
        take: 10,
        select: { id: true, payoutFailedAt: true, payoutFailureReason: true, providerPayoutAmount: true, provider: { select: { name: true } }, parentUser: { select: { name: true, firstName: true } } },
      }),
      // Meetings awaiting a GOSTORK host's confirmation - a task, not just a
      // calendar row. Provider-hosted pending meetings are the provider's task
      // and already surface in the provider home work queue.
      prisma.booking.findMany({
        where: { status: "PENDING", providerUser: { roles: { hasSome: ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE"] } } },
        orderBy: { scheduledAt: "asc" },
        take: 10,
        select: { id: true, scheduledAt: true, subject: true, attendeeName: true, parentUser: { select: { name: true, firstName: true, email: true } }, providerUser: { select: { id: true, name: true } } },
      }),
      prisma.aiChatSession.count({ where: { updatedAt: { gte: d30 } } }),
      prisma.intendedParentProfile.count({ where: { hotLeadAt: { gte: d30 } } }),
      prisma.booking.count({ where: { createdAt: { gte: d30 }, status: { notIn: ["CANCELLED", "DECLINED", "RESCHEDULED", "EXPIRED"] } } }),
      prisma.surrogate.count({ where: { status: "MATCHED" } }),
      prisma.surrogate.count({ where: { status: "ON_HOLD" } }),
      prisma.invoice.count({ where: { status: "PAID", paidAt: { gte: d30 } } }),
      prisma.agreement.count({ where: { status: "SIGNED", signedAt: { gte: d30 } } }),
      prisma.invoice.findMany({
        where: { status: "PAID" },
        select: { serviceAmount: true, referralFeeAmount: true, providerPayoutAmount: true, stripeTransferId: true },
      }),
      prisma.provider.findMany({
        where: { services: { some: { status: "APPROVED" } } },
        select: { id: true, autoFeaturesEnabled: true, agreementAutomation: true },
      }),
      // Phase 8: reviews a provider flagged for re-check - resolved by admin
      // Remove (REJECTED) or Restore (clears the flag) in /admin/reviews.
      prisma.providerReview.findMany({
        where: { flaggedByProviderAt: { not: null }, status: "PUBLISHED" },
        orderBy: { flaggedByProviderAt: "desc" },
        take: 10,
        select: { id: true, rating: true, flagReason: true, flaggedByProviderAt: true, provider: { select: { name: true } } },
      }),
    ]);

    const [upcomingMeetings, recentInvoices, recentPayouts] = await Promise.all([
      prisma.booking.findMany({
        where: { scheduledAt: { gte: now }, status: { in: ["PENDING", "CONFIRMED"] } },
        orderBy: { scheduledAt: "asc" },
        take: 8,
        select: {
          id: true,
          scheduledAt: true,
          subject: true,
          status: true,
          providerUserId: true,
          parentUser: { select: { name: true, firstName: true, email: true } },
          providerUser: { select: { name: true, provider: { select: { name: true } } } },
        },
      }),
      prisma.invoice.findMany({
        orderBy: { createdAt: "desc" },
        take: 3,
        select: {
          id: true,
          status: true,
          serviceAmount: true,
          serviceType: true,
          createdAt: true,
          parentUser: { select: { name: true, firstName: true, email: true } },
          provider: { select: { name: true } },
        },
      }),
      prisma.invoice.findMany({
        where: { status: "PAID", providerPayoutAmount: { gt: 0 } },
        orderBy: { paidAt: "desc" },
        take: 3,
        select: {
          id: true,
          providerPayoutAmount: true,
          currency: true,
          paidAt: true,
          payoutInitiatedAt: true,
          payoutFailedAt: true,
          stripeTransferId: true,
          bankPayoutCompletedAt: true,
          bankPayoutFailedAt: true,
          provider: { select: { name: true } },
          parentUser: { select: { name: true, firstName: true } },
        },
      }),
    ]);

    // Dismissed Needs-attention rows. The taskKey embeds the occurrence
    // timestamp, so the same invoice failing AGAIN later gets a fresh key
    // and re-surfaces despite the old dismissal.
    const dismissedKeys = new Set(
      (await prisma.adminTaskDismissal.findMany({ select: { taskKey: true } })).map(d => d.taskKey),
    );

    const awaitingAgg = await prisma.invoice.aggregate({
      where: { status: { in: ["AWAITING_PAYMENT", "AUTHORIZED"] } },
      _sum: { serviceAmount: true },
    });
    const awaitingPayment = awaitingAgg._sum.serviceAmount || 0;

    const totalCollected = paidInvoices.reduce((sum, i) => sum + (i.serviceAmount || 0), 0);
    const totalFees = paidInvoices.reduce((sum, i) => sum + (i.referralFeeAmount || 0), 0);
    const pendingPayouts = paidInvoices.filter(i => !i.stripeTransferId).length;
    const payoutsSent = paidInvoices
      .filter(i => i.stripeTransferId)
      .reduce((sum, i: any) => sum + (i.providerPayoutAmount || 0), 0);

    const adoption = { total: providers.length, costSheet: 0, invoice: 0, agreement: 0 };
    for (const pr of providers) {
      const f = (pr.autoFeaturesEnabled as any) || {};
      if (f.autoCostSheetDraft === true) adoption.costSheet++;
      if (f.autoInvoiceDraft === true) adoption.invoice++;
      // Provider's own setting overrides the admin rollout toggle
      const mode = pr.agreementAutomation;
      if (mode === "approval" || mode === "auto_send" || (mode == null && f.autoAgreementDraft === true)) adoption.agreement++;
    }

    res.json({
      flaggedReviews: flaggedReviewRows
        .map(r => ({
          reviewId: r.id,
          rating: r.rating,
          flagReason: r.flagReason,
          flaggedAt: r.flaggedByProviderAt,
          providerName: r.provider?.name || null,
          taskKey: `review-flag:${r.id}:${r.flaggedByProviderAt ? new Date(r.flaggedByProviderAt).getTime() : 0}`,
        }))
        .filter(r => !dismissedKeys.has(r.taskKey)),
      escalations: escalations
        .map(e => ({
          sessionId: e.id,
          parentName: e.user?.firstName || e.user?.name || e.user?.email || "Parent",
          providerName: e.provider?.name || null,
          updatedAt: e.updatedAt,
          taskKey: `escalation:${e.id}`,
        }))
        .filter(e => !dismissedKeys.has(e.taskKey)),
      dueInvoices: dueInvoices
        .map(inv => ({
          id: inv.id,
          sessionId: inv.sessionId,
          dueAt: inv.dueAt,
          overdue: inv.dueAt ? inv.dueAt < now : false,
          amountCents: inv.serviceAmount,
          serviceType: inv.serviceType,
          parentName: inv.parentUser?.firstName || inv.parentUser?.name || inv.parentUser?.email || "Parent",
          providerName: inv.provider?.name || null,
          taskKey: `due-invoice:${inv.id}:${inv.dueAt ? new Date(inv.dueAt).getTime() : 0}`,
        }))
        .filter(inv => !dismissedKeys.has(inv.taskKey)),
      sentAgreements: sentAgreements.map(a => {
        const ss = (a.signerStatus as Record<string, any>) || {};
        const signers = Object.values(ss);
        return {
          agreementId: a.id,
          createdAt: a.createdAt,
          documentType: a.documentType,
          parentName: a.parentUser?.firstName || a.parentUser?.name || a.parentUser?.email || "Parent",
          providerName: a.provider?.name || null,
          signedCount: signers.filter((x: any) => x?.completed).length,
          signerCount: signers.length,
        };
      }),
      failedPayouts: failedPayouts
        .map(inv => ({
          id: inv.id,
          payoutFailedAt: inv.payoutFailedAt,
          payoutFailureReason: inv.payoutFailureReason,
          amountCents: inv.providerPayoutAmount,
          providerName: inv.provider?.name || null,
          parentName: inv.parentUser?.firstName || inv.parentUser?.name || "Parent",
          taskKey: `failed-payout:${inv.id}:${inv.payoutFailedAt ? new Date(inv.payoutFailedAt).getTime() : 0}`,
        }))
        .filter(inv => !dismissedKeys.has(inv.taskKey)),
      pendingMeetings: pendingMeetings
        .map(b => ({
          id: b.id,
          scheduledAt: b.scheduledAt,
          subject: b.subject,
          parentName: b.parentUser?.firstName || b.parentUser?.name || b.attendeeName || b.parentUser?.email || "Parent",
          hostName: b.providerUser?.name || "GoStork",
          hostUserId: b.providerUser?.id || null,
          taskKey: `pending-booking:${b.id}:${new Date(b.scheduledAt).getTime()}`,
        }))
        .filter(b => !dismissedKeys.has(b.taskKey)),
      funnel: {
        activeSessions,
        hotLeads: hotLeads30,
        callsBooked: callsBooked30,
        matched: matchedNow,
        onHold: onHoldNow,
        depositsPaid: deposits30,
        agreementsSigned: signed30,
      },
      money: { totalCollected, totalFees, pendingPayouts, payoutsSent, awaitingPayment },
      adoption,
      upcomingMeetings: upcomingMeetings.map(b => ({
        id: b.id,
        scheduledAt: b.scheduledAt,
        subject: b.subject,
        status: b.status,
        // Host user id lets the admin Home split "my meetings" (this admin
        // hosts) from platform-wide provider-parent meetings.
        hostUserId: b.providerUserId,
        parentName: b.parentUser?.firstName || b.parentUser?.name || b.parentUser?.email || "Parent",
        providerName: b.providerUser?.provider?.name || b.providerUser?.name || "Provider",
      })),
      recentInvoices: recentInvoices.map(inv => ({
        id: inv.id,
        status: inv.status,
        amountCents: inv.serviceAmount,
        serviceType: inv.serviceType,
        createdAt: inv.createdAt,
        parentName: inv.parentUser?.firstName || inv.parentUser?.name || inv.parentUser?.email || "Parent",
        providerName: inv.provider?.name || null,
      })),
      recentPayouts: recentPayouts.map(inv => ({
        id: inv.id,
        amountCents: inv.providerPayoutAmount,
        paidAt: inv.paidAt,
        payoutInitiatedAt: inv.payoutInitiatedAt,
        payoutFailedAt: inv.payoutFailedAt,
        stripeTransferId: inv.stripeTransferId,
        bankPayoutCompletedAt: inv.bankPayoutCompletedAt,
        bankPayoutFailedAt: inv.bankPayoutFailedAt,
        status: "PAID",
        providerName: inv.provider?.name || null,
        parentName: inv.parentUser?.firstName || inv.parentUser?.name || "Parent",
      })),
    });
  } catch (e: any) {
    console.error("Admin dashboard error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Dismiss a row in the admin Home Needs-attention queue (and undo it).
// taskKey format: "<type>:<entityId>[:<occurredAtMs>]" - built server-side
// in /api/admin/dashboard; a new occurrence of the same problem gets a new
// key and re-surfaces.
chatRouter.post("/api/admin/dashboard/dismiss", requireAuth, async (req, res) => {
  const user = req.user as any;
  const roles: string[] = user?.roles || [];
  if (!roles.includes("GOSTORK_ADMIN") && !roles.includes("GOSTORK_CONCIERGE")) {
    return res.status(403).json({ message: "GoStork admin only" });
  }
  const taskKey = String(req.body?.taskKey || "").trim();
  if (!taskKey || taskKey.length > 200) return res.status(400).json({ message: "taskKey required" });
  try {
    await prisma.adminTaskDismissal.upsert({
      where: { taskKey },
      create: { taskKey, dismissedBy: user.id },
      update: {},
    });
    res.json({ ok: true });
  } catch (e: any) {
    console.error("Dismiss task error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.delete("/api/admin/dashboard/dismiss", requireAuth, async (req, res) => {
  const user = req.user as any;
  const roles: string[] = user?.roles || [];
  if (!roles.includes("GOSTORK_ADMIN") && !roles.includes("GOSTORK_CONCIERGE")) {
    return res.status(403).json({ message: "GoStork admin only" });
  }
  const taskKey = String(req.query?.taskKey || "").trim();
  if (!taskKey) return res.status(400).json({ message: "taskKey required" });
  try {
    await prisma.adminTaskDismissal.deleteMany({ where: { taskKey } });
    res.json({ ok: true });
  } catch (e: any) {
    console.error("Undo dismiss error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Provider Home work queue: every unresolved inline decision across all the
// provider's sessions - approval cards (cost sheet / invoice / agreement),
// unanswered readiness prompts, unanswered whispers, agreements out for
// signature. Bookings + invoices come from their existing endpoints.
chatRouter.get("/api/provider/dashboard-queue", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const sessions = await prisma.aiChatSession.findMany({
      where: { providerId: user.providerId },
      select: { id: true, user: { select: { name: true, firstName: true, lastName: true, email: true } } },
    });
    const sessionIds = sessions.map(s => s.id);
    const parentNameBySession = new Map(sessions.map(s => [
      s.id,
      s.user?.firstName || s.user?.name || s.user?.email || "Parent",
    ]));

    const APPROVAL_TYPES = ["cost_sheet_draft_approval", "invoice_draft_approval", "agreement_draft_approval", "provider_readiness_prompt"];
    const cards = sessionIds.length
      ? await prisma.aiChatMessage.findMany({
          where: { sessionId: { in: sessionIds }, uiCardType: { in: APPROVAL_TYPES } },
          orderBy: { createdAt: "desc" },
          take: 200,
          select: { id: true, sessionId: true, uiCardType: true, createdAt: true, uiCardData: true },
        })
      : [];
    const openApprovals = cards
      .filter(c => {
        const d = (c.uiCardData as any) || {};
        if (c.uiCardType === "provider_readiness_prompt") return !d.answered;
        return !d.resolvedAt;
      })
      .map(c => ({
        messageId: c.id,
        sessionId: c.sessionId,
        type: c.uiCardType,
        createdAt: c.createdAt,
        parentName: ((c.uiCardData as any) || {}).parentName || parentNameBySession.get(c.sessionId) || "Parent",
        documentType: ((c.uiCardData as any) || {}).documentType || null,
        totalCents: ((c.uiCardData as any) || {}).totalCents ?? null,
      }));

    const [pendingWhispers, reviewsAwaitingReply, agreementsAwaiting] = await Promise.all([
      prisma.silentQuery.findMany({
        where: { providerId: user.providerId, status: "PENDING" },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, questionText: true, createdAt: true },
      }),
      // Phase 8: fresh published reviews the provider hasn't responded to -
      // resolves naturally when a reply is posted (or the review is flagged).
      prisma.providerReview.findMany({
        where: {
          providerId: user.providerId,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          providerReply: null,
          flaggedByProviderAt: null,
          createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, rating: true, bodyText: true, createdAt: true, anonymous: true, authorUserId: true, member: { select: { name: true } } },
      }).then(async (rows) => {
        const authors = await prisma.user.findMany({
          where: { id: { in: rows.map(r => r.authorUserId) } },
          select: { id: true, name: true, firstName: true },
        });
        const byId = new Map(authors.map(a => [a.id, a]));
        return rows.map(r => {
          const a = byId.get(r.authorUserId);
          const first = a?.firstName || (a?.name || "").split(" ")[0] || "A parent";
          const last = (a?.name || "").split(" ").slice(1).join(" ");
          return {
            reviewId: r.id,
            rating: r.rating,
            text: r.bodyText,
            createdAt: r.createdAt,
            memberName: r.member?.name || null,
            reviewerLabel: r.anonymous ? "Verified GoStork Parent" : (last ? `${first} ${last.charAt(0).toUpperCase()}.` : first),
          };
        });
      }),
      prisma.agreement.findMany({
        where: { providerId: user.providerId, status: "SENT" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          documentType: true,
          createdAt: true,
          signerStatus: true,
          parentUser: { select: { name: true, firstName: true, lastName: true, email: true } },
        },
      }),
    ]);

    res.json({
      openApprovals,
      pendingWhispers,
      reviewsAwaitingReply,
      agreementsAwaiting: agreementsAwaiting.map(a => {
        const ss = (a.signerStatus as Record<string, any>) || {};
        const signers = Object.values(ss);
        return {
          agreementId: a.id,
          documentType: a.documentType,
          createdAt: a.createdAt,
          parentName: a.parentUser?.firstName || a.parentUser?.name || a.parentUser?.email || "Parent",
          signedCount: signers.filter((x: any) => x?.completed).length,
          signerCount: signers.length,
        };
      }),
    });
  } catch (e: any) {
    console.error("Provider dashboard queue error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.get("/api/my/agreements", requireAuth, async (req, res) => {
  const user = req.user as any;
  try {
    const me = await prisma.user.findUnique({ where: { id: user.id }, select: { parentAccountId: true } });
    const memberIds = me?.parentAccountId
      ? (await prisma.user.findMany({ where: { parentAccountId: me.parentAccountId }, select: { id: true } })).map(u => u.id)
      : [user.id];
    const agreements = await prisma.agreement.findMany({
      where: { parentUserId: { in: memberIds } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        documentType: true,
        serviceType: true,
        sessionId: true,
        signedAt: true,
        rejectedAt: true,
        createdAt: true,
        provider: { select: { id: true, name: true, logoUrl: true } },
      },
    });
    res.json(agreements);
  } catch (e: any) {
    console.error("List my agreements error:", e);
    res.status(500).json({ message: e.message });
  }
});

// GoStork admin: every agreement across all providers (the admin Agreements
// page). Includes parent + provider names and signer progress.
chatRouter.get("/api/admin/agreements", requireAuth, async (req, res) => {
  const user = req.user as any;
  const roles: string[] = user?.roles || [];
  if (!roles.includes("GOSTORK_ADMIN") && !roles.includes("GOSTORK_CONCIERGE")) {
    return res.status(403).json({ message: "GoStork admin only" });
  }
  try {
    const agreements = await prisma.agreement.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        documentType: true,
        signedAt: true,
        createdAt: true,
        signerStatus: true,
        parentUser: { select: { name: true, firstName: true, lastName: true, email: true } },
        provider: { select: { name: true } },
      },
    });
    res.json(agreements.map(a => {
      const ss = (a.signerStatus as Record<string, any>) || {};
      const signers = Object.values(ss);
      return {
        id: a.id,
        status: a.status,
        documentType: a.documentType,
        signedAt: a.signedAt,
        createdAt: a.createdAt,
        parentName: a.parentUser?.name || `${a.parentUser?.firstName || ""} ${a.parentUser?.lastName || ""}`.trim() || a.parentUser?.email || "Parent",
        providerName: a.provider?.name || "Provider",
        signedCount: signers.filter((x: any) => x?.completed).length,
        signerCount: signers.length,
      };
    }));
  } catch (e: any) {
    console.error("Admin agreements list error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.get("/api/agreements", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const agreements = await prisma.agreement.findMany({
      where: { providerId: user.providerId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        documentType: true,
        pandaDocViewUrl: true,
        signedAt: true,
        rejectedAt: true,
        createdAt: true,
        parentUser: {
          select: { name: true, firstName: true, lastName: true, email: true },
        },
      },
    });
    const formatted = agreements.map(a => ({
      id: a.id,
      status: a.status,
      documentType: a.documentType,
      pandaDocViewUrl: a.pandaDocViewUrl,
      signedAt: a.signedAt,
      rejectedAt: a.rejectedAt,
      createdAt: a.createdAt,
      parentName: a.parentUser.name || `${a.parentUser.firstName || ""} ${a.parentUser.lastName || ""}`.trim() || a.parentUser.email,
      parentEmail: a.parentUser.email,
    }));
    res.json(formatted);
  } catch (e: any) {
    console.error("List agreements error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Sync provider's Word/PDF template to PandaDoc as a reusable template
chatRouter.post("/api/agreements/sync-template", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const templateId = await syncTemplateToPandaDoc(user.providerId, typeof req.query.serviceType === "string" ? req.query.serviceType : (typeof req.body?.serviceType === "string" ? req.body.serviceType : null));
    res.json({ templateId });
  } catch (e: any) {
    console.error("Sync template error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Delete the provider's PandaDoc template and clear GoStork's reference
chatRouter.delete("/api/agreements/template", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  const serviceType = typeof req.query.serviceType === "string" ? req.query.serviceType : null;
  try {
    let pandaDocTemplateId: string | null = null;
    if (serviceType) {
      const row = await prisma.providerAgreementTemplate.findUnique({
        where: { providerId_serviceType: { providerId: user.providerId, serviceType } },
        select: { pandaDocTemplateId: true },
      });
      pandaDocTemplateId = row?.pandaDocTemplateId ?? null;
    } else {
      const provider = await prisma.provider.findUnique({
        where: { id: user.providerId },
        select: { pandaDocTemplateId: true },
      });
      pandaDocTemplateId = provider?.pandaDocTemplateId ?? null;
    }
    if (pandaDocTemplateId) {
      const apiKey = process.env.PANDADOC_API_KEY;
      if (apiKey) {
        const delRes = await fetch(`https://api.pandadoc.com/public/v1/templates/${pandaDocTemplateId}`, {
          method: "DELETE",
          headers: { "Authorization": `API-Key ${apiKey}` },
        });
        console.log(`[PandaDoc] Template delete: ${pandaDocTemplateId} -> ${delRes.status}`);
      }
    }
    if (serviceType) {
      await prisma.providerAgreementTemplate.deleteMany({
        where: { providerId: user.providerId, serviceType },
      });
    } else {
      await prisma.provider.update({
        where: { id: user.providerId },
        data: { agreementTemplateUrl: null, agreementTemplateOriginalName: null, pandaDocTemplateId: null },
      });
    }
    res.json({ ok: true });
  } catch (e: any) {
    console.error("Delete template error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Per-service agreement templates (Phase 5): list all template slots and
// upsert a service's template file. The legacy single template on Provider
// remains the fallback for providers that never configured per-service rows.
chatRouter.get("/api/agreements/templates", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const [provider, rows, services] = await Promise.all([
      prisma.provider.findUnique({
        where: { id: user.providerId },
        select: { agreementTemplateUrl: true, agreementTemplateOriginalName: true, pandaDocTemplateId: true, agreementAutomation: true, autoFeaturesEnabled: true },
      }),
      prisma.providerAgreementTemplate.findMany({ where: { providerId: user.providerId } }),
      prisma.providerService.findMany({
        where: { providerId: user.providerId, status: "APPROVED" },
        select: { providerType: { select: { name: true } } },
      }),
    ]);
    const serviceTypes = new Set<string>();
    for (const svc of services) {
      const n = (svc.providerType?.name || "").toLowerCase();
      if (n.includes("surrog")) serviceTypes.add("SURROGACY");
      else if (n.includes("egg")) serviceTypes.add("EGG_DONATION");
      else if (n.includes("sperm")) serviceTypes.add("SPERM_DONATION");
      else if (n.includes("ivf") || n.includes("clinic")) serviceTypes.add("IVF_CLINIC");
    }
    const autoDraft = (provider?.autoFeaturesEnabled as any)?.autoAgreementDraft === true;
    res.json({
      serviceTypes: [...serviceTypes],
      legacy: {
        agreementTemplateUrl: provider?.agreementTemplateUrl ?? null,
        agreementTemplateOriginalName: provider?.agreementTemplateOriginalName ?? null,
        pandaDocTemplateId: provider?.pandaDocTemplateId ?? null,
      },
      templates: rows.map(r => ({
        serviceType: r.serviceType,
        agreementTemplateUrl: r.agreementTemplateUrl,
        agreementTemplateOriginalName: r.agreementTemplateOriginalName,
        pandaDocTemplateId: r.pandaDocTemplateId,
      })),
      agreementAutomation: provider?.agreementAutomation ?? null,
      adminAutoAgreementDraft: autoDraft,
    });
  } catch (e: any) {
    console.error("List agreement templates error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.put("/api/agreements/templates/:serviceType", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  const serviceType = req.params.serviceType;
  const VALID = ["SURROGACY", "EGG_DONATION", "SPERM_DONATION", "IVF_CLINIC", "OTHER"];
  if (!VALID.includes(serviceType)) return res.status(400).json({ message: "Invalid serviceType" });
  const { agreementTemplateUrl, agreementTemplateOriginalName } = req.body || {};
  if (typeof agreementTemplateUrl !== "string" || !agreementTemplateUrl) {
    return res.status(400).json({ message: "agreementTemplateUrl is required" });
  }
  try {
    const row = await prisma.providerAgreementTemplate.upsert({
      where: { providerId_serviceType: { providerId: user.providerId, serviceType } },
      // New file invalidates the previously synced PandaDoc template + roles
      update: { agreementTemplateUrl, agreementTemplateOriginalName: agreementTemplateOriginalName ?? null, pandaDocTemplateId: null, pandaDocRoles: null },
      create: { providerId: user.providerId, serviceType, agreementTemplateUrl, agreementTemplateOriginalName: agreementTemplateOriginalName ?? null },
    });
    res.json({ ok: true, serviceType: row.serviceType });
  } catch (e: any) {
    console.error("Upsert agreement template error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Provider's own automation preference (overrides the GoStork-admin rollout toggle)
chatRouter.put("/api/agreements/automation", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  const { mode } = req.body || {};
  if (mode !== null && !["off", "approval", "auto_send"].includes(mode)) {
    return res.status(400).json({ message: "mode must be null, off, approval, or auto_send" });
  }
  try {
    await prisma.provider.update({
      where: { id: user.providerId },
      data: { agreementAutomation: mode },
    });
    res.json({ ok: true, mode });
  } catch (e: any) {
    console.error("Update agreement automation error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Get PandaDoc embedded template editor session URL
chatRouter.get("/api/agreements/template-editor-session", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const eToken = await createTemplateEditingSession(user.providerId, user.email, typeof req.query.serviceType === "string" ? req.query.serviceType : null);
    res.json({ eToken });
  } catch (e: any) {
    console.error("Template editor session error:", e);
    res.status(500).json({ message: e.message });
  }
});


// Refresh cached role names from the PandaDoc template - called after provider closes editor
chatRouter.post("/api/agreements/refresh-roles", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const result = await refreshTemplateRoles(user.providerId, typeof req.query.serviceType === "string" ? req.query.serviceType : (typeof req.body?.serviceType === "string" ? req.body.serviceType : null));
    res.json(result);
  } catch (e: any) {
    console.error("Refresh template roles error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Generate agreement from PandaDoc template (new template-based flow).
// Thin wrapper over the shared flow in agreement-flow.ts (also used by the
// Phase 5 auto-draft approval + fully-automated paths).
chatRouter.post("/api/agreements/generate-from-template", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  const { sessionId, partnerOverride, skipPartner } = req.body;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ message: "sessionId is required" });
  }
  if (partnerOverride !== undefined) {
    if (
      typeof partnerOverride !== "object" || partnerOverride === null ||
      typeof partnerOverride.firstName !== "string" ||
      typeof partnerOverride.lastName !== "string" ||
      typeof partnerOverride.email !== "string"
    ) {
      return res.status(400).json({ message: "partnerOverride must have firstName, lastName, and email strings" });
    }
  }
  try {
    const { generateAndAnnounceAgreement } = await import("./agreement-flow");
    const agreement = await generateAndAnnounceAgreement({
      sessionId,
      providerId: user.providerId,
      generatedByUserId: user.id,
      partnerOverride: partnerOverride ?? undefined,
      skipPartner: skipPartner === true,
      trigger: "manual",
    });
    res.json({ success: true, agreementId: agreement.id, status: agreement.status });
  } catch (e: any) {
    if (e.code === "PAYMENT_REQUIRED") {
      return res.status(402).json({ code: "PAYMENT_REQUIRED", message: e.message });
    }
    if (e.code === "PARTNER_INFO_REQUIRED") {
      return res.status(409).json({
        code: "PARTNER_INFO_REQUIRED",
        parent1: e.parent1,
        parentRoles: e.parentRoles,
      });
    }
    console.error("Agreement from template error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Public guest signing session - no auth required, validated by one-time token
chatRouter.get("/api/agreements/guest/:token/signing-session", async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ message: "Missing token" });

    // Find the agreement that owns this token
    const agreement = await (prisma.agreement as any).findFirst({
      where: {
        guestSigningTokens: { path: [token], not: null },
      },
      select: { id: true, pandaDocDocumentId: true, guestSigningTokens: true },
    });
    if (!agreement) return res.status(404).json({ message: "Invalid or expired signing link" });

    const email: string | undefined = (agreement.guestSigningTokens as Record<string, string>)[token];
    if (!email) return res.status(404).json({ message: "Invalid or expired signing link" });

    if (!agreement.pandaDocDocumentId) return res.status(400).json({ message: "Agreement document not ready" });

    const apiKey = process.env.PANDADOC_API_KEY;
    if (!apiKey) return res.status(500).json({ message: "PandaDoc not configured" });

    const { fetchDocumentViewUrl } = await import("./pandadoc-service");
    const signingUrl = await fetchDocumentViewUrl(apiKey, agreement.pandaDocDocumentId, email);
    if (!signingUrl) return res.status(400).json({ message: "Could not create signing session - document may not be ready yet" });

    res.json({ signingUrl });
  } catch (e: any) {
    console.error("[Guest signing session]", e.message);
    res.status(500).json({ message: e.message });
  }
});

// Get a fresh signing session URL for a specific agreement (parent or provider access)
chatRouter.get("/api/agreements/:id/signing-session", requireAuth, async (req, res) => {
  const user = req.user as any;
  try {
    // GoStork admins don't sign either - same status view, any agreement
    const adminRoles: string[] = user?.roles || [];
    if (adminRoles.includes("GOSTORK_ADMIN") || adminRoles.includes("GOSTORK_CONCIERGE")) {
      const agr = await prisma.agreement.findUnique({
        where: { id: req.params.id as string },
        select: { id: true, providerId: true, status: true, sessionId: true, signerStatus: true },
      });
      if (!agr) return res.status(404).json({ message: "Agreement not found" });
      return res.json({ isProviderView: true, status: agr.status, agreementId: agr.id, sessionId: agr.sessionId, providerId: agr.providerId });
    }

    // Providers don't sign - return a completion view response instead
    if (isProviderUser(user)) {
      const agr = await prisma.agreement.findUnique({
        where: { id: req.params.id as string },
        select: { id: true, providerId: true, status: true, sessionId: true, signerStatus: true },
      });
      if (!agr) return res.status(404).json({ message: "Agreement not found" });
      if (agr.providerId !== user.providerId) return res.status(403).json({ message: "Not authorized to access this agreement" });
      return res.json({ isProviderView: true, status: agr.status, agreementId: agr.id, sessionId: agr.sessionId, providerId: user.providerId });
    }

    const result = await getAgreementSigningSession(req.params.id, user.id);
    res.json(result);

    // Track that this signer has opened/viewed the agreement (fire-and-forget)
    const _agreementId = req.params.id as string;
    Promise.all([
      prisma.agreement.findUnique({ where: { id: _agreementId }, select: { signerStatus: true, status: true } }),
      prisma.user.findUnique({ where: { id: user.id as string }, select: { firstName: true, lastName: true, name: true } }),
    ]).then(async ([agr, viewer]) => {
      if (!agr || agr.status === "SIGNED") return;
      const existing: Record<string, any> = (agr.signerStatus as Record<string, any>) ?? {};
      const rawEmail = user.email;
      const userEmail: string | undefined = Array.isArray(rawEmail) ? rawEmail[0] : rawEmail;
      if (!userEmail) return;
      const prev = existing[userEmail] ?? {};
      if (prev.viewed) return; // already marked
      const firstName = viewer?.firstName || (viewer?.name ? viewer.name.split(" ")[0] : null) || null;
      const lastName = viewer?.lastName || (viewer?.name && viewer.name.includes(" ") ? viewer.name.split(" ").slice(1).join(" ") : null) || null;
      await prisma.agreement.update({
        where: { id: _agreementId },
        data: {
          signerStatus: {
            ...existing,
            [userEmail]: {
              ...prev,
              viewed: true,
              viewedAt: new Date().toISOString(),
              firstName: prev.firstName ?? firstName,
              lastName: prev.lastName ?? lastName,
            },
          },
        },
      });
    }).catch(e => console.error("[Agreement] viewed tracking failed:", e));
  } catch (e: any) {
    console.error("Signing session error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Sync agreement status from PandaDoc API - called by the provider sidebar when status is SENT
chatRouter.post("/api/agreements/:id/sync-status", requireAuth, async (req, res) => {
  try {
    const agreement = await prisma.agreement.findUnique({
      where: { id: req.params.id as string },
      select: { providerId: true, parentUserId: true },
    });
    if (!agreement) return res.status(404).json({ message: "Not found" });
    const user = req.user as any;
    // Allow provider who owns the session OR the parent on the agreement
    if (user.providerId !== agreement.providerId && user.id !== agreement.parentUserId) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const result = await syncAgreementStatus(req.params.id as string);
    res.json(result);
  } catch (e: any) {
    console.error("[Agreement sync]", e.message);
    res.status(500).json({ message: e.message });
  }
});

// Download signed agreement PDF from PandaDoc
chatRouter.get("/api/agreements/:id/download", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    const agreement = await prisma.agreement.findUnique({
      where: { id: req.params.id as string },
      select: { providerId: true, parentUserId: true, pandaDocDocumentId: true, status: true },
    });
    if (!agreement) return res.status(404).json({ message: "Agreement not found" });
    const isAdmin = isAdminOrConcierge(user);
    if (!isAdmin && user.providerId !== agreement.providerId && user.id !== agreement.parentUserId) {
      return res.status(403).json({ message: "Forbidden" });
    }
    if (!agreement.pandaDocDocumentId) return res.status(400).json({ message: "No PandaDoc document linked" });

    const apiKey = process.env.PANDADOC_API_KEY;
    if (!apiKey) return res.status(500).json({ message: "PandaDoc not configured" });

    const pdRes = await fetch(
      `https://api.pandadoc.com/public/v1/documents/${agreement.pandaDocDocumentId}/download`,
      { headers: { "Authorization": `API-Key ${apiKey}` } }
    );
    if (!pdRes.ok) {
      const err = await pdRes.text();
      console.error("[Agreement download] PandaDoc error:", err);
      return res.status(502).json({ message: "Failed to download from PandaDoc" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="agreement-${agreement.pandaDocDocumentId}.pdf"`);
    const buffer = Buffer.from(await pdRes.arrayBuffer());
    res.send(buffer);
  } catch (e: any) {
    console.error("[Agreement download]", e.message);
    res.status(500).json({ message: e.message });
  }
});

// Parent confirms readiness to move forward (clicks "Yes, I'm Ready" in chat)
// Notifies GoStork admin to prepare the invoice, or auto-creates if cost sheet exists
chatRouter.post("/api/billing/parent-confirm-ready", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    const { sessionId } = req.body;

    if (!sessionId) return res.status(400).json({ message: "sessionId is required" });

    const session = await prisma.aiChatSession.findUnique({ where: { id: sessionId } });

    if (!session) return res.status(404).json({ message: "Session not found" });
    // Auth: must be the session owner or a member of the same parent account
    if (session.userId !== user.id) {
      const [sessionOwner, requestUser] = await Promise.all([
        prisma.user.findUnique({ where: { id: session.userId }, select: { parentAccountId: true } }),
        prisma.user.findUnique({ where: { id: user.id }, select: { parentAccountId: true } }),
      ]);
      if (!sessionOwner?.parentAccountId || sessionOwner.parentAccountId !== requestUser?.parentAccountId) {
        return res.status(403).json({ message: "Not authorized" });
      }
    }

    // Check if invoice already exists for this session
    const existing = await prisma.invoice.findFirst({
      where: { sessionId: session.id, status: { notIn: ["EXPIRED", "CANCELLED"] } },
    });
    if (existing) {
      return res.json({ message: "Payment already in progress", invoiceId: existing.id, paymentToken: existing.paymentToken });
    }

    // Get provider name + type from the readiness_prompt card's uiCardData.
    // The readiness prompt lives in the parent's PRIVATE session which has no provider linked,
    // so session.provider is always null here - we must read from the card data.
    const readinessMsg = await prisma.aiChatMessage.findFirst({
      where: { sessionId: session.id, uiCardType: "readiness_prompt" },
      orderBy: { createdAt: "desc" },
    });
    const cardData = readinessMsg?.uiCardData as any;
    const providerName = cardData?.providerName || "the provider";
    const providerTypeName = cardData?.providerType || "";

    const admins = await prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" } },
      select: { id: true, email: true },
    });
    const parentName = user.name || user.email;
    const notifMessage = `${parentName} is ready to move forward with ${providerName}. Create an invoice in the billing dashboard.`;
    const billingUrl = `/admin/billing`;

    // --- Admin notification (SSE + email) ---
    // Dedup: only notify admins once per session (24h window) so repeat clicks don't spam.
    const alreadyNotified = await prisma.inAppNotification.findFirst({
      where: {
        eventType: "PARENT_READY_TO_PROCEED",
        payload: { path: ["sessionId"], equals: session.id },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });

    if (!alreadyNotified) {
      // Live SSE push to connected admins; offline admins get it on next connect
      try {
        const { getNestApp } = await import("./nest-app-ref");
        const nestApp = getNestApp();
        if (nestApp) {
          const { AppEventsService } = await import("./src/modules/notifications/app-events.service");
          let appEvents: any = null;
          try { appEvents = nestApp.get(AppEventsService); } catch {}
          if (appEvents) {
            await appEvents.emit({
              type: "parent_ready_to_proceed",
              payload: { sessionId: session.id, parentUserId: user.id, parentName, providerName, providerType: providerTypeName, message: notifMessage, billingUrl },
              targetUserIds: admins.map((a: any) => a.id),
            });
            console.log(`[parent-confirm-ready] SSE emitted to ${admins.length} admin(s) for session ${session.id}`);
          } else {
            console.warn("[parent-confirm-ready] AppEventsService not available - SSE not sent");
          }
        }
      } catch (sseErr: any) {
        console.error("[parent-confirm-ready] SSE emit failed:", sseErr.message);
      }

      // Email all admins
      try {
        const { getNestApp } = await import("./nest-app-ref");
        const nestApp = getNestApp();
        if (nestApp) {
          const { NotificationService } = await import("./src/modules/notifications/notification.service");
          let notifService: any = null;
          try { notifService = nestApp.get(NotificationService); } catch {}
          if (notifService) {
            const appBase = getAppBaseUrl();
            for (const admin of admins) {
              if (!admin.email) continue;
              notifService.sendParentReadyAdminNotification({
                adminUserId: admin.id,
                adminEmail: admin.email,
                parentName,
                providerName,
                providerType: providerTypeName,
                billingUrl: `${appBase}${billingUrl}`,
              }).catch((e: any) => console.error("[parent-confirm-ready] Admin email failed:", e.message));
            }
            console.log(`[parent-confirm-ready] Admin emails dispatched for session ${session.id}`);
          } else {
            console.warn("[parent-confirm-ready] NotificationService not available - email not sent");
          }
        }
      } catch (emailErr: any) {
        console.error("[parent-confirm-ready] Admin email setup failed:", emailErr.message);
      }
    } else {
      console.log(`[parent-confirm-ready] Admin already notified for session ${session.id} - skipping duplicate notification`);
    }

    // --- Auto-trigger invoice on the matching provider session ---
    // Resolve the provider session (this readiness prompt lives in the parent's *private*
    // session, but invoices live on the provider session for the (parent, provider) pair).
    let providerSessionId: string | null = null;
    try {
      const booking = cardData?.bookingId
        ? await prisma.booking.findUnique({
            where: { id: cardData.bookingId as string },
            include: { providerUser: { select: { providerId: true } } },
          })
        : null;
      const providerId = booking?.providerUser?.providerId || null;
      if (providerId) {
        const providerSession = await prisma.aiChatSession.findFirst({
          where: {
            userId: user.id,
            providerId,
            status: { in: ["PROVIDER_CONNECTED", "CONSULTATION_BOOKED"] },
          },
          orderBy: { updatedAt: "desc" },
          select: { id: true },
        });
        providerSessionId = providerSession?.id || null;
      }
    } catch (resolveErr: any) {
      console.error("[parent-confirm-ready] provider session resolve failed:", resolveErr.message);
    }

    if (providerSessionId) {
      try {
        const { getNestApp } = await import("./nest-app-ref");
        const nestApp = getNestApp();
        if (nestApp) {
          const { BillingService } = await import("./src/modules/billing/billing.service");
          const billing = nestApp.get(BillingService);

          // Phase 3: when the provider has invoice auto-draft enabled, post a
          // provider approval card instead of creating the invoice directly.
          // Phase 4: MATCH CALLS need BOTH sides to say yes - the parent's
          // yes alone never fires the invoice. tryFinalizeMatch evaluates the
          // agency's answer too and only then sends the 24h deposit invoice.
          // "legacy" = gates off -> original direct path. skipped/blocked
          // results share the direct path's shapes for the handling below.
          let result: Awaited<ReturnType<typeof billing.createInvoiceFromReadiness>> | null = null;
          if (cardData?.isMatchCall === true && cardData?.bookingId) {
            void emitJourneyEvent({ eventType: "MATCH_ACCEPTED_BY_PARENT", parentUserId: session.userId, sessionId: providerSessionId, bookingId: cardData.bookingId, actorRole: "parent" });
            const matchRes = await billing.tryFinalizeMatch(cardData.bookingId);
            if (matchRes.status === "finalized") {
              console.log(`[parent-confirm-ready] Match finalized - invoice ${matchRes.invoiceId} sent (booking ${cardData.bookingId})`);
            } else if (matchRes.status === "waiting") {
              console.log(`[parent-confirm-ready] Match waiting on ${matchRes.waitingOn} (booking ${cardData.bookingId})`);
              // Reassure the parent, nudge the agency to answer its question.
              await prisma.aiChatMessage.create({
                data: {
                  sessionId: session.id,
                  role: "assistant",
                  content: `Wonderful! I've let ${providerName} know you're ready. As soon as they confirm on the surrogate's side, your secure payment link will arrive right here - and the hold stays yours in the meantime.`,
                  senderType: "system",
                  senderName: "GoStork",
                },
              }).catch(() => {});
              await prisma.aiChatMessage.create({
                data: {
                  sessionId: providerSessionId,
                  role: "assistant",
                  content: `${parentName} just confirmed they're ready to move forward! We're waiting on your side - answer the match question above and the deposit invoice goes out automatically.`,
                  senderType: "system",
                  senderName: "GoStork",
                  uiCardType: "provider_only",
                },
              }).catch(() => {});
            } else if (matchRes.status === "skipped" && matchRes.reason === "NOT_A_MATCH_CALL") {
              // No provider readiness card exists (pre-Phase-4 booking) - old direct path.
              result = await billing.createInvoiceFromReadiness(providerSessionId);
            } else if (matchRes.status === "skipped") {
              console.log(`[parent-confirm-ready] Match finalize skipped: ${matchRes.reason}`);
            } else {
              result = matchRes as any;
            }
          } else {
            const draftRes = await billing.tryDraftInvoiceForReadiness(
              providerSessionId,
              parentName,
              { isMatchCall: cardData?.isMatchCall === true },
            );
            if (draftRes.status === "legacy") {
              result = await billing.createInvoiceFromReadiness(providerSessionId);
            } else if (draftRes.status === "drafted") {
              console.log(`[parent-confirm-ready] Invoice draft ${draftRes.messageId} posted for provider approval (session ${providerSessionId})`);
            } else if (draftRes.status === "skipped") {
              console.log(`[parent-confirm-ready] Invoice draft skipped: ${draftRes.reason}`);
            } else {
              result = draftRes as any;
            }
          }

          if (result === null) {
            // drafted or draft-skipped - nothing more to do here
          } else if (result.status === "created") {
            await billing.sendPaymentNotificationsToParent(result.invoice.id);
            console.log(`[parent-confirm-ready] Invoice ${result.invoice.id} auto-created for session ${providerSessionId}`);
          } else if (result.status === "skipped") {
            console.log(`[parent-confirm-ready] Auto-trigger skipped: ${result.reason}`);
          } else if (result.reason === "BILLING_IDENTITY_INCOMPLETE") {
            // Provider hasn't completed Billing Identity (Legal Name / Tax ID / W-9).
            // Nudge the provider to complete it - a cost sheet won't unblock this.
            console.warn(`[parent-confirm-ready] Auto-trigger blocked: ${result.reason} - ${result.message}`);
            try {
              const providerSession = await prisma.aiChatSession.findUnique({
                where: { id: providerSessionId },
                include: { provider: { include: { users: { select: { id: true } } } } },
              });
              await prisma.aiChatMessage.create({
                data: {
                  sessionId: providerSessionId,
                  role: "assistant",
                  content: `${parentName} just confirmed they're ready to proceed, but we can't issue their invoice yet. ${result.message}`,
                  senderType: "system",
                  senderName: "GoStork",
                },
              });
              for (const u of providerSession?.provider?.users || []) {
                await prisma.inAppNotification.create({
                  data: {
                    userId: u.id,
                    eventType: "BILLING_IDENTITY_INCOMPLETE",
                    payload: { providerId: providerSession?.provider?.id ?? null, message: result.message },
                  },
                }).catch(() => {});
              }
            } catch (nudgeErr: any) {
              console.error("[parent-confirm-ready] billing-identity nudge failed:", nudgeErr.message);
            }
          } else {
            // Blocked - record the reminder, nudge the provider via chat, email, and SMS.
            console.warn(`[parent-confirm-ready] Auto-trigger blocked: ${result.reason} - ${result.message}`);

            const reminderExists = await prisma.costSheetReminder.findFirst({
              where: { sessionId: providerSessionId, bookingId: null, window: "POST_READINESS_BLOCKED" },
            });
            if (!reminderExists) {
              await prisma.costSheetReminder.create({
                data: { sessionId: providerSessionId, window: "POST_READINESS_BLOCKED" },
              });

              // System chat message in the provider session prompting them to act.
              await prisma.aiChatMessage.create({
                data: {
                  sessionId: providerSessionId,
                  role: "assistant",
                  content: `${parentName} just confirmed they're ready to proceed. Please send a cost sheet so we can issue their invoice.`,
                  senderType: "system",
                  senderName: "GoStork",
                },
              });

              // Email + SMS to all members of this provider.
              try {
                const providerSession = await prisma.aiChatSession.findUnique({
                  where: { id: providerSessionId },
                  include: { provider: { include: { users: { select: { id: true } } } } },
                });
                const providerUserIds = (providerSession?.provider?.users || []).map(u => u.id);
                if (providerUserIds.length && providerSession?.provider) {
                  const { NotificationService } = await import("./src/modules/notifications/notification.service");
                  const notifService = nestApp.get(NotificationService);
                  await notifService.sendCostSheetMissingToProvider({
                    providerUserIds,
                    providerName: providerSession.provider.name,
                    parentName,
                    sessionId: providerSessionId,
                    providerId: providerSession.provider.id,
                    parentUserId: providerSession.userId,
                    reason: "post_readiness",
                  });
                }
              } catch (notifErr: any) {
                console.error("[parent-confirm-ready] cost-sheet-missing notification failed:", notifErr.message);
              }
            }
          }
        }
      } catch (autoErr: any) {
        console.error("[parent-confirm-ready] auto-invoice path failed:", autoErr.message);
      }
    } else {
      console.warn(`[parent-confirm-ready] No provider session resolved for session ${session.id} - invoice not auto-created`);
    }

    // --- "Thank you" chat message (one per session, no time limit) ---
    // Match calls get their own status message from the both-sides gate above
    // ("waiting for the agency" / invoice announce) - the generic "preparing
    // your invoice" line would contradict it.
    if (cardData?.isMatchCall !== true) {
      const existingConfirm = await prisma.aiChatMessage.findFirst({
        where: { sessionId: session.id, senderName: "GoStork", content: { contains: "Thank you for letting us know" } },
      });
      if (!existingConfirm) {
        await prisma.aiChatMessage.create({
          data: {
            sessionId: session.id,
            role: "assistant",
            content: `Thank you for letting us know! We're preparing your payment invoice now. Our team will send it to you shortly.`,
            senderType: "system",
            senderName: "GoStork",
          },
        });
      }
    }

    res.json({ success: true, message: "Confirmed. GoStork will send your invoice shortly." });
  } catch (e: any) {
    console.error("[parent-confirm-ready]", e.message);
    res.status(500).json({ message: e.message });
  }
});

// Mark a readiness_prompt message as answered so the card shows disabled on reload
chatRouter.patch("/api/billing/readiness-prompt-respond", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    const { messageId, answer } = req.body; // answer: "yes" | "no" | "later"
    if (!messageId || !["yes", "no", "later"].includes(answer)) {
      return res.status(400).json({ message: "messageId and answer (yes|no|later) required" });
    }
    const msg = await prisma.aiChatMessage.findUnique({
      where: { id: messageId },
      select: { id: true, sessionId: true, uiCardType: true, uiCardData: true },
    });
    if (!msg || msg.uiCardType !== "readiness_prompt") {
      return res.status(404).json({ message: "Readiness prompt message not found" });
    }
    // Verify the user owns this session
    const session = await prisma.aiChatSession.findUnique({
      where: { id: msg.sessionId },
      select: { userId: true },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });
    const sessionOwner = await prisma.user.findUnique({ where: { id: session.userId }, select: { parentAccountId: true } });
    const requestUser = await prisma.user.findUnique({ where: { id: user.id }, select: { parentAccountId: true } });
    const isOwner = session.userId === user.id ||
      (sessionOwner?.parentAccountId && requestUser?.parentAccountId && sessionOwner.parentAccountId === requestUser.parentAccountId);
    if (!isOwner) return res.status(403).json({ message: "Not authorized" });

    const cardData = (msg.uiCardData as any) || {};
    const extra: Record<string, unknown> = {};
    if (answer === "later") {
      // Phase 3: "Need more time" schedules a single 12h re-ask (swept by the
      // readiness-reminder pass in the pending-booking scheduler).
      extra.remindAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      extra.reminderSentAt = null;
    }
    await prisma.aiChatMessage.update({
      where: { id: messageId },
      data: { uiCardData: { ...cardData, answered: answer, ...extra } },
    });

    const providerName = cardData.providerName || "the provider";
    if (answer === "later") {
      await prisma.aiChatMessage.create({
        data: {
          sessionId: msg.sessionId,
          role: "assistant",
          content: `No problem - take the time you need. I'll check back in about 12 hours. If anything comes up before then, just ask me here.`,
          senderType: "system",
          senderName: "GoStork",
        },
      }).catch(() => {});
    } else if (answer === "no") {
      // Phase 3: Eva asks what the blocker is (the parent's reply flows
      // through the normal AI routing), and the provider gets a heads-up
      // note in their session so they can help.
      await prisma.aiChatMessage.create({
        data: {
          sessionId: msg.sessionId,
          role: "assistant",
          content: `Totally understandable - this is a big decision. Can I ask what's holding you back? I'll make sure ${providerName} addresses it, or I can help you compare other options.`,
          senderType: "system",
          senderName: "GoStork",
        },
      }).catch(() => {});
      try {
        const booking = cardData.bookingId
          ? await prisma.booking.findUnique({
              where: { id: cardData.bookingId as string },
              include: { providerUser: { select: { providerId: true } } },
            })
          : null;
        const providerId = booking?.providerUser?.providerId || null;
        if (providerId) {
          const providerSession = await prisma.aiChatSession.findFirst({
            where: { userId: session.userId, providerId, status: { in: ["PROVIDER_CONNECTED", "CONSULTATION_BOOKED"] } },
            orderBy: { updatedAt: "desc" },
            select: { id: true, user: { select: { firstName: true, name: true } } },
          });
          if (providerSession) {
            const parentLabel = providerSession.user?.firstName || providerSession.user?.name || "The parent";
            await prisma.aiChatMessage.create({
              data: {
                sessionId: providerSession.id,
                role: "assistant",
                content: `${parentLabel} said they're not ready to move forward yet after the call. Eva is asking what's holding them back and will relay it here.`,
                senderType: "system",
                senderName: "GoStork",
                uiCardType: "provider_only",
              },
            });
          }
        }
      } catch (relayErr: any) {
        console.error("[readiness-prompt-respond] provider relay failed:", relayErr.message);
      }
    }

    res.json({ success: true });
  } catch (e: any) {
    console.error("[readiness-prompt-respond]", e.message);
    res.status(500).json({ message: e.message });
  }
});

// Handle PandaDoc webhook events for provider W-9 documents.
// Returns true if the document was a recognized W-9 (so the caller stops looking).
async function handleW9Webhook(eventType: string, documentId: string, event: any): Promise<boolean> {
  const w9 = await prisma.providerW9.findUnique({
    where: { pandaDocDocumentId: documentId },
    include: { provider: { select: { id: true, name: true } } },
  });
  if (!w9) return false;

  const isCompleted = eventType === "document_state_changed" && event?.data?.status === "document.completed";
  if (!isCompleted) return true; // recognized W-9 event, nothing to do for this state
  if (w9.status === "COMPLETED") return true; // idempotent

  await prisma.providerW9.update({
    where: { id: w9.id },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  console.log(`[W-9 webhook] Provider ${w9.providerId} W-9 completed`);

  // Pull W-9 field values into ProviderLegalIdentity so legalName, taxId,
  // tax classification, and business address auto-fill (only into empty
  // fields - manual edits win). Best-effort: a failure here doesn't
  // affect the W-9 completion itself.
  try {
    const { getNestApp } = await import("./nest-app-ref");
    const nestApp = getNestApp();
    if (nestApp) {
      const { LegalIdentityService } = await import("./src/modules/billing/legal-identity.service");
      const legalIdentityService = nestApp.get(LegalIdentityService);
      const result = await legalIdentityService.syncFromW9(w9.providerId);
      console.log(
        `[W-9 webhook] Legal Identity sync for provider ${w9.providerId}: ${result.status}` +
          ("appliedFields" in result ? ` (${result.appliedFields.length} fields)` : "") +
          ("reason" in result ? ` - ${result.reason}` : ""),
      );
    }
  } catch (err: any) {
    console.error(`[W-9 webhook] Legal Identity sync failed: ${err?.message}`);
  }

  try {
    const admins = await prisma.user.findMany({ where: { roles: { has: "GOSTORK_ADMIN" } }, select: { id: true, email: true, name: true } });
    const { getNestApp } = await import("./nest-app-ref");
    const nestApp = getNestApp();
    if (nestApp) {
      const { NotificationService } = await import("./src/modules/notifications/notification.service");
      const notifService = nestApp.get(NotificationService);
      for (const admin of admins) {
        if (!admin.email) continue;
        await notifService.sendW9CompletedNotification({
          adminUserId: admin.id,
          adminEmail: admin.email,
          adminName: admin.name,
          providerName: w9.provider?.name || "Provider",
          providerId: w9.providerId,
        });
      }
    }
    for (const admin of admins) {
      await prisma.inAppNotification.create({
        data: {
          userId: admin.id,
          eventType: "W9_COMPLETED",
          payload: { providerId: w9.providerId, message: `${w9.provider?.name || "A provider"} has completed their W-9` },
        },
      }).catch(() => {});
    }
  } catch (err: any) {
    console.error(`[W-9 webhook] Notification failed: ${err.message}`);
  }
  return true;
}

chatRouter.post("/api/webhooks/pandadoc", async (req, res) => {
  // Always respond 200 first - PandaDoc disables webhooks after repeated non-200 responses
  res.json({ received: true });

  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];

    for (const event of events) {
      const eventType = event?.event;
      const documentId = event?.data?.id;
      if (!documentId) continue;

      console.log(`[PandaDoc webhook] Event: ${eventType}, documentId: ${documentId}`);

      const agreement = await prisma.agreement.findUnique({
        where: { pandaDocDocumentId: documentId },
        include: {
          provider: { select: { id: true, name: true, email: true } },
          parentUser: { select: { id: true, name: true, firstName: true, lastName: true, email: true } },
        },
      }) as any;
      if (!agreement) {
        // Not an agreement - it may be a provider W-9 document.
        const handledW9 = await handleW9Webhook(eventType, documentId, event);
        if (!handledW9) console.log(`[PandaDoc webhook] No agreement or W-9 found for documentId: ${documentId}`);
        continue;
      }

      // When a recipient completes signing, notify the next unnotified signer in order
      if (eventType === "recipient_completed") {
        const completedEmails: Set<string> = new Set(
          ((event?.data?.recipients ?? []) as any[])
            .filter((r: any) => r.has_completed === true)
            .map((r: any) => r.email as string)
        );
        console.log(`[PandaDoc webhook] recipient_completed - completed emails: ${[...completedEmails].join(", ")}`);

        // Re-fetch signerOrder fresh to avoid using stale data from the top-of-handler load
        const freshAgreement = await (prisma.agreement as any).findUnique({
          where: { id: agreement.id },
          select: { signerOrder: true },
        });
        const signerOrder: Array<{ email: string; name: string; userId: string | null; guestToken: string | null; signingOrder: number; notified: boolean; signed?: boolean }> =
          (freshAgreement?.signerOrder as any[]) ?? [];

        console.log(`[PandaDoc webhook] signerOrder contents: ${JSON.stringify(signerOrder.map(s => ({ email: s.email, notified: s.notified, signingOrder: s.signingOrder })))}`);
        if (signerOrder.length > 0) {
          const nextSigner = signerOrder.find(s => !s.notified);
          if (!nextSigner) {
            console.log(`[PandaDoc webhook] All signers already notified - skipping`);
          } else if (nextSigner && completedEmails.size > 0) {
            const signersBeforeNext = signerOrder.filter(s => s.signingOrder < nextSigner.signingOrder);
            const allPreviousDone = signersBeforeNext.every(s => completedEmails.has(s.email));
            if (allPreviousDone) {
              console.log(`[PandaDoc webhook] Notifying next signer: ${nextSigner.email}`);
              try {
                // Atomically mark as notified BEFORE sending email to prevent duplicate sends
                // if PandaDoc retries the webhook. The WHERE condition ensures only one event wins.
                const updatedOrder = signerOrder.map(s =>
                  s.email === nextSigner.email ? { ...s, notified: true } : s
                );
                const affected = await prisma.$executeRaw`
                  UPDATE "Agreement"
                  SET "signerOrder" = ${JSON.stringify(updatedOrder)}::jsonb
                  WHERE id = ${agreement.id}
                  AND "signerOrder" @> ${JSON.stringify([{ email: nextSigner.email, notified: false }])}::jsonb
                `;
                // Use == not === because Prisma v7 $executeRaw returns BigInt (0n == 0 is true, 0n === 0 is false)
                if (affected == 0) {
                  console.log(`[PandaDoc webhook] Duplicate event - ${nextSigner.email} already notified, skipping`);
                  continue;
                }

                const { getNestApp } = await import("./nest-app-ref");
                const nestApp = getNestApp();
                if (nestApp) {
                  const { NotificationService } = await import("./src/modules/notifications/notification.service");
                  const notifService = nestApp.get(NotificationService);
                  const providerRecord = await prisma.provider.findUnique({
                    where: { id: agreement.providerId },
                    select: { name: true },
                  });
                  const providerName = providerRecord?.name || "Your Agency";
                  // CRITICAL: use the agreement's stored originAppUrl, NOT
                  // this server's getAppBaseUrl(). PandaDoc broadcasts the
                  // recipient_completed event to every webhook subscription
                  // (local ngrok + Replit + prod, all enabled at once), so
                  // whichever server wins the idempotency race might not be
                  // the one the agency generated from. The stored URL keeps
                  // the link pointing back where the parents are signing.
                  // Fall back to this server's base URL only for legacy
                  // agreements created before the originAppUrl column.
                  const appBase = (agreement as any).originAppUrl || getAppBaseUrl();
                  const goStorkSigningUrl = `${appBase}/agreements/${agreement.id}`;
                  const emailSigningUrl = nextSigner.userId
                    ? goStorkSigningUrl
                    : nextSigner.guestToken ? `${appBase}/agreements/guest/${nextSigner.guestToken}` : null;

                  let phone: string | null = null;
                  if (nextSigner.userId) {
                    const u = await prisma.user.findUnique({ where: { id: nextSigner.userId }, select: { mobileNumber: true } });
                    phone = u?.mobileNumber ?? null;
                  }

                  console.log(`[Agreement notify] webhook recipient_completed -> sending to ${nextSigner.email}, isGoStorkMember: ${!!nextSigner.userId && !nextSigner.guestToken}`);
                  await notifService.sendAgreementReadyNotification({
                    parentUserId: nextSigner.userId || agreement.parentUserId,
                    parentName: nextSigner.name || nextSigner.email,
                    parentEmail: nextSigner.email,
                    parentPhone: phone,
                    providerName,
                    providerId: agreement.providerId,
                    signingUrl: emailSigningUrl,
                    sessionId: agreement.sessionId,
                    isGoStorkMember: !!nextSigner.userId && !nextSigner.guestToken,
                  });
                  console.log(`[PandaDoc webhook] Notified next signer ${nextSigner.email}`);
                }
              } catch (notifErr: any) {
                console.error(`[PandaDoc webhook] Failed to notify next signer: ${notifErr.message}`);
              }
            }
          }
        }

        // Post a chat message for each signer who just completed (idempotent via signed flag)
        // Also update signerStatus so the provider sidebar reflects the signing immediately.
        if (agreement.sessionId && completedEmails.size > 0) {
          // Re-fetch latest signerOrder and signerStatus together
          const latestAgreement = await (prisma.agreement as any).findUnique({
            where: { id: agreement.id },
            select: { signerOrder: true, signerStatus: true, status: true },
          });
          const latestOrder: Array<{ email: string; name: string; signingOrder: number; signed?: boolean }> =
            (latestAgreement?.signerOrder as any[]) ?? [];

          for (const signer of latestOrder) {
            if (!completedEmails.has(signer.email) || signer.signed === true) continue;

            // Atomically mark as signed - skip if already marked (idempotency)
            const markedOrder = latestOrder.map(s =>
              s.email === signer.email ? { ...s, signed: true } : s
            );
            const rows = await prisma.$executeRaw`
              UPDATE "Agreement"
              SET "signerOrder" = ${JSON.stringify(markedOrder)}::jsonb
              WHERE id = ${agreement.id}
              AND NOT "signerOrder" @> ${JSON.stringify([{ email: signer.email, signed: true }])}::jsonb
            `;
            if (rows == 0) continue; // duplicate event

            await prisma.aiChatMessage.create({
              data: {
                sessionId: agreement.sessionId,
                role: "assistant",
                content: `${signer.name || signer.email} has signed the agreement.`,
                senderType: "system",
                senderName: await resolveSessionSenderName(agreement.sessionId),
                uiCardType: "signer_signed",
                uiCardData: { signerName: signer.name || signer.email, agreementId: agreement.id },
              },
            });
            console.log(`[PandaDoc webhook] Posted "signed" chat message for ${signer.email}`);
          }

          // Update signerStatus to mark completed signers - this makes the sidebar reflect signing immediately
          if (latestAgreement?.status !== "SIGNED") {
            const existingStatus: Record<string, any> = (latestAgreement?.signerStatus as Record<string, any>) ?? {};
            const updatedStatus = { ...existingStatus };
            let statusChanged = false;
            for (const email of completedEmails) {
              const prev = existingStatus[email] ?? {};
              if (!prev.completed) {
                updatedStatus[email] = {
                  ...prev,
                  completed: true,
                  completedAt: prev.completedAt ?? new Date().toISOString(),
                };
                statusChanged = true;
              }
            }
            if (statusChanged) {
              await prisma.agreement.update({
                where: { id: agreement.id },
                data: { signerStatus: updatedStatus },
              });
              console.log(`[PandaDoc webhook] Updated signerStatus for completed signers: ${[...completedEmails].join(", ")}`);
            }
          }
        }
      }

      // Build per-signer status from recipients array (present on most event payloads)
      if (eventType === "document_state_changed") {
        const newState = event?.data?.status;
        console.log(`[PandaDoc webhook] State change: ${newState} for agreement ${agreement.id}`);

        if (newState === "document.completed") {
          if (agreement.status === "SIGNED") {
            console.log(`[PandaDoc webhook] Agreement ${agreement.id} already SIGNED - skipping duplicate`);
            continue;
          }

          await prisma.agreement.update({
            where: { id: agreement.id },
            data: { status: "SIGNED", signedAt: new Date() },
          });

          const parentName = agreement.parentUser.name ||
            `${agreement.parentUser.firstName || ""} ${agreement.parentUser.lastName || ""}`.trim() ||
            agreement.parentUser.email;

          // In-app notification to provider
          const providerUser = (agreement as any).generatedByUserId
            ? await prisma.user.findUnique({
                where: { id: (agreement as any).generatedByUserId },
                select: { id: true, email: true, name: true },
              })
            : await prisma.user.findFirst({
                where: { providerId: agreement.providerId },
                select: { id: true, email: true, name: true },
              });
          if (!providerUser) {
            console.warn(`[PandaDoc webhook] No provider user found for agreement ${agreement.id}`);
          }
          if (providerUser) {
            await prisma.inAppNotification.create({
              data: {
                userId: providerUser.id,
                eventType: "AGREEMENT_SIGNED",
                payload: { agreementId: agreement.id, message: `${parentName} has signed the agreement` },
              },
            }).catch(e => console.error("[PandaDoc webhook] inAppNotification failed:", e));
          }

          // Send completion email to provider
          try {
            const { getNestApp } = await import("./nest-app-ref");
            const nestApp = getNestApp();
            if (nestApp && providerUser?.email) {
              const { NotificationService } = await import("./src/modules/notifications/notification.service");
              const notifService = nestApp.get(NotificationService);
              const providerName = agreement.provider.name || "Your Agency";
              await notifService.sendAgreementSignedNotification({
                recipientUserId: providerUser.id,
                recipientEmail: providerUser.email,
                recipientName: providerUser.name || providerName,
                recipientRole: "provider",
                providerName,
                parentName,
                providerId: agreement.providerId,
                sessionId: agreement.sessionId,
                agreementId: agreement.id,
              });
              console.log(`[PandaDoc webhook] Completion email sent to provider: ${providerUser.email}`);
            }
          } catch (emailErr: any) {
            console.error(`[PandaDoc webhook] Failed to send completion email: ${emailErr.message}`);
          }

          // Post "all sides signed" chat message with a link to view/download the signed agreement.
          // First flush any remaining "[Name] has signed" messages for signers not yet announced,
          // so individual messages always appear before the "all sides" summary.
          if (agreement.sessionId) {
            const finalAgreement = await (prisma.agreement as any).findUnique({
              where: { id: agreement.id },
              select: { signerOrder: true },
            });
            const finalOrder: Array<{ email: string; name: string; signed?: boolean }> =
              (finalAgreement?.signerOrder as any[]) ?? [];

            for (const signer of finalOrder) {
              if (signer.signed === true) continue;
              const markedOrder = finalOrder.map(s =>
                s.email === signer.email ? { ...s, signed: true } : s
              );
              const rows = await prisma.$executeRaw`
                UPDATE "Agreement"
                SET "signerOrder" = ${JSON.stringify(markedOrder)}::jsonb
                WHERE id = ${agreement.id}
                AND NOT "signerOrder" @> ${JSON.stringify([{ email: signer.email, signed: true }])}::jsonb
              `;
              if (rows == 0) continue; // already posted by recipient_completed
              await prisma.aiChatMessage.create({
                data: {
                  sessionId: agreement.sessionId,
                  role: "assistant",
                  content: `${signer.name || signer.email} has signed the agreement.`,
                  senderType: "system",
                  senderName: await resolveSessionSenderName(agreement.sessionId),
                  uiCardType: "signer_signed",
                  uiCardData: { signerName: signer.name || signer.email, agreementId: agreement.id },
                },
              });
            }

            await prisma.aiChatMessage.create({
              data: {
                sessionId: agreement.sessionId,
                role: "assistant",
                content: "All sides have signed the agreement. It is now ready to view and download.",
                senderType: "system",
                senderName: await resolveSessionSenderName(agreement.sessionId),
                uiCardType: "agreement_signed",
                // Balloons float up the screen for the signing milestone.
                uiCardData: { agreementId: agreement.id, celebration: "agreement_signed" },
              },
            }).catch(e => console.error("[PandaDoc webhook] Failed to post all-signed chat message:", e));
            void emitJourneyEvent({ eventType: "AGREEMENT_SIGNED", parentUserId: agreement.parentUserId, providerId: agreement.providerId, sessionId: agreement.sessionId, metadata: { agreementId: agreement.id, documentType: agreement.documentType } });

            // Stage 13: fully signed + paid invoice -> journey handoff
            try {
              const { maybeCompleteHandoff } = await import("./agreement-flow");
              await maybeCompleteHandoff(agreement.sessionId);
            } catch (handoffErr: any) {
              console.error("[PandaDoc webhook] Handoff check failed:", handoffErr?.message);
            }
          }

        } else if (newState === "document.viewed") {
          // Phase 7C: first view only - PandaDoc re-fires on every open.
          try {
            const prior = await prisma.journeyEvent.findFirst({
              where: { eventType: "AGREEMENT_VIEWED", metadata: { path: ["agreementId"], equals: agreement.id } },
              select: { id: true },
            });
            if (!prior) {
              void emitJourneyEvent({ eventType: "AGREEMENT_VIEWED", parentUserId: agreement.parentUserId, providerId: agreement.providerId, sessionId: agreement.sessionId, actorRole: "parent", metadata: { agreementId: agreement.id } });
            }
          } catch { /* best-effort */ }
        } else if (newState === "document.rejected") {
          await prisma.agreement.update({
            where: { id: agreement.id },
            data: { status: "REJECTED", rejectedAt: new Date() },
          });
        } else if (newState === "document.expired") {
          await prisma.agreement.update({
            where: { id: agreement.id },
            data: { status: "EXPIRED" },
          });
        }
      }
    }
  } catch (e: any) {
    console.error("[PandaDoc webhook] Error:", e.message);
  }
});

