import * as React from "react";

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
  ...rest
}: ProfileSectionProps) {
  const testId = rest["data-testid"];
  return (
    <Card className={cn("overflow-hidden", className)} data-testid={testId}>
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b bg-muted/50">
        <h3
          className="font-heading text-foreground"
          style={{ fontSize: "var(--section-title-size)", fontWeight: "var(--section-title-weight)" as any }}
          data-testid={
            typeof title === "string"
              ? `section-header-${title.toLowerCase().replace(/\s+/g, "-")}`
              : undefined
          }
        >
          {title}
        </h3>
        {headerActions}
      </div>
      <div className={contentClassName}>{children}</div>
    </Card>
  );
}
