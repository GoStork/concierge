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
import { apiRequest } from "@/lib/queryClient";
import { CheckCircle2, ListChecks, ArrowRight, ArrowDown, Clock, Check, FileX2 } from "lucide-react";
import { useProviderOnboarding, type OwnStep } from "@/components/provider-own-onboarding";
import { CelebrationBurst } from "@/components/chat/celebration-burst";

type TourSection = NonNullable<OwnStep["sections"]>[number];

/**
 * Scroll a page section (a data-onb-anchor element) into view and ring it
 * with the primary highlight - the same visual language as the parent-record
 * ?focus deep link. Retries while the page is still rendering; the returned
 * cleanup removes the ring when the tour moves on.
 */
function paintAnchor(
  anchor: string,
  onFound: (el: HTMLElement | null) => void,
  onMissing?: () => void,
): () => void {
  let cancelled = false;
  let el: HTMLElement | null = null;
  let tries = 8;
  const attempt = () => {
    if (cancelled) return;
    // Anchor resolution: explicit data-onb-anchor first, then an element id
    // (the Automation page's own section ids), then a data-testid.
    el =
      document.querySelector<HTMLElement>(`[data-onb-anchor="${anchor}"]`) ||
      document.getElementById(anchor) ||
      document.querySelector<HTMLElement>(`[data-testid="${anchor}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.style.transition = "box-shadow 0.3s ease";
      el.style.borderRadius = "var(--radius)";
      el.style.boxShadow = "0 0 0 3px hsl(var(--primary))";
      onFound(el);
    } else if (--tries > 0) {
      setTimeout(attempt, 300);
    } else {
      // The section left the DOM after discovery (a conditional card whose
      // data changed). Without this, the tour dead-ends here: no ring, no
      // flag, no way to reach the sections after it.
      onMissing?.();
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
  // A sub-section's alternative action (server-declared): call it, refresh
  // what it touched, and step on to the next section.
  const skipSection = useMutation({
    mutationFn: async (skip: NonNullable<TourSection["skip"]>) => {
      await apiRequest(skip.method, skip.url, skip.body);
      return skip;
    },
    onSuccess: (skip) => {
      queryClient.invalidateQueries({ queryKey: ["/api/provider/onboarding"] });
      for (const k of skip.invalidate || []) queryClient.invalidateQueries({ queryKey: [k] });
      setSectionIdx((i) => i + 1);
    },
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
  // Required steps hit 100% first (the milestone parents care about), but
  // the bar keeps walking the optional pages until nothing is open. It
  // retires only when ALL of it is done - except for the one render where
  // the last step flipped right here, which earns a send-off instead of a
  // silent vanish.
  const requiredComplete = !!data && data.percent >= 100;
  const complete = !!data && data.allDone;
  const hidden = !data || (complete && !celebrateKey);
  const next = steps.find((s) => s.key === data?.nextKey) || null;
  const onPage = steps.filter((s) => s.link === location.pathname);
  // Several steps can share a page (/account/documents holds both the
  // GoStork agreement and parent templates) - coach the first open one.
  const openStep = (!hidden && (onPage.find((s) => s.status === "pending") || onPage.find((s) => s.status === "optional"))) || null;

  // ── Tour resume across reloads (OAuth redirects!) ──
  // Progress is persisted per page in sessionStorage. Connecting a calendar
  // bounces through Google and can complete the whole step - without this,
  // the return found no OPEN step and the wizard vanished mid-walkthrough.
  // A saved tour whose step is now DONE resumes anyway, at the NEXT section.
  const tourStorageKey = `onbtour:${location.pathname}`;
  let savedTour: { key: string; idx: number } | null = null;
  try {
    savedTour = JSON.parse(sessionStorage.getItem(tourStorageKey) || "null");
  } catch {}
  const resumedStep =
    !hidden && !complete && !openStep && savedTour
      ? steps.find((s) => s.key === savedTour!.key && s.link === location.pathname && s.status === "done") || null
      : null;
  const current = openStep || resumedStep;
  const celebrated = celebrateKey ? steps.find((s) => s.key === celebrateKey) : null;

  // ── Section tour: walk the step's page sections wizard-style ──
  // Landing on a step's page highlights its first section; "Next section"
  // advances through the rest, each scrolled to and ringed in turn.
  const [sectionIdx, setSectionIdx] = useState(0);
  const currentKey = current?.key ?? null;
  useEffect(() => {
    setSectionIdx(0);
  }, [currentKey, location.pathname]);
  // The tour walks EVERY section actually rendered on the page, not just the
  // server-declared list: all visible [data-onb-anchor] elements in document
  // order, labeled from the declared sections when they match (else the
  // section's own heading). Declared anchors that resolve via element id or
  // testid (e.g. the Automation page) are appended in declared order. This
  // makes tours complete by construction - a page section can only be
  // skipped if its wrapper carries no anchor at all.
  const [discovered, setDiscovered] = useState<TourSection[]>([]);
  const declaredSections = current?.sections;
  useEffect(() => {
    if (!current) {
      setDiscovered([]);
      return;
    }
    let cancelled = false;
    let tries = 15;
    const attempt = () => {
      if (cancelled) return;
      const declared = declaredSections || [];
      const found: Array<{ el: HTMLElement; section: TourSection }> = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-onb-anchor]"))) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue; // not rendered
        const a = el.getAttribute("data-onb-anchor")!;
        if (found.some((x) => x.section.anchor === a)) continue;
        const d = declared.find((s) => s.anchor === a);
        const heading = el.querySelector("h1,h2,h3,h4")?.textContent?.trim();
        found.push({ el, section: { anchor: a, label: d?.label || el.getAttribute("data-onb-label") || heading || a, state: d?.state, skip: d?.skip } });
      }
      for (const s of declared) {
        if (found.some((x) => x.section.anchor === s.anchor)) continue;
        const el = document.getElementById(s.anchor) || document.querySelector<HTMLElement>(`[data-testid="${s.anchor}"]`);
        if (el) found.push({ el, section: s });
      }
      // Walk the page top to bottom regardless of how each section was
      // resolved or declared - a tour that jumps down then back up reads as
      // broken.
      found.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      const list: TourSection[] = found.map((f) => f.section);
      if (list.length) {
        setDiscovered(list);
        // Resuming a saved tour (reload / OAuth return) wins over the
        // default start. A step that completed while away resumes at the
        // NEXT section - the one they left is what they just finished.
        if (savedTour && savedTour.key === current.key) {
          const resumeIdx = current.status === "done" ? savedTour.idx + 1 : savedTour.idx;
          setSectionIdx(Math.min(Math.max(0, resumeIdx), list.length - 1));
        } else {
          // Start the tour at the CURRENT step's own section, not the page's
          // first anchor: on the Legal page the open W-9 step must land on
          // the W-9 section, with the agreement reachable via Back.
          const startIdx = declared.length
            ? list.findIndex((s) => declared.some((d) => d.anchor === s.anchor))
            : -1;
          if (startIdx > 0) setSectionIdx(startIdx);
        }
      }
      else if (--tries > 0) setTimeout(attempt, 300);
    };
    attempt();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, location.pathname]);
  const sections = discovered;
  // sectionIdx === sections.length means the tour was finished ("Done" on
  // the last flag) - ring and flag retire until the step changes.
  const section = sections.length && sectionIdx < sections.length ? sections[sectionIdx] : null;

  // Persist tour progress so a reload (or an OAuth bounce) resumes instead
  // of vanishing; a finished tour clears its slot.
  useEffect(() => {
    if (!current || !sections.length) return;
    try {
      if (sectionIdx >= sections.length) sessionStorage.removeItem(tourStorageKey);
      else sessionStorage.setItem(tourStorageKey, JSON.stringify({ key: current.key, idx: sectionIdx }));
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, sectionIdx, sections.length]);
  const barRef = useRef<HTMLDivElement>(null);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!section) {
      setAnchorEl(null);
      return;
    }
    const missingAnchor = section.anchor;
    return paintAnchor(section.anchor, setAnchorEl, () => {
      // Self-heal: drop the vanished section from the tour. Removing at the
      // current index makes sectionIdx point at the next section naturally;
      // clamp when the removed one was last.
      setDiscovered((prev) => {
        const next = prev.filter((s) => s.anchor !== missingAnchor);
        setSectionIdx((i) => Math.min(i, Math.max(0, next.length - 1)));
        return next;
      });
    });
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
  // The flag must never ride up over the sticky bar (its "Done" button sits
  // exactly where a centred flag lands on a phone): its ceiling is the bar's
  // live bottom edge, re-read on every scroll via anchorRect updates.
  const barBottom = barRef.current?.getBoundingClientRect().bottom ?? 0;
  const flagCeiling = Math.max(76, barBottom + 10);
  // Only a self-markable, still-open step completes on the flag click.
  const canMarkHere = !!current && current.selfMarkable && current.status !== "done";
  // Centered above the section, straddling its top border - clear of the
  // left-aligned section titles - bobbing vertically to say "this card".
  const sectionFlag = section && anchorRect && current
    ? createPortal(
        <>
          <style>{`
            @keyframes onbFlagNudge { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(6px); } }
            /* Two nudges say "this card"; an endless bob over a form the
               provider is trying to read is a distraction, and motion they
               asked the OS to reduce never plays at all. */
            .onb-section-flag-inner { animation: onbFlagNudge 1.2s ease-in-out 2; }
            @media (prefers-reduced-motion: reduce) { .onb-section-flag-inner { animation: none; } }
          `}</style>
          <div
            className="fixed z-40"
            style={{
              top: Math.min(Math.max(anchorRect.top - 18, flagCeiling), window.innerHeight - 56),
              left: anchorRect.left + anchorRect.width / 2,
              transform: "translateX(-50%)",
            }}
          >
            <button
              type="button"
              className="onb-section-flag-inner flex items-center gap-1.5 min-h-10 px-3.5 py-2 rounded-full bg-[hsl(var(--primary))] text-primary-foreground text-sm font-medium shadow-lg hover:brightness-110 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              disabled={markDone.isPending}
              onClick={() => {
                if (!isLastSection) {
                  setSectionIdx((i) => Math.min(sections.length - 1, i + 1));
                } else {
                  // Last section: a still-open review step gets marked
                  // complete ("Done"); anything else - an artifact step or
                  // an already-done walkthrough - just ends the tour ("Got
                  // it"), because clicking cannot complete it.
                  if (canMarkHere) markDone.mutate(current.key);
                  try { sessionStorage.removeItem(tourStorageKey); } catch {}
                  setSectionIdx(sections.length); // end the tour
                }
              }}
              data-testid="onboarding-section-flag"
            >
              {isLastSection ? (
                <>
                  {markDone.isPending ? "Saving..." : canMarkHere ? "Done" : "Got it"}
                  <Check className="w-4 h-4" />
                </>
              ) : (
                <>
                  Next
                  <ArrowDown className="w-4 h-4" />
                </>
              )}
            </button>
            {section.skip && (
              <button
                type="button"
                className="mt-1.5 mx-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--background))] text-[hsl(var(--primary))] text-xs font-medium shadow hover:bg-[hsl(var(--primary)/0.06)] transition-colors whitespace-nowrap"
                disabled={skipSection.isPending}
                onClick={() => skipSection.mutate(section.skip!)}
                data-testid="onboarding-section-skip"
              >
                <FileX2 className="w-3.5 h-3.5" />
                {skipSection.isPending ? "Saving..." : section.skip.label}
              </button>
            )}
          </div>
        </>,
        document.body,
      )
    : null;

  // ── Celebrate: it just flipped to done right here ──
  if (celebrated && !current) {
    return (
      <div
        className="sticky top-0 md:top-16 z-20 -mx-1 mb-4 px-3 py-2 md:px-3.5 md:py-2.5 rounded-[var(--radius)] border border-[hsl(var(--brand-success)/0.35)] bg-[color-mix(in_srgb,hsl(var(--brand-success))_8%,hsl(var(--background)))] shadow-sm flex flex-wrap items-center gap-x-3 gap-y-2"
        data-testid="onboarding-coach-done"
      >
        {/* Fireworks the moment the required setup completes (same show as
            a payment landing in chat); confetti when the optional pages are
            walked too. Once per tab, via the burst's own guard. */}
        {requiredComplete && !celebrated.isOptional && (
          <CelebrationBurst messageId="onboarding-required-complete" createdAt={new Date().toISOString()} kind="payment_received" />
        )}
        {complete && celebrated.isOptional && (
          <CelebrationBurst messageId="onboarding-all-complete" createdAt={new Date().toISOString()} kind="match_confirmed" />
        )}
        <CheckCircle2 className="w-5 h-5 text-[hsl(var(--brand-success-text))] shrink-0" aria-hidden="true" />
        {/* Phones: the text takes the full row and the Next button drops
            to its own full-width row - side by side the button squeezed the
            text to one word per line. */}
        <div className="flex-1 min-w-0 basis-[calc(100%-2rem)] md:basis-auto text-sm" role="status" aria-live="polite">
          <span className="font-medium">{celebrated.label} - done!</span>
          {complete ? (
            <span className="text-muted-foreground"> Every page reviewed - your setup is complete and parents can find you.</span>
          ) : requiredComplete && !celebrated.isOptional ? (
            <span className="text-muted-foreground"> All required steps are done - parents can find you. {data.openOptionalCount} optional page{data.openOptionalCount === 1 ? "" : "s"} worth a look next.</span>
          ) : next ? (
            <span className="text-muted-foreground"> {data.doneCount}/{data.requiredCount} steps complete.</span>
          ) : null}
        </div>
        {complete && (
          <Button size="sm" variant="outline" className="w-full md:w-auto" onClick={() => setCelebrateKey(null)} data-testid="onboarding-coach-finish">
            Done
          </Button>
        )}
        {!complete && next && (
          <Button size="sm" className="w-full md:w-auto min-w-0" onClick={() => navigate(next.link)} data-testid="onboarding-coach-next">
            <span className="truncate">Next: {next.label}</span>
            <ArrowRight className="w-3.5 h-3.5 ml-1.5 shrink-0" />
          </Button>
        )}
      </div>
    );
  }

  // ── Coach: this page is an open step ──
  if (current) {
    return (
      <div
        ref={barRef}
        className="sticky top-0 md:top-16 z-20 -mx-1 mb-4 px-3 py-2 md:px-3.5 md:py-2.5 rounded-[var(--radius)] border border-[hsl(var(--primary)/0.25)] bg-[color-mix(in_srgb,hsl(var(--primary))_5%,hsl(var(--background)))] shadow-sm flex items-center gap-2 md:gap-3"
        data-testid="onboarding-coach-bar"
        role="region"
        aria-label="Setup guide"
      >
        {/* Phones: no icon, one line per fact (title + meta / description /
            section), a short Done button - the bar must stay a slim strip,
            not a third of the screen. */}
        <span className="hidden md:flex w-8 h-8 rounded-full bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))] items-center justify-center shrink-0">
          <ListChecks className="w-4 h-4" aria-hidden="true" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium flex items-center gap-2 min-w-0">
            <span className="line-clamp-2 md:line-clamp-1">{current.label}</span>
            <span className="text-xs font-normal text-muted-foreground flex items-center gap-1 shrink-0 whitespace-nowrap">
              <Clock className="w-3 h-3" aria-hidden="true" /> about {current.minutes} min · {data.doneCount}/{data.requiredCount} done
            </span>
          </div>
          <div className="text-xs md:text-sm text-muted-foreground line-clamp-2">{current.description}</div>
          {section && sections.length > 1 && (
            <div className="mt-0.5 md:mt-1 flex items-center gap-2 text-xs font-medium text-[hsl(var(--primary))] min-w-0">
              <span className="truncate">
                Section {sectionIdx + 1}/{sections.length}: {section.label}
              </span>
              {section.state === "open" && (
                <span className="shrink-0 whitespace-nowrap px-1.5 py-0.5 rounded-full bg-[hsl(var(--brand-warning)/0.15)] text-[hsl(var(--brand-warning-text))]">
                  <span className="md:hidden">still needed</span>
                  <span className="hidden md:inline">still needed - upload, or mark not applicable</span>
                </span>
              )}
              {section.state === "done" && (
                <span className="shrink-0 flex items-center gap-1 text-[hsl(var(--brand-success-text))]">
                  <Check className="w-3 h-3" /> settled
                </span>
              )}
              {sectionIdx > 0 && (
                <button
                  type="button"
                  className="shrink-0 underline underline-offset-2 hover:opacity-80"
                  onClick={() => setSectionIdx((i) => Math.max(0, i - 1))}
                  data-testid="onboarding-coach-prev-section"
                >
                  Back
                </button>
              )}
            </div>
          )}
        </div>
        {current.selfMarkable && current.status !== "done" && (
          <Button
            size="sm"
            // Teal, not status green: white on the live success hue measured
            // 2.59:1, and DESIGN.md keeps one action color.
            className="shrink-0 shadow-md font-medium min-h-11 md:min-h-0 md:h-10 md:px-4"
            disabled={markDone.isPending}
            onClick={() => markDone.mutate(current.key)}
            data-testid="onboarding-coach-mark-done"
          >
            <Check className="w-4 h-4 md:mr-1.5" />
            <span className="hidden md:inline">{markDone.isPending ? "Saving..." : "All good - mark as done"}</span>
            <span className="md:hidden ml-1">{markDone.isPending ? "Saving" : "Done"}</span>
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
      className="sticky top-0 md:top-16 z-20 -mx-1 mb-4 px-3 py-2 md:px-3.5 rounded-[var(--radius)] border border-[hsl(var(--primary)/0.2)] bg-[color-mix(in_srgb,hsl(var(--primary))_3%,hsl(var(--background)))] shadow-sm flex flex-wrap items-center gap-x-3 gap-y-2"
      data-testid="onboarding-coach-mirror"
      role="region"
      aria-label="Setup progress"
    >
      <div className="flex-1 min-w-0 basis-full md:basis-auto flex items-center gap-3">
        <span className="text-sm font-medium shrink-0">
          {requiredComplete ? "Setup complete" : `Getting started - ${data.doneCount}/${data.requiredCount}`}
        </span>
        <span className="flex-1 min-w-[60px] max-w-[180px] h-1.5 rounded-full bg-[hsl(var(--primary)/0.12)] overflow-hidden" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={data.requiredCount} aria-valuenow={data.doneCount}>
          <span className="block h-full rounded-full bg-[hsl(var(--primary))] transition-all" style={{ width: `${data.percent}%` }} />
        </span>
      </div>
      <Button size="sm" variant="outline" className="w-full md:w-auto min-w-0" onClick={() => navigate(next.link)} data-testid="onboarding-coach-continue">
        <span className="truncate">{next.isOptional ? `Optional: ${next.label}` : `Continue setup: ${next.label}`}</span>
        <ArrowRight className="w-3.5 h-3.5 ml-1.5 shrink-0" />
      </Button>
    </div>
  );
}
