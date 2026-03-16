import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import {
  Loader2, Calendar, Clock, Video, User, Users, Check, X, RefreshCw
} from "lucide-react";
import { AddToCalendarButtons } from "@/components/calendar/add-to-calendar-buttons";
import { format } from "date-fns";
import { useCompanyName } from "@/hooks/use-brand-settings";

function formatTime12(date: Date): string {
  return format(date, "h:mm a");
}

export default function BookingConfirmationPage() {
  const { bookingId: token } = useParams<{ bookingId: string }>();
  const companyName = useCompanyName();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [newDate, setNewDate] = useState("");
  const [newTime, setNewTime] = useState("");

  const { data: booking, isLoading } = useQuery({
    queryKey: ["/api/calendar/booking", token],
    queryFn: async () => {
      const res = await fetch(`/api/calendar/booking/${token}`);
      if (!res.ok) throw new Error("Booking not found");
      return res.json();
    },
    enabled: !!token,
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/calendar/booking/${token}/cancel-public`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/booking", token] });
      setCancelOpen(false);
    },
  });

  const rescheduleMutation = useMutation({
    mutationFn: async () => {
      if (!newDate || !newTime) throw new Error("Select date and time");
      const res = await apiRequest("POST", `/api/calendar/booking/${token}/reschedule-public`, {
        scheduledAt: `${newDate}T${newTime}:00`,
        bookerTimezone: booking?.bookerTimezone,
      });
      return res.json();
    },
    onSuccess: (data) => {
      window.location.href = `/booking/${data.publicToken}`;
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!booking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-display font-heading mb-2">Booking Not Found</h1>
          <p className="text-muted-foreground">This booking may have been cancelled or doesn't exist.</p>
        </div>
      </div>
    );
  }

  const start = new Date(booking.scheduledAt);
  const isCancelled = booking.status === "CANCELLED";
  const isRescheduled = booking.status === "RESCHEDULED";
  const isPending = booking.status === "PENDING";
  const isConfirmed = booking.status === "CONFIRMED";
  const isActive = !isCancelled && !isRescheduled;

  const providerPhoto = booking.providerUser?.photoUrl
    ? booking.providerUser.photoUrl.startsWith("/uploads")
      ? booking.providerUser.photoUrl
      : `/api/uploads/proxy?url=${encodeURIComponent(booking.providerUser.photoUrl)}`
    : null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-primary/5 to-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-card rounded-2xl border border-border/50 shadow-lg p-8">
          <div className="text-center mb-6">
            {isCancelled ? (
              <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-destructive/15 flex items-center justify-center">
                <X className="w-7 h-7 text-destructive" />
              </div>
            ) : isRescheduled ? (
              <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-[hsl(var(--brand-warning)/0.12)] flex items-center justify-center">
                <RefreshCw className="w-7 h-7 text-[hsl(var(--brand-warning))]" />
              </div>
            ) : isPending ? (
              <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-[hsl(var(--brand-warning)/0.12)] flex items-center justify-center">
                <Clock className="w-7 h-7 text-[hsl(var(--brand-warning))]" />
              </div>
            ) : (
              <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-[hsl(var(--brand-success)/0.12)] flex items-center justify-center">
                <Check className="w-7 h-7 text-[hsl(var(--brand-success))]" />
              </div>
            )}
            <h1 className="text-2xl font-display font-heading" data-testid="text-booking-status">
              {isCancelled ? "Booking Cancelled" : isRescheduled ? "Booking Rescheduled" : isPending ? "Awaiting Confirmation" : "Booking Confirmed"}
            </h1>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-ui mt-2 ${
              booking.status === "CONFIRMED" ? "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))]" :
              booking.status === "CANCELLED" ? "bg-destructive/15 text-destructive" :
              booking.status === "PENDING" ? "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))]" :
              booking.status === "RESCHEDULED" ? "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))]" :
              "bg-muted text-foreground"
            }`} data-testid="text-status-badge">
              {booking.status}
            </span>
          </div>

          <div className="bg-secondary/30 rounded-xl p-4 space-y-3 mb-6">
            <div className="flex items-center gap-3">
              {providerPhoto ? (
                <img src={providerPhoto} alt="" className="w-10 h-10 rounded-full object-cover" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                  <User className="w-5 h-5" />
                </div>
              )}
              <div>
                <p className="font-ui text-sm">{booking.providerUser?.name || "Provider"}</p>
                {booking.providerUser?.provider && (
                  <p className="text-xs text-muted-foreground">{booking.providerUser.provider.name}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Calendar className="w-4 h-4 text-primary shrink-0" />
              <span>{format(start, "EEEE, MMMM d, yyyy")}</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Clock className="w-4 h-4 text-primary shrink-0" />
              <span>{formatTime12(start)} ({booking.duration} min)</span>
            </div>
            {booking.meetingUrl && (
              <div className="flex items-center gap-2 text-sm">
                <Video className="w-4 h-4 text-primary shrink-0" />
                <a href={booking.meetingUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline truncate" data-testid="link-meeting-url">
                  {booking.meetingUrl}
                </a>
              </div>
            )}
            {booking.subject && (
              <p className="text-sm text-muted-foreground">{booking.subject}</p>
            )}
            {booking.notes && (
              <p className="text-sm text-muted-foreground italic">{booking.notes}</p>
            )}
            {booking.rescheduledFrom && (
              <p className="text-xs text-muted-foreground">
                Rescheduled from {format(new Date(booking.rescheduledFrom.scheduledAt), "MMM d, yyyy h:mm a")}
              </p>
            )}
          </div>

          {(() => {
            const details: Record<string, { name?: string; phone?: string }> = booking.attendeeDetails || {};
            const emails: string[] = booking.attendeeEmails || [];
            const bookerEmail = emails[0];
            const seenEmails = new Set<string>();
            const participants: { label: string; sub?: string }[] = [];
            if (booking.attendeeName || bookerEmail) {
              participants.push({ label: booking.attendeeName || bookerEmail, sub: bookerEmail && booking.attendeeName ? bookerEmail : undefined });
              if (bookerEmail) seenEmails.add(bookerEmail.toLowerCase());
            }
            if (booking.parentUser && booking.parentUser.email?.toLowerCase() !== bookerEmail?.toLowerCase()) {
              participants.push({ label: booking.parentUser.name || booking.parentUser.email, sub: booking.parentUser.email });
              seenEmails.add(booking.parentUser.email.toLowerCase());
            }
            const pam = booking.parentAccountMembers || [];
            for (const m of pam) {
              if (seenEmails.has(m.email.toLowerCase())) continue;
              seenEmails.add(m.email.toLowerCase());
              participants.push({ label: m.name || m.email, sub: m.name ? m.email : undefined });
            }
            for (let i = 1; i < emails.length; i++) {
              const email = emails[i];
              if (seenEmails.has(email.toLowerCase())) continue;
              seenEmails.add(email.toLowerCase());
              const d = details[email.toLowerCase()] || {};
              participants.push({ label: d.name || email, sub: d.name ? email : undefined });
            }
            if (participants.length === 0) return null;
            return (
              <div className="bg-secondary/30 rounded-xl p-4 mb-6" data-testid="section-participants">
                <div className="flex items-center gap-2 mb-2">
                  <Users className="w-4 h-4 text-primary" />
                  <span className="text-sm font-ui">Participants</span>
                </div>
                <div className="space-y-1.5">
                  {participants.map((p, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm pl-6">
                      <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <User className="w-3 h-3 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <span className="font-ui" data-testid={`text-participant-name-${i}`}>{p.label}</span>
                        {p.sub && <span className="text-muted-foreground ml-1 text-xs">({p.sub})</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {isPending && (
            <div className="bg-[hsl(var(--brand-warning)/0.08)] border border-[hsl(var(--brand-warning)/0.3)] rounded-lg p-3 mb-4">
              <p className="text-sm text-[hsl(var(--brand-warning))] font-ui">Awaiting provider confirmation</p>
              <p className="text-xs text-[hsl(var(--brand-warning))] mt-1">We'll send you an email once {booking.providerUser?.name || "the provider"} confirms your booking.</p>
            </div>
          )}

          {isConfirmed && (
            <div className="mb-4">
              <p className="text-xs text-muted-foreground mb-3 flex items-center gap-1.5" data-testid="text-calendar-invite-note">
                <Check className="w-3.5 h-3.5 text-[hsl(var(--brand-success))] shrink-0" />
                A calendar invitation has been sent to your email
              </p>
              <AddToCalendarButtons booking={booking} />
              {booking.providerUser?.dailyRoomUrl && (
                <a
                  href={`/room/${booking.id}`}
                  className="flex items-center justify-center gap-2 mt-3 w-full py-2.5 px-4 rounded-lg bg-primary text-white text-sm font-ui hover:bg-primary/90 transition-colors"
                  data-testid="button-join-video-call"
                >
                  <Video className="w-4 h-4" />
                  Join Video Call
                </a>
              )}
            </div>
          )}

          {isActive && (
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setRescheduleOpen(true)} data-testid="button-reschedule">
                <RefreshCw className="w-4 h-4 mr-1" /> Reschedule
              </Button>
              <Button variant="outline" className="flex-1 text-destructive hover:text-destructive" onClick={() => setCancelOpen(true)} data-testid="button-cancel">
                <X className="w-4 h-4 mr-1" /> Cancel
              </Button>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground mt-4">
          Powered by <span className="font-ui text-primary">{companyName}</span>
        </p>
      </div>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Booking</DialogTitle>
            <DialogDescription>Are you sure you want to cancel this booking? This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)}>Keep Booking</Button>
            <Button variant="destructive" onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending} data-testid="button-confirm-cancel">
              {cancelMutation.isPending ? "Cancelling..." : "Yes, Cancel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rescheduleOpen} onOpenChange={setRescheduleOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reschedule Booking</DialogTitle>
            <DialogDescription>Select a new date and time for your appointment.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>New Date</Label>
              <Input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} data-testid="input-reschedule-date" />
            </div>
            <div className="space-y-1">
              <Label>New Time</Label>
              <Input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} data-testid="input-reschedule-time" />
            </div>
            {rescheduleMutation.isError && (
              <p className="text-sm text-destructive">{(rescheduleMutation.error as Error).message}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRescheduleOpen(false)}>Cancel</Button>
            <Button onClick={() => rescheduleMutation.mutate()} disabled={rescheduleMutation.isPending} data-testid="button-confirm-reschedule">
              {rescheduleMutation.isPending ? "Rescheduling..." : "Reschedule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
