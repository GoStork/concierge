/**
 * Phase 7A: journey event log.
 *
 * emitJourneyEvent() appends one row to the append-only JourneyEvent table.
 * Events are the granular truth of what happened in a parent-provider
 * relationship; journey STAGES (the timeline UI) and funnel analytics are
 * derived from these plus source-of-truth records (bookings, invoices,
 * agreements). Rows are never updated or deleted.
 *
 * Always best-effort: an event-log failure must never break the flow that
 * emitted it. Errors are logged and swallowed.
 */
import { prisma } from "./db";

export type JourneyEventType =
  // Gate B of the two-tier privacy model opened for a (provider, parent) pair.
  // Carries `metadata.reason` (IP_FORM | INVOICE | AGREEMENT | CALLBACK | ADMIN)
  // so the timeline shows WHY a provider gained the parent's contact details.
  | "CONTACT_RELEASED"
  // Consultation lifecycle
  | "CONSULTATION_SCHEDULED"
  | "CONSULTATION_CONFIRMED"
  | "CONSULTATION_RESCHEDULED"
  | "CONSULTATION_CANCELED"
  | "CONSULTATION_COMPLETED"
  | "CONSULTATION_NO_SHOW_PARENT"
  | "CONSULTATION_NO_SHOW_PROVIDER"
  | "CONSULTATION_NO_SHOW_BOTH"
  | "CONSULTATION_ELAPSED_UNVERIFIED"
  | "CANCELED_NOT_REBOOKED"
  // Match call lifecycle (same booking machinery, MATCH_CALL subtype)
  | "MATCH_CALL_SCHEDULED"
  | "MATCH_CALL_CONFIRMED"
  | "MATCH_CALL_RESCHEDULED"
  | "MATCH_CALL_CANCELED"
  | "MATCH_CALL_COMPLETED"
  | "MATCH_CALL_NO_SHOW_PARENT"
  | "MATCH_CALL_NO_SHOW_PROVIDER"
  | "MATCH_CALL_NO_SHOW_BOTH"
  // Match decisions
  | "MATCH_ACCEPTED_BY_PARENT"
  | "MATCH_DECLINED_BY_PARENT"
  | "MATCH_ACCEPTED_BY_SURROGATE" // reported by the agency on the surrogate's behalf
  | "MATCH_DECLINED_BY_SURROGATE"
  | "MATCH_CONFIRMED"
  | "MATCH_DECLINED"
  // Engagement
  | "PROFILE_PRESENTED"
  | "PROFILE_FAVORITED"
  | "WHISPER_ASKED"
  | "WHISPER_ANSWERED"
  | "PREP_INTAKE_COMPLETED"
  | "PROVIDER_CONNECTED"
  | "ESCALATED_TO_HUMAN"
  | "LAWYER_CONNECTED"
  // Money
  | "INVOICE_SENT"
  | "INVOICE_OPENED"
  | "INVOICE_PAID"
  | "BANK_CHECKOUT_STARTED"
  // Documents
  | "COST_SHEET_SHARED"
  | "COST_SHEET_OPENED"
  | "AGREEMENT_SENT"
  | "AGREEMENT_VIEWED"
  | "AGREEMENT_SIGNED"
  // Journey terminal
  | "HANDOFF_COMPLETED"
  // Win-back
  | "WINBACK_SENT"
  | "WINBACK_RESPONSE"
  | "CHURN_REASON"
  | "REENGAGED"
  // Reviews (Phase 8)
  | "JOURNEY_RESTARTED"
  | "REVIEW_PROMPTED"
  | "REVIEW_SUBMITTED"
  | "REVIEW_UPDATED"
  // Intended Parent Form (surrogacy agencies' parent profile form)
  | "IP_FORM_PROMPTED"
  | "IP_FORM_SUBMITTED"
  // Consultation focus lock (server/consultation-gates.ts). The lock itself is
  // DERIVED from bookings; these rows are the only thing that cannot be -
  // the human decisions that release it early.
  | "CONSULTATION_NOT_A_FIT"
  // metadata.reason: PARENT_MOVED_ON | ADMIN (+ note, actorUserId, actorName)
  | "CONSULTATION_LOCK_RELEASED"
  // Consent ledger. These rows ARE the acknowledgements - there is no separate
  // table. Scoped by (parentAccountId, providerId, metadata.subjectProfileId)
  // and compared against the relevant booking's createdAt, so a re-booked call
  // re-asks rather than reusing a stale tick.
  | "CONSULT_PRELIM_ACKNOWLEDGED"
  | "MATCH_CALL_ATTENDANCE_ACKNOWLEDGED"
  // metadata.depositSnapshot records the exact figure the parent was shown.
  | "MATCH_CALL_DECISION_ACKNOWLEDGED"
  // A subject thread opened with an agency the parent was already connected
  // to, with no new consultation call (server/connected-agency-shortcut.ts).
  | "SUBJECT_THREAD_OPENED"
  // Parent CRM (server/parent-record-router.ts). Staff actions on the record
  // page, not parent-visible milestones. metadata carries ids, scopes and
  // lengths ONLY - never note or next-step body text, because
  // GET /api/journey/events returns metadata verbatim to providers.
  | "CRM_NOTE_ADDED"
  | "CRM_NOTE_SHARED_WITH_PROVIDER"
  | "CRM_FOLLOWUP_SET"
  | "CRM_FOLLOWUP_COMPLETED"
  | "CRM_OWNER_ASSIGNED"
  | "CRM_TAG_ADDED";

export type JourneyActor = "parent" | "provider" | "system" | "admin";

/**
 * Append one journey event. Pass EITHER parentAccountId (preferred) or
 * parentUserId (resolved to the account, falling back to the user id for
 * legacy accounts without a parentAccountId).
 */
export async function emitJourneyEvent(input: {
  eventType: JourneyEventType;
  parentAccountId?: string | null;
  parentUserId?: string | null;
  providerId?: string | null;
  sessionId?: string | null;
  bookingId?: string | null;
  actorRole?: JourneyActor | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    let accountId = input.parentAccountId || null;
    if (!accountId && input.parentUserId) {
      const u = await prisma.user.findUnique({
        where: { id: input.parentUserId },
        select: { parentAccountId: true },
      });
      accountId = u?.parentAccountId || input.parentUserId;
    }
    if (!accountId) return; // no parent to attribute the event to

    await prisma.journeyEvent.create({
      data: {
        parentAccountId: accountId,
        providerId: input.providerId || null,
        sessionId: input.sessionId || null,
        bookingId: input.bookingId || null,
        eventType: input.eventType,
        actorRole: input.actorRole || "system",
        metadata: (input.metadata as any) ?? undefined,
      },
    });
  } catch (e: any) {
    console.error(`[journey-events] Failed to emit ${input.eventType}: ${e?.message}`);
  }
}

/** Invoice-flavored emitter: loads the invoice and attributes the event. */
export async function emitInvoiceJourneyEvent(
  invoiceId: string,
  eventType: "INVOICE_SENT" | "INVOICE_OPENED" | "INVOICE_PAID",
  extraMeta?: Record<string, unknown>,
): Promise<void> {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, parentUserId: true, providerId: true, sessionId: true, serviceAmount: true, triggerSource: true },
    });
    if (!invoice) return;
    await emitJourneyEvent({
      eventType,
      parentUserId: invoice.parentUserId,
      providerId: invoice.providerId,
      sessionId: invoice.sessionId,
      metadata: { invoiceId, amountCents: invoice.serviceAmount, triggerSource: invoice.triggerSource, ...(extraMeta || {}) },
    });
  } catch (e: any) {
    console.error(`[journey-events] emitInvoiceJourneyEvent(${eventType}) failed for ${invoiceId}: ${e?.message}`);
  }
}

/** INVOICE_OPENED, first open only - later page loads are noise. */
export async function emitInvoiceOpenedOnce(invoiceId: string): Promise<void> {
  try {
    const prior = await prisma.journeyEvent.findFirst({
      where: { eventType: "INVOICE_OPENED", metadata: { path: ["invoiceId"], equals: invoiceId } },
      select: { id: true },
    });
    if (!prior) await emitInvoiceJourneyEvent(invoiceId, "INVOICE_OPENED");
  } catch (e: any) {
    console.error(`[journey-events] emitInvoiceOpenedOnce failed for ${invoiceId}: ${e?.message}`);
  }
}

/**
 * Booking lifecycle emitter: loads the booking, resolves the provider org,
 * skips GoStork house calls, and emits the right CONSULTATION_* /
 * MATCH_CALL_* event. On SCHEDULED it also detects re-engagement: a new
 * booking after a win-back for the same parent-provider pair (30d window)
 * emits REENGAGED. Fire-and-forget safe (all failures swallowed).
 */
export async function emitBookingLifecycleEvent(
  bookingId: string,
  base: "SCHEDULED" | "CONFIRMED" | "RESCHEDULED" | "CANCELED",
  actorRole?: JourneyActor,
  extraMeta?: Record<string, unknown>,
): Promise<void> {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        parentUserId: true,
        scheduledAt: true,
        meetingSubtype: true,
        providerUser: { select: { providerId: true, roles: true, provider: { select: { name: true } } } },
      },
    });
    if (!booking?.parentUserId) return; // no parent to attribute (pure external invite)
    const provName = (booking.providerUser?.provider?.name || "").trim().toLowerCase();
    const isHouse = provName === "gostork" || (booking.providerUser?.roles || []).some((r: any) => String(r).startsWith("GOSTORK"));
    if (isHouse) return; // concierge calls are not provider-journey events
    const providerId = booking.providerUser?.providerId || null;

    await emitJourneyEvent({
      eventType: bookingEventType(base, booking.meetingSubtype),
      parentUserId: booking.parentUserId,
      providerId,
      bookingId,
      actorRole: actorRole || "system",
      metadata: { scheduledAt: booking.scheduledAt, meetingSubtype: booking.meetingSubtype || null, ...(extraMeta || {}) },
    });

    if (base === "SCHEDULED" && providerId) {
      const me = await prisma.user.findUnique({ where: { id: booking.parentUserId }, select: { parentAccountId: true } });
      const accountId = me?.parentAccountId || booking.parentUserId;
      const winback = await prisma.journeyEvent.findFirst({
        where: {
          parentAccountId: accountId,
          providerId,
          eventType: "WINBACK_SENT",
          createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (winback) {
        const already = await prisma.journeyEvent.findFirst({
          where: { parentAccountId: accountId, providerId, eventType: "REENGAGED", createdAt: { gte: winback.createdAt } },
          select: { id: true },
        });
        if (!already) {
          await emitJourneyEvent({
            eventType: "REENGAGED",
            parentAccountId: accountId,
            providerId,
            bookingId,
            actorRole: "parent",
            metadata: { winbackAt: winback.createdAt },
          });
          console.log(`[journey-events] REENGAGED: parent ${accountId} rebooked with provider ${providerId} after win-back`);
        }
      }
    }
  } catch (e: any) {
    console.error(`[journey-events] emitBookingLifecycleEvent(${base}) failed for ${bookingId}: ${e?.message}`);
  }
}

/** Booking-flavored convenience: picks CONSULTATION_* vs MATCH_CALL_* by subtype. */
export function bookingEventType(
  base: "SCHEDULED" | "CONFIRMED" | "RESCHEDULED" | "CANCELED" | "COMPLETED" | "NO_SHOW_PARENT" | "NO_SHOW_PROVIDER" | "NO_SHOW_BOTH",
  meetingSubtype?: string | null,
): JourneyEventType {
  const family = meetingSubtype === "MATCH_CALL" ? "MATCH_CALL" : "CONSULTATION";
  return `${family}_${base}` as JourneyEventType;
}
