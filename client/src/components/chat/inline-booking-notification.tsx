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

  return cardChrome(<>
        <div className="space-y-3">
          {/* Hero status display - matches parent /chat InlineBookingCalendar so all
              three views (parent, provider, admin) show the same state visual. */}
          <div className="text-center space-y-1 py-1">
            {isParentCancelled ? (
              <>
                <div className="w-12 h-12 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
                  <X className="w-6 h-6 text-destructive" />
                </div>
                <p className="font-bold text-sm">Parent Cancelled</p>
                <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-destructive/10 text-destructive">
                  Parent Cancelled
                </span>
              </>
            ) : isProviderCancelled ? (
              <>
                <div className="w-12 h-12 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
                  <X className="w-6 h-6 text-destructive" />
                </div>
                <p className="font-bold text-sm">Provider Cancelled</p>
                <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-destructive/10 text-destructive">
                  Provider Cancelled
                </span>
              </>
            ) : isCancelled ? (
              <>
                <div className="w-12 h-12 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
                  <X className="w-6 h-6 text-destructive" />
                </div>
                <p className="font-bold text-sm">Meeting Cancelled</p>
                <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-destructive/10 text-destructive">
                  Cancelled
                </span>
              </>
            ) : wasCompleted ? (
              <>
                <div className="w-12 h-12 mx-auto rounded-full bg-muted flex items-center justify-center">
                  <Check className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="font-bold text-sm">Meeting Completed</p>
                <span className="t-micro-label inline-block px-2 py-0.5 rounded-full bg-muted">
                  Completed
                </span>
              </>
            ) : isParentNoShow ? (
              <>
                <div className="w-12 h-12 mx-auto rounded-full bg-muted flex items-center justify-center">
                  <Clock className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="font-bold text-sm">Parent No Show</p>
                <span className="t-micro-label inline-block px-2 py-0.5 rounded-full bg-muted">
                  Parent No Show
                </span>
              </>
            ) : isProviderNoShow ? (
              <>
                <div className="w-12 h-12 mx-auto rounded-full bg-muted flex items-center justify-center">
                  <Clock className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="font-bold text-sm">Provider No Show</p>
                <span className="t-micro-label inline-block px-2 py-0.5 rounded-full bg-muted">
                  Provider No Show
                </span>
              </>
            ) : isNoShow ? (
              <>
                <div className="w-12 h-12 mx-auto rounded-full bg-muted flex items-center justify-center">
                  <Clock className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="font-bold text-sm">No Show</p>
                <span className="t-micro-label inline-block px-2 py-0.5 rounded-full bg-muted">
                  No Show
                </span>
              </>
            ) : isConfirmed ? (
              <>
                <div className="w-12 h-12 mx-auto rounded-full bg-[hsl(var(--brand-success)/0.12)] flex items-center justify-center">
                  <Check className="w-6 h-6 text-[hsl(var(--brand-success))]" />
                </div>
                <p className="font-bold text-sm">Confirmed</p>
                <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))]">
                  Confirmed
                </span>
              </>
            ) : isRescheduled ? (
              <>
                <div className="w-12 h-12 mx-auto rounded-full bg-muted flex items-center justify-center">
                  <CalendarClock className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="font-bold text-sm">Rescheduled</p>
                <span className="t-micro-label inline-block px-2 py-0.5 rounded-full bg-muted">
                  Rescheduled
                </span>
              </>
            ) : isPending ? (
              <>
                <div className="w-12 h-12 mx-auto rounded-full bg-[hsl(var(--brand-warning)/0.12)] flex items-center justify-center">
                  <Clock className="w-6 h-6 text-[hsl(var(--brand-warning))]" />
                </div>
                <p className="font-bold text-sm">Awaiting Confirmation</p>
                <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))]">
                  Pending
                </span>
              </>
            ) : null}
          </div>

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

          {isPending && !isNoShow && !isParentNoShow && !isProviderNoShow && isProvider && (
            <div className="bg-[hsl(var(--brand-warning)/0.08)] border border-[hsl(var(--brand-warning)/0.3)] rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-[hsl(var(--brand-warning))]">This meeting request needs your confirmation</p>
              <p className="text-[11px] text-[hsl(var(--brand-warning))] mt-0.5">Requested by {booking.attendeeName || booking.parentUser?.name || "a parent"}.</p>
            </div>
          )}

          {isPending && !isNoShow && !isParentNoShow && !isProviderNoShow && !isProvider && (
            <div className="bg-[hsl(var(--brand-warning)/0.08)] border border-[hsl(var(--brand-warning)/0.3)] rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-[hsl(var(--brand-warning))]">Awaiting provider confirmation</p>
              <p className="text-[11px] text-[hsl(var(--brand-warning))] mt-0.5">We'll send you an email once {providerName} confirms your booking.</p>
            </div>
          )}

          {isConfirmed && !wasCompleted && !isNoShow && !isParentNoShow && !isProviderNoShow && (
            <div className="bg-[hsl(var(--brand-success)/0.08)] border border-[hsl(var(--brand-success)/0.3)] rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-[hsl(var(--brand-success))]">Meeting confirmed</p>
              <p className="text-[11px] text-[hsl(var(--brand-success))] mt-0.5">This meeting has been confirmed. You'll receive a reminder before it starts.</p>
            </div>
          )}

          {wasCompleted && (
            <div className="bg-muted/60 border border-border rounded-[var(--radius)] p-3">
              <p className="t-helper">Meeting completed</p>
              <p className="t-helper mt-0.5">Both parties joined this consultation.</p>
            </div>
          )}

          {isParentNoShow && (
            <div className="bg-muted/60 border border-border rounded-[var(--radius)] p-3">
              <p className="t-helper">Parent no show</p>
              <p className="t-helper mt-0.5">The provider joined the meeting room but the parent did not.</p>
            </div>
          )}

          {isProviderNoShow && (
            <div className="bg-muted/60 border border-border rounded-[var(--radius)] p-3">
              <p className="t-helper">Provider no show</p>
              <p className="t-helper mt-0.5">The parent joined the meeting room but the provider did not.</p>
            </div>
          )}

          {isNoShow && (
            <div className="bg-muted/60 border border-border rounded-[var(--radius)] p-3">
              <p className="t-helper">No show</p>
              <p className="t-helper mt-0.5">The scheduled time has passed and no one joined the meeting room.</p>
            </div>
          )}

          {isParentCancelled && (
            <div className="bg-destructive/5 border border-destructive/20 rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-destructive">Parent cancelled</p>
              <p className="text-[11px] text-destructive/80 mt-0.5">This meeting was cancelled by the parent.</p>
            </div>
          )}

          {isProviderCancelled && (
            <div className="bg-destructive/5 border border-destructive/20 rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-destructive">Provider cancelled</p>
              <p className="text-[11px] text-destructive/80 mt-0.5">This meeting was cancelled by the provider.</p>
            </div>
          )}

          {isCancelled && !isParentCancelled && !isProviderCancelled && (
            <div className="bg-destructive/5 border border-destructive/20 rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-destructive">Meeting cancelled</p>
              <p className="text-[11px] text-destructive/80 mt-0.5">This meeting has been cancelled.</p>
            </div>
          )}

          {isRescheduled && (
            <div className="bg-muted/60 border border-border rounded-[var(--radius)] p-3">
              <p className="t-helper">Meeting rescheduled</p>
              <p className="t-helper mt-0.5">This meeting was rescheduled. A new booking has been created.</p>
            </div>
          )}

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
