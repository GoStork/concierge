import { Router, Request, Response } from "express";
import { prisma } from "./db";
import { generateAgreement } from "./pandadoc-service";

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

function requireAuth(req: Request, res: Response, next: () => void) {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  next();
}

export const chatRouter = Router();

chatRouter.get("/api/my/chat-sessions", requireAuth, async (req, res) => {
  const user = req.user as any;
  try {
    const sessions = await prisma.aiChatSession.findMany({
      where: { userId: user.id },
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
    const result = sessions.map(s => ({
      id: s.id,
      title: s.title,
      status: s.status,
      matchmakerId: s.matchmakerId,
      matchmakerName: s.matchmakerId ? matchmakerMap[s.matchmakerId]?.name : null,
      matchmakerAvatar: s.matchmakerId ? matchmakerMap[s.matchmakerId]?.avatarUrl : null,
      matchmakerTitle: s.matchmakerId ? matchmakerMap[s.matchmakerId]?.title : null,
      providerId: s.providerId,
      providerName: s.provider?.name || null,
      providerLogo: s.provider?.logoUrl || null,
      providerJoinedAt: s.providerJoinedAt,
      humanRequested: s.humanRequested,
      lastMessage: s.messages[0]?.content || null,
      lastMessageAt: s.messages[0]?.createdAt || s.updatedAt,
      lastMessageSenderType: s.messages[0]?.senderType || null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
    res.json(result);
  } catch (e) {
    console.error("My chat sessions error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

chatRouter.patch("/api/my/chat-session/matchmaker", requireAuth, async (req, res) => {
  const user = req.user as any;
  const { matchmakerId } = req.body;
  if (!matchmakerId) return res.status(400).json({ message: "matchmakerId required" });
  try {
    const session = await prisma.aiChatSession.findFirst({
      where: { userId: user.id, providerId: null },
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
    const result = sessions.map(s => ({
      id: s.id,
      userId: s.userId,
      userName: s.user.name,
      userEmail: s.user.email,
      userAvatar: (s.user as any).photoUrl,
      status: s.status,
      humanRequested: s.humanRequested,
      humanJoinedAt: s.humanJoinedAt,
      providerId: s.providerId,
      providerName: s.provider?.name || null,
      providerLogo: s.provider?.logoUrl || null,
      providerJoinedAt: s.providerJoinedAt,
      messageCount: s._count.messages,
      lastMessage: s.messages[0]?.content?.slice(0, 120) || null,
      lastMessageAt: s.messages[0]?.createdAt || s.updatedAt,
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
            id: true, name: true, email: true, photoUrl: true, city: true, state: true,
            parentAccount: {
              select: {
                intendedParentProfile: { select: { journeyStage: true, eggSource: true, spermSource: true, carrier: true, hasEmbryos: true, embryoCount: true } },
              },
            },
          },
        },
        messages: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });
    res.json(session);
  } catch (e: any) {
    console.error("Admin concierge session detail error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/admin/concierge-sessions/:id/message", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
  const { content } = req.body;
  if (!content || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ message: "Content is required" });
  }
  try {
    const session = await prisma.aiChatSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ message: "Session not found" });

    if (!session.humanJoinedAt) {
      await prisma.aiChatSession.update({
        where: { id: session.id },
        data: { humanJoinedAt: new Date(), humanAgentId: user.id, status: "HUMAN_JOINED" },
      });
    }

    const message = await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: content.trim(),
        senderType: "human",
        senderName: user.name || "GoStork Expert",
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
      where: { providerId: user.providerId, status: { in: ["ACTIVE", "HUMAN_JOINED", "PROVIDER_JOINED"] } },
      include: {
        user: { select: { id: true, name: true, email: true, photoUrl: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    const result = sessions.map(s => ({
      id: s.id,
      userId: s.userId,
      userName: s.user.name,
      userEmail: s.user.email,
      userAvatar: (s.user as any).photoUrl,
      status: s.status,
      providerJoinedAt: s.providerJoinedAt,
      messageCount: s._count.messages,
      lastMessage: s.messages[0]?.content?.slice(0, 120) || null,
      lastMessageAt: s.messages[0]?.createdAt || s.updatedAt,
      createdAt: s.createdAt,
    }));
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
            id: true, name: true, email: true, photoUrl: true, city: true, state: true,
            parentAccount: {
              select: {
                intendedParentProfile: { select: { journeyStage: true, eggSource: true, spermSource: true, carrier: true, hasEmbryos: true, embryoCount: true } },
              },
            },
          },
        },
        messages: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (session.providerId !== user.providerId) return res.status(403).json({ message: "Forbidden" });
    res.json(session);
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

    await prisma.aiChatSession.update({
      where: { id: session.id },
      data: { providerJoinedAt: new Date(), status: "PROVIDER_JOINED" },
    });

    const providerName = session.provider?.name || user.name || "Your matched provider";
    await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: `Exciting news! ${providerName} has joined our conversation. They can now answer your questions directly here.`,
        senderType: "system",
        senderName: "Eva",
      },
    });

    await prisma.inAppNotification.create({
      data: {
        userId: session.userId,
        eventType: "PROVIDER_JOINED_CHAT",
        payload: {
          sessionId: session.id,
          providerName,
          message: `${providerName} has joined your conversation`,
        },
      },
    });

    res.json({ success: true });
  } catch (e: any) {
    console.error("Provider join session error:", e);
    res.status(500).json({ message: e.message });
  }
});

chatRouter.post("/api/provider/concierge-sessions/:id/message", requireAuth, async (req, res) => {
  const user = req.user as any;
  if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
  const { content } = req.body;
  if (!content || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ message: "Content is required" });
  }
  try {
    const session = await prisma.aiChatSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (session.providerId !== user.providerId) return res.status(403).json({ message: "Forbidden" });

    if (!session.providerJoinedAt) {
      await prisma.aiChatSession.update({
        where: { id: session.id },
        data: { providerJoinedAt: new Date(), status: "PROVIDER_JOINED" },
      });
    }

    const provider = await prisma.provider.findUnique({ where: { id: user.providerId }, select: { name: true } });
    const nameParts = (user.firstName && user.lastName)
      ? [user.firstName, user.lastName]
      : (user.name || "").trim().split(/\s+/);
    const senderDisplayName = nameParts.length >= 2
      ? `${nameParts[0]} ${nameParts[nameParts.length - 1][0]}.`
      : nameParts[0] || provider?.name || "Agency Expert";
    const message = await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: content.trim(),
        senderType: "provider",
        senderName: senderDisplayName,
      },
    });

    const pendingWhispers = await prisma.silentQuery.findMany({
      where: { sessionId: session.id, providerId: user.providerId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    if (pendingWhispers.length > 0) {
      await prisma.silentQuery.updateMany({
        where: { id: { in: pendingWhispers.map(w => w.id) } },
        data: { status: "ANSWERED", answerText: content.trim() },
      });
    }

    await prisma.inAppNotification.create({
      data: {
        userId: session.userId,
        eventType: "PROVIDER_MESSAGE",
        payload: {
          sessionId: session.id,
          message: `${provider?.name || "Your provider"} sent you a message`,
          preview: content.trim().slice(0, 100),
        },
      },
    });

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
          content: `Thank you for completing the consultation with ${session.provider?.name || "the provider"}. Based on the discussion, this may not be the ideal match. Don't worry — I can help you explore other providers that might be a better fit for your needs.`,
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

    res.json({ success: true, agreementId: agreement.id, status: agreement.status });
  } catch (e: any) {
    console.error("Agreement generation error:", e);
    res.status(500).json({ message: e.message });
  }
});
