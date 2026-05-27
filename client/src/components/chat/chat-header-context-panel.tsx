import { type ReactNode } from "react";
import { CheckCircle2, ExternalLink, MessageCircle, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { ParentProfileCard, SubjectProfileCard } from "@/components/profile-cards";
import { getPhotoSrc } from "@/lib/profile-utils";
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
  heading?: string;
}

interface ProviderContext {
  id: string | null | undefined;
  name: string | null | undefined;
  logoUrl?: string | null;
}

interface ChatHeaderContextPanelProps {
  open: boolean;
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
      : "bg-secondary text-foreground";
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
  const showProviderRow = role === "parent" && !!provider?.id;

  const subjectHeading =
    subject?.heading
    ?? (subject?.subjectType?.toLowerCase() === "surrogate" ? "Interested Surrogate"
      : subject?.subjectType?.toLowerCase().includes("sperm") ? "Interested Sperm Donor"
      : subject?.subjectType?.toLowerCase().includes("donor") ? "Interested Egg Donor"
      : undefined);

  return (
    <Collapsible open={open} className="lg:hidden">
      <CollapsibleContent
        className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up"
        data-testid={testId}
      >
        <div className="border-b bg-secondary/30 px-4 py-3 space-y-3 max-h-[60vh] overflow-y-auto">
          {(matchStatus || extraTopContent) && (
            <div className="flex flex-wrap items-center gap-2">
              {matchStatus && <MatchStatusPill status={matchStatus} />}
              {extraTopContent}
            </div>
          )}

          {showProviderRow && provider && (
            <button
              type="button"
              onClick={() => provider.id && navigate(`/providers/${provider.id}`)}
              className="w-full flex items-center gap-3 rounded-[var(--radius)] bg-background border px-3 py-2.5 text-left active:opacity-70 transition-opacity"
              data-testid="context-panel-provider-link"
            >
              <div className="w-9 h-9 rounded-full overflow-hidden bg-muted flex-shrink-0 flex items-center justify-center">
                {provider.logoUrl ? (
                  <img src={getPhotoSrc(provider.logoUrl) || undefined} alt="" className="w-full h-full object-cover" />
                ) : (
                  <Sparkles className="w-4 h-4" style={{ color: brandColor }} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Provider</p>
                <p className="text-sm font-semibold truncate">{provider.name || "Provider"}</p>
              </div>
              <ExternalLink className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            </button>
          )}

          {showParentCard && user && (
            <div className="rounded-[var(--radius)] bg-background border p-3" data-testid="context-panel-parent-card">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Parent</p>
              <ParentProfileCard user={user} testId="context-panel-parent-profile" />
              {user.id && (
                <button
                  type="button"
                  onClick={() => navigate(`/parents/${user.id}`)}
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
            <div className="rounded-[var(--radius)] bg-background border p-3" data-testid="context-panel-subject-card">
              <SubjectProfileCard
                providerId={subject.providerId}
                subjectProfileId={subject.subjectProfileId}
                subjectType={subject.subjectType}
                fallbackPhotoUrl={subject.fallbackPhotoUrl}
                fallbackLabel={subject.fallbackLabel}
                brandColor={brandColor}
                heading={subjectHeading}
                testId="context-panel-subject-profile"
              />
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
