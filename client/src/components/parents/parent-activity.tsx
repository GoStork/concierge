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
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, CalendarClock, ChevronDown, Loader2, MessageSquare,
  Sparkles, StickyNote, Tag as TagIcon, TrendingUp, User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NoteComposer, ParentFollowUpPanel } from "./parent-crm-ui";
import type { ParentRecord } from "./parent-record-types";

interface JourneyEventRow {
  id: string;
  eventType: string;
  actorRole: string | null;
  metadata: Record<string, any> | null;
  createdAt: string;
  providerId: string | null;
}

/**
 * How an entry is badged.
 *
 * The three system kinds mirror the way HubSpot separates what the pipeline
 * did from what an automation sent. "parent" is ours: an event the FAMILY
 * caused - opening an invoice, favouriting a profile - is neither a stage
 * change nor something we sent, and filing it under either would be a lie
 * about who acted.
 */
type ActivityKind = "note" | "next_step" | "tag" | "deal" | "ai" | "parent";

const KIND_META: Record<ActivityKind, { label: string; icon: typeof StickyNote; tone: "accent" | "primary" | "muted" }> = {
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
function kindForEvent(ev: JourneyEventRow): ActivityKind {
  if (ev.actorRole === "parent" || PARENT_EVENTS.has(ev.eventType)) return "parent";
  if (DEAL_EVENTS.has(ev.eventType)) return "deal";
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
  IP_FORM_PROMPTED: "Parent Form requested",
  IP_FORM_SUBMITTED: "Parent Form submitted",
  CONSULT_PRELIM_ACKNOWLEDGED: "Acknowledged the pre-call notice",
  MATCH_CALL_ATTENDANCE_ACKNOWLEDGED: "Acknowledged Match Call attendance",
  MATCH_CALL_DECISION_ACKNOWLEDGED: "Acknowledged the Match Call decision",
  SUBJECT_THREAD_OPENED: "New thread opened",
  CRM_OWNER_ASSIGNED: "Lead owner assigned",
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
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function buildEntries(record: ParentRecord, events: JourneyEventRow[]): Entry[] {
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

  for (const ev of events) {
    if (SUPERSEDED_BY_PAYLOAD.has(ev.eventType)) continue;
    const org = record.providerOrgs.find((o) => o.providerId === ev.providerId);
    out.push({
      id: `ev-${ev.id}`,
      kind: kindForEvent(ev),
      at: ev.createdAt,
      title: EVENT_LABELS[ev.eventType] || ev.eventType.toLowerCase().replace(/_/g, " "),
      org: org?.providerName || null,
    });
  }

  return out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

function EntryCard({ entry }: { entry: Entry }) {
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  const tint =
    meta.tone === "accent" ? "hsl(var(--accent))"
    : meta.tone === "primary" ? "hsl(var(--primary))"
    : "hsl(var(--muted-foreground))";
  return (
    <div className="rounded-[var(--radius)] border bg-card p-3" data-testid={`activity-${entry.id}`}>
      <div className="flex items-start gap-2.5">
        <span
          className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5"
          style={{ background: `color-mix(in srgb, ${tint} 12%, transparent)`, color: tint }}
        >
          <Icon className="w-3.5 h-3.5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-baseline gap-x-2 gap-y-0.5 flex-wrap">
            <span className="text-sm font-medium font-ui">{entry.title}</span>
            {entry.byline && <span className="t-helper">by {entry.byline}</span>}
            {entry.org && <span className="t-helper">{entry.org}</span>}
            <span className="t-helper ml-auto shrink-0">{fmt(entry.at)}</span>
          </div>
          {entry.body && <p className="text-sm whitespace-pre-wrap break-words">{entry.body}</p>}
          {entry.extra}
          <p className="t-helper">{meta.label}</p>
        </div>
      </div>
    </div>
  );
}

type Composer = "note" | "next_step" | null;

export function ParentActivitySection({ record }: { record: ParentRecord }) {
  const [composer, setComposer] = useState<Composer>(null);

  const eventsQuery = useQuery<{ events: JourneyEventRow[] }>({
    queryKey: ["journey-events-feed", record.parent.id, record.viewer.providerId || "all"],
    queryFn: async () => {
      const p = new URLSearchParams({ parentUserId: record.parent.id, limit: "50" });
      const res = await fetch(`/api/journey/events?${p}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load activity");
      return res.json();
    },
  });

  const entries = useMemo(
    () => buildEntries(record, eventsQuery.data?.events || []),
    [record, eventsQuery.data],
  );

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
        <div className="rounded-[var(--radius)] bg-secondary p-3" data-testid="panel-activity-note">
          <NoteComposer record={record} onPosted={() => setComposer(null)} />
        </div>
      )}
      {composer === "next_step" && (
        <div className="rounded-[var(--radius)] bg-secondary p-3" data-testid="panel-activity-next-step">
          <ParentFollowUpPanel record={record} />
        </div>
      )}

      {eventsQuery.isLoading && (
        <div className="flex items-center gap-2 py-4">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <span className="t-helper">Loading activity...</span>
        </div>
      )}

      {!eventsQuery.isLoading && entries.length === 0 && (
        <div className="rounded-[var(--radius)] bg-secondary p-4">
          <p className="t-helper">Nothing has happened yet. The first note is usually why this family came in.</p>
        </div>
      )}

      <div className="space-y-2" data-testid="activity-feed">
        {entries.map((e) => <EntryCard key={e.id} entry={e} />)}
      </div>

      {eventsQuery.isError && (
        <div className="flex items-center gap-2">
          <MessageSquare className="w-3.5 h-3.5 text-destructive" />
          <span className="t-helper">Could not load the event history. Notes and next steps above are complete.</span>
        </div>
      )}
    </div>
  );
}
