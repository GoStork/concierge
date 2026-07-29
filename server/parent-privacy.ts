/**
 * Two-tier parent privacy: who may see a parent's NAME, and who may see their
 * CONTACT DETAILS.
 *
 * GoStork 1.0's core failure was leakage. A provider got the parent's email and
 * phone at the moment a call was booked, and the relationship left the platform.
 * Everything after that - the scheduling, the documents, the payments, the
 * record of what was promised - happened somewhere GoStork could not see, and
 * the parent lost every protection the platform exists to give them.
 *
 * So there are now TWO gates, not one:
 *
 *   Gate A - IDENTITY. Name, photo, city/state, profile answers, the full
 *   message transcript. Opens when the parent books a consultation, when a
 *   provider is connected, when there is a confirmed booking, or whenever
 *   Gate B is open.
 *
 *   Gate B - CONTACT. Email, mobile number, date of birth, address, the
 *   Intended Parent Form PDF, the invoice contact block, the calendar attendee
 *   address. Opens ONLY when the parent takes a committing action with that
 *   specific provider: submitting their IP Form to them, receiving an invoice
 *   or a sent agreement from them, requesting a callback, or a GoStork admin
 *   unlocking the pair by hand.
 *
 * Gate B is scoped to a (providerId, parentAccountId) PAIR, never a session: a
 * parent has several sibling sessions with the same provider (see
 * findMergeableSiblingSessions in chat-router.ts), and a per-session answer
 * would show the same human as "Prospective Parent" in one inbox row and by
 * name in the next.
 *
 * This module is the single source of truth. Before it, `showIdentity` was
 * re-derived in about six places, each subtly different, and the answer always
 * bundled the email in with the name. Sits beside server/parent-visibility.ts,
 * which answers the mirror-image question (what may a PARENT see).
 */

import { prisma as defaultPrisma } from "./db";

export type ReleaseReason = "IP_FORM" | "INVOICE" | "AGREEMENT" | "CALLBACK" | "ADMIN";

export interface ParentGates {
  /** Name, photo, city/state, profile answers, full transcript. */
  showIdentity: boolean;
  /** Email, mobileNumber, dateOfBirth, address, IP-form PDF, calendar attendee. */
  showContact: boolean;
  contactReason: ReleaseReason | null;
}

export const GATES_CLOSED: ParentGates = { showIdentity: false, showContact: false, contactReason: null };
/** For the parent viewing their own data, and for GoStork staff. */
export const GATES_OPEN: ParentGates = { showIdentity: true, showContact: true, contactReason: null };

const IDENTITY_STATUSES = new Set(["CONSULTATION_BOOKED", "PROVIDER_CONNECTED"]);

/**
 * The account key every release row is written under.
 *
 * `parentAccountId` is nullable, so the codebase convention everywhere is
 * `u.parentAccountId || u.id`. Keep using this helper rather than re-typing it:
 * a release written while a user was solo is keyed on their userId, and reads
 * must be able to find it after they later join a ParentAccount.
 */
export function parentAccountKey(u: { id: string; parentAccountId?: string | null } | null | undefined): string {
  if (!u) return "";
  return u.parentAccountId || u.id;
}

export interface GateInput {
  accountKey: string;
  /** Status of the session being rendered, if any. */
  sessionStatus?: string | null;
  /** Statuses of every sibling session for this pair, when the caller has them. */
  siblingStatuses?: (string | null | undefined)[];
  /** A confirmed booking with this provider opens Gate A (never Gate B). */
  hasBooking?: boolean;
}

/**
 * Resolve gates for many parents in ONE indexed query.
 *
 * Use this on every list endpoint (the provider inbox renders ~50 sessions; the
 * /parents page renders every parent an org has ever met). Resolving per row
 * would turn one page into N round trips.
 *
 * No TTL cache, deliberately: the table is tiny, the lookup is a single
 * unique-index scan, and a cache would make an admin's manual unlock appear not
 * to work for however long the TTL lasted.
 */
export async function resolveParentGatesBatch(
  providerId: string | null | undefined,
  inputs: GateInput[],
  client?: any,
): Promise<Map<string, ParentGates>> {
  const out = new Map<string, ParentGates>();
  if (!providerId || inputs.length === 0) {
    for (const i of inputs) out.set(i.accountKey, GATES_CLOSED);
    return out;
  }
  const db = client ?? defaultPrisma;
  const keys = Array.from(new Set(inputs.map((i) => i.accountKey).filter(Boolean)));
  const rows = keys.length
    ? await db.parentContactRelease.findMany({
        where: { providerId, parentAccountId: { in: keys } },
        select: { parentAccountId: true, reason: true },
      })
    : [];
  const released = new Map<string, ReleaseReason>(
    rows.map((r: any) => [r.parentAccountId, r.reason as ReleaseReason]),
  );

  // Gate A is PAIR-scoped: fold every input for the same account together, so a
  // parent who booked on one thread is not still "Prospective Parent" on another.
  const identityByKey = new Map<string, boolean>();
  for (const i of inputs) {
    const statuses = [i.sessionStatus, ...(i.siblingStatuses || [])];
    const opens = i.hasBooking === true || statuses.some((s) => s && IDENTITY_STATUSES.has(s));
    identityByKey.set(i.accountKey, (identityByKey.get(i.accountKey) || false) || opens);
  }

  for (const i of inputs) {
    const reason = released.get(i.accountKey) || null;
    const showContact = reason !== null;
    out.set(i.accountKey, {
      showContact,
      // Contact release always implies identity: a provider holding an invoice
      // with the parent's name on it cannot meaningfully be shown a stub.
      showIdentity: showContact || identityByKey.get(i.accountKey) === true,
      contactReason: reason,
    });
  }
  return out;
}

/** Single-pair convenience wrapper around resolveParentGatesBatch. */
export async function resolveParentGates(
  providerId: string | null | undefined,
  accountKey: string,
  opts: Omit<GateInput, "accountKey"> = {},
  client?: any,
): Promise<ParentGates> {
  if (!accountKey) return GATES_CLOSED;
  const map = await resolveParentGatesBatch(providerId, [{ accountKey, ...opts }], client);
  return map.get(accountKey) || GATES_CLOSED;
}

/** Has this pair been released, ignoring session state entirely? */
export async function hasContactRelease(
  providerId: string | null | undefined,
  accountKey: string,
  client?: any,
): Promise<boolean> {
  if (!providerId || !accountKey) return false;
  const db = client ?? defaultPrisma;
  const row = await db.parentContactRelease.findUnique({
    where: { providerId_parentAccountId: { providerId, parentAccountId: accountKey } },
    select: { id: true },
  });
  return !!row;
}

/** Every parent account this provider has been released to. */
export async function releasedAccountIds(providerId: string | null | undefined, client?: any): Promise<string[]> {
  if (!providerId) return [];
  const db = client ?? defaultPrisma;
  const rows = await db.parentContactRelease.findMany({ where: { providerId }, select: { parentAccountId: true } });
  return rows.map((r: any) => r.parentAccountId);
}

// ─── Writers ────────────────────────────────────────────────────────────────

/**
 * Open Gate B for a pair. Idempotent by construction (upsert with an empty
 * update), which matters because PandaDoc has two send paths and its webhooks
 * replay.
 *
 * Fire-and-forget friendly, in the same spirit as emitJourneyEvent: a failure
 * to record the release must never take down the invoice or agreement that
 * triggered it.
 */
export async function releaseParentContact(input: {
  providerId: string;
  parentAccountId: string;
  reason: ReleaseReason;
  releasedByUserId?: string | null;
  note?: string | null;
}, client?: any): Promise<void> {
  const { providerId, parentAccountId, reason } = input;
  if (!providerId || !parentAccountId) return;
  const db = client ?? defaultPrisma;
  try {
    await db.parentContactRelease.upsert({
      where: { providerId_parentAccountId: { providerId, parentAccountId } },
      create: {
        providerId,
        parentAccountId,
        reason,
        releasedByUserId: input.releasedByUserId || null,
        note: input.note || null,
      },
      // Monotonic: the FIRST trigger is the one that matters. The JourneyEvent
      // ledger carries the rest of the history.
      update: {},
    });
  } catch (e: any) {
    console.error("[parent-privacy] releaseParentContact failed:", e?.message || e);
  }
}

// ─── Serializers (pure, no DB) ──────────────────────────────────────────────

/**
 * A parent's display name that is never their email address.
 *
 * At least nine call sites used `user.name || user.email` as a fallback, which
 * leaks the address in full even with Gate B correctly closed - on the provider
 * dashboard, in the agreements list, and as the Daily.co video tile label.
 * Route every one of them through here.
 */
export function parentDisplayName(
  u: { name?: string | null; firstName?: string | null; lastName?: string | null } | null | undefined,
  gates: ParentGates,
): string {
  if (!gates.showIdentity) return "Prospective Parent";
  if (!u) return "Prospective Parent";
  const full = u.name || [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return full || "Parent";
}

/** Fields that only exist behind Gate B. */
const CONTACT_FIELDS = [
  "email", "mobileNumber", "mobileNumberDisplay", "dateOfBirth",
  "address", "zip", "ssn", "passport", "passportCountryOfIssue", "nationality",
] as const;

/**
 * Gate-aware view of a parent user.
 *
 * Gate A closed  -> the "Prospective Parent" stub (id survives, everything else
 *                   goes; the id is needed for whisper routing).
 * Gate A open, B closed -> keeps name, photo, city, state; nulls every contact
 *                   field. Both phone fields must go: billing selects
 *                   mobileNumberDisplay alongside mobileNumber, so nulling one
 *                   lets the other walk straight through.
 */
export function redactParentContact<T extends Record<string, any>>(u: T | null | undefined, gates: ParentGates): T | null {
  if (!u) return null;
  if (!gates.showIdentity) {
    return {
      id: u.id,
      name: "Prospective Parent",
      firstName: null, lastName: null,
      email: null, photoUrl: null, city: null, state: null,
      mobileNumber: null, mobileNumberDisplay: null, dateOfBirth: null,
      parentAccount: null,
    } as unknown as T;
  }
  if (gates.showContact) return u;
  const out: Record<string, any> = { ...u };
  for (const f of CONTACT_FIELDS) if (f in out) out[f] = null;
  out.name = parentDisplayName(u as any, gates);
  return out as T;
}

/** Array form, for accountMembers / parentAccountMembers / members[]. */
export function redactParentMembers<T extends Record<string, any>>(members: T[] | null | undefined, gates: ParentGates): T[] {
  if (!Array.isArray(members)) return [];
  return members.map((m) => redactParentContact(m, gates)).filter(Boolean) as T[];
}

/**
 * Gate-aware view of a booking.
 *
 * Redacting `parentUser.email` alone accomplishes nothing: `attendeeEmails` is
 * auto-populated from the parent account (the parent never types it), returned
 * raw by three list endpoints, and read by the notification service at nine
 * sites. `attendeeDetails` has the same problem.
 */
export function redactBookingForProvider<T extends Record<string, any>>(b: T | null | undefined, gates: ParentGates): T | null {
  if (!b) return null;
  if (gates.showContact) return b;
  const out: Record<string, any> = { ...b };
  if ("parentUser" in out) out.parentUser = redactParentContact(out.parentUser, gates);
  if ("parentAccountMembers" in out) out.parentAccountMembers = redactParentMembers(out.parentAccountMembers, gates);
  if ("attendeeEmails" in out) out.attendeeEmails = [];
  if ("attendeeDetails" in out) out.attendeeDetails = null;
  if ("attendeePhone" in out) out.attendeePhone = null;
  if (!gates.showIdentity && "attendeeName" in out) out.attendeeName = "Prospective Parent";
  return out as T;
}

/**
 * Attendee list for an external (Google / Outlook) calendar event.
 *
 * With Gate B closed this returns [], so the provider's own calendar carries the
 * parent's display name in the summary and the GoStork join link, but never an
 * address. Verified safe: Google is already called with sendUpdates "none", the
 * parent's own copy is written by a separate sync, no code reads RSVP status,
 * and the external-deletion sweep looks events up by stored event id as the
 * calendar owner rather than through attendees.
 */
export function calendarAttendeesFor(
  members: { email?: string | null; name?: string | null }[] | null | undefined,
  gates: ParentGates,
): { email: string; displayName?: string }[] {
  if (!gates.showContact || !Array.isArray(members)) return [];
  return members
    .filter((m) => !!m?.email)
    .map((m) => ({ email: m.email as string, ...(m.name ? { displayName: m.name } : {}) }));
}
