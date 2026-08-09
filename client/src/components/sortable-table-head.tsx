import * as React from "react";
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
   * Where the label sits in the cell. Money and count columns are right
   * aligned and centered checkmark columns exist too - the arrow has to
   * follow the label or the header stops lining up with its own data.
   */
  align?: "left" | "right" | "center";
  /** For a pinned column that needs an edge shadow the class layer cannot express. */
  style?: React.CSSProperties;
  "data-testid"?: string;
};

const ALIGN_CLASS = { left: "justify-start", right: "justify-end", center: "justify-center" } as const;

export function SortableTableHead({ label, sortKey, currentSort, onSort, className, align = "left", style, ...props }: Props) {
  const isActive = currentSort.key === sortKey;
  const direction = isActive ? currentSort.direction : null;

  return (
    <TableHead
      className={`cursor-pointer select-none transition-colors ${className || ""}`}
      style={style}
      onClick={() => onSort(sortKey)}
      data-testid={props["data-testid"]}
    >
      <div className={`flex items-center gap-1 whitespace-nowrap ${ALIGN_CLASS[align]}`}>
        <span>{label}</span>
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
