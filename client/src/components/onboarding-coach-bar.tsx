/**
 * The sticky onboarding "coach" on /account pages while a provider is still
 * getting set up. Three faces, one derivation (useProviderOnboarding):
 *
 *  - Coach: the current page IS an open onboarding step - show what to do
 *    here and why. Polls, so the moment the real artifact appears (calendar
 *    connected, sheet uploaded) the bar flips green by itself.
 *  - Celebrate: a step just completed under the visitor's feet - green tick
 *    plus a one-click jump to the recommended next step.
 *  - Mirror: any other /account page - slim progress line with a "Continue
 *    setup" jump, so the thread is never lost between pages.
 *
 * Disappears entirely at 100%. No modals - a slim inline bar, per app rules.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { CheckCircle2, ListChecks, ArrowRight, Clock, Check } from "lucide-react";
import { useProviderOnboarding, type OwnStep } from "@/components/provider-own-onboarding";

export function OnboardingCoachBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useProviderOnboarding({ poll: true });

  // Review-style steps have no artifact to detect - the provider's own
  // confirmation IS the completion. Closes the underlying onb* task, which
  // flips the admin checklist too.
  const markDone = useMutation({
    mutationFn: async (key: string) => {
      const res = await fetch(`/api/provider/onboarding/steps/${key}/done`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to mark step done");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/provider/onboarding"] }),
  });

  // Which step key completed while THIS visitor was on its page - drives the
  // celebrate face. Tracked as a transition (pending -> done seen live), so a
  // long-done step renders the mirror, not an eternal green banner.
  const [celebrateKey, setCelebrateKey] = useState<string | null>(null);
  const prevStatuses = useRef<Map<string, OwnStep["status"]>>(new Map());

  useEffect(() => {
    if (!data) return;
    for (const s of data.steps) {
      const prev = prevStatuses.current.get(s.key);
      if (prev && prev !== "done" && s.status === "done" && s.link === location.pathname) {
        setCelebrateKey(s.key);
      }
      prevStatuses.current.set(s.key, s.status);
    }
  }, [data, location.pathname]);

  // Leaving the page retires the celebration.
  useEffect(() => {
    setCelebrateKey(null);
  }, [location.pathname]);

  if (!data || data.percent >= 100) return null;

  const next = data.steps.find((s) => s.key === data.nextKey) || null;
  const onPage = data.steps.filter((s) => s.link === location.pathname);
  // Several steps can share a page (/account/documents holds both the
  // GoStork agreement and parent templates) - coach the first open one.
  const current = onPage.find((s) => s.status === "pending") || onPage.find((s) => s.status === "optional") || null;
  const celebrated = celebrateKey ? data.steps.find((s) => s.key === celebrateKey) : null;

  // ── Celebrate: it just flipped to done right here ──
  if (celebrated && !current) {
    return (
      <div
        className="sticky top-0 z-20 -mx-1 mb-4 px-3.5 py-2.5 rounded-[var(--radius)] border border-[hsl(var(--brand-success)/0.35)] bg-[hsl(var(--brand-success)/0.08)] flex items-center gap-3"
        data-testid="onboarding-coach-done"
      >
        <CheckCircle2 className="w-5 h-5 text-[hsl(var(--brand-success))] shrink-0" />
        <div className="flex-1 min-w-0 text-sm">
          <span className="font-medium">{celebrated.label} - done!</span>
          {next && <span className="text-muted-foreground"> {data.doneCount}/{data.requiredCount} steps complete.</span>}
        </div>
        {next && (
          <Button size="sm" onClick={() => navigate(next.link)} data-testid="onboarding-coach-next">
            Next: {next.label}
            <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
          </Button>
        )}
      </div>
    );
  }

  // ── Coach: this page is an open step ──
  if (current) {
    return (
      <div
        className="sticky top-0 z-20 -mx-1 mb-4 px-3.5 py-2.5 rounded-[var(--radius)] border border-[hsl(var(--primary)/0.25)] bg-[hsl(var(--primary)/0.05)] flex items-center gap-3"
        data-testid="onboarding-coach-bar"
      >
        <span className="w-8 h-8 rounded-full bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))] flex items-center justify-center shrink-0">
          <ListChecks className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
            {current.label}
            <span className="text-[11px] font-normal text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" /> ~{current.minutes} min · {data.doneCount}/{data.requiredCount} done
            </span>
          </div>
          <div className="text-sm text-muted-foreground truncate">{current.description}</div>
        </div>
        {current.selfMarkable && (
          <Button
            className="shrink-0 bg-[hsl(var(--brand-success))] hover:bg-[hsl(var(--brand-success))]/90 text-primary-foreground shadow-md font-medium"
            disabled={markDone.isPending}
            onClick={() => markDone.mutate(current.key)}
            data-testid="onboarding-coach-mark-done"
          >
            <Check className="w-4 h-4 mr-1.5" />
            {markDone.isPending ? "Saving..." : "All good - mark as done"}
          </Button>
        )}
      </div>
    );
  }

  // ── Mirror: some other /account page - keep the thread visible ──
  if (!next) return null;
  return (
    <div
      className="sticky top-0 z-20 -mx-1 mb-4 px-3.5 py-2 rounded-[var(--radius)] border border-[hsl(var(--primary)/0.2)] bg-[hsl(var(--primary)/0.03)] flex items-center gap-3"
      data-testid="onboarding-coach-mirror"
    >
      <div className="flex-1 min-w-0 flex items-center gap-3">
        <span className="text-sm font-medium shrink-0">
          Getting started - {data.doneCount}/{data.requiredCount}
        </span>
        <span className="flex-1 min-w-[60px] max-w-[180px] h-1.5 rounded-full bg-[hsl(var(--primary)/0.12)] overflow-hidden">
          <span className="block h-full rounded-full bg-[hsl(var(--primary))] transition-all" style={{ width: `${data.percent}%` }} />
        </span>
      </div>
      <Button size="sm" variant="outline" onClick={() => navigate(next.link)} data-testid="onboarding-coach-continue">
        Continue setup: {next.label}
        <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
      </Button>
    </div>
  );
}
