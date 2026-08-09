/**
 * THE list-page header. Title in the brand display face at page-title size,
 * subtitle under it, optional action on the right.
 *
 * The Parents and Providers pages had this shape; Billing, Agreements and
 * Journey Analytics each wrote their own `text-2xl font-heading font-bold`
 * heading inside a `max-w-6xl mx-auto` column, so the same product read as two
 * different apps depending on which nav item you clicked. Brand typography
 * tokens only - never a hardcoded size.
 */
import { type ReactNode } from "react";

export function PageHeader({ title, subtitle, action, testId = "text-page-title" }: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <h1 className="font-display t-page-title text-primary" data-testid={testId}>{title}</h1>
        {subtitle && <p className="text-muted-foreground">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * The white card a table sits in: rounded, hairline border, clipped corners,
 * and it dims while a background refetch is in flight so a stale table is
 * visibly stale instead of silently wrong.
 */
export function TableShell({ children, busy = false, className }: {
  children: ReactNode;
  busy?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`bg-card rounded-[var(--radius)] border border-border/50 shadow-sm overflow-hidden transition-opacity ${busy ? "opacity-60" : ""} ${className || ""}`}
    >
      {children}
    </div>
  );
}
