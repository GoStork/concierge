/**
 * The parent record's activity timeline: one chronological stream of
 * everything that has happened to this family, one card per entry.
 *
 * It replaces three separate sections (Notes, Next step and tags, and the
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
 * So the feed merges the events with the real note / next-step / tag objects
 * from the record payload, which do carry their text and have already been
 * scoped and redacted server-side. The CRM_* events are dropped in the merge,
 * or every note would appear twice: once with its body and once as a bare
 * "Note added".
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { InlineBookingNotification } from "@/components/chat/inline-booking-notification";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle, CalendarCheck, CalendarClock, CalendarX, ChevronDown, ExternalLink,
  FileText, Mail, MessageSquare,
  Sparkles, StickyNote, Tag as TagIcon, TrendingUp, User, Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DoctorMonogram } from "@/components/marketplace/doctor-monogram";
import { getPhotoSrc } from "@/lib/profile-utils";
import { NoteComposer, ParentFollowUpPanel } from "./parent-crm-ui";
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
type ActivityKind = "note" | "next_step" | "tag" | "deal" | "ai" | "parent" | "message";

const KIND_META: Record<ActivityKind, { label: string; icon: typeof StickyNote; tone: "accent" | "primary" | "muted" }> = {
  message: { label: "AI Activity", icon: Mail, tone: "accent" },
  note: { label: "Note", icon: StickyNote, tone: "accent" },
  next_step: { label: "Next step", icon: CalendarClock, tone: "primary" },
  tag: { label: "Tag", icon: TagIcon, tone: "accent" },
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
  if (ev.eventType === "MESSAGE_EMAIL" || ev.eventType === "MESSAGE_SMS") return "message";
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
  CONSULTATION_NO_SHOW_PARENT: CalendarX,
  CONSULTATION_NO_SHOW_PROVIDER: CalendarX,
  CONSULTATION_NO_SHOW_BOTH: CalendarX,
  MATCH_CALL_SCHEDULED: CalendarClock,
  MATCH_CALL_CONFIRMED: CalendarCheck,
  MATCH_CALL_RESCHEDULED: CalendarClock,
  MATCH_CALL_CANCELED: CalendarX,
  MATCH_CALL_COMPLETED: Video,
  MATCH_CALL_NO_SHOW_PARENT: CalendarX,
  MATCH_CALL_NO_SHOW_PROVIDER: CalendarX,
  MATCH_CALL_NO_SHOW_BOTH: CalendarX,
};

/** These arrive with their real text from the record payload instead. */
const SUPERSEDED_BY_PAYLOAD = new Set([
  "CRM_NOTE_ADDED", "CRM_NOTE_SHARED_WITH_PROVIDER",
  "CRM_FOLLOWUP_SET", "CRM_FOLLOWUP_COMPLETED", "CRM_TAG_ADDED",
]);

interface Entry {
  id: string;
  kind: ActivityKind;
  at: string;
  title: string;
  body?: string | null;
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
      body: n.body,
      byline: n.authorName || "Staff",
      extra: (
        <span
          className="text-xs font-ui px-2 py-0.5 rounded-full"
          style={internal
            ? { background: "hsl(var(--accent) / 0.15)", color: "hsl(var(--accent))" }
            : { background: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
        >
          {internal ? "GoStork internal" : `Shared with ${org?.providerName || "provider"}`}
        </span>
      ),
    });
  }

  for (const f of record.crm.followUps) {
    out.push({
      id: `followup-${f.id}`,
      // Placed by when it was SET, not when it is due - this is a history, and
      // a next step due next month did not happen next month.
      at: f.createdAt || f.dueAt,
      kind: "next_step",
      title: "Next step set",
      body: f.body,
      byline: f.assigneeName || null,
      extra: (
        <span
          className="inline-flex items-center gap-1 text-xs font-ui"
          style={f.overdue ? { color: "hsl(var(--brand-warning))" } : undefined}
        >
          {f.overdue && <AlertTriangle className="w-3 h-3" />}
          Due {new Date(f.dueAt).toLocaleDateString()}
        </span>
      ),
    });
  }

  for (const t of record.crm.tags) {
    if (!t.createdAt) continue;   // pre-dates the timestamp; the chip still shows in the header
    out.push({
      id: `tag-${t.id}`,
      kind: "tag",
      at: t.createdAt,
      title: "Tag added",
      body: t.label,
    });
  }

  for (const ev of record.activity || []) {
    if (SUPERSEDED_BY_PAYLOAD.has(ev.eventType)) continue;
    out.push({
      id: `ev-${ev.id}`,
      kind: kindForEvent(ev),
      at: ev.at,
      title: EVENT_LABELS[ev.eventType] || ev.eventType.toLowerCase().replace(/_/g, " "),
      org: ev.providerName,
      detail: ev.detail,
      eventType: ev.eventType,
      aiName: ev.aiName,
      aiAvatarUrl: ev.aiAvatarUrl,
    });
  }

  return out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}


const money = (cents: number | null) =>
  cents == null ? null : `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

/** A labelled row inside a detail block. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="t-micro-label shrink-0">{label}</span>
      <span className="t-micro-value min-w-0 break-words">{children}</span>
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
  // bg-secondary/40 is exactly what the Home journey cards use. At full
  // strength this token is a visible mint, which read as a different surface
  // from every other card in the product.
  const shell = "mt-2 rounded-[var(--radius)] border bg-secondary/40 p-3 space-y-1.5";

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
          <Row label="Status now">{detail.status}{detail.outcome ? ` - ${detail.outcome}` : ""}</Row>
        )}
        {detail.meetingSubtype && <Row label="Type">{detail.meetingSubtype.replace(/_/g, " ").toLowerCase()}</Row>}
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
    const failed = detail.status && detail.status !== "sent" && detail.status !== "delivered";
    return (
      <div className={shell} data-testid={`detail-message-${detail.notificationId}`}>
        <Row label="To">{detail.recipient}</Row>
        <Row label="Kind">{detail.kind.replace(/_/g, " ")}</Row>
        <Row label="Delivery">
          <span style={failed ? { color: "hsl(var(--brand-warning))" } : undefined}>{detail.status}</span>
        </Row>
        {/* Said plainly rather than faked: Notification records that a message
            went out and nothing about what it said. Giving this card a real
            body needs a column on Notification plus a write at dispatch. */}
        <p className="t-helper">The message text was not stored, so it cannot be shown here.</p>
      </div>
    );
  }

  if (detail.type === "invoice") {
    return (
      <div className={shell} data-testid={`detail-invoice-${detail.invoiceId}`}>
        {detail.description && <Row label="For">{detail.description}</Row>}
        {money(detail.amountCents) && <Row label="Amount">{money(detail.amountCents)}</Row>}
        <Row label="Status">{detail.status}</Row>
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
      <div className={shell} data-testid={`detail-agreement-${detail.agreementId}`}>
        <Row label="Status">{detail.status}</Row>
        {detail.documentUrl && (
          <Button size="sm" variant="outline" className="mt-1" onClick={() => window.open(detail.documentUrl as string, "_blank", "noopener,noreferrer")} data-testid={`btn-agreement-${detail.agreementId}`}>
            <FileText className="w-3.5 h-3.5 mr-1.5" /> Open agreement
          </Button>
        )}
      </div>
    );
  }

  if (detail.type === "cost_sheet") {
    return (
      <div className={shell} data-testid={`detail-cost-sheet-${detail.quoteId}`}>
        {money(detail.totalCostCents) && <Row label="Total">{money(detail.totalCostCents)}</Row>}
        {detail.notes && <Row label="Notes">{detail.notes}</Row>}
        {detail.fileUrl && (
          <Button size="sm" variant="outline" className="mt-1" onClick={() => window.open(detail.fileUrl as string, "_blank", "noopener,noreferrer")} data-testid={`btn-cost-sheet-${detail.quoteId}`}>
            <FileText className="w-3.5 h-3.5 mr-1.5" /> {detail.fileName || "Open cost sheet"}
          </Button>
        )}
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
        {detail.hasResponse ? (
          <Row label="Your reply">{detail.responseText}</Row>
        ) : (
          <Button size="sm" variant="outline" className="mt-1" onClick={() => navigate(`/providers/${detail.providerId}?tab=reviews&review=${detail.reviewId}`)} data-testid={`btn-review-reply-${detail.reviewId}`}>
            <MessageSquare className="w-3.5 h-3.5 mr-1.5" /> Reply to review
          </Button>
        )}
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

function EntryCard({ entry, parentUserId, parentName, parentPhotoUrl, viewerRole, onChanged }: {
  entry: Entry; parentUserId: string; parentName: string | null; parentPhotoUrl: string | null;
  viewerRole: "provider" | "admin"; onChanged: () => void;
}) {
  const meta = KIND_META[entry.kind];
  const isSms = entry.detail?.type === "message" && entry.detail.channel === "SMS";
  const callIcon = CALL_ICONS[entry.eventType || ""];
  // An SMS card was showing an envelope. The icon follows the channel, not
  // the bucket the two share.
  const Icon = isSms ? MessageSquare : (callIcon || meta.icon);
  const tint =
    // A text message reads as a text message at a glance - green, the way
    // every messaging app has trained people to expect. --brand-success
    // rather than iMessage's literal hex, per the no-hardcoded-colour rule.
    isSms ? "hsl(var(--brand-success))"
    // Calendar red, the way every calendar app has trained people to expect.
    // --destructive is the brand's red and is used here for its COLOUR, not
    // its "danger" meaning - a booked consultation is good news. The camera
    // on a completed call is deliberately excluded, so it keeps reading as a
    // call rather than as another calendar entry.
    : callIcon && callIcon !== Video ? "hsl(var(--destructive))"
    : meta.tone === "accent" ? "hsl(var(--accent))"
    : meta.tone === "primary" ? "hsl(var(--primary))"
    : "hsl(var(--muted-foreground))";
  return (
    <div className="rounded-[var(--radius)] border bg-card p-3" data-testid={`activity-${entry.id}`}>
      <div className="flex items-start gap-2.5">
        {entry.kind === "ai" && entry.aiAvatarUrl ? (
          // Eva sent this, so it wears Eva's face - the same reason a parent
          // action shows the parent and a note shows its author.
          <img
            src={getPhotoSrc(entry.aiAvatarUrl) || undefined}
            alt={entry.aiName || "Concierge"}
            className="w-7 h-7 rounded-full object-cover object-top shrink-0 mt-0.5"
          />
        ) : entry.kind === "parent" ? (
          // The family did this, so show the family - the same reason a note
          // carries its author's name.
          parentPhotoUrl
            ? <img src={getPhotoSrc(parentPhotoUrl) || undefined} alt={parentName || "Parent"} className="w-7 h-7 rounded-full object-cover object-top shrink-0 mt-0.5" />
            : <DoctorMonogram name={parentName || "Parent"} size={28} rounded="9999px" />
        ) : (
          <span
            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5"
            style={{ background: `color-mix(in srgb, ${tint} 12%, transparent)`, color: tint }}
          >
            <Icon className="w-3.5 h-3.5" />
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-baseline gap-x-2 gap-y-0.5 flex-wrap">
            <span className="text-sm font-medium font-ui">{entry.title}</span>
            {entry.byline && <span className="t-helper">by {entry.byline}</span>}
            {entry.org && <span className="t-helper">{entry.org}</span>}
            <span className="t-helper ml-auto shrink-0">{fmt(entry.at)}</span>
          </div>
          {entry.body && <p className="text-sm whitespace-pre-wrap break-words">{entry.body}</p>}
          {entry.extra}
          {entry.detail && <DetailBlock detail={entry.detail} parentUserId={parentUserId} viewerRole={viewerRole} onChanged={onChanged} />}
          <p className="t-helper">{meta.label}</p>
        </div>
      </div>
    </div>
  );
}

type Composer = "note" | "next_step" | null;

export function ParentActivitySection({ record }: { record: ParentRecord }) {
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
        <Button
          variant={composer === "note" ? "default" : "outline"}
          size="sm"
          onClick={() => toggle("note")}
          data-testid="btn-activity-add-note"
        >
          <StickyNote className="w-3.5 h-3.5 mr-1.5" /> Note
          <ChevronDown className={cn("w-3 h-3 ml-1 transition-transform", composer === "note" && "rotate-180")} />
        </Button>
        <Button
          variant={composer === "next_step" ? "default" : "outline"}
          size="sm"
          onClick={() => toggle("next_step")}
          data-testid="btn-activity-add-next-step"
        >
          <CalendarClock className="w-3.5 h-3.5 mr-1.5" /> Next step and tags
          <ChevronDown className={cn("w-3 h-3 ml-1 transition-transform", composer === "next_step" && "rotate-180")} />
        </Button>
      </div>

      {composer === "note" && (
        <div className="rounded-[var(--radius)] border bg-secondary/40 p-3" data-testid="panel-activity-note">
          <NoteComposer record={record} onPosted={() => setComposer(null)} />
        </div>
      )}
      {composer === "next_step" && (
        <div className="rounded-[var(--radius)] border bg-secondary/40 p-3" data-testid="panel-activity-next-step">
          <ParentFollowUpPanel record={record} />
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
