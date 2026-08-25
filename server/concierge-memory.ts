/**
 * Durable cross-thread concierge memory + rolling session summary.
 * Ported from the AI-Health app's proven design (memory.service.ts +
 * chat.service.ts maybeUpdateSummary), adapted to GoStork:
 *
 * - ConciergeMemory is ACCOUNT-scoped (parentAccountId), not per-user or
 *   per-session: the facts follow the family across the Eva chat AND every
 *   provider thread. Parents can view/edit/delete everything on their
 *   Profile page (stale memories never fester).
 * - Extraction skips anything the structured intake already saves to the
 *   IntendedParentProfile via [[SAVE]] (services, budget, appearance
 *   preferences, medical basics) - memory holds only the soft context the
 *   schema can't (emotional state, partner dynamics, communication style,
 *   scheduling constraints, decisions).
 * - The rolling summary folds turns that scrolled out of the model's
 *   recent-history window into AiChatSession.historySummary in the
 *   background (batched - no reply latency), with a summarizedThrough
 *   watermark so nothing is folded twice. Memory auto-extraction piggybacks
 *   on the same fold so it costs no extra cadence.
 */
import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "./db";
import { isAdminOrConcierge } from "./chat-router";
import { trackGemini } from "./src/lib/gemini-usage";
import { GEMINI_CHAT_MODEL } from "./src/lib/gemini-models";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

/** Turns fed to the model verbatim - matches TIER2_MAX_HISTORY in ai-router. */
export const CHAT_HISTORY_WINDOW = 20;
/** Fold once this many un-summarized turns pile up beyond the window. */
const SUMMARY_BATCH = 8;

const KINDS = new Set(["PREFERENCE", "CONSTRAINT", "GOAL", "FACT", "DECISION"]);

async function fastJson(system: string, user: string, maxTokens = 500): Promise<any | null> {
  try {
    const model = genAI.getGenerativeModel({
      model: GEMINI_CHAT_MODEL,
      systemInstruction: system,
      generationConfig: { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } } as any,
    });
    const memRes = await model.generateContent(user);
    trackGemini("concierge-memory", GEMINI_CHAT_MODEL, memRes);
    const out = memRes.response.text().trim();
    // The model occasionally returns trailing junk (or two concatenated
    // objects) even in JSON mode - parse the FIRST balanced object.
    try {
      return JSON.parse(out);
    } catch {
      const start = out.indexOf("{");
      if (start < 0) return null;
      let depth = 0;
      for (let i = start; i < out.length; i++) {
        if (out[i] === "{") depth++;
        else if (out[i] === "}" && --depth === 0) return JSON.parse(out.slice(start, i + 1));
      }
      return null;
    }
  } catch (e: any) {
    console.warn(`[memory] fastJson failed: ${e?.message}`);
    return null;
  }
}

async function fastText(system: string, user: string, maxTokens = 600): Promise<string> {
  try {
    const model = genAI.getGenerativeModel({
      model: GEMINI_CHAT_MODEL,
      systemInstruction: system,
      generationConfig: { temperature: 0, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } } as any,
    });
    const textRes = await model.generateContent(user);
    trackGemini("concierge-memory", GEMINI_CHAT_MODEL, textRes);
    return textRes.response.text().trim();
  } catch (e: any) {
    console.warn(`[memory] fastText failed: ${e?.message}`);
    return "";
  }
}

/** Resolve the account id for a user (falls back to the user id for accountless users). */
export async function accountIdForUser(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, parentAccountId: true } });
  return u?.parentAccountId || u?.id || userId;
}

/** Compact prompt block of ACTIVE memories. Empty string when none. */
export async function memoryBlock(parentAccountId: string): Promise<string> {
  const items = await prisma.conciergeMemory.findMany({
    where: { parentAccountId, active: true },
    orderBy: { updatedAt: "desc" },
    take: 25,
  }).catch(() => []);
  if (!items.length) return "";
  const lines = items.map((m) => `- [${m.kind.toLowerCase()}] ${m.text}`);
  return (
    `WHAT YOU REMEMBER ABOUT THIS FAMILY (durable cross-conversation memory the parent can view/edit on ` +
    `their Profile page; honor these preferences and constraints naturally - do not recite the list. If a ` +
    `memory conflicts with the CURRENT profile or data blocks, the current data wins):\n${lines.join("\n")}`
  );
}

/**
 * EXPLICIT capture: the parent said "remember (that) ..." - store it now.
 * Returns the created memory text, or null when it isn't a remember request.
 */
export async function captureExplicitMemory(parentAccountId: string, message: string): Promise<string | null> {
  if (!/\b(remember|memorize)\b/i.test(message)) return null;
  const existing = await prisma.conciergeMemory.findMany({
    where: { parentAccountId, active: true }, orderBy: { updatedAt: "desc" }, take: 25, select: { text: true },
  }).catch(() => []);
  const parsed = await fastJson(
    "You extract durable facts about a fertility-journey family. JSON only.",
    `A parent in a fertility concierge chat sent this message:\n"${message.slice(0, 800)}"\n\n` +
    `If they are asking the assistant to REMEMBER something durable about them or their family (a preference, ` +
    `constraint, decision, or personal fact), extract it as ONE short third-person line (e.g. "Prefers evening ` +
    `calls"). If they are NOT asking to remember anything (e.g. "I don't remember her name"), return null.\n` +
    (existing.length ? `Already remembered (do not duplicate):\n${existing.map((m) => `- ${m.text}`).join("\n")}\n` : "") +
    `\nReturn STRICT JSON only: {"fact": "<line>" | null, "kind": "PREFERENCE|CONSTRAINT|GOAL|FACT|DECISION"}`,
    200,
  );
  if (!parsed?.fact || typeof parsed.fact !== "string") return null;
  const created = await prisma.conciergeMemory.create({
    data: {
      parentAccountId,
      kind: KINDS.has(parsed.kind) ? parsed.kind : "FACT",
      text: parsed.fact.trim().slice(0, 500),
      source: "USER_SAID",
    },
  });
  console.log(`[memory] Explicit capture for ${parentAccountId}: ${created.text}`);
  return created.text;
}

/**
 * AUTO extraction, piggybacked on the summary fold: read the turns being
 * folded away and propose durable cross-thread facts. Dedupes + supersedes
 * against existing memories (newest wins).
 */
/** Compact "already known" snapshot so extraction never restates the profile. */
async function profileSnapshot(parentAccountId: string): Promise<string> {
  try {
    const [profile, users] = await Promise.all([
      prisma.intendedParentProfile.findUnique({ where: { parentAccountId } }),
      prisma.user.findMany({ where: { parentAccountId }, select: { relationshipStatus: true, gender: true, city: true, state: true, country: true }, take: 3 }),
    ]);
    const u = users[0] || ({} as any);
    const facts: string[] = [];
    if (u.relationshipStatus) facts.push(`relationship status: ${u.relationshipStatus}`);
    if (u.gender) facts.push(`gender: ${u.gender}`);
    if ([u.city, u.state, u.country].some(Boolean)) facts.push(`location: ${[u.city, u.state, u.country].filter(Boolean).join(", ")}`);
    if (profile) {
      const p: any = profile;
      if (p.familyType) facts.push(`family type: ${p.familyType}`);
      if (p.interestedServices?.length) facts.push(`services: ${p.interestedServices.join(", ")}`);
      for (const [k, label] of [["needsSurrogate", "surrogacy"], ["needsEggDonor", "egg donation"], ["needsSpermDonor", "sperm donation"], ["needsClinic", "IVF clinic"]] as const) {
        if (p[k] === true) facts.push(`needs ${label}`);
      }
      if (p.hasEmbryos != null) facts.push(`has embryos: ${p.hasEmbryos}${p.embryoCount ? ` (${p.embryoCount})` : ""}`);
      if (p.budget) facts.push(`budget: ${p.budget}`);
      if (p.timeline) facts.push(`timeline: ${p.timeline}`);
    }
    return facts.length ? facts.join("; ") : "";
  } catch {
    return "";
  }
}

async function extractFromTranscript(parentAccountId: string, transcript: string): Promise<void> {
  // A big fold (backfill, long thread) exceeds one prompt - chunk it so the
  // WHOLE transcript gets scanned, not just the first slice.
  const CHUNK = 9000;
  const chunks: string[] = [];
  for (let i = 0; i < transcript.length && chunks.length < 3; i += CHUNK) chunks.push(transcript.slice(i, i + CHUNK));
  const known = await profileSnapshot(parentAccountId);

  for (const chunk of chunks) {
    const existing = await prisma.conciergeMemory.findMany({
      where: { parentAccountId, active: true }, orderBy: { updatedAt: "desc" }, take: 30,
    }).catch(() => []);
    const listing = existing.map((m) => `${m.id} | [${m.kind}] ${m.text}`).join("\n") || "(none)";
    const parsed = await fastJson(
      "You maintain a small durable-facts memory for a fertility concierge. JSON only.",
      `From this fertility-concierge chat transcript, extract durable facts about the FAMILY worth remembering ` +
      `across future conversations: soft preferences (communication style, call timing), constraints (schedule, ` +
      `budget sensitivities they voiced), explicit decisions, emotional/personal context (partner dynamics, ` +
      `topics to handle gently). STRICT rules:\n` +
      `- Only what the PARENT said or clearly agreed to - not the assistant's suggestions.\n` +
      `- NEVER restate anything from ALREADY IN THEIR PROFILE below - those facts are injected separately on ` +
      `every turn; a memory that repeats them is pure noise.\n` +
      `- Skip anything the structured intake saves to the profile: which services they want, donor/surrogate ` +
      `appearance preferences (height, hair, eyes, ethnicity), medical basics, locations, budget figures.\n` +
      `- Skip small talk, one-off questions, and anything about a specific donor/surrogate/provider profile.\n` +
      `- Each fact: one short third-person line. Most transcripts yield ZERO facts - that's normal.\n\n` +
      `ALREADY IN THEIR PROFILE (never restate): ${known || "(empty profile)"}\n\n` +
      `EXISTING MEMORIES (id | fact):\n${listing}\n\n` +
      `TRANSCRIPT:\n${chunk}\n\n` +
      `Return STRICT JSON only: {"add":[{"kind":"PREFERENCE|CONSTRAINT|GOAL|FACT|DECISION","text":"..."}],` +
      `"supersede":["<existing id that a new/changed fact replaces>"]} - both arrays may be empty. ` +
      `Do NOT re-add a fact already in EXISTING MEMORIES.`,
    );
    if (!parsed) continue;
    const validIds = new Set(existing.map((m) => m.id));
    for (const id of parsed.supersede ?? []) {
      if (typeof id === "string" && validIds.has(id)) {
        await prisma.conciergeMemory.update({ where: { id }, data: { active: false } }).catch(() => {});
      }
    }
    for (const a of (parsed.add ?? []).slice(0, 5)) {
      if (a?.text && typeof a.text === "string") {
        await prisma.conciergeMemory.create({
          data: {
            parentAccountId,
            kind: KINDS.has(a.kind) ? a.kind : "FACT",
            text: a.text.trim().slice(0, 500),
            source: "CHAT_AUTO",
          },
        }).catch(() => {});
      }
    }
    const n = (parsed.add?.length ?? 0) + (parsed.supersede?.length ?? 0);
    if (n > 0) console.log(`[memory] ${parentAccountId}: +${parsed.add?.length ?? 0} facts, superseded ${parsed.supersede?.length ?? 0}`);
  }
}

/**
 * Fold messages that scrolled OUT of the recent window into the session's
 * rolling summary. Fire-and-forget after each reply - batched via
 * SUMMARY_BATCH so it stays cheap, watermarked via summarizedThrough.
 */
export async function maybeUpdateSessionSummary(sessionId: string): Promise<void> {
  try {
    const s = await prisma.aiChatSession.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true, historySummary: true, summarizedThrough: true },
    });
    if (!s) return;
    const windowIds = await prisma.aiChatMessage.findMany({
      where: { sessionId, role: { in: ["user", "assistant"] } },
      orderBy: { createdAt: "desc" },
      take: CHAT_HISTORY_WINDOW,
      select: { createdAt: true },
    });
    if (windowIds.length < CHAT_HISTORY_WINDOW) return; // whole thread still fits
    const windowStart = windowIds[windowIds.length - 1].createdAt;
    const older = await prisma.aiChatMessage.findMany({
      where: {
        sessionId,
        role: { in: ["user", "assistant"] },
        createdAt: s.summarizedThrough ? { lt: windowStart, gt: s.summarizedThrough } : { lt: windowStart },
      },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true, createdAt: true },
    });
    if (older.length < SUMMARY_BATCH) return;
    // First fold on a long-lived thread (or the one-time backfill) can cover
    // months at once - feed only the NEWEST 80 folded turns to the model
    // while the watermark still advances over all of them. The skipped oldest
    // turns are the least relevant; their durable facts live in the profile.
    const foldable = older.slice(-80);
    const transcript = foldable
      .map((m) => `${m.role === "assistant" ? "Assistant" : "Parent"}: ${(m.content || "").replace(/\[\[[^\]]*\]\]/g, "").slice(0, 1200)}`)
      .join("\n");

    // Same folded turns feed the durable cross-thread memory - no extra cadence.
    const accountId = await accountIdForUser(s.userId);
    void extractFromTranscript(accountId, transcript).catch(() => {});

    const summary = await fastText(
      "You compress conversations into a tight running summary.",
      `Maintain a concise running summary of a fertility-concierge conversation. Keep only durable, useful ` +
      `context: the parent's decisions, stated preferences, profiles/providers discussed and how they felt ` +
      `about them, open threads/questions, and what the assistant recommended. Omit small talk and anything ` +
      `already in their structured profile. 8-12 short bullet points max.\n\n` +
      (s.historySummary ? `EXISTING SUMMARY:\n${s.historySummary}\n\n` : "") +
      `NEW MESSAGES TO FOLD IN:\n${transcript}\n\nReturn ONLY the updated summary.`,
    );
    if (summary) {
      await prisma.aiChatSession.update({
        where: { id: sessionId },
        data: { historySummary: summary.slice(0, 4000), summarizedThrough: older[older.length - 1].createdAt },
      });
      console.log(`[summary] Folded ${older.length} turns into session ${sessionId} summary`);
    }
  } catch (e: any) {
    console.warn(`[summary] maybeUpdateSessionSummary failed: ${e?.message}`);
  }
}

// ── Parent-facing CRUD ("What Eva remembers about you" on the Profile page) ──

export const conciergeMemoryRouter = Router();

// JWT Bearer fallback (same contract as aiRouter/reviewsRouter).
conciergeMemoryRouter.use(async (req: any, _res: any, next: any) => {
  if (!req.isAuthenticated?.()) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET || "dev-jwt-secret-change-me") as any;
        if (payload?.sub) {
          const user = await prisma.user.findUnique({ where: { id: payload.sub } });
          if (user && !user.isDisabled) {
            req.user = user;
            req.isAuthenticated = () => true;
          }
        }
      } catch { /* continue unauthenticated */ }
    }
  }
  next();
});

function requireParent(req: Request, res: Response): string | null {
  const user = (req as any).user;
  if (!(req as any).isAuthenticated?.() || !user) {
    res.status(401).json({ message: "Unauthorized" });
    return null;
  }
  return user.parentAccountId || user.id;
}

conciergeMemoryRouter.get("/api/my/concierge-memory", async (req, res) => {
  const accountId = requireParent(req, res);
  if (!accountId) return;
  const items = await prisma.conciergeMemory.findMany({
    where: { parentAccountId: accountId, active: true },
    orderBy: { updatedAt: "desc" },
  });
  res.json(items);
});

conciergeMemoryRouter.post("/api/my/concierge-memory", async (req, res) => {
  const accountId = requireParent(req, res);
  if (!accountId) return;
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ message: "text required" });
  const kind = KINDS.has(req.body?.kind) ? req.body.kind : "FACT";
  const created = await prisma.conciergeMemory.create({
    data: { parentAccountId: accountId, kind, text: text.slice(0, 500), source: "MANUAL" },
  });
  res.json(created);
});

conciergeMemoryRouter.patch("/api/my/concierge-memory/:id", async (req, res) => {
  const accountId = requireParent(req, res);
  if (!accountId) return;
  const m = await prisma.conciergeMemory.findFirst({ where: { id: req.params.id, parentAccountId: accountId } });
  if (!m) return res.status(404).json({ message: "Memory not found" });
  const text = req.body?.text !== undefined ? String(req.body.text).trim() : undefined;
  const updated = await prisma.conciergeMemory.update({
    where: { id: m.id },
    data: {
      ...(text ? { text: text.slice(0, 500) } : {}),
      ...(req.body?.kind !== undefined && KINDS.has(req.body.kind) ? { kind: req.body.kind } : {}),
    },
  });
  res.json(updated);
});

conciergeMemoryRouter.delete("/api/my/concierge-memory/:id", async (req, res) => {
  const accountId = requireParent(req, res);
  if (!accountId) return;
  const m = await prisma.conciergeMemory.findFirst({ where: { id: req.params.id, parentAccountId: accountId } });
  if (!m) return res.status(404).json({ message: "Memory not found" });
  await prisma.conciergeMemory.delete({ where: { id: m.id } });
  res.json({ ok: true });
});

// ── Admin endpoints (concierge monitor) ─────────────────────────────────────
// Same CRUD as the parent's, scoped by an explicit parentAccountId so a
// GoStork admin/concierge can audit and correct Eva's memory for any family
// while monitoring a session. Parents keep full visibility - edits made here
// show up on the parent's /account/concierge tab exactly like their own.

function requireAdmin(req: Request, res: Response): boolean {
  const user = (req as any).user;
  if (!(req as any).isAuthenticated?.() || !user) {
    res.status(401).json({ message: "Unauthorized" });
    return false;
  }
  if (!isAdminOrConcierge(user)) {
    res.status(403).json({ message: "Forbidden" });
    return false;
  }
  return true;
}

conciergeMemoryRouter.get("/api/admin/concierge-memory", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const parentAccountId = String(req.query.parentAccountId || "");
  if (!parentAccountId) return res.status(400).json({ message: "parentAccountId required" });
  const items = await prisma.conciergeMemory.findMany({
    where: { parentAccountId, active: true },
    orderBy: { updatedAt: "desc" },
  });
  res.json(items);
});

conciergeMemoryRouter.post("/api/admin/concierge-memory", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const parentAccountId = String(req.body?.parentAccountId || "");
  const text = String(req.body?.text || "").trim();
  if (!parentAccountId) return res.status(400).json({ message: "parentAccountId required" });
  if (!text) return res.status(400).json({ message: "text required" });
  const kind = KINDS.has(req.body?.kind) ? req.body.kind : "FACT";
  const created = await prisma.conciergeMemory.create({
    data: { parentAccountId, kind, text: text.slice(0, 500), source: "MANUAL" },
  });
  res.json(created);
});

conciergeMemoryRouter.patch("/api/admin/concierge-memory/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const m = await prisma.conciergeMemory.findUnique({ where: { id: req.params.id } });
  if (!m) return res.status(404).json({ message: "Memory not found" });
  const text = req.body?.text !== undefined ? String(req.body.text).trim() : undefined;
  const updated = await prisma.conciergeMemory.update({
    where: { id: m.id },
    data: {
      ...(text ? { text: text.slice(0, 500) } : {}),
      ...(req.body?.kind !== undefined && KINDS.has(req.body.kind) ? { kind: req.body.kind } : {}),
    },
  });
  res.json(updated);
});

conciergeMemoryRouter.delete("/api/admin/concierge-memory/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const m = await prisma.conciergeMemory.findUnique({ where: { id: req.params.id } });
  if (!m) return res.status(404).json({ message: "Memory not found" });
  await prisma.conciergeMemory.delete({ where: { id: m.id } });
  res.json({ ok: true });
});
