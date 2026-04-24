import { Router, Request, Response } from "express";
import multer from "multer";
import { prisma } from "./db";
import { generateAgreement, syncTemplateToPandaDoc, createTemplateEditingSession, generateAgreementFromTemplate, getAgreementSigningSession, refreshTemplateRoles, syncAgreementStatus } from "./pandadoc-service";
import { StorageService } from "./src/modules/storage/storage.service";
import { isUserOnline, getOnlineUserIds } from "./online-tracker";

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

const PROVIDER_ROLES = ["PROVIDER_ADMIN", "SURROGACY_COORDINATOR", "EGG_DONOR_COORDINATOR", "SPERM_DONOR_COORDINATOR", "IVF_CLINIC_COORDINATOR", "DOCTOR", "BILLING_MANAGER"];

function getUserRoles(user: any): string[] {
  return user.roles || [];
}
function isAdminUser(user: any): boolean {
  return getUserRoles(user).includes("GOSTORK_ADMIN");
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

function getAppBaseUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "development") {
    const port = process.env.PORT || 5001;
    return `http://localhost:${port}`;
  }
  return "https://app.gostork.com";
}

export const chatRouter = Router();

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
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
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
        const photo = (p.photos && p.photos.length > 0) ? p.photos[0] : p.photoUrl;
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
        const photo = (p.photos && p.photos.length > 0) ? p.photos[0] : p.photoUrl;
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
    const isAdmin = (user.roles || []).includes("GOSTORK_ADMIN");
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
  if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const sessions = await prisma.aiChatSession.findMany({
      where: { status: { in: ["ACTIVE", "HUMAN_JOINED", "PROVIDER_JOINED"] } },
      include: {
        user: { select: { id: true, name: true, email: true, photoUrl: true } },
        provider: { select: { id: true, name: true, logoUrl: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
        _count: { select: { messages: true } },
      },
      orderBy: [{ humanRequested: "desc" }, { updatedAt: "desc" }],
      take: 50,
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

    const result = sessions.map(s => ({
      id: s.id,
      userId: s.userId,
      userName: s.user.name,
      userEmail: s.user.email,
      userAvatar: (s.user as any).photoUrl,
      status: s.status,
      humanRequested: s.humanRequested,
      humanJoinedAt: s.humanJoinedAt,
      humanConcludedAt: (s as any).humanConcludedAt || null,
      providerId: s.providerId,
      providerName: s.provider?.name || null,
      providerLogo: s.provider?.logoUrl || null,
      providerJoinedAt: s.providerJoinedAt,
      messageCount: s._count.messages,
      lastMessage: s.messages[0]?.content?.slice(0, 120) || null,
      lastMessageAt: s.messages[0]?.createdAt || s.updatedAt,
      unreadCount: unreadMap[s.id] || 0,
      createdAt: s.createdAt,
    }));
    res.json(result);
  } catch (e: any) {
    console.error("Admin concierge sessions error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.get("/api/admin/concierge-sessions/:id", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const session = await prisma.aiChatSession.findUnique({
      where: { id: req.params.id },
      include: {
        user: {
          select: {
            id: true, name: true, email: true, photoUrl: true, city: true, state: true, mobileNumber: true, relationshipStatus: true, partnerFirstName: true, partnerAge: true, dateOfBirth: true,
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
    res.json(session);
  } catch (e: any) {
    console.error("Admin concierge session detail error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/admin/concierge-sessions/:id/join", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const session = await prisma.aiChatSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ message: "Session not found" });
    // Block re-join only if already joined AND not yet concluded (active session)
    console.log(`[join] humanJoinedAt=${session.humanJoinedAt}, humanConcludedAt=${(session as any).humanConcludedAt}, humanRequested=${session.humanRequested}`);
    if (session.humanJoinedAt && !(session as any).humanConcludedAt) return res.json({ alreadyJoined: true });

    const expertName = user.name || "GoStork Expert";
    const expertFirstName = expertName.split(" ")[0];
    // Preserve PROVIDER_JOINED status if provider is already in the chat
    const newStatus = session.status === "PROVIDER_JOINED" ? "PROVIDER_JOINED" : "HUMAN_JOINED";
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
  if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const session = await prisma.aiChatSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ message: "Session not found" });

    const expertFirstName = (user.name || "GoStork Expert").split(" ")[0];

    await prisma.aiChatSession.update({
      where: { id: session.id },
      data: {
        humanConcludedAt: new Date(),
        humanRequested: false,
        status: session.status === "PROVIDER_JOINED" ? "PROVIDER_JOINED" : "ACTIVE",
      },
    });

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

    // Notify admins (in-app + email + SMS)
    const admins = await prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" } },
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
  if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
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
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <h2 style="color:#004D4D">New Consultation Request</h2>
          <p>A prospective parent has requested a consultation callback through GoStork.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee">Name</td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(name)}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee">Email</td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(email)}</td></tr>
            ${message ? `<tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee">Message</td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(message)}</td></tr>` : ""}
          </table>
          <p style="color:#666;font-size:14px">Please reach out to this parent to schedule a consultation.</p>
        </div>
      `;
      await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sendgridKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: recipientEmail }] }],
          from: { email: fromEmail, name: "GoStork" },
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
    const sessions = await prisma.aiChatSession.findMany({
      where: {
        providerId: user.providerId,
        status: { in: ["ACTIVE", "HUMAN_JOINED", "CONSULTATION_BOOKED", "PROVIDER_JOINED"] },
        sessionType: { not: "PROVIDER_CONCIERGE" },
      },
      include: {
        user: { select: { id: true, name: true, email: true, photoUrl: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });

    const pendingCounts = await prisma.silentQuery.groupBy({
      by: ["sessionId"],
      where: { providerId: user.providerId, status: "PENDING" },
      _count: true,
    });
    const pendingBySession: Record<string, number> = {};
    for (const pc of pendingCounts) {
      pendingBySession[pc.sessionId] = pc._count;
    }

    // Count unread messages per session (messages from non-providers that provider hasn't read)
    const sessionIds = sessions.map(s => s.id);
    const unreadCounts = sessionIds.length > 0
      ? await prisma.aiChatMessage.groupBy({
          by: ["sessionId"],
          where: {
            sessionId: { in: sessionIds },
            readAt: null,
            senderType: { in: ["parent", "user"] },
          },
          _count: true,
        })
      : [];
    const unreadMap: Record<string, number> = {};
    for (const uc of unreadCounts) unreadMap[uc.sessionId] = uc._count;

    const result = sessions.map(s => {
      const isJoined = s.status === "PROVIDER_JOINED";
      const isConsultationBooked = s.status === "CONSULTATION_BOOKED";
      return {
        id: s.id,
        userId: s.userId,
        userName: isJoined || isConsultationBooked ? s.user.name : "Prospective Parent",
        userEmail: isJoined || isConsultationBooked ? s.user.email : null,
        userAvatar: isJoined || isConsultationBooked ? (s.user as any).photoUrl : null,
        status: s.status,
        sessionType: (s as any).sessionType || "PARENT",
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
      };
    });
    result.sort((a, b) => {
      if (a.status === "CONSULTATION_BOOKED" && b.status !== "CONSULTATION_BOOKED") return -1;
      if (b.status === "CONSULTATION_BOOKED" && a.status !== "CONSULTATION_BOOKED") return 1;
      if (a.pendingQuestions > 0 && b.pendingQuestions === 0) return -1;
      if (b.pendingQuestions > 0 && a.pendingQuestions === 0) return 1;
      return 0;
    });

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
        const photo = (p.photos && p.photos.length > 0) ? p.photos[0] : p.photoUrl;
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
            id: true, name: true, email: true, photoUrl: true, city: true, state: true, mobileNumber: true, relationshipStatus: true, partnerFirstName: true, partnerAge: true, dateOfBirth: true,
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

    const isJoined = session.status === "PROVIDER_JOINED";
    const isConsultationBooked = session.status === "CONSULTATION_BOOKED";
    const showIdentity = isJoined || isConsultationBooked;

    const providerMessages = session.messages.filter(m =>
      m.senderType === "system" || m.senderType === "provider"
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
      messages: isJoined ? session.messages : providerMessages,
      accountMembers: showIdentity ? accountMembers.map(m => ({ id: m.id, displayName: formatInitials(m) })) : [],
    };

    // Auto-mark non-provider messages as delivered when provider views them
    prisma.aiChatMessage.updateMany({
      where: { sessionId: session.id, senderType: { not: "provider" }, deliveredAt: null },
      data: { deliveredAt: new Date() },
    }).catch(() => {});

    res.json(responseSession);
  } catch (e: any) {
    console.error("Provider concierge session detail error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/provider/concierge-sessions/:id/join", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const session = await prisma.aiChatSession.findUnique({
      where: { id: req.params.id },
      include: { provider: { select: { name: true } } },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (session.providerId !== user.providerId) return res.status(403).json({ message: "Forbidden" });
    if (session.providerJoinedAt) return res.json({ message: "Already joined", alreadyJoined: true });
    if (session.status !== "CONSULTATION_BOOKED") {
      return res.status(400).json({ message: "Cannot join - parent has not booked a consultation yet" });
    }

    await prisma.aiChatSession.update({
      where: { id: session.id },
      data: { providerJoinedAt: new Date(), status: "PROVIDER_JOINED" },
    });

    const providerName = session.provider?.name || user.name || "Your matched provider";
    const profileCardData = (session as any).subjectProfileId && (session as any).subjectType
      ? {
          whisperMatchCard: {
            type: (session as any).subjectType,
            ownerProviderId: session.providerId,
            providerId: (session as any).subjectProfileId,
            reasons: [],
            photo: (session as any).profilePhotoUrl || undefined,
            name: session.title || undefined,
          },
        }
      : undefined;
    await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: `Exciting news! ${providerName} has joined our conversation. They can now answer your questions directly here.`,
        senderName: "Eva",
        ...(profileCardData ? { uiCardData: profileCardData } : {}),
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
          eventType: "PROVIDER_JOINED_CHAT",
          payload: {
            sessionId: session.id,
            providerName,
            message: `${providerName} has joined your conversation`,
          },
        },
      });
    }

    res.json({ success: true });
  } catch (e: any) {
    console.error("Provider join session error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/provider/concierge-sessions/:id/message", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  const { content, uiCardType, uiCardData } = req.body;
  if (!content || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ message: "Content is required" });
  }
  try {
    const session = await prisma.aiChatSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (session.providerId !== user.providerId) return res.status(403).json({ message: "Forbidden" });

    const isJoined = session.status === "PROVIDER_JOINED";

    const provider = await prisma.provider.findUnique({ where: { id: user.providerId }, select: { name: true } });
    const nameParts = (user.firstName && user.lastName)
      ? [user.firstName, user.lastName]
      : (user.name || "").trim().split(/\s+/);
    const senderDisplayName = nameParts.length >= 2
      ? `${nameParts[0]} ${nameParts[nameParts.length - 1][0]}.`
      : nameParts[0] || provider?.name || "Agency Expert";

    // Check for pending whispers FIRST - if this is a whisper answer (not a joined 3-way session),
    // the provider's message should be intercepted silently so the AI can relay it naturally.
    // Only in a PROVIDER_JOINED session should provider messages appear directly in the parent chat.
    const pendingWhispers = await prisma.silentQuery.findMany({
      where: { sessionId: session.id, providerId: user.providerId, status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: 1,
    });

    if (pendingWhispers.length > 0 && !isJoined) {
      const whisper = pendingWhispers[0];
      // Silently record the answer - do NOT create a visible provider message in the parent's chat
      await prisma.silentQuery.update({
        where: { id: whisper.id },
        data: { status: "ANSWERED", answerText: content.trim() },
      });

      // Show the provider their answer + a confirmation so they can see what was sent
      await prisma.aiChatMessage.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          content: `You answered: "${content.trim()}"\n\nThis has been relayed to the parent by the AI concierge. Thank you!`,
          senderType: "system",
          senderName: "System",
        },
      });

      // Look up the matchmaker name for Eva's relay message
      let matchmakerName = "Eva";
      if ((session as any).matchmakerId) {
        const mm = await prisma.matchmaker.findUnique({ where: { id: (session as any).matchmakerId }, select: { name: true } }).catch(() => null);
        if (mm?.name) matchmakerName = mm.name;
      }

      // Proactively relay the answer to the parent - inject an AI message directly so the parent
      // gets the answer immediately without needing to send another message
      const relayContent = `I heard back from the agency! The answer to your question is: "${content.trim()}"\n\nDoes that help? Do you have any other questions, or would you like to schedule a free consultation call?`;
      await prisma.aiChatMessage.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          content: relayContent,
          senderType: "assistant",
          senderName: matchmakerName,
        },
      });

      // Mark the SilentQuery as RELAYED so the AI router doesn't relay it again on the next parent message
      await prisma.silentQuery.update({
        where: { id: whisper.id },
        data: { status: "RELAYED" },
      });

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

      return res.json({ success: true, whisperAnswered: true });
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

    if (isJoined) {
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

      await prisma.aiChatMessage.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          content: `Great news! ${session.provider?.name || "The provider"} has confirmed the consultation was successful and you're ready to move forward. Your journey stage has been updated to Match Eligibility.`,
          senderType: "system",
          senderName: "Eva",
        },
      });

      const admins = await prisma.user.findMany({ where: { roles: { has: "GOSTORK_ADMIN" } }, select: { id: true } });
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
    } else {
      if (parentUser?.parentAccountId) {
        await prisma.intendedParentProfile.update({
          where: { parentAccountId: parentUser.parentAccountId },
          data: { journeyStage: "Consultation - Not a Fit" },
        }).catch(() => {});
      }

      await prisma.aiChatMessage.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          content: `Thank you for completing the consultation with ${session.provider?.name || "the provider"}. Based on the discussion, this may not be the ideal match. Don't worry - I can help you explore other providers that might be a better fit for your needs.`,
          senderType: "system",
          senderName: "Eva",
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
  if (!user.roles?.includes("GOSTORK_ADMIN")) return res.status(403).json({ message: "Forbidden" });
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
      if (roles.includes("GOSTORK_ADMIN")) allowed = true;
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
        senderName: "Eva",
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
    if (!isSessionProvider && !isSessionParent && !isAdminUser(user)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    let providerUserIds: string[] = [];
    if (session.providerId) {
      const providerUsers = await prisma.user.findMany({
        where: { providerId: session.providerId, roles: { hasSome: PROVIDER_ROLES } },
        select: { id: true },
      });
      providerUserIds = providerUsers.map(u => u.id);
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
            id: true, name: true, email: true, photoUrl: true, providerId: true, roles: true,
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
  if (!isAdminUser(req.user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const sections = await prisma.conciergePromptSection.findMany({ orderBy: { sortOrder: "asc" } });
    res.json(sections);
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/admin/concierge-prompts/seed", requireAuth, async (req, res) => {
  if (!isAdminUser(req.user)) return res.status(403).json({ message: "Forbidden" });
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

// Admin-only: Delete ALL chats, meetings, and reset parent profiles (for testing)
chatRouter.delete("/api/admin/reset-all-chats", requireAuth, async (req, res) => {
  if (!isAdminUser(req.user)) return res.status(403).json({ message: "Forbidden" });
  try {
    // Delete in dependency order - preserve interestedServices on profiles (set during registration)
    const [agreements, silentQueries, messages, sessions, bookings, notifications, profiles] = await prisma.$transaction([
      prisma.agreement.deleteMany({}),
      prisma.silentQuery.deleteMany({}),
      prisma.aiChatMessage.deleteMany({}),
      prisma.aiChatSession.deleteMany({}),
      prisma.booking.deleteMany({}),
      prisma.notification.deleteMany({}),
      prisma.intendedParentProfile.updateMany({
        data: {
          journeyStage: null,
          hasEmbryos: false,
          embryoCount: 0,
          embryosTested: false,
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
          needsSurrogate: false,
          needsEggDonor: false,
          needsClinic: false,
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
          isFirstIvf: null,
          hotLeadProviderId: null,
          hotLeadAt: null,
          currentClinicName: null,
          currentAgencyName: null,
          currentAttorneyName: null,
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
        senderName: "Eva",
      },
    });

    res.json({ success: true, agreementId: agreement?.id, status: agreement?.status });
  } catch (e: any) {
    console.error("Agreement generation error:", e);
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
    const templateId = await syncTemplateToPandaDoc(user.providerId);
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
  try {
    const provider = await prisma.provider.findUnique({
      where: { id: user.providerId },
      select: { pandaDocTemplateId: true },
    });
    if (provider?.pandaDocTemplateId) {
      const apiKey = process.env.PANDADOC_API_KEY;
      if (apiKey) {
        const delRes = await fetch(`https://api.pandadoc.com/public/v1/templates/${provider.pandaDocTemplateId}`, {
          method: "DELETE",
          headers: { "Authorization": `API-Key ${apiKey}` },
        });
        console.log(`[PandaDoc] Template delete: ${provider.pandaDocTemplateId} -> ${delRes.status}`);
      }
    }
    await prisma.provider.update({
      where: { id: user.providerId },
      data: { agreementTemplateUrl: null, agreementTemplateOriginalName: null, pandaDocTemplateId: null },
    });
    res.json({ ok: true });
  } catch (e: any) {
    console.error("Delete template error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Get PandaDoc embedded template editor session URL
chatRouter.get("/api/agreements/template-editor-session", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const eToken = await createTemplateEditingSession(user.providerId, user.email);
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
    const result = await refreshTemplateRoles(user.providerId);
    res.json(result);
  } catch (e: any) {
    console.error("Refresh template roles error:", e);
    res.status(500).json({ message: e.message });
  }
});

// Generate agreement from PandaDoc template (new template-based flow)
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
    const session = await prisma.aiChatSession.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true, providerId: true },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (session.providerId !== user.providerId) return res.status(403).json({ message: "Not authorized for this session" });

    const agreement = await generateAgreementFromTemplate({
      providerId: user.providerId,
      parentUserId: session.userId,
      sessionId: session.id,
      generatedByUserId: user.id,
      partnerOverride: partnerOverride ?? undefined,
      skipPartner: skipPartner === true,
    });

    await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: "The provider has generated the official agreement. Please review and sign it using the button below. You'll also receive it via email.",
        senderType: "system",
        senderName: "Eva",
        uiCardType: "agreement",
        uiCardData: {
          agreementCard: {
            agreementId: (agreement as any).id,
            status: (agreement as any).status,
            viewUrl: (agreement as any).pandaDocViewUrl || null,
          },
        },
      },
    });

    // Send email only to the first signer (lowest signingOrder). Subsequent signers are notified
    // sequentially via the recipient_completed webhook after each person signs.
    try {
      const { getNestApp } = await import("./nest-app-ref");
      const nestApp = getNestApp();
      if (nestApp) {
        const { NotificationService } = await import("./src/modules/notifications/notification.service");
        const notifService = nestApp.get(NotificationService);
        const providerRecord = await prisma.provider.findUnique({
          where: { id: user.providerId },
          select: { name: true },
        });
        const providerName = providerRecord?.name || "Your Agency";
        const agr = agreement as any;
        const appBase = getAppBaseUrl();
        const goStorkSigningUrl = agr.id ? `${appBase}/agreements/${agr.id}` : null;

        type SignerEntry = { name: string; email: string; userId: string | null; guestToken: string | null; signingOrder: number; notified: boolean; signed: boolean };
        console.log(`[Agreement signers] parentSigners count: ${(agr.parentSigners ?? []).length}, agreementId: ${agr.id}, emails: ${(agr.parentSigners ?? []).map((s: any) => s.email).join(", ")}`);
        let signers: SignerEntry[] = (agr.parentSigners ?? []).map((s: any) => ({
          name: s.name,
          email: s.email,
          userId: s.userId ?? null,
          guestToken: s.guestToken ?? null,
          signingOrder: s.signingOrder ?? 1,
          notified: false,
          signed: false,
        }));

        // Fallback: if parentSigners not populated (e.g. old non-template flow), email the primary parent
        if (signers.length === 0) {
          const parentUser = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { name: true, email: true },
          });
          if (parentUser?.email) {
            signers.push({ name: parentUser.name || parentUser.email, email: parentUser.email, userId: session.userId, guestToken: null, signingOrder: 1, notified: false, signed: false });
          }
        }

        // Sort by signing order, then persist the full ordered list on the agreement
        signers.sort((a, b) => a.signingOrder - b.signingOrder);
        await (prisma.agreement as any).update({ where: { id: agr.id }, data: { signerOrder: signers } });

        // Only notify the first signer now
        const firstSigner = signers[0];
        if (firstSigner?.email) {
          const signerUserIds = firstSigner.userId ? [firstSigner.userId] : [];
          const signerUsers = signerUserIds.length > 0
            ? await prisma.user.findMany({ where: { id: { in: signerUserIds } }, select: { id: true, mobileNumber: true } })
            : [];
          const phone = signerUsers.find(u => u.id === firstSigner.userId)?.mobileNumber ?? null;
          const emailSigningUrl = firstSigner.userId
            ? goStorkSigningUrl
            : firstSigner.guestToken ? `${appBase}/agreements/guest/${firstSigner.guestToken}` : null;

          console.log(`[Agreement notify] generate-from-template -> sending to ${firstSigner.email}, isGoStorkMember: ${!!firstSigner.userId && !firstSigner.guestToken}`);
          await notifService.sendAgreementReadyNotification({
            parentUserId: firstSigner.userId || session.userId,
            parentName: firstSigner.name || firstSigner.email,
            parentEmail: firstSigner.email,
            parentPhone: phone,
            providerName,
            providerId: user.providerId,
            signingUrl: emailSigningUrl,
            sessionId: session.id,
            isGoStorkMember: !!firstSigner.userId && !firstSigner.guestToken,
          });

          // Mark first signer as notified in signerOrder
          signers[0] = { ...firstSigner, notified: true };
          await (prisma.agreement as any).update({ where: { id: agr.id }, data: { signerOrder: signers } });
        }
      }
    } catch (notifErr: any) {
      console.error("[Agreement] Notification send failed:", notifErr?.message);
    }

    const agr2 = agreement as any;
    res.json({ success: true, agreementId: agr2.id, status: agr2.status });
  } catch (e: any) {
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
    const isAdmin = isAdminUser(user);
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
        console.log(`[PandaDoc webhook] No agreement found for documentId: ${documentId}`);
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
                  const appBase = getAppBaseUrl();
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
                senderName: "Eva",
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
                  senderName: "Eva",
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
                senderName: "Eva",
                uiCardType: "agreement_signed",
                uiCardData: { agreementId: agreement.id },
              },
            }).catch(e => console.error("[PandaDoc webhook] Failed to post all-signed chat message:", e));
          }

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

