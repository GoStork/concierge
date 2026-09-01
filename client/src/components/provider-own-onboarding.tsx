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
  /** Where it happens in the provider's own nav, e.g. "Settings -> Company". */
  where: string;
  description: string;
  minutes: number;
  /** Review-style step the provider confirms themselves ("all good here"). */
  selfMarkable: boolean;
  status: "done" | "pending" | "optional" | "locked";
  isOptional: boolean;
};

export type OwnOnboarding = {
  steps: OwnStep[];
  nextKey: string | null;
  doneCount: number;
  requiredCount: number;
  percent: number;
};

/**
 * Work-queue task systemKey prefixes that duplicate onboarding facts. While
 * onboarding is underway the Getting Started panel IS the queue for these,
 * so Home hides the materialized snapshots (they still power reminder
 * emails/digests behind the scenes).
 */
export const ONBOARDING_TASK_PREFIXES = ["onb", "w9:", "pagr:"];

export function isOnboardingTaskKey(systemKey: string | null | undefined): boolean {
  if (!systemKey) return false;
  return ONBOARDING_TASK_PREFIXES.some((p) => systemKey.startsWith(p));
}

/** Shared query - Home hub, coach bar, and queue filter all read this one. */
export function useProviderOnboarding(opts?: { poll?: boolean }) {
  return useQuery<OwnOnboarding>({
    queryKey: ["/api/provider/onboarding"],
    queryFn: async () => {
      const res = await fetch("/api/provider/onboarding", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load onboarding");
      return res.json();
    },
    staleTime: 5_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    // The coach bar polls so "done" flips live the moment the step's real
    // artifact appears (calendar connected, sheet uploaded, ...).
    refetchInterval: opts?.poll ? 8_000 : false,
  });
}

function StatusIcon({ status }: { status: OwnStep["status"] }) {
  if (status === "done") return <CheckCircle2 className="w-4 h-4 text-[hsl(var(--brand-success))] shrink-0" />;
  if (status === "locked") return <Lock className="w-4 h-4 text-muted-foreground/50 shrink-0" />;
  if (status === "pending") return <Circle className="w-4 h-4 text-[hsl(var(--brand-warning))] shrink-0" />;
  return <Circle className="w-4 h-4 text-muted-foreground/50 shrink-0" />;
}

export function ProviderOwnOnboarding() {
  const navigate = useNavigate();
  const [listToggled, setListToggled] = useState<boolean | null>(null);

  const { data } = useProviderOnboarding();

  if (!data) return null;
  if (data.percent >= 100) return null;

  const next = data.steps.find((s) => s.key === data.nextKey) || null;
  // Full list open until they are properly underway, then folded behind the
  // "Next up" card - one obvious action, details on demand.
  const listOpen = listToggled ?? data.percent < 25;

  return (
    <Card className="p-4 border-[hsl(var(--primary)/0.25)] bg-[hsl(var(--primary)/0.03)]" data-testid="provider-own-onboarding">
      <div className="flex items-center gap-3">
        <span className="w-9 h-9 rounded-full bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))] flex items-center justify-center shrink-0">
          <ListChecks className="w-5 h-5" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium">
            Getting started - {data.doneCount}/{data.requiredCount} steps done
          </span>
          <span className="mt-1 block h-1.5 rounded-full bg-[hsl(var(--primary)/0.12)] overflow-hidden">
            <span
              className="block h-full rounded-full bg-[hsl(var(--primary))] transition-all"
              style={{ width: `${data.percent}%` }}
            />
          </span>
        </span>
      </div>

      {next && (
        <div
          className="mt-3 rounded-[var(--radius)] bg-background border border-[hsl(var(--primary)/0.2)] p-3.5"
          data-testid="provider-own-onboarding-next"
        >
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--primary))]">
            Next up
            <span className="flex items-center gap-1 normal-case tracking-normal text-muted-foreground font-normal">
              <Clock className="w-3 h-3" /> ~{next.minutes} min
            </span>
          </div>
          <div className="mt-1 text-sm font-medium">{next.label}</div>
          <div className="text-xs text-muted-foreground">{next.where}</div>
          <div className="mt-0.5 text-sm text-muted-foreground">{next.description}</div>
          <div className="mt-2.5 flex items-center gap-2">
            <Button size="sm" onClick={() => navigate(next.link)} data-testid="provider-own-onboarding-next-cta">
              Do it now
              <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => setListToggled(!listOpen)}
              data-testid="provider-own-onboarding-toggle"
            >
              {listOpen ? "Hide all steps" : "See all steps"}
              {listOpen ? <ChevronUp className="w-3.5 h-3.5 ml-1" /> : <ChevronDown className="w-3.5 h-3.5 ml-1" />}
            </Button>
          </div>
        </div>
      )}

      {listOpen && (
        <div className="mt-3 space-y-3">
          {/* Steps arrive grouped by Settings tab (server orders them - the
              group holding the next task is first). Render one titled
              section per tab, Stripe-setup-guide style. */}
          {data.steps
            .reduce<{ where: string; steps: OwnStep[] }[]>((groups, step) => {
              const last = groups[groups.length - 1];
              if (last && last.where === step.where) last.steps.push(step);
              else groups.push({ where: step.where, steps: [step] });
              return groups;
            }, [])
            .map((group) => (
              <div key={group.where}>
                <div className="t-helper font-medium uppercase tracking-wide mb-1 px-2.5">{group.where}</div>
                <div className="space-y-0.5">
                  {group.steps.map((step) => (
                    <button
                      key={step.key}
                      type="button"
                      disabled={step.status === "locked"}
                      onClick={() => navigate(step.link)}
                      className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-[var(--radius)] text-left hover:bg-[hsl(var(--primary)/0.06)] transition-colors disabled:opacity-60 disabled:hover:bg-transparent"
                      data-testid={`provider-own-step-${step.key}`}
                    >
                      <StatusIcon status={step.status} />
                      <span className={`flex-1 min-w-0 text-sm truncate ${step.status === "done" ? "text-muted-foreground line-through decoration-[hsl(var(--brand-success)/0.5)]" : ""}`}>
                        {step.label}
                      </span>
                      {step.key === data.nextKey && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]">Next</span>
                      )}
                      {step.isOptional && step.status !== "done" && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 bg-secondary text-secondary-foreground">Optional</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}
