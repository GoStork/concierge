/**
 * Single source of truth for two questions that were being answered
 * differently in five places, each answer subtly wrong in its own way:
 *
 *   1. "Which session is the parent's own Eva chat?"
 *   2. "Which system cards is a parent allowed to see?"
 *
 * Both matter because getting them wrong is SILENT. A prompt posted into the
 * wrong session is invisible to everyone; a card counted but not rendered is
 * a notification badge the parent can never clear.
 *
 * See docs/freetext-request-test-plan.md and the Jul 24 routing audit.
 */
/**
 * System cards a PARENT may see in their message feed.
 *
 * The read path hides any `senderType: "system"` message whose uiCardType is
 * not in this list (a null uiCardType is always allowed - it is a plain
 * message, not a card). The unread COUNT must apply the same rule, or a
 * hidden card silently inflates the badge. Keep the two in lockstep by
 * importing this constant rather than re-typing the list.
 *
 * Deliberately absent (provider-side or internal): clearance_tracker,
 * ip_form_submitted, video_invite, partner_info_request, donor_hold_decision,
 * cost_sheet_draft_approval, invoice_draft_approval, agreement_draft_approval,
 * provider_only, provider_assessment.
 */
export const PARENT_VISIBLE_SYSTEM_CARDS: string[] = [
  "proposed_times",
  "agreement",
  "agreement_signed",
  "signer_signed",
  "readiness_prompt",
  "invoice",
  "cost_sheet",
  // Egg-donor hold countdown: the parent decides "release her" vs "I will pay
  // soon" (the provider-side donor_hold_decision card stays hidden).
  "donor_release_warning",
  // Phase 8: Eva's review ask (parent-only by definition).
  "review_prompt",
  // Intended Parent Form nudge (parent-only by definition).
  "ip_form_prompt",
  // System-sent file attachments (e.g. the Match Call prep guide).
  "attachment",
  // Consultation focus lock / match call consent gates
  // (server/consultation-gates.ts). All three are the PARENT's action - they
  // must render for the parent or the gate is unsatisfiable. The two match-call
  // ones are ALSO visible to the provider (deliberately: the provider is the one
  // who hits the 409 on propose-call-times and needs to see the blocker), while
  // consult_preliminary_ack is parent-private - it renders pre-booking, where
  // the agency's identity is still masked.
  "consult_preliminary_ack",
  "match_call_attendance_ack",
  "match_call_decision_ack",
];

/**
 * Card types that belong to the parent alone and must never surface in the
 * provider's feed, previews or badges. Import this rather than re-typing the
 * list at each `notIn` site.
 */
export const PARENT_PRIVATE_SYSTEM_CARDS: string[] = ["consult_preliminary_ack"];

/**
 * A Prisma `where` fragment that excludes exactly the messages the parent's
 * read path hides, for use in unread counts and any other aggregate that must
 * agree with what actually renders.
 */
export const PARENT_HIDDEN_MESSAGE_FILTER = {
  NOT: {
    AND: [
      { senderType: "system" },
      { uiCardType: { not: null } },
      { uiCardType: { notIn: PARENT_VISIBLE_SYSTEM_CARDS } },
    ],
  },
};

/**
 * The parent's own concierge (Eva) chat - never a shared parent-provider
 * thread.
 *
 * THE TRAP: a whisper stamps `providerId` onto the parent's PRIVATE Eva
 * session, so "Eva session" is NOT "session with no providerId" - a lookup
 * keyed on that misses a stamped Eva chat, and one keyed only on
 * `matchmakerId: { not: null }` drops the post entirely when the session
 * predates the matchmaker (review_prompt and ip_form_prompt both did exactly
 * that, silently). The reliable discriminators are `status` and
 * `providerJoinedAt`: a thread the provider has joined is shared, everything
 * else belongs to the parent alone.
 *
 * Preference order: the canonical Eva session (has a matchmaker), then any
 * other private ACTIVE parent session, newest first.
 */
export async function resolveParentEvaSessionId(
  memberIds: string[],
  client?: any,
): Promise<string | null> {
  if (!memberIds || memberIds.length === 0) return null;
  // Imported lazily so the card allow-list and this function stay usable
  // without a database connection (scripts/test-unit-guards.ts injects a stub).
  const db = client ?? (await import("./db")).prisma;
  const privateThread = {
    userId: { in: memberIds },
    sessionType: "PARENT",
    status: "ACTIVE",
    providerJoinedAt: null,
  };
  const withMatchmaker = await db.aiChatSession.findFirst({
    where: { ...privateThread, matchmakerId: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (withMatchmaker?.id) return withMatchmaker.id;
  // Fallback: a private parent session that never got a matchmakerId. Posting
  // here is strictly better than dropping the message on the floor.
  const anyPrivate = await db.aiChatSession.findFirst({
    where: privateThread,
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  return anyPrivate?.id ?? null;
}

/** The subset of AiChatSession every caller of findConnectedProviderSession needs. */
export interface SharedProviderSession {
  id: string;
  status: string;
  providerJoinedAt: Date | null;
  subjectProfileId: string | null;
  subjectType: string | null;
  title: string | null;
}

const SHARED_SESSION_SELECT = {
  id: true,
  status: true,
  providerJoinedAt: true,
  subjectProfileId: true,
  subjectType: true,
  title: true,
} as const;

/**
 * DELETED: findSharedProviderSession.
 *
 * It tried the strict query first and, on a miss, fell back to a bare
 * `{ userId, providerId }` lookup - "better than dropping a message on the
 * floor". That fallback was the trap, not a rescue: a whisper stamps
 * providerId onto the parent's PRIVATE Eva session, so it resolved to Eva
 * exactly when no shared thread existed. It shipped signed Intended Parent
 * Forms and ID scans into a conversation the provider is not a party to, where
 * the card is not even in the parent's allow-list - so it rendered to nobody
 * while sitting in a private thread.
 *
 * Use findConnectedProviderSession below. If it returns null there is no
 * shared thread, and the correct behaviour is to log and not post. A narrowed
 * primary query with the loose one still reachable underneath is not a fix.
 */

/**
 * Strict variant: resolves ONLY a genuinely shared thread, never the loose
 * fallback. Use this when the answer drives a branch (skip the consultation,
 * treat the parent as connected) rather than "where do I post this?".
 */
export async function findConnectedProviderSession(
  memberIds: string[],
  providerId: string,
  opts?: { excludeSessionId?: string | null; client?: any },
): Promise<SharedProviderSession | null> {
  if (!memberIds?.length || !providerId) return null;
  const db = opts?.client ?? (await import("./db")).prisma;
  const found = await db.aiChatSession.findFirst({
    where: {
      ...(opts?.excludeSessionId ? { id: { not: opts.excludeSessionId } } : {}),
      userId: { in: memberIds },
      providerId,
      OR: [
        { status: { in: ["CONSULTATION_BOOKED", "PROVIDER_CONNECTED", "HUMAN_JOINED"] } },
        { providerJoinedAt: { not: null } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: SHARED_SESSION_SELECT,
  });
  return (found as SharedProviderSession) ?? null;
}
