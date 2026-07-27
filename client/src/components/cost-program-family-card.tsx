import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, Circle, MessageSquare } from "lucide-react";
import { getCountryFlag } from "@/lib/country-flag";
import { formatMoneyDollars } from "@/lib/format-money";
import { formatFieldLabel } from "@/lib/format-label";
import type { ProgramCardData, ProgramCardLineItem } from "@/components/cost-sheet-program-card";
import { cn } from "@/lib/utils";

/**
 * Several variants of ONE product, as a price ladder plus what they share.
 *
 * PFCLA published four programs - one, two, three and unlimited transfers - as
 * four cards of ~14 rows each, of which almost every row was identical. That
 * asks a parent to diff 56 lines by hand to find four numbers, at the exact
 * moment cost is the thing making them stall.
 *
 * Only variants of the same product are merged (same tab + subtype + country).
 * Genuinely different products - Fixed vs Regular Egg Donation - stay separate
 * cards, because merging them would imply they are interchangeable options when
 * they carry different terms.
 *
 * A row only moves into the shared block when it is identical in EVERY variant.
 * Anything that differs stays visible against its own variant, so collapsing
 * can never hide a real difference.
 */

function itemValue(item: ProgramCardLineItem): string {
  const min = item.minValue ?? 0;
  const max = item.maxValue ?? min;
  if (min === 0 && max === 0) return "Included";
  if (min === max) return formatMoneyDollars(min);
  if (min === 0) return `Up to ${formatMoneyDollars(max)}`;
  return `${formatMoneyDollars(min)} - ${formatMoneyDollars(max)}`;
}

function total(min: number, max: number): string {
  if (min === max) return formatMoneyDollars(min);
  if (min === 0) return formatMoneyDollars(max);
  return `${formatMoneyDollars(min)} - ${formatMoneyDollars(max)}`;
}

const itemKey = (i: ProgramCardLineItem) => `${i.category}::${i.key}`;
const itemSignature = (i: ProgramCardLineItem) => `${itemKey(i)}::${i.minValue ?? ""}::${i.maxValue ?? ""}::${i.isIncluded}`;

/** The part of each program name that differs, e.g. "One Cycle" / "Two Cycles". */
function variantLabels(names: string[]): string[] {
  if (names.length < 2) return names;
  const words = names.map((n) => n.split(/\s+/));
  let shared = 0;
  while (words.every((w) => w[shared] && w[shared] === words[0][shared]) && shared < words[0].length - 1) shared++;
  const trimmed = words.map((w) => w.slice(shared).join(" ").replace(/^[-·:]\s*/, "").trim());
  // If trimming left anything empty, the names weren't a common family - keep them whole.
  return trimmed.some((t) => !t) ? names : trimmed;
}

function LineRow({ item }: { item: ProgramCardLineItem }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-2 flex-1 min-w-0">
        {item.isIncluded ? (
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-[hsl(var(--brand-success))]" />
        ) : (
          <Circle className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground/50" />
        )}
        <span className={cn("t-micro-value", !item.isIncluded && "opacity-60")}>
          {formatFieldLabel(item.key)}
        </span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={cn("t-micro-value tabular-nums text-right", !item.isIncluded && "opacity-60")}>
          {itemValue(item)}
        </span>
        <span className="w-3.5 shrink-0 flex justify-center" aria-hidden={!item.comment}>
          {item.comment && (
            <span title={item.comment} className="text-accent/70"><MessageSquare className="w-3.5 h-3.5" /></span>
          )}
        </span>
      </div>
    </div>
  );
}

export function CostProgramFamilyCard({ programs }: { programs: ProgramCardData[] }) {
  const first = programs[0];
  const flag = getCountryFlag(first.country);
  const labels = variantLabels(programs.map((p) => p.programName));

  // Identical in every variant -> shared. Anything else stays with its variant.
  const counts = new Map<string, number>();
  for (const p of programs) {
    for (const sig of new Set(p.lineItems.map(itemSignature))) {
      counts.set(sig, (counts.get(sig) || 0) + 1);
    }
  }
  const isShared = (i: ProgramCardLineItem) => counts.get(itemSignature(i)) === programs.length;

  const sharedItems = first.lineItems.filter(isShared);
  const sharedIncluded = sharedItems.filter((i) => i.isIncluded);
  const sharedExtra = sharedItems.filter((i) => !i.isIncluded);
  const perVariantItems = programs.map((p) => p.lineItems.filter((i) => !isShared(i)));

  return (
    <Card className="border border-[hsl(var(--brand-success))]/40 overflow-hidden" data-testid={`program-family-${first.programId}`}>
      <CardContent className="p-0">
        <div className="px-5 pt-5 pb-3">
          <h3 className="font-heading text-lg text-foreground leading-snug" data-testid="family-name">
            {first.subTypeLabel || first.programName}
          </h3>
          <div className="flex items-center gap-2 mt-1">
            {flag ? <span className="text-base shrink-0" aria-hidden>{flag}</span> : null}
            <span className="t-helper">{first.country}</span>
          </div>
        </div>

        {/* The price ladder - the only thing that actually differs. */}
        <div className="px-5 pb-4">
          {programs.map((p, i) => (
            <div key={p.programId} className="flex items-baseline justify-between gap-4 py-2.5 border-b border-border/60 last:border-0" data-testid={`family-option-${i}`}>
              <div className="min-w-0">
                <span className="t-micro-value">{labels[i]}</span>
                {perVariantItems[i].length > 0 && (
                  <div className="mt-1.5 space-y-1">
                    {perVariantItems[i].map((item, j) => <LineRow key={j} item={item} />)}
                  </div>
                )}
              </div>
              <span className="font-heading text-xl text-primary shrink-0 tabular-nums">
                {total(p.minTotal, p.maxTotal)}
              </span>
            </div>
          ))}
        </div>

        {sharedIncluded.length > 0 && (
          <div className="mx-5 mb-4 rounded-[var(--radius)] bg-secondary/60 px-4 py-3" data-testid="family-shared-included">
            <p className="t-micro-label mb-1.5">Included in every option</p>
            <p className="t-micro-value">
              {sharedIncluded.map((i) => formatFieldLabel(i.key)).join(" · ")}
            </p>
          </div>
        )}

        {sharedExtra.length > 0 && (
          <div className="px-5 pb-5" data-testid="family-shared-extra">
            <p className="t-micro-label mb-2">Not included, in every option</p>
            <div className="space-y-1.5">
              {sharedExtra.map((item, i) => <LineRow key={i} item={item} />)}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Group programs into families. Same tab + subtype + country + item shape is one
 * product in several sizes; anything else is its own product.
 */
export function groupProgramFamilies(programs: ProgramCardData[]): ProgramCardData[][] {
  const groups = new Map<string, ProgramCardData[]>();
  for (const p of programs) {
    const key = [p.tab ?? "", p.subType ?? "", p.country ?? "", p.isFixedCost ? "fixed" : "var"].join("::");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  return Array.from(groups.values());
}
