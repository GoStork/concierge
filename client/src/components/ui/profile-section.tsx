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
  /**
   * Force headerActions onto their own row instead of sitting beside the
   * title. Set it when this card lives in a narrow COLUMN rather than a
   * narrow screen - the `sm:` rule below keys off the viewport, so at 1512px
   * it happily puts a lead-owner control beside the title inside a 320px
   * rail and clips both.
   */
  denseHeader?: boolean;
  /**
   * Below lg, drop the card frame entirely - plain heading, bare children.
   * For pages whose MOBILE layout tabs between columns (the parent record):
   * there the tab already is the section, and nesting a framed section
   * inside it just spends screen width on a second border (HubSpot's mobile
   * record does the same - cards sit directly on the page background).
   * Only set this when the children carry their own card chrome. Desktop is
   * untouched.
   */
  frameless?: boolean;
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
  denseHeader = false,
  frameless = false,
  ...rest
}: ProfileSectionProps) {
  const testId = rest["data-testid"];
  const heading = (
    <h3
      // Wraps rather than truncating - a heading that silently loses its
      // last word is worse than a heading on two lines.
      className="font-heading text-foreground min-w-0 break-words"
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
    <Card
      className={cn(
        "overflow-hidden",
        frameless && "max-lg:border-0 max-lg:bg-transparent max-lg:shadow-none max-lg:rounded-none max-lg:overflow-visible",
        className,
      )}
      data-testid={testId}
    >
      {/* Wraps: headerActions can be as wide as a lead-owner control with a
          name and a button, which on a phone sat on top of the title. */}
      <div className={cn("flex flex-wrap items-center justify-between gap-x-3 border-b bg-muted/50", frameless && "max-lg:border-0 max-lg:bg-transparent")}>
        {collapsible ? (
          // The whole bar is the target, not just the chevron - a 3px icon is
          // a poor place to make someone aim.
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className={cn(
              "flex-1 min-w-0 flex items-center gap-2 px-5 py-3.5 text-left hover:bg-muted transition-colors",
              frameless && "max-lg:px-1 max-lg:py-2.5 max-lg:hover:bg-transparent",
            )}
            data-testid={testId ? `${testId}-toggle` : undefined}
          >
            <ChevronDown className={cn("w-4 h-4 shrink-0 transition-transform", !open && "-rotate-90")} />
            {heading}
          </button>
        ) : (
          <div className={cn("flex-1 min-w-0 px-5 py-3.5", frameless && "max-lg:px-1 max-lg:py-2.5")}>{heading}</div>
        )}
        {/* basis-full below sm: the actions take their own row rather than
            competing with the title. flex-1 + truncate on the title meant the
            shrink-0 actions won that fight and squeezed the heading to zero
            width - the title vanished entirely on a narrow phone. */}
        {headerActions && (
          <div className={cn(
            "px-5 pb-3.5 shrink-0",
            denseHeader ? "basis-full" : "sm:pt-3.5 sm:pl-0 basis-full sm:basis-auto",
          )}>
            {headerActions}
          </div>
        )}
      </div>
      {(!collapsible || open) && <div className={contentClassName}>{children}</div>}
    </Card>
  );
}
