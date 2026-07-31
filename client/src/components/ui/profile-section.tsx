import * as React from "react";
import { ChevronDown } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface ProfileSectionProps {
  /** Section title shown in the header bar. */
  title: React.ReactNode;
  /** Section body. Wrapped in a padded container (see contentClassName). */
  children: React.ReactNode;
  /** Extra classes for the outer Card (e.g. a custom border). */
  className?: string;
  /** Content wrapper classes. Defaults to "p-6". Pass e.g. "p-6 space-y-3". */
  contentClassName?: string;
  /** Optional node rendered on the right side of the header bar. */
  headerActions?: React.ReactNode;
  /**
   * Turn the header bar into a toggle and hide the body when closed. Off by
   * default, so every existing profile page renders exactly as before. Added
   * so the parent record could stop hand-rolling its own section header - the
   * warning above is only enforceable if this covers the collapsing case too.
   */
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  "data-testid"?: string;
}

/**
 * Shared section card used across every provider/profile detail page (IVF
 * clinics, doctors, surrogates, egg donors, sperm donors). One source of truth
 * for the section shape, header bar, and colors so every profile type renders
 * identically. Do not re-implement a local SectionHeader anywhere - use this.
 */
export function ProfileSection({
  title,
  children,
  className,
  contentClassName = "p-6",
  headerActions,
  collapsible = false,
  open = true,
  onToggle,
  ...rest
}: ProfileSectionProps) {
  const testId = rest["data-testid"];
  const heading = (
    <h3
      className="font-heading text-foreground truncate"
      style={{ fontSize: "var(--section-title-size)", fontWeight: "var(--section-title-weight)" as any }}
      data-testid={
        typeof title === "string"
          ? `section-header-${title.toLowerCase().replace(/\s+/g, "-")}`
          : undefined
      }
    >
      {title}
    </h3>
  );

  return (
    <Card className={cn("overflow-hidden", className)} data-testid={testId}>
      {/* Wraps: headerActions can be as wide as a lead-owner control with a
          name and a button, which on a phone sat on top of the title. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 border-b bg-muted/50">
        {collapsible ? (
          // The whole bar is the target, not just the chevron - a 3px icon is
          // a poor place to make someone aim.
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex-1 min-w-0 flex items-center gap-2 px-5 py-3.5 text-left hover:bg-muted transition-colors"
            data-testid={testId ? `${testId}-toggle` : undefined}
          >
            <ChevronDown className={cn("w-4 h-4 shrink-0 transition-transform", !open && "-rotate-90")} />
            {heading}
          </button>
        ) : (
          <div className="flex-1 min-w-0 px-5 py-3.5">{heading}</div>
        )}
        {headerActions && <div className="px-5 pb-3.5 pt-0 sm:pt-3.5 sm:pl-0 shrink-0">{headerActions}</div>}
      </div>
      {(!collapsible || open) && <div className={contentClassName}>{children}</div>}
    </Card>
  );
}
