/**
 * Eva's reply inside a provider-owned chat.
 *
 * Once a parent-provider session is CONSULTATION_BOOKED / PROVIDER_CONNECTED
 * the provider owns the conversation and Eva stays silent by default. The
 * one exception: the parent's message is fully answered by facts the
 * platform already holds (the family's calls with this provider, the
 * provider's own knowledge base, the thread itself). Then Eva answers right
 * away instead of leaving the parent waiting on a question she can settle.
 *
 * Deliberately NOT the full concierge pipeline: that stack is built for
 * Eva's private chat (intake, matching, booking cards, whispers) and fights
 * a thread the provider already owns. One focused call answers from the
 * facts below or declines.
 *
 * The prompt is the ConciergePromptSection row "provider_chat_gate"
 * (admin-editable at /account/concierge). A failed call is logged loudly and
 * treated as silence - the pre-existing behavior - never as a reply.
 */
import { prisma } from "./db";
import { fastJson } from "./concierge-memory";

export const PROVIDER_CHAT_GATE_KEY = "provider_chat_gate";

/** A provider who wrote within this window and is online is actively handling the chat. */
export const PROVIDER_ACTIVE_WINDOW_MS = 10 * 60 * 1000;

export interface ProviderChatGateInput {
  sessionId: string;
  providerId: string;
  providerName: string;
  parentUserId: string;
  parentAccountId?: string | null;
  parentFirstName: string;
  parentMessage: string;
  knowledge: { content: string }[];
}

export interface ProviderChatGateDecision {
  answer: boolean;
  reply: string;
  reason: string;
}

function formatCallTime(at: Date, timeZone: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  try {
    return at.toLocaleString("en-US", { ...opts, timeZone: timeZone || "America/New_York" });
  } catch {
    return at.toLocaleString("en-US", { ...opts, timeZone: "America/New_York" });
  }
}

export async function decideEvaReplyInProviderChat(input: ProviderChatGateInput): Promise<ProviderChatGateDecision> {
  const silent = (reason: string): ProviderChatGateDecision => ({ answer: false, reply: "", reason });

  const section = await prisma.conciergePromptSection.findUnique({
    where: { key: PROVIDER_CHAT_GATE_KEY },
    select: { content: true, isActive: true },
  });
  if (!section?.isActive || !section.content?.trim()) return silent("gate section missing or inactive");

  const family = input.parentAccountId ? { parentAccountId: input.parentAccountId } : { id: input.parentUserId };
  const [recent, bookings, handedOff] = await Promise.all([
    prisma.aiChatMessage.findMany({
      where: { sessionId: input.sessionId },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { senderType: true, senderName: true, content: true, createdAt: true },
    }),
    // The family's calls with this provider from two weeks back onward, so
    // "when is my call?" is answered from the booking itself, never guessed.
    prisma.booking.findMany({
      where: {
        providerUser: { providerId: input.providerId },
        parentUser: family,
        scheduledAt: { gte: new Date(Date.now() - 14 * 24 * 3600 * 1000) },
      },
      orderBy: { scheduledAt: "asc" },
      take: 5,
      select: { scheduledAt: true, duration: true, status: true, subject: true, meetingSubtype: true, bookerTimezone: true, outcome: true },
    }),
    prisma.aiChatSession.count({
      where: { providerId: input.providerId, handoffCompletedAt: { not: null }, user: family },
    }).then((n) => n > 0),
  ]);

  const transcript = recent
    .reverse()
    .map((m) => `[${m.createdAt.toISOString().slice(0, 16)} ${m.senderType}${m.senderName ? ` - ${m.senderName}` : ""}] ${String(m.content || "").slice(0, 400)}`)
    .join("\n");
  const now = new Date();
  const bookingLines = bookings.length
    ? bookings
        .map((b) => `- ${b.subject || b.meetingSubtype || "Call"}: ${formatCallTime(b.scheduledAt, b.bookerTimezone)}, ${b.duration} min, status ${b.status}${b.outcome ? `, outcome ${b.outcome}` : ""}${b.scheduledAt < now ? " (in the past)" : ""}`)
        .join("\n")
    : "(none)";
  const kb = input.knowledge.length
    ? input.knowledge.map((k, i) => `(${i + 1}) ${String(k.content).slice(0, 500)}`).join("\n")
    : "(no matching entries)";

  const user = [
    `PROVIDER: ${input.providerName}`,
    `PARENT FIRST NAME: ${input.parentFirstName}`,
    `JOURNEY WITH THIS PROVIDER: ${handedOff ? "handed off (agreement signed and paid)" : "in progress"}`,
    `CALLS WITH THIS PROVIDER:\n${bookingLines}`,
    `PROVIDER KNOWLEDGE BASE MATCHES:\n${kb}`,
    `RECENT MESSAGES IN THIS CHAT (oldest first):\n${transcript}`,
    `LATEST PARENT MESSAGE: ${input.parentMessage}`,
  ].join("\n\n");

  const parsed = await fastJson(section.content, user, 600, "provider-chat-gate");
  if (!parsed || typeof parsed.answer !== "boolean") {
    console.error(`[provider-chat-gate] No usable decision for session ${input.sessionId} - staying silent`);
    return silent("gate call failed");
  }
  const reply = String(parsed.reply || "").trim();
  if (parsed.answer && !reply) {
    console.error(`[provider-chat-gate] answer=true with an empty reply for session ${input.sessionId} - staying silent`);
    return silent("empty reply");
  }
  return { answer: parsed.answer, reply, reason: String(parsed.reason || "") };
}
