/**
 * Standard "reset all filters" button for list/table filter bars.
 *
 * Two visual variants, matching the two filter-bar styles in the app:
 * - default: labeled outline button ("x Clear") for form-style filter rows
 *   (billing, invoices, payouts, cost sheets, agreements)
 * - pill: compact icon-only ghost pill for pill-style filter rows
 *   (Parents, Providers, doctor records, conversations)
 *
 * Renders nothing when `show` is false so callers can pass their
 * hasActiveFilters expression directly.
 */
import { X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ClearFiltersButton({
  show = true,
  onClick,
  testId = "button-clear-filters",
  pill = false,
}: {
  show?: boolean;
  onClick: () => void;
  testId?: string;
  pill?: boolean;
}) {
  if (!show) return null;
  if (pill) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        className="text-muted-foreground hover:text-foreground h-8 px-2 shrink-0 rounded-full"
        aria-label="Clear filters"
        data-testid={testId}
      >
        <XCircle className="w-4 h-4" />
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="h-9 gap-1.5 shrink-0"
      data-testid={testId}
    >
      <X className="w-3.5 h-3.5" /> Clear
    </Button>
  );
}
