import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ChevronRight, Loader2, X } from "lucide-react";

// Shared building blocks for the Home dashboards (parent /home, provider
// /provider/home, admin /admin/home): the amber action-queue row and the
// section header with a View-all link. One implementation so the three
// dashboards never drift.

export function QueueRow({ icon, title, detail, cta, onClick, action, onDismiss }: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  cta: string;
  onClick: () => void;
  /** Optional inline primary action (e.g. "Retry" on a failed payout) rendered before the cta link. */
  action?: { label: string; onClick: () => void; loading?: boolean };
  /** Optional dismiss handler - renders a small X that removes the row from the queue. */
  onDismiss?: () => void;
}) {
  return (
    <div className="w-full flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border bg-[hsl(var(--brand-warning)/0.06)] border-[hsl(var(--brand-warning)/0.25)] hover:bg-[hsl(var(--brand-warning)/0.12)] transition-colors">
      <button onClick={onClick} className="flex-1 min-w-0 flex items-center gap-3 text-left">
        <span className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-[hsl(var(--brand-warning)/0.15)] text-[hsl(var(--brand-warning))]">
          {icon}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium truncate">{title}</span>
          <span className="block text-xs text-muted-foreground truncate">{detail}</span>
        </span>
      </button>
      {action && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 text-xs"
          disabled={action.loading}
          onClick={action.onClick}
        >
          {action.loading && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
          {action.label}
        </Button>
      )}
      <button onClick={onClick} className="text-xs font-semibold shrink-0 flex items-center gap-0.5" style={{ color: "hsl(var(--primary))" }}>
        {cta}
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="shrink-0 p-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--brand-warning)/0.2)]"
          aria-label="Dismiss"
          title="Dismiss - hide this item"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

export function SectionHeader({ icon, title, viewAllTo, viewAllLabel = "View all" }: { icon: React.ReactNode; title: string; viewAllTo?: string; viewAllLabel?: string }) {
  return (
    // min-h-8 matches the height a "View all" button gives the row, so a
    // section with the link and one without still line up side by side.
    <div className="flex items-center justify-between min-h-8">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-lg font-heading">{title}</h2>
      </div>
      {viewAllTo && (
        <Button variant="ghost" size="sm" asChild>
          <Link to={viewAllTo} className="text-xs">
            {viewAllLabel}
            <ChevronRight className="w-3.5 h-3.5 ml-0.5" />
          </Link>
        </Button>
      )}
    </div>
  );
}

export function StatTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-[var(--radius)] border p-3 bg-secondary/40">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-lg font-heading font-bold">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
