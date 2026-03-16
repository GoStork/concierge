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

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return response.data[0].embedding;
}

async function searchKnowledgeBase(
  query: string,
  providerId?: string,
  maxResults: number = 5,
): Promise<{ content: string; sourceTier: number; sourceType: string; score: number }[]> {
  try {
    const embedding = await generateEmbedding(query);
    const vectorStr = `[${embedding.join(",")}]`;

    let results: any[];
    if (providerId) {
      results = await prisma.$queryRawUnsafe(
        `SELECT content, "sourceTier", "sourceType",
                1 - (embedding <=> $1::vector) as score
         FROM "KnowledgeChunk"
         WHERE ("providerId" = $2 AND "sourceTier" = 1)
            OR "sourceTier" IN (2, 3)
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        vectorStr,
        providerId,
        maxResults,
      );
    } else {
      results = await prisma.$queryRawUnsafe(
        `SELECT content, "sourceTier", "sourceType",
                1 - (embedding <=> $1::vector) as score
         FROM "KnowledgeChunk"
         WHERE "sourceTier" IN (2, 3)
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        vectorStr,
        maxResults,
      );
    }
    return results.map((r: any) => ({
      content: r.content,
      sourceTier: r.sourceTier,
      sourceType: r.sourceType,
      score: parseFloat(r.score),
    }));
  } catch (e) {
    console.error("Knowledge search failed:", e);
    return [];
  }
}

async function getExpertGuidanceRules(): Promise<string> {
  try {
    const rules = await prisma.expertGuidanceRule.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
    if (rules.length === 0) return "";
    const ruleLines = rules.map(
      (r) => `- IF the user mentions "${r.condition}" → ${r.guidance}`,
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
    const roles: string[] = user.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN");
    const providerRoles = ["PROVIDER_ADMIN", "SURROGACY_COORDINATOR", "EGG_DONOR_COORDINATOR", "SPERM_DONOR_COORDINATOR", "IVF_CLINIC_COORDINATOR", "DOCTOR", "BILLING_MANAGER"];
    const isProvider = roles.some((r: string) => providerRoles.includes(r)) && user.providerId && session.providerId === user.providerId;
    if (!isOwner && !isAdmin && !isProvider) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const where: any = { sessionId };
    if (after) {
      where.createdAt = { gt: new Date(after) };
    }
    const messages = await prisma.aiChatMessage.findMany({
      where,
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, content: true, senderType: true, senderName: true, createdAt: true },
    });
    res.json(messages);
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

aiRouter.post("/chat", async (req: Request, res: Response) => {
  try {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const userId = (req.user as any).id;
    let currentSessionId = req.body.sessionId;

    if (currentSessionId) {
      const session = await prisma.aiChatSession.findUnique({ where: { id: currentSessionId } });
      if (!session || session.userId !== userId) {
        return res.status(403).json({ error: "Session does not belong to this user" });
      }
    } else {
      const newSession = await prisma.aiChatSession.create({
        data: { userId, title: "Concierge Consultation" },
      });
      currentSessionId = newSession.id;
    }

    // Save the Intended Parent's message
    await prisma.aiChatMessage.create({
      data: {
        sessionId: currentSessionId,
        role: "user",
        content: req.body.message,
      },
    });

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

STEP 2: "What's your plan for eggs — are you thinking of using your own, or are you considering a donor?" [[QUICK_REPLY:My own eggs|Donor eggs|I'm not sure yet]]
  → If DONOR EGGS: go to STEP 2a
  → Otherwise: go to STEP 3

STEP 2a: "Do you need help finding an egg donor, or do you already have one?" [[QUICK_REPLY:I need help finding one|I already have one]]
  → After answer, go to STEP 3

STEP 3: "And for sperm, will you be using your own, donor sperm, or are you still deciding?" [[QUICK_REPLY:My own|Donor sperm|Not sure yet]]
  → If DONOR SPERM: go to STEP 3a
  → Otherwise: go to STEP 4

STEP 3a: "Do you need help finding a sperm donor, or do you already have one?" [[QUICK_REPLY:I need help finding one|I already have one]]
  → After answer, go to STEP 4

STEP 4: "And who is planning to carry the pregnancy?" [[QUICK_REPLY:Me|My partner|A gestational surrogate]]
  → If GESTATIONAL SURROGATE: go to STEP 4a
  → Otherwise: go to STEP 5

STEP 4a: "Do you need help finding a surrogate, or do you already have one?" [[QUICK_REPLY:I need help finding one|I already have one]]
  → After answer, go to STEP 5

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

STEP 6 — FINAL OPEN-ENDED QUESTION:
  ASK: "Before I share some matches with you, is there anything else you'd like me to know or any specific concerns you have?"
  → WAIT for reply.

STEP 7 — CURATION:
  After the user replies to Step 6, warmly acknowledge what they said, then say EXACTLY this (you MUST include the [[CURATION]] tag):
  "Thank you, ${firstName}. I have everything I need to find your perfect matches. Let me curate your personalized results now. [[CURATION]]"
  The system will show a loading animation. WAIT for the next message (the system auto-sends "ready" after the animation).

STEP 8 — MATCH REVEAL:
  Once you receive "ready", use your database tools to search for matching providers based on everything you learned.
  Present matches using the MATCH CARD format:
  [[MATCH_CARD:{"name":"Provider Name","type":"Clinic/Agency/Donor","location":"City, State","photo":"/path/to/photo","reasons":["Reason 1 based on user's specific needs","Reason 2","Reason 3"],"providerId":"actual-uuid"}]]
  After showing the card(s), add your expert take: "I chose [Name] because [personal reason tied to what the user shared]. Would you like me to reach out and check their availability for a match call with you? [[QUICK_REPLY:Yes, please!|Show me more options]]"
  If they say YES: respond enthusiastically — "I'm on it! I'll flag this and the GoStork team will reach out shortly to confirm your call." Include [[HOT_LEAD:PROVIDER_ID]] at the end.
  If they want more options: "Of course! Here are a couple more great fits..." and show additional match cards.

SILENT PASSTHROUGH PROTOCOL:
When the user asks a specific question about a provider's operations, pricing, policies, or administrative details that you cannot find in the KNOWLEDGE BASE CONTEXT above or via your database tools, use the [[WHISPER:PROVIDER_ID]] tag.
Format: Include [[WHISPER:provider-uuid-here]] at the end of your response along with the question.
Your message should say: "I don't have that specific detail yet, but I've just whispered a message to the clinic's coordinator. I'll have that answer for you as soon as they reply!"
The system will silently send the question to the provider without revealing the parent's identity. When the provider answers, you'll receive it in a future message context.
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
- donorEyeColor, donorHairColor, donorHeight, donorEducation (strings)
- surrogateBudget, surrogateMedPrefs (strings)
Example: If user says they have 3 frozen embryos, end your response with: [[SAVE:{"hasEmbryos":true,"embryoCount":3}]]
CONSULTATION BOOKING:
When a parent is ready to take the next step with a matched provider and wants to schedule a consultation (not just a match call), use:
[[CONSULTATION_BOOKING:PROVIDER_ID]]
This will present a booking card with the provider's details and a "Schedule Consultation" button.
After triggering a consultation booking, acknowledge it warmly: "Great! I've logged that you've requested a consultation with [Provider]. I'll keep an eye on this for you. Would you like me to suggest some questions specifically for this first meeting?"
Also save the journey stage: [[SAVE:{"journeyStage":"Consultation Requested"}]]

All [[SAVE:...]], [[QUICK_REPLY:...]], [[CURATION]], [[MATCH_CARD:...]], [[HOT_LEAD:...]], [[WHISPER:...]], [[HUMAN_NEEDED]], and [[CONSULTATION_BOOKING:...]] tags are stripped before the user sees the message.

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
        include: { provider: { select: { name: true } } },
        orderBy: { updatedAt: "desc" },
        take: 5,
      });
      if (answeredWhispers.length > 0) {
        const whisperParts = answeredWhispers.map(
          (w: any) => `- Question about ${w.provider.name}: "${w.questionText}" → Answer: "${w.answerText}"`,
        );
        answeredWhispersContext = `\nPROVIDER WHISPER ANSWERS (recently answered by providers — present these naturally when relevant):\n${whisperParts.join("\n")}\nWhen presenting a whisper answer, lead with: "I have an update! I spoke with the clinic and they confirmed: [Answer]. Does that help, or are you ready to schedule a match call?"\nIf the parent wants to schedule a match call, use the [[HOT_LEAD:PROVIDER_ID]] tag.\n`;
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
Use your tools to fetch real data from the GoStork database when looking up providers, clinics, donors, or surrogates.`;

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
        ];
        const updateData: any = {};
        for (const [key, value] of Object.entries(fieldsToSave)) {
          if (allowedFields.includes(key)) {
            if (key === "hasEmbryos" || key === "embryosTested") {
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

    const whisperMatch = finalContent.match(/\[\[WHISPER:(.*?)\]\]/);
    if (whisperMatch) {
      const whisperProviderId = whisperMatch[1].trim();
      try {
        if (whisperProviderId && userId && currentSessionId) {
          const questionText = userMessage || finalContent.replace(/\[\[WHISPER:.*?\]\]/g, "").trim().slice(0, 500);
          await prisma.silentQuery.create({
            data: {
              parentUserId: userId,
              providerId: whisperProviderId,
              sessionId: currentSessionId,
              questionText,
              status: "PENDING",
            },
          });

          const provider = await prisma.provider.findUnique({
            where: { id: whisperProviderId },
            select: { name: true },
          });
          const providerName = provider?.name || "Your Clinic";

          const providerUsers = await prisma.user.findMany({
            where: { providerId: whisperProviderId },
            select: { id: true, email: true },
          });
          for (const pu of providerUsers) {
            await prisma.inAppNotification.create({
              data: {
                userId: pu.id,
                eventType: "WHISPER_QUESTION",
                payload: {
                  message: "The AI concierge has a new question from a prospective parent that needs your input.",
                  questionPreview: questionText.slice(0, 100),
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

    for (const card of matchCards) {
      if (card.providerId) {
        try {
          const provider = await prisma.provider.findUnique({
            where: { id: card.providerId },
            select: { logoUrl: true, name: true },
          });
          if (provider?.logoUrl) {
            card.photo = provider.logoUrl;
          }
        } catch (e) {
          // Provider lookup failed, try searching by name
        }
      }
      if (!card.photo || card.photo === "/path/to/photo") {
        try {
          const providerByName = await prisma.provider.findFirst({
            where: { name: { contains: card.name, mode: "insensitive" } },
            select: { logoUrl: true, id: true },
          });
          if (providerByName?.logoUrl) {
            card.photo = providerByName.logoUrl;
            if (!card.providerId) card.providerId = providerByName.id;
          } else {
            card.photo = null;
          }
        } catch (e) {
          card.photo = null;
        }
      }
    }

    let consultationCard: any = null;
    const consultationMatch = finalContent.match(/\[\[CONSULTATION_BOOKING:(.*?)\]\]/);
    if (consultationMatch) {
      const consultProviderId = consultationMatch[1].trim();
      try {
        const consultProvider = await prisma.provider.findUnique({
          where: { id: consultProviderId },
          select: {
            id: true,
            name: true,
            logoUrl: true,
            consultationBookingUrl: true,
            consultationIframeEnabled: true,
            email: true,
          },
        });
        if (consultProvider) {
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
              data: { providerId: consultProviderId },
            });
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

    const savedAiMessage = await prisma.aiChatMessage.create({
      data: {
        sessionId: currentSessionId,
        role: "assistant",
        content: finalContent,
      },
    });

    res.json({
      sessionId: currentSessionId,
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
