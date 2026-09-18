import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ChevronRight, Loader2, X } from "lucide-react";

// Shared building blocks for the Home dashboards (parent /home, provider
// /provider/home, admin /admin/home): the amber action-queue row and the
// section header with a View-all link. One implementation so the three
// dashboards never drift.

export function QueueRow({ icon, title, detail, cta, onClick, action, onDismiss, tone = "notification" }: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  cta: string;
  onClick: () => void;
  /** Optional inline primary action (e.g. "Retry" on a failed payout) rendered before the cta link. */
  action?: { label: string; onClick: () => void; loading?: boolean };
  /** Optional dismiss handler - renders a small X that removes the row from the queue. */
  onDismiss?: () => void;
  /** "task" = actionable work, brand-teal tint (same green as the Tasks panel
   *  on a parent record). "notification" = informational, the amber default. */
  tone?: "notification" | "task";
}) {
  const isTask = tone === "task";
  const rowClasses = isTask
    ? "bg-[hsl(var(--primary)/0.06)] border-[hsl(var(--primary)/0.18)] hover:bg-[hsl(var(--primary)/0.12)]"
    : "bg-[hsl(var(--brand-warning)/0.06)] border-[hsl(var(--brand-warning)/0.25)] hover:bg-[hsl(var(--brand-warning)/0.12)]";
  const iconClasses = isTask
    ? "bg-[hsl(var(--primary)/0.15)] text-[hsl(var(--primary))]"
    : "bg-[hsl(var(--brand-warning)/0.15)] text-[hsl(var(--brand-warning-text))]";
  return (
    <div className={`w-full flex items-center gap-2 pl-4 pr-2 py-2 rounded-[var(--radius)] border transition-colors ${rowClasses}`}>
      {/* ONE control per row. The title and the CTA used to be two buttons
          with the same onClick: two tab stops per row, a 60x16px second
          target, and an accessible name that ran title into detail with no
          pause. Now the whole row is the button, 44px tall, with the CTA
          drawn inside it as presentation and the brand focus ring. */}
      <button
        type="button"
        onClick={onClick}
        className="flex-1 min-w-0 min-h-11 flex items-center gap-3 text-left rounded-[var(--radius)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${iconClasses}`} aria-hidden="true">
          {icon}
        </span>
        <span className="flex-1 min-w-0 py-0.5">
          {/* Two lines, not one: on a 375px phone the title column is about
              115px wide and a one-line truncate cut "Start exploring profiles
              for your Surrogacy journey" and "...Egg Donation journey" to the
              same "Start exploring ...". */}
          <span className="text-sm font-medium leading-5 line-clamp-2 [overflow-wrap:anywhere]">{title}</span>
          <span className="sr-only">. </span>
          <span className="t-helper line-clamp-2 [overflow-wrap:anywhere]">{detail}</span>
        </span>
        <span className="text-xs font-semibold shrink-0 flex items-center gap-0.5 pl-1 text-primary" aria-hidden="true">
          {cta}
          <ChevronRight className="w-3.5 h-3.5" />
        </span>
      </button>
      {action && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 text-xs"
          disabled={action.loading}
          onClick={action.onClick}
        >
          {action.loading && <Loader2 className="w-3 h-3 mr-1 animate-spin" aria-hidden="true" />}
          {action.label}
        </Button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className={`shrink-0 w-9 h-9 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isTask ? "hover:bg-[hsl(var(--primary)/0.2)]" : "hover:bg-[hsl(var(--brand-warning)/0.2)]"}`}
          aria-label={`Dismiss: ${title}`}
          title="Dismiss - hide this item"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function SectionHeader({ icon, title, viewAllTo, viewAllLabel = "View all", id }: { icon: React.ReactNode; title: string; viewAllTo?: string; viewAllLabel?: string; id?: string }) {
  return (
    // min-h-8 matches the height a "View all" button gives the row, so a
    // section with the link and one without still line up side by side.
    <div className="flex items-center justify-between gap-3 min-h-8">
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 flex" aria-hidden="true">{icon}</span>
        <h2 id={id} className="t-section-title font-heading leading-tight">{title}</h2>
      </div>
      {viewAllTo && (
        <Button variant="ghost" size="sm" asChild className="shrink-0">
          {/* Three "View all" links on one page read identically to a screen
              reader; the label names the section the link leads to. */}
          <Link to={viewAllTo} className="text-xs" aria-label={`${viewAllLabel}: ${title}`}>
            {viewAllLabel}
            <ChevronRight className="w-3.5 h-3.5 ml-0.5" aria-hidden="true" />
          </Link>
        </Button>
      )}
    </div>
  );
}

export function StatTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-[var(--radius)] border p-3 bg-secondary/40">
      <p className="t-micro-label">{label}</p>
      <p className="text-lg font-heading font-bold">{value}</p>
      {hint && <p className="t-helper">{hint}</p>}
    </div>
  );
}
