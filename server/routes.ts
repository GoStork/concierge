import { aiRouter } from "./ai-router";
import type { Express } from "express";
import { type Server } from "http";
import passport from "passport";
import { storage } from "./storage";
import { setupAuth, requireAuth, requireRole } from "./auth";
import { api } from "@shared/routes";
import { z } from "zod";
import { prisma } from "./db";
import { generateAgreement } from "./pandadoc-service";

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

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
function isProviderOrAdmin(user: any, providerId: string): boolean {
  if (isAdminUser(user)) return true;
  const roles = getUserRoles(user);
  return roles.some((r: string) => PROVIDER_ROLES.includes(r)) && user.providerId === providerId;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  const { hashPassword } = setupAuth(app);

  app.post(api.auth.login.path, (req, res, next) => {
    passport.authenticate("local", async (err: any, user: any) => {
      if (err) return next(err);
      if (!user)
        return res.status(401).json({ message: "Invalid credentials" });
      req.logIn(user, async (err) => {
        if (err) return next(err);
        const enriched = await storage.getUserWithProvider(user.id);
        const result = enriched || user;
        const { password: _, ...safe } = result;
        res.json(safe);
      });
    })(req, res, next);
  });

  app.post(api.auth.logout.path, (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session.destroy((destroyErr) => {
        if (destroyErr) console.error("Session destroy error:", destroyErr);
        res.clearCookie("connect.sid", { path: "/" });
        res.json({ message: "Logged out" });
      });
    });
  });

  app.get(api.auth.me.path, async (req, res) => {
    if (!req.isAuthenticated())
      return res.status(401).json({ message: "Not logged in" });
    const user = req.user as any;
    const enriched = await storage.getUserWithProvider(user.id);
    const result = enriched || user;
    const { password: _, ...safe } = result;
    res.json(safe);
  });

  app.get(api.providers.list.path, async (_req, res) => {
    const allProviders = await storage.getAllProviders();
    res.json(allProviders);
  });

  app.get(api.providers.get.path, async (req, res) => {
    const provider = await storage.getProvider(req.params.id);
    if (!provider)
      return res.status(404).json({ message: "Provider not found" });
    res.json(provider);
  });

  app.post(
    api.providers.create.path,
    requireRole(["GOSTORK_ADMIN"]),
    async (req, res) => {
      try {
        const input = api.providers.create.input.parse(req.body);
        const provider = await storage.createProvider(input);
        res.status(201).json(provider);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return res
            .status(400)
            .json({ message: "Validation error", errors: err.errors });
        }
        throw err;
      }
    },
  );

  app.put(api.providers.update.path, requireAuth, async (req, res) => {
    const user = req.user as any;
    const targetId = req.params.id;
    if (!isProviderOrAdmin(user, targetId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    try {
      const input = api.providers.update.input.parse(req.body);
      const updated = await storage.updateProvider(targetId, input);
      res.json(updated);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json(err);
      throw err;
    }
  });

  app.get(api.providerTypes.list.path, async (_req, res) => {
    const types = await storage.getAllProviderTypes();
    res.json(types);
  });

  app.post(
    api.providerTypes.create.path,
    requireRole(["GOSTORK_ADMIN"]),
    async (req, res) => {
      try {
        const input = api.providerTypes.create.input.parse(req.body);
        const providerType = await storage.createProviderType(input);
        res.status(201).json(providerType);
      } catch (err) {
        if (err instanceof z.ZodError) return res.status(400).json(err);
        throw err;
      }
    },
  );

  app.get(api.providerServices.list.path, async (req, res) => {
    const providerId = req.params.providerId;
    const services = await storage.getProviderServices(providerId);
    res.json(services);
  });

  app.post(api.providerServices.create.path, requireAuth, async (req, res) => {
    const user = req.user as any;
    const providerId = req.params.providerId;

    if (!isProviderOrAdmin(user, providerId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    try {
      const input = api.providerServices.create.input.parse(req.body);
      const service = await storage.createProviderService({
        ...input,
        providerId,
      });
      res.status(201).json(service);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json(err);
      throw err;
    }
  });

  app.put(api.providerServices.update.path, requireAuth, async (req, res) => {
    const user = req.user as any;
    const providerId = req.params.providerId;

    if (!isProviderOrAdmin(user, providerId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    try {
      const input = api.providerServices.update.input.parse(req.body);
      const service = await storage.updateProviderService(req.params.id, input);
      res.json(service);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json(err);
      throw err;
    }
  });

  app.get(api.providerLocations.list.path, async (req, res) => {
    const providerId = req.params.providerId;
    const locations = await storage.getProviderLocations(providerId);
    res.json(locations);
  });

  app.post(api.providerLocations.create.path, requireAuth, async (req, res) => {
    const user = req.user as any;
    const providerId = req.params.providerId;

    if (!isProviderOrAdmin(user, providerId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    try {
      const input = api.providerLocations.create.input.parse(req.body);
      const location = await storage.createProviderLocation({
        ...input,
        providerId,
      });
      res.status(201).json(location);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json(err);
      throw err;
    }
  });

  app.put(api.providerLocations.update.path, requireAuth, async (req, res) => {
    const user = req.user as any;
    const providerId = req.params.providerId;

    if (!isProviderOrAdmin(user, providerId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    try {
      const input = api.providerLocations.update.input.parse(req.body);
      const location = await storage.updateProviderLocation(
        req.params.id,
        input,
      );
      res.json(location);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json(err);
      throw err;
    }
  });

  app.post(api.users.create.path, async (req, res) => {
    try {
      const input = api.users.create.input.parse(req.body);
      const existing = await storage.getUserByEmail(input.email);
      if (existing)
        return res.status(400).json({ message: "Email already in use" });
      const hashedPassword = await hashPassword(input.password);
      const isAdmin = req.isAuthenticated() && (req.user as any).role === "GOSTORK_ADMIN";
      const user = await storage.createUser({
        email: input.email,
        password: hashedPassword,
        name: input.name,
        mobileNumber: input.mobileNumber,
        mustCompleteProfile: true,
        ...(isAdmin ? {
          role: input.role,
          roles: input.roles,
          providerId: input.providerId,
          allLocations: input.allLocations,
          locationIds: input.locationIds,
          photoUrl: input.photoUrl,
        } : {}),
      });
      res.status(201).json(user);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json(err);
      throw err;
    }
  });

  app.get(api.users.list.path, requireAuth, async (req, res) => {
    if ((req.user as any).role !== "GOSTORK_ADMIN") {
      return res.status(403).json({ message: "Only Admins for now" });
    }
    res.json([]);
  });

  // No auto-seeding — data is managed via SQL inserts by the admin

  app.use("/api/ai-concierge", aiRouter);

  app.get("/api/my/chat-sessions", requireAuth, async (req, res) => {
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
        profilePhotoUrl: (s as any).profilePhotoUrl || null,
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

  app.get("/api/admin/concierge-sessions", requireAuth, async (req, res) => {
    const user = req.user as any;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    try {
      const sessions = await prisma.aiChatSession.findMany({
        where: { status: { in: ["ACTIVE", "HUMAN_JOINED", "PROVIDER_JOINED"] } },
        include: {
          user: { select: { id: true, name: true, email: true, avatarUrl: true } },
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
        userAvatar: s.user.avatarUrl,
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

  app.get("/api/admin/concierge-sessions/:id", requireAuth, async (req, res) => {
    const user = req.user as any;
    if (!isAdminUser(user)) return res.status(403).json({ message: "Forbidden" });
    try {
      const session = await prisma.aiChatSession.findUnique({
        where: { id: req.params.id },
        include: {
          user: {
            select: {
              id: true, name: true, email: true, avatarUrl: true, city: true, state: true,
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

  app.post("/api/admin/concierge-sessions/:id/message", requireAuth, async (req, res) => {
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

  app.post("/api/consultation/request-callback", requireAuth, async (req, res) => {
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

  app.get("/api/provider/concierge-sessions", requireAuth, async (req, res) => {
    const user = req.user as any;
    if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
    try {
      const sessions = await prisma.aiChatSession.findMany({
        where: { providerId: user.providerId, status: { in: ["ACTIVE", "HUMAN_JOINED", "PROVIDER_JOINED"] } },
        include: {
          user: { select: { id: true, name: true, email: true, avatarUrl: true } },
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
        userAvatar: s.user.avatarUrl,
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

  app.get("/api/provider/concierge-sessions/:id", requireAuth, async (req, res) => {
    const user = req.user as any;
    if (!isProviderUser(user)) return res.status(403).json({ message: "Forbidden" });
    try {
      const session = await prisma.aiChatSession.findUnique({
        where: { id: req.params.id },
        include: {
          user: {
            select: {
              id: true, name: true, email: true, avatarUrl: true, city: true, state: true,
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

  app.post("/api/provider/concierge-sessions/:id/join", requireAuth, async (req, res) => {
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

  app.post("/api/provider/concierge-sessions/:id/message", requireAuth, async (req, res) => {
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
      const message = await prisma.aiChatMessage.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          content: content.trim(),
          senderType: "provider",
          senderName: provider?.name || user.name || "Agency Expert",
        },
      });

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

  app.post("/api/provider/concierge-sessions/:id/consultation-status", requireAuth, async (req, res) => {
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

  app.post("/api/agreements/generate", requireAuth, async (req, res) => {
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

  return httpServer;
}
