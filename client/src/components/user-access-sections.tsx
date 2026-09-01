/**
 * A user's access facts - video room, connected calendars, public booking
 * link - rendered identically wherever a user record is shown:
 *  - the Team user editor (/users/:id, admin-user-edit-page.tsx)
 *  - the logged-in user's own My Account page (/account), so "everything
 *    about me" lives in one self-service place (the onboarding step
 *    "Review your video room" points there).
 * One shared file - never fork these sections per page.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Video, Calendar, Link2, Copy, Check, AlertTriangle } from "lucide-react";

export type CalendarConnection = {
  id: string;
  provider: string;
  email: string | null;
  label: string | null;
  tokenValid?: boolean;
  connected?: boolean;
};

export function VideoRoomSection({ url }: { url: string }) {
  return (
    <div className="bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
      <h2 className="t-micro-label font-heading">Video Room</h2>
      <div className="flex items-center gap-2">
        <Video className="w-4 h-4 text-primary shrink-0" />
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline truncate" data-testid="link-video-room-url">
          {url}
        </a>
      </div>
    </div>
  );
}

export function ConnectedCalendarsSection({
  connections,
  canManage = true,
}: {
  connections: CalendarConnection[] | undefined;
  /** False when an admin views ANOTHER member's record - calendars are
   *  per-user OAuth, so only the member themselves can connect/disconnect
   *  (on their own Settings -> Calendar page). */
  canManage?: boolean;
}) {
  const navigate = useNavigate();
  const hasConnections = !!connections && connections.length > 0;
  return (
    <div className="bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
      <h2 className="t-micro-label font-heading">Connected Calendars</h2>
      {hasConnections ? (
        <div className="space-y-2">
          {connections!.map((conn) => {
            const isHealthy = conn.tokenValid !== false && conn.connected !== false;
            return (
              <div key={conn.id} className="flex items-center gap-2 text-sm" data-testid={`text-calendar-connection-${conn.id}`}>
                <Calendar className="w-4 h-4 text-primary shrink-0" />
                <span className="font-ui">{conn.label || conn.provider}</span>
                {conn.email && <span className="text-muted-foreground">({conn.email})</span>}
                {isHealthy ? (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-ui bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))]" data-testid={`badge-calendar-status-${conn.id}`}>Connected</span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-ui bg-[hsl(var(--brand-warning))]/10 text-[hsl(var(--brand-warning))]" data-testid={`badge-calendar-status-${conn.id}`}>
                    <AlertTriangle className="w-3 h-3" />Needs Renewal
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="t-helper">No calendar connected yet.</p>
      )}
      {canManage ? (
        <Button type="button" variant="outline" size="sm" onClick={() => navigate(hasConnections ? "/account/calendar" : "/account/calendar?connect=true")} data-testid="button-manage-calendars">
          <Calendar className="w-4 h-4 mr-1.5" />
          {hasConnections ? "Manage calendars" : "Connect Your Calendar"}
        </Button>
      ) : (
        <p className="t-helper">
          Calendars are connected and managed by each member on their own Settings -&gt; Calendar page.
        </p>
      )}
    </div>
  );
}

export function CalendarLinkSection({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const bookingUrl = `${window.location.origin}/book/${slug}`;
  const handleCopy = () => {
    navigator.clipboard.writeText(bookingUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="bg-card rounded-[var(--radius)] border border-border/50 shadow-sm p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Link2 className="w-5 h-5 text-primary" />
        <h2 className="t-micro-label font-heading">Your Calendar Link</h2>
      </div>
      <p className="t-helper">
        Share this link with anyone to let them book time with you. It can be embedded on websites or shared via email.
      </p>
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center bg-secondary/30 border border-border/50 rounded-[var(--radius)] px-3 py-2">
          <span className="t-helper mr-1 shrink-0">/book/</span>
          <span className="text-sm font-ui font-heading" data-testid="text-calendar-slug">{slug}</span>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={handleCopy} data-testid="button-copy-calendar-link">
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </Button>
      </div>
      <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline break-all" data-testid="link-calendar-booking-url">{bookingUrl}</a>
    </div>
  );
}

/**
 * The logged-in provider user's own access sections for My Account: fetches
 * their user record (same provider-scoped endpoint the Team editor uses) and
 * renders video room + connected calendars + booking link. Renders nothing
 * for non-provider users or while loading.
 */
export function MyAccessSections({ providerId, userId }: { providerId: string; userId: string }) {
  const { data } = useQuery<{
    dailyRoomUrl?: string | null;
    calendarConnections?: CalendarConnection[];
    scheduleConfig?: { bookingPageSlug: string | null } | null;
  }>({
    queryKey: ["/api/providers", providerId, "users", userId],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${providerId}/users/${userId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load user access details");
      return res.json();
    },
    staleTime: 30_000,
  });
  if (!data) return null;
  return (
    // mt-6 matches the space-y-6 between the sections themselves, so the gap
    // to the Personal Information card above is equal to every other gap.
    <div className="mt-6 space-y-6">
      {data.dailyRoomUrl && <VideoRoomSection url={data.dailyRoomUrl} />}
      <ConnectedCalendarsSection connections={data.calendarConnections} />
      {data.scheduleConfig?.bookingPageSlug && <CalendarLinkSection slug={data.scheduleConfig.bookingPageSlug} />}
    </div>
  );
}
