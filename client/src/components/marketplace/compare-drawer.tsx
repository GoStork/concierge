import { Fragment } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatMoneyDollars } from "@/lib/format-money";
import { formatLocationDisplay } from "@/lib/format-location";
import { getPhotoSrc } from "@/lib/profile-utils";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { formatStatusLabel } from "@/lib/format-label";
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

export type CompareKind = "egg-donor" | "surrogate" | "sperm-donor";

type Row = { label: string; get: (p: any) => string | null };

const money = (v: unknown): string | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? formatMoneyDollars(n) : null;
};
const text = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s && s !== "-" && s !== "--" ? s : null;
};

export function rowsFor(kind: CompareKind): { group: string; rows: Row[] }[] {
  const cost: Row[] = kind === "surrogate"
    ? [
        { label: "Total cost", get: (p) => {
          const min = money(p.totalCostMin), max = money(p.totalCostMax);
          return min && max && min !== max ? `${min} - ${max}` : (min || max || money(p.totalCost));
        } },
        { label: "Base compensation", get: (p) => money(p.baseCompensation) },
      ]
    : [
        { label: "Total cost", get: (p) => money(p.totalCost) },
        { label: "Compensation", get: (p) => money(p.donorCompensation) },
      ];

  const decide: Row[] = [
    ...cost,
    { label: "Availability", get: (p) => formatStatusLabel(text(p.donorStatus)) || (p.available === false ? "Not available" : "Available") },
    { label: "Last updated", get: (p) => formatRelativeTime(p.updatedAt) },
    { label: "Age", get: (p) => (p.age ? `${p.age}` : null) },
    { label: "Location", get: (p) => formatLocationDisplay(text(p.location)) || text(p.location) },
  ];

  const traits: Row[] = [
    { label: "Height", get: (p) => text(p.height) },
    { label: "Eye colour", get: (p) => text(p.eyeColor) },
    { label: "Hair colour", get: (p) => text(p.hairColor) },
    { label: "Race", get: (p) => text(p.race) },
    { label: "Ethnicity", get: (p) => text(p.ethnicity) },
  ];

  const proven: Row[] = kind === "surrogate"
    ? [
        { label: "Live births", get: (p) => (p.liveBirths != null ? String(p.liveBirths) : null) },
        { label: "C-sections", get: (p) => (p.cSections != null ? String(p.cSections) : null) },
        { label: "BMI", get: (p) => (p.bmi != null ? String(p.bmi) : null) },
      ]
    : [
        { label: "Previously donated", get: (p) => (p.statusBadge === "Experienced" ? "Yes" : null) },
        { label: "Eggs retrieved", get: (p) => (p.numberOfEggs != null ? String(p.numberOfEggs) : null) },
      ];

  const background: Row[] = [
    { label: "Education", get: (p) => text(p.education) },
    { label: "Occupation", get: (p) => text(p.occupation) },
  ];

  return [
    { group: "Cost & availability", rows: decide },
    { group: "Physical traits", rows: traits },
    { group: "Proven history", rows: proven },
    { group: "Background", rows: background },
  ];
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
export function buildCompareTable(kind: CompareKind, profiles: any[]): CompareTableGroup[] {
  return rowsFor(kind)
    .map(({ group, rows }) => ({
      group,
      rows: rows
        .filter((r) => profiles.some((p) => r.get(p)))
        .map((r) => ({ label: r.label, values: profiles.map((p) => r.get(p)) })),
    }))
    .filter((g) => g.rows.length > 0);
}

export function CompareDrawer({
  kind,
  profiles,
  available,
  onToggle,
  onClose,
  onOpenProfile,
}: {
  kind: CompareKind;
  profiles: SwipeDeckProfile[];
  /** Everything saved in this tab, so columns can be swapped without leaving. */
  available: SwipeDeckProfile[];
  onToggle: (id: string) => void;
  onClose: () => void;
  onOpenProfile: (profile: any) => void;
}) {
  if (profiles.length === 0) return null;
  const groups = buildCompareTable(kind, profiles as any[]);

  return (
    <div className="fixed inset-0 z-50 bg-background overflow-auto" data-testid="compare-drawer">
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 py-3 flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-heading">Comparing {profiles.length}</h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close comparison" data-testid="compare-close">
          <X className="w-5 h-5" />
        </Button>
      </div>

      <div className="p-4 max-w-[1200px] mx-auto">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse" data-testid="compare-table">
            <thead>
              <tr>
                <th className="w-[132px]" />
                {profiles.map((p: any) => (
                  <th key={p.id} className="p-2 align-bottom min-w-[150px] text-left font-normal">
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
                    <td colSpan={profiles.length + 1} className="pt-5 pb-1">
                      <span className="t-micro-label">{group}</span>
                    </td>
                  </tr>
                  {rows.map((row) => (
                    <tr key={row.label} className="border-t border-border/60" data-testid={`compare-row-${row.label.toLowerCase().replace(/\s+/g, "-")}`}>
                      <td className="py-2.5 pr-3 align-top"><span className="t-field-label">{row.label}</span></td>
                      {row.values.map((value, i) => (
                        <td key={profiles[i]?.id ?? i} className="py-2.5 pr-3 align-top">
                          <span className="t-micro-value">{value ?? <span className="opacity-40">-</span>}</span>
                        </td>
                      ))}
                    </tr>
                  ))}
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
