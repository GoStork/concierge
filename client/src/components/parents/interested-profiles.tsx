/**
 * Which profiles is this family actually pursuing, and where is the chat?
 *
 * Two lists, because they are two different states of a lead:
 *
 *   In conversation   - a chat thread exists about a specific donor, surrogate,
 *                       clinic or doctor. Each row carries its OWN match status
 *                       and links straight into that thread.
 *   Saved, not
 *   contacted         - favourited, never messaged about. The follow-up list.
 *
 * A provider sees a flat list of their own profiles; an admin sees the same
 * rows grouped by provider org. Same component, one `groupByProvider` prop -
 * the grouping is presentation, not a different data path.
 */
import { useNavigate } from "react-router-dom";
import { ExternalLink, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DoctorMonogram } from "@/components/marketplace/doctor-monogram";
import { DoctorAvatar } from "@/components/marketplace/doctor-monogram";
import { getPhotoSrc } from "@/lib/profile-utils";
import { cn } from "@/lib/utils";
import { MatchStatusBadge, chatDeepLink } from "./parent-cells";
import { useDense } from "./record-density";
import type { ConversationRow, ParentRecord, SavedProfileRow } from "./parent-record-types";

const KIND_LABEL: Record<string, string> = {
  "egg-donor": "Egg donor",
  "surrogate": "Surrogate",
  "sperm-donor": "Sperm donor",
  clinic: "Clinic",
  agency: "Agency",
  doctor: "Doctor",
  none: "Concierge",
};

function Avatar({ photoUrl, name, status }: { photoUrl: string | null; name: string; status?: string | null }) {
  const src = photoUrl ? getPhotoSrc(photoUrl) : null;
  return (
    <div className="relative w-10 h-10 shrink-0">
      {src ? (
        <img src={src} alt={name} className="w-10 h-10 rounded-[var(--radius)] object-cover object-top" />
      ) : (
        <DoctorMonogram name={name} size={40} rounded="var(--radius)" />
      )}
      {status === "MATCHED" && (
        <span
          className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-background"
          style={{ background: "hsl(var(--accent))" }}
          title="Matched"
        />
      )}
    </div>
  );
}

function EmptyPanel({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <div className="rounded-[var(--radius)] bg-secondary p-4" data-testid={testId}>
      <p className="t-helper">{children}</p>
    </div>
  );
}

export function ConversationRowCard({
  row, isAdmin, parentUserId, showOrg,
}: { row: ConversationRow; isAdmin: boolean; parentUserId: string; showOrg: boolean }) {
  const navigate = useNavigate();
  const dense = useDense();
  const chatHref = chatDeepLink(
    { sessionId: row.sessionId, parentUserId, subjectProfileId: row.subjectProfileId },
    isAdmin,
  );
  return (
    // Stacks on a phone, and in a narrow column at any viewport. Side by side,
    // the two buttons hold ~200px of a 390px screen, which left the text about
    // 130px: the name truncated to "S...", the badges stacked, and the meta
    // line broke one word per row.
    <div
      className={cn(
        "rounded-[var(--radius)] border bg-card p-3 flex flex-col gap-3 hover:bg-secondary/30 transition-colors",
        !dense && "sm:flex-row sm:items-start",
      )}
      data-testid={`row-conversation-${row.sessionId}`}
    >
      <div className="flex items-start gap-3 min-w-0 flex-1">
      <Avatar photoUrl={row.photoUrl} name={row.displayName} status={row.profileStatus} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate">{row.displayName}</span>
          <MatchStatusBadge status={row.matchStatus} />
          {/* A thread with no subject profile is titled with the org itself, so
              the org chip would just say the same words twice - under a group
              header that already says them a third time. */}
          {showOrg && row.providerName && row.providerName !== row.displayName && (
            <span
              className="text-xs font-ui px-2 py-0.5 rounded-full"
              style={{ background: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
            >
              {row.providerName}
            </span>
          )}
        </div>
        <p className="t-helper break-words">
          {KIND_LABEL[row.subjectKind] || "Thread"}
          {" · started "}{new Date(row.createdAt).toLocaleDateString()}
          {row.updatedAt ? ` · last activity ${new Date(row.updatedAt).toLocaleDateString()}` : ""}
        </p>
        {row.lastMessagePreview && (
          <p className="t-helper italic truncate">"{row.lastMessagePreview}"</p>
        )}
      </div>
      </div>
      <div className={cn("flex items-center gap-1.5 shrink-0 self-end", !dense && "sm:self-auto")}>
        {chatHref && (
          <Button variant="outline" size="sm" onClick={() => navigate(chatHref)} data-testid={`btn-open-chat-${row.sessionId}`}>
            <MessageSquare className="w-3.5 h-3.5 mr-1.5" /> Open chat
          </Button>
        )}
        {row.profileUrl && (
          <Button variant="ghost" size="sm" onClick={() => navigate(row.profileUrl as string)} data-testid={`btn-open-profile-${row.sessionId}`}>
            <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> Profile
          </Button>
        )}
      </div>
    </div>
  );
}

function SavedRowCard({ row }: { row: SavedProfileRow }) {
  const navigate = useNavigate();
  const dense = useDense();
  return (
    <div
      className={cn(
        "rounded-[var(--radius)] border bg-card p-3 flex flex-col gap-3 hover:bg-secondary/30 transition-colors",
        !dense && "sm:flex-row sm:items-center",
      )}
      data-testid={`row-saved-${row.profileId}`}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
      <Avatar photoUrl={row.photoUrl} name={row.displayName} status={row.profileStatus} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{row.displayName}</p>
        {/* break-words: a provider like "Sperm Bank California | Fertility
            Center of California" ran straight past the card's right edge. */}
        <p className="t-helper break-words">
          {KIND_LABEL[row.subjectKind] || "Profile"}
          {row.providerName ? ` · ${row.providerName}` : ""}
          {" · saved "}{new Date(row.savedAt).toLocaleDateString()}
        </p>
      </div>
      </div>
      {row.profileUrl && (
        <Button variant="ghost" size="sm" className={cn("shrink-0 self-end", !dense && "sm:self-auto")} onClick={() => navigate(row.profileUrl as string)} data-testid={`btn-saved-profile-${row.profileId}`}>
          <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> Profile
        </Button>
      )}
    </div>
  );
}

export function EngagementLine({ record }: { record: ParentRecord }) {
  const { impressions, profilesViewed, lastBrowsedAt } = record.engagement;
  if (profilesViewed === null && impressions === null) return null;
  const isAdmin = record.viewer.role === "admin";
  const parts: string[] = [];
  if (profilesViewed !== null) {
    parts.push(isAdmin ? `Viewed ${profilesViewed} profiles` : `Viewed ${profilesViewed} of your profiles`);
  }
  if (impressions !== null) parts.push(`${impressions} impressions`);
  if (lastBrowsedAt) parts.push(`last browsed ${new Date(lastBrowsedAt).toLocaleDateString()}`);
  if (!parts.length) return null;
  return <p className="t-helper" data-testid="parent-engagement-line">{parts.join(" · ")}</p>;
}

export function InterestedProfilesSection({
  record, groupByProvider,
}: { record: ParentRecord; groupByProvider: boolean }) {
  const isAdmin = record.viewer.role === "admin";
  const { conversations, savedProfiles } = record;
  const nothingAtAll =
    conversations.length === 0 &&
    savedProfiles.length === 0 &&
    !record.engagement.profilesViewed &&
    !record.engagement.impressions;

  if (nothingAtAll) {
    return <EmptyPanel testId="interests-empty-all">No marketplace activity recorded for this family yet.</EmptyPanel>;
  }

  // Admin groups by org, most recently active first. Sessions with no org
  // (the parent's own Eva thread) sort last under their own heading.
  const groups: { key: string; label: string; logoUrl: string | null; rows: ConversationRow[] }[] = [];
  if (groupByProvider) {
    const byOrg = new Map<string, ConversationRow[]>();
    for (const c of conversations) {
      const k = c.providerId || "__eva__";
      byOrg.set(k, [...(byOrg.get(k) || []), c]);
    }
    for (const [k, rows] of byOrg) {
      groups.push({
        key: k,
        label: k === "__eva__" ? "GoStork concierge (Eva)" : rows[0]?.providerName || "Provider",
        logoUrl: rows[0]?.providerLogoUrl ?? null,
        rows,
      });
    }
    groups.sort((a, b) => {
      if (a.key === "__eva__") return 1;
      if (b.key === "__eva__") return -1;
      return new Date(b.rows[0]?.updatedAt || 0).getTime() - new Date(a.rows[0]?.updatedAt || 0).getTime();
    });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="t-micro-label">In conversation{conversations.length ? ` (${conversations.length})` : ""}</p>
        {conversations.length === 0 ? (
          <EmptyPanel testId="interests-empty-conversations">
            {isAdmin
              ? "No profile conversations yet."
              : "No conversations about your profiles yet. They will appear here when this family starts a chat about one of your donors, surrogates or doctors."}
          </EmptyPanel>
        ) : groupByProvider ? (
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.key} className="space-y-2" data-testid={`interests-group-${g.key}`}>
                <div className="flex items-center gap-2">
                  {/* DoctorAvatar, not a bare img: a provider whose logo URL
                      has gone dead on their own site rendered the browser's
                      broken-image icon. This falls back to initials. */}
                  <DoctorAvatar
                    name={g.label}
                    photoUrl={g.logoUrl}
                    size={24}
                    rounded="var(--radius)"
                    className="object-contain"
                  />
                  <span className="text-sm font-medium font-ui">{g.label}</span>
                  <span className="t-helper">({g.rows.length})</span>
                </div>
                <div className="space-y-2">
                  {g.rows.map((row) => (
                    <ConversationRowCard key={row.sessionId} row={row} isAdmin={isAdmin} parentUserId={record.parent.id} showOrg />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {conversations.map((row) => (
              // Everything on screen is already this provider's, so an org chip
              // on every row would just be noise.
              <ConversationRowCard key={row.sessionId} row={row} isAdmin={isAdmin} parentUserId={record.parent.id} showOrg={false} />
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <p className="t-micro-label">Saved, not contacted{savedProfiles.length ? ` (${savedProfiles.length})` : ""}</p>
        {savedProfiles.length === 0 ? (
          <EmptyPanel testId="interests-empty-saved">
            {isAdmin ? "Nothing saved yet." : "They have not saved any of your profiles yet."}
          </EmptyPanel>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {savedProfiles.map((row) => (
              <SavedRowCard key={`${row.subjectKind}-${row.profileId}`} row={row} />
            ))}
          </div>
        )}
      </div>

      <EngagementLine record={record} />
    </div>
  );
}
