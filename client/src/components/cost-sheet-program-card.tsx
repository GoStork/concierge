import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, Circle, MessageSquare } from "lucide-react";
import { getCountryFlag } from "@/lib/country-flag";
import { formatMoneyDollars } from "@/lib/format-money";
import { cn } from "@/lib/utils";

/**
 * Parent-facing card representing one of a clinic's cost-sheet programs.
 * Matches the layout in the user-provided screenshots: country flag header
 * with program-number pill, title, big total price, and a breakdown of
 * line items with check/circle status icons.
 */

export interface ProgramCardLineItem {
  category: string;
  key: string;
  minValue: number | null;
  maxValue: number | null;
  isIncluded: boolean;
  comment: string | null;
}

export interface ProgramCardData {
  programId: string;
  programName: string;
  country: string;
  tab: string | null;
  subType: string | null;
  subTypeLabel: string | null;
  tabLabel: string | null;
  isFixedCost: boolean | null;
  minTotal: number;
  maxTotal: number;
  lineItems: ProgramCardLineItem[];
}

function formatItemValue(item: ProgramCardLineItem): string {
  const min = item.minValue ?? 0;
  const max = item.maxValue ?? min;
  if (min === 0 && max === 0) return "Included";
  if (min === max) return formatMoneyDollars(min);
  if (min === 0) return `Up to ${formatMoneyDollars(max)}`;
  return `${formatMoneyDollars(min)} - ${formatMoneyDollars(max)}`;
}

function formatTotal(min: number, max: number): string {
  if (min === max) return formatMoneyDollars(min);
  if (min === 0) return formatMoneyDollars(max);
  return `${formatMoneyDollars(min)} - ${formatMoneyDollars(max)}`;
}

export function CostSheetProgramCard({
  program,
}: {
  program: ProgramCardData;
  // index is still accepted by callers (kept in the type) but no longer shown.
  index?: number;
}) {
  const flag = getCountryFlag(program.country);

  return (
    <Card
      className="border border-[hsl(var(--brand-success))]/40 overflow-hidden h-full flex flex-col"
      data-testid={`program-card-${program.programId}`}
    >
      <CardContent className="p-0 flex flex-col h-full">
        {/* Program name leads (full first row); flag + country + total below. */}
        <div className="px-5 pt-5 pb-4">
          <h3 className="font-heading text-lg text-foreground leading-snug" data-testid="program-name">
            {program.programName}
          </h3>
          {program.subTypeLabel && (
            <p className="t-helper mt-0.5">{program.subTypeLabel}</p>
          )}
          <div className="flex items-center justify-between gap-3 mt-3">
            <div className="flex items-center gap-2 min-w-0">
              {flag ? <span className="text-xl shrink-0" aria-hidden>{flag}</span> : null}
              <span className="font-heading text-base text-foreground truncate" data-testid="program-country">
                {program.country}
              </span>
            </div>
            <p className="text-3xl font-heading text-primary shrink-0" data-testid="program-total">
              {formatTotal(program.minTotal, program.maxTotal)}
            </p>
          </div>
        </div>

        <div className="border-t border-border/60 px-5 py-4 space-y-2 flex-1">
          {program.lineItems.map((item, idx) => {
            const label = `${item.category && item.category !== "Medical" ? "" : "IVF - "}${item.key}`;
            const cleanLabel = label.replace(/^IVF -\s*/, "").trim();
            const value = formatItemValue(item);
            return (
              <div
                key={`${item.category}-${item.key}-${idx}`}
                className="flex items-start justify-between gap-3 text-sm"
                data-testid={`line-${idx}`}
              >
                <div className="flex items-start gap-2 flex-1 min-w-0">
                  {item.isIncluded ? (
                    <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-[hsl(var(--brand-success))]" />
                  ) : (
                    <Circle className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground/50" />
                  )}
                  <span className={cn("text-foreground", !item.isIncluded && "text-muted-foreground")}>
                    {cleanLabel}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className={cn("tabular-nums text-foreground", !item.isIncluded && "text-muted-foreground")}>
                    {value}
                  </span>
                  {item.comment && (
                    <span title={item.comment} className="text-accent/70">
                      <MessageSquare className="w-3.5 h-3.5" />
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
