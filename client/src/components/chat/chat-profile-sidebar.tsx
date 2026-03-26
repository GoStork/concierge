import { type ReactNode } from "react";
import { User, Mail, MapPin } from "lucide-react";
import type { SessionUser } from "./chat-types";

interface ChatProfileSidebarProps {
  user: SessionUser;
  brandColor: string;
  /** Extra sections rendered after the profile info (e.g. consultation status, agreement buttons) */
  extraSections?: ReactNode;
  testId?: string;
}

/**
 * Shared right-sidebar profile panel showing parent info and journey details.
 * Used by both provider chat and admin concierge monitor.
 */
export function ChatProfileSidebar({ user, brandColor, extraSections, testId = "chat-profile-sidebar" }: ChatProfileSidebarProps) {
  const profile = user.parentAccount?.intendedParentProfile;

  return (
    <div className="w-72 border-l overflow-y-auto p-4 bg-muted/30 hidden md:block" data-testid={testId}>
      <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Parent Profile</h4>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <User className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm">{user.name || "-"}</span>
        </div>
        <div className="flex items-center gap-2">
          <Mail className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm truncate">{user.email}</span>
        </div>
        {(user.city || user.state) && (
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm">{[user.city, user.state].filter(Boolean).join(", ")}</span>
          </div>
        )}
        {profile && (
          <div className="border-t pt-3 mt-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Journey Details</p>
            <div className="space-y-1.5">
              {profile.journeyStage && <div className="text-sm"><span className="text-muted-foreground">Stage:</span> {profile.journeyStage}</div>}
              {profile.eggSource && <div className="text-sm"><span className="text-muted-foreground">Egg Source:</span> {profile.eggSource}</div>}
              {profile.spermSource && <div className="text-sm"><span className="text-muted-foreground">Sperm Source:</span> {profile.spermSource}</div>}
              {profile.carrier && <div className="text-sm"><span className="text-muted-foreground">Carrier:</span> {profile.carrier}</div>}
              {profile.hasEmbryos !== null && profile.hasEmbryos !== undefined && <div className="text-sm"><span className="text-muted-foreground">Embryos:</span> {profile.hasEmbryos ? `Yes (${profile.embryoCount || "??"})` : "No"}</div>}
            </div>
          </div>
        )}
      </div>
      {extraSections}
    </div>
  );
}
