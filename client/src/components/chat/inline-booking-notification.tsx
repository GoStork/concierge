import { useState, type ReactNode } from "react";
import { getPhotoSrc } from "@/lib/profile-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2, X, CalendarClock, Clock, Crown, Check, Video, Globe } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { format } from "date-fns";
import { InlineSuggestTimeForm } from "./inline-suggest-time-form";
import { RescheduleCalendarPicker } from "@/pages/concierge-chat-page";

/**
 * Shared booking widget used by parent (/chat), provider (conversations-page),
 * and admin (concierge-monitor) views. Only the action buttons differ by role;
 * the visual layout, hero, counterparty info, date/time, participants, and
 * status message are identical across all three.
 */
interface InlineBookingNotificationProps {
  booking: any;
  brandColor: string;
  onUpdate: () => void;
  /** Who's looking at this widget. Drives counterparty calc, header title, and
   *  which action buttons render. Falls back to user==providerUser detection
   *  when not provided (matches the pre-refactor behavior). */
  viewerRole?: "parent" | "provider" | "admin";
  /** When true, skips the outer card border + brand-color header strip so the
   *  caller can provide its own wrapper. Used by the parent's
   *  InlineBookingCalendar which already wraps in the timeline. */
  embedded?: boolean;
  /** Parent-only: clicking Reschedule fires this; the parent's calendar widget
   *  uses it to swap to its date-picker step. */
  onRequestReschedule?: () => void;
  /** Parent-only: clicking Cancel fires this; the parent's calendar widget
   *  uses it to swap to its cancel-confirm step. */
  onRequestCancel?: () => void;
}

export function InlineBookingNotification({
  booking,
  brandColor,
  onUpdate,
  viewerRole,
  embedded = false,
  onRequestReschedule,
  onRequestCancel,
}: InlineBookingNotificationProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [showSuggestForm, setShowSuggestForm] = useState(false);
  const [showRescheduleForm, setShowRescheduleForm] = useState(false);
  // Provider detection: explicit viewerRole wins, else fall back to user==providerUser.
  const isProvider = viewerRole
    ? (viewerRole === "provider" || viewerRole === "admin")
    : booking?.providerUserId === user?.id;
  const isParent = viewerRole === "parent";
  const isPending = booking?.status === "PENDING";
  const isConfirmed = booking?.status === "CONFIRMED";
  const isCancelled = booking?.status === "CANCELLED";
  const isRescheduled = booking?.status === "RESCHEDULED";

  const confirmMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/calendar/bookings/${booking.id}/confirm`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting confirmed", description: "The parent has been notified.", variant: "success" as any });
      onUpdate();
    },
  });

  const declineMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/calendar/bookings/${booking.id}/decline`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting declined", description: "The parent has been notified.", variant: "success" as any });
      onUpdate();
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/calendar/bookings/${booking.id}`, { status: "CANCELLED" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting cancelled", description: "All participants have been notified.", variant: "success" as any });
      onUpdate();
    },
    onError: () => toast({ title: "Failed to cancel meeting", variant: "destructive" }),
  });

  if (!booking) return null;
  const start = new Date(booking.scheduledAt);
  // A single bad/unparseable scheduledAt must never crash the whole chat page:
  // date-fns format() throws "Invalid time value" on an invalid Date, which the
  // root ErrorBoundary turns into a full-page "Something went wrong". Detect it,
  // log loudly so the underlying data bug stays diagnosable, and degrade the
  // date display gracefully instead of taking down the app.
  const startValid = !isNaN(start.getTime());
  if (!startValid) {
    // eslint-disable-next-line no-console
    console.warn(`[InlineBookingNotification] booking ${booking.id} has an invalid scheduledAt:`, booking.scheduledAt);
  }
  const end = startValid ? new Date(start.getTime() + (booking.duration || 30) * 60 * 1000) : null;
  const hasPassed = end ? new Date() > end : false;
  const parentJoined = !!booking.parentJoinedMeetingAt;
  const providerJoined = !!booking.providerJoinedMeetingAt;
  const wasCompleted = hasPassed && isConfirmed && parentJoined && providerJoined;
  const isParentNoShow = hasPassed && isConfirmed && providerJoined && !parentJoined;
  const isProviderNoShow = hasPassed && isConfirmed && parentJoined && !providerJoined;
  const isNoShow = hasPassed && !wasCompleted && !isParentNoShow && !isProviderNoShow && !isCancelled && !isRescheduled;
  const isParentCancelled = isCancelled && booking.cancelledByRole === "parent";
  const isProviderCancelled = isCancelled && booking.cancelledByRole === "provider";
  // The host is a GoStork admin if they have GOSTORK_ADMIN role, or as fallback have no providerId
  const isAdminHost = !!(booking.providerUser?.roles as string[] | undefined)?.includes("GOSTORK_ADMIN")
    || !booking.providerUser?.providerId;
  const adminName = booking.providerUser?.name || "GoStork Team";
  const providerName = isAdminHost ? adminName : (booking.providerUser?.name || "Provider");
  const orgName = isAdminHost ? "" : (booking.providerUser?.provider?.name || "");

  const members = booking.parentAccountMembers || [];
  const attendees = members.length > 0
    ? members
    : booking.parentUser
    ? [booking.parentUser]
    : [];

  const headerTitle = isAdminHost && isProvider
    ? `GoStork Concierge Call with ${booking.parentUser?.name || booking.attendeeName || "Parent"}`
    : isAdminHost
    ? `GoStork Concierge Call - ${adminName}`
    : isProvider
    ? `Consultation Call with ${booking.parentUser?.name || booking.attendeeName || "Parent"}`
    : orgName ? `Consultation Call with ${orgName}` : "Consultation Call";

  const cardChrome = (children: ReactNode) => embedded ? (
    <div className="space-y-3" data-testid={`inline-booking-card-${booking.id}`}>{children}</div>
  ) : (
    <div className="my-3" data-testid={`inline-booking-card-${booking.id}`}>
      <div
        className="w-full overflow-hidden border border-border bg-card"
        style={{ borderRadius: "var(--container-radius, 0.5rem)", maxWidth: "min(100%, 420px)" }}
      >
        <div className="p-1.5" style={{ backgroundColor: brandColor }}>
          <div className="flex items-center gap-2 px-3 py-1.5">
            <CalendarClock className="w-4 h-4 text-primary-foreground" />
            <span className="text-primary-foreground text-xs font-semibold uppercase tracking-wider">
              {headerTitle}
            </span>
          </div>
        </div>
        <div className="p-4 space-y-3">{children}</div>
      </div>
    </div>
  );

  /**
   * The meeting's state, said ONCE.
   *
   * It used to be said four times over: a 48px icon medallion, a headline, a
   * pill repeating the headline, and a coloured banner at the foot of the card
   * repeating it again - three of those stacked centred rows, so a cancelled
   * meeting opened with a column of near-empty space before any fact about the
   * meeting appeared.
   *
   * Now: one banner, tinted to the state, carrying the icon, the label and the
   * sentence that actually tells you something. Tone comes from the state
   * rather than from where the branch happened to sit, which is how No Show
   * ended up grey at the foot of the card while its own header was amber.
   */
  const status: { icon: typeof X; label: string; note: string; tone: "destructive" | "warning" | "success" | "muted" } | null =
    isParentCancelled ? { icon: X, label: "Parent cancelled", note: "This meeting was cancelled by the parent.", tone: "destructive" }
    : isProviderCancelled ? { icon: X, label: "Provider cancelled", note: "This meeting was cancelled by the provider.", tone: "destructive" }
    : isCancelled ? { icon: X, label: "Meeting cancelled", note: "This meeting has been cancelled.", tone: "destructive" }
    : wasCompleted ? { icon: Check, label: "Meeting completed", note: "Both sides joined the meeting room.", tone: "muted" }
    : isParentNoShow ? { icon: Clock, label: "Parent no show", note: "The provider joined the meeting room but the parent did not.", tone: "warning" }
    : isProviderNoShow ? { icon: Clock, label: "Provider no show", note: "The parent joined the meeting room but the provider did not.", tone: "warning" }
    : isNoShow ? { icon: Clock, label: "No show", note: "The scheduled time has passed and no one joined the meeting room.", tone: "warning" }
    : isConfirmed ? { icon: Check, label: "Meeting confirmed", note: "You'll get a reminder before it starts.", tone: "success" }
    : isRescheduled ? { icon: CalendarClock, label: "Meeting rescheduled", note: "This meeting was rescheduled. A new booking has been created.", tone: "muted" }
    // The two live states are the ones where the reader's next action differs
    // by role, so their sentence does too.
    : isPending && isProvider ? {
        icon: Clock, label: "Needs your confirmation",
        note: `Requested by ${booking.attendeeName || booking.parentUser?.name || "the parent"}.`, tone: "warning",
      }
    : isPending ? {
        icon: Clock, label: "Awaiting provider confirmation",
        note: `We'll email you as soon as ${providerName} confirms.`, tone: "warning",
      }
    : null;

  const TONE_STYLE = {
    destructive: { fg: "hsl(var(--destructive))", bg: "hsl(var(--destructive) / 0.08)", bd: "hsl(var(--destructive) / 0.2)" },
    warning: { fg: "hsl(var(--brand-warning))", bg: "hsl(var(--brand-warning) / 0.12)", bd: "hsl(var(--brand-warning) / 0.25)" },
    success: { fg: "hsl(var(--brand-success))", bg: "hsl(var(--brand-success) / 0.12)", bd: "hsl(var(--brand-success) / 0.25)" },
    muted: { fg: "hsl(var(--muted-foreground))", bg: "hsl(var(--muted) / 0.6)", bd: "hsl(var(--border))" },
  } as const;

  const statusBanner = status ? (() => {
    const t = TONE_STYLE[status.tone];
    const Icon = status.icon;
    return (
      <div
        className="flex items-start gap-2.5 rounded-[var(--radius)] border p-3"
        style={{ background: t.bg, borderColor: t.bd }}
        data-testid="booking-status-banner"
      >
        <Icon className="w-4 h-4 shrink-0 mt-0.5" style={{ color: t.fg }} />
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight" style={{ color: t.fg }}>{status.label}</p>
          {status.note && <p className="text-xs mt-0.5" style={{ color: t.fg, opacity: 0.85 }}>{status.note}</p>}
        </div>
      </div>
    );
  })() : null;

  return cardChrome(<>
        <div className="space-y-3">
          {statusBanner}
          {/* Counterparty info + date/time - mirrors parent /chat InlineBookingCalendar
              so all three views (parent, provider, admin) show the same structure.
              From this viewer's perspective the counterparty is the OTHER party:
              for parent: the provider; for provider/admin: the parent. */}
          <div className="bg-muted/40 rounded-[var(--radius)] p-3 space-y-2.5 border border-border">
            {(() => {
              // Counterparty = the party the viewer is meeting with.
              const counterpartyName = isProvider
                ? (booking.parentUser?.name || booking.attendeeName || booking.attendeeEmails?.[0] || "Parent")
                : (isAdminHost ? adminName : providerName);
              const counterpartySubtitle = isProvider
                ? (booking.parentUser?.email || booking.attendeeEmails?.[0] || "")
                : (isAdminHost ? "" : orgName);
              const counterpartyPhoto = getPhotoSrc(
                isProvider
                  ? (booking.parentUser?.photoUrl || null)
                  : (booking.providerUser?.photoUrl || null),
              );
              return (
                <div className="flex items-center gap-3">
                  {counterpartyPhoto ? (
                    <>
                      <img
                        src={counterpartyPhoto}
                        alt={counterpartyName}
                        className="w-12 h-12 rounded-full object-cover"
                        onError={(e) => {
                          // Broken/forbidden image -> show the standard
                          // initial-letter avatar instead of the browser's
                          // broken-image glyph.
                          e.currentTarget.style.display = "none";
                          const fallback = e.currentTarget.nextElementSibling as HTMLElement | null;
                          if (fallback) {
                            fallback.classList.remove("hidden");
                            fallback.classList.add("flex");
                          }
                        }}
                      />
                      <div className="hidden w-12 h-12 rounded-full bg-primary/10 items-center justify-center text-primary font-bold text-sm">
                        {counterpartyName.charAt(0)}
                      </div>
                    </>
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm">
                      {counterpartyName.charAt(0)}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{counterpartyName}</p>
                    {counterpartySubtitle && <p className="t-helper truncate">{counterpartySubtitle}</p>}
                  </div>
                </div>
              );
            })()}
            <div className="flex items-center gap-2 text-sm">
              <CalendarClock className="w-4 h-4 text-muted-foreground shrink-0" />
              <span>{startValid ? format(start, "EEEE, MMMM d, yyyy") : "Date to be confirmed"}</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
              <span>{startValid ? `${format(start, "h:mm a")} (${booking.duration} min)` : `${booking.duration || 30} min`}</span>
            </div>
          </div>

          <div className="bg-muted/40 rounded-[var(--radius)] p-3 border border-border">
            <div className="flex items-center gap-2 mb-2">
              <Globe className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-semibold">Participants</span>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm pl-1">
                <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: `${brandColor}1A` }}>
                  <Crown className="w-3 h-3" style={{ color: brandColor }} />
                </div>
                <span className="font-medium text-xs">{isAdminHost ? adminName : providerName}</span>
                <span className="t-helper">{isAdminHost ? "(GoStork - Host)" : "(Host)"}</span>
              </div>
              {attendees.map((a: any) => (
                <div key={a.id || a.email} className="flex items-center gap-2 text-sm pl-1">
                  <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <Check className="w-3 h-3 text-primary" />
                  </div>
                  <span className="font-medium text-xs">{a.name || a.email}</span>
                  {a.email && a.name && <span className="t-helper">({a.email})</span>}
                </div>
              ))}
            </div>
          </div>
          {showSuggestForm && isPending && isProvider && !isNoShow && !isParentNoShow && !isProviderNoShow && (
            <div className="border border-border/50 rounded-[var(--radius)] p-3 space-y-2">
              <p className="text-sm font-medium">Suggest a new time</p>
              <InlineSuggestTimeForm
                bookingId={booking.id}
                onCancel={() => setShowSuggestForm(false)}
                onSuccess={() => { setShowSuggestForm(false); onUpdate(); }}
              />
            </div>
          )}

          {showRescheduleForm && isConfirmed && isProvider && !hasPassed && booking.providerUser?.scheduleConfig?.bookingPageSlug && (
            <div className="border border-border/50 rounded-[var(--radius)] p-3 space-y-2">
              <RescheduleCalendarPicker
                slug={booking.providerUser.scheduleConfig.bookingPageSlug}
                booking={booking}
                brandColor={brandColor}
                onRescheduled={() => { setShowRescheduleForm(false); onUpdate(); }}
                onCancel={() => setShowRescheduleForm(false)}
              />
            </div>
          )}
        </div>

        {isPending && isProvider && !showSuggestForm && !isNoShow && !isParentNoShow && !isProviderNoShow && (
          <div className="flex flex-wrap items-center justify-center gap-2 px-4 py-3 border-t bg-muted/20">
            <Button size="sm" onClick={() => confirmMutation.mutate()} disabled={confirmMutation.isPending || declineMutation.isPending} className="gap-1 text-xs" data-testid="button-confirm-booking-inline">
              {confirmMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Confirm
            </Button>
            <Button size="sm" variant="outline" className="text-destructive gap-1 text-xs" onClick={() => declineMutation.mutate()} disabled={confirmMutation.isPending || declineMutation.isPending} data-testid="button-decline-booking-inline">
              {declineMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3.5 h-3.5" />}
              Decline
            </Button>
            <Button size="sm" variant="outline" className="gap-1 text-xs" onClick={() => setShowSuggestForm(true)} data-testid="button-suggest-new-time-inline">
              <CalendarClock className="w-3.5 h-3.5" /> New Time
            </Button>
          </div>
        )}

        {isConfirmed && !hasPassed && booking.providerUser?.dailyRoomUrl && booking.meetingType !== "phone" && (
          <div className="px-4 py-3 border-t bg-muted/20">
            <a
              href={`/room/${booking.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full py-2 rounded-[var(--radius)] text-xs font-medium text-primary-foreground bg-primary transition-colors hover:bg-primary/90"
              data-testid={isProvider ? "button-start-meeting-inline" : "button-join-meeting-inline"}
            >
              <Video className="w-3.5 h-3.5" />
              {isProvider ? "Start Meeting" : "Join Meeting"}
            </a>
          </div>
        )}

        {isConfirmed && isProvider && !hasPassed && !showRescheduleForm && (
          <div className="flex items-center justify-center gap-2 px-4 py-3 border-t bg-muted/20">
            <Button size="sm" variant="outline" className="gap-1 text-xs" onClick={() => setShowRescheduleForm(true)} data-testid="button-reschedule-booking-inline">
              <CalendarClock className="w-3.5 h-3.5" /> Reschedule
            </Button>
            <Button size="sm" variant="outline" className="text-destructive gap-1 text-xs" onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending} data-testid="button-cancel-booking-inline">
              {cancelMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
              Cancel
            </Button>
          </div>
        )}

        {/* Parent-only action buttons - matches parent /chat InlineBookingCalendar */}
        {isParent && booking.publicToken && !wasCompleted && !isNoShow && !isParentNoShow && !isProviderNoShow && !isCancelled && (
          <div className="flex items-center justify-center gap-2 px-4 py-3 border-t bg-muted/20">
            <button
              onClick={() => onRequestReschedule?.()}
              className="text-center text-xs font-medium px-4 py-2 rounded-[var(--radius)] border border-border hover:bg-muted transition-colors cursor-pointer"
              data-testid="button-reschedule-parent-inline"
            >
              Reschedule
            </button>
            <button
              onClick={() => onRequestCancel?.()}
              className="text-center text-xs font-medium px-4 py-2 rounded-[var(--radius)] border border-destructive/30 text-destructive hover:bg-destructive/5 transition-colors cursor-pointer"
              data-testid="button-cancel-parent-inline"
            >
              Cancel
            </button>
          </div>
        )}
      </>);
}
