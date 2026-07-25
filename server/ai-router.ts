import { Router, Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { getBaseUrl } from "./src/lib/get-base-url";
import { buildBrandedEmail, fetchEmailBrandData } from "./src/modules/notifications/email-builder";
import { canProviderAccessSession } from "../shared/roles";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { prisma } from "./db";
import { emitJourneyEvent } from "./journey-events";
import { ASKER_IDENTITY_IN_ANSWER, isAgencyLevelPair, sanitizeReusableQuestion } from "./whisper-knowledge";
import { memoryBlock, captureExplicitMemory, maybeUpdateSessionSummary, accountIdForUser } from "./concierge-memory";
import path from "path";
import fs from "fs";
import { isUserOnline } from "./online-tracker";
import jwt from "jsonwebtoken";
import { getNextIntakeQuestion, buildD1HasEmbryos, buildD1NoEmbryos, type D1Costs } from "./intake-questions";

// Singleton Anthropic client - enables HTTP connection pooling across requests.
let _anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (_anthropicClient) return _anthropicClient;
  let apiKey = process.env.ANTHROPIC_API_KEY;
  console.log(`[ANTHROPIC] env key: ${apiKey ? "SET (length " + apiKey.length + ")" : "EMPTY/MISSING"}`);
  if (!apiKey) {
    try {
      const envPath = path.resolve(process.cwd(), ".env");
      console.log(`[ANTHROPIC] Falling back to reading: ${envPath}`);
      const envContent = fs.readFileSync(envPath, "utf8");
      const match = envContent.match(/^ANTHROPIC_API_KEY=([^\r\n]+)/m);
      if (match) {
        apiKey = match[1].trim();
        console.log(`[ANTHROPIC] Fallback key found, length: ${apiKey.length}`);
      } else {
        console.log(`[ANTHROPIC] Fallback: no match found in .env`);
      }
    } catch (e: any) {
      console.log(`[ANTHROPIC] Fallback failed: ${e.message}`);
    }
  }
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  _anthropicClient = new Anthropic({ apiKey });
  return _anthropicClient;
}

// Pre-warm the Anthropic connection on startup to eliminate cold-start TLS handshake latency.
export async function warmupGeminiConnection(): Promise<void> {
  try {
    const model = geminiAI.getGenerativeModel({ model: "gemini-3.5-flash" });
    await model.generateContent("hi");
    console.log("[GEMINI] Tier2 connection pre-warmed");
  } catch (e: any) {
    console.log(`[GEMINI] Pre-warm failed (non-critical): ${e.message}`);
  }
}
const geminiAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// -------------------------------------------------------------------------
// SSE helpers
// -------------------------------------------------------------------------
function setupSSE(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Transfer-Encoding", "chunked");
  // Disable TCP Nagle algorithm to send each chunk immediately
  (res as any).socket?.setNoDelay?.(true);
  res.flushHeaders();
  const flush = () => { if (typeof (res as any).flush === "function") (res as any).flush(); };
  return {
    sendToken: (delta: string) => { res.write(`data: ${JSON.stringify({ type: "token", delta })}\n\n`); flush(); },
    // Clears the client's streaming draft. Used by interceptors that REPLACE
    // already-streamed content, so a rejected draft disappears the moment the
    // replacement is ready instead of sitting on screen until the final "done".
    sendReset: () => { res.write(`data: ${JSON.stringify({ type: "reset" })}\n\n`); flush(); },
    sendDone: (payload: object) => { res.write(`data: ${JSON.stringify({ type: "done", ...payload })}\n\n`); flush(); res.end(); },
    sendError: (msg: string) => { res.write(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`); flush(); res.end(); },
    sendRetry: () => { res.write(`data: ${JSON.stringify({ type: "retry_needed" })}\n\n`); flush(); res.end(); },
  };
}
type SSEHandle = ReturnType<typeof setupSSE>;

// -------------------------------------------------------------------------
// Tier 1: Gemini 2.5 Flash - fast conversational turns before [[CURATION]]
// -------------------------------------------------------------------------
async function callTier1Gemini(
  systemPrompt: string,
  messages: any[],
  sse: SSEHandle
): Promise<string> {
  // Use gemini-2.5-flash with thinking disabled for instant conversational responses
  // thinkingBudget: 0 disables the reasoning phase that adds 5-7s latency
  const model = geminiAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } } as any,
  });

  // Collect inline system messages and merge into the system instruction
  const inlineSysT1 = messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter(Boolean);
  const fullSystemT1 = inlineSysT1.length > 1
    ? inlineSysT1.join("\n\n---\n\n")
    : systemPrompt;

  // Gemini requires history to start with a "user" turn - drop leading model messages
  const rawHistory = messages
    .filter((m) => m.role !== "system")
    .slice(0, -1)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
    }));
  const firstUserIdx = rawHistory.findIndex((m) => m.role === "user");
  const history = firstUserIdx > 0 ? rawHistory.slice(firstUserIdx) : firstUserIdx === 0 ? rawHistory : [];

  const lastMsg = messages[messages.length - 1];
  const userMessage = typeof lastMsg?.content === "string" ? lastMsg.content : JSON.stringify(lastMsg?.content);

  const chat = model.startChat({
    systemInstruction: { parts: [{ text: fullSystemT1 }] },
    history,
  });

  // Stream deltas to the client AS THEY ARRIVE - the reply appears word by word
  // in real time instead of all at once after full generation. The rare
  // post-processing edits below (trailing-question strip) are reconciled by the
  // client's final "done" replace, which rebuilds the message from the
  // processed content.
  const result = await chat.sendMessageStream(userMessage);
  let fullText = "";
  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) { fullText += text; sse.sendToken(text); }
  }

  // Strip questions that Gemini bundles at the end of long educational messages.
  // These questions must appear as standalone messages so the user sees them clearly
  // with their quick-reply buttons. If the full response is long (>200 chars before
  // the question) we remove the trailing question - Gemini will ask it standalone
  // on the next turn once it sees the question wasn't answered.
  const trailingQuestionPatterns = [
    /\s*\n*What are your preferences regarding termination if medically necessary\?\s*$/i,
    /\s*\n*With all of that in mind, which countries are you open to for your surrogacy\?\s*$/i,
    /\s*\n*Are you hoping to have twins, or would you prefer a singleton pregnancy\?\s*$/i,
    /\s*\n*Are you hoping for twins or would you prefer a singleton\?\s*$/i,
  ];
  for (const pattern of trailingQuestionPatterns) {
    if (pattern.test(fullText)) {
      const stripped = fullText.replace(pattern, "").trimEnd();
      if (stripped.length > 200) {
        fullText = stripped;
        break;
      }
    }
  }

  // Tokens were already streamed live above - the client's "done" replace picks
  // up any post-processing (trailing-question strip) applied to fullText.
  return fullText;
}

// Normalize biological baseline field values to match account-page dropdown option values exactly.
// These must match the string arrays in account-page.tsx: eggSourceOptions, spermSourceOptions, carrierOptions.
function normalizeCarrier(val: string): string {
  const v = val.toLowerCase().trim().replace(/^a\s+/, "");
  if (v.includes("gestational") || v === "surrogate") return "Gestational surrogate";
  if (v === "me" || v === "self" || v === "self carrying" || v === "myself" || v === "carrying myself") return "Self carrying";
  if (v.includes("partner") || v.includes("spouse")) return "My partner";
  return val;
}
function normalizeEggSource(val: string, _parentGender?: string | null): string {
  const v = val.toLowerCase().trim().replace(/^a\s+/, "");
  if (v.includes("donor egg") || v.includes("egg donor") || v === "donor eggs" || v === "egg donor") return "Egg donor";
  if (v.includes("donated embryo") || v.includes("embryo donation")) return "Donated embryos";
  // "Partner eggs" canonical applies to both genders: Two Moms (one female partner provides eggs)
  // and Man+Woman with man speaking (female partner provides eggs). Two Dads can never legitimately
  // emit a partner-eggs SAVE since neither partner has eggs biologically.
  if (v.includes("partner") && v.includes("egg")) return "Partner eggs";
  if (v.includes("own egg") || v === "her own" || v === "my own eggs" || v === "own eggs") return "Own eggs";
  return val;
}
// An explicit own/partner egg source contradicts a stale needsEggDonor=true
// (e.g. inferred from an Egg Donor service registration in a prior journey).
// Clear the flag in the same write so donor-signal checks downstream (clinic
// card enrichment, cost program matching) can't resurrect donor mode. An
// explicit needsEggDonor in the same payload wins.
function clearStaleNeedsEggDonor(data: Record<string, any>) {
  if (typeof data.eggSource !== "string" || data.needsEggDonor !== undefined) return;
  const v = data.eggSource.toLowerCase();
  if (!v.includes("donor") && (v.includes("own") || v.includes("partner"))) {
    data.needsEggDonor = false;
  }
}
function normalizeSpermSource(val: string, parentGender?: string | null): string {
  const v = val.toLowerCase().trim().replace(/^a\s+/, "");
  if (v.includes("sperm donor") || v === "donor sperm" || v === "sperm donor") return "Sperm donor";
  if (v === "my own" || v === "my sperm" || v.includes("own sperm") || v === "his own") return "My sperm";
  if (v === "known donor") return "Known donor";
  if (v.includes("partner") || v.includes("spouse")) {
    // Gender-aware: male couples (Two Dads) use "Partner sperm" canonical; female users (Solo Woman,
    // Two Moms, Man+Woman) use "Partner/Spouse". Matches the dropdown options in account-page.tsx.
    const g = (parentGender || "").toLowerCase();
    const isFemale = /\b(female|woman|girl)\b/.test(g);
    const isMale = !isFemale && /\b(male|man|boy)\b/.test(g);
    return isMale ? "Partner sperm" : "Partner/Spouse";
  }
  return val;
}

// -------------------------------------------------------------------------
// Journey-aware conversation_flow slicing (Tier 2 latency)
// The conversation_flow prompt section is ~92KB covering EVERY journey; Gemini
// re-prefills the full system prompt on every chained tool round, so match
// turns paid ~43K tokens of prefill per round (16-40s turns). This slices the
// section down to what THIS turn can actually use:
//   - Intake (Phases 0-2, ~48KB) only before tier2Active - Tier2 activates at
//     the first [[CURATION]], by which point the biological baseline is done.
//     (The Tier1-error fallback path reaches Tier2 pre-curation and keeps it.)
//   - Each match cycle (A clinic / B egg donor / C sperm donor / D surrogate)
//     only when the parent's profile, registered services, or recent chat
//     show that journey is in scope. Country routing rides with cycle D.
// The DB section stays ONE admin-editable blob - slicing is at read time off
// stable header markers. Any missing/reordered marker falls back to the full
// section with a loud log (never silently drop instructions).
// -------------------------------------------------------------------------
const CF_PHASE3 = "=== PHASE 3: PROGRESSIVE MATCH CYCLES ===";
const CF_CYCLE_A = "--- MATCH CYCLE A: IVF CLINIC ---";
const CF_CYCLE_B = "--- MATCH CYCLE B: EGG DONOR ---";
const CF_CYCLE_C = "--- MATCH CYCLE C: SPERM DONOR ---";
const CF_CYCLE_D = "--- MATCH CYCLE D: SURROGATE ---";
const CF_COUNTRY = "=== COUNTRY ROUTING";
const CF_WRAPUP = "=== PHASE 4: WRAP-UP ===";
function sliceConversationFlow(full: string, inc: { intake: boolean; A: boolean; B: boolean; C: boolean; D: boolean }): string {
  const iP3 = full.indexOf(CF_PHASE3);
  const iA = full.indexOf(CF_CYCLE_A);
  const iB = full.indexOf(CF_CYCLE_B);
  const iC = full.indexOf(CF_CYCLE_C);
  const iD = full.indexOf(CF_CYCLE_D);
  const iCountry = full.indexOf(CF_COUNTRY);
  const iWrap = full.indexOf(CF_WRAPUP);
  if (iP3 < 0 || iA < 0 || iB < 0 || iC < 0 || iD < 0 || iCountry < 0 || iWrap < 0
      || !(iP3 < iA && iA < iB && iB < iC && iC < iD && iD < iCountry && iCountry < iWrap)) {
    console.warn("[PROMPT SLICE] conversation_flow markers missing or reordered - using FULL section");
    return full;
  }
  const parts: string[] = [];
  if (inc.intake) parts.push(full.slice(0, iP3));
  parts.push(full.slice(iP3, iA)); // Phase 3 orchestration rules (cycle ordering, curation gate, pivots)
  if (inc.A) parts.push(full.slice(iA, iB));
  if (inc.B) parts.push(full.slice(iB, iC));
  if (inc.C) parts.push(full.slice(iC, iD));
  if (inc.D) parts.push(full.slice(iD, iCountry));
  if (inc.D) parts.push(full.slice(iCountry, iWrap)); // country routing is surrogacy-path-only
  parts.push(full.slice(iWrap));
  return parts.join("\n");
}

// Shared by the clinic MATCH_CARD enrichment AND the ready-turn server-side
// pre-search: derive the egg provider's age (chat scan first - ages were just
// discussed - then DB fallback) and the first-time-IVF answer from the same
// signals, so the searched success rates and the card's rates can never
// disagree.
function deriveEggProviderAge(chatHistory: any[], userRecord: any, profileEggSource: string | null | undefined, isMaleParent: boolean, resolvedEggSource: string): number | null {
  if (resolvedEggSource === "donor") return null;
  const esSaved = (profileEggSource || "").toLowerCase();
  let isPartnerEggs = esSaved.includes("partner") || (isMaleParent && resolvedEggSource === "own_eggs");
  if (!isPartnerEggs) {
    for (let i = chatHistory.length - 1; i >= Math.max(0, chatHistory.length - 30); i--) {
      if (chatHistory[i].role !== "user") continue;
      const c = (chatHistory[i].content || "").toLowerCase();
      if (/partner'?s?\s*eggs?/i.test(c)) { isPartnerEggs = true; break; }
    }
  }
  let eggProviderAge: number | null = null;
  const ageQuestionPatterns = isPartnerEggs
    ? [/how old is your partner/i, /partner.*age/i, /age.*partner/i, /partner.*old/i]
    : [/how old are you/i, /your age/i, /old are you/i];
  for (let i = 0; i < chatHistory.length - 1; i++) {
    if (chatHistory[i].role !== "assistant") continue;
    const aiMsg = chatHistory[i].content || "";
    if (ageQuestionPatterns.some(p => p.test(aiMsg)) && chatHistory[i + 1]?.role === "user") {
      const ageMatch = (chatHistory[i + 1].content || "").match(/\b(\d{2})\b/);
      if (ageMatch) {
        const age = parseInt(ageMatch[1], 10);
        if (age >= 18 && age <= 55) { eggProviderAge = age; break; }
      }
    }
  }
  if (eggProviderAge === null) {
    if (isPartnerEggs && userRecord?.partnerAge) {
      eggProviderAge = Number(userRecord.partnerAge);
    } else if (!isPartnerEggs && userRecord?.dateOfBirth) {
      eggProviderAge = Math.floor((Date.now() - new Date(userRecord.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    }
  }
  if (eggProviderAge === null) {
    for (let i = chatHistory.length - 1; i >= Math.max(0, chatHistory.length - 30); i--) {
      if (chatHistory[i].role !== "user") continue;
      const c = chatHistory[i].content || "";
      const ageMatch = c.match(/\b(\d{2})\b/);
      if (ageMatch && c.length < 50) {
        const age = parseInt(ageMatch[1], 10);
        if (age >= 20 && age <= 50) { eggProviderAge = age; break; }
      }
    }
  }
  return eggProviderAge;
}
function ageToAgeGroup(age: number): string {
  return age < 35 ? "under_35" : age <= 37 ? "35_37" : age <= 40 ? "38_40" : "over_40";
}
function deriveIsNewPatient(chatHistory: any[]): boolean | null {
  for (let i = chatHistory.length - 1; i >= Math.max(0, chatHistory.length - 30); i--) {
    const c = (chatHistory[i].content || "").toLowerCase();
    if (chatHistory[i].role === "user") {
      if (/first.?time|new to ivf|never done|^first$|^new$/i.test(c)) return true;
      if (/done.*(ivf|before)|i'?ve done|not my first|been through|returning|had prior|prior cycle/i.test(c)) return false;
    }
    if (chatHistory[i].role === "assistant" && /first time.*ivf|been through.*before/i.test(c)) {
      if (i + 1 < chatHistory.length && chatHistory[i + 1].role === "user") {
        const answer = (chatHistory[i + 1].content || "").toLowerCase();
        if (/first|new|^yes/i.test(answer)) return true;
        if (/before|done|no|prior|returning/i.test(answer)) return false;
      }
    }
  }
  return null;
}

// Post-process Gemini Tier 1 output: inject [[QUICK_REPLY:...]] tags for known
// questions when Gemini drops them. Only fires when no [[QUICK_REPLY:]] is present.
function injectMissingQuickReplies(content: string): string {
  if (/\[\[QUICK_REPLY:/.test(content) || /\[\[MULTI_SELECT:/.test(content)) return content;

  // Ordered from most specific to least specific
  const patterns: [RegExp, string][] = [
    // Phase 0
    [/do you have any questions about gostork/i, "[[QUICK_REPLY:I understand, let's get started|I have a few questions]]"],
    [/what are you looking for help with|which services.*interested|tell me.*services|services.*looking for/i, "[[MULTI_SELECT:Surrogacy|Egg Donation|Sperm Donation|IVF Clinics]]"],
    // Phase 1 identity - single 5-option question
    [/solo man.*solo woman.*two dads.*two moms.*man and a woman/i, "[[QUICK_REPLY:Solo man|Solo woman|Two dads|Two moms|Man and a woman]]"],
    [/which best describes you/i, "[[QUICK_REPLY:Solo man|Solo woman|Two dads|Two moms|Man and a woman]]"],
    [/which of these fits your journey/i, "[[QUICK_REPLY:Solo man|Solo woman|Two dads|Two moms|Man and a woman]]"],
    // Phase 1 identity - any old-style phrasing gets upgraded to 5-option format
    [/are you a woman or a man/i, "[[QUICK_REPLY:A woman|A man]]"],
    [/same-sex couple or opposite-sex/i, "[[QUICK_REPLY:Same-sex couple|Straight couple]]"],
    [/two dads.*two moms.*man and a woman/i, "[[QUICK_REPLY:Solo man|Solo woman|Two dads|Two moms|Man and a woman]]"],
    [/two moms.*two dads.*man and a woman/i, "[[QUICK_REPLY:Solo man|Solo woman|Two dads|Two moms|Man and a woman]]"],
    [/solo.*with a partner.*as a couple/i, "[[QUICK_REPLY:Solo man|Solo woman|Two dads|Two moms|Man and a woman]]"],
    [/on your own.*with a partner/i, "[[QUICK_REPLY:Solo man|Solo woman|Two dads|Two moms|Man and a woman]]"],
    [/are you on this journey solo/i, "[[QUICK_REPLY:Solo man|Solo woman|Two dads|Two moms|Man and a woman]]"],
    [/solo.*or with a partner/i, "[[QUICK_REPLY:Solo man|Solo woman|Two dads|Two moms|Man and a woman]]"],
    [/journey solo.*partner/i, "[[QUICK_REPLY:Solo man|Solo woman|Two dads|Two moms|Man and a woman]]"],
    // Phase 2 biological baseline
    [/do you already have a fertility clinic.*need help finding one/i, "[[QUICK_REPLY:I need help finding a clinic|I already have a clinic]]"],
    [/need help finding.*fertility clinic.*already have one/i, "[[QUICK_REPLY:I need help finding a clinic|I already have a clinic]]"],
    [/do you already have frozen embryos/i, "[[QUICK_REPLY:Yes, I do|No, not yet|Working to create them]]"],
    [/have they been pgt-?a tested/i, "[[QUICK_REPLY:Yes|No|I'm not sure]]"],
    [/how many embryos do you have/i, "[[QUICK_REPLY:1|2|3|4+|Not sure]]"],
    [/how many frozen embryos/i, "[[QUICK_REPLY:1|2|3|4+|Not sure]]"],
    [/how many.*pgt.*normal/i, "[[QUICK_REPLY:1|2|3|4+|Not sure]]"],
    [/how many children do you (already )?have/i, "[[QUICK_REPLY:0|1|2|3+]]"],
    // Step 1c - egg donor conflict (has embryos but registered for egg donation)
    [/fresh egg donor.*existing embryos/i, "[[QUICK_REPLY:Create new embryos with a donor|Use my existing embryos]]"],
    [/create new embryos with.*donor.*existing embryos/i, "[[QUICK_REPLY:Create new embryos with a donor|Use my existing embryos]]"],
    // Step 3b - sperm donor conflict (has embryos but registered for sperm donation)
    [/create new embryos with donor sperm.*existing embryos/i, "[[QUICK_REPLY:Create new embryos with donor sperm|Use my existing embryos]]"],
    [/donor sperm.*existing embryos/i, "[[QUICK_REPLY:Create new embryos with donor sperm|Use my existing embryos]]"],
    // Phase 1 - which partner is speaking (straight couple)
    [/are you the woman or the man/i, "[[QUICK_REPLY:I'm the woman|I'm the man]]"],
    // Step 2 - egg source (past tense, straight male: no "My own eggs")
    [/were the eggs your partner's or from a donor/i, "[[QUICK_REPLY:My partner's eggs|Donor eggs]]"],
    // Step 2 - egg source (past tense, female speaker: includes "My own eggs")
    [/were the eggs yours.*partner.*from a donor/i, "[[QUICK_REPLY:My own eggs|My partner's eggs|Donor eggs]]"],
    [/eggs yours.*partner.*from a donor/i, "[[QUICK_REPLY:My own eggs|My partner's eggs|Donor eggs]]"],
    // Step 2 - egg source: gender-dependent options are handled in the done-event fallback
    // which has isFemaleGender context. Only inject options here for the full-text patterns
    // where the question text itself already reveals which options apply.
    [/plan for eggs.*partner.*own eggs.*considering a donor/i, "[[QUICK_REPLY:My partner's eggs|Donor eggs|I'm not sure yet]]"],
    [/what.*plan for eggs.*using your own.*considering a donor/i, "[[QUICK_REPLY:My own eggs|My partner's eggs|Donor eggs|I'm not sure yet]]"],
    [/thinking of using your own.*considering a donor/i, "[[QUICK_REPLY:My own eggs|My partner's eggs|Donor eggs|I'm not sure yet]]"],
    // Step 3 - sperm source: intentionally NOT injected here to avoid streaming wrong options.
    // For female parents, "My own" is biologically impossible but inject is gender-blind.
    // All sperm source QRs are handled in the done-event fallback which has gender context.
    [/do you need help finding an egg donor/i, "[[QUICK_REPLY:I need help finding an egg donor|I already have an egg donor]]"],
    [/do you need help finding a sperm donor/i, "[[QUICK_REPLY:I need help finding a sperm donor|I already have a sperm donor]]"],
    [/do you need help finding a surrogate/i, "[[QUICK_REPLY:I need help finding a surrogate|I already have a surrogate]]"],
    [/who is.*planning to carry the pregnancy/i, "[[QUICK_REPLY:Me|My partner|A gestational surrogate]]"],
    [/who is carrying the pregnancy/i, "[[QUICK_REPLY:Me|My partner|A gestational surrogate]]"],
    // Cycle intake
    [/are you hoping for twins/i, "[[QUICK_REPLY:Yes|No]]"],
    [/are you hoping to have twins.*singleton/i, "[[QUICK_REPLY:Hoping for twins|Singleton only|No preference]]"],
    [/first ivf journey.*done ivf before/i, "[[QUICK_REPLY:First time|I've done IVF before]]"],
    [/most important.*choosing a clinic|matters most.*clinic|important.*when choosing/i, "[[MULTI_SELECT:Success rates|Location|Cost|Volume of cycles|Physician gender]]"],
    [/termination if medically necessary/i, "[[QUICK_REPLY:Pro-choice surrogate|Pro-life surrogate|No preference]]"],
    // Timeline education closing question
    [/give you a sense of what to expect/i, "[[QUICK_REPLY:Yes, makes sense|I have a question]]"],
    [/does that timeline feel right/i, "[[QUICK_REPLY:Yes, makes sense|I have a question]]"],
    [/does that give you a sense/i, "[[QUICK_REPLY:Yes, makes sense|I have a question]]"],
    // CURATION summary confirmation - "Does that sound right / correct and are you ready?"
    [/does that (?:sound right|all sound correct|sound correct).*ready/i, "[[QUICK_REPLY:Yes, I'm ready!|Let me correct something]]"],
    [/ready to see some (?:surrogate|donor|clinic|match)/i, "[[QUICK_REPLY:Yes, show me matches!|Not yet]]"],
    [/shall i find your (?:perfect )?matches/i, "[[QUICK_REPLY:Yes, find my matches!|I have a question first]]"],
    // Post-surrogate match conversion follow-up
    [/does she feel like (?:a |she could be a )?good (?:match|fit)/i, "[[QUICK_REPLY:I have questions about her|Schedule a free consultation|I don't like her]]"],
    [/ready to take the next step.*schedule/i, "[[QUICK_REPLY:Yes, schedule a call|I don't like her]]"],
    // Surrogate decline education follow-up
    [/what didn't feel right|didn't feel right to you|what.*not.*right/i, "[[QUICK_REPLY:Her location|Her age|Her BMI|Too many pregnancies|Too many C-sections|Her medical history|Her appearance|Her vibe or personality|The cost|Something else]]"],
    [/find.*someone.*better|schedule.*call.*anyway/i, "[[QUICK_REPLY:Find me someone better|Schedule a call with her anyway]]"],
  ];

  for (const [pattern, tag] of patterns) {
    if (pattern.test(content)) {
      console.log(`[Tier1 QR inject] Pattern matched, injecting: ${tag.slice(0, 60)}`);
      return content.trimEnd() + " " + tag;
    }
  }
  return content;
}

// -------------------------------------------------------------------------
// Tier 2: Gemini 3.5 Flash - matching, tool calls, complex rules
// -------------------------------------------------------------------------
async function callTier2Claude(
  systemPrompt: string,
  messages: any[],
  openAiTools: any[],
  sse: SSEHandle,
  mcpClientRef: Client | null,
  forceToolUse = false,
  parentAccountId: string | null = null,
  authUserId: string | null = null,
  lookalikePhotoUrl: string | null = null,
  freshPhotoUpload: boolean = false,
  // Ready-turn optimization: a search the server already KNOWS must run
  // (e.g. search_clinics after a clinic curation + "ready"). Executed here
  // before the first model call and handed to Gemini with its results, so the
  // usual two rounds (decide-to-search, then write) collapse into one.
  preSearch: { name: string; args: Record<string, unknown> } | null = null,
): Promise<{ content: string; toolCallsExecuted: boolean; searchToolResults: { toolName: string; resultText: string; toolArgs?: any }[] }> {
  const hasTools = openAiTools.length > 0;

  // Tools whose userId arg MUST be the authenticated parent (never trust the
  // model-supplied value) so a parent can only ever read their own data.
  const injectAuthUser = (fc: { name: string; args: any }) => {
    if (authUserId && fc.name === "get_parent_meetings") {
      fc.args = { ...(fc.args || {}), userId: authUserId };
    }
    // Clinic search: the matching-requirements check derives the parent's
    // age / patient type / embryo situation SERVER-side from their profile,
    // so enforcement never depends on the model remembering to pass args.
    if (authUserId && fc.name === "search_clinics") {
      fc.args = { ...(fc.args || {}), userId: authUserId };
      // Widen the candidate pool: priority re-ranking (cost / location / volume
      // of cycles) needs more than the success-rate top 5 to choose from - a
      // cheap or nearby clinic ranked #6 by success rate must be able to
      // surface. maybeRerankClinicsByPriorities trims back to 5 after sorting.
      const requestedLimit = Number((fc.args as any).limit) || 0;
      if (requestedLimit < 10) (fc.args as any).limit = 10;
    }
    // Look-alike face match: both the parent identity and the photo to match
    // are server-supplied (never trust model-supplied values). photoUrl is the
    // session's most recent upload.
    if (fc.name === "find_lookalike_matches") {
      fc.args = {
        ...(fc.args || {}),
        ...(authUserId ? { userId: authUserId } : {}),
        ...(lookalikePhotoUrl ? { photoUrl: lookalikePhotoUrl } : {}),
        // A freshly uploaded photo is a NEW search intent - return the BEST
        // matches for it, ignoring any "already shown" exclusions the model
        // carried over from earlier in this (single, persistent) session.
        ...(freshPhotoUpload ? { excludeIds: [] } : {}),
      };
    }
  };

  // Collect inline system messages and merge into one prompt (strip the cache marker - not needed for Gemini)
  const inlineSystemParts: string[] = [];
  for (const m of messages) {
    if (m.role === "system" && typeof m.content === "string") inlineSystemParts.push(m.content);
  }
  const CACHE_MARKER = "___CACHE_BREAKPOINT___";
  const mainSystem = inlineSystemParts[0] || systemPrompt;
  const extraSystem = inlineSystemParts.slice(1).join("\n\n---\n\n");
  const markerIdx = mainSystem.indexOf(CACHE_MARKER);
  const strippedMain = markerIdx >= 0 ? mainSystem.slice(0, markerIdx) + mainSystem.slice(markerIdx + CACHE_MARKER.length) : mainSystem;
  const fullSystem = strippedMain + (extraSystem ? "\n\n---\n\n" + extraSystem : "");

  // Build Gemini history (last 20 turns, must start with a user turn)
  const TIER2_MAX_HISTORY = 20;
  const rawHistory = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: (m.role === "assistant" ? "model" : "user") as "model" | "user",
      parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
    }))
    .slice(-TIER2_MAX_HISTORY);
  const firstUserIdx = rawHistory.findIndex((m) => m.role === "user");
  const trimmedHistory = firstUserIdx >= 0 ? rawHistory.slice(firstUserIdx) : [];
  const chatHistory = trimmedHistory.slice(0, -1); // all but the current user message

  const lastNonSystem = messages.filter((m) => m.role !== "system").at(-1);
  const userMessage = typeof lastNonSystem?.content === "string" ? lastNonSystem.content : JSON.stringify(lastNonSystem?.content ?? "");

  // Convert OpenAI tool format to Gemini FunctionDeclaration format
  const geminiTools = hasTools
    ? [{ functionDeclarations: openAiTools.map((t: any) => ({ name: t.function.name, description: t.function.description || "", parameters: t.function.parameters })) }]
    : undefined;

  // thinkingBudget 0 disables the hidden reasoning phase, same as Tier1. Measured
  // 2026-07-17: with thinking on, call1 median was ~7s REGARDLESS of prompt size
  // (a 30% prompt cut moved nothing) - the reasoning phase, not prefill, dominated
  // Tier2 latency. TIER2_THINKING=1 restores it for A/B comparison.
  const model = geminiAI.getGenerativeModel({
    // TIER2_MODEL overrides for A/B (e.g. gemini-3.1-flash-lite); default stays
    // the flagship - the whole 73-test suite is tuned against it.
    model: process.env.TIER2_MODEL || "gemini-3.5-flash",
    ...(process.env.TIER2_THINKING === "1" ? {} : { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } as any }),
    ...(geminiTools ? { tools: geminiTools as any } : {}),
    systemInstruction: { parts: [{ text: fullSystem }] },
  });

  let chat = model.startChat({ history: chatHistory });

  // The SDK's streaming path does not always commit the model's functionCall
  // turn to the ChatSession history. Sending the functionResponse then fails
  // the whole turn with a hard 400 ("function response turn comes immediately
  // after a function call turn") and the parent gets a completely EMPTY reply
  // - observed live on every tool-backed question in a post-booking session
  // ("when is my call again?", "what did they quote me?", "is my contract
  // signed?"). Repair deterministically: rebuild the chat with an EXPLICIT
  // history containing the user turn and the model's functionCall parts, so
  // the functionResponse always has its call to attach to.
  // IMPORTANT: reuse the model's ORIGINAL content parts verbatim. Gemini 3.x
  // requires a `thought_signature` on functionCall parts; hand-rebuilding them
  // from {name, args} drops it and trades the first 400 for a second one
  // ("Function call is missing a thought_signature in functionCall parts").
  const rebuildChatForToolResponse = (modelContent: any) => {
    if (!modelContent?.parts?.length) return false;
    chat = model.startChat({
      history: [
        ...chatHistory,
        { role: "user" as const, parts: [{ text: userMessage }] },
        { role: "model" as const, parts: modelContent.parts },
      ],
    });
    return true;
  };

  // Runs a tool-response round, repairing the SDK's dropped functionCall turn
  // on the 400 described above. `callsForRepair` are the calls this response
  // answers, so the rebuilt history can carry them.
  // Minimal tool executor for the non-streaming replay path (read-only
  // lookups, so re-running them is safe).
  const execCallsForReplay = async (calls: any[]): Promise<any[]> => {
    const out: any[] = [];
    for (const fc of calls) {
      if (!mcpClientRef) continue;
      const overLimitMsg = overSearchLimit(fc as any);
      if (overLimitMsg) {
        out.push({ functionResponse: { name: fc.name, response: { output: overLimitMsg } } });
        continue;
      }
      try {
        injectAuthUser(fc as any);
        const toolResult = await mcpClientRef.callTool({ name: fc.name, arguments: fc.args as Record<string, unknown> }, undefined, { timeout: 180_000 });
        let resultText = (toolResult.content as any)?.[0]?.text || JSON.stringify(toolResult);
        resultText = await maybeReorderCountryPrograms(fc.name, resultText);
        resultText = await maybeRerankClinicsByPriorities(fc.name, resultText, fc.args);
        const MAX_TOOL_RESULT = 8000;
        if (searchToolNames.includes(fc.name) && resultText.length > MAX_TOOL_RESULT) {
          resultText = resultText.slice(0, MAX_TOOL_RESULT) + "\n\n[Results truncated - present the first surrogate above as a [[MATCH_CARD]] only]";
        }
        out.push({ functionResponse: { name: fc.name, response: { output: resultText } } });
        if (searchToolNames.includes(fc.name)) searchToolResults.push({ toolName: fc.name, resultText, toolArgs: fc.args });
      } catch (e: any) {
        out.push({ functionResponse: { name: fc.name, response: { output: `Error: ${e.message}` } } });
      }
    }
    return out;
  };

  const streamToolResponseTurn = async (message: any, _modelContentForRepair: any) => {
    try {
      return await streamTurn(message);
    } catch (e: any) {
      const isHistoryOrderError = /function response turn comes immediately after a function call turn/i.test(e?.message || "");
      if (!isHistoryOrderError) throw e;
      // The streaming SDK path does not commit the model's functionCall turn
      // (and its Gemini-3.x thought_signature) to history, so the tool response
      // has nothing valid to attach to and the whole turn 400s - the parent got
      // a completely EMPTY reply on every tool-backed question. Rebuilding the
      // call parts by hand fails too (signatures cannot be forged). The
      // reliable repair is to REPLAY the turn on the non-streaming path, which
      // keeps history intact.
      console.warn(`[TIER2 HISTORY REPAIR] Streaming dropped the functionCall turn - replaying this turn non-streaming`);
      forceNonStream = true;
      chat = model.startChat({ history: chatHistory });
      const first = await streamTurn(userMessage);
      if (first.functionCalls.length === 0) return first;
      const responses = await execCallsForReplay(first.functionCalls);
      return await streamTurn(responses);
    }
  };

  let toolCallsExecuted = false;
  // The model turn the pending currentMessage answers, captured verbatim
  // (functionCall parts + thought signatures) for the history repair.
  let lastModelContent: any = null;
  const searchToolResults: { toolName: string; resultText: string; toolArgs?: any }[] = [];
  const t0 = Date.now();
  const searchToolNames = ["search_surrogates", "search_egg_donors", "search_sperm_donors", "search_clinics", "find_lookalike_matches"];
  // Per-turn cap on REPEATED calls to the same search tool. The model sometimes
  // hunts for a "perfect" result by re-calling the same search 5-8 times in one
  // turn (each retry re-prefills the full system prompt = +3-7s), even hitting
  // MAX_TOOL_ROUNDS. The tools already relax filters server-side, so a repeat
  // search rarely returns anything new - after 2 calls the model is told to
  // present from what it already has.
  const searchCallCounts = new Map<string, number>();
  const overSearchLimit = (fc: { name: string }): string | null => {
    if (!searchToolNames.includes(fc.name)) return null;
    const n = (searchCallCounts.get(fc.name) || 0) + 1;
    searchCallCounts.set(fc.name, n);
    if (n <= 2) return null;
    console.log(`[TIER2] ${fc.name} call #${n} this turn - short-circuited (present from prior results)`);
    return `SEARCH LIMIT REACHED for this turn. You have already called ${fc.name} twice - do NOT search again. The tool already relaxed filters automatically, so a repeat search will not surface different results. Present the best match from the results you ALREADY received above using ONE [[MATCH_CARD]] now, and be transparent with the parent about any preference that could not be fully matched.`;
  };
  console.log(`[TIER2] start: history=${chatHistory.length} turns, system=${fullSystem.length} chars, tools=${openAiTools.length}`);

  // After search_surrogacy_agencies returns, reorder the agency list cheapest-first
  // by the role-aware COMBINED country-program cost (agency surrogacy fee + each
  // partner clinic's IVF / egg-donor program, matched to THIS parent's profile).
  // Eva is instructed to present results in the returned order, so this guarantees
  // the cheapest country program is offered first when multiple pass the
  // hard-reject check. Falls through silently on any failure - ordering is a
  // quality improvement, not a correctness gate; the cards still hydrate
  // authoritative costs from /api/costs/.../country-program at render time.
  const maybeReorderCountryPrograms = async (toolName: string, resultText: string): Promise<string> => {
    if (toolName !== "search_surrogacy_agencies") return resultText;
    if (!parentAccountId) return resultText;
    try {
      const jsonStart = resultText.indexOf("[");
      const jsonEnd = resultText.lastIndexOf("]");
      if (jsonStart < 0 || jsonEnd <= jsonStart) return resultText;
      const before = resultText.slice(0, jsonStart);
      const after = resultText.slice(jsonEnd + 1);
      const agencies = JSON.parse(resultText.slice(jsonStart, jsonEnd + 1));
      // Annotate even single-agency results - Eva uses estimatedCombinedMinTotal
      // in the D1 international education message ("Colombia: starting from $X")
      // and the per-country search returns exactly one agency. Skipping the
      // annotation for length < 2 left D1 with no DB cost data and made Eva
      // fall back to hardcoded $100K/$65K estimates in the prompt.
      if (!Array.isArray(agencies) || agencies.length < 1) return resultText;

      const { getNestApp } = await import("./nest-app-ref");
      const nestApp = getNestApp();
      if (!nestApp) return resultText;
      const { CostsService } = await import("./src/modules/costs/costs.service");
      let costsService: any = null;
      try { costsService = nestApp.get(CostsService); } catch { return resultText; }
      if (!costsService) return resultText;

      const costs = await Promise.all(
        agencies.map(async (a: any) => {
          if (!a?.id) return { id: a?.id, sort: Number.POSITIVE_INFINITY, cost: null };
          try {
            const c = await costsService.getCombinedCountryProgramCost(a.id, parentAccountId);
            const min = typeof c?.combinedMinTotal === "number" ? c.combinedMinTotal : null;
            return {
              id: a.id,
              sort: min != null && min > 0 ? min : Number.POSITIVE_INFINITY,
              cost: c,
            };
          } catch (e: any) {
            console.log(`[COUNTRY ORDER] cost fetch failed for ${a.id}: ${e.message}`);
            return { id: a.id, sort: Number.POSITIVE_INFINITY, cost: null };
          }
        }),
      );
      const costById = new Map(costs.map((c) => [c.id, c]));
      const sorted = [...agencies].sort((a: any, b: any) => {
        const sa = costById.get(a?.id)?.sort ?? Number.POSITIVE_INFINITY;
        const sb = costById.get(b?.id)?.sort ?? Number.POSITIVE_INFINITY;
        return sa - sb;
      });
      // Annotate each agency with the authoritative combined min/max + country
      // so Eva can present the cheapest-first ordering with confidence.
      const annotated = sorted.map((a: any) => {
        const c = costById.get(a?.id)?.cost;
        if (!c) return a;
        return {
          ...a,
          estimatedCombinedMinTotal: c.combinedMinTotal,
          estimatedCombinedMaxTotal: c.combinedMaxTotal,
          estimatedCountry: c.country,
        };
      });
      const orderingNote = annotated.length >= 2
        ? `\n\nORDERING: The agencies above are sorted by COMBINED country-program cost (agency surrogacy fee + partner clinic IVF/egg-donor cost) ASCENDING. Present them to the parent in this order - cheapest first. Each agency carries estimatedCombinedMinTotal/MaxTotal/Country for your reference; for [[MATCH_CARD:CountryProgram]] cards do NOT write the dollar amount yourself, the card hydrates authoritative costs at render time. For the D1 INTERNATIONAL EDUCATION message you MUST use the MIN of estimatedCombinedMinTotal across agencies for each country as "starting from $X" - this is the real DB cost for THIS parent's coverage (IVF + egg donor + surrogate, etc.).`
        : `\n\nCOST: Each agency above carries estimatedCombinedMinTotal/MaxTotal/Country - this is the authoritative COMBINED program cost (agency surrogacy fee + partner clinic IVF/egg-donor cost) matched to THIS parent's coverage. For the D1 INTERNATIONAL EDUCATION message you MUST use estimatedCombinedMinTotal as the country's "starting from $X" - this is the real DB cost, NOT a hardcoded estimate. For [[MATCH_CARD:CountryProgram]] cards do NOT write the dollar amount yourself, the card hydrates authoritative costs at render time.`;
      return before + JSON.stringify(annotated, null, 2) + after + orderingNote;
    } catch (e: any) {
      console.log(`[COUNTRY ORDER] reorder failed: ${e.message}`);
      return resultText;
    }
  };

  // After search_clinics returns, re-rank the clinics by the parent's stated
  // A5 priorities ("What's most important to you when choosing a clinic?").
  // The MCP tool sorts by success rate alone; when the parent said cost,
  // location, or volume of cycles matter, those MUST shape the order -
  // otherwise asking A5 is theater. Cost comes from the same parent-matched
  // CostsService programs the profile page uses (via nest-app-ref, like the
  // agency reorder above). Falls through silently on any failure - ordering
  // is a quality improvement, not a correctness gate.
  const CLINIC_PRIORITY_PATTERNS: { dim: string; re: RegExp }[] = [
    { dim: "success", re: /success/i },
    { dim: "cost", re: /\bcost|price|pricing|afford|budget|cheap|expensive/i },
    { dim: "location", re: /location|close to|near me|nearby|distance|local|drive|commute/i },
    { dim: "volume", re: /volume|number of cycles|cycles per year/i },
    { dim: "physicianGender", re: /physician gender|doctor gender|(female|male|woman|man) (doctor|physician)/i },
  ];
  const maybeRerankClinicsByPriorities = async (toolName: string, resultText: string, toolArgs: any): Promise<string> => {
    if (toolName !== "search_clinics" || !parentAccountId) return resultText;
    try {
      // 1. Gather the parent's stated priorities: profile first, then the chat
      //    answer to the A5 question (Eva often misses the [[SAVE]] for A5 -
      //    the A5 SAVE FALLBACK also patches it, but Tier2-only paths where
      //    the bypass never fired still need the chat scan).
      let rawPriorities = "";
      try {
        const profileRow = await prisma.intendedParentProfile.findUnique({
          where: { parentAccountId },
          select: { clinicPriority: true, clinicPriorityTags: true },
        });
        rawPriorities = [profileRow?.clinicPriority, profileRow?.clinicPriorityTags].filter(Boolean).join(", ");
      } catch { /* profile lookup is best-effort */ }
      if (!rawPriorities) {
        const nonSystem = messages.filter((m: any) => m.role !== "system");
        for (let i = nonSystem.length - 1; i > 0; i--) {
          const q = nonSystem[i - 1];
          if (q.role === "assistant" && typeof q.content === "string" && /most important.*choosing a clinic|matters most.*clinic/i.test(q.content)) {
            const ans = nonSystem[i];
            if (ans?.role === "user" && typeof ans.content === "string") rawPriorities = ans.content;
            break;
          }
        }
      }
      if (!rawPriorities) return resultText;

      const dims = new Set<string>();
      for (const p of CLINIC_PRIORITY_PATTERNS) if (p.re.test(rawPriorities)) dims.add(p.dim);
      // Free-text priorities we can't score numerically (e.g. "LGBTQ friendly",
      // "bedside manner") - surfaced to Eva so she addresses them explicitly.
      const otherPriorities = rawPriorities
        .split(/,|\band\b|\+|\//i)
        .map((s) => s.trim())
        .filter((s) => s.length > 2 && !CLINIC_PRIORITY_PATTERNS.some((p) => p.re.test(s)));
      if (dims.size === 0 && otherPriorities.length === 0) return resultText;

      // 2. Parse the tool's JSON payload
      const jsonStart = resultText.indexOf("[");
      const jsonEnd = resultText.lastIndexOf("]");
      if (jsonStart < 0 || jsonEnd <= jsonStart) return resultText;
      let before = resultText.slice(0, jsonStart);
      const after = resultText.slice(jsonEnd + 1);
      let clinics: any[] = JSON.parse(resultText.slice(jsonStart, jsonEnd + 1));
      if (!Array.isArray(clinics) || clinics.length === 0) return resultText;

      const notes: string[] = [];

      // 3. Cost: parent-matched program starting cost per clinic, so cost can
      //    be ranked AND so Eva never invents pricing for a clinic without any.
      if (dims.has("cost")) {
        try {
          const { getNestApp } = await import("./nest-app-ref");
          const nestApp = getNestApp();
          const { CostsService } = await import("./src/modules/costs/costs.service");
          const costsService: any = nestApp ? nestApp.get(CostsService) : null;
          if (costsService) {
            await Promise.all(clinics.map(async (c: any) => {
              try {
                const res = await costsService.getProviderParentPrograms(c.id, parentAccountId);
                const totals = (res?.programs || [])
                  .map((p: any) => Number(p.minTotal))
                  .filter((n: number) => Number.isFinite(n) && n > 0);
                c.costMinTotal = totals.length > 0 ? Math.min(...totals) : null;
                c.costProgramCount = (res?.programs || []).length;
              } catch {
                c.costMinTotal = null;
                c.costProgramCount = 0;
              }
            }));
            const missingCost = clinics.filter((c: any) => c.costMinTotal == null).map((c: any) => c.name);
            notes.push(`COST: the parent said COST matters. Each clinic carries costMinTotal - the authoritative parent-matched program starting cost from the DB - use it when discussing price.${missingCost.length > 0 ? ` These clinics have NO published pricing for this parent: ${missingCost.join(", ")}. NEVER state, estimate, or imply a price for them and NEVER praise their pricing - be transparent that they haven't published pricing yet and offer to request it for the parent.` : ""}`);
          }
        } catch (e: any) {
          console.log(`[CLINIC RANK] cost fetch failed: ${e.message}`);
        }
      }

      // 4. Location: the parent's own city/state (User record, else search args)
      let parentCity: string | null = null;
      let parentState: string | null = null;
      if (dims.has("location")) {
        if (authUserId) {
          try {
            const u = await prisma.user.findUnique({ where: { id: authUserId }, select: { city: true, state: true } });
            parentCity = u?.city || null;
            parentState = u?.state || null;
          } catch { /* best-effort */ }
        }
        if (!parentCity && !parentState) {
          parentCity = toolArgs?.city || null;
          parentState = toolArgs?.state || toolArgs?.location || null;
        }
      }
      const locationScore = (c: any): number => {
        const cityL = (parentCity || "").toLowerCase().trim();
        const stateL = (parentState || "").toLowerCase().trim();
        if (!cityL && !stateL) return 0;
        let best = 0;
        for (const loc of Array.isArray(c.locations) ? c.locations : []) {
          const ll = String(loc).toLowerCase();
          if (cityL && ll.includes(cityL)) return 1;
          if (stateL) {
            // 2-letter state codes need token-exact matching ("ny" is inside "sunnyvale")
            const stateHit = stateL.length <= 2 ? ll.split(/[^a-z]+/).includes(stateL) : ll.includes(stateL);
            if (stateHit) best = Math.max(best, 0.6);
          }
        }
        return best;
      };

      // 5. Physician gender: no structured preference field exists - hand it to Eva
      if (dims.has("physicianGender")) {
        notes.push(`PHYSICIAN GENDER: the parent said physician gender matters. Ask which gender they prefer (if the conversation hasn't established it), then use search_doctors with providerGender to surface a matching doctor at the recommended clinic.`);
      }

      // 6. Composite score over the scorable priorities, equal weights. Success
      //    rate stays a tiebreaker even when not selected, never a hidden rank.
      const scorable = ["success", "cost", "location", "volume"].filter((d) => dims.has(d));
      const rerank = scorable.some((d) => d !== "success") && clinics.length >= 2;
      if (rerank) {
        const rates = clinics.map((c: any) => parseFloat(c.successRate) || 0);
        const maxRate = Math.max(...rates, 0);
        const cyclesArr = clinics.map((c: any) => Number(c.cycleCount) || 0);
        const maxCycles = Math.max(...cyclesArr, 0);
        const knownCosts = clinics
          .map((c: any) => (typeof c.costMinTotal === "number" && c.costMinTotal > 0 ? c.costMinTotal : null))
          .filter((n: number | null): n is number => n != null);
        const cheapest = knownCosts.length > 0 ? Math.min(...knownCosts) : null;
        for (const c of clinics) {
          const parts: number[] = [];
          for (const d of scorable) {
            if (d === "success") parts.push(maxRate > 0 ? (parseFloat(c.successRate) || 0) / maxRate : 0);
            else if (d === "volume") parts.push(maxCycles > 0 ? (Number(c.cycleCount) || 0) / maxCycles : 0);
            else if (d === "location") parts.push(locationScore(c));
            else if (d === "cost") parts.push(cheapest != null && typeof c.costMinTotal === "number" && c.costMinTotal > 0 ? cheapest / c.costMinTotal : 0);
          }
          c.priorityScore = parts.length > 0 ? Number((parts.reduce((a, b) => a + b, 0) / parts.length).toFixed(3)) : 0;
        }
        clinics.sort((a: any, b: any) => {
          if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
          const ra = parseFloat(a.successRate) || 0;
          const rb = parseFloat(b.successRate) || 0;
          if (rb !== ra) return rb - ra;
          return (b.sponsored ? 1 : 0) - (a.sponsored ? 1 : 0);
        });
        notes.push(`RANKING: the clinics above are sorted by a composite of the parent's stated priorities (${scorable.join(", ")}) - each carries priorityScore. Present them IN THIS ORDER, and when you recommend one, explain the fit against EVERY priority the parent named (not just success rates).`);
      }
      if (otherPriorities.length > 0) {
        notes.push(`OTHER PRIORITIES: the parent also said these matter: ${otherPriorities.join("; ")}. Address each one explicitly when presenting a clinic - if you have no data for one, say so honestly instead of ignoring it.`);
      }

      // 7. Trim the widened pool back down so the prompt stays lean - after
      //    re-ranking, the top 5 are the right 5 for THIS parent.
      if (clinics.length > 5) clinics = clinics.slice(0, 5);
      before = before.replace(/Found \d+ IVF clinics/, `Found ${clinics.length} IVF clinics`);

      console.log(`[CLINIC RANK] priorities="${rawPriorities.slice(0, 80)}" dims=[${[...dims].join(",")}] reranked=${rerank} order=${clinics.map((c: any) => c.name).join(" > ")}`);
      return before + JSON.stringify(clinics, null, 2) + after + (notes.length > 0 ? "\n\n" + notes.join("\n\n") : "");
    } catch (e: any) {
      console.log(`[CLINIC RANK] rerank failed: ${e.message}`);
      return resultText;
    }
  };

  let currentMessage: any = userMessage;
  // Multi-step tool chain support. Gemini frequently chains 2-4 tool calls before
  // producing the final text (e.g. search_surrogates -> resolve_match_card ->
  // search_knowledge_base -> text). A comparison turn can need a few more (resolve
  // 2+ entities, then emit the tag), so the cap is 8 to leave room to actually emit
  // the card after the lookups. Hard cap to prevent infinite loops.
  const MAX_TOOL_ROUNDS = 8;
  let toolRoundCount = 0;
  // forceToolUse: this turn is ORDERED to search (ready-after-curation with no cards shown
  // for the pending service). If the model answers with text and no tool call anyway, retry
  // once with an explicit correction instead of accepting the drift (calendar offers for
  // never-presented providers, re-curation, etc.). One retry only - a second refusal is
  // returned as-is so the failure stays loud rather than looping.
  let forcedSearchRetryDone = false;

  // TRUE STREAMING with a peek window. Previously every tool-enabled round used
  // non-streaming sendMessage and the full reply was fake-streamed only after
  // complete generation - the parent stared at "typing" for the entire
  // generation time. Now text deltas forward to the SSE as Gemini produces
  // them. The first PEEK_CHARS stay buffered so a round that opens with a
  // functionCall part remains silent exactly like before; the rare
  // text-then-functionCall mix is reconciled by the client's final "done"
  // replace (the client already rebuilds the message from the processed
  // content at done). freshPhotoUpload keeps its full suppression.
  // Set by the history-order repair below: forces the non-streaming SDK path,
  // which maintains tool-call history (and its thought signatures) correctly.
  let forceNonStream = false;
  const streamTurn = async (message: any): Promise<{ text: string; functionCalls: any[]; response: any }> => {
    if (forceNonStream) {
      const r = await chat.sendMessage(message);
      const resp = r.response;
      const fcs = resp.functionCalls() || [];
      const txt = fcs.length === 0 ? (resp.text() || "") : (() => { try { return resp.text() || ""; } catch { return ""; } })();
      if (!freshPhotoUpload && fcs.length === 0 && txt) sse.sendToken(txt);
      return { text: txt, functionCalls: fcs, response: resp };
    }
    // Tier2 true streaming is ON by default (TIER2_STREAM=0 is the kill switch).
    // History: under the OLD conditions (173KB prompt + model-driven search
    // chains) streaming dropped [[MATCH_CARD]] tags 8/8 on MW-03/MW-19 and
    // produced MALFORMED_RESPONSE empties. After the journey-sliced prompt,
    // ready-turn pre-search, and search-repeat cap landed (2026-07-17), the
    // same tests went green with streaming on: 4/4 former victims passed and
    // the full suite held baseline (71/73, both failures known flakes). If
    // match cards start vanishing again, flip TIER2_STREAM=0 first.
    if (process.env.TIER2_STREAM === "0") {
      const r = await chat.sendMessage(message);
      const resp = r.response;
      const fcs = resp.functionCalls() || [];
      const txt = fcs.length === 0 ? (resp.text() || "") : (() => { try { return resp.text() || ""; } catch { return ""; } })();
      if (!freshPhotoUpload && fcs.length === 0 && txt) {
        for (const word of txt.split(" ")) sse.sendToken(word + " ");
      }
      return { text: txt, functionCalls: fcs, response: resp };
    }
    const result = await chat.sendMessageStream(message);
    let text = "";
    let forwarded = 0;
    let sawFunctionCall = false;
    const PEEK_CHARS = 80;
    for await (const chunk of result.stream) {
      // NOTE: .functionCalls() and .text() are read separately so a throw in one
      // can never drop the other's content for the same chunk.
      try {
        if (!sawFunctionCall && (chunk.functionCalls?.()?.length ?? 0) > 0) sawFunctionCall = true;
      } catch { /* candidate without function parts */ }
      let t = "";
      try { t = chunk.text(); } catch { /* blocked/partless chunk */ }
      if (!t) continue;
      text += t;
      if (!freshPhotoUpload && !sawFunctionCall && text.length >= PEEK_CHARS) {
        sse.sendToken(text.slice(forwarded));
        forwarded = text.length;
      }
    }
    const response = await result.response;
    const functionCalls = response.functionCalls() || [];
    // Flush the tail (or a short-but-final reply that never crossed the peek window)
    if (!freshPhotoUpload && functionCalls.length === 0 && text.length > forwarded) {
      sse.sendToken(text.slice(forwarded));
    }
    return { text, functionCalls, response };
  };

  // READY-TURN PRE-SEARCH: run the known-required search server-side and hand
  // Gemini the results inside the same message - one writing pass instead of
  // decide-to-search + write. Falls back to the normal model-driven flow on
  // any failure (loudly logged, never fabricated).
  if (preSearch && mcpClientRef) {
    try {
      const fcLike = { name: preSearch.name, args: { ...preSearch.args } };
      injectAuthUser(fcLike);
      searchCallCounts.set(fcLike.name, 1); // counts toward the per-turn repeat cap
      const tPre = Date.now();
      const toolResult = await mcpClientRef.callTool({ name: fcLike.name, arguments: fcLike.args }, undefined, { timeout: 180_000 });
      let resultText = (toolResult.content as any)?.[0]?.text || JSON.stringify(toolResult);
      resultText = await maybeReorderCountryPrograms(fcLike.name, resultText);
      resultText = await maybeRerankClinicsByPriorities(fcLike.name, resultText, fcLike.args);
      const MAX_TOOL_RESULT = 8000;
      if (resultText.length > MAX_TOOL_RESULT) {
        resultText = resultText.slice(0, MAX_TOOL_RESULT) + "\n\n[Results truncated - present the first result above as a [[MATCH_CARD]] only]";
      }
      console.log(`[TIER2 PRE-SEARCH] ${fcLike.name} executed server-side in ${Date.now() - tPre}ms (result=${resultText.length} chars)`);
      searchToolResults.push({ toolName: fcLike.name, resultText, toolArgs: fcLike.args });
      toolCallsExecuted = true;
      toolRoundCount = 1;
      currentMessage = `${userMessage}\n\n[SERVER NOTE: ${fcLike.name} was ALREADY EXECUTED for this turn using the parent's saved profile - authoritative results below. Do NOT call ${fcLike.name} again. Write the presentation NOW following the match cycle's AFTER-MATCHES rules: a short personalized intro and ONE [[MATCH_CARD]] for the FIRST result.]\n\nTOOL RESULTS:\n${resultText}`;
    } catch (e: any) {
      console.log(`[TIER2 PRE-SEARCH] ${preSearch.name} failed (${e.message}) - falling back to model-driven search`);
    }
  }

  while (true) {
    if (!toolCallsExecuted) {
      if (!hasTools) {
        // No tools - stream directly to SSE
        const tStream = Date.now();
        const result = await chat.sendMessageStream(currentMessage);
        let fullText = "";
        let firstEventMs: number | null = null;
        for await (const chunk of result.stream) {
          if (firstEventMs === null) firstEventMs = Date.now() - tStream;
          const text = chunk.text();
          if (text) { fullText += text; if (!freshPhotoUpload) sse.sendToken(text); }
        }
        console.log(`[TIER2] DONE (no tools) in ${Date.now() - t0}ms`);
        return { content: fullText, toolCallsExecuted: false, searchToolResults };
      }

      // Has tools - stream the first pass; per-chunk functionCalls detection
      // keeps tool-call turns silent while pure-text turns stream live.
      const tCall = Date.now();
      const { text: firstText, functionCalls, response: firstResponse } = await streamTurn(currentMessage);
      console.log(`[TIER2] call1 done in ${Date.now() - tCall}ms, functionCalls=${functionCalls.length}`);

      if (functionCalls.length > 0) {
        toolCallsExecuted = true;
        toolRoundCount = 1;
        const functionResponses: any[] = [];
        for (const fc of functionCalls) {
          if (mcpClientRef) {
            const overLimitMsg = overSearchLimit(fc as any);
            if (overLimitMsg) {
              functionResponses.push({ functionResponse: { name: fc.name, response: { output: overLimitMsg } } });
              continue;
            }
            const tMcp = Date.now();
            try {
              injectAuthUser(fc as any);
              const toolResult = await mcpClientRef.callTool({ name: fc.name, arguments: fc.args as Record<string, unknown> }, undefined, { timeout: 180_000 });
              let resultText = (toolResult.content as any)?.[0]?.text || JSON.stringify(toolResult);
              resultText = await maybeReorderCountryPrograms(fc.name, resultText);
              resultText = await maybeRerankClinicsByPriorities(fc.name, resultText, fc.args);
              // Truncate large search results: 29KB of surrogate data overwhelms Gemini's
              // second-round context, causing it to return 0 chars. We only need the first
              // 1-2 results to show a match card - truncate to keep the round-trip manageable.
              const MAX_TOOL_RESULT = 8000;
              if (searchToolNames.includes(fc.name) && resultText.length > MAX_TOOL_RESULT) {
                resultText = resultText.slice(0, MAX_TOOL_RESULT) + "\n\n[Results truncated - present the first surrogate above as a [[MATCH_CARD]] only]";
                console.log(`[TIER2] Truncated ${fc.name} result to ${MAX_TOOL_RESULT} chars`);
              }
              console.log(`[TIER2] MCP ${fc.name} in ${Date.now() - tMcp}ms (result=${resultText.length} chars)`);
              functionResponses.push({ functionResponse: { name: fc.name, response: { output: resultText } } });
              if (searchToolNames.includes(fc.name)) {
                searchToolResults.push({ toolName: fc.name, resultText, toolArgs: fc.args });
              }
            } catch (e: any) {
              console.log(`[TIER2] MCP ${fc.name} FAILED in ${Date.now() - tMcp}ms: ${e.message}`);
              functionResponses.push({ functionResponse: { name: fc.name, response: { output: `Error: ${e.message}` } } });
            }
          }
        }
        currentMessage = functionResponses;
        lastModelContent = (firstResponse as any)?.candidates?.[0]?.content ?? null;
      } else if (forceToolUse && !forcedSearchRetryDone) {
        // Search was mandatory this turn but the model wrote text instead. Correct it once.
        // Any partially streamed text is reconciled by the client's final "done" replace
        // (same mechanism the anti-echo guard relies on).
        forcedSearchRetryDone = true;
        console.log(`[TIER2 FORCE-SEARCH] required search tool not called (model wrote ${firstText.length} chars instead) - corrective retry`);
        currentMessage = `SYSTEM ENFORCEMENT - YOUR PREVIOUS REPLY WAS REJECTED AND NOT SHOWN TO THE PARENT.
The parent said "ready" after a [[CURATION]] summary for a service whose matches have NOT been shown yet. This turn MUST call the appropriate search tool (search_surrogates, search_surrogacy_agencies, search_egg_donors, search_sperm_donors, or search_clinics).
- Do NOT offer a consultation, calendar, or booking - no provider for this service has been presented yet.
- Do NOT send [[CURATION]] again and do NOT ask more questions.
Call the correct search tool NOW, then present the FIRST result with ONE [[MATCH_CARD]].`;
      } else {
        // Model chose text instead of calling tools - already streamed live by streamTurn
        console.log(`[TIER2] DONE (text w/ tools enabled) in ${Date.now() - t0}ms`);
        if (!firstText) {
          // Empty text + no tool calls: surface WHY (finishReason SAFETY /
          // RECITATION / MAX_TOKENS etc.) instead of failing silently.
          const cand0 = (firstResponse as any)?.candidates?.[0];
          console.warn(`[TIER2] Empty no-tools response - finishReason=${cand0?.finishReason || "UNKNOWN"} safety=${JSON.stringify(cand0?.safetyRatings || null)} promptFeedback=${JSON.stringify((firstResponse as any)?.promptFeedback || null)}`);
        }
        return { content: firstText, toolCallsExecuted: false, searchToolResults };
      }
    } else {
      // ROOT CAUSE FIX for "Stream AND response.text() both empty - Gemini produced no
      // content after tool call":
      //
      // The previous code passed toolConfig.mode="NONE" to tell Gemini "don't call any
      // more tools, just respond with text." Diagnostic logging revealed Gemini IGNORES
      // that setting - the model returns a fresh functionCall part (e.g. resolve_match_
      // card, search_knowledge_base, search_surrogates again) accompanied by an empty
      // text part `{"text":""}`. So the "empty response" was actually the model
      // legitimately wanting to chain more tool calls; our code just ignored the
      // functionCall and surfaced the empty text.
      //
      // Fix: loop through tool calls until the model produces text. Each iteration we
      // sendMessage with the previous functionResponses, check whether the model called
      // more tools, execute those if so, otherwise extract text. A MAX_TOOL_ROUNDS cap
      // (declared above the while) prevents infinite tool chains.
      const tStream2 = Date.now();
      const { text: roundText, functionCalls: moreFunctionCalls, response: roundResponse } = await streamToolResponseTurn(currentMessage, lastModelContent);

      if (moreFunctionCalls.length > 0) {
        if (toolRoundCount >= MAX_TOOL_ROUNDS) {
          console.warn(`[TIER2] Hit MAX_TOOL_ROUNDS=${MAX_TOOL_ROUNDS} - bailing. Attempted: ${moreFunctionCalls.map(f => f.name).join(",")}`);
          return { content: "", toolCallsExecuted: true, searchToolResults };
        }
        toolRoundCount += 1;
        console.log(`[TIER2] Round ${toolRoundCount}/${MAX_TOOL_ROUNDS} - model chained ${moreFunctionCalls.length} more tool call(s): ${moreFunctionCalls.map(f => f.name).join(",")}`);
        const moreResponses: any[] = [];
        for (const fc of moreFunctionCalls) {
          if (mcpClientRef) {
            const overLimitMsg = overSearchLimit(fc as any);
            if (overLimitMsg) {
              moreResponses.push({ functionResponse: { name: fc.name, response: { output: overLimitMsg } } });
              continue;
            }
            const tMcp = Date.now();
            try {
              injectAuthUser(fc as any);
              const toolResult = await mcpClientRef.callTool({ name: fc.name, arguments: fc.args as Record<string, unknown> }, undefined, { timeout: 180_000 });
              let resultText = (toolResult.content as any)?.[0]?.text || JSON.stringify(toolResult);
              resultText = await maybeReorderCountryPrograms(fc.name, resultText);
              resultText = await maybeRerankClinicsByPriorities(fc.name, resultText, fc.args);
              const MAX_TOOL_RESULT = 8000;
              if (searchToolNames.includes(fc.name) && resultText.length > MAX_TOOL_RESULT) {
                resultText = resultText.slice(0, MAX_TOOL_RESULT) + "\n\n[Results truncated - present the first result above as a [[MATCH_CARD]] only]";
                console.log(`[TIER2] Truncated ${fc.name} result to ${MAX_TOOL_RESULT} chars`);
              }
              console.log(`[TIER2] MCP ${fc.name} in ${Date.now() - tMcp}ms (result=${resultText.length} chars)`);
              moreResponses.push({ functionResponse: { name: fc.name, response: { output: resultText } } });
              if (searchToolNames.includes(fc.name)) {
                searchToolResults.push({ toolName: fc.name, resultText, toolArgs: fc.args });
              }
            } catch (e: any) {
              console.log(`[TIER2] MCP ${fc.name} FAILED in ${Date.now() - tMcp}ms: ${e.message}`);
              moreResponses.push({ functionResponse: { name: fc.name, response: { output: `Error: ${e.message}` } } });
            }
          }
        }
        currentMessage = moreResponses;
        lastModelContent = (roundResponse as any)?.candidates?.[0]?.content ?? null;
        continue; // loop back for another round
      }

      // Model produced text (no more tools) - streamTurn already forwarded it live.
      let fullText = roundText || "";
      if (!fullText) {
        // Truly empty after no more tool calls. Diagnostic log so the next dev knows why.
        const candidates = (roundResponse as any)?.candidates || [];
        const cand0 = candidates[0] || {};
        const finishReason = cand0?.finishReason || "UNKNOWN";
        const partsCount = cand0?.content?.parts?.length || 0;
        const partKinds = (cand0?.content?.parts || []).map((p: any) =>
          p.text ? `text(${p.text.length})` :
          p.functionCall ? `fnCall(${p.functionCall.name})` :
          p.functionResponse ? `fnResp(${p.functionResponse.name})` :
          JSON.stringify(p).slice(0, 80)
        );
        const usageMetadata = (roundResponse as any)?.usageMetadata;
        console.warn(`[TIER2] After ${toolRoundCount} tool round(s), Gemini returned no text - finishReason=${finishReason} parts=${partsCount} [${partKinds.join(",")}]${usageMetadata ? ` tokens(in=${usageMetadata.promptTokenCount},out=${usageMetadata.candidatesTokenCount})` : ""}`);
      }
      console.log(`[TIER2] DONE (after ${toolRoundCount} tool round(s)) in ${Date.now() - tStream2}ms (${fullText.length} chars). Total TIER2 ${Date.now() - t0}ms`);
      return { content: fullText, toolCallsExecuted: true, searchToolResults };
    }
  }
}

// Clean session titles: strip alphabetic prefixes from IDs (e.g. "Surrogate #pdf-23068" → "Surrogate #23068")
function cleanTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  return title.replace(/#([A-Za-z]+-)/g, "#");
}

// Load prompt sections from DB (cached 2 min), fallback to null if empty
let promptSectionsCache: Map<string, string> | null = null;
let promptSectionsCacheExpiry = 0;
async function getPromptSections(): Promise<Map<string, string> | null> {
  if (Date.now() < promptSectionsCacheExpiry && promptSectionsCache) return promptSectionsCache;
  try {
    const sections = await prisma.conciergePromptSection.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } });
    if (sections.length === 0) return null; // fallback to hardcoded
    promptSectionsCache = new Map(sections.map(s => [s.key, s.content]));
    promptSectionsCacheExpiry = Date.now() + 30 * 1000;
    return promptSectionsCache;
  } catch {
    return null;
  }
}

function assemblePromptFromSections(sections: Map<string, string>, sectionKeys: string[]): string {
  return sectionKeys.map(k => sections.get(k) || "").filter(Boolean).join("\n\n");
}

// D1 country starting-cost lookup. Used by all three intake bypass paths
// (carrier bypass, D-cycle bypass, generic intake-question bypass) to put
// REAL DB numbers into the international education message instead of the
// previous hardcoded "$100K Mexico / $65K Colombia" fallbacks. Costs are
// matched to THIS parent's coverage via the role-aware combiner - same
// authority as the CountryProgramCard, so the education quote and the
// later match-card cost can never diverge. Returns nulls when no priced
// program matches the parent's coverage in a country (rare); the builder
// then emits a "programs available" line instead of a fabricated number.
async function getD1CountryCosts(parentAccountId: string | null | undefined): Promise<D1Costs> {
  const out: D1Costs = { us: null, mexico: null, colombia: null };
  if (!parentAccountId) return out;
  try {
    const { getNestApp } = await import("./nest-app-ref");
    const nestApp = getNestApp();
    if (!nestApp) return out;
    const { CostsService } = await import("./src/modules/costs/costs.service");
    let costsService: any = null;
    try { costsService = nestApp.get(CostsService); } catch { return out; }
    if (!costsService) return out;

    // For each international country, find every surrogacy agency provider
    // located there (or whose published programs are tagged that country),
    // compute the parent-specific combined cost, and take the MIN. This
    // generalizes beyond the current Bioética / Eggspecting pair so a new
    // country / agency added tomorrow gets picked up automatically.
    const findAgenciesForCountry = async (country: string): Promise<string[]> => {
      // Providers that (a) actually offer a "Surrogacy Agency" service (APPROVED)
      // AND (b) have at least one CostProgram in that country tagged "surrogacy".
      // (a) filters out clinics whose IVF programs happen to be over-tagged with
      // the surrogacy service tag - e.g. Inser is a clinic, not an agency, so
      // we must not treat it as a country-program candidate. The role-aware
      // combiner then computes the parent's full journey (agency surrogacy +
      // partner clinic IVF/egg donor) for whichever real agency we pick.
      const rows: { id: string }[] = await prisma.$queryRaw`
        SELECT DISTINCT p.id::text AS id
        FROM "Provider" p
        JOIN "ProviderService" ps ON ps."providerId" = p.id AND ps.status = 'APPROVED'
        JOIN "ProviderType" pt ON pt.id = ps."providerTypeId" AND pt.name ILIKE '%surrogacy%agency%'
        JOIN "CostProgram" cp ON cp."providerId" = p.id
        WHERE cp.country ILIKE ${country}
          AND 'surrogacy' = ANY(cp."serviceTypes")
      ` as any;
      return rows.map(r => r.id);
    };

    const computeCountryMin = async (country: string): Promise<number | null> => {
      const ids = await findAgenciesForCountry(country);
      if (ids.length === 0) return null;
      const mins: number[] = [];
      for (const id of ids) {
        try {
          const r = await costsService.getCombinedCountryProgramCost(id, parentAccountId);
          if (r?.hasCost && typeof r.combinedMinTotal === "number" && r.combinedMinTotal > 0) {
            mins.push(r.combinedMinTotal);
          }
        } catch (e: any) {
          console.log(`[D1 COSTS] ${country} agency ${id} failed: ${e.message}`);
        }
      }
      return mins.length > 0 ? Math.min(...mins) : null;
    };

    // US surrogacy alone: min of all USA CostProgram totals tagged surrogacy.
    // We don't run them through getCombinedCountryProgramCost because in the
    // US the journey isn't a single bundled program - parents pay an agency
    // for surrogacy plus a separate clinic for IVF. The US line in the
    // education message is "surrogacy alone" so the aggregate min is correct.
    //
    // Provider-role filter: only providers that ACTUALLY offer a "Surrogacy
    // Agency" service (APPROVED) contribute. This mirrors the international
    // findAgenciesForCountry filter and protects against data hygiene
    // issues - an IVF clinic whose program is over-tagged with "surrogacy"
    // (e.g. Pacific Fertility Center, CNY, Inser) won't have its IVF cycle
    // fee mistaken for a "surrogacy alone" price. The role filter is the
    // authoritative signal; the serviceTypes tag is helpful but not enough.
    const computeUsMin = async (): Promise<number | null> => {
      try {
        const rows: { min: number | null }[] = await prisma.$queryRaw`
          SELECT MIN(program_total) AS min
          FROM (
            SELECT COALESCE(SUM(COALESCE(ci."minValue", 0)), 0) AS program_total
            FROM "CostProgram" cp
            JOIN "Provider" p ON p.id = cp."providerId"
            JOIN "ProviderService" psv ON psv."providerId" = p.id AND psv.status = 'APPROVED'
            JOIN "ProviderType" pt ON pt.id = psv."providerTypeId" AND pt.name ILIKE '%surrogacy%agency%'
            JOIN "ProviderCostSheet" pcs ON pcs."programId" = cp.id AND pcs.status = 'APPROVED'
            JOIN "CostItem" ci ON ci."providerCostSheetId" = pcs.id
              AND COALESCE(ci."isIncluded", true) = true
              AND COALESCE(ci."isTier", false) = false
            WHERE cp.country IN ('USA', 'United States', 'US', 'United States of America')
              AND 'surrogacy' = ANY(cp."serviceTypes")
            GROUP BY cp.id
            HAVING COALESCE(SUM(COALESCE(ci."minValue", 0)), 0) > 0
          ) sub
        ` as any;
        const v = rows?.[0]?.min;
        return typeof v === "number" && v > 0 ? v : null;
      } catch (e: any) {
        console.log(`[D1 COSTS] US min failed: ${e.message}`);
        return null;
      }
    };

    const [mexico, colombia, us] = await Promise.all([
      computeCountryMin("Mexico"),
      computeCountryMin("Colombia"),
      computeUsMin(),
    ]);
    out.mexico = mexico;
    out.colombia = colombia;
    out.us = us;
    console.log(`[D1 COSTS] parent=${parentAccountId} us=${us} mexico=${mexico} colombia=${colombia}`);
  } catch (e: any) {
    console.log(`[D1 COSTS] lookup failed: ${e.message}`);
  }
  return out;
}

// Simple non-streaming Claude call for interceptor retries (replaces gpt-4o retries)
async function claudeRetry(messages: any[]): Promise<string> {
  const systemMsg = messages.find((m: any) => m.role === "system");
  const rawHistory = messages
    .filter((m: any) => m.role === "user" || m.role === "assistant")
    .map((m: any) => ({
      role: (m.role === "assistant" ? "model" : "user") as "model" | "user",
      parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
    }));
  const firstUserIdx = rawHistory.findIndex((m) => m.role === "user");
  const history = firstUserIdx >= 0 ? rawHistory.slice(firstUserIdx) : rawHistory;
  if (!history.length) return "";
  const chatHistory = history.slice(0, -1);
  const lastMsg = history.at(-1);
  if (!lastMsg) return "";
  const userMessage = lastMsg.parts[0].text;
  const model = geminiAI.getGenerativeModel({
    model: "gemini-3.5-flash",
    ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
  });
  const chat = model.startChat({ history: chatHistory });
  const result = await chat.sendMessage(userMessage);
  return result.response.text();
}

export const aiRouter = Router();

// JWT Bearer token middleware - allows tests and mobile clients to authenticate
// without a session cookie. Falls back gracefully to Passport session auth.
aiRouter.use(async (req: any, _res: any, next: any) => {
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

// Cache MCP tools list - refreshed every 5 minutes instead of every message
let cachedOpenAiTools: any[] = [];
let toolsCacheExpiry = 0;
export function invalidateMcpToolsCache() { toolsCacheExpiry = 0; cachedOpenAiTools = []; }
async function getCachedMcpTools(mcpClient: Client | null): Promise<any[]> {
  if (!mcpClient) return [];
  if (Date.now() < toolsCacheExpiry && cachedOpenAiTools.length > 0) return cachedOpenAiTools;
  try {
    const mcpToolsList = await mcpClient.listTools();
    cachedOpenAiTools = mcpToolsList.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as any,
      },
    }));
    toolsCacheExpiry = Date.now() + 5 * 60 * 1000;
  } catch (e) {
    console.error("MCP tools unavailable:", e);
  }
  return cachedOpenAiTools;
}


function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function findLatestMatchCard(sessionId: string): Promise<any | null> {
  // Single date-ordered scan across ALL messages with uiCardData. We do NOT
  // prefer uiCardType="rich" — the session-init greeting stores the parent's
  // currently-viewed donor card with uiCardType=null, and that subject must
  // win over any older rich message from an earlier interaction. Sorting
  // strictly by createdAt is the only way "latest" stays correct when the
  // parent jumps between providers in the same shared session.
  const messages = await prisma.aiChatMessage.findMany({
    where: { sessionId, NOT: { uiCardData: { equals: null } } },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { uiCardData: true },
  });
  for (const msg of messages) {
    const mc = (msg.uiCardData as any)?.matchCards?.[0];
    if (mc?.providerId && mc?.type) return mc;
  }
  return null;
}

/**
 * International programs bundle a surrogacy AGENCY with one or more partner
 * IVF / egg-donor clinics (Provider.partnerProviderIds - e.g. Colombia's
 * Bioética agency + Inser clinic). A program means the parent books TWO calls,
 * one after the other: the agency first, then the clinic. Given the agency id
 * this returns its partner clinics, each flagged with whether this parent
 * account has already booked it (an existing CONSULTATION_BOOKED session or an
 * upcoming booking with that clinic). Used by (1) the consultation-booking
 * guard so a legitimate partner-clinic id is not rewritten back to the agency,
 * and (2) the directives that drive the sequential "agency, then clinic" offer.
 */
async function getProgramPartnerClinics(
  agencyId: string,
  accountIds: string[],
): Promise<Array<{ id: string; name: string; booked: boolean }>> {
  const agency = await prisma.provider
    .findUnique({ where: { id: agencyId }, select: { partnerProviderIds: true } })
    .catch(() => null);
  const ids = Array.isArray(agency?.partnerProviderIds)
    ? (agency!.partnerProviderIds as any[]).map(String).filter(Boolean)
    : [];
  if (ids.length === 0) return [];
  const clinics = await prisma.provider
    .findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    .catch(() => [] as any[]);
  const bookedIds = new Set<string>();
  try {
    const sessions = await prisma.aiChatSession.findMany({
      where: { userId: { in: accountIds }, providerId: { in: ids }, status: "CONSULTATION_BOOKED" },
      select: { providerId: true },
    });
    for (const s of sessions) if (s.providerId) bookedIds.add(s.providerId);
    const bookings = await prisma.booking.findMany({
      where: {
        parentUserId: { in: accountIds },
        status: { in: ["PENDING", "CONFIRMED"] },
        providerUser: { providerId: { in: ids } },
      },
      select: { providerUser: { select: { providerId: true } } },
    });
    for (const b of bookings) {
      const pid = (b as any).providerUser?.providerId;
      if (pid) bookedIds.add(pid);
    }
  } catch {
    /* best-effort - "booked" just defaults to false and the offer still fires */
  }
  return clinics.map((c: any) => ({ id: c.id, name: c.name, booked: bookedIds.has(c.id) }));
}

// Latest card the parent is looking at, across BOTH card storage paths:
// matchCards (egg/sperm donors, surrogates, IVF clinics, surrogacy agencies) and
// doctorCards (doctors, keyed by slug). Used to attribute per-profile inquiries.
async function findLatestChatSubject(sessionId: string): Promise<{ profileId: string; type: string } | null> {
  const messages = await prisma.aiChatMessage.findMany({
    where: { sessionId, NOT: { uiCardData: { equals: null } } },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { uiCardData: true },
  });
  for (const msg of messages) {
    const data = msg.uiCardData as any;
    const mc = data?.matchCards?.[0];
    if (mc?.providerId && mc?.type) return { profileId: String(mc.providerId), type: String(mc.type) };
    const dc = data?.doctorCards?.[0];
    if (dc?.slug) return { profileId: String(dc.slug), type: "doctor" };
  }
  // Fallback: the session's opening subject. When a parent opens a specific
  // profile directly (e.g. "ask about this donor" from the marketplace), the
  // card comes from the session greeting - which is not persisted as a
  // MATCH_CARD message - so the loop above finds nothing. The session itself
  // records subjectProfileId/subjectType, which is the profile being inquired about.
  const session = await prisma.aiChatSession.findUnique({
    where: { id: sessionId },
    select: { subjectProfileId: true, subjectType: true },
  });
  if (session?.subjectProfileId) {
    return { profileId: String(session.subjectProfileId), type: String(session.subjectType || "egg-donor") };
  }
  return null;
}

// Extract search keywords from parent's question with synonym expansion
function extractSearchKeywords(question: string): string[] {
  const q = question.toLowerCase().replace(/[?!.,]/g, "");
  const synonymMap: Record<string, string[]> = {
    husband: ["husband", "partner", "spouse", "significant other", "married", "relationship"],
    wife: ["wife", "partner", "spouse", "significant other", "married", "relationship"],
    partner: ["partner", "spouse", "significant other", "husband", "wife", "married", "relationship"],
    name: ["name", "first name", "called"],
    age: ["age", "old", "born", "birthday", "date of birth"],
    weight: ["weight", "weigh", "lbs", "pounds", "kg"],
    height: ["height", "tall", "feet", "inches"],
    religion: ["religion", "religious", "faith", "church", "spiritual"],
    education: ["education", "school", "college", "university", "degree", "studied"],
    job: ["job", "occupation", "work", "career", "employed", "employment"],
    smoke: ["smoke", "smoking", "tobacco", "cigarette"],
    drink: ["drink", "drinking", "alcohol"],
    drug: ["drug", "drugs", "recreational", "marijuana", "cannabis"],
    pet: ["pet", "pets", "dog", "cat", "animal"],
    tattoo: ["tattoo", "tattoos", "piercing", "piercings"],
    diabetes: ["diabetes", "diabetic", "blood sugar", "insulin"],
    pregnant: ["pregnant", "pregnancy", "pregnancies", "birth", "deliver", "delivery", "labor"],
    complication: ["complication", "complications", "c-section", "cesarean", "preeclampsia", "preterm"],
    baby: ["baby", "babies", "child", "children", "kids", "born"],
    compensation: ["compensation", "pay", "cost", "fee", "charge", "price", "money"],
    location: ["location", "live", "lives", "city", "state", "country", "based"],
    insurance: ["insurance", "insured", "coverage", "health plan"],
    twins: ["twins", "twin", "multiples", "triplets"],
    abortion: ["abortion", "termination", "terminate", "selective reduction"],
    letter: ["letter", "intended parents", "message", "wrote"],
    hobby: ["hobby", "hobbies", "interests", "enjoy", "fun", "like to do"],
    diet: ["diet", "eat", "food", "nutrition", "vegan", "vegetarian"],
    exercise: ["exercise", "workout", "fitness", "gym", "active"],
    bmi: ["bmi", "body mass"],
    ethnicity: ["ethnicity", "ethnic", "race", "racial", "background"],
    criminal: ["criminal", "arrest", "arrested", "convicted", "crime", "felony"],
    support: ["support", "supportive", "family support", "help"],
    motivation: ["motivation", "why", "reason", "surrogacy", "become a surrogate"],
    eye: ["eye", "eyes", "eye color"],
    hair: ["hair", "hair color"],
    blood: ["blood", "blood type", "bloodtype"],
    eggs: ["eggs", "egg", "donation", "donated", "cycles", "retrieval"],
    medical: ["medical", "medical history", "health history", "family history", "genetic"],
    family: ["family", "family history", "siblings", "parents", "mother", "father"],
    occupation: ["occupation", "job", "work", "career", "employed"],
  };

  const keywords: string[] = [];
  const words = q.split(/\s+/);
  for (const word of words) {
    if (synonymMap[word]) {
      keywords.push(...synonymMap[word]);
    }
  }
  // Also add raw words from question (minus stopwords)
  const stopwords = new Set(["what", "whats", "what's", "is", "are", "does", "do", "she", "he", "her", "his", "the", "a", "an", "have", "has", "any", "this", "that", "can", "could", "would", "tell", "me", "about", "of", "to", "in", "and", "or", "how", "many", "much"]);
  for (const word of words) {
    if (!stopwords.has(word) && word.length > 2) {
      keywords.push(word);
    }
  }
  return [...new Set(keywords)];
}

// Recursively search any JSON structure for keys/values matching keywords
function searchProfileForKeywords(obj: any, keywords: string[], path: string = ""): {key: string, value: any, path: string}[] {
  const results: {key: string, value: any, path: string}[] = [];
  if (!obj || typeof obj !== "object") return results;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      results.push(...searchProfileForKeywords(obj[i], keywords, `${path}[${i}]`));
    }
    return results;
  }

  for (const [key, value] of Object.entries(obj)) {
    const keyLower = key.toLowerCase();
    const valueLower = typeof value === "string" ? value.toLowerCase() : "";
    const keyMatches = keywords.some(kw => keyLower.includes(kw));

    if (keyMatches && value !== null && value !== undefined && value !== "" && value !== "-") {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        results.push({ key, value: String(value), path: path || "root" });
      } else if (Array.isArray(value)) {
        results.push({ key, value: JSON.stringify(value).slice(0, 500), path: path || "root" });
      }
    }

    // Recurse into nested objects/arrays
    if (typeof value === "object" && value !== null) {
      results.push(...searchProfileForKeywords(value, keywords, path ? `${path}.${key}` : key));
    }
  }
  return results;
}

async function sendPrepDocEmail(parentEmail: string, parentName: string, baseUrl: string) {
  const sendgridKey = process.env.SENDGRID_API_KEY;
  if (!sendgridKey) {
    console.log(`[PREP DOC EMAIL MOCK] To: ${parentEmail}, Parent: ${parentName}`);
    return;
  }

  const brand = await fetchEmailBrandData(prisma);
  const companyName = brand.companyName;

  // Served from the admin-uploaded ConciergeAsset (Settings -> AI Concierge).
  // 302s to a signed GCS URL; 404s gracefully if no guide is uploaded yet.
  const downloadLink = `${baseUrl}/api/knowledge/concierge-assets/match_call_prep_guide/file`;
  const html = buildBrandedEmail(brand, {
    title: "Your Match Call Prep Guide",
    greeting: `Hi ${escapeHtml(parentName)},`,
    body: `<p style="margin:0 0 20px;">Exciting news - a match call is being arranged for you! To help you feel confident and prepared, we've put together a guide with thoughtful questions to ask your potential surrogate.</p>
<div style="background-color:${brand.secondaryColor};border-radius:8px;padding:20px;margin:0;">
<p style="color:${brand.brandColor};font-size:14px;font-weight:600;margin:0 0 12px;">What's Inside:</p>
<table cellpadding="0" cellspacing="0" width="100%">
<tr><td style="padding:4px 0;font-size:14px;">🫶 Personal &amp; Lifestyle questions</td></tr>
<tr><td style="padding:4px 0;font-size:14px;">🧠 Values &amp; Boundaries discussion points</td></tr>
<tr><td style="padding:4px 0;font-size:14px;">🏥 Medical &amp; Pregnancy-related questions</td></tr>
<tr><td style="padding:4px 0;font-size:14px;">💬 Key Ethical Topics to address</td></tr>
<tr><td style="padding:4px 0;font-size:14px;">📝 Legal, Logistical &amp; Communication style</td></tr>
<tr><td style="padding:4px 0;font-size:14px;">🐣 After Birth expectations</td></tr>
</table>
</div>`,
    alertBox: { text: `<strong>💡 Tip:</strong> Start warm and personal - this is a relationship-building moment, not just a checklist. Leave space for your surrogate to ask you questions too. It's a two-way match!`, type: "warning" },
    buttons: [{ label: "Download Your Guide (PDF)", url: downloadLink }],
    footer: `Your ${companyName} team is here every step of the way. If you have any questions before your call, just chat with your AI concierge or reach out to our team.`,
  });

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
        subject: `Your Surrogacy Match Call Prep Guide - ${companyName}`,
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

async function sendWhisperEmail(providerEmail: string, providerName: string, questionText: string, baseUrl: string, sessionId: string, overrideChatLink?: string) {
  const sendgridKey = process.env.SENDGRID_API_KEY;
  if (!sendgridKey) {
    console.log(`[WHISPER EMAIL MOCK] To: ${providerEmail}, Provider: ${providerName}, Question: ${questionText}`);
    return;
  }

  const brand = await fetchEmailBrandData(prisma);
  const companyName = brand.companyName;

  const chatLink = overrideChatLink || `${baseUrl}/chat/${sessionId}`;
  const html = buildBrandedEmail(brand, {
    title: "New Question from a Prospective Parent",
    greeting: `Hi ${escapeHtml(providerName)} team,`,
    body: `<p style="margin:0 0 16px;">A prospective parent asked our AI concierge a question that we don't have the answer to yet. Could you help us out?</p>
<div style="background-color:${brand.secondaryColor};border-left:4px solid ${brand.brandColor};padding:16px 20px;border-radius:4px;margin:0 0 24px;">
<p style="color:${brand.mutedForegroundColor};font-size:13px;font-weight:600;text-transform:uppercase;margin:0 0 8px;">Question:</p>
<p style="font-size:15px;line-height:1.6;margin:0;font-style:italic;">"${escapeHtml(questionText)}"</p>
</div>
<p style="margin:0;">Once you answer, our AI will learn it for the future so parents always get accurate information about your clinic.</p>`,
    buttons: [{ label: "Open This Conversation", url: chatLink }],
    footer: `This question was asked anonymously - no parent contact information is shared. You can reply directly from your ${companyName} inbox.`,
  });

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
        subject: `New Question from a Prospective Parent - ${companyName}`,
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

async function sendWhisperSms(phone: string, questionText: string, chatLink: string) {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

  if (!twilioSid || !twilioToken || !twilioFrom) {
    console.log(`[WHISPER SMS MOCK] To: ${phone}, Question: ${questionText.slice(0, 60)}, Link: ${chatLink}`);
    return;
  }

  let companyName = "GoStork";
  try {
    const settings = await prisma.siteSettings.findFirst();
    if (settings) companyName = (settings as any).companyName || companyName;
  } catch {}

  const preview = questionText.length > 100 ? questionText.slice(0, 100) + "..." : questionText;
  const body = `[${companyName}] New question from a prospective parent: "${preview}"\n\nReply here: ${chatLink}`;
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
    const params = new URLSearchParams({ To: phone, From: twilioFrom, Body: body });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Twilio whisper SMS failed: ${res.status} - ${text}`);
    }
  } catch (e: any) {
    console.error(`Twilio whisper SMS error: ${e.message}`);
  }
}

// ─── Cross-family reuse of provider answers about a specific profile ────────
//
// When a provider answers a whisper about a donor/surrogate ("did she have any
// pregnancy complications?"), that answer is provider-authored knowledge about
// the PROFILE - not about the family who asked. Reusing it means the next
// family gets an instant answer instead of waiting days for the provider to
// re-answer the same question.
//
// PRIVACY CONTRACT (deliberately strict - the asking family must stay invisible):
//   1. Only the ANSWER is ever reused; the asking family's identity is never
//      loaded or surfaced.
//   2. A pair is DROPPED ENTIRELY when its question carries the asking family's
//      own context ("we're two dads, would she be comfortable...") - both
//      because the question text would leak, and because such an answer is
//      specific to THAT family and would be wrong for anyone else.
//   3. Scoped to one exact (provider, profile) pair - never across providers,
//      never across profiles.
// Classification, sanitization and ingestion live in ./whisper-knowledge so the
// read path (here) and the write path (chat-router, on relay) share one source
// of truth for what may be reused and what must stay locked to its profile.

/**
 * Provider answers about THIS profile, previously given to OTHER families.
 * Returns sanitized {question, answer} pairs safe to hand to the model.
 */
/** Overlap of meaningful words between the parent's message and a stored question. */
const STOPWORDS = new Set("the a an is are was were do does did have has had of for to in on with about her his she he they it any and or if can could would will what when where which who how".split(" "));
function relevanceScore(userMessage: string, question: string): number {
  const toks = (t: string) => new Set(
    t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
  const a = toks(userMessage);
  const b = toks(question);
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const w of b) if (a.has(w)) hits++;
  return hits / b.size;
}

async function priorAnswersForProfile(
  profileId: string,
  ownerProviderId: string,
  excludeParentUserIds: string[],
  max = 8,
  userMessage = "",
): Promise<{ question: string; answer: string }[]> {
  try {
    const rows = await prisma.silentQuery.findMany({
      where: {
        // MUST include RELAYED: chat-router flips ANSWERED -> RELAYED the
        // instant Eva passes the answer to the asking parent, so in production
        // essentially every reusable answer is RELAYED and an ANSWERED-only
        // filter matches nothing. (Verified against live data: 5 RELAYED with
        // answers, 0 ANSWERED.)
        status: { in: ["ANSWERED", "RELAYED"] },
        answerText: { not: null },
        providerId: ownerProviderId,
        session: { subjectProfileId: profileId },
        parentUserId: { notIn: excludeParentUserIds },
      },
      select: { questionText: true, answerText: true },
      orderBy: { updatedAt: "desc" },
      // Wide over-fetch: sanitization drops family-specific pairs, and the
      // survivors are ranked by RELEVANCE below rather than recency. A popular
      // profile can accumulate dozens of answers, and the best match is often
      // an old one - a pure "most recent N" window silently hid those.
      take: 60,
    });
    const out: { question: string; answer: string }[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const q = sanitizeReusableQuestion(r.questionText);
      const a = (r.answerText || "").trim();
      if (!q || !a) continue;
      // An answer that describes the ASKING FAMILY is not reusable. Note this
      // uses the narrow answer-side markers - provider "we/our" is the agency
      // talking about itself and is exactly what we want to keep.
      if (ASKER_IDENTITY_IN_ANSWER.test(a)) continue;
      const key = q.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ question: q, answer: a });
    }
    // Rank by overlap with what the parent actually just asked; keep recency as
    // the tie-break (rows arrived newest-first, so a stable sort preserves it).
    if (userMessage) {
      return out
        .map((p, i) => ({ p, i, score: relevanceScore(userMessage, p.question) }))
        .sort((x, y) => y.score - x.score || x.i - y.i)
        .slice(0, max)
        .map((r) => r.p);
    }
    return out.slice(0, max);
  } catch (e: any) {
    console.error("[PRIOR ANSWERS] lookup failed:", e?.message);
    return [];
  }
}

/**
 * AGENCY-LEVEL answers from this provider, given on ANY profile.
 * "How long does your matching process take?" answered while a parent viewed
 * Donor A is equally true for Donor B, so it should not stay locked to
 * whichever profile happened to be on screen. Facts about a specific person
 * never qualify (see isAgencyLevelPair).
 */
async function agencyLevelAnswersForProvider(
  ownerProviderId: string,
  excludeParentUserIds: string[],
  excludeQuestions: Set<string>,
  max = 6,
): Promise<{ question: string; answer: string }[]> {
  try {
    const rows = await prisma.silentQuery.findMany({
      where: {
        status: { in: ["ANSWERED", "RELAYED"] },
        answerText: { not: null },
        providerId: ownerProviderId,
        parentUserId: { notIn: excludeParentUserIds },
      },
      select: { questionText: true, answerText: true },
      orderBy: { updatedAt: "desc" },
      take: max * 6,
    });
    const out: { question: string; answer: string }[] = [];
    const seen = new Set<string>(excludeQuestions);
    for (const r of rows) {
      const q = sanitizeReusableQuestion(r.questionText);
      const a = (r.answerText || "").trim();
      if (!q || !a) continue;
      if (ASKER_IDENTITY_IN_ANSWER.test(a)) continue;
      if (!isAgencyLevelPair(q, a)) continue; // person-specific stays locked
      const key = q.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ question: q, answer: a });
      if (out.length >= max) break;
    }
    return out;
  } catch (e: any) {
    console.error("[AGENCY ANSWERS] lookup failed:", e?.message);
    return [];
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
      (r: any) => {
        const prefix = r.sortOrder <= 5 ? "**CRITICAL** " : "";
        return `- ${prefix}IF the user mentions "${r.condition}" → ${r.guidance}`;
      },
    );
    return `\nEXPERT GUIDANCE RULES (MANDATORY - these override knowledge base context when applicable):\n${ruleLines.join("\n")}\n`;
  } catch (e) {
    console.error("Failed to load guidance rules:", e);
    return "";
  }
}

let mcpClient: Client | null = null;

async function initMcp(attempt = 1): Promise<void> {
  const maxAttempts = 3;
  try {
    const isProd = process.env.NODE_ENV === "production";
    const transport = new StdioClientTransport({
      command: "node",
      args: isProd
        ? [path.join(__dirname, "mcp-server.cjs")]
        : ["--import", "tsx/esm", "server/src/mcp-server.ts"],
      env: { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config` } as Record<string, string>,
    });

    mcpClient = new Client(
      { name: "gostork-express-client", version: "1.0.0" },
      { capabilities: {} },
    );

    await mcpClient.connect(transport);
    console.log("Express Client successfully connected to the MCP Database Server");
  } catch (error) {
    console.error(`Failed to start MCP Client (attempt ${attempt}/${maxAttempts}):`, error);
    mcpClient = null;
    if (attempt < maxAttempts) {
      const delay = attempt * 5000;
      console.log(`Retrying MCP connection in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      return initMcp(attempt + 1);
    }
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
      select: { userId: true, providerId: true, title: true, status: true, providerJoinedAt: true, subjectProfileId: true, subjectType: true, profilePhotoUrl: true, matchmakerId: true, humanRequested: true, humanJoinedAt: true, humanConcludedAt: true, humanAgentId: true, provider: { select: { name: true, logoUrl: true } } },
    });
    if (!session) return res.status(403).json({ message: "Forbidden" });
    const isOwner = session.userId === user.id;
    let isAccountMember = false;
    if (!isOwner && user.parentAccountId) {
      const sessionOwner = await prisma.user.findUnique({ where: { id: session.userId }, select: { parentAccountId: true } });
      isAccountMember = !!sessionOwner && sessionOwner.parentAccountId === user.parentAccountId;
    }
    const roles: string[] = user.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN") || roles.includes("GOSTORK_CONCIERGE");
    const providerRoles = ["PROVIDER_ADMIN", "IP_SURROGACY_COORDINATOR", "IP_EGG_DONOR_COORDINATOR", "IP_SPERM_DONOR_COORDINATOR", "IP_IVF_COORDINATOR", "IP_LEGAL_COORDINATOR", "SURROGATE_COORDINATOR", "EGG_DONOR_COORDINATOR", "SPERM_DONOR_COORDINATOR", "SCHEDULER", "DOCTOR", "LAWYER", "BILLING_MANAGER"];
    const isProviderMember = roles.some((r: string) => providerRoles.includes(r)) && user.providerId && session.providerId === user.providerId;
    const isProvider = isProviderMember && canProviderAccessSession(roles, session.subjectType || null);
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
      select: { id: true, role: true, content: true, senderType: true, senderName: true, createdAt: true, uiCardType: true, uiCardData: true, deliveredAt: true, readAt: true },
    });
    // Review prompts + IP form nudges are parent-private - providers never see them.
    const providerSafe = messages.filter((m: any) => m.uiCardType !== "review_prompt" && m.uiCardType !== "ip_form_prompt");
    const filteredMessages = isProvider ? providerSafe : messages.filter((m: any) => {
      const data = m.uiCardData as any;
      if (data?.whisperQuestionId) return false;
      if (m.uiCardType === "provider_only") return false;
      // System messages: show plain-text ones (join/escalation notices) and specific card types; hide everything else.
      // agreement_signed (fully signed, all parties) and signer_signed (one
      // signer just completed) are part of the agreement flow the parent
      // is actively in, so they belong in the parent's view - leaving them
      // out makes the chat go silent after the parent signed, even though
      // the conversations-list preview keeps showing the latest update.
      const allowedSystemCardTypes = [
        "proposed_times",
        "agreement",
        "agreement_signed",
        "signer_signed",
        "readiness_prompt",
        "invoice",
        "cost_sheet",
        // Egg-donor hold countdown: the parent decides "release her" vs
        // "I will pay soon" (the provider-side donor_hold_decision card
        // stays hidden - it's not in this list).
        "donor_release_warning",
        // Phase 8: Eva's review ask (parent-only by definition).
        "review_prompt",
        // Intended Parent Form nudge (parent-only by definition).
        "ip_form_prompt",
        // System-sent file attachments (e.g. the Match Call prep guide Eva
        // sends when a match call is scheduled).
        "attachment",
      ];
      if (m.senderType === "system" && !allowedSystemCardTypes.includes(m.uiCardType) && m.uiCardType != null) return false;
      // Provider assessment prompts are only shown to providers, not parents
      if (!isProvider && m.uiCardType === "provider_assessment") return false;
      // In a 3-way provider chat, hide AI concierge messages from before the provider joined -
      // the provider session is a direct parent-provider channel; pre-join AI chatter is irrelevant.
      if (session.status === "PROVIDER_CONNECTED" && session.providerJoinedAt && m.senderType === "ai") {
        const msgTime = new Date(m.createdAt).getTime();
        const joinTime = new Date(session.providerJoinedAt).getTime();
        if (msgTime < joinTime) return false;
      }
      return true;
    });

    // Auto-mark messages from others as delivered when fetched
    const undeliveredFromOthers = filteredMessages.filter(m =>
      !m.deliveredAt && (
        isProvider ? m.senderType !== "provider" : m.role !== "user"
      )
    );
    if (undeliveredFromOthers.length > 0) {
      prisma.aiChatMessage.updateMany({
        where: { id: { in: undeliveredFromOthers.map(m => m.id) }, deliveredAt: null },
        data: { deliveredAt: new Date() },
      }).catch(() => {});
      for (const m of undeliveredFromOthers) (m as any).deliveredAt = new Date();
    }

    let matchmakerName: string | null = null;
    if (session.matchmakerId) {
      const mm = await prisma.matchmaker.findUnique({ where: { id: session.matchmakerId }, select: { name: true } });
      matchmakerName = mm?.name || null;
    }
    let humanAgentPhotoUrl: string | null = null;
    if ((session as any).humanAgentId) {
      const agent = await prisma.user.findUnique({ where: { id: (session as any).humanAgentId }, select: { photoUrl: true } });
      humanAgentPhotoUrl = agent?.photoUrl || null;
    }

    // Enrich the subject photo from the donor/surrogate row when the session has
    // no stored profilePhotoUrl (mirrors /api/my/chat-sessions). Lookup is by id
    // WITHOUT the hiddenFromSearch filter so the right-panel/header still shows
    // the photo of a profile that was pulled from the marketplace but is still
    // the subject of this chat.
    let enrichedPhotoUrl: string | null = session.profilePhotoUrl || null;
    if (!enrichedPhotoUrl && session.subjectProfileId && session.subjectType) {
      const st = session.subjectType.toLowerCase();
      try {
        const donor = st.includes("egg")
          ? await prisma.eggDonor.findUnique({ where: { id: session.subjectProfileId }, select: { photos: true, photoUrl: true } })
          : st.includes("sperm")
          ? await prisma.spermDonor.findUnique({ where: { id: session.subjectProfileId }, select: { photos: true, photoUrl: true } })
          : st.includes("surrogate")
          ? await prisma.surrogate.findUnique({ where: { id: session.subjectProfileId }, select: { photos: true, photoUrl: true } })
          : null;
        if (donor) {
          const photos = (donor.photos as string[]) || [];
          enrichedPhotoUrl = photos.find((p) => !!p) || donor.photoUrl || null;
        }
      } catch { /* best-effort photo enrichment */ }
    }

    res.json({
      messages: filteredMessages,
      sessionTitle: cleanTitle(session.title) || null,
      providerName: session.provider?.name || null,
      providerLogo: session.provider?.logoUrl || null,
      providerJoined: !!session.providerJoinedAt || session.status === "CONSULTATION_BOOKED" || session.status === "PROVIDER_CONNECTED",
      humanRequested: session.humanRequested,
      humanJoinedAt: (session as any).humanJoinedAt || null,
      humanConcludedAt: (session as any).humanConcludedAt || null,
      subjectProfileId: session.subjectProfileId || null,
      subjectType: session.subjectType || null,
      profilePhotoUrl: enrichedPhotoUrl,
      sessionProviderId: session.providerId || null,
      matchmakerId: session.matchmakerId || null,
      matchmakerName,
      humanAgentPhotoUrl,
    });
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
});

aiRouter.get("/my-session", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ message: "Unauthorized" });
    const userId = user.id;
    const accountUserIds = user.parentAccountId
      ? (await prisma.user.findMany({ where: { parentAccountId: user.parentAccountId }, select: { id: true } })).map((u: any) => u.id)
      : [userId];
    const session = await prisma.aiChatSession.findFirst({
      where: { userId: { in: accountUserIds }, providerJoinedAt: null, status: { notIn: ["CONSULTATION_BOOKED", "PROVIDER_CONNECTED"] } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, matchmakerId: true, title: true, provider: { select: { name: true } } },
    });
    if (!session) {
      return res.json({ session: null, messages: [] });
    }
    const messages = await prisma.aiChatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, content: true, senderType: true, senderName: true, createdAt: true, uiCardType: true, uiCardData: true, deliveredAt: true, readAt: true },
    });
    const filteredMessages = messages.filter((m: any) => {
      const data = m.uiCardData as any;
      if (data?.whisperQuestionId) return false;
      // System messages: show plain-text ones (join/escalation notices) and specific card types; hide everything else.
      // agreement_signed (fully signed, all parties) and signer_signed (one
      // signer just completed) are part of the agreement flow the parent
      // is actively in, so they belong in the parent's view - leaving them
      // out makes the chat go silent after the parent signed, even though
      // the conversations-list preview keeps showing the latest update.
      const allowedSystemCardTypes = [
        "agreement",
        "agreement_signed",
        "signer_signed",
        "readiness_prompt",
        "invoice",
        "cost_sheet",
        // System-sent file attachments (e.g. the Match Call prep guide Eva
        // sends when a match call is scheduled).
        "attachment",
      ];
      if (m.senderType === "system" && !allowedSystemCardTypes.includes(m.uiCardType) && m.uiCardType != null) return false;
      // Provider assessment prompts are only shown to providers, never here -
      // /my-session is parent-only (queried by parentAccountId), so the filter
      // is unconditional. (A copied `isProvider` reference here used to throw
      // ReferenceError and 500 the whole endpoint.)
      if (m.uiCardType === "provider_assessment") return false;
      return true;
    });
    res.json({
      session: { id: session.id, matchmakerId: session.matchmakerId, title: cleanTitle(session.title), providerName: session.provider?.name || null },
      messages: filteredMessages,
    });
  } catch (e: any) {
    console.error("My session error:", e);
    res.status(500).json({ message: e.message });
  }
});

aiRouter.post("/init-session", async (req: Request, res: Response) => {
  try {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const userId = (req.user as any).id;
    const { matchmakerId, donorId, donorType } = req.body;
    // Accept legacy client-sent greeting as fallback only
    const clientGreeting: string | undefined = req.body.greeting;
    if (!matchmakerId) {
      return res.status(400).json({ error: "matchmakerId required" });
    }

    const currentUser = await prisma.user.findUnique({ where: { id: userId }, select: { parentAccountId: true } });
    const accountUserIds = currentUser?.parentAccountId
      ? (await prisma.user.findMany({ where: { parentAccountId: currentUser.parentAccountId }, select: { id: true } })).map(u => u.id)
      : [userId];

    const existing = await prisma.aiChatSession.findFirst({
      where: { userId: { in: accountUserIds }, providerJoinedAt: null, status: { notIn: ["CONSULTATION_BOOKED", "PROVIDER_CONNECTED"] } },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });

    const donorLabel = donorId
      ? (donorType === "surrogate" ? "Surrogate" : donorType === "sperm-donor" ? "Sperm Donor" : donorType === "clinic" ? "Clinic" : donorType === "agency" ? "Surrogacy Agency" : donorType === "doctor" ? "Doctor" : "Egg Donor")
      : null;

    // Build the greeting card for the opened subject. Doctors render through the
    // separate doctorCards path (keyed by slug), so resolve the full doctor by
    // slug here - that way the PERSISTED greeting renders correctly on reload,
    // not just in the optimistic client card. Everything else uses matchCards.
    const isDoctorSubject = donorType === "doctor";
    let subjectGreetingCard: any = null;
    if (donorId) {
      if (isDoctorSubject) {
        let doctor: any = null;
        if (mcpClient) {
          try {
            const r: any = await mcpClient.callTool({ name: "resolve_doctor_card", arguments: { slug: donorId } });
            doctor = JSON.parse((r.content as any)?.[0]?.text || "{}");
          } catch {}
        }
        subjectGreetingCard = { doctorCards: [doctor && doctor.slug ? doctor : { slug: donorId, name: donorLabel || "Doctor" }] };
      } else {
        subjectGreetingCard = { matchCards: [{ name: donorLabel, type: donorLabel, providerId: donorId, ownerProviderId: req.body.ownerProviderId || undefined, reasons: [] }] };
      }
    }

    // Build greeting server-side using matchmaker template + user profile (eliminates client timing issues)
    const [matchmakerRecord, userForGreeting] = await Promise.all([
      prisma.matchmaker.findUnique({ where: { id: matchmakerId } }),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          firstName: true, name: true, city: true, state: true,
          parentAccount: { select: { intendedParentProfile: { select: { interestedServices: true } } } },
        },
      }),
    ]);
    const firstName = userForGreeting?.firstName || userForGreeting?.name?.split(" ")[0] || "there";
    const city = userForGreeting?.city || "";
    const state = userForGreeting?.state || "";
    const location = city && state ? `${city}, ${state}` : city || state || "your area";
    const interestedServices: string[] = (userForGreeting?.parentAccount as any)?.intendedParentProfile?.interestedServices || [];
    const SERVICE_LABEL_MAP: Record<string, string> = {
      "Surrogate": "surrogacy", "Egg Donor": "egg donation",
      "Fertility Clinic": "IVF clinics", "Sperm Donor": "sperm donation",
    };
    const serviceLabels = interestedServices.map((s: string) => SERVICE_LABEL_MAP[s] || s.toLowerCase());
    const serviceLabel = serviceLabels.length === 1 ? serviceLabels[0]
      : serviceLabels.length > 1 ? serviceLabels.slice(0, -1).join(", ") + " and " + serviceLabels[serviceLabels.length - 1]
      : "fertility services";
    const conciergeNameLabel = matchmakerRecord?.name || "your concierge";
    const defaultGreeting = interestedServices.length > 0
      ? `Hi ${firstName}! I'm ${conciergeNameLabel}, your GoStork AI concierge. I see you're looking into ${serviceLabel} - is that correct? [[QUICK_REPLY:Yes, that's right|Not exactly]]`
      : `Hi ${firstName}! I'm ${conciergeNameLabel}, your GoStork AI concierge. What are you looking for help with? [[QUICK_REPLY:Surrogacy|Egg Donation|Sperm Donation|IVF Clinics]]`;
    // Use the matchmaker's initialGreeting template from DB with [First Name]/[Service]/[Location] replaced.
    // Fall back to defaultGreeting if no template is set.
    const templateGreeting = matchmakerRecord?.initialGreeting
      ? matchmakerRecord.initialGreeting
          .replace(/\[First Name\]/gi, firstName)
          .replace(/\[Service\]/gi, serviceLabel)
          .replace(/\[Location\]/gi, location)
      : defaultGreeting;
    const rawGreeting = donorId ? (clientGreeting || templateGreeting) : templateGreeting;
    // Parse [[QUICK_REPLY:...]] from greeting so buttons render in the chat UI
    const greetingQrMatch = rawGreeting.match(/\[\[QUICK_REPLY:(.*?)\]\]/);
    const greetingQuickReplies: string[] = greetingQrMatch ? greetingQrMatch[1].split("|").map((s: string) => s.trim()) : [];
    const builtGreeting = rawGreeting.replace(/\[\[QUICK_REPLY:.*?\]\]/g, "").trim();
    // Phase 0 is no longer sent statically - the AI delivers it after the parent confirms their services.
    const builtPhase0 = null;

    if (existing) {
      if (donorId) {
        const matchCardData = subjectGreetingCard;
        const greetingMsg = await prisma.aiChatMessage.create({
          data: {
            sessionId: existing.id,
            role: "assistant",
            content: builtGreeting,
            senderType: "ai",
            uiCardType: "rich",
            uiCardData: matchCardData,
          },
        });
        await prisma.aiChatSession.update({
          where: { id: existing.id },
          // Re-point the reused session at the profile the parent just opened, so
          // typed-message attribution + photo enrichment track the current subject.
          data: { updatedAt: new Date(), title: "AI Concierge Chat", subjectProfileId: donorId, subjectType: donorType || donorLabel || null },
        });
        // Opening a chat about a specific profile (the marketplace "message" icon /
        // "ask about this donor") IS an inquiry - record it now, without waiting for
        // the parent to type. Deduped per (session, profile).
        prisma.profileInquiry.upsert({
          where: { sessionId_profileId: { sessionId: existing.id, profileId: donorId } },
          create: { sessionId: existing.id, profileId: donorId, entityType: donorType || donorLabel || "egg-donor" },
          update: {},
        }).catch(() => {});
        res.json({ sessionId: existing.id, greetingMessageId: greetingMsg.id, greeting: builtGreeting, greetingQuickReplies, reused: true });
        // Background name resolve only applies to the matchCards path (doctors
        // are already fully resolved by slug above).
        if (mcpClient && !isDoctorSubject && matchCardData?.matchCards?.[0]) {
          mcpClient.callTool({ name: "resolve_match_card", arguments: { entityId: donorId, entityType: donorLabel } })
            .then((resolveResult: any) => {
              const resolved = JSON.parse((resolveResult.content as any)?.[0]?.text || "{}");
              if (resolved.name && resolved.name !== donorLabel) {
                // Title stays "AI Concierge Chat" - do not rename to donor/surrogate name
                prisma.aiChatMessage.update({
                  where: { id: greetingMsg.id },
                  data: { uiCardData: { matchCards: [{ ...matchCardData.matchCards[0], name: resolved.name, ownerProviderId: resolved.ownerProviderId || req.body.ownerProviderId || undefined }] } },
                }).catch(() => {});
              }
            }).catch((e: any) => console.error("[init-session] Background resolve error:", e));
        }
        return;
      }
      const msgCount = await prisma.aiChatMessage.count({ where: { sessionId: existing.id } });
      // If the session is empty, include greeting + phase0 so the frontend can display them
      if (msgCount === 0) {
        return res.json({ sessionId: existing.id, reused: true, messageCount: 0, greeting: builtGreeting, greetingQuickReplies, phase0Content: builtPhase0 });
      }
      return res.json({ sessionId: existing.id, reused: true, messageCount: msgCount });
    }

    const sessionTitle = "AI Concierge Chat";
    const session = await prisma.aiChatSession.create({
      // Stamp the subject profile when the parent starts a chat focused on a
      // specific donor/surrogate (the marketplace "ask about this profile" flow),
      // so engagement (inquiries) attributes to that sponsored profile.
      data: { userId, title: sessionTitle, matchmakerId, ...(donorId ? { subjectProfileId: donorId, subjectType: donorType || donorLabel || null } : {}) },
    });

    // Opening a chat about a specific profile IS an inquiry (the marketplace
    // "message" icon / "ask about this donor"). Record it on session open, not
    // only when the parent types. Deduped per (session, profile).
    if (donorId) {
      prisma.profileInquiry.upsert({
        where: { sessionId_profileId: { sessionId: session.id, profileId: donorId } },
        create: { sessionId: session.id, profileId: donorId, entityType: donorType || donorLabel || "egg-donor" },
        update: {},
      }).catch(() => {});
    }

    let greetingUiCardData: any = donorId ? subjectGreetingCard : undefined;

    const greetingMsg = await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: builtGreeting,
        senderType: "ai",
        ...(greetingUiCardData ? { uiCardType: "rich" } : {}),
        uiCardData: { ...(greetingUiCardData || {}), ...(greetingQuickReplies.length ? { quickReplies: greetingQuickReplies } : {}) },
      },
    });

    // Save Phase 0 template message immediately - built server-side with correct services
    let phase0Msg: { id: string } | null = null;
    if (builtPhase0) {
      phase0Msg = await prisma.aiChatMessage.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          content: builtPhase0,
          senderType: "ai",
        },
      });
    }

    res.json({
      sessionId: session.id,
      greetingMessageId: greetingMsg.id,
      greeting: builtGreeting,
      greetingQuickReplies,
      phase0Content: builtPhase0,
      interestedServices,
      ...(phase0Msg ? { phase0MessageId: phase0Msg.id } : {}),
    });

    if (donorId && mcpClient) {
      mcpClient.callTool({ name: "resolve_match_card", arguments: { entityId: donorId, entityType: donorLabel } })
        .then((resolveResult: any) => {
          const resolved = JSON.parse((resolveResult.content as any)?.[0]?.text || "{}");
          if (resolved.name && resolved.name !== donorLabel) {
            // Title stays "AI Concierge Chat" - do not rename to donor/surrogate name
            if (greetingUiCardData) {
              prisma.aiChatMessage.update({
                where: { id: greetingMsg.id },
                data: { uiCardData: { matchCards: [{ ...greetingUiCardData.matchCards[0], name: resolved.name, ownerProviderId: resolved.ownerProviderId || req.body.ownerProviderId || undefined }] } },
              }).catch(() => {});
            }
          }
        }).catch((e: any) => console.error("[init-session] Background resolve error:", e));
    }
  } catch (e: any) {
    console.error("Init session error:", e);
    res.status(500).json({ error: e.message });
  }
});

aiRouter.post("/chat", async (req: Request, res: Response) => {
  const tReq = Date.now(); // request received - [LATENCY] logs measure pre-model work from here
  try {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const userId = (req.user as any).id;
    let currentSessionId = req.body.sessionId;

    const currentUser = await prisma.user.findUnique({ where: { id: userId }, select: { parentAccountId: true, name: true, firstName: true, lastName: true, email: true, mobileNumber: true } });
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
        where: { userId: { in: accountUserIds }, providerJoinedAt: null, status: { notIn: ["CONSULTATION_BOOKED", "PROVIDER_CONNECTED"] } },
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

    const attachmentData = req.body.attachmentData || null;
    const clientMsgId: string | undefined = req.body.clientMsgId;
    const isPhase0Init = req.body.isSystemTrigger === true && req.body.message === "phase0_init";
    const isPhase1Init = req.body.isSystemTrigger === true && req.body.message === "phase1_init";
    const isSystemTrigger = (req.body.isSystemTrigger === true && req.body.message === "consultation_callback_submitted") || isPhase0Init || isPhase1Init;

    // For system triggers, don't save a user message - just inject context and let AI respond.
    // For normal messages, deduplicate by clientMsgId (retry guard): if the client retries after
    // a stream failure, the first request's message is already in the DB - reuse it instead of
    // creating a second record with identical content.
    let savedUserMsg: { id: string } | null = null;
    if (!isSystemTrigger) {
      let existing: { id: string } | null = null;
      if (clientMsgId) {
        // Query recent user messages in this session and filter by clientMsgId in JS,
        // avoiding Prisma JSON-path filter type issues across different Prisma versions.
        const recentMsgs = await prisma.aiChatMessage.findMany({
          where: {
            sessionId: currentSessionId,
            role: "user",
            createdAt: { gte: new Date(Date.now() - 120_000) },
          },
          select: { id: true, uiCardData: true },
          orderBy: { createdAt: "desc" },
          take: 20,
        });
        const match = recentMsgs.find(m => (m.uiCardData as any)?.clientMsgId === clientMsgId);
        if (match) existing = { id: match.id };
      }
      if (existing) {
        savedUserMsg = existing;
      } else {
        const cardData = attachmentData
          ? { ...attachmentData, ...(clientMsgId ? { clientMsgId } : {}) }
          : clientMsgId ? { clientMsgId } : null;
        // Strip the "[Attached file: ...]" marker the client appends so the LLM sees
        // attachment context, but the SAVED bubble only shows the user's actual text.
        // The receiver's chat bubble renders msg.content verbatim; without this strip
        // the bracket leaks into the visible message next to the attachment card.
        const rawContent = String(req.body.message ?? "");
        const cleanedContent = attachmentData
          ? rawContent
              .replace(/\s*\[Attached file:[^\]]*\]/gi, "")
              .replace(/^\s*I've shared a file with you:[^\n]*\.?\s*Please acknowledge it\.?\s*$/i, "")
              .trim() || `Shared a file: ${(attachmentData as any)?.originalName || "file"}`
          : rawContent;
        savedUserMsg = await prisma.aiChatMessage.create({
          data: {
            sessionId: currentSessionId,
            role: "user",
            content: cleanedContent,
            senderType: "parent",
            senderName: parentDisplayName,
            ...(attachmentData ? { uiCardType: "attachment" } : {}),
            ...(cardData ? { uiCardData: cardData } : {}),
          },
        });
      }
    }

    // Remember the parent's most recent uploaded image so the look-alike face
    // matcher (find_lookalike_matches) can search against it on a later turn.
    // Only images - documents (PDFs etc.) are not face-matchable.
    if (currentSessionId && attachmentData?.mimeType?.startsWith?.("image/") && attachmentData?.url) {
      await prisma.aiChatSession
        .update({ where: { id: currentSessionId }, data: { lastUploadedPhotoUrl: String(attachmentData.url) } })
        .catch(() => {});
    }

    // Per-profile inquiry: the parent just engaged about whatever profile is on
    // screen (the latest match card). Fire-and-forget; deduped per (session,
    // profile); the sponsorship dashboard filters this to the sponsored subset.
    if (currentSessionId && savedUserMsg) {
      const sid = currentSessionId;
      findLatestChatSubject(sid)
        .then((subj) => {
          if (!subj) return;
          return prisma.profileInquiry.upsert({
            where: { sessionId_profileId: { sessionId: sid, profileId: subj.profileId } },
            create: { sessionId: sid, profileId: subj.profileId, entityType: subj.type },
            update: {},
          });
        })
        .catch(() => {});
    }

    const currentSession = await prisma.aiChatSession.findUnique({
      where: { id: currentSessionId },
      select: { providerJoinedAt: true, providerId: true, status: true, humanRequested: true, humanJoinedAt: true, humanConcludedAt: true, tier2Active: true, lastUploadedPhotoUrl: true, historySummary: true, subjectProfileId: true, subjectType: true, handoffCompletedAt: true },
    });

    // Kick off the Tier2-only expensive lookups (expert guidance rules,
    // answered whispers, knowledge-base RAG incl. its OpenAI embedding call)
    // EARLY so they overlap with the entire user-context assembly below,
    // instead of running serially after it (~300ms off Tier2 pre-work).
    // Every branch resolves (per-item .catch), so this can never produce an
    // unhandled rejection while later awaits run.
    const useTier2Early = !!(currentSession?.tier2Active);
    const tier2LookupsPromise: Promise<[string, any[], any[]]> = useTier2Early
      ? (Promise.all([
          getExpertGuidanceRules().catch(() => ""),
          // Answered whispers were scoped to (this parent, THIS session), so a
          // family that got an answer in one thread re-asked the provider from
          // scratch in another - and account partners never saw each other's
          // answers at all. Widen to the whole parent ACCOUNT. (Reuse across
          // DIFFERENT families is deliberately NOT done here - see
          // docs/freetext-request-test-plan.md; it needs a privacy decision
          // because stored questionText can carry the asking family's context.)
          // RELAYED included for the same reason as the cross-family lookup:
          // the status flips to RELAYED the moment Eva delivers the answer, so
          // an ANSWERED-only filter goes empty almost immediately and the
          // family's own answered questions vanish from context. The two are
          // framed differently below - ANSWERED is news, RELAYED is history.
          prisma.silentQuery.findMany({
            where: {
              status: { in: ["ANSWERED", "RELAYED"] },
              answerText: { not: null },
              ...(currentUser?.parentAccountId
                ? { parentUser: { parentAccountId: currentUser.parentAccountId } }
                : { parentUserId: userId }),
            },
            select: { questionText: true, answerText: true, providerId: true, status: true },
            orderBy: { updatedAt: "desc" },
            take: 8,
          }).catch(() => [] as any[]),
          // Fall back to the SESSION's provider: without a providerId the MCP
          // search returns only global tiers 2/3, so a provider's own uploaded
          // documents (tier 1) were unreachable on a normal chat turn - the
          // whole point of the provider knowledge base. Scoping to the session's
          // provider stays tenant-safe: tier 1 is filtered to that exact
          // provider, never anyone else's.
          searchKnowledgeBase(
            String(req.body.message || ""),
            req.body.providerId || currentSession?.providerId || undefined,
            5,
          ).catch(() => [] as any[]),
        ]) as Promise<[string, any[], any[]]>)
      : Promise.resolve(["", [], []] as [string, any[], any[]]);

    // If a GoStork human concierge has joined and not yet concluded, silence the AI
    if (currentSession?.humanJoinedAt && !currentSession.humanConcludedAt) {
      const sse = setupSSE(res);
      sse.sendDone({
        message: { id: null, content: "", senderType: "ai", role: "assistant" },
        sessionId: currentSessionId,
        userMessageId: savedUserMsg?.id,
        skipAiResponse: true,
      });
      return;
    }

    if (currentSession?.providerId && (currentSession.status === "PROVIDER_CONNECTED" || currentSession.status === "CONSULTATION_BOOKED")) {
      let userMsgDeliveredAt: string | null = null;
      if (currentSession.providerId) {
        const providerUsers = await prisma.user.findMany({
          where: { providerId: currentSession.providerId },
          select: { id: true },
        });
        // Mark delivered if any provider user is online
        if (providerUsers.some(u => isUserOnline(u.id))) {
          const now = new Date();
          userMsgDeliveredAt = now.toISOString();
          prisma.aiChatMessage.update({
            where: { id: savedUserMsg.id },
            data: { deliveredAt: now },
          }).catch(() => {});
        }
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

      // If the parent is requesting a human in a provider session, notify GoStork admins.
      // NOTE: the handler-wide `firstName` is declared much later (TDZ) - use this
      // branch-local name everywhere below or the whole branch throws at runtime.
      const parentFirstName = currentUser?.firstName || currentUser?.name?.split(" ")[0] || "The parent";
      let humanEscalationTriggered = false;
      const userMessage = String(req.body.message ?? "");
      const humanRequestPatternInProvider = /talk to (?:a )?(?:real|human|actual) person|talk to (?:the )?gostork team|speak (?:to|with) (?:a )?human|connect me with (?:a )?(?:human|person|someone)|i want (?:a )?human|i'd like to talk to a real person/i;
      if (humanRequestPatternInProvider.test(userMessage) && !currentSession.humanRequested) {
        try {
          await prisma.aiChatSession.update({ where: { id: currentSessionId }, data: { humanRequested: true } });
          void emitJourneyEvent({ eventType: "ESCALATED_TO_HUMAN", parentUserId: userId, sessionId: currentSessionId, actorRole: "parent" });
          humanEscalationTriggered = true;
          const admins = await prisma.user.findMany({ where: { roles: { hasSome: ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE"] } }, select: { id: true } });
          for (const admin of admins) {
            await prisma.inAppNotification.create({
              data: {
                userId: admin.id,
                eventType: "HUMAN_ESCALATION",
                payload: { parentName: parentFirstName, parentUserId: userId, sessionId: currentSessionId, message: `${parentFirstName} has requested to speak with a human concierge` },
              },
            });
          }
          try {
            const { notifyAdminsHumanEscalation } = await import("./notify-admin-escalation");
            notifyAdminsHumanEscalation({
              parentName: parentFirstName,
              parentEmail: currentUser?.email || "",
              parentPhone: currentUser?.mobileNumber || undefined,
              sessionId: currentSessionId || "",
            }).catch((e: any) => console.error("[PROVIDER_SESSION ESCALATION] Email/SMS failed:", e));

            // SSE toast (best effort)
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
                    payload: { parentName: parentFirstName, sessionId: currentSessionId, message: `${parentFirstName} has requested to speak with a human concierge` },
                    targetUserIds: admins.map((a: any) => a.id),
                  }).catch((e: any) => console.error("[PROVIDER_SESSION ESCALATION] SSE failed:", e));
                }
              }
            } catch {}
          } catch (notifErr) {
            console.error("[PROVIDER_SESSION ESCALATION] Notification failed:", notifErr);
          }
        } catch (e) {
          console.error("Failed to process human request in PROVIDER_CONNECTED session:", e);
        }
      }

      const sse = setupSSE(res);

      // "Talk to GoStork Team" flow inside a provider session. The AI is passive
      // here (messages relay straight to the provider), so the triage reply that
      // Eva generates in AI-only sessions is posted deterministically instead.
      // Dual-audience: the parent reads `content` (second person), the provider
      // chat renders `uiCardData.providerContent`.
      const teamQuickReplies = ["Keep chatting here", "I'll wait for the team", "Schedule a video call"];
      if (humanRequestPatternInProvider.test(userMessage)) {
        const triageContent = "I've notified the GoStork concierge team - someone will join this chat shortly, and they'll see the full conversation when they arrive. What would you like to do in the meantime?";
        const triageCardData = {
          quickReplies: teamQuickReplies,
          providerContent: `${parentFirstName} asked to speak with the GoStork team - a GoStork concierge will join this chat shortly.`,
        };
        const triageMsg = await prisma.aiChatMessage.create({
          data: { sessionId: currentSessionId!, role: "assistant", content: triageContent, senderType: "system", senderName: "GoStork", uiCardData: triageCardData },
        });
        sse.sendToken(triageContent);
        sse.sendDone({
          message: { id: triageMsg.id, content: triageContent, senderType: "system", role: "assistant", uiCardData: triageCardData },
          sessionId: currentSessionId,
          userMessageId: savedUserMsg.id,
          userMessageDeliveredAt: userMsgDeliveredAt,
          quickReplies: teamQuickReplies,
          humanNeeded: true,
        });
        return;
      }
      if (/^i'?ll wait for the team[.!]?$/i.test(userMessage.trim())) {
        const ackContent = "No problem - the team will be with you shortly. I'm here if you need anything in the meantime.";
        const ackCardData = { providerContent: `${parentFirstName} is waiting for the GoStork team to join this chat.` };
        const ackMsg = await prisma.aiChatMessage.create({
          data: { sessionId: currentSessionId!, role: "assistant", content: ackContent, senderType: "system", senderName: "GoStork", uiCardData: ackCardData },
        });
        sse.sendToken(ackContent);
        sse.sendDone({
          message: { id: ackMsg.id, content: ackContent, senderType: "system", role: "assistant", uiCardData: ackCardData },
          sessionId: currentSessionId,
          userMessageId: savedUserMsg.id,
          userMessageDeliveredAt: userMsgDeliveredAt,
        });
        return;
      }
      if (/^schedule a video call[.!]?$/i.test(userMessage.trim()) ||
          (/(schedule|book|set up).{0,40}(video\s*)?(call|meeting).{0,40}(concierge|gostork|your team|the team|a human)/i.test(userMessage) && !/(agency|clinic|provider|surrogate|donor)/i.test(userMessage))) {
        // Same GoStork staff pick as the [[CONCIERGE_CALENDAR]] tag handler.
        const staffMember = await prisma.user.findFirst({
          where: {
            OR: [{ roles: { has: "GOSTORK_ADMIN" } }, { roles: { has: "GOSTORK_CONCIERGE" } }],
            scheduleConfig: { bookingPageSlug: { not: null } },
          },
          orderBy: { createdAt: "asc" },
          select: { name: true, photoUrl: true, scheduleConfig: { select: { bookingPageSlug: true } } },
        });
        if (staffMember?.scheduleConfig?.bookingPageSlug) {
          const calContent = "Here's the GoStork concierge calendar - pick a time that works for you:";
          const conciergeCard = {
            providerId: null,
            providerName: "GoStork",
            providerLogo: null,
            bookingUrl: `/book/${staffMember.scheduleConfig.bookingPageSlug}`,
            iframeEnabled: true,
            memberBookingSlug: staffMember.scheduleConfig.bookingPageSlug,
            memberName: staffMember.name,
            memberPhoto: staffMember.photoUrl,
            aiSessionId: currentSessionId || undefined,
          };
          const calCardData = { consultationCard: conciergeCard, providerContent: `${parentFirstName} is scheduling a video call with the GoStork team.` };
          const calMsg = await prisma.aiChatMessage.create({
            data: { sessionId: currentSessionId!, role: "assistant", content: calContent, senderType: "system", senderName: "GoStork", uiCardType: "rich", uiCardData: calCardData },
          });
          sse.sendToken(calContent);
          sse.sendDone({
            message: { id: calMsg.id, content: calContent, senderType: "system", role: "assistant", uiCardData: calCardData },
            sessionId: currentSessionId,
            userMessageId: savedUserMsg.id,
            userMessageDeliveredAt: userMsgDeliveredAt,
            consultationCard: conciergeCard,
          });
          return;
        }
      }

      sse.sendDone({
        message: { id: null, content: "", senderType: "ai", role: "assistant" },
        sessionId: currentSessionId,
        userMessageId: savedUserMsg.id,
        userMessageDeliveredAt: userMsgDeliveredAt,
        skipAiResponse: true,
        humanNeeded: humanEscalationTriggered,
      });
      return;
    }

    // If the client supplied a fixed reply (e.g. readiness-prompt card confirmation),
    // skip the LLM entirely and stream that text as the AI response.
    const fixedReply = req.body.fixedReply as string | undefined;
    if (fixedReply) {
      const aiMsg = await prisma.aiChatMessage.create({
        data: {
          sessionId: currentSessionId,
          role: "assistant",
          content: fixedReply,
          senderType: "ai",
        },
      });
      const sse = setupSSE(res);
      sse.sendToken(fixedReply);
      sse.sendDone({
        message: { id: aiMsg.id, content: fixedReply, senderType: "ai", role: "assistant" },
        sessionId: currentSessionId,
        userMessageId: savedUserMsg?.id,
      });
      return;
    }

    // Set up SSE streaming - all AI responses from here forward use SSE
    const sse = setupSSE(res);

    // Parallelize all independent queries for performance
    const matchmakerId = req.body.matchmakerId;
    const [chatHistory, matchmaker, userRecord, openAiTools] = await Promise.all([
      prisma.aiChatMessage.findMany({
        where: { sessionId: currentSessionId },
        orderBy: { createdAt: "asc" },
      }),
      matchmakerId
        ? prisma.matchmaker.findUnique({ where: { id: matchmakerId } })
        : null,
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          name: true,
          email: true,
          mobileNumber: true,
          city: true,
          state: true,
          country: true,
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
      }),
      getCachedMcpTools(mcpClient),
    ]);

    // Detect service selection during the greeting/onboarding phase and persist it to the profile.
    // This covers two cases:
    //   1. Fresh user selects from the initial [[QUICK_REPLY:Surrogacy|Egg Donation|Sperm Donation|IVF Clinics]] greeting
    //   2. Returning user with pre-saved services says "Not exactly" and then picks from the MULTI_SELECT
    // In both cases the preceding AI message contains recognizable service option text.
    if (!isSystemTrigger && req.body.message && chatHistory.length <= 8) {
      try {
        const SERVICE_KEYWORD_MAP: Record<string, string> = {
          "surrogacy": "Surrogate",
          "egg donation": "Egg Donor",
          "sperm donation": "Sperm Donor",
          "ivf clinics": "Fertility Clinic",
          "ivf clinic": "Fertility Clinic",
          "egg donor": "Egg Donor",
          "sperm donor": "Sperm Donor",
          "surrogate": "Surrogate",
          "fertility clinic": "Fertility Clinic",
        };
        // Find the last AI message before the current user message
        const lastAiMsg = [...chatHistory].reverse().find(m => m.role === "assistant");
        const isServiceSelectionMsg = lastAiMsg && (
          lastAiMsg.content.includes("Surrogacy|Egg Donation|Sperm Donation|IVF Clinics") ||
          lastAiMsg.content.includes("What are you looking for help with")
        );
        if (isServiceSelectionMsg) {
          const msgLower = (req.body.message as string).toLowerCase();
          const selectedServices: string[] = [];
          for (const [keyword, dbValue] of Object.entries(SERVICE_KEYWORD_MAP)) {
            if (msgLower.includes(keyword) && !selectedServices.includes(dbValue)) {
              selectedServices.push(dbValue);
            }
          }
          if (selectedServices.length > 0 && userRecord?.parentAccountId) {
            const parentAccountId = userRecord.parentAccountId;
            const existingProfile = await prisma.intendedParentProfile.findUnique({ where: { parentAccountId } });
            if (existingProfile) {
              await prisma.intendedParentProfile.update({ where: { parentAccountId }, data: { interestedServices: selectedServices } });
              console.log(`[GREETING SERVICE UPDATE] Updated interestedServices for account ${parentAccountId}:`, selectedServices);
              // Patch the in-memory profile so the rest of this request sees the updated services
              if ((userRecord as any).parentAccount?.intendedParentProfile) {
                (userRecord as any).parentAccount.intendedParentProfile.interestedServices = selectedServices;
              }
            }
          }
        }
      } catch (e) {
        console.error("[GREETING SERVICE UPDATE] Error:", e);
      }
    }

    const profile = (userRecord as any)?.parentAccount?.intendedParentProfile;

    // --- IMMEDIATE PROFILE INFERENCE ---
    // Save logically-implied fields to DB from service registration and known biology.
    // CRITICAL: does NOT require profile != null - Surrogate registration alone is enough.
    // Uses upsert so it works even if no IntendedParentProfile record exists yet.
    //
    // Persona rules:
    //   Any+Surrogate registration: carrier=surrogate, needsSurrogate=true  (no gender needed)
    //   Any+EggDonor registration:  needsEggDonor=true (if no embryos)
    //   Any+SpermDonor registration: sperm=donor (if no embryos)
    //   Solo Man / Two Dads (gender=male): egg=donor, carrier=surrogate, needsSurrogate, needsEggDonor
    //   Gay male:  isLGBTQ=true, sameSexCouple=true (if not single)
    //   Solo Woman (female+single): sperm=donor
    //   Two Moms (lesbian): sperm=donor, isLGBTQ=true, sameSexCouple=true (if not single)
    if (userRecord?.parentAccountId) {
      const parentAccountId = userRecord.parentAccountId;
      const registeredServices: string[] = (profile?.interestedServices || []) as string[];

      // Gather Phase 1 / family signals from EVERY source so the inference fires on the
      // FIRST request after the user picks "Solo woman" etc, not the second. The SAVE for
      // the Phase 1 answer goes to userRecord.gender etc., but it runs AFTER the AI
      // response is generated - the immediate inference reads userRecord synchronously
      // at request start, before the SAVE. Without these fallbacks, solo woman's sperm
      // source / LGBTQ saves were one turn late, letting Tier 1 ask the sperm question
      // before intake bypass had spermSource available to drive Step 3a instead.
      const currentMsg = (req.body?.message || "").toString().toLowerCase();
      const historyUserMsgs = Array.isArray(chatHistory)
        ? chatHistory.filter((m: any) => m.role === "user").map((m: any) => (m.content || "").toLowerCase()).join(" ")
        : "";
      const allUserMsgsLower = `${historyUserMsgs} ${currentMsg}`;
      const familyType = profile?.familyType || "";
      const ftGender = familyType === "solo_man" || familyType === "two_dads" ? "man"
        : familyType === "solo_woman" || familyType === "two_moms" ? "woman" : "";
      const ftOrientation = familyType === "two_dads" ? "gay"
        : familyType === "two_moms" ? "lesbian" : "";
      const ftRelationship = familyType.startsWith("solo_") ? "single"
        : ["two_dads", "two_moms", "straight_couple"].includes(familyType) ? "couple" : "";
      // Phase 1 chat detection - matches the actual button label even if SAVE hasn't landed
      const chatSaysSoloMan = /\bsolo man\b/.test(allUserMsgsLower);
      const chatSaysSoloWoman = /\bsolo woman\b/.test(allUserMsgsLower);
      const chatSaysTwoDads = /\btwo dads\b/.test(allUserMsgsLower);
      const chatSaysTwoMoms = /\btwo moms\b/.test(allUserMsgsLower);
      const chatGender = chatSaysSoloMan || chatSaysTwoDads ? "man"
        : chatSaysSoloWoman || chatSaysTwoMoms ? "woman" : "";
      const chatOrientation = chatSaysTwoDads ? "gay"
        : chatSaysTwoMoms ? "lesbian" : "";
      const chatRelationship = chatSaysSoloMan || chatSaysSoloWoman ? "single"
        : chatSaysTwoDads || chatSaysTwoMoms ? "couple" : "";

      // Fall through: user table -> profile familyType -> chat phrasing.
      const genderVal = (userRecord.gender || ftGender || chatGender || "").toLowerCase();
      // CRITICAL: must check female/woman BEFORE male/man because "female".includes("male") is true.
      // Word-boundary regex prevents false positives - "female" no longer matches "male".
      const genderIsFemale = /\b(female|woman|girl)\b/.test(genderVal);
      const genderIsMale = !genderIsFemale && /\b(male|man|boy)\b/.test(genderVal);
      const orientationVal = (userRecord.sexualOrientation || ftOrientation || chatOrientation || "").toLowerCase();
      const orientationIsGay = orientationVal === "gay";
      const orientationIsLesbian = orientationVal === "lesbian";
      const relationshipVal = (userRecord.relationshipStatus || ftRelationship || chatRelationship || "").toLowerCase();
      const isSingle = relationshipVal === "single" || relationshipVal === "solo";
      const registeredForSurrogate = registeredServices.includes("Surrogate");
      const registeredForEggDonor = registeredServices.includes("Egg Donor");
      const registeredForSpermDonor = registeredServices.includes("Sperm Donor");
      const hasEmbryos = profile?.hasEmbryos === true;

      // Read current values via optional chaining - null profile means all fields unset
      const curCarrier = profile?.carrier ?? null;
      const curEggSource = profile?.eggSource ?? null;
      const curSpermSource = profile?.spermSource ?? null;
      const curNeedsSurrogate = profile?.needsSurrogate ?? null;
      const curNeedsEggDonor = profile?.needsEggDonor ?? null;
      const curIsLGBTQ = profile?.isLGBTQ ?? null;
      const curSameSexCouple = profile?.sameSexCouple ?? null;

      const inf: Record<string, any> = {};

      // --- SERVICE REGISTRATIONS (any persona, no gender required) ---
      if (registeredForSurrogate) {
        if (curCarrier == null) inf.carrier = "Gestational surrogate";
        if (curNeedsSurrogate == null) inf.needsSurrogate = true;
      }
      // Never infer needsEggDonor over an explicit own/partner egg source - the
      // registration may be from an abandoned or parallel journey, and the stale
      // flag flips clinic cards + cost matching into donor mode (2026-07-16 bug).
      const curEggLower = (curEggSource || "").toLowerCase();
      const eggIsOwnOrPartner = !!curEggLower && !curEggLower.includes("donor") && (curEggLower.includes("own") || curEggLower.includes("partner"));
      if (registeredForEggDonor && curNeedsEggDonor == null && !hasEmbryos && !eggIsOwnOrPartner) {
        inf.needsEggDonor = true;
      }
      if (registeredForSpermDonor && curSpermSource == null && !hasEmbryos) {
        inf.spermSource = "Sperm donor";
      }

      // --- SOLO MAN / TWO DADS (gender=male, NO female partner) ---
      // CRITICAL: these defaults assume the male user has no female partner who could provide
      // eggs or carry. They apply only to:
      //   - Solo Man (isSingle=true)
      //   - Two Dads / gay male couple (orientationIsGay=true, not single)
      // They must NOT apply to Man & Woman couples (straight male with female partner) because
      // the partner can be the egg source ("Partner eggs") and the partner can carry the
      // pregnancy ("My partner"). Defaulting to "Egg donor"/"Gestational surrogate" for an
      // MW male overwrites these correct choices before the user can answer the intake Qs.
      const maleHasNoFemalePartner = genderIsMale && (isSingle || orientationIsGay);
      if (maleHasNoFemalePartner) {
        if (curEggSource == null) inf.eggSource = "Egg donor";
        if (curCarrier == null && !inf.carrier) inf.carrier = "Gestational surrogate";
        if (curNeedsSurrogate == null && !inf.needsSurrogate) inf.needsSurrogate = true;
        // Only infer needsEggDonor if they explicitly registered for Egg Donor -
        // a male user with only Surrogate registered does NOT need a new egg donor
        if (curNeedsEggDonor == null && !inf.needsEggDonor && !hasEmbryos && registeredForEggDonor) inf.needsEggDonor = true;
      }
      if (genderIsMale && orientationIsGay) {
        if (curIsLGBTQ == null) inf.isLGBTQ = true;
        if (curSameSexCouple == null && !isSingle) inf.sameSexCouple = true;
      }

      // --- SOLO WOMAN (female + single) ---
      if (genderIsFemale && isSingle && curSpermSource == null && !inf.spermSource) {
        inf.spermSource = "Sperm donor";
      }

      // --- TWO MOMS (lesbian orientation) ---
      if (orientationIsLesbian) {
        if (curSpermSource == null && !inf.spermSource) inf.spermSource = "Sperm donor";
        if (curIsLGBTQ == null) inf.isLGBTQ = true;
        if (curSameSexCouple == null && !isSingle) inf.sameSexCouple = true;
      }

      if (Object.keys(inf).length > 0) {
        try {
          await prisma.intendedParentProfile.upsert({
            where: { parentAccountId },
            update: inf,
            create: { parentAccountId, ...inf },
          });
          if (profile) {
            Object.assign(profile, inf);
          } else {
            // Profile didn't exist - patch userRecord so rest of this request sees the data
            const syntheticProfile = { ...inf, parentAccountId, interestedServices: registeredServices };
            if ((userRecord as any).parentAccount) {
              (userRecord as any).parentAccount.intendedParentProfile = syntheticProfile;
            }
          }
          console.log(`[INFERENCE] Auto-saved for ${parentAccountId}:`, inf);
        } catch (e) {
          console.error("[INFERENCE] Failed:", e);
        }
      }
    }

    // Kick off clinic lookup in parallel with synchronous context-building below
    const clinicLookupPromise = (profile?.needsClinic === false && profile?.currentClinicName)
      ? prisma.provider.findFirst({
          where: { name: { contains: profile.currentClinicName, mode: "insensitive" }, type: { in: ["IVF_CLINIC", "FERTILITY_CLINIC"] } },
          select: {
            name: true,
            ivfSurrogateMinAge: true, ivfSurrogateMaxAge: true,
            ivfSurrogateMinBmi: true, ivfSurrogateMaxBmi: true,
            ivfSurrogateMinDeliveries: true,
            ivfSurrogateMaxDeliveries: true, ivfSurrogateMaxCSections: true,
            ivfSurrogateMaxMiscarriages: true, ivfSurrogateMaxAbortions: true,
            ivfSurrogateCovidVaccination: true,
            ivfMaxAgeIp1: true, ivfMaxAgeIp2: true,
            ivfTwinsAllowed: true, ivfGenderSelectionAllowed: true, ivfAcceptingPatients: true,
          },
        })
      : Promise.resolve(null);

    const messages: any[] = chatHistory.map(
      (msg) => ({
        role: msg.role as "user" | "assistant" | "system",
        content: msg.content,
      }),
    );

    // NEAR-DUPLICATE COLLAPSE: a lifetime thread accumulates repeats (the
    // same intake exchange across journeys, echoed replies) and a window
    // full of near-identical turns is exactly what provokes Gemini into
    // producing yet another duplicate. Collapse older turns that are >=90%
    // word-identical to a LATER turn of the same role - the model sees only
    // the newest occurrence; the visible thread is untouched. Scoped to the
    // tail that can actually reach the model's history window.
    {
      const DEDUP_SCAN = 60;
      const start = Math.max(0, messages.length - DEDUP_SCAN);
      const wordsOf = (s: any) => String(typeof s === "string" ? s : JSON.stringify(s))
        .replace(/\[\[[^\]]*\]\]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
      const tailWords = messages.slice(start).map((m) => (m.role === "system" ? null : wordsOf(m.content)));
      const drop = new Set<number>();
      for (let i = 0; i < tailWords.length; i++) {
        const a = tailWords[i];
        if (!a || a.length < 12) continue;
        for (let j = i + 1; j < tailWords.length; j++) {
          if (messages[start + i].role !== messages[start + j].role) continue;
          const b = tailWords[j];
          if (!b || b.length < 12 || Math.abs(a.length - b.length) / Math.max(a.length, b.length) > 0.25) continue;
          const bSet = new Set(b);
          const overlap = a.filter((w) => bSet.has(w)).length / a.length;
          if (overlap >= 0.9) { drop.add(start + i); break; } // later copy survives
        }
      }
      if (drop.size > 0) {
        console.log(`[HISTORY DEDUPE] Collapsed ${drop.size} near-duplicate turn(s) out of the model window`);
        for (const idx of [...drop].sort((x, y) => y - x)) messages.splice(idx, 1);
      }
    }

    let personalityBlock = "You are Eva, the expert fertility concierge for GoStork.";
    let initialGreeting: string | null = null;
    if (matchmaker) {
      personalityBlock = matchmaker.personalityPrompt;
      initialGreeting = matchmaker.initialGreeting;
    }

    const firstName = userRecord?.firstName || userRecord?.name?.split(" ")[0] || "there";
    const city = userRecord?.city || "";
    const state = userRecord?.state || "";
    const country = (userRecord as any)?.country || "";
    const location = city && state ? `${city}, ${state}` : city || state || "your area";
    const services: string[] = profile?.interestedServices || [];
    const service = services.length ? services.join(" and ") : "fertility services";

    if (initialGreeting) {
      initialGreeting = initialGreeting
        .replace(/\[First Name\]/gi, firstName)
        .replace(/\[Service\]/gi, service)
        .replace(/\[Location\]/gi, location);
      // Add line breaks for readability: before "Here is how", "To find", "First things"
      initialGreeting = initialGreeting
        .replace(/\.\s+(Here is how|Here's how)/g, ".\n\n$1")
        .replace(/\.\s+(To find)/g, ".\n\n$1")
        .replace(/\.\s+(First things|First,|So,|Now,|Let'?s start)/g, ".\n\n$1");
    }

    let userContextBlock = "";
    // Hoisted so the Phase 1 stand-down (below) can see them: a family with an
    // Intended Parent Form on the table is past onboarding.
    let ipFormPending = false;
    let ipFormSubmitted = false;
    // Whether a real upcoming provider consultation exists (drives CALL PREP MODE
    // below and read by the FAVORITE interceptor - never offer to schedule a call
    // that is already booked).
    let hasUpcomingProviderConsult = false;
    // Also fed to the Tier 1 compact prompt - a parent asking "how much do I
    // owe?" must not get "I don't have access to your financial information"
    // just because the turn happened to route to Tier 1.
    let paperworkBlock = "";
    // Hoisted so the top-priority directives below (service switch, etc.) can
    // defer to the handed-off rules instead of overriding them.
    let handedOffProviderNames = "";
    // Which provider that upcoming consult is with - the scheduling-intent
    // enforcement uses it to avoid forcing a calendar for an agency the parent
    // already has a call booked with (a DIFFERENT provider is still fine).
    let upcomingConsultProviderId: string | null = null;
    if (userRecord) {
      const parts: string[] = [];

      // --- LONG-THREAD CONTINUITY (ported from AI-Health) ---
      // Rolling summary of turns older than the model's recent-history window,
      // plus the durable cross-thread family memory. Both defer to the live
      // profile/data blocks on any conflict.
      if ((currentSession as any)?.historySummary) {
        parts.push(
          `EARLIER IN THIS CONVERSATION (summary of turns before the recent messages - use it for continuity, ` +
          `but defer to the CURRENT profile and data blocks for any fact or number):\n${(currentSession as any).historySummary}`,
        );
      }
      try {
        const acctIdForMemory = userRecord?.parentAccountId || userId;
        const memBlock = await memoryBlock(acctIdForMemory);
        if (memBlock) parts.push(memBlock);
        // Explicit "remember that..." capture - awaited only when the message
        // actually asks to remember (rare), so no latency for normal turns.
        if (!isSystemTrigger && req.body.message) {
          const captured = await captureExplicitMemory(acctIdForMemory, String(req.body.message));
          if (captured) {
            parts.push(`The parent JUST asked you to remember something and it is now saved: "${captured}". Briefly confirm you've noted it (one warm sentence) as part of your reply, then continue with their request.`);
          }
        }
      } catch (e: any) {
        console.warn(`[memory] injection failed: ${e?.message}`);
      }

      // PROFILE CONTRADICTION DETECTOR (deterministic - the prompt-section
      // rule lives in the intake slice, which is dropped on later-journey
      // turns): the parent mentions a spouse/partner while the saved profile
      // says single/solo. Highest-stakes field - it flips the biological
      // journey tree - so force the confirm-then-save protocol.
      if (!isSystemTrigger && req.body.message) {
        const mentionsSpouse = /\b(my|our)\s+(wife|husband|spouse|partner)\b/i.test(String(req.body.message));
        const savedSingle = /single|solo/i.test(String(userRecord?.relationshipStatus || "")) || /solo_/i.test(String(profile?.familyType || ""));
        if (mentionsSpouse && savedSingle) {
          parts.push(
            `PROFILE CONTRADICTION - CONFIRM FIRST (CRITICAL): The parent's profile says they are SINGLE/SOLO, but ` +
            `their latest message mentions a spouse/partner. Do NOT ignore this and do NOT silently assume. In your ` +
            `reply, warmly confirm in ONE short question whether to update their profile (e.g. "Quick check - I have ` +
            `you down as single, but you mentioned your wife. Should I update that? It changes some of the options ` +
            `I'll line up for you."), then continue helping with their actual request. Emit the [[SAVE:...]] for the ` +
            `corrected relationship/family fields ONLY after they confirm.`,
          );
        }
      }

      // --- IDENTITY ---
      parts.push(`The user's name is ${firstName}.`);
      if (userRecord.gender) parts.push(`Gender: ${userRecord.gender}.`);
      else parts.push(`Gender: not yet collected (ask in Phase 1).`);
      if (userRecord.sexualOrientation) parts.push(`Sexual orientation: ${userRecord.sexualOrientation}.`);
      else parts.push(`Sexual orientation: not yet collected (ask in Phase 1).`);
      if (userRecord.relationshipStatus) parts.push(`Relationship status: ${userRecord.relationshipStatus}.`);
      else parts.push(`Relationship status: not yet collected (ask in Phase 1).`);
      if (profile?.sameSexCouple != null) parts.push(`Same-sex couple: ${profile.sameSexCouple ? "yes" : "no"}.`);
      if (profile?.isLGBTQ != null) parts.push(`LGBTQ+: ${profile.isLGBTQ ? "yes" : "no"}.`);
      if (userRecord.partnerFirstName) {
        let partnerInfo = `Partner's name: ${userRecord.partnerFirstName}`;
        if (userRecord.partnerAge) partnerInfo += `, age ${userRecord.partnerAge}`;
        parts.push(partnerInfo + ".");
      }
      const locationWithCountry = country && country.toLowerCase() !== "united states" && country.toLowerCase() !== "us" && country.toLowerCase() !== "usa"
        ? `${location}${location !== "your area" ? ", " : ""}${country}`
        : location;
      parts.push(`Location: ${locationWithCountry}.${country ? ` Parent's country of citizenship: ${country}. Always pass parentCountry="${country}" to search_surrogates and search_surrogacy_agencies so agencies that do not serve parents from ${country} are automatically excluded.` : ""}`);
      parts.push(`Registered interest in: ${service}.`);
      if (userRecord.dateOfBirth) {
        const age = Math.floor((Date.now() - new Date(userRecord.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        parts.push(`Age: ${age}.`);
      }

      // --- BIOLOGICAL BASELINE (Phase 2) ---
      if (profile?.hasEmbryos === true) {
        parts.push(`Has frozen embryos: YES (count: ${profile.embryoCount ?? "unknown"}, PGT-A tested: ${profile.embryosTested === true ? "yes" : profile.embryosTested === false ? "no" : "unknown"}) - do NOT ask about embryos again. CRITICAL: because embryos already exist, the sperm and eggs were already used - do NOT ask "Do you need help finding a sperm donor?" or "Do you need help finding an egg donor?" - SKIP Step 2a and Step 3a entirely.`);
      } else if (profile?.hasEmbryos === false) {
        parts.push(`Has frozen embryos: NO - do NOT ask about embryos again.`);
      }
      if (profile?.eggSource) parts.push(`Egg source: ${profile.eggSource} - do NOT ask about egg source again.`);
      if (profile?.spermSource) parts.push(`Sperm source: ${profile.spermSource} - do NOT ask about sperm source again.`);
      if (profile?.carrier) parts.push(`Carrier: ${profile.carrier} - do NOT ask about carrier again.`);
      if (profile?.isFirstIvf != null) parts.push(`First IVF: ${profile.isFirstIvf ? "yes" : "no"} - do NOT ask about IVF history again.`);

      // --- SERVICE NEEDS (Phase 2 Step 0 / 2a / 3a / 4a) ---
      if (profile?.needsClinic === true) parts.push(`Needs help finding a clinic: YES - do NOT ask again.`);
      else if (profile?.needsClinic === false) {
        parts.push(`Already has a clinic${profile.currentClinicName ? ` (${profile.currentClinicName})` : ""} - do NOT ask if they need a clinic.`);
        // Inject IVF clinic surrogate requirements so AI can advise parents and pass clinicName to search
        if (profile.currentClinicName) {
          try {
            const clinicProvider = await clinicLookupPromise;
            if (clinicProvider) {
              const surReqs: string[] = [];
              if (clinicProvider.ivfSurrogateMinAge != null || clinicProvider.ivfSurrogateMaxAge != null)
                surReqs.push(`age ${clinicProvider.ivfSurrogateMinAge ?? "?"}-${clinicProvider.ivfSurrogateMaxAge ?? "?"}`);
              if (clinicProvider.ivfSurrogateMinBmi != null || clinicProvider.ivfSurrogateMaxBmi != null)
                surReqs.push(`BMI ${clinicProvider.ivfSurrogateMinBmi ?? "?"}-${clinicProvider.ivfSurrogateMaxBmi ?? "?"}`);
              if (clinicProvider.ivfSurrogateMaxCSections != null) surReqs.push(`max ${clinicProvider.ivfSurrogateMaxCSections} c-sections`);
              if (clinicProvider.ivfSurrogateMaxMiscarriages != null) surReqs.push(`max ${clinicProvider.ivfSurrogateMaxMiscarriages} miscarriages`);
              if (clinicProvider.ivfSurrogateMinDeliveries != null) surReqs.push(`min ${clinicProvider.ivfSurrogateMinDeliveries} prior deliveries`);
              if (clinicProvider.ivfSurrogateMaxDeliveries != null) surReqs.push(`max ${clinicProvider.ivfSurrogateMaxDeliveries} deliveries`);
              if (clinicProvider.ivfSurrogateCovidVaccination === true) surReqs.push("covid vaccinated required");
              if (surReqs.length > 0) {
                parts.push(`IVF CLINIC SURROGATE REQUIREMENTS (${clinicProvider.name}) - these are MANDATORY hard filters, tell the parent upfront and always pass parentClinicName="${profile.currentClinicName}" to search_surrogates: ${surReqs.join(", ")}.`);
              }
              const ipReqs: string[] = [];
              if (clinicProvider.ivfMaxAgeIp1 != null) ipReqs.push(`primary parent max age ${clinicProvider.ivfMaxAgeIp1}`);
              if (clinicProvider.ivfMaxAgeIp2 != null) ipReqs.push(`secondary parent max age ${clinicProvider.ivfMaxAgeIp2}`);
              if (clinicProvider.ivfTwinsAllowed === false) ipReqs.push("does not allow twins transfers");
              if (clinicProvider.ivfGenderSelectionAllowed === false) ipReqs.push("does not allow selecting the embryo's gender");
              if (ipReqs.length > 0) {
                parts.push(`IVF CLINIC PARENT REQUIREMENTS (${clinicProvider.name}): ${ipReqs.join(", ")}.`);
              }
            }
          } catch { /* non-critical - skip if lookup fails */ }
        }
      }
      if (profile?.needsEggDonor === true) parts.push(`Needs help finding an egg donor: YES - do NOT ask again.`);
      else if (profile?.needsEggDonor === false) parts.push(`Already has an egg donor - do NOT ask if they need one.`);
      if (profile?.needsSurrogate === true) parts.push(`Needs help finding a surrogate: YES - do NOT ask again.`);
      else if (profile?.needsSurrogate === false) parts.push(`Already has a surrogate - do NOT ask if they need one.`);

      // --- JOURNEY ---
      if (profile?.journeyStage) parts.push(`Journey stage: ${profile.journeyStage}.`);

      // --- CLINIC PREFERENCES (Match Cycle A) ---
      const clinicPrefs: string[] = [];
      if (profile?.clinicPriority) clinicPrefs.push(`priority: ${profile.clinicPriority}`);
      if (profile?.clinicAgeGroup) clinicPrefs.push(`age group: ${profile.clinicAgeGroup}`);
      if (clinicPrefs.length > 0) parts.push(`Saved clinic preferences (do NOT re-ask): ${clinicPrefs.join(", ")}.`);

      // CLINIC MATCH GATE: a clinic's success rate is meaningless without the egg
      // provider's age + IVF history, so the AI must collect every UNANSWERED
      // STEP 5-CLINIC question before matching - regardless of what the parent
      // said in a prior journey (e.g. they once said they had a clinic). Compute
      // exactly what is still missing from the saved profile and forbid defaulting
      // or matching until it is answered.
      {
        const usingDonorEggs = (profile?.eggSource || "").toLowerCase().includes("donor");
        const missingClinic: string[] = [];
        if (!profile?.eggSource) missingClinic.push("egg source (their own/partner's eggs vs donor eggs)");
        if (!profile?.clinicAgeGroup && !usingDonorEggs) missingClinic.push("the egg provider's age - i.e. the age of the woman whose eggs are used (this sets the success-rate age band)");
        if (profile?.isFirstIvf == null && !usingDonorEggs) missingClinic.push("whether this is their first IVF or they have done it before");
        if (missingClinic.length > 0) {
          parts.push(`CLINIC MATCH GATE (CRITICAL): If the parent asks to find, match, or recommend an IVF clinic, the following REQUIRED questions are still UNANSWERED: ${missingClinic.join("; ")}. You MUST run the STEP 5-CLINIC question sequence and ask EACH unanswered item (one question per message), saving the answer, BEFORE you call search_clinics or show ANY clinic MATCH_CARD. NEVER default, guess, assume "under 35", or carry over a value the parent did not explicitly give in this journey - even if they completed a different journey (e.g. sperm or egg-donor) before, and even if they previously said they already had a clinic. The success rate shown on the card is WRONG if any of these are defaulted, so do not recommend a clinic until they are answered.`);
        }
      }

      // --- EGG DONOR PREFERENCES (Match Cycle B) ---
      const donorPrefs: string[] = [];
      if (profile?.donorEyeColor) donorPrefs.push(`eye color: ${profile.donorEyeColor}`);
      if (profile?.donorHairColor) donorPrefs.push(`hair color: ${profile.donorHairColor}`);
      if (profile?.donorEthnicity) donorPrefs.push(`ethnicity: ${profile.donorEthnicity}`);
      if (profile?.donorHeight) donorPrefs.push(`height: ${profile.donorHeight}`);
      if (profile?.donorEducation) donorPrefs.push(`education: ${profile.donorEducation}`);
      if (profile?.eggDonorAgeRange) donorPrefs.push(`age range: ${profile.eggDonorAgeRange}`);
      if (profile?.eggDonorEggType) donorPrefs.push(`egg type: ${profile.eggDonorEggType}`);
      if (profile?.donorPreferences) donorPrefs.push(`other: ${profile.donorPreferences}`);
      if (donorPrefs.length > 0) parts.push(`Saved egg donor preferences (do NOT re-ask B1): ${donorPrefs.join(", ")}.`);

      // --- SPERM DONOR PREFERENCES (Match Cycle C) ---
      const spermPrefs: string[] = [];
      if (profile?.spermDonorType) spermPrefs.push(`donor type: ${profile.spermDonorType}`);
      if (profile?.spermDonorVialType) spermPrefs.push(`vial type: ${profile.spermDonorVialType}`);
      if (profile?.spermDonorPreferences) spermPrefs.push(`other: ${profile.spermDonorPreferences}`);
      if (profile?.spermDonorEthnicity) spermPrefs.push(`ethnicity: ${profile.spermDonorEthnicity}`);
      if (spermPrefs.length > 0) parts.push(`Saved sperm donor preferences (do NOT re-ask C1/C2): ${spermPrefs.join(", ")}.`);

      // --- SURROGATE PREFERENCES (Match Cycle D) ---
      const surrogatePrefs: string[] = [];
      if (profile?.surrogateCountries) surrogatePrefs.push(`countries: ${profile.surrogateCountries}`);
      if (profile?.surrogateTermination) surrogatePrefs.push(`termination: ${profile.surrogateTermination}`);
      if (profile?.surrogateTwins) surrogatePrefs.push(`twins: ${profile.surrogateTwins}`);
      if (profile?.surrogateAgeRange) surrogatePrefs.push(`age range: ${profile.surrogateAgeRange}`);
      if (profile?.surrogateExperience) surrogatePrefs.push(`experience: ${profile.surrogateExperience}`);
      if (profile?.surrogateBudget) surrogatePrefs.push(`budget: ${profile.surrogateBudget}`);
      if (profile?.surrogateBmiRange) surrogatePrefs.push(`BMI range: ${profile.surrogateBmiRange}`);
      if (profile?.surrogateMaxCSections != null) surrogatePrefs.push(`max c-sections: ${profile.surrogateMaxCSections}`);
      if (profile?.surrogateMaxMiscarriages != null) surrogatePrefs.push(`max miscarriages: ${profile.surrogateMaxMiscarriages}`);
      if (profile?.surrogateMedPrefs) surrogatePrefs.push(`other: ${profile.surrogateMedPrefs}`);
      if (surrogatePrefs.length > 0) parts.push(`Saved surrogate preferences (do NOT re-ask D1/D2/D3): ${surrogatePrefs.join(", ")}.`);

      // MATCH CHECKLIST (egg donor / sperm donor / surrogate): same principle as
      // the CLINIC MATCH GATE above - whenever the parent asks for a service
      // (even "out of nowhere", after a different journey), the AI must collect
      // that cycle's questions it does not already have answers to BEFORE it
      // matches. Compute what is still unanswered per cycle from the saved
      // profile and require it. Each gate is conditional on the parent actually
      // requesting that service, and the AI may skip an item it already asked
      // earlier in this same conversation.
      {
        const has = (...vals: any[]) => vals.some((v) => v != null && v !== "");
        if (!has(profile?.donorEyeColor, profile?.donorHairColor, profile?.donorEthnicity, profile?.donorHeight, profile?.donorEducation, profile?.eggDonorAgeRange, profile?.eggDonorEggType, profile?.donorPreferences)) {
          parts.push(`MATCH CHECKLIST - EGG DONOR (CRITICAL): If the parent asks to find, match, or recommend an egg donor, you have NO saved egg-donor preferences yet. You MUST ask the egg-donor preference questions (STEP 5-DONOR / B1: what matters most - e.g. ethnicity, education, physical traits, age range, and fresh vs frozen eggs) and SAVE the answers BEFORE calling search_egg_donors or showing an egg-donor MATCH_CARD. ONE QUESTION PER MESSAGE - never bundle multiple checklist questions into a single message, and NEVER re-ask a question the parent already answered in this conversation (their chat answer counts even if the profile has not caught up yet - emit the [[SAVE]] for it instead). Skip an item only if it is already saved above or already answered earlier in this conversation. Never carry it over or assume it from a prior journey.`);
        }
        if (!has(profile?.spermDonorType, profile?.spermDonorVialType, profile?.spermDonorPreferences, profile?.spermDonorEthnicity)) {
          parts.push(`MATCH CHECKLIST - SPERM DONOR (CRITICAL): If the parent asks to find, match, or recommend a sperm donor, you have NO saved sperm-donor preferences yet. You MUST ask the sperm-donor questions and SAVE the answers BEFORE calling search_sperm_donors or showing a sperm-donor MATCH_CARD. ONE QUESTION PER MESSAGE - ask C1 (what matters most: appearance, background, education, personality) first, then C2 (donor type - Open / Anonymous / Exclusive) in a SEPARATE later message. NEVER combine C1 and C2 in one message, and NEVER re-ask a question the parent already answered in this conversation - their chat answer counts even if the profile has not caught up yet (emit the [[SAVE]] for it instead). Skip an item only if it is already saved above or already answered earlier in this conversation.`);
        }
        const surrMissing: string[] = [];
        if (profile?.surrogateTwins == null) surrMissing.push("whether they want a surrogate willing to carry twins (D1)");
        if (!has(profile?.surrogateTermination)) surrMissing.push("their views on termination / selective reduction (D2)");
        if (!has(profile?.surrogateAgeRange, profile?.surrogateCountries, profile?.surrogateExperience)) surrMissing.push("their surrogate preferences - preferred age range / country / experience (D3)");
        if (surrMissing.length > 0) {
          parts.push(`MATCH CHECKLIST - SURROGATE (CRITICAL): If the parent asks to find, match, or recommend a surrogate, these are still UNANSWERED: ${surrMissing.join("; ")}. You MUST ask each unanswered item (STEP 5-SURROGATE, one question per message) and SAVE it BEFORE calling search_surrogates or showing a surrogate MATCH_CARD. Skip an item only if it is already saved above or you already asked it earlier in this conversation. Never carry it over or assume it from a prior journey.`);
        }
      }

      // Phase 7B: Eva stands down for handed-off journeys. Once a journey
      // with a provider completed its handoff (signed + paid), Eva must not
      // re-offer consultations, matching, or curation in that lane - the
      // provider runs the journey from here. Journey questions get
      // redirected to the provider's chat.
      // Single query via the user relation - previously two sequential
      // round-trips (account member ids, then sessions).
      const handedOffSessions = await prisma.aiChatSession.findMany({
        where: {
          user: userRecord?.parentAccountId ? { parentAccountId: userRecord.parentAccountId } : { id: userId },
          handoffCompletedAt: { not: null },
          providerId: { not: null },
        },
        select: { providerId: true, provider: { select: { name: true } } },
      }).catch(() => [] as any[]);
      const handedOffProviders = Array.from(
        new Map(handedOffSessions.map((hs: any) => [hs.providerId, hs.provider?.name || "the provider"])).entries(),
      ) as [string, string][];
      if (handedOffProviders.length > 0) {
        const names = handedOffProviders.map(([, n]) => n).join(", ");
        handedOffProviderNames = names;
        parts.push(`JOURNEY HANDED OFF (CRITICAL): the parent's journey with ${names} is COMPLETE - agreement signed, payment made, and the journey formally handed off to the provider. Rules:
1. NEVER offer or schedule consultations with ${names} and NEVER emit [[CONSULTATION_BOOKING]] for ${names}. If the parent asks to schedule or coordinate with ${names}, warmly point them to their direct chat with ${names} - the provider manages the calendar and next steps from here.
2. If the parent asks to see MORE surrogates/donors/profiles in that same journey lane, do NOT refuse - real journeys change (matches fall through, some parents pursue a second journey in parallel). But do NOT show profiles yet either. FIRST ask, warmly and without judgment, what is prompting the new search, with quick replies adapted to their journey, e.g. [[QUICK_REPLY:My match fell through|I want a second surrogate in parallel|I'm not happy with the agency|Just exploring]]. Ask ONLY this one question - no profiles, no [[CURATION]], no [[MATCH_CARD]] in that message. This OVERRIDES the FAVORITE flow: if the parent hearts/favorites a profile in this lane, confirm the save in ONE sentence and ask this why-question - do NOT propose a consultation and do NOT show another profile.
3. AFTER the parent answers the why-question, acknowledge their reason empathetically and THEN proceed with the NORMAL matching flow (search tools + [[MATCH_CARD]]). Tailor to the answer: if the match fell through or they are unhappy with the agency, be supportive (never defensive of the agency) and include profiles from OTHER agencies; if they want a second journey in parallel, celebrate that and search normally.
4. RESTART MARKER: if (and ONLY if) the parent's answer means their completed journey ENDED and they are starting over - the match fell through, or they are unhappy and leaving the agency - include the hidden tag [[JOURNEY_RESTART:PROVIDER_ID]] in that same reply, using the provider id from this list: ${handedOffProviders.map(([id, n]) => `${n} = ${id}`).join("; ")}. Do NOT emit it for "second journey in parallel" or "just exploring" - the existing journey continues in those cases.
5. Everything else stays fully available - other journeys, general questions, and a NEW journey of a DIFFERENT type needs no why-question at all.`);
      }

      // POST-BOOKING CALL PREP: once a consultation is booked (journeyStage flips to
      // "Consultation Requested" in the calendar controller / FAVORITE flow SAVE),
      // drive the short agency-prep intake for whatever is still missing so the
      // provider's parent-profile card is filled before the call. The rules live in
      // the post_booking_call_prep prompt section; this block activates it and
      // scopes it to ONLY the missing items.
      // journeyStage alone is a STALE signal - it stays "Consultation Requested"
      // after calls happen or get cancelled, which would make every later favorite
      // act like a call is already scheduled. Require a real upcoming
      // provider-hosted consultation (GoStork concierge calls don't count -
      // there's no agency to prep for).
      const upcomingProviderConsult = profile?.journeyStage === "Consultation Requested"
        ? await prisma.booking.findFirst({
            where: {
              parentUserId: userId,
              status: { in: ["PENDING", "CONFIRMED"] },
              scheduledAt: { gte: new Date() },
              providerUser: { providerId: { not: null } },
            },
            select: {
              id: true,
              providerUser: {
                select: {
                  provider: {
                    select: {
                      id: true,
                      name: true,
                      services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } },
                    },
                  },
                },
              },
            },
          })
        : null;
      hasUpcomingProviderConsult = !!upcomingProviderConsult;
      upcomingConsultProviderId = (upcomingProviderConsult?.providerUser?.provider as any)?.id || null;

      // PAPERWORK ON FILE: cost sheets, invoices and agreements live in the
      // parent-provider thread, but the parent asks Eva about them in the Eva
      // thread - where she previously had zero visibility and answered "I don't
      // see an invoice on your profile" / "you don't owe us anything!" while a
      // real pending invoice existed. Give her the account's actual artifacts
      // (read-only) so she can answer truthfully or point to the right chat.
      try {
        const paperAcctIds = userRecord?.parentAccountId
          ? (await prisma.user.findMany({ where: { parentAccountId: userRecord.parentAccountId }, select: { id: true } })).map((u) => u.id)
          : [userId];
        const [quotes, invoices, agreements] = await Promise.all([
          prisma.providerQuote.findMany({
            where: { parentUserId: { in: paperAcctIds }, supersededAt: null },
            orderBy: { createdAt: "desc" }, take: 3,
            select: { totalCostCents: true, parentAcknowledgedAt: true, createdAt: true, provider: { select: { name: true } } },
          }).catch(() => [] as any[]),
          prisma.invoice.findMany({
            where: { parentUserId: { in: paperAcctIds } },
            orderBy: { createdAt: "desc" }, take: 3,
            select: { status: true, serviceAmount: true, providerName: true, description: true, paidAt: true },
          }).catch(() => [] as any[]),
          prisma.agreement.findMany({
            where: { parentUserId: { in: paperAcctIds } },
            orderBy: { createdAt: "desc" }, take: 3,
            select: { status: true, signedAt: true, provider: { select: { name: true } } },
          }).catch(() => [] as any[]),
        ]);
        const paperLines: string[] = [];
        for (const q of quotes as any[]) {
          paperLines.push(`- COST SHEET from ${q.provider?.name || "a provider"}: $${(q.totalCostCents / 100).toLocaleString("en-US")} total${q.parentAcknowledgedAt ? " (acknowledged)" : " (not yet acknowledged)"}`);
        }
        for (const inv of invoices as any[]) {
          paperLines.push(`- INVOICE from ${inv.providerName}: $${(inv.serviceAmount / 100).toLocaleString("en-US")} - status ${inv.status}${inv.paidAt ? ` (paid)` : " (NOT paid)"}${inv.description ? ` - ${inv.description}` : ""}`);
        }
        for (const ag of agreements as any[]) {
          paperLines.push(`- AGREEMENT with ${ag.provider?.name || "a provider"}: status ${ag.status}${ag.signedAt ? " (signed)" : " (NOT signed yet)"}`);
        }
        if (paperLines.length > 0) {
          paperworkBlock = `PAPERWORK ON FILE (authoritative - use these EXACT figures/statuses; never claim you have no record of something listed here, and never tell the parent they owe nothing when an unpaid invoice is listed. You cannot act on these documents - point them to their chat with that provider, or the team via [[HUMAN_NEEDED]]):\n${paperLines.join("\n")}`;
          parts.push(`PAPERWORK ON FILE (the family's REAL cost sheets, invoices and agreements - authoritative):\n${paperLines.join("\n")}\nUse these EXACT figures and statuses when the parent asks about a quote, a total, a balance, a payment, or a contract. NEVER say you have no record of a document that is listed here, and NEVER tell them they owe nothing when an unpaid invoice is listed. You still cannot perform actions on them (no sending, no cancelling, no refunding) - the documents themselves live in the parent's chat with that provider, so point them there and offer the team ([[HUMAN_NEEDED]]) if they need more.`);
        }
      } catch (e: any) {
        console.error("[PAPERWORK CONTEXT] Failed:", e?.message);
      }
      if (upcomingProviderConsult) {
        // These two directives must hold for the WHOLE post-booking phase -
        // not just while prep items are missing (prep completes quickly and
        // the model then happily re-offered the calendar / never re-raised
        // the buried lawyer offer).
        const consultProvName = upcomingProviderConsult.providerUser?.provider?.name || "the provider";
        parts.push(`CALL ALREADY BOOKED: the parent already has a consultation call scheduled with ${consultProvName}. NEVER offer to schedule another consultation with ${consultProvName} and NEVER emit [[CONSULTATION_BOOKING]] for them - reference the existing upcoming call instead (next steps happen ON that call). Scheduling with a DIFFERENT provider they newly engage is still fine.`);

        // INTERNATIONAL PROGRAM - SECOND CALL: if the just-booked provider is a
        // surrogacy agency paired with a partner IVF/egg-donor clinic (an
        // international program), booking the agency covers only ONE of the two
        // legs. Surface the unbooked partner clinic's id + name and explicitly
        // authorize its booking - otherwise CALL PREP MODE below would suppress
        // the second [[CONSULTATION_BOOKING]] and the parent never gets the
        // clinic call.
        let partnerClinicPending = false;
        try {
          const bookedProvId = (upcomingProviderConsult.providerUser?.provider as any)?.id || null;
          if (bookedProvId) {
            const acctIds = userRecord?.parentAccountId
              ? (await prisma.user.findMany({ where: { parentAccountId: userRecord.parentAccountId }, select: { id: true } })).map((u) => u.id)
              : [userId];
            const unbooked = (await getProgramPartnerClinics(bookedProvId, acctIds)).filter((p) => !p.booked);
            if (unbooked.length > 0) {
              partnerClinicPending = true;
              const list = unbooked.map((p) => `${p.name} (providerId: ${p.id})`).join("; ");
              parts.push(`PARTNER IVF CLINIC PENDING (international program): ${consultProvName} is one leg of an international program that ALSO includes a partner IVF/egg-donor clinic the parent has NOT booked yet: ${list}. This clinic is a SEPARATE provider, so the "call already booked" rule does NOT apply to it and this is the exception to CALL PREP MODE below. Offer to set up that clinic call next (warm, one message), and when the parent agrees emit [[CONSULTATION_BOOKING:<the clinic providerId listed above>]] using the CLINIC's id (never the agency id). Offer this BEFORE diving into call-prep questions.`);
            }
          }
        } catch {
          /* best-effort - the directive is additive */
        }

        const prepMissing: string[] = [];
        if (!userRecord?.gender || !userRecord?.relationshipStatus) prepMissing.push("family type - who is on this journey (Phase 1 identity question)");
        if (!userRecord?.dateOfBirth) prepMissing.push("their age (save as birthYear = current year minus age)");
        if (!userRecord?.sexualOrientation) prepMissing.push(`their sexual orientation - agencies use it for surrogate matching preferences. Ask warmly and normalize it, e.g. "So the agency can match you with surrogates who are excited about your family type - how do you identify?" [[QUICK_REPLY:Straight|Gay|Lesbian|Bi|Queer]] and save [[SAVE:{"sexualOrientation":"..."}]]. SKIP silently (do not ask) if it is already implied by family type: two dads = Gay, two moms = Lesbian`);
        if (/married|partner|couple/i.test(userRecord?.relationshipStatus || "") && !userRecord?.partnerFirstName) prepMissing.push("their partner's first name and age (save partnerFirstName + partnerBirthYear)");
        if (profile?.hasEmbryos == null) prepMissing.push("whether they have frozen embryos");
        else if (profile.hasEmbryos === true && (profile?.embryoCount == null || profile?.embryosTested == null)) prepMissing.push("embryo details (how many and/or PGT-A tested)");
        if (!profile?.eggSource) prepMissing.push("their egg source plan (SKIP silently if implied by family type)");
        if (!profile?.spermSource) prepMissing.push("their sperm source plan (SKIP silently if implied by family type)");
        if (profile?.needsClinic == null && !profile?.currentClinicName) prepMissing.push("whether they already work with an IVF clinic (and which one)");
        // "First IVF journey?" is a CLINIC-call question - surrogacy/donor
        // agency calls don't need it (user feedback 2026-07-09).
        const consultTypeNames = (upcomingProviderConsult?.providerUser?.provider?.services || []).map((sv: any) => sv.providerType?.name || "");
        const consultIsIvfClinic = consultTypeNames.some((n: string) => /ivf|clinic/i.test(n));
        if (profile?.isFirstIvf == null && consultIsIvfClinic) prepMissing.push("whether this is their first IVF journey");
        if (!profile?.surrogateBudget && profile?.needsSurrogate !== false) prepMissing.push("their budget comfort range for the journey");
        if (prepMissing.length === 0) {
          // Phase 7C: prep intake complete for this consult - once per
          // account+provider (checked every turn while the consult is
          // upcoming, so dedupe against the event log).
          void (async () => {
            try {
              const provId = (upcomingProviderConsult.providerUser?.provider as any)?.id || null;
              const acct = userRecord?.parentAccountId || userId;
              const prior = await prisma.journeyEvent.findFirst({
                where: { parentAccountId: acct, providerId: provId, eventType: "PREP_INTAKE_COMPLETED" },
                select: { id: true },
              });
              if (!prior) {
                await emitJourneyEvent({ eventType: "PREP_INTAKE_COMPLETED", parentAccountId: acct, providerId: provId, actorRole: "parent" });
                console.log(`[journey-events] PREP_INTAKE_COMPLETED for account ${acct} / provider ${provId}`);
              }
            } catch { /* best-effort */ }
          })();
        }
        if (prepMissing.length > 0) {
          parts.push(`CALL PREP MODE - ACTIVE: The parent's consultation call is ALREADY BOOKED and confirmed - do NOT offer the calendar again, do NOT emit [[CONSULTATION_BOOKING]]${partnerClinicPending ? " (EXCEPTION: you MAY and SHOULD still book the partner IVF clinic named in the PARTNER IVF CLINIC PENDING directive above - offer that clinic call before starting prep)" : ""}, do NOT ask about scheduling or time preferences. Follow the POST-BOOKING CALL PREP section. Items still missing for the provider: ${prepMissing.map((m, i) => `(${i + 1}) ${m}`).join("; ")}. When the parent agrees to prep (e.g. "Let's do it") or sends any message while prep is pending, ask the FIRST missing item - one question per message, IN THE ORDER LISTED, framed as preparing for their call. If their message contains a question or a request of its own, answer/handle THAT first in the same reply, then ask the next missing prep item - NEVER ignore what the parent actually said. THIS OVERRIDES THE FAVORITE FLOW: if the parent just favorited a profile, confirm the favorite in ONE sentence (note the agency can discuss her on the upcoming call - do NOT offer to schedule another call, do NOT ask if they have questions or want more profiles), then ask the next missing prep item in the SAME reply. NEVER refuse the save - the system already saved it when the heart was tapped; if the profile has a hard incompatibility (e.g. not open to single parents), keep the confirmation, add ONE short heads-up sentence about it, and STILL ask the next prep item. Everything else about the parent is already saved - do not re-ask it.`);
        }
      }

      // INTERNATIONAL PROGRAM - SEQUENTIAL TWO-CALL BOOKING (pre-booking path):
      // a CountryProgram card bundles the surrogacy agency with its partner IVF
      // clinic. When the parent is looking at such a card (and has NOT yet
      // booked - the post-booking block above already handles the after-booking
      // case), surface the partner clinic's id + name so the model offers BOTH
      // calls one after the other and can emit the clinic's [[CONSULTATION_BOOKING]]
      // with the right id even after the agency search scrolled out of context.
      if (currentSessionId && !hasUpcomingProviderConsult) {
        try {
          const latestCard = await findLatestMatchCard(currentSessionId);
          if (latestCard?.type === "CountryProgram" && latestCard?.providerId) {
            const acctIds = userRecord?.parentAccountId
              ? (await prisma.user.findMany({ where: { parentAccountId: userRecord.parentAccountId }, select: { id: true } })).map((u) => u.id)
              : [userId];
            const unbooked = (await getProgramPartnerClinics(latestCard.providerId, acctIds)).filter((p) => !p.booked);
            if (unbooked.length > 0) {
              const list = unbooked.map((p) => `${p.name} (providerId: ${p.id})`).join("; ");
              parts.push(`INTERNATIONAL PROGRAM - TWO CALLS: The ${latestCard.country || "international"} program the parent is looking at bundles a surrogacy agency with a partner IVF/egg-donor clinic: ${list}. This is a TWO-provider program, so when the parent moves to schedule, offer a consultation with BOTH - the surrogacy agency FIRST (agency id = ${latestCard.providerId}), then the IVF clinic. Present them ONE AT A TIME (never two booking cards in one message): confirm and book the agency, tell the parent the program also includes the IVF clinic and offer that call as the next step, and when they agree emit [[CONSULTATION_BOOKING:<the clinic providerId listed above>]] using the CLINIC's id (never the agency id).`);
            }
          }
        } catch {
          /* best-effort - the directive is additive */
        }
      }

      // Intended Parent Form context: while the account has a prompted,
      // unfinished form, Eva knows about it and can nudge/answer questions
      // (behavior text lives in the ip_form_guidance prompt section).
      try {
        const acctForIpForm = userRecord?.parentAccountId || userId;
        const ipForm = await prisma.ipFormResponse.findUnique({
          where: { parentAccountId: acctForIpForm },
          select: { status: true, promptedAt: true, hasSecondParent: true },
        });
        if (ipForm?.promptedAt && ipForm.status === "DRAFT") {
          ipFormPending = true;
          parts.push(
            `IP FORM PENDING: This family was asked to complete their Intended Parent Form (at /ip-form) and has NOT submitted it yet. The surrogacy agency shares this form (with photos and their letter) with potential surrogates - a MATCH CALL CANNOT BE SCHEDULED until it is submitted. Follow the INTENDED PARENT FORM section: remind them naturally when relevant, answer questions about it, and point them to the form page. Do not nag on every message.`,
          );
        } else if (ipForm?.status === "SUBMITTED") {
          ipFormSubmitted = true;
          parts.push(`IP FORM STATUS: The family's Intended Parent Form IS SUBMITTED and complete. This overrides anything earlier in this conversation that treated it as pending - those messages are out of date. Never ask them to fill it, complete it, or finish it again, and never say you are "waiting" on it. The match call is now unblocked: the agency proposes the times (you cannot book it yourself), so tell them their coordinator will send times to this chat and offer to help them prepare.`);
        }
      } catch { /* best-effort context */ }

      userContextBlock = parts.join("\n");
    }

    // Try loading prompt sections from DB (admin-editable)
    const dbSections = await getPromptSections();

    // Journey-aware slimming: replace conversation_flow with only the blocks
    // this turn can use (see sliceConversationFlow). Signals are generous -
    // a cycle is dropped only when the profile EXPLICITLY rules it out AND no
    // registered service or recent chat message brings it back into scope.
    let sectionsForPrompt = dbSections;
    const fullCf = dbSections?.get("conversation_flow");
    if (dbSections && fullCf) {
      const svc = services.map((s: string) => s.toLowerCase());
      const recentUserText = (Array.isArray(chatHistory) ? chatHistory : [])
        .slice(-12)
        .filter((m: any) => m.role === "user")
        .map((m: any) => m.content || "")
        .join(" ")
        .toLowerCase();
      const eggSrc = (profile?.eggSource || "").toLowerCase();
      const spermSrc = (profile?.spermSource || "").toLowerCase();
      const carrierVal = (profile?.carrier || "").toLowerCase();
      const eggOwnPartner = !!eggSrc && !eggSrc.includes("donor") && (eggSrc.includes("own") || eggSrc.includes("partner"));
      const spermOwn = !!spermSrc && !spermSrc.includes("donor");
      const carrierSelf = carrierVal.includes("self");
      const inc = {
        intake: !currentSession?.tier2Active,
        A: profile?.needsClinic !== false
          || svc.some((s: string) => s.includes("clinic") || s.includes("ivf"))
          || /\b(clinic|ivf|doctor)\b/.test(recentUserText),
        B: (profile?.needsEggDonor !== false && !eggOwnPartner)
          || svc.some((s: string) => s.includes("egg"))
          || /egg donor|egg donation|donor egg/.test(recentUserText),
        C: !spermOwn
          || svc.some((s: string) => s.includes("sperm"))
          || /sperm/.test(recentUserText),
        D: (profile?.needsSurrogate !== false && !carrierSelf)
          || svc.some((s: string) => s.includes("surroga"))
          || /surrogat|gestational/.test(recentUserText),
      };
      const slicedCf = sliceConversationFlow(fullCf, inc);
      if (slicedCf.length < fullCf.length) {
        sectionsForPrompt = new Map(dbSections);
        sectionsForPrompt.set("conversation_flow", slicedCf);
        console.log(`[PROMPT SLICE] conversation_flow ${fullCf.length} -> ${slicedCf.length} chars (intake=${inc.intake} A=${inc.A} B=${inc.B} C=${inc.C} D=${inc.D})`);
      }
    }
    const biologicalMasterLogicFromDb = sectionsForPrompt ? assemblePromptFromSections(sectionsForPrompt, [
      "expert_persona", "ui_components", "conversation_flow", "matching_rules",
      "match_blurb_rules", "protocols", "post_match_behavior", "agency_confidentiality", "general_behavior",
      "post_booking_call_prep",
    ]) : null;

    const biologicalMasterLogic = biologicalMasterLogicFromDb || `
CONVERSATIONAL FLOW - EXPERT CONSULTANT MODE:
You are NOT a survey bot. You are an expert fertility consultant who listens deeply, offers guidance, and provides expert insight. You already know the user's basic profile (name, identity, location, services). NEVER re-ask for information you already have. Use it naturally.

YOUR EXPERT PERSONA:
- Guide parents with confidence. When they share a preference, acknowledge it and offer an Expert Tip that adds value.
- Example: If a parent says "I want a donor with a master's degree," respond: "Noted. That's a great goal. Expert Tip: we find that a donor's family health history is just as critical for long-term success. Let's look for both."
- Use warm Amata-style transitions: "Noted." "Understood." "I'm on it." "Perfect." "Great choice." "Let me look into that."
- Be conversational and human - you're a knowledgeable friend, not a form.

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
This shows toggleable buttons - the user can select multiple options, then tap "Done" to submit all selections at once.
Use MULTI_SELECT instead of QUICK_REPLY when the user should be able to pick several options (e.g., eye colors, hair colors, ethnicities, countries, clinic preferences).
CRITICAL: You MUST include the [[MULTI_SELECT:...]] tag literally in your message text. Do NOT just say "you can select multiple" without the tag - the buttons will NOT appear unless the tag is present. The tag is what renders the buttons. Never describe multi-select without including the tag.
Examples:
  - "What eye color preferences do you have?" [[MULTI_SELECT:Blue|Green|Brown|Hazel|Any]]
  - "Which countries are you open to?" [[MULTI_SELECT:USA|Mexico|Colombia]]

SHORTCUT RULE (CRITICAL - OVERRIDES STEP ORDER):
If the parent's FIRST message (or any early message) explicitly states what they need - e.g., "I'm looking for an IVF clinic", "I need a surrogate", "help me find an egg donor" - do NOT start from STEP 1. Instead:
1. Acknowledge warmly: "I'd love to help you find the perfect [service]!"
2. Save the need immediately: [[SAVE:{"needsClinic":true}]] or [[SAVE:{"needsSurrogate":true}]] etc.
3. Jump DIRECTLY to the relevant STEP 5 deep-dive (STEP 5-CLINIC, STEP 5-SURROGATE, or STEP 5-DONOR).
4. After the deep-dive, ask if they need help with OTHER services (embryos, eggs, sperm, carrier) - but only what you don't already know.
5. NEVER ask "do you also need help finding a [service]?" for the service they already told you they need. That's redundant and wastes their time.

This shortcut applies whenever the parent's intent is clear. Only use the full STEP 1-5 flow when the parent starts with a vague message like "hello" or "I need help" without specifying what service they need.

STANDARD FLOW (use only when the parent hasn't specified a service):
You MUST follow the question flow below in EXACT order. Ask ONE question per message. Do NOT combine multiple questions into one message. Do NOT re-order steps. After the user answers each question, acknowledge briefly and move to the NEXT step. Track which step you are on internally.

FERTILITY BIOLOGY - WHAT IS BIOLOGICALLY POSSIBLE FOR EACH FAMILY TYPE:
Before asking any question, identify the parent's family type from the conversation and apply ONLY the valid options below. Never offer an option that is biologically impossible for this family type.

Solo Man (single male, gay solo man):
  - Sperm: His own OR Donor sperm
  - Eggs: ALWAYS from a donor - no other option exists. NEVER ask about egg source.
  - Gestation: ALWAYS a gestational surrogate - no other option exists. NEVER ask who will carry.
  Questions to ask: sperm source only. Skip egg source and carrier entirely.

Two Dads (gay male couple):
  - Sperm: Partner A, Partner B, or Donor
  - Eggs: ALWAYS from a donor - no other option exists. NEVER ask about egg source.
  - Gestation: ALWAYS a gestational surrogate - no other option exists. NEVER ask who will carry.
  Questions to ask: whose sperm (Partner A / Partner B / Donor). Skip egg source and carrier entirely.

Solo Woman (single female):
  - Sperm: ALWAYS from a donor - no other option exists. NEVER ask about sperm source.
  - Eggs: Her own OR Donor eggs
  - Gestation: Herself OR a gestational surrogate
  Questions to ask: egg source, then carrier.

Two Moms (lesbian couple):
  - Sperm: ALWAYS from a donor - no other option exists. NEVER ask about sperm source.
  - Eggs: Partner A (traditional), Partner B (reciprocal IVF), or Third-party donor
  - Gestation: Partner A, Partner B, or a gestational surrogate
  Questions to ask: which partner's eggs (or donor), then who carries.

Man and Woman (heterosexual couple):
  - Sperm: His own OR Donor
  - Eggs: Her own OR Donor
  - Gestation: Female partner OR gestational surrogate
  Questions to ask: egg source, sperm source, carrier.

CRITICAL - SKIP QUESTIONS ALREADY ANSWERED BY CONTEXT:
Before asking ANY question, check if the parent already provided the answer - either explicitly in a previous message OR implicitly from their situation (use FERTILITY BIOLOGY above). If the answer is already known, SKIP the question entirely and move to the next unanswered step. Examples:
- Parent said "gay couple, need egg donor and surrogate and IVF clinic" - you already know: no embryos (needs egg donor), will use egg donor (gay couple), needs help finding one (said "need egg donor"), will use surrogate (gay couple), needs help finding one (said "need surrogate"), needs a clinic. SKIP Steps 1, 2, 2a, 3, 4, 4a entirely. Go straight to Step 5 (clinic).
- Gay male couple or single male: they CANNOT have embryos from their own eggs, eggs MUST come from a donor, and they WILL need a surrogate. SKIP Step 1 (embryos - unless they might have embryos from a prior cycle, which they would mention), SKIP Step 2 (egg source - always donor), SKIP Step 4 (carrier - always surrogate). Only ask 2a (need help finding egg donor?) and 4a (need help finding surrogate?) IF not already answered.
- Parent says "I need help finding an egg donor" - SKIP both Step 2 AND Step 2a (both answered).
- Parent says "I already have a surrogate" - SKIP both Step 4 AND Step 4a (both answered).
- Parent mentions they have embryos ("we have 3 frozen embryos") - SKIP Step 1, go to 1a/1b.
When skipping, do NOT announce what you're skipping. Just naturally move to the next unanswered question.

STEP 1: "Do you already have frozen embryos?" [[QUICK_REPLY:Yes, I do|No, not yet|Working to create them]]
  → If YES: go to STEP 1a
  → If NO: go to STEP 2
  → If WORKING TO CREATE THEM: acknowledge warmly, go to STEP 2
  → SKIP this question if context already tells you (e.g., gay couple looking for an egg donor obviously doesn't have embryos yet, unless they explicitly mentioned having some)

STEP 1a: "How many embryos do you have?"
  → After answer, go to STEP 1b

STEP 1b: "Have they been PGT-A tested?" [[QUICK_REPLY:Yes|No|I'm not sure]]
  → After answer, go to STEP 2

CRITICAL CONTEXT RULES FOR STEPS 2-4:
You MUST adapt questions based on TWO factors:
1. TENSE: If parent HAS embryos → past tense (decisions already made). If NOT → future tense (decisions ahead).
2. GENDER & SEXUAL ORIENTATION: You know the parent's gender and orientation from their profile. NEVER offer biologically impossible options:
   - A MALE parent cannot use "my own eggs" - eggs come from either their female partner or an egg donor.
   - A FEMALE parent cannot use "my own sperm" - sperm comes from either their male partner or a sperm donor.
   - A GAY MALE couple: eggs MUST come from a donor, sperm is from one of them. They WILL need a surrogate (they cannot carry).
   - A LESBIAN couple: sperm MUST come from a donor, eggs can be from one of them. One of them CAN carry.
   - A SINGLE MALE: eggs MUST come from a donor, sperm is his. He WILL need a surrogate.
   - A SINGLE FEMALE: sperm MUST come from a donor, eggs can be hers. She CAN carry.
   - A STRAIGHT COUPLE: eggs can be from the female partner or a donor, sperm can be from the male partner or a donor. The female partner CAN carry.
   Adjust the question wording AND the quick reply options accordingly. If a donor is the ONLY option (e.g., eggs for a gay male couple), acknowledge that naturally instead of asking - e.g., "Since you'll need an egg donor, do you need help finding one or do you already have one?"

STEP 2 - EGGS:
  Refer to FERTILITY BIOLOGY above first. Only ask if egg source has more than one valid option for this parent type.
  NEVER ask a male parent about egg source - eggs always come from a donor for male parents. Save donor silently and move to STEP 2a.
  Adapt based on gender/orientation:
  - If parent is MALE (gay or single): Eggs MUST come from a donor. SKIP Step 2 entirely. Save [[SAVE:{"eggSource":"donor eggs"}]] silently, go to STEP 2a.
  - If parent is FEMALE (or has a female partner who could provide eggs):
    - If HAS embryos (past tense): "For those embryos, were the eggs yours/your partner's or from a donor?" [[QUICK_REPLY:My own eggs|My partner's eggs|Donor eggs]]
    - If does NOT have embryos (future tense): "What's your plan for eggs - are you thinking of using your own/your partner's, or are you considering a donor?" [[QUICK_REPLY:My own eggs|My partner's eggs|Donor eggs|I'm not sure yet]]
  - If SINGLE (no partner): do NOT offer "My partner's eggs" option in quick replies.
  → IMMEDIATELY save the egg source: [[SAVE:{"eggSource":"[answer: my own eggs / partner's eggs / donor eggs]"}]]
  → If DONOR EGGS AND parent does NOT have embryos: go to STEP 2a
  → If DONOR EGGS AND parent already HAS embryos: SKIP step 2a (the donor was already used to create the embryos, no need to find one now). Go to STEP 3.
  → Otherwise: go to STEP 3

STEP 2a (ONLY if parent does NOT have embryos and needs a donor): "Do you need help finding an egg donor, or do you already have one?" [[QUICK_REPLY:I need help finding one|I already have one]]
  SKIP if the parent already said they need one (e.g., "I need an egg donor") or already have one.
  → After answer, go to STEP 3

STEP 3 - SPERM:
  Refer to FERTILITY BIOLOGY above first. Only ask if sperm source has more than one valid option for this parent type.
  NEVER mention "partner" in the question or options if the parent is SOLO (no partner exists).
  Adapt based on gender/orientation:
  - If parent is FEMALE (lesbian or single): Sperm must come from a donor - only one option exists. Skip the question, go to STEP 3a (only if they do NOT already have embryos).
  - If parent is SOLO MALE: Ask ONLY "did you use your own sperm or donor sperm?" - no mention of "partner" anywhere. [[QUICK_REPLY:My own|Donor sperm]]
  - If parent is MALE WITH PARTNER (gay couple or straight couple):
    - If HAS embryos (past tense): "And for sperm, did you use your own, your partner's, or donor sperm?" [[QUICK_REPLY:My own|My partner's|Donor sperm]]
    - If does NOT have embryos (future tense): "And for sperm, will you be using your own, your partner's, or donor sperm?" [[QUICK_REPLY:My own|My partner's|Donor sperm|Not sure yet]]
  → IMMEDIATELY save the sperm source: [[SAVE:{"spermSource":"[answer: my own / partner's / donor sperm]"}]]
  → If DONOR SPERM AND parent does NOT have embryos: go to STEP 3a
  → If DONOR SPERM AND parent already HAS embryos: SKIP step 3a (the donor was already used to create the embryos, no need to find one now). Go to STEP 4.
  → Otherwise: go to STEP 4

STEP 3a (ONLY if parent does NOT have embryos and needs a donor): "Do you need help finding a sperm donor, or do you already have one?" [[QUICK_REPLY:I need help finding one|I already have one]]
  → After answer, go to STEP 4

STEP 4 - CARRIER:
  Refer to FERTILITY BIOLOGY above first. Only ask if carrier has more than one valid option for this parent type.
  NEVER ask a male parent who will carry - they cannot. Save gestational surrogate silently and move to STEP 4a.
  Adapt based on gender/orientation:
  - If parent is MALE (gay or single): They CANNOT carry - a surrogate is the ONLY option. SKIP Step 4 entirely. Save [[SAVE:{"carrier":"gestational surrogate"}]] silently, go to STEP 4a.
  - If parent is FEMALE (or has a female partner who could carry):
    - If HAS embryos (past tense): "And who is carrying the pregnancy?" [[QUICK_REPLY:Me|My partner|A gestational surrogate]]
    - If does NOT have embryos (future tense): "And who is planning to carry the pregnancy?" [[QUICK_REPLY:Me|My partner|A gestational surrogate]]
  - If SINGLE (no partner): do NOT offer "My partner" option in quick replies.
  → IMMEDIATELY save the carrier: [[SAVE:{"carrier":"[answer: me / my partner / gestational surrogate]"}]]
  → If GESTATIONAL SURROGATE: go to STEP 4a
  → Otherwise: go to STEP 5

STEP 4a: "Do you need help finding a surrogate, or do you already have one?" [[QUICK_REPLY:I need help finding one|I already have one]]
  SKIP if the parent already said they need one (e.g., "I need a surrogate") or already have one.
  → After answer, go to STEP 5

INTELLIGENCE RULE - DO NOT ASK REDUNDANT QUESTIONS (CRITICAL):
If the parent's answer already covers the NEXT question too, SKIP IT. Do not ask a question the parent already answered. Examples:
- Parent says "yes, I need one" to "will you be working with a gestational surrogate?" - this ALSO answers "do you need help finding one?" (they said they NEED one). Skip Step 4a, go to Step 5.
- Parent says "I need help finding a surrogate" - skip BOTH Step 4 and Step 4a, they answered both.
- Parent says "I already have a donor" - skip "do you need help finding one?" since they already have one.
- Parent says "no, we'll carry ourselves" - skip Step 4a entirely since no surrogate is needed.
Apply this logic to ALL steps (2/2a, 3/3a, 4/4a): if the answer to the current question implicitly answers the follow-up, skip the follow-up.
This also applies if the user circles back after the conversation - treat their statement as both the answer to "do you need one?" AND "do you need help finding one?" and skip to the deep dive.

STEP 5: "Now that I have a clear picture of your family-building journey - do you also need help finding a fertility clinic, or do you already have one?" [[QUICK_REPLY:I need help finding one|I already have one]]
  → This is the ONLY service question you need to ask here. You already know from STEPS 2-4 whether they need an egg donor and/or surrogate (based on their answers and whether they said "I need help finding one" in steps 2a, 3a, 4a).
  → After answer, proceed to STEP 5 deep dives for ALL applicable services.

STEP 5 - SERVICE DEEP DIVES (ask deep dive questions for each service that applies, in this order):
  - Ask STEP 5-CLINIC if: the user said they need help finding a clinic in STEP 5 above.
  - Ask STEP 5-DONOR (egg donor) if: (a) the user said they need help finding an egg donor in STEP 2a, OR (b) the skip directives confirmed the user needs an egg donor (because they said so in chat or registered for it and Step 2a was skipped - treat this as confirmed YES), OR (c) the user confirmed donor eggs in STEP 2 and does NOT already have embryos.
  - Ask STEP 5-DONOR (sperm donor) if: the user said they need help finding a sperm donor in STEP 3a, OR the skip directives confirmed they need one (because they said so or registered for it and Step 3a was skipped - treat this as confirmed YES).
  - Ask STEP 5-SURROGATE if: (a) the user said they need help finding a surrogate in STEP 4a, OR (b) the skip directives confirmed the user needs a surrogate (because they said so in chat or registered for it and Step 4a was skipped - treat this as confirmed YES), OR (c) the user is a gay male or single male (who always needs a surrogate).

STEP 5-CLINIC (only if user is looking for a Fertility Clinic - ask ALL of these in order, one per message):
  IMPORTANT: Clinic success rates vary dramatically based on the EGG PROVIDER's age and egg source (own eggs vs donor eggs). You MUST collect this information BEFORE searching for clinics. Without it, you cannot provide accurate, personalized success rate data.

  GENDER-AWARE EGG SOURCE LOGIC:
  - If the parent is FEMALE and using her own eggs → HER age determines the success rate age group.
  - If the parent is MALE (straight, with a female partner) → The PARTNER provides the eggs. The PARTNER's age determines the success rate age group. Ask for the partner's age, NOT the parent's.
  - If the parent said "my partner's eggs" or "partner eggs" → This means OWN EGGS (not donor eggs). The partner IS the egg source. Ask for the PARTNER's age.
  - "Donor eggs" means eggs from a THIRD-PARTY anonymous/known donor, NOT from the partner. Do NOT confuse partner's eggs with donor eggs.
  - If using DONOR EGGS → Age group doesn't matter (donor rates are not age-specific). Skip the age question.

  5-CLINIC-A: "Since you're looking for a clinic, what's your main reason for seeking one out?" [[QUICK_REPLY:Medically necessary|Single parent|LGBTQ+|Changing clinics]]
  → After answer, acknowledge, then:
  5-CLINIC-B: CRITICAL - Do NOT ask about egg source again if it was ALREADY answered earlier in the conversation (STEP 2). Look back through the conversation: if the parent already said "my own eggs", "my partner's eggs", "donor eggs", or anything similar - SKIP THIS QUESTION and go directly to 5-CLINIC-C (or 5-CLINIC-D if using donor eggs).
  ONLY ask this question if the egg source was truly never discussed:
    - If FEMALE: "Will you be using your own eggs or donor eggs?" [[QUICK_REPLY:My own eggs|Donor eggs|I'm not sure yet]]
    - If MALE with female partner: "Will you be using your partner's eggs or donor eggs?" [[QUICK_REPLY:My partner's eggs|Donor eggs|I'm not sure yet]]
    - If MALE single or same-sex couple: "Will you be using donor eggs?" (They must use donor eggs)
  → Egg source mapping (each option saves a DISTINCT enum value - do not conflate):
    - "my own eggs" → eggSource = "own_eggs". Ask for the parent's age in the next step.
    - "my partner's eggs" or "partner's eggs" → eggSource = "partner_eggs". Ask for PARTNER's age in the next step.
    - "donor eggs" → eggSource = "donor". Skip the age question (donor rates are not age-specific). Go to 5-CLINIC-D.
  5-CLINIC-C: Ask for the AGE of whoever is providing the eggs:
    - If female parent using own eggs and age NOT in USER CONTEXT: "How old are you? Clinic success rates are reported by age group, so this helps me find the most accurate match for you."
    - If male parent using partner's eggs and partner's age NOT in USER CONTEXT: "How old is your partner? Since she'll be the egg provider, her age determines which success rate data applies."
    - If age IS already known from USER CONTEXT, skip this question.
    → Map the egg provider's age to an age group: under 35 → "under_35", 35-37 → "35_37", 38-40 → "38_40", over 40 → "over_40"
  → After answer, ask:
  5-CLINIC-D (SKIP if using donor eggs): "Is this your first time doing IVF, or have you been through it before?" [[QUICK_REPLY:First time|I've done IVF before]]. SKIP this question if the parent is using donor eggs - donor egg success rates do not vary by new vs. prior IVF cycles.
  → After answer, ask:
  5-CLINIC-E: "What's the most important thing to you when choosing a clinic?" [[QUICK_REPLY:Success rates|Cost|Location|Volume of births]]
  → After answer, ask:
  5-CLINIC-F: "Do you have any specific preferences for your physician? For example, gender or background." [[QUICK_REPLY:I prefer a male physician|I prefer a female physician|I prefer a BIPOC physician|I prefer a LGBTQA+ physician|No preference]]
  → After answer, go to next applicable service deep dive or STEP 6

  CLINIC MATCHING GATE - CRITICAL:
  If a parent asks you to find or match them with a clinic BEFORE you have collected their egg source and the egg provider's age, do NOT call search_clinics. Instead, explain WHY you need this info first:
  "Great question! Before I search for clinics, I need to know a couple of things so I can show you the most accurate success rates. Clinic outcomes vary a lot based on whether you're using your own eggs or donor eggs, and the egg provider's age group. Let me ask you a few quick questions first!"
  Then proceed with the STEP 5-CLINIC questions above. Only call search_clinics AFTER you have egg source and age.

  When you DO search for clinics, use the egg provider's age to highlight the correct age-group success rate in your blurb (e.g., "For patients in your partner's age group (Under 35), this clinic has a 65% live birth rate"). Use the successRatesByAge data from the search results.

  SURROGATE MATCHING GATE - CRITICAL:
  If a parent asks you to find or match them with a surrogate BEFORE you have asked about twins preference and country/location preference, do NOT call search_surrogates. Instead, say:
  "I'd love to help you find the perfect surrogate! Let me ask a couple of quick questions first so I can find the best matches for you."
  Then proceed with the STEP 5-SURROGATE questions (twins, country, termination views). Only call search_surrogates AFTER you have these answers.

  EGG DONOR MATCHING GATE - CRITICAL:
  If a parent asks you to find or match them with an egg donor BEFORE you have asked about their physical trait preferences (eye color, hair color, ethnicity), do NOT call search_egg_donors. Instead, say:
  "I'd love to help you find the perfect egg donor! We have thousands of profiles, so let me ask a few quick questions to narrow things down for you."
  Then proceed with the STEP 5-DONOR questions (eye color, hair color, height, ethnicity). Only call search_egg_donors AFTER you have at least eye color and hair color preferences.

  SPERM DONOR MATCHING GATE - CRITICAL:
  If a parent asks you to find or match them with a sperm donor BEFORE you have asked about their preferences, do NOT call search_sperm_donors. Instead, say:
  "Great! Let me ask a few quick questions about what you're looking for in a sperm donor so I can find the best matches."
  Then ask about physical traits, ethnicity, education, and any other preferences. Only call search_sperm_donors AFTER you have their key preferences.

STEP 5-DONOR (only if user said they need donor eggs OR donor sperm AND need help finding one - ask ALL of these in order, one per message):
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

STEP 5-SURROGATE (only if user said they need a surrogate AND need help finding one - ask ALL of these in order, one per message):
  5-SURROGATE-A: "Surrogacy is a beautiful process. Are you hoping for twins? Note: many clinics recommend single embryo transfers for safety." [[QUICK_REPLY:Yes|No]]
  → After answer, ask:
  5-SURROGATE-B: "Surrogacy programs vary significantly in cost depending on the country. A US journey is typically $150k+, while international options like Mexico or Colombia can be $60k-$100k. Which are you open to? You can pick more than one." [[MULTI_SELECT:USA|Mexico|Colombia]]
  → If USA selected, ask:
  5-SURROGATE-C: "In the US, we can match you with surrogates based on specific views. For example, what are your preferences regarding termination or selective reduction if medically necessary?" [[QUICK_REPLY:Pro-choice surrogate|Pro-life surrogate|No preference]]
  → After answer, go to STEP 6

STEP 6 - SUMMARY AND CURATION:
  After ALL deep dive sections are complete, send a warm summary of what you've learned and end with a question asking if the parent is ready. You MUST include the [[CURATION]] tag at the very end. Example:
  "I've got a great picture of what you're looking for! You're a [relationship] couple, [ages], in [location], and you value [priorities]. Shall I find your perfect matches now? [[CURATION]]"
  Do NOT call any search tools or include any [[MATCH_CARD]] in this message.
  The parent will reply with their confirmation. The system will then show a loading animation and automatically send "ready" as the next message.
  → If the parent says "I have one more thing" or asks a question instead of confirming: listen to what they share, acknowledge it, then ask again with [[CURATION]]: "Got it! Ready for me to find your matches now? [[CURATION]]"

STEP 7 - MATCH REVEAL:
  Once you receive "ready", you MUST call the appropriate MCP database tools to find real matches:
  - Call search_surrogates if user needs a surrogate (pass filters like agreesToTwins, agreesToAbortion based on their answers)
  - Call search_egg_donors if user needs an egg donor (pass filters like eyeColor, hairColor, ethnicity based on their answers)
  - Call search_sperm_donors if user needs a sperm donor
  - Call search_clinics if user needs a clinic - ALWAYS pass the user's state and city from their profile location. Clinics must be near the parent
  You MUST use ONLY the results returned by these tools. Do NOT invent or fabricate ANY names or IDs.
  Present matches for the services the user ACTUALLY asked for:
  - If user needs a SURROGATE: present individual surrogate profiles (we have real surrogates in our database, not agencies).
  - If user needs an EGG DONOR: present individual egg donor profiles from the database.
  - If user needs a SPERM DONOR: present individual sperm donor profiles from the database.
  - If user needs a FERTILITY CLINIC: present clinics from the database.
  
  CRITICAL MATCHING RULES:
  - ONLY present matches for services the user explicitly requested. If they only asked for a surrogate, show surrogate profiles - NOT clinics or egg donors.
  - If they asked for multiple services, present matches ONE AT A TIME across service types. Start with the service they mentioned first, present one profile, wait for feedback, then continue.
  - You MUST call the MCP database tools (search_surrogates, search_egg_donors, search_sperm_donors, search_clinics) to get REAL profiles. NEVER fabricate names, profiles, or IDs.
  - Use the IDs and names returned by the tools. The "providerId" field must be a real UUID from the tool results.
  - For surrogates: call search_surrogates with filters based on user's answers (twins, termination, etc.), set type to "Surrogate" in the MATCH_CARD
  - For egg donors: call search_egg_donors with filters (eye color, hair color, ethnicity, etc.), set type to "Egg Donor" in the MATCH_CARD
  - For sperm donors: call search_sperm_donors with filters, set type to "Sperm Donor" in the MATCH_CARD
  - For clinics: call search_clinics and ALWAYS pass: (1) the user's state and city as filters, (2) ageGroup based on the parent's age (under_35, 35_37, 38_40, over_40), (3) eggSource ("own_eggs" or "donor"), (4) isNewPatient (true if first-time IVF). These parameters ensure the success rates shown are personalized to the parent. Set type to "Clinic" in the MATCH_CARD. Include "successRateLabel" in the MATCH_CARD JSON with a human-readable description like "Own eggs · 35-37 · First-time IVF". NEVER mention a clinic by name without a [[MATCH_CARD]] - if you reference a clinic, you MUST include its match card so the parent can see the profile and schedule a consultation.
  - search_clinics returns rich data: all locations, doctors/team members, success rates by age group, cycle counts, and Top 10% status. The primary success rate shown is personalized to the parent's age and egg source. Use the "successRateLabel" from results to describe which metric the rate represents. Mention specific doctors by name when relevant (e.g., "led by Dr. Smith"). Use minSuccessRate parameter when the parent asks for clinics above a certain success rate threshold.

  ONE PROFILE AT A TIME RULE (CRITICAL):
  You MUST present exactly ONE match profile per message. NEVER show multiple MATCH_CARD tags in the same response.
  After presenting the single profile, STOP and wait for the parent's feedback before doing anything else.
  This creates a personal, curated experience - like a concierge hand-selecting each match individually.

  NO EXACT MATCH FALLBACK (IMPORTANT):
  If the search tools return zero results for the parent's exact preferences (e.g., no clinics in their city, no surrogates matching all criteria), do NOT say "I couldn't find anything" or give up. Instead:
  1. Broaden the search - try removing one filter at a time (e.g., search the state instead of the city, relax age range, drop one preference).
  2. Present the BEST AVAILABLE option as a "close match" and be TRANSPARENT about what doesn't perfectly match. For example:
     - "I searched for clinics in Manhattan but the closest top-rated option I found is in New Jersey - just a short trip across the river. They have incredible success rates, so let me show you..."
     - "I couldn't find a surrogate in Florida who matches all your criteria, but here's someone in Georgia who checks every other box - open to twins, experienced, pro-choice. The only difference is location."
  3. Always frame it positively - lead with what DOES match, then briefly mention the one thing that differs, and explain why this option is still worth considering.
  4. After presenting, ask: "Would you like me to keep looking, or does this feel like it could work?" [[QUICK_REPLY:Keep looking|Tell me more|Let's go with this one]]

  Present the match using the MATCH CARD format:
  [[MATCH_CARD:{"name":"displayName from tool results","type":"Surrogate","location":"location from tool results","photo":"","reasons":["Specific preference match 1","Specific preference match 2","Specific preference match 3"],"providerId":"id-from-tool-results"}]]
  For CLINIC match cards, also include these fields so the card shows the correct personalized success rate:
  [[MATCH_CARD:{"name":"clinic name","type":"Clinic","location":"city, state","photo":"","reasons":["reason1"],"providerId":"id","successRateLabel":"Own eggs · 35-37","ageGroup":"35_37","eggSource":"own_eggs","isNewPatient":false}]]
  The photo field can be empty - the system will automatically load the real photo from the database based on the providerId and type.

  PERSONALIZED MATCH BLURB (CRITICAL - DO NOT SKIP):
  Your text blurb MUST describe the EXACT SAME provider/clinic that is in the MATCH_CARD tag. NEVER mention a different provider in the blurb than the one in the card. If your MATCH_CARD says "Midwest Center", your blurb MUST be about Midwest Center - not any other clinic from the search results. Only ONE provider per message, in BOTH the text and the card.
  BEFORE the MATCH_CARD tag, write a warm, detailed, personalized blurb about this specific person. This is NOT a generic "this matches your preferences" sentence. Instead, write it like a personal concierge introducing someone they hand-picked. Include:
  1. SPECIFIC DETAILS about the person from the search results (age, location, experience, background, personality traits, etc.)
  2. EXPLICIT REFERENCES to the parent's stated preferences and how this person meets them. Name the actual preferences - e.g., "You mentioned you wanted someone open to carrying twins - she's done it before" or "You said pro-choice was important, and she aligns with that."
  3. A HUMAN TOUCH - make it feel like you personally reviewed this profile and are excited about the match, not like you're reading from a database.
  
  *** ABSOLUTE RULE - ONLY POSITIVES, ZERO NEGATIVES ***
  This is the #1 rule for match introductions. NEVER mention ANYTHING negative, lacking, missing, or potentially concerning about a match.
  
  BANNED phrases and patterns - if you catch yourself writing any of these, DELETE the sentence entirely:
  - "although", "while she hasn't", "while she isn't", "despite", "however"
  - "not yet experienced", "not experienced", "new to surrogacy"
  - "limited", "only", "just", "maxed out"
  - "she isn't open to...", "she doesn't have...", "she hasn't done..."
  - ANY sentence that contrasts a positive with a negative
  - ANY mention of something the candidate does NOT have or has NOT done
  
  If a preference the parent requested is NOT met by this candidate, DO NOT MENTION THAT PREFERENCE AT ALL. Simply skip it and talk about what IS great.
  
  ALWAYS mention these positives when the data is available:
  - Her support system: mention her partner/husband, family, or who supports her (parents care deeply about this)
  - Her pregnancy history: "mom of three with healthy pregnancies" (not "three live births" - keep it warm and human)
  - Her age if she's young and healthy
  - Her BMI if it's healthy
  - Her motivation and why she wants to be a surrogate
  - Matching preferences the parent actually stated
  - Her location and proximity
  - Her personality and warmth
  
  *** VARIETY RULE - NEVER REPEAT THE SAME SENTENCES ***
  Each match introduction MUST feel unique and freshly written. NEVER reuse:
  - "Feel free to explore her profile!"
  - "Let me know if she feels like a good match or if you'd like to see another option."
  - "Her openness to helping families of all kinds makes her a truly nurturing choice."
  - "a wonderful fit for your surrogacy journey"
  - ANY closing sentence you've already used in this conversation
  
  Instead, vary your closings naturally like a real person would:
  - "Take a look at her profile - I have a good feeling about this one!"
  - "What do you think? She really stood out to me."
  - "I'd love to hear your thoughts on her."
  - "Check out her full profile and let me know what you think!"
  - Or simply end after your last positive point without a generic closing.
  
  Vary your OPENINGS too. Don't always start with "I'm excited to introduce..." or "Here's someone." Mix it up:
  - "Okay, I think you're going to love this one."
  - "I've got someone really special to show you."
  - "Here's a great candidate I found for you."
  - "So I pulled up some profiles and one really caught my eye."
  
  Example for a surrogate: "Okay, I think you're going to love this one! Meet Surrogate #18691 - she's 29, a mom of two from Austin, Texas, and her husband is super supportive of her surrogacy journey. She's been through this process before with a smooth pregnancy, and she's totally on board with carrying twins, which I know matters to you. She's also pro-choice. I have a really good feeling about her - take a look!"
  
  Example for a clinic: "So I found a clinic that really stands out - CCRM in Manhattan. Their IVF success rates are some of the best in the country: 68% for women under 35, which is incredible. Since you said success rates are your top priority, their numbers speak for themselves. Dr. Tran is their lead RE and gets amazing reviews."
  
  The "reasons" array in the MATCH_CARD should list 2-4 SHORT, specific preference matches (e.g., "Open to twins", "Pro-choice", "Previous surrogacy experience") - these appear as checkmarks on the card.
  
  ANTI-HALLUCINATION RULE: ONLY reference preferences the parent has ACTUALLY stated during this conversation. NEVER claim a match fits criteria the parent was not asked about or did not mention. For example:
  - Do NOT say "within your budget" unless you explicitly asked the parent about their budget AND they gave a number.
  - Do NOT say "matches your location preference" unless the parent stated a location preference.
  - Do NOT invent or assume ANY preference the parent did not express. If you only know 2 preferences, only mention 2. Do not pad with made-up ones.
  
  SEARCH RESULT VALIDATION RULE (CRITICAL - ZERO TOLERANCE):
  Before presenting a match card, you MUST verify that EVERY search result you plan to show ACTUALLY satisfies the parent's stated requirements. Check the returned profile data against ALL explicit criteria the parent gave. Examples:
  - Parent says "blue eyes" → verify the profile's eyeColor is "Blue". If null or different, REJECT it.
  - Parent says "no more than 4 pregnancies" → verify liveBirths <= 4. If higher, REJECT it.
  - Parent says "max 2 C-sections" → verify cSections <= 2. If higher, REJECT it.
  - Parent says "Caucasian" → verify ethnicity/race matches. If different, REJECT it.
  - Parent says "in California" → verify location includes California. If different, REJECT it.
  If ALL results from the search fail validation, do NOT present any of them. Instead:
  1. Search again with adjusted or broader parameters.
  2. If still no valid matches, be honest: "I wasn't able to find a match that meets all your criteria right now. Would you like to adjust any of your preferences, or should I flag this so our team can help?"
  NEVER present a profile that contradicts the parent's explicit requirements. NEVER say "Although she has more than you specified" or make excuses for a mismatch - just don't show it.
  Also, NEVER include raw URLs, image links, or markdown image syntax in your message text. Profile photos are displayed on the match card itself - do not paste photo URLs in the text bubble.

  Do NOT add quick reply buttons when presenting a match card - the card has Skip (X) and Favorite (❤️) buttons built in. The parent will either skip or favorite the profile. (Note: quick replies ARE used during the SKIP follow-up flow below to ask why the parent declined.)
  
  MID-CONVERSATION SERVICE REQUEST (CRITICAL - DO NOT SKIP):
  When a parent mentions a NEW service mid-conversation - e.g., "I'm looking for an IVF clinic", "I need a surrogate", "I want to find an egg donor" - do NOT immediately search and show match cards. Instead:
  1. Check the chat history for what qualifying information you ALREADY have (age, partner details, egg source, location, preferences, etc.).
  2. Identify what REQUIRED intake questions for that service type are still unanswered. For IVF clinics: egg source (own vs. donor) and egg provider's age are MANDATORY before searching. For surrogates: twins preference and country/location. For egg donors: physical trait preferences.
  3. Acknowledge the request warmly, then ask the MISSING questions one at a time before searching. Example: "I'd love to help you find the perfect clinic! Let me ask a couple of quick questions so I can match you with the best options. Are you planning to use your own eggs or donor eggs?"
  4. Only call search tools AFTER you have collected the minimum required information for that service type.
  This rule applies even if the parent has been chatting about other topics - always qualify before matching.

  GENERAL COST/PRICING QUESTIONS (CRITICAL):
  When a parent asks a GENERAL question about costs or pricing - such as "how much does surrogacy cost?", "what are egg donor prices?", "how much does it cost in the USA?", "what's the price range?" - and they are NOT asking about a specific profile you already presented:
  1. Do NOT show match cards or individual profiles. This is a general information question, not a match request.
  2. Call the get_cost_ranges tool with the appropriate serviceType ("surrogacy", "egg-donor", or "sperm-donor") to get the actual min/max total journey costs from our database.
  3. Present the cost range naturally, e.g.: "Based on the programs we work with, a surrogacy journey in the US typically ranges from $X to $Y total. This includes base compensation, agency fees, legal fees, and medical expenses."
  4. After sharing the range, ask if they'd like to explore options within a specific budget or learn more about what's included.
  IMPORTANT: The get_cost_ranges tool returns REAL data from our database - always use it instead of guessing or using hardcoded numbers. If the tool returns no data (null values), you may say you don't have exact pricing data available yet and offer to connect them with a specialist.

  QUESTIONS ABOUT A PRESENTED MATCH (CRITICAL - DO NOT SKIP):
  When you have just presented a match card and the parent asks ANY question about that profile - birth weights, delivery types, health details, location, age, experience, compensation, personality, family, diet, anything - you MUST:
  1. Call get_surrogate_profile (or the appropriate search tool for egg donors/clinics) with the surrogate's ID/external ID to get the FULL profile data.
  2. Answer the question directly from the profile data.
  3. Do NOT treat questions as a skip/decline. Do NOT present a new match. Do NOT move on. Stay on the current profile and answer the question.
  4. After answering, ask if they have more questions or are ready to decide: "Anything else you'd like to know about her, or are you ready to decide?" [[QUICK_REPLY:More questions|I like her!|Show me someone else]]
  Examples of parent questions that should trigger a profile lookup (NOT a skip):
  - "What are the weights of her babies?" → Look up pregnancy history entries (Weight, Gestation, Delivery fields)
  - "Were her deliveries vaginal or C-section?" → Look up delivery types in pregnancy history
  - "Where does she live?" → Look up Current Location
  - "What's her BMI?" → Look up BMI in health details
  - "How much is the compensation?" → Look up Base Compensation
  - "Does she have experience?" → Look up previous surrogacy history
  - "Did she write a letter to intended parents?" → Look up "Letter to Intended Parents" section (contains _letterTitle and _letterText fields). This is a personal letter the surrogate writes - share it warmly.
  - "What's her education?" → Look up Education and Occupation section
  - "Does she have pets?" → Look up Personal Information section
  - "What's her blood type?" → Look up health/additional info section
  
  IMPORTANT: The profile data from get_surrogate_profile is a large JSON. Key sections to look for:
  - "Pregnancy History" → entries with DOB, Sex, Weight, Delivery, Gestation
  - "Letter to Intended Parents" → _letterText and _letterTitle (the surrogate's personal letter)
  - "Basic Information" → BMI, Race, Height, Education, Career
  - "Personal Information" → Pets, Location, Transportation
  - "My Health History" → allergies, medications, conditions
  - "General Interests" → hobbies, favorites, personality
  - "Education and Occupation" → employment, education level
  If you cannot find a field, look deeper - it may be nested or have a slightly different key name. NEVER say you "ran into a hiccup" or "couldn't find" data when you have the full profile.

  SKIP/FAVORITE INTERACTION FLOW:
  The parent interacts with match cards via two buttons on the card itself:
  - SKIP (X button): The parent sends a message like "I'm not interested in [Name]. Show me another option."
    → Step 1: Acknowledge warmly and respectfully. Example: "Totally understood - she's not the right fit, and that's perfectly okay!"
    → Step 2: Ask why to improve future matches. Say something like: "Would you mind sharing what didn't feel right? It'll help me find better matches for you." Then offer quick replies:
      [[QUICK_REPLY:Location too far|Age preference|Experience level|Personality/vibe|Compensation range|Just not the right fit|Other]]
    → Step 3 (After parent responds with reason): Save the feedback using [[SAVE:...]] to update their preferences so future searches reflect it. Use ONLY the supported SAVE field names listed in the REAL-TIME DATA PERSISTENCE section above. Examples:
      - "Location too far" → Ask which state or region they prefer. If they name a US state/region, note it and use it as a search filter. If they name a country preference, save: [[SAVE:{"surrogateCountries":"[country or countries]"}]]. Always pass the preferred state/region to your search tool filters when searching for the next match.
      - "Age preference" → Ask their preferred age range, then save: [[SAVE:{"surrogateAgeRange":"[range, e.g. 25-32]"}]]
      - "Experience level" → Save: [[SAVE:{"surrogateExperience":"experienced only"}]]
      - "Compensation range" → Ask their budget range, then save: [[SAVE:{"surrogateBudget":"under [amount]"}]]
      - "Personality/vibe" or "Just not the right fit" → Acknowledge ("That's totally valid - chemistry matters!") and move to Step 4 without saving (subjective, no filter to apply).
      - "Other" → Ask a brief follow-up: "Could you share a bit more about what you're looking for? I want to make sure the next match is closer to what you have in mind." Then save whatever preference they share using the supported field names.
    → Step 4: Confirm understanding and search. Say something like: "Got it - I'll focus on [adjusted criteria] for your next match!" Then call the search tools with updated filters and present ONE NEW MATCH_CARD. NEVER show more than one card.
    → REPEATED DECLINES RULE: If the parent has declined 3 or more profiles in this conversation, BEFORE showing the next match, proactively say: "I want to make sure I'm really understanding what you're looking for. Let me ask a couple of quick questions to narrow things down..." Then do a brief re-qualification focusing on whichever criteria seem misaligned (e.g., location, age, experience, compensation). Save updated preferences via [[SAVE:...]] before searching again.
  
  - FAVORITE (❤️ button): The parent sends a message like "I like [Name]! Save as favorite. ❤️"
    → Step 1: Acknowledge warmly and confirm the favorite: "Great choice! I've saved [Name] as a favorite for you."
    → Step 2: Immediately propose scheduling as the primary next step. Say something like: "The next step would be to schedule a free consultation call with the surrogate's agency (or "the egg donor's agency" / "the sperm donor's agency") so you can speak with them directly - it's completely free and no commitment required. Would you like to book that now, or do you have questions about [Name] first?" [[QUICK_REPLY:Schedule a consultation|I have some questions|Show me more profiles]] NEVER say the agency's real name before the call is booked (AGENCY NAME CONFIDENTIALITY).
      CRITICAL: Do NOT offer showing more profiles as an equal or primary option at this stage - the parent just saved someone they like. Scheduling is the clear next step. "Show me more profiles" is a fallback only.
    → Step 3 (If "I have some questions"): FIRST, use the get_surrogate_profile tool to look up the surrogate's FULL profile (for egg donors/clinics, re-run the search tool). The get_surrogate_profile tool returns pregnancy history (birth weights, delivery types, gestational ages), health info, support system, insurance, preferences, and more. Answer the parent's question using this data.
      ONLY use [[WHISPER:PROVIDER_ID]] if the answer is truly NOT in the profile data AND NOT in the knowledge base. Questions about pregnancy history, birth weights, delivery types, health details, BMI, compensation, preferences, support system, and personal background are ALL in the profile - use the tool to look them up.
      If you DO need to whisper: Your response MUST include the literal tag [[WHISPER:provider-uuid-here]] with the real provider UUID. Say: "That's a great question! I don't have that specific detail yet, but I've just sent a message to the agency. I'll get back to you as soon as they reply!" followed by [[WHISPER:provider-uuid-here]].
      CRITICAL: You MUST include the [[WHISPER:...]] tag in your response text. Do NOT just say you'll check - the tag is what triggers the system to actually send the question. Without the tag, NOTHING happens. The PROVIDER_ID is the ownerProviderId from the MATCH_CARD you presented (NOT the surrogate/donor's own ID).
      IMPORTANT: After using [[WHISPER:...]], WAIT for the provider's answer. Do NOT move forward to scheduling until the parent says they're done with questions. Keep answering questions as long as the parent has them.
      After answering ALL questions, loop back to Step 2: "Now that you have those answers - would you like to schedule a free consultation call with the surrogate's agency?" (or the egg/sperm donor's agency - NEVER the real agency name) [[QUICK_REPLY:Yes, schedule a consultation|Show me more profiles]]
    → Step 4 (If "Schedule a consultation" at any point): Provide a brief summary about the agency WITHOUT naming it (per AGENCY NAME CONFIDENTIALITY - real details like location/experience are fine, the name is not). Then include [[CONSULTATION_BOOKING:PROVIDER_ID]] to present the booking card. Also include [[HOT_LEAD:PROVIDER_ID]] and save: [[SAVE:{"journeyStage":"Consultation Requested"}]]
    → Step 5 (If "Show me more profiles"): Call the search tools again and present ONE NEW MATCH_CARD.
  
  - REMEMBER: Always wait for the parent to respond at each step. Never skip ahead or auto-present the next profile. The parent can ask as many questions as they want before scheduling.

SILENT PASSTHROUGH PROTOCOL:
BEFORE whispering, ALWAYS try the get_surrogate_profile tool first (pass the surrogate's ID or external ID number like '19331'). This tool returns the FULL profile including pregnancy history (birth weights, delivery types, gestational ages), health details, BMI, support system, insurance, preferences, compensation, education, and personal background. If the answer is in the profile data, answer directly - do NOT whisper.
Only when the user asks a question about a provider's operations, policies, or details that you TRULY cannot find in the profile data, KNOWLEDGE BASE CONTEXT, or via your database tools, you MUST include the [[WHISPER:PROVIDER_ID]] tag in your response.
Format: Include [[WHISPER:provider-uuid-here]] at the END of your response text. The PROVIDER_ID is the ownerProviderId from the most recent MATCH_CARD. This tag is REQUIRED - without it, the question is NEVER sent to the provider.
Your message should say: "That's a great question! I don't have that specific detail yet, but I've just sent a message to the agency. I'll get back to you as soon as they reply!" [[WHISPER:provider-uuid-here]]
NEVER ask the parent "Would you like me to contact the agency?" or "Shall I ask them?" - just send the whisper immediately when you don't know the answer. Asking for confirmation causes the parent's "yes" reply to be forwarded as the question instead of the real question.
NEVER say you'll "check" or "look into it" without including the [[WHISPER:...]] tag - that would be lying to the parent since nothing actually happens without the tag.
The system will silently send the question to the provider's AI Concierge inbox (the parent's identity is NOT revealed to the provider). When the provider answers, you'll receive it as a PROVIDER WHISPER ANSWER in your context - present it naturally.
CRITICAL: Using [[WHISPER:...]] does NOT create a direct conversation with the provider. The parent stays in their AI chat. Only when the parent schedules a consultation (via [[CONSULTATION_BOOKING:...]]) does a direct 3-way chat get created.
Only use [[WHISPER:...]] when you're discussing a SPECIFIC provider and the question requires provider-specific knowledge you don't have. Do NOT whisper for general fertility questions you can answer yourself.

HUMAN ESCALATION PROTOCOL:
If the user says ANY of these (or similar): "talk to a real person", "talk to the GoStork team", "I'd like to talk to a real person", "speak to a human", "connect me with someone", "I want a human", "talk to someone real" - you MUST include [[HUMAN_NEEDED]] in your response. This is MANDATORY - without the tag, the human team will NOT be notified.
Your response MUST follow this exact structure:
1. First sentence: Confirm the team has been notified. Example: "Absolutely, [name]! I've notified our human concierge team - one of them will jump in shortly to assist you directly!"
2. Second sentence: Offer to continue the matching work while waiting. Example: "In the meantime, would you like to continue with our matching questions so we can find your best options?"
FORBIDDEN phrases after human escalation - NEVER use these: "consultation", "arrange", "set up a call", "connect you with", "schedule", "guide you further". The parent already asked for a human - do NOT offer to arrange anything. Just offer to continue the matching flow.
CRITICAL: You MUST include [[HUMAN_NEEDED]] in the response. The tag triggers the notification - without it, no human will know to join.

REAL-TIME DATA PERSISTENCE:
After the user provides each answer, include a JSON block at the END of your response in this exact format:
[[SAVE:{"fieldName":"value"}]]
The system will automatically save this to their profile. Use these field names:
- hasEmbryos (boolean), embryoCount (number), embryosTested (boolean)
- eggSource, spermSource, carrier (strings)
- clinicReason, clinicPriority (strings)
- donorEyeColor, donorHairColor, donorHeight, donorEducation, donorEthnicity (strings - for multi-select, join with comma)
- surrogateBudget, surrogateMedPrefs (strings)
- surrogateAgeRange (string - e.g. "25-32", "under 30")
- surrogateExperience (string - e.g. "experienced only", "first-time ok")
- needsSurrogate (boolean - save true when user says they need help finding a surrogate)
- needsEggDonor (boolean - save true when user says they need help finding an egg donor)
- needsClinic (boolean - save true when user says they need help finding a clinic)
- surrogateTwins (string - "Yes" or "No")
- surrogateCountries (string - comma-separated: "USA,Mexico,Colombia")
- surrogateTermination (string - "Pro-choice surrogate", "Pro-life surrogate", or "No preference")
Example: If user says they have 3 frozen embryos, end your response with: [[SAVE:{"hasEmbryos":true,"embryoCount":3}]]
Example: If user says they need a surrogate, save: [[SAVE:{"needsSurrogate":true}]]
Example: If user selects USA and Mexico for surrogate countries, save: [[SAVE:{"surrogateCountries":"USA,Mexico"}]]
CONSULTATION BOOKING:
When a parent is ready to take the next step with a matched provider and wants to schedule a consultation (not just a match call), use:
[[CONSULTATION_BOOKING:PROVIDER_ID]]
This will present a booking card with the provider's details and a "Schedule Consultation" button.
After triggering a consultation booking, keep your text VERY short because the system will automatically embed the provider's calendar widget right below your message. Say something brief like: "Here's the calendar - pick a time that works for you!" Do NOT say you "logged" anything or that you'll "keep an eye on it." The calendar appears automatically.
Also save the journey stage: [[SAVE:{"journeyStage":"Consultation Requested"}]]

All [[SAVE:...]], [[QUICK_REPLY:...]], [[CURATION]], [[MATCH_CARD:...]], [[HOT_LEAD:...]], [[WHISPER:...]], [[HUMAN_NEEDED]], and [[CONSULTATION_BOOKING:...]] tags are stripped before the user sees the message.

MANDATORY MATCH_CARD TAG RULE:
Whenever you present a match profile after calling a search tool, you MUST ALWAYS include the [[MATCH_CARD:...]] tag in your response. The tag renders a visual profile card with the person's photo, name, and action buttons. WITHOUT the tag, the parent sees only plain text with NO card, NO photo, and NO way to interact. This is a CRITICAL system requirement - NEVER skip the MATCH_CARD tag when introducing a match.

AGENCY NAME CONFIDENTIALITY:
NEVER disclose the name of the agency or provider that represents a surrogate, egg donor, or sperm donor BEFORE the parent has scheduled a consultation (i.e., before a 3-way chat is created). If the parent asks "what's the name of her agency?" or similar:
1. Do NOT reveal the agency name.
2. Do NOT whisper to the provider - this is a policy, not a question that needs answering.
3. FIRST, call the resolve_provider tool with the ownerProviderId from the most recent MATCH_CARD to get REAL provider details (location, year founded, services offered, number of surrogates/donors, etc.).
4. Also check the KNOWLEDGE BASE CONTEXT for additional info about this provider.
5. Share SPECIFIC, real details about the agency WITHOUT naming them - location (city/state), year founded, how many surrogates/donors they represent, services they offer, what makes them unique. Do NOT make up generic praise - use REAL data from the provider profile.
6. Example of a GOOD response: "I can't share the agency name just yet - that comes once we connect you through a consultation. But here's what I can tell you: they're based in Los Angeles, California, founded in 2015, and they currently represent over 50 surrogates. They specialize in both domestic and international surrogacy and offer full-service matching with legal and medical coordination. Would you like to schedule a free consultation to learn more?"
7. Example of a BAD response (too generic): "They're well-established and known for their thorough screening process." - This says nothing specific. Always use real data.

CONVERSION-FIRST MINDSET (CRITICAL - NEVER VIOLATE):
Your primary goal is to CONNECT the parent with the agency. NEVER leave the conversation open-ended or passive.

BANNED PHRASES (never use these or anything similar):
- "Is there anything else I can assist you with?"
- "Feel free to let me know your next steps."
- "Feel free to reach out!"
- "What would you like to do?"
- "Let me know if you need anything."
- "Is there anything more you'd like to know?"
- "There was an issue accessing her profile"
- "I'm unable to retrieve/access the data"
- "It seems there was an issue accessing"
- Any variation of "I couldn't access/retrieve/find the profile data"
- Any sentence that puts the burden on the parent to decide what happens next.

NEVER ADMIT DATA ACCESS FAILURE:
If you cannot find data in the profile to answer a question, do NOT tell the parent "there was an issue accessing the data." Instead, use [[WHISPER:ownerProviderId]] to silently ask the agency. Tell the parent something warm like: "Great question! I'll ask her agency about that and get back to you. In the meantime, would you like to schedule a free consultation to speak with them directly?" The parent should NEVER know about internal data issues.

ZERO HALLUCINATION POLICY (CRITICAL - NEVER VIOLATE):
You MUST ONLY state facts that come DIRECTLY from:
- The profile data returned by MCP tools (search_surrogates, get_surrogate_profile, etc.)
- The KNOWLEDGE BASE CONTEXT provided in this system prompt
- The conversation history (what the parent told you)
If a piece of information is NOT explicitly present in any of the above sources, you MUST NOT guess, infer, or make it up. This includes:
- Names of family members (husband, partner, children names)
- Specific medical details not in the profile
- Agency processes or screening procedures
- Any claim about GoStork's policies unless from the knowledge base
- Any detail about the surrogate/donor that wasn't in the tool results

WHEN YOU DON'T HAVE THE ANSWER (MANDATORY):
When a parent asks a specific question and the answer is NOT in your available data, you MUST:
1. Say something warm like: "I don't have that detail right now, but I've just asked her agency - I'll share their answer as soon as I hear back!"
2. Include [[WHISPER:ownerProviderId]] in your response - this is what actually sends the question. Without it, nothing happens.
3. Offer alternatives inline with QUICK_REPLY buttons: [[QUICK_REPLY:Schedule a call with the agency|Show me more donors]]
4. NEVER just say "the profile doesn't disclose that" and stop there - that is unhelpful. Always whisper AND offer next steps.
5. NEVER fabricate an answer. NEVER make general claims. NEVER guess.

FORBIDDEN response pattern - NEVER do this:
"The profile does not disclose [X]. Would you like to schedule a consultation?" ← WRONG - no whisper sent, no alternatives

CORRECT response pattern:
"I don't have that detail in her profile right now, but I've just sent a message to her agency to ask! I'll get back to you as soon as they reply. In the meantime, would you like to schedule a free call with the agency or see more donor options?" [[QUICK_REPLY:Schedule a call|Show more donors]] [[WHISPER:ownerProviderId]]

Examples of questions you should WHISPER (not guess):
- "What's her mom's name?" → WHISPER (personal family detail, never in profile)
- "What's her husband's name?" → WHISPER (unless name is in profile data)
- "Does she have diabetes?" → Check profile health section first, if not there → WHISPER
- "What religion is she?" → Check profile first, if not there → WHISPER
- "How much does she charge?" → Check profile compensation data first, if not there → WHISPER

INSTEAD, ALWAYS end your message with ONE of these active next steps:
1. Offer a FREE consultation: "It's completely free - no strings attached. Want me to set that up?" [[QUICK_REPLY:Yes, schedule a free consultation|Show me more options]]
2. Show the next match: If they decline, immediately say "No problem! Let me show you another great match..." and call search tools to present ONE NEW MATCH_CARD.
3. Ask a specific question about their preferences: "What matters most to you in a surrogate - location, experience, or personality?"

If the parent says "no" to a consultation, do NOT ask open-ended follow-ups. Instead, immediately show the next matching profile. Keep the momentum going at all times.

IMPORTANT RULES:
- Ask ONE question per message. Never stack multiple questions.
- After the user answers, acknowledge with an expert touch before the next question. Add value - don't just parrot back.
- Use short, warm transitions: "Noted." "Got it." "Understood." "Perfect." "I'm on it." "Great choice."
- End every response with a single, clear question to maintain momentum.
- Never give medical or legal advice, but always validate the user's feelings.
- Keep responses concise - 2-3 sentences max before the question.
- Use line breaks (\\n) between distinct thoughts to make messages easy to scan. Never send a wall of text. ALWAYS put a blank line (\\n\\n) before your closing question so it stands out visually from the preceding text.
- Be conversational and human, not robotic or clinical.
- When summarizing what you heard, always frame it positively and confirm: "Based on that, it sounds like [X] is your top priority. Am I reading that right?"
- NEVER use cold, clinical terms like "biological plan" or "medical baseline." Instead, use warm phrases like "where you are in your journey," "your path to parenthood," or "your family-building steps."
- When transitioning from asking about embryos/eggs to asking about services, use a warm transition like: "Now that I have a clear picture of your family-building journey, let's figure out the exact support you need."
`;

    const userMessage = req.body.message || "";
    const ragProviderId = req.body.providerId || undefined;

    // Tier 2-only expensive lookups - ALREADY RUNNING since right after the
    // session load (tier2LookupsPromise kicked off ~1s of pre-work earlier);
    // Tier 1 sessions resolved instantly with empty values.
    void ragProviderId; // retained for the debug/readability of req.body.providerId above
    const [guidanceRules, answeredWhispers, knowledgeResults] = await tier2LookupsPromise;

    // PROVIDER REQUIREMENTS the provider configured in their own settings
    // (Parents Matching Requirements / Surrogate Matching Requirements /
    // Accepted Surrogate Medical History). These were only ever used inside
    // search_surrogates filtering and were never readable by Eva, so a parent
    // asking "what are their surrogate requirements?" could not be answered.
    // GoStork's own ASRM platform minimums are loaded separately and labelled
    // separately - conflating the two is exactly the attribution error we are
    // guarding against.
    let requirementsContext = "";
    try {
      const reqProviderId = (currentSession as any)?.providerId || null;
      const yesNo = (v: any) => (v === true ? "accepted" : v === false ? "not accepted" : null);
      const describe = (p: any): string[] => {
        const surrogate: string[] = [];
        if (p.ivfSurrogateMinAge != null || p.ivfSurrogateMaxAge != null) surrogate.push(`age ${p.ivfSurrogateMinAge ?? "?"}-${p.ivfSurrogateMaxAge ?? "?"}`);
        if (p.ivfSurrogateMinBmi != null || p.ivfSurrogateMaxBmi != null) surrogate.push(`BMI ${p.ivfSurrogateMinBmi ?? "?"}-${p.ivfSurrogateMaxBmi ?? "?"}`);
        if (p.ivfSurrogateMinDeliveries != null || p.ivfSurrogateMaxDeliveries != null) surrogate.push(`${p.ivfSurrogateMinDeliveries ?? "?"}-${p.ivfSurrogateMaxDeliveries ?? "?"} prior deliveries`);
        if (p.ivfSurrogateMaxCSections != null) surrogate.push(`max ${p.ivfSurrogateMaxCSections} c-sections`);
        if (p.ivfSurrogateMaxMiscarriages != null) surrogate.push(`max ${p.ivfSurrogateMaxMiscarriages} miscarriages`);
        if (p.ivfSurrogateMaxAbortions != null) surrogate.push(`max ${p.ivfSurrogateMaxAbortions} abortions`);
        if (p.ivfSurrogateMaxYearsFromLastPregnancy != null) surrogate.push(`last delivery within ${p.ivfSurrogateMaxYearsFromLastPregnancy} years`);
        if (p.ivfSurrogateMonthsPostVaginal != null) surrogate.push(`${p.ivfSurrogateMonthsPostVaginal} months since a vaginal delivery`);
        if (p.ivfSurrogateCovidVaccination === true) surrogate.push("COVID vaccination required");

        const medical: string[] = [];
        const med = (label: string, v: any) => { const s = yesNo(v); if (s) medical.push(`${label}: ${s}`); };
        med("gestational diabetes controlled by diet", p.ivfSurrogateGdDiet);
        med("gestational diabetes controlled with medication", p.ivfSurrogateGdMedication);
        med("high blood pressure", p.ivfSurrogateHighBloodPressure);
        med("placenta previa", p.ivfSurrogatePlacentaPrevia);
        med("preeclampsia in most recent pregnancy", p.ivfSurrogatePreeclampsia);
        if (p.ivfSurrogateMentalHealthHistory) medical.push(`mental health history: ${p.ivfSurrogateMentalHealthHistory}`);

        const parents: string[] = [];
        const pm = (label: string, v: any) => { const s = yesNo(v); if (s) parents.push(`${label}: ${s}`); };
        pm("twins (IVF program)", p.ivfTwinsAllowed);
        pm("gender selection", p.ivfGenderSelectionAllowed);
        pm("embryo transfer from another clinic", p.ivfTransferFromOtherClinics);
        if (p.ivfMaxAgeIp1 != null) parents.push(`max age intended parent 1: ${p.ivfMaxAgeIp1}`);
        if (p.ivfMaxAgeIp2 != null) parents.push(`max age intended parent 2: ${p.ivfMaxAgeIp2}`);
        if (p.ivfBiologicalConnection) parents.push(`biological connection: ${p.ivfBiologicalConnection}`);
        if (p.ivfAcceptingPatients === false) parents.push("not currently accepting new patients");
        if (p.surrogacyTwinsAllowed != null) { const s = yesNo(p.surrogacyTwinsAllowed); if (s) parents.push(`twins (surrogacy program): ${s}`); }

        const out: string[] = [];
        if (parents.length) out.push(`  Parents matching requirements: ${parents.join("; ")}`);
        if (surrogate.length) out.push(`  Surrogate matching requirements: ${surrogate.join("; ")}`);
        if (medical.length) out.push(`  Accepted surrogate medical history: ${medical.join("; ")}`);
        return out;
      };

      const REQ_SELECT = {
        id: true, name: true,
        ivfSurrogateMinAge: true, ivfSurrogateMaxAge: true, ivfSurrogateMinBmi: true, ivfSurrogateMaxBmi: true,
        ivfSurrogateMinDeliveries: true, ivfSurrogateMaxDeliveries: true, ivfSurrogateMaxCSections: true,
        ivfSurrogateMaxMiscarriages: true, ivfSurrogateMaxAbortions: true, ivfSurrogateMaxYearsFromLastPregnancy: true,
        ivfSurrogateMonthsPostVaginal: true, ivfSurrogateCovidVaccination: true,
        ivfSurrogateGdDiet: true, ivfSurrogateGdMedication: true, ivfSurrogateHighBloodPressure: true,
        ivfSurrogatePlacentaPrevia: true, ivfSurrogatePreeclampsia: true, ivfSurrogateMentalHealthHistory: true,
        ivfTwinsAllowed: true, ivfGenderSelectionAllowed: true, ivfTransferFromOtherClinics: true,
        ivfMaxAgeIp1: true, ivfMaxAgeIp2: true, ivfBiologicalConnection: true, ivfAcceptingPatients: true,
        surrogacyTwinsAllowed: true,
      } as const;

      const blocks: string[] = [];
      if (reqProviderId) {
        const p: any = await prisma.provider.findUnique({ where: { id: reqProviderId }, select: REQ_SELECT as any });
        if (p && !/^gostork$/i.test(p.name || "")) {
          const lines = describe(p);
          if (lines.length) {
            blocks.push(`THIS PROVIDER'S OWN REQUIREMENTS - "${p.name}" (they set these in their settings; they are ${p.name}'s rules, NOT GoStork's):\n${lines.join("\n")}`);
          }
        }
      }
      // GoStork's platform-wide ASRM minimums - the ONLY rules that may be
      // described as applying "on GoStork".
      const houseProvider: any = await prisma.provider.findFirst({
        where: { name: { equals: "GoStork", mode: "insensitive" } },
        select: REQ_SELECT as any,
      });
      if (houseProvider) {
        const lines = describe(houseProvider).filter((l) => !l.includes("Parents matching"));
        if (lines.length) {
          blocks.push(`GOSTORK PLATFORM MINIMUMS (ASRM-based - these apply to EVERY surrogate listed on GoStork regardless of agency, and are the only rules you may describe as "on GoStork"):\n${lines.join("\n")}`);
        }
      }
      if (blocks.length) {
        requirementsContext = `\n${blocks.join("\n")}
HOW TO USE THESE:
- ANSWER THE REQUIREMENTS QUESTION FIRST. If the parent asks what a provider requires or accepts, give the answer as the FIRST thing in your reply, using these EXACT configured values. Never replace it with an intake or call-prep question ("are you solo or with a partner?") - a parent who asked a direct question and got a question back reads it as being ignored. Ask your next flow question only AFTER the answer.
- NEVER INVENT A REQUIREMENT. If a specific condition or threshold is NOT in the lists above, you do not know it: do NOT answer "yes they accept it" or "no they don't". Say you don't have that specific item on file for them, and offer to confirm with the provider ([[WHISPER:<providerId>]] when you are discussing a specific provider). Guessing an acceptance criterion is a fabrication with real consequences for a family.
- A requirement listed under GOSTORK PLATFORM MINIMUMS may be cited as the platform rule even when the agency has not set their own - just be explicit about which one you are quoting.\n`;
      }
    } catch (e: any) {
      console.error("[REQUIREMENTS CONTEXT] failed:", e?.message);
    }

    // PRIOR PROVIDER ANSWERS ABOUT THIS PROFILE (cross-family reuse).
    // Repeat questions about a specific donor/surrogate ("did she have any
    // pregnancy complications?", "gestational diabetes?") are extremely common,
    // and the provider has usually answered them already for someone else.
    // Reuse the answer so this family gets it instantly instead of waiting days.
    let priorProfileAnswersContext = "";
    try {
      // Resolve the profile from the SESSION (set on marketplace deep-links and
      // 3-way threads) or, failing that, from the latest match card on screen.
      // NOTE: inquiryMatchCard is declared further down - do not reference it
      // here (TDZ); findLatestMatchCard gives the same answer independently.
      let profileIdForReuse = (currentSession as any)?.subjectProfileId || null;
      let ownerProviderIdForReuse = (currentSession as any)?.providerId || null;
      if ((!profileIdForReuse || !ownerProviderIdForReuse) && currentSessionId) {
        const mcForReuse = await findLatestMatchCard(currentSessionId).catch(() => null);
        profileIdForReuse = profileIdForReuse || mcForReuse?.providerId || null;
        ownerProviderIdForReuse = ownerProviderIdForReuse || mcForReuse?.ownerProviderId || null;
      }
      if (profileIdForReuse && ownerProviderIdForReuse) {
        const myAccountUserIds = userRecord?.parentAccountId
          ? (await prisma.user.findMany({ where: { parentAccountId: userRecord.parentAccountId }, select: { id: true } })).map((u) => u.id)
          : [userId];
        const priorAnswers = await priorAnswersForProfile(profileIdForReuse, ownerProviderIdForReuse, myAccountUserIds, 8, userMessage);
        // Agency-level answers travel across profiles; person-specific ones do not.
        const agencyAnswers = await agencyLevelAnswersForProvider(
          ownerProviderIdForReuse,
          myAccountUserIds,
          new Set(priorAnswers.map((p) => p.question.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60))),
        );
        if (priorAnswers.length > 0 || agencyAnswers.length > 0) {
          console.log(`[PRIOR ANSWERS] ${priorAnswers.length} profile-specific + ${agencyAnswers.length} agency-level reusable answer(s) for profile ${profileIdForReuse}`);
          const profileBlock = priorAnswers.length > 0
            ? `\nALREADY CONFIRMED BY THIS AGENCY ABOUT THIS PROFILE (authoritative - about this exact donor/surrogate):\n${priorAnswers.map((p) => `- Q: ${p.question}\n  A: ${p.answer}`).join("\n")}`
            : "";
          const agencyBlock = agencyAnswers.length > 0
            ? `\nALREADY CONFIRMED BY THIS AGENCY ABOUT HOW THEY WORK (authoritative - agency process/policy, true regardless of which donor or surrogate is being discussed):\n${agencyAnswers.map((p) => `- Q: ${p.question}\n  A: ${p.answer}`).join("\n")}`
            : "";
          priorProfileAnswersContext = `${profileBlock}${agencyBlock}
HOW TO USE THESE:
- If the parent asks something answered above, ANSWER IT DIRECTLY AND IMMEDIATELY from this list. Do NOT emit [[WHISPER:...]] for it and do NOT tell the parent you will check with the agency - it is already confirmed.
- Restate the answer in your own warm words. Do NOT quote it verbatim as if it just arrived, and never use the "I heard back from the agency!" framing - that is only for answers that came in for THIS family just now.
- These all came from the agency itself. NEVER say, hint, or imply that another family, client, or parent asked anything - other families must stay completely invisible. Never mention "another intended parent", "a previous client", or similar.
- The "ABOUT THIS PROFILE" facts apply ONLY to the donor/surrogate currently being discussed - never attribute them to a different person. The "HOW THEY WORK" facts are agency process and apply to any of their profiles.
- ATTRIBUTION: these are THAT AGENCY'S policies and describe ONE agency only. The stored answers are written in the AGENCY'S own voice, so they say "we"/"our" meaning the agency. You are GoStork's concierge - repeating "our screening..." verbatim makes the parent think it is GoStork's policy. ALWAYS convert to the agency: "their standard screening...", "at <agency name>...", "this agency requires...", or "the agency representing her..." if you do not have the name.
  FORBIDDEN - every one of these turns one agency's practice into a false platform-wide claim: "every surrogate on GoStork...", "for any surrogate you see on GoStork...", "all agencies on GoStork...", "agencies on GoStork typically...", "GoStork requires/screens...". Do NOT attach ANY quantifier (every / all / any / each) or the GoStork name to an agency's own policy. Other agencies genuinely work differently. Only the GOSTORK PLATFORM MINIMUMS block may be described as applying platform-wide.
- If the parent asks something NOT covered above and not in the profile data, whisper as usual.`;
        }
      }
    } catch (e: any) {
      console.error("[PRIOR ANSWERS] context build failed:", e?.message);
    }

    let answeredWhispersContext = "";
    if (answeredWhispers.length > 0) {
      const uniqueProviderIds = [...new Set(answeredWhispers.map((w: any) => w.providerId))];
      const providerNameMap = new Map<string, string>();
      await Promise.all(uniqueProviderIds.map(async (pid) => {
        try {
          const pRes = await mcpClient!.callTool({ name: "resolve_provider", arguments: { providerId: pid } });
          const pData = JSON.parse((pRes.content as any)?.[0]?.text || "{}");
          providerNameMap.set(pid, pData.name || "the agency");
        } catch { providerNameMap.set(pid, "the agency"); }
      }));
      // NEWS vs HISTORY: an ANSWERED whisper has not been delivered to this
      // family yet, so it is genuine news ("I heard back!"). A RELAYED one was
      // already delivered - re-announcing it as new is confusing and makes Eva
      // look like she is repeating herself, but it must still be available so
      // she can answer a re-asked question instead of whispering again.
      const fresh = answeredWhispers.filter((w: any) => w.status !== "RELAYED");
      const already = answeredWhispers.filter((w: any) => w.status === "RELAYED");
      const line = (w: any) =>
        `- Question about ${providerNameMap.get(w.providerId) || "the agency"}: "${w.questionText}" → Answer: "${w.answerText}"`;
      const freshBlock = fresh.length > 0
        ? `\nNEW PROVIDER WHISPER ANSWERS (just came in for THIS family - not yet shared with them):\n${fresh.map(line).join("\n")}\nWhen presenting one of these, lead with: "I have an update! I heard back from the agency and they confirmed: [Answer]."\nAfter sharing the answer, ask if the parent has any more questions: "Does that answer your question? Do you have anything else you'd like to know, or are you ready to schedule a free consultation call?"\nIf the parent wants to schedule a consultation, use [[CONSULTATION_BOOKING:PROVIDER_ID]] to present the booking card.\n`
        : "";
      const alreadyBlock = already.length > 0
        ? `\nALREADY ANSWERED FOR THIS FAMILY (the agency answered these and the parent has ALREADY been told - treat as known facts):\n${already.map(line).join("\n")}\nIf they ask any of these again, just answer directly from the facts above. Do NOT emit [[WHISPER:...]] for them, do NOT say you will check with the agency, and do NOT use the "I heard back from the agency!" framing - that is only for answers arriving now.\n`
        : "";
      answeredWhispersContext = `${freshBlock}${alreadyBlock}`;
    }

    let ragContext = "";
    const relevantResults = knowledgeResults.filter((r: any) => r.score > 0.3);
    if (relevantResults.length > 0) {
      const contextParts = relevantResults.map(
        (r: any) => `[Tier ${r.sourceTier} - ${r.sourceType}]: ${r.content}`,
      );
      ragContext = `\nKNOWLEDGE BASE CONTEXT (use this information to answer accurately):\n${contextParts.join("\n\n")}\n\nANSWER THE QUESTION FIRST: if the parent's current message asks something the context above answers, ANSWER IT DIRECTLY as the FIRST thing in your reply. Never replace that answer with an intake or call-prep question - a parent who asked a real question and got "are you solo or with a partner?" instead reads it as being ignored. Ask your next flow question only AFTER the answer, and only if it still fits.\n\nIMPORTANT: If the knowledge base has relevant information, use it confidently. If you're asked about a specific provider detail that isn't in the knowledge base or your tools, say: "I don't have that specific detail right now - let me flag this so the provider can get back to you directly." Do NOT make up information.\nNOTE: For cost, pricing, and compensation questions, ALWAYS prefer real-time data from MCP search tools over the knowledge base, as uploaded documents may contain outdated pricing.\n`;
    }

    let isDonorInquiryMode = false;
    let inquiryMatchCard: any = null;
    try {
      let latestMatchCardIdx = -1;
      let latestMc: any = null;
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        const mc = (chatHistory[i].uiCardData as any)?.matchCards?.[0];
        if (mc?.providerId && mc?.type) {
          latestMatchCardIdx = i;
          latestMc = mc;
          break;
        }
      }
      if (latestMc && latestMatchCardIdx >= 0) {
        const messagesAfterCard = chatHistory.slice(latestMatchCardIdx + 1);
        const userMsgsAfterCard = messagesAfterCard.filter((m: any) => m.role === "user");
        const assistantMsgsAfterCard = messagesAfterCard.filter((m: any) => m.role === "assistant");
        const hasIntakeFlow = assistantMsgsAfterCard.some((m: any) =>
          m.content && /frozen embryos|egg source|sperm source|who is.*carry|gestational surrogate|\[\[CURATION\]\]/i.test(m.content)
        );
        if (userMsgsAfterCard.length <= 10 && !hasIntakeFlow) {
          isDonorInquiryMode = true;
          inquiryMatchCard = latestMc;
        }
      }
    } catch (e) {
      console.error("[DONOR INQUIRY MODE] Detection error:", e);
    }

    // SERVICE-SWITCH REQUEST (deterministic): the parent free-typed a first-person
    // ask for a DIFFERENT service than the profile pinned on screen ("I am
    // interested in an egg donor" while an inquiry pin holds a Surrogate).
    // Inquiry mode REPLACES the master flow prompt entirely, so while pinned the
    // model has NO instructions for other services and historically IGNORED such
    // requests (observed live: egg-donor ask answered with the Colombia surrogacy
    // narrative). Release the pin for this turn and inject a top-priority
    // directive so the requested cycle starts immediately - which also makes the
    // FIRST streamed tokens on-topic instead of a wrong draft that gets replaced.
    let serviceSwitchDirective = "";
    // Set when the parent's request contradicts their saved profile (e.g. asks
    // for a donor while holding tested embryos). That confirm question owns the
    // turn, so the Phase 1 identity directives - which declare themselves "your
    // ONLY job right now" - must stand down, or the two fight and the reply
    // carries Phase 1's quick replies under the confirm question.
    let redundancyConfirmActive = false;
    // Same problem, different directive: on a handed-off journey a new-lane
    // request must get the why-question, which also needs its own quick
    // replies. Phase 1 has to stand down for that turn too.
    let handoffWhyQuestionActive = false;
    try {
      const svcSwitchMatch = userMessage.match(
        // "thinking about" / "considering" / "exploring" are how parents most
        // often raise a NEW lane ("I'm also thinking about an egg donor now") -
        // without them the request read as chit-chat and skipped both the
        // service-switch handling and the handed-off why-question.
        /(?:\b(?:i|we)\b[^.?!\n]{0,30}\b(?:interested in|need|want|would like|looking for|thinking about|considering|exploring|open to)\b|^(?:find me|show me|help me find|let'?s find|i'?d like)\b)[^.?!\n]{0,30}\b(egg\s*donors?|sperm\s*donors?|surrogates?|surrogacy|(?:(?:ivf|fertility)\s*)?clinics?)\b/i
      );
      if (svcSwitchMatch) {
        const raw = svcSwitchMatch[1].toLowerCase();
        const requestedService = raw.includes("egg") ? "Egg Donor"
          : raw.includes("sperm") ? "Sperm Donor"
          : raw.includes("clinic") ? "IVF Clinic"
          : "Surrogate";
        // NOT a switch when the parent is ANSWERING the flow's own intake
        // question about this service ("Do you need help finding an egg
        // donor?" -> quick reply "I need help finding an egg donor"). The
        // flow is already on it - injecting the directive here derails the
        // scripted step order (regressed TD-01 live: the two-dads baseline
        // questions got skipped and the ready-turn search never fired).
        const lastAiForSwitch = String([...chatHistory].reverse().find((m: any) => m.role === "assistant")?.content || "");
        const svcTerm = requestedService === "IVF Clinic" ? "(ivf\\s*clinic|fertility\\s*clinic|clinic)"
          : requestedService.toLowerCase().replace(" ", "\\s*");
        const answeringIntakeQuestion = new RegExp(`(need help finding|do you (already )?have)[^.?!]{0,40}${svcTerm}`, "i").test(lastAiForSwitch);
        // OPENING-MESSAGE GUARD: a parent whose FIRST messages ask for a
        // service they REGISTERED for is not going off-script - that IS the
        // script starting, and the state machine owns Phase 0 education +
        // Phase 1 there. Only treat it as a switch when it conflicts with an
        // inquiry pin, names a service they did NOT register for, or arrives
        // after the conversation is underway.
        const assistantTurnsSoFar = chatHistory.filter((m: any) => m.role === "assistant").length;
        const registeredSvcs: string[] = profile?.interestedServices || [];
        const requestedIsRegistered = registeredSvcs.some((s) =>
          s === requestedService || (requestedService === "IVF Clinic" && /clinic/i.test(s)));
        const openingScriptRequest = !isDonorInquiryMode && requestedIsRegistered && assistantTurnsSoFar <= 2;
        if (answeringIntakeQuestion) {
          console.log(`[SERVICE SWITCH] Skipped - "${userMessage.slice(0, 60)}" answers the flow's own ${requestedService} intake question`);
        } else if (openingScriptRequest) {
          console.log(`[SERVICE SWITCH] Skipped - opening request for registered service ${requestedService}; the scripted flow owns it`);
        } else {
        const pinnedType = (inquiryMatchCard?.type || "").toLowerCase();
        const pinnedService = pinnedType.includes("egg") ? "Egg Donor"
          : pinnedType.includes("sperm") ? "Sperm Donor"
          : pinnedType.includes("clinic") || pinnedType.includes("doctor") ? "IVF Clinic"
          : pinnedType.includes("surrog") ? "Surrogate" : "";
        if (requestedService === pinnedService && isDonorInquiryMode) {
          // SAME service as the pinned profile ("I need a surrogate" while
          // viewing a surrogate). Observed live: skipping this case left the
          // model free to continue whatever cycle it was in before (it kept
          // asking sperm-donor questions). Keep the pin - the profile on
          // screen IS what they asked for - but force engagement with the
          // request: offer to move forward with this profile or see matches.
          const pinnedName = inquiryMatchCard?.name && inquiryMatchCard.name !== inquiryMatchCard.type
            ? inquiryMatchCard.name : `the ${requestedService} profile on their screen`;
          console.log(`[SERVICE SWITCH] Parent asked for ${requestedService} while already viewing a ${pinnedService} - forcing engagement with the pinned profile`);
          serviceSwitchDirective = `PARENT SERVICE REQUEST - TOP PRIORITY: The parent's CURRENT message says they want a ${requestedService}: "${userMessage.slice(0, 140)}". They are ALREADY viewing ${pinnedName}. Do NOT ignore this message and do NOT continue any other service's intake thread (no egg donor, sperm donor, clinic, or other-topic questions this turn). Respond to THIS request: warmly confirm you can help with their ${requestedService} search and note the profile they are viewing (one sentence). THEN: if a Phase 1 identity directive above says identity is still missing, ask that identity question now; otherwise ask whether they'd like to move forward with this profile (a free consultation call) or see more ${requestedService} matches, ending with exactly [[QUICK_REPLY:Schedule a consultation|Show me more matches|I have questions first]]. These instructions are internal - never quote or echo them (never write words like "Acknowledge:" or "Noted:" as labels in your reply).`;
        } else if (requestedService !== pinnedService) {
          if (isDonorInquiryMode) {
            console.log(`[SERVICE SWITCH] Parent asked for ${requestedService} while inquiry-pinned to ${pinnedService || "an unknown type"} - releasing the pin for this turn`);
            isDonorInquiryMode = false;
            inquiryMatchCard = null;
          } else {
            console.log(`[SERVICE SWITCH] Parent asked for ${requestedService} mid-conversation - injecting top-priority directive`);
          }
          serviceSwitchDirective = `PARENT SERVICE REQUEST - TOP PRIORITY: The parent's CURRENT message asks about ${requestedService}: "${userMessage.slice(0, 140)}". NEVER ignore this request, NEVER steer the reply back to a previously shown profile, provider, or country program, and do NOT continue any other service's intake thread (no questions about other services this turn). Respond to THIS request now: open with one warm natural sentence confirming you can help with their ${requestedService} search, then continue with the correct NEXT STEP of the ${requestedService} flow - the first unanswered required question, respecting the normal question order (Phase 1 identity questions still come first if they are missing, then the ${requestedService} checklist items; one question per message) - BEFORE any search or match card. If their message also contains a question, answer it briefly first in the same reply. Mention other services only if the parent did.
CONFIRM, NEVER OVERRULE: if the parent's saved profile makes this request look unnecessary (e.g. they already have PGT-A tested embryos and now ask for an egg or sperm donor), do NOT tell them they don't need it and do NOT refuse or redirect. State what they already have in one sentence, then ASK what they need the ${requestedService} for - e.g. "You mentioned you have 45 PGT-A tested embryos ready - are you looking for an egg donor to create additional embryos, or has something changed with your plans?" Proceed with the ${requestedService} flow as soon as they confirm. The parent knows their situation better than the profile does.
These instructions are internal - never quote or echo them (never write words like "Acknowledge:" or "Noted:" as labels in your reply).`;
          // Data-driven redundancy check: the generic conditional above is not
          // enough when other scripted openers (e.g. the GoStork education
          // pitch) compete for the turn - name the exact conflict so the
          // confirm-first question deterministically leads the reply.
          // A handed-off journey outranks this directive: the parent must get
          // the why-question first (observed live - "I'm also thinking about an
          // egg donor now" post-handoff went straight into donor intake because
          // this directive is prepended above the handed-off rules).
          if (handedOffProviderNames) {
            handoffWhyQuestionActive = true;
            serviceSwitchDirective += `\nHANDED-OFF JOURNEY TAKES PRECEDENCE: this family's journey with ${handedOffProviderNames} is already signed, paid, and handed off. Before starting ANY new ${requestedService} search or intake, you MUST first ask - warmly and without judgment - what is prompting this new search, with quick replies like [[QUICK_REPLY:My match fell through|I want a second one in parallel|I'm not happy with the agency|Just exploring]]. Ask ONLY that question this turn: no profiles, no [[CURATION]], no [[MATCH_CARD]], no other intake questions. Proceed with the normal ${requestedService} flow only AFTER they answer.`;
          }
          if ((requestedService === "Egg Donor" || requestedService === "Sperm Donor") && profile?.hasEmbryos === true) {
            const embryoDesc = `${profile?.embryoCount || "several"}${profile?.embryosTested ? " PGT-A tested" : ""} embryo(s)`;
            redundancyConfirmActive = true;
            serviceSwitchDirective += `\nREDUNDANCY DETECTED - CONFIRM FIRST (this OUTRANKS the "Phase 1 identity questions come first" instruction above, and overrides any scripted opener, education pitch, or intake question this turn - identity can wait one turn, the parent's contradictory request cannot): the parent's profile shows they ALREADY have ${embryoDesc}. Your reply MUST open by warmly noting that (one sentence) and asking whether they want the ${requestedService.toLowerCase()} to create ADDITIONAL embryos or whether their plans have changed - do NOT start the ${requestedService} intake, the GoStork explanation, or any search until they answer. Never tell them they don't need it. End with exactly [[QUICK_REPLY:Yes, to create more embryos|My plans have changed|Let me explain]] - these are the ONLY quick replies for this question.`;
          }
        }
        }
      }
    } catch (e) {
      console.error("[SERVICE SWITCH] Detection error:", e);
    }

    // PROFILE CORRECTION (deterministic): "actually I'm married, not single" -
    // observed live: the correction was completely ignored and the next intake
    // question served as if nothing was said. The CONTRADICTION CONFIRMATION
    // prompt rule exists but is too weak against the intake momentum, so a
    // correction-marker + identity/biology keyword match injects it as a
    // top-priority directive for this turn.
    let correctionDirective = "";
    if (
      /\b(actually|correction|i meant|to be clear|i said|that'?s (wrong|not right|incorrect)|not true|you have (it|that) wrong)\b/i.test(userMessage) &&
      /\b(married|single|solo|partner(ed)?|wife|husband|divorced|widowed|woman|man|male|female|gay|lesbian|straight|embryos?|frozen|age|years old)\b/i.test(userMessage)
    ) {
      console.log(`[PROFILE CORRECTION] Correction detected: "${userMessage.slice(0, 80)}"`);
      correctionDirective = `PROFILE CORRECTION - TOP PRIORITY: The parent's CURRENT message corrects information about themselves: "${userMessage.slice(0, 140)}". Do NOT ignore it and do NOT ask the next intake question as if nothing was said. Follow the CONTRADICTION CONFIRMATION rule: warmly acknowledge the correction, confirm it in ONE short sentence, emit the matching [[SAVE:...]] with the corrected value(s), and only THEN continue with the next relevant question (which may change because of the correction - e.g. a married parent gets partner questions). These instructions are internal - never quote or echo them.`;
    }

    // CRISIS / GRIEF GUARD (deterministic, highest priority of all directives):
    // observed live - a parent wrote "we just found out the pregnancy failed"
    // and the reply gave one empathetic paragraph then asked a call-prep intake
    // question ("are you navigating this solo, or with a partner?"). A parent
    // reporting a loss or a medical emergency must never be run through intake,
    // sales framing, or "keep making progress" quick replies.
    let crisisDirective = "";
    const crisisPatterns = [
      /\b(miscarriage|miscarried|pregnancy (failed|loss|lost)|lost the (baby|pregnancy)|stillbirth|stillborn)\b/i,
      /\b(baby|surrogate|wife|partner|she) (is |was )?(in the )?(hospital|hospitalized|icu|emergency room|er)\b/i,
      /\b(complications?|hemorrhag|bleeding heavily|life.?threatening|critical condition)\b/i,
      /\b(passed away|died|death)\b/i,
      /\bfailed (transfer|cycle|implantation)\b/i,
      /\b(cancer|terminal|diagnosed with)\b/i,
    ];
    if (crisisPatterns.some((re) => re.test(userMessage))) {
      console.log(`[CRISIS GUARD] Crisis/grief language detected - suppressing intake and sales framing`);
      crisisDirective = `CRISIS / GRIEF - ABSOLUTE TOP PRIORITY (overrides EVERY other directive in this prompt, including call prep, intake checklists, matching, and the conversion-first mindset): The parent's message reports a loss, medical emergency, or serious diagnosis: "${userMessage.slice(0, 160)}".
YOUR ENTIRE REPLY MUST BE: (1) genuine, unhurried empathy in your own words - name what happened, do not minimize it, do not rush; (2) an offer of real human support - include [[HUMAN_NEEDED]] so a GoStork person reaches out; (3) at most ONE gentle sentence letting them know you're here whenever they're ready, and if it is a medical emergency, that their clinic/provider and medical team are the right people right now.
ABSOLUTELY FORBIDDEN in this reply: any intake or call-prep question (solo/partner, embryos, budget, preferences), any mention of matching, profiles, searches, bookings, cost, or next steps in their journey; any quick replies that push progress (never "Keep making progress", never "Solo|With a partner"). If you offer quick replies at all, they must be supportive only, e.g. [[QUICK_REPLY:I'd like to talk to someone|I just need a moment]].
Do not quote or echo these instructions.`;
    }

    // CANCEL/RESCHEDULE TRUTH (deterministic): "I need to cancel my consultation
    // call" - observed live: the model replied "I've canceled your consultation
    // call" for a parent with NO booking at all. It can never perform the
    // cancellation itself, so this injects the parent's REAL upcoming bookings
    // (or the fact there are none) and the only honest ways to respond.
    let cancelTruthDirective = "";
    try {
      // Also covers indirect asks that IMPLY cancelling/moving an existing
      // call - "I need to pause everything for a few months", "put things on
      // hold", "stop for now". Observed live: Eva answered a pause request
      // with "I can reach out to them to cancel or reschedule it for you" and
      // a "Yes, please cancel the call" quick reply - an action she cannot
      // perform, so the click would have gone nowhere.
      const cancelIntent =
        /\b(cancel|reschedule|move|postpone|change the (time|date))\b[^.?!\n]{0,50}\b(call|consultation|appointment|meeting|session)\b|\b(call|consultation|appointment|meeting)\b[^.?!\n]{0,30}\b(cancel|reschedul)/i.test(userMessage)
        || /\b(pause|put .{0,20}on hold|hold off|stop|take a break|step back)\b[^.?!\n]{0,40}\b(everything|all of (this|it)|the (process|journey)|for now|for a (few|couple)|things)\b/i.test(userMessage)
        || /\bneed to (pause|stop|halt)\b/i.test(userMessage);
      if (cancelIntent) {
        const acctIdsCancel = userRecord?.parentAccountId
          ? (await prisma.user.findMany({ where: { parentAccountId: userRecord.parentAccountId }, select: { id: true } })).map((u) => u.id)
          : [userId];
        const upcoming = await prisma.booking.findMany({
          where: { parentUserId: { in: acctIdsCancel }, status: { in: ["PENDING", "CONFIRMED"] }, scheduledAt: { gte: new Date() } },
          orderBy: { scheduledAt: "asc" },
          take: 3,
          select: { id: true, scheduledAt: true, subject: true },
        });
        if (upcoming.length === 0) {
          console.log(`[CANCEL TRUTH] Cancel/reschedule intent but NO upcoming booking - injecting honesty directive`);
          cancelTruthDirective = `CANCEL/RESCHEDULE REQUEST - SYSTEM TRUTH (overrides everything): The parent asked to cancel or reschedule a call, but they have NO upcoming booked call on file. NEVER claim you cancelled, moved, or changed anything - nothing exists to cancel. Tell them warmly that you don't see an upcoming call on their account, ask which call they mean, and offer to check with the team ([[HUMAN_NEEDED]]) if they believe one exists. You cannot perform cancellations yourself - never say you did.`;
        } else {
          const list = upcoming.map((b) => `"${b.subject || "Consultation"}" on ${b.scheduledAt.toISOString()} (bookingId: ${b.id})`).join("; ");
          console.log(`[CANCEL TRUTH] Cancel/reschedule intent with ${upcoming.length} upcoming booking(s) - injecting meeting-card directive`);
          cancelTruthDirective = `CANCEL/RESCHEDULE/PAUSE REQUEST - SYSTEM TRUTH (overrides everything): The parent asked to cancel, reschedule, or pause. Their REAL upcoming call(s): ${list}. You CANNOT cancel, reschedule, move, or pause anything yourself, and you cannot contact the provider on their behalf - NEVER claim or offer to do any of it ("I'll cancel that for you", "I can reach out to them to cancel it", or a quick reply like "Yes, please cancel the call" are all FORBIDDEN, because nothing would actually happen). Instead, include [[MEETING_CARD:<the matching bookingId from the list>]] so the call's card renders with its own cancel/reschedule controls, and tell them they can manage it right there themselves. If they want the provider notified or the whole journey paused, offer the GoStork team via [[HUMAN_NEEDED]] - that is a real handoff, not a promise you keep yourself.`;
        }
      }
    } catch (e) {
      console.error("[CANCEL TRUTH] Error:", e);
    }

    // Resolve the presented entity's display name so the inquiry prompt can pin the
    // model to THE clinic/agency on screen. Without this, "call search_clinics" reads
    // as a generic preference-ranked search and the model streams a DIFFERENT clinic
    // (observed live: parent asked about PFCLA, model searched and presented InSer).
    let inquiryEntityName: string | null =
      inquiryMatchCard?.name && inquiryMatchCard.name !== inquiryMatchCard.type ? inquiryMatchCard.name : null;
    if (isDonorInquiryMode && !inquiryEntityName && /clinic|agency|bank|doctor/i.test(inquiryMatchCard?.type || "")) {
      try {
        const p = await prisma.provider.findUnique({ where: { id: inquiryMatchCard.providerId }, select: { name: true } });
        inquiryEntityName = p?.name || null;
      } catch { /* prompt falls back to generic wording */ }
    }

    const donorInquiryPrompt = isDonorInquiryMode ? `
DONOR/SURROGATE INQUIRY MODE - CRITICAL CONTEXT:
The parent came from the marketplace and is inquiring about a SPECIFIC ${inquiryMatchCard?.type || "profile"}${inquiryEntityName ? ` - "${inquiryEntityName}"` : ""} that was already presented to them with a match card.
This is NOT a general intake conversation. Do NOT run the intake questionnaire (Steps 1-8). Do NOT ask about frozen embryos, egg source, sperm source, or carrier.

YOUR SOLE FOCUS: Answer the parent's questions about this specific ${inquiryMatchCard?.type || "profile"}${inquiryEntityName ? ` ("${inquiryEntityName}")` : ""}. Every question the parent asks ("the clinic", "they", "them") refers to THIS entity - never any other provider from earlier in the conversation.

SCOPE GUARD (OVERRIDES EVERYTHING IN THIS MODE): This mode only covers messages ABOUT the profile on screen. If the parent's message is about something else - a different service (an egg donor, sperm donor, surrogate, or clinic that is NOT this profile), a scheduling request, a general fertility question, or ANY request unrelated to this profile - do NOT redirect them back to this profile and NEVER ignore their message. Handle their actual request: answer it, start the proper intake cycle for the service they asked about, or ask whatever you need to know first. The parent's current message ALWAYS wins over this mode's restrictions.

RULES:
1. The parent is asking about a ${inquiryMatchCard?.type || "profile"} - use the correct terminology (e.g., "egg donor" not "surrogate").
2. When they ask a question, look up the profile using the appropriate MCP tool:
   - For surrogates: call get_surrogate_profile with surrogateId
   - For egg donors: call get_egg_donor_profile with donorId
   - For sperm donors: call search_sperm_donors
   - For clinics: call search_clinics with name: ${inquiryEntityName ? `"${inquiryEntityName}"` : "the presented clinic's exact name"} - NEVER a generic preference-based search (that returns a DIFFERENT clinic)
3. NEVER present a new or different [[MATCH_CARD]] in this mode - the parent is asking about the profile already on their screen. Do NOT search for alternatives unless the parent explicitly asks to see other options.
4. Answer directly from the profile data. Be warm, confident, and specific.
5. If the answer is NOT in the profile data, use [[WHISPER:${inquiryMatchCard?.ownerProviderId || ""}]] to ask the agency.
6. After answering, ask if they have more questions or want to take the next step:
   "Anything else you'd like to know about her, or would you like to schedule a free consultation?" [[QUICK_REPLY:More questions|Schedule consultation|Show me more options]]
7. If they want to schedule, use [[CONSULTATION_BOOKING:${inquiryMatchCard?.ownerProviderId || ""}]]
8. If they want to see more options, THEN you can start the intake flow to understand their preferences.
9. NEVER say "surrogate" when the profile is an "Egg Donor" and vice versa. Always use the correct type.

INTERACTIVE UI COMPONENTS (still available):
- [[QUICK_REPLY:option1|option2|option3]] for single-choice buttons
- [[WHISPER:PROVIDER_ID]] to ask the agency a question
- [[CONSULTATION_BOOKING:PROVIDER_ID]] to show the booking card
- [[SAVE:{"fieldName":"value"}]] to save preferences

${biologicalMasterLogic.split("QUESTIONS ABOUT A PRESENTED MATCH")[1] ? "QUESTIONS ABOUT A PRESENTED MATCH" + biologicalMasterLogic.split("QUESTIONS ABOUT A PRESENTED MATCH")[1] : ""}
` : "";

    // Dynamically analyze chat history to build concrete skip directives
    const allUserMessages = chatHistory.filter(m => m.role === "user").map(m => (m.content || "").toLowerCase()).join(" ") + " " + userMessage.toLowerCase();
    const skipDirectives: string[] = [];

    const mentionsEggDonor = /egg\s*donor|need.*egg|donor\s*egg/i.test(allUserMessages);
    const mentionsSurrogate = /surrogate|surrogacy|need.*surrogate/i.test(allUserMessages);
    const mentionsClinic = /ivf\s*clinic|fertility\s*clinic|need.*clinic|clinic/i.test(allUserMessages);
    const mentionsSpermDonor = /sperm\s*donor|need.*sperm/i.test(allUserMessages);
    // "Already has X" must be detected per SINGLE message. These were previously
    // tested against ALL user messages joined into one string, so ".*" matched
    // across message boundaries: "I need help finding a clinic" + a later
    // "I already have an egg donor" satisfied /clinic.*already/ and flipped
    // alreadyHasClinic=true, derailing intake into the what's-your-clinic's-name
    // branch (MW-04's chronic flake). Bounded gaps + a negation guard keep
    // "I don't have a clinic yet" from counting as having one.
    const userMsgList = chatHistory.filter(m => m.role === "user").map(m => (m.content || "").toLowerCase()).concat([userMessage.toLowerCase()]);
    const saidHas = (re: RegExp) => userMsgList.some(m => re.test(m) && !/don'?t|do not|not yet|haven'?t|need help finding/i.test(m));
    const hasEggDonor = saidHas(/have.{0,40}egg\s*donor|already.{0,40}egg\s*donor|egg\s*donor.{0,25}already/i);
    const hasSurrogate = saidHas(/have.{0,40}surrogate|already.{0,40}surrogate|surrogate.{0,25}already/i);
    const hasClinic = saidHas(/have.{0,40}clinic|already.{0,40}clinic|clinic.{0,25}already/i);
    const hasSpermDonor = saidHas(/have.{0,40}sperm\s*donor|already.{0,40}sperm/i);
    // Detect gay male from chat text OR from DB profile (gender=male + LGBTQ/Gay orientation).
    // "Solo man" + "Yes" to LGBTQ+ does not match the regex, so we must also check the DB.
    const genderLower = (userRecord?.gender || "").toLowerCase();
    // If gender not in DB yet, detect from chat when the bypass asked the gender follow-up
    // ("And are you the woman or the man in this journey?") and the user answered it.
    // This covers the gap between the bypass serving the question and the DB save completing.
    const genderFollowUpEverAsked = chatHistory.some((m: any) =>
      m.role === "assistant" && /are you the woman or the man in this journey/i.test(m.content || "")
    );
    const genderFromChat = (!genderLower && genderFollowUpEverAsked)
      ? (/\bi('?m| am) (?:a |the )?man\b/i.test(allUserMessages) ? "man"
        : /\bi('?m| am) (?:a |the )?woman\b/i.test(allUserMessages) ? "woman"
        : "")
      : "";
    // Fallback: derive gender from Phase 1 family-type phrasing when neither the DB nor
    // the gender-follow-up chat detection has landed yet. "Solo woman" and "Two moms"
    // imply female; "Solo man" and "Two dads" imply male. Mirrors the chatGender derivation
    // in IMMEDIATE PROFILE INFERENCE so isFemaleGender / isMaleGender stay consistent even
    // on the very first turn after the Phase 1 answer (before the DB save lands).
    const chatGenderFallback = !genderLower && !genderFromChat
      ? (/\bsolo woman\b|\btwo moms\b/i.test(allUserMessages) ? "woman"
        : /\bsolo man\b|\btwo dads\b/i.test(allUserMessages) ? "man"
        : "")
      : "";
    const effectiveGenderLower = genderLower || genderFromChat || chatGenderFallback;
    // Same female-first ordering as above: "female".includes("male") is true so naive substring fails.
    const isFemaleGender = /\b(female|woman|girl)\b/.test(effectiveGenderLower);
    const isMaleGender = !isFemaleGender && /\b(male|man|boy)\b/.test(effectiveGenderLower);
    const orientationLower = (userRecord?.sexualOrientation || "").toLowerCase();
    const isLesbianOrientation = orientationLower === "lesbian";
    const relationshipLower = (userRecord?.relationshipStatus || "").toLowerCase();
    // isSoloSkip: true if parent is solo/single - by relationshipStatus OR by gender containing "solo"
    // (AI sometimes saves "solo woman" in gender field without separate relationshipStatus)
    const isSoloSkip = relationshipLower === "single" || relationshipLower === "solo" || genderLower.includes("solo");
    const isGayMaleFromDB =
      isMaleGender &&
      ((userRecord?.sexualOrientation || "").toLowerCase() === "gay" ||
        profile?.isLGBTQ === true ||
        profile?.sameSexCouple === true);
    const isGayMale =
      /gay\s*(couple|man|male|men|dad|father)|two\s*dad|two\s*men|single\s*(man|male|dad|father|guy)/i.test(allUserMessages) ||
      isGayMaleFromDB;

    // Also check saved profile DB fields - these are the most reliable signal
    const profileServices: string[] = profile?.interestedServices || [];
    const registeredForEggDonor = profileServices.includes("Egg Donor");
    const registeredForSurrogate = profileServices.includes("Surrogate");
    const registeredForClinic = profileServices.includes("Fertility Clinic");
    // Biological baseline profile fields can bleed across sessions - only trust them when the
    // relevant topic was also mentioned in the current conversation's chat history.
    // Registration-form services (profileServices) are always reliable; AI-saved fields are not.
    const profileNeedsEggDonor = registeredForEggDonor || (profile?.needsEggDonor === true && mentionsEggDonor);
    const profileAlreadyHasEggDonor = profile?.needsEggDonor === false && hasEggDonor;
    const profileNeedsSurrogate = profileServices.includes("Surrogate") || (profile?.needsSurrogate === true && mentionsSurrogate);
    const profileAlreadyHasSurrogate = profile?.needsSurrogate === false && hasSurrogate;
    const profileNeedsSpermDonor = profileServices.includes("Sperm Donor") || (profile?.needsSpermDonor === true && mentionsSpermDonor);
    const profileNeedsClinic = profileServices.includes("Fertility Clinic") || (profile?.needsClinic === true && mentionsClinic);
    const profileAlreadyHasClinic = profile?.needsClinic === false && (mentionsClinic || hasClinic);

    // Combined signals (DB profile takes precedence over regex chat scan)
    const needsClinic = mentionsClinic || profileNeedsClinic;
    const alreadyHasClinic = hasClinic || profileAlreadyHasClinic;
    const needsEggDonor = mentionsEggDonor || profileNeedsEggDonor;
    const alreadyHasEggDonor = hasEggDonor || profileAlreadyHasEggDonor;
    const needsSurrogate = mentionsSurrogate || profileNeedsSurrogate;
    const alreadyHasSurrogate = hasSurrogate || profileAlreadyHasSurrogate;
    const needsSpermDonor = mentionsSpermDonor || profileNeedsSpermDonor;
    const alreadyHasSpermDonor = hasSpermDonor;

    // --- PHASE 1 ENFORCEMENT ---
    // If Phase 1 (identity/relationship) has not been collected yet and the parent needs a clinic or surrogate,
    // inject a high-priority directive so the AI asks Phase 1 BEFORE any Phase 2 question.
    const phase1GenderKnown = !!userRecord?.gender;
    const phase1RelationshipKnown = !!userRecord?.relationshipStatus;
    const phase1Needed = registeredForClinic || registeredForSurrogate || needsClinic || needsSurrogate || mentionsClinic || mentionsSurrogate;

    // Detect straight couple where we know it's a man+woman but don't yet know WHO is speaking.
    // Signals: sameSexCouple=false saved, OR chat mentions "a woman and a man" / "man and a woman" / "opposite-sex",
    // AND gender not yet saved.
    const chatMentionsStraightCouple = /\b(a woman and a man|a man and a woman|opposite.sex|straight couple|husband and (i|wife)|wife and (i|husband))\b/i.test(allUserMessages);
    const straightCoupleKnown = profile?.sameSexCouple === false || chatMentionsStraightCouple;
    const speakerGenderNeeded = straightCoupleKnown && !phase1GenderKnown;

    // A redundancy-confirm turn owns the reply outright: the parent asked for
    // something their profile contradicts, and that question needs its own
    // quick replies. Adding a Phase 1 "this is your ONLY job" directive on the
    // same turn made the two compete, and the reply intermittently carried
    // Phase 1's quick replies ("Solo | With a partner") under the confirm
    // question. Identity is asked on the very next turn instead.
    // A family already working with an agency - consultation booked, provider
    // in the thread, or an Intended Parent Form on the table - is long past
    // onboarding. Asking "are you going solo or with a partner?" at that point
    // reads as if nobody has been paying attention, and worse, it hijacks the
    // reply to whatever they actually asked (the probe on Jul 25 had Phase 1
    // tacked onto three consecutive post-consultation answers, including a
    // [[SAVE]] that guessed "partnered" from the word "we"). Identity gaps at
    // this stage belong to the provider's intake, not to Eva's opening script.
    const journeyUnderway = ipFormPending || ipFormSubmitted
      || currentSession?.status === "CONSULTATION_BOOKED"
      || currentSession?.status === "PROVIDER_CONNECTED"
      || !!(currentSession as any)?.providerJoinedAt
      || !!(currentSession as any)?.handoffCompletedAt;

    const phase1StandsDown = redundancyConfirmActive || handoffWhyQuestionActive || journeyUnderway;
    if (phase1StandsDown) {
      const why = redundancyConfirmActive ? "redundancy-confirm"
        : handoffWhyQuestionActive ? "handoff why-question"
        : "journey already underway (agency engaged / IP form on the table)";
      console.log(`[PHASE1] Suppressed this turn - ${why} owns the reply`);
    }
    if (phase1StandsDown) {
      // no Phase 1 directive this turn - it is asked on the next one
    } else if (speakerGenderNeeded && phase1Needed) {
      // We know it's a straight couple but not who is speaking - ask the follow-up before Phase 2
      skipDirectives.unshift(
        "PHASE 1 FOLLOW-UP REQUIRED - TOP PRIORITY: We know this is a man-and-woman couple but we do NOT yet know which partner is filling out this form. " +
        "Before asking ANYTHING from Phase 2 (no clinic question, no embryo question, no egg/sperm/carrier question), " +
        "you MUST ask: 'And just so I can ask the right questions - are you the woman or the man in this journey?' " +
        "[[QUICK_REPLY:I'm the woman|I'm the man]]. This is your ONLY job right now. Do not deviate. " +
        "(Sole exception: if the parent's current message asks a question or makes a request of its own, address it briefly FIRST in the same reply, then ask this.)"
      );
    } else if (!phase1GenderKnown && !phase1RelationshipKnown && phase1Needed) {
      skipDirectives.unshift(
        "PHASE 1 NOT YET DONE - TOP PRIORITY: Gender and relationship status have NOT been collected yet. " +
        "Before asking ANYTHING from Phase 2 (no clinic question, no embryo question, no egg/sperm/carrier question), " +
        "you MUST ask Phase 1 Question 1 now. Ask: 'Are you on this journey solo, or with a partner?' " +
        "[[QUICK_REPLY:Solo|With a partner|As a couple]]. This is your ONLY job right now. Do not deviate. " +
        "(Sole exception: if the parent's current message asks a question or makes a request of its own, address it briefly FIRST in the same reply, then ask this.)"
      );
    }

    // --- PHASE 2: BIOLOGICAL BASELINE SKIP DIRECTIVES ---
    // CRITICAL: Profile-based skips for biological baseline fields ONLY fire when the
    // topic was also mentioned in the CURRENT conversation. Profile data from previous
    // sessions must not silently skip Phase 2 questions in a new conversation.

    // Detect embryo possession from chat history as well as DB (chat answers may not be saved to DB yet)
    // Exclude negated statements like "No, I don't have frozen embryos yet" which contain
    // "have frozen embryo" as a substring but mean the opposite.
    const chatMentionsHavingEmbryosExplicit = /(?<!don'?t\s+)(?<!no[,.]?\s+)(?:i\s+)?(?:already\s+)?(?:have|has|got)\s+(?:\d+\s+)?(?:frozen\s+)?embryo|yes[,.]?\s+(?:my\s+)?embryo|i\s+have\s+(?:\d+\s+)?embryo/i.test(allUserMessages);
    // Contextual fallback: when the AI just asked "do you already have frozen embryos?" and
    // the user answered with a bare affirmative ("Yes, I do" - the literal QR button text),
    // count that as confirmation. Without this, the embryo state stays unknown and downstream
    // step 1a (count), step 1b (PGT-A), step 3b (sperm conflict) all silently skip - which
    // shifts every subsequent intake message into the wrong slot for the rest of the conversation.
    const chatMentionsHavingEmbryosContext = chatHistory.some((m: any, idx: number) => {
      if (m.role !== "user") return false;
      if (!/^(yes|yes,?\s*i do|yeah|yep|yup|i do|we do|sure|correct)\s*\.?$/i.test((m.content || "").trim())) return false;
      const prevAi = chatHistory.slice(0, idx).reverse().find((p: any) => p.role === "assistant");
      return !!(prevAi && /do you already have (?:any )?(?:frozen )?embryos/i.test(prevAi.content || ""));
    }) || (
      /^(yes|yes,?\s*i do|yeah|yep|yup|i do|we do|sure|correct)\s*\.?$/i.test(userMessage.trim())
      && chatHistory.some((m: any) => m.role === "assistant" && /do you already have (?:any )?(?:frozen )?embryos/i.test(m.content || ""))
    );
    const chatMentionsHavingEmbryos = chatMentionsHavingEmbryosExplicit || chatMentionsHavingEmbryosContext;
    const chatMentionsNoEmbryos = /no.*embryo|don'?t have.*embryo|not.*embryo|working to create|haven'?t.*embryo/i.test(allUserMessages);
    const chatMentionsEggSource = /partner'?s eggs|my own eggs|donor eggs|egg donor|eggs from a donor|used.*egg/i.test(allUserMessages);
    const chatMentionsSpermSource = /my own sperm|used my own|sperm donor|donor sperm|own sperm/i.test(allUserMessages);
    const chatMentionsCarrier = /carrying.*pregnancy|who.*carr|my partner.*carr|i'?ll carry|gestational surrogate/i.test(allUserMessages);
    // effectivelyHasEmbryos: true only when confirmed IN THIS conversation (not just profile)
    const effectivelyHasEmbryos = chatMentionsHavingEmbryos || (profile?.hasEmbryos === true && chatMentionsHavingEmbryos);

    // Embryos: skip only if confirmed in current conversation
    if (profile?.hasEmbryos === true && chatMentionsHavingEmbryos) {
      skipDirectives.push(`DO NOT ask about frozen embryos (Step 1) - already saved: YES, ${profile.embryoCount ?? "unknown"} embryos, PGT-A tested: ${profile.embryosTested === true ? "yes" : "unknown"}.`);
    } else if (profile?.hasEmbryos === false && chatMentionsNoEmbryos) {
      skipDirectives.push("DO NOT ask about frozen embryos (Step 1) - already saved: NO embryos.");
    } else if (chatMentionsHavingEmbryos) {
      skipDirectives.push("DO NOT ask about frozen embryos (Step 1) - parent already confirmed in this conversation they have frozen embryos.");
    } else if (needsEggDonor || (isGayMale && !chatMentionsHavingEmbryos)) {
      skipDirectives.push("DO NOT ask about frozen embryos (Step 1) - parent needs an egg donor, so they do not have embryos yet.");
    }

    // Egg source: skip only if confirmed in current conversation
    if (profile?.eggSource && chatMentionsEggSource) {
      skipDirectives.push(`DO NOT ask about egg source (Step 2) - already saved: ${profile.eggSource}.`);
    } else if (isGayMale || needsEggDonor || alreadyHasEggDonor) {
      skipDirectives.push("DO NOT ask about egg source (Step 2) - already known: using egg donor.");
    } else if (isFemaleGender && !chatMentionsEggSource) {
      // Female parent with unknown egg source - must ask Step 2 explicitly.
      // This prevents the AI from incorrectly assuming "donor eggs" for solo women who may use their own eggs.
      skipDirectives.push("DO NOT assume or infer egg source - it has not been confirmed yet. You MUST ask Step 2 (egg source question) before proceeding to Step 2a.");
    }

    // Sperm source: skip only if confirmed in current conversation
    if (profile?.spermSource && chatMentionsSpermSource) {
      skipDirectives.push(`DO NOT ask about sperm source (Step 3) - already saved: ${profile.spermSource}.`);
    } else if (isFemaleGender && isSoloSkip) {
      // Solo woman ALWAYS uses a sperm donor - no other option exists
      skipDirectives.push(
        `DO NOT ask about sperm source (Step 3) - solo woman always uses a sperm donor. ` +
        `Save silently: [[SAVE:{"spermSource":"Sperm donor"}]] and skip to the next question.`
      );
    } else if (isLesbianOrientation) {
      // Lesbian couple ALWAYS uses a sperm donor
      skipDirectives.push(
        `DO NOT ask about sperm source (Step 3) - lesbian couple always uses a sperm donor. ` +
        `Save silently: [[SAVE:{"spermSource":"Sperm donor"}]] and skip to the next question.`
      );
    }

    // Carrier: skip only if confirmed in current conversation or biologically obvious.
    // ANY male parent cannot carry - isMaleGender alone is sufficient, no LGBTQ detection needed.
    if (profile?.carrier && chatMentionsCarrier) {
      skipDirectives.push(`DO NOT ask about carrier/who will carry (Step 4) - already saved: ${profile.carrier}.`);
    } else if (isMaleGender || isGayMale || needsSurrogate || alreadyHasSurrogate) {
      skipDirectives.push(
        "FORBIDDEN: DO NOT ask 'who will carry the pregnancy' or 'who is planning to carry' or any carrier question (Step 4). " +
        "This parent is using a gestational surrogate - it is the ONLY option. NEVER offer 'Me' or 'My partner' as carrier options. " +
        "Save carrier silently as gestational surrogate: [[SAVE:{\"carrier\":\"gestational surrogate\"}]] and proceed directly to Step 4a."
      );
    }

    // Clinic: skip if already answered in DB or from chat
    if (profileNeedsClinic) {
      skipDirectives.push(
        "DO NOT ask if they need help finding a clinic or whether they already have one - already confirmed: they DO need a clinic. " +
        "When you reach Phase 3, MUST run Match Cycle A (IVF Clinic)."
      );
    } else if (profileAlreadyHasClinic) {
      skipDirectives.push(`DO NOT ask if they need help finding a clinic - already saved: they already have one${profile?.currentClinicName ? ` (${profile.currentClinicName})` : ""}. Skip Match Cycle A entirely.`);
    } else if (mentionsClinic && !hasClinic) {
      skipDirectives.push(
        "DO NOT ask if they need help finding a clinic or whether they already have one - they said they need one. " +
        "When you reach Phase 3, MUST run Match Cycle A (IVF Clinic)."
      );
    } else if (hasClinic) {
      skipDirectives.push("DO NOT ask if they need help finding a clinic - they already have one. Skip Match Cycle A entirely.");
    }

    // Egg donor help (Step 2a): skip if already answered in DB or from chat
    // IMPORTANT: When hasEmbryos=true, the parent already used an egg donor in the past.
    // Step 1c (conflict resolution) must run first to determine if they want a NEW egg donor or will use existing embryos.
    // Never pre-confirm "they DO need an egg donor" when hasEmbryos=true - that directive overrides prompt rules and causes the bug.
    // Issue 2: A MALE parent with embryos who did NOT register for egg donation never needs Step 1c or a new egg donor.
    if (isMaleGender && effectivelyHasEmbryos && !profileNeedsEggDonor) {
      // Only skip Step 1c/2a - NOT Step 2 itself. Step 2 (egg source) must still be asked
      // for a straight male because we don't know if partner eggs or donor eggs were used.
      skipDirectives.push(
        "SKIP Step 1c and Step 2a (egg donor help) ONLY. " +
        "This parent is a MALE parent with EXISTING frozen embryos who DID NOT register for egg donation. " +
        "No NEW egg donor is needed. DO NOT say 'since you'll need an egg donor'. " +
        "HOWEVER: you MUST still ask Step 2 (egg source) to find out whose eggs were used for those embryos - " +
        "partner's eggs or donor eggs? Ask: 'For those embryos, were the eggs your partner's or from a donor?' " +
        "[[QUICK_REPLY:My partner's eggs|Donor eggs]] - then proceed to Step 3 (sperm source)."
      );
    } else if (effectivelyHasEmbryos && needsEggDonor && !alreadyHasEggDonor) {
      skipDirectives.push(
        "Parent already HAS frozen embryos AND registered for egg donation. " +
        "DO NOT pre-confirm they need a new egg donor. DO NOT say 'since you'll need an egg donor'. " +
        "You MUST ask Step 1c (conflict resolution: use existing embryos, or create new ones with a fresh donor?) first. " +
        "Only after Step 1c confirms they want a new donor should you run Match Cycle B."
      );
    } else if (needsEggDonor && !alreadyHasEggDonor) {
      skipDirectives.push(
        "DO NOT ask if they need help finding an egg donor (Step 2a) - already confirmed: they DO need an egg donor. " +
        "When you reach Phase 3, MUST run Match Cycle B (Egg Donor)."
      );
    }
    if (alreadyHasEggDonor) {
      skipDirectives.push("DO NOT ask if they need help finding an egg donor (Step 2a) - already saved: they already have one. Skip Match Cycle B entirely.");
    }

    // Issue 4: Past tense enforcement when parent already has embryos
    if (effectivelyHasEmbryos) {
      skipDirectives.push(
        "TENSE RULE: This parent ALREADY HAS frozen embryos. ALL biological baseline questions about egg/sperm source " +
        "MUST use PAST TENSE. Examples: 'For those embryos, did you use your own sperm...' (NOT 'will you be using'). " +
        "NEVER use future tense for egg source, sperm source, or any question about how those embryos were created."
      );
    }

    // Surrogate help (Step 4a): skip if already answered in DB or from chat (Issue 6: strengthen)
    if (needsSurrogate && !alreadyHasSurrogate) {
      skipDirectives.push(
        "SKIP Step 4a ENTIRELY - DO NOT ask 'do you need help finding a surrogate?' under any circumstances. " +
        "The parent already confirmed they need a surrogate (from services registration or this conversation). " +
        "This question is already answered. Jump directly past Step 4a to the next step. " +
        "When matching begins, MUST run Match Cycle D (Surrogate)."
      );
    }
    if (alreadyHasSurrogate) {
      skipDirectives.push("DO NOT ask if they need help finding a surrogate (Step 4a) - already saved: they already have one. Skip Match Cycle D entirely.");
    }

    // Sperm donor help (Step 3a): skip if already answered in DB or from chat
    // CRITICAL: if the parent already HAS embryos, Step 3a is moot - the sperm was already used to create them.
    // Even if they registered for Sperm Donor service, do NOT ask "do you need help finding a sperm donor?"
    // when they already have existing embryos. This overrides profileNeedsSpermDonor.
    if (effectivelyHasEmbryos) {
      skipDirectives.push(
        "SKIP Step 3a ENTIRELY - DO NOT ask 'Do you need help finding a sperm donor?' under any circumstances. " +
        "This parent already HAS frozen embryos. The sperm was already used to CREATE those embryos. " +
        "This question is irrelevant - no new sperm donor is needed for existing embryos. " +
        "Even if they registered for Sperm Donor service, that was before intake revealed they have embryos. " +
        "Proceed directly to Step 4 (carrier / surrogate)."
      );
    } else if (needsSpermDonor && !alreadyHasSpermDonor) {
      skipDirectives.push(
        "DO NOT ask about sperm source (Step 3) or if they need help finding a sperm donor (Step 3a) - already confirmed: they DO need a sperm donor. " +
        "When you reach Phase 3, MUST run Match Cycle C (Sperm Donor)."
      );
    }
    if (alreadyHasSpermDonor) {
      skipDirectives.push("DO NOT ask about sperm source (Step 3) or if they need help finding a sperm donor (Step 3a) - already saved: they already have one. Skip Match Cycle C entirely.");
    }

    // isFirstIvf (A4): skip only if already saved - always ask for new parents regardless of egg source
    if (profile?.isFirstIvf != null) {
      skipDirectives.push(`DO NOT ask if this is their first IVF journey (A4) - already saved: ${profile.isFirstIvf ? "first time" : "done IVF before"}.`);
    }

    // Age for clinic (A1/A2): skip only if already saved - always ask age for clinic matching
    // Age affects uterine receptivity and overall IVF success rates even with donor eggs
    if (userRecord?.dateOfBirth) {
      const savedAge = Math.floor((Date.now() - new Date(userRecord.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
      skipDirectives.push(`DO NOT ask for the parent's age (A1) - already saved: ${savedAge} years old.`);
    }
    if (userRecord?.partnerAge) {
      skipDirectives.push(`DO NOT ask for the partner's age (A2) - already saved: ${userRecord.partnerAge} years old.`);
    } else if (isSoloSkip || (userRecord?.relationshipStatus || "").toLowerCase() === "single" || /\bsolo\b|\bsingle\b|\bjust me\b|\bon my own\b/i.test(allUserMessages)) {
      skipDirectives.push("DO NOT ask for the partner's age (A2) - this parent is solo/single and has no partner.");
    }

    // --- PHASE 3: MATCH CYCLE SKIP DIRECTIVES (preferences already saved) ---

    // Clinic preferences already saved (A5)
    if (profile?.clinicPriority) {
      skipDirectives.push(`DO NOT ask what matters most in a clinic (A5) - already saved: ${profile.clinicPriority}.`);
    }

    // Egg donor preferences already saved (B1)
    const hasEggDonorPrefs = profile?.donorEyeColor || profile?.donorHairColor || profile?.donorEthnicity ||
      profile?.donorHeight || profile?.donorEducation || profile?.donorPreferences || profile?.eggDonorAgeRange;
    if (hasEggDonorPrefs) {
      skipDirectives.push("DO NOT ask about egg donor preferences (B1) - already saved. Use the saved preferences from USER CONTEXT when running Match Cycle B.");
    }

    // Sperm donor preferences already saved (C1/C2)
    if (profile?.spermDonorType) {
      skipDirectives.push(`DO NOT ask about donor type preference (C2) - already saved: ${profile.spermDonorType}.`);
    }
    if (profile?.spermDonorPreferences) {
      skipDirectives.push("DO NOT ask about sperm donor preferences (C2) - already saved. Use saved preferences when running Match Cycle C.");
    }

    // D1 COUNTRY SAVE FALLBACK - Gemini sometimes ignores the prompt's mandatory
    // [[SAVE:{"surrogateCountries":"..."}]] when the parent answers the D1
    // [[MULTI_SELECT:USA|Mexico|Colombia]] question. When the SAVE is missing,
    // profile.surrogateCountries stays null, the skip directive below never
    // fires, the CURATION summary defaults to "USA" even though the parent
    // selected Mexico/Colombia, and the next turn ends up in PATH B (US
    // surrogates) instead of PATH A (international agencies). Fix it
    // server-side: if Eva's previous message asked the D1 question and the
    // parent's last message names one or more of the three supported
    // countries, save the selection BEFORE building the skip directives so
    // the rest of this request sees it.
    if (!profile?.surrogateCountries && userRecord?.parentAccountId) {
      const lastAssistantMsg = [...chatHistory].reverse().find((m: any) => m.role === "assistant")?.content || "";
      const askedD1 = /\bwhich countries are you open to\b|\[\[MULTI_SELECT:USA\|Mexico\|Colombia\]\]/i.test(lastAssistantMsg);
      // Parent's last user message in this turn lives in `messages` (the array
      // built earlier). Grab the most recent user content as the candidate
      // selection. Bounded to short messages (a country pick is rarely more
      // than ~40 chars - "USA, Mexico and Colombia" is 25) so we don't
      // accidentally regex-match country names mentioned inside long
      // narrative replies.
      const lastUserMsg = ((messages || []).filter((m: any) => m.role === "user").at(-1)?.content || "").toString();
      const shortMsg = lastUserMsg.length <= 60 ? lastUserMsg : "";
      // A short message that is PURELY a list of the three supported countries can
      // only be a D1 answer - accept it even when the last AI message asked something
      // else (out-of-order answers are when Eva needs the fallback most).
      const pureCountryList = /^\s*(usa|united states|mexico|colombia)((\s*,\s*|\s+(and|\+|&)\s+)(usa|united states|mexico|colombia))*\s*[.!]?\s*$/i.test(shortMsg);
      if ((askedD1 || pureCountryList) && shortMsg) {
        const picks: string[] = [];
        if (/\b(usa|united states|america|us\b)/i.test(shortMsg)) picks.push("USA");
        if (/\bmexico\b/i.test(shortMsg)) picks.push("Mexico");
        if (/\bcolombia\b/i.test(shortMsg)) picks.push("Colombia");
        if (picks.length > 0) {
          const value = picks.join(",");
          try {
            await prisma.intendedParentProfile.upsert({
              where: { parentAccountId: userRecord.parentAccountId },
              update: { surrogateCountries: value },
              create: { parentAccountId: userRecord.parentAccountId, surrogateCountries: value },
            });
            if ((userRecord as any).parentAccount?.intendedParentProfile) {
              (userRecord as any).parentAccount.intendedParentProfile.surrogateCountries = value;
            }
            (profile as any).surrogateCountries = value;
            console.log(`[D1 SAVE FALLBACK] Patched surrogateCountries=${value} for account ${userRecord.parentAccountId} (Eva missed the SAVE tag)`);
          } catch (e: any) {
            console.log(`[D1 SAVE FALLBACK] Failed to patch: ${e.message}`);
          }
        }
      }
    }

    // When a fallback below completes the D-set on THIS turn, this turn is the
    // MANDATORY-STOP turn (only [[CURATION]] is legal) - the search gate keys off it.
    let dSaveJustPatched = false;

    // D2/D3 SAVE FALLBACKS - same failure mode as D1 above: Gemini skips the
    // [[SAVE]] tag for the termination (D2) and twins (D3) answers, so the
    // profile's D-cycle stays incomplete forever, skip directives never fire,
    // and the deterministic search gate can't tell when the intake is done.
    // The D2 quick-reply strings ("Pro-choice surrogate"/"Pro-life surrogate")
    // are unique to that question, so they save even when the parent answers a
    // turn late (out-of-order answers are exactly when Eva loses the thread).
    if (!profile?.surrogateTermination && userRecord?.parentAccountId) {
      const lastUserMsgD = ((messages || []).filter((m: any) => m.role === "user").at(-1)?.content || "").toString().trim();
      const m2 = /^pro-?(choice|life)\s+surrogate[.!]?$/i.exec(lastUserMsgD);
      if (m2) {
        const value = m2[1].toLowerCase() === "choice" ? "Pro-choice surrogate" : "Pro-life surrogate";
        try {
          await prisma.intendedParentProfile.upsert({
            where: { parentAccountId: userRecord.parentAccountId },
            update: { surrogateTermination: value },
            create: { parentAccountId: userRecord.parentAccountId, surrogateTermination: value },
          });
          (profile as any).surrogateTermination = value;
          dSaveJustPatched = true;
          console.log(`[D2 SAVE FALLBACK] Patched surrogateTermination=${value} for account ${userRecord.parentAccountId} (Eva missed the SAVE tag)`);
        } catch (e: any) {
          console.log(`[D2 SAVE FALLBACK] Failed to patch: ${e.message}`);
        }
      }
    }
    // D3 twins: the quick replies are shared with the clinic-cycle A3 question,
    // so only treat them as the SURROGATE answer once the D-cycle is underway
    // (countries already saved) and the surrogate value is still missing.
    if (profile?.surrogateCountries && profile?.surrogateTwins == null && userRecord?.parentAccountId) {
      const lastUserMsgD = ((messages || []).filter((m: any) => m.role === "user").at(-1)?.content || "").toString().trim();
      const value = /^hoping (for|to have) twins[.!]?$/i.test(lastUserMsgD) ? "Yes"
        : /^singleton( only| pregnancy)?[.!]?$/i.test(lastUserMsgD) ? "No"
        : null;
      if (value) {
        try {
          await prisma.intendedParentProfile.upsert({
            where: { parentAccountId: userRecord.parentAccountId },
            update: { surrogateTwins: value },
            create: { parentAccountId: userRecord.parentAccountId, surrogateTwins: value },
          });
          (profile as any).surrogateTwins = value;
          dSaveJustPatched = true;
          console.log(`[D3 SAVE FALLBACK] Patched surrogateTwins=${value} for account ${userRecord.parentAccountId} (Eva missed the SAVE tag)`);
        } catch (e: any) {
          console.log(`[D3 SAVE FALLBACK] Failed to patch: ${e.message}`);
        }
      }
    }

    // C2 SAVE FALLBACK - same failure mode in the sperm-donor cycle: the parent
    // answers the Open/Anonymous/Exclusive donor-type question but Gemini skips
    // the [[SAVE]], so spermDonorType stays null and the checklist directive
    // re-asks the question forever (observed live: "Open" answered, the same
    // question re-asked the very next turn). Guarded on the AI having just
    // asked the sperm donor-type question so a bare "Open" elsewhere never
    // misfires.
    if (!profile?.spermDonorType && userRecord?.parentAccountId) {
      const lastUserMsgC = ((messages || []).filter((m: any) => m.role === "user").at(-1)?.content || "").toString().trim();
      const lastAiMsgC = ((messages || []).filter((m: any) => m.role === "assistant").at(-1)?.content || "").toString();
      const cm = /^(open|anonymous|exclusive|no preference)(\s+donor)?[.!]?$/i.exec(lastUserMsgC);
      // The Open/Anonymous/Exclusive trio identifies the C2 question itself -
      // the question text often does NOT contain the word "sperm" ("Would you
      // prefer an Open donor, an Anonymous donor, or an Exclusive donor?"), so
      // sperm context comes from the parent's services / recent history
      // instead. Requiring "sperm" in the question silently disabled this
      // fallback and spermDonorType stayed null.
      const askedC2 = /\bopen\b.{0,80}\banonymous\b|\banonymous\b.{0,80}\bexclusive\b|donor type/i.test(lastAiMsgC);
      const spermContext = (profile?.interestedServices || []).includes("Sperm Donor")
        || /sperm/i.test(lastAiMsgC)
        || /sperm/i.test((messages || []).slice(-8).map((m: any) => String(m.content || "")).join(" "));
      if (cm && askedC2 && spermContext) {
        const raw = cm[1].toLowerCase();
        const value = raw === "no preference" ? "No preference" : raw.charAt(0).toUpperCase() + raw.slice(1);
        try {
          await prisma.intendedParentProfile.upsert({
            where: { parentAccountId: userRecord.parentAccountId },
            update: { spermDonorType: value },
            create: { parentAccountId: userRecord.parentAccountId, spermDonorType: value },
          });
          (profile as any).spermDonorType = value;
          console.log(`[C2 SAVE FALLBACK] Patched spermDonorType=${value} for account ${userRecord.parentAccountId} (Eva missed the SAVE tag)`);
        } catch (e: any) {
          console.log(`[C2 SAVE FALLBACK] Failed to patch: ${e.message}`);
        }
      }
    }

    // Surrogate preferences already saved (D1/D2/D3)
    if (profile?.surrogateCountries) {
      const countries = profile.surrogateCountries;
      const hasUSA = /\busa\b|\bunited states\b/i.test(countries);
      const hasInternational = /\bmexico\b|\bcolombia\b/i.test(countries);
      let pathDirective = "";
      if (hasInternational && !hasUSA) {
        pathDirective = ` INTERNATIONAL-ONLY: parent selected ${countries} - take PATH A (search_surrogacy_agencies). DO NOT call search_surrogates (that's PATH B for US). The CURATION summary MUST say "open to surrogacy in ${countries}" (NOT USA) and end with "Shall I find you the right international agency?" - never "find your perfect surrogate matches now" (that's US-only phrasing).`;
      } else if (hasUSA && !hasInternational) {
        pathDirective = ` USA-ONLY: parent selected USA only - take PATH B (search_surrogates).`;
      } else if (hasUSA && hasInternational) {
        pathDirective = ` USA + INTERNATIONAL: parent selected ${countries} - take PATH C (US surrogates first, then international agencies).`;
      }
      skipDirectives.push(`DO NOT ask about surrogate countries (D1) - already saved: ${countries}. Skip the international education message and country question.${pathDirective}`);
    }
    if (profile?.surrogateTermination) {
      skipDirectives.push(`DO NOT ask about termination preference (D2) - already saved: ${profile.surrogateTermination}.`);
    }
    if (profile?.surrogateTwins) {
      skipDirectives.push(`DO NOT ask about twins preference (D3 / A3) - already saved: ${profile.surrogateTwins}.`);
    }

    // D0a/D0b: skip if identity/relationship already known from Phase 1 or profile.
    // "Man and a woman" answer in Phase 1 saves familyType=straight_couple but does NOT save
    // sameSexCouple, so D0b skips must also check familyType and current conversation.
    const straightCoupleFromPhase1 = profile?.familyType === "straight_couple" ||
      chatHistory.some((m: any) => m.role === "user" && /\b(man and a woman|a woman and a man|woman and a man)\b/i.test(m.content || ""));
    const sameSexCoupleFromPhase1 = profile?.familyType === "two_dads" || profile?.familyType === "two_moms" ||
      chatHistory.some((m: any) => m.role === "user" && /\b(two dads|two moms)\b/i.test(m.content || ""));
    const soloFromPhase1 = profile?.familyType === "solo_man" || profile?.familyType === "solo_woman" ||
      chatHistory.some((m: any) => m.role === "user" && /\b(solo man|solo woman)\b/i.test(m.content || ""));

    if (profile?.isLGBTQ != null) {
      skipDirectives.push(
        `DO NOT ask the LGBTQ+ identity question (Phase 1 Q2 / D0b) - already saved: isLGBTQ=${profile.isLGBTQ}. Never ask it again.`
      );
    } else if (profile?.sameSexCouple === true || sameSexCoupleFromPhase1) {
      skipDirectives.push(
        `DO NOT ask the LGBTQ+ identity question (D0b) - already known: parent is in a same-sex couple.`
      );
    } else if (profile?.sameSexCouple === false || straightCoupleFromPhase1 || chatMentionsStraightCouple) {
      skipDirectives.push(
        `DO NOT ask the LGBTQ+ identity question (D0b) / 'same-sex or straight couple' - already known: parent is in an opposite-sex (straight) couple. They already told us this in Phase 1. NEVER ask it again.`
      );
    }
    if (userRecord?.relationshipStatus || soloFromPhase1 || straightCoupleFromPhase1 || sameSexCoupleFromPhase1) {
      const status = userRecord?.relationshipStatus || (soloFromPhase1 ? "single" : "partnered");
      skipDirectives.push(`DO NOT ask D0a (solo or with partner) - already known from Phase 1: ${status}.`);
    }

    let skipRulesPreamble = skipDirectives.length > 0 ? `
MANDATORY - QUESTIONS YOU MUST NOT ASK (the parent already answered these):
${skipDirectives.map(d => "- " + d).join("\n")}
NEVER tell the parent you are skipping questions. Just move naturally to the next unanswered question as if the skipped ones never existed.
` : `
MANDATORY RULE - NEVER ASK QUESTIONS ALREADY ANSWERED:
Before asking ANY question, check if the parent already provided the answer. If yes, skip it silently and move to the next unanswered step. NEVER announce you are skipping.
`;
    // The service-switch / correction / cancel-truth directives lead the
    // dynamic block - they outrank every other steering rule for this turn
    // (both tiers read skipRulesPreamble).
    if (serviceSwitchDirective) skipRulesPreamble = `\n${serviceSwitchDirective}\n${skipRulesPreamble}`;
    if (correctionDirective) skipRulesPreamble = `\n${correctionDirective}\n${skipRulesPreamble}`;
    if (cancelTruthDirective) skipRulesPreamble = `\n${cancelTruthDirective}\n${skipRulesPreamble}`;
    // Crisis leads everything - it must outrank the service/correction/cancel
    // directives above as well as call-prep mode.
    // Handed-off status is easy to lose in a 130K prompt - lead the dynamic
    // block with it so scheduling/coordination asks route to the provider's own
    // chat instead of Eva trying to arrange things she no longer owns.
    if (handedOffProviderNames) {
      skipRulesPreamble = `\nHANDED OFF (read before answering): the family's journey with ${handedOffProviderNames} is signed, paid, and handed off. (a) Eva no longer arranges appointments, calls, or coordination in that lane - if they ask to schedule or arrange anything with ${handedOffProviderNames}, point them to their direct chat with ${handedOffProviderNames} (the provider owns the calendar and next steps now), and NEVER answer such a request with intake questions. (b) If they raise a NEW search or service - in any wording, including "I'm also thinking about...", "considering", "exploring" - ask FIRST, warmly and without judgment, what is prompting it: [[QUICK_REPLY:My match fell through|I want a second one in parallel|I'm not happy with the agency|Just exploring]]. That question is your ONLY output that turn - no intake questions, no profiles, no curation - and you continue normally once they answer.\n${skipRulesPreamble}`;
    }
    if (crisisDirective) skipRulesPreamble = `\n${crisisDirective}\n${skipRulesPreamble}`;

    // Collect all previously-presented match card provider IDs to prevent re-suggesting.
    // Also bucket the card TYPES: the ready-turn force-search guard must be per-service -
    // a clinic card shown in phase 1 must not disable forcing the surrogate search in
    // phase 2 of the same session (TD-11 chronic failure).
    const presentedProviderIds = new Set<string>();
    const presentedCardTypes = new Set<string>();
    for (const msg of chatHistory) {
      const cards = (msg as any).uiCardData?.matchCards || [];
      for (const card of cards) {
        if (card?.providerId) presentedProviderIds.add(card.providerId);
        const t = String(card?.type || "").toLowerCase();
        if (t.includes("clinic")) presentedCardTypes.add("clinic");
        else if (t.includes("egg")) presentedCardTypes.add("egg");
        else if (t.includes("sperm")) presentedCardTypes.add("sperm");
        else if (t.includes("agency") || t.includes("countryprogram")) presentedCardTypes.add("agency");
        else if (t.includes("surrogate")) presentedCardTypes.add("surrogate");
      }
    }
    const alreadyPresentedContext = presentedProviderIds.size > 0
      ? `\nALREADY PRESENTED PROFILES (NEVER suggest these again - use excludeIds parameter to filter them out):\n${JSON.stringify(Array.from(presentedProviderIds))}\nWhen calling search tools (search_surrogates, search_egg_donors, search_sperm_donors, search_clinics), ALWAYS pass the above IDs in the "excludeIds" parameter to ensure the parent sees NEW profiles they haven't seen before.\n`
      : "";

    // Split the system prompt into a STATIC prefix (cached across calls/sessions) and a
    // DYNAMIC suffix (per-request). The CACHE_BREAKPOINT marker is detected in
    // callTier2Claude which inserts cache_control on the static block only.
    // Static: persona + master logic + guidance rules + tool usage (identical across sessions)
    // Dynamic: skip rules + user profile + RAG + whispers + presented IDs (varies per request)
    const staticMasterLogic = isDonorInquiryMode ? donorInquiryPrompt : biologicalMasterLogic;
    const toolUsageSection = dbSections?.get("tool_usage") || `When you need to find surrogates, egg donors, sperm donors, or clinics, ALWAYS use the MCP database tools (search_surrogates, search_egg_donors, search_sperm_donors, search_clinics). NEVER fabricate any provider data.
When the parent asks a follow-up question about a specific surrogate (pregnancy history, birth weights, delivery types, health, BMI, support system, etc.), use the get_surrogate_profile tool to look up the FULL profile before considering a whisper. This tool returns ALL profile details.
When the parent asks a follow-up question about a specific egg donor (eye color, hair color, ethnicity, education, medical history, etc.), use the get_egg_donor_profile tool to look up the FULL profile before considering a whisper.`;

    const staticSystemPart = `${personalityBlock}

${staticMasterLogic}
${guidanceRules}
${toolUsageSection}`;

    const dynamicSystemPart = `${skipRulesPreamble}

USER CONTEXT (already collected - do NOT ask again):
${userContextBlock}
${ragContext}${requirementsContext}${priorProfileAnswersContext}${answeredWhispersContext}${alreadyPresentedContext}`;

    const systemPrompt = `${staticSystemPart}\n___CACHE_BREAKPOINT___\n${dynamicSystemPart}`;

    messages.unshift({
      role: "system",
      content: systemPrompt,
    });

    if (initialGreeting && !isDonorInquiryMode) {
      messages.splice(1, 0, {
        role: "assistant",
        content: initialGreeting,
      });
    }

    // Inject skip directives ONLY for Phase 2 baseline questions
    if (skipDirectives.length > 0) {
      messages.push({
        role: "system" as const,
        content: `These Phase 2 baseline questions have already been answered - do not ask them again:\n${skipDirectives.map(d => "- " + d).join("\n")}\nDo not mention or acknowledge skipping. Continue with the normal conversation flow.`,
      });
    }

    // -------------------------------------------------------------------------
    // SURROGATE ADVISORY - server-side enforcement for all 7 advisory triggers.
    // Fires whenever the parent's message triggers a clinical advisory topic,
    // regardless of where in the conversation we are.
    // -------------------------------------------------------------------------
    const hasSurrogateMatchCardShown = chatHistory.some((msg: any) => {
      const cards = (msg?.uiCardData as any)?.matchCards || [];
      return cards.some((c: any) => c?.type === "Surrogate");
    });

    // Helper: check if a specific advisory was already given this session
    const advisoryGiven = (marker: string) => chatHistory.some((msg: any) =>
      msg.role === "assistant" && typeof msg.content === "string" && msg.content.includes(marker)
    );

    const umLower = userMessage.toLowerCase();
    const surrogateAdvisories: string[] = [];

    // Look-alike face search is resemblance-first and explicitly requested by the
    // parent - don't let the clinical advisories (age/BMI/etc.) hijack the turn
    // and suppress the resemblance result. Eligibility can be raised afterward.
    const isLookAlikeTurn = !!(currentSession?.lastUploadedPhotoUrl)
      && /look(s|ed|ing)?\s+like|resembl|similar\s+to|like\s+(me|this|that|the\s+(photo|picture|image|attach))/i.test(userMessage);

    if (needsSurrogate && !isLookAlikeTurn) {
      // --- 1. AGE: maxAge < 36 ---
      const ageMaxMatch = userMessage.match(
        /(?:not\s+older\s+than|no\s+older\s+than|young\w*\s+than|under\s+(?:age\s+)?|at\s+most\s+(?:age\s+)?|max(?:imum)?\s*(?:age\s*)?|no\s+more\s+than\s+|below\s+(?:age\s+)?|less\s+than\s+(?:age\s+)?|age(?:d)?\s+(?:of\s+)?)(\d+)/i
      ) || (userMessage.match(/\b(2\d|3[0-5])\b/) ? userMessage.match(/\b(2\d|3[0-5])\b/) : null);
      const requestedMaxAge = ageMaxMatch ? parseInt(ageMaxMatch[1]) : null;
      if (requestedMaxAge !== null && requestedMaxAge < 36 && !advisoryGiven("clinics approve surrogates between ages 20 and 38")) {
        surrogateAdvisories.push(`AGE ADVISORY: The parent wants a surrogate not older than ${requestedMaxAge}.
Tell them: "I completely understand wanting a younger surrogate! Just so you know, clinics approve surrogates between ages 20 and 38 - surrogates aged ${requestedMaxAge + 1} to 38 are fully clinic-eligible and often more experienced. Limiting to ${requestedMaxAge} may significantly reduce your options. Would you like me to search up to 38, or would you prefer to stick with ${requestedMaxAge}?" [[QUICK_REPLY:Search up to 38|Stick with ${requestedMaxAge}]]`);
      }

      // --- 2. BMI ---
      const bmiMatch = userMessage.match(/bmi\s*(?:of\s*|under\s*|below\s*|less\s+than\s*|max(?:imum)?\s*)?(\d+(?:\.\d+)?)/i)
        || userMessage.match(/(?:bmi|body\s*mass)\D{0,15}(\d+(?:\.\d+)?)/i);
      const requestedMaxBmi = bmiMatch ? parseFloat(bmiMatch[1]) : null;
      if (requestedMaxBmi !== null && !advisoryGiven("clinic maximum BMI")) {
        let bmiAdvisory = "";
        if (requestedMaxBmi >= 32) {
          bmiAdvisory = `BMI ADVISORY: The parent wants a surrogate with BMI ${requestedMaxBmi}. Remind them: "Clinics approve surrogates with a BMI under 32, so requiring BMI under ${requestedMaxBmi} would include surrogates clinics won't approve. The effective max is 31. Would you like me to search with BMI under 31?" [[QUICK_REPLY:Yes, BMI under 31|Keep my preference]]`;
        } else if (requestedMaxBmi < 30) {
          bmiAdvisory = `BMI ADVISORY: The parent wants BMI under ${requestedMaxBmi}. Suggest: "That is a strict BMI filter. A BMI under 30 keeps you well within clinic limits while significantly expanding your options. Would you like to open it up to BMI under 30?" [[QUICK_REPLY:Yes, open to BMI under 30|Keep BMI under ${requestedMaxBmi}]]`;
        }
        if (bmiAdvisory) surrogateAdvisories.push(bmiAdvisory);
      }

      // --- 3. NUMBER OF PREGNANCIES ---
      const pregnancyMatch = userMessage.match(/(?:(?:max(?:imum)?|no\s+more\s+than|less\s+than|under|fewer\s+than|at\s+most)\s+)?(\d+)\s*(?:pregnanc(?:y|ies)|times\s+pregnant)/i)
        || userMessage.match(/pregnanc(?:y|ies)\D{0,10}(\d+)/i);
      const requestedMaxPregnancies = pregnancyMatch ? parseInt(pregnancyMatch[1]) : null;
      if (requestedMaxPregnancies !== null && requestedMaxPregnancies < 4 && !advisoryGiven("clinics approve surrogates who have had up to 5 pregnancies")) {
        surrogateAdvisories.push(`PREGNANCIES ADVISORY: The parent wants no more than ${requestedMaxPregnancies} pregnancies. Tell them: "Clinics actually approve surrogates who have had up to 5 pregnancies total. Limiting to ${requestedMaxPregnancies} would significantly reduce your options. Would you like to open it up to 4 pregnancies?" [[QUICK_REPLY:Yes, up to 4 pregnancies|Keep my preference]]`);
      }

      // --- 4. C-SECTIONS ---
      const cSectionMatch = userMessage.match(/(?:more\s+than|over|above|up\s+to|accept(?:ing)?|open\s+to|ok\s+with|okay\s+with)\s+(\d+)\s*c.?section/i)
        || userMessage.match(/(\d+)\s*(?:or\s+more\s+)?c.?section/i);
      const requestedMaxCSections = cSectionMatch ? parseInt(cSectionMatch[1]) : null;
      if (requestedMaxCSections !== null && requestedMaxCSections > 2 && !advisoryGiven("clinics cap approval at a maximum of 2 c-sections")) {
        surrogateAdvisories.push(`C-SECTIONS ADVISORY: The parent mentioned accepting ${requestedMaxCSections} c-sections. Tell them: "Just so you know, clinics cap surrogate approval at a maximum of 2 c-sections. A surrogate with more than 2 would not be cleared by a clinic, so I will limit the search to surrogates with 2 or fewer c-sections."`);
      }

      // --- 5. DELIVERIES (wanting very few) ---
      const deliveryMatch = userMessage.match(/(?:(?:max(?:imum)?|no\s+more\s+than|less\s+than|under|fewer\s+than|at\s+most)\s+)?(\d+)\s*(?:successful\s+)?(?:deliver(?:y|ies)|birth(?:s)?|live\s+birth(?:s)?)/i);
      const requestedMaxDeliveries = deliveryMatch ? parseInt(deliveryMatch[1]) : null;
      if (requestedMaxDeliveries !== null && requestedMaxDeliveries < 2 && !advisoryGiven("at least one successful delivery")) {
        surrogateAdvisories.push(`DELIVERIES ADVISORY: The parent wants a surrogate with no more than ${requestedMaxDeliveries} deliveries. Tell them: "For surrogacy, clinics actually require that a surrogate has had at least one successful delivery - it proves she can carry to term. Most experienced surrogates have had 1-3 deliveries, which is a positive sign. Limiting to ${requestedMaxDeliveries} would significantly reduce your options. Would you like me to search for surrogates with 1-3 deliveries?" [[QUICK_REPLY:Yes, 1-3 deliveries|Keep my preference]]`);
      }

      // --- 6. MISCARRIAGES (wanting to exclude them) ---
      const wantsNoMiscarriages = /no\s+miscarriage|without\s+miscarriage|never\s+(?:had\s+a\s+)?miscarriage|zero\s+miscarriage|0\s+miscarriage|hasn.t.*miscarr|no\s+history\s+of\s+miscarr/i.test(umLower);
      if (wantsNoMiscarriages && !advisoryGiven("prior miscarriage followed by a successful birth is not a disqualifier")) {
        surrogateAdvisories.push(`MISCARRIAGE ADVISORY: The parent wants to exclude surrogates with miscarriages. Tell them: "I completely understand the concern! However, clinics actually allow miscarriages in a surrogate's history as long as there was a healthy pregnancy and delivery afterward. A prior miscarriage followed by a successful birth is not a disqualifier - in fact, it shows the surrogate can carry to term. Excluding them would significantly reduce your options. Would you like to keep options open?" [[QUICK_REPLY:Keep options open|Still exclude miscarriages]]`);
      }

      // --- 7. ABORTIONS (wanting to exclude them) ---
      const wantsNoAbortions = /no\s+abort(?:ion)?|without\s+abort(?:ion)?|never\s+(?:had\s+an?\s+)?abort(?:ion)?|zero\s+abort(?:ion)?|0\s+abort(?:ion)?|no\s+history\s+of\s+abort|no\s+termination|pro.life\s+surrogate\s+only/i.test(umLower);
      if (wantsNoAbortions && !advisoryGiven("termination history is a personal")) {
        surrogateAdvisories.push(`ABORTIONS ADVISORY: The parent wants to exclude surrogates with abortion or termination history. Tell them: "I understand this matters to you. In surrogacy, what is most important is whether the surrogate is willing to make termination decisions with you if medically necessary during this journey - that is what the 'pro-choice' vs 'pro-life' preference covers. A surrogate's past personal history does not affect her commitment to your preferences for this journey. Would you like me to search for pro-life surrogates - those who have indicated they would not terminate even if medically recommended?" [[QUICK_REPLY:Yes, pro-life surrogates|No, any surrogate is fine]]`);
      }

      // --- 9. AGENCY LOCATION ---
      const wantsAgencyLocation = /agency\s+(?:in|near|from|based\s+in|located\s+in)|(?:in|near|from)\s+\w+\s+agency/i.test(umLower);
      if (wantsAgencyLocation && !advisoryGiven("agency's location is not relevant to the surrogacy process")) {
        surrogateAdvisories.push(`AGENCY LOCATION ADVISORY: The parent is filtering by agency location. Tell them: "The agency's location actually does not affect your journey - what matters is where your surrogate lives, since that determines the legal jurisdiction. Agencies recruit surrogates from across the country regardless of where their office is. Filtering by agency location would unnecessarily limit your matches. Would you like me to focus on the surrogate's location instead?" [[QUICK_REPLY:Yes, focus on surrogate location|I still want a local agency]]`);
      }

      // --- 10. SURROGATE LOCATION / PROXIMITY ---
      const wantsSurrogateNearby = /surrogate\s+(?:near|close\s+to|in|from|local|nearby)|(?:near|close\s+to|local)\s+surrogate|surrogate\s+in\s+(?:my\s+)?(?:state|city|area|town)|same\s+(?:state|city|area)\s+as\s+(?:me|us)|within\s+\d+\s+(?:miles|km)/i.test(umLower);
      if (wantsSurrogateNearby && !advisoryGiven("vast majority of surrogacy journeys are remote")) {
        surrogateAdvisories.push(`SURROGATE PROXIMITY ADVISORY: The parent wants a surrogate near them. Tell them: "Great question! The good news is that most surrogacy journeys are fully remote - your surrogate does not need to live near you. You will have video calls, can join doctor appointments virtually, and when the baby is born you simply fly to wherever she is, be there for the delivery, and bring your baby home. Focusing on proximity would significantly limit your options. May I search nationwide for the best match?" [[QUICK_REPLY:Yes, search nationwide|I still prefer local]]`);
      }
    }

    if (surrogateAdvisories.length > 0) {
      console.log(`[SURROGATE ADVISORY] Injecting ${surrogateAdvisories.length} advisories: ${surrogateAdvisories.map(a => a.split('\n')[0]).join(' | ')}`);
      messages.push({
        role: "system" as const,
        content: `SURROGATE ADVISORY REQUIRED - DO NOT SEARCH OR ASK MATCHING QUESTIONS THIS TURN:
The parent's message triggers the following clinical advisory guidance. You MUST deliver this advisory now before doing anything else. Do NOT call search_surrogates. Do NOT ask D1/D2/D3 questions. Do NOT show [[MATCH_CARD]].

${surrogateAdvisories.join("\n\n")}

After the parent responds to the advisory, then continue with any unanswered matching questions and proceed normally.`,
      });
    }

    // Fresh look-alike upload: a newly uploaded photo is a NEW search. The model
    // otherwise skips profiles already shown earlier in this (single, persistent)
    // session and presents "another" - but for a new photo the parent wants the
    // BEST resemblance, even if that profile appeared before.
    // A face photo uploaded THIS turn alongside any find/resemblance/donor intent
    // is a look-alike search. Keep the intent regex broad - phrasings like "find
    // me a similar egg donor to the attached one" must count, or exclusions from
    // earlier turns drop the very profile they're searching for.
    const isFreshLookalikeUpload = !!(attachmentData?.mimeType?.startsWith?.("image/"))
      && /look|resembl|similar|\blike\b|match|\bfind\b|attach|donor|surrogate|egg|sperm/i.test(userMessage);
    if (isFreshLookalikeUpload) {
      console.log(`[LOOK-ALIKE] Fresh photo upload - directing top-match presentation`);
      messages.push({
        role: "system" as const,
        content: `LOOK-ALIKE SEARCH (new photo just uploaded): Call find_lookalike_matches for the entity type the parent asked about and present the SINGLE TOP result (the highest-resemblance match it returns) as a [[MATCH_CARD]]. This is a fresh search for the NEW photo - present the top match EVEN IF that exact profile was shown earlier in this chat. Do NOT skip it as "already shown", do NOT say "another", and do NOT pass excludeIds. Keep your blurb short and generic about the resemblance; do NOT state any specific donor ID/number in your text (the card displays it). If the parent later asks to see a different option, then you may show the next match.`,
      });
    }

    // Advisory confirmation handler: parent confirms age after the advisory
    const advisorySearchUpToMatch = userMessage.match(/^search up to\s+(\d+)$/i);
    const advisoryStickWithMatch = userMessage.match(/^stick with\s+(\d+)$/i);
    if (needsSurrogate && (advisorySearchUpToMatch || advisoryStickWithMatch)) {
      const confirmedMaxAge = advisorySearchUpToMatch
        ? parseInt(advisorySearchUpToMatch[1])
        : parseInt(advisoryStickWithMatch![1]);
      console.log(`[SURROGATE ADVISORY CONFIRMED] maxAge=${confirmedMaxAge}, matchCardShown=${hasSurrogateMatchCardShown}`);
      if (hasSurrogateMatchCardShown) {
        messages.push({
          role: "system" as const,
          content: `SURROGATE ADVISORY CONFIRMED (mid-conversation): The parent chose maxAge: ${confirmedMaxAge}.
Call search_surrogates immediately with maxAge: ${confirmedMaxAge}. Do NOT send [[CURATION]]. Do NOT ask any more questions. Show the first result as a [[MATCH_CARD]].`,
        });
      } else {
        messages.push({
          role: "system" as const,
          content: `SURROGATE ADVISORY CONFIRMED (early conversation): The parent chose maxAge: ${confirmedMaxAge}. Save this preference.
Now continue with any surrogate matching questions not yet answered: D1 (countries), D2 (termination if USA), D3 (twins). Then send [[CURATION]] and search with maxAge: ${confirmedMaxAge}.`,
        });
      }
    }

    // Inject human escalation instructions when user is requesting to talk to a human
    const humanRequestRegex = /talk to (?:a )?(?:real|human|actual) person|talk to (?:the )?gostork team|speak (?:to|with) (?:a )?human|connect me with (?:a )?(?:human|person|someone)|i want (?:a )?human|i'd like to talk to a real person/i;
    if (humanRequestRegex.test(userMessage)) {
      messages.push({
        role: "system" as const,
        content: `The parent is requesting to talk to a human. Your response MUST:\n1. Confirm the GoStork concierge team has been notified and someone will join the chat shortly.\n2. Ask what they'd like to do in the meantime and end with EXACTLY these quick replies: [[QUICK_REPLY:Keep making progress|I'll wait for the team|Schedule a video call]]\nExample: "Of course! I've notified the GoStork concierge team - someone will join our chat shortly to assist you directly. What would you like to do in the meantime?"\nDo NOT offer provider consultations here - this is about GoStork's own team.\nYou MUST include [[HUMAN_NEEDED]] in your response.`,
      });
    }

    // Parent wants to SCHEDULE a call with GoStork's own team (the
    // escalation quick reply or a free-text ask). Deterministic directive -
    // the DB prompt alone proved too weak against the older "never say
    // schedule" escalation framing in the conversation history.
    const scheduleConciergeRegex = /^schedule a video call$|(schedule|book|set up).{0,40}(video\s*)?(call|meeting).{0,40}(concierge|gostork|your team|the team|a human)|(video\s*)?call with (the )?(concierge|gostork|team|human)/i;
    if (scheduleConciergeRegex.test(userMessage.trim()) && !/(agency|clinic|provider|surrogate|donor)/i.test(userMessage)) {
      messages.push({
        role: "system" as const,
        content: `The parent wants to SCHEDULE a video call with the GoStork concierge team. You MUST reply with ONE short sentence like "Here's the concierge calendar - pick a time that works for you:" and include [[CONCIERGE_CALENDAR]]. The system embeds the GoStork concierge's booking calendar right below your message automatically. Do NOT mention a "Contact Us" page, a "Schedule a Call" button, or any other way to book - the calendar card IS the way. Also include [[HUMAN_NEEDED]] only if the team has not already been notified in this conversation.`,
      });
    }

    // When human has already been requested, respect the parent's choice to wait
    if (currentSession?.humanRequested && !humanRequestRegex.test(userMessage)) {
      const wantsToWait = /wait|no|nah|i('ll| will) wait|not now|later|just wait|prefer to wait/i.test(userMessage);
      if (wantsToWait) {
        messages.push({
          role: "system" as const,
          content: `The parent has asked to wait for the human concierge. RESPECT their choice. Say something brief and warm like "No problem! The team will be with you shortly. I'm here if you need anything in the meantime." Do NOT offer consultations, scheduling, or suggest continuing the matching process. Do NOT push or re-ask. Just be available.`,
        });
      }
    }

    // Always inject consultation naming rule
    messages.push({
      role: "system" as const,
      content: `When offering to schedule a consultation or call with a PROVIDER, you MUST always name the specific provider/clinic/agency. NEVER say vague phrases like "one of our experts" or "a professional". Always say the specific name, e.g., "Would you like to schedule a free consultation with San Diego Fertility Center?" If multiple providers were presented, name the most recently discussed one. Exception: calls with GoStork's OWN concierge team use [[CONCIERGE_CALENDAR]] and are named "the GoStork concierge team".`,
    });

    // Detect short affirmatives and "learn more" intent BEFORE show-more blocks
    // so both surrogate and egg donor blocks can guard against misinterpreting "yes".
    const shortAffirmative = /^(yes|sure|ok|absolutely|definitely|please|do it|set it up|sounds good|let.?s do it|i.?d love that|that.?d be great|go ahead|go for it)[.!,\s]*$/i.test(userMessage.trim());
    let affirmativeIsLearnMore = false;
    if (shortAffirmative && currentSessionId) {
      const lastAssistantMsgForLearnMore = [...messages].reverse().find(m => m.role === "assistant");
      if (lastAssistantMsgForLearnMore && typeof lastAssistantMsgForLearnMore.content === "string" &&
          /know more|get in touch|explore further|contact the agency|reach out|connect you|more information|interested in|tell you more|learn more|hear more/i.test(lastAssistantMsgForLearnMore.content) &&
          presentedProviderIds.size > 0) {
        affirmativeIsLearnMore = true;
        console.log(`[LEARN-MORE-INTENT] Short affirmative "${userMessage}" after "know more / get in touch" prompt`);
      }
    }

    // "Show more" enforcement: when parent asks to see more surrogates/donors after already
    // seeing a match card, force the AI to call the search tool again and use [[MATCH_CARD]].
    // Prevents the AI from listing profiles as plain text from memory.
    const isShowMoreRequest = /^(show\s+me\s+more|show\s+more|see\s+more|yes[,.]?\s*(show|let'?s\s+see\s+more|more\s+please|i'?d\s+like\s+more)|more\s+(surrogates?|donors?|options?|profiles?)|next\s+(surrogate|donor|option|profile)|another\s+(surrogate|donor|option)|let'?s\s+(see\s+more|continue)|keep\s+going|yes[.!]?\s*$)/i.test(userMessage.trim());
    if (isShowMoreRequest && !affirmativeIsLearnMore && hasSurrogateMatchCardShown && presentedProviderIds.size > 0) {
      const excludeList = JSON.stringify(Array.from(presentedProviderIds));
      messages.push({
        role: "system" as const,
        content: `SHOW MORE - MANDATORY INSTRUCTIONS:
The parent wants to see more surrogate profiles. You MUST:
1. Call search_surrogates with excludeIds: ${excludeList} to get a NEW profile they haven't seen.
2. Present EXACTLY ONE result using [[MATCH_CARD]]. Never list multiple profiles as text.
3. Do NOT describe profiles in plain text. The [[MATCH_CARD]] tag is the ONLY way to present a profile.
4. After the card, ask: "Want to see more surrogates, or are we all set?" [[QUICK_REPLY:Show me more|We're all set]]
Use the same filters from the current search (maxAge, agreesToAbortion, agreesToTwins, etc.) plus the excludeIds.`,
      });
    }

    // Egg donor equivalent of the surrogate "show more" block above.
    const hasEggDonorMatchCardShown = chatHistory.some((msg: any) => {
      const cards = (msg?.uiCardData as any)?.matchCards || [];
      return cards.some((c: any) => c?.type === "Egg Donor");
    });
    if (isShowMoreRequest && !affirmativeIsLearnMore && hasEggDonorMatchCardShown && presentedProviderIds.size > 0) {
      const excludeList = JSON.stringify(Array.from(presentedProviderIds));
      messages.push({
        role: "system" as const,
        content: `SHOW MORE EGG DONORS - MANDATORY INSTRUCTIONS:
The parent wants to see more egg donor profiles. You MUST:
1. Call search_egg_donors with excludeIds: ${excludeList} to get a NEW profile they haven't seen.
2. Present EXACTLY ONE result using [[MATCH_CARD]]. Never list multiple profiles as text.
3. Do NOT describe profiles in plain text. The [[MATCH_CARD]] tag is the ONLY way to present a profile.
4. After the card, ask: "Want to see more donors, or shall we move forward?" [[QUICK_REPLY:Show me more|Let's move forward]]
Use the same filters from the current search (eyeColor, hairColor, ethnicity, minHeightInches, maxAge, etc.) plus the excludeIds.
CRITICAL: If search_egg_donors returns results, present them with [[MATCH_CARD]]. Do NOT say "no matches found" unless the tool explicitly returns zero results after filtering out already-shown profiles.`,
      });
    }

    // PROACTIVE PROFILE INJECTION: When parent asks a question about a presented profile,
    // fetch the full profile BEFORE sending to AI so it has all data on the first try
    const looksLikeProfileQuestion = /\?|what|how|where|when|who|why|does she|does he|is she|is he|tell me|her\s+|his\s+|husband|wife|partner|name|age|weight|bmi|education|location|health|deliver|pregnan|baby|babies|height|diet|religion|charge|cost|compen|letter|hobby|pet|smoke|drink|tattoo|pierc|eye|hair|blood|ethnic|race|occupation|donat|experience|eggs|medical|family/i.test(userMessage);
    const isNotAction = !/not interested|show me another|skip|pass on|save as favorite|like .+!|❤️|favorite|yes.*schedule|schedule.*consultation|show me more|what.?s next|what happens next|what now|next step|move forward|let.?s (go|proceed|do it|move)|ready to (book|schedule|proceed)|i.?m ready|let.?s book|sign me up|^yes[.!,\s]*$|^sure[.!,\s]*$|^ok[.!,\s]*$|^absolutely[.!,\s]*$|^definitely[.!,\s]*$|^please[.!,\s]*$|^do it[.!,\s]*$|^set it up[.!,\s]*$/i.test(userMessage.trim());

    if (looksLikeProfileQuestion && isNotAction && currentSessionId && mcpClient) {
      try {
        const mc = await findLatestMatchCard(currentSessionId);
        if (mc?.providerId && mc?.type) {
          const etype = (mc.type || "").toLowerCase();
          let profileText = "";
          let profileToolName: string | null = null;
          let profileToolArgs: any = {};
          if (etype === "surrogate") {
            profileToolName = "get_surrogate_profile";
            profileToolArgs = { surrogateId: mc.providerId };
          } else if (etype === "egg donor") {
            profileToolName = "get_egg_donor_profile";
            profileToolArgs = { donorId: mc.providerId };
          }
          if (profileToolName) {
            try {
              const profileResult = await mcpClient.callTool({
                name: profileToolName,
                arguments: profileToolArgs,
              });
              profileText = (profileResult.content as any)?.[0]?.text || "";
            } catch (e) {
              console.error("[PROACTIVE PROFILE] Fetch failed, will retry:", e);
              await new Promise(r => setTimeout(r, 500));
              try {
                const retryResult = await mcpClient.callTool({
                  name: profileToolName,
                  arguments: profileToolArgs,
                });
                profileText = (retryResult.content as any)?.[0]?.text || "";
              } catch (e2) {
                console.error("[PROACTIVE PROFILE] Retry also failed:", e2);
              }
            }
          }
          if (profileText && profileText.length > 50) {
            console.log(`[PROACTIVE PROFILE] Injected full profile (${profileText.length} chars) before AI call for question: "${userMessage.slice(0, 60)}"`);

            // Server-side keyword search: extract relevant Q&A pairs from the profile
            // based on the parent's question - works regardless of profile structure
            let relevantFindings = "";
            try {
              const profileObj = JSON.parse(profileText.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
              const keywords = extractSearchKeywords(userMessage);
              if (keywords.length > 0) {
                const matches = searchProfileForKeywords(profileObj, keywords);
                if (matches.length > 0) {
                  relevantFindings = `\n\nPRE-SEARCHED RESULTS (server found these matching Q&A pairs for the parent's question "${userMessage}"):\n${matches.map((m: {key: string, value: any, path: string}) => `• [${m.path}] "${m.key}" → "${m.value}"`).join("\n")}`;
                  console.log(`[PROACTIVE PROFILE] Found ${matches.length} relevant Q&A pairs for question`);
                }
              }
            } catch (parseErr) {
              console.log(`[PROACTIVE PROFILE] Could not pre-search profile, sending full data`);
            }

            messages.push({
              role: "system",
              content: `FULL PROFILE DATA for the currently presented match.${relevantFindings}\n\nRULES:\n1. If PRE-SEARCHED RESULTS are shown above, use those to answer - they are the most relevant matches from the profile.\n2. If no pre-searched results, scan the FULL DATA below by looking at ALL keys and question labels (not section names - keys can be anywhere).\n3. If the answer is found, respond with it confidently.\n4. If the answer is truly NOT anywhere in this data, say "I'll check with her agency" and use [[WHISPER:${mc.ownerProviderId || ""}]].\n5. NEVER guess or make up information.\n\nFULL DATA:\n${profileText}`,
            });
          }
        }
      } catch (e) {
        console.error("[PROACTIVE PROFILE] Error:", e);
      }
    }

    // openAiTools already fetched in parallel above (cached)

    // Generic booking phrasing ("schedule a call", "book a consultation", "set
    // up a meeting") counts as scheduling intent UNLESS it targets the GoStork
    // team/concierge (scheduleConciergeRegex owns those, handled above) or a
    // lawyer (the deterministic lawyer flow owns those). The narrow list below
    // was built around quick-reply texts ("Yes, schedule a call") and missed
    // free-typed asks like "schedule a call" - observed live: the parent asked
    // and got a profile description instead of the calendar.
    const genericBookingAsk =
      /(schedule|book|set\s*up|arrange).{0,30}(video\s*)?(call|consult(ation)?|meeting|appointment)/i.test(userMessage) &&
      !/(concierge|gostork|your team|the team|a human|lawyer|attorney)/i.test(userMessage);
    const schedulingIntent = genericBookingAsk || /what.?s next|what happens next|what now|next step|move forward|let.?s (go|proceed|do it|move)|ready to (book|schedule|proceed)|i.?m ready|let.?s book|sign me up|yes.*schedule|schedule.*consultation|yes.*free consultation|book.*consultation|^schedule[.!]?$/i.test(userMessage.trim());
    let affirmativeIsScheduling = false;
    if (shortAffirmative && currentSessionId) {
      const lastAssistantMsg = [...messages].reverse().find(m => m.role === "assistant");
      if (lastAssistantMsg && typeof lastAssistantMsg.content === "string" &&
          /schedule|consultation|set.?that.?up|book.*call|free.*call|arrange.*that|next step/i.test(lastAssistantMsg.content)) {
        affirmativeIsScheduling = true;
      }
    }
    // Inject learn-more context (affirmativeIsLearnMore detected earlier, before show-more blocks)
    if (affirmativeIsLearnMore && currentSessionId) {
      try {
        const mc = await findLatestMatchCard(currentSessionId);
        if (mc?.providerId) {
          const profileType = (mc.type || "").toLowerCase(); // e.g. "egg donor", "surrogate"
          const profileLabel = profileType === "egg donor" ? `Egg Donor #${mc.providerId}` : profileType === "surrogate" ? `Surrogate #${mc.providerId}` : `profile #${mc.providerId}`;
          messages.push({
            role: "system" as const,
            content: `LEARN MORE INTENT DETECTED: The parent just said "${userMessage}" in response to your question about whether they want to know more or get in touch about ${profileLabel}.
DO NOT search for any new profiles. DO NOT say "no matches found."
The parent is expressing interest in the CURRENTLY SHOWN profile (${profileLabel}, agency provider ID: ${mc.ownerProviderId || "unknown"}).
Your response should:
1. Warmly acknowledge their interest in ${profileLabel}
2. Offer to connect them with the agency - e.g. "I can connect you with [agency name] so they can share more details and answer any questions you have about her!"
3. Use [[CONSULTATION_BOOKING:${mc.ownerProviderId || mc.providerId}]] if they seem ready to book, OR ask a warm follow-up like "Would you like me to set up a call with the agency to learn more?" [[QUICK_REPLY:Yes, set up a call|I have more questions first]]
4. Tag [[HOT_LEAD:${mc.ownerProviderId || mc.providerId}]] since the parent is expressing active interest`,
          });
        }
      } catch (e) {
        console.error("[LEARN-MORE-INTENT] Error finding match card:", e);
      }
    }

    const shouldTriggerScheduling = schedulingIntent || affirmativeIsScheduling;
    if (shouldTriggerScheduling && !affirmativeIsLearnMore && currentSessionId) {
      try {
        const mc = await findLatestMatchCard(currentSessionId);
        // Skip when the parent ALREADY has an upcoming call with this exact
        // provider - the CALL ALREADY BOOKED / CALL PREP directives own that
        // case (reference the existing call, never a second calendar).
        if (mc?.ownerProviderId && hasUpcomingProviderConsult && upcomingConsultProviderId === mc.ownerProviderId) {
          console.log(`[SCHEDULING-INTENT] Skipped - upcoming consult already booked with ${mc.ownerProviderId}`);
        } else if (mc?.ownerProviderId) {
          messages.push({
            role: "user",
            content: `SYSTEM OVERRIDE: The parent is signaling they want to take the next step. They are ready to schedule a consultation with the agency. Do NOT answer any more profile questions. Do NOT provide a match call prep guide - that comes later when the actual surrogate match call is arranged. Instead:
1. Warmly acknowledge their interest in the current match
2. Say something brief like: "Wonderful! Let me pull up the calendar so you can pick a time for a free consultation call with the agency - completely free, no strings attached!"
3. Include [[CONSULTATION_BOOKING:${mc.ownerProviderId}]] in your response to show the booking calendar
4. Also include [[HOT_LEAD:${mc.ownerProviderId}]] and [[SAVE:{"journeyStage":"Consultation Requested"}]]
Keep your message SHORT - the calendar widget will appear right below it.
The parent's message was: "${userMessage}"`,
          });
        }
      } catch (e) {
        console.error("[SCHEDULING-INTENT] Error finding match card:", e);
      }
    }

    // BANK PURCHASE INTENT (deterministic): "Buy vials now" / "purchase his
    // vials" must flow into the bank checkout card - observed live: the model
    // instead re-ran the search and re-presented the SAME donor card. Mirror
    // of the scheduling-intent enforcement. postBankCheckoutCard safely
    // degrades to an agency-guidance message when the donor is not at a bank,
    // so forcing the tag is always safe.
    // "order" alone is NOT purchase intent ("in order to find a donor") - it
    // only counts in explicit buying phrases.
    const bankBuyIntent = /\b(buy|purchase)\b.{0,30}\b(vials?|donors?|eggs?|lot)\b|\bvials?\b.{0,20}\b(buy|purchase)\b|\b(ready to|place (my|an|the)) order\b|complete\s+(my|the|this)?\s*checkout|^buy( vials)?( now)?[.!]?$/i.test(userMessage.trim());
    let bankBuyDonorId: string | null = null;
    if (bankBuyIntent && currentSessionId) {
      try {
        const mcBuy = await findLatestMatchCard(currentSessionId);
        if (mcBuy?.providerId && /donor/i.test(mcBuy?.type || "")) {
          bankBuyDonorId = mcBuy.providerId;
          console.log(`[BANK BUY INTENT] Purchase intent on donor ${bankBuyDonorId} - injecting checkout override`);
          messages.push({
            role: "user",
            content: `SYSTEM OVERRIDE: The parent wants to PURCHASE this bank donor's vials right now (their message: "${userMessage.slice(0, 120)}"). Do NOT search again, do NOT present another [[MATCH_CARD]], do NOT re-describe the donor, do NOT ask more questions. Reply with ONE short confirmation sentence like "Wonderful choice - here's everything you need to complete your order:" and include [[BANK_CHECKOUT:${mcBuy.providerId}]]. Nothing else.`,
          });
        }
      } catch (e) {
        console.error("[BANK BUY INTENT] Error:", e);
      }
    }

    // Phase 0 is now delivered as a pre-written template - no AI generation needed.
    // The isPhase0Init path is intentionally left as a no-op; the client no longer calls it.

    // Phase 1 trigger: Phase 0 template has been displayed, now ask the first question
    if (isPhase1Init) {
      const donorOnlyServices = ["Egg Donor", "Sperm Donor"];
      const sessionServices: string[] = profile?.interestedServices || [];
      const isDonorOnly = sessionServices.length > 0 && sessionServices.every((s: string) => donorOnlyServices.includes(s));
      const hasEggDonor = sessionServices.includes("Egg Donor");
      const hasSpermDonor = sessionServices.includes("Sperm Donor");

      if (isDonorOnly) {
        // Skip Phase 1 entirely - go straight to first match cycle question
        const firstCycle = hasEggDonor ? "B1 (egg donor preferences)" : "C1 (sperm donor preferences)";
        messages.push({
          role: "user",
          content: `SYSTEM: Phase 0 has been shown. The parent is ONLY looking for ${sessionServices.join(" and ")} - skip Phase 1 (identity/relationship question) entirely. Go straight to ${firstCycle}. Ask a single warm, open-ended question about what they are looking for in a donor. Keep it brief.`,
        });
      } else {
        messages.push({
          role: "user",
          content: `SYSTEM: The GoStork introduction (Phase 0) has already been shown to the parent as a pre-written message ending with "To help guide you toward the perfect match..." or similar. Do NOT repeat or summarize Phase 0. Your ONLY job now is to ask Phase 1 Question 1 - a single warm, natural question to start the conversation. Keep it brief.`,
        });
      }
    }

    // System trigger: consultation callback submitted - tell AI to transition to next cycle
    if (isSystemTrigger && !isPhase0Init && !isPhase1Init) {
      messages.push({
        role: "user",
        content: `SYSTEM: The parent just submitted a callback consultation request and it was confirmed. The consultation for this cycle is now complete. DO NOT mention the callback again or summarize what just happened - the confirmation message was already shown. Your ONLY job now is to immediately start the next pending match cycle from the checklist. Ask the very first question of the next cycle (ONE question only). Be warm and excited. Example: "Wonderful - your request is in! 🎉 Now let's find you the perfect egg donor. **What matters most to you in an egg donor?**" or "Now that your clinic is sorted, let's find your surrogate! **Are you going on this journey solo, or with a partner?**" - adapt to whatever the next service in the checklist is.`,
      });
    }

    // Skip tools only during early Q&A steps (before any curation/matching has happened).
    // Also enable tools when match cycle intake questions have been asked (D1 surrogate country,
    // B1 egg donor prefs, C1 sperm donor ID release, A1 clinic age) so the AI can search
    // even if it mistakenly skips the [[CURATION]] step.
    const hasEnteredMatchingPhase = messages.some(m => {
      const c = typeof m.content === "string" ? m.content : "";
      return c.includes("[[CURATION]]")
        || c === "ready"
        || c.includes("MATCH_CARD")
        || c.includes("[[CONSULTATION_BOOKING")
        || c.includes("[[MULTI_SELECT:USA|Mexico|Colombia]]")  // surrogate D1 asked
        || c.includes("Pro-choice surrogate")                  // surrogate D2 answered
        || c.includes("Pro-life surrogate");                   // surrogate D2 answered
    });
    const needsTools = hasEnteredMatchingPhase || shouldTriggerScheduling || isDonorInquiryMode;

    // Detect if the AI just asked B1/C1/C2/A5 and the user is now answering it.
    // In each case, the ONLY valid next action is [[CURATION]] - not a search, not a text list.
    // NOTE: regex must NOT match curation summary messages.
    const conversationMessages = messages.filter(m => m.role === "user" || m.role === "assistant");
    const lastAiMsg = [...conversationMessages].reverse().find(m => m.role === "assistant");
    const lastAiContent = typeof lastAiMsg?.content === "string" ? lastAiMsg.content : "";
    // Check if CURATION was already sent. Use the session's tier2Active flag as the primary signal
    // (most reliable) since [[CURATION]] tags are stripped from stored content.
    // Fall back to scanning chat history for CURATION text patterns in case tier2Active is unavailable.
    const curationAlreadySent = !!(currentSession?.tier2Active) || conversationMessages.some(
      m => m.role === "assistant" && typeof m.content === "string" && m.content.includes("[[CURATION]]")
    );
    // B1: egg donor preferences
    const justAnsweredB1 = /what matters most.*egg donor|egg donor.*preferences|specific preferences.*egg donor|qualities.*egg donor|preferences.*in an egg donor/i.test(lastAiContent);
    // C2: sperm donor type (open/anonymous/exclusive) - comes after C1 preferences
    // Pattern must match when AI ASKED the C2 question, not just mentioned donor types in a summary
    const justAnsweredC2 = /prefer.*open.*donor.*anonymous|prefer.*anonymous.*exclusive|open.*anonymous.*exclusive|would you prefer.*open|would you prefer.*anonymous|open donor.*anonymous donor|prefer an open|anonymous donor.*exclusive/i.test(lastAiContent) && /\b(open|anonymous|exclusive|no preference)\b/i.test(userMessage);
    // C1: sperm donor broad preferences (only if C2 not already asked)
    const justAnsweredC1 = !justAnsweredC2 && /what matters most.*sperm donor|sperm donor.*preferences|broad preferences.*sperm|looking for.*sperm donor|tell me.*sperm donor preferences/i.test(lastAiContent);
    // A5: clinic priorities question
    const justAnsweredA5 = /what.*most important.*choosing.*clinic|matters most.*clinic|clinic.*priorities|priority.*clinic/i.test(lastAiContent);

    if ((justAnsweredB1 || justAnsweredC1 || justAnsweredC2 || justAnsweredA5) && !curationAlreadySent) {
      const serviceName = justAnsweredB1 ? "egg donor" : (justAnsweredC1 || justAnsweredC2) ? "sperm donor" : "clinic";
      const searchTool = justAnsweredB1 ? "search_egg_donors" : (justAnsweredC1 || justAnsweredC2) ? "search_sperm_donors" : "search_clinics";
      messages.push({
        role: "system" as const,
        content: `MANDATORY NEXT ACTION - NO EXCEPTIONS:
The parent just answered a key ${serviceName} matching question. Your ONLY valid next response is a [[CURATION]] summary message.
- Do NOT call any search tools (${searchTool} or any other tool).
- Do NOT list any ${serviceName}s - not as text, not as numbers, not in any format.
- Do NOT show any [[MATCH_CARD]].
- ONLY send: a warm 1-2 sentence summary of their preferences, ending with "Ready to see your matches?" and [[CURATION]] at the very end.
Example: "Here's what I have: you're looking for a ${serviceName} with [preferences]. Shall I find your perfect matches now? [[CURATION]]"
After you send this, wait for the parent to reply. The system will then auto-send "ready" and ONLY THEN can you call ${searchTool} and show ONE [[MATCH_CARD]].`,
      });
    }

    // When the parent says "ready" (or any affirmative) after a [[CURATION]] summary, force search.
    // Also catch service-mention affirmatives like "Yes, I'm looking into surrogacy" which happen
    // when the frontend's expandQuickReply incorrectly expands "Yes, find my matches!".
    const userSaidReady = /^\s*ready\s*$/i.test(userMessage)
      || /^\s*yes,?\s+i'?m\s+ready[!.]?\s*$/i.test(userMessage)
      || /^\s*i'?m\s+ready[!.]?\s*$/i.test(userMessage)
      || /\b(yes.*find|find.*match|show.*match|let.*go|proceed|start.*search)\b/i.test(userMessage)
      || (curationAlreadySent && /^(yes|sure|ok|okay|go|let'?s|please)\b.*(?:surrogacy|surrogate|egg donor|sperm donor|clinic|ivf|looking|match)/i.test(userMessage.trim()));
    if (userSaidReady && curationAlreadySent) {
      messages.push({
        role: "system" as const,
        content: `MANDATORY ACTION - NO EXCEPTIONS:
The parent said "ready" and a [[CURATION]] summary was already sent. You MUST call the appropriate search tool RIGHT NOW:
- Call search_egg_donors if parent needs an egg donor (pass filters from their stated preferences: ethnicity, height, eye color, hair color, etc.).
- Call search_surrogates if parent needs a surrogate.
- Call search_sperm_donors if parent needs a sperm donor.
- Call search_clinics if parent needs a clinic.
Do NOT send [[CURATION]] again. Do NOT ask any more questions. Call the tool, then show ONE [[MATCH_CARD]] using a real result.`,
      });
    }

    // Final enforcement injection - always appended last so model reads it immediately before generating.
    // Rules near end of context are followed more reliably than rules buried in a long system prompt.
    messages.push({
      role: "system" as const,
      content: `ABSOLUTE OUTPUT RULES (enforced every response):
1. MATCH_CARD MANDATORY: Whenever you mention, describe, or recommend a specific donor, surrogate, or clinic - you MUST use [[MATCH_CARD:{...}]]. Plain-text-only profile descriptions (e.g., "Donor #5596 - Age 20, Brown hair...") are STRICTLY FORBIDDEN.
2. ONE PROFILE PER MESSAGE: Never list multiple profiles in one message. ONE [[MATCH_CARD]] only, then stop and wait.
3. CURATION BEFORE SEARCH: After collecting preferences (B1 for egg donors, D1-D3 for surrogates), you MUST send [[CURATION]] first. Only call search tools AFTER receiving "ready". If the parent already said "ready" and [[CURATION]] was already sent, call search tools immediately - do NOT send [[CURATION]] again.
4. NEVER FABRICATE: NEVER describe a specific clinic, donor, or surrogate from your training data. You MUST call the relevant MCP search tool first. Any clinic/donor/surrogate description without a prior tool call is FORBIDDEN.`,
    });

    // -------------------------------------------------------------------------
    // TIER ROUTING: Tier 1 (Gemini 2.5 Flash) for early turns, Tier 2 (Claude
    // Sonnet 4.6) once [[CURATION]] fires or for all tool-calling turns.
    // One-way door: tier2Active stays true for all subsequent turns.
    // -------------------------------------------------------------------------
    // Marketplace inquiry pins ALWAYS need Tier 2: answering questions about
    // the pinned profile requires MCP tools (get_surrogate_profile etc.) that
    // Tier 1 does not have - observed live: "has she ever had a c-section?" on
    // a fresh deep-link session fell to Tier 1 and got the Phase 1 intake
    // question instead of an answer.
    const useTier2 = !!(currentSession?.tier2Active) || isDonorInquiryMode;
    let finalContent = "";
    let needsRetry = false; // true when all AI tiers failed - tell client to silently retry
    let serverBypassServed = false; // true when a server-side hardcoded bypass served the response
    let lastSearchToolResults: { toolName: string; resultText: string; toolArgs?: any }[] = [];
    // Mirrors blockSurrogateSearchThisTurn (computed in the Tier2 branch) for the card
    // post-processing below: on a gate-blocked turn no surrogate card may render either -
    // otherwise the MATCH_CARD fallback manufactures one from stale tool results, the
    // "surrogate presented" bucket gets polluted, and the ready-turn force never fires.
    let surrogateCardGateActive = false;
    const tierCallStart = Date.now();

    // Extract the system prompt text (first message in messages array after unshift)
    const systemPromptForTiers = typeof messages[0]?.content === "string" ? messages[0].content : "";

    // Phase 1 completion check - needed in both Tier 1 pre-generation bypasses and
    // post-generation interceptors. Declared here (outer scope) to avoid TDZ errors.
    // MW phrasing variants: the QR button reads "Man and a woman" but free-text answers
    // commonly invert to "A woman and a man" or just "woman and a man" - match both.
    // CRITICAL: For MW (straight couple), Phase 1 is NOT complete until gender is also
    // known. The relationship answer alone leaves us unable to ask gender-specific
    // questions (egg source for male speaker vs female speaker has different QR options).
    // Without the gender gate, Step 0 (clinic) fires immediately after "A woman and a
    // man" but BEFORE the gender follow-up is asked, causing the test's gender-answer
    // message to misalign as a Step 0 answer.
    const mentionedStraightCouple = chatHistory.some((m: any) =>
      m.role === "user" && /\b(man and a woman|a woman and a man|woman and a man|straight couple)\b/i.test(m.content || ""));
    const mentionedOtherFamilyType = chatHistory.some((m: any) =>
      m.role === "user" && /\b(solo man|solo woman|two dads|two moms)\b/i.test(m.content || ""));
    const familyTypeKnown = !!(profile?.familyType) || mentionedStraightCouple || mentionedOtherFamilyType;
    // MW requires gender too - other family types have implicit/single-option gender.
    const mwGenderKnown = !mentionedStraightCouple ||
      !!(profile?.gender) ||
      /\bi('?m| am) (?:a |the )?(?:woman|man)\b/i.test(allUserMessages);
    const phase1Complete = familyTypeKnown && mwGenderKnown;

    // Phase 7A win-back: deterministic handling of the win-back quick
    // replies. The win-back message carries uiCardData.winback; when it is
    // the LAST assistant message, the parent's answer routes here - no
    // model involved. "Reschedule" re-serves the original host's booking
    // calendar; "not interested" asks the one churn-reason question; churn
    // answers are recorded (CHURN_REASON) and cool the lead for provider+admin.
    let winbackRescheduleCard: any = null;
    let winbackChurnAskPayload: any = null;
    const lastAssistantMsg = [...chatHistory].reverse().find((m: any) => m.role === "assistant");
    const wbPayload = ((lastAssistantMsg as any)?.uiCardData as any)?.winback || null;
    const churnAskPayload = ((lastAssistantMsg as any)?.uiCardData as any)?.churnAsk || null;
    if (wbPayload && !serverBypassServed) {
      const wbMsg = userMessage.trim();
      if (/reschedul/i.test(wbMsg)) {
        if (wbPayload.hostSlug) {
          winbackRescheduleCard = {
            providerId: wbPayload.providerId || null,
            providerName: wbPayload.providerName || "the provider",
            providerLogo: null,
            bookingUrl: `/book/${wbPayload.hostSlug}`,
            iframeEnabled: true,
            memberBookingSlug: wbPayload.hostSlug,
            memberName: wbPayload.hostName || null,
            memberPhoto: null,
            aiSessionId: currentSessionId || undefined,
            meetingSubtype: wbPayload.meetingSubtype || undefined,
          };
          finalContent = `Absolutely - here's ${wbPayload.hostName || wbPayload.providerName}'s calendar. Pick any time that works for you:`;
        } else if (wbPayload.providerId) {
          finalContent = `Absolutely - let's get that back on the books: [[CONSULTATION_BOOKING:${wbPayload.providerId}]]`;
        } else {
          finalContent = `Absolutely - I've flagged this to the GoStork team and they'll send you new times shortly. [[HUMAN_NEEDED]]`;
        }
        sse.sendToken(finalContent.replace(/\s*\[\[[^\]]*\]\]/g, "").trim());
        serverBypassServed = true;
        await emitJourneyEvent({ eventType: "WINBACK_RESPONSE", parentUserId: userId, providerId: wbPayload.providerId || null, sessionId: currentSessionId || null, bookingId: wbPayload.bookingId || null, actorRole: "parent", metadata: { response: "reschedule" } });
        console.log(`[winback] Parent chose reschedule (booking ${wbPayload.bookingId})`);
      } else if (/something came up|later\b|not (right )?now|need more time/i.test(wbMsg) && !/interested/i.test(wbMsg)) {
        finalContent = `Of course - no rush at all. Whenever you're ready, just tell me and I'll pull up new times with ${wbPayload.providerName || "them"}. I'm here for anything else in the meantime.`;
        sse.sendToken(finalContent);
        serverBypassServed = true;
        await emitJourneyEvent({ eventType: "WINBACK_RESPONSE", parentUserId: userId, providerId: wbPayload.providerId || null, sessionId: currentSessionId || null, bookingId: wbPayload.bookingId || null, actorRole: "parent", metadata: { response: "later" } });
      } else if (/no longer interested|not interested/i.test(wbMsg)) {
        finalContent = `Thanks for being upfront with me - that's completely fine, and I won't keep asking. If you're open to sharing, what changed? It helps us (and ${wbPayload.providerName || "the provider"}) do better. [[QUICK_REPLY:Found a match elsewhere|Costs|Not the right timing|Just exploring]]`;
        winbackChurnAskPayload = { bookingId: wbPayload.bookingId || null, providerId: wbPayload.providerId || null, providerName: wbPayload.providerName || null };
        sse.sendToken(finalContent.replace(/\s*\[\[QUICK_REPLY:[^\]]*\]\]/g, "").trim());
        serverBypassServed = true;
        await emitJourneyEvent({ eventType: "WINBACK_RESPONSE", parentUserId: userId, providerId: wbPayload.providerId || null, sessionId: currentSessionId || null, bookingId: wbPayload.bookingId || null, actorRole: "parent", metadata: { response: "not_interested" } });
      }
    } else if (churnAskPayload && !serverBypassServed) {
      const reason = /found a match elsewhere|found (someone|them|one) (else|elsewhere|outside)/i.test(userMessage) ? "found_elsewhere"
        : /^costs?[.!]?$|too expensive|price|cost/i.test(userMessage.trim()) ? "costs"
        : /not the right timing|timing/i.test(userMessage) ? "timing"
        : /just exploring|exploring/i.test(userMessage) ? "exploring"
        : null;
      if (reason) {
        const closes: Record<string, string> = {
          found_elsewhere: "I really appreciate you telling me - and congratulations on finding your path forward. If anything changes or you need a second opinion on anything at all, I'm always here.",
          costs: "That's completely understandable - this journey is a big investment. If it would help, I can look for options with different price points, or we can revisit whenever the timing is better financially.",
          timing: "Totally understood - timing matters more than anything in this journey. I'll be right here whenever you're ready to pick things back up.",
          exploring: "That's exactly what I'm here for - explore as long as you like, no pressure whatsoever. Ask me anything as questions come up.",
        };
        finalContent = closes[reason];
        sse.sendToken(finalContent);
        serverBypassServed = true;
        await emitJourneyEvent({ eventType: "CHURN_REASON", parentUserId: userId, providerId: churnAskPayload.providerId || null, sessionId: currentSessionId || null, bookingId: churnAskPayload.bookingId || null, actorRole: "parent", metadata: { reason } });
        // Cool the lead: the provider's users + GoStork admins hear why.
        try {
          const parentRow = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, firstName: true } });
          const parentName = parentRow?.firstName || parentRow?.name || "A parent";
          const reasonLabel = reason === "found_elsewhere" ? "found a match elsewhere" : reason === "costs" ? "costs" : reason === "timing" ? "timing" : "still exploring";
          const notifyIds: string[] = [];
          if (churnAskPayload.providerId) {
            const provUsers = await prisma.user.findMany({ where: { providerId: churnAskPayload.providerId }, select: { id: true } });
            notifyIds.push(...provUsers.map((u) => u.id));
          }
          const admins = await prisma.user.findMany({ where: { roles: { has: "GOSTORK_ADMIN" } }, select: { id: true } });
          notifyIds.push(...admins.map((a) => a.id));
          for (const uid of Array.from(new Set(notifyIds))) {
            await prisma.inAppNotification.create({
              data: {
                userId: uid,
                eventType: "LEAD_WENT_COLD",
                payload: { parentName, providerId: churnAskPayload.providerId, bookingId: churnAskPayload.bookingId, reason, message: `${parentName} stepped back${churnAskPayload.providerName ? ` from ${churnAskPayload.providerName}` : ""} - reason: ${reasonLabel}.` },
              },
            }).catch(() => {});
          }
        } catch (e: any) {
          console.error(`[winback] churn notify failed: ${e?.message}`);
        }
        console.log(`[winback] CHURN_REASON recorded: ${reason} (booking ${churnAskPayload.bookingId})`);
      }
    }

    // Deterministic lawyer connect - BOTH tiers. The model repeatedly
    // narrates fake "I've submitted a request, they'll reach out" text
    // instead of emitting [[LAWYER_CONNECT]] (and the whisper fallback then
    // pings the AGENCY with the lawyer ask). When the parent clearly asks to
    // be connected with a lawyer, skip the model entirely: announce the
    // connection and embed the attorney's booking calendar inline. The
    // [[LAWYER_CALENDAR]] tag is processed downstream (firm card + calendar).
    let lawyerBypassPick: Awaited<ReturnType<typeof import("./lawyer-intro-flow").pickLawyerWithBooking>> = null;
    const lawyerAskRegex = /\b(connect|introduce|match|set me up|hook me up)\b[^.?!]{0,40}\b(lawyer|attorney|legal counsel)\b|^(yes[,! ]*)?(please )?(i (want|need|would like) |get me |find me )(a |an |to (talk|speak) (to|with) (a |an )?)?(fertility )?(lawyer|attorney)\b/i;
    const lawyerDeclineRegex = /\bnot right now\b|\bno thanks?\b|\bdon'?t (want|need)\b|\bmaybe later\b|^\s*no\b/i;
    if (lawyerAskRegex.test(userMessage) && !lawyerDeclineRegex.test(userMessage)) {
      try {
        const { pickLawyerWithBooking } = await import("./lawyer-intro-flow");
        lawyerBypassPick = await pickLawyerWithBooking(userId);
        if (lawyerBypassPick) {
          const memberFirst = lawyerBypassPick.member?.name ? String(lawyerBypassPick.member.name).trim() : null;
          finalContent = memberFirst && lawyerBypassPick.member?.slug
            ? `You're in good hands - ${lawyerBypassPick.provider.name} is our vetted fertility law partner. Here's their profile, and you can schedule a call with ${memberFirst} right here: [[LAWYER_CALENDAR]]`
            : `You're in good hands - ${lawyerBypassPick.provider.name} is our vetted fertility law partner. Here's their profile: [[LAWYER_CALENDAR]]`;
          sse.sendToken(finalContent.replace(/\s*\[\[LAWYER_CALENDAR\]\]/g, "").trim());
          serverBypassServed = true;
          console.log(`[LAWYER BYPASS] Deterministic connect served (${lawyerBypassPick.provider.name}, member slug: ${lawyerBypassPick.member?.slug || "none"})`);
        } else {
          console.log("[LAWYER BYPASS] No approved Legal Services provider - falling through to the model");
        }
      } catch (e: any) {
        console.error("[LAWYER BYPASS] pick failed - falling through to the model:", e?.message);
      }
    }

    // Deterministic review update/leave bypass - BOTH tiers. The model has no
    // way to (re)surface a review card, so it free-texts a rating interrogation
    // instead. When the parent asks to update or leave a rating/review, serve a
    // short confirmation and post the review card into THIS session - which
    // also fixes prompts stranded in another Eva thread of the same account.
    let reviewCardRequest: { providerId: string; providerName: string; existing: { id: string; rating: number | null; stage: string | null } | null } | null = null;
    const reviewAskRegex = /\b(update|change|edit|revise|redo)\b[^.?!]{0,60}\b(rating|review)\b|\b(leave|write|give|add|submit)\b[^.?!]{0,60}\b(review|rating)\b/i;
    if (!serverBypassServed && !isSystemTrigger && currentSessionId && reviewAskRegex.test(userMessage)) {
      try {
        const acct = userRecord?.parentAccountId || userId;
        const myReviews = await prisma.providerReview.findMany({
          where: { parentAccountId: acct, memberId: null },
          select: { id: true, rating: true, stage: true, providerId: true, provider: { select: { name: true } } },
          orderBy: { updatedAt: "desc" },
        });
        const msgLc = userMessage.toLowerCase();
        const nameMatches = (name: string) => {
          const lc = (name || "").toLowerCase().trim();
          if (!lc) return false;
          if (msgLc.includes(lc)) return true;
          const toks = lc.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
          const hits = toks.filter((t) => msgLc.includes(t));
          return hits.some((t) => t.length >= 6) || hits.length >= 2;
        };
        let target = myReviews.find((r) => nameMatches(r.provider?.name || ""));
        if (!target && myReviews.length === 1) target = myReviews[0];
        if (target) {
          reviewCardRequest = { providerId: target.providerId, providerName: target.provider?.name || "the provider", existing: { id: target.id, rating: target.rating, stage: target.stage } };
          finalContent = `Of course! Here's your current review of ${reviewCardRequest.providerName} - tap "Update review" on the card below to change your stars or comments.`;
          sse.sendToken(finalContent);
          serverBypassServed = true;
        } else if (myReviews.length > 1) {
          const opts = myReviews.slice(0, 4).map((r) => `Update my ${r.provider?.name || "provider"} review`).join("|");
          finalContent = `Happy to! Which review would you like to update? [[QUICK_REPLY:${opts}]]`;
          sse.sendToken(finalContent.replace(/\[\[QUICK_REPLY:.*?\]\]/g, "").trim());
          serverBypassServed = true;
        } else {
          // No reviews yet: if a journey provider is review-eligible, post a fresh ask.
          const { eligibleStage } = await import("./reviews-router");
          const memberIds = userRecord?.parentAccountId
            ? (await prisma.user.findMany({ where: { parentAccountId: userRecord.parentAccountId }, select: { id: true } })).map((u) => u.id)
            : [userId];
          const journeyProviders = await prisma.aiChatSession.findMany({
            where: { userId: { in: memberIds }, providerId: { not: null } },
            select: { providerId: true, provider: { select: { name: true } } },
            distinct: ["providerId"],
          });
          const named = journeyProviders.find((s) => nameMatches(s.provider?.name || ""));
          for (const c of (named ? [named] : journeyProviders)) {
            const elig = await eligibleStage(acct, c.providerId!);
            if (elig.eligible) {
              reviewCardRequest = { providerId: c.providerId!, providerName: c.provider?.name || "the provider", existing: null };
              finalContent = `I'd love that! Here's the review card for ${reviewCardRequest.providerName} - tap the stars below to get started.`;
              sse.sendToken(finalContent);
              serverBypassServed = true;
              break;
            }
          }
          if (!serverBypassServed) console.log("[REVIEW BYPASS] No reviewable provider found - falling through to the model");
        }
        if (serverBypassServed) console.log(`[REVIEW BYPASS] Served (${reviewCardRequest ? reviewCardRequest.providerName : "which-provider picker"})`);
      } catch (e: any) {
        console.error("[REVIEW BYPASS] failed - falling through to the model:", e?.message);
      }
    }

    if (serverBypassServed && finalContent) {
      // Canned bypass reply already streamed - skip both model tiers.
    } else if (useTier2) {
      // Tier 2: Claude Sonnet 4.6 with full prompt + caching + tools
      // Force tool use when parent says "ready" after CURATION - prevents AI from fabricating match results.
      // Per-SERVICE guard: skip forcing only when cards for the service this ready refers to
      // were already shown (then "ready" may legitimately mean booking, not searching). A session
      // that finished the clinic phase and is now mid-surrogate-curation MUST still force the
      // surrogate search - the old session-global presentedProviderIds.size===0 guard let the
      // model drift to a calendar offer for a never-presented agency (TD-11 chronic failure).
      const lastAiL = lastAiContent.toLowerCase();
      // What satisfies the surrogate need depends on the parent's D1 countries:
      // international-only parents (PATH A) get AGENCY cards as their match, so an
      // agency card counts. USA or mixed parents (PATH B/C) are owed a surrogate
      // PROFILE card - a mid-intake agency card (D1 cost education gone rogue) must
      // NOT disable the ready-turn force for them.
      const dCountries = String(profile?.surrogateCountries || "");
      const internationalOnly = !!dCountries
        && !/\busa\b|\bunited states\b/i.test(dCountries)
        && /\bmexico\b|\bcolombia\b/i.test(dCountries);
      const surrogateSatisfied = presentedCardTypes.has("surrogate")
        || (internationalOnly && presentedCardTypes.has("agency"));
      const typeSatisfied = (svc: string) => svc === "surrogate" ? surrogateSatisfied : presentedCardTypes.has(svc);
      // "surroga" stem: curation summaries say "surrogacy" ("open to surrogacy in
      // USA or Colombia"), which /surrogate/ misses - that gap made pendingReadyService
      // null and silently disabled the ready-turn force. Message sniffing first, then
      // fall back to the profile's outstanding needs that have no cards yet.
      const pendingReadyService =
        /surroga|carrier|agency/.test(lastAiL) ? "surrogate" :
        /egg donor/.test(lastAiL) ? "egg" :
        /sperm donor/.test(lastAiL) ? "sperm" :
        /clinic|ivf/.test(lastAiL) ? "clinic" :
        (profile?.needsSurrogate && !surrogateSatisfied) ? "surrogate" :
        (profile?.needsEggDonor && !presentedCardTypes.has("egg")) ? "egg" : null;
      const forceToolUseForSearch = userSaidReady && curationAlreadySent && needsTools &&
        (presentedProviderIds.size === 0 ||
          (pendingReadyService != null && !typeSatisfied(pendingReadyService)));

      // DETERMINISTIC SEARCH GATE (surrogate D-cycle). The prompt's SEARCH GATE rule
      // ("no search until D-intake complete + [[CURATION]] + ready") keeps getting jumped
      // when parents answer out of order: the model searches and shows a surrogate card
      // mid-D-intake, and the later "ready" then reads as a booking confirmation instead
      // of the search trigger (TD-11 chronic). Enforce server-side: search_surrogates is
      // simply not callable this turn while the profile's D-answers are incomplete, or on
      // the turn right after the D3 (twins) question where the ONLY valid action is the
      // curation summary. Ready-turns and sessions that already presented a surrogate/
      // agency card are always exempt (those turns legitimately search or book).
      const surrogateDIncomplete = profile?.surrogateTwins == null
        || !profile?.surrogateTermination
        || !(profile?.surrogateAgeRange || profile?.surrogateCountries || profile?.surrogateExperience);
      const d3AskedLastTurn = /hoping (for|to have) twins|twins.*singleton|singleton pregnancy/i.test(lastAiL);
      const blockSurrogateSearchThisTurn = !userSaidReady
        && !surrogateSatisfied
        && (surrogateDIncomplete || d3AskedLastTurn || dSaveJustPatched);
      surrogateCardGateActive = blockSurrogateSearchThisTurn;
      const toolsForTurn = needsTools && openAiTools.length > 0
        ? (blockSurrogateSearchThisTurn
            ? openAiTools.filter((t: any) => t?.function?.name !== "search_surrogates")
            : openAiTools)
        : [];
      if (blockSurrogateSearchThisTurn && needsTools && openAiTools.length > 0) {
        console.log(`[SEARCH GATE] search_surrogates withheld this turn (dIncomplete=${surrogateDIncomplete}, d3Asked=${d3AskedLastTurn}) - D-cycle must finish before matching`);
      }

      // Ready-turn pre-search (clinic only - deterministic): after a clinic
      // curation + "ready", the search is not a model decision, it's ordered.
      // Execute it server-side with args derived from the SAME shared helpers
      // the card enrichment uses, collapsing the turn to one writing pass.
      // Donor/surrogate searches stay model-driven - mapping free-text
      // preferences to filters is the model's judgment call.
      let preSearchForReady: { name: string; args: Record<string, unknown> } | null = null;
      if (forceToolUseForSearch && /perfect clinic matches|clinic matches now|find your clinic matches/i.test(String(lastAiMsg?.content || ""))) {
        const genderL = (userRecord?.gender || "").toLowerCase();
        const isFemaleP = /\b(female|woman|girl)\b/.test(genderL) || genderL === "f";
        const isMaleP = !isFemaleP && (/\b(male|man|boy)\b/.test(genderL) || genderL === "m");
        const orientL = (userRecord?.sexualOrientation || "").toLowerCase();
        const relL = (userRecord?.relationshipStatus || "").toLowerCase();
        const eggL = (profile?.eggSource || "").toLowerCase();
        const donorEggs = (isMaleP && (orientL.includes("gay") || relL.includes("single")))
          || eggL.includes("donor")
          || (!eggL && profile?.needsEggDonor === true);
        const args: Record<string, unknown> = { eggSource: donorEggs ? "donor" : "own_eggs", limit: 10 };
        if (!donorEggs) {
          const age = deriveEggProviderAge(conversationMessages, userRecord, profile?.eggSource, isMaleP, "own_eggs");
          if (age != null) args.ageGroup = ageToAgeGroup(age);
          const isNew = deriveIsNewPatient(conversationMessages);
          if (isNew != null) args.isNewPatient = isNew;
        }
        if (userRecord?.state) args.state = userRecord.state;
        if (userRecord?.city) args.city = userRecord.city;
        if (presentedProviderIds.size > 0) args.excludeIds = Array.from(presentedProviderIds);
        preSearchForReady = { name: "search_clinics", args };
      }

      console.log(`[LATENCY] pre-work before Tier2: ${Date.now() - tReq}ms (session load, profile, RAG, prompt assembly)`);
      const tier2Result = await callTier2Claude(
        systemPromptForTiers,
        messages,
        toolsForTurn,
        sse,
        mcpClient,
        forceToolUseForSearch,
        userRecord?.parentAccountId ?? null,
        userId,
        currentSession?.lastUploadedPhotoUrl ?? null,
        isFreshLookalikeUpload,
        preSearchForReady,
      );
      // If Claude executed a search tool but returned empty text, retry once with an explicit
      // instruction to present the results. This happens when Claude calls the tool successfully
      // but fails to generate the match card presentation in the same response.
      if (!tier2Result.content && tier2Result.toolCallsExecuted && tier2Result.searchToolResults.length > 0) {
        console.log("[TIER2 RETRY] Tool call succeeded but content empty - retrying with results in context, no tools");
        // Include the actual search results in the retry message so Gemini doesn't re-call the tool.
        // Pass [] for tools to prevent a redundant search call.
        const firstResult = tier2Result.searchToolResults[0];
        const serviceType = firstResult.toolName.includes("clinic") ? "IVF Clinic"
          : firstResult.toolName.includes("surrogate") ? "Surrogate"
          : firstResult.toolName.includes("egg") ? "Egg Donor"
          : firstResult.toolName.includes("sperm") ? "Sperm Donor"
          : "Surrogate Agency";
        // Use a minimal system prompt for the retry - the full systemPromptForTiers (128K chars)
        // makes the total context too large for Gemini to generate after a tool call.
        const minimalRetrySystem = `You are Ariel, a warm GoStork fertility concierge. A database search for a ${serviceType} just completed. Present the FIRST result as a match card.

CRITICAL: The providerId in the MATCH_CARD MUST be the "id" field from the search results (a UUID like "abc-123-def"). NEVER use the display name or externalId as the providerId.

Use this EXACT format:
[[MATCH_CARD:{"name":"displayName field","type":"${serviceType}","location":"location field","photo":"","reasons":["reason1","reason2","reason3"],"providerId":"id field value (UUID)"}]]

Write 2-3 warm sentences BEFORE the card. After the card: "Does she feel like a good match?" [[QUICK_REPLY:I have questions about her|Schedule a free consultation|I don't like her]]

Rules: Use real values from the data. The providerId = the "id" UUID field. Never fabricate. Never say search failed.`;
        const retryMessages = [
          { role: "user" as const, content: `Here are the search results. Present the first one as a match card:\n\n${firstResult.resultText.slice(0, 5000)}` }
        ];
        // Up to 2 retries. Gemini intermittently returns empty after tool calls (high flake
        // rate especially on surrogate D-cycle responses). Second attempt with a short pause
        // gives Gemini another shot before we give up and surface the failure to the client.
        let retryResult = await callTier2Claude(minimalRetrySystem, retryMessages, [], sse, mcpClient, false);
        if (!retryResult.content) {
          console.log("[TIER2 RETRY] First retry also empty - second attempt in 500ms");
          await new Promise(r => setTimeout(r, 500));
          retryResult = await callTier2Claude(minimalRetrySystem, retryMessages, [], sse, mcpClient, false);
        }
        if (retryResult.content) {
          tier2Result.content = retryResult.content;
        }
        // No hardcoded fallback - if Gemini won't produce content with the real search
        // results in front of it, that's a server bug we want to surface (the client will
        // get retry_needed and the test will fail loudly) rather than paper over with a
        // deterministic stub that bypasses the AI's actual reasoning.
      }
      if (tier2Result.content) {
        finalContent = injectMissingQuickReplies(tier2Result.content);
      } else {
        needsRetry = true;
      }
      // Populate lastSearchToolResults from Tier2 tool calls for fallback MATCH_CARD injection
      if (tier2Result.searchToolResults.length > 0) {
        lastSearchToolResults.push(...tier2Result.searchToolResults);
      }
    } else {
      // Tier 1: Gemini 2.5 Flash - MINIMAL prompt, Phase 0-2 only, no matching
      // Extract only the Phase 0-2 section from conversation_flow - strip Phase 3+ (match cycles)
      // to keep the prompt small. Gemini returns soft error responses when the prompt grows too large.
      const promptSections = await getPromptSections();
      const fullConversationFlow = promptSections.get("conversation_flow") || "";
      const phase3Marker = "=== PHASE 3: PROGRESSIVE MATCH CYCLES ===";
      const phase3Idx = fullConversationFlow.indexOf(phase3Marker);
      const conversationFlow = phase3Idx > 0
        ? fullConversationFlow.slice(0, phase3Idx).trimEnd()
        : fullConversationFlow;
      const expertPersona = promptSections.get("expert_persona") || "";
      const uiComponents = promptSections.get("ui_components") || "";

      // Strip the full userContextBlock from Tier 1 - it contains matching state that confuses Gemini
      const tier1Name = userRecord?.firstName || userRecord?.name?.split(" ")[0] || "there";
      const tier1Services = services.join(" and ") || "fertility services";

      // Detect whether Phase 0 has already been completed so we can give the AI the right instruction.
      // Phase 0 is done when the parent has sent at least one message AFTER the Phase 0 AI content
      // appeared in the history (i.e., Phase 0 was shown and the parent has responded to it).
      const phase0AiMsgIdx = chatHistory.findIndex(m =>
        m.role === "assistant" && (
          /Before we dive in, let me give you a quick picture/i.test(m.content || "") ||
          /Where are you in your journey right now/i.test(m.content || "") ||
          /Do you have any questions about GoStork/i.test(m.content || "")
        )
      );
      const phase0Done = phase0AiMsgIdx !== -1 &&
        chatHistory.some((m, idx) => idx > phase0AiMsgIdx && m.role === "user");

      const phase0Section = phase0Done
        ? `=== PHASE 0 COMPLETE - CONTINUE WITH INTAKE ===
The GoStork introduction has already been shown to the parent and they have responded. Phase 0 is DONE.
Your job now: continue the conversation naturally based on the parent's current message.
- Answer any questions they have about GoStork or the process
- Then proceed with intake questions from the conversation_flow above
- Do NOT re-deliver or summarize Phase 0
- Honor all MANDATORY QUESTIONS YOU MUST NOT ASK skip directives above`
        : `=== MANDATORY PHASE 0 FLOW - CANNOT BE SKIPPED ===
The greeting was already sent. The parent just confirmed their services ("Yes, that's right").

YOUR ONLY VALID NEXT ACTION RIGHT NOW:
Deliver the GoStork introduction (PATH A from conversation_flow above). Then end EXACTLY with:
"Do you have any questions about GoStork and how we can help you?" [[QUICK_REPLY:I understand, let's get started|I have a few questions]]

PHASE 0 OVERRIDES (apply ONLY while delivering the GoStork education intro - not after):
1. DO NOT ask about sperm donor preferences yet - that comes AFTER Phase 0
2. DO NOT output [[MATCH_CARD]], [[CURATION]], or any matching content
3. DO NOT skip the education message under ANY circumstances
4. The education message is MANDATORY before any matching can begin
NOTE: Once Phase 0 is complete, the MANDATORY QUESTIONS YOU MUST NOT ASK block above takes full effect - honor all skip directives.`;

      const tier1SystemPrompt = `You are ${matchmaker?.name || "Adam"}, the AI concierge for GoStork, a fertility matching concierge service.${matchmaker?.personalityPrompt ? ` ${matchmaker.personalityPrompt}` : ""}
USER: ${tier1Name} | Services: ${tier1Services}

${skipRulesPreamble}
RULES: One question per message. Copy question text and [[QUICK_REPLY:]] tags EXACTLY as written. Save preferences immediately with [[SAVE:{"field":"value"}]]. Skip any step already answered in chat history. Do NOT search, show match cards, or call tools - your job ends at [[CURATION]].

${paperworkBlock ? `\n${paperworkBlock}\n` : ""}
NEVER FAKE AN ACTION OR A SYSTEM FACT (ABSOLUTE):
- You cannot perform account actions (cancel/reschedule calls, receive forms, send documents, process payments). NEVER claim you did or that something was received - if it is not in your context, say you don't see it on your side and offer to check with the team ([[HUMAN_NEEDED]]).
- Financing/payment plans: never invent GoStork policy. Truthful answer: GoStork's own service is free for parents; financing for provider fees varies by provider and the GoStork team can walk through options.
- NEVER ignore what the parent's message actually says (a question, a correction, a request) - address it first, then continue the flow.

=== PHASE 0: GOSTORK INTRODUCTION ===
After parent confirms services ("Yes, that's right"):

1. Acknowledge briefly (1 sentence). Then deliver Part 1 using the EXACT TEMPLATE below. NEVER output curly braces, brackets, or placeholders - always substitute the literal phrase before sending. The "That network is the largest in the industry: ..." numbers sentence is MANDATORY - never omit it.

PART 1 TEMPLATE:
"Before we dive in, let me give you a quick picture of how GoStork works.

GoStork is a matching concierge service - think of me as your personal matchmaker for your fertility journey. You won't be {RESEARCH} on your own. Instead, I get to know your situation, search our entire network for you, and bring you one great match at a time - hand-picked to fit you. That network is the largest in the industry: {NUMBERS} - all with full transparent pricing and no surprises.

And I don't stop at the match. I book your calls, prep you for them, and handle agreements and payments - everything in one place, from first question to signed contract. It's completely free for intended parents - providers pay us a referral fee and are not allowed to pass that cost on to you."
End with: "Does that make sense so far?" [[QUICK_REPLY:Yes, makes sense!|I have a question]]

{RESEARCH} - pick the one matching the parent's services:
- Sperm donation only -> "scrolling through thousands of donor profiles across dozens of sperm bank websites"
- Egg donation only -> "scrolling through thousands of donor profiles across dozens of egg donor agency websites"
- Surrogacy only -> "scrolling through endless profiles across dozens of surrogacy agency websites"
- IVF clinic only -> "researching and comparing dozens of IVF clinic websites"
- Egg + Sperm -> "scrolling through thousands of donor profiles across dozens of egg donor agency and sperm bank websites"
- Egg + Surrogacy -> "scrolling through thousands of profiles across dozens of egg donor and surrogacy agency websites"
- Egg + IVF -> "scrolling through thousands of donor profiles across dozens of egg donor agency websites and comparing IVF clinics"
- Sperm + Surrogacy -> "scrolling through thousands of profiles across dozens of surrogacy agency and sperm bank websites"
- Sperm + IVF -> "scrolling through thousands of donor profiles across dozens of sperm bank websites and comparing IVF clinics"
- Surrogacy + IVF -> "scrolling through endless profiles across dozens of surrogacy agency websites and comparing IVF clinics"
- 3+ services -> name every relevant surface, joined with commas + "and" (e.g. "scrolling through thousands of profiles across dozens of egg donor agency, surrogacy agency, and sperm bank websites and comparing IVF clinics")

{NUMBERS} - pick or combine by parent's services (2 services use "and"; 3+ use commas + final "and"):
- Sperm donation -> "10+ sperm banks with 1,500+ donors"
- Egg donation -> "30 egg donor agencies with 10,000+ donors"
- Surrogacy -> "60+ surrogacy agencies"
- IVF clinic -> "30+ IVF clinics"

EXAMPLES (every selected service appears in BOTH {RESEARCH} and {NUMBERS}):
- Sperm only: "...You won't be scrolling through thousands of donor profiles across dozens of sperm bank websites on your own... That network is the largest in the industry: 10+ sperm banks with 1,500+ donors - all with full transparent pricing and no surprises. ... It's completely free..."
- Egg + Sperm: "...You won't be scrolling through thousands of donor profiles across dozens of egg donor agency and sperm bank websites on your own... That network is the largest in the industry: 30 egg donor agencies with 10,000+ donors and 10+ sperm banks with 1,500+ donors - all with full transparent pricing and no surprises. ... It's completely free..."
- All four: "...That network is the largest in the industry: 60+ surrogacy agencies, 30 egg donor agencies with 10,000+ donors, 10+ sperm banks with 1,500+ donors, and 30+ IVF clinics - all with full transparent pricing and no surprises. ... It's completely free..."

HARD RULES:
- ALWAYS include the "That network is the largest in the industry: {NUMBERS}" sentence - it is MANDATORY.
- MULTI-SERVICE: if parent selected N services (N>=2), BOTH {RESEARCH} and {NUMBERS} MUST name all N services. Never drop a service.
- ONLY include numbers for services the parent actually selected. NEVER quote egg donor numbers to a sperm-only parent, etc.
- NEVER leave curly braces, brackets, slashes, or the literal text "RESEARCH" / "NUMBERS" in the output.

2. When parent affirms (any yes/sure/got it/ok), deliver Part 2 in same response. Same placeholder discipline - never output curly braces.

PART 2 TEMPLATE:
"One thing that sets GoStork apart: every provider has been personally vetted by Eran Amir, our founder, who went through {JOURNEY} himself. He personally interviews each {PROVIDER}'s leadership, reviews their operations, and makes sure they have the right team in place.{WAITLIST}

Do you have any questions about GoStork and how we can help you?" [[QUICK_REPLY:I understand, let's get started|I have a few questions]]

{JOURNEY} - "surrogacy" if parent is looking for surrogacy; otherwise "the fertility journey".
{PROVIDER} - "agency" for egg donation or surrogacy, "sperm bank" for sperm donation, "clinic" for IVF clinic, "provider" if the parent selected multiple service types.
{WAITLIST} - if parent is looking for surrogacy, append " And there are no waiting lists - every surrogate you'll see is available right now." Otherwise leave it out entirely (no extra space, no extra punctuation).

3. If "Not exactly": ask [[MULTI_SELECT:Surrogacy|Egg Donation|Sperm Donation|IVF Clinics]] then deliver education.
4. PHASE 1 (Identity) AND PHASE 2 (Biological baseline) ARE MANDATORY for ALL parents. NEVER skip them, even for donor-only parents. Donor matching (B1/C1) cannot run until Phase 1 + Phase 2 are complete - we need to know family type, gender, embryo status, and biology context to match donors properly. The ONLY thing that varies by services is which Phase 3 cycles run AFTER Phase 1+2 finish.
5. Never deliver education more than once.

=== PHASE 1: IDENTITY (MANDATORY for everyone) ===
MANDATORY: Use EXACTLY this question and EXACTLY these five quick reply options. Do NOT rephrase. Do NOT ask "solo or with a partner?" or any two-step version. One question, five options, always.

"To help me tailor everything to your situation -

Which best describes you?" [[QUICK_REPLY:Solo man|Solo woman|Two dads|Two moms|Man and a woman]]

- Solo man -> [[SAVE:{"gender":"man","relationshipStatus":"single","familyType":"solo_man"}]]
- Solo woman -> [[SAVE:{"gender":"woman","relationshipStatus":"single","familyType":"solo_woman"}]]
- Two dads -> [[SAVE:{"gender":"man","sexualOrientation":"gay","relationshipStatus":"couple","familyType":"two_dads"}]]
- Two moms -> [[SAVE:{"gender":"woman","sexualOrientation":"lesbian","relationshipStatus":"couple","familyType":"two_moms"}]]
- Man and a woman -> [[SAVE:{"relationshipStatus":"couple","familyType":"straight_couple"}]] then ask "And are you the woman or the man in this journey?" [[QUICK_REPLY:I'm the woman|I'm the man]] -> save gender.
Do NOT start Phase 2 until family type + speaker gender are known.

=== PHASE 2: BIOLOGICAL BASELINE ===
Ask in EXACT order. Skip steps already answered. One question per message.

STEP 0: "Do you already have a fertility clinic you're working with, or do you need help finding one?" [[QUICK_REPLY:I need help finding a clinic|I already have a clinic]]
-> Need: [[SAVE:{"needsClinic":true}]] -> Step 1 | Have: [[SAVE:{"needsClinic":false}]] -> Step 0a

STEP 0a: "What's the name of the IVF clinic you're currently with?" (free text) -> [[SAVE:{"currentClinicName":"..."}]] -> Step 1

STEP 1: "Do you already have frozen embryos?" [[QUICK_REPLY:Yes, I do|No, not yet|Working to create them]]
-> Yes: [[SAVE:{"hasEmbryos":true}]] -> Step 1a | No/Working: [[SAVE:{"hasEmbryos":false}]] -> Step 2

STEP 1a: "How many embryos do you have?" [[QUICK_REPLY:1|2|3|4|5|6-10|Above 10]] -> [[SAVE:{"embryoCount":N}]] -> Step 1b

STEP 1b: "Have they been PGT-A tested?" [[QUICK_REPLY:Yes|No|I'm not sure]]
-> Gay/single male: save [[SAVE:{"eggSource":"donor eggs"}]] silently -> Step 3 (NEVER ask Step 2)
-> Straight couple / female: MUST go to Step 2 next. FORBIDDEN to jump to Step 3.

STEP 1c (ONLY if has embryos AND registered for egg donation):
"You mentioned you already have frozen embryos - and you're also registered for egg donation. Just to clarify: are you planning to use your existing embryos, or are you also looking to create new embryos with a fresh donor?" [[QUICK_REPLY:Use my existing embryos|Create new embryos with a fresh donor]]
-> Create new: [[SAVE:{"needsEggDonor":true}]] -> Step 2
-> Use existing + gay/single male: skip Step 2 + 2a -> Step 3
-> Use existing + straight/female: skip Step 2a only, still ask Step 2 (egg source of existing embryos unknown)

STEP 2 - EGG SOURCE:
Gay/single male: skip -> [[SAVE:{"eggSource":"donor eggs"}]] silently. Has embryos -> Step 3. No embryos -> Step 2a.
Straight male + has embryos: "For those embryos, were the eggs your partner's or from a donor?" [[QUICK_REPLY:My partner's eggs|Donor eggs]]
Straight male + no embryos: "What's your plan for eggs - are you thinking of using your partner's own eggs, or considering a donor?" [[QUICK_REPLY:My partner's eggs|Donor eggs|I'm not sure yet]]
Female + couple + has embryos: "For those embryos, were the eggs yours, your partner's, or from a donor?" [[QUICK_REPLY:My own eggs|My partner's eggs|Donor eggs]]
Solo woman + has embryos: "For those embryos, were the eggs yours or from a donor?" [[QUICK_REPLY:My own eggs|Donor eggs]]
Female + couple + no embryos: "What's your plan for eggs?" [[QUICK_REPLY:My own eggs|My partner's eggs|Donor eggs|I'm not sure yet]]
Solo woman + no embryos: "What's your plan for eggs?" [[QUICK_REPLY:My own eggs|Donor eggs|I'm not sure yet]]
-> [[SAVE:{"eggSource":"..."}]] | Donor eggs + no embryos -> Step 2a | Otherwise -> Step 3

STEP 2a: "Do you need help finding an egg donor, or do you already have one?" [[QUICK_REPLY:I need help finding an egg donor|I already have an egg donor]]
-> [[SAVE:{"needsEggDonor":true/false}]] -> Step 3

STEP 3b (ONLY if has embryos AND registered for sperm donation AND 1c didn't resolve):
"You're looking for a sperm donor but already have frozen embryos. Just to confirm - are you looking to create new embryos with donor sperm, or will you use your existing embryos?" [[QUICK_REPLY:Create new embryos with donor sperm|Use my existing embryos]]
-> Create new: [[SAVE:{"needsSpermDonor":true}]] -> Step 3 | Use existing: [[SAVE:{"needsSpermDonor":false}]] -> Step 4

STEP 3 - SPERM:
Solo woman / two moms: "For the sperm source, will you be working with a sperm donor?" -> Step 3a if no embryos
Solo man + has embryos: "For those embryos, did you use your own sperm or a sperm donor?" [[QUICK_REPLY:My own|Donor sperm]]
Solo man + no embryos: "For sperm, will you be using your own or a sperm donor?" [[QUICK_REPLY:My own|Donor sperm]]
Two dads + has embryos: "And for sperm, did you use your own, your partner's, or a sperm donor?" [[QUICK_REPLY:My own|My partner's|Donor sperm]]
Two dads + no embryos: "And for sperm, will you be using your own, your partner's, or a sperm donor?" [[QUICK_REPLY:My own|My partner's|Donor sperm|Not sure yet]]
Straight male + has embryos: "And for sperm, did you use your own or a sperm donor?" [[QUICK_REPLY:My own|Donor sperm]]
Straight male + no embryos: "And for sperm, will you be using your own or a sperm donor?" [[QUICK_REPLY:My own|Donor sperm|Not sure yet]]
-> [[SAVE:{"spermSource":"..."}]] | Donor sperm + no embryos -> Step 3a | Otherwise -> Step 4

STEP 3a (ONLY if donor sperm AND no embryos):
"Do you need help finding a sperm donor, or do you already have one?" [[QUICK_REPLY:I need help finding a sperm donor|I already have a sperm donor]]
-> [[SAVE:{"needsSpermDonor":true/false}]] -> Step 4

STEP 4 - CARRIER:
Gay/single male: skip -> [[SAVE:{"carrier":"gestational surrogate"}]] silently -> Step 4a
SKIP both 4 and 4a if surrogacy confirmed at conversation start -> [[SAVE:{"carrier":"gestational surrogate","needsSurrogate":true}]]
Straight male + has embryos: "And who is carrying the pregnancy?" [[QUICK_REPLY:My partner|A gestational surrogate]]
Straight male + no embryos: "And who is planning to carry the pregnancy?" [[QUICK_REPLY:My partner|A gestational surrogate]]
Female + couple + has embryos: "And who is carrying the pregnancy?" [[QUICK_REPLY:Me|My partner|A gestational surrogate]]
Female + couple + no embryos: "And who is planning to carry the pregnancy?" [[QUICK_REPLY:Me|My partner|A gestational surrogate]]
Solo woman: [[QUICK_REPLY:Me|A gestational surrogate]]
-> [[SAVE:{"carrier":"..."}]] | Surrogate -> Step 4a | Otherwise -> Phase 3

STEP 4a: "Do you need help finding a surrogate, or do you already have one?" [[QUICK_REPLY:I need help finding a surrogate|I already have a surrogate]]
-> [[SAVE:{"needsSurrogate":true/false}]] -> Phase 3

=== PHASE 3: MATCH CYCLE INTAKE ===
Order: Clinic (A) -> Egg Donor (B) -> Sperm Donor (C) -> Surrogate (D). Skip types not needed. One question per message.
After ALL questions answered for a type, send [[CURATION]] summary, then STOP - do not search or show cards.

-- A: CLINIC --
A1: "How old are you?" -> [[SAVE:{"birthYear":YYYY}]] (current year minus age)
A2: "And how old is your partner?" -> [[SAVE:{"partnerBirthYear":YYYY}]] (skip if single)
A3: "Are you hoping for twins?" [[QUICK_REPLY:Yes|No]] -> [[SAVE:{"hopingForTwins":"yes/no"}]]
A4: "Is this your first IVF journey, or have you done IVF before?" [[QUICK_REPLY:First time|I've done IVF before]] -> [[SAVE:{"isFirstIvf":true/false}]]
A5: "What's most important to you when choosing a clinic?" [[MULTI_SELECT:Success rates|Location|Cost|Volume of cycles|Physician gender]] -> [[SAVE:{"clinicPriority":"..."}]]
CURATION: "Here's what I have: [summary of age, egg source, priorities]. Shall I find your perfect matches now? [[CURATION]]"

-- B: EGG DONOR --
B1: "What matters most to you in an egg donor? Feel free to share any preferences - appearance, background, education, anything that's important to you." (free text)
-> Save ALL extracted preferences in ONE [[SAVE:]] tag (eye color, hair, ethnicity, education, height, free text donorPreferences). Never acknowledge without saving.
RULE: Accept all preferences as stated. No advisory, no alternatives suggested.
CURATION: "Here's what I have: [summary of donor preferences]. Shall I find your perfect matches now? [[CURATION]]"

-- C: SPERM DONOR --
C1: "What matters most to you in a sperm donor? Appearance, background, education, personality - anything important." (free text) -> Save all in ONE [[SAVE:]] tag.
C2 (skip if donor type stated in C1): "Would you prefer an Open donor, an Anonymous donor, or an Exclusive donor?" [[QUICK_REPLY:Open|Anonymous|Exclusive|No preference]] -> [[SAVE:{"spermDonorType":"..."}]]
CURATION: "Here's what I have: [summary]. Shall I find your perfect matches now? [[CURATION]]"

-- D: SURROGATE --
D0a: "Are you going on this journey solo, or with a partner?" [[QUICK_REPLY:Solo|With a partner]] -> [[SAVE:{"relationshipStatus":"solo/partnered"}]]
Skip if already known from Phase 1/2.
D0b: "Are you a same-sex couple or straight couple?" [[QUICK_REPLY:Same-sex couple|Straight couple]] -> [[SAVE:{"sameSexCouple":true/false}]]
Skip if D0a was "Solo", or orientation already known.
D1: Deliver cost education FIRST (required), then ask country question.
IF HAS EMBRYOS:
"One thing many families don't realize: since you already have frozen embryos, you can ship them internationally and do your surrogacy in Colombia or Mexico at a significant cost savings - without giving up the embryos you've worked so hard to create.

Here's a quick breakdown:
- United States: $150,000 and up (surrogate compensation, agency fee, legal, insurance)
- Mexico: around $100,000 all-in
- Colombia: starting from $65,000 all-in - our most popular option

Colombia has become the go-to for many of our families. The legal process is straightforward, you only need to stay a few weeks after the baby is born, and we have agencies there we trust completely."

IF NO EMBRYOS:
"Something worth knowing before we dive in: international surrogacy programs can include everything - IVF, egg donor, AND surrogate - all in one package, at a fraction of what you'd pay in the US.

Here's a quick comparison:
- United States: $150,000+ for surrogacy alone (IVF and egg donor are separate additional costs)
- Mexico: around $100,000 for a complete program including IVF, egg donor, and surrogate
- Colombia: starting from $65,000 for a complete program - our most popular option

Colombia's program is particularly well-regarded. The agencies we work with there have delivered hundreds of healthy babies, the legal process is clean, and you only need to stay a few weeks after birth."

Then: "With all of that in mind, which countries are you open to for your surrogacy?" [[MULTI_SELECT:USA|Mexico|Colombia]]
D2: "What are your preferences regarding termination if medically necessary?" [[QUICK_REPLY:Pro-choice surrogate|Pro-life surrogate|No preference]] -> [[SAVE:{"surrogateTermination":"..."}]]
Skip if parent did NOT select USA in D1.
D3: "Are you hoping to have twins, or would you prefer a singleton pregnancy?" [[QUICK_REPLY:Hoping for twins|Singleton only|No preference]] -> [[SAVE:{"hopingForTwins":"..."}]]
Skip ONLY if twins preference was explicitly stated in this conversation. NEVER skip because Cycle A was skipped - D3 is MANDATORY for surrogate matching regardless of clinic cycle status. Do NOT ask A1-A5 first.
CURATION: "Here's what I have: [family type, location, country, termination preference, twins preference]. Shall I find your perfect matches now? [[CURATION]]"

${phase0Section}`;

      // -----------------------------------------------------------------------
      // SERVER-SIDE PHASE 0 PART 2 BYPASS
      // When user affirms Part 1 ("Yes, makes sense!"), Gemini generates Part 2
      // AND Phase 1 together in one streamed response. By the time any post-
      // processing strip runs, the client has already received Phase 1 via stream.
      // Serve Part 2 as a hardcoded bypass so Gemini never touches this turn.
      // -----------------------------------------------------------------------
      const lastAiMessage = [...chatHistory].reverse().find((m: any) => m.role === "assistant");
      // Part 1 detection: Gemini may rephrase the ending question, so check for
      // the GoStork marketplace education content rather than the exact closing line.
      const lastAiWasPart1 = /matching concierge service|giant directory and wish you luck|GoStork is a fertility marketplace|Kayak or Expedia for fertility|providers pay us a referral fee|completely free for intended parents/i.test(lastAiMessage?.content || "") &&
        !/personally vetted by eran amir|no waiting lists/i.test(lastAiMessage?.content || "");
      const part2AlreadyDelivered = chatHistory.some((m: any) =>
        m.role === "assistant" && /personally vetted by eran amir|no waiting lists/i.test(m.content || "")
      );
      const userAffirmedPart1 = /^(yes|sure|makes sense|got it|ok|great|absolutely|yep|sounds good|i understand)/i.test(userMessage.trim()) ||
        /makes sense|let'?s (go|start)/i.test(userMessage);
      if (lastAiWasPart1 && userAffirmedPart1 && !part2AlreadyDelivered) {
        // Serve Part 2 + Phase 1 in ONE response to avoid the typing-animation merge bug.
        // When Part 2 and Phase 1 arrive in rapid succession as separate responses, the frontend
        // animation queue merges them into the same bubble. Combining prevents this entirely.
        // Per-service render: founder journey + provider type + waitlist must adapt
        // to the actual services the parent selected. Defaults to "the fertility
        // journey" / "provider" when surrogacy isn't selected so sperm-only or
        // egg-only parents don't see surrogacy-specific copy.
        const _selectedCount = [needsSurrogate, needsClinic, needsEggDonor, needsSpermDonor].filter(Boolean).length;
        const _journey = needsSurrogate ? "surrogacy" : "the fertility journey";
        let _providerType = "provider";
        if (_selectedCount === 1) {
          if (needsSpermDonor) _providerType = "sperm bank";
          else if (needsClinic) _providerType = "clinic";
          else _providerType = "agency"; // egg donor or surrogacy
        }
        const _waitlist = needsSurrogate ? " And there are no waiting lists - every surrogate you'll see is available right now." : "";
        const part2Body = `One thing that sets GoStork apart: every provider has been personally vetted by Eran Amir, our founder, who went through ${_journey} himself. He personally interviews each ${_providerType}'s leadership, reviews their operations, and makes sure they have the right team in place.${_waitlist}`;
        // Inline all variables needed here - they are declared further down in the Tier 1 block
        // and would cause ReferenceError (TDZ) if referenced before their declarations.
        const _parentNeedsPhase1 = services.some((s: string) => /surrog|clinic|ivf/i.test(s))
          || needsSurrogate || needsClinic || profile?.needsSurrogate === true || profile?.needsClinic === true;
        const _phase1AnsweredInHistory = chatHistory.some((m: any) =>
          m.role === "user" && /\b(solo man|solo woman|two dads|two moms|man and a woman|a woman and a man|woman and a man)\b/i.test(m.content || "")
        ) || !!profile?.familyType;
        const _phase1AlreadyAsked = chatHistory.some((m: any) =>
          m.role === "assistant" && /solo man.*solo woman.*two dads|which best describes you|which of these fits your journey/i.test(m.content || "")
        );
        const needsPhase1Now = _parentNeedsPhase1 && !_phase1AnsweredInHistory && !_phase1AlreadyAsked;
        const combined = needsPhase1Now
          ? `${part2Body}\n\nTo help me tailor everything to your situation -\n\nWhich best describes you? [[QUICK_REPLY:Solo man|Solo woman|Two dads|Two moms|Man and a woman]]`
          : `${part2Body}\n\nDo you have any questions about GoStork and how we can help you? [[QUICK_REPLY:I understand, let's get started|I have a few questions]]`;
        finalContent = combined;
        sse.sendToken(combined);
        serverBypassServed = true;
        console.log(`[PHASE0 PART2 BYPASS] Served Part 2${needsPhase1Now ? " + Phase 1" : ""} directly - triggered by: "${userMessage.slice(0, 40)}"`);
      } else {

      // -----------------------------------------------------------------------
      // SERVER-SIDE PHASE 0 PATH B BYPASS
      // When the user says "No, I'm not looking into X" or corrects their services
      // at the greeting confirmation, show the service selection MULTI_SELECT.
      // Gemini generates "Could you please tell me which services..." without cards.
      // -----------------------------------------------------------------------
      const lastAiWasGreeting = /is that correct\?|looking into.*correct\?|looking for.*correct\?/i.test(lastAiMessage?.content || "");
      const userCorrectedServices = /^no[,!.]?\s|not exactly|not quite|not specifically|i('m| am) not|that'?s not|actually/i.test(userMessage.trim());
      if (lastAiWasGreeting && userCorrectedServices) {
        finalContent = `Got it! What are you looking for help with? Select all that apply. [[MULTI_SELECT:Surrogacy|Egg Donation|Sperm Donation|IVF Clinics]]`;
        sse.sendToken(finalContent);
        serverBypassServed = true;
        console.log("[PHASE0 PATH B BYPASS] Served service selection - Gemini skipped");
      } else {

      // -----------------------------------------------------------------------
      // SERVER-SIDE PHASE 0 Q&A BYPASS
      // When the user clicks "I have a few questions" after the GoStork education,
      // the response is always the same. Gemini confuses this with post-match Q&A
      // and generates matching language instead of a simple open invitation.
      // -----------------------------------------------------------------------
      const lastAiWasPhase0Education = /do you have any questions about GoStork/i.test(lastAiMessage?.content || "");
      const userSaysHasQuestions = /i have (a few|some|a couple of)? ?questions?|i'?d like to (ask|know)|have (some|a few) questions/i.test(userMessage);
      // Also catch "I have a question" after Part 1 (before Part 2 is delivered).
      // Without this, Gemini handles it and says "What would you like to know?" which
      // matches the dead-end pattern /what would you like/, triggering a retry + flash.
      const lastAiWasPart1ForQA = /does that make sense so far|matching concierge service|giant directory and wish you luck|GoStork is a fertility marketplace|Kayak or Expedia for fertility/i.test(lastAiMessage?.content || "");
      if ((lastAiWasPhase0Education || lastAiWasPart1ForQA) && userSaysHasQuestions) {
        finalContent = "Of course! What would you like to know?";
        sse.sendToken(finalContent);
        serverBypassServed = true;
        console.log("[PHASE0 Q&A BYPASS] Served hardcoded open invitation - Gemini skipped");
      } else {

      // -----------------------------------------------------------------------
      // SERVER-SIDE PHASE 1 BYPASS
      // Gemini cannot be trusted to ask the 5-option identity question in the
      // correct format - it keeps reverting to old phrasings from training data.
      // When Phase 1 is needed, skip Gemini entirely and serve the hardcoded
      // question directly. This is the only way to guarantee it never regresses.
      // -----------------------------------------------------------------------
      const phase1AnsweredInHistory = chatHistory.some((m: any) =>
        m.role === "user" && /\b(solo man|solo woman|two dads|two moms|man and a woman|a woman and a man|woman and a man)\b/i.test(m.content || "")
      ) || !!profile?.familyType;
      const parentNeedsPhase1 = services.some((s: string) => /surrog|clinic|ivf/i.test(s))
        || needsSurrogate || needsClinic || profile?.needsSurrogate === true || profile?.needsClinic === true;
      const phase1AlreadyAsked = chatHistory.some((m: any) =>
        m.role === "assistant" && /solo man.*solo woman.*two dads|which best describes you|which of these fits your journey/i.test(m.content || "")
      );
      // Only bypass once Phase 0 Q&A is fully finished.
      // phase0Done fires as soon as the user sends any message after the education -
      // including "I have a few questions", so we need an explicit confirmation signal.
      // The bypass must NOT fire while the user is still asking questions about GoStork.
      // Check ONLY the current userMessage, not allUserMessages (which includes historical
      // "I understand, let's get started" from previous tests and causes false positives).
      const phase0ReadyForPhase1 = phase1AlreadyAsked ||
        /i understand.*let'?s|let'?s (get )?start(ed)?|let'?s go|let'?s begin|i'?m ready|get started|start now/i.test(userMessage);
      // Bypass fires only on the FIRST ask (phase1AlreadyAsked = false) AND only after
      // Phase 0 is truly done. Once Phase 1 has been asked, Gemini handles all follow-up
      // turns (fertility questions, clarifications, weird answers) - the post-generation
      // QR replacer ensures correct options if Gemini re-asks the identity question.
      // phase1StandsDown also gates the hardcoded BYPASS, not just the prompt
      // directive: this branch answers without calling any model, so a
      // redundancy-confirm or handed-off why-question turn would still be
      // overwritten by "Which best describes you?" no matter what the prompt
      // said. (That is what made FT-14 look flaky - the identity quick replies
      // in the failing runs were this bypass's, not the model's.)
      const shouldServePhase1 = phase0Done && phase0ReadyForPhase1 && parentNeedsPhase1
        && !phase1AnsweredInHistory && !phase1AlreadyAsked && !phase1StandsDown;

      // Use allUserMessages (includes current message) not chatHistory so the bypass
      // doesn't loop: when user says "I am a man", chatHistory doesn't include it yet.
      // Also check userMessage directly: when user JUST answered "Man and a woman" this turn,
      // profile.familyType hasn't been saved to DB yet so we must detect it from the message.
      // Match both the QR button text ("Man and a woman") and the natural-language
      // variants ("A woman and a man", "woman and a man") that users / test scripts
      // often send instead of the exact button label.
      const straightCoupleFollowUpNeeded = phase0Done
        && (profile?.familyType === "straight_couple" || /\b(man and a woman|a woman and a man|woman and a man)\b/i.test(userMessage))
        && !profile?.gender
        && !/i('m| am) (the )?(woman|man)\b/i.test(allUserMessages)
        && !isMaleGender && !isFemaleGender // also skip if gender already known from DB
        && !chatHistory.some((m: any) => m.role === "assistant" && /are you the woman or the man in this journey/i.test(m.content || ""));

      // Gender save: when user answered the gender follow-up ("I am a man" / "I'm the woman")
      // but the DB save hasn't landed yet (bypass served the question without a [[SAVE]] tag),
      // persist it now so isMaleGender / isFemaleGender are correct for subsequent turns.
      if (genderFromChat && !profile?.gender && userRecord?.parentAccountId) {
        try {
          await prisma.intendedParentProfile.upsert({
            where: { parentAccountId: userRecord.parentAccountId },
            update: { gender: genderFromChat },
            create: { parentAccountId: userRecord.parentAccountId, gender: genderFromChat },
          });
          if (profile) profile.gender = genderFromChat;
          console.log(`[GENDER SAVE] Saved gender from chat: ${genderFromChat}`);
        } catch {}
      }

      // Schedule-with-concierge: bypass Gemini entirely - Tier 1's compact
      // prompt knows nothing about [[CONCIERGE_CALENDAR]], so it hallucinates
      // fake "Contact Us" buttons. Deterministic response; the tag is
      // processed downstream into the GoStork concierge booking card.
      const scheduleConciergeRegexT1 = /^schedule a video call$|(schedule|book|set up).{0,40}(video\s*)?(call|meeting).{0,40}(concierge|gostork|your team|the team|a human)|(video\s*)?call with (the )?(concierge|gostork|team|human)/i;
      const humanRequestRegexT1 = /talk to (?:a )?(?:real|human|actual) person|talk to (?:the )?gostork team|speak (?:to|with) (?:a )?human|connect me with (?:a )?(?:human|person|someone)|i want (?:a )?human|i'd like to talk to a real person|just want to speak to (?:a )?human|want to talk to (?:a )?human/i;
      if (scheduleConciergeRegexT1.test(userMessage.trim()) && !/(agency|clinic|provider|surrogate|donor)/i.test(userMessage)) {
        // Notify the team only if this session hasn't escalated yet -
        // the HUMAN_NEEDED handler pings every admin unconditionally.
        const needsNotify = !currentSession?.humanRequested;
        const calMsg = `Here's the concierge calendar - pick a time that works for you: [[CONCIERGE_CALENDAR]]${needsNotify ? " [[HUMAN_NEEDED]]" : ""}`;
        sse.sendToken(calMsg.replace(/\[\[CONCIERGE_CALENDAR\]\]/g, "").replace(/\[\[HUMAN_NEEDED\]\]/g, "").trim());
        finalContent = calMsg;
      } else if (humanRequestRegexT1.test(userMessage)) {
        const humanMsg = `Of course! I've just notified the GoStork concierge team - someone will join our chat shortly to assist you directly. What would you like to do in the meantime? [[HUMAN_NEEDED]] [[QUICK_REPLY:Keep making progress|I'll wait for the team|Schedule a video call]]`;
        sse.sendToken(humanMsg.replace(/\[\[HUMAN_NEEDED\]\]/g, "").replace(/\[\[QUICK_REPLY:.*?\]\]/g, "").trim());
        finalContent = humanMsg;
      } else if (handoffWhyQuestionActive) {
        // Handed-off journey + a new-lane request: the why-question is fixed
        // text with fixed options, so serve it deterministically. Left to the
        // prompt, Tier 1 intermittently reproduced its own Phase 1 template
        // ("Which best describes you?" with the five identity options) because
        // that section is far more prominent than any injected directive.
        const laneNoun = /egg\s*donor/i.test(userMessage) ? "egg donor"
          : /sperm\s*donor/i.test(userMessage) ? "sperm donor"
          : /clinic/i.test(userMessage) ? "clinic" : "surrogate";
        const whyMsg = `Of course - I can help you look at ${laneNoun === "clinic" ? "clinics" : `${laneNoun}s`}.\n\nSince your journey with ${handedOffProviderNames} is already underway, help me understand what's prompting this new search so I point you in the right direction. [[QUICK_REPLY:My match fell through|I want a second one in parallel|I'm not happy with the agency|Just exploring]]`;
        sse.sendToken(whyMsg.replace(/\[\[QUICK_REPLY:.*?\]\]/g, "").trim());
        finalContent = whyMsg;
        serverBypassServed = true;
        console.log(`[HANDOFF WHY] Served the why-question deterministically (${laneNoun} request on a handed-off journey)`);
      } else if (shouldServePhase1) {
        // Check if Phase 0 Part 2 (Eran Amir vetting paragraph) was ever delivered.
        // When the user goes through the Q&A path ("I have a few questions" → asks questions
        // → "I understand, let's get started"), Gemini handles Q&A but never delivers Part 2.
        const part2Delivered = chatHistory.some((m: any) =>
          m.role === "assistant" && /eran amir|personally vetted|no waiting lists/i.test(m.content || "")
        );
        // Per-service render - same logic as the Part 2 bypass above. Founder
        // journey, provider type, and waitlist must adapt to the actual services
        // the parent selected.
        const _p1_selectedCount = [needsSurrogate, needsClinic, needsEggDonor, needsSpermDonor].filter(Boolean).length;
        const _p1_journey = needsSurrogate ? "surrogacy" : "the fertility journey";
        let _p1_providerType = "provider";
        if (_p1_selectedCount === 1) {
          if (needsSpermDonor) _p1_providerType = "sperm bank";
          else if (needsClinic) _p1_providerType = "clinic";
          else _p1_providerType = "agency";
        }
        const _p1_waitlist = needsSurrogate ? " And there are no waiting lists - every surrogate you'll see is available right now." : "";
        const part2Text = part2Delivered ? "" :
          `One thing that sets GoStork apart: every provider has been personally vetted by Eran Amir, our founder, who went through ${_p1_journey} himself. He personally interviews each ${_p1_providerType}'s leadership, reviews their operations, and makes sure they have the right team in place.${_p1_waitlist}\n\n`;
        finalContent = `${part2Text}To help me tailor everything to your situation -\n\nWhich best describes you? [[QUICK_REPLY:Solo man|Solo woman|Two dads|Two moms|Man and a woman]]`;
        sse.sendToken(finalContent);
        serverBypassServed = true;
        console.log(`[PHASE1 BYPASS] Served ${part2Delivered ? "" : "Part 2 + "}Phase 1 question - triggered by: "${userMessage.slice(0, 40)}" phase0Ready:${phase0ReadyForPhase1} phase1Asked:${phase1AlreadyAsked}`);
      } else if (straightCoupleFollowUpNeeded) {
        finalContent = `And are you the woman or the man in this journey? [[QUICK_REPLY:I'm the woman|I'm the man]]`;
        serverBypassServed = true; // set before sendToken so Gemini never runs even if sendToken throws
        sse.sendToken(finalContent);
        console.log("[PHASE1 BYPASS] Served straight couple follow-up - Gemini skipped");
      } else if (!useTier2 && needsSurrogate &&
          // Fire for ANY parent type who just answered the sperm question AND needs a surrogate.
          // MUST contain "sperm" explicitly - "using my own eggs" must NOT trigger this.
          // Male/gay male: their own sperm or donor | Female: partner's sperm or donor
          // ONLY when the AI actually just ASKED the sperm-source question - a message
          // merely containing "sperm" is not an answer. Observed live: "I need to
          // find a sperm donor" (a service REQUEST) was hijacked into the D1
          // surrogate education and the request ignored, Gemini never called.
          !serviceSwitchDirective &&
          /for sperm|whose sperm|will you be using.*sperm|sperm.*your own|your plan for sperm|sperm.*donor sperm/i.test(lastAiContent) &&
          /\bsperm\b/i.test(userMessage) &&
          !chatHistory.some((m: any) => m.role === "user" && /my partner.*carr|a gestational surrogate|i.*will carry|i'll carry|carrying.*myself/i.test(m.content || "")) &&
          !chatHistory.some((m: any) => m.role === "assistant" && /who is (?:planning to )?carry|who.*carry.*pregnancy/i.test(m.content || ""))) {
        // Step 4 (carrier) pre-bypass for male parents who need a surrogate.
        // Gemini streams the carrier question before the post-processor can strip it, causing a flash.
        // Bypass Gemini entirely: save carrier silently, skip to the next step.
        try {
          if (userRecord?.parentAccountId) {
            await prisma.intendedParentProfile.upsert({
              where: { parentAccountId: userRecord.parentAccountId },
              update: { carrier: "Gestational surrogate" },
              create: { parentAccountId: userRecord.parentAccountId, carrier: "Gestational surrogate" },
            });
          }
        } catch {}
        // Transition message - only go to clinic cycle if parent NEEDS HELP finding a clinic.
        // alreadyHasClinic = true means they said "I already have a clinic" - skip clinic cycle.
        // needsClinic can be true for BOTH "I need help" AND "I already have" because both contain "clinic".
        const needsHelpFindingClinic = (needsClinic || registeredForClinic) && !alreadyHasClinic;
        // If parent has no embryos, they need IVF to create them - so we MUST know their clinic status
        // before jumping to D1. If clinic question hasn't been asked or answered yet, ask step 0 first.
        const clinicStatusAsked = chatHistory.some((m: any) =>
          m.role === "assistant" && /do you already have a fertility clinic.*need help finding one|need help finding.*clinic.*already have a clinic/i.test(m.content || "")
        );
        const clinicStatusKnown = clinicStatusAsked || needsClinic || registeredForClinic || alreadyHasClinic;
        // Trust chat over stale profile.hasEmbryos (may have "true" persisted from a prior test session).
        // If user said "no embryos" in current chat, treat that as authoritative.
        const noEmbryosNeedIVF = chatMentionsNoEmbryos && !chatMentionsHavingEmbryos;
        if (noEmbryosNeedIVF && !clinicStatusKnown) {
          const step0Text = `Got it! Since you'll need IVF to create embryos before transferring to a surrogate, let me ask:\n\nDo you already have a fertility clinic you're working with, or do you need help finding one? [[QUICK_REPLY:I need help finding a clinic|I already have a clinic]]`;
          finalContent = step0Text;
          sse.sendToken(step0Text);
          serverBypassServed = true;
          console.log("[STEP4 CARRIER BYPASS] Asking step 0 (clinic status) first - parent needs IVF clinic for surrogate path");
        } else {
          // Use the full D1 education text (same as D-cycle bypass) - NOT a truncated version.
          // Trust chat over stale profile.hasEmbryos - if user said "no embryos" this session,
          // never show the HAS_EMBRYOS variant just because a prior test left hasEmbryos=true in DB.
          const d1HasEmbryosCarrier = chatMentionsHavingEmbryos || (profile?.hasEmbryos === true && !chatMentionsNoEmbryos);
          const d1CarrierCosts = await getD1CountryCosts(userRecord?.parentAccountId ?? null);
          const d1TextFull = d1HasEmbryosCarrier
            ? buildD1HasEmbryos(d1CarrierCosts)
            : buildD1NoEmbryos(d1CarrierCosts);
          // INTERNATIONAL SURROGACY EARLY COUNTRY GATE: this bypass fires only
          // when the parent needs a surrogate, so D1 must come BEFORE any
          // Cycle A clinic question per ai-prompt-defaults.ts:526-534. If
          // parent picks USA in D1, the state machine will run Cycle A
          // afterward; if international-only, Cycle A is skipped entirely.
          const transitionLead = needsHelpFindingClinic
            ? `Got it! Before we look at clinics, here's something important about your surrogacy:`
            : `Got it! Now let's find you the perfect surrogate.`;
          const transitionText = `${transitionLead}\n\n${d1TextFull}`;
          finalContent = transitionText;
          sse.sendToken(transitionText);
          serverBypassServed = true;
          console.log("[STEP4 CARRIER BYPASS] Skipped carrier question for male/surrogate parent - Gemini never called");
        }
      } else if (!useTier2 && justAnsweredA5 && !curationAlreadySent) {
        // After A5 (clinic priorities) is answered, Gemini ignores the mandatory CURATION instruction
        // and jumps to surrogate questions. Bypass Gemini and serve the clinic curation directly.
        const currentYear = new Date().getFullYear();
        // Prefer chatHistory answers over profile (profile may have stale data from previous sessions)
        const allUserMsgs = chatHistory.filter((m: any) => m.role === "user").map((m: any) => m.content || "");
        // Age: find a standalone number (18-70) that answered "How old are you?"
        const ageAnswerMsg = allUserMsgs.find((s: string) => /^\d{2}$/.test(s.trim()) && parseInt(s.trim()) >= 18 && parseInt(s.trim()) <= 70);
        const ageFromChat = ageAnswerMsg ? parseInt(ageAnswerMsg.trim()) : null;
        const age = ageFromChat || (profile?.birthYear ? currentYear - profile.birthYear : null);
        // Partner age: similar
        const partnerAgeMsg = chatHistory.filter((m: any) => m.role === "assistant" && /partner.*age|how old.*partner|partner.*how old/i.test(m.content || "")).length > 0
          ? allUserMsgs.find((s: string) => /^\d{2}$/.test(s.trim()) && parseInt(s.trim()) >= 18 && parseInt(s.trim()) <= 70 && s !== ageAnswerMsg) : null;
        const partnerAgeFromChat = partnerAgeMsg ? parseInt(partnerAgeMsg.trim()) : null;
        const partnerAge = partnerAgeFromChat || (profile?.partnerBirthYear ? currentYear - profile.partnerBirthYear : null);
        // Egg source: from chatHistory first (prevent stale profile data like "Egg donor" from previous session)
        const eggSourceFromChat = allUserMsgs.find((s: string) => /partner'?s eggs|my own eggs|donor eggs/i.test(s))?.match(/partner'?s eggs|my own eggs|donor eggs/i)?.[0];
        const eggSource = eggSourceFromChat || (chatMentionsEggSource ? null : profile?.eggSource) || "your eggs";
        const twins = chatHistory.some((m: any) => m.role === "user" && /hoping for twins|yes.*twins/i.test(m.content || "")) ? "hoping for twins"
          : chatHistory.some((m: any) => m.role === "user" && /singleton|no twins/i.test(m.content || "")) ? "preferring singleton"
          : profile?.hopingForTwins === "yes" ? "hoping for twins" : profile?.hopingForTwins === "no" ? "preferring a singleton pregnancy" : null;
        const priorities = userMessage; // userMessage IS the A5 answer (what parent just typed)
        const agePart = age ? `you're ${age}` : "";
        const partnerPart = partnerAge ? `, your partner is ${partnerAge}` : "";
        const eggPart = eggSource.toLowerCase().includes("partner") ? ", using your partner's eggs" : eggSource.toLowerCase().includes("own") ? ", using your own eggs" : eggSource.toLowerCase().includes("donor") ? ", using donor eggs" : "";
        const twinsPart = twins ? `, ${twins}` : "";
        const priorityPart = priorities ? `, with ${priorities} being your top ${priorities.includes(",") ? "priorities" : "priority"} for a clinic` : "";
        const curationText = `Here's what I have: ${agePart}${partnerPart}${eggPart}${twinsPart}${priorityPart}. Shall I find your perfect clinic matches now? [[CURATION]]`;
        finalContent = curationText;
        sse.sendToken(curationText);
        serverBypassServed = true;
        console.log("[A5 CURATION BYPASS] Served clinic curation directly - Gemini skipped");
        // A5 SAVE FALLBACK: since this bypass skips Gemini entirely, no
        // [[SAVE:{"clinicPriority":...}]] tag is ever emitted for the A5 answer
        // (DB audit 2026-07-16: clinicPriority was null after a full clinic
        // intake). The priority-aware clinic ranking depends on it - persist
        // the answer deterministically, same pattern as D1 SAVE FALLBACK.
        // STRICT question check: justAnsweredA5's loose regex also matches the
        // CURATION summary ("...priorities for a clinic"), which made this save
        // a NON-A5 answer (e.g. "First time") as clinicPriority in some flows.
        const lastAiWasA5Question = /most important to you when choosing a clinic|what matters most.*in a clinic/i.test(lastAiContent || "");
        if (lastAiWasA5Question && userRecord?.parentAccountId && userMessage && !profile?.clinicPriority) {
          try {
            await prisma.intendedParentProfile.update({
              where: { parentAccountId: userRecord.parentAccountId },
              data: { clinicPriority: userMessage.slice(0, 300) },
            });
            console.log(`[A5 SAVE FALLBACK] Saved clinicPriority="${userMessage.slice(0, 80)}"`);
          } catch { /* profile row may not exist yet - the chat-scan fallback in the reranker covers it */ }
        }
      } else if (!useTier2 && phase1Complete && needsSurrogate && !needsClinic && !registeredForClinic && chatMentionsSpermSource &&
          // Also block if Step 0 (clinic question) was asked in this session - means clinic is in scope
          // even if the user's answer didn't contain the word "clinic" (e.g. clicked "Yes, I need help")
          !chatHistory.some((m: any) => m.role === "assistant" && /do you already have a fertility clinic|need help finding.*clinic|fertility clinic.*working with/i.test(m.content || "")) &&
          !chatHistory.some((m: any) => m.role === "assistant" && /which countries are you open to|colombia.*mexico|surrogate.*cost.*comparison/i.test(m.content || "")) &&
          !chatHistory.some((m: any) => m.role === "assistant" && /are you going on this journey solo|solo.*or.*with a partner/i.test(m.content || ""))) {
        // Phase 2 → D-cycle pre-bypass: sperm answered, surrogate-ONLY (no clinic needed), Phase 1 known.
        // Only fires when clinic cycle is NOT needed - if parent needs a clinic, Gemini handles
        // clinic cycle first (A1-A5 → CURATION), then Tier 2 handles D cycle after tier2Active fires.
        // D0a and D0b are skippable - serve D1 (cost education + country question) directly.
        console.log(`[D-CYCLE BYPASS] Firing: needsClinic=${needsClinic} registeredForClinic=${registeredForClinic}`);
        // Trust chat over stale profile.hasEmbryos (see carrier bypass for same reasoning).
        const d1HasEmbryos = chatMentionsHavingEmbryos || (profile?.hasEmbryos === true && !chatMentionsNoEmbryos);
        const d1DCycleCosts = await getD1CountryCosts(userRecord?.parentAccountId ?? null);
        const d1Text = d1HasEmbryos
          ? buildD1HasEmbryos(d1DCycleCosts)
          : buildD1NoEmbryos(d1DCycleCosts);
        finalContent = d1Text;
        sse.sendToken(d1Text);
        serverBypassServed = true;
      } else {
        // -----------------------------------------------------------------------
        // INTAKE QUESTION BYPASS - serve hardcoded Phase 2 / Phase 3A / Phase 3D
        // questions directly without calling Gemini. Eliminates wrong QR options,
        // skipped questions, and flash bugs caused by Gemini unreliability.
        //
        // This runs ONLY when none of the more specific bypasses above fired.
        // Gemini is still used for Phase 0 education, Phase 0 Q&A, Phase 3B B1
        // (egg donor open prefs), Phase 3C C1 (sperm donor open prefs), and all
        // Tier 2 matching / post-match turns.
        // -----------------------------------------------------------------------
        // The state machine advances the SCRIPT - it must stand down whenever
        // the current message carries a detected off-script intent (service
        // switch, profile correction, cancel/reschedule ask). Observed live:
        // "actually I'm married, not single" and "forget the surrogate, I just
        // want a clinic first" were steamrolled with the next scripted question
        // while the injected directives never reached any model.
        const offScriptIntentDetected = !!(serviceSwitchDirective || correctionDirective || cancelTruthDirective);
        if (offScriptIntentDetected) {
          console.log(`[INTAKE BYPASS] Standing down - off-script intent detected, the model handles this turn with its directive`);
        }
        if (!serverBypassServed && !useTier2 && !offScriptIntentDetected) {
          // Pre-fetch real DB country costs in case the intake state machine
          // decides to serve the D1 international education message - the
          // builder substitutes them in.
          const d1IntakeCosts = await getD1CountryCosts(userRecord?.parentAccountId ?? null);
          const intakeQuestion = getNextIntakeQuestion({
            profile,
            chatHistory,
            userMessage,
            allUserMessages,
            isMaleGender,
            isFemaleGender,
            isGayMale,
            isLesbianOrientation,
            isSoloSkip,
            needsClinic,
            needsSurrogate,
            needsEggDonor,
            needsSpermDonor,
            registeredForClinic,
            registeredForSurrogate,
            registeredForEggDonor,
            registeredForSpermDonor: (profile?.interestedServices || []).includes("Sperm Donor"),
            alreadyHasClinic,
            alreadyHasSurrogate,
            alreadyHasEggDonor,
            alreadyHasSpermDonor: !!(alreadyHasSpermDonor),
            chatMentionsHavingEmbryos,
            chatMentionsNoEmbryos,
            chatMentionsEggSource,
            chatMentionsSpermSource,
            chatMentionsCarrier,
            phase1Complete,
            curationAlreadySent,
            d1Costs: d1IntakeCosts,
          });

          if (intakeQuestion) {
            finalContent = intakeQuestion.text;
            sse.sendToken(intakeQuestion.text);
            serverBypassServed = true;
            console.log(`[INTAKE BYPASS] Serving step=${intakeQuestion.step}: "${intakeQuestion.text.slice(0, 80)}"`);
          }
        }

        if (!serverBypassServed) {
        // Pass only non-system messages to Tier 1 - the tier1SystemPrompt is the sole system context
        const tier1Messages = messages.filter((m: any) => m.role !== "system");
        const geminiErrorPhrases = /having trouble connecting|trouble connecting|i('m| am) sorry.*connecting|please try again.*moment|experiencing.*issues|temporarily unavailable/i;
        try {
          console.log(`[LATENCY] pre-work before Tier1: ${Date.now() - tReq}ms`);
          finalContent = await callTier1Gemini(tier1SystemPrompt, tier1Messages, sse);
          // Gemini sometimes returns a generic "having trouble connecting" string instead of throwing.
          // Detect this and fall back to Tier 2 so the user gets a real response.
          if (!finalContent || geminiErrorPhrases.test(finalContent)) {
            console.warn("[Tier1] Gemini returned error-like response, falling back to Tier 2:", finalContent?.slice(0, 100));
            const tier2Fallback = await callTier2Claude(systemPromptForTiers, messages, [], sse, mcpClient, false);
            if (tier2Fallback.content) finalContent = tier2Fallback.content;
          }
        } catch (tier1Error: any) {
          console.error("[Tier1] Gemini threw, falling back to Tier 2:", tier1Error?.message);
          try {
            const tier2Fallback = await callTier2Claude(systemPromptForTiers, messages, [], sse, mcpClient, false);
            if (tier2Fallback.content) { finalContent = tier2Fallback.content; }
            else { needsRetry = true; }
          } catch {
            needsRetry = true;
          }
        }
        if (!finalContent && !needsRetry) needsRetry = true;
        const beforeInject = finalContent;
        finalContent = injectMissingQuickReplies(finalContent);
        // Stream the injected suffix so the client receives the QR tag.
        // Gemini already streamed the main content; the injected portion was never sent.
        if (finalContent !== beforeInject) {
          const injectedSuffix = finalContent.slice(beforeInject.trimEnd().length);
          if (injectedSuffix.trim()) sse.sendToken(injectedSuffix);
        }

        // Phase 0 + Phase 1 separation: Gemini sometimes generates both Part 2 of the
        // GoStork education AND the Phase 1 identity question in the same response.
        // Strip Phase 1 from any Tier 1 response that contains Part 2 content.
        // The Phase 1 bypass will serve it correctly on the next turn.
        const containsPart2 = /do you have any questions about GoStork/i.test(finalContent);
        const containsPhase1 = /which best describes you|to help me tailor everything to your situation/i.test(finalContent);
        if (!serverBypassServed && containsPart2 && containsPhase1) {
          // Strip from "To help me tailor..." onwards (Phase 1 portion)
          const phase1Start = finalContent.search(/to help me tailor everything to your situation/i);
          if (phase1Start > 0) {
            finalContent = finalContent.slice(0, phase1Start).trimEnd();
            // Ensure Part 2 ending has the right QR buttons
            if (!/\[\[QUICK_REPLY:/.test(finalContent)) {
              finalContent += " [[QUICK_REPLY:I understand, let's get started|I have a few questions]]";
            }
            console.log("[PHASE0/1 SPLIT] Stripped Phase 1 from Part 2 response - will serve on next turn");
          }
        }

        // Phase 0 Q&A completeness: every Gemini ANSWER during Phase 0 Q&A must
        // end with [[QUICK_REPLY]] buttons so the user has a clear next step.
        // Exception: when Gemini is asking "what's your question?" it's prompting the user
        // to type freely - adding nav buttons before they've asked is premature and confusing.
        if (!serverBypassServed && phase0Done && !phase0ReadyForPhase1) {
          const hasQuickReply = /\[\[QUICK_REPLY:/.test(finalContent);
          const isAskingForQuestion = /what'?s your question|what would you like to know|what.*question.*gostork|tell me.*question|go ahead.*ask|feel free.*ask/i.test(finalContent);
          if (!hasQuickReply && !isAskingForQuestion) {
            const stripped = finalContent.replace(/\[\[.*?\]\]/g, "").trim();
            const endsWithQuestion = stripped.endsWith("?");
            const suffix = endsWithQuestion
              ? " [[QUICK_REPLY:I have more questions|I understand, let's get started]]"
              : "\n\nDo you have any other questions, or are you ready to get started? [[QUICK_REPLY:I have more questions|I understand, let's get started]]";
            sse.sendToken(suffix);
            finalContent += suffix;
            console.log("[PHASE0 Q&A] Appended missing quick reply buttons to Gemini response");
          }
        }
      } // closes if (!serverBypassServed) Gemini call block
      } // closes } else { at line 3887 (D-cycle fallthrough - intake bypass or Gemini)
      } // closes Phase 0 Q&A bypass else block
      } // closes Phase 0 Path B bypass else block
      } // closes Phase 0 Part 2 bypass else block
    }

    // Issue 3: Strip "My partner's" from sperm source quick replies for solo (no-partner) parents.
    // A solo male has no partner - offering "My partner's" as a sperm option is biologically impossible.
    // Detects solo status from DB relationship status OR from chat text.
    const isSoloParent = (userRecord?.relationshipStatus || "").toLowerCase() === "single" ||
      /\bsolo\b|\bsingle\b|\bjust me\b|\bon my own\b|\bby myself\b/i.test(allUserMessages);
    // Post-processor: strip sperm question for solo woman or lesbian couple.
    // A solo woman or lesbian couple ALWAYS uses a sperm donor - asking is wrong.
    const parentIsFemaleSolo = isFemaleGender && isSoloSkip;
    const parentIsLesbian = isLesbianOrientation;
    if ((parentIsFemaleSolo || parentIsLesbian) && profile?.spermSource !== "My own") {
      // CRITICAL: Extract and apply [[SAVE:...]] tags from finalContent BEFORE stripping the sperm Q,
      // because the strip pattern `[^.!?]*` can capture and remove SAVE tags that precede the question.
      // We process the SAVE tags early here so the data is not lost when the question is stripped.
      if (/will you be using your own(?: sperm)?(?:\s*or a sperm donor|,|\s*your partner)|\bfor sperm[,\s]*will you be\b|sperm.*will you be using.*own|using your own or a sperm/i.test(finalContent)) {
        const earlyMatchesSave = [...finalContent.matchAll(/\[\[SAVE:(.*?)\]\]/g)];
        for (const esm of earlyMatchesSave) {
          try {
            const earlyData = JSON.parse(esm[1]);
            if (Object.keys(earlyData).length > 0 && userRecord?.parentAccountId) {
              // Normalize biological-baseline fields so we never write raw lowercase from the prompt template.
              if (typeof earlyData.carrier === "string") earlyData.carrier = normalizeCarrier(earlyData.carrier);
              if (typeof earlyData.eggSource === "string") earlyData.eggSource = normalizeEggSource(earlyData.eggSource, userRecord?.gender);
              if (typeof earlyData.spermSource === "string") earlyData.spermSource = normalizeSpermSource(earlyData.spermSource, userRecord?.gender);
              // Carrier guard: block AI-emitted SAVE from flipping an explicit "Self" to "Gestational surrogate"
              // unless the parent's message in this turn mentioned a surrogate. Same logic as in the main
              // SAVE block at line ~4170 - keep them in sync.
              if (typeof earlyData.carrier === "string" && earlyData.carrier === "Gestational surrogate") {
                const existing = (await prisma.intendedParentProfile.findFirst({
                  where: { parentAccountId: userRecord.parentAccountId },
                  select: { carrier: true },
                }))?.carrier;
                const userMentionsSurrogate = /\bgestational surrogate\b|\ba surrogate\b|\bsurrogate will carry\b|\bvia surrogacy\b/i.test(userMessage || "");
                if ((existing === "Self" || existing === "Self carrying") && !userMentionsSurrogate) {
                  console.log(`[EARLY-SAVE CARRIER GUARD] Blocked carrier downgrade from "${existing}" -> "Gestational surrogate"`);
                  delete earlyData.carrier;
                }
              }
              if (Object.keys(earlyData).length > 0) {
                clearStaleNeedsEggDonor(earlyData);
                await prisma.intendedParentProfile.upsert({
                  where: { parentAccountId: userRecord.parentAccountId },
                  update: earlyData,
                  create: { parentAccountId: userRecord.parentAccountId, ...earlyData },
                });
                // Update local profile cache
                if (profile) Object.assign(profile, earlyData);
                console.log(`[EARLY-SAVE] Saved profile data before sperm Q strip:`, Object.keys(earlyData));
              }
            }
          } catch {}
        }
      }
      // Pattern: matches sperm source questions WITH OR WITHOUT QR buttons
      // Tier1 (Gemini) sometimes generates without QR buttons so we can't require them
      // IMPORTANT: Only strip SPERM SOURCE questions (Step 3: "will you use your own sperm or a donor?")
      // Do NOT strip SPERM DONOR HELP questions (Step 3a: "do you need help finding a sperm donor?")
      // Step 3a is still needed for solo women to indicate if they have a donor or need to find one.
      const spermQuestionPattern = /[^.!?]*(?:will you be using your own(?: sperm)?(?:,| or)?(?: your partner(?:'s)?)?(?:,| or)? (?:a )?sperm donor|(?:and )?for sperm[,\s]*will you be|sperm[^.!?]*will you be using|using your own or a sperm)[^.!?]*[.!?]?(?:\s*\[\[QUICK_REPLY:[^\]]*\]\])?/gi;
      const hasSpermQ = /will you be using your own(?: sperm)?(?:\s*or a sperm donor|,|\s*your partner)|\bfor sperm[,\s]*will you be\b|sperm.*will you be using.*own|using your own or a sperm/i.test(finalContent);
      if (hasSpermQ) {
        // Auto-save sperm donor silently and strip the question
        try {
          if (userRecord?.parentAccountId) {
            await prisma.intendedParentProfile.upsert({
              where: { parentAccountId: userRecord.parentAccountId },
              update: { spermSource: "Sperm donor" },
              create: { parentAccountId: userRecord.parentAccountId, spermSource: "Sperm donor" },
            });
          }
        } catch {}
        finalContent = finalContent.replace(spermQuestionPattern, "").trim();
        // Also remove any stray QUICK_REPLY with sperm options
        finalContent = finalContent.replace(/\[\[QUICK_REPLY:[^\]]*(?:my own|donor sperm|sperm donor)[^\]]*\]\]/gi, "").trim();
        // If entire content was the sperm question, provide a bridging acknowledgment
        if (!finalContent) finalContent = "Got it! Let's continue.";
        console.log("[POST-PROC] Stripped sperm question for solo woman/lesbian - auto-saved Sperm donor");
      }
    }

    if (isMaleGender && isSoloParent && /My partner/i.test(finalContent)) {
      finalContent = finalContent.replace(
        /\[\[QUICK_REPLY:([^\]]*)\]\]/g,
        (_match: string, options: string) => {
          if (options.includes("My partner")) {
            const filtered = options.split("|").filter((o: string) => !o.trim().startsWith("My partner")).join("|");
            return `[[QUICK_REPLY:${filtered}]]`;
          }
          return _match;
        }
      );
    }

    // Post-processor: strip carrier question ("who will carry") for parents who definitely need a
    // surrogate - either they explicitly said so, OR they're male with no female partner (solo male,
    // gay male couple) where the partner cannot carry either. For MW male (straight male in a couple)
    // the female partner CAN carry, so we must NOT strip the question - it's a real choice between
    // "My partner" and "A gestational surrogate".
    const isMaleSoloOrGay = isMaleGender && (isGayMale || isSoloSkip);
    const parentNeedsSurrogate = needsSurrogate || alreadyHasSurrogate || profile?.needsSurrogate === true || isMaleSoloOrGay;
    // Don't auto-save "Gestational surrogate" if the parent already explicitly stated they (or their partner)
    // will carry. This protects lesbian self-carry (Two Moms) and partner-carry (Two Moms partner case)
    // from being silently overwritten when the AI happens to include a "who will carry?" question alongside.
    const parentSaidSelfOrPartnerCarry = /\bi('ll| will| am| plan to)?\s+(carry|be carrying|be the carrier|carry the pregnancy)\b|\bcarrying (it|the pregnancy|myself|the baby)\b|\bi'll carry\b|\bmy partner (?:will|is|plans to)\s+carry\b|\b(?:wife|husband|spouse) (?:will )?carr(?:y|ies)\b/i.test(allUserMessages);
    if (parentNeedsSurrogate && !parentSaidSelfOrPartnerCarry) {
      // Detect carrier question by its text pattern and strip entire sentence + quick reply
      const carrierQuestionPattern = /[^.!?]*(?:who(?:'s| is| will be| would be| was| are)?(?:\s+\w+)?\s+(?:planning\s+to\s+)?(?:carry(?:ing)?|carrier)|who(?:'s| is) (?:going to|planning to) (?:carry|be the carrier))[^.!?]*[.!?]?\s*\[\[QUICK_REPLY:[^\]]*\]\]/gi;
      if (carrierQuestionPattern.test(finalContent)) {
        // Auto-save carrier silently then strip the question
        try {
          if (userRecord?.parentAccountId && profile) {
            await prisma.intendedParentProfile.update({
              where: { parentAccountId: userRecord.parentAccountId },
              data: { carrier: "Gestational surrogate" },
            });
            console.log(`[CARRIER POST-PROC] Auto-saved carrier=gestational surrogate for ${userRecord.parentAccountId}`);
          }
        } catch (e) {
          console.error("[CARRIER POST-PROC] Failed to auto-save carrier:", e);
        }
        finalContent = finalContent.replace(carrierQuestionPattern, "").trim();
        // If stripping the carrier question left the entire response empty, the AI had
        // nothing else to say. Re-run Tier 2 (no tools) to generate the actual next step.
        if (!finalContent) {
          console.log("[CARRIER POST-PROC] Response empty after strip - re-running for next step");
          try {
            const retryResult = await callTier2Claude(systemPromptForTiers, messages, [], sse, mcpClient, false);
            if (retryResult.content) finalContent = retryResult.content;
          } catch (retryErr: any) {
            console.error("[CARRIER POST-PROC] Retry failed:", retryErr?.message);
          }
          if (!finalContent) finalContent = "Got it! Let's move on. [[QUICK_REPLY:Continue]]";
        }
      } else {
        // Fallback: if a quick reply contains "surrogate" and "Me"/"My partner", strip the invalid options
        finalContent = finalContent.replace(
          /\[\[QUICK_REPLY:([^\]]*)\]\]/g,
          (_match: string, options: string) => {
            const opts = options.split("|").map((o: string) => o.trim());
            const hasSurrogate = opts.some((o: string) => /surrogate/i.test(o));
            const hasInvalid = opts.some((o: string) => /^me$/i.test(o) || /my partner/i.test(o));
            if (hasSurrogate && hasInvalid) {
              const filtered = opts.filter((o: string) => !/^me$/i.test(o) && !/my partner/i.test(o)).join("|");
              return filtered ? `[[QUICK_REPLY:${filtered}]]` : "";
            }
            return _match;
          }
        );
      }
    }

    // D0a INTERCEPTOR: Strip "Are you going on this journey solo, or with a partner?" when
    // Phase 1 already established the family type. Gemini ignores the skip directive and asks it
    // anyway, which re-surfaces what looks like a Phase 1 question mid-conversation.
    const d0aPattern = /[^.!?]*(?:are you (?:going on this journey|on this journey|doing this) (?:solo|on your own)|solo.*or.*with a partner|journey.*solo.*partner)[^.!?]*[.!?]?\s*(?:\[\[(?:QUICK_REPLY|MULTI_SELECT):[^\]]*\]\])?/gi;
    if (!useTier2 && phase1Complete && d0aPattern.test(finalContent)) {
      console.log("[D0a INTERCEPT] Stripping redundant D0a question - family type already known from Phase 1");
      finalContent = finalContent.replace(d0aPattern, "").trim();
      if (!finalContent) {
        console.log("[D0a INTERCEPT] Response empty after strip - re-running for next step");
        try {
          const retryResult = await callTier2Claude(systemPromptForTiers, messages, [], sse, mcpClient, false);
          if (retryResult.content) {
            finalContent = retryResult.content;
            sse.sendToken(finalContent);
          }
        } catch (retryErr: any) {
          console.error("[D0a INTERCEPT] Retry failed:", retryErr?.message);
        }
        if (!finalContent) finalContent = "Let me get you set up with some surrogate options. [[QUICK_REPLY:Continue]]";
      }
    }

    // EGG SOURCE INTERCEPTOR (Step 2)
    // Gemini consistently skips Step 2 (egg source) for straight/female parents with embryos,
    // jumping from Step 1b (PGT-A) directly to Step 3 (sperm). Detect this and replace.
    const spermQuestionInContent = /(?:for (?:those embryos,? )?(?:did you use|sperm)|(?:and )?for sperm[,\s]|using your own(?: sperm)? or a sperm donor)/i.test(finalContent);
    // Include the current userMessage in the check - chatHistory.some() only sees prior
    // turns, so if the parent JUST said "I need help finding an egg donor" this turn,
    // the interceptor would otherwise consider egg source still unanswered and overwrite
    // the (correct) next-step response with another egg source question, looping forever.
    const eggSourceAlreadyAnswered = !!profile?.eggSource ||
      /partner'?s eggs|my own eggs|donor eggs|egg donor/i.test(userMessage) ||
      chatHistory.some((m: any) => m.role === "user" && /partner'?s eggs|my own eggs|donor eggs|egg donor/i.test(m.content || ""));
    const isGayOrSingleMaleForEgg = isGayMale || (isMaleGender && isSoloSkip);
    const familyTypeKnownForEgg = !!(profile?.familyType) || isMaleGender || isFemaleGender;
    if (!useTier2 && spermQuestionInContent && !eggSourceAlreadyAnswered && familyTypeKnownForEgg && !isGayOrSingleMaleForEgg) {
      // Straight male: partner's eggs or donor eggs (never "my own")
      // Female (coupled): own, partner's, or donor | Solo woman: own or donor
      let eggQ: string;
      if (isMaleGender) {
        eggQ = `For those embryos, were the eggs your partner's or from a donor? [[QUICK_REPLY:My partner's eggs|Donor eggs]]`;
      } else if (isFemaleGender && isSoloSkip) {
        eggQ = `For those embryos, were the eggs yours or from a donor? [[QUICK_REPLY:My own eggs|Donor eggs]]`;
      } else {
        eggQ = `For those embryos, were the eggs yours, your partner's, or from a donor? [[QUICK_REPLY:My own eggs|My partner's eggs|Donor eggs]]`;
      }
      console.log("[EGG SOURCE INTERCEPT] Replacing premature sperm question with egg source question");
      // Strip the sperm question and replace with the egg source question.
      // Strip broadly so partial sentences before the sperm question are also removed.
      const spermQPattern = /[^.!?]*(?:for (?:those embryos,? )?(?:did you use|sperm)|(?:and )?for sperm[,\s]|using your own(?: sperm)? or a sperm donor)[^.!?]*[.!?]?\s*(?:\[\[QUICK_REPLY:[^\]]*\]\])?/gi;
      const stripped = finalContent.replace(spermQPattern, "").trim();
      finalContent = stripped ? `${stripped}\n\n${eggQ}` : eggQ;
      // Re-stream the corrected content (the original was already streamed by Gemini)
      sse.sendToken("\n\n" + eggQ);
    }

    // Force-correct Phase 1 identity quick replies.
    // Gemini generates its own [[QUICK_REPLY:Solo|With a partner|...]] from training data,
    // bypassing injectMissingQuickReplies (which only fires when no QR tag exists).
    // Any Phase 1 identity question with the wrong options gets its QR replaced unconditionally.
    const PHASE1_CORRECT_QR = "[[QUICK_REPLY:Solo man|Solo woman|Two dads|Two moms|Man and a woman]]";
    const phase1QuestionPattern = /(?:are you (?:on this journey|doing this) (?:solo|on your own)|solo.*or.*with a partner|journey.*solo.*partner|which best describes|which of these fits your journey)/i;
    if (!useTier2 && phase1QuestionPattern.test(finalContent)) {
      // Replace any QR on this message that doesn't already have the 5 correct options
      finalContent = finalContent.replace(/\[\[QUICK_REPLY:([^\]]*)\]\]/g, (_match: string, options: string) => {
        const opts = options.split("|").map((o: string) => o.trim());
        const hasCorrect = opts.includes("Solo man") && opts.includes("Two dads");
        return hasCorrect ? _match : PHASE1_CORRECT_QR;
      });
      // If no QR tag existed at all, append the correct one
      if (!finalContent.includes("[[QUICK_REPLY:")) {
        finalContent = finalContent.trimEnd() + " " + PHASE1_CORRECT_QR;
      }
      console.log("[PHASE1 FIX] Replaced identity QR with 5-option set");
    }

    // One-way door: [[CURATION]] in response permanently activates Tier 2
    if (!useTier2 && finalContent.includes("[[CURATION]]")) {
      prisma.aiChatSession.update({
        where: { id: currentSessionId },
        data: { tier2Active: true },
      }).catch((e: any) => console.error("[TIER ROUTER] Failed to activate tier2:", e));
    }

    // QUESTION INTERCEPTOR: Detect when parent asked a question about a presented profile
    // but the AI ignored it and showed a new match card instead.
    const isSkipAction = /not interested|show me another|skip|pass on/i.test(userMessage);
    const isFavoriteAction = /save as favorite|like .+!|❤️|favorite/i.test(userMessage);
    const looksLikeQuestion = /\?|what|how|where|when|who|why|does she|does he|is she|is he|tell me|her\s+(weight|bmi|age|education|location|compensation|health|deliver|pregnan|baby|babies|height|diet|eye|hair|blood|ethnic|race|occupation|religio|hobby|hobbies|donat|experience|cost|eggs)/i.test(userMessage);
    const aiShowedNewMatch = /\[\[MATCH_CARD:/i.test(finalContent);

    if (!isSkipAction && !isFavoriteAction && looksLikeQuestion && aiShowedNewMatch && currentSessionId && mcpClient) {
      console.log(`[QUESTION INTERCEPT] Parent asked a question but AI showed new match card. Intercepting to answer from profile.`);
      try {
        const foundMc = await findLatestMatchCard(currentSessionId);
        let entityId: string | null = foundMc?.providerId || null;
        let entityType: string | null = foundMc?.type || null;

        if (entityId && entityType) {
          const etype = (entityType || "").toLowerCase();
          let profileToolName: string | null = null;
          let profileToolArgs: any = {};
          if (etype === "surrogate") {
            profileToolName = "get_surrogate_profile";
            profileToolArgs = { surrogateId: entityId };
          } else if (etype === "egg donor") {
            profileToolName = "get_egg_donor_profile";
            profileToolArgs = { donorId: entityId };
          } else if (etype === "sperm donor") {
            profileToolName = "search_sperm_donors";
            profileToolArgs = { query: userMessage, limit: 1 };
          } else if (etype === "clinic") {
            profileToolName = "search_clinics";
            profileToolArgs = { query: userMessage, limit: 1 };
            try {
              const clinicProvider = await prisma.provider.findUnique({ where: { id: entityId }, select: { name: true } });
              if (clinicProvider?.name) {
                profileToolArgs = { name: clinicProvider.name, limit: 1 };
              }
            } catch {}
          }

          if (profileToolName) {
            let profileText = "";
            const profileResult = await mcpClient.callTool({
              name: profileToolName,
              arguments: profileToolArgs,
            });
            profileText = (profileResult.content as any)?.[0]?.text || "";

            if (profileText && profileText.length > 50) {
              console.log(`[QUESTION INTERCEPT] Got profile data (${profileText.length} chars), re-asking AI to answer question instead of showing new match`);
              const pronounLabel = etype === "clinic" ? "them" : etype === "sperm donor" ? "him" : "her";
              messages.push({
                role: "user",
                content: `SYSTEM OVERRIDE: The parent asked a QUESTION about the currently presented match profile. They did NOT ask to skip or see a new match. You MUST answer their question using the profile data below. Do NOT present a new match card. Do NOT call search tools. Just answer the question.\n\nFULL PROFILE DATA:\n${profileText}\n\nParent's question: "${userMessage}"\n\nAnswer the question directly from the profile data. After answering, ask if they have more questions: "Anything else you'd like to know about ${pronounLabel}?" [[QUICK_REPLY:More questions|I like ${pronounLabel}!|Show me someone else]]`,
              });

              const retryContent = await claudeRetry(messages);
              if (retryContent && !/\[\[MATCH_CARD:/i.test(retryContent)) {
                console.log(`[QUESTION INTERCEPT SUCCESS] AI answered from profile data instead of showing new match`);
                finalContent = retryContent;
                // The rejected draft (wrong match presentation) already streamed live -
                // clear it and stream the replacement so the parent never keeps
                // reading a paragraph about the wrong profile until "done".
                sse.sendReset();
                sse.sendToken(finalContent);
              } else {
                console.log(`[QUESTION INTERCEPT] Retry still showed match card - using original response`);
                messages.pop();
              }
            }
          }
        }
      } catch (e) {
        console.error("[QUESTION INTERCEPT] Error:", e);
      }
    }

    // FAVORITE CONVERSION INTERCEPTOR: The FAVORITE flow (post_match_behavior)
    // mandates proposing a free consultation call as the primary next step after
    // the parent hearts a profile. Tier 1 sometimes replies with a bare
    // acknowledgment instead - especially on marketplace deep-link sessions where
    // the heart is the first turn after the greeting card. Enforce the offer:
    // one forced retry, then a deterministic Step 2 append if the model still
    // drops it. Scoped to the exact heart-button message ("Save as favorite")
    // so free-typed messages never trigger it.
    const isHeartButtonAction = /save as favorite/i.test(userMessage);
    const proposesConsultation = /\[\[CONSULTATION_BOOKING:/i.test(finalContent) ||
      /\[\[BANK_CHECKOUT:/i.test(finalContent) || // bank donors are ready inventory - no consultation step
      (/consultation/i.test(finalContent) && /\[\[QUICK_REPLY:/i.test(finalContent));

    // POST-HANDOFF OVERRIDE (7B-4): hearting a profile represented by an org
    // whose journey with this account is already handed off must NOT lead to
    // a consultation offer (handed-off rule 1) or fresh match cards - the
    // why-question comes first (rule 2). The FAVORITE enforcement below would
    // do the opposite, so this check outranks it and REPLACES any reply that
    // skipped the why-question.
    let favoritedHandedOffOrg = false;
    let favoritedMcType = "";
    if (isHeartButtonAction && currentSessionId) {
      try {
        const mc = await findLatestMatchCard(currentSessionId);
        favoritedMcType = (mc?.type || "").toLowerCase();
        if (mc?.providerId) {
          const acctIds = userRecord?.parentAccountId
            ? (await prisma.user.findMany({ where: { parentAccountId: userRecord.parentAccountId }, select: { id: true } })).map((u) => u.id)
            : [userId];
          favoritedHandedOffOrg = !!(await prisma.aiChatSession.findFirst({
            where: { userId: { in: acctIds }, providerId: mc.providerId, handoffCompletedAt: { not: null } },
            select: { id: true },
          }));
        }
      } catch { /* fall through to the normal FAVORITE flow */ }
    }
    if (isHeartButtonAction && favoritedHandedOffOrg) {
      const asksWhy = /\[\[QUICK_REPLY:[^\]]*fell through/i.test(finalContent);
      if (!asksWhy) {
        console.log(`[FAVORITE INTERCEPT] Favorited profile belongs to a handed-off org - replacing with the why-question (7B-4)`);
        const pron = favoritedMcType.includes("sperm") ? "him"
          : (favoritedMcType.includes("clinic") || favoritedMcType.includes("agency") || favoritedMcType.includes("doctor")) ? "them" : "her";
        const laneNoun = favoritedMcType.includes("donor") ? "donor" : favoritedMcType.includes("surrogate") ? "surrogate" : "match";
        finalContent =
          `I've saved ${pron} to your favorites! Since your journey in this lane is already officially underway and handed off, help me understand what's prompting the new search - just so I can point you in the right direction. [[QUICK_REPLY:My match fell through|I want a second ${laneNoun} in parallel|I'm not happy with the agency|Just exploring]]`;
        sse.sendReset();
        sse.sendToken(finalContent);
      }
    }

    // With a consultation already booked, "schedule a call" must NOT be enforced -
    // the CALL PREP MODE directive drives the post-favorite behavior instead.
    if (isHeartButtonAction && hasUpcomingProviderConsult) {
      console.log(`[FAVORITE INTERCEPT] Skipped - consultation already booked, call-prep directive owns the follow-up`);
    }
    if (isHeartButtonAction && !favoritedHandedOffOrg && !hasUpcomingProviderConsult && !proposesConsultation && currentSessionId) {
      console.log(`[FAVORITE INTERCEPT] Heart action but AI reply has no consultation offer. Enforcing FAVORITE flow Step 2.`);
      try {
        const likedName = (userMessage.match(/^i like (.+?)!\s*save as favorite/i)?.[1] || "").trim();
        const foundMc = await findLatestMatchCard(currentSessionId);
        const etype = ((foundMc?.type || likedName || "")).toLowerCase();

        // How to refer to the favorited profile in the follow-up question. The
        // deep-link heart sends a generic type label ("Surrogate") - use a
        // pronoun there instead of the awkward "questions about Surrogate".
        const pronounByLabel: Record<string, string> = {
          "surrogate": "her", "egg donor": "her", "sperm donor": "him",
          "clinic": "them", "surrogacy agency": "them", "doctor": "them",
        };
        const subjectRef = pronounByLabel[likedName.toLowerCase()] || likedName || "them";

        // AGENCY NAME CONFIDENTIALITY: for surrogates/donors, the representing
        // agency is NEVER named before the call is booked - use the generic
        // "the surrogate's agency" phrasing. Clinics/doctors/agencies favorited
        // from their own public card keep their name (they ARE the provider).
        const isRepresentedProfile = etype.includes("surrogate") && !etype.includes("agency")
          ? true : etype.includes("egg donor") || etype.includes("sperm donor");
        const agencyPhrase = etype.includes("egg donor") ? "with the egg donor's agency"
          : etype.includes("sperm donor") ? "with the sperm donor's agency"
          : isRepresentedProfile ? "with the surrogate's agency"
          : likedName ? `with ${likedName}` : "with them";

        messages.push({
          role: "user",
          content: `SYSTEM OVERRIDE: The parent just FAVORITED ${likedName || "this profile"} using the heart button. Your reply did not follow the mandatory FAVORITE flow. Respond again and you MUST: (1) warmly confirm the favorite was saved, (2) propose scheduling a free consultation call ${agencyPhrase} as the clear next step (completely free, no commitment) - NEVER say the agency's real name, refer to it only as "${agencyPhrase.replace(/^with /, "")}", and (3) end with exactly [[QUICK_REPLY:Schedule a consultation|I have some questions|Show me more profiles]]. Do NOT show a new match card. Do NOT call search tools. Do NOT run intake questions.`,
        });
        const retryContent = await claudeRetry(messages);
        const retryProposes = retryContent && !/\[\[MATCH_CARD:/i.test(retryContent) &&
          /consultation/i.test(retryContent) && /\[\[QUICK_REPLY:/i.test(retryContent);
        if (retryProposes) {
          console.log(`[FAVORITE INTERCEPT] Retry followed the FAVORITE flow - using retry response`);
          finalContent = retryContent;
          sse.sendReset();
          sse.sendToken(finalContent);
        } else {
          messages.pop();
          // Replace (not append): the original reply violated the flow - often an
          // intake question - and appending to it produces an incoherent message
          // whose first [[QUICK_REPLY]] tag would also win the QR extraction.
          console.log(`[FAVORITE INTERCEPT] Retry still dropped the offer - replacing with deterministic FAVORITE flow message`);
          const savedRef = pronounByLabel[likedName.toLowerCase()] || likedName || "them";
          finalContent =
            `Great choice - I've saved ${savedRef} as a favorite! The next step would be to schedule a free consultation call ${agencyPhrase} so you can speak with them directly - it's completely free and there's no commitment. Would you like to book that now, or do you have questions about ${subjectRef} first? [[QUICK_REPLY:Schedule a consultation|I have some questions|Show me more profiles]]`;
          sse.sendReset();
          sse.sendToken(finalContent);
        }
      } catch (e) {
        console.error("[FAVORITE INTERCEPT] Error:", e);
      }
    }

    // ACCESS-FAILURE INTERCEPTOR: When AI admits it can't access data, follow the hierarchy:
    // Step 1: Retry MCP profile fetch (up to 2 attempts)
    // Step 2: If profile found, re-ask AI to answer from profile data
    // Step 3: If answer not in profile, check knowledge base
    // Step 4: If still no answer, whisper to agency (silent query)
    // NEVER tell the parent about data access issues
    const accessFailurePatterns = [
      /issue\s*accessing/i,
      /unable\s*to\s*(?:retrieve|access|find|locate|get)/i,
      /there\s*was\s*(?:an?\s*)?(?:issue|problem|error)\s*(?:accessing|retrieving|fetching|getting)/i,
      /couldn'?t\s*(?:retrieve|access|fetch|get)\s*(?:her|his|their|the)\s*(?:full\s*)?(?:profile|data|details|information)/i,
      /(?:having|had)\s*(?:trouble|difficulty|issues?)\s*(?:accessing|retrieving|fetching|getting)/i,
      // Privacy refusals & "not in profile" - treat same as access failure; escalate to agency whisper
      /(?:can'?t|cannot|don'?t|unable to)\s*(?:share|provide|disclose|reveal|give)\s*(?:personal|private|sensitive|that)/i,
      /(?:for\s*)?privacy\s*reasons/i,
      /(?:not\s*)?(?:allowed|able)\s*to\s*(?:share|provide|disclose|reveal)\s*(?:personal|private|that)/i,
      /this\s*(?:type\s*of\s*)?(?:information\s*(?:is|isn'?t)|detail)\s*(?:is\s*)?(?:not|unavailable|private|confidential)/i,
      /(?:that'?s?\s*)?(?:not\s*)?(?:public|available)\s*(?:information|data)/i,
      /don'?t\s*have\s*(?:access\s*to\s*)?(?:that|this|her|his|their)\s*(?:information|detail|data)/i,
      /(?:that\s*)?information\s*(?:isn'?t|is\s*not)\s*(?:available|accessible|in\s*(?:the|her|his)\s*profile)/i,
      // "Profile doesn't include/contain/have" phrasing
      /profile\s*(?:for\s*\w+\s*#?\d+\s*)?(?:doesn'?t|does\s*not)\s*(?:include|contain|have)\s*/i,
      /(?:doesn'?t|does\s*not|not)\s*(?:include|contain|list|have)\s*(?:personal|private|that|this|her|his|their|the\s*\w+'?s?)\s*(?:information|details?|name|data)/i,
      /not\s*(?:something\s*)?(?:included|available|listed|found|part\s*of)\s*(?:in\s*)?(?:her|his|their|the)\s*(?:profile|data|information)/i,
      /(?:that'?s?\s*)?(?:personal|private)\s*(?:information|details?)\s*(?:like|such as)/i,
    ];
    const hasAccessFailure = accessFailurePatterns.some((p) => p.test(finalContent));
    if (hasAccessFailure && currentSessionId && mcpClient) {
      console.log(`[ACCESS-FAILURE INTERCEPT] AI admitted data access failure. Starting hierarchy: profile → knowledge base → whisper.`);
      try {
        const foundMc = await findLatestMatchCard(currentSessionId);
        let entityId: string | null = foundMc?.providerId || null;
        let entityType: string | null = foundMc?.type || null;
        let ownerProviderId: string | null = foundMc?.ownerProviderId || null;
        if (!ownerProviderId) {
          const session = await prisma.aiChatSession.findUnique({
            where: { id: currentSessionId },
            select: { providerId: true },
          });
          ownerProviderId = session?.providerId || null;
        }

        let resolved = false;

        // STEP 1: Retry MCP profile fetch (up to 2 attempts)
        if (entityId && entityType) {
          const etype = (entityType || "").toLowerCase();
          let profileToolName: string | null = null;
          let profileToolArgs: any = {};
          if (etype === "surrogate") {
            profileToolName = "get_surrogate_profile";
            profileToolArgs = { surrogateId: entityId };
          } else if (etype === "egg donor") {
            profileToolName = "get_egg_donor_profile";
            profileToolArgs = { donorId: entityId };
          } else if (etype === "sperm donor") {
            profileToolName = "search_sperm_donors";
            profileToolArgs = { query: userMessage, limit: 1 };
          } else if (etype === "clinic") {
            profileToolName = "search_clinics";
            profileToolArgs = { query: userMessage, limit: 1 };
            try {
              const clinicProvider = await prisma.provider.findUnique({ where: { id: entityId }, select: { name: true } });
              if (clinicProvider?.name) {
                profileToolArgs = { name: clinicProvider.name, limit: 1 };
              }
            } catch {}
          }

          if (profileToolName) {
            let profileText = "";
            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
                console.log(`[ACCESS-FAILURE] Step 1: Profile fetch attempt ${attempt} via ${profileToolName}`);
                const profileResult = await mcpClient.callTool({
                  name: profileToolName,
                  arguments: profileToolArgs,
                });
                profileText = (profileResult.content as any)?.[0]?.text || "";
                if (profileText && profileText.length > 50) break;
              } catch (fetchErr) {
                console.error(`[ACCESS-FAILURE] Profile fetch attempt ${attempt} failed:`, fetchErr);
                if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
              }
            }

            // STEP 2: If profile found, re-ask AI to answer from it
            if (profileText && profileText.length > 50) {
              console.log(`[ACCESS-FAILURE] Step 2: Got profile (${profileText.length} chars), re-asking AI`);
              messages.push({
                role: "user",
                content: `SYSTEM OVERRIDE: You said you couldn't access the profile - but here it is. Answer the parent's question using this data. NEVER tell the parent there was a data access issue.\n\nFULL PROFILE DATA:\n${profileText}\n\nParent's question: "${userMessage}"\n\nIf the answer IS in the profile, respond with it directly. If it truly is NOT in the profile data, say: "Great question! Let me check on that for you - I'll have an answer shortly." and use [[WHISPER:${ownerProviderId || ""}]] to ask the agency.`,
              });
              const retryContent = await claudeRetry(messages);
              if (retryContent && !accessFailurePatterns.some((p) => p.test(retryContent))) {
                console.log(`[ACCESS-FAILURE] Step 2 SUCCESS: AI answered from profile data`);
                finalContent = retryContent;
                resolved = true;
              } else {
                messages.pop();
              }
            }
          }
        }

        // STEP 3: If profile didn't resolve it, try knowledge base
        if (!resolved) {
          try {
            console.log(`[ACCESS-FAILURE] Step 3: Searching knowledge base for answer`);
            const kbResult = await mcpClient.callTool({
              name: "search_knowledge_base",
              arguments: { query: userMessage, limit: 5 },
            });
            const kbText = (kbResult.content as any)?.[0]?.text || "";
            if (kbText && kbText.length > 50) {
              console.log(`[ACCESS-FAILURE] Step 3: Got knowledge base data (${kbText.length} chars), re-asking AI`);
              messages.push({
                role: "user",
                content: `SYSTEM OVERRIDE: Here is relevant knowledge base information. Use it to answer the parent's question. NEVER mention data access issues.\n\nKNOWLEDGE BASE DATA:\n${kbText}\n\nParent's question: "${userMessage}"\n\nIf this answers the question, respond warmly. If not, say: "Great question! Let me check on that for you - I'll have an answer shortly." and use [[WHISPER:${ownerProviderId || ""}]] to ask the agency.`,
              });
              const retryContent = await claudeRetry(messages);
              if (retryContent && !accessFailurePatterns.some((p) => p.test(retryContent))) {
                console.log(`[ACCESS-FAILURE] Step 3 SUCCESS: AI answered from knowledge base`);
                finalContent = retryContent;
                resolved = true;
              } else {
                messages.pop();
              }
            }
          } catch (kbErr) {
            console.error(`[ACCESS-FAILURE] Step 3: Knowledge base search failed:`, kbErr);
          }
        }

        // STEP 4: If still not resolved, whisper to agency
        if (!resolved && ownerProviderId) {
          console.log(`[ACCESS-FAILURE] Step 4: Answer not found in profile or KB - sending whisper to agency ${ownerProviderId}`);
          finalContent = `Great question! I'll check with her agency on that and get back to you with the answer. In the meantime, would you like to schedule a free consultation to speak with them directly? [[WHISPER:${ownerProviderId}]] [[QUICK_REPLY:Yes, schedule a free consultation|Show me more options]]`;
          resolved = true;
        }

        // Last resort: strip access failure language if no provider to whisper to
        if (!resolved) {
          console.log(`[ACCESS-FAILURE] No provider to whisper to - stripping access failure language`);
          finalContent = finalContent.replace(/(?:it\s*seems\s*)?there\s*was\s*(?:an?\s*)?(?:issue|problem|error)\s*(?:accessing|retrieving|fetching|getting|finding)[^.!?]*[.!?]?\s*/gi, "");
          finalContent = finalContent.replace(/(?:i'?m\s*)?unable\s*to\s*(?:retrieve|access|find|locate|get)[^.!?]*[.!?]?\s*/gi, "");
          if (!finalContent.trim()) {
            finalContent = "Great question! Let me look into that for you - I'll have an answer shortly.";
          }
        }
      } catch (e) {
        console.error("[ACCESS-FAILURE INTERCEPT] Error:", e);
      }
    }

    // DEAD-END INTERCEPTOR: Catch passive/open-ended closings and force the AI to retry with an active next step
    const deadEndPatterns = [
      /feel free to (?:let me know|reach out|ask)/i,
      /is there anything (?:else|more) (?:i can|you'd like)/i,
      /let me know (?:if you need|your next|how I can|what you)/i,
      /anything (?:else )?(?:i can |you'd like me to )?(?:help|assist|do for)/i,
      /what (?:else can I|can I help)/i,
      // NOTE: "what would you like to know?" is intentionally excluded - it's a valid Q&A prompt, not a dead-end
      /don't hesitate to/i,
      /i'm here (?:for you|whenever|if you)/i,
      /whenever you're ready/i,
      // Promises to search/retrieve without actually doing it
      /one moment while i/i,
      /give me (?:a moment|one moment|just a moment)/i,
      /(?:let me|i'll) (?:search|look|find|line up|pull up|check|get) (?:some |the |a few )?(?:strong |great |good |perfect )?(?:matches|options|results|profiles)/i,
      /i'll have (?:those|that|some|a few) (?:for you|ready)/i,
      /stand by while/i,
      /bear with me/i,
    ];
    const hasDeadEnd = deadEndPatterns.some((p) => p.test(finalContent));
    if (hasDeadEnd && !isSkipAction && !serverBypassServed) {
      console.log(`[DEAD-END INTERCEPT] AI used passive/open-ended closing. Forcing retry with active next step.`);
      try {
        messages.push({
          role: "user",
          content: `SYSTEM OVERRIDE: Your last response ended with a passive or unfulfilled promise (like "one moment", "let me find", "I'll line up matches") without actually doing it. You MUST act NOW - do NOT say you will do something, just DO it:
1. If the parent gave search criteria (ethnicity, eye color, etc.) - call the search tools RIGHT NOW and present a [[MATCH_CARD:...]]
2. If you need more info before searching - ask ONE specific question like "Do you have a preference on education level?" with quick replies
3. If you already found a match - offer the consultation: [[QUICK_REPLY:Yes, schedule a free consultation|Show me more options]]

NEVER promise to search without actually calling the search tool. NEVER end without either a [[MATCH_CARD]], a direct question, or a [[QUICK_REPLY]].`,
        });
        const retryContent = await claudeRetry(messages);
        if (retryContent && !deadEndPatterns.some((p) => p.test(retryContent))) {
          console.log(`[DEAD-END INTERCEPT SUCCESS] AI retried with active next step`);
          finalContent = retryContent;
        } else {
          console.log(`[DEAD-END INTERCEPT] Retry still had dead-end - using original but trimming`);
          messages.pop();
          // Strip the dead-end sentence and append a proactive nudge
          for (const p of deadEndPatterns) {
            finalContent = finalContent.replace(p, "").trim();
          }
          // Clean up trailing punctuation artifacts
          finalContent = finalContent.replace(/[.!?\s]+$/, ".");
          finalContent += ` Would you like to schedule a free consultation with this agency, or shall I show you another great match? [[QUICK_REPLY:Yes, schedule a free consultation|Show me more options]]`;
        }
      } catch (e) {
        console.error("[DEAD-END INTERCEPT] Error:", e);
      }
    }

    // Server-side pattern extraction: save profile fields from parent message
    // regardless of whether the AI emitted a [[SAVE:]] tag
    if (userRecord && req.body.message && typeof req.body.message === "string") {
      try {
        const msg = req.body.message.toLowerCase().trim();
        const autoUserData: any = {};
        const autoProfileData: any = {};

        // Relationship status
        if (!userRecord.relationshipStatus) {
          if (/\bi('m| am) single\b|^single$|\bsolo\b|\bon my own\b|\bjust me\b/.test(msg)) {
            autoUserData.relationshipStatus = "Single";
          } else if (/\bi('m| am) married\b|\bmy (husband|wife)\b|\bwe('re| are) married\b/.test(msg)) {
            autoUserData.relationshipStatus = "Married";
          } else if (/\bwith (a |my )?partner\b|\bi have a partner\b|\bwe('re| are) (a couple|partnered)\b/.test(msg)) {
            autoUserData.relationshipStatus = "Partnered";
          }
        }

        // Sexual orientation
        if (!userRecord.sexualOrientation) {
          if (/\bi('m| am) gay\b|\btwo dads\b|\bgay (couple|man|male)\b/.test(msg)) {
            autoUserData.sexualOrientation = "Gay";
          } else if (/\bi('m| am) lesbian\b|\btwo moms\b|\btwo mothers\b|\blesbian (couple|woman)\b/.test(msg)) {
            autoUserData.sexualOrientation = "Lesbian";
          } else if (/\bi('m| am) (straight|heterosexual)\b/.test(msg)) {
            autoUserData.sexualOrientation = "Straight";
          } else if (/\bi('m| am) bi(sexual)?\b/.test(msg)) {
            autoUserData.sexualOrientation = "Bi";
          }
        }

        // Gender - also handles single-word quick reply responses ("A man", "A woman")
        if (!userRecord.gender) {
          if (/\bi('m| am) (a )?wom[ae]n\b|\bi('m| am) female\b|\bas a woman\b|\bsingle (mom|mother|woman)\b|^a woman$|^woman$|^female$|^solo woman$|^two moms$/i.test(msg)) {
            autoUserData.gender = "I'm a woman";
          } else if (/\bi('m| am) (a )?m[ae]n\b|\bi('m| am) male\b|\bas a man\b|\bsingle (dad|father|man)\b|\btwo dads\b|^a man$|^man$|^male$|^solo man$/i.test(msg)) {
            autoUserData.gender = "I'm a man";
          } else if (/^non.?binary$|^i'm non.?binary$/i.test(msg)) {
            autoUserData.gender = "I'm non-binary";
          }
        }

        // Same-sex couple
        const extractedProfile = userRecord.parentAccountId
          ? await prisma.intendedParentProfile.findUnique({ where: { parentAccountId: userRecord.parentAccountId } })
          : null;
        if (extractedProfile?.sameSexCouple == null) {
          if (/\btwo dads\b|\btwo moms\b|\btwo mothers\b|\bsame.sex couple\b/.test(msg)) {
            autoProfileData.sameSexCouple = true;
          } else if (/\bmy (husband|wife)\b|\bopposite.sex\b/.test(msg)) {
            autoProfileData.sameSexCouple = false;
          }
        }

        // Has embryos - hasEmbryos/embryoCount/embryosTested use non-null DB defaults (false/0/false),
        // so == null checks always fail. Use !== true to detect "not yet confirmed as true".
        // NEGATION FIRST: "No, I don't have frozen embryos yet" contains the literal
        // substring "have frozen embryos", so the positive regex must never be checked
        // before negation (2026-07-17 bug: saved hasEmbryos=true, then the age answer
        // "49" became embryoCount, and clinic cards flagged "doesn't accept embryo
        // transfers from other clinics" for a parent with no embryos at all).
        const lastAiMsgText = ([...chatHistory].reverse().find(m => m.role === "assistant")?.content || "") as string;
        const lastAiAskedHasEmbryos = /frozen embryos/i.test(lastAiMsgText);
        const msgNegates = /\b(no|don'?t|do not|not yet|haven'?t|have not|never|nope)\b/i.test(msg);
        if (extractedProfile?.hasEmbryos !== true) {
          const embryoCountMatch = msg.match(/\b(\d+)\s*(frozen\s+)?embryos?\b/);
          if ((msgNegates && (/\bembryos?\b/i.test(msg) || lastAiAskedHasEmbryos))
              || (lastAiAskedHasEmbryos && /^working\b/i.test(msg.trim()))) {
            // "No, I don't have frozen embryos yet" / bare "No, not yet" / "Working on
            // them now" answers to the embryos question - all mean no frozen embryos yet
            // (prompt spec Step 1: No/Working -> hasEmbryos=false)
            autoProfileData.hasEmbryos = false;
          } else if (embryoCountMatch) {
            autoProfileData.hasEmbryos = true;
            autoProfileData.embryoCount = parseInt(embryoCountMatch[1], 10);
          } else if (/\bhave (frozen )?embryos?\b|\bwe have embryos?\b/.test(msg)) {
            autoProfileData.hasEmbryos = true;
          } else if (lastAiAskedHasEmbryos && /^(yes|yes, i do|yeah|yep|yup|we do|i do)\b/i.test(msg.trim())) {
            // Bare QR affirmative to "Do you already have frozen embryos?" - the intake
            // bypass serves that question without Gemini, so no SAVE tag ever fires
            autoProfileData.hasEmbryos = true;
          }
        }

        // Embryo count update even when hasEmbryos is already true
        // embryoCount defaults to 0 (non-null), so check for 0 rather than null.
        // A BARE number only counts when the question on the table was actually
        // about embryo count - "49" answering "How old are you?" must never land
        // here (it did: embryoCount=49 for a 49-year-old with zero embryos).
        if ((extractedProfile?.hasEmbryos === true || autoProfileData.hasEmbryos === true) && !extractedProfile?.embryoCount && !autoProfileData.embryoCount) {
          const lastAiAskedEmbryoCount = /how many embryos|number of embryos|embryos do you have/i.test(lastAiMsgText);
          const inlineCountMatch = msg.match(/\b(\d+)\s*(frozen\s+)?embryos?\b/);
          const bareCountMatch = lastAiAskedEmbryoCount ? msg.match(/^(\d+)\s*\+?$/) : null;
          const rawCount = inlineCountMatch?.[1] || bareCountMatch?.[1];
          if (rawCount) {
            const count = parseInt(rawCount, 10);
            if (!isNaN(count) && count > 0 && count <= 50) {
              autoProfileData.embryoCount = count;
            }
          }
        }

        // PGT-A tested - embryosTested defaults to false (non-null), so check !== true
        if ((extractedProfile?.hasEmbryos === true || autoProfileData.hasEmbryos === true) && extractedProfile?.embryosTested !== true) {
          if (/\byes\b.*pgt|pgt.*\byes\b|they.?ve been tested|all.*tested|pgt.?a tested|tested.*pgt.?a|yes.*tested/i.test(msg)) {
            autoProfileData.embryosTested = true;
          } else if (/\bno\b.*pgt|pgt.*\bno\b|not.*tested|haven.t.*tested|not pgt/i.test(msg)) {
            autoProfileData.embryosTested = false;
          } else if (/^(yes|yeah|yep|yup|correct|they have|they are|they were|they've been)$/i.test(msg) || /^(no|nope|not yet|they haven't|they have not)$/i.test(msg)) {
            // Bare affirmative/negative - check if the last AI message was about PGT-A testing
            const lastAiMsg = [...chatHistory].reverse().find(m => m.role === "assistant");
            if (lastAiMsg && /pgt.?a|genetically tested|chromosomally tested|preimplantation/i.test(lastAiMsg.content || "")) {
              autoProfileData.embryosTested = /^(yes|yeah|yep|yup|correct|they have|they are|they were|they've been)$/i.test(msg);
            }
          }
        }

        // Sperm source - extract from parent's direct statement
        if (extractedProfile?.spermSource == null) {
          // Partner sperm FIRST: require explicit sperm context OR a male parent answering a partner question.
          // We disambiguate the bare "my partner's" multiple ways:
          //   (a) message includes the word "sperm" - unambiguous
          //   (b) bare "my partner's" + last AI message mentioned sperm - context match
          //   (c) bare "my partner's" + male parent (Two Dads / MW with man speaking) AND no "eggs" word
          //       in the last AI message - gender heuristic for ambiguous AI phrasing
          const bareMyPartners = /^my partner'?s\s*$/i.test(msg);
          const lastAiMsgForSperm = bareMyPartners
            ? [...chatHistory].reverse().find(m => m.role === "assistant")
            : null;
          const lastAiContent = (lastAiMsgForSperm?.content || "").toString();
          const lastAiAskedSperm = lastAiContent && /sperm|donor sample|genetic material|seed/i.test(lastAiContent);
          const lastAiAskedEggs = lastAiContent && /\beggs?\b/i.test(lastAiContent);
          const genderL = (userRecord?.gender || "").toLowerCase();
          const isMaleParent = !/\b(female|woman|girl)\b/.test(genderL) && /\b(male|man|boy)\b/.test(genderL);
          if (/\bmy partner'?s sperm\b|\bpartner'?s sperm\b|^partner sperm$/i.test(msg) ||
              (bareMyPartners && lastAiAskedSperm) ||
              (bareMyPartners && isMaleParent && !lastAiAskedEggs)) {
            autoProfileData.spermSource = normalizeSpermSource("partner's sperm", userRecord?.gender);
          } else if (/^my own$|^my own sperm$|\bi used my own sperm|\busing my own sperm|\bmy (own )?sperm\b/i.test(msg)) {
            autoProfileData.spermSource = "My sperm";
          } else if (/^donor sperm$|^a sperm donor$|^sperm donor$|\bi used donor sperm|\busing donor sperm/i.test(msg)) {
            autoProfileData.spermSource = "Sperm donor";
          } else if (/^donor$/i.test(msg)) {
            const lastAiMsgSperm = [...chatHistory].reverse().find(m => m.role === "assistant");
            if (lastAiMsgSperm && /sperm source|whose sperm|your (own )?sperm|sperm donor/i.test(lastAiMsgSperm.content || "")) {
              autoProfileData.spermSource = "Sperm donor";
            }
          }
        }

        // Egg source - extract from parent's direct statement (mirrors sperm source extraction).
        // Solo Man / Two Dads have eggSource pre-set to "Egg donor" via IMMEDIATE PROFILE INFERENCE
        // so the null guard prevents this from overwriting their value.
        if (extractedProfile?.eggSource == null) {
          // Partner eggs FIRST: "my partner's eggs" contains "eggs" so check partner explicitly first
          // so we don't misclassify it as "Own eggs". For female parents this saves "Partner eggs"
          // (Two Moms canonical); for male parents (impossible biologically) it falls through.
          if (/\bmy partner'?s? eggs?\b|\bpartner'?s eggs?\b|^my partner'?s?$|^partner eggs$/i.test(msg)) {
            autoProfileData.eggSource = normalizeEggSource("partner's eggs", userRecord?.gender);
          } else if (/\bi('ll| will| am|'m)? (be )?(going to |gonna |planning to )?use (my |our )?own eggs?\b|\bmy own eggs?\b|^own eggs?$|^my own$/i.test(msg)) {
            autoProfileData.eggSource = "Own eggs";
          } else if (/\bdonor eggs?\b|\begg donor\b|\bi('ll| will|'m|m)? (be )?using (an? )?egg donor\b/i.test(msg)) {
            autoProfileData.eggSource = "Egg donor";
          }
        }

        // needsEggDonor false signal: when parent chooses to use existing embryos (no new egg donor needed).
        // The IMMEDIATE PROFILE INFERENCE sets needsEggDonor=true at registration time for anyone who
        // registered for "Egg Donor" service. If they later confirm they will use existing embryos, that
        // inference is stale and must be flipped to false.
        if (extractedProfile?.needsEggDonor !== false && /\buse (my |our )?existing embryos?\b|^use existing$|\bgoing with (my |our )?existing embryos?\b/i.test(msg)) {
          autoProfileData.needsEggDonor = false;
        }

        // Carrier - extract from user message text first (most reliable signal)
        if (extractedProfile?.carrier == null) {
          // Partner-carry FIRST: "My partner will carry" must match before the generic carry regex
          // so we don't misclassify it as "Self".
          if (/\bmy partner (?:will|is going to|plans to|is)\s+(?:carry|carrying|be the carrier|be carrying)\b|\bpartner('s)? carrying\b|\b(?:my )?(?:wife|husband|spouse|partner) (?:will )?carr(?:y|ies)\b/i.test(msg)) {
            autoProfileData.carrier = "My partner";
          } else if (/\bi('ll| will| am| plan to)? (carry|be carrying|be the carrier|carry the pregnancy)\b/i.test(msg) ||
              /\bcarrying (it|the pregnancy|myself|the baby)\b/i.test(msg) ||
              /\bi'll carry\b/i.test(msg)) {
            autoProfileData.carrier = "Self";
          } else if (/\bgestational surrogate\b|\ba surrogate\b|\bsurrogate will carry\b/i.test(msg)) {
            autoProfileData.carrier = "Gestational surrogate";
          } else if (isMaleGender && (isGayMale || isSoloParent)) {
            // Gay males and solo males ALWAYS need a gestational surrogate (no other option)
            autoProfileData.carrier = "Gestational surrogate";
          }
        }

        // Needs
        if (extractedProfile?.needsClinic == null) {
          if (/\b(need|want|looking for|find) (a |an )?(fertility )?clinic\b/.test(msg)) {
            autoProfileData.needsClinic = true;
          } else if (/\balready have (a |an )?(fertility )?clinic\b|\bi have a clinic\b/.test(msg)) {
            autoProfileData.needsClinic = false;
          }
        }
        // needsSurrogate / needsEggDonor: ALWAYS extract from the user's explicit
        // statement, even when the existing profile already has a value. The immediate
        // profile inference at registration time defaults needsSurrogate=true for any
        // gay/solo male and needsEggDonor=true for anyone registered for Egg Donor; the
        // user saying "I already have a surrogate" / "I already have an egg donor" MUST
        // be able to flip those defaults back to false. Previously the `== null` guard
        // prevented any override, leaving TD-06 etc. with stale defaults.
        if (/\b(need|want|looking for|find) (a |an )?surrogate\b/.test(msg)) {
          autoProfileData.needsSurrogate = true;
        } else if (/\balready have (a |an )?surrogate\b/.test(msg)) {
          autoProfileData.needsSurrogate = false;
        }
        if (/\b(need|want|looking for|find) (a |an )?egg donor\b/.test(msg)) {
          autoProfileData.needsEggDonor = true;
        } else if (/\balready have (a |an )?egg donor\b/.test(msg)) {
          autoProfileData.needsEggDonor = false;
        }

        // isLGBTQ: auto-extract from explicit user statement. The Phase 1 prompt asks
        // "Solo man / Solo woman / Two dads / Two moms / Man and a woman?" but does NOT
        // ask a follow-up LGBTQ+ question for solo personas - the test scripts send
        // "Yes, I identify as LGBTQ+" or "No, I'm not LGBTQ+" right after the family
        // type answer expecting that signal to be saved. Without this regex,
        // profile.isLGBTQ stayed null for SM-13 / SW-14 tests (gay solo man / woman).
        if (extractedProfile?.isLGBTQ == null) {
          if (/yes.*identify.*lgbtq|i('?m| am)? ?lgbtq|i identify as lgbtq/i.test(msg)) {
            autoProfileData.isLGBTQ = true;
          } else if (/no.*not (?:lgbtq|an lgbtq)|i'?m not lgbtq|not lgbtq|we'?re not lgbtq|we are not lgbtq|i don'?t identify.*lgbtq/i.test(msg)) {
            autoProfileData.isLGBTQ = false;
          }
        }

        // Age -> birthYear -> dateOfBirth
        if (!userRecord.dateOfBirth) {
          const ageMatch = msg.match(/\bi('m| am) (\d{2})\b|\bage[d]? (\d{2})\b|\b(\d{2}) years? old\b/);
          if (ageMatch) {
            const age = parseInt(ageMatch[2] || ageMatch[3] || ageMatch[4], 10);
            if (age >= 18 && age <= 80) {
              autoUserData.dateOfBirth = new Date(new Date().getFullYear() - age, 0, 1);
            }
          }
        }

        // Persist what we found
        if (Object.keys(autoUserData).length > 0) {
          await prisma.user.update({ where: { id: userId }, data: autoUserData });
          console.log(`[AUTO-EXTRACT] Saved user fields for ${userId}:`, autoUserData);
        }
        if (Object.keys(autoProfileData).length > 0 && userRecord.parentAccountId) {
          clearStaleNeedsEggDonor(autoProfileData);
          const existingAutoProfile = extractedProfile || await prisma.intendedParentProfile.findUnique({ where: { parentAccountId: userRecord.parentAccountId } });
          if (existingAutoProfile) {
            await prisma.intendedParentProfile.update({ where: { parentAccountId: userRecord.parentAccountId }, data: autoProfileData });
          }
          console.log(`[AUTO-EXTRACT] Saved profile fields for account ${userRecord.parentAccountId}:`, autoProfileData);
        }
      } catch (e) {
        console.error("[AUTO-EXTRACT] Error:", e);
      }
    }

    // Collect ALL [[SAVE:]] tags from the response (AI sometimes emits multiple)
    const saveTagMatches = [...finalContent.matchAll(/\[\[SAVE:(.*?)\]\]/g)];
    if (saveTagMatches.length > 0) {
      // Merge all SAVE tags into one object (later tags override earlier ones for the same key)
      const fieldsToSave: any = {};
      for (const m of saveTagMatches) {
        try {
          Object.assign(fieldsToSave, JSON.parse(m[1]));
        } catch (e) {
          console.error("Failed to parse SAVE block:", m[1], e);
        }
      }

      // Fields saved to IntendedParentProfile - every DB column that the AI can set
      const allowedProfileFields = [
        // Biological baseline
        "hasEmbryos", "embryoCount", "embryosTested",
        "eggSource", "spermSource", "carrier",
        // Journey
        "journeyStage", "isFirstIvf",
        // Needs flags
        "needsSurrogate", "needsEggDonor", "needsClinic",
        // Family type
        "sameSexCouple", "isLGBTQ",
        // Clinic preferences
        "clinicReason", "clinicPriority", "clinicAgeGroup", "clinicPriorityTags",
        "currentClinicName",
        // Structured diagnoses (CDC "Reason for Using ART" labels) - drives clinic-experience match
        "diagnoses",
        // Current professionals
        "currentAgencyName", "currentAttorneyName",
        // Egg donor preferences
        "donorPreferences", "donorEyeColor", "donorHairColor", "donorHeight",
        "donorEducation", "donorEthnicity",
        "eggDonorAgeRange", "eggDonorCompensationRange", "eggDonorTotalCostRange",
        "eggDonorLotCostRange", "eggDonorEggType", "eggDonorDonationType",
        // Sperm donor preferences
        "spermDonorType", "spermDonorPreferences",
        "spermDonorAgeRange", "spermDonorEyeColor", "spermDonorHairColor",
        "spermDonorHeightRange", "spermDonorRace", "spermDonorEthnicity",
        "spermDonorEducation", "spermDonorMaxPrice", "spermDonorVialType", "spermDonorCovidVaccinated",
        // Surrogate core preferences
        "surrogateTwins", "surrogateCountries", "surrogateTermination",
        "surrogateAgeRange", "surrogateExperience", "surrogateBudget", "surrogateMedPrefs",
        // Surrogate extended preferences
        "surrogateRace", "surrogateEthnicity", "surrogateRelationship",
        "surrogateBmiRange", "surrogateTotalCostRange", "surrogateLiveBirthsRange",
        "surrogateMaxCSections", "surrogateMaxMiscarriages", "surrogateMaxAbortions",
        "surrogateLastDeliveryYear",
        "surrogateCovidVaccinated", "surrogateSelectiveReduction", "surrogateInternationalParents",
      ];

      const booleanProfileFields = [
        "hasEmbryos", "embryosTested", "needsSurrogate", "needsEggDonor", "needsClinic",
        "isFirstIvf", "sameSexCouple", "isLGBTQ",
        "surrogateCovidVaccinated", "surrogateSelectiveReduction", "surrogateInternationalParents",
        "spermDonorCovidVaccinated",
      ];

      const integerProfileFields = [
        "embryoCount", "surrogateMaxCSections", "surrogateMaxMiscarriages",
        "surrogateMaxAbortions", "surrogateLastDeliveryYear", "spermDonorMaxPrice",
      ];

      // Fields saved to User model
      const allowedUserFields = ["gender", "sexualOrientation", "relationshipStatus", "partnerFirstName", "partnerGender"];

      const profileData: any = {};
      const userData: any = {};

      for (const [key, value] of Object.entries(fieldsToSave)) {
        // hopingForTwins is the prompt-facing alias; DB column is surrogateTwins
        const resolvedKey = key === "hopingForTwins" ? "surrogateTwins" : key;

        if (allowedProfileFields.includes(resolvedKey)) {
          if (booleanProfileFields.includes(resolvedKey)) {
            profileData[resolvedKey] = value === true || value === "true";
          } else if (integerProfileFields.includes(resolvedKey)) {
            const num = parseInt(String(value), 10);
            if (!isNaN(num) && num >= 0) profileData[resolvedKey] = num;
          } else if (resolvedKey === "carrier") {
            const normalized = normalizeCarrier(String(value));
            // Guard: never downgrade an explicit "Self" / "Self carrying" carrier to "Gestational surrogate"
            // unless the parent has actually mentioned a surrogate in this message. Prevents the AI from
            // hallucinating a surrogate-need after the parent already said "I'll carry myself".
            const currentCarrier = (await prisma.intendedParentProfile.findFirst({
              where: { parentAccountId: userRecord!.parentAccountId! },
              select: { carrier: true },
            }))?.carrier;
            const isDowngrade = (currentCarrier === "Self" || currentCarrier === "Self carrying") && normalized === "Gestational surrogate";
            const userMentionsSurrogate = /\bgestational surrogate\b|\ba surrogate\b|\bsurrogate will carry\b|\bvia surrogacy\b/i.test(userMessage || "");
            if (isDowngrade && !userMentionsSurrogate) {
              console.log(`[CARRIER GUARD] Blocked SAVE attempting to downgrade carrier from "${currentCarrier}" -> "Gestational surrogate" (user did not mention a surrogate)`);
            } else {
              profileData.carrier = normalized;
            }
          } else if (resolvedKey === "diagnoses") {
            // Normalize free phrasings to the CDC "Reason for Using ART" labels and
            // UNION with any diagnoses already on file (the AI may surface them one
            // at a time across the conversation).
            const CDC_DX: { match: RegExp; label: string }[] = [
              { match: /male factor|male infertility|sperm|azoosperm|oligosperm/i, label: "Male factor" },
              { match: /endometriosis/i, label: "Endometriosis" },
              { match: /tubal|blocked tube|fallopian/i, label: "Tubal factor" },
              { match: /pcos|polycystic|ovulat|anovulation/i, label: "Ovulatory dysfunction" },
              { match: /uterine|fibroid|polyp|asherman/i, label: "Uterine factor" },
              { match: /diminished ovarian|low ovarian|\bdor\b|low amh|premature ovarian/i, label: "Diminished ovarian reserve" },
              { match: /recurrent (pregnancy )?loss|recurrent miscarriage|\brpl\b/i, label: "Recurrent pregnancy loss" },
              { match: /gestational carrier|surrogate/i, label: "Gestational carrier" },
              { match: /egg.{0,6}bank|embryo.{0,6}bank|fertility preservation|freeze.{0,10}egg/i, label: "Egg or embryo banking" },
              { match: /\bpgt\b|preimplantation|genetic testing|genetic disorder/i, label: "Preimplantation genetic testing" },
              { match: /unexplained/i, label: "Unexplained factor" },
            ];
            const raw = Array.isArray(value) ? value : [value];
            const normalized = new Set<string>();
            for (const item of raw) {
              const s = String(item);
              for (const d of CDC_DX) if (d.match.test(s)) normalized.add(d.label);
            }
            const existing = (await prisma.intendedParentProfile.findFirst({
              where: { parentAccountId: userRecord!.parentAccountId! },
              select: { diagnoses: true },
            }))?.diagnoses || [];
            const union = Array.from(new Set([...existing, ...normalized]));
            if (union.length > 0) profileData.diagnoses = union;
          } else if (resolvedKey === "eggSource") {
            profileData.eggSource = normalizeEggSource(String(value), userRecord?.gender);
          } else if (resolvedKey === "spermSource") {
            profileData.spermSource = normalizeSpermSource(String(value), userRecord?.gender);
          } else {
            // Ensure string fields are actually strings - AI sometimes saves arrays
            profileData[resolvedKey] = Array.isArray(value) ? value.join(",") : String(value);
          }
        } else if (key === "gender") {
          const gRaw = String(value).toLowerCase().trim().replace(/^i'm\s+/, "").replace(/^a\s+/, "");
          if (gRaw === "man" || gRaw === "male") userData.gender = "I'm a man";
          else if (gRaw === "woman" || gRaw === "female") userData.gender = "I'm a woman";
          else if (gRaw === "non-binary" || gRaw === "nonbinary") userData.gender = "I'm non-binary";
          else userData.gender = String(value);
        } else if (allowedUserFields.includes(key)) {
          userData[key] = value;
        } else if (key === "birthYear") {
          const year = parseInt(String(value), 10);
          if (!isNaN(year) && year > 1900 && year <= new Date().getFullYear()) {
            userData.dateOfBirth = new Date(year, 0, 1);
          }
        } else if (key === "partnerBirthYear") {
          const year = parseInt(String(value), 10);
          if (!isNaN(year) && year > 1900 && year <= new Date().getFullYear()) {
            userData.partnerAge = new Date().getFullYear() - year;
          }
        }
      }

      // Derive partnerGender from familyType so the cost-sheet subtype
      // matcher can distinguish 2-mom couples from a Solo Woman, etc.
      // Eva's prompt emits familyType alongside gender/orientation/relationship
      // but the column didn't exist before; we translate the token here.
      // Runs AFTER the main loop so userData.gender is already populated
      // (relevant for straight_couple, where the partner gender is the
      // opposite of the speaker's gender).
      const ftRaw = (fieldsToSave as any)?.familyType;
      if (typeof ftRaw === "string") {
        const effectiveGender = userData.gender ?? userRecord?.gender ?? null;
        switch (ftRaw) {
          case "solo_man":
            if (!userData.gender) userData.gender = "I'm a man";
            userData.partnerGender = null;
            break;
          case "solo_woman":
            if (!userData.gender) userData.gender = "I'm a woman";
            userData.partnerGender = null;
            break;
          case "two_dads":
            if (!userData.gender) userData.gender = "I'm a man";
            userData.partnerGender = "man";
            break;
          case "two_moms":
            if (!userData.gender) userData.gender = "I'm a woman";
            userData.partnerGender = "woman";
            break;
          case "straight_couple":
            if (effectiveGender === "I'm a man") userData.partnerGender = "woman";
            else if (effectiveGender === "I'm a woman") userData.partnerGender = "man";
            // If gender is still unknown, the straight-couple-aware fallback
            // below catches the follow-up turn that finally sets it.
            break;
        }
      }

      // Straight-couple late-bind: Eva's straight-couple flow is two turns.
      // Turn 1 saves familyType=straight_couple + relationshipStatus=couple
      // (partnerGender stays null because gender is still unknown). Turn 2
      // saves only gender ("man" / "woman") via the "I'm the man" / "I'm
      // the woman" quick reply - NO familyType - so the block above doesn't
      // fire and partnerGender stays null forever, breaking the matcher.
      // Catch the follow-up: if THIS save set gender, and the chat / DB
      // shows a straight-couple signal that ISN'T explicitly two_dads or
      // two_moms, derive partnerGender as the opposite of the just-set gender.
      const justSetGender = userData.gender as string | undefined;
      const noPartnerGenderInSave = userData.partnerGender === undefined;
      if (justSetGender && noPartnerGenderInSave) {
        const allChatLower = (Array.isArray(chatHistory) ? chatHistory : [])
          .filter((m: any) => m.role === "user")
          .map((m: any) => (m.content || "").toLowerCase())
          .join(" ") + " " + (userMessage || "").toLowerCase();
        const looksTwoMoms = /\btwo moms\b/.test(allChatLower);
        const looksTwoDads = /\btwo dads\b/.test(allChatLower);
        const looksStraightCouple =
          /\bman and a woman\b|\bstraight couple\b|\bmy wife\b|\bmy husband\b/.test(allChatLower) ||
          (userRecord as any)?.relationshipStatus === "Partnered" ||
          (userRecord as any)?.relationshipStatus === "Married";
        if (looksStraightCouple && !looksTwoMoms && !looksTwoDads) {
          if (justSetGender === "I'm a man") userData.partnerGender = "woman";
          else if (justSetGender === "I'm a woman") userData.partnerGender = "man";
        }
      }

      if (userRecord) {
        if (Object.keys(userData).length > 0) {
          await prisma.user.update({ where: { id: userRecord.id }, data: userData });
        }
        if (Object.keys(profileData).length > 0) {
          clearStaleNeedsEggDonor(profileData);
          const parentAccountId = userRecord.parentAccountId;
          if (parentAccountId) {
            const existing = await prisma.intendedParentProfile.findUnique({ where: { parentAccountId } });
            if (existing) {
              await prisma.intendedParentProfile.update({ where: { parentAccountId }, data: profileData });
              console.log(`[SAVE] Saved profile fields for account ${parentAccountId}:`, Object.keys(profileData));
            }
          }
        }
      }

      finalContent = finalContent.replace(/\[\[SAVE:.*?\]\]/g, "").trim();
      // If stripping SAVE tags left us with empty content, add a neutral bridging message
      // so the parent always gets a response
      if (!finalContent) {
        finalContent = "Got it! Let's continue.";
        console.log("[POST-PROC] Added bridging after SAVE-only response left empty content");
      }
    }

    let sendPrepDoc = false;
    const hotLeadMatch = finalContent.match(/\[\[HOT_LEAD:(.*?)\]\]/);
    if (hotLeadMatch) {
      const providerId = hotLeadMatch[1].trim();
      try {
        const parentAccountId = userRecord?.parentAccountId;
        if (parentAccountId && providerId) {
          await prisma.intendedParentProfile.update({
            where: { parentAccountId },
            data: { hotLeadProviderId: providerId, hotLeadAt: new Date() },
          });
          const admins = await prisma.user.findMany({ where: { roles: { hasSome: ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE"] } }, select: { id: true } });
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

      // [[JOURNEY_RESTART:PROVIDER_ID]] - the parent explicitly said their
      // handed-off journey ended (match fell through / leaving the agency).
      // Records a durable JourneyEvent so accountability flips back to
      // per-chat for sessions created after this moment (dashboard-queue
      // reschedule rows use it as the post-handoff restart marker).
      const restartMatch = finalContent.match(/\[\[JOURNEY_RESTART:([a-zA-Z0-9-]+)\]\]/);
      if (restartMatch) {
        try {
          const restartProviderId = restartMatch[1];
          const providerExists = await prisma.provider.findUnique({ where: { id: restartProviderId }, select: { id: true } });
          if (providerExists) {
            await emitJourneyEvent({
              eventType: "JOURNEY_RESTARTED",
              parentUserId: userId,
              providerId: restartProviderId,
              sessionId: currentSessionId,
              actorRole: "parent",
            });
          }
        } catch (e) {
          console.error("Failed to process JOURNEY_RESTART:", e);
        }
        finalContent = finalContent.replace(/\[\[JOURNEY_RESTART:.*?\]\]/g, "").trim();
      }

      // NOTE: Prep doc email is NOT sent here. The match call prep guide should only
      // be sent when an actual surrogate match call is scheduled by the provider/agency,
      // not when the parent first books a consultation with the agency.
    }

    // Safety net: if the user explicitly asked for a human, force-trigger HUMAN_NEEDED
    // even if the AI forgot to include the tag
    const userMsg = (userMessage || "").toLowerCase();
    const humanRequestPatterns = /talk to (?:a )?(?:real|human|actual) person|talk to (?:the )?gostork team|speak (?:to|with) (?:a )?human|connect me with (?:a )?(?:human|person|someone)|i want (?:a )?human|i'd like to talk to a real person/i;
    if (humanRequestPatterns.test(userMsg) && !finalContent.includes("[[HUMAN_NEEDED]]")) {
      console.log(`[HUMAN_NEEDED SAFETY NET] User requested human but AI forgot the tag - forcing it`);
      finalContent += " [[HUMAN_NEEDED]]";
    }

    // ANTI-ECHO GUARD: Gemini occasionally parrots its own previous message
    // near-verbatim instead of writing a fresh reply - worst on match-card
    // turns, where the card renders followed by the SAME intake question the
    // parent just answered. Detect heavy overlap with the last assistant turn
    // and force one corrective retry; if the retry echoes too, keep the cards
    // but swap the stale text for a minimal lead-in.
    try {
      const lastAssistantForEcho = [...chatHistory].reverse().find((m: any) => m.role === "assistant" && typeof m.content === "string");
      const echoWords = (s: string) => s.replace(/\[\[[^\]]*\]\]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
      if (lastAssistantForEcho && finalContent) {
        const prevW = echoWords(lastAssistantForEcho.content);
        const currW = echoWords(finalContent);
        if (currW.length > 15 && prevW.length > 15) {
          const prevSet = new Set(prevW);
          const overlap = currW.filter((w) => prevSet.has(w)).length / currW.length;
          if (overlap > 0.9) {
            console.log(`[ANTI-ECHO] Reply repeats the previous assistant message (${(overlap * 100).toFixed(0)}% overlap) - retrying`);
            const hadCard = /\[\[(MATCH_CARD|DOCTOR_CARD):/i.test(finalContent);
            messages.push({
              role: "user",
              content: `SYSTEM OVERRIDE: Your reply repeated your PREVIOUS message almost verbatim${hadCard ? " after the match card" : ""}. The parent ALREADY answered that question - never re-ask it. Respond again, and follow ALL of these rules:
1. Do NOT re-greet or re-introduce the task (no "I would love to help you find..." again) - you are MID-conversation; continue naturally from the parent's latest answer.
2. START by briefly acknowledging what the parent just told you (e.g. their stated preferences) and treat it as saved - never ask for it again.
3. ${hadCard ? "Keep the exact same [[MATCH_CARD]]/[[DOCTOR_CARD]] tag(s) and write a warm, personalized introduction for THAT specific profile following the MATCH BLURB rules (positives only)." : "Then continue with the NEXT step of the flow (or answer their question directly) - never restart from the beginning."}`,
            });
            const echoRetry = await claudeRetry(messages).catch(() => "");
            messages.pop();
            const retryW = echoRetry ? echoWords(echoRetry) : [];
            const retryEchoes = retryW.length > 0 ? (retryW.filter((w) => prevSet.has(w)).length / retryW.length) > 0.9 : true;
            const retryKeepsCards = !hadCard || /\[\[(MATCH_CARD|DOCTOR_CARD):/i.test(echoRetry || "");
            if (echoRetry && !retryEchoes && retryKeepsCards) {
              finalContent = echoRetry;
            } else if (hadCard) {
              const tags = finalContent.match(/\[\[[^\]]*\]\]/g) || [];
              finalContent = `Here's a match based on exactly what you shared - take a look: ${tags.join(" ")}`.trim();
            }
          }
        }
      }
    } catch (e) {
      console.error("[ANTI-ECHO] guard error:", e);
    }

    // FALSE-ESCALATION GUARD: the model sometimes imitates the escalation
    // protocol for plain matching requests ("can you help me find a sperm
    // donor?"), pinging every admin and derailing the flow. HUMAN_NEEDED only
    // stands when the parent actually asked for a human. Otherwise strip the
    // tag, the escalation quick replies, and the "I've notified the team"
    // sentences - and if nothing meaningful remains, answer the matching ask
    // with a warm kickoff so the next turn runs the normal intake.
    const matchingHelpIntent = /\b(find|show|match|search|looking for|help (?:me|us))\b[\s\S]{0,60}\b(donor|surrogate|clinic|agency|doctor|match|profile)/i;
    const scheduleConciergeIntent = /(schedule|book|set up).{0,40}(call|meeting).{0,40}(concierge|gostork|team|human)/i;
    if (finalContent.includes("[[HUMAN_NEEDED]]")
        && !humanRequestPatterns.test(userMsg)
        && !scheduleConciergeIntent.test(userMsg)
        && matchingHelpIntent.test(userMsg)) {
      console.log(`[HUMAN_NEEDED GUARD] Matching request escalated by mistake - stripping escalation framing`);
      finalContent = finalContent
        .replace(/\[\[HUMAN_NEEDED\]\]/g, "")
        .replace(/\s*\[\[QUICK_REPLY:Keep making progress\|I'll wait for the team\|Schedule a video call\]\]/gi, "")
        .split(/(?<=[.!?])\s+/)
        .filter(s => !/notified[\s\S]{0,60}(team|concierge)|jump in shortly|join (?:our|the) chat shortly|in the meantime|how would you like to proceed/i.test(s))
        .join(" ")
        .trim();
      if (finalContent.replace(/\[\[.*?\]\]/g, "").trim().length < 25) {
        finalContent = "Absolutely - I'd love to help with that! Tell me what matters most to you and I'll take it from there.";
      }
    }

    // Stale escalation quick replies: the "Keep making progress / I'll wait /
    // Schedule a video call" trio belongs to the escalation message ONLY, but
    // the model keeps appending it to every later reply in a conversation
    // that once escalated. If this reply isn't itself an escalation, drop it.
    if (!finalContent.includes("[[HUMAN_NEEDED]]")) {
      finalContent = finalContent.replace(/\s*\[\[QUICK_REPLY:Keep making progress\|I'll wait for the team\|Schedule a video call\]\]/gi, "").trim();
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
        const admins = await prisma.user.findMany({ where: { roles: { hasSome: ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE"] } }, select: { id: true } });
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

        // Send email + SMS to admins via standalone notifier (no NestJS DI needed)
        try {
        const { notifyAdminsHumanEscalation } = await import("./notify-admin-escalation");
        notifyAdminsHumanEscalation({
          parentName: userRecord?.name || firstName,
          parentEmail: userRecord?.email || "",
          parentPhone: userRecord?.mobileNumber,
          sessionId: currentSessionId || "",
        }).catch((e: any) => console.error("[HUMAN_NEEDED] Email/SMS dispatch failed:", e));

        // Emit SSE real-time toast to admins (best effort via NestJS)
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
                  parentName: userRecord?.name || firstName,
                  parentEmail: userRecord?.email || "",
                  sessionId: currentSessionId,
                  message: `${firstName} has requested to speak with a human concierge`,
                },
                targetUserIds: admins.map((a: any) => a.id),
              }).catch((e: any) => console.error("[HUMAN_NEEDED] SSE emit failed:", e));
            }
          }
        } catch (sseErr) {
          console.error("[HUMAN_NEEDED] SSE dispatch failed:", sseErr);
        }

        } catch (notifErr) {
          console.error("[HUMAN_NEEDED] Notification dispatch error:", notifErr);
        }
      } catch (e) {
        console.error("Failed to process HUMAN_NEEDED:", e);
      }
      finalContent = finalContent.replace(/\[\[HUMAN_NEEDED\]\]/g, "").trim();
    }

    let whisperMatch = finalContent.match(/\[\[WHISPER:(.*?)\]\]/);
    const whisperPhrasePattern = /(?:whisper|reach(?:ed|ing)?\s*out|sent\s*a\s*message|ask(?:ed|ing)?\s*the\s*(?:agency|coordinator|clinic|provider)|check\s*(?:on|with)|hold\s*on|get\s*(?:that|this|back|the)\s*(?:info|detail|answer)|find\s*(?:that|this)\s*out|look(?:ing)?\s*into\s*(?:that|this|it)|get\s*back\s*to\s*you|couldn'?t\s*(?:retrieve|locate|find|access)|don'?t\s*have\s*(?:that|this|access|the)\s*(?:specific|particular|info|detail|data)?|I'?ll\s*(?:check|find|update\s*you)|ran\s*into\s*a\s*(?:hiccup|issue|problem)|wasn'?t\s*able\s*to\s*(?:find|locate|retrieve|access)|unfortunately.*(?:don'?t|can'?t|couldn'?t)|seems\s*I\s*(?:don'?t|can'?t|couldn'?t)|issue\s*accessing|unable\s*to\s*(?:retrieve|access|find|locate|get)|there\s*was\s*(?:an?\s*)?(?:issue|problem|error)\s*(?:accessing|retrieving|fetching|getting|finding)|I'?m\s*unable\s*to\s*(?:retrieve|access|find))/i;
    const phraseMatched = !whisperMatch && whisperPhrasePattern.test(finalContent);

    if ((whisperMatch || phraseMatched) && userId && currentSessionId && mcpClient) {
      let recentEntityId: string | null = null;
      let recentEntityType: string | null = null;
      let inferredProviderId: string | null = null;
      try {
        const foundMc = await findLatestMatchCard(currentSessionId);
        if (foundMc) {
          recentEntityId = foundMc.providerId || null;
          recentEntityType = foundMc.type || null;
          inferredProviderId = foundMc.ownerProviderId || null;
        }
        if (!inferredProviderId) {
          const session = await prisma.aiChatSession.findUnique({
            where: { id: currentSessionId },
            select: { providerId: true },
          });
          inferredProviderId = session?.providerId || null;
        }
      } catch (e) {
        console.error("Whisper context inference error:", e);
      }

      if (recentEntityId && recentEntityType) {
        const etype = (recentEntityType || "").toLowerCase();
        let profileToolName: string | null = null;
        if (etype === "surrogate") profileToolName = "get_surrogate_profile";
        else if (etype === "egg donor") profileToolName = "search_egg_donors";
        else if (etype === "sperm donor") profileToolName = "search_sperm_donors";
        else if (etype === "clinic") profileToolName = "search_clinics";

        if (profileToolName) {
          try {
            console.log(`[WHISPER INTERCEPT] AI wanted to whisper/defer - fetching ${profileToolName} for entity ${recentEntityId} to check if answer is in profile`);
            let profileText = "";
            if (profileToolName === "get_surrogate_profile") {
              const profileResult = await mcpClient.callTool({
                name: "get_surrogate_profile",
                arguments: { surrogateId: recentEntityId },
              });
              profileText = (profileResult.content as any)?.[0]?.text || "";
            } else if (profileToolName === "search_clinics") {
              let clinicArgs: any = { query: userMessage, limit: 1 };
              try {
                const clinicProvider = await prisma.provider.findUnique({ where: { id: recentEntityId }, select: { name: true } });
                if (clinicProvider?.name) clinicArgs = { name: clinicProvider.name, limit: 1 };
              } catch {}
              const searchResult = await mcpClient.callTool({ name: "search_clinics", arguments: clinicArgs });
              profileText = (searchResult.content as any)?.[0]?.text || "";
            } else {
              const searchResult = await mcpClient.callTool({
                name: profileToolName,
                arguments: { query: userMessage, limit: 1 },
              });
              profileText = (searchResult.content as any)?.[0]?.text || "";
            }

            if (profileText && profileText.length > 50) {
              console.log(`[WHISPER INTERCEPT] Got profile data (${profileText.length} chars), re-asking AI to answer from profile`);
              messages.push({
                role: "user",
                content: `SYSTEM OVERRIDE: I found the full profile data for this person. Search through it carefully for the answer. Do NOT whisper or reach out to the agency UNLESS the answer truly is not here.\n\nIMPORTANT: The profile is a large JSON with nested sections. Key sections:\n- "Letter to Intended Parents" → contains _letterText and _letterTitle\n- "Pregnancy History" → entries with Weight, Delivery, Gestation\n- "Basic Information" → BMI, Height, Education\n- "Personal Information" → Location, Pets, Partner/Husband info\n- "My Health History" → medications, conditions\n- "General Interests" → hobbies, personality\n\nCRITICAL: If the answer to the question is NOT explicitly in this profile data, do NOT guess or make it up. Instead say: "Great question! I'll check with her agency on that and get back to you with the answer. In the meantime, would you like to schedule a free consultation to speak with them directly?" and use [[WHISPER:${inferredProviderId || ""}]] to ask the agency.\n\nFULL PROFILE DATA:\n${profileText}\n\nNow answer the parent's original question: "${userMessage}"`,
              });

              const retryContent = await claudeRetry(messages);
              if (retryContent && !retryContent.includes("[[WHISPER:") && !whisperPhrasePattern.test(retryContent)) {
                console.log(`[WHISPER INTERCEPT SUCCESS] AI answered from profile data - whisper avoided`);
                finalContent = retryContent;
                // The deferral draft already streamed live - clear it and stream
                // the real answer (same reconciliation as QUESTION INTERCEPT).
                sse.sendReset();
                sse.sendToken(finalContent);
                whisperMatch = null;
              } else {
                console.log(`[WHISPER INTERCEPT] AI still wants to whisper even with profile data - allowing whisper`);
                messages.pop();
              }
            }
          } catch (e) {
            console.error("[WHISPER INTERCEPT] Profile fetch failed:", e);
          }
        }
      }

      if (!whisperMatch && phraseMatched && inferredProviderId) {
        console.log(`[WHISPER FALLBACK] AI mentioned reaching out but no [[WHISPER:...]] tag - auto-creating for provider ${inferredProviderId}`);
        whisperMatch = [`[[WHISPER:${inferredProviderId}]]`, inferredProviderId] as any;
      }
    }
    if (whisperMatch) {
      const whisperProviderId = whisperMatch[1].trim();
      try {
        if (whisperProviderId && userId && currentSessionId) {
          // If the user's message is a short affirmative ("yes", "sure", etc.), the actual question
          // is earlier in the conversation history - find the last real parent question
          const SHORT_AFFIRMATIVES = /^(yes|yeah|yep|sure|ok|okay|please|go ahead|do it|yup|absolutely|sounds good|great|perfect|yes please)[\s!.]*$/i;
          let questionText: string;
          if (userMessage && SHORT_AFFIRMATIVES.test(userMessage.trim())) {
            // Walk back through messages to find the last user question (before the current "yes")
            const parentMessages = messages.filter((m: any) => m.role === "user");
            const prevQuestion = parentMessages.length >= 2
              ? parentMessages[parentMessages.length - 2]?.content
              : null;
            questionText = (typeof prevQuestion === "string" ? prevQuestion : null)
              || userMessage
              || finalContent.replace(/\[\[WHISPER:.*?\]\]/g, "").trim().slice(0, 500);
          } else {
            questionText = userMessage || finalContent.replace(/\[\[WHISPER:.*?\]\]/g, "").trim().slice(0, 500);
          }
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
          void emitJourneyEvent({ eventType: "WHISPER_ASKED", parentUserId: userId, providerId: whisperProviderId, sessionId: currentSessionId || null, actorRole: "parent" });

          let whisperMatchCard: any = null;
          try {
            const foundMc = await findLatestMatchCard(currentSessionId);
            if (foundMc) {
              whisperMatchCard = { ...foundMc };
            }
          } catch (e) {
            console.error("[WHISPER] Could not find match card for whisper:", e);
          }

          await prisma.aiChatMessage.create({
            data: {
              sessionId: currentSessionId,
              role: "assistant",
              content: `📋 A prospective parent has a question that needs your input:\n\n"${questionText}"\n\nPlease reply below and the AI concierge will pass your answer to the parent.`,
              senderType: "system",
              uiCardData: {
                whisperQuestionId: silentQuery.id,
                ...(whisperMatchCard ? { whisperMatchCard } : {}),
              },
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

            const baseUrl = getBaseUrl();
            const whisperSession = await prisma.aiChatSession.findUnique({
              where: { id: currentSessionId },
              select: { userId: true, subjectProfileId: true },
            });
            const whisperPath = whisperSession
              ? `/chat/${whisperSession.userId}/${whisperSession.subjectProfileId || currentSessionId}`
              : `/chat/${currentSessionId}`;
            const chatLink = `${baseUrl}${whisperPath}`;
            const emailRecipients = providerUsers.filter((pu: any) => pu.email).map((pu: any) => pu.email!);
            for (const recipientEmail of emailRecipients) {
              sendWhisperEmail(recipientEmail, providerName, questionText, baseUrl, currentSessionId, chatLink).catch(e =>
                console.error(`Whisper email failed for ${recipientEmail}:`, e.message)
              );
            }

            // SMS: fetch mobile numbers for provider users and send text notification
            const providerUserIds = providerUsers.map((pu: any) => pu.id).filter(Boolean);
            if (providerUserIds.length > 0) {
              prisma.user.findMany({
                where: { id: { in: providerUserIds }, mobileNumber: { not: null } },
                select: { mobileNumber: true },
              }).then(usersWithPhone => {
                for (const u of usersWithPhone) {
                  if (u.mobileNumber) {
                    sendWhisperSms(u.mobileNumber, questionText, chatLink).catch(e =>
                      console.error(`Whisper SMS failed:`, e.message)
                    );
                  }
                }
              }).catch(e => console.error("Failed to fetch provider phones for whisper SMS:", e.message));
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

    // Normalize verbose quick-reply options for simple sense-check / confirmation questions.
    // The AI sometimes generates "Yes, I'm looking into surrogacy" instead of "Yes, makes sense!"
    if (quickReplies.length > 0 && /does that make sense|make sense so far|does that all make sense/i.test(finalContent)) {
      quickReplies = quickReplies.map((opt: string) => {
        if (/^yes[,!]?\s*$/i.test(opt) || /^yes,?\s+(that\s+)?makes?\s+sense/i.test(opt) || (/^yes,\s+/i.test(opt) && opt.length > 20)) return "Yes, makes sense!";
        if (/^no[,!]?\s*$/i.test(opt) || /^i\s+have\s+a?\s+question/i.test(opt) || /^i\s+have\s+questions/i.test(opt)) return "I have a question";
        return opt;
      });
      console.log("[QR NORMALIZE] Normalized sense-check quick replies:", quickReplies);
    }

    // Fallback: if AI forgot to include [[QUICK_REPLY:...]], inject known options for
    // recognised Phase 1/2 questions based on content pattern matching.
    // Patterns match the CLOSING QUESTION only (the last non-empty line - the
    // question-placement rule puts it there), never the whole message: a reply
    // that merely MENTIONS a topic earlier must not get that topic's canned
    // options. Observed live: "Are you looking for a sperm donor to create
    // additional embryos, or has something changed with your plans?" matched
    // the old whole-message `sperm.*donor` pattern and got the sperm-SOURCE
    // options (My own | My partner's | Donor sperm) - answers to a different
    // question entirely.
    if (quickReplies.length === 0 && finalContent.trim().endsWith("?")) {
      const qLines = finalContent.trim().split(/\n+/);
      const qText = qLines[qLines.length - 1] || finalContent;
      // Sperm source question - context-aware options (never "My own" for female parents)
      if (/for sperm|using your own.*sperm|sperm.*your own|your plan for sperm|will you be using.*sperm|whose sperm/i.test(qText)) {
        if (isFemaleGender) {
          // Female parent: her partner's sperm OR donor sperm. Never "My own" - women don't produce sperm.
          quickReplies = ["My partner's sperm", "Donor sperm", "Not sure yet"];
        } else if (isGayMale) {
          // Gay male couple: partner's, own, or donor
          quickReplies = ["My own", "My partner's", "Donor sperm", "Not sure yet"];
        } else {
          // Straight male or unknown: own or donor
          quickReplies = ["My own", "Donor sperm", "Not sure yet"];
        }
        console.log(`[QUICK_REPLY FALLBACK] Injected sperm source options (female=${isFemaleGender})`);
      // Egg source question - context-aware options based on gender
      } else if (/plan for eggs|what.*eggs.*partner|thinking.*eggs|eggs.*donor|eggs.*plan|your plan for eggs/i.test(qText)) {
        if (isFemaleGender) {
          // Female speaker: can use own eggs. In straight couple her partner is male (no eggs),
          // so no "My partner's eggs". In lesbian couple partner CAN provide eggs but we show
          // same set since the question will clarify.
          const isStraightCouple = /familyType.*straight_couple/i.test(JSON.stringify(profile || {})) ||
            chatHistory.some((m: any) => m.role === "user" && /\b(man and a woman|a woman and a man|woman and a man)\b/i.test(m.content || ""));
          quickReplies = isStraightCouple
            ? ["My own eggs", "Donor eggs", "I'm not sure yet"]
            : ["My own eggs", "My partner's eggs", "Donor eggs", "I'm not sure yet"];
        } else {
          // Male speaker in straight couple: partner (female) can provide eggs, or donor
          quickReplies = ["My partner's eggs", "Donor eggs", "I'm not sure yet"];
        }
        console.log(`[QUICK_REPLY FALLBACK] Injected egg source options (female=${isFemaleGender})`);
      } else if (/are you hoping (?:for twins|to have twins)|hoping for twins.*singleton/i.test(qText)) {
        quickReplies = ["Hoping for twins", "Singleton only", "No preference"];
        console.log("[QUICK_REPLY FALLBACK] Injected twins options");
      } else if (/first ivf journey.*done ivf before|is this your first ivf|have you done ivf before/i.test(qText)) {
        quickReplies = ["First time", "I've done IVF before"];
        console.log("[QUICK_REPLY FALLBACK] Injected first IVF options");
      } else if (/most important.*choosing a clinic|matters most.*clinic|important.*when choosing/i.test(qText)) {
        quickReplies = ["Success rates", "Location", "Cost", "Volume of cycles", "Physician gender"];
        multiSelect = true;
        console.log("[QUICK_REPLY FALLBACK] Injected clinic priority MULTI_SELECT options (A5)");
      } else if (/what.*preferences.*termination|preferences.*termination.*medically|termination if medically/i.test(qText)) {
        quickReplies = ["Pro-choice surrogate", "Pro-life surrogate", "No preference"];
        console.log("[QUICK_REPLY FALLBACK] Injected termination preference options");
      } else if (/lgbtq/i.test(qText)) {
        quickReplies = ["Yes", "No"];
        console.log("[QUICK_REPLY FALLBACK] Injected Yes|No for LGBTQ+ question");
      } else if (/going on this journey|who.{0,20}journey|journey.{0,20}who/i.test(qText)) {
        quickReplies = ["Solo woman", "Solo man", "Two moms", "Two dads", "A woman and a man"];
        console.log("[QUICK_REPLY FALLBACK] Injected identity options for journey question");
      } else if (/already have.{0,20}frozen embryos|frozen embryos.{0,20}already/i.test(qText)) {
        quickReplies = ["Yes, I do", "No, not yet", "Working to create them"];
        console.log("[QUICK_REPLY FALLBACK] Injected embryo options");
      } else if (/pgt.{0,5}a tested|been tested/i.test(qText)) {
        quickReplies = ["Yes", "No", "I'm not sure"];
        console.log("[QUICK_REPLY FALLBACK] Injected PGT-A tested options");
      } else if (/already have.{0,20}(fertility clinic|ivf clinic|clinic)|help finding.{0,20}(clinic|one)/i.test(qText)) {
        quickReplies = ["I need help finding one", "I already have one"];
        console.log("[QUICK_REPLY FALLBACK] Injected clinic options");
      } else if (/does that make sense|make sense so far/i.test(qText)) {
        quickReplies = ["Yes, makes sense!", "I have a question"];
        console.log("[QUICK_REPLY FALLBACK] Injected sense-check options");
      } else if (/questions about gostork|questions.{0,30}help you/i.test(qText)) {
        quickReplies = ["I understand, let's get started", "I have a few questions"];
        console.log("[QUICK_REPLY FALLBACK] Injected GoStork intro options");
      }
    }

    // Correct sperm QR options for female parents - "My own" is biologically impossible.
    // The inject patterns are gender-blind so they include "My own" for all parents.
    // For a female in a straight couple, replace with "My partner's sperm".
    if (isFemaleGender && quickReplies.some(qr => /^my own$/i.test(qr)) &&
        /for sperm|sperm.*your own|using.*sperm|sperm donor/i.test(finalContent)) {
      quickReplies = quickReplies.map(qr => /^my own$/i.test(qr) ? "My partner's sperm" : qr);
      console.log("[SPERM QR FIX] Replaced 'My own' with 'My partner's sperm' for female parent");
    }

    let showCuration = false;
    if (finalContent.includes("[[CURATION]]")) {
      showCuration = true;
      finalContent = finalContent.replace(/\[\[CURATION\]\]/g, "").trim();
    }

    // Post-processor: Detect summary/confirmation messages ("just to confirm your preferences
    // before I search for surrogates:...") that are missing the mandatory question + quick replies.
    // The AI should always end curation summaries with a question and [[CURATION]], but sometimes
    // forgets both. Inject them so the conversation never dead-ends silently.
    // CRITICAL: Only fire for ACTUAL CURATION summaries that list collected preferences.
    // NOT for Phase 3 intake questions that just happen to say "confirm" before asking A1/B1/etc.
    // A true CURATION summary: summarizes multiple preferences AND asks if parent is ready.
    const isMatchCycleSummary = /surrogate|egg donor|sperm donor|ivf clinic|fertility clinic/i.test(finalContent);
    // Require the summary to actually contain preference descriptions (not just ask one question)
    const looksLikeCurationSummary = (
      /\b(you're looking for|here's what i have|you've mentioned|you'd like|looking for a|your preference[s]?|to summarize|let me summarize|you want)\b/i.test(finalContent) &&
      /\b(ready|shall i|want me to|can i|would you like|ready to see)\b/i.test(finalContent)
    );
    if (quickReplies.length === 0 && isMatchCycleSummary && looksLikeCurationSummary && /just to confirm|to confirm your preferences|let me confirm|just to recap/i.test(finalContent)) {
      const isForSurrogate = /surrogate/i.test(finalContent);
      const isForEggDonor = /egg donor/i.test(finalContent);
      const isForSpermDonor = /sperm donor/i.test(finalContent);
      const serviceLabel = isForSurrogate ? "surrogates" : isForEggDonor ? "egg donors" : isForSpermDonor ? "sperm donors" : "matches";
      if (!showCuration) {
        showCuration = true;
        prisma.aiChatSession.update({
          where: { id: currentSessionId },
          data: { tier2Active: true },
        }).catch((e: any) => console.error("[CONFIRM POST-PROC] Failed to activate tier2:", e));
      }
      if (!finalContent.trimEnd().endsWith("?")) {
        finalContent = `${finalContent.trimEnd()} Are you ready to see your ${serviceLabel}?`;
      }
      quickReplies = ["Yes, let's go!", "Let me adjust my preferences"];
      console.log("[CONFIRM POST-PROC] Injected CURATION + quick replies for confirmation summary");
    }

    let matchCards: any[] = [];
    // Track AI-emitted cards that were rejected for missing required fields - the fallback
    // below can use the AI's intent (mentioned type/id) to repair them from tool results.
    let aiAttemptedTags = 0;
    const matchCardRegex = /\[\[MATCH_CARD:([\s\S]*?)\]\]/g;
    let mcMatch;
    while ((mcMatch = matchCardRegex.exec(finalContent)) !== null) {
      aiAttemptedTags++;
      try {
        const parsed = JSON.parse(mcMatch[1]);
        if (!parsed) continue;
        // Accept `id` / `entityId` as fallbacks when AI used the wrong field
        // name for providerId, and `entityType` for type. Seen in the wild:
        // {"entityId": "<profile uuid>", "entityType": "Surrogate"} - a fully
        // usable card that was being skipped for "missing required fields".
        if (!parsed.providerId && parsed.id) parsed.providerId = parsed.id;
        if (!parsed.providerId && parsed.entityId) parsed.providerId = parsed.entityId;
        if (!parsed.type && parsed.entityType) parsed.type = parsed.entityType;
        // Gate-blocked turn: the D-cycle is still collecting preferences, so a surrogate
        // card is premature by design (SEARCH GATE) no matter where the model got the id.
        if (surrogateCardGateActive && /surrogate/i.test(String(parsed.type || ""))) {
          console.log(`[SEARCH GATE] Suppressed premature surrogate MATCH_CARD (${parsed.providerId || parsed.name || "?"}) - D-cycle incomplete`);
          continue;
        }
        // Repair the classic field swap: the model sometimes puts the AGENCY
        // id in providerId and the actual profile UUID in entityId - the
        // client then fetches a profile with the agency id and renders
        // "Profile unavailable". If providerId matches a Provider row and
        // entityId is a UUID, swap them (and keep the agency as owner).
        const mcLooksUuid = (v: any) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v);
        if (mcLooksUuid(parsed.providerId) && mcLooksUuid(parsed.entityId) && parsed.entityId !== parsed.providerId) {
          const agencyRow = await prisma.provider.findUnique({ where: { id: parsed.providerId }, select: { id: true } }).catch(() => null);
          if (agencyRow) {
            parsed.ownerProviderId = parsed.ownerProviderId || parsed.providerId;
            parsed.providerId = parsed.entityId;
            console.log(`[ai-router] MATCH_CARD repaired swapped providerId/entityId (profile=${parsed.providerId})`);
          }
        }
        // Verify a profile-type card's providerId is actually a PROFILE row.
        // The model sometimes puts the AGENCY id in providerId with no
        // entityId at all (seen post-handoff: card said "Surrogate #23062"
        // but carried Family Creations' provider id) - the client then
        // fetches /marketplace/profile/surrogate/<agency-id>, 404s, and
        // renders "Profile unavailable". Resolve the real profile from the
        // display number in the card name; if unresolvable, drop the card so
        // the search-results fallback rebuilds it from DB truth.
        {
          const profileModelByType: Record<string, any> = {
            "surrogate": prisma.surrogate,
            "egg donor": prisma.eggDonor,
            "sperm donor": prisma.spermDonor,
          };
          const typeKey = String(parsed.type || "").toLowerCase();
          const profileModel = profileModelByType[typeKey];
          if (profileModel && mcLooksUuid(parsed.providerId)) {
            const asProfile = await profileModel.findUnique({ where: { id: parsed.providerId }, select: { id: true } }).catch(() => null);
            if (!asProfile) {
              const agencyRow = await prisma.provider.findUnique({ where: { id: parsed.providerId }, select: { id: true } }).catch(() => null);
              const displayNum = String(parsed.name || "").match(/#\s*(\d{2,})/);
              let repaired: any = null;
              if (displayNum) {
                repaired = agencyRow
                  ? await profileModel.findFirst({ where: { externalId: displayNum[1], providerId: agencyRow.id }, select: { id: true, providerId: true } }).catch(() => null)
                  : null;
                if (!repaired) {
                  repaired = await profileModel.findFirst({ where: { externalId: displayNum[1] }, select: { id: true, providerId: true } }).catch(() => null);
                }
              }
              if (repaired) {
                parsed.ownerProviderId = parsed.ownerProviderId || repaired.providerId || (agencyRow ? agencyRow.id : undefined);
                parsed.providerId = repaired.id;
                console.log(`[ai-router] MATCH_CARD repaired agency-id card via display number #${displayNum?.[1]} (profile=${parsed.providerId})`);
              } else {
                console.warn(`[ai-router] MATCH_CARD providerId is not a ${typeKey} profile (${parsed.providerId}) and no repair found - dropping card for fallback`);
                continue;
              }
            }
          }
        }
        // Reject invalid providerIds - these are not real DB UUIDs:
        // - Numeric only (display number like "23069")
        // - Looks like a name (only letters, short - e.g. "Sarah", "John")
        // - Too short to be a UUID (UUIDs are 36 chars with hyphens)
        const pid = String(parsed.providerId || "");
        const providerIdIsNumeric = pid && /^\d+$/.test(pid);
        const providerIdLooksLikeName = pid && /^[a-zA-Z\s]+$/.test(pid) && pid.length < 30;
        if (providerIdIsNumeric || providerIdLooksLikeName) {
          console.warn(`[ai-router] MATCH_CARD has invalid providerId (${pid}) - name or display number, using fallback`);
        } else if (parsed.type && parsed.providerId) {
          matchCards.push(parsed);
        } else {
          console.warn("[ai-router] MATCH_CARD missing required fields (type/providerId), skipping:", parsed);
        }
      } catch (e) {
        console.error("Failed to parse MATCH_CARD:", e);
      }
    }
    finalContent = finalContent.replace(/\[\[MATCH_CARD:[\s\S]*?\]\]/g, "").trim();

    // DOCTOR_CARD: parse the doctor-recommendation tags (just {slug, reasons}) and
    // strip them here, same as MATCH_CARD. The cards are RESOLVED below (after the
    // clinic-card block) via resolve_doctor_card so the displayed data is DB-truth.
    const doctorCardTags: { slug: string; reasons?: string[] }[] = [];
    const doctorCardRegex = /\[\[DOCTOR_CARD:([\s\S]*?)\]\]/g;
    let docMatch;
    while ((docMatch = doctorCardRegex.exec(finalContent)) !== null) {
      try {
        const parsed = JSON.parse(docMatch[1]);
        const slug = parsed && (parsed.slug || parsed.id);
        if (slug && typeof slug === "string") {
          doctorCardTags.push({ slug, reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [] });
        } else {
          console.warn("[ai-router] DOCTOR_CARD missing slug, skipping:", parsed);
        }
      } catch (e) {
        console.error("Failed to parse DOCTOR_CARD:", e);
      }
    }
    finalContent = finalContent.replace(/\[\[DOCTOR_CARD:[\s\S]*?\]\]/g, "").trim();
    let doctorCards: any[] = [];

    // COMPARE_CARD: parse side-by-side comparison tags ({entityType, entities[],
    // dimensions}) and strip them here. RESOLVED below via resolve_comparison so
    // every number/value rendered is DB-truth, never model output.
    const compareCardTags: { entityType: string; entities: string[]; dimensions: any }[] = [];
    const compareCardRegex = /\[\[COMPARE_CARD:([\s\S]*?)\]\]/g;
    let cmpTagMatch;
    while ((cmpTagMatch = compareCardRegex.exec(finalContent)) !== null) {
      try {
        const parsed = JSON.parse(cmpTagMatch[1]);
        const entities = Array.isArray(parsed?.entities) ? parsed.entities.map((e: any) => String(e)).filter(Boolean) : [];
        if (parsed?.entityType && entities.length >= 2) {
          compareCardTags.push({ entityType: String(parsed.entityType), entities, dimensions: parsed.dimensions ?? "all" });
        } else {
          console.warn("[ai-router] COMPARE_CARD missing entityType or <2 entities, skipping:", parsed);
        }
      } catch (e) {
        console.error("Failed to parse COMPARE_CARD:", e);
      }
    }
    finalContent = finalContent.replace(/\[\[COMPARE_CARD:[\s\S]*?\]\]/g, "").trim();
    let comparisonCards: any[] = [];

    // CLINIC CARD GUARD: a clinic MATCH_CARD's providerId MUST belong to a clinic
    // the AI actually looked up this turn - either via search_clinics OR via
    // get_provider_profile (a profile Q&A like "what are X's success rates?").
    // The model sometimes answers correctly in prose about clinic A while emitting
    // a card whose providerId is clinic B (a clinic mentioned earlier, or simply
    // hallucinated) - so the parent sees the wrong clinic's card. Validate every
    // clinic card against the looked-up clinics and repair it to the clinic named
    // in the prose (falling back to the single looked-up clinic / top result).
    if (matchCards.some((c) => String(c.type || "").toLowerCase() === "clinic")) {
      const clinicResults: any[] = [];
      for (const sr of lastSearchToolResults) {
        if (sr.toolName === "search_clinics") {
          try {
            const body: string = sr.resultText || "";
            const s = body.indexOf("[");
            const e = body.lastIndexOf("]");
            const arr = s !== -1 && e !== -1 ? JSON.parse(body.substring(s, e + 1)) : [];
            if (Array.isArray(arr)) clinicResults.push(...arr);
          } catch { /* ignore */ }
        } else if (sr.toolName === "get_provider_profile") {
          // get_provider_profile returns a single JSON object (not an array).
          // Parse it so the clinic the parent asked about counts as valid AND
          // becomes the repair target for a mis-emitted card.
          try {
            const body: string = sr.resultText || "";
            const s = body.indexOf("{");
            const e = body.lastIndexOf("}");
            const obj = s !== -1 && e !== -1 ? JSON.parse(body.substring(s, e + 1)) : null;
            if (obj && obj.id) {
              clinicResults.push({ id: obj.id, name: obj.name, location: Array.isArray(obj.locations) ? obj.locations[0] : undefined });
            }
          } catch { /* ignore */ }
        }
      }
      if (clinicResults.length > 0) {
        const validIds = new Set(clinicResults.map((c: any) => String(c.id || c.providerId)));
        const plain = finalContent.replace(/\*\*/g, "").toLowerCase();
        for (const card of matchCards) {
          if (String(card.type || "").toLowerCase() !== "clinic") continue;
          if (validIds.has(String(card.providerId))) continue;
          const repaired =
            clinicResults.find((c: any) => {
              const n = String(c.name || c.displayName || "").toLowerCase();
              return n.length > 3 && plain.includes(n);
            }) || clinicResults[0];
          const newId = String(repaired.id || repaired.providerId || "");
          if (!newId) continue;
          console.warn(`[ai-router] CLINIC CARD GUARD: card providerId ${card.providerId} (${card.name}) is NOT a clinic looked up this turn - repairing to ${repaired.name} (${newId})`);
          card.providerId = newId;
          card.ownerProviderId = newId;
          card.name = repaired.name || repaired.displayName || card.name;
          card.location = repaired.location || card.location || "";
          card.photo = ""; // force re-resolve below
        }
      }
    }

    // Skip the MATCH_CARD fallback entirely when the AI emitted DOCTOR_CARD tags -
    // a doctor recommendation is its own card type, not a missing MATCH_CARD.
    if (matchCards.length === 0 && doctorCardTags.length === 0 && lastSearchToolResults.length > 0) {
      // Tolerant tool-result parser: MCP search results sometimes carry raw
      // control chars inside string fields (invalid JSON) and/or extra JSON
      // blocks after the results array - the old indexOf("[")/lastIndexOf("]")
      // slice threw on both, silently killing the card fallback. Sanitize
      // control chars (safe: they are whitespace outside strings and invalid
      // inside them) and bracket-match the FIRST array only.
      const parseToolResultArray = (body: string): any[] => {
        if (!body) return [];
        const clean = body.replace(/[\u0000-\u001f]/g, " ");
        const start = clean.indexOf("[");
        if (start === -1) {
          try { const p = JSON.parse(clean); return Array.isArray(p) ? p : []; } catch { return []; }
        }
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < clean.length; i++) {
          const ch = clean[i];
          if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inStr = false;
            continue;
          }
          if (ch === '"') inStr = true;
          else if (ch === "[") depth++;
          else if (ch === "]") {
            depth--;
            if (depth === 0) {
              try { const p = JSON.parse(clean.substring(start, i + 1)); return Array.isArray(p) ? p : []; } catch { return []; }
            }
          }
        }
        return [];
      };
      const matchIntroPattern = /(?:meet|introducing|found|here(?:'s| is)|check (?:out|her|his|their)|i(?:'ve| have) (?:got|a)|first up|special to show|great (?:fit|match|option|choice|pick)|perfect (?:fit|match|option|choice)|top (?:option|pick|choice)|premier|recommend|someone.*really|stands?\s*out|option for you|show you)/i;
      // Most robust signal: the AI named one of the just-searched providers in its
      // prose (e.g. "Reproductive Medicine Associates ... is a premier option").
      // If a search result's name appears in the text, the AI is recommending that
      // provider and a card MUST be created even if the intro phrasing did not match.
      const plainForName = finalContent.replace(/\*\*/g, "").toLowerCase();
      let resultNameInProse = false;
      for (const sr of lastSearchToolResults) {
        try {
          const arr = parseToolResultArray(sr.resultText || "");
          if (Array.isArray(arr) && arr.some((r: any) => {
            const n = String(r?.name || r?.displayName || "").toLowerCase();
            return n.length > 4 && plainForName.includes(n);
          })) { resultNameInProse = true; break; }
        } catch { /* ignore */ }
      }
      // Trigger the fallback if the AI (a) tried to emit a tag but malformed it,
      // (b) introduced a match in prose, or (c) named a searched provider.
      const shouldRepair = aiAttemptedTags > 0 || matchIntroPattern.test(finalContent) || resultNameInProse;
      if (shouldRepair) {
        console.log(`[MATCH_CARD FALLBACK] AI introduced a match but forgot/malformed [[MATCH_CARD:...]] tag (attemptedTags=${aiAttemptedTags}) - attempting auto-creation from tool results`);
        const mentionedNameMatch = finalContent.match(/(?:Surrogate|Donor|Clinic)\s*#?(\d+)/i);
        const mentionedFirstName = finalContent.match(/(?:Meet|introducing)\s+(\w+)/i);
        // Strip markdown bold markers for name matching
        const plainContent = finalContent.replace(/\*\*/g, "").toLowerCase();

        for (const searchResult of lastSearchToolResults) {
          // Doctor results are not MATCH_CARD material - they render as DOCTOR_CARDs.
          if (searchResult.toolName === "search_doctors") continue;
          try {
            const results: any[] = parseToolResultArray(searchResult.resultText || "");

            if (results.length > 0) {
              const toolTypeMap: Record<string, string> = {
                search_surrogates: "Surrogate",
                search_egg_donors: "Egg Donor",
                search_sperm_donors: "Sperm Donor",
                search_clinics: "Clinic",
              };
              // find_lookalike_matches has no fixed type - it carries the entity
              // type in its args (Egg Donor / Sperm Donor / Surrogate).
              const cardType = searchResult.toolName === "find_lookalike_matches"
                ? (searchResult.toolArgs?.entityType || "Egg Donor")
                : (toolTypeMap[searchResult.toolName] || "Surrogate");
              // Gate-blocked turn: never manufacture a surrogate card mid-D-intake
              // (stale agency results otherwise become "Surrogate"-typed cards here).
              if (surrogateCardGateActive && /surrogate/i.test(cardType)) {
                console.log(`[SEARCH GATE] Suppressed fallback surrogate card from ${searchResult.toolName} - D-cycle incomplete`);
                continue;
              }

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
              // Also try matching by full name mentioned in the AI's message (handles clinics mentioned by name)
              if (matched === results[0] && results.length > 1) {
                const byFullName = results.find((r: any) => {
                  const name = (r.displayName || r.name || "").toLowerCase();
                  return name.length > 3 && plainContent.includes(name);
                });
                if (byFullName) matched = byFullName;
              }

              const idField = matched.id || matched.providerId;
              const cleanEid = matched.externalId ? matched.externalId.replace(/^[a-zA-Z]+-/, "") : null;
              const nameField = matched.displayName || matched.firstName || matched.name || (cleanEid ? `${cardType} #${cleanEid}` : `Match`);
              const locationField = matched.location || "";

              const reasons: string[] = [];
              if (searchResult.toolName === "find_lookalike_matches") {
                reasons.push("Strong facial resemblance");
                if (matched.eyeColor) reasons.push(`${matched.eyeColor} eyes`);
                if (matched.hairColor) reasons.push(`${matched.hairColor} hair`);
              }
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
                  reasons: reasons.slice(0, 6),
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

    // Deterministic top match for a fresh look-alike upload. The model tends to
    // skip profiles shown earlier in this (single, persistent) session and
    // present "another", but a NEW photo should surface the STRONGEST
    // resemblance. Force the top tool result as the card, and rewrite the blurb
    // if the model wrote about a different profile so text and card agree.
    if (isFreshLookalikeUpload) {
      const laResult = lastSearchToolResults.find((r) => r.toolName === "find_lookalike_matches");
      if (laResult) {
        try {
          const js = laResult.resultText.indexOf("[");
          const je = laResult.resultText.lastIndexOf("]");
          const arr = js !== -1 && je !== -1 ? JSON.parse(laResult.resultText.substring(js, je + 1)) : [];
          if (Array.isArray(arr) && arr.length > 0) {
            const top = arr[0];
            const laType = laResult.toolArgs?.entityType || "Egg Donor";
            const laReasons = ["Strong facial resemblance"];
            if (top.eyeColor) laReasons.push(`${top.eyeColor} eyes`);
            if (top.hairColor) laReasons.push(`${top.hairColor} hair`);
            matchCards = [{
              name: top.displayName || (laType === "Surrogate" ? "Surrogate" : "Donor"),
              type: laType,
              location: top.location || "",
              photo: "",
              reasons: laReasons.slice(0, 4),
              providerId: top.id,
            }];
            // Only rewrite the blurb when the model named a DIFFERENT specific
            // profile (conflict with the forced card). A generic blurb is fine
            // and left untouched, so the streamed text is not jarringly swapped.
            const cleanTok = ((top.displayName || "").split("#")[1] || "").replace(/[^0-9A-Za-z]/g, "").toLowerCase();
            const donorRefs = finalContent.match(/#\s*[A-Za-z]?\d{2,}/g) || [];
            const mentionsConflicting = donorRefs.some((ref) => {
              const r = ref.replace(/[^0-9A-Za-z]/g, "").toLowerCase();
              return cleanTok ? !(r.includes(cleanTok) || cleanTok.includes(r)) : true;
            });
            if (mentionsConflicting) {
              const bits = [top.age ? `${top.age}` : null, top.ethnicity || null, top.location || null].filter(Boolean).join(", ");
              finalContent = `I found a strong facial resemblance to the photo you uploaded - meet ${top.displayName}${bits ? ` (${bits})` : ""}. Would you like to schedule a free consultation to learn more, or see another option?`;
            }
            console.log(`[LOOK-ALIKE] Forced top-resemblance card ${top.displayName} (${top.id})`);
          }
        } catch (e) {
          console.error("[LOOK-ALIKE] top-match override failed:", e);
        }
      }
    }

    if (matchCards.length > 1) {
      console.warn(`[ai-router] AI returned ${matchCards.length} match cards - enforcing one-at-a-time rule, keeping first only`);
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

    // Ethnicity synonym map - "white" filter must match "caucasian" donors and vice versa.
    const MATCH_CARD_ETHNICITY_SYNONYMS: Record<string, string[]> = {
      "white": ["white", "caucasian"],
      "caucasian": ["caucasian", "white"],
      "asian": ["asian", "east asian", "south asian", "southeast asian"],
      "hispanic": ["hispanic", "latina", "latino", "latin"],
      "latina": ["latina", "hispanic", "latin"],
      "black": ["black", "african american", "african-american"],
      "african american": ["african american", "african-american", "black"],
      "middle eastern": ["middle eastern", "arab", "arabic"],
      "mixed": ["mixed", "biracial", "multiracial", "multi-racial"],
    };
    const resolveEthTerms = (eth: string): string[] =>
      MATCH_CARD_ETHNICITY_SYNONYMS[eth.toLowerCase()] || [eth.toLowerCase()];
    const matchesWordBoundary = (fieldVal: string, term: string) => {
      const esc = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z])${esc}($|[^a-z])`).test(fieldVal.toLowerCase());
    };
    const ethnicityMatchesField = (donorRace: string, donorEth: string, filterEthnicity: string): boolean => {
      const terms = resolveEthTerms(filterEthnicity);
      return terms.some(t => matchesWordBoundary(donorRace, t) || matchesWordBoundary(donorEth, t));
    };

    // For egg/sperm donor cards: always recompute reasons from actual search filters + donor data,
    // ignoring AI-generated reasons which often include profile highlights the parent never asked for
    // (e.g. "College degree", specific height value) rather than the actual matching preferences.
    for (const card of matchCards) {
      const cardTypeForDonor = (card.type || "").toLowerCase();
      if (cardTypeForDonor === "egg donor" || cardTypeForDonor === "sperm donor") {
        const donorSearchTool = cardTypeForDonor === "egg donor" ? "search_egg_donors" : "search_sperm_donors";
        const donorSearchResult = lastSearchToolResults.find(r => r.toolName === donorSearchTool);
        if (!donorSearchResult) continue;
        const donorArgs = donorSearchResult.toolArgs || {};
        const donorComputedReasons: string[] = [];
        let donorProfileData: any = null;
        try {
          const rb = donorSearchResult.resultText;
          const js = rb.indexOf("["); const je = rb.lastIndexOf("]");
          if (js !== -1 && je !== -1) {
            const results = JSON.parse(rb.substring(js, je + 1));
            donorProfileData = results.find((r: any) => String(r.id) === String(card.providerId) || String(r.externalId) === String(card.providerId) || String(r.providerId) === String(card.providerId));
          }
        } catch {}
        // Only add a reason if the parent explicitly requested it via args.
        // Validate against donor data only when the field is populated - if the field is empty,
        // trust the search tool already filtered correctly and still show the reason.
        if (donorArgs.eyeColor) {
          const eyeVal = donorProfileData?.eyeColor || "";
          if (!eyeVal || matchesWordBoundary(eyeVal, donorArgs.eyeColor)) {
            donorComputedReasons.push(`${donorArgs.eyeColor} eyes`);
          }
        }
        if (donorArgs.hairColor) {
          const hairVal = donorProfileData?.hairColor || "";
          if (!hairVal || matchesWordBoundary(hairVal, donorArgs.hairColor)) {
            donorComputedReasons.push(`${donorArgs.hairColor} hair`);
          }
        }
        if (donorArgs.ethnicity) {
          const donorRace = donorProfileData?.race || "";
          const donorEth = donorProfileData?.ethnicity || "";
          if (!donorRace && !donorEth) {
            // Fields empty - trust search tool filtering
            donorComputedReasons.push(`${donorArgs.ethnicity} ethnicity`);
          } else if (ethnicityMatchesField(donorRace, donorEth, donorArgs.ethnicity)) {
            donorComputedReasons.push(`${donorArgs.ethnicity} ethnicity`);
          } else {
            console.warn(`[MATCH_CARD] Skipping ethnicity "${donorArgs.ethnicity}" - donor race="${donorRace}" ethnicity="${donorEth}"`);
          }
        }
        if (donorArgs.minHeightInches) {
          const totalInches = Number(donorArgs.minHeightInches);
          const feet = Math.floor(totalInches / 12);
          const inches = totalInches % 12;
          const heightLabel = inches > 0 ? `${feet}'${inches}" and above` : `${feet}' and above`;
          const heightVal = donorProfileData?.heightInches;
          if (heightVal == null || Number(heightVal) >= totalInches) {
            donorComputedReasons.push(heightLabel);
          }
        }
        if (donorArgs.maxAge) {
          const ageVal = donorProfileData?.age;
          if (ageVal == null || Number(ageVal) <= Number(donorArgs.maxAge)) {
            donorComputedReasons.push(`Under ${donorArgs.maxAge} years old`);
          }
        }
        if (donorArgs.minAge) {
          const ageVal = donorProfileData?.age;
          if (ageVal == null || Number(ageVal) >= Number(donorArgs.minAge)) {
            donorComputedReasons.push(`${donorArgs.minAge}+ years old`);
          }
        }
        // Education: only show if parent explicitly asked for it (AI must pass args.education based on parent's stated preference)
        if (donorArgs.education) {
          const eduVal = donorProfileData?.education || "";
          if (!eduVal || matchesWordBoundary(eduVal, donorArgs.education)) {
            donorComputedReasons.push(`${donorArgs.education} education`);
          }
        }
        if (donorComputedReasons.length > 0) {
          card.reasons = donorComputedReasons.slice(0, 6);
        }
      }
    }

    // For surrogate cards: always recompute reasons from actual search filters + surrogate data,
    // ignoring AI-generated reasons which tend to include profile highlights the parent never asked for.
    for (const card of matchCards) {
      const cardTypeForSurrogate = (card.type || "").toLowerCase();
      if (cardTypeForSurrogate === "surrogate") {
        const searchResult = lastSearchToolResults.find(r => r.toolName === "search_surrogates");
        if (searchResult) {
          const args = searchResult.toolArgs || {};
          const computedReasons: string[] = [];
          try {
            const rb = searchResult.resultText;
            const js = rb.indexOf("["); const je = rb.lastIndexOf("]");
            if (js !== -1 && je !== -1) {
              const results = JSON.parse(rb.substring(js, je + 1));
              const matched = results.find((r: any) => String(r.id) === String(card.providerId) || String(r.externalId) === String(card.providerId) || String(r.providerId) === String(card.providerId));
              if (matched) {
                // Only add reasons for filters the parent ACTUALLY applied
                if (args.agreesToAbortion === true && (matched.agreesToAbortion || matched.agreesToSelectiveReduction)) computedReasons.push("Pro-choice");
                if (args.agreesToAbortion === false && matched.agreesToAbortion === false) computedReasons.push("Pro-life");
                if (args.agreesToTwins === true && matched.agreesToTwins) computedReasons.push("Open to twins");
                if (args.openToSameSexCouple === true && matched.openToSameSexCouple) computedReasons.push("Open to same-sex couples");
                if (args.isExperienced === true && matched.isExperienced) computedReasons.push("Experienced surrogate");
                if (args.maxAge != null && matched.age != null && Number(matched.age) <= Number(args.maxAge)) computedReasons.push(`Age ${matched.age}`);
                // Always include live births as a factual attribute (not a preference match)
                if (matched.liveBirths) computedReasons.push(`Mom of ${matched.liveBirths}`);
              }
            }
          } catch {}
          if (computedReasons.length > 0) {
            card.reasons = computedReasons.slice(0, 6);
          }
        }
      }
    }

    // Auto-populate reasons from search filters when the AI left reasons empty.
    for (const card of matchCards) {
      if (!card.reasons || card.reasons.length === 0) {
        const cardTypeLower = (card.type || "").toLowerCase();
        const searchToolName = cardTypeLower === "egg donor" ? "search_egg_donors"
          : cardTypeLower === "sperm donor" ? "search_sperm_donors"
          : cardTypeLower === "surrogate" ? "search_surrogates"
          : cardTypeLower === "clinic" ? "search_clinics" : null;

        if (searchToolName) {
          const searchResult = lastSearchToolResults.find(r => r.toolName === searchToolName);
          if (searchResult) {
            const args = searchResult.toolArgs || {};
            const autoReasons: string[] = [];

            if (cardTypeLower === "egg donor" || cardTypeLower === "sperm donor") {
              // Find actual donor data from search results to validate reasons against real profile
              let donorData: any = null;
              try {
                const rb = searchResult.resultText;
                const js = rb.indexOf("["); const je = rb.lastIndexOf("]");
                if (js !== -1 && je !== -1) {
                  const results = JSON.parse(rb.substring(js, je + 1));
                  donorData = results.find((r: any) => String(r.id) === String(card.providerId) || String(r.externalId) === String(card.providerId) || String(r.providerId) === String(card.providerId));
                }
              } catch {}
              const matchesField = (fieldVal: string, term: string) => {
                const esc = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                return new RegExp(`(^|[^a-z])${esc}($|[^a-z])`).test(fieldVal.toLowerCase());
              };
              if (args.eyeColor) {
                if (!donorData || matchesField(donorData.eyeColor || "", args.eyeColor)) autoReasons.push(`${args.eyeColor} eyes`);
              }
              if (args.hairColor) {
                if (!donorData || matchesField(donorData.hairColor || "", args.hairColor)) autoReasons.push(`${args.hairColor} hair`);
              }
              if (args.ethnicity) {
                // Validate ethnicity against actual race AND ethnicity fields - prevent "Asian" matching "Caucasian"
                if (!donorData || matchesField(donorData.race || "", args.ethnicity) || matchesField(donorData.ethnicity || "", args.ethnicity)) {
                  autoReasons.push(`${args.ethnicity} ethnicity`);
                } else {
                  console.warn(`[MATCH_CARD] Skipping invalid ethnicity reason "${args.ethnicity}" - donor race="${donorData.race}" ethnicity="${donorData.ethnicity}"`);
                }
              }
              if (args.education) {
                if (!donorData || matchesField(donorData.education || "", args.education)) autoReasons.push(`${args.education} education`);
              }
              if (args.maxAge) {
                if (!donorData || (donorData.age != null && Number(donorData.age) <= Number(args.maxAge))) autoReasons.push(`Under ${args.maxAge} years old`);
              }
              if (args.minAge) {
                if (!donorData || (donorData.age != null && Number(donorData.age) >= Number(args.minAge))) autoReasons.push(`${args.minAge}+ years old`);
              }
              if (args.minHeightInches) {
                // Convert inches to feet/inches display, e.g. 67 -> "5'7\""
                const totalInches = Number(args.minHeightInches);
                const feet = Math.floor(totalInches / 12);
                const inches = totalInches % 12;
                const heightLabel = inches > 0 ? `${feet}'${inches}" and above` : `${feet}' and above`;
                autoReasons.push(heightLabel);
              }
            } else if (cardTypeLower === "surrogate") {
              try {
                const resultBody = searchResult.resultText;
                const jsonStart = resultBody.indexOf("[");
                const jsonEnd = resultBody.lastIndexOf("]");
                if (jsonStart !== -1 && jsonEnd !== -1) {
                  const results = JSON.parse(resultBody.substring(jsonStart, jsonEnd + 1));
                  const matched = results.find((r: any) => String(r.id) === String(card.providerId) || String(r.externalId) === String(card.providerId) || String(r.providerId) === String(card.providerId));
                  if (matched) {
                    if (matched.agreesToTwins) autoReasons.push("Open to twins");
                    if (matched.agreesToAbortion || matched.agreesToSelectiveReduction) autoReasons.push("Pro-choice");
                    if (matched.isExperienced) autoReasons.push("Previous surrogacy experience");
                    if (matched.openToSameSexCouple) autoReasons.push("Open to same-sex couples");
                    if (matched.liveBirths) autoReasons.push(`Mom of ${matched.liveBirths}`);
                  }
                }
              } catch {}
            } else if (cardTypeLower === "clinic") {
              if (args.eggSource === "donor") autoReasons.push("Specializes in donor egg IVF");
              if (args.location) autoReasons.push(`Located in ${args.location}`);
            }

            if (autoReasons.length > 0) {
              card.reasons = autoReasons.slice(0, 6);
              console.log(`[MATCH_CARD] Auto-populated ${card.reasons.length} reasons for ${card.name || card.type}`);
            }
          }
        }
      }
    }

    // Validate AI-generated ethnicity/race reasons against actual donor data to prevent hallucinations
    // (e.g., AI saying "Asian ethnicity" for a Caucasian donor).
    for (const card of matchCards) {
      const cardTypeLower2 = (card.type || "").toLowerCase();
      if ((cardTypeLower2 === "egg donor" || cardTypeLower2 === "sperm donor") && card.reasons?.length > 0) {
        const searchToolName2 = cardTypeLower2 === "egg donor" ? "search_egg_donors" : "search_sperm_donors";
        const searchResult2 = lastSearchToolResults.find((r: any) => r.toolName === searchToolName2);
        if (searchResult2) {
          try {
            const rb = searchResult2.resultText;
            const js = rb.indexOf("["); const je = rb.lastIndexOf("]");
            if (js !== -1 && je !== -1) {
              const results = JSON.parse(rb.substring(js, je + 1));
              const donorData = results.find((r: any) => String(r.id) === String(card.providerId) || String(r.externalId) === String(card.providerId) || String(r.providerId) === String(card.providerId));
              if (donorData) {
                const donorRace = (donorData.race || "").toLowerCase();
                const donorEthnicity = (donorData.ethnicity || "").toLowerCase();
                // Use synonym resolution so "white" reason is valid for "caucasian" donor and vice versa
                const matchesEth = (term: string) => {
                  const terms = resolveEthTerms(term);
                  return terms.some(t => {
                    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    const re = new RegExp(`(^|[^a-z])${esc}($|[^a-z])`);
                    return re.test(donorRace) || re.test(donorEthnicity);
                  });
                };
                const before = card.reasons.length;
                card.reasons = card.reasons.filter((reason: string) => {
                  const rl = reason.toLowerCase();
                  if (rl.includes("ethnicity") || rl.includes("race") || rl.endsWith(" background")) {
                    const term = rl.replace(/\s*(ethnicity|race|background)\s*/g, "").trim();
                    if (term && !matchesEth(term)) {
                      console.warn(`[MATCH_CARD] Removing hallucinated reason "${reason}" - donor race="${donorData.race}" ethnicity="${donorData.ethnicity}"`);
                      return false;
                    }
                  }
                  return true;
                });
                if (card.reasons.length < before) {
                  console.log(`[MATCH_CARD] Validated reasons: removed ${before - card.reasons.length} invalid ethnicity reason(s) for ${card.name}`);
                }
              }
            }
          } catch {}
        }
      }
    }

    // Auto-inject clinic context into Clinic match cards from parent profile + chat history.
    // ALWAYS override AI values - the AI is unreliable at setting these correctly.
    for (const card of matchCards) {
      if ((card.type || "").toLowerCase() === "clinic") {
        // Step 1: Determine egg source - check ALL available signals
        let resolvedEggSource = "own_eggs";

        const genderCheck = (userRecord?.gender || "").toLowerCase();
        const orientationCheck = (userRecord?.sexualOrientation || "").toLowerCase();
        const relationCheck = (userRecord?.relationshipStatus || "").toLowerCase();
        // "female".includes("male") is true - check female first then exclude.
        const isFemaleParent = /\b(female|woman|girl)\b/.test(genderCheck) || genderCheck === "f";
        const isMaleParent = !isFemaleParent && (/\b(male|man|boy)\b/.test(genderCheck) || genderCheck === "m");
        const isGay = orientationCheck.includes("gay") || orientationCheck.includes("homosexual");
        const isSingleMale = isMaleParent && relationCheck.includes("single");
        const isGayCouple = isMaleParent && isGay;
        const profileEggSource = (profile?.eggSource || "").toLowerCase();

        // Signal 0 (strongest): Check what the AI actually passed to search_clinics
        const clinicSearchArgs = lastSearchToolResults.find(r => r.toolName === "search_clinics")?.toolArgs;
        const aiCalledWithDonor = clinicSearchArgs?.eggSource === "donor";
        const aiCalledWithOwn = clinicSearchArgs?.eggSource === "own_eggs";
        // Profile explicitly names an own/partner egg source (not donor)
        const profileSaysOwnPartner = !!profileEggSource && !profileEggSource.includes("donor") && (profileEggSource.includes("own") || profileEggSource.includes("partner"));

        // Signals in priority order. Explicit statements (search args, profile
        // eggSource) OUTRANK the needsEggDonor flag - that flag can be a stale
        // inference from a prior journey (service registration), and letting it
        // trump an explicit "Partner eggs" rendered donor-egg rates on a card
        // the AI had correctly searched as own-eggs (2026-07-16 bug).
        if (isGayCouple || isSingleMale) {
          // Biology first: no female partner means eggs must come from a donor
          resolvedEggSource = "donor";
        } else if (aiCalledWithDonor) {
          resolvedEggSource = "donor";
        } else if (profileEggSource.includes("donor")) {
          resolvedEggSource = "donor";
        } else if (aiCalledWithOwn) {
          resolvedEggSource = "own_eggs";
        } else if (profileSaysOwnPartner) {
          resolvedEggSource = "own_eggs";
        } else if (profile?.needsEggDonor === true) {
          // Weakest donor signal - only when nothing explicit contradicts it
          resolvedEggSource = "donor";
        } else if (profileEggSource) {
          // Any other explicit non-donor value (e.g. "Donated embryos") - same
          // own-eggs treatment the previous logic gave it
          resolvedEggSource = "own_eggs";
        } else {
          // Scan chat history for egg source answers AND identity clues
          for (let i = chatHistory.length - 1; i >= Math.max(0, chatHistory.length - 30); i--) {
            const c = (chatHistory[i].content || "").toLowerCase();
            if (chatHistory[i].role === "user") {
              if (/\bdonor eggs?\b|egg donor|\bneed.*egg donor\b/.test(c)) { resolvedEggSource = "donor"; break; }
              if (/\btwo dads?\b|\bgay\b|\btwo men\b|\bsingle dad\b|\bsingle father\b|\bsingle man\b/.test(c)) { resolvedEggSource = "donor"; break; }
              if (/\bmy (own )?eggs?\b|partner'?s eggs?\b|my eggs/i.test(c)) { resolvedEggSource = "own_eggs"; break; }
            }
            if (chatHistory[i].role === "assistant") {
              if (/since you'll need an egg donor|eggs? (?:must|will) come from a donor|you'll be working with an egg donor/i.test(c)) {
                resolvedEggSource = "donor"; break;
              }
            }
          }
        }
        card.eggSource = resolvedEggSource;
        console.log(`[CLINIC CARD] eggSource resolution: aiCalledWithDonor=${aiCalledWithDonor}, gender="${userRecord?.gender}", orientation="${userRecord?.sexualOrientation}", profileEggSource="${profile?.eggSource}", needsEggDonor=${profile?.needsEggDonor}, isGayCouple=${isGayCouple}, isSingleMale=${isSingleMale}, resolved="${resolvedEggSource}"`);

        // Step 2: Determine egg provider's age (shared helper - same derivation
        // the ready-turn server-side pre-search uses)
        const eggProviderAge = deriveEggProviderAge(chatHistory, userRecord, profile?.eggSource, isMaleParent, resolvedEggSource);

        if (resolvedEggSource === "donor") {
          // For donor eggs, age group and new patient status are irrelevant
          delete card.ageGroup;
          delete card.isNewPatient;
        } else if (eggProviderAge !== null) {
          card.ageGroup = ageToAgeGroup(eggProviderAge);
        } else {
          card.ageGroup = card.ageGroup || "under_35";
        }

        // Step 3: Determine isNewPatient (shared helper; skip for donor eggs - not relevant)
        if (resolvedEggSource !== "donor") {
          card.isNewPatient = deriveIsNewPatient(chatHistory) ?? false;
        }

        // Step 4: Build the label
        const ageLbl = card.ageGroup === "under_35" ? "Under 35" : card.ageGroup === "35_37" ? "35-37" : card.ageGroup === "38_40" ? "38-40" : "Over 40";
        card.successRateLabel = card.eggSource === "donor"
          ? "Donor eggs"
          : `Own eggs · ${ageLbl} · ${card.isNewPatient ? "First-time IVF" : "Prior cycles"}`;

        console.log(`[CLINIC CARD ENRICHMENT] eggSource=${card.eggSource}, ageGroup=${card.ageGroup}, isNewPatient=${card.isNewPatient}, eggProviderAge=${eggProviderAge}, label=${card.successRateLabel}`);
      }
    }

    let consultationCard: any = null;

    const consultationMatch = finalContent.match(/\[\[CONSULTATION_BOOKING:(.*?)\]\]/);
    if (consultationMatch) {
      let consultProviderId = consultationMatch[1].trim();
      console.log(`[CONSULTATION] Processing CONSULTATION_BOOKING for providerId="${consultProviderId}"`);
      if (!consultProviderId) {
        console.warn("[CONSULTATION] Empty provider ID in CONSULTATION_BOOKING tag");
      }
      // Guard: the AI sometimes carries forward an earlier provider's ID (e.g., a previously
      // booked Sperm Bank) when the parent is actually trying to book a different agency
      // (e.g., the egg donor's agency that was just shown). Override with the latest match
      // card's ownerProviderId when they disagree - the latest card is what the parent is
      // looking at right now.
      if (currentSessionId) {
        try {
          const latestMc = await findLatestMatchCard(currentSessionId);
          const correctOwnerId = latestMc?.ownerProviderId || null;
          if (correctOwnerId && correctOwnerId !== consultProviderId) {
            // EXCEPTION - international program second call: a CountryProgram
            // card's ownerProviderId is the surrogacy agency, but the parent's
            // program also includes a partner IVF clinic. When the AI is
            // intentionally booking that partner clinic (the second of the two
            // sequential calls), consultProviderId is a legitimate partner of
            // the agency - do NOT rewrite it back to the agency.
            let isPartnerClinic = false;
            try {
              const acctIds = userRecord?.parentAccountId
                ? (await prisma.user.findMany({ where: { parentAccountId: userRecord.parentAccountId }, select: { id: true } })).map((u) => u.id)
                : [userId];
              const partners = await getProgramPartnerClinics(correctOwnerId, acctIds);
              isPartnerClinic = partners.some((p) => p.id === consultProviderId);
            } catch { /* fall through to override */ }
            if (isPartnerClinic) {
              console.log(`[CONSULTATION] Keeping partner IVF clinic id "${consultProviderId}" - it is a partner of program agency "${correctOwnerId}" (international two-call flow); not overriding.`);
            } else {
              console.warn(`[CONSULTATION] Provider ID mismatch: AI used "${consultProviderId}" but latest match card's ownerProviderId is "${correctOwnerId}". Overriding to latest match card's agency.`);
              consultProviderId = correctOwnerId;
            }
          }
        } catch (e) {
          console.error("[CONSULTATION] Error validating providerId against latest match card:", e);
        }
      }

      // INTERNATIONAL PROGRAM - SECOND-LEG REDIRECT (deterministic): an
      // international surrogacy agency is paired with a partner IVF/egg-donor
      // clinic (Provider.partnerProviderIds). The parent books the two calls
      // sequentially - the agency first, then the clinic. The model reliably
      // re-emits the AGENCY id for BOTH bookings, so we detect the second leg
      // server-side: if this session has ALREADY shown a booking card for this
      // exact agency and a partner clinic is still unbooked, this booking is the
      // clinic leg - redirect to the first unbooked partner clinic. Once both
      // legs are booked (no unbooked partner), the agency id stays as-is.
      if (currentSessionId && consultProviderId) {
        try {
          const acctIds = userRecord?.parentAccountId
            ? (await prisma.user.findMany({ where: { parentAccountId: userRecord.parentAccountId }, select: { id: true } })).map((u) => u.id)
            : [userId];
          const partners = await getProgramPartnerClinics(consultProviderId, acctIds);
          const unbooked = partners.filter((p) => !p.booked);
          if (unbooked.length > 0) {
            const priorAgencyCard = await prisma.aiChatMessage.findFirst({
              where: {
                sessionId: currentSessionId,
                uiCardData: { path: ["consultationCard", "providerId"], equals: consultProviderId },
              },
              select: { id: true },
            });
            if (priorAgencyCard) {
              console.log(`[CONSULTATION] International program second leg: agency "${consultProviderId}" already has a booking card in this session -> redirecting to partner IVF clinic "${unbooked[0].id}" (${unbooked[0].name}).`);
              consultProviderId = unbooked[0].id;
            }
          }
        } catch (e) {
          console.error("[CONSULTATION] Partner-clinic second-leg redirect failed:", e);
        }
      }

      // Phase 7B deterministic guard: a handed-off journey never gets a new
      // consultation card for that provider, no matter what the model emitted.
      try {
        const me = await prisma.user.findUnique({ where: { id: userId }, select: { parentAccountId: true } });
        const ids = me?.parentAccountId
          ? (await prisma.user.findMany({ where: { parentAccountId: me.parentAccountId }, select: { id: true } })).map((u) => u.id)
          : [userId];
        const handedOff = await prisma.aiChatSession.findFirst({
          where: { userId: { in: ids }, providerId: consultProviderId, handoffCompletedAt: { not: null } },
          select: { id: true },
        });
        if (handedOff) {
          console.log(`[CONSULTATION] Provider ${consultProviderId} journey is handed off - dropping consultation card`);
          consultProviderId = "";
        }
      } catch { /* fail open - the directive still guards */ }
      try {
        const cpResult = await mcpClient!.callTool({
          name: "resolve_provider",
          arguments: { providerId: consultProviderId },
        });
        const consultProvider = JSON.parse((cpResult.content as any)?.[0]?.text || "{}");
        console.log(`[CONSULTATION] resolve_provider result: ${JSON.stringify({ id: consultProvider?.id, name: consultProvider?.name, error: consultProvider?.error }).slice(0, 200)}`);
        if (consultProvider && !consultProvider.error) {
          let memberBookingSlug: string | null = null;
          let memberName: string | null = null;
          let memberPhoto: string | null = null;
          try {
            const memberWithBooking = await prisma.user.findFirst({
              where: {
                providerId: consultProviderId,
                scheduleConfig: { bookingPageSlug: { not: null } },
              },
              select: {
                name: true,
                photoUrl: true,
                scheduleConfig: { select: { bookingPageSlug: true } },
              },
            });
            if (memberWithBooking?.scheduleConfig?.bookingPageSlug) {
              memberBookingSlug = memberWithBooking.scheduleConfig.bookingPageSlug;
              memberName = memberWithBooking.name;
              memberPhoto = memberWithBooking.photoUrl;
              console.log(`[CONSULTATION] Found provider member booking slug: ${memberBookingSlug} for ${memberName}`);
            }
          } catch (e) {
            console.error("[CONSULTATION] Error finding member booking slug:", e);
          }

          consultationCard = {
            providerId: consultProvider.id,
            providerName: consultProvider.name,
            providerLogo: consultProvider.logoUrl,
            bookingUrl: memberBookingSlug ? `/book/${memberBookingSlug}` : consultProvider.consultationBookingUrl,
            iframeEnabled: true,
            providerEmail: consultProvider.email,
            memberBookingSlug,
            memberName,
            memberPhoto,
          };
          console.log(`[CONSULTATION] Card built: slug=${memberBookingSlug}, bookingUrl=${consultationCard.bookingUrl}, provider=${consultProvider.name}`);

          // Compute profile label and attach metadata to consultationCard.
          // The 3-way chat session is created LATER when the parent actually books via the calendar.
          if (currentSessionId) {
            let profileLabel: string | null = null;
            let profilePhotoUrl: string | null = null;
            let subjectProfileId: string | null = null;
            let subjectType: string | null = null;
            try {
              const richMessages = await prisma.aiChatMessage.findMany({
                where: { sessionId: currentSessionId, uiCardType: "rich" },
                orderBy: { createdAt: "desc" },
                take: 20,
                select: { uiCardData: true },
              });
              for (const msg of richMessages) {
                const cards = (msg.uiCardData as any)?.matchCards || [];
                const matched = cards.find((c: any) => c.ownerProviderId === consultProviderId || c.providerId === consultProviderId);
                if (matched?.name) {
                  profileLabel = matched.name;
                  if (matched.photo) profilePhotoUrl = matched.photo;
                  subjectProfileId = matched.providerId || null;
                  subjectType = matched.type || null;
                  break;
                }
              }
              if (!profileLabel) {
                const mc = await findLatestMatchCard(currentSessionId);
                if (mc?.name) profileLabel = mc.name;
                if (mc?.photo || mc?.photoUrl) profilePhotoUrl = mc.photo || mc.photoUrl;
                if (mc?.providerId) subjectProfileId = mc.providerId;
                if (mc?.type) subjectType = mc.type;
              }
            } catch (e) {
              console.error("[CONSULTATION] Error finding match card for profile label:", e);
            }

            const currentSession = await prisma.aiChatSession.findUnique({
              where: { id: currentSessionId },
              select: { providerId: true, matchmakerId: true },
            });

            let enrichedLabel = profileLabel;
            if (profileLabel && !profileLabel.match(/#\d+/) && profileLabel.match(/^(Egg Donor|Surrogate|Sperm Donor|Donor)$/i)) {
              try {
                const richMessages = await prisma.aiChatMessage.findMany({
                  where: { sessionId: currentSessionId, uiCardType: "rich" },
                  orderBy: { createdAt: "desc" },
                  take: 20,
                  select: { uiCardData: true },
                });
                for (const msg of richMessages) {
                  const cards = (msg.uiCardData as any)?.matchCards || [];
                  const matched = cards.find((c: any) => c.ownerProviderId === consultProviderId || c.providerId === consultProviderId);
                  if (matched?.providerId) {
                    const resolveResult = await mcpClient!.callTool({
                      name: "resolve_match_card",
                      arguments: { entityId: matched.providerId, entityType: matched.type || profileLabel },
                    });
                    const resolved = JSON.parse((resolveResult.content as any)?.[0]?.text || "{}");
                    if (resolved.name && resolved.name.match(/#\d+/)) {
                      enrichedLabel = resolved.name;
                    }
                    break;
                  }
                }
              } catch (e) {
                console.error("[CONSULTATION] Error enriching profile label with external ID:", e);
              }
            }

            const sessionTitle = enrichedLabel || profileLabel || null;
            // Attach metadata so the booking flow can create the 3-way session later
            consultationCard.aiSessionId = currentSessionId;
            consultationCard.matchmakerId = currentSession?.matchmakerId || null;
            consultationCard.profileLabel = sessionTitle;
            consultationCard.profilePhotoUrl = profilePhotoUrl;
            consultationCard.subjectProfileId = subjectProfileId;
            consultationCard.subjectType = subjectType;

            // AGENCY NAME CONFIDENTIALITY (pre-booking): until the parent actually
            // books the call (3-way chat created), the card must not reveal which
            // agency represents the surrogate/donor - name, logo, email domain, or
            // the coordinator's surname. Applies ONLY to donor/surrogate agencies;
            // clinics, lawyers, and GoStork are direct providers whose names are
            // always visible. Full names appear post-booking in the 3-way chat.
            try {
              const CONFIDENTIAL_AGENCY_TYPES = ["Surrogacy Agency", "Egg Donor Agency"];
              const svcTypes = await prisma.provider.findUnique({
                where: { id: consultProvider.id },
                select: { services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } } },
              });
              const isConfidentialAgency = !!svcTypes?.services?.some((s: any) => CONFIDENTIAL_AGENCY_TYPES.includes(s.providerType?.name || ""));
              if (isConfidentialAgency) {
                const st = (subjectType || "").toLowerCase();
                consultationCard.providerName = st.includes("egg") ? "the Egg Donor's Agency"
                  : st.includes("sperm") ? "the Sperm Donor's Agency"
                  : "the Surrogate's Agency";
                consultationCard.providerLogo = null;
                consultationCard.providerEmail = null;
                if (consultationCard.memberName) {
                  consultationCard.memberName = String(consultationCard.memberName).trim().split(/\s+/)[0];
                }
                console.log(`[CONSULTATION] Agency identity masked on pre-booking card (${consultationCard.providerName}, coordinator "${consultationCard.memberName || ""}")`);
              }
            } catch (e) {
              console.error("[CONSULTATION] Agency confidentiality masking failed:", e);
            }
            console.log(`[CONSULTATION] Calendar card shown for provider ${consultProviderId}, profile "${sessionTitle}" (session will be created on actual booking)`);
          }
        }
      } catch (e) {
        console.error("Failed to process CONSULTATION_BOOKING:", e);
      }
      finalContent = finalContent.replace(/\[\[CONSULTATION_BOOKING:.*?\]\]/g, "").trim();
      if (!consultationCard) {
        console.warn(`[CONSULTATION] consultationCard is NULL after processing - calendar will NOT show`);
      }
    }

    // Human-escalation "Schedule" path: [[CONCIERGE_CALENDAR]] embeds a
    // GoStork staff member's booking calendar inline - the classic
    // "GoStork Concierge Call" card (ConsultationBookingCard renders the
    // GoStork-branded title when providerName === "GoStork"). Skipped if a
    // provider consultation card was already attached to this reply.
    if (finalContent.includes("[[CONCIERGE_CALENDAR]]")) {
      finalContent = finalContent.replace(/\[\[CONCIERGE_CALENDAR\]\]/g, "").trim();
      if (!consultationCard) {
        try {
          const staffMember = await prisma.user.findFirst({
            where: {
              OR: [{ roles: { has: "GOSTORK_ADMIN" } }, { roles: { has: "GOSTORK_CONCIERGE" } }],
              scheduleConfig: { bookingPageSlug: { not: null } },
            },
            orderBy: { createdAt: "asc" },
            select: { name: true, photoUrl: true, scheduleConfig: { select: { bookingPageSlug: true } } },
          });
          if (staffMember?.scheduleConfig?.bookingPageSlug) {
            consultationCard = {
              providerId: null,
              providerName: "GoStork",
              providerLogo: null,
              bookingUrl: `/book/${staffMember.scheduleConfig.bookingPageSlug}`,
              iframeEnabled: true,
              memberBookingSlug: staffMember.scheduleConfig.bookingPageSlug,
              memberName: staffMember.name,
              memberPhoto: staffMember.photoUrl,
              aiSessionId: currentSessionId || undefined,
            };
            console.log(`[CONCIERGE_CALENDAR] GoStork concierge card built for ${staffMember.name}`);
          } else {
            console.error("[CONCIERGE_CALENDAR] No GoStork staff member with a booking page - card skipped");
          }
        } catch (e: any) {
          console.error("[CONCIERGE_CALENDAR] Failed to build card:", e?.message);
        }
      }
    }

    // Phase 5: [[AGREEMENT_PREVIEW]] - parent asked to see the provider's
    // contract. Side effect (attachment/agreement card) fires after the main
    // message is saved; the tag itself is stripped here.
    let agreementPreviewRequested = false;
    if (finalContent.includes("[[AGREEMENT_PREVIEW]]")) {
      agreementPreviewRequested = true;
      finalContent = finalContent.replace(/\[\[AGREEMENT_PREVIEW\]\]/g, "").trim();
    }
    // Deterministic backstop: the [[AGREEMENT_PREVIEW]] rule lives only in the
    // Tier 2 prompt, so the same request on a Tier 1 turn produced a reply that
    // PROMISED the document ("here is the agreement for you to review:") and
    // then attached nothing. Detect the request directly - postAgreementPreview
    // is safe either way (it posts the real agreement, the provider's template,
    // or an honest "no agreement on file yet" note).
    if (!agreementPreviewRequested && /\b(send|share|resend|show)\b[^.?!\n]{0,40}\b(agreement|contract)\b|\b(agreement|contract)\b[^.?!\n]{0,30}\b(again|copy|can'?t find|lost)\b|\bsee (the|my) (agreement|contract)\b/i.test(userMessage)) {
      console.log(`[AGREEMENT_PREVIEW] Deterministic request detected ("${userMessage.slice(0, 60)}") - forcing the preview`);
      agreementPreviewRequested = true;
    }

    // Lawyer connect (reworked with 7A): [[LAWYER_CONNECT]] (model) and
    // [[LAWYER_CALENDAR]] (deterministic bypass) both PRESENT the firm - the
    // law-group profile card + the attorney's booking calendar. The 3-way
    // legal chat is created ONLY when the parent books the call
    // (calendar.controller createConsultationChatSession), exactly like
    // every other provider type. No chat, no provider notification, and no
    // journey rung before the booking.
    let lawyerCalendarServed = false;
    if (finalContent.includes("[[LAWYER_CONNECT]]") || finalContent.includes("[[LAWYER_CALENDAR]]")) {
      finalContent = finalContent.replace(/\[\[LAWYER_CONNECT\]\]/g, "").replace(/\[\[LAWYER_CALENDAR\]\]/g, "").trim();
      lawyerCalendarServed = true;
      if (!lawyerBypassPick) {
        try {
          const { pickLawyerWithBooking } = await import("./lawyer-intro-flow");
          lawyerBypassPick = await pickLawyerWithBooking(userId);
        } catch (e: any) {
          console.error("[LAWYER_CALENDAR] pick failed:", e?.message);
        }
      }
      if (lawyerBypassPick) {
        // The firm card renders ABOVE the calendar: firm tabs + one face tab
        // per lawyer (LawGroupSwipeCard). Pushed after the MATCH_CARD
        // validation loops on purpose - this is DB truth, not model output.
        matchCards.push({
          type: "Law Group",
          providerId: lawyerBypassPick.provider.id,
          ownerProviderId: lawyerBypassPick.provider.id,
          name: lawyerBypassPick.provider.name,
          photo: lawyerBypassPick.provider.logoUrl || undefined,
          reasons: [],
        });
        // The presentation IS the legal journey's "Exploring Profiles" rung.
        void emitJourneyEvent({ eventType: "PROFILE_PRESENTED", parentUserId: userId, providerId: lawyerBypassPick.provider.id, sessionId: currentSessionId || null, metadata: { kind: "law_group" } });
        if (!consultationCard && lawyerBypassPick.member?.slug) {
          consultationCard = {
            providerId: lawyerBypassPick.provider.id,
            providerName: lawyerBypassPick.provider.name,
            providerLogo: lawyerBypassPick.provider.logoUrl,
            bookingUrl: `/book/${lawyerBypassPick.member.slug}`,
            iframeEnabled: true,
            memberBookingSlug: lawyerBypassPick.member.slug,
            memberName: lawyerBypassPick.member.name,
            memberPhoto: lawyerBypassPick.member.photoUrl,
            aiSessionId: currentSessionId || undefined,
            subjectType: "legal",
          };
          console.log(`[LAWYER_CALENDAR] Card built: slug=${lawyerBypassPick.member.slug}, provider=${lawyerBypassPick.provider.name}`);
        }
      } else {
        console.warn("[LAWYER_CALENDAR] No approved Legal Services provider - nothing to present");
      }
    }

    // Phase 6: [[BANK_CHECKOUT:DONOR_ID]] - parent wants to buy a BANK donor
    // directly. Side effect (bank_checkout card with price + Buy button)
    // fires after the main message is saved; tag stripped here.
    let bankCheckoutDonorId: string | null = null;
    const bankCheckoutMatch = finalContent.match(/\[\[BANK_CHECKOUT:([^\]]+)\]\]/);
    if (bankCheckoutMatch) {
      bankCheckoutDonorId = bankCheckoutMatch[1].trim();
      finalContent = finalContent.replace(/\[\[BANK_CHECKOUT:[^\]]*\]\]/g, "").trim();
    }

    // Resolve [[MEETING_CARD:<bookingId>]] tags into hydrated Booking objects so
    // the parent can join/reschedule/cancel an existing meeting inline. The AI
    // emits only the bookingId (from get_parent_meetings); the server re-fetches
    // the booking from DB truth, scoped to the parent-account members, and drops
    // any id that isn't theirs (defense in depth on top of the userId injection).
    let meetingCards: any[] = [];
    const meetingCardTags = [...finalContent.matchAll(/\[\[MEETING_CARD:([\s\S]*?)\]\]/g)];
    if (meetingCardTags.length > 0) {
      try {
        const meAcct = await prisma.user.findUnique({ where: { id: userId }, select: { parentAccountId: true } });
        const meetingMemberIds = meAcct?.parentAccountId
          ? (await prisma.user.findMany({
              where: { parentAccountId: meAcct.parentAccountId, isDisabled: false },
              select: { id: true },
            })).map((u) => u.id)
          : [userId];
        const seenBookingIds = new Set<string>();
        for (const m of meetingCardTags) {
          const bookingId = (m[1] || "").trim();
          if (!bookingId || seenBookingIds.has(bookingId)) continue;
          seenBookingIds.add(bookingId);
          const booking = await prisma.booking.findFirst({
            where: { id: bookingId, parentUserId: { in: meetingMemberIds } },
            include: {
              providerUser: {
                select: {
                  id: true, name: true, email: true, photoUrl: true, dailyRoomUrl: true,
                  provider: { select: { id: true, name: true, logoUrl: true } },
                  scheduleConfig: { select: { bookingPageSlug: true } },
                },
              },
              parentUser: { select: { id: true, name: true, email: true, photoUrl: true, parentAccountId: true } },
            },
          });
          if (booking) {
            // Normalize to plain JSON (Date -> ISO string) BEFORE it lands in the
            // Json `uiCardData` column. Prisma serializes embedded JS Date values
            // inside a Json field as {"$type":"DateTime","value":"..."}; on history
            // reload the client then gets that wrapped object and `new Date(...)`
            // yields an Invalid Date, which crashes the booking card (date-fns
            // format throws "Invalid time value"). A JSON round-trip flattens every
            // Date field to a plain ISO string so the persisted and live shapes match.
            meetingCards.push(JSON.parse(JSON.stringify(booking)));
          } else {
            console.warn(`[MEETING_CARD] booking ${bookingId} not found or not owned by parent ${userId} - dropping card`);
          }
        }
      } catch (e) {
        console.error("Failed to process MEETING_CARD:", e);
      }
      finalContent = finalContent.replace(/\[\[MEETING_CARD:[\s\S]*?\]\]/g, "").trim();
    }

    // If all AI tiers failed, tell the client to silently retry rather than saving an error message
    if (needsRetry) {
      console.warn("[AI Router] All tiers failed - sending retry_needed to client");
      sse.sendRetry();
      return;
    }

    // Resolve DOCTOR_CARD tags into full enriched cards (DB-truth) via
    // resolve_doctor_card. Mirrors the MATCH_CARD resolve pipeline: the AI emits
    // only {slug, reasons}; the server re-resolves the slug so the rendered card
    // is real data, not model output. Success-rate context comes from the same
    // values the AI passed to search_doctors (consistent with what it returned),
    // falling back to the parent's saved profile.
    if (doctorCardTags.length > 0 && mcpClient) {
      const docSearchArgs: any = lastSearchToolResults.find((r) => r.toolName === "search_doctors")?.toolArgs || {};
      const profileEgg = (profile?.eggSource || "").toLowerCase();
      const docEggSource =
        docSearchArgs.eggSource === "donor" || profileEgg.includes("donor") || profile?.needsEggDonor === true
          ? "donor"
          : "own_eggs";
      const docAgeGroup = docSearchArgs.ageGroup || profile?.clinicAgeGroup || "under_35";
      const docIsNew =
        typeof docSearchArgs.isNewPatient === "boolean"
          ? docSearchArgs.isNewPatient
          : profile?.isFirstIvf == null
            ? true
            : !!profile.isFirstIvf;
      // Only the FIRST doctor card per turn (one-at-a-time, like MATCH_CARD).
      const tag = doctorCardTags[0];
      try {
        const resolveResult: any = await mcpClient.callTool({
          name: "resolve_doctor_card",
          arguments: { slug: tag.slug, eggSource: docEggSource, ageGroup: docAgeGroup, isNewPatient: docIsNew },
        });
        const text = Array.isArray(resolveResult?.content) ? resolveResult.content[0]?.text : null;
        const doctor = text ? JSON.parse(text) : null;
        if (doctor && !doctor.error) {
          doctorCards = [{
            ...doctor,
            reasons: tag.reasons && tag.reasons.length > 0 ? tag.reasons : doctor.matchedReasons || [],
            eggSource: docEggSource,
            ageGroup: docAgeGroup,
            isNewPatient: docIsNew,
          }];
        } else {
          console.warn(`[ai-router] DOCTOR_CARD slug "${tag.slug}" did not resolve - dropping card`);
        }
      } catch (e) {
        console.error("[ai-router] resolve_doctor_card failed:", e);
      }
      if (doctorCardTags.length > 1) {
        console.warn(`[ai-router] AI returned ${doctorCardTags.length} doctor cards - enforcing one-at-a-time, kept first only`);
      }
    }

    // COMPARE_CARD resolution. Mirrors the MATCH_CARD/DOCTOR_CARD pipeline: the
    // AI emits only {entityType, entities, dimensions}; resolve_comparison fetches
    // the real DB data so every value on the comparison card is authoritative.
    // Success-rate context (eggSource/ageGroup/isNewPatient) is derived the same
    // way the doctor cards derive it - from the last clinic/doctor search args,
    // falling back to the parent's saved profile.
    if (compareCardTags.length > 0 && mcpClient) {
      const cmpSearchArgs: any =
        lastSearchToolResults.find((r) => r.toolName === "search_doctors")?.toolArgs ||
        lastSearchToolResults.find((r) => r.toolName === "search_clinics")?.toolArgs ||
        {};
      const profileEgg = (profile?.eggSource || "").toLowerCase();
      // Detect a donor-egg intent in the parent's actual message (e.g. "compare ...
      // for patients using an egg donor"), so the comparison frames donor-egg rates
      // even if the model didn't run a donor-scoped search this turn.
      const cmpMsg = String(req.body.message || "").toLowerCase();
      const msgWantsDonor = /donor egg|egg donor|donated egg|donor-egg/.test(cmpMsg);
      const cmpEggSource =
        cmpSearchArgs.eggSource === "donor" || msgWantsDonor || profileEgg.includes("donor") || profile?.needsEggDonor === true
          ? "donor"
          : "own_eggs";
      const cmpAgeGroup = cmpSearchArgs.ageGroup || profile?.clinicAgeGroup || "under_35";
      const cmpIsNew =
        typeof cmpSearchArgs.isNewPatient === "boolean"
          ? cmpSearchArgs.isNewPatient
          : profile?.isFirstIvf == null
            ? true
            : !!profile.isFirstIvf;
      // One comparison card per turn (one-at-a-time, like the other cards).
      const tag = compareCardTags[0];
      // For clinic/agency comparisons, narrow the COST dimension to the cost
      // programs that actually apply to THIS parent's journey (e.g. a parent who
      // already has embryos should see only transfer/FET program prices, not
      // embryo-creation). Reuse CostsService.getMatchingSubtypesForParent - the
      // same personalization the direct cost Q&A and the parent cost page use.
      let cmpCostSubtypes: string[] = [];
      const cmpTypeLc = String(tag.entityType || "").toLowerCase();
      const isProviderCompare = ["clinic", "surrogacy agency", "provider", "egg bank", "sperm bank", "agency"].includes(cmpTypeLc);
      if (isProviderCompare && userRecord?.parentAccountId) {
        try {
          const { getNestApp } = await import("./nest-app-ref");
          const nestApp = getNestApp();
          const { CostsService } = await import("./src/modules/costs/costs.service");
          const costsService: any = nestApp?.get(CostsService);
          if (costsService) {
            const r = await costsService.getMatchingSubtypesForParent(userRecord.parentAccountId);
            if (Array.isArray(r?.subtypes)) cmpCostSubtypes = r.subtypes;
          }
        } catch (e: any) {
          console.warn("[ai-router] comparison cost-subtype fetch failed:", e?.message);
        }
      }
      try {
        const resolveResult: any = await mcpClient.callTool({
          name: "resolve_comparison",
          arguments: {
            entityType: tag.entityType,
            entities: tag.entities,
            dimensions: tag.dimensions ?? "all",
            eggSource: cmpEggSource,
            ageGroup: cmpAgeGroup,
            isNewPatient: cmpIsNew,
            costSubtypes: cmpCostSubtypes,
          },
        });
        const text = Array.isArray(resolveResult?.content) ? resolveResult.content[0]?.text : null;
        const card = text ? JSON.parse(text) : null;
        if (card && !card.error && Array.isArray(card.entities) && card.entities.length >= 2 && Array.isArray(card.groups) && card.groups.length > 0) {
          comparisonCards = [card];
        } else {
          console.warn(`[ai-router] COMPARE_CARD did not resolve (${card?.error || "no comparable data"}) - dropping card`);
        }
      } catch (e) {
        console.error("[ai-router] resolve_comparison failed:", e);
      }
      if (compareCardTags.length > 1) {
        console.warn(`[ai-router] AI returned ${compareCardTags.length} comparison cards - enforcing one-at-a-time, kept first only`);
      }
    }

    // A comparison card already renders every entity side-by-side, so any single
    // MATCH_CARD / DOCTOR_CARD the model also emitted this turn is redundant (and
    // frequently the wrong entity - e.g. a same-named-but-different clinic). Drop
    // them so the parent sees only the comparison card.
    if (comparisonCards.length > 0) {
      if (matchCards.length > 0) {
        console.warn(`[ai-router] COMPARE_CARD present - dropping ${matchCards.length} stray MATCH_CARD(s) this turn`);
        matchCards = [];
      }
      if (doctorCards.length > 0) {
        console.warn(`[ai-router] COMPARE_CARD present - dropping ${doctorCards.length} stray DOCTOR_CARD(s) this turn`);
        doctorCards = [];
      }
    }

    // Deterministic backstop for purchase intent: this turn MUST end in the
    // checkout card (or the consultation path for agency donors). If the model
    // ignored the override (observed live: re-presented the same match card
    // instead), force the checkout - postBankCheckoutCard validates bank-ness
    // and posts the agency-guidance message when direct checkout doesn't apply.
    if (bankBuyDonorId && !bankCheckoutDonorId && !consultationCard) {
      console.log(`[BANK BUY INTENT] Model reply lacked BANK_CHECKOUT - forcing checkout card for donor ${bankBuyDonorId}`);
      bankCheckoutDonorId = bankBuyDonorId;
      matchCards = [];
      quickReplies = [];
      multiSelect = false;
      finalContent = "Wonderful choice - here's everything you need to complete your order:";
      sse.sendReset();
      sse.sendToken(finalContent);
    }

    const uiExtras: Record<string, any> = {};
    // Phase 7A win-back: the reschedule reply re-serves the original host's
    // calendar; the churn question carries its payload for the next turn.
    if (!consultationCard && winbackRescheduleCard) consultationCard = winbackRescheduleCard;
    if (winbackChurnAskPayload) uiExtras.churnAsk = winbackChurnAskPayload;
    if (matchCards.length > 0) uiExtras.matchCards = matchCards;
    if (doctorCards.length > 0) uiExtras.doctorCards = doctorCards;
    if (comparisonCards.length > 0) uiExtras.comparisonCards = comparisonCards;
    if (consultationCard) uiExtras.consultationCard = consultationCard;
    if (meetingCards.length > 0) uiExtras.meetingCards = meetingCards;
    if (sendPrepDoc) uiExtras.prepDoc = true;
    if (quickReplies.length > 0) uiExtras.quickReplies = quickReplies;
    if (multiSelect) uiExtras.multiSelect = true;

    const replySessionId = currentSessionId;

    // Sanitize: replace em-dashes and en-dashes with regular hyphens
    finalContent = finalContent.replace(/[\u2013\u2014]/g, "-");

    const now = new Date();
    const savedAiMessage = await prisma.aiChatMessage.create({
      data: {
        sessionId: replySessionId,
        role: "assistant",
        content: finalContent,
        deliveredAt: now,
        ...(Object.keys(uiExtras).length > 0 ? { uiCardType: "rich", uiCardData: uiExtras } : {}),
      },
    });
    // Mark the user's message as delivered AND read (AI always processes immediately)
    // savedUserMsg is null for system triggers - skip the update in that case
    if (savedUserMsg) {
      prisma.aiChatMessage.update({
        where: { id: savedUserMsg.id },
        data: { deliveredAt: now, readAt: now },
      }).catch(() => {});
    }

    // Roll turns that scrolled out of the recent window into the session's
    // running summary (background - no added latency; batched internally).
    if (replySessionId) {
      void maybeUpdateSessionSummary(replySessionId).catch(() => {});
    }

    if (agreementPreviewRequested && replySessionId) {
      try {
        const { postAgreementPreview } = await import("./agreement-flow");
        await postAgreementPreview(replySessionId);
      } catch (e: any) {
        console.error("[AGREEMENT_PREVIEW] Failed to post preview:", e?.message);
      }
    }

    if (bankCheckoutDonorId && replySessionId) {
      try {
        const { postBankCheckoutCard } = await import("./bank-checkout-flow");
        await postBankCheckoutCard(replySessionId, bankCheckoutDonorId);
      } catch (e: any) {
        console.error("[BANK_CHECKOUT] Failed to post checkout card:", e?.message);
      }
    }

    // Review bypass: drop the review card right below the confirmation reply.
    // Existing review -> submitted chip with the "Update review" opener;
    // no review yet -> the fresh star-row ask.
    if (reviewCardRequest && replySessionId) {
      try {
        const ex = reviewCardRequest.existing;
        await prisma.aiChatMessage.create({
          data: {
            sessionId: replySessionId,
            role: "assistant",
            senderType: "system",
            senderName: "GoStork",
            content: ex
              ? `Your review of ${reviewCardRequest.providerName}:`
              : `How was your experience with ${reviewCardRequest.providerName}? Your rating helps other families choose well.`,
            uiCardType: "review_prompt",
            uiCardData: {
              providerId: reviewCardRequest.providerId,
              providerName: reviewCardRequest.providerName,
              memberId: null,
              stage: ex?.stage || "handed_off",
              existingReviewId: ex?.id || null,
              existingRating: ex?.rating || null,
              submitted: !!ex,
              submittedRating: ex?.rating || null,
              remindedAt: null,
            },
          },
        });
      } catch (e: any) {
        console.error("[REVIEW BYPASS] card post failed:", e?.message);
      }
    }

    // Standalone lawyer offer: inline reminders kept getting buried (quick
    // replies only render on the LAST message, and the model loves attaching
    // meeting cards below its text). So when the parent has an upcoming
    // provider call and no legal chat yet, post the offer as its OWN trailing
    // message - always last on screen, buttons always tappable. Once per
    // session (uiCardData.lawyerOffer marker); answering it either creates
    // the legal session (suppresses forever) or leaves the marker (never
    // re-posted).
    if (hasUpcomingProviderConsult && replySessionId && !lawyerCalendarServed) {
      try {
        const [legalSession, alreadyOffered] = await Promise.all([
          prisma.aiChatSession.findFirst({ where: { userId, subjectType: "legal" }, select: { id: true } }),
          prisma.aiChatMessage.findFirst({
            where: { sessionId: replySessionId, uiCardData: { path: ["lawyerOffer"], equals: true } },
            select: { id: true },
          }),
        ]);
        if (!legalSession && !alreadyOffered) {
          // Show the firm (+ its lawyers as face tabs) with the offer so the
          // parent sees WHO they'd be connected with before answering.
          let offerMatchCards: any[] | undefined;
          try {
            const { pickLawyerWithBooking } = await import("./lawyer-intro-flow");
            const pick = await pickLawyerWithBooking(userId);
            if (pick) {
              offerMatchCards = [{
                type: "Law Group",
                providerId: pick.provider.id,
                ownerProviderId: pick.provider.id,
                name: pick.provider.name,
                photo: pick.provider.logoUrl || undefined,
                reasons: [],
              }];
              void emitJourneyEvent({ eventType: "PROFILE_PRESENTED", parentUserId: userId, providerId: pick.provider.id, sessionId: replySessionId, metadata: { kind: "law_group", viaOffer: true } });
            }
          } catch { /* offer still posts without the card */ }
          await prisma.aiChatMessage.create({
            data: {
              sessionId: replySessionId,
              role: "assistant",
              content: "One quick thing before your call: surrogacy and egg donation journeys require independent legal counsel, and it's smart to have your own fertility attorney lined up early. I can connect you with a vetted attorney right here on GoStork - want me to?",
              senderType: "ai",
              uiCardData: {
                lawyerOffer: true,
                quickReplies: ["Yes, connect me with a lawyer", "Not right now"],
                ...(offerMatchCards ? { matchCards: offerMatchCards } : {}),
              },
            },
          });
          console.log(`[lawyer-offer] Posted standalone trailing offer in session ${replySessionId}`);
        }
      } catch (e: any) {
        console.error("[lawyer-offer] Failed to post trailing offer:", e?.message);
      }
    }

    sse.sendDone({
      sessionId: replySessionId,
      userMessageId: savedUserMsg?.id ?? null,
      userMessageDeliveredAt: now.toISOString(),
      userMessageReadAt: now.toISOString(),
      message: savedAiMessage,
      quickReplies: quickReplies.length > 0 ? quickReplies : undefined,
      multiSelect: multiSelect || undefined,
      showCuration: showCuration || undefined,
      matchCards: matchCards.length > 0 ? matchCards : undefined,
      doctorCards: doctorCards.length > 0 ? doctorCards : undefined,
      comparisonCards: comparisonCards.length > 0 ? comparisonCards : undefined,
      prepDoc: sendPrepDoc || undefined,
      humanNeeded: humanNeeded || undefined,
      consultationCard: consultationCard || undefined,
      meetingCards: meetingCards.length > 0 ? meetingCards : undefined,
    });
  } catch (error: any) {
    console.error("AI Router Error:", error);
    // Tell the client to silently retry - don't save an error message to the session
    try {
      res.write(`data: ${JSON.stringify({ type: "retry_needed" })}\n\n`);
      res.end();
    } catch {
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
      else res.end();
    }
  }
});
