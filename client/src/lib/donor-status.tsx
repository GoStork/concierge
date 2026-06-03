import { ReactNode } from "react";

// Canonical donor/surrogate statuses surfaced to the UI. INACTIVE is omitted
// here because INACTIVE rows are never rendered (marketplace / chat / AI all
// filter them out at the API layer); if you see "INACTIVE" land in the UI,
// something upstream is leaking.
export type DonorStatus = "AVAILABLE" | "PENDING" | "MATCHED";

export interface StatusBadgeStyle {
  label: string;
  description: string;       // tooltip / aria-label
  pillClassName: string;     // background+text for the small status pill
  dotClassName: string;      // background for the tiny status dot
}

const STYLES: Record<DonorStatus, StatusBadgeStyle> = {
  AVAILABLE: {
    label: "Available",
    description: "Available now",
    pillClassName: "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))]",
    dotClassName: "bg-[hsl(var(--brand-success))]",
  },
  PENDING: {
    label: "Pending",
    description: "Pending availability - not yet approved",
    pillClassName: "bg-[hsl(var(--brand-warning)/0.15)] text-[hsl(var(--brand-warning))]",
    dotClassName: "bg-[hsl(var(--brand-warning))]",
  },
  MATCHED: {
    label: "Matched",
    description: "Matched with another family",
    pillClassName: "bg-muted text-muted-foreground",
    dotClassName: "bg-muted-foreground/50",
  },
};

export function getDonorStatusStyle(status: string | null | undefined): StatusBadgeStyle | null {
  if (!status) return null;
  return STYLES[status as DonorStatus] || null;
}

// Render the small status pill next to a donor/surrogate name. Returns null
// for AVAILABLE (no pill needed - presence on the list is the signal) and
// for null status (status not yet resolved).
export function DonorStatusPill({ status, className }: { status: string | null | undefined; className?: string }): ReactNode {
  const style = getDonorStatusStyle(status);
  if (!style || status === "AVAILABLE") return null;
  return (
    <span
      className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0 whitespace-nowrap ${style.pillClassName} ${className || ""}`}
      title={style.description}
      data-testid={`donor-status-pill-${status.toLowerCase()}`}
    >
      {style.label}
    </span>
  );
}
