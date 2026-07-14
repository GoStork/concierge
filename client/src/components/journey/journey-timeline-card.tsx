import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, AlertTriangle, Loader2 } from "lucide-react";

/**
 * Phase 7A: the shared journey timeline.
 *
 * One component, three surfaces:
 *  - parent Home ("home" variant: one card per journey, all types)
 *  - provider chat sidebar ("sidebar": scoped to that provider's journey)
 *  - admin concierge monitor ("sidebar" with explicit providerId, or all
 *    journeys on an Eva session)
 *
 * Stages arrive fully derived from /api/journey/timeline (journey-timeline.ts
 * on the server) - this component only renders. Parents fetch their own
 * account (no params); provider/admin viewers pass parentUserId (+ optional
 * providerId; provider users are force-scoped server-side anyway).
 */

interface StageOut {
  id: string;
  label: string;
  reachedAt: string | null;
  state: "done" | "current" | "upcoming";
  optional?: boolean;
  tone?: "warning";
}

interface JourneyOut {
  journeyType: string;
  typeLabel: string;
  providerId: string;
  providerName: string;
  providerLogo: string | null;
  sessionId: string | null;
  stages: StageOut[];
  currentStageId: string | null;
  attention: { kind: string; label: string } | null;
  lastActivityAt: string | null;
}

const EVENT_LABELS: Record<string, string> = {
  CONSULTATION_SCHEDULED: "Consultation scheduled",
  CONSULTATION_CONFIRMED: "Consultation confirmed",
  CONSULTATION_RESCHEDULED: "Consultation rescheduled",
  CONSULTATION_CANCELED: "Consultation canceled",
  CONSULTATION_COMPLETED: "Consultation completed",
  CONSULTATION_NO_SHOW_PARENT: "Parent missed the call",
  CONSULTATION_NO_SHOW_PROVIDER: "Provider missed the call",
  CONSULTATION_NO_SHOW_BOTH: "Call never happened",
  CONSULTATION_ELAPSED_UNVERIFIED: "Call time passed",
  CANCELED_NOT_REBOOKED: "Canceled without rebooking",
  MATCH_CALL_SCHEDULED: "Match Call scheduled",
  MATCH_CALL_CONFIRMED: "Match Call confirmed",
  MATCH_CALL_RESCHEDULED: "Match Call rescheduled",
  MATCH_CALL_CANCELED: "Match Call canceled",
  MATCH_CALL_COMPLETED: "Match Call completed",
  MATCH_CALL_NO_SHOW_PARENT: "Parent missed the Match Call",
  MATCH_CALL_NO_SHOW_PROVIDER: "Provider missed the Match Call",
  MATCH_CALL_NO_SHOW_BOTH: "Match Call never happened",
  MATCH_ACCEPTED_BY_PARENT: "Parent said yes to the match",
  MATCH_DECLINED_BY_PARENT: "Parent declined the match",
  MATCH_ACCEPTED_BY_SURROGATE: "Surrogate side said yes",
  MATCH_DECLINED_BY_SURROGATE: "Surrogate side declined",
  MATCH_CONFIRMED: "Match confirmed",
  MATCH_DECLINED: "Match declined",
  PROFILE_PRESENTED: "Profile presented",
  PROFILE_FAVORITED: "Profile favorited",
  WHISPER_ASKED: "Question sent to provider",
  WHISPER_ANSWERED: "Provider answered a question",
  PREP_INTAKE_COMPLETED: "Call prep completed",
  PROVIDER_CONNECTED: "Provider joined the chat",
  ESCALATED_TO_HUMAN: "Asked for the GoStork team",
  LAWYER_CONNECTED: "Connected with a lawyer",
  INVOICE_SENT: "Invoice sent",
  INVOICE_OPENED: "Invoice opened",
  INVOICE_PAID: "Invoice paid",
  BANK_CHECKOUT_STARTED: "Bank checkout started",
  COST_SHEET_SHARED: "Cost sheet shared",
  COST_SHEET_OPENED: "Cost sheet opened",
  AGREEMENT_SENT: "Agreement sent",
  AGREEMENT_VIEWED: "Agreement viewed",
  AGREEMENT_SIGNED: "Agreement signed",
  HANDOFF_COMPLETED: "Journey handed off",
  WINBACK_SENT: "Follow-up sent",
  WINBACK_RESPONSE: "Parent replied to follow-up",
  CHURN_REASON: "Parent shared why they paused",
  REENGAGED: "Parent re-engaged",
};

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function StageRow({ stage, isLast }: { stage: StageOut; isLast: boolean }) {
  const done = stage.state === "done";
  const current = stage.state === "current";
  const warning = stage.tone === "warning";
  return (
    <div className="flex gap-2.5" data-testid={`journey-stage-${stage.id}`}>
      <div className="flex flex-col items-center">
        <div
          className={
            warning
              ? "w-5 h-5 rounded-full flex items-center justify-center bg-[hsl(var(--brand-warning))]/15 ring-2 ring-[hsl(var(--brand-warning))] shrink-0"
              : done
              ? "w-5 h-5 rounded-full flex items-center justify-center bg-primary text-primary-foreground shrink-0"
              : current
              ? "w-5 h-5 rounded-full flex items-center justify-center bg-primary/15 ring-2 ring-primary shrink-0"
              : "w-5 h-5 rounded-full border-2 border-primary/40 bg-background shrink-0"
          }
        >
          {warning ? (
            <AlertTriangle className="w-3 h-3 text-[hsl(var(--brand-warning))]" />
          ) : (
            <>
              {done && <Check className="w-3 h-3" />}
              {current && <div className="w-2 h-2 rounded-full bg-primary" />}
            </>
          )}
        </div>
        {!isLast && <div className="w-px flex-1 min-h-[10px] bg-primary/50" />}
      </div>
      <div className={`${isLast ? "pb-0" : "pb-2.5"} min-w-0 flex-1`} style={isLast ? undefined : { minHeight: 42 }}>
        <p className={`text-xs font-ui leading-5 ${warning ? "font-semibold text-[hsl(var(--brand-warning))]" : current ? "font-semibold text-foreground" : done ? "text-foreground" : "text-muted-foreground"}`}>
          {stage.label}
          {stage.optional && stage.state === "upcoming" && <span className="text-muted-foreground font-normal"> (if needed)</span>}
        </p>
        {stage.reachedAt && <p className="text-[10px] text-muted-foreground leading-3">{fmtDate(stage.reachedAt)}</p>}
      </div>
    </div>
  );
}

/**
 * Decision-tree fork: the parent rung splits into two children - the main
 * line continues straight down (e.g. "Consultation Completed"), and the
 * branch ("No Show") sits to the RIGHT on the same row, reached by an elbow
 * connector: the spine forks mid-gap, runs right, and curves down into the
 * branch node's dot. Both children are FULL standard stage rows - identical
 * dot / label / date anatomy, states rendered exactly like any other rung.
 */
function ForkRow({ main, branch, isLast }: { main: StageOut; branch: StageOut; isLast: boolean }) {
  return (
    <div className="relative grid grid-cols-2 pt-3">
      {/* spine continuation down to the main child */}
      <div className="absolute w-px" style={{ left: "10px", top: 0, height: "12px", backgroundColor: "hsl(var(--primary) / 0.5)" }} />
      {/* elbow to the branch child: right along the top, rounded corner, down into its dot */}
      <div
        className="absolute"
        style={{
          left: "10px",
          right: "calc(50% - 11px)",
          top: 0,
          height: "22px",
          borderTop: "1px solid hsl(var(--primary) / 0.5)",
          borderRight: "1px solid hsl(var(--primary) / 0.5)",
          borderTopRightRadius: "8px",
        }}
      />
      <StageRow stage={main} isLast={isLast} />
      <StageRow stage={{ ...branch, tone: undefined }} isLast />
    </div>
  );
}

function JourneyBlock({ journey, showProviderName }: { journey: JourneyOut; showProviderName: boolean }) {
  // Pull branch-type stages (no_show) off the main line; each attaches to
  // the row that FOLLOWS it in the server order (the fork's sibling rung -
  // e.g. no_show sits between consult_scheduled and consult_completed, so
  // it renders beside consult_completed).
  const mainStages: StageOut[] = [];
  const branchBySibling = new Map<string, StageOut>();
  for (let i = 0; i < journey.stages.length; i++) {
    const st = journey.stages[i];
    if (st.id === "no_show") {
      const sibling = journey.stages[i + 1];
      if (sibling) branchBySibling.set(sibling.id, st);
      continue;
    }
    mainStages.push(st);
  }
  return (
    <div data-testid={`journey-${journey.journeyType}-${journey.providerId}`}>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-accent/15 text-[hsl(var(--accent))] text-[10px] font-semibold uppercase tracking-wide">
          {journey.typeLabel}
        </span>
        {showProviderName && <span className="text-xs font-medium font-ui truncate">{journey.providerName}</span>}
      </div>
      {journey.attention && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 mb-2 rounded-full bg-[hsl(var(--brand-warning))]/10 text-[hsl(var(--brand-warning))] text-xs font-medium w-fit" data-testid="journey-attention-chip">
          <AlertTriangle className="w-3 h-3" />
          {journey.attention.label}
        </div>
      )}
      <div>
        {mainStages.map((st, i) => {
          const branch = branchBySibling.get(st.id);
          return branch ? (
            <ForkRow key={st.id} main={st} branch={branch} isLast={i === mainStages.length - 1} />
          ) : (
            <StageRow key={st.id} stage={st} isLast={i === mainStages.length - 1} />
          );
        })}
      </div>
    </div>
  );
}

export function JourneyTimelineCard({
  parentUserId,
  providerId,
  sessionId,
  showEvents = false,
  variant = "sidebar",
  testId = "journey-timeline",
}: {
  /** Omit for the parent's own view (server resolves their account). */
  parentUserId?: string | null;
  /** Scope to one provider org (providers are force-scoped server-side). */
  providerId?: string | null;
  /**
   * Scope the money/terminal rungs to ONE chat's evidence. Chat sidebars
   * pass the open session so a profile thread that never advanced doesn't
   * inherit the org-level terminal state (e.g. "Handed Off" via a sibling
   * profile). Home/overview surfaces omit it for the full relationship view.
   */
  sessionId?: string | null;
  /** Provider/admin: collapsible recent-activity feed under the timeline. */
  showEvents?: boolean;
  variant?: "sidebar" | "home";
  testId?: string;
}) {
  const [eventsOpen, setEventsOpen] = useState(false);

  const params = new URLSearchParams();
  if (parentUserId) params.set("parentUserId", parentUserId);
  if (providerId) params.set("providerId", providerId);
  if (sessionId) params.set("sessionId", sessionId);
  const qs = params.toString();

  const timelineQuery = useQuery({
    queryKey: ["journey-timeline", parentUserId || "self", providerId || "all", sessionId || "org"],
    queryFn: async () => {
      const res = await fetch(`/api/journey/timeline${qs ? `?${qs}` : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load journey");
      return res.json() as Promise<{ registeredAt: string | null; journeys: JourneyOut[] }>;
    },
    staleTime: 30_000,
  });

  const eventsQuery = useQuery({
    queryKey: ["journey-events", parentUserId || "self", providerId || "all"],
    queryFn: async () => {
      const res = await fetch(`/api/journey/events?${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load events");
      return res.json() as Promise<{ events: { id: string; eventType: string; createdAt: string }[] }>;
    },
    enabled: showEvents && eventsOpen && !!parentUserId,
    staleTime: 30_000,
  });

  if (timelineQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-4" data-testid={`${testId}-loading`}>
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const journeys = timelineQuery.data?.journeys || [];
  if (journeys.length === 0) {
    return <p className="text-xs text-muted-foreground" data-testid={`${testId}-empty`}>No journey activity yet.</p>;
  }

  if (variant === "home") {
    return (
      <div className="grid gap-4 md:grid-cols-2" data-testid={testId}>
        {journeys.map((j) => (
          <div key={`${j.journeyType}-${j.providerId}`} className="rounded-[var(--radius)] border bg-secondary/40 p-4">
            <JourneyBlock journey={j} showProviderName />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid={testId}>
      {journeys.map((j) => (
        <JourneyBlock key={`${j.journeyType}-${j.providerId}`} journey={j} showProviderName={journeys.length > 1 || !providerId} />
      ))}
      {showEvents && parentUserId && (
        <div>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setEventsOpen((v) => !v)}
            data-testid="journey-events-toggle"
          >
            {eventsOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            Recent activity
          </button>
          {eventsOpen && (
            <div className="mt-2 space-y-1.5" data-testid="journey-events-feed">
              {eventsQuery.isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
              {(eventsQuery.data?.events || []).map((ev) => (
                <div key={ev.id} className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] text-foreground/80 font-ui">{EVENT_LABELS[ev.eventType] || ev.eventType.toLowerCase().replace(/_/g, " ")}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">{fmtDate(ev.createdAt)}</span>
                </div>
              ))}
              {eventsQuery.data && eventsQuery.data.events.length === 0 && (
                <p className="text-[11px] text-muted-foreground">No activity recorded yet.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
