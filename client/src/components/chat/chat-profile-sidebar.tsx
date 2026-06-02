import { type ReactNode } from "react";
import type { SessionUser } from "./chat-types";
import { ParentProfileCard } from "@/components/profile-cards";

interface ChatProfileSidebarProps {
  user: SessionUser;
  brandColor: string;
  /** When true, the parent identity row renders an Online pill + dot. */
  isOnline?: boolean;
  /** Sections rendered above the Parent Profile heading (e.g. match status). */
  topSections?: ReactNode;
  /** Extra sections rendered after the profile info (e.g. consultation status, agreement buttons, interested subject card). */
  extraSections?: ReactNode;
  testId?: string;
}

/**
 * Right-rail wrapper used by provider chat and admin concierge monitor.
 * Renders the canonical <ParentProfileCard /> in the middle, with optional
 * topSections above and extraSections below.
 *
 * The brandColor prop is preserved for backwards compatibility but is no
 * longer read here - ParentProfileCard uses design-system tokens.
 */
export function ChatProfileSidebar({ user, isOnline, topSections, extraSections, testId = "chat-profile-sidebar" }: ChatProfileSidebarProps) {
  return (
    <div className="w-72 border-l overflow-y-auto p-4 bg-muted/30 hidden md:block" data-testid={testId}>
      {topSections}
      <ParentProfileCard user={user} isOnline={isOnline} />
      {extraSections}
    </div>
  );
}
