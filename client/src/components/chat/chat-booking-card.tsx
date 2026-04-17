import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2, Check, X, CalendarClock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { format } from "date-fns";
import { InlineSuggestTimeForm } from "./inline-suggest-time-form";
import { RescheduleCalendarPicker } from "@/pages/concierge-chat-page";

interface ChatBookingCardProps {
  booking: any;
  /** Called after a confirm/decline/suggest action so the parent can refetch */
  onUpdate?: () => void;
  /** When true, no action buttons are shown (read-only view for parents) */
  readOnly?: boolean;
}

/**
 * Meeting request card that matches the visual style of the Meetings page
 * (PendingBookingCard). Used in chat right-sidebar for both admin and provider views.
 */
export function ChatBookingCard({ booking, onUpdate, readOnly }: ChatBookingCardProps) {
  const { toast } = useToast();
  const { data: brand } = useBrandSettings();
  const brandColor = brand?.primaryColor || "#004D4D";
  const queryClient = useQueryClient();
  const [showSuggest, setShowSuggest] = useState(false);
  const [showReschedule, setShowReschedule] = useState(false);

  const isPending = booking?.status === "PENDING";
  const isConfirmed = booking?.status === "CONFIRMED";
  const isCancelled = booking?.status === "CANCELLED";
  const isRescheduled = booking?.status === "RESCHEDULED";

  const start = new Date(booking.scheduledAt);
  const end = new Date(start.getTime() + (booking.duration || 30) * 60 * 1000);
  const isPast = new Date() > end;

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/calendar/bookings/${booking.id}/confirm`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to confirm");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting confirmed", description: "The parent has been notified.", variant: "success" as any });
      onUpdate?.();
    },
    onError: () => toast({ title: "Failed to confirm booking", variant: "destructive" }),
  });

  const declineMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/calendar/bookings/${booking.id}/decline`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to decline");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting declined", description: "The parent has been notified.", variant: "success" as any });
      onUpdate?.();
    },
    onError: () => toast({ title: "Failed to decline booking", variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/calendar/bookings/${booking.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status: "CANCELLED" }),
      });
      if (!res.ok) throw new Error("Failed to cancel");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting cancelled", description: "All participants have been notified.", variant: "success" as any });
      onUpdate?.();
    },
    onError: () => toast({ title: "Failed to cancel meeting", variant: "destructive" }),
  });

  const acting = confirmMutation.isPending || declineMutation.isPending;

  const isAdminHost = !!(booking.providerUser?.roles as string[] | undefined)?.includes("GOSTORK_ADMIN")
    || !booking.providerUser?.providerId;
  const subject = booking.subject || (isAdminHost ? "GoStork Concierge Call" : "Consultation Call");
  const attendeeName = booking.attendeeName || booking.parentUser?.name;

  const borderColor = isCancelled || isRescheduled
    ? "hsl(var(--muted-foreground))"
    : isPending
    ? "hsl(var(--brand-warning))"
    : isPast
    ? "hsl(var(--muted-foreground))"
    : "hsl(var(--brand-success))";

  const bgClass = isCancelled || isRescheduled || isPast
    ? "bg-muted/40 border-border"
    : isPending
    ? "bg-[hsl(var(--brand-warning)/0.08)] border-[hsl(var(--brand-warning)/0.3)]"
    : "bg-[hsl(var(--brand-success)/0.08)] border-[hsl(var(--brand-success)/0.3)]";

  const statusLabel = isRescheduled
    ? "Rescheduled"
    : isCancelled
    ? "Cancelled"
    : isPending
    ? "Awaiting Confirmation"
    : isPast
    ? "Completed"
    : "Confirmed";

  const statusClass = isCancelled || isRescheduled || isPast
    ? "bg-muted/50 text-muted-foreground border border-border"
    : isPending
    ? "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))] border border-[hsl(var(--brand-warning)/0.3)]"
    : "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))] border border-[hsl(var(--brand-success)/0.3)]";

  return (
    <div
      className={`rounded-[var(--radius)] border p-3 space-y-2 ${bgClass}`}
      style={{ borderLeft: `3px solid ${borderColor}` }}
      data-testid={`chat-booking-card-${booking.id}`}
    >
      <div>
        <p className="text-sm font-ui truncate">{attendeeName || "Meeting Request"}</p>
        <p className="text-xs text-muted-foreground">
          {format(start, "EEE, MMM d")} · {format(start, "h:mm a")} · {booking.duration || 30}min
        </p>
        <p className="text-xs text-muted-foreground truncate mt-0.5">{subject}</p>
      </div>

      {(isCancelled || isRescheduled || isPast || readOnly || (isConfirmed && !isPast)) && !isPending && (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-ui ${statusClass}`}>
          {statusLabel}
        </span>
      )}

      {isPending && !readOnly && !showSuggest && (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            <Button
              size="sm"
              className="h-7 text-xs gap-1 px-2.5 flex-1"
              onClick={() => confirmMutation.mutate()}
              disabled={acting}
              data-testid={`chat-booking-confirm-${booking.id}`}
            >
              {confirmMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Confirm
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1 px-2.5 flex-1 text-destructive border-destructive/30 hover:bg-destructive/10"
              onClick={() => declineMutation.mutate()}
              disabled={acting}
              data-testid={`chat-booking-decline-${booking.id}`}
            >
              {declineMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
              Decline
            </Button>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1 w-full"
            onClick={() => setShowSuggest(true)}
            disabled={acting}
            data-testid={`chat-booking-suggest-${booking.id}`}
          >
            <CalendarClock className="w-3 h-3" /> New Time
          </Button>
        </div>
      )}

      {isPending && !readOnly && showSuggest && (
        <InlineSuggestTimeForm
          bookingId={booking.id}
          onCancel={() => setShowSuggest(false)}
          onSuccess={() => {
            setShowSuggest(false);
            onUpdate?.();
          }}
        />
      )}

      {isPending && readOnly && (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-ui ${statusClass}`}>
          {statusLabel}
        </span>
      )}

      {isConfirmed && !isPast && !readOnly && !showReschedule && (
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1 flex-1"
            onClick={() => setShowReschedule(true)}
            data-testid={`chat-booking-reschedule-${booking.id}`}
          >
            <CalendarClock className="w-3 h-3" /> Reschedule
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1 flex-1 text-destructive border-destructive/30 hover:bg-destructive/10"
            onClick={() => cancelMutation.mutate()}
            disabled={cancelMutation.isPending}
            data-testid={`chat-booking-cancel-${booking.id}`}
          >
            {cancelMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
            Cancel
          </Button>
        </div>
      )}

      {isConfirmed && !isPast && !readOnly && showReschedule && booking.providerUser?.scheduleConfig?.bookingPageSlug && (
        <RescheduleCalendarPicker
          slug={booking.providerUser.scheduleConfig.bookingPageSlug}
          booking={booking}
          brandColor={brandColor}
          onRescheduled={() => { setShowReschedule(false); onUpdate?.(); }}
          onCancel={() => setShowReschedule(false)}
        />
      )}
    </div>
  );
}
