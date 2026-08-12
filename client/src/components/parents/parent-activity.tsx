/**
 * The parent record's activity timeline: one chronological stream of
 * everything that has happened to this family, one card per entry.
 *
 * It replaces three separate sections (Notes, tasks, and the
 * collapsed "Recent activity" list under the ladder). Those split one story
 * across three places and hid the most useful half of it behind a disclosure
 * triangle - you could not see that a note was written the day after a
 * consultation without opening two of them and comparing dates.
 *
 * WHERE THE ENTRIES COME FROM
 *
 * Journey events already record almost everything: consultations, match
 * calls, invoices, agreements, cost sheets, whispers, IP forms. They also
 * record the CRM actions - but deliberately WITHOUT their text, because
 * GET /api/journey/events returns metadata verbatim to providers and an
 * internal note must never travel that way (see journey-events.ts).
 *
 * So the feed merges the events with the real note and next-step objects
 * from the record payload, which do carry their text and have already been
 * scoped and redacted server-side. The CRM_* events are dropped in the merge,
 * or every note would appear twice: once with its body and once as a bare
 * "Note added".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { InlineBookingNotification } from "@/components/chat/inline-booking-notification";
import { AttachmentMessageCard } from "@/components/chat/attachment-message-card";
import { SpecialMessageCard } from "@/components/chat/special-message-card";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle, CalendarCheck, CalendarClock, CalendarX, Check, ChevronDown, CircleCheck, ExternalLink,
  Clock, FileText, Filter, Mail, MessageSquare,
  Pencil, Pin, Receipt, Sparkles, StickyNote, Trash2, TrendingUp, User, Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ServiceDot } from "@/components/ui/service-tag";
import { cn } from "@/lib/utils";
import { DoctorMonogram } from "@/components/marketplace/doctor-monogram";
import { getPhotoSrc } from "@/lib/profile-utils";
import { formatPhoneDisplay } from "@/lib/phone-countries";
import { renderRichText } from "@/lib/render-rich-text";
import { AgreementRow } from "@/components/chat/agreement-row";
import { CostSheetRow } from "@/components/chat/cost-sheet-row";
import { NoteComposer, ParentTaskComposer, ParentTaskPanel, TaskCardBody, useCrmMutation } from "./parent-crm-ui";
import type { TaskMode } from "./parent-crm-ui";
import { RichTextEditor, isRichNoteHtml } from "@/components/ui/rich-text-editor";
import type { ActivityDetail, ParentRecord } from "./parent-record-types";



/**
 * How an entry is badged.
 *
 * The three system kinds mirror the way HubSpot separates what the pipeline
 * did from what an automation sent. "parent" is ours: an event the FAMILY
 * caused - opening an invoice, favouriting a profile - is neither a stage
 * change nor something we sent, and filing it under either would be a lie
 * about who acted.
 */
type ActivityKind = "note" | "task" | "deal" | "ai" | "parent" | "message";

const KIND_META: Record<ActivityKind, { label: string; icon: typeof StickyNote; tone: "accent" | "primary" | "muted" }> = {
  message: { label: "AI Activity", icon: Mail, tone: "accent" },
  note: { label: "Note", icon: StickyNote, tone: "accent" },
  task: { label: "Task", icon: CircleCheck, tone: "primary" },
  deal: { label: "Deal Activity", icon: TrendingUp, tone: "primary" },
  ai: { label: "AI Activity", icon: Sparkles, tone: "accent" },
  parent: { label: "Parent Activity", icon: User, tone: "muted" },
};

/** Events that move the family along the ladder. */
const DEAL_EVENTS = new Set([
  "CONSULTATION_SCHEDULED", "CONSULTATION_CONFIRMED", "CONSULTATION_RESCHEDULED",
  "CONSULTATION_CANCELED", "CONSULTATION_COMPLETED", "CONSULTATION_NO_SHOW_PARENT",
  "CONSULTATION_NO_SHOW_PROVIDER", "CONSULTATION_NO_SHOW_BOTH",
  "CONSULTATION_ELAPSED_UNVERIFIED", "CANCELED_NOT_REBOOKED", "CONSULTATION_NOT_A_FIT",
  "CONSULTATION_LOCK_RELEASED",
  "MATCH_CALL_SCHEDULED", "MATCH_CALL_CONFIRMED", "MATCH_CALL_RESCHEDULED",
  "MATCH_CALL_CANCELED", "MATCH_CALL_COMPLETED", "MATCH_CALL_NO_SHOW_PARENT",
  "MATCH_CALL_NO_SHOW_PROVIDER", "MATCH_CALL_NO_SHOW_BOTH",
  "MATCH_CONFIRMED", "MATCH_DECLINED",
  "MATCH_ACCEPTED_BY_SURROGATE", "MATCH_DECLINED_BY_SURROGATE",
  "PROVIDER_CONNECTED", "SUBJECT_THREAD_OPENED", "CONTACT_RELEASED",
  "IP_FORM_SUBMITTED", "INVOICE_PAID", "AGREEMENT_SIGNED", "HANDOFF_COMPLETED",
  "JOURNEY_RESTARTED", "REENGAGED", "CHURN_REASON", "LAWYER_CONNECTED",
  "CRM_OWNER_ASSIGNED",
]);

/** Events where the FAMILY did something. */
const PARENT_EVENTS = new Set([
  "PROFILE_FAVORITED", "INVOICE_OPENED", "COST_SHEET_OPENED", "AGREEMENT_VIEWED",
  "BANK_CHECKOUT_STARTED", "REVIEW_SUBMITTED", "REVIEW_UPDATED",
  "MATCH_ACCEPTED_BY_PARENT", "MATCH_DECLINED_BY_PARENT",
  "PREP_INTAKE_COMPLETED", "WHISPER_ASKED", "ESCALATED_TO_HUMAN",
  "CONSULT_PRELIM_ACKNOWLEDGED", "MATCH_CALL_ATTENDANCE_ACKNOWLEDGED",
  "MATCH_CALL_DECISION_ACKNOWLEDGED", "WINBACK_RESPONSE",
]);

/**
 * Everything else - invoices sent, cost sheets shared, prompts, profiles
 * presented - is something Eva or a coordinator SENT, which is the AI
 * Activity bucket. actorRole wins when it says the parent acted, because the
 * row knows better than a static list.
 */
function kindForEvent(ev: { eventType: string; actorRole: string | null }): ActivityKind {
  // A file we sent sits with the other automated deliveries around it, and
  // wears the file glyph rather than Eva's face - the row is about the
  // document, and who sent it is already in the label.
  if (ev.eventType === "MESSAGE_EMAIL" || ev.eventType === "MESSAGE_SMS" || ev.eventType === "FILE_SHARED") return "message";
  if (ev.eventType === "COST_SHEET_SHARED") return "deal";
  if (DEAL_EVENTS.has(ev.eventType)) return "deal";
  if (ev.actorRole === "parent" || PARENT_EVENTS.has(ev.eventType)) return "parent";
  return "ai";
}

const EVENT_LABELS: Record<string, string> = {
  CONTACT_RELEASED: "Contact details shared",
  CONSULTATION_SCHEDULED: "Consultation scheduled",
  CONSULTATION_CONFIRMED: "Consultation confirmed",
  CONSULTATION_RESCHEDULED: "Consultation rescheduled",
  CONSULTATION_CANCELED: "Consultation canceled",
  CONSULTATION_COMPLETED: "Consultation completed",
  CONSULTATION_NO_SHOW_PARENT: "Parent missed the call",
  CONSULTATION_NO_SHOW_PROVIDER: "Provider missed the call",
  CONSULTATION_NO_SHOW_BOTH: "Call never happened",
  CONSULTATION_ELAPSED_UNVERIFIED: "Call time passed",
  CONSULTATION_NOT_A_FIT: "Marked not a fit",
  CONSULTATION_LOCK_RELEASED: "Consultation lock released",
  CANCELED_NOT_REBOOKED: "Canceled without rebooking",
  MATCH_CALL_SCHEDULED: "Match Call scheduled",
  MATCH_CALL_CONFIRMED: "Match Call confirmed",
  MATCH_CALL_RESCHEDULED: "Match Call rescheduled",
  MATCH_CALL_CANCELED: "Match Call canceled",
  MATCH_CALL_COMPLETED: "Match Call completed",
  MATCH_CALL_NO_SHOW_PARENT: "Parent missed the Match Call",
  MATCH_CALL_NO_SHOW_PROVIDER: "Provider missed the Match Call",
  MATCH_CALL_NO_SHOW_BOTH: "Match Call never happened",
  MATCH_ACCEPTED_BY_PARENT: "Said yes to the match",
  MATCH_DECLINED_BY_PARENT: "Declined the match",
  MATCH_ACCEPTED_BY_SURROGATE: "Surrogate side said yes",
  MATCH_DECLINED_BY_SURROGATE: "Surrogate side declined",
  MATCH_CONFIRMED: "Match confirmed",
  MATCH_DECLINED: "Match declined",
  PROFILE_PRESENTED: "Profile presented",
  PROFILE_FAVORITED: "Favorited a profile",
  WHISPER_ASKED: "Asked the provider a question",
  WHISPER_ANSWERED: "Provider answered a question",
  PREP_INTAKE_COMPLETED: "Completed call prep",
  PROVIDER_CONNECTED: "Provider joined the chat",
  ESCALATED_TO_HUMAN: "Asked for the GoStork team",
  LAWYER_CONNECTED: "Connected with a lawyer",
  INVOICE_SENT: "Invoice sent",
  INVOICE_OPENED: "Opened the invoice",
  INVOICE_PAID: "Invoice paid",
  BANK_CHECKOUT_STARTED: "Started bank checkout",
  COST_SHEET_SHARED: "Cost sheet shared",
  COST_SHEET_OPENED: "Opened the cost sheet",
  AGREEMENT_SENT: "Agreement sent",
  AGREEMENT_VIEWED: "Viewed the agreement",
  AGREEMENT_SIGNED: "Agreement signed",
  HANDOFF_COMPLETED: "Handed off",
  WINBACK_SENT: "Win-back message sent",
  WINBACK_RESPONSE: "Replied to the win-back",
  CHURN_REASON: "Churn reason recorded",
  REENGAGED: "Re-engaged",
  JOURNEY_RESTARTED: "Journey restarted",
  REVIEW_PROMPTED: "Review requested",
  REVIEW_SUBMITTED: "Review submitted",
  REVIEW_UPDATED: "Review updated",
  MESSAGE_EMAIL: "Email sent",
  MESSAGE_SMS: "Text message sent",
  IP_FORM_PROMPTED: "Parent Form requested",
  IP_FORM_SUBMITTED: "Parent Form submitted",
  CONSULT_PRELIM_ACKNOWLEDGED: "Acknowledged the pre-call notice",
  MATCH_CALL_ATTENDANCE_ACKNOWLEDGED: "Acknowledged Match Call attendance",
  MATCH_CALL_DECISION_ACKNOWLEDGED: "Acknowledged the Match Call decision",
  SUBJECT_THREAD_OPENED: "New thread opened",
  FILE_SHARED: "Document sent",
  CRM_OWNER_ASSIGNED: "Lead owner assigned",
};


/**
 * Call events get an icon for what the event IS, not for the bucket it sits
 * in - booking one is a calendar act, holding it is a video call.
 *
 * Keyed on the event type rather than the booking's meetingType: the record's
 * booking query selects a narrow set of columns and meetingType is not among
 * them, so a check on it silently never matched. The event name is always
 * present.
 */
const CALL_ICONS: Record<string, typeof CalendarClock> = {
  CONSULTATION_SCHEDULED: CalendarClock,
  CONSULTATION_CONFIRMED: CalendarCheck,
  CONSULTATION_RESCHEDULED: CalendarClock,
  CONSULTATION_CANCELED: CalendarX,
  CONSULTATION_COMPLETED: Video,
  CONSULTATION_NO_SHOW_PARENT: Clock,
  CONSULTATION_NO_SHOW_PROVIDER: Clock,
  CONSULTATION_NO_SHOW_BOTH: Clock,
  MATCH_CALL_SCHEDULED: CalendarClock,
  MATCH_CALL_CONFIRMED: CalendarCheck,
  MATCH_CALL_RESCHEDULED: CalendarClock,
  MATCH_CALL_CANCELED: CalendarX,
  MATCH_CALL_COMPLETED: Video,
  MATCH_CALL_NO_SHOW_PARENT: Clock,
  MATCH_CALL_NO_SHOW_PROVIDER: Clock,
  MATCH_CALL_NO_SHOW_BOTH: Clock,
};

/** These arrive with their real text from the record payload instead. */
const SUPERSEDED_BY_PAYLOAD = new Set([
  "CRM_NOTE_ADDED", "CRM_NOTE_SHARED_WITH_PROVIDER",
  "CRM_FOLLOWUP_SET", "CRM_FOLLOWUP_COMPLETED",
]);

interface Entry {
  id: string;
  kind: ActivityKind;
  at: string;
  title: string;
  body?: string | null;
  /** kind "task" only: the task itself, rendered with its own controls. */
  task?: ParentRecord["crm"]["tasks"][number];
  /** kind "note" only: the raw note plus whether the viewer may manage it. */
  note?: { id: string; html: string; canManage: boolean; pinned: boolean };
  /** The person who wrote it. Only notes have one. */
  byline?: string | null;
  /** Which org the entry belongs to. NOT an author - see buildEntries. */
  org?: string | null;
  /** Rendered under the body - a due date, a scope chip. */
  extra?: React.ReactNode;
  /** The joined object this entry is about. Renders as a detail block. */
  detail?: ActivityDetail | null;
  /** Raw event type, so the card can pick an icon for what actually happened. */
  eventType?: string;
  /** Concierge persona, for the avatar on an AI Activity card. */
  aiName?: string | null;
  aiAvatarUrl?: string | null;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function buildEntries(record: ParentRecord): Entry[] {
  const out: Entry[] = [];

  for (const n of record.crm.notes) {
    const org = record.providerOrgs.find((o) => o.providerId === n.providerId);
    const internal = n.scope === "GOSTORK";
    out.push({
      id: `note-${n.id}`,
      kind: "note",
      at: n.createdAt,
      title: "Note",
      note: {
        id: n.id,
        html: n.body,
        pinned: !!n.pinned,
        // The server re-checks on write; this only decides whether to DRAW
        // the buttons. Admins manage everything, authors their own.
        canManage: record.viewer.role === "admin" || (!!record.viewer.userId && n.authorUserId === record.viewer.userId),
      },
      byline: n.authorName || "Staff",
      // The audience chip is an ADMIN affordance: admins write to several
      // audiences, so each card must say which one it reached. A provider
      // has exactly one - every note they can see is shared with their own
      // org by construction - so the chip told them nothing.
      extra: record.viewer.role === "admin" ? (
        <span
          className="text-xs font-ui px-2 py-0.5 rounded-full"
          style={internal
            ? { background: "hsl(var(--accent) / 0.15)", color: "hsl(var(--accent))" }
            : { background: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
        >
          {internal ? "GoStork internal" : `Shared with ${org?.providerName || "provider"}`}
        </span>
      ) : undefined,
    });
  }

  for (const f of record.crm.tasks) {
    out.push({
      id: `task-${f.id}`,
      // Placed by when it was SET, not when it is due - this is a history, and
      // a task due next month did not happen next month.
      at: f.createdAt || f.dueAt,
      kind: "task",
      title: "Task",
      // The card renders the task itself: title in bold, then its chips, its
      // note and its controls. A task is a thing you act on, like a note is a
      // thing you edit - not a line of history about a thing.
      body: f.title,
      task: f,
    });
  }

  for (const ev of record.activity || []) {
    if (SUPERSEDED_BY_PAYLOAD.has(ev.eventType)) continue;
    // A future-queued reminder is not a SENT message - titling it "sent"
    // with an amber Pending made a correctly-scheduled reminder read as a
    // delivery failure (and buried the real confirmation cards beneath it).
    const isScheduledMsg =
      ev.detail?.type === "message" && ev.detail.status === "pending" && !!ev.detail.scheduledFor;
    out.push({
      id: `ev-${ev.id}`,
      kind: kindForEvent(ev),
      at: ev.at,
      title: isScheduledMsg
        ? (ev.eventType === "MESSAGE_SMS" ? "Text message scheduled" : "Email scheduled")
        : (EVENT_LABELS[ev.eventType] || ev.eventType.toLowerCase().replace(/_/g, " ")),
      org: ev.providerName,
      detail: ev.detail,
      eventType: ev.eventType,
      aiName: ev.aiName,
      aiAvatarUrl: ev.aiAvatarUrl,
    });
  }

  return out.sort((a, b) => {
    // A pinned note holds the top of the feed no matter what happens below
    // it, until someone unpins it - then it drops back to its date. Several
    // pinned notes order among themselves by date.
    const ap = a.note?.pinned ? 1 : 0;
    const bp = b.note?.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return new Date(b.at).getTime() - new Date(a.at).getTime();
  });
}


/**
 * Every value Notification.status can hold, in the provider's words.
 *
 * "Skipped" is the one that needs saying: it does NOT mean we failed. The
 * reminder sweep skips a queued message when its booking was cancelled or
 * rescheduled before the send time - not sending it is the correct outcome,
 * and a provider reading a bare "skipped" would reasonably assume otherwise.
 */
const DELIVERY_MEANING: Record<string, string> = {
  sent: "",
  pending: "Queued - not sent yet.",
  skipped: "Not needed by the time it was due - the meeting had been cancelled or moved.",
  failed: "The provider rejected it. Worth checking the address or number.",
};

const money = (cents: number | null) =>
  cents == null ? null : `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

/** A labelled row inside a detail block. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // flex-wrap with a minimum basis: the value drops to its own line rather
    // than being squeezed into a sliver. break-words so a long address wraps
    // at a sensible point instead of running past the card.
    <div className="flex items-baseline gap-x-2 gap-y-0.5 flex-wrap min-w-0">
      <span className="t-micro-label shrink-0">{label}</span>
      <span className="t-micro-value min-w-0 basis-40 flex-1 break-words">{children}</span>
    </div>
  );
}

/**
 * The card's payload: whatever the entry is actually ABOUT.
 *
 * A timeline that only says "Invoice sent" makes you leave it to find out
 * which invoice. Everything here is joined server-side (buildActivity), so
 * this only renders - it never fetches, and there is nothing here a provider
 * was not already allowed to see.
 */
function DetailBlock({ detail, parentUserId, viewerRole, onChanged }: {
  detail: ActivityDetail;
  parentUserId: string;
  viewerRole: "provider" | "admin";
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  // Option A (approved Aug 9): a card is at most TWO fills. No cream wrapper
  // box - the detail rows sit directly on the white card behind a hairline,
  // and only the message bubble / email frame carries its own outlined
  // surface. Cream now means exactly one thing on this page: an editable
  // composer panel.
  const shell = "mt-2.5 pt-2.5 border-t border-border/60 space-y-1.5";

  if (detail.type === "booking") {
    // The shared widget every chat surface already uses - same layout, same
    // actions (confirm, decline, reschedule, suggest a time, join), scoped by
    // viewerRole. Mounting it here rather than hand-rolling a second set of
    // buttons is the whole point of it being shared. `embedded` drops its own
    // card chrome so this block keeps supplying the wrapper.
    if (detail.booking) {
      return (
        <div className={shell} data-testid={`detail-booking-${detail.bookingId}`}>
          <InlineBookingNotification
            booking={detail.booking}
            brandColor="hsl(var(--primary))"
            viewerRole={viewerRole}
            embedded
            onUpdate={onChanged}
          />
        </div>
      );
    }
    const when = new Date(detail.scheduledAt);
    return (
      <div className={shell} data-testid={`detail-booking-${detail.bookingId}`}>
        <Row label="When">
          {when.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          {detail.timezone ? ` (${detail.timezone})` : ""}
        </Row>
        {detail.durationMinutes != null && <Row label="Duration">{detail.durationMinutes} minutes</Row>}
        {detail.isCurrentState && (
          // Only on this booking's newest event: the current status is not a
          // fact about an earlier moment in its history.
          <Row label="Status now">{titleCaseWords(detail.status)}{detail.outcome ? ` - ${titleCaseWords(detail.outcome)}` : ""}</Row>
        )}
        {detail.meetingSubtype && <Row label="Type">{titleCaseWords(detail.meetingSubtype.toLowerCase())}</Row>}
        {detail.notes && <Row label="Notes">{detail.notes}</Row>}
        <div className="flex flex-wrap gap-2 pt-1">
          {detail.meetingUrl && (
            <Button size="sm" variant="outline" onClick={() => window.open(detail.meetingUrl as string, "_blank", "noopener,noreferrer")} data-testid={`btn-join-${detail.bookingId}`}>
              <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> Join call
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => navigate(`/calendar?bookingId=${detail.bookingId}`)} data-testid={`btn-booking-${detail.bookingId}`}>
            <CalendarClock className="w-3.5 h-3.5 mr-1.5" /> Open in calendar
          </Button>
        </div>
      </div>
    );
  }

  if (detail.type === "message") {
    return <MessageDetail detail={detail} parentUserId={parentUserId} />;
  }

  if (detail.type === "invoice") {
    return (
      <div className={shell} data-testid={`detail-invoice-${detail.invoiceId}`}>
        {detail.description && <Row label="For">{detail.description}</Row>}
        {money(detail.amountCents) && <Row label="Amount">{money(detail.amountCents)}</Row>}
        <Row label="Status">{titleCaseWords(detail.status)}</Row>
        {detail.dueAt && <Row label="Due">{new Date(detail.dueAt).toLocaleDateString()}</Row>}
        {detail.paymentUrl && (
          <Button size="sm" variant="outline" className="mt-1" onClick={() => window.open(detail.paymentUrl as string, "_blank", "noopener,noreferrer")} data-testid={`btn-invoice-${detail.invoiceId}`}>
            <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> Open invoice
          </Button>
        )}
      </div>
    );
  }

  if (detail.type === "agreement") {
    return (
      // The SAME card the Documents panel and the chat rail draw, so an
      // agreement is one openable object wherever you meet it. It routes a
      // signed agreement to the PDF download and anything else to the
      // agreement page. This used to be a status line plus a button gated on
      // a documentUrl the record query never selected - so the button could
      // not appear, and "Agreement sent" was a dead end.
      <div className={`${shell} [&>div]:max-w-[300px]`} data-testid={`detail-agreement-${detail.agreementId}`}>
        <AgreementRow
          agreement={{
            id: detail.agreementId,
            status: detail.status,
            documentType: detail.documentType,
            serviceType: detail.serviceType,
            createdAt: detail.createdAt,
            signedAt: detail.signedAt,
          }}
          testId={`agreement-row-${detail.agreementId}`}
        />
      </div>
    );
  }

  if (detail.type === "cost_sheet") {
    return (
      // The SAME card the Documents panel and the chat rail draw. This used to
      // be a bespoke total-plus-button block, so one quote looked like two
      // different objects depending on which part of the page you were on -
      // and its file button opened the raw GCS url, which 403s.
      // Capped to the sent-attachment width, like every document tile in the
      // timeline - the rail is where they fill their column.
      <div className={`${shell} [&>div]:max-w-[300px]`} data-testid={`detail-cost-sheet-${detail.quoteId}`}>
        <CostSheetRow
          quote={{
            id: detail.quoteId,
            sessionId: detail.sessionId,
            totalCostCents: detail.totalCostCents,
            costSheetFileUrl: detail.costSheetFileUrl,
            costSheetFileName: detail.costSheetFileName,
            serviceType: detail.serviceType,
            notes: detail.notes,
            createdAt: detail.createdAt,
            supersededAt: detail.supersededAt,
            parentAcknowledgedAt: detail.parentAcknowledgedAt,
          }}
          testId={`cost-sheet-row-${detail.quoteId}`}
        />
      </div>
    );
  }

  if (detail.type === "review") {
    return (
      <div className={shell} data-testid={`detail-review-${detail.reviewId}`}>
        <Row label="Rating">
          {detail.rating != null ? `${detail.rating} / 5` : detail.recommendation.replace(/_/g, " ").toLowerCase()}
        </Row>
        {detail.bodyText && <p className="text-sm whitespace-pre-wrap break-words">{detail.bodyText}</p>}
        {detail.hasResponse && <Row label="Your reply">{detail.responseText}</Row>}
        {/* The action shows in BOTH states. It used to appear only when there
            was no reply, so the moment you answered a review the card became
            a dead end - you could read your own words but never get back to
            the review to edit or flag it.

            Where it goes: the provider profile only DISPLAYS reviews, so
            sending a provider there handed them a page where they could read
            the review and do nothing about it. ProviderReviewsPanel, which
            owns reply and flag, is on /performance. Admins have no such
            panel, so they go to the profile, where ?review= scrolls to the
            section (?tab=reviews was inert - that page has no tabs). */}
        <Button
          size="sm"
          variant="outline"
          className="mt-1 bg-card"
          onClick={() =>
            navigate(
              viewerRole === "provider"
                ? `/performance?tab=reviews&review=${detail.reviewId}`
                : `/providers/${detail.providerId}?review=${detail.reviewId}#parent-reviews-section`,
            )
          }
          data-testid={`btn-review-reply-${detail.reviewId}`}
        >
          <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
          {viewerRole === "provider"
            ? (detail.hasResponse ? "Open review" : "Reply to review")
            : "Open review"}
        </Button>
      </div>
    );
  }

  if (detail.type === "whisper") {
    return (
      <div className={shell} data-testid={`detail-whisper-${detail.whisperId}`}>
        {/* The parent is anonymous until they book, so the question is shown
            without them - that is the whole point of the whisper protocol. */}
        <Row label="Asked">{detail.question}</Row>
        {detail.answer
          ? <Row label="Answered">{detail.answer}</Row>
          : <p className="t-helper">Not answered yet.</p>}
      </div>
    );
  }

  if (detail.type === "cost_sheet_card") {
    return (
      <div className={shell} data-testid={`detail-cost-sheet-card-${detail.messageId}`}>
        {detail.message && <p className="text-sm break-words">{detail.message}</p>}
        {/* The SAME card the chat draws. The action callbacks are deliberately
            omitted, which is exactly how that component degrades to read-only
            - the record is a history, not a place to resend or cancel. */}
        <SpecialMessageCard
          msg={{ id: detail.messageId, uiCardType: "cost_sheet", uiCardData: detail.card } as any}
          brandColor="hsl(var(--primary))"
          viewerRole={viewerRole}
          sessionId={detail.sessionId}
        />
      </div>
    );
  }

  if (detail.type === "attachment") {
    return (
      <div className={shell} data-testid={`detail-attachment-${detail.messageId}`}>
        {/* The line the file arrived with. Already viewer-specific from the
            server, so a provider reads their own wording rather than the one
            addressed to the family. */}
        {detail.message && <p className="text-sm break-words">{detail.message}</p>}
        {/* The SAME card every chat surface draws, so the download button and
            the file-type glyph come for free and cannot drift from chat. */}
        <AttachmentMessageCard data={detail} testId={`attachment-${detail.messageId}`} />
      </div>
    );
  }

  if (detail.type === "winback") {
    return (
      <div className={shell} data-testid="detail-winback">
        {/* Eva's words, verbatim - the same copy builder the sweep uses. */}
        <p className="text-sm break-words italic">"{detail.message}"</p>
        <p className="t-helper">
          Sent by the concierge in the family's chat, with quick replies to reschedule.
        </p>
      </div>
    );
  }

  if (detail.type === "ip_form") {
    return (
      <div className={shell} data-testid={`detail-ip-form-${detail.responseId}`}>
        {detail.submittedAt && <Row label="Submitted">{new Date(detail.submittedAt).toLocaleDateString()}</Row>}
        <Button size="sm" variant="outline" className="mt-1" onClick={() => window.open(`/api/provider/ip-forms/${detail.responseId}/pdf?variant=full`, "_blank", "noopener,noreferrer")} data-testid={`btn-ip-form-${detail.responseId}`}>
          <FileText className="w-3.5 h-3.5 mr-1.5" /> Open Parent Form
        </Button>
      </div>
    );
  }

  return null;
}


/**
 * A sent email or SMS: what it said, and the real thing behind it.
 *
 * The full HTML is fetched on demand rather than shipped with the record - a
 * family with a hundred emails would otherwise carry a hundred rendered
 * documents on every page load. It renders in a SANDBOXED iframe: this is
 * mail HTML, and it gets no script, no forms and no same-origin access.
 */


/** "booking reminder" -> "Booking Reminder". Stored values are lowercase
 *  identifiers; a card should read as a label, not as a database value. */
function titleCaseWords(value: string): string {
  return value
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * A sent email, rendered at its full height - no inner scrollbar.
 *
 * Sizing needs to read the document inside the frame, which needs
 * allow-same-origin. That is safe here precisely BECAUSE allow-scripts is
 * withheld: with no JS able to run, same-origin access is a privilege nothing
 * inside the frame can use. Granting both together would be the mistake.
 *
 * Height is re-measured as images arrive, since an email is mostly images and
 * the first measurement lands before they have loaded.
 */
/**
 * Flattens an email's SURFACE colours to white for this preview.
 *
 * Every email now builds white (email-builder.ts), but the timeline renders
 * the bodyHtml that was STORED at send time - so every message sent before
 * that keeps the cream it was sent with, and the activity feed reads as a
 * patchwork of two eras. Rewriting the stored HTML is not an option: it is the
 * record of what the family actually received.
 *
 * So the flattening happens here, at display, and touches nothing but page and
 * table backgrounds. The brand header band, buttons, alert boxes and every
 * word are still exactly what was sent - those live on <td>s and <div>s, which
 * these selectors do not reach.
 */
const EMAIL_SURFACE_RESET = `<style>
  html, body { background: #ffffff !important; }
  body table { background-color: #ffffff !important; }
</style>`;

function whitenEmailSurfaces(html: string): string {
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => m + EMAIL_SURFACE_RESET)
    : EMAIL_SURFACE_RESET + html;
}

function EmailFrame({ html: rawHtml, title, testId }: { html: string; title: string; testId: string }) {
  const html = whitenEmailSurfaces(rawHtml);
  const wrap = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLIFrameElement>(null);
  const [box, setBox] = useState({ height: 320, scale: 1 });

  const measure = () => {
    const doc = ref.current?.contentDocument;
    const available = wrap.current?.clientWidth || 0;
    if (!doc?.documentElement || !available) return;
    const contentW = Math.max(doc.documentElement.scrollWidth, doc.body?.scrollWidth || 0);
    const contentH = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0);
    if (!contentH) return;
    // A branded email is laid out for ~600px. On a 390px phone that would
    // either clip or need sideways scrolling, so it is scaled to fit instead
    // - the whole email, readable, no horizontal scroll. Never scaled UP.
    const scale = contentW > available ? available / contentW : 1;
    setBox({ height: Math.ceil(contentH * scale), scale });
  };

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const onLoad = () => {
      measure();
      const doc = frame.contentDocument;
      if (!doc) return;
      // Images finish after load and change the height; so can a late webfont.
      doc.querySelectorAll("img").forEach((img) => img.addEventListener("load", measure));
      const ro = new ResizeObserver(measure);
      if (doc.documentElement) ro.observe(doc.documentElement);
      if (wrap.current) ro.observe(wrap.current);   // re-fit on rotate / resize
      (frame as any).__ro = ro;
    };
    frame.addEventListener("load", onLoad);
    return () => {
      frame.removeEventListener("load", onLoad);
      (frame as any).__ro?.disconnect();
    };
  }, [html]);

  return (
    <div ref={wrap} style={{ height: box.height }} className="w-full overflow-hidden">
      <iframe
        ref={ref}
        title={title}
        sandbox="allow-same-origin"
        srcDoc={html}
        style={{
          width: box.scale < 1 ? `${100 / box.scale}%` : "100%",
          height: box.scale < 1 ? `${box.height / box.scale}px` : box.height,
          transform: box.scale < 1 ? `scale(${box.scale})` : undefined,
          transformOrigin: "top left",
        }}
        className="bg-white block border-0"
        scrolling="no"
        data-testid={testId}
      />
    </div>
  );
}


function MessageDetail({ detail, parentUserId }: {
  detail: Extract<ActivityDetail, { type: "message" }>;
  parentUserId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const failed = detail.status && detail.status !== "sent" && detail.status !== "delivered";

  // Only fetch the email once its card is actually on screen. The timeline can
  // hold dozens of messages, and eagerly pulling every rendered document would
  // make opening a record download a few megabytes nobody scrolled to.
  // (formatSmsForDisplay lives just below this component.)
  useEffect(() => {
    if (!detail.hasHtml || visible || !ref.current) return;
    const el = ref.current;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [detail.hasHtml, visible]);

  const full = useQuery<{ subject: string | null; bodyHtml: string | null; bodyText: string | null }>({
    queryKey: ["parent-message", parentUserId, detail.notificationId],
    queryFn: async () => {
      const res = await fetch(`/api/parents/${parentUserId}/messages/${detail.notificationId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Could not load the message");
      return res.json();
    },
    enabled: visible,
    staleTime: Infinity,
  });

  return (
    <div ref={ref} className="mt-2.5 pt-2.5 border-t border-border/60 space-y-1.5" data-testid={`detail-message-${detail.notificationId}`}>
      {/* SMS recipients are stored E.164 (+19172247761) - render them
          country-formatted like every other phone in the product. Email
          recipients pass through untouched. */}
      <Row label="To">
        {detail.channel === "SMS" ? formatPhoneDisplay(detail.recipient) || detail.recipient : detail.recipient}
      </Row>
      {detail.subject && <Row label="Subject">{detail.subject}</Row>}
      <Row label="Kind">{titleCaseWords(detail.kind)}</Row>
      <Row label="Delivery">
        {detail.status === "pending" && detail.scheduledFor ? (
          // A future-queued reminder: pending BY DESIGN, so no amber, no
          // "not sent yet" alarm - say when it will go out instead.
          <>
            <span>Scheduled</span>
            <span className="t-helper block">Will send {fmt(detail.scheduledFor)}.</span>
          </>
        ) : (
          <>
            <span style={failed ? { color: "hsl(var(--brand-warning))" } : undefined}>{titleCaseWords(detail.status)}</span>
            {DELIVERY_MEANING[detail.status] && (
              <span className="t-helper block">{DELIVERY_MEANING[detail.status]}</span>
            )}
          </>
        )}
      </Row>

      {/* An email shows the email. The plain-text version was a worse copy of
          the thing sitting right beneath it, so only messages with NO rendered
          document (SMS) fall back to text - rendered through the same
          rich-text pass the chat uses, so the join URL becomes a clickable
          link. formatSmsForDisplay adds the line structure the source lacks
          (SMS copy is written as one long line by design); break-words, not
          break-all, so ordinary words stay whole and only an overlong URL
          ever breaks mid-string. */}
      {!detail.hasHtml && detail.bodyPreview && (
        <div className="text-sm whitespace-pre-wrap break-words pt-1 rounded-[calc(var(--radius)/2)] bg-card border px-2.5 py-2">
          {renderRichText(formatSmsForDisplay(detail.bodyPreview))}
        </div>
      )}

      {!detail.contentStored && !(detail.status === "pending" && detail.scheduledFor) && (
        // Only true of messages sent before the content columns existed. They
        // cannot be recovered - the rendered email resolves brand settings and
        // one-time links at send time - so this says so instead of guessing.
        // Scheduled reminders are excluded: their body is rendered at SEND
        // time, so an empty body is expected, not historical.
        <p className="t-helper">This message was sent before GoStork began recording message content.</p>
      )}

      {detail.hasHtml && (
        <div className="mt-1 rounded-[var(--radius)] border bg-card overflow-hidden">
          {full.isLoading && <p className="t-helper p-3">Loading the email...</p>}
          {full.isError && <p className="t-helper p-3">Could not load this email.</p>}
          {full.data?.bodyHtml && (
            <EmailFrame
              html={full.data.bodyHtml}
              title={full.data.subject || "Sent email"}
              testId={`iframe-message-${detail.notificationId}`}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * SMS copy is written as ONE long line by design (that is what a text message
 * is), so the timeline bubble showed a run-on sentence. Display-only
 * formatting - the stored body is untouched: each sentence gets its own line,
 * and a URL moves to its own line so the link reads as the action it is.
 * Honorifics (Dr. Vicken, St. Jude) must not split - the callback skips the
 * break when the "sentence end" is really an abbreviation.
 */
const SMS_NO_BREAK_AFTER = /^(?:Dr|Mr|Mrs|Ms|St|Jr|Sr|vs|etc|no|approx)\.$/i;
function formatSmsForDisplay(text: string): string {
  // Already multi-line (a future Content Template with real breaks): keep it.
  if (text.includes("\n")) return text;
  return text
    .replace(/\s+(https?:\/\/\S+)/g, "\n$1")
    .replace(/(\S+[.!?])\s+(?=[A-Z0-9])/g, (match, word) =>
      SMS_NO_BREAK_AFTER.test(word) ? match : `${word}\n`);
}

/**
 * A note's Edit / Delete, in the CARD HEADER - same row as the title and
 * date, per review. The state lives in EntryCard because the actions sit in
 * the header while the editor they toggle sits in the body.
 *
 * Delete is a two-step inline confirm, not a dialog. Edit reuses the same
 * rich editor the composer uses; scope stays immutable (the server enforces
 * it - re-scoping by edit would disclose an internal note with no trail).
 * The body is server-sanitized HTML - on write AND on read, which is what
 * makes dangerouslySetInnerHTML safe; legacy plain-text notes carry no tags
 * and render through the pre-wrap path.
 */
type NoteMode = "view" | "edit" | "confirm";

function NoteHeaderActions({ note, mode, setMode, onDelete, onTogglePin, pending, onStartEdit }: {
  note: { id: string; canManage: boolean; pinned: boolean };
  mode: NoteMode;
  setMode: (m: NoteMode) => void;
  onDelete: () => void;
  onTogglePin: () => void;
  pending: boolean;
  onStartEdit: () => void;
}) {
  // The menu renders for EVERY note the viewer can see: pinning belongs to
  // the parent record, not the author (HubSpot semantics), so a colleague
  // covering the lead can pin or unpin too. Only Edit and Delete - the
  // note's words - stay author-only via canManage.
  if (mode === "edit") return null;
  if (mode === "confirm") {
    return (
      <span className="shrink-0 inline-flex items-center gap-2">
        <span className="t-helper">Delete?</span>
        <button
          type="button"
          className="t-helper underline"
          style={{ color: "hsl(var(--destructive))" }}
          onClick={onDelete}
          data-testid={`btn-note-delete-confirm-${note.id}`}
        >
          {pending ? "Deleting..." : "Yes, delete"}
        </button>
        <button type="button" className="t-helper underline" onClick={() => setMode("view")}>Keep it</button>
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // p-3 -m-3 below sm: an invisible 44px-class hit area around the
          // small text (Apple's minimum tap target). The visual layout is
          // unchanged - the negative margin swallows the padding - but a
          // thumb no longer has to land on a 20px-tall word. Desktop keeps
          // the tight footprint.
          // EXACTLY the card title's face: same classes, and the color is
          // INHERITED like the title's rather than set to text-foreground -
          // the token is blue-tinted (15,23,41) while the title inherits the
          // page's near-black (10,10,10), and the mismatch showed.
          className="shrink-0 inline-flex items-center gap-0.5 text-sm font-medium font-ui transition-colors hover:opacity-70 p-3 -m-3 sm:p-0 sm:m-0"
          data-testid={`btn-note-actions-${note.id}`}
        >
          Actions <ChevronDown className="w-3 h-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onTogglePin} data-testid={`btn-note-pin-${note.id}`}>
          <Pin className="w-3.5 h-3.5 mr-2" /> {note.pinned ? "Unpin" : "Pin"}
        </DropdownMenuItem>
        {note.canManage && (
          <DropdownMenuItem onClick={onStartEdit} data-testid={`btn-note-edit-${note.id}`}>
            <Pencil className="w-3.5 h-3.5 mr-2" /> Edit
          </DropdownMenuItem>
        )}
        {note.canManage && (
          <DropdownMenuItem
            onClick={() => setMode("confirm")}
            className="text-[hsl(var(--destructive))] focus:text-[hsl(var(--destructive))]"
            data-testid={`btn-note-delete-${note.id}`}
          >
            <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NoteEntryBody({ note, mode, draft, setDraft, onSave, onCancel, pending }: {
  note: { id: string; html: string };
  mode: NoteMode;
  draft: string;
  setDraft: (h: string) => void;
  onSave: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const hasText = !!draft.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
  if (mode === "edit") {
    return (
      <div className="space-y-2" data-testid={`note-edit-${note.id}`}>
        <RichTextEditor initialHtml={note.html} onChange={setDraft} testId={`note-editor-${note.id}`} />
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!hasText || pending} onClick={onSave} data-testid={`btn-note-save-${note.id}`}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    );
  }
  return isRichNoteHtml(note.html) ? (
    <div
      className="text-sm break-words [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:underline [&_a]:text-primary [&_img]:max-w-full [&_img]:rounded-[var(--radius)] [&_img]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:pl-3"
      // Sanitized server-side on write and read - see server/note-html.ts.
      dangerouslySetInnerHTML={{ __html: note.html }}
      data-testid={`note-body-${note.id}`}
    />
  ) : (
    <p className="text-sm whitespace-pre-wrap break-words" data-testid={`note-body-${note.id}`}>{note.html}</p>
  );
}

function EntryCard({ entry, record, parentUserId, parentName, parentPhotoUrl, viewerRole, onChanged }: {
  entry: Entry; record: ParentRecord; parentUserId: string; parentName: string | null; parentPhotoUrl: string | null;
  viewerRole: "provider" | "admin"; onChanged: () => void;
}) {
  // Note-only state, hosted here because the Edit/Delete links live in the
  // card HEADER while the editor they toggle renders in the body.
  const [noteMode, setNoteMode] = useState<NoteMode>("view");
  const [noteDraft, setNoteDraft] = useState("");
  const noteMut = useCrmMutation(parentUserId, () => setNoteMode("view"));
  // Same story for a task: the card IS the editor, exactly as a note's is.
  const [taskMode, setTaskMode] = useState<TaskMode>("view");
  /** Open = this card is currently showing an editor, whichever kind it is. */
  const isOpen = noteMode === "edit" || taskMode === "edit";
  const closeFromHeader = (e: React.MouseEvent) => {
    // Actions, the pin, a link in the byline - a real control in the header is
    // still itself, not a close button.
    if ((e.target as HTMLElement).closest('a,button,[role="menuitem"],[role="menu"]')) return;
    setNoteMode("view");
    setTaskMode("view");
  };

  /**
   * A note opens for editing when you click it - the whole card is the
   * affordance, not a menu item two clicks away. Only for notes this viewer
   * may actually change; on anyone else's the card stays inert rather than
   * offering an edit that would be refused.
   */
  const canOpenNoteEdit = !!entry.note?.canManage && noteMode === "view";
  /**
   * A task opens the same way. SYSTEM tasks are the product's own words about
   * work it is tracking, so they stay inert - editing the title of "Review and
   * approve: cost sheet" would just make the queue lie.
   */
  const canOpenTaskEdit = !!entry.task && entry.task.source !== "SYSTEM" && taskMode === "view";
  const openTaskEdit = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest('a,button,input,textarea,select,[role="menuitem"],[role="menu"],[contenteditable="true"]')) return;
    if ((window.getSelection()?.toString() || "").length > 0) return;
    setTaskMode("edit");
  };
  const openNoteEdit = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    // Never swallow a real control. A note body can hold links and uploaded
    // files, and the header carries Actions and the pin.
    if (el.closest('a,button,input,textarea,select,[role="menuitem"],[role="menu"],[contenteditable="true"]')) return;
    // Dragging across the text to copy it is not a request to edit it.
    if ((window.getSelection()?.toString() || "").length > 0) return;
    setNoteDraft(entry.note!.html);
    setNoteMode("edit");
  };
  const meta = KIND_META[entry.kind];
  const isSms = entry.detail?.type === "message" && entry.detail.channel === "SMS";
  const callIcon = CALL_ICONS[entry.eventType || ""];
  const isNoShow = /NO_SHOW/.test(entry.eventType || "");
  // An SMS card was showing an envelope. The icon follows the channel, not
  // the bucket the two share.
  // A file card reads as a file, whoever sent it - the sparkle and the person
  // glyph both say who acted and nothing about what changed hands.
  const isFile = entry.detail?.type === "attachment";
  const isQuote = entry.detail?.type === "cost_sheet_card" || entry.detail?.type === "cost_sheet";
  const Icon = isSms ? MessageSquare : isFile ? FileText : isQuote ? Receipt : (callIcon || meta.icon);
  const tint =
    // A text message reads as a text message at a glance - green, the way
    // every messaging app has trained people to expect. --brand-success
    // rather than iMessage's literal hex, per the no-hardcoded-colour rule.
    isSms ? "hsl(var(--brand-success))"
    // Sticky-note gold - the one colour the timeline was not spending, and
    // the colour every notes product has trained people to expect. Notes
    // and emails both wore the accent purple, so only the glyph told a
    // hand-written note apart from an automated send.
    : entry.kind === "note" ? "var(--swipe-undo)"
    // A document is not an email. Both were drawing the accent purple, so the
    // only thing separating a prep guide from a booking reminder was the
    // glyph. Blue is the one hue the timeline was not already spending, and
    // --swipe-compare is where the brand keeps it.
    : isFile ? "var(--swipe-compare)"
    // Money gets the brand's own teal and a receipt, so a quote never reads as
    // one more thing we emailed.
    : isQuote ? "hsl(var(--primary))"
    // A missed call is not a cancelled one: nobody decided anything, it just
    // needs chasing. Warning tone, matching the booking widget everywhere
    // else in the product.
    : isNoShow ? "hsl(var(--brand-warning))"
    // Calendar red, the way every calendar app has trained people to expect.
    // --destructive is the brand's red and is used here for its COLOUR, not
    // its "danger" meaning - a booked consultation is good news. The camera
    // on a completed call is deliberately excluded, so it keeps reading as a
    // call rather than as another calendar entry.
    : callIcon && callIcon !== Video ? "hsl(var(--destructive))"
    : meta.tone === "accent" ? "hsl(var(--accent))"
    : meta.tone === "primary" ? "hsl(var(--primary))"
    : "hsl(var(--muted-foreground))";
  const avatar =
    entry.kind === "ai" && entry.aiAvatarUrl ? (
      // Eva sent this, so it wears Eva's face - the same reason a parent
      // action shows the parent and a note shows its author.
      <img
        src={getPhotoSrc(entry.aiAvatarUrl) || undefined}
        alt={entry.aiName || "Concierge"}
        className="w-7 h-7 rounded-full object-cover object-top shrink-0"
      />
    ) : entry.kind === "parent" ? (
      parentPhotoUrl
        ? <img src={getPhotoSrc(parentPhotoUrl) || undefined} alt={parentName || "Parent"} className="w-7 h-7 rounded-full object-cover object-top shrink-0" />
        : <DoctorMonogram name={parentName || "Parent"} size={28} rounded="9999px" />
    ) : (
      <span
        className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
        style={{ background: `color-mix(in srgb, ${tint} 12%, transparent)`, color: tint }}
      >
        <Icon className="w-3.5 h-3.5" />
      </span>
    );

  return (
    // Header row, then everything else at FULL card width. The detail used to
    // sit in a column beside the icon, which indented every payload by 38px
    // and cost a phone a tenth of its screen for no information.
    // Pinned notes wear the pin ON the frame, centered on the top border,
    // HubSpot-style - not as a chip in the header row. The chip pokes ~10px
    // above the card, so a pinned card carries its own top margin: an inline
    // style, because a margin utility loses to space-y-2's higher-specificity
    // sibling selector on the feed.
    <div
      className={cn(
        "relative rounded-[var(--radius)] border bg-card p-3 space-y-1.5",
        (canOpenNoteEdit || canOpenTaskEdit) && "cursor-text hover:border-primary/40 transition-colors",
      )}
      style={entry.note?.pinned ? { marginTop: "1.125rem" } : undefined}
      onClick={canOpenNoteEdit ? openNoteEdit : canOpenTaskEdit ? openTaskEdit : undefined}
      data-testid={`activity-${entry.id}`}
    >
      {/* The header is also the way OUT: a card opens when you click its body,
          so its top row - type, date, the frame around them - closes it again.
          Without that the only exit from an editor you opened by clicking was
          to hunt for Cancel. */}
      <div
        className={cn(
          "flex items-center gap-2.5",
          // Same line the email card's detail block draws, for the same
          // reason: the type and date read as a card header rather than as the
          // first line of the content. Only where the body is our own writing -
          // a detail block brings its own rule and two would stack.
          (entry.note || entry.task) && "pb-2.5 border-b border-border/60",
          isOpen && "cursor-pointer",
        )}
        onClick={isOpen ? closeFromHeader : undefined}
      >
        {avatar}
        {/* Title row never wraps: byline (and org) truncate before Actions
            ever leaves the top-right corner - on a phone a wrapped second
            line read as the button being missing entirely. */}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-x-2">
            <span className="text-sm font-medium font-ui shrink-0">{entry.title}</span>
            {entry.byline && <span className="t-helper truncate min-w-0">by {entry.byline}</span>}
            {/* The org is only information when there is more than one of
                them. An admin's timeline spans every provider, so each card
                has to say whose it is; a provider sees nothing but their own
                org, where repeating it on every row is pure noise. */}
            {entry.org && viewerRole === "admin" && (
              <span className="t-helper truncate min-w-0">{entry.org}</span>
            )}
            <span className="ml-auto shrink-0 inline-flex items-center gap-3">
              {entry.note && (
                <NoteHeaderActions
                  note={entry.note}
                  mode={noteMode}
                  setMode={setNoteMode}
                  pending={noteMut.isPending}
                  onStartEdit={() => { setNoteDraft(entry.note!.html); setNoteMode("edit"); }}
                  onTogglePin={() => noteMut.mutate({ url: `/api/parents/${parentUserId}/notes/${entry.note!.id}`, method: "PATCH", body: { pinned: !entry.note!.pinned } })}
                  onDelete={() => noteMut.mutate({ url: `/api/parents/${parentUserId}/notes/${entry.note!.id}`, method: "DELETE" })}
                />
              )}
            </span>
          </div>
          {/* HubSpot card shape on every viewport: the date lives on its own
              line under the header, leaving the far right corner of the
              title row to Actions alone. */}
          <p className="t-helper mt-0.5">{fmt(entry.at)}</p>
        </div>
      </div>
      {entry.note ? (
        <NoteEntryBody
          note={entry.note}
          mode={noteMode}
          draft={noteDraft}
          setDraft={setNoteDraft}
          pending={noteMut.isPending}
          onSave={() => noteMut.mutate({ url: `/api/parents/${parentUserId}/notes/${entry.note!.id}`, method: "PATCH", body: { body: noteDraft } })}
          onCancel={() => setNoteMode("view")}
        />
      ) : entry.task ? (
        <>
          {taskMode !== "edit" && (
            <p className="text-sm font-medium whitespace-pre-wrap break-words">{entry.task.title}</p>
          )}
          <TaskCardBody
            record={record}
            task={entry.task}
            mode={taskMode}
            setMode={setTaskMode}
            onChanged={onChanged}
          />
        </>
      ) : entry.body ? (
        <p className="text-sm whitespace-pre-wrap break-words">{entry.body}</p>
      ) : null}
      {entry.extra}
      {entry.detail && <DetailBlock detail={entry.detail} parentUserId={parentUserId} viewerRole={viewerRole} onChanged={onChanged} />}
      {/* The footer label earns its place only when it ADDS something the
          header didn't say (e.g. "AI Activity" on an email). On a note it
          just repeated the title. */}
      {!entry.note && !entry.task && <p className="t-helper">{meta.label}</p>}
      {/* LAST child on purpose: as the first child it would push margin-top
          from the card's space-y onto the real first row. Absolute, so order
          does not matter visually. */}
      {entry.note?.pinned && (
        <span
          className="absolute left-1/2 -translate-x-1/2 w-7 h-7 rounded-full border bg-card flex items-center justify-center shadow-sm"
          // Inline, not -top-*: the card's space-y hands this LAST child a
          // margin-top that still shifts an absolutely positioned element,
          // which sank the chip 6px below center. marginTop: 0 kills that;
          // -15px = half the 28px chip plus the card's 1px border, so the
          // chip's midline rides exactly on the visible frame line.
          style={{ top: -15, marginTop: 0 }}
          title="Pinned"
          data-testid={`note-pinned-${entry.note.id}`}
        >
          {/* rotate-45 tips the head to the upper right, the way HubSpot
              draws a pin that is IN the board rather than lying beside it. */}
          <Pin className="w-4 h-4 rotate-45" style={{ color: "hsl(var(--accent))" }} />
        </span>
      )}
    </div>
  );
}

type Composer = "note" | "task" | "next_step" | null;

export function ParentActivitySection({ record, scope }: {
  record: ParentRecord;
  /**
   * The page-wide service-line filter, relocated here from the page's top
   * right corner (by request) but unchanged in behavior: picking a line
   * still scopes the WHOLE record - ladders, interested profiles, documents
   * - not just this feed. State lives in the page (URL param); this is only
   * the control.
   */
  scope?: {
    lines: string[];
    labels: Record<string, string>;
    active: string;
    onChange: (line: string) => void;
  };
}) {
  const [composer, setComposer] = useState<Composer>(null);
  const qc = useQueryClient();
  // Confirming or declining from a card changes the record, so pull it again.
  const refetchRecord = () => {
    qc.invalidateQueries({ queryKey: ["/api/parents", record.parent.id, "record"] });
    qc.invalidateQueries({ queryKey: ["journey-timeline"] });
  };

  const entries = useMemo(() => buildEntries(record), [record]);

  const toggle = (c: Exclude<Composer, null>) => setComposer((prev) => (prev === c ? null : c));

  return (
    <div className="space-y-4">
      {/* Actions on the timeline, not sections of their own. Inline panels,
          never a dialog - the house rule, and a note you have to open a modal
          to write is a note nobody writes. */}
      <div className="flex flex-wrap gap-2">
        {/* Outline buttons are transparent, which reads fine on a white card
            but disappears into the sand page these sit directly on - same
            fix as the mobile record tabs: explicit card fill. */}
        <Button
          variant={composer === "note" ? "default" : "outline"}
          size="sm"
          className={composer === "note" ? undefined : "bg-card"}
          onClick={() => toggle("note")}
          data-testid="btn-activity-add-note"
        >
          {/* No chevron: this opens a composer, it does not open a menu, and
              the caret promised a dropdown that never existed. Closing it is
              Cancel, next to Post, where the note's own edit controls are. */}
          <StickyNote className="w-3.5 h-3.5 mr-1.5" /> Create Note
        </Button>
        {/* A task is an ACT on the record, the same kind of thing as writing a
            note, so creating one sits beside Create Note rather than inside
            the list of tasks that already exist. */}
        <Button
          variant={composer === "task" ? "default" : "outline"}
          size="sm"
          className={composer === "task" ? undefined : "bg-card"}
          onClick={() => toggle("task")}
          data-testid="btn-activity-add-task"
        >
          <CircleCheck className="w-3.5 h-3.5 mr-1.5" /> Create Task
        </Button>
        <Button
          variant={composer === "next_step" ? "default" : "outline"}
          size="sm"
          className={composer === "next_step" ? undefined : "bg-card"}
          onClick={() => toggle("next_step")}
          data-testid="btn-activity-add-next-step"
        >
          <CalendarClock className="w-3.5 h-3.5 mr-1.5" /> Next step
          <ChevronDown className={cn("w-3 h-3 ml-1 transition-transform", composer === "next_step" && "rotate-180")} />
        </Button>
        {scope && scope.lines.length >= 2 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="bg-card" data-testid="btn-activity-scope">
                <Filter className="w-3.5 h-3.5 mr-1.5" />
                {scope.active === "all" ? "All services" : scope.labels[scope.active] || scope.active}
                <ChevronDown className="w-3 h-3 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {["all", ...scope.lines].map((line) => (
                <DropdownMenuItem key={line} onClick={() => scope.onChange(line)} data-testid={`record-scope-${line}`}>
                  <Check className={cn("w-3.5 h-3.5 mr-2", scope.active === line ? "opacity-100" : "opacity-0")} />
                  {line !== "all" && <ServiceDot service={scope.labels[line] || line} className="mr-1.5" />}
                  {line === "all" ? "All services" : scope.labels[line] || line}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Same chrome as the note cards below - white card, same radius, border
          and padding. These panels used a bg-secondary/40 tint, so composing a
          note looked like a different kind of object from the note it was
          about to become, and from the identical editor that opens when you
          edit one in place. The task composer gets it too: they are siblings in one
          row and a tinted one beside a white one reads as a mistake. */}
      {composer === "note" && (
        <div className="rounded-[var(--radius)] border bg-card p-3" data-testid="panel-activity-note">
          <NoteComposer
            record={record}
            onPosted={() => setComposer(null)}
            onCancel={() => setComposer(null)}
          />
        </div>
      )}
      {composer === "task" && (
        <div className="rounded-[var(--radius)] border bg-card p-3" data-testid="panel-activity-task">
          <ParentTaskComposer
            record={record}
            onDone={() => setComposer(null)}
            onCancel={() => setComposer(null)}
          />
        </div>
      )}
      {composer === "next_step" && (
        <div className="rounded-[var(--radius)] border bg-card p-3" data-testid="panel-activity-next-step">
          <ParentTaskPanel record={record} />
        </div>
      )}

      {entries.length === 0 && (
        <div className="rounded-[var(--radius)] border bg-secondary/40 p-4">
          <p className="t-helper">Nothing has happened yet. The first note is usually why this family came in.</p>
        </div>
      )}

      <div className="space-y-2" data-testid="activity-feed">
        {entries.map((e) => (
          <EntryCard
            key={e.id}
            entry={e}
            record={record}
            parentUserId={record.parent.id}
            parentName={record.parent.name ?? null}
            parentPhotoUrl={record.parent.photoUrl ?? null}
            viewerRole={record.viewer.role}
            onChanged={refetchRecord}
          />
        ))}
      </div>

    </div>
  );
}
