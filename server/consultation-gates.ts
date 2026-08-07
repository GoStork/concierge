/**
 * Consultation focus lock + match-call consent gates.
 *
 * WHY THIS EXISTS
 * Parents were collecting first-consultation calls instead of closing on one.
 * Five agencies booked in parallel means no focus, no progression to a match
 * call, and a choice made on scheduling luck rather than fit. So: ONE open
 * consultation per provider type at a time, with real ways out.
 *
 * The lock is per TYPE and each type is independent - an open surrogacy
 * consultation never blocks an egg donor, IVF clinic, bank or legal call.
 *
 * FOUR WAYS A LOCK RELEASES (any one is enough):
 *   1. The call reached a terminal state - cancelled, expired, or a no-show.
 *   2. The provider marked the family not a fit.
 *   3. The parent told Eva they want to move on (she confirms once first).
 *   4. Seven days passed since the call with no match call scheduled.
 *   ...plus a GoStork admin override, which is (3) written by staff.
 *
 * NOTHING IS STORED. The lock is derived from Booking rows on every read, and
 * the only facts that cannot be derived - the human decisions in (2) and (3),
 * and the consent ticks - are appended to JourneyEvent, which already carries
 * parentAccountId / providerId / metadata and is already append-only. A
 * "ConsultationLock" table would be a cache of bookings, and a stale cache
 * here means a parent silently locked out of their own journey.
 *
 * FAIL OPEN, ALWAYS. Every ambiguity in this file resolves to "allow". A
 * missed lock is a soft product miss; a wrong lock is a dead end the parent
 * cannot see or undo.
 */
import {
  resolveLockProviderType,
  providerTypeFromSubject,
  isLockedProviderType,
  type LockedProviderType,
} from "./provider-type-resolve";
import { isParentVisibleSchedule } from "../shared/payment-schedule";
import type { JourneyEventType, JourneyActor } from "./journey-events";

/** Days after a consultation with no match call before the lock lifts itself. */
export const CONSULTATION_LOCK_WINDOW_DAYS = 7;

/** Booking statuses that still hold a lock. Anything else has ended. */
const LIVE_BOOKING_STATUSES = ["PENDING", "CONFIRMED"];
const NO_SHOW_OUTCOMES = ["NO_SHOW_PARENT", "NO_SHOW_PROVIDER", "NO_SHOW_BOTH"];
const RELEASE_EVENT_TYPES = ["CONSULTATION_NOT_A_FIT", "CONSULTATION_LOCK_RELEASED"];

export type LockRelease =
  | "NONE"
  | "TERMINAL_OUTCOME"
  | "NOT_A_FIT"
  | "PARENT_MOVED_ON"
  | "STALE_WINDOW"
  | "ADMIN_OVERRIDE";

export interface OpenConsultation {
  bookingId: string;
  sessionId: string | null;
  providerId: string;
  providerName: string;
  providerTypeName: LockedProviderType;
  scheduledAt: Date;
  status: string;
  subjectLabel: string | null;
  /** "NONE" means this consultation is still holding its type's lock. */
  releasedBy: LockRelease;
  /** When the 7-day window lifts it on its own. */
  releaseEligibleAt: Date;
}

export interface ConsultationLockDecision {
  allowed: boolean;
  /** Resolved service line of the REQUESTED provider. Null = could not tell. */
  providerTypeName: LockedProviderType | null;
  blocker: OpenConsultation | null;
  code: "CONSULTATION_ALREADY_OPEN" | null;
  /** Parent-facing. ALWAYS second person - a parent never reads about themselves in third person. */
  message: string | null;
}

// Both of these are imported lazily so this module stays loadable with no
// DATABASE_URL - scripts/test-unit-guards.ts drives every rule in here with a
// fake client and no server, which is the only way the release conditions get
// tested at all (they are otherwise days apart in wall-clock time).
async function db(client?: any) {
  return client ?? (await import("./db")).prisma;
}

async function emitEvent(input: {
  eventType: JourneyEventType;
  parentAccountId?: string | null;
  parentUserId?: string | null;
  providerId?: string | null;
  sessionId?: string | null;
  actorRole?: JourneyActor | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  const { emitJourneyEvent } = await import("./journey-events");
  await emitJourneyEvent(input);
}

/** parentAccountId -> every login on the household. Couples share one journey. */
export async function expandParentAccount(parentUserId: string, client?: any): Promise<string[]> {
  const prisma = await db(client);
  const user = await prisma.user
    .findUnique({ where: { id: parentUserId }, select: { parentAccountId: true } })
    .catch(() => null);
  if (!user?.parentAccountId) return [parentUserId];
  const members = await prisma.user
    .findMany({ where: { parentAccountId: user.parentAccountId }, select: { id: true } })
    .catch(() => [] as any[]);
  const ids = (members || []).map((m: any) => m.id);
  return ids.length ? ids : [parentUserId];
}

/** The account id every JourneyEvent and IpFormResponse is keyed on. */
export async function resolveParentAccountId(parentUserId: string, client?: any): Promise<string> {
  const prisma = await db(client);
  const user = await prisma.user
    .findUnique({ where: { id: parentUserId }, select: { parentAccountId: true } })
    .catch(() => null);
  return user?.parentAccountId || parentUserId;
}

/**
 * Two providers that are legs of one international program (a surrogacy agency
 * paired with its partner IVF clinic). Checked in both directions because
 * either side may hold the link.
 */
async function arePartnerPrograms(a: string, b: string, client?: any): Promise<boolean> {
  if (!a || !b || a === b) return false;
  const prisma = await db(client);
  const rows = await prisma.provider
    .findMany({ where: { id: { in: [a, b] } }, select: { id: true, partnerProviderIds: true } })
    .catch(() => [] as any[]);
  for (const row of rows || []) {
    const ids = Array.isArray(row.partnerProviderIds)
      ? (row.partnerProviderIds as any[]).map(String)
      : [];
    const other = row.id === a ? b : a;
    if (ids.includes(other)) return true;
  }
  return false;
}

/**
 * Every consultation the family has open, with its release state resolved.
 *
 * Four batched queries, no N+1: bookings (with provider + services), the chat
 * sessions they belong to, the release events, and the live match calls that
 * keep a stale consultation alive.
 */
export async function listOpenConsultations(
  memberIds: string[],
  client?: any,
): Promise<OpenConsultation[]> {
  if (!memberIds?.length) return [];
  const prisma = await db(client);

  const bookings = await prisma.booking
    .findMany({
      where: {
        parentUserId: { in: memberIds },
        // Consultations only. A match call is the OUTCOME of a lock, not a lock.
        meetingSubtype: null,
        status: { in: LIVE_BOOKING_STATUSES },
        // GoStork staff have no providerId, so this also excludes concierge calls.
        providerUser: { providerId: { not: null } },
        // Prisma drops NULL rows from `notIn`, and an un-swept booking has
        // outcome: null - which is exactly the booking that SHOULD still lock.
        // Spelled out rather than relying on notIn.
        OR: [{ outcome: null }, { outcome: { notIn: NO_SHOW_OUTCOMES } }],
      },
      orderBy: { scheduledAt: "desc" },
      select: {
        id: true,
        sessionId: true,
        scheduledAt: true,
        status: true,
        createdAt: true,
        providerUser: {
          select: {
            provider: {
              select: {
                id: true,
                name: true,
                services: {
                  where: { status: "APPROVED" },
                  select: { providerType: { select: { name: true } } },
                },
              },
            },
          },
        },
      },
    })
    .catch(() => [] as any[]);
  if (!bookings?.length) return [];

  const sessionIds = bookings.map((b: any) => b.sessionId).filter(Boolean);
  const providerIds = Array.from(
    new Set(bookings.map((b: any) => b.providerUser?.provider?.id).filter(Boolean)),
  ) as string[];
  const accountId = await resolveParentAccountId(memberIds[0], client);

  const [sessions, releases, matchCalls] = await Promise.all([
    sessionIds.length
      ? prisma.aiChatSession
          .findMany({
            where: { id: { in: sessionIds } },
            select: { id: true, subjectType: true, title: true, handoffCompletedAt: true },
          })
          .catch(() => [] as any[])
      : Promise.resolve([] as any[]),
    prisma.journeyEvent
      .findMany({
        where: {
          parentAccountId: accountId,
          providerId: { in: providerIds },
          eventType: { in: RELEASE_EVENT_TYPES },
        },
        orderBy: { createdAt: "desc" },
        select: { providerId: true, eventType: true, createdAt: true, metadata: true },
      })
      .catch(() => [] as any[]),
    prisma.booking
      .findMany({
        where: {
          parentUserId: { in: memberIds },
          meetingSubtype: "MATCH_CALL",
          status: { notIn: ["CANCELLED", "EXPIRED", "RESCHEDULED"] },
          providerUser: { providerId: { in: providerIds } },
        },
        select: { providerUser: { select: { providerId: true } } },
      })
      .catch(() => [] as any[]),
  ]);

  type LoadedSession = { id: string; subjectType: string | null; title: string | null; handoffCompletedAt: Date | null };
  const sessionById = new Map<string, LoadedSession>(
    (sessions || []).map((s: any) => [s.id as string, s as LoadedSession]),
  );
  const matchCallProviderIds = new Set(
    (matchCalls || []).map((b: any) => b.providerUser?.providerId).filter(Boolean),
  );
  const now = Date.now();
  const windowMs = CONSULTATION_LOCK_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const out: OpenConsultation[] = [];
  for (const b of bookings as any[]) {
    const provider = b.providerUser?.provider;
    if (!provider?.id) continue;
    const session = b.sessionId ? sessionById.get(b.sessionId) : null;

    // A handed-off journey is finished business - it must never lock.
    if (session?.handoffCompletedAt) continue;

    const serviceNames = (provider.services || [])
      .map((s: any) => s.providerType?.name)
      .filter(Boolean) as string[];
    const providerTypeName = resolveTypeFromLoaded(serviceNames, session?.subjectType, provider.id);
    if (!providerTypeName) continue; // ambiguous: fail open, no lock

    const releaseEligibleAt = new Date(b.scheduledAt.getTime() + windowMs);
    let releasedBy: LockRelease = "NONE";

    // A release event only counts if it came AFTER this booking was made -
    // otherwise last month's "not a fit" would release a call booked today.
    const evt = (releases as any[]).find(
      (e) => e.providerId === provider.id && e.createdAt > b.createdAt,
    );
    if (evt) {
      if (evt.eventType === "CONSULTATION_NOT_A_FIT") releasedBy = "NOT_A_FIT";
      else releasedBy = (evt.metadata as any)?.reason === "ADMIN" ? "ADMIN_OVERRIDE" : "PARENT_MOVED_ON";
    } else if (
      b.scheduledAt.getTime() < now - windowMs &&
      !matchCallProviderIds.has(provider.id)
    ) {
      // Stale: the call happened over a week ago and went nowhere.
      releasedBy = "STALE_WINDOW";
    }

    out.push({
      bookingId: b.id,
      sessionId: b.sessionId ?? null,
      providerId: provider.id,
      providerName: provider.name,
      providerTypeName,
      scheduledAt: b.scheduledAt,
      status: b.status,
      subjectLabel: session?.title ?? null,
      releasedBy,
      releaseEligibleAt,
    });
  }
  return out;
}

/** Same rules as resolveLockProviderType, on already-loaded service names. */
function resolveTypeFromLoaded(
  serviceNames: string[],
  subjectType: string | null | undefined,
  providerId: string,
): LockedProviderType | null {
  if (!serviceNames.length) return null;
  const fromSubject = providerTypeFromSubject(subjectType);
  if (fromSubject && serviceNames.includes(fromSubject)) return fromSubject;
  if (serviceNames.length === 1) {
    // Only lock on a line the lock actually knows about.
    const only = serviceNames[0];
    return isLockedProviderType(only) ? only : null;
  }
  console.warn(
    `[consultation-lock] Ambiguous service line for provider ${providerId} (runs ${serviceNames.join(", ")}) - failing OPEN`,
  );
  return null;
}

/**
 * THE single answer to "can this family open a new consultation with X?".
 *
 * Every enforcement point calls this - the booking endpoint, Eva's context
 * builder, the tag parser, and the lawyer-connect path - so there is exactly
 * one place the policy can be wrong.
 */
export async function evaluateConsultationLock(input: {
  parentUserId: string;
  targetProviderId: string;
  subjectType?: string | null;
  client?: any;
}): Promise<ConsultationLockDecision> {
  const none: ConsultationLockDecision = {
    allowed: true,
    providerTypeName: null,
    blocker: null,
    code: null,
    message: null,
  };
  if (!input.parentUserId || !input.targetProviderId) return none;

  const targetType = await resolveLockProviderType(
    input.targetProviderId,
    input.subjectType,
    input.client,
  );
  if (!targetType) return none; // already warned inside the resolver

  const memberIds = await expandParentAccount(input.parentUserId, input.client);
  const open = await listOpenConsultations(memberIds, input.client);

  let blocker =
    open.find(
      (o) =>
        o.releasedBy === "NONE" &&
        o.providerTypeName === targetType &&
        // A provider never blocks itself - rebooking or a second thread with
        // the same agency is the flow working, not a violation.
        o.providerId !== input.targetProviderId,
    ) || null;

  // International programs: an agency and its partner clinic are two legs of
  // ONE decision, so they never block each other even if both run the same line.
  if (blocker && (await arePartnerPrograms(blocker.providerId, input.targetProviderId, input.client))) {
    blocker = null;
  }

  if (!blocker) return { ...none, providerTypeName: targetType };

  return {
    allowed: false,
    providerTypeName: targetType,
    blocker,
    code: "CONSULTATION_ALREADY_OPEN",
    message: `You already have a consultation booked with ${blocker.providerName}. Let's see that one through before opening another - you can always tell me if you'd rather move on from them.`,
  };
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

/** The parent decided to move on, or an admin unlocked it for them. */
export async function releaseConsultationLock(input: {
  parentUserId?: string | null;
  parentAccountId?: string | null;
  providerId: string;
  reason: "PARENT_MOVED_ON" | "ADMIN";
  note?: string | null;
  actorUserId?: string | null;
  actorName?: string | null;
  sessionId?: string | null;
}): Promise<void> {
  await emitEvent({
    eventType: "CONSULTATION_LOCK_RELEASED",
    parentAccountId: input.parentAccountId ?? undefined,
    parentUserId: input.parentUserId ?? undefined,
    providerId: input.providerId,
    sessionId: input.sessionId ?? undefined,
    actorRole: input.reason === "ADMIN" ? "admin" : "parent",
    metadata: {
      reason: input.reason,
      note: input.note ?? null,
      actorUserId: input.actorUserId ?? null,
      actorName: input.actorName ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Consent gates
// ---------------------------------------------------------------------------

export type MatchCallGateCode =
  | "IP_FORM_REQUIRED"
  | "BOTH_PARENTS_ACK_REQUIRED"
  | "MATCH_DECISION_ACK_REQUIRED";

export type ConsentGate =
  | "PRELIMINARY_STEP"
  | "BOTH_PARENTS"
  | "DECISION_WINDOW";

/**
 * The preliminary-step fork. MATCH_INTEREST = the parent is seriously
 * considering this profile (the agency preps for the call as real interest).
 * INFO_ONLY = still researching, wants a general information call - the call
 * happens either way, but the provider is told honestly which one it is and
 * no "a family wants her" signal is created for the profile.
 */
export type ConsultIntent = "MATCH_INTEREST" | "INFO_ONLY";

/** uiCardType per gate. Registered in parent-visibility.ts + both card dispatchers. */
export const GATE_CARD_TYPE: Record<ConsentGate, string> = {
  PRELIMINARY_STEP: "consult_preliminary_ack",
  BOTH_PARENTS: "match_call_attendance_ack",
  DECISION_WINDOW: "match_call_decision_ack",
};

const GATE_EVENT_TYPE: Record<ConsentGate, any> = {
  PRELIMINARY_STEP: "CONSULT_PRELIM_ACKNOWLEDGED",
  BOTH_PARENTS: "MATCH_CALL_ATTENDANCE_ACKNOWLEDGED",
  DECISION_WINDOW: "MATCH_CALL_DECISION_ACKNOWLEDGED",
};

export interface DepositSnapshot {
  source: "QUOTE" | "COST_SHEET" | "NONE";
  label: string | null;
  minCents: number | null;
  maxCents: number | null;
  triggerLabel: string | null;
  payToLabel: string | null;
  isRefundable: boolean | null;
  refundNote: string | null;
  /** True when this agency takes the deposit at medical clearance, not at match. */
  depositAtClearance: boolean;
}

const EMPTY_DEPOSIT: DepositSnapshot = {
  source: "NONE",
  label: null,
  minCents: null,
  maxCents: null,
  triggerLabel: null,
  payToLabel: null,
  isRefundable: null,
  refundNote: null,
  depositAtClearance: false,
};

/**
 * The real at-match deposit figure for an agency, or an honest blank.
 *
 * Order matters: the quote already sent to THIS family beats the provider's
 * generic sheet, because that is the number they were actually shown.
 *
 * NEVER invents an amount. When nothing is on file it returns source "NONE"
 * and the card falls back to policy wording with no figure - a fabricated
 * number on the largest financial decision these parents make would be far
 * worse than admitting we do not have it yet.
 */
export async function resolveDepositSnapshot(
  providerId: string,
  memberIds: string[],
  client?: any,
): Promise<DepositSnapshot> {
  if (!providerId) return EMPTY_DEPOSIT;
  const prisma = await db(client);

  const provider = await prisma.provider
    .findUnique({ where: { id: providerId }, select: { depositMilestone: true } })
    .catch(() => null);
  const depositAtClearance = provider?.depositMilestone === "AT_CLEARANCE";

  const pick = (tranches: any[]) =>
    (tranches || []).find((t: any) => t.triggerType === "AT_MATCH") || null;

  // 1. The quote this family actually holds.
  const quote = await prisma.providerQuote
    .findFirst({
      where: { providerId, parentUserId: { in: memberIds }, supersededAt: null },
      orderBy: { createdAt: "desc" },
      select: { paymentSchedule: true },
    })
    .catch(() => null);
  const quoted = pick((quote?.paymentSchedule as any)?.tranches || []);
  if (quoted) return shapeDeposit("QUOTE", quoted, depositAtClearance);

  // 2. The provider's approved sheet - only if THEY confirmed the schedule.
  //    An ai_proposed schedule is provider-only and must never be quoted at a
  //    parent as if it were real.
  const sheets = await prisma.providerCostSheet
    .findMany({
      where: { providerId, status: "APPROVED" },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: {
        scheduleSource: true,
        tranches: {
          orderBy: { sortOrder: "asc" },
          select: {
            name: true,
            triggerType: true,
            triggerLabel: true,
            minValueCents: true,
            maxValueCents: true,
            payToLabel: true,
            isRefundable: true,
            refundNote: true,
          },
        },
      },
    })
    .catch(() => [] as any[]);
  for (const sheet of sheets || []) {
    if (!isParentVisibleSchedule(sheet.scheduleSource)) continue;
    const t = pick(sheet.tranches);
    if (t) return shapeDeposit("COST_SHEET", t, depositAtClearance);
  }

  return { ...EMPTY_DEPOSIT, depositAtClearance };
}

function shapeDeposit(
  source: "QUOTE" | "COST_SHEET",
  t: any,
  depositAtClearance: boolean,
): DepositSnapshot {
  return {
    source,
    label: t.name ?? null,
    minCents: t.minValueCents ?? null,
    maxCents: t.maxValueCents ?? null,
    triggerLabel: t.triggerLabel ?? null,
    payToLabel: t.payToLabel ?? null,
    isRefundable: t.isRefundable ?? null,
    refundNote: t.refundNote ?? null,
    depositAtClearance,
  };
}

/**
 * Is this family a couple? Any one signal is enough - we would rather ask a
 * solo parent to confirm one checkbox than let half a couple meet a surrogate.
 */
export async function requiresBothParents(
  memberIds: string[],
  parentAccountId: string,
  client?: any,
): Promise<{ required: boolean; reason: string | null; partnerFirstName: string | null }> {
  const prisma = await db(client);
  if (memberIds.length > 1) {
    return { required: true, reason: "ACCOUNT_MEMBERS", partnerFirstName: null };
  }
  const [user, profile, ipForm] = await Promise.all([
    prisma.user
      .findUnique({
        where: { id: memberIds[0] },
        select: { relationshipStatus: true, partnerFirstName: true },
      })
      .catch(() => null),
    prisma.intendedParentProfile
      .findUnique({ where: { parentAccountId }, select: { sameSexCouple: true } })
      .catch(() => null),
    prisma.ipFormResponse
      .findUnique({ where: { parentAccountId }, select: { hasSecondParent: true, hasSecondParentManual: true } })
      .catch(() => null),
  ]);

  const partnerFirstName = user?.partnerFirstName || null;
  if (/married|partner|couple|relationship/i.test(user?.relationshipStatus || "")) {
    return { required: true, reason: "RELATIONSHIP", partnerFirstName };
  }
  if (partnerFirstName) return { required: true, reason: "RELATIONSHIP", partnerFirstName };
  if (profile?.sameSexCouple) return { required: true, reason: "RELATIONSHIP", partnerFirstName };
  // hasSecondParent defaults to true, so only trust it once a parent has
  // explicitly confirmed it (hasSecondParentManual) - otherwise every solo
  // parent would be asked to promise their imaginary partner attends.
  if (ipForm?.hasSecondParentManual && ipForm?.hasSecondParent) {
    return { required: true, reason: "SECOND_PARENT_ON_FORM", partnerFirstName };
  }
  return { required: false, reason: null, partnerFirstName };
}

/**
 * Has this family ticked a given gate for this provider + subject, since the
 * booking that made it relevant?
 *
 * Scoping matters in both directions: too loose and a year-old tick waves
 * through a brand-new surrogate; too tight and the parent is asked the same
 * question forever.
 */
async function hasAck(input: {
  gate: ConsentGate;
  parentAccountId: string;
  providerId: string;
  subjectProfileId?: string | null;
  since: Date | null;
  client?: any;
}): Promise<Date | null> {
  const prisma = await db(input.client);
  const rows = await prisma.journeyEvent
    .findMany({
      where: {
        parentAccountId: input.parentAccountId,
        providerId: input.providerId,
        eventType: GATE_EVENT_TYPE[input.gate],
        ...(input.since ? { createdAt: { gt: input.since } } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, metadata: true },
    })
    .catch(() => [] as any[]);
  for (const r of rows || []) {
    const acked = (r.metadata as any)?.subjectProfileId ?? null;
    // A subject-scoped ack must match the subject; an unscoped legacy ack counts.
    if (!input.subjectProfileId || !acked || acked === input.subjectProfileId) {
      return r.createdAt;
    }
  }
  return null;
}

/**
 * Which fork did this family choose on the newest preliminary ack for this
 * provider (+ subject)? Resolved from the JourneyEvent at read time - nothing
 * stored - so the booking flow can label the call honestly for the provider.
 * Defaults to MATCH_INTEREST: every ack before the fork existed was exactly
 * that, and a wrong "info only" label would understate real interest.
 */
export async function latestConsultIntent(input: {
  parentUserId: string;
  providerId: string;
  subjectProfileId?: string | null;
  client?: any;
}): Promise<ConsultIntent> {
  const prisma = await db(input.client);
  const accountId = await resolveParentAccountId(input.parentUserId, input.client);
  const rows = await prisma.journeyEvent
    .findMany({
      where: {
        parentAccountId: accountId,
        providerId: input.providerId,
        eventType: GATE_EVENT_TYPE.PRELIMINARY_STEP,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { metadata: true },
    })
    .catch(() => [] as any[]);
  for (const r of rows || []) {
    const acked = (r.metadata as any)?.subjectProfileId ?? null;
    // Same subject scoping as hasAck: a subject-scoped ack must match; an
    // unscoped legacy ack counts.
    if (!input.subjectProfileId || !acked || acked === input.subjectProfileId) {
      return (r.metadata as any)?.consultIntent === "INFO_ONLY" ? "INFO_ONLY" : "MATCH_INTEREST";
    }
  }
  return "MATCH_INTEREST";
}

/** Newest booking of a kind for this family + provider, as the ack cutoff. */
async function latestBookingAt(input: {
  memberIds: string[];
  providerId: string;
  matchCall: boolean;
  client?: any;
}): Promise<Date | null> {
  const prisma = await db(input.client);
  const b = await prisma.booking
    .findFirst({
      where: {
        parentUserId: { in: input.memberIds },
        meetingSubtype: input.matchCall ? "MATCH_CALL" : null,
        providerUser: { providerId: input.providerId },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    })
    .catch(() => null);
  return b?.createdAt ?? null;
}

export interface MatchCallGateResult {
  allowed: boolean;
  code: MatchCallGateCode | null;
  /** Provider-facing at the 409 sites - they are the ones who see it. */
  message: string;
  missing: ConsentGate[];
  /** Set when the IP form is what's missing, so callers need no second query. */
  ipFormMissing: boolean;
  deposit: DepositSnapshot;
  bothParents: { required: boolean; reason: string | null; partnerFirstName: string | null };
}

/**
 * The three things that must be true before a match call can be scheduled.
 *
 * Order is fixed - IP form, then both parents, then the decision window - so
 * the parent is never asked three things at once and the provider always sees
 * one clear blocker.
 */
export async function evaluateMatchCallGates(input: {
  parentUserId: string;
  providerId: string;
  subjectProfileId?: string | null;
  client?: any;
}): Promise<MatchCallGateResult> {
  const prisma = await db(input.client);

  // MATCH-CALL GATES ARE A SURROGACY CONCEPT: the IP form (the family story
  // an agency shows to surrogates), the both-parents attendance confirmation,
  // and the decision-window/deposit acknowledgement exist for SURROGATE match
  // calls. Observed live (session 3xympn): an egg-donor call was 409'd with a
  // confirm-something + IP-form demand - nothing to confirm on screen, and
  // the form does not apply to egg donation (the parent said exactly that).
  // When the subject profile resolves to a known egg/sperm donor, every gate
  // passes. A known surrogate, an unknown id, or no subject at all keeps the
  // full gate set (conservative default - a generic match call with a
  // connected surrogacy agency is still a surrogacy match call).
  if (input.subjectProfileId) {
    const sid = String(input.subjectProfileId);
    try {
      const [isSurrogate, isEggDonor, isSpermDonor] = await Promise.all([
        prisma.surrogate.findFirst({ where: { OR: [{ id: sid }, { externalId: sid }] }, select: { id: true } }).catch(() => null),
        prisma.eggDonor.findFirst({ where: { OR: [{ id: sid }, { externalId: sid }] }, select: { id: true } }).catch(() => null),
        prisma.spermDonor.findFirst({ where: { OR: [{ id: sid }, { externalId: sid }] }, select: { id: true } }).catch(() => null),
      ]);
      if (!isSurrogate && (isEggDonor || isSpermDonor)) {
        return {
          allowed: true,
          code: null,
          message: "",
          missing: [],
          ipFormMissing: false,
          deposit: {
            source: "NONE",
            label: null,
            minCents: null,
            maxCents: null,
            triggerLabel: null,
            payToLabel: null,
            isRefundable: null,
            refundNote: null,
            depositAtClearance: false,
          },
          bothParents: { required: false, reason: null, partnerFirstName: null },
        };
      }
    } catch {
      /* fail closed into the normal gate evaluation below */
    }
  }

  const memberIds = await expandParentAccount(input.parentUserId, input.client);
  const accountId = await resolveParentAccountId(input.parentUserId, input.client);

  const [ipForm, bothParents, deposit, since] = await Promise.all([
    prisma.ipFormResponse
      .findUnique({ where: { parentAccountId: accountId }, select: { status: true } })
      .catch(() => null),
    requiresBothParents(memberIds, accountId, input.client),
    resolveDepositSnapshot(input.providerId, memberIds, input.client),
    latestBookingAt({ memberIds, providerId: input.providerId, matchCall: true, client: input.client }),
  ]);

  const missing: ConsentGate[] = [];
  const ipFormMissing = ipForm?.status !== "SUBMITTED";

  if (bothParents.required) {
    const acked = await hasAck({
      gate: "BOTH_PARENTS",
      parentAccountId: accountId,
      providerId: input.providerId,
      subjectProfileId: input.subjectProfileId,
      since,
      client: input.client,
    });
    if (!acked) missing.push("BOTH_PARENTS");
  }
  const decisionAcked = await hasAck({
    gate: "DECISION_WINDOW",
    parentAccountId: accountId,
    providerId: input.providerId,
    subjectProfileId: input.subjectProfileId,
    since,
    client: input.client,
  });
  if (!decisionAcked) missing.push("DECISION_WINDOW");

  if (ipFormMissing) {
    return {
      allowed: false,
      code: "IP_FORM_REQUIRED",
      message:
        "The parents have not submitted their Intended Parent Form yet. A match call can be scheduled once the form is complete - the parents have been asked to fill it.",
      missing,
      ipFormMissing,
      deposit,
      bothParents,
    };
  }
  if (missing.includes("BOTH_PARENTS")) {
    return {
      allowed: false,
      code: "BOTH_PARENTS_ACK_REQUIRED",
      message:
        "Both intended parents must attend the match call, and this family has not confirmed that yet. They have been asked in their chat - you can propose times as soon as they confirm.",
      missing,
      ipFormMissing,
      deposit,
      bothParents,
    };
  }
  if (missing.includes("DECISION_WINDOW")) {
    return {
      allowed: false,
      code: "MATCH_DECISION_ACK_REQUIRED",
      message:
        "The parents have not yet confirmed they understand the 24-hour decision window and the match deposit. They have been asked in their chat - you can propose times as soon as they confirm.",
      missing,
      ipFormMissing,
      deposit,
      bothParents,
    };
  }
  return { allowed: true, code: null, message: "", missing: [], ipFormMissing, deposit, bothParents };
}

/**
 * Gate A: the parent must acknowledge that an agency consultation is the
 * preliminary step toward a match call with THIS profile, not an info call.
 * Asked before every agency consultation - each new agency, every time.
 */
export async function evaluateConsultationAckGate(input: {
  parentUserId: string;
  providerId: string;
  subjectProfileId?: string | null;
  client?: any;
}): Promise<{ allowed: boolean; code: "CONSULT_PRELIM_ACK_REQUIRED" | null; message: string }> {
  const memberIds = await expandParentAccount(input.parentUserId, input.client);
  const accountId = await resolveParentAccountId(input.parentUserId, input.client);
  const since = await latestBookingAt({
    memberIds,
    providerId: input.providerId,
    matchCall: false,
    client: input.client,
  });
  const acked = await hasAck({
    gate: "PRELIMINARY_STEP",
    parentAccountId: accountId,
    providerId: input.providerId,
    subjectProfileId: input.subjectProfileId,
    since,
    client: input.client,
  });
  if (acked) return { allowed: true, code: null, message: "" };
  return {
    allowed: false,
    code: "CONSULT_PRELIM_ACK_REQUIRED",
    message:
      "Almost there - there's a quick confirmation card waiting in your chat. Tap \"I understand\" on it and the calendar will open for you.",
  };
}

// ---------------------------------------------------------------------------
// Posting the ack cards
// ---------------------------------------------------------------------------

const CONFIDENTIAL_AGENCY_TYPES = ["Surrogacy Agency", "Egg Donor Agency"];

/**
 * Does the preliminary-step ack apply to this provider at all?
 *
 * Only donor/surrogate AGENCIES: their consultation signals real interest in
 * a specific person, which is the whole thing the ack makes explicit. It was
 * being enforced on every concierge booking, so a LAWYER'S calendar 409'd
 * with "the agency treats it as real interest in this profile" (observed
 * live with IFLG). Clinics, banks and legal always pass. Fails open.
 */
export async function providerRequiresPreliminaryAck(
  providerId: string,
  client?: any,
): Promise<boolean> {
  const prisma = await db(client);
  const provider = await prisma.provider
    .findUnique({
      where: { id: providerId },
      select: { services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } } },
    })
    .catch(() => null);
  if (!provider) return false;
  return (provider.services || []).some((s: any) =>
    CONFIDENTIAL_AGENCY_TYPES.includes(s.providerType?.name || ""),
  );
}

/**
 * The provider name a PRE-BOOKING card may show.
 *
 * Until the parent actually books, a donor/surrogate agency's identity stays
 * hidden - name, logo, coordinator surname. Clinics, lawyers and GoStork are
 * direct providers whose names are always visible. Same rule as the
 * pre-booking consultation card in ai-router.ts.
 */
export async function maskedProviderName(
  providerId: string,
  subjectType?: string | null,
  client?: any,
): Promise<string> {
  const prisma = await db(client);
  const provider = await prisma.provider
    .findUnique({
      where: { id: providerId },
      select: {
        name: true,
        services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } },
      },
    })
    .catch(() => null);
  if (!provider) return "the agency";
  const confidential = (provider.services || []).some((s: any) =>
    CONFIDENTIAL_AGENCY_TYPES.includes(s.providerType?.name || ""),
  );
  if (!confidential) return provider.name;
  const st = (subjectType || "").toLowerCase();
  return st.includes("egg")
    ? "the Egg Donor's Agency"
    : st.includes("sperm")
      ? "the Sperm Donor's Agency"
      : "the Surrogate's Agency";
}

/**
 * Post an ack card, once.
 *
 * Idempotent on (session, cardType, subjectProfileId) with no acknowledgedAt -
 * a provider retrying propose-call-times three times must not stack three
 * identical cards in the family's chat.
 */
async function postGateCard(input: {
  gate: ConsentGate;
  sessionId: string;
  content: string;
  providerContent?: string | null;
  cardData: Record<string, unknown>;
  subjectProfileId?: string | null;
  client?: any;
}): Promise<any | null> {
  const prisma = await db(input.client);
  const cardType = GATE_CARD_TYPE[input.gate];
  const existing = await prisma.aiChatMessage
    .findFirst({
      where: { sessionId: input.sessionId, uiCardType: cardType },
      orderBy: { createdAt: "desc" },
      select: { id: true, uiCardData: true },
    })
    .catch(() => null);
  if (existing) {
    const data = (existing.uiCardData as any) || {};
    const sameSubject =
      !input.subjectProfileId || (data.subjectProfileId ?? null) === input.subjectProfileId;
    if (sameSubject && !data.acknowledgedAt) {
      // Already asked, still open. If the caller carries a held calendar
      // (pendingConsultationCard), the old open card may be sitting far up in
      // scrollback (observed live: a 40-minute-old card, invisible while Eva
      // says "see the card below"). Delete it and fall through to create a
      // fresh one at the bottom with the CURRENT calendar - still exactly one
      // open card, just where the parent is looking.
      const pending = (input.cardData as any)?.pendingConsultationCard;
      if (!pending) return null;
      await prisma.aiChatMessage
        .delete({ where: { id: existing.id } })
        .catch((e: any) =>
          console.error(`[consultation-gates] Stale open card delete failed (${cardType}): ${e?.message}`),
        );
    }
  }

  const created = await prisma.aiChatMessage
    .create({
      data: {
        sessionId: input.sessionId,
        role: "assistant",
        content: input.content,
        senderType: "system",
        senderName: "GoStork",
        uiCardType: cardType,
        uiCardData: {
          gate: input.gate,
          ...input.cardData,
          ...(input.providerContent ? { providerContent: input.providerContent } : {}),
          acknowledgedAt: null,
          acknowledgedByName: null,
        } as any,
      },
    })
    .catch((e: any) => {
      console.error(`[consultation-gates] Card post failed (${cardType}): ${e?.message}`);
      return null;
    });
  return created;
}

/**
 * Gate A card, in the parent's PRIVATE Eva chat - it renders pre-booking, when
 * the agency's identity is still masked, so it must not go anywhere the
 * provider can read it.
 */
export async function postPreliminaryAckCard(input: {
  parentUserId: string;
  providerId: string;
  subjectProfileId?: string | null;
  subjectType?: string | null;
  subjectLabel?: string | null;
  /**
   * The session the booking widget was embedded in. Used when the canonical
   * Eva lookup comes up empty - refusing the booking AND dropping the card
   * would leave the parent staring at an error with no way through it, and
   * this gate is the only one whose card has nowhere else to go.
   */
  fallbackSessionId?: string | null;
  /**
   * Extra fields merged into the card's uiCardData. The concierge path stashes
   * the fully-built consultation calendar here (pendingConsultationCard) so
   * the acknowledge endpoint can post it the moment the parent ticks the card
   * - ask first, calendar second.
   */
  extraCardData?: Record<string, unknown>;
  client?: any;
}): Promise<any | null> {
  const { resolveParentEvaSessionId } = await import("./parent-visibility");
  const memberIds = await expandParentAccount(input.parentUserId, input.client);
  const sessionId =
    (await resolveParentEvaSessionId(memberIds, input.client)) || input.fallbackSessionId || null;
  if (!sessionId) {
    console.error(
      `[consultation-gates] No session to post the preliminary ack card for parent ${input.parentUserId} - the booking will be refused with no way through. THIS IS A DEAD END.`,
    );
    return null;
  }
  const displayName = await maskedProviderName(input.providerId, input.subjectType, input.client);
  const subject = input.subjectLabel || "this profile";
  return postGateCard({
    gate: "PRELIMINARY_STEP",
    sessionId,
    content:
      `Before we open the calendar, we want to be upfront about what this call is. It's the first step toward a match call with ${subject} specifically, not a general information session. ` +
      `Once it's booked, ${displayName} treats it as real interest: they prepare for the call around ${subject} and start thinking seriously about fit with your family. ` +
      `It's still completely free and nothing is binding - this just makes sure everyone walks into the call on the same page. ` +
      `If ${subject} is someone you're seriously considering, confirm below and the calendar will open right here. ` +
      `Still exploring? That's completely fine too - choose the info call option instead and you can talk with the agency without signaling commitment to ${subject}.`,
    cardData: {
      providerId: input.providerId,
      providerDisplayName: displayName,
      subjectLabel: input.subjectLabel ?? null,
      subjectProfileId: input.subjectProfileId ?? null,
      subjectType: input.subjectType ?? null,
      ...(input.extraCardData || {}),
    },
    subjectProfileId: input.subjectProfileId,
    client: input.client,
  });
}

/**
 * Gates B and C, in the SHARED thread.
 *
 * Deliberately shared, not private: the provider is the one who hits the 409
 * on propose-call-times, and being told "no" with no visible cause is how the
 * IP-form gate used to feel. Here they can see exactly what the family still
 * owes.
 */
export async function postMissingGateCards(input: {
  sessionId: string;
  parentUserId: string;
  providerId: string;
  providerName?: string | null;
  subjectLabel?: string | null;
  subjectProfileId?: string | null;
  gates: ConsentGate[];
  deposit: DepositSnapshot;
  bothParents: { required: boolean; reason: string | null; partnerFirstName: string | null };
  client?: any;
}): Promise<void> {
  const subject = input.subjectLabel || "your match";
  const agency = input.providerName || "the agency";

  if (input.gates.includes("BOTH_PARENTS")) {
    const partner = input.bothParents.partnerFirstName;
    await postGateCard({
      gate: "BOTH_PARENTS",
      sessionId: input.sessionId,
      content: `Both of you need to be on the match call with ${subject}${partner ? ` - you and ${partner}` : ""}. A surrogate is choosing a family, and meeting half of one tells her very little. Confirm below and ${agency} can send you times.`,
      providerContent: `Waiting on the parents to confirm that BOTH of them will attend the match call for ${subject}. You can propose times as soon as they tick it.`,
      cardData: {
        providerId: input.providerId,
        subjectLabel: input.subjectLabel ?? null,
        subjectProfileId: input.subjectProfileId ?? null,
        partnerFirstName: partner,
        requiredBecause: input.bothParents.reason,
      },
      subjectProfileId: input.subjectProfileId,
      client: input.client,
    });
  }

  if (input.gates.includes("DECISION_WINDOW")) {
    await postGateCard({
      gate: "DECISION_WINDOW",
      sessionId: input.sessionId,
      content: input.deposit.depositAtClearance
        ? `One thing to know before the match call: if it goes well, ${subject} goes on hold for you and you have 24 hours to decide. ${agency} takes the deposit at medical clearance rather than at match, so nothing is due the day of the call - but the decision still is.`
        : `One thing to know before the match call: if it goes well, ${subject} goes on hold exclusively for you and you have 24 hours to decide and place the match deposit. We would rather you see the number now than on an invoice.`,
      providerContent: `Waiting on the parents to confirm they understand the 24-hour decision window${input.deposit.depositAtClearance ? "" : " and the match deposit"} for ${subject}. You can propose times as soon as they tick it.`,
      cardData: {
        providerId: input.providerId,
        subjectLabel: input.subjectLabel ?? null,
        subjectProfileId: input.subjectProfileId ?? null,
        deposit: input.deposit,
        policyText:
          input.deposit.source === "NONE"
            ? `${agency} sets the exact deposit amount. Ask them here and they'll confirm it before the call.`
            : null,
      },
      subjectProfileId: input.subjectProfileId,
      client: input.client,
    });
  }
}

/** Write a consent tick. The JourneyEvent row IS the acknowledgement. */
export async function recordGateAck(input: {
  gate: ConsentGate;
  parentUserId: string;
  providerId: string;
  subjectProfileId?: string | null;
  subjectType?: string | null;
  sessionId?: string | null;
  actorUserId?: string | null;
  actorName?: string | null;
  /** The figure the card actually displayed - the one that matters. */
  depositSnapshot?: DepositSnapshot | null;
  /** What the provider's sheet said at click time, when it differs. */
  liveDepositAtAck?: DepositSnapshot | null;
  /**
   * PRELIMINARY_STEP only: which fork the parent chose. MATCH_INTEREST is the
   * classic "I understand" (real interest in this profile); INFO_ONLY means
   * they are still researching and want a general information call. Both
   * satisfy the gate - the difference is what the PROVIDER is told at booking.
   */
  consultIntent?: ConsultIntent | null;
}): Promise<void> {
  await emitEvent({
    eventType: GATE_EVENT_TYPE[input.gate],
    parentUserId: input.parentUserId,
    providerId: input.providerId,
    sessionId: input.sessionId ?? undefined,
    actorRole: "parent",
    metadata: {
      subjectProfileId: input.subjectProfileId ?? null,
      subjectType: input.subjectType ?? null,
      actorUserId: input.actorUserId ?? null,
      actorName: input.actorName ?? null,
      ...(input.gate === "PRELIMINARY_STEP" && input.consultIntent
        ? { consultIntent: input.consultIntent }
        : {}),
      // The figure the parent was actually shown, frozen at the moment they
      // ticked. This is the part that matters if anyone ever disputes it.
      ...(input.gate === "DECISION_WINDOW" && input.depositSnapshot
        ? { depositSnapshot: input.depositSnapshot }
        : {}),
      ...(input.liveDepositAtAck ? { liveDepositAtAck: input.liveDepositAtAck } : {}),
    },
  });
}
