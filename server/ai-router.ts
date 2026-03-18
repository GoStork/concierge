import { Router, Request, Response } from "express";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { prisma } from "./db";

export const aiRouter = Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function sendPrepDocEmail(parentEmail: string, parentName: string, baseUrl: string) {
  const sendgridKey = process.env.SENDGRID_API_KEY;
  if (!sendgridKey) {
    console.log(`[PREP DOC EMAIL MOCK] To: ${parentEmail}, Parent: ${parentName}`);
    return;
  }

  let brandColor = "#004D4D";
  let companyName = "GoStork";
  let logoUrl = "";
  try {
    const settings = await prisma.siteSettings.findFirst();
    if (settings) {
      brandColor = (settings as any).primaryColor || brandColor;
      companyName = (settings as any).companyName || companyName;
      logoUrl = (settings as any).logoWithNameUrl || (settings as any).logoUrl || "";
    }
  } catch {}

  const downloadLink = `${baseUrl}/surrogacy-match-call-guide.pdf`;
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f5f5f0;font-family:'DM Sans',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f0;padding:40px 20px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="background-color:${brandColor};padding:30px;text-align:center;">
${logoUrl ? `<img src="${logoUrl}" alt="${companyName}" style="max-height:40px;margin-bottom:8px;"><br>` : ""}
<h1 style="color:#ffffff;font-family:'Playfair Display',Georgia,serif;font-size:24px;margin:0;">${companyName}</h1>
</td></tr>
<tr><td style="padding:40px 30px;">
<h2 style="font-family:'Playfair Display',Georgia,serif;color:${brandColor};font-size:22px;margin:0 0 16px;">Your Match Call Prep Guide</h2>
<p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 12px;">Hi ${escapeHtml(parentName)},</p>
<p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 20px;">Exciting news — a match call is being arranged for you! To help you feel confident and prepared, we've put together a guide with thoughtful questions to ask your potential surrogate.</p>
<div style="background-color:#f8f9fa;border-radius:8px;padding:20px;margin:0 0 20px;">
<p style="color:${brandColor};font-size:14px;font-weight:600;margin:0 0 12px;">What's Inside:</p>
<table cellpadding="0" cellspacing="0" width="100%">
<tr><td style="padding:4px 0;color:#333;font-size:14px;">🫶 Personal &amp; Lifestyle questions</td></tr>
<tr><td style="padding:4px 0;color:#333;font-size:14px;">🧠 Values &amp; Boundaries discussion points</td></tr>
<tr><td style="padding:4px 0;color:#333;font-size:14px;">🏥 Medical &amp; Pregnancy-related questions</td></tr>
<tr><td style="padding:4px 0;color:#333;font-size:14px;">💬 Key Ethical Topics to address</td></tr>
<tr><td style="padding:4px 0;color:#333;font-size:14px;">📝 Legal, Logistical &amp; Communication style</td></tr>
<tr><td style="padding:4px 0;color:#333;font-size:14px;">🐣 After Birth expectations</td></tr>
</table>
</div>
<table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;"><tr><td style="background-color:${brandColor};border-radius:8px;padding:14px 32px;">
<a href="${downloadLink}" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;display:inline-block;">Download Your Guide (PDF)</a>
</td></tr></table>
<div style="background-color:#fef9e7;border-left:4px solid #f59e0b;padding:16px;border-radius:4px;margin:0 0 20px;">
<p style="color:#333;font-size:14px;line-height:1.5;margin:0;"><strong>💡 Tip:</strong> Start warm and personal — this is a relationship-building moment, not just a checklist. Leave space for your surrogate to ask you questions too. It's a two-way match!</p>
</div>
<p style="color:#666;font-size:13px;line-height:1.5;margin:0;">Your ${companyName} team is here every step of the way. If you have any questions before your call, just chat with your AI concierge or reach out to our team.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const fromEmail = process.env.SENDGRID_FROM_EMAIL || "noreply@gostork.com";
  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sendgridKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: parentEmail }] }],
        from: { email: fromEmail, name: companyName },
        subject: `Your Surrogacy Match Call Prep Guide — ${companyName}`,
        content: [{ type: "text/html", value: html }],
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`SendGrid prep doc email failed: ${response.status} - ${text}`);
    }
  } catch (e: any) {
    console.error(`SendGrid prep doc email error: ${e.message}`);
  }
}

async function sendWhisperEmail(providerEmail: string, providerName: string, questionText: string, baseUrl: string) {
  const sendgridKey = process.env.SENDGRID_API_KEY;
  if (!sendgridKey) {
    console.log(`[WHISPER EMAIL MOCK] To: ${providerEmail}, Provider: ${providerName}, Question: ${questionText}`);
    return;
  }

  let brandColor = "#004D4D";
  let companyName = "GoStork";
  let logoUrl = "";
  try {
    const settings = await prisma.siteSettings.findFirst();
    if (settings) {
      brandColor = (settings as any).primaryColor || brandColor;
      companyName = (settings as any).companyName || companyName;
      logoUrl = (settings as any).logoWithNameUrl || (settings as any).logoUrl || "";
    }
  } catch {}

  const dashboardLink = `${baseUrl}/account/knowledge`;
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f5f5f0;font-family:'DM Sans',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f0;padding:40px 20px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="background-color:${brandColor};padding:30px;text-align:center;">
${logoUrl ? `<img src="${logoUrl}" alt="${companyName}" style="max-height:40px;margin-bottom:8px;"><br>` : ""}
<h1 style="color:#ffffff;font-family:'Playfair Display',Georgia,serif;font-size:24px;margin:0;">${companyName}</h1>
</td></tr>
<tr><td style="padding:40px 30px;">
<h2 style="font-family:'Playfair Display',Georgia,serif;color:${brandColor};font-size:22px;margin:0 0 16px;">New Question from a Prospective Parent</h2>
<p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 12px;">Hi ${escapeHtml(providerName)} team,</p>
<p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 16px;">A prospective parent asked our AI concierge a question that we don't have the answer to yet. Could you help us out?</p>
<div style="background-color:#f8f9fa;border-left:4px solid ${brandColor};padding:16px 20px;border-radius:4px;margin:0 0 24px;">
<p style="color:#555;font-size:13px;font-weight:600;text-transform:uppercase;margin:0 0 8px;">Question:</p>
<p style="color:#333;font-size:15px;line-height:1.6;margin:0;font-style:italic;">"${escapeHtml(questionText)}"</p>
</div>
<p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 24px;">Once you answer, our AI will learn it for the future so parents always get accurate information about your clinic.</p>
<table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;"><tr><td style="background-color:${brandColor};border-radius:8px;padding:14px 32px;">
<a href="${dashboardLink}" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;display:inline-block;">Answer This Question</a>
</td></tr></table>
<p style="color:#999;font-size:12px;line-height:1.5;margin:24px 0 0;padding-top:16px;border-top:1px solid #eee;">This question was asked anonymously — no parent contact information is shared. You can answer directly from your ${companyName} dashboard.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const fromEmail = process.env.SENDGRID_FROM_EMAIL || "noreply@gostork.com";
  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sendgridKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: providerEmail }] }],
        from: { email: fromEmail, name: companyName },
        subject: `New Question from a Prospective Parent — ${companyName}`,
        content: [{ type: "text/html", value: html }],
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`SendGrid whisper email failed: ${response.status} - ${text}`);
    }
  } catch (e: any) {
    console.error(`SendGrid whisper email error: ${e.message}`);
  }
}

async function searchKnowledgeBase(
  query: string,
  providerId?: string,
  maxResults: number = 5,
): Promise<{ content: string; sourceTier: number; sourceType: string; score: number }[]> {
  try {
    const result = await mcpClient.callTool({
      name: "search_knowledge_base",
      arguments: { query, ...(providerId ? { providerId } : {}), maxResults },
    });
    const text = (result.content as any)?.[0]?.text || "[]";
    return JSON.parse(text);
  } catch (e) {
    console.error("Knowledge search failed:", e);
    return [];
  }
}

async function getExpertGuidanceRules(): Promise<string> {
  try {
    const result = await mcpClient!.callTool({
      name: "get_expert_guidance_rules",
      arguments: {},
    });
    const text = (result.content as any)?.[0]?.text || "[]";
    const rules = JSON.parse(text);
    if (rules.length === 0) return "";
    const ruleLines = rules.map(
      (r: any) => `- IF the user mentions "${r.condition}" → ${r.guidance}`,
    );
    return `\nEXPERT GUIDANCE RULES (follow these when relevant):\n${ruleLines.join("\n")}\n`;
  } catch (e) {
    console.error("Failed to load guidance rules:", e);
    return "";
  }
}

let mcpClient: Client | null = null;

async function initMcp() {
  try {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "server/src/mcp-server.ts"],
      env: { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config` } as Record<string, string>,
    });

    mcpClient = new Client(
      { name: "gostork-express-client", version: "1.0.0" },
      { capabilities: {} },
    );

    await mcpClient.connect(transport);
    console.log("Express Client successfully connected to the MCP Database Server");
  } catch (error) {
    console.error("Failed to start MCP Client:", error);
    mcpClient = null;
  }
}

initMcp();

// 2. The Chat API Endpoint
aiRouter.get("/session/:sessionId/messages", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ message: "Unauthorized" });
    const { sessionId } = req.params;
    const after = req.query.after as string | undefined;
    const session = await prisma.aiChatSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, providerId: true },
    });
    if (!session) return res.status(403).json({ message: "Forbidden" });
    const isOwner = session.userId === user.id;
    let isAccountMember = false;
    if (!isOwner && user.parentAccountId) {
      const sessionOwner = await prisma.user.findUnique({ where: { id: session.userId }, select: { parentAccountId: true } });
      isAccountMember = !!sessionOwner && sessionOwner.parentAccountId === user.parentAccountId;
    }
    const roles: string[] = user.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN");
    const providerRoles = ["PROVIDER_ADMIN", "SURROGACY_COORDINATOR", "EGG_DONOR_COORDINATOR", "SPERM_DONOR_COORDINATOR", "IVF_CLINIC_COORDINATOR", "DOCTOR", "BILLING_MANAGER"];
    const isProvider = roles.some((r: string) => providerRoles.includes(r)) && user.providerId && session.providerId === user.providerId;
    if (!isOwner && !isAccountMember && !isAdmin && !isProvider) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const where: any = { sessionId };
    if (after) {
      where.createdAt = { gt: new Date(after) };
    }
    const messages = await prisma.aiChatMessage.findMany({
      where,
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, content: true, senderType: true, senderName: true, createdAt: true, uiCardType: true, uiCardData: true },
    });
    res.json(messages);
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

aiRouter.post("/init-session", async (req: Request, res: Response) => {
  try {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const userId = (req.user as any).id;
    const { matchmakerId, greeting } = req.body;
    if (!matchmakerId || !greeting) {
      return res.status(400).json({ error: "matchmakerId and greeting required" });
    }

    const currentUser = await prisma.user.findUnique({ where: { id: userId }, select: { parentAccountId: true } });
    const accountUserIds = currentUser?.parentAccountId
      ? (await prisma.user.findMany({ where: { parentAccountId: currentUser.parentAccountId }, select: { id: true } })).map(u => u.id)
      : [userId];

    const existing = await prisma.aiChatSession.findFirst({
      where: { userId: { in: accountUserIds } },
      select: { id: true },
    });
    if (existing) {
      return res.json({ sessionId: existing.id });
    }

    const session = await prisma.aiChatSession.create({
      data: { userId, title: "AI Concierge Chat", matchmakerId },
    });

    const greetingMsg = await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: greeting,
        senderType: "ai",
      },
    });

    res.json({ sessionId: session.id, greetingMessageId: greetingMsg.id });
  } catch (e: any) {
    console.error("Init session error:", e);
    res.status(500).json({ error: e.message });
  }
});

aiRouter.post("/chat", async (req: Request, res: Response) => {
  try {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const userId = (req.user as any).id;
    let currentSessionId = req.body.sessionId;

    const currentUser = await prisma.user.findUnique({ where: { id: userId }, select: { parentAccountId: true, name: true, firstName: true, lastName: true } });
    if (currentSessionId) {
      const session = await prisma.aiChatSession.findUnique({ where: { id: currentSessionId } });
      if (!session) {
        return res.status(403).json({ error: "Session not found" });
      }
      let hasAccess = session.userId === userId;
      if (!hasAccess && currentUser?.parentAccountId) {
        const sessionOwner = await prisma.user.findUnique({ where: { id: session.userId }, select: { parentAccountId: true } });
        hasAccess = !!sessionOwner && sessionOwner.parentAccountId === currentUser.parentAccountId;
      }
      if (!hasAccess) {
        return res.status(403).json({ error: "Session does not belong to this user" });
      }
      if (req.body.matchmakerId && session.matchmakerId !== req.body.matchmakerId) {
        await prisma.aiChatSession.update({
          where: { id: currentSessionId },
          data: { matchmakerId: req.body.matchmakerId },
        });
      }
    } else {
      const accountUserIds = currentUser?.parentAccountId
        ? (await prisma.user.findMany({ where: { parentAccountId: currentUser.parentAccountId }, select: { id: true } })).map(u => u.id)
        : [userId];
      const existingSession = await prisma.aiChatSession.findFirst({
        where: { userId: { in: accountUserIds }, providerId: null },
        orderBy: { updatedAt: "desc" },
      });
      if (existingSession) {
        currentSessionId = existingSession.id;
        if (req.body.matchmakerId && existingSession.matchmakerId !== req.body.matchmakerId) {
          await prisma.aiChatSession.update({
            where: { id: currentSessionId },
            data: { matchmakerId: req.body.matchmakerId },
          });
        }
      } else {
        const newSession = await prisma.aiChatSession.create({
          data: { userId, title: "Concierge Consultation", matchmakerId: req.body.matchmakerId || null },
        });
        currentSessionId = newSession.id;
      }
    }

    const parentNameParts = (currentUser?.firstName && currentUser?.lastName)
      ? [currentUser.firstName, currentUser.lastName]
      : (currentUser?.name || "").trim().split(/\s+/);
    const parentDisplayName = parentNameParts.length >= 2
      ? `${parentNameParts[0]} ${parentNameParts[parentNameParts.length - 1][0]}.`
      : parentNameParts[0] || "Parent";

    const savedUserMsg = await prisma.aiChatMessage.create({
      data: {
        sessionId: currentSessionId,
        role: "user",
        content: req.body.message,
        senderName: parentDisplayName,
      },
    });

    const currentSession = await prisma.aiChatSession.findUnique({
      where: { id: currentSessionId },
      select: { providerJoinedAt: true, providerId: true, status: true },
    });
    if (currentSession?.providerJoinedAt && currentSession.status === "PROVIDER_JOINED") {
      if (currentSession.providerId) {
        const providerUsers = await prisma.user.findMany({
          where: { providerId: currentSession.providerId },
          select: { id: true },
        });
        for (const pu of providerUsers) {
          await prisma.inAppNotification.create({
            data: {
              userId: pu.id,
              eventType: "PARENT_MESSAGE",
              payload: {
                sessionId: currentSessionId,
                message: "A parent sent a new message in your conversation",
                preview: req.body.message.slice(0, 100),
              },
            },
          });
        }
      }
      return res.json({
        message: { id: null, content: "", senderType: "ai", role: "assistant" },
        sessionId: currentSessionId,
        userMessageId: savedUserMsg.id,
        skipAiResponse: true,
      });
    }

    const chatHistory = await prisma.aiChatMessage.findMany({
      where: { sessionId: currentSessionId },
      orderBy: { createdAt: "asc" },
    });

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = chatHistory.map(
      (msg) => ({
        role: msg.role as "user" | "assistant" | "system",
        content: msg.content,
      }),
    );

    const matchmakerId = req.body.matchmakerId;
    let personalityBlock = "You are Eva, the expert fertility concierge for GoStork.";
    let initialGreeting: string | null = null;
    if (matchmakerId) {
      const matchmaker = await prisma.matchmaker.findUnique({ where: { id: matchmakerId } });
      if (matchmaker) {
        personalityBlock = matchmaker.personalityPrompt;
        initialGreeting = matchmaker.initialGreeting;
      }
    }

    const userRecord = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        firstName: true,
        lastName: true,
        name: true,
        city: true,
        state: true,
        gender: true,
        sexualOrientation: true,
        relationshipStatus: true,
        partnerFirstName: true,
        partnerAge: true,
        dateOfBirth: true,
        parentAccountId: true,
        parentAccount: {
          select: {
            intendedParentProfile: true,
          },
        },
      },
    });

    const firstName = userRecord?.firstName || userRecord?.name?.split(" ")[0] || "there";
    const city = userRecord?.city || "";
    const state = userRecord?.state || "";
    const location = city && state ? `${city}, ${state}` : city || state || "your area";
    const profile = (userRecord as any)?.parentAccount?.intendedParentProfile;
    const services: string[] = profile?.interestedServices || [];
    const service = services.length ? services.join(" and ") : "fertility services";

    if (initialGreeting) {
      initialGreeting = initialGreeting
        .replace(/\[First Name\]/gi, firstName)
        .replace(/\[Service\]/gi, service)
        .replace(/\[Location\]/gi, location);
    }

    let userContextBlock = "";
    if (userRecord) {
      const parts: string[] = [];
      parts.push(`The user's name is ${firstName}.`);
      if (userRecord.gender) parts.push(`They identify as ${userRecord.gender.replace("I'm ", "").toLowerCase()}.`);
      if (userRecord.sexualOrientation) parts.push(`Sexual orientation: ${userRecord.sexualOrientation}.`);
      if (userRecord.relationshipStatus) parts.push(`Relationship status: ${userRecord.relationshipStatus}.`);
      if (userRecord.partnerFirstName) {
        let partnerInfo = `Partner's name: ${userRecord.partnerFirstName}`;
        if (userRecord.partnerAge) partnerInfo += `, age ${userRecord.partnerAge}`;
        parts.push(partnerInfo + ".");
      }
      parts.push(`Location: ${location}.`);
      parts.push(`Registered interest in: ${service} (but you MUST still ask them in STEP 5 what services they actually need help finding — do NOT assume from registration).`);
      if (userRecord.dateOfBirth) {
        const age = Math.floor((Date.now() - new Date(userRecord.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        parts.push(`Age: ${age}.`);
      }
      if (profile?.hasEmbryos) {
        parts.push(`Has frozen embryos: Yes (count: ${profile.embryoCount || "unknown"}, PGT-A tested: ${profile.embryosTested ? "yes" : "unknown"}).`);
      }
      if (profile?.eggSource) parts.push(`Egg source: ${profile.eggSource}.`);
      if (profile?.spermSource) parts.push(`Sperm source: ${profile.spermSource}.`);
      if (profile?.carrier) parts.push(`Carrier: ${profile.carrier}.`);
      if (profile?.journeyStage) parts.push(`Journey stage: ${profile.journeyStage}.`);
      userContextBlock = parts.join(" ");
    }

    const biologicalMasterLogic = `
CONVERSATIONAL FLOW — EXPERT CONSULTANT MODE:
You are NOT a survey bot. You are an expert fertility consultant who listens deeply, offers guidance, and provides expert insight. You already know the user's basic profile (name, identity, location, services). NEVER re-ask for information you already have. Use it naturally.

YOUR EXPERT PERSONA:
- Guide parents with confidence. When they share a preference, acknowledge it and offer an Expert Tip that adds value.
- Example: If a parent says "I want a donor with a master's degree," respond: "Noted. That's a great goal. Expert Tip: we find that a donor's family health history is just as critical for long-term success. Let's look for both."
- Use warm Amata-style transitions: "Noted." "Understood." "I'm on it." "Perfect." "Great choice." "Let me look into that."
- Be conversational and human — you're a knowledgeable friend, not a form.

INTERACTIVE UI COMPONENTS:
For technical/binary questions, offer quick-reply buttons so the user can tap instead of type.
Format: Include [[QUICK_REPLY:option1|option2|option3]] at the end of your message.
Examples:
  - "Do you already have frozen embryos? [[QUICK_REPLY:Yes, I do|No, not yet]]"
  - "Have they been PGT-A tested? [[QUICK_REPLY:Yes|No|I'm not sure]]"
  - "Who is planning to carry? [[QUICK_REPLY:Me|My partner|A gestational surrogate]]"
These buttons will appear below your message for easy selection. The user can also type freely instead.
Only use quick replies for clear-cut technical questions. For emotional/preference questions, let them type freely.

MULTI-SELECT UI (for questions where the user can pick MORE THAN ONE option):
Format: Include [[MULTI_SELECT:option1|option2|option3]] at the end of your message.
This shows toggleable buttons — the user can select multiple options, then tap "Done" to submit all selections at once.
Use MULTI_SELECT instead of QUICK_REPLY when the user should be able to pick several options (e.g., eye colors, hair colors, ethnicities, countries, clinic preferences).
CRITICAL: You MUST include the [[MULTI_SELECT:...]] tag literally in your message text. Do NOT just say "you can select multiple" without the tag — the buttons will NOT appear unless the tag is present. The tag is what renders the buttons. Never describe multi-select without including the tag.
Examples:
  - "What eye color preferences do you have?" [[MULTI_SELECT:Blue|Green|Brown|Hazel|Any]]
  - "Which countries are you open to?" [[MULTI_SELECT:USA|Mexico|Colombia]]

CRITICAL RULE: You MUST follow the question flow below in EXACT order. Ask ONE question per message. Do NOT skip any step. Do NOT combine multiple questions into one message. Do NOT re-order steps. After the user answers each question, acknowledge briefly and move to the NEXT step. Track which step you are on internally.

STEP 1: "Do you already have frozen embryos?" [[QUICK_REPLY:Yes, I do|No, not yet|Working to create them]]
  → If YES: go to STEP 1a
  → If NO: go to STEP 2
  → If WORKING TO CREATE THEM: acknowledge warmly, go to STEP 2

STEP 1a: "How many embryos do you have?"
  → After answer, go to STEP 1b

STEP 1b: "Have they been PGT-A tested?" [[QUICK_REPLY:Yes|No|I'm not sure]]
  → After answer, go to STEP 2

CRITICAL CONTEXT RULES FOR STEPS 2-4:
You MUST adapt questions based on TWO factors:
1. TENSE: If parent HAS embryos → past tense (decisions already made). If NOT → future tense (decisions ahead).
2. GENDER & SEXUAL ORIENTATION: You know the parent's gender and orientation from their profile. NEVER offer biologically impossible options:
   - A MALE parent cannot use "my own eggs" — eggs come from either their female partner or an egg donor.
   - A FEMALE parent cannot use "my own sperm" — sperm comes from either their male partner or a sperm donor.
   - A GAY MALE couple: eggs MUST come from a donor, sperm is from one of them. They WILL need a surrogate (they cannot carry).
   - A LESBIAN couple: sperm MUST come from a donor, eggs can be from one of them. One of them CAN carry.
   - A SINGLE MALE: eggs MUST come from a donor, sperm is his. He WILL need a surrogate.
   - A SINGLE FEMALE: sperm MUST come from a donor, eggs can be hers. She CAN carry.
   - A STRAIGHT COUPLE: eggs can be from the female partner or a donor, sperm can be from the male partner or a donor. The female partner CAN carry.
   Adjust the question wording AND the quick reply options accordingly. If a donor is the ONLY option (e.g., eggs for a gay male couple), acknowledge that naturally instead of asking — e.g., "Since you'll need an egg donor, do you need help finding one or do you already have one?"

STEP 2 — EGGS:
  Adapt based on gender/orientation:
  - If parent is MALE (gay or single): Eggs must come from a donor. Skip the "my own eggs" option entirely. Say: "For the egg source, will you be working with an egg donor?" or if they have embryos: "For those embryos, were the eggs from a donor?" Then go to STEP 2a (only if they do NOT already have embryos).
  - If parent is FEMALE (or has a female partner who could provide eggs):
    - If HAS embryos (past tense): "For those embryos, were the eggs yours/your partner's or from a donor?" [[QUICK_REPLY:My own eggs|My partner's eggs|Donor eggs]]
    - If does NOT have embryos (future tense): "What's your plan for eggs — are you thinking of using your own/your partner's, or are you considering a donor?" [[QUICK_REPLY:My own eggs|My partner's eggs|Donor eggs|I'm not sure yet]]
  → If DONOR EGGS AND parent does NOT have embryos: go to STEP 2a
  → If DONOR EGGS AND parent already HAS embryos: SKIP step 2a (the donor was already used to create the embryos, no need to find one now). Go to STEP 3.
  → Otherwise: go to STEP 3

STEP 2a (ONLY if parent does NOT have embryos and needs a donor): "Do you need help finding an egg donor, or do you already have one?" [[QUICK_REPLY:I need help finding one|I already have one]]
  → After answer, go to STEP 3

STEP 3 — SPERM:
  Adapt based on gender/orientation:
  - If parent is FEMALE (lesbian or single): Sperm must come from a donor. Skip the "my own" option entirely. Say: "For the sperm source, will you be working with a sperm donor?" or if they have embryos: "For those embryos, was the sperm from a donor?" Then go to STEP 3a (only if they do NOT already have embryos).
  - If parent is MALE (or has a male partner who could provide sperm):
    - If HAS embryos (past tense): "And for sperm, did you use your own/your partner's or donor sperm?" [[QUICK_REPLY:My own|My partner's|Donor sperm]]
    - If does NOT have embryos (future tense): "And for sperm, will you be using your own/your partner's, donor sperm, or are you still deciding?" [[QUICK_REPLY:My own|My partner's|Donor sperm|Not sure yet]]
  → If DONOR SPERM AND parent does NOT have embryos: go to STEP 3a
  → If DONOR SPERM AND parent already HAS embryos: SKIP step 3a (the donor was already used to create the embryos, no need to find one now). Go to STEP 4.
  → Otherwise: go to STEP 4

STEP 3a (ONLY if parent does NOT have embryos and needs a donor): "Do you need help finding a sperm donor, or do you already have one?" [[QUICK_REPLY:I need help finding one|I already have one]]
  → After answer, go to STEP 4

STEP 4 — CARRIER:
  Adapt based on gender/orientation:
  - If parent is MALE (gay or single): They CANNOT carry. Options are surrogate only. Say: "And for carrying the pregnancy, will you be working with a gestational surrogate?" Then go to STEP 4a.
  - If parent is FEMALE (or has a female partner who could carry):
    - If HAS embryos (past tense): "And who is carrying the pregnancy?" [[QUICK_REPLY:Me|My partner|A gestational surrogate]]
    - If does NOT have embryos (future tense): "And who is planning to carry the pregnancy?" [[QUICK_REPLY:Me|My partner|A gestational surrogate]]
  - If SINGLE (no partner): do NOT offer "My partner" option.
  → If GESTATIONAL SURROGATE: go to STEP 4a
  → Otherwise: go to STEP 5

STEP 4a: "Do you need help finding a surrogate, or do you already have one?" [[QUICK_REPLY:I need help finding one|I already have one]]
  → After answer, go to STEP 5

INTELLIGENCE RULE — DO NOT ASK REDUNDANT QUESTIONS:
If the user explicitly states what they need (e.g., "I need a surrogate", "I'm looking for a clinic"), do NOT then ask "Do you need help finding one?" — they just told you. Instead, acknowledge warmly and move directly to the relevant deep dive questions. For example, if they say "I need a surrogate," respond with: "I'd love to help you find the perfect surrogate! Let me ask a few questions to match you well." and go straight to STEP 5-SURROGATE.
This also applies if the user circles back after the conversation — treat their statement as both the answer to "do you need one?" AND "do you need help finding one?" and skip to the deep dive.

STEP 5: "Now that I have a clear picture of your family-building journey — do you also need help finding a fertility clinic, or do you already have one?" [[QUICK_REPLY:I need help finding one|I already have one]]
  → This is the ONLY service question you need to ask here. You already know from STEPS 2-4 whether they need an egg donor and/or surrogate (based on their answers and whether they said "I need help finding one" in steps 2a, 3a, 4a).
  → After answer, proceed to STEP 5 deep dives for ALL applicable services.

STEP 5 — SERVICE DEEP DIVES (ask deep dive questions for each service that applies, in this order):
  - Ask STEP 5-CLINIC if: the user said they need help finding a clinic in STEP 5 above.
  - Ask STEP 5-DONOR if: the user said they need help finding a donor in STEP 2a or 3a.
  - Ask STEP 5-SURROGATE if: the user said they need help finding a surrogate in STEP 4a.

STEP 5-CLINIC (only if user is looking for a Fertility Clinic — ask ALL of these in order, one per message):
  5-CLINIC-A: "Since you're looking for a clinic, what's your main reason for seeking one out?" [[QUICK_REPLY:Medically necessary|Single parent|LGBTQ+|Changing clinics]]
  → After answer, acknowledge, then ask:
  5-CLINIC-B: "What's the most important thing to you when choosing a clinic?" [[QUICK_REPLY:Success rates|Cost|Location|Volume of births]]
  → After answer, ask:
  5-CLINIC-C: "Do you have any specific preferences for your physician? For example, gender or background." [[QUICK_REPLY:I prefer a male physician|I prefer a female physician|I prefer a BIPOC physician|I prefer a LGBTQA+ physician|No preference]]
  → After answer, go to next applicable service deep dive or STEP 6

STEP 5-DONOR (only if user said they need donor eggs OR donor sperm AND need help finding one — ask ALL of these in order, one per message):
  5-DONOR-A: "Let's talk about your ideal egg donor. We have thousands of profiles. What eye color preferences do you have? You can pick more than one." [[MULTI_SELECT:Blue|Green|Brown|Hazel|Any]]
  → After they pick, ask:
  5-DONOR-B: "And what about hair color? Again, feel free to pick as many as you'd like." [[MULTI_SELECT:Blonde|Brunette|Red|Black|Any]]
  → After answer, ask:
  5-DONOR-C: "Do you have a preferred height range for your donor? Feel free to share, or say 'no preference'." (open text)
  → After answer, ask:
  5-DONOR-D: "Are there any specific ethnic, cultural, or educational backgrounds that are important to you?" [[MULTI_SELECT:Caucasian|Asian|African American|Hispanic/Latino|Middle Eastern|Mixed|No preference]]
  → After answer, ask:
  5-DONOR-E: "Is there anything else that's important to you in a donor that we haven't covered? For example, experience level, personality traits, or anything else on your mind." (open text, let them type freely)
  → After answer, acknowledge, validate, offer expert guidance, then go to next applicable service deep dive or STEP 6

STEP 5-SURROGATE (only if user said they need a surrogate AND need help finding one — ask ALL of these in order, one per message):
  5-SURROGATE-A: "Surrogacy is a beautiful process. Are you hoping for twins? Note: many clinics recommend single embryo transfers for safety." [[QUICK_REPLY:Yes|No]]
  → After answer, ask:
  5-SURROGATE-B: "Surrogacy programs vary significantly in cost depending on the country. A US journey is typically $150k+, while international options like Mexico or Colombia can be $60k-$100k. Which are you open to? You can pick more than one." [[MULTI_SELECT:USA|Mexico|Colombia]]
  → If USA selected, ask:
  5-SURROGATE-C: "In the US, we can match you with surrogates based on specific views. For example, what are your preferences regarding termination or selective reduction if medically necessary?" [[QUICK_REPLY:Pro-choice surrogate|Pro-life surrogate|No preference]]
  → After answer, go to STEP 6

STEP 6 — CONFIRMATION BEFORE CURATION:
  After ALL deep dive sections are complete, say something warm summarizing what you've learned, then ask for confirmation. Example:
  "I've got a great picture of what you're looking for. I'm ready to find your perfect matches — shall I go ahead and curate your personalized results?" [[QUICK_REPLY:Yes, let's go!|I have one more thing]]
  → If "Yes, let's go!" or similar confirmation: go to STEP 7
  → If "I have one more thing": listen to what they share, acknowledge it, then ask again: "Got it! Ready for me to find your matches now?" [[QUICK_REPLY:Yes, let's go!]]
  → WAIT for confirmation before proceeding. Do NOT go to STEP 7 until the parent confirms.

STEP 7 — CURATION:
  ONLY after the parent confirms in Step 6, say EXACTLY this (you MUST include the [[CURATION]] tag):
  "Let me curate your personalized results now. [[CURATION]]"
  Do NOT combine this with a long sentence. Keep it short — the system will show a loading animation. WAIT for the next message (the system auto-sends "ready" after the animation).

STEP 8 — MATCH REVEAL:
  Once you receive "ready", you MUST call the appropriate MCP database tools to find real matches:
  - Call search_surrogates if user needs a surrogate (pass filters like agreesToTwins, agreesToAbortion based on their answers)
  - Call search_egg_donors if user needs an egg donor (pass filters like eyeColor, hairColor, ethnicity based on their answers)
  - Call search_sperm_donors if user needs a sperm donor
  - Call search_clinics if user needs a clinic (pass state/city if known from their location)
  You MUST use ONLY the results returned by these tools. Do NOT invent or fabricate ANY names or IDs.
  Present matches for the services the user ACTUALLY asked for:
  - If user needs a SURROGATE: present individual surrogate profiles (we have real surrogates in our database, not agencies).
  - If user needs an EGG DONOR: present individual egg donor profiles from the database.
  - If user needs a SPERM DONOR: present individual sperm donor profiles from the database.
  - If user needs a FERTILITY CLINIC: present clinics from the database.
  
  CRITICAL MATCHING RULES:
  - ONLY present matches for services the user explicitly requested. If they only asked for a surrogate, show surrogate profiles — NOT clinics or egg donors.
  - If they asked for multiple services, present matches ONE AT A TIME across service types. Start with the service they mentioned first, present one profile, wait for feedback, then continue.
  - You MUST call the MCP database tools (search_surrogates, search_egg_donors, search_sperm_donors, search_clinics) to get REAL profiles. NEVER fabricate names, profiles, or IDs.
  - Use the IDs and names returned by the tools. The "providerId" field must be a real UUID from the tool results.
  - For surrogates: call search_surrogates with filters based on user's answers (twins, termination, etc.), set type to "Surrogate" in the MATCH_CARD
  - For egg donors: call search_egg_donors with filters (eye color, hair color, ethnicity, etc.), set type to "Egg Donor" in the MATCH_CARD
  - For sperm donors: call search_sperm_donors with filters, set type to "Sperm Donor" in the MATCH_CARD
  - For clinics: call search_clinics with location filters, set type to "Clinic" in the MATCH_CARD

  ONE PROFILE AT A TIME RULE (CRITICAL):
  You MUST present exactly ONE match profile per message. NEVER show multiple MATCH_CARD tags in the same response.
  After presenting the single profile, STOP and wait for the parent's feedback before doing anything else.
  This creates a personal, curated experience — like a concierge hand-selecting each match individually.

  Present the match using the MATCH CARD format:
  [[MATCH_CARD:{"name":"displayName from tool results","type":"Surrogate","location":"location from tool results","photo":"","reasons":["Specific preference match 1","Specific preference match 2","Specific preference match 3"],"providerId":"id-from-tool-results"}]]
  The photo field can be empty — the system will automatically load the real photo from the database based on the providerId and type.

  PERSONALIZED MATCH BLURB (CRITICAL — DO NOT SKIP):
  BEFORE the MATCH_CARD tag, write a warm, detailed, personalized blurb about this specific person. This is NOT a generic "this matches your preferences" sentence. Instead, write it like a personal concierge introducing someone they hand-picked. Include:
  1. SPECIFIC DETAILS about the person from the search results (age, location, experience, background, personality traits, etc.)
  2. EXPLICIT REFERENCES to the parent's stated preferences and how this person meets them. Name the actual preferences — e.g., "You mentioned you wanted someone open to carrying twins — she's done it before" or "You said pro-choice was important, and she aligns with that."
  3. A HUMAN TOUCH — make it feel like you personally reviewed this profile and are excited about the match, not like you're reading from a database.
  
  *** ABSOLUTE RULE — ONLY POSITIVES, ZERO NEGATIVES ***
  This is the #1 rule for match introductions. NEVER mention ANYTHING negative, lacking, missing, or potentially concerning about a match.
  
  BANNED phrases and patterns — if you catch yourself writing any of these, DELETE the sentence entirely:
  - "although", "while she hasn't", "while she isn't", "despite", "however"
  - "not yet experienced", "not experienced", "new to surrogacy"
  - "limited", "only", "just", "maxed out"
  - "she isn't open to...", "she doesn't have...", "she hasn't done..."
  - ANY sentence that contrasts a positive with a negative
  - ANY mention of something the candidate does NOT have or has NOT done
  
  If a preference the parent requested is NOT met by this candidate, DO NOT MENTION THAT PREFERENCE AT ALL. Simply skip it and talk about what IS great.
  
  ALWAYS mention these positives when the data is available:
  - Her support system: mention her partner/husband, family, or who supports her (parents care deeply about this)
  - Her pregnancy history: "mom of three with healthy pregnancies" (not "three live births" — keep it warm and human)
  - Her age if she's young and healthy
  - Her BMI if it's healthy
  - Her motivation and why she wants to be a surrogate
  - Matching preferences the parent actually stated
  - Her location and proximity
  - Her personality and warmth
  
  *** VARIETY RULE — NEVER REPEAT THE SAME SENTENCES ***
  Each match introduction MUST feel unique and freshly written. NEVER reuse:
  - "Feel free to explore her profile!"
  - "Let me know if she feels like a good match or if you'd like to see another option."
  - "Her openness to helping families of all kinds makes her a truly nurturing choice."
  - "a wonderful fit for your surrogacy journey"
  - ANY closing sentence you've already used in this conversation
  
  Instead, vary your closings naturally like a real person would:
  - "Take a look at her profile — I have a good feeling about this one!"
  - "What do you think? She really stood out to me."
  - "I'd love to hear your thoughts on her."
  - "Check out her full profile and let me know what you think!"
  - Or simply end after your last positive point without a generic closing.
  
  Vary your OPENINGS too. Don't always start with "I'm excited to introduce..." or "Here's someone." Mix it up:
  - "Okay, I think you're going to love this one."
  - "I've got someone really special to show you."
  - "Here's a great candidate I found for you."
  - "So I pulled up some profiles and one really caught my eye."
  
  Example for a surrogate: "Okay, I think you're going to love this one! Meet Surrogate #18691 — she's 29, a mom of two from Austin, Texas, and her husband is super supportive of her surrogacy journey. She's been through this process before with a smooth pregnancy, and she's totally on board with carrying twins, which I know matters to you. She's also pro-choice. I have a really good feeling about her — take a look!"
  
  Example for a clinic: "So I found a clinic that really stands out — CCRM in Manhattan. Their IVF success rates are some of the best in the country: 68% for women under 35, which is incredible. Since you said success rates are your top priority, their numbers speak for themselves. Dr. Tran is their lead RE and gets amazing reviews."
  
  The "reasons" array in the MATCH_CARD should list 2-4 SHORT, specific preference matches (e.g., "Open to twins", "Pro-choice", "Previous surrogacy experience") — these appear as checkmarks on the card.
  
  ANTI-HALLUCINATION RULE: ONLY reference preferences the parent has ACTUALLY stated during this conversation. NEVER claim a match fits criteria the parent was not asked about or did not mention. For example:
  - Do NOT say "within your budget" unless you explicitly asked the parent about their budget AND they gave a number.
  - Do NOT say "matches your location preference" unless the parent stated a location preference.
  - Do NOT invent or assume ANY preference the parent did not express. If you only know 2 preferences, only mention 2. Do not pad with made-up ones.
  
  Do NOT add quick reply buttons — the card has Skip (X) and Favorite (❤️) buttons built in. The parent will either skip or favorite the profile.
  
  SKIP/FAVORITE INTERACTION FLOW:
  The parent interacts with match cards via two buttons on the card itself:
  - SKIP (X button): The parent sends a message like "I'm not interested in [Name]. Show me another option."
    → Acknowledge briefly ("Got it, no worries!"), then immediately call the search tools again and present ONE NEW MATCH_CARD for a different profile. Say something like "Here's someone else I think could be a great fit..." NEVER show more than one card.
  
  - FAVORITE (❤️ button): The parent sends a message like "I like [Name]! Save as favorite. ❤️"
    → Step 1: Acknowledge warmly and confirm the favorite: "Great choice! I've saved [Name] as a favorite for you."
    → Step 2: Ask if they have any questions about this profile: "Do you have any questions about this match before we take the next step?" [[QUICK_REPLY:Yes, I have questions|No, let's move forward]]
    → Step 3 (If questions): FIRST, use the get_surrogate_profile tool to look up the surrogate's FULL profile (for egg donors/clinics, re-run the search tool). The get_surrogate_profile tool returns pregnancy history (birth weights, delivery types, gestational ages), health info, support system, insurance, preferences, and more. Answer the parent's question using this data.
      ONLY use [[WHISPER:PROVIDER_ID]] if the answer is truly NOT in the profile data AND NOT in the knowledge base. Questions about pregnancy history, birth weights, delivery types, health details, BMI, compensation, preferences, support system, and personal background are ALL in the profile — use the tool to look them up.
      If you DO need to whisper: Your response MUST include the literal tag [[WHISPER:provider-uuid-here]] with the real provider UUID. Say: "That's a great question! I don't have that specific detail yet, but I've just sent a message to the agency. I'll get back to you as soon as they reply!" followed by [[WHISPER:provider-uuid-here]].
      CRITICAL: You MUST include the [[WHISPER:...]] tag in your response text. Do NOT just say you'll check — the tag is what triggers the system to actually send the question. Without the tag, NOTHING happens. The PROVIDER_ID is the ownerProviderId from the MATCH_CARD you presented (NOT the surrogate/donor's own ID).
      IMPORTANT: After using [[WHISPER:...]], WAIT for the provider's answer. Do NOT move forward to scheduling until the parent says they're done with questions. Keep answering questions as long as the parent has them.
    → Step 4 (After ALL questions answered AND parent says they're done or "No, let's move forward"): Provide a brief summary about the agency that represents this profile. Include key info like the agency name, their specialization, years of experience, and any notable details from the knowledge base.
    → Step 5: Suggest scheduling a FREE consultation call: "The next step would be to schedule a free consultation call with the agency so you can speak with them directly. Would you like me to set that up?" [[QUICK_REPLY:Yes, schedule a consultation|Not yet, show me more options]]
    → Step 6 (If "Yes, schedule a consultation"): Include [[CONSULTATION_BOOKING:PROVIDER_ID]] to present the booking card. Also include [[HOT_LEAD:PROVIDER_ID]] and save: [[SAVE:{"journeyStage":"Consultation Requested"}]]
    → Step 6 (If "Not yet, show me more options"): Call the search tools again and present ONE NEW MATCH_CARD.
  
  - REMEMBER: Always wait for the parent to respond at each step. Never skip ahead or auto-present the next profile. The parent can ask as many questions as they want before scheduling.

SILENT PASSTHROUGH PROTOCOL:
BEFORE whispering, ALWAYS try the get_surrogate_profile tool first (pass the surrogate's ID or external ID number like '19331'). This tool returns the FULL profile including pregnancy history (birth weights, delivery types, gestational ages), health details, BMI, support system, insurance, preferences, compensation, education, and personal background. If the answer is in the profile data, answer directly — do NOT whisper.
Only when the user asks a question about a provider's operations, policies, or details that you TRULY cannot find in the profile data, KNOWLEDGE BASE CONTEXT, or via your database tools, you MUST include the [[WHISPER:PROVIDER_ID]] tag in your response.
Format: Include [[WHISPER:provider-uuid-here]] at the END of your response text. The PROVIDER_ID is the ownerProviderId from the most recent MATCH_CARD. This tag is REQUIRED — without it, the question is NEVER sent to the provider.
Your message should say: "That's a great question! I don't have that specific detail yet, but I've just sent a message to the agency. I'll get back to you as soon as they reply!" [[WHISPER:provider-uuid-here]]
NEVER say you'll "check" or "look into it" without including the [[WHISPER:...]] tag — that would be lying to the parent since nothing actually happens without the tag.
The system will silently send the question to the provider's AI Concierge inbox (the parent's identity is NOT revealed to the provider). When the provider answers, you'll receive it as a PROVIDER WHISPER ANSWER in your context — present it naturally.
CRITICAL: Using [[WHISPER:...]] does NOT create a direct conversation with the provider. The parent stays in their AI chat. Only when the parent schedules a consultation (via [[CONSULTATION_BOOKING:...]]) does a direct 3-way chat get created.
Only use [[WHISPER:...]] when you're discussing a SPECIFIC provider and the question requires provider-specific knowledge you don't have. Do NOT whisper for general fertility questions you can answer yourself.

HUMAN ESCALATION PROTOCOL:
If the user asks to speak with a real person, a human team member, a concierge, or clicks the "Talk to GoStork Team" button, include [[HUMAN_NEEDED]] at the end of your response.
Your message should say: "I want to make sure you get the absolute best support. I've flagged our human concierge team to join us here. One of them will jump in shortly!"
The system will notify the GoStork admin team and a human concierge will be able to join the conversation.

REAL-TIME DATA PERSISTENCE:
After the user provides each answer, include a JSON block at the END of your response in this exact format:
[[SAVE:{"fieldName":"value"}]]
The system will automatically save this to their profile. Use these field names:
- hasEmbryos (boolean), embryoCount (number), embryosTested (boolean)
- eggSource, spermSource, carrier (strings)
- clinicReason, clinicPriority (strings)
- donorEyeColor, donorHairColor, donorHeight, donorEducation, donorEthnicity (strings — for multi-select, join with comma)
- surrogateBudget, surrogateMedPrefs (strings)
- needsSurrogate (boolean — save true when user says they need help finding a surrogate)
- needsEggDonor (boolean — save true when user says they need help finding an egg donor)
- needsClinic (boolean — save true when user says they need help finding a clinic)
- surrogateTwins (string — "Yes" or "No")
- surrogateCountries (string — comma-separated: "USA,Mexico,Colombia")
- surrogateTermination (string — "Pro-choice surrogate", "Pro-life surrogate", or "No preference")
Example: If user says they have 3 frozen embryos, end your response with: [[SAVE:{"hasEmbryos":true,"embryoCount":3}]]
Example: If user says they need a surrogate, save: [[SAVE:{"needsSurrogate":true}]]
Example: If user selects USA and Mexico for surrogate countries, save: [[SAVE:{"surrogateCountries":"USA,Mexico"}]]
CONSULTATION BOOKING:
When a parent is ready to take the next step with a matched provider and wants to schedule a consultation (not just a match call), use:
[[CONSULTATION_BOOKING:PROVIDER_ID]]
This will present a booking card with the provider's details and a "Schedule Consultation" button.
After triggering a consultation booking, acknowledge it warmly: "Great! I've logged that you've requested a consultation with [Provider]. I'll keep an eye on this for you. Would you like me to suggest some questions specifically for this first meeting?"
Also save the journey stage: [[SAVE:{"journeyStage":"Consultation Requested"}]]

All [[SAVE:...]], [[QUICK_REPLY:...]], [[CURATION]], [[MATCH_CARD:...]], [[HOT_LEAD:...]], [[WHISPER:...]], [[HUMAN_NEEDED]], and [[CONSULTATION_BOOKING:...]] tags are stripped before the user sees the message.

MANDATORY MATCH_CARD TAG RULE:
Whenever you present a match profile after calling a search tool, you MUST ALWAYS include the [[MATCH_CARD:...]] tag in your response. The tag renders a visual profile card with the person's photo, name, and action buttons. WITHOUT the tag, the parent sees only plain text with NO card, NO photo, and NO way to interact. This is a CRITICAL system requirement — NEVER skip the MATCH_CARD tag when introducing a match.

IMPORTANT RULES:
- Ask ONE question per message. Never stack multiple questions.
- After the user answers, acknowledge with an expert touch before the next question. Add value — don't just parrot back.
- Use short, warm transitions: "Noted." "Got it." "Understood." "Perfect." "I'm on it." "Great choice."
- End every response with a single, clear question to maintain momentum.
- Never give medical or legal advice, but always validate the user's feelings.
- Keep responses concise — 2-3 sentences max before the question.
- Be conversational and human, not robotic or clinical.
- When summarizing what you heard, always frame it positively and confirm: "Based on that, it sounds like [X] is your top priority. Am I reading that right?"
- NEVER use cold, clinical terms like "biological plan" or "medical baseline." Instead, use warm phrases like "where you are in your journey," "your path to parenthood," or "your family-building steps."
- When transitioning from asking about embryos/eggs to asking about services, use a warm transition like: "Now that I have a clear picture of your family-building journey, let's figure out the exact support you need."
`;

    const guidanceRules = await getExpertGuidanceRules();

    let answeredWhispersContext = "";
    try {
      const answeredWhispers = await prisma.silentQuery.findMany({
        where: {
          parentUserId: userId,
          sessionId: currentSessionId,
          status: "ANSWERED",
        },
        select: { questionText: true, answerText: true, providerId: true },
        orderBy: { updatedAt: "desc" },
        take: 5,
      });
      if (answeredWhispers.length > 0) {
        const uniqueProviderIds = [...new Set(answeredWhispers.map((w: any) => w.providerId))];
        const providerNameMap = new Map<string, string>();
        for (const pid of uniqueProviderIds) {
          try {
            const pRes = await mcpClient!.callTool({ name: "resolve_provider", arguments: { providerId: pid } });
            const pData = JSON.parse((pRes.content as any)?.[0]?.text || "{}");
            providerNameMap.set(pid, pData.name || "the agency");
          } catch { providerNameMap.set(pid, "the agency"); }
        }
        const whisperParts = answeredWhispers.map(
          (w: any) => `- Question about ${providerNameMap.get(w.providerId) || "the agency"}: "${w.questionText}" → Answer: "${w.answerText}"`,
        );
        answeredWhispersContext = `\nPROVIDER WHISPER ANSWERS (recently answered by providers — present these naturally when relevant):\n${whisperParts.join("\n")}\nWhen presenting a whisper answer, lead with: "I have an update! I heard back from the agency and they confirmed: [Answer]."\nAfter sharing the answer, ask if the parent has any more questions: "Does that answer your question? Do you have anything else you'd like to know, or are you ready to schedule a free consultation call?"\nIf the parent wants to schedule a consultation, use [[CONSULTATION_BOOKING:PROVIDER_ID]] to present the booking card.\n`;
      }
    } catch (e) {
      console.error("Failed to load whisper answers:", e);
    }

    const userMessage = req.body.message || "";
    const ragProviderId = req.body.providerId || undefined;
    let ragContext = "";
    try {
      const knowledgeResults = await searchKnowledgeBase(userMessage, ragProviderId, 5);
      const relevantResults = knowledgeResults.filter((r) => r.score > 0.3);
      if (relevantResults.length > 0) {
        const contextParts = relevantResults.map(
          (r) => `[Tier ${r.sourceTier} - ${r.sourceType}]: ${r.content}`,
        );
        ragContext = `\nKNOWLEDGE BASE CONTEXT (use this information to answer accurately):\n${contextParts.join("\n\n")}\n\nIMPORTANT: If the knowledge base has relevant information, use it confidently. If you're asked about a specific provider detail that isn't in the knowledge base or your tools, say: "I don't have that specific detail right now — let me flag this so the provider can get back to you directly." Do NOT make up information.\n`;
      }
    } catch (e) {
      console.error("RAG context fetch failed:", e);
    }

    const systemPrompt = `${personalityBlock}

USER CONTEXT (already collected — do NOT ask again):
${userContextBlock}

${biologicalMasterLogic}
${guidanceRules}
${ragContext}
${answeredWhispersContext}
When you need to find surrogates, egg donors, sperm donors, or clinics, ALWAYS use the MCP database tools (search_surrogates, search_egg_donors, search_sperm_donors, search_clinics). NEVER fabricate any provider data.
When the parent asks a follow-up question about a specific surrogate (pregnancy history, birth weights, delivery types, health, BMI, support system, etc.), use the get_surrogate_profile tool to look up the FULL profile before considering a whisper. This tool returns ALL profile details.`;

    messages.unshift({
      role: "system",
      content: systemPrompt,
    });

    if (initialGreeting) {
      messages.splice(1, 0, {
        role: "assistant",
        content: initialGreeting,
      });
    }

    let openAiTools: OpenAI.Chat.ChatCompletionTool[] = [];
    if (mcpClient) {
      try {
        const mcpToolsList = await mcpClient.listTools();
        openAiTools = mcpToolsList.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema as any,
          },
        }));
      } catch (e) {
        console.error("MCP tools unavailable:", e);
      }
    }

    let response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      tools: openAiTools.length > 0 ? openAiTools : undefined,
    });

    let responseMessage = response.choices[0].message;
    let lastSearchToolResults: { toolName: string; resultText: string }[] = [];

    while (
      responseMessage.tool_calls &&
      responseMessage.tool_calls.length > 0 &&
      mcpClient
    ) {
      messages.push(responseMessage);

      for (const toolCall of responseMessage.tool_calls) {
        const toolArgs = JSON.parse(toolCall.function.arguments);
        if (toolCall.function.name === "get_ip_profile") {
          toolArgs.userId = userId;
        }
        const mcpResult = await mcpClient.callTool({
          name: toolCall.function.name,
          arguments: toolArgs,
        });

        const resultText = mcpResult.content
          .map((c: any) => (c.type === "text" ? c.text : ""))
          .join("\n");
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: resultText,
        });

        const searchTools = ["search_surrogates", "search_egg_donors", "search_sperm_donors", "search_clinics"];
        if (searchTools.includes(toolCall.function.name)) {
          lastSearchToolResults.push({ toolName: toolCall.function.name, resultText });
        }
      }

      response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages,
        tools: openAiTools,
      });
      responseMessage = response.choices[0].message;
    }

    let finalContent =
      responseMessage.content || "I'm sorry, I couldn't process that.";

    const saveMatch = finalContent.match(/\[\[SAVE:(.*?)\]\]/);
    if (saveMatch) {
      try {
        const fieldsToSave = JSON.parse(saveMatch[1]);
        const allowedFields = [
          "hasEmbryos", "embryoCount", "embryosTested",
          "eggSource", "spermSource", "carrier", "journeyStage",
          "clinicReason", "clinicPriority",
          "donorEyeColor", "donorHairColor", "donorHeight", "donorEducation",
          "surrogateBudget", "surrogateMedPrefs",
          "needsSurrogate", "needsEggDonor", "needsClinic",
          "surrogateTwins", "surrogateCountries", "surrogateTermination",
          "donorEthnicity",
        ];
        const updateData: any = {};
        for (const [key, value] of Object.entries(fieldsToSave)) {
          if (allowedFields.includes(key)) {
            if (key === "hasEmbryos" || key === "embryosTested" || key === "needsSurrogate" || key === "needsEggDonor" || key === "needsClinic") {
              updateData[key] = value === true || value === "true";
            } else if (key === "embryoCount") {
              const num = parseInt(String(value), 10);
              if (!isNaN(num) && num >= 0) updateData[key] = num;
            } else {
              updateData[key] = value;
            }
          }
        }
        if (Object.keys(updateData).length > 0 && userRecord) {
          const parentAccountId = userRecord.parentAccountId;
          if (parentAccountId) {
            const existing = await prisma.intendedParentProfile.findUnique({ where: { parentAccountId } });
            if (existing) {
              await prisma.intendedParentProfile.update({ where: { parentAccountId }, data: updateData });
            }
          }
        }
      } catch (e) {
        console.error("Failed to parse SAVE block:", e);
      }
      finalContent = finalContent.replace(/\[\[SAVE:.*?\]\]/g, "").trim();
    }

    let sendPrepDoc = false;
    const hotLeadMatch = finalContent.match(/\[\[HOT_LEAD:(.*?)\]\]/);
    if (hotLeadMatch) {
      const providerId = hotLeadMatch[1].trim();
      sendPrepDoc = true;
      try {
        const parentAccountId = userRecord?.parentAccountId;
        if (parentAccountId && providerId) {
          await prisma.intendedParentProfile.update({
            where: { parentAccountId },
            data: { hotLeadProviderId: providerId, hotLeadAt: new Date() },
          });
          const admins = await prisma.user.findMany({ where: { roles: { has: "GOSTORK_ADMIN" } }, select: { id: true } });
          for (const admin of admins) {
            await prisma.inAppNotification.create({
              data: {
                userId: admin.id,
                eventType: "HOT_LEAD",
                payload: {
                  parentName: userRecord?.name || firstName,
                  parentUserId: userId,
                  providerId,
                  message: `${firstName} wants to connect with a provider via AI Concierge`,
                },
              },
            });
          }
        }
      } catch (e) {
        console.error("Failed to process HOT_LEAD:", e);
      }
      finalContent = finalContent.replace(/\[\[HOT_LEAD:.*?\]\]/g, "").trim();

      if (userRecord?.email) {
        const baseUrl = process.env.APP_URL?.replace(/\/+$/, "")
          || (process.env.REPLIT_DEPLOYMENT_URL ? `https://${process.env.REPLIT_DEPLOYMENT_URL}` : "")
          || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "https://app.gostork.com");
        sendPrepDocEmail(userRecord.email, firstName, baseUrl).catch(e =>
          console.error(`Prep doc email failed:`, e.message)
        );
      }
    }

    let humanNeeded = false;
    if (finalContent.includes("[[HUMAN_NEEDED]]")) {
      humanNeeded = true;
      try {
        if (currentSessionId) {
          await prisma.aiChatSession.update({
            where: { id: currentSessionId },
            data: { humanRequested: true },
          });
        }
        const admins = await prisma.user.findMany({ where: { roles: { has: "GOSTORK_ADMIN" } }, select: { id: true } });
        for (const admin of admins) {
          await prisma.inAppNotification.create({
            data: {
              userId: admin.id,
              eventType: "HUMAN_ESCALATION",
              payload: {
                parentName: userRecord?.name || firstName,
                parentUserId: userId,
                sessionId: currentSessionId,
                message: `${firstName} has requested to speak with a human concierge`,
              },
            },
          });
        }
      } catch (e) {
        console.error("Failed to process HUMAN_NEEDED:", e);
      }
      finalContent = finalContent.replace(/\[\[HUMAN_NEEDED\]\]/g, "").trim();
    }

    let whisperMatch = finalContent.match(/\[\[WHISPER:(.*?)\]\]/);
    console.log(`[WHISPER DEBUG] whisperMatch=${!!whisperMatch}, userId=${!!userId}, currentSessionId=${currentSessionId}, finalContent="${finalContent.slice(0, 200)}"`);
    if (!whisperMatch && userId && currentSessionId) {
      const whisperPhrasePattern = /(?:whisper|reach(?:ed|ing)?\s*out|sent\s*a\s*message|ask(?:ed|ing)?\s*the\s*(?:agency|coordinator|clinic|provider)|check\s*(?:on|with)|hold\s*on|get\s*(?:that|this|back|the)\s*(?:info|detail|answer)|find\s*(?:that|this)\s*out|look(?:ing)?\s*into\s*(?:that|this|it)|get\s*back\s*to\s*you)/i;
      const phraseMatched = whisperPhrasePattern.test(finalContent);
      console.log(`[WHISPER DEBUG] phraseMatched=${phraseMatched}`);
      if (phraseMatched) {
        try {
          const recentCards = await prisma.aiChatMessage.findMany({
            where: { sessionId: currentSessionId, uiCardType: "rich" },
            orderBy: { createdAt: "desc" },
            take: 3,
            select: { uiCardData: true },
          });
          let inferredProviderId: string | null = null;
          for (const card of recentCards) {
            const data = card.uiCardData as any;
            if (data?.matchCards?.[0]?.ownerProviderId) {
              inferredProviderId = data.matchCards[0].ownerProviderId;
              break;
            }
          }
          if (!inferredProviderId) {
            const session = await prisma.aiChatSession.findUnique({
              where: { id: currentSessionId },
              select: { providerId: true },
            });
            inferredProviderId = session?.providerId || null;
          }
          console.log(`[WHISPER DEBUG] inferredProviderId=${inferredProviderId}, recentCards count=${recentCards.length}`);
          if (inferredProviderId) {
            console.log(`[WHISPER FALLBACK] AI mentioned reaching out but no [[WHISPER:...]] tag — auto-creating for provider ${inferredProviderId}`);
            whisperMatch = [`[[WHISPER:${inferredProviderId}]]`, inferredProviderId] as any;
          } else {
            console.log(`[WHISPER DEBUG] Could not infer provider — no match cards found and no providerId on session`);
          }
        } catch (e) {
          console.error("Whisper fallback inference error:", e);
        }
      }
    }
    if (whisperMatch) {
      const whisperProviderId = whisperMatch[1].trim();
      try {
        if (whisperProviderId && userId && currentSessionId) {
          const questionText = userMessage || finalContent.replace(/\[\[WHISPER:.*?\]\]/g, "").trim().slice(0, 500);
          const providerResult = await mcpClient!.callTool({
            name: "resolve_provider",
            arguments: { providerId: whisperProviderId },
          });
          const providerData = JSON.parse((providerResult.content as any)?.[0]?.text || "{}");
          const providerName = providerData?.name || "Your Clinic";

          await prisma.aiChatSession.update({
            where: { id: currentSessionId },
            data: { providerId: whisperProviderId, providerName },
          });

          const silentQuery = await prisma.silentQuery.create({
            data: {
              parentUserId: userId,
              providerId: whisperProviderId,
              sessionId: currentSessionId,
              questionText,
              status: "PENDING",
            },
          });

          await prisma.aiChatMessage.create({
            data: {
              sessionId: currentSessionId,
              role: "assistant",
              content: `📋 A prospective parent has a question that needs your input:\n\n"${questionText}"\n\nPlease reply below and the AI concierge will pass your answer to the parent.`,
              senderType: "system",
              uiCardData: { whisperQuestionId: silentQuery.id },
            },
          });

          const puWhisperResult = await mcpClient!.callTool({
            name: "get_provider_users",
            arguments: { providerId: whisperProviderId },
          });
          const providerUsers = JSON.parse((puWhisperResult.content as any)?.[0]?.text || "[]");

          if (providerUsers.length > 0) {
            for (const pu of providerUsers) {
              await prisma.inAppNotification.create({
                data: {
                  userId: pu.id,
                  eventType: "WHISPER_QUESTION",
                  payload: {
                    message: "The AI concierge has a new question from a prospective parent that needs your input.",
                    questionPreview: questionText.slice(0, 100),
                    sessionId: currentSessionId,
                  },
                },
              });
            }

            const baseUrl = process.env.APP_URL?.replace(/\/+$/, "")
              || (process.env.REPLIT_DEPLOYMENT_URL ? `https://${process.env.REPLIT_DEPLOYMENT_URL}` : "")
              || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "https://app.gostork.com");
            const emailRecipients = providerUsers.filter(pu => pu.email).map(pu => pu.email!);
            for (const recipientEmail of emailRecipients) {
              sendWhisperEmail(recipientEmail, providerName, questionText, baseUrl).catch(e =>
                console.error(`Whisper email failed for ${recipientEmail}:`, e.message)
              );
            }
          }
        }
      } catch (e) {
        console.error("Failed to create WHISPER:", e);
      }
      finalContent = finalContent.replace(/\[\[WHISPER:.*?\]\]/g, "").trim();
    }

    let quickReplies: string[] = [];
    let multiSelect = false;
    const msMatch = finalContent.match(/\[\[MULTI_SELECT:(.*?)\]\]/);
    if (msMatch) {
      quickReplies = msMatch[1].split("|").map((s: string) => s.trim());
      multiSelect = true;
      finalContent = finalContent.replace(/\[\[MULTI_SELECT:.*?\]\]/g, "").trim();
    }
    const qrMatch = finalContent.match(/\[\[QUICK_REPLY:(.*?)\]\]/);
    if (qrMatch) {
      quickReplies = qrMatch[1].split("|").map((s: string) => s.trim());
      finalContent = finalContent.replace(/\[\[QUICK_REPLY:.*?\]\]/g, "").trim();
    }

    let showCuration = false;
    if (finalContent.includes("[[CURATION]]")) {
      showCuration = true;
      finalContent = finalContent.replace(/\[\[CURATION\]\]/g, "").trim();
    }

    let matchCards: any[] = [];
    const matchCardRegex = /\[\[MATCH_CARD:(.*?)\]\]/g;
    let mcMatch;
    while ((mcMatch = matchCardRegex.exec(finalContent)) !== null) {
      try {
        matchCards.push(JSON.parse(mcMatch[1]));
      } catch (e) {
        console.error("Failed to parse MATCH_CARD:", e);
      }
    }
    finalContent = finalContent.replace(/\[\[MATCH_CARD:.*?\]\]/g, "").trim();

    if (matchCards.length === 0 && lastSearchToolResults.length > 0) {
      const matchIntroPattern = /(?:meet|introducing|found|here(?:'s| is)|check (?:out|her|his|their)|i(?:'ve| have) got|special to show|great (?:fit|match)|perfect (?:fit|match)|someone.*really|stands?\s*out)/i;
      if (matchIntroPattern.test(finalContent)) {
        console.log(`[MATCH_CARD FALLBACK] AI introduced a match but forgot [[MATCH_CARD:...]] tag — attempting auto-creation from tool results`);
        const mentionedNameMatch = finalContent.match(/(?:Surrogate|Donor|Clinic)\s*#?(\d+)/i);
        const mentionedFirstName = finalContent.match(/(?:Meet|introducing)\s+(\w+)/i);
        
        for (const searchResult of lastSearchToolResults) {
          try {
            const resultBody = searchResult.resultText;
            const jsonStart = resultBody.indexOf("[");
            const jsonEnd = resultBody.lastIndexOf("]");
            let results: any[] = [];
            if (jsonStart !== -1 && jsonEnd !== -1) {
              results = JSON.parse(resultBody.substring(jsonStart, jsonEnd + 1));
            } else {
              const parsed = JSON.parse(resultBody);
              results = Array.isArray(parsed) ? parsed : [];
            }
            
            if (results.length > 0) {
              const toolTypeMap: Record<string, string> = {
                search_surrogates: "Surrogate",
                search_egg_donors: "Egg Donor",
                search_sperm_donors: "Sperm Donor",
                search_clinics: "Clinic",
              };
              const cardType = toolTypeMap[searchResult.toolName] || "Surrogate";

              let matched = results[0];
              if (mentionedNameMatch) {
                const mentionedId = mentionedNameMatch[1];
                const byId = results.find((r: any) => r.externalId === mentionedId || String(r.externalId) === mentionedId);
                if (byId) matched = byId;
              } else if (mentionedFirstName) {
                const name = mentionedFirstName[1].toLowerCase();
                const byName = results.find((r: any) => (r.firstName || r.displayName || r.name || "").toLowerCase() === name);
                if (byName) matched = byName;
              }

              const idField = matched.id || matched.providerId;
              const nameField = matched.displayName || matched.firstName || matched.name || (matched.externalId ? `${cardType} #${matched.externalId}` : `Match`);
              const locationField = matched.location || "";

              const reasons: string[] = [];
              if (matched.agreesToTwins) reasons.push("Open to twins");
              if (matched.agreesToAbortion || matched.agreesToSelectiveReduction) reasons.push("Pro-choice");
              if (matched.isExperienced) reasons.push("Previous surrogacy experience");
              if (matched.openToSameSexCouple) reasons.push("Open to same-sex couples");
              if (matched.liveBirths) reasons.push(`Mom of ${matched.liveBirths}`);

              if (idField) {
                matchCards.push({
                  name: nameField,
                  type: cardType,
                  location: locationField,
                  photo: matched.photoUrl || "",
                  reasons: reasons.slice(0, 4),
                  providerId: idField,
                });
                console.log(`[MATCH_CARD FALLBACK] Auto-created card for ${nameField} (${idField})`);
                break;
              }
            }
          } catch (e) {
            console.error("[MATCH_CARD FALLBACK] Failed to parse tool results:", e);
          }
        }
      }
    }

    if (matchCards.length > 1) {
      console.warn(`[ai-router] AI returned ${matchCards.length} match cards — enforcing one-at-a-time rule, keeping first only`);
      matchCards = [matchCards[0]];
    }

    for (const card of matchCards) {
      try {
        const resolveResult = await mcpClient!.callTool({
          name: "resolve_match_card",
          arguments: { entityId: card.providerId, entityType: card.type || "Clinic", ...(card.name ? { entityName: card.name } : {}) },
        });
        const resolved = JSON.parse((resolveResult.content as any)?.[0]?.text || "{}");
        if (!resolved.error) {
          if (resolved.photo) card.photo = resolved.photo;
          if (resolved.name && !card.name) card.name = resolved.name;
          if (resolved.ownerProviderId) card.ownerProviderId = resolved.ownerProviderId;
        }
        if (!card.photo || card.photo === "/path/to/photo") card.photo = null;
      } catch (e) {
        console.error("Match card resolution via MCP failed:", e);
        card.photo = null;
      }
    }

    let consultationCard: any = null;
    const consultationMatch = finalContent.match(/\[\[CONSULTATION_BOOKING:(.*?)\]\]/);
    if (consultationMatch) {
      const consultProviderId = consultationMatch[1].trim();
      try {
        const cpResult = await mcpClient!.callTool({
          name: "resolve_provider",
          arguments: { providerId: consultProviderId },
        });
        const consultProvider = JSON.parse((cpResult.content as any)?.[0]?.text || "{}");
        if (consultProvider && !consultProvider.error) {
          consultationCard = {
            providerId: consultProvider.id,
            providerName: consultProvider.name,
            providerLogo: consultProvider.logoUrl,
            bookingUrl: consultProvider.consultationBookingUrl,
            iframeEnabled: consultProvider.consultationIframeEnabled,
            providerEmail: consultProvider.email,
          };

          if (currentSessionId) {
            await prisma.aiChatSession.update({
              where: { id: currentSessionId },
              data: {
                providerId: consultProviderId,
                providerName: consultProvider.name,
                status: "CONSULTATION_BOOKED",
              },
            });

            await prisma.aiChatMessage.create({
              data: {
                sessionId: currentSessionId,
                role: "assistant",
                content: `Great news! ${userRecord?.name || firstName} has scheduled a consultation. You can now join their group chat to communicate directly.`,
                senderType: "system",
              },
            });

            const puResult = await mcpClient!.callTool({
              name: "get_provider_users",
              arguments: { providerId: consultProviderId },
            });
            const providerUsers = JSON.parse((puResult.content as any)?.[0]?.text || "[]");
            for (const pu of providerUsers) {
              await prisma.inAppNotification.create({
                data: {
                  userId: pu.id,
                  eventType: "CONSULTATION_BOOKED_CHAT",
                  payload: {
                    sessionId: currentSessionId,
                    parentName: userRecord?.name || firstName,
                    message: `${firstName} has scheduled a consultation — click "Join Group Chat" to start chatting directly`,
                  },
                },
              });
            }
          }

          const admins = await prisma.user.findMany({ where: { roles: { has: "GOSTORK_ADMIN" } }, select: { id: true } });
          for (const admin of admins) {
            await prisma.inAppNotification.create({
              data: {
                userId: admin.id,
                eventType: "CONSULTATION_REQUESTED",
                payload: {
                  parentName: userRecord?.name || firstName,
                  parentUserId: userId,
                  providerId: consultProviderId,
                  providerName: consultProvider.name,
                  message: `${firstName} requested a consultation with ${consultProvider.name}`,
                },
              },
            });
          }
        }
      } catch (e) {
        console.error("Failed to process CONSULTATION_BOOKING:", e);
      }
      finalContent = finalContent.replace(/\[\[CONSULTATION_BOOKING:.*?\]\]/g, "").trim();
    }

    const uiExtras: Record<string, any> = {};
    if (matchCards.length > 0) uiExtras.matchCards = matchCards;
    if (consultationCard) uiExtras.consultationCard = consultationCard;
    if (sendPrepDoc) uiExtras.prepDoc = true;
    if (quickReplies.length > 0) uiExtras.quickReplies = quickReplies;
    if (multiSelect) uiExtras.multiSelect = true;

    const savedAiMessage = await prisma.aiChatMessage.create({
      data: {
        sessionId: currentSessionId,
        role: "assistant",
        content: finalContent,
        ...(Object.keys(uiExtras).length > 0 ? { uiCardType: "rich", uiCardData: uiExtras } : {}),
      },
    });

    res.json({
      sessionId: currentSessionId,
      userMessageId: savedUserMsg.id,
      message: savedAiMessage,
      quickReplies: quickReplies.length > 0 ? quickReplies : undefined,
      multiSelect: multiSelect || undefined,
      showCuration: showCuration || undefined,
      matchCards: matchCards.length > 0 ? matchCards : undefined,
      prepDoc: sendPrepDoc || undefined,
      humanNeeded: humanNeeded || undefined,
      consultationCard: consultationCard || undefined,
    });
  } catch (error: any) {
    console.error("AI Router Error:", error);
    res.status(500).json({ error: error.message });
  }
});
