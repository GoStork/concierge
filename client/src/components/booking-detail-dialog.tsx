/**
 * Booking detail dialog - the meeting popup used by the Calendar page and
 * the three Home dashboards (parent / provider / admin upcoming meetings).
 * Extracted from calendar-page so Home rows can open the exact same popup
 * (Join / Confirm / Decline / Reschedule / Suggest time / Cancel) without
 * navigating away. Single implementation - never fork.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Clock, Crown, Users, Video, FileText, Check, X, CalendarClock, Loader2 } from "lucide-react";

/** Every mutation in this dialog changes booking state that multiple surfaces
 *  derive from: the Calendar page, the pending work queues, and the admin Home
 *  dashboard aggregate (Needs-attention pending meetings). Invalidate them all
 *  in one place - a key that isn't in the viewer's cache is a no-op. */
function invalidateBookingQueries() {
  queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
  queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings/pending"] });
  queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings/pending-count"] });
  queryClient.invalidateQueries({ queryKey: ["/api/admin/dashboard"] });
}

export function SuggestTimeForm({ bookingId, onCancel, onSuccess }: { bookingId: string; onCancel: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const [suggestDate, setSuggestDate] = useState("");
  const [suggestTime, setSuggestTime] = useState("10:00");
  const [message, setMessage] = useState("");

  const suggestMutation = useMutation({
    mutationFn: async () => {
      if (!suggestDate || !suggestTime) throw new Error("Please select a date and time");
      await apiRequest("POST", `/api/calendar/bookings/${bookingId}/suggest-time`, {
        scheduledAt: new Date(`${suggestDate}T${suggestTime}:00`).toISOString(),
        message: message || undefined,
      });
    },
    onSuccess: () => {
      invalidateBookingQueries();
      toast({ title: "New time suggested", description: "The parent has been notified.", variant: "success" });
      onSuccess();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-2 pt-1">
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" value={suggestDate} onChange={(e) => setSuggestDate(e.target.value)} data-testid="input-suggest-date" className="h-8 text-xs" />
        <Input type="time" value={suggestTime} onChange={(e) => setSuggestTime(e.target.value)} data-testid="input-suggest-time" className="h-8 text-xs" />
      </div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Add a message (optional)"
        className="w-full text-xs rounded-[var(--radius)] border border-input bg-background px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
        rows={2}
        data-testid="input-suggest-message"
      />
      <div className="flex gap-2">
        <Button size="sm" className="flex-1 h-7 text-xs gap-1" onClick={() => suggestMutation.mutate()} disabled={suggestMutation.isPending || !suggestDate} data-testid="button-send-suggestion">
          {suggestMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Send
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function RescheduleForm({ bookingId, onCancel, onSuccess }: { bookingId: string; onCancel: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleTime, setRescheduleTime] = useState("10:00");
  const [message, setMessage] = useState("");

  const rescheduleMutation = useMutation({
    mutationFn: async () => {
      if (!rescheduleDate || !rescheduleTime) throw new Error("Please select a date and time");
      await apiRequest("POST", `/api/calendar/bookings/${bookingId}/reschedule`, {
        scheduledAt: new Date(`${rescheduleDate}T${rescheduleTime}:00`).toISOString(),
        message: message || undefined,
      });
    },
    onSuccess: () => {
      invalidateBookingQueries();
      toast({ title: "Meeting rescheduled", variant: "success" });
      onSuccess();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-2 pt-1">
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" value={rescheduleDate} onChange={(e) => setRescheduleDate(e.target.value)} data-testid="input-reschedule-date" className="h-8 text-xs" />
        <Input type="time" value={rescheduleTime} onChange={(e) => setRescheduleTime(e.target.value)} data-testid="input-reschedule-time" className="h-8 text-xs" />
      </div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Add a message (optional)"
        className="w-full text-xs rounded-[var(--radius)] border border-input bg-background px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
        rows={2}
        data-testid="input-reschedule-message"
      />
      <div className="flex gap-2">
        <Button size="sm" className="flex-1 h-7 text-xs gap-1" onClick={() => rescheduleMutation.mutate()} disabled={rescheduleMutation.isPending || !rescheduleDate} data-testid="button-confirm-reschedule">
          {rescheduleMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Reschedule
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

export function BookingDetailDialog({ booking, open, onClose }: { booking: any; open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [showSuggestForm, setShowSuggestForm] = useState(false);
  const [showRescheduleForm, setShowRescheduleForm] = useState(false);
  const isProvider = booking?.providerUserId === user?.id;
  const isPending = booking?.status === "PENDING";
  const isConfirmed = booking?.status === "CONFIRMED";
  const isExpired = booking?.status === "EXPIRED";

  const cancelMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/calendar/bookings/${booking.id}`, { status: "CANCELLED" });
    },
    onSuccess: () => {
      invalidateBookingQueries();
      toast({ title: "Booking cancelled", variant: "success" });
      onClose();
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/calendar/bookings/${booking.id}/confirm`, {});
    },
    onSuccess: () => {
      invalidateBookingQueries();
      toast({ title: "Meeting confirmed", description: "The parent has been notified.", variant: "success" });
      onClose();
    },
  });

  const declineMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/calendar/bookings/${booking.id}/decline`, {});
    },
    onSuccess: () => {
      invalidateBookingQueries();
      toast({ title: "Meeting declined", description: "The parent has been notified.", variant: "success" });
      onClose();
    },
  });

  if (!booking) return null;
  const start = new Date(booking.scheduledAt);
  const end = new Date(start.getTime() + (booking.duration || 30) * 60 * 1000);
  const hasPassed = new Date() > end;
  const parentJoined = !!booking.parentJoinedMeetingAt;
  const providerJoined = !!booking.providerJoinedMeetingAt;
  const wasCompleted = hasPassed && booking.status === "CONFIRMED" && parentJoined && providerJoined;
  const isParentNoShow = hasPassed && booking.status === "CONFIRMED" && providerJoined && !parentJoined;
  const isProviderNoShow = hasPassed && booking.status === "CONFIRMED" && parentJoined && !providerJoined;
  const isNoShow = hasPassed && !wasCompleted && !isParentNoShow && !isProviderNoShow && booking.status !== "CANCELLED" && booking.status !== "RESCHEDULED" && booking.status !== "EXPIRED";
  const isParentCancelled = booking.status === "CANCELLED" && booking.cancelledByRole === "parent";
  const isProviderCancelled = booking.status === "CANCELLED" && booking.cancelledByRole === "provider";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg" style={{ backgroundColor: booking.status === "CANCELLED" ? "hsl(var(--destructive))" : wasCompleted || isNoShow ? "hsl(var(--muted-foreground))" : booking.status === "PENDING" ? "hsl(var(--brand-warning))" : "hsl(var(--primary))" }} />
        <DialogHeader>
          <DialogTitle>{booking.subject || "Appointment"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <span>{format(start, "EEEE, MMMM d, yyyy")} at {format(start, "h:mm a")}</span>
            <span className="text-muted-foreground">({booking.duration} min)</span>
          </div>
          {booking.providerUser && (
            <div className="flex items-center gap-2 text-sm">
              <Crown className="w-4 h-4 text-primary" />
              <span>{booking.providerUser.name || booking.providerUser.email}</span>
              <span className="text-xs text-muted-foreground">(Host)</span>
            </div>
          )}
          {(() => {
            const members = booking.parentAccountMembers || [];
            if (members.length > 0) {
              return members.map((m: any) => (
                <div key={m.id} className="flex items-center gap-2 text-sm">
                  <Users className="w-4 h-4 text-muted-foreground" />
                  <span>{m.name || m.email}</span>
                </div>
              ));
            }
            if (booking.parentUser) {
              return (
                <div className="flex items-center gap-2 text-sm">
                  <Users className="w-4 h-4 text-muted-foreground" />
                  <span>{booking.parentUser.name || booking.parentUser.email}</span>
                </div>
              );
            }
            return null;
          })()}
          {booking.meetingUrl && (
            <div className="flex items-center gap-2 text-sm">
              <Video className="w-4 h-4 text-muted-foreground" />
              <a href={booking.meetingUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline truncate">{booking.meetingUrl}</a>
            </div>
          )}
          {booking.notes && (
            <p className="text-sm text-muted-foreground bg-secondary/30 rounded-[var(--radius)] p-2">{booking.notes}</p>
          )}
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-ui ${
              booking.status === "CANCELLED" ? "bg-destructive/15 text-destructive" :
              booking.status === "RESCHEDULED" ? "bg-muted text-muted-foreground" :
              booking.status === "EXPIRED" ? "bg-muted text-muted-foreground" :
              wasCompleted || isParentNoShow || isProviderNoShow || isNoShow ? "bg-muted text-muted-foreground" :
              booking.status === "CONFIRMED" ? "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))]" :
              booking.status === "PENDING" ? "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))]" :
              "bg-muted text-foreground"
            }`}>
              {booking.status === "RESCHEDULED" ? "Rescheduled"
                : booking.status === "EXPIRED" ? "Expired"
                : isParentCancelled ? "Parent Cancelled"
                : isProviderCancelled ? "Provider Cancelled"
                : booking.status === "CANCELLED" ? "Cancelled"
                : wasCompleted ? "Completed"
                : isParentNoShow ? "Parent No Show"
                : isProviderNoShow ? "Provider No Show"
                : isNoShow ? "No Show"
                : booking.status === "PENDING" ? "Awaiting Confirmation"
                : booking.status}
            </span>
          </div>
          {isConfirmed && booking.providerUser?.dailyRoomUrl && booking.meetingType !== "phone" && (
            <a
              href={`/room/${booking.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 w-full justify-center rounded-[var(--radius)] px-4 py-2.5 text-sm font-ui bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
              data-testid={isProvider ? "button-start-meeting" : "button-join-meeting"}
            >
              <Video className="w-4 h-4" />
              {isProvider ? "Start Meeting" : "Join Meeting"}
            </a>
          )}

          {isPending && !isNoShow && isProvider && (
            <div className="bg-[hsl(var(--brand-warning)/0.08)] border border-[hsl(var(--brand-warning)/0.3)] rounded-[var(--radius)] p-3">
              <p className="text-sm text-[hsl(var(--brand-warning))] font-ui">This meeting request needs your confirmation</p>
              <p className="text-xs text-[hsl(var(--brand-warning))] mt-1">Requested by {booking.attendeeName || booking.parentUser?.name || "a parent"}.</p>
            </div>
          )}

          {isPending && !isNoShow && !isProvider && (
            <div className="bg-[hsl(var(--brand-warning)/0.08)] border border-[hsl(var(--brand-warning)/0.3)] rounded-[var(--radius)] p-3">
              <p className="text-sm text-[hsl(var(--brand-warning))] font-ui">Awaiting provider confirmation</p>
            </div>
          )}

          {wasCompleted && (
            <div className="bg-muted/60 border border-border rounded-[var(--radius)] p-3">
              <p className="text-sm font-ui text-muted-foreground">Meeting completed</p>
              <p className="text-xs text-muted-foreground mt-1">Both parties joined this consultation.</p>
            </div>
          )}

          {isParentNoShow && (
            <div className="bg-muted/60 border border-border rounded-[var(--radius)] p-3">
              <p className="text-sm font-ui text-muted-foreground">Parent no show</p>
              <p className="text-xs text-muted-foreground mt-1">The provider joined the meeting room but the parent did not.</p>
            </div>
          )}

          {isProviderNoShow && (
            <div className="bg-muted/60 border border-border rounded-[var(--radius)] p-3">
              <p className="text-sm font-ui text-muted-foreground">Provider no show</p>
              <p className="text-xs text-muted-foreground mt-1">The parent joined the meeting room but the provider did not.</p>
            </div>
          )}

          {isNoShow && (
            <div className="bg-muted/60 border border-border rounded-[var(--radius)] p-3">
              <p className="text-sm font-ui text-muted-foreground">No show</p>
              <p className="text-xs text-muted-foreground mt-1">The scheduled time has passed and no one joined the meeting room.</p>
            </div>
          )}

          {booking.actualEndedAt && booking.consentGiven && (
            <Link
              to={`/recordings/${booking.id}`}
              className="inline-flex items-center gap-2 w-full justify-center rounded-[var(--radius)] px-4 py-2.5 text-sm font-ui border border-border hover:bg-secondary/50 transition-colors"
              data-testid="link-view-recording"
            >
              <FileText className="w-4 h-4" />
              View Recording & Transcript
            </Link>
          )}
        </div>
        {showSuggestForm && (isPending || isExpired) && isProvider && !isNoShow && (
          <div className="border border-border/50 rounded-[var(--radius)] p-3 space-y-2">
            <p className="text-sm font-ui">Suggest a new time</p>
            <SuggestTimeForm
              bookingId={booking.id}
              onCancel={() => setShowSuggestForm(false)}
              onSuccess={() => { setShowSuggestForm(false); onClose(); }}
            />
          </div>
        )}
        {showRescheduleForm && !wasCompleted && !isNoShow && (isConfirmed || (isPending && !isProvider)) && (
          <div className="border border-border/50 rounded-[var(--radius)] p-3 space-y-2">
            <p className="text-sm font-ui">Reschedule to a new time</p>
            <RescheduleForm
              bookingId={booking.id}
              onCancel={() => setShowRescheduleForm(false)}
              onSuccess={() => { setShowRescheduleForm(false); onClose(); }}
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-4 border-t">
          {!isNoShow && !isParentNoShow && !isProviderNoShow && isPending && isProvider && !showSuggestForm && (
            <>
              <Button size="sm" onClick={() => confirmMutation.mutate()} disabled={confirmMutation.isPending || declineMutation.isPending} className="gap-1" data-testid="button-confirm-booking">
                {confirmMutation.isPending ? "Confirming..." : <><Check className="w-4 h-4" /> Confirm</>}
              </Button>
              <Button size="sm" variant="outline" className="text-destructive gap-1" onClick={() => declineMutation.mutate()} disabled={confirmMutation.isPending || declineMutation.isPending} data-testid="button-decline-booking">
                {declineMutation.isPending ? "Declining..." : <><X className="w-4 h-4" /> Decline</>}
              </Button>
              <Button size="sm" variant="outline" className="gap-1" onClick={() => setShowSuggestForm(true)} data-testid="button-suggest-new-time">
                <CalendarClock className="w-4 h-4" /> New Time
              </Button>
            </>
          )}
          {!wasCompleted && !isNoShow && !isParentNoShow && !isProviderNoShow && (isConfirmed || (isPending && !isProvider)) && !showRescheduleForm && (
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setShowRescheduleForm(true)} data-testid="button-reschedule-booking">
              <CalendarClock className="w-4 h-4" /> Reschedule
            </Button>
          )}
          {isExpired && isProvider && !showSuggestForm && (
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setShowSuggestForm(true)} data-testid="button-suggest-new-time-expired">
              <CalendarClock className="w-4 h-4" /> New Time
            </Button>
          )}
          {!wasCompleted && !isNoShow && !isParentNoShow && !isProviderNoShow && booking.status !== "CANCELLED" && booking.status !== "RESCHEDULED" && (!isPending || !isProvider) && !showSuggestForm && (
            <Button size="sm" variant="outline" className="text-destructive" onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending} data-testid="button-cancel-booking">
              {cancelMutation.isPending ? "Cancelling..." : "Cancel Booking"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onClose} className="ml-auto">Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
