/**
 * The shell every provider list page shares.
 *
 * /provider/invoices, /cost-sheets, /agreements and /payouts are the same
 * page four times over: a title, a row of summary figures, a filter row, and
 * one table. Each had grown its own copy - different stat-card classes,
 * hand-rolled <select> filters, and four subtly different tables - so a fix
 * to one never reached the others.
 *
 * The filter controls live in ./filter-controls (shared with the parents
 * tables); this module owns the page frame and the table chrome.
 */
import { type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { ClearFiltersButton } from "@/components/clear-filters-button";
import { FilterRow } from "@/components/ui/filter-controls";

export function ListPageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h1 className="text-2xl font-heading font-bold">{title}</h1>
      <p className="t-helper mt-1">{subtitle}</p>
    </div>
  );
}

/** Summary figures. Two or three across on desktop, stacked on a phone. */
export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">{children}</div>;
}

export function StatCard({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <div
      className="rounded-[var(--container-radius)] border border-border bg-card shadow-sm p-4 space-y-1"
      data-testid={testId}
    >
      <p className="t-micro-label">{label}</p>
      <p className="text-2xl font-heading font-bold">{value}</p>
    </div>
  );
}

/** Filter row with the Clear button pinned to the right, as on the parents tables. */
export function ListFilterBar({
  children, showClear, onClear, testId,
}: { children: ReactNode; showClear: boolean; onClear: () => void; testId?: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <FilterRow>{children}</FilterRow>
      <ClearFiltersButton pill show={showClear} onClick={onClear} testId={testId} />
    </div>
  );
}

/**
 * The house table chrome: a card that clips its own horizontal scroller, so
 * a wide table scrolls inside the card instead of pushing the page sideways.
 * Callers supply <thead>/<tbody> and use SortableTableHead for the headers.
 */
export function TableShell({ minWidth = 640, children }: { minWidth?: number; children: ReactNode }) {
  return (
    <div className="rounded-[var(--container-radius)] border border-border overflow-hidden bg-card shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth }}>{children}</table>
      </div>
    </div>
  );
}

/** The muted header strip. SortableTableHead cells go inside. */
export function TableHeadRow({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-border bg-muted">{children}</tr>
    </thead>
  );
}

/** Standard body row: hairline separator, hover tint, optional click. */
export function TableBodyRow({
  children, onClick, className, testId, title,
}: { children: ReactNode; onClick?: () => void; className?: string; testId?: string; title?: string }) {
  return (
    <tr
      className={`border-b last:border-0 transition-colors hover:bg-muted/50 ${onClick ? "cursor-pointer" : ""} ${className || ""}`}
      onClick={onClick}
      data-testid={testId}
      title={title}
    >
      {children}
    </tr>
  );
}

/** Spinner and empty state, so all four pages phrase them identically. */
export function ListLoading() {
  return (
    <div className="flex justify-center py-12">
      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
    </div>
  );
}

export function ListEmpty({ icon, message }: { icon: ReactNode; message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      {icon}
      <p className="t-helper">{message}</p>
    </div>
  );
}
