/**
 * Whisper-answer knowledge: classification, sanitization, and ingestion.
 *
 * When a provider answers a parent's whisper about a donor/surrogate, that
 * answer is durable knowledge. Two different things happen with it:
 *
 *  - AGENCY-LEVEL answers (how the agency works: process, policy, screening)
 *    are ingested into `KnowledgeChunk` so they become semantically searchable
 *    for that provider forever, with no recency cap and no dependence on which
 *    profile happened to be on screen when the question was asked.
 *  - PERSON-SPECIFIC answers (facts about one donor/surrogate) are NEVER
 *    ingested. They stay bound to their own profile via the SilentQuery lookup
 *    in ai-router, because "she is cleared to travel until 34 weeks" applied to
 *    a different surrogate is a fabrication, not a shortcut.
 *
 * Shared by ai-router (read path) and chat-router (write path on relay).
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "./db";

// QUESTION side: the asking family describing themselves. First person here is
// the PARENT talking, so "we/our/my" disqualifies the pair from any reuse.
export const FAMILY_CONTEXT_MARKERS =
  /\b(we|we'?re|we'?ve|us|our|ours|my|mine|i'?m|i am|i'?ve|husband|wife|partner|spouse|two dads|two moms|two mums|gay|lesbian|same.?sex|single (mom|mother|dad|father|parent)|solo (mom|mother|dad|father|parent)|our family|my family)\b/i;

// ANSWER side: deliberately NARROWER. In an answer, "we/our" is the PROVIDER
// talking about their own agency ("We screen every surrogate...") - exactly the
// knowledge worth keeping. Only drop answers describing the ASKING FAMILY.
export const ASKER_IDENTITY_IN_ANSWER =
  /\b(two dads|two moms|two mums|same.?sex|gay couple|lesbian couple|single (mom|mother|dad|father|parent)|solo (mom|mother|dad|father|parent)|your (family|husband|wife|partner|situation|country))\b/i;

/** Talks about THE PERSON on the profile rather than the agency. */
export const PROFILE_REFERENTIAL = /\b(she|she'?s|her|hers|he|he'?s|him|his)\b/i;

/** Reads like agency process/policy rather than one person's facts. */
export const AGENCY_LEVEL_MARKERS =
  /\b(we|we'?re|our|us|the agency|agency'?s|policy|policies|process|program|procedure|requirement|typically|generally|usually|standard|all (of )?(our|their) (surrogates|donors|clients|parents)|every (surrogate|donor))\b/i;

/**
 * Safe to reuse across DIFFERENT profiles of the same provider. Conservative:
 * a single "she/her/his" anywhere in question or answer keeps the pair locked.
 */
export function isAgencyLevelPair(question: string, answer: string): boolean {
  if (PROFILE_REFERENTIAL.test(question) || PROFILE_REFERENTIAL.test(answer)) return false;
  return AGENCY_LEVEL_MARKERS.test(answer);
}

/**
 * Strip the asking family's context from a question, or reject the pair.
 * Returns null when the question cannot be made safe/standalone.
 */
export function sanitizeReusableQuestion(raw: string): string | null {
  const text = (raw || "").trim();
  if (!text) return null;
  // Parents often prefix context ("We're a same-sex couple. Did she have
  // gestational diabetes?") - prefer the actual interrogative sentence.
  const sentences = text.split(/(?<=[.?!])\s+/).map((x) => x.trim()).filter(Boolean);
  const question = sentences.reverse().find((x) => x.includes("?")) || text;
  if (FAMILY_CONTEXT_MARKERS.test(question)) return null;
  if (question.length < 8 || question.length > 240) return null;
  // If a leading context sentence was dropped, what survives must still stand
  // alone: "We're doing this in Colombia. Is she open to that?" reduces to a
  // dangling "Is she open to that?" - meaningless for a different family.
  const strippedContext = question !== text;
  if (strippedContext && /\b(that|this|these|those|it|them|there)\b\s*\??$/i.test(question)) return null;
  return question;
}

/** Same model + dimensions the MCP search embeds queries with, or nothing matches. */
async function embed(text: string): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: "gemini-embedding-001" });
    const r: any = await model.embedContent({
      content: { parts: [{ text }], role: "user" },
      outputDimensionality: 768,
    } as any);
    const values = r?.embedding?.values;
    return Array.isArray(values) && values.length ? `[${values.join(",")}]` : null;
  } catch (e: any) {
    console.error("[WHISPER KB] embedding failed:", e?.message);
    return null;
  }
}

/**
 * Ingest an answered whisper into the provider's knowledge base when - and only
 * when - it is agency-level. Idempotent per SilentQuery id. Fire-and-forget:
 * never block or fail the parent-facing relay.
 */
export async function ingestAgencyAnswerToKnowledgeBase(params: {
  silentQueryId: string;
  providerId: string;
  questionText: string;
  answerText: string;
}): Promise<"ingested" | "skipped_person_specific" | "skipped_unsafe_question" | "skipped_duplicate" | "failed"> {
  const { silentQueryId, providerId, questionText, answerText } = params;
  try {
    const answer = (answerText || "").trim();
    if (!answer) return "failed";
    if (ASKER_IDENTITY_IN_ANSWER.test(answer)) return "skipped_person_specific";
    const question = sanitizeReusableQuestion(questionText);
    if (!question) return "skipped_unsafe_question";
    if (!isAgencyLevelPair(question, answer)) return "skipped_person_specific";

    const existing = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "KnowledgeChunk" WHERE metadata->>'silentQueryId' = $1 LIMIT 1`,
      silentQueryId,
    );
    if (existing.length > 0) return "skipped_duplicate";

    const content = `Q: ${question}\nA: ${answer}`;
    const vector = await embed(content);
    if (!vector) return "failed";

    await prisma.$executeRawUnsafe(
      `INSERT INTO "KnowledgeChunk" (id, content, metadata, embedding, "sourceTier", "providerId", "sourceType", "createdAt")
       VALUES (gen_random_uuid(), $1, $2::jsonb, $3::vector, 1, $4, 'whisper_answer', NOW())`,
      content,
      JSON.stringify({ silentQueryId, origin: "whisper_answer", agencyLevel: true }),
      vector,
      providerId,
    );
    console.log(`[WHISPER KB] Ingested agency-level answer for provider ${providerId} (whisper ${silentQueryId})`);
    return "ingested";
  } catch (e: any) {
    console.error("[WHISPER KB] ingest failed:", e?.message);
    return "failed";
  }
}
