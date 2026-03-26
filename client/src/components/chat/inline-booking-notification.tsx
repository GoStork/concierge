import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2, X, CalendarClock, Clock, Crown, Check } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { format } from "date-fns";
import { InlineSuggestTimeForm } from "./inline-suggest-time-form";

interface InlineBookingNotificationProps {
  booking: any;
  brandColor: string;
  onUpdate: () => void;
}

export function InlineBookingNotification({ booking, brandColor, onUpdate }: InlineBookingNotificationProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [showSuggestForm, setShowSuggestForm] = useState(false);
  const isProvider = booking?.providerUserId === user?.id;
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

  if (!booking) return null;
  const start = new Date(booking.scheduledAt);
  const providerName = booking.providerUser?.name || "Provider";
  const orgName = booking.providerUser?.provider?.name || "";

  const members = booking.parentAccountMembers || [];
  const attendees = members.length > 0
    ? members
    : booking.parentUser
    ? [booking.parentUser]
    : [];

  return (
    <div className="mx-auto max-w-[85%] my-3" data-testid={`inline-booking-card-${booking.id}`}>
      <div
        className="bg-card border border-border overflow-hidden"
        style={{ borderRadius: "var(--container-radius, 0.5rem)" }}
      >
        <div className="p-1.5" style={{ backgroundColor: brandColor }}>
          <div className="flex items-center gap-2 px-3 py-1.5">
            <CalendarClock className="w-4 h-4 text-primary-foreground" />
            <span className="text-primary-foreground text-xs font-semibold uppercase tracking-wider">
              {orgName ? `${orgName} Consultation Call` : "Consultation Call"}
            </span>
          </div>
        </div>

        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
              isConfirmed
                ? "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))]"
                : isPending
                ? "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))]"
                : isCancelled
                ? "bg-destructive/10 text-destructive"
                : isRescheduled
                ? "bg-muted text-muted-foreground"
                : "bg-muted text-foreground"
            }`}>
              {isPending ? "Pending Approval" : isCancelled ? "Cancelled" : isRescheduled ? "Rescheduled" : booking.status}
            </span>
          </div>

          <div className="bg-muted/40 rounded-[var(--radius)] p-3 space-y-2.5 border border-border">
            <div className="flex items-center gap-2 text-sm">
              <CalendarClock className="w-4 h-4 text-muted-foreground shrink-0" />
              <span>{format(start, "EEEE, MMMM d, yyyy")}</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
              <span>{format(start, "h:mm a")} ({booking.duration} min)</span>
            </div>
          </div>

          <div className="bg-muted/40 rounded-[var(--radius)] p-3 border border-border">
            <div className="flex items-center gap-2 mb-2">
              <Crown className="w-3.5 h-3.5" style={{ color: brandColor }} />
              <span className="text-xs font-semibold">Participants</span>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm pl-1">
                <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: `${brandColor}1A` }}>
                  <Crown className="w-3 h-3" style={{ color: brandColor }} />
                </div>
                <span className="font-medium text-xs">{providerName}</span>
                <span className="text-xs text-muted-foreground">(Host)</span>
              </div>
              {attendees.map((a: any) => (
                <div key={a.id || a.email} className="flex items-center gap-2 text-sm pl-1">
                  <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <Check className="w-3 h-3 text-primary" />
                  </div>
                  <span className="font-medium text-xs">{a.name || a.email}</span>
                  {a.email && a.name && <span className="text-xs text-muted-foreground">({a.email})</span>}
                </div>
              ))}
            </div>
          </div>

          {isPending && isProvider && (
            <div className="bg-[hsl(var(--brand-warning)/0.08)] border border-[hsl(var(--brand-warning)/0.3)] rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-[hsl(var(--brand-warning))]">This meeting request needs your confirmation</p>
              <p className="text-[11px] text-[hsl(var(--brand-warning))] mt-0.5">Requested by {booking.attendeeName || booking.parentUser?.name || "a parent"}.</p>
            </div>
          )}

          {isPending && !isProvider && (
            <div className="bg-[hsl(var(--brand-warning)/0.08)] border border-[hsl(var(--brand-warning)/0.3)] rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-[hsl(var(--brand-warning))]">Awaiting provider confirmation</p>
              <p className="text-[11px] text-[hsl(var(--brand-warning))] mt-0.5">We'll send you an email once {providerName} confirms your booking.</p>
            </div>
          )}

          {isConfirmed && (
            <div className="bg-[hsl(var(--brand-success)/0.08)] border border-[hsl(var(--brand-success)/0.3)] rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-[hsl(var(--brand-success))]">Meeting confirmed</p>
              <p className="text-[11px] text-[hsl(var(--brand-success))] mt-0.5">This meeting has been confirmed. You'll receive a reminder before it starts.</p>
            </div>
          )}

          {isCancelled && (
            <div className="bg-destructive/5 border border-destructive/20 rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-destructive">Meeting cancelled</p>
              <p className="text-[11px] text-destructive/80 mt-0.5">This meeting has been cancelled by the parent.</p>
            </div>
          )}

          {isRescheduled && (
            <div className="bg-muted/60 border border-border rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-muted-foreground">Meeting rescheduled</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">This meeting was rescheduled. A new booking has been created.</p>
            </div>
          )}

          {showSuggestForm && isPending && isProvider && (
            <div className="border border-border/50 rounded-[var(--radius)] p-3 space-y-2">
              <p className="text-sm font-medium">Suggest a new time</p>
              <InlineSuggestTimeForm
                bookingId={booking.id}
                onCancel={() => setShowSuggestForm(false)}
                onSuccess={() => { setShowSuggestForm(false); onUpdate(); }}
              />
            </div>
          )}
        </div>

        {isPending && isProvider && !showSuggestForm && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t bg-muted/20">
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
      </div>
    </div>
  );
}
