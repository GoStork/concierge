import { useEffect, type ReactNode } from "react";
import { CheckCircle2, ExternalLink, MessageCircle, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ParentProfileCard, SubjectProfileCard, ProviderProfileCard, type ProviderProfileCardCalendar } from "@/components/profile-cards";
import type { SessionUser, ViewerRole } from "./chat-types";

export type MatchStatusTone = "neutral" | "success" | "warning";

export interface ChatHeaderMatchStatus {
  label: string;
  tone: MatchStatusTone;
}

interface SubjectContext {
  providerId: string | null | undefined;
  subjectProfileId: string | null | undefined;
  subjectType: string | null | undefined;
  fallbackPhotoUrl?: string | null;
  fallbackLabel?: string | null;
  profileAvailable?: boolean | null;
  heading?: string;
}

interface ProviderContext {
  id: string | null | undefined;
  name: string | null | undefined;
  logoUrl?: string | null;
  calendar?: ProviderProfileCardCalendar | null;
}

interface ChatHeaderContextPanelProps {
  open: boolean;
  onClose: () => void;
  role: ViewerRole;
  brandColor: string;
  matchStatus?: ChatHeaderMatchStatus | null;
  user?: SessionUser;
  subject?: SubjectContext | null;
  provider?: ProviderContext | null;
  extraTopContent?: ReactNode;
  testId?: string;
}

function MatchStatusPill({ status }: { status: ChatHeaderMatchStatus }) {
  const toneClass =
    status.tone === "success"
      ? "bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))]"
      : status.tone === "warning"
      ? "bg-[hsl(var(--brand-warning))]/10 text-[hsl(var(--brand-warning))]"
      : "bg-background text-foreground border";
  const Icon = status.tone === "success" ? CheckCircle2 : MessageCircle;
  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium w-fit ${toneClass}`}
      data-testid="context-panel-match-status"
    >
      <Icon className="w-3 h-3" />
      {status.label}
    </div>
  );
}

export function ChatHeaderContextPanel({
  open,
  onClose,
  role,
  brandColor,
  matchStatus,
  user,
  subject,
  provider,
  extraTopContent,
  testId = "chat-header-context-panel",
}: ChatHeaderContextPanelProps) {
  const navigate = useNavigate();
  const showParentCard = (role === "provider" || role === "admin") && !!user;
  const showProviderCard = (role === "parent" || role === "admin") && !!provider?.id;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const subjectHeading =
    subject?.heading
    ?? (subject?.subjectType?.toLowerCase() === "surrogate" ? "Interested Surrogate"
      : subject?.subjectType?.toLowerCase().includes("sperm") ? "Interested Sperm Donor"
      : subject?.subjectType?.toLowerCase().includes("donor") ? "Interested Egg Donor"
      : undefined);

  const navTo = (path: string) => {
    onClose();
    navigate(path);
  };

  return (
    <div
      className={`lg:hidden fixed inset-0 z-50 bg-background flex flex-col transform-gpu transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full pointer-events-none"}`}
      style={{ visibility: open ? "visible" : "hidden" }}
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
      data-testid={testId}
    >
      <div className="flex items-center gap-3 px-4 h-14 border-b bg-background shrink-0">
        <button
          type="button"
          onClick={onClose}
          className="h-9 w-9 -ml-1 flex items-center justify-center rounded-full active:bg-muted/60"
          aria-label="Close details"
          data-testid="context-panel-close"
        >
          <X className="w-5 h-5" />
        </button>
        <span className="text-sm font-medium font-ui">Details</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3" style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}>
        {(matchStatus || extraTopContent) && (
          <div className="rounded-[var(--radius)] bg-secondary/40 border p-4" data-testid="context-panel-match-status-card">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Match Status</p>
            <div className="flex flex-wrap items-center gap-2">
              {matchStatus && <MatchStatusPill status={matchStatus} />}
              {extraTopContent}
            </div>
          </div>
        )}

        {showProviderCard && provider && (
          <div className="rounded-[var(--radius)] bg-secondary/40 border p-4" data-testid="context-panel-provider-card">
            <ProviderProfileCard
              providerId={provider.id}
              providerName={provider.name}
              providerLogo={provider.logoUrl}
              brandColor={brandColor}
              calendar={provider.calendar || null}
              testId="context-panel-provider-profile"
            />
          </div>
        )}

        {showParentCard && user && (
          <div className="rounded-[var(--radius)] bg-secondary/40 border p-4" data-testid="context-panel-parent-card">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Parent</p>
            <ParentProfileCard user={user} testId="context-panel-parent-profile" />
            {user.id && (
              <button
                type="button"
                onClick={() => navTo(`/parents/${user.id}`)}
                className="mt-3 inline-flex items-center gap-1 text-xs"
                style={{ color: brandColor }}
                data-testid="context-panel-parent-link"
              >
                <ExternalLink className="w-3 h-3" />
                View Full Parent Profile
              </button>
            )}
          </div>
        )}

        {subject?.subjectProfileId && subject?.providerId && subject?.subjectType && (
          <div className="rounded-[var(--radius)] bg-secondary/40 border p-4" data-testid="context-panel-subject-card">
            <SubjectProfileCard
              providerId={subject.providerId}
              subjectProfileId={subject.subjectProfileId}
              subjectType={subject.subjectType}
              fallbackPhotoUrl={subject.fallbackPhotoUrl}
              fallbackLabel={subject.fallbackLabel}
              profileAvailable={subject.profileAvailable}
              brandColor={brandColor}
              heading={subjectHeading}
              testId="context-panel-subject-profile"
            />
          </div>
        )}
      </div>
    </div>
  );
}
