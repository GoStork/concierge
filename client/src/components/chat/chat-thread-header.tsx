/**
 * The ONE header above a parent's chat thread.
 *
 * It used to exist twice: the concierge page drew its own when opened at
 * /concierge, and the conversations page drew a second one when the same
 * thread was opened through /chat (the path the app actually takes). They
 * had drifted: 48px vs 40px avatar, 17px vs 14px name, the persona's title
 * vs a hardcoded "AI Concierge Chat", and only one of them named its icon
 * buttons. Every fix had to be made twice or was missed once.
 *
 * Two layouts, chosen by `subject`:
 *  - identity: avatar + name + subtitle (Eva, or a provider before a subject
 *    is attached)
 *  - subject: the donor/surrogate/clinic the thread is about as the primary
 *    line, the provider as a "via" subtitle, optionally tappable to open the
 *    context panel on small screens.
 * The right side is the human-escalation control in one of three states.
 */
import type { ReactNode } from "react";
import { ArrowLeft, ChevronRight, Headphones, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getPhotoSrc } from "@/lib/profile-utils";

export type ChatThreadHeaderProps = {
  brandColor: string;
  testId?: string;
  onBack: () => void;
  /** Extra classes for the back button (e.g. "md:hidden" when a sidebar shows the list). */
  backClassName?: string;
  identity: {
    name: string;
    subtitle: string | null;
    avatarUrl: string | null;
    /** Logos sit inside a bordered circle; faces fill it. */
    avatarFit?: "cover" | "contain";
  };
  subject?: {
    title: string;
    photoUrl: string | null;
    viaName: string;
    viaLogo: string | null;
    /** Status pill or online dot rendered after the title. */
    badge?: ReactNode;
    onToggle?: () => void;
    panelOpen?: boolean;
  } | null;
  team?: {
    state: "talking" | "notified" | "available";
    onClick?: () => void;
    disabled?: boolean;
  } | null;
};

export function ChatThreadHeader({ brandColor, testId = "chat-thread-header", onBack, backClassName = "", identity, subject, team }: ChatThreadHeaderProps) {
  const identityAvatar = identity.avatarUrl ? (getPhotoSrc(identity.avatarUrl) || identity.avatarUrl) : null;
  const viaLogo = subject?.viaLogo ? (getPhotoSrc(subject.viaLogo) || subject.viaLogo) : null;
  const subjectPhoto = subject?.photoUrl ? (getPhotoSrc(subject.photoUrl) || subject.photoUrl) : null;

  const subjectBody = subject ? (
    <>
      <div className="w-12 h-12 rounded-full flex-shrink-0 overflow-hidden bg-muted relative">
        {subjectPhoto ? (
          <img src={subjectPhoto} alt="" className="w-12 h-12 rounded-full object-cover" onError={(e) => { e.currentTarget.style.display = "none"; }} />
        ) : viaLogo ? (
          <img src={viaLogo} alt="" className="w-12 h-12 rounded-full object-contain p-0.5 bg-background border" onError={(e) => { e.currentTarget.style.display = "none"; }} />
        ) : (
          <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
            <User className="w-4 h-4 text-muted-foreground" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[17px] font-ui truncate" style={{ fontWeight: 600 }} data-testid="parent-chat-subject-label">{subject.title}</span>
          {subject.badge}
        </div>
        <div className="flex items-center gap-1 mt-0.5 min-w-0">
          <span className="t-helper flex-shrink-0">via</span>
          {viaLogo && (
            <img src={viaLogo} alt="" className="w-3.5 h-3.5 rounded-sm object-contain flex-shrink-0 bg-white border border-border/40" onError={(e) => { e.currentTarget.style.display = "none"; }} />
          )}
          <span className="t-helper truncate">{subject.viaName}</span>
        </div>
      </div>
      {subject.onToggle && <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0 lg:hidden" aria-hidden />}
    </>
  ) : null;

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b bg-background shrink-0" data-testid={testId}>
      <Button
        variant="ghost"
        size="sm"
        className={`h-8 w-8 p-0 ${backClassName}`}
        onClick={onBack}
        aria-label="Back to conversations"
        data-testid="btn-back-to-chats"
      >
        <ArrowLeft className="w-4 h-4" />
      </Button>

      {subject ? (
        subject.onToggle ? (
          <button
            type="button"
            onClick={subject.onToggle}
            aria-expanded={!!subject.panelOpen}
            aria-controls="parent-header-context-panel"
            className="flex items-center gap-3 min-w-0 flex-1 text-left rounded-[var(--radius)] -mx-1 px-1 py-1 lg:cursor-default active:bg-muted/40 lg:active:bg-transparent"
            data-testid="btn-parent-header-context"
          >
            {subjectBody}
          </button>
        ) : (
          <div className="flex items-center gap-3 min-w-0 flex-1">{subjectBody}</div>
        )
      ) : (
        <>
          <div className="w-12 h-12 rounded-full flex-shrink-0 relative">
            {identityAvatar ? (
              <img
                src={identityAvatar}
                alt={identity.name}
                className={`w-12 h-12 rounded-full ${identity.avatarFit === "contain" ? "object-contain p-0.5 bg-background border" : "object-cover border"}`}
                onError={(e) => { e.currentTarget.style.display = "none"; }}
              />
            ) : (
              <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground text-sm font-bold" style={{ backgroundColor: brandColor }}>
                {identity.name.charAt(0) || "?"}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[17px] font-ui truncate" style={{ fontWeight: 600 }}>{identity.name}</h2>
            {identity.subtitle && <p className="t-helper font-ui truncate" data-testid="chat-subject-label">{identity.subtitle}</p>}
          </div>
        </>
      )}

      {team && (
        <div className="flex items-center gap-1 shrink-0 ml-auto">
          {team.state === "talking" ? (
            <div
              className="inline-flex items-center gap-1.5 px-3 h-8 text-xs font-medium"
              style={{ backgroundColor: `${brandColor}15`, color: brandColor, borderRadius: "999px" }}
              data-testid="btn-talk-to-team"
            >
              <Headphones className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Talking with Human</span>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="text-xs gap-1.5 h-8"
              style={{ borderColor: `${brandColor}30`, color: brandColor, borderRadius: "999px" }}
              onClick={team.onClick}
              disabled={team.disabled || team.state === "notified"}
              aria-label={team.state === "notified" ? "Team notified" : "Talk to GoStork Team"}
              data-testid="btn-talk-to-team"
            >
              <Headphones className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{team.state === "notified" ? "Team Notified" : "Talk to GoStork Team"}</span>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
