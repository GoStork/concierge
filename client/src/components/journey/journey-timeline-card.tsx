import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, AlertTriangle, Loader2, X } from "lucide-react";
import { ServiceTag } from "@/components/ui/service-tag";

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
  tone?: "warning" | "destructive";
  /** Server-declared fork off the main line - see journey-timeline.ts. */
  branch?: boolean;
}

interface JourneyOut {
  journeyType: string;
  /** Service-line filter key (surrogacy / egg_donation / sperm_donation / ivf / legal). */
  serviceLine?: string | null;
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
  // CRM activity. These were emitted from the start but never labelled, so the
  // timeline fell back to rendering the raw key as "crm_owner_assigned".
  CRM_NOTE_ADDED: "Internal note added",
  CRM_NOTE_SHARED_WITH_PROVIDER: "Note shared with provider",
  CRM_FOLLOWUP_SET: "Next step set",
  CRM_FOLLOWUP_COMPLETED: "Next step completed",
  CRM_OWNER_ASSIGNED: "Lead owner assigned",
  CRM_TAG_ADDED: "Tag added",
};

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function StageRow({ stage, isLast, stripMarkTone }: { stage: StageOut; isLast: boolean; stripMarkTone?: boolean }) {
  return (
    <div className="flex gap-2.5" data-testid={`journey-stage-${stage.id}`}>
      <div className="flex flex-col items-center">
        {/* A branch dot draws as a standard stage dot - the fork already says
            something went sideways - but the LABEL keeps its warning tone.
            The old code stripped tone from the whole stage, which silenced
            the label too: the parent's No Show read as plain grey while the
            provider's horizontal ladder showed it amber. */}
        <StageMark stage={stripMarkTone && stage.tone !== "destructive" ? { ...stage, tone: undefined } : stage} />
        {!isLast && <div className="w-px flex-1 min-h-[10px] bg-primary/50" />}
      </div>
      <div className={`${isLast ? "pb-0" : "pb-2.5"} min-w-0 flex-1`} style={isLast ? undefined : { minHeight: 42 }}>
        <p className={`text-xs font-ui leading-5 ${stageLabelClass(stage)}`}>
          {stage.label}
          {stage.optional && stage.state === "upcoming" && <span className="text-muted-foreground font-normal"> (if needed)</span>}
        </p>
        {stage.reachedAt && <p className="t-helper leading-3">{fmtDate(stage.reachedAt)}</p>}
      </div>
    </div>
  );
}

/** Dot styling, shared by both orientations so the two can never drift. */
function stageDotClass(stage: StageOut): string {
  const base = "w-5 h-5 rounded-full flex items-center justify-center shrink-0";
  if (stage.tone === "warning") return `${base} bg-[hsl(var(--brand-warning))]/15 ring-2 ring-[hsl(var(--brand-warning))]`;
  if (stage.tone === "destructive") return `${base} bg-[hsl(var(--destructive))]/15 ring-2 ring-[hsl(var(--destructive))]`;
  if (stage.state === "done") return `${base} bg-primary text-primary-foreground`;
  if (stage.state === "current") return `${base} bg-primary/15 ring-2 ring-primary`;
  return "w-5 h-5 rounded-full border-2 border-primary/40 bg-background shrink-0";
}

function StageMark({ stage }: { stage: StageOut }) {
  return (
    <div className={stageDotClass(stage)}>
      {stage.tone === "warning" ? (
        <AlertTriangle className="w-3 h-3 text-[hsl(var(--brand-warning))]" />
      ) : stage.tone === "destructive" ? (
        <X className="w-3 h-3 text-[hsl(var(--destructive))]" />
      ) : (
        <>
          {stage.state === "done" && <Check className="w-3 h-3" />}
          {stage.state === "current" && <div className="w-2 h-2 rounded-full bg-primary" />}
        </>
      )}
    </div>
  );
}

function stageLabelClass(stage: StageOut): string {
  if (stage.tone === "warning") return "font-semibold text-[hsl(var(--brand-warning))]";
  if (stage.tone === "destructive") return "font-semibold text-[hsl(var(--destructive))]";
  if (stage.state === "current") return "font-semibold text-foreground";
  if (stage.state === "done") return "text-foreground";
  return "text-muted-foreground";
}

/**
 * One rung of the horizontal ladder: dot on a rail, label and date beneath.
 *
 * Rungs SHARE the row rather than holding a fixed width, so the whole ladder
 * is always exactly one row however many stages a journey has. It got a fixed
 * width first, which meant twelve rungs needed ~1250px and wrapped onto four
 * rows inside a column - a ladder you have to read in a boustrophedon is not
 * a ladder. The caller's job is to give this enough room; below `lg` the
 * record page switches to the vertical ladder instead of squeezing.
 */
function StageColumn({ stage, isFirst, isLast, branch, widthPct }: {
  stage: StageOut;
  isFirst: boolean;
  isLast: boolean;
  branch?: StageOut;
  /**
   * Fixed share of the strip, computed from the LONGEST ladder on the page
   * so the same rung index lands on the same vertical line on every ladder
   * (by request). Shorter ladders simply end early instead of stretching.
   */
  widthPct?: number;
}) {
  // The connector is drawn as two half-width rails either side of the dot, so
  // every segment meets its neighbour exactly at the column boundary - no
  // absolute positioning, and it survives any column width.
  const rail = "h-px flex-1 bg-primary/50";
  const line = "hsl(var(--primary) / 0.5)";
  // The dot is w-5 (20px), so its centre - and therefore the connector line -
  // sits 10px below the top of the rail row.
  const DOT = 20;
  const HALF_DOT = DOT / 2;
  // Breathing room between the sibling's label and the branch dot, so the two
  // do not touch. 12px is what the vertical fork already uses (ForkRow's
  // pt-3), which also makes the elbow's vertical run 22px on both - the same
  // fork drawn the same way, rotated.
  const BRANCH_GAP = 12;
  return (
    // Fixed width (see widthPct) so rung indexes align across ladders;
    // min-w-0 lets a long label wrap under its dot instead of widening it.
    <div
      className={widthPct ? "shrink-0 min-w-0" : "flex-1 basis-0 min-w-0"}
      style={widthPct ? { width: `${widthPct}%` } : undefined}
      data-testid={`journey-stage-${stage.id}`}
    >
      {/* relative only when there is a branch: the stem is absolute inside
          this box so it can start on the connector line and run past the
          label, whose height varies with wrapping. */}
      <div className={branch ? "relative" : undefined}>
        {/* First and last rungs ANCHOR to the strip's edges instead of
            centering in their columns (by request): ladders have different
            stage counts, so a centered first dot landed at a different x on
            every ladder - anchored, every "Registered" starts on the same
            vertical line. */}
        <div className="flex items-center">
          {!isFirst && <div className={rail} />}
          <StageMark stage={stage} />
          {/* The last rung keeps an INVISIBLE spacer where its rail would
              be, so its dot stays at the same index position as every other
              ladder's rung of that index - a missing rail would let the dot
              slide to the column's right edge. */}
          {!isLast ? <div className={rail} /> : !isFirst && <div className="h-px flex-1" />}
        </div>
        {/* Only the FIRST rung anchors (left) - a right-anchored last rung
            would break index alignment for ladders that end early. */}
        <div className={`pt-1.5 ${isFirst ? "pr-1 text-left" : "px-1 text-center"}`}>
          <p className={`text-[11px] font-ui leading-tight ${stageLabelClass(stage)}`}>
            {stage.label}
            {stage.optional && stage.state === "upcoming" && <span className="text-muted-foreground font-normal"> (if needed)</span>}
          </p>
          {stage.reachedAt && <p className="t-helper leading-4">{fmtDate(stage.reachedAt)}</p>}
        </div>
        {/* The fork leaves the track BETWEEN two rungs, not out of a dot.
            left:0 is this column's left edge, and because each connector is
            drawn as two half-width rails either side of its dot, that edge is
            exactly the midpoint between this dot and the previous one - the
            same place the vertical ladder's elbow forks from. It used to drop
            straight down from the sibling's own dot, which read as "the No
            Show happened AT Doctor Call Completed" rather than between the
            two. */}
        {branch && (
          <span
            className="absolute w-px"
            style={{ left: 0, top: `${HALF_DOT}px`, bottom: 0, backgroundColor: line }}
          />
        )}
      </div>
      {/* A branch rung hangs BELOW the main line, reached by the corner that
          finishes the fork: down the column edge, then right into its dot.
          The vertical ladder puts it to the RIGHT of its sibling, which is
          the same relationship rotated with the rest of the track. */}
      {branch && (
        <>
          <div className="flex">
            {/* calc(50% - HALF_DOT) so the dot that follows lands centred on
                the column, directly under its sibling. */}
            <div
              className="shrink-0"
              style={{
                width: `calc(50% - ${HALF_DOT}px)`,
                // The corner drops through the gap first, then turns - so the
                // horizontal run still lands exactly on the dot's centre.
                height: `${BRANCH_GAP + HALF_DOT}px`,
                borderLeft: `1px solid ${line}`,
                borderBottom: `1px solid ${line}`,
                borderBottomLeftRadius: "8px",
              }}
            />
            <div style={{ marginTop: `${BRANCH_GAP}px` }}>
              {/* A warning branch keeps a standard dot - the fork says enough.
              A destructive one keeps its red X: a cancelled call whose dot
              draws a green positional checkmark reads as "done", which is
              the one thing a cancellation is not. */}
          <StageMark stage={branch.tone === "destructive" ? branch : { ...branch, tone: undefined }} />
            </div>
          </div>
          <div className="px-1 pt-1 text-center">
            <p className={`text-[11px] font-ui leading-tight ${stageLabelClass(branch)}`}>{branch.label}</p>
            {branch.reachedAt && <p className="t-helper leading-4">{fmtDate(branch.reachedAt)}</p>}
          </div>
        </>
      )}
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
      <StageRow stage={branch} isLast stripMarkTone />
    </div>
  );
}

// The server now DECLARES a fork with `branch: true`, so this list is only a
// fallback for a payload built before that field existed (a deploy where the
// client lands first). It used to be the source of truth, with a comment
// telling whoever edited journey-timeline.ts to remember to update it here -
// and the first person to add a rung there did not, so a Doctor Call no-show
// rendered inline, as a step in the middle of the ladder, instead of hanging
// off it. Do not add new ids here; set `branch: true` on the server.
const LEGACY_BRANCH_STAGE_IDS = new Set(["no_show", "match_call_no_show", "not_matched"]);
const isBranchStage = (st: StageOut) => st.branch === true || LEGACY_BRANCH_STAGE_IDS.has(st.id);

function JourneyBlock({ journey, showProviderName, horizontal, cols }: {
  journey: JourneyOut;
  showProviderName: boolean;
  horizontal?: boolean;
  /** Column count of the LONGEST ladder on the page - see StageColumn.widthPct. */
  cols?: number;
}) {
  // Pull branch-type stages off the main line; each attaches to the row that
  // FOLLOWS it in the server order (the fork's sibling rung - e.g. no_show
  // sits between consult_scheduled and consult_completed, so it renders
  // beside consult_completed; not_matched renders beside matched).
  const mainStages: StageOut[] = [];
  const branchBySibling = new Map<string, StageOut>();
  for (let i = 0; i < journey.stages.length; i++) {
    const st = journey.stages[i];
    if (isBranchStage(st)) {
      const sibling = journey.stages[i + 1];
      if (sibling) branchBySibling.set(sibling.id, st);
      continue;
    }
    mainStages.push(st);
  }
  const headerBits = (
    <>
      {showProviderName && (
        <p className="text-xs font-medium font-ui truncate min-w-0" title={journey.providerName}>
          {journey.providerName}
        </p>
      )}
      <ServiceTag service={journey.typeLabel} label={journey.typeLabel} className="shrink-0" />
    </>
  );
  return (
    <div data-testid={`journey-${journey.journeyType}-${journey.providerId}`}>
      {/* Vertical rails keep the header ABOVE the ladder (they are narrow).
          The horizontal ladder inlines it on the rung row instead - see
          below - which takes a full line of height off every ladder. */}
      {!horizontal && (
        <div className="mb-2 min-w-0 flex items-center gap-2 flex-wrap">
          {headerBits}
        </div>
      )}
      {/* No attention chip on the horizontal ladder at all - with four of
          them stacked on the record it was one label too many, and the red
          Canceled / amber No Show branches already say what went sideways.
          The compact vertical rails keep it: they show a single journey, and
          the chip doubles as the "needs chasing" cue the parent home builds
          its to-do from. */}
      {journey.attention && !horizontal && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 mb-2 rounded-full bg-[hsl(var(--brand-warning))]/10 text-[hsl(var(--brand-warning))] text-xs font-medium w-fit" data-testid="journey-attention-chip">
          <AlertTriangle className="w-3 h-3" />
          {journey.attention.label}
        </div>
      )}
      {horizontal ? (
        // One row, always. items-start so a rung with a branch hanging under
        // it does not stretch its neighbours to match. The label block sits
        // IN FRONT of the rungs (by request): admin stacks provider name over
        // the service tag, provider staff see only the tag - and the stack
        // is shorter than the ladder, so each journey is exactly one row.
        <div className="pb-1 flex items-start gap-4">
          {/* FIXED width when the name shows (admin): every ladder's rungs
              start on the same vertical line no matter how long the org
              name is, the name ellipsizes, and the title attribute serves
              the full name on hover. Provider staff see only the tag, which
              needs no reserved width. */}
          {/* FIXED width in BOTH modes - a natural-width column made each
              ladder's rungs start wherever its tag ended ("EGG DONATION" is
              wider than "SURROGACY"). */}
          <div className={`shrink-0 flex flex-col items-start gap-1 pt-1 ${showProviderName ? "w-[180px]" : "w-[130px]"}`}>
            {showProviderName && (
              <p className="text-xs font-medium font-ui truncate w-full" title={journey.providerName}>
                {journey.providerName}
              </p>
            )}
            <ServiceTag service={journey.typeLabel} label={journey.typeLabel} className="shrink-0" />
          </div>
          <div className="flex items-start flex-1 min-w-0">
            {mainStages.map((st, i) => (
              <StageColumn
                key={st.id}
                stage={st}
                isFirst={i === 0}
                isLast={i === mainStages.length - 1}
                branch={branchBySibling.get(st.id)}
                widthPct={cols ? 100 / cols : undefined}
              />
            ))}
          </div>
        </div>
      ) : (
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
      )}
    </div>
  );
}

export function JourneyTimelineCard({
  parentUserId,
  providerId,
  sessionId,
  showEvents = false,
  variant = "sidebar",
  orientation = "vertical",
  serviceLine = null,
  live = false,
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
  /**
   * "horizontal" lays the ladder left-to-right with the labels beneath each
   * rung. Use it where the surface is wide and short - the record page's
   * activity column - rather than the tall narrow rails the vertical ladder
   * was drawn for. The track scrolls sideways; it never compresses.
   */
  orientation?: "vertical" | "horizontal";
  /**
   * Show only journeys of this SERVICE LINE (the record page's scope chips:
   * surrogacy / egg_donation / sperm_donation / ivf / legal). null = all.
   * Display filter only - the fetch is unchanged, so flipping it is instant.
   */
  serviceLine?: string | null;
  /**
   * Poll while mounted (15s, paused in background tabs) so the ladder moves
   * without a manual refresh. The record page passes it - a CRM screen staff
   * keep open while things happen elsewhere. Rails and home mounts stay
   * non-live; they remount on navigation anyway.
   */
  live?: boolean;
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
    staleTime: live ? 10_000 : 30_000,
    refetchInterval: live ? 15_000 : false,
    refetchOnWindowFocus: live,
  });

  const eventsQuery = useQuery({
    queryKey: ["journey-events", parentUserId || "self", providerId || "all"],
    queryFn: async () => {
      const res = await fetch(`/api/journey/events?${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load events");
      return res.json() as Promise<{ events: { id: string; eventType: string; createdAt: string }[] }>;
    },
    enabled: showEvents && eventsOpen && !!parentUserId,
    staleTime: live ? 10_000 : 30_000,
    refetchInterval: live ? 15_000 : false,
    refetchOnWindowFocus: live,
  });

  if (timelineQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-4" data-testid={`${testId}-loading`}>
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const allJourneys = timelineQuery.data?.journeys || [];
  const journeys = serviceLine
    ? allJourneys.filter((j) => (j.serviceLine ?? j.journeyType) === serviceLine)
    : allJourneys;
  if (journeys.length === 0) {
    return <p className="t-helper" data-testid={`${testId}-empty`}>No journey activity yet.</p>;
  }

  if (variant === "home") {
    // Every journey the parent is running sits side by side on one row (up to
    // 5 across on a wide screen), instead of stacking two-up and pushing the
    // rest of the dashboard down. Classes are spelled out because Tailwind
    // can't see interpolated column counts.
    const colClass =
      journeys.length >= 5
        ? "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
        : journeys.length === 4
        ? "sm:grid-cols-2 lg:grid-cols-4"
        : journeys.length === 3
        ? "sm:grid-cols-2 lg:grid-cols-3"
        : "sm:grid-cols-2";
    return (
      <div className={`grid gap-4 ${colClass}`} data-testid={testId}>
        {/* min-w-0 on each cell: grid items default to min-width:auto, so
            without it a non-wrapping provider name widens its column past the
            viewport (that's what broke the mobile layout). */}
        {journeys.map((j) => (
          <div key={`${j.journeyType}-${j.providerId}`} className="min-w-0 rounded-[var(--radius)] border bg-secondary/40 p-4">
            <JourneyBlock journey={j} showProviderName />
          </div>
        ))}
      </div>
    );
  }

  return (
    // Horizontal ladders pack tighter - the inline label made each journey a
    // single row, so the old 16px gaps read as holes.
    <div className={orientation === "horizontal" ? "space-y-2" : "space-y-4"} data-testid={testId}>
      {journeys.map((j) => (
        <JourneyBlock
          key={`${j.journeyType}-${j.providerId}`}
          journey={j}
          // A provider is ALWAYS looking at their own org - the name told
          // them nothing (the service tag disambiguates multi-service
          // families). Admins span providers, so they keep it.
          showProviderName={!providerId}
          horizontal={orientation === "horizontal"}
          // Same column width on every ladder (from the longest one), so
          // rung N sits on the same vertical line page-wide; shorter
          // ladders end early rather than stretching.
          cols={orientation === "horizontal"
            ? Math.max(...journeys.map((jj) => jj.stages.filter((st) => !isBranchStage(st)).length))
            : undefined}
        />
      ))}
      {showEvents && parentUserId && (
        <div>
          <button
            type="button"
            className="t-helper inline-flex items-center gap-1 hover:text-foreground"
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
                  <span className="t-helper shrink-0">{fmtDate(ev.createdAt)}</span>
                </div>
              ))}
              {eventsQuery.data && eventsQuery.data.events.length === 0 && (
                <p className="t-helper">No activity recorded yet.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
