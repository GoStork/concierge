import { ReactNode } from "react";

// Canonical donor / surrogate / sperm-donor statuses surfaced to the UI.
// INACTIVE profiles never appear in marketplace/search results, but chat
// rows keep referencing a profile after it leaves the roster - those rows
// must communicate "no longer available" (red), not fall back to a mute
// gray that reads like nothing happened.
// PENDING and MATCHED apply to egg donors + surrogates; SOLD_OUT applies
// to sperm donors. AVAILABLE is universal.
// ON_HOLD: surrogates - a match call is scheduled or the 24h post-call
// decision hold is running; egg donors - a parent confirmed "I'm ready"
// after the consultation and their deposit invoice is live.
// IN_CYCLE applies to fresh egg donors only: the deposit was paid - she is
// in a donation cycle with a family and unavailable to everyone else.
export type DonorStatus = "AVAILABLE" | "ON_HOLD" | "PENDING" | "MATCHED" | "SOLD_OUT" | "INACTIVE" | "IN_CYCLE";

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
  ON_HOLD: {
    label: "On Hold",
    description: "On hold - a match call is in progress with another family",
    pillClassName: "bg-[hsl(var(--brand-warning)/0.15)] text-[hsl(var(--brand-warning))]",
    dotClassName: "bg-[hsl(var(--brand-warning))]",
  },
  PENDING: {
    label: "Pending",
    description: "Pending availability - not yet approved",
    pillClassName: "bg-[hsl(var(--brand-warning)/0.15)] text-[hsl(var(--brand-warning))]",
    dotClassName: "bg-[hsl(var(--brand-warning))]",
  },
  MATCHED: {
    label: "Matched",
    description: "Matched with a family",
    pillClassName: "bg-accent/15 text-[hsl(var(--accent))]",
    dotClassName: "bg-[hsl(var(--accent))]",
  },
  SOLD_OUT: {
    label: "Sold Out",
    description: "No vials currently in stock",
    pillClassName: "bg-destructive/15 text-destructive",
    dotClassName: "bg-destructive",
  },
  INACTIVE: {
    label: "No Longer Available",
    description: "This profile is no longer available",
    pillClassName: "bg-destructive/15 text-destructive",
    dotClassName: "bg-destructive",
  },
  IN_CYCLE: {
    label: "In Cycle",
    description: "In a donation cycle with a family",
    pillClassName: "bg-accent/15 text-[hsl(var(--accent))]",
    dotClassName: "bg-[hsl(var(--accent))]",
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
      data-testid={`donor-status-pill-${String(status).toLowerCase()}`}
    >
      {style.label}
    </span>
  );
}
