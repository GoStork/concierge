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
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { CheckCircle2, ListChecks, ArrowRight, ArrowDown, Clock, Check } from "lucide-react";
import { useProviderOnboarding, type OwnStep } from "@/components/provider-own-onboarding";

/**
 * Scroll a page section (a data-onb-anchor element) into view and ring it
 * with the primary highlight - the same visual language as the parent-record
 * ?focus deep link. Retries while the page is still rendering; the returned
 * cleanup removes the ring when the tour moves on.
 */
function paintAnchor(anchor: string, onFound: (el: HTMLElement | null) => void): () => void {
  let cancelled = false;
  let el: HTMLElement | null = null;
  let tries = 15;
  const attempt = () => {
    if (cancelled) return;
    el = document.querySelector<HTMLElement>(`[data-onb-anchor="${anchor}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.style.transition = "box-shadow 0.3s ease";
      el.style.borderRadius = "var(--radius)";
      el.style.boxShadow = "0 0 0 3px hsl(var(--primary))";
      onFound(el);
    } else if (--tries > 0) {
      setTimeout(attempt, 300);
    }
  };
  attempt();
  return () => {
    cancelled = true;
    if (el) el.style.boxShadow = "";
    onFound(null);
  };
}

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

  const steps = data?.steps || [];
  const hidden = !data || data.percent >= 100;
  const next = steps.find((s) => s.key === data?.nextKey) || null;
  const onPage = steps.filter((s) => s.link === location.pathname);
  // Several steps can share a page (/account/documents holds both the
  // GoStork agreement and parent templates) - coach the first open one.
  const current = (!hidden && (onPage.find((s) => s.status === "pending") || onPage.find((s) => s.status === "optional"))) || null;
  const celebrated = celebrateKey ? steps.find((s) => s.key === celebrateKey) : null;

  // ── Section tour: walk the step's page sections wizard-style ──
  // Landing on a step's page highlights its first section; "Next section"
  // advances through the rest, each scrolled to and ringed in turn.
  const [sectionIdx, setSectionIdx] = useState(0);
  const currentKey = current?.key ?? null;
  useEffect(() => {
    setSectionIdx(0);
  }, [currentKey, location.pathname]);
  const sections = current?.sections || [];
  // sectionIdx === sections.length means the tour was finished ("Done" on
  // the last flag) - ring and flag retire until the step changes.
  const section = sections.length && sectionIdx < sections.length ? sections[sectionIdx] : null;
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!section) {
      setAnchorEl(null);
      return;
    }
    return paintAnchor(section.anchor, setAnchorEl);
  }, [currentKey, section?.anchor]);

  // The flag rides the highlighted section: track its viewport rect through
  // scrolls and resizes (rAF-throttled) so the fixed-position flag stays
  // pinned to the card, PandaDoc-style.
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!anchorEl) {
      setAnchorRect(null);
      return;
    }
    let raf = 0;
    const update = () => setAnchorRect(anchorEl.getBoundingClientRect());
    update();
    const onMove = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [anchorEl]);

  if (hidden) return null;

  const isLastSection = sectionIdx >= sections.length - 1;
  // Centered above the section, straddling its top border - clear of the
  // left-aligned section titles - bobbing vertically to say "this card".
  const sectionFlag = section && anchorRect && current
    ? createPortal(
        <>
          <style>{`
            @keyframes onbFlagNudge { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(6px); } }
            .onb-section-flag-inner { animation: onbFlagNudge 1.2s ease-in-out infinite; }
          `}</style>
          <div
            className="fixed z-40"
            style={{
              top: Math.min(Math.max(anchorRect.top - 18, 76), window.innerHeight - 56),
              left: anchorRect.left + anchorRect.width / 2,
              transform: "translateX(-50%)",
            }}
          >
            <button
              type="button"
              className="onb-section-flag-inner flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-[hsl(var(--primary))] text-primary-foreground text-sm font-medium shadow-lg hover:brightness-110 transition-all"
              disabled={markDone.isPending}
              onClick={() => {
                if (!isLastSection) {
                  setSectionIdx((i) => Math.min(sections.length - 1, i + 1));
                } else if (current.selfMarkable) {
                  markDone.mutate(current.key);
                } else {
                  setSectionIdx(sections.length); // end the tour
                }
              }}
              data-testid="onboarding-section-flag"
            >
              {isLastSection ? (
                <>
                  {markDone.isPending ? "Saving..." : "Done"}
                  <Check className="w-4 h-4" />
                </>
              ) : (
                <>
                  Next
                  <ArrowDown className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        </>,
        document.body,
      )
    : null;

  // ── Celebrate: it just flipped to done right here ──
  if (celebrated && !current) {
    return (
      <div
        className="sticky top-0 md:top-16 z-20 -mx-1 mb-4 px-3.5 py-2.5 rounded-[var(--radius)] border border-[hsl(var(--brand-success)/0.35)] bg-[color-mix(in_srgb,hsl(var(--brand-success))_8%,hsl(var(--background)))] shadow-sm flex items-center gap-3"
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
        className="sticky top-0 md:top-16 z-20 -mx-1 mb-4 px-3.5 py-2.5 rounded-[var(--radius)] border border-[hsl(var(--primary)/0.25)] bg-[color-mix(in_srgb,hsl(var(--primary))_5%,hsl(var(--background)))] shadow-sm flex items-center gap-3"
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
          {section && sections.length > 1 && (
            <div className="mt-1 flex items-center gap-2 text-xs font-medium text-[hsl(var(--primary))]">
              <span>
                Section {sectionIdx + 1}/{sections.length}: {section.label}
              </span>
              {sectionIdx > 0 && (
                <button
                  type="button"
                  className="underline underline-offset-2 hover:opacity-80"
                  onClick={() => setSectionIdx((i) => Math.max(0, i - 1))}
                  data-testid="onboarding-coach-prev-section"
                >
                  Back
                </button>
              )}
            </div>
          )}
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
        {sectionFlag}
      </div>
    );
  }

  // ── Mirror: some other /account page - keep the thread visible ──
  if (!next) return null;
  return (
    <div
      className="sticky top-0 md:top-16 z-20 -mx-1 mb-4 px-3.5 py-2 rounded-[var(--radius)] border border-[hsl(var(--primary)/0.2)] bg-[color-mix(in_srgb,hsl(var(--primary))_3%,hsl(var(--background)))] shadow-sm flex items-center gap-3"
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
