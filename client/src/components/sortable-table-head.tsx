import { useState } from "react";
import { TableHead } from "@/components/ui/table";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

export type SortDirection = "asc" | "desc" | null;
export type SortConfig = { key: string; direction: SortDirection };

type Props = {
  label: string;
  sortKey: string;
  currentSort: SortConfig;
  onSort: (key: string) => void;
  className?: string;
  /**
   * Let a two-word label wrap instead of forcing its column as wide as the
   * header text. Off by default so every existing table is untouched; worth
   * turning on where the header is the widest thing in a narrow column.
   */
  wrapLabel?: boolean;
  "data-testid"?: string;
};

export function SortableTableHead({ label, sortKey, currentSort, onSort, className, wrapLabel, ...props }: Props) {
  const isActive = currentSort.key === sortKey;
  const direction = isActive ? currentSort.direction : null;

  return (
    <TableHead
      className={`cursor-pointer select-none transition-colors ${className || ""}`}
      onClick={() => onSort(sortKey)}
      data-testid={props["data-testid"]}
    >
      {/* A wrapping label stays a flex item so the arrow sits beside it, not
          under it - but it needs w-min, or the label box keeps the column's
          full width and strands the arrow at the far edge with a gap. w-min
          shrinks the box to the longest word, so the arrow lands right after
          the text and every header's arrow reads the same way. */}
      <div className={`flex items-center gap-1 ${wrapLabel ? "leading-tight" : "whitespace-nowrap"}`}>
        <span className={wrapLabel ? "w-min" : undefined}>{label}</span>
        {direction === "asc" ? (
          <ArrowUp className="w-3.5 h-3.5 shrink-0 text-foreground/70" />
        ) : direction === "desc" ? (
          <ArrowDown className="w-3.5 h-3.5 shrink-0 text-foreground/70" />
        ) : (
          <ArrowUpDown className="w-3.5 h-3.5 shrink-0 text-foreground/40" />
        )}
      </div>
    </TableHead>
  );
}

export function useTableSort(defaultKey = "", defaultDir: SortDirection = null) {
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: defaultKey, direction: defaultDir });

  function handleSort(key: string) {
    setSortConfig(prev => {
      if (prev.key === key) {
        if (prev.direction === "asc") return { key, direction: "desc" };
        if (prev.direction === "desc") return { key: "", direction: null };
        return { key, direction: "asc" };
      }
      return { key, direction: "asc" };
    });
  }

  function sortData<T>(data: T[], getValue: (item: T, key: string) => string | number | null): T[] {
    if (!sortConfig.key || !sortConfig.direction) return data;
    return [...data].sort((a, b) => {
      const aVal = getValue(a, sortConfig.key);
      const bVal = getValue(b, sortConfig.key);
      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;
      const cmp = typeof aVal === "number" && typeof bVal === "number"
        ? aVal - bVal
        : String(aVal).localeCompare(String(bVal), undefined, { sensitivity: "base" });
      return sortConfig.direction === "asc" ? cmp : -cmp;
    });
  }

  return { sortConfig, handleSort, sortData };
}
