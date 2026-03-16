import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Loader2, Check, X, Clock, Calendar, Video, User, CalendarClock, MessageSquare, Mail, Phone
} from "lucide-react";
import { format } from "date-fns";
import { useCompanyName } from "@/hooks/use-brand-settings";

export default function BookingManagePage() {
  const { token } = useParams<{ token: string }>();
  const companyName = useCompanyName();
  const [loading, setLoading] = useState(true);
  const [booking, setBooking] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<"idle" | "confirming" | "declining" | "suggesting" | "done">("idle");
  const [result, setResult] = useState<{ action: string; booking?: any } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [suggestDate, setSuggestDate] = useState("");
  const [suggestTime, setSuggestTime] = useState("");

  useEffect(() => {
    if (!token) {
      setError("Invalid booking link");
      setLoading(false);
      return;
    }
    fetchBookingInfo();
  }, [token]);

  async function fetchBookingInfo() {
    try {
      const res = await fetch(`/api/calendar/booking/${token}/info`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message || "Unable to load booking details");
      }
      const data = await res.json();
      setBooking(data.booking);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function executeAction(action: "confirm" | "decline") {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/calendar/booking/${token}/${action}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message || `Action failed`);
      }
      const data = await res.json();
      setResult({ action, booking: data.booking });
      setActionState("done");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSuggestSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!suggestDate || !suggestTime) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/calendar/booking/${token}/suggest-time`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledAt: `${suggestDate}T${suggestTime}:00` }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message || "Failed to suggest new time");
      }
      const data = await res.json();
      setResult({ action: "suggest-time", booking: data.booking });
      setActionState("done");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-primary/5 to-background flex items-center justify-center p-4">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading booking details...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-primary/5 to-background flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="bg-card rounded-2xl border border-border/50 shadow-lg p-8 text-center">
            <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-destructive/15 flex items-center justify-center">
              <X className="w-7 h-7 text-destructive" />
            </div>
            <h1 className="text-2xl font-display font-heading mb-2" data-testid="text-manage-error">Unable to Process</h1>
            <p className="text-muted-foreground text-sm">{error}</p>
          </div>
          <p className="text-center text-xs text-muted-foreground mt-4">
            Powered by <span className="font-ui text-primary">{companyName}</span>
          </p>
        </div>
      </div>
    );
  }

  if (actionState === "done" && result) {
    const rb = result.booking || booking;
    const start = rb ? new Date(rb.scheduledAt) : null;
    const isConfirm = result.action === "confirm";
    const isDecline = result.action === "decline";

    return (
      <div className="min-h-screen bg-gradient-to-b from-primary/5 to-background flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="bg-card rounded-2xl border border-border/50 shadow-lg p-8 text-center">
            <div className={`w-14 h-14 mx-auto mb-4 rounded-full flex items-center justify-center ${
              isConfirm ? "bg-[hsl(var(--brand-success)/0.12)]" : isDecline ? "bg-destructive/15" : "bg-primary/10"
            }`}>
              {isConfirm ? <Check className="w-7 h-7 text-[hsl(var(--brand-success))]" /> :
               isDecline ? <X className="w-7 h-7 text-destructive" /> :
               <CalendarClock className="w-7 h-7 text-primary" />}
            </div>
            <h1 className="text-2xl font-display font-heading mb-1" data-testid="text-manage-result">
              {isConfirm ? "Meeting Confirmed!" : isDecline ? "Meeting Declined" : "New Time Suggested"}
            </h1>
            <p className="text-muted-foreground text-sm mb-6">
              {isConfirm ? `${rb?.attendeeName || "The parent"} has been notified that you've confirmed the meeting.` :
               isDecline ? `${rb?.attendeeName || "The parent"} has been notified that the meeting was declined.` :
               `${rb?.attendeeName || "The parent"} has been notified about the suggested new time.`}
            </p>

            {start && rb && (
              <div className="bg-secondary/30 rounded-xl p-4 space-y-3 text-left mb-4">
                <div className="flex items-center gap-2 text-sm">
                  <Calendar className="w-4 h-4 text-primary shrink-0" />
                  <span className="font-ui">{format(start, "EEEE, MMMM d, yyyy")}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Clock className="w-4 h-4 text-primary shrink-0" />
                  <span>{format(start, "h:mm a")} ({rb.duration} min)</span>
                </div>
                {rb.meetingUrl && (
                  <div className="flex items-center gap-2 text-sm">
                    <Video className="w-4 h-4 text-primary shrink-0" />
                    <a href={rb.meetingUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline truncate">
                      {rb.meetingUrl}
                    </a>
                  </div>
                )}
                <div className="flex items-center gap-2 text-sm">
                  <User className="w-4 h-4 text-primary shrink-0" />
                  <span>{rb.attendeeName || "Parent"} ({rb.attendeeEmails?.[0] || ""})</span>
                </div>
              </div>
            )}

            {isConfirm && (
              <p className="text-xs text-muted-foreground">The meeting has been added to your calendar and reminders will be sent before the meeting.</p>
            )}
          </div>
          <p className="text-center text-xs text-muted-foreground mt-4">
            Powered by <span className="font-ui text-primary">{companyName}</span>
          </p>
        </div>
      </div>
    );
  }

  const start = booking ? new Date(booking.scheduledAt) : null;
  const isPending = booking?.status === "PENDING";

  return (
    <div className="min-h-screen bg-gradient-to-b from-primary/5 to-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-card rounded-2xl border border-border/50 shadow-lg p-8">
          <div className="text-center mb-6">
            <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-[hsl(var(--brand-warning)/0.12)] flex items-center justify-center">
              <CalendarClock className="w-7 h-7 text-[hsl(var(--brand-warning))]" />
            </div>
            <h1 className="text-2xl font-display font-heading" data-testid="text-manage-title">
              {isPending ? "New Meeting Request" : "Meeting Details"}
            </h1>
            {isPending && (
              <p className="text-muted-foreground text-sm mt-1">
                {booking.attendeeName || "Someone"} would like to schedule a meeting with you.
              </p>
            )}
            {!isPending && booking?.status && (
              <div className={`inline-block mt-2 px-3 py-1 rounded-full text-xs font-ui ${
                booking.status === "CONFIRMED" ? "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))]" :
                booking.status === "CANCELLED" ? "bg-destructive/15 text-destructive" :
                "bg-muted text-foreground"
              }`} data-testid="text-manage-status">
                {booking.status === "CONFIRMED" ? "Confirmed" :
                 booking.status === "CANCELLED" ? "Cancelled" :
                 booking.status}
              </div>
            )}
          </div>

          {start && booking && (
            <div className="bg-secondary/30 rounded-xl p-4 space-y-3 mb-6">
              {booking.subject && (
                <div className="flex items-center gap-2 text-sm">
                  <MessageSquare className="w-4 h-4 text-primary shrink-0" />
                  <span className="font-ui">{booking.subject}</span>
                </div>
              )}
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="w-4 h-4 text-primary shrink-0" />
                <span>{format(start, "EEEE, MMMM d, yyyy")}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Clock className="w-4 h-4 text-primary shrink-0" />
                <span>{format(start, "h:mm a")} ({booking.duration} min)</span>
              </div>
              {booking.meetingUrl && (
                <div className="flex items-center gap-2 text-sm">
                  <Video className="w-4 h-4 text-primary shrink-0" />
                  <a href={booking.meetingUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline truncate">
                    {booking.meetingUrl}
                  </a>
                </div>
              )}
              <div className="flex items-center gap-2 text-sm">
                <User className="w-4 h-4 text-primary shrink-0" />
                <span>{booking.attendeeName || "Parent"}</span>
              </div>
              {booking.attendeeEmails?.[0] && (
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground">{booking.attendeeEmails[0]}</span>
                </div>
              )}
              {booking.attendeePhone && (
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground">{booking.attendeePhone}</span>
                </div>
              )}
              {booking.notes && (
                <div className="border-t border-border/50 pt-3 mt-3">
                  <p className="text-xs text-muted-foreground mb-1">Notes:</p>
                  <p className="text-sm">{booking.notes}</p>
                </div>
              )}
            </div>
          )}

          {isPending && actionState === "idle" && (
            <div className="space-y-3">
              <Button
                className="w-full gap-2 bg-[hsl(var(--brand-success))] hover:bg-[hsl(var(--brand-success))] text-white"
                onClick={() => setActionState("confirming")}
                data-testid="button-manage-confirm"
              >
                <Check className="w-4 h-4" /> Confirm Meeting
              </Button>
              <Button
                variant="outline"
                className="w-full gap-2 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setActionState("declining")}
                data-testid="button-manage-decline"
              >
                <X className="w-4 h-4" /> Decline
              </Button>
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={() => setActionState("suggesting")}
                data-testid="button-manage-suggest"
              >
                <CalendarClock className="w-4 h-4" /> Suggest a Different Time
              </Button>
            </div>
          )}

          {actionState === "confirming" && (
            <div className="space-y-3">
              <div className="bg-[hsl(var(--brand-success)/0.08)] border border-[hsl(var(--brand-success)/0.3)] rounded-lg p-3">
                <p className="text-sm text-[hsl(var(--brand-success))] font-ui">Confirm this meeting?</p>
                <p className="text-xs text-[hsl(var(--brand-success))] mt-1">{booking.attendeeName || "The parent"} will be notified and the meeting will be added to your calendar.</p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setActionState("idle")}
                  disabled={submitting}
                  data-testid="button-confirm-cancel"
                >
                  Back
                </Button>
                <Button
                  className="flex-1 gap-2 bg-[hsl(var(--brand-success))] hover:bg-[hsl(var(--brand-success))] text-white"
                  onClick={() => executeAction("confirm")}
                  disabled={submitting}
                  data-testid="button-confirm-yes"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  {submitting ? "Confirming..." : "Yes, Confirm"}
                </Button>
              </div>
            </div>
          )}

          {actionState === "declining" && (
            <div className="space-y-3">
              <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3">
                <p className="text-sm text-destructive font-ui">Decline this meeting?</p>
                <p className="text-xs text-destructive mt-1">{booking.attendeeName || "The parent"} will be notified that the meeting was declined.</p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setActionState("idle")}
                  disabled={submitting}
                  data-testid="button-decline-cancel"
                >
                  Back
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1 gap-2"
                  onClick={() => executeAction("decline")}
                  disabled={submitting}
                  data-testid="button-decline-yes"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
                  {submitting ? "Declining..." : "Yes, Decline"}
                </Button>
              </div>
            </div>
          )}

          {actionState === "suggesting" && (
            <div className="space-y-3">
              {start && (
                <div className="bg-secondary/50 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-1">Originally requested:</p>
                  <div className="flex items-center gap-2 text-sm">
                    <Calendar className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="line-through text-muted-foreground">{format(start, "EEEE, MMMM d, yyyy")} at {format(start, "h:mm a")}</span>
                  </div>
                </div>
              )}
              <form onSubmit={handleSuggestSubmit} className="space-y-3">
                <div className="space-y-1">
                  <Label>New Date</Label>
                  <Input
                    type="date"
                    value={suggestDate}
                    onChange={(e) => setSuggestDate(e.target.value)}
                    min={format(new Date(), "yyyy-MM-dd")}
                    required
                    data-testid="input-manage-suggest-date"
                  />
                </div>
                <div className="space-y-1">
                  <Label>New Time</Label>
                  <Input
                    type="time"
                    value={suggestTime}
                    onChange={(e) => setSuggestTime(e.target.value)}
                    required
                    data-testid="input-manage-suggest-time"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => setActionState("idle")}
                    disabled={submitting}
                    data-testid="button-suggest-cancel"
                  >
                    Back
                  </Button>
                  <Button
                    type="submit"
                    className="flex-1 gap-2"
                    disabled={submitting}
                    data-testid="button-suggest-submit"
                  >
                    {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarClock className="w-4 h-4" />}
                    {submitting ? "Sending..." : "Send Suggestion"}
                  </Button>
                </div>
              </form>
            </div>
          )}
        </div>
        <p className="text-center text-xs text-muted-foreground mt-4">
          Powered by <span className="font-ui text-primary">{companyName}</span>
        </p>
      </div>
    </div>
  );
}
