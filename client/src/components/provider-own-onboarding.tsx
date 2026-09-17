/**
 * The provider's OWN onboarding - their second-person view of the same
 * derived steps the GoStork admin tracks (GET /api/provider/onboarding).
 *
 * One derivation, three surfaces:
 *  - ProviderOwnOnboarding: the guided hub on the provider Home page. A
 *    prominent "Next up" card (what, why, how long) plus the full step list,
 *    collapsed once they are underway. Replaces the onboarding rows in the
 *    work queue (see ONBOARDING_TASK_PREFIXES) so the two can never disagree.
 *  - OnboardingCoachBar (onboarding-coach-bar.tsx): the sticky guide on
 *    /account pages, sharing useProviderOnboarding().
 *  - The admin checklist on the provider edit page (separate component).
 *
 * Everything hides itself at 100%.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { hasProviderRole } from "@shared/roles";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  Circle,
  Lock,
  ChevronDown,
  ChevronUp,
  ListChecks,
  ArrowRight,
  Clock,
} from "lucide-react";

export type OwnStep = {
  key: string;
  label: string;
  link: string;
  /** Where it happens in the provider's own nav, e.g. "Settings / Company". */
  where: string;
  description: string;
  minutes: number;
  /** Review-style step the provider confirms themselves ("all good here"). */
  selfMarkable: boolean;
  /** Ordered on-page sections the coach bar tours (scroll + highlight),
   *  each matching a data-onb-anchor element on the step's page. */
  sections?: {
    anchor: string;
    label: string;
    /** Settled vs still-open sub-section (per-line steps). */
    state?: "done" | "open";
    /** Alternative action for this sub-section, e.g. mark an agreement line
     *  as not applicable. The coach bar calls it and advances. */
    skip?: { label: string; method: "PUT" | "POST"; url: string; body?: Record<string, unknown>; invalidate?: string[] };
  }[];
  status: "done" | "pending" | "optional" | "locked";
  isOptional: boolean;
};

export type OwnOnboarding = {
  steps: OwnStep[];
  nextKey: string | null;
  /** Optional pages still open - the coach bar keeps walking until zero. */
  openOptionalCount: number;
  /** Nothing left at all, required or optional. */
  allDone: boolean;
  doneCount: number;
  requiredCount: number;
  percent: number;
};

/**
 * Work-queue task systemKey prefixes that duplicate onboarding facts. While
 * onboarding is underway the Getting Started panel IS the queue for these,
 * so Home hides the materialized snapshots (they still power reminder
 * emails/digests behind the scenes). `calconn:` joined the list after a
 * brand-new provider met "Connect your calendar - Overdue" in their queue on
 * day one, directly under a hub that already lists the calendar step second.
 */
export const ONBOARDING_TASK_PREFIXES = ["onb", "w9:", "pagr:", "calconn:"];

export function isOnboardingTaskKey(systemKey: string | null | undefined): boolean {
  if (!systemKey) return false;
  return ONBOARDING_TASK_PREFIXES.some((p) => systemKey.startsWith(p));
}

/** Shared query - Home hub, coach bar, nav dot and queue filter all read this one. */
export function useProviderOnboarding(opts?: { poll?: boolean; enabled?: boolean }) {
  return useQuery<OwnOnboarding>({
    queryKey: ["/api/provider/onboarding"],
    queryFn: async () => {
      const res = await fetch("/api/provider/onboarding", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load onboarding");
      return res.json();
    },
    enabled: opts?.enabled ?? true,
    staleTime: 5_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    // The coach bar polls so "done" flips live the moment the step's real
    // artifact appears (calendar connected, sheet uploaded, ...).
    refetchInterval: opts?.poll ? 8_000 : false,
  });
}

/** What is left, in the two numbers a busy owner budgets with. */
export function onboardingRemaining(data: OwnOnboarding): { stepsLeft: number; minutesLeft: number } {
  const open = data.steps.filter((s) => !s.isOptional && s.status !== "done");
  return { stepsLeft: open.length, minutesLeft: open.reduce((sum, s) => sum + (s.minutes || 0), 0) };
}

const STATUS_WORD: Record<OwnStep["status"], string> = {
  done: "Done",
  pending: "To do",
  optional: "Optional",
  locked: "Locked for now",
};

function StatusIcon({ status }: { status: OwnStep["status"] }) {
  // "To do" is not a warning: the open circle is brand teal, not status
  // amber (which also measured about 1.8:1 on the tray).
  if (status === "done") return <CheckCircle2 className="w-4 h-4 text-[hsl(var(--brand-success-text))] shrink-0" aria-hidden="true" />;
  if (status === "locked") return <Lock className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />;
  if (status === "pending") return <Circle className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />;
  return <Circle className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />;
}

function StepRow({ step, isNext, onOpen }: { step: OwnStep; isNext: boolean; onOpen: () => void }) {
  // "Settings / Company" -> "Company": the group already says it is setup.
  const tab = step.where.replace(/^Settings\s*\/\s*/i, "");
  return (
    <li>
      <button
        type="button"
        disabled={step.status === "locked"}
        onClick={onOpen}
        className="w-full min-h-11 md:min-h-9 flex items-center gap-2.5 px-2.5 py-1.5 rounded-[var(--radius)] text-left hover:bg-[hsl(var(--primary)/0.06)] transition-colors disabled:opacity-60 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid={`provider-own-step-${step.key}`}
      >
        <StatusIcon status={step.status} />
        <span className="flex-1 min-w-0">
          <span className={`block text-sm leading-5 line-clamp-2 ${step.status === "done" ? "text-muted-foreground line-through decoration-[hsl(var(--brand-success)/0.5)]" : ""}`}>
            {step.label}
          </span>
          {/* Status in words: done / to do was carried by icon and
              strikethrough only. */}
          <span className="sr-only">. {STATUS_WORD[step.status]}. </span>
          <span className="t-helper block md:hidden">{tab}{step.status !== "done" ? ` - about ${step.minutes} min` : ""}</span>
        </span>
        {isNext && (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full shrink-0 bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]">Next</span>
        )}
        <span className="t-helper hidden md:block shrink-0 w-32 text-right truncate">{tab}</span>
        {step.status !== "done" && (
          <span className="t-helper hidden md:flex items-center gap-1 shrink-0 w-20 justify-end whitespace-nowrap">
            <Clock className="w-3 h-3" aria-hidden="true" /> {step.minutes} min
          </span>
        )}
        {step.status === "done" && <span className="hidden md:block shrink-0 w-20" aria-hidden="true" />}
      </button>
    </li>
  );
}

export function ProviderOwnOnboarding() {
  const navigate = useNavigate();
  const [listToggled, setListToggled] = useState<boolean | null>(null);

  const { data } = useProviderOnboarding();

  if (!data) return null;
  // Retire only when the optional pages are walked too - required-complete
  // still has "worth a look" work to point at.
  if (data.allDone) return null;

  const next = data.steps.find((s) => s.key === data.nextKey) || null;
  // Full list open until they are properly underway, then folded behind the
  // "Next up" card - one obvious action, details on demand.
  const listOpen = listToggled ?? data.percent < 25;
  const { stepsLeft, minutesLeft } = onboardingRemaining(data);
  const required = data.steps.filter((s) => !s.isOptional);
  const later = data.steps.filter((s) => s.isOptional);
  const laterOpen = later.filter((s) => s.status !== "done").length;
  // The outcome, and what it costs: "how much work is this?" was never
  // answered anywhere on the path.
  const headline = data.percent >= 100
    ? `You're live - ${data.openOptionalCount} optional page${data.openOptionalCount === 1 ? "" : "s"} worth a look`
    : `${stepsLeft} step${stepsLeft === 1 ? "" : "s"} until parents can find you - about ${minutesLeft} min`;

  return (
    <Card className="p-4 md:p-5 border-[hsl(var(--primary)/0.25)] bg-[hsl(var(--primary)/0.03)]" data-testid="provider-own-onboarding" role="region" aria-labelledby="provider-onboarding-title">
      <div className="flex items-center gap-3">
        <span className="w-9 h-9 rounded-full bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))] flex items-center justify-center shrink-0" aria-hidden="true">
          <ListChecks className="w-5 h-5" />
        </span>
        <span className="flex-1 min-w-0">
          <h2 id="provider-onboarding-title" className="t-section-title font-heading leading-snug">{headline}</h2>
          <span className="t-helper block">{data.doneCount} of {data.requiredCount} required steps done</span>
          <span
            className="mt-1.5 block h-1.5 rounded-full bg-[hsl(var(--primary)/0.12)] overflow-hidden"
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin={0}
            aria-valuemax={data.requiredCount}
            aria-valuenow={data.doneCount}
            aria-valuetext={`${data.doneCount} of ${data.requiredCount} required steps done`}
          >
            <span
              className="block h-full rounded-full bg-[hsl(var(--primary))] transition-all"
              style={{ width: `${data.percent}%` }}
            />
          </span>
        </span>
      </div>

      {next && (
        <div
          className="mt-3 rounded-[var(--radius)] bg-background border border-[hsl(var(--primary)/0.2)] p-3.5 md:p-4"
          data-testid="provider-own-onboarding-next"
        >
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[hsl(var(--primary))]">
            Next up
            <span className="flex items-center gap-1 normal-case tracking-normal text-muted-foreground font-normal">
              <Clock className="w-3 h-3" aria-hidden="true" /> about {next.minutes} min
            </span>
          </div>
          <div className="mt-1 text-base font-medium">{next.label}</div>
          <div className="t-helper">{next.where}</div>
          <div className="mt-0.5 text-sm text-muted-foreground">{next.description}</div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button className="min-h-11 md:min-h-9" onClick={() => navigate(next.link)} data-testid="provider-own-onboarding-next-cta">
              Do it now
              <ArrowRight className="w-3.5 h-3.5 ml-1.5" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              className="min-h-11 md:min-h-9 text-muted-foreground"
              onClick={() => setListToggled(!listOpen)}
              aria-expanded={listOpen}
              aria-controls="provider-onboarding-steps"
              data-testid="provider-own-onboarding-toggle"
            >
              {listOpen ? "Hide all steps" : "See all steps"}
              {listOpen ? <ChevronUp className="w-3.5 h-3.5 ml-1" aria-hidden="true" /> : <ChevronDown className="w-3.5 h-3.5 ml-1" aria-hidden="true" />}
            </Button>
          </div>
        </div>
      )}

      {listOpen && (
        <div id="provider-onboarding-steps" className="mt-4 space-y-4">
          {/* Two groups, by what the provider is trying to achieve - not one
              heading per Settings tab (measured: 16 headings for 19 rows,
              2.1 phone screens, no time anywhere). The tab rides each row as
              a small trailing label. */}
          <div>
            <div className="flex items-baseline justify-between gap-3 px-2.5 mb-1">
              <h3 className="text-sm font-semibold">Required to go live</h3>
              <span className="t-helper">
                {stepsLeft === 0 ? "All done" : `${stepsLeft} left - about ${minutesLeft} min`}
              </span>
            </div>
            <ul className="space-y-0.5" aria-label="Required to go live">
              {required.map((step) => (
                <StepRow key={step.key} step={step} isNext={step.key === data.nextKey} onOpen={() => navigate(step.link)} />
              ))}
            </ul>
          </div>
          {later.length > 0 && (
            <div>
              <div className="flex items-baseline justify-between gap-3 px-2.5 mb-1">
                <h3 className="text-sm font-semibold">Worth a look later</h3>
                <span className="t-helper">{laterOpen === 0 ? "All reviewed" : `${laterOpen} optional`}</span>
              </div>
              <ul className="space-y-0.5" aria-label="Worth a look later">
                {later.map((step) => (
                  <StepRow key={step.key} step={step} isNext={step.key === data.nextKey} onOpen={() => navigate(step.link)} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * One slim line for surfaces that are not about setup (the Chats sidebar):
 * a provider could work in chat for days without learning that required
 * steps still stand between them and "parents can find you". Renders nothing
 * for parents, admins, or once the required steps are done.
 */
export function ProviderSetupStrip() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const roles: string[] = (user as any)?.roles || [];
  const isProviderUser = hasProviderRole(roles) && !roles.includes("GOSTORK_ADMIN");
  const { data } = useProviderOnboarding({ enabled: isProviderUser });
  if (!isProviderUser || !data || data.percent >= 100) return null;
  const next = data.steps.find((s) => s.key === data.nextKey) || null;
  const { stepsLeft, minutesLeft } = onboardingRemaining(data);
  if (!next || stepsLeft === 0) return null;
  return (
    <button
      type="button"
      onClick={() => navigate("/provider/home")}
      className="w-full flex items-center gap-2.5 min-h-11 px-3 py-2 rounded-[var(--radius)] border border-[hsl(var(--primary)/0.2)] bg-[hsl(var(--primary)/0.04)] text-left hover:bg-[hsl(var(--primary)/0.08)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="provider-setup-strip"
    >
      <ListChecks className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium leading-5 line-clamp-2">{stepsLeft} step{stepsLeft === 1 ? "" : "s"} until parents can find you</span>
        <span className="t-helper block truncate">About {minutesLeft} min - next: {next.label}</span>
      </span>
      <ArrowRight className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
    </button>
  );
}
