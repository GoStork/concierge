import { Fragment } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { getPhotoSrc } from "@/lib/profile-utils";
import { getMandatoryFields } from "@/lib/profile-summary";
import { buildClinicCompare, buildDoctorCompare, clinicRatesAreGeneric } from "@/lib/compare-providers";
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
 */
function summaryRows(kind: CompareKind, profiles: any[]): CompareTableGroup[] {
  const perProfile = profiles.map((p) => getMandatoryFields(p, kind));
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
  const groups = buildCompareTable(kind, profiles as any[], tableOptions);

  return (
    <div className="fixed inset-0 z-50 bg-background overflow-auto" data-testid="compare-drawer">
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 py-3 flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-heading">Comparing {profiles.length}</h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close comparison" data-testid="compare-close">
          <X className="w-5 h-5" />
        </Button>
      </div>

      <div className="p-4 max-w-[1200px] mx-auto">
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
        <div className="overflow-x-auto">
          <table className="w-full table-fixed border-collapse" data-testid="compare-table">
            <thead className="sticky top-[57px] z-10 bg-background">
              <tr>
                <th className="w-[168px]" />
                {profiles.map((p: any) => (
                  <th key={p.id} className="p-2 align-bottom text-left font-normal">
                    <button
                      type="button"
                      onClick={() => onOpenProfile(p)}
                      className="block w-full text-left focus:outline-none focus:ring-2 focus:ring-primary/40 rounded-[var(--radius)]"
                      data-testid={`compare-open-${p.id}`}
                    >
                      {getPhotoSrc(p.photoUrl || p.photos?.[0]) ? (
                        <img
                          src={getPhotoSrc(p.photoUrl || p.photos?.[0])!}
                          alt=""
                          className="w-full max-w-[150px] aspect-[3/4] object-cover object-top rounded-[var(--radius)] mb-2"
                        />
                      ) : (
                        <div className="w-full max-w-[150px] aspect-[3/4] rounded-[var(--radius)] bg-secondary mb-2" />
                      )}
                      <span className="t-field-value block truncate">{buildTitle(p)}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggle(p.id)}
                      className="t-helper mt-1 block hover:underline"
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
                    <td colSpan={profiles.length + 1} className="pt-7 pb-2">
                      {/* A real band, not a faint caption. The old headings were
                          t-micro-label on white and vanished into the rows they
                          were meant to separate - in a table this long, the
                          group is the only thing telling a parent what they are
                          looking at. */}
                      <div className="flex items-center gap-3">
                        <span className="font-heading text-base text-foreground">{group}</span>
                        <span className="h-px flex-1 bg-border" />
                      </div>
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
                        className="border-t border-border/60 hover:bg-secondary/40 transition-colors"
                        data-testid={`compare-row-${row.label.toLowerCase().replace(/\s+/g, "-")}`}
                        data-identical={identical ? "true" : "false"}
                      >
                        <td className="py-2.5 pr-4 align-top">
                          <span className="t-field-label break-words">{row.label}</span>
                        </td>
                        {row.values.map((value, i) => (
                          <td key={profiles[i]?.id ?? i} className="py-2.5 pr-4 align-top">
                            <span className={cn("t-micro-value break-words", identical && "opacity-55")}>
                              {value ?? <span className="opacity-30">-</span>}
                            </span>
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

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
                    {getPhotoSrc(a.photoUrl || a.photos?.[0]) && (
                      <img src={getPhotoSrc(a.photoUrl || a.photos?.[0])!} alt="" className="w-6 h-6 rounded-full object-cover object-top" />
                    )}
                    <span className="t-micro-value">{buildTitle(a)}</span>
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
