import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, TrendingUp, X } from "lucide-react";

import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { getPhotoSrc } from "@/lib/profile-utils";
import { getMandatoryFields } from "@/lib/profile-summary";
import { buildClinicCompare, buildDoctorCompare, clinicRatesAreGeneric, TOP_10_BADGE } from "@/lib/compare-providers";
import type { ClinicRateContext } from "@/lib/clinic-rate";
import { compareCellsFromProfile, mergeCompareCells } from "@/lib/compare-sections";
import { buildTitle, type SwipeDeckProfile } from "@/components/marketplace/swipe-mappers";

/**
 * Side-by-side comparison of a shortlist.
 *
 * Parents shortlist three to five and then decide by comparison - which today
 * means browser tabs. Rows are grouped so the attributes that disqualify people
 * fastest (cost, availability, age, location) come first, then the traits many
 * parents scan for, then outcome evidence, then background.
 *
 * Empty rows are dropped entirely: a comparison of four dashes tells a parent
 * nothing and makes the table look broken.
 */

export type CompareKind = "egg-donor" | "surrogate" | "sperm-donor" | "clinic" | "doctor";

/**
 * The comparison's first group: everything the Summary block shows.
 *
 * This used to be a hand-picked subset - cost, age, location, a few traits -
 * which left out the answers people actually choose on: twins, selective
 * reduction, prior c-sections, vaccination, whether she is open to same-sex or
 * international parents. Reusing the Summary builder means the comparison and
 * the profile can never disagree about what a parent is shown.
 *
 * It is handed the DATABASE ROW, not the swipe-card shape the marketplace maps
 * profiles into. Sharing the builder was only half the job: the card shape
 * drops fields it has no use for and renames others, so the comparison was
 * quietly missing blood type and showing a single total cost where the profile
 * shows the calculated range. Same builder, same input, or they still drift.
 */
function summaryRows(kind: CompareKind, profiles: any[]): CompareTableGroup[] {
  const perProfile = profiles.map((p) => getMandatoryFields(p.raw ?? p, kind));
  const labels: string[] = [];
  for (const rows of perProfile) for (const r of rows) if (!labels.includes(r.label)) labels.push(r.label);

  const rows = labels
    .map((label) => ({
      label,
      values: perProfile.map((rs) => {
        const hit = rs.find((r) => r.label === label);
        const v = hit?.value;
        return v && v !== "-" && v !== "--" ? v : null;
      }),
    }))
    // A row nobody answered teaches nothing; a row ONE of them answered is a
    // difference and stays.
    .filter((r) => r.values.some(Boolean));

  return rows.length ? [{ group: "Summary", rows }] : [];
}


/** Clinics and doctors have real names and logos; donors have numbers and photos. */
function compareTitle(p: any): string {
  return p?.name || buildTitle(p);
}
function comparePhoto(p: any): string | null {
  return getPhotoSrc(p?.photoUrl || p?.highResPhotoUrl || p?.photos?.[0] || p?.logoUrl) || null;
}

/**
 * Yes / No as a mark rather than a word.
 *
 * In a four-column table these are the rows a parent scans rather than reads -
 * "does this one do gestational carrier" is answered faster by a shape than by
 * a word, and the eye can run down a column without parsing anything. The word
 * stays available to screen readers, which cannot see the shape.
 */
function CompareValue({ value, dim }: { value: string | null; dim: boolean }) {
  // The same green pill the marketplace card carries. A parent has already
  // learned what it means there; re-rendering it as the word "Yes" would make
  // them re-learn the same signal in a second place.
  if (value === TOP_10_BADGE) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-[hsl(var(--brand-success))]/90 text-white font-ui px-2 py-0.5 whitespace-nowrap",
          dim && "opacity-75",
        )}
        style={{ fontSize: "var(--badge-text-size, 11px)" }}
      >
        <TrendingUp className="w-3 h-3" aria-hidden />
        {value}
      </span>
    );
  }
  if (value === "Yes" || value === "No") {
    const yes = value === "Yes";
    const Icon = yes ? Check : X;
    return (
      // A filled badge, not a hairline tick. At a glance down a four-column
      // table the answer should read as a solid block of colour - an outline
      // check reads as decoration and disappears at the size a table row gives
      // it. Identical rows still recede, but only to 75%: a filled badge at the
      // 55% the text rows use looks broken rather than quiet.
      <span
        className={cn(
          "inline-flex items-center justify-center w-5 h-5 rounded-[6px] shrink-0",
          yes ? "bg-[hsl(var(--brand-success))]" : "bg-destructive",
          dim && "opacity-75",
        )}
      >
        <Icon className="w-3.5 h-3.5 text-white" strokeWidth={3.5} aria-hidden />
        <span className="sr-only">{value}</span>
      </span>
    );
  }
  // A multi-item value is a list of facts, not a sentence. One per line, each
  // with its own marker, so three degrees read as three degrees.
  const lines = value ? value.split("\n").filter(Boolean) : [];
  if (lines.length > 1) {
    return (
      <ul className={cn("t-micro-value break-words space-y-0.5 text-left inline-block", dim && "opacity-55")}>
        {lines.map((line, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="text-accent shrink-0" aria-hidden>&bull;</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <span className={cn("t-micro-value break-words", dim && "opacity-55")}>
      {value ?? <span className="opacity-30">-</span>}
    </span>
  );
}

export const COMPARE_MAX = 4;

/**
 * Add or drop one profile from the shortlist.
 *
 * The cap is a reading limit, not a technical one: five columns on a laptop
 * makes every value too narrow to compare, which defeats the point. An attempt
 * to exceed it is IGNORED rather than silently evicting an earlier pick - a
 * parent who has chosen four and taps a fifth should keep the four they chose.
 */
export function toggleCompareSelection(selected: string[], id: string, max = COMPARE_MAX): string[] {
  if (selected.includes(id)) return selected.filter((x) => x !== id);
  if (selected.length >= max) return selected;
  return [...selected, id];
}

export type CompareTableGroup = { group: string; rows: { label: string; values: (string | null)[] }[] };

/**
 * The table a comparison renders, with dead rows removed.
 *
 * A row every selected profile leaves blank teaches a parent nothing and makes
 * the comparison look broken - four dashes reads as "the product failed", not
 * "nobody listed an occupation". A row ONE profile answers is kept: that gap is
 * itself a difference between them.
 */
export function buildCompareTable(
  kind: CompareKind,
  profiles: any[],
  opts: { rateContext?: ClinicRateContext; parentDiagnoses?: string[] } = {},
): CompareTableGroup[] {
  // Clinics and doctors compare on entirely different things - outcomes, cost,
  // access - so they get their own builders rather than a donor Summary that
  // does not apply to them.
  if (kind === "clinic") return buildClinicCompare(profiles, opts.rateContext || {});
  if (kind === "doctor") return buildDoctorCompare(profiles, opts.parentDiagnoses || []);

  const scalar = summaryRows(kind, profiles);

  // Then the substance: her own sections, in the same priority order the
  // profile page uses. Cost and availability still lead - they disqualify
  // fastest - but everything after them is what actually decides between two
  // people, and the comparison used to omit it entirely.
  const fromSections = mergeCompareCells(
    profiles.map((p) => compareCellsFromProfile(p.profileData, kind as any)),
  );

  return [...scalar, ...fromSections];
}

export function CompareDrawer({
  kind,
  profiles,
  tableOptions,
  available,
  onToggle,
  onClose,
  onOpenProfile,
  onPersonalise,
}: {
  kind: CompareKind;
  profiles: SwipeDeckProfile[];
  /** Clinic rate context and the parent's diagnoses, for the provider kinds. */
  tableOptions?: { rateContext?: ClinicRateContext; parentDiagnoses?: string[] };
  /** Everything saved in this tab, so columns can be swapped without leaving. */
  available: SwipeDeckProfile[];
  onToggle: (id: string) => void;
  onClose: () => void;
  onOpenProfile: (profile: any) => void;
  /** Sends her to the profile questions that make the rates hers. */
  onPersonalise?: () => void;
}) {
  if (profiles.length === 0) return null;

  // The header row is sticky, so once you are twenty rows down the photos are
  // still occupying a third of the screen for no reason. They ease down to a
  // thumbnail instead - the column identity is what matters at that point, not
  // the portrait.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Hysteresis, not one threshold. Shrinking the header shortens the page, and
    // at the bottom the browser answers by pulling the scroll position up with
    // it - straight back across a single threshold, which expanded the header,
    // lengthened the page, and started again. That was the stutter.
    const onScroll = () => {
      const y = el.scrollTop;
      if (!compactRef.current && y > 140) { compactRef.current = true; setCompact(true); }
      else if (compactRef.current && y < 70) { compactRef.current = false; setCompact(false); }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // And the belt to that pair of braces: hold the page's total height constant
  // while the header collapses, by growing a spacer by exactly what the header
  // gives up. Measured rather than hardcoded, and continuously, so it tracks
  // the 300ms transition frame by frame instead of only its endpoints.
  const headRef = useRef<HTMLTableSectionElement>(null);
  const tallRef = useRef(0);
  const [headSlack, setHeadSlack] = useState(0);
  useEffect(() => {
    const el = headRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (!compactRef.current) { tallRef.current = h; setHeadSlack(0); return; }
      setHeadSlack(Math.max(0, tallRef.current - h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const groups = buildCompareTable(kind, profiles as any[], tableOptions);

  // Rendered into <body>, not where it sits in the tree. The page wrapper in
  // layout-shell carries `animate-in slide-in-from-bottom-4`, and an element
  // with an animated transform becomes the containing block for every FIXED
  // descendant - permanently, because the animation fills forwards. So
  // `fixed inset-0` was not the viewport at all: it was that wrapper's box,
  // which starts below the site header (the Saved page showing above the
  // drawer) and runs the full height of the page's content (so the drawer was
  // far taller than the screen, its scrollport never matched the viewport, and
  // everything anchored to its bottom sat below the fold). An overlay must not
  // depend on where in the tree it happens to be mounted.
  return createPortal(
    // ONE scrollport. The table used to sit in its own overflow-x container,
    // and because an element that scrolls in one axis scrolls in both, that
    // container - not the page - was what the sticky header measured itself
    // against. It never scrolled vertically, so the header never stuck. It only
    // looked like it did on egg donors, whose table is short enough to fit.
    // z-[70]: above the mobile deck's own z-[60] container, which the drawer
    // used to be nested inside and is now a sibling of.
    <div className="fixed inset-0 z-[70] bg-background flex flex-col" data-testid="compare-drawer">
      <div className="shrink-0 bg-background border-b border-border px-4 py-3 flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-heading">Comparing {profiles.length}</h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close comparison" data-testid="compare-close">
          <X className="w-5 h-5" />
        </Button>
      </div>

      {/* pb-28 clears the compare tray, which is fixed over the bottom of the
          screen - without it the last thing on the page sits under it. */}
      <div ref={scrollRef} className="flex-1 overflow-auto p-4 pb-28 max-w-[1200px] w-full mx-auto">
        {/* A rate that does not describe her must never be shown bare. CDC
            publishes per age band and egg source, so without her profile these
            are the under-35 first-cycle figures - a real number about a
            population she may not be in. Say so, and put the fix next to the
            number she wants fixed. */}
        {kind === "clinic" && clinicRatesAreGeneric(profiles as any[], tableOptions?.rateContext || {}) && (
          <div
            className="mb-4 rounded-[var(--radius)] bg-accent/10 border border-accent/30 px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1"
            data-testid="compare-generic-rate-notice"
          >
            <span className="t-micro-value">
              These are all-patient rates, not yours - CDC reports separately by age and egg source.
            </span>
            <button
              type="button"
              onClick={onPersonalise}
              className="t-micro-value text-accent underline underline-offset-2 hover:opacity-80"
              data-testid="compare-personalise"
            >
              Add your age and egg source
            </button>
          </div>
        )}
        {/* border-separate, because a sticky cell inside a collapsed table drops
            its borders in Safari - and the row rules ARE borders. They move to
            the cells, which is where a separated table draws them. */}
        {/* The label column has to hold the longest single word in it - at 140px
            "Compensation" did not fit on a line of its own, so break-words did
            what it is for and split it, leaving a lone "n". Words are the unit
            here; the column widens instead. */}
        <table className="w-full table-fixed border-separate border-spacing-0 min-w-[620px]" data-testid="compare-table">
            {/* Sticky on the cells as well as on the thead: browsers vary on
                whether a sticky thead alone pins its row. */}
            <thead ref={headRef} className="sticky top-0 z-30 bg-background">
              <tr>
                <th className="w-[150px] sm:w-[200px] sticky top-0 left-0 z-40 bg-background border-b border-border" />
                {profiles.map((p: any) => (
                  <th key={p.id} className="p-2 align-bottom text-center font-normal sticky top-0 z-30 bg-background border-b border-border">
                    <button
                      type="button"
                      onClick={() => onOpenProfile(p)}
                      className="block w-full text-center focus:outline-none focus:ring-2 focus:ring-primary/40 rounded-[var(--radius)]"
                      data-testid={`compare-open-${p.id}`}
                    >
                      {comparePhoto(p) ? (
                        <img
                          src={comparePhoto(p)!}
                          alt=""
                          className={cn(
                            "w-full mx-auto rounded-[var(--radius)] mb-2 transition-all duration-300 ease-out",
                            compact ? "max-w-[44px]" : "max-w-[150px]",
                            kind === "clinic" ? "aspect-square object-contain bg-secondary/40 p-1.5" : "aspect-[3/4] object-cover object-top",
                          )}
                        />
                      ) : (
                        <div className={cn("w-full mx-auto aspect-[3/4] rounded-[var(--radius)] bg-secondary mb-2 transition-all duration-300 ease-out", compact ? "max-w-[44px]" : "max-w-[150px]")} />
                      )}
                      <span className="t-field-value block truncate">{compareTitle(p)}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggle(p.id)}
                      className={cn("t-helper mt-1 mx-auto block hover:underline transition-opacity", compact && "opacity-0 pointer-events-none h-0 overflow-hidden")}
                      data-testid={`compare-remove-${p.id}`}
                    >
                      Remove
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(({ group, rows }) => (
                <Fragment key={group}>
                  <tr>
                    {/* z-0, explicitly. Sticking it to the left made it a
                        positioned element, and with no z-index of its own it
                        painted over the pinned header - the group title and its
                        rule cut straight across the photos as they scrolled
                        past. Everything sticky in the body sits below the
                        header now, by number rather than by DOM order. */}
                    <td colSpan={profiles.length + 1} className="pt-7 pb-2 sticky left-0 z-0 bg-background">
                      {/* A real band, not a faint caption. The old headings were
                          t-micro-label on white and vanished into the rows they
                          were meant to separate - in a table this long, the
                          group is the only thing telling a parent what they are
                          looking at.

                          No rule trailing off the title. It was drawn when the
                          heading needed help separating itself from the rows;
                          the row above already ends in a border and the row
                          below starts with one, so it was a third line in the
                          same inch, running out of the word for no reason. */}
                      <span className="font-heading text-base text-foreground">{group}</span>
                    </td>
                  </tr>
                  {rows.map((row) => {
                    // Rows where everyone answered the same are not a decision.
                    // Dimming them lets the eye land on what actually differs,
                    // which is the whole reason the table exists.
                    const filled = row.values.filter((v) => v != null);
                    const identical = filled.length === row.values.length
                      && filled.every((v) => v === filled[0]);
                    return (
                      <tr
                        key={row.label}
                        className="hover:bg-secondary/40 transition-colors"
                        data-testid={`compare-row-${row.label.toLowerCase().replace(/\s+/g, "-")}`}
                        data-identical={identical ? "true" : "false"}
                      >
                        <td className="py-2.5 pr-4 align-top text-left sticky left-0 z-10 bg-background border-t border-border/60">
                          <span className="t-field-label break-words">{row.label}</span>
                        </td>
                        {row.values.map((value, i) => (
                          <td key={profiles[i]?.id ?? i} className="py-2.5 px-3 align-top text-center border-t border-border/60">
                            <CompareValue value={value} dim={identical} />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
        </table>

        {available.length > profiles.length && (
          <div className="mt-8" data-testid="compare-swap-strip">
            <p className="t-micro-label mb-2">
              {profiles.length >= COMPARE_MAX
                ? `Comparing the maximum of ${COMPARE_MAX} - remove one to swap another in`
                : "Add another from your saved list"}
            </p>
            <div className="flex flex-wrap gap-2">
              {available
                .filter((a: any) => !profiles.some((p: any) => p.id === a.id))
                .map((a: any) => (
                  <button
                    key={a.id}
                    type="button"
                    disabled={profiles.length >= COMPARE_MAX}
                    onClick={() => onToggle(a.id)}
                    className="flex items-center gap-2 rounded-full border border-border px-3 py-1.5 disabled:opacity-40 hover:border-primary/40"
                    data-testid={`compare-add-${a.id}`}
                  >
                    {comparePhoto(a) && (
                      <img src={comparePhoto(a)!} alt="" className="w-6 h-6 rounded-full object-cover object-top" />
                    )}
                    <span className="t-micro-value">{compareTitle(a)}</span>
                  </button>
                ))}
            </div>
          </div>
        )}

        {/* Exactly what the header gave up, so the page keeps its height while
            it collapses. It belongs at the very bottom: sitting between the
            table and this strip, it pushed the strip down by its own height and
            straight under the tray, where nobody could reach it. */}
        <div style={{ height: headSlack }} aria-hidden />
      </div>
    </div>,
    document.body,
  );
}
