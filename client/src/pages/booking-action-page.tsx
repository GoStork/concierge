import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Loader2, Check, X, Clock, Calendar, Video, User, CalendarClock
} from "lucide-react";
import { format } from "date-fns";
import { useCompanyName } from "@/hooks/use-brand-settings";

type ActionType = "confirm" | "decline" | "suggest-time";

export default function BookingActionPage({ action }: { action: ActionType }) {
  const { token } = useParams<{ token: string }>();
  const companyName = useCompanyName();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestDate, setSuggestDate] = useState("");
  const [suggestTime, setSuggestTime] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (action === "confirm" || action === "decline") {
      executeAction();
    } else {
      fetchBookingInfo();
    }
  }, [token, action]);

  async function fetchBookingInfo() {
    try {
      const res = await fetch(`/api/calendar/booking/${token}/info`);
      if (res.ok) {
        const data = await res.json();
        setResult({ booking: data.booking, action: "info" });
      }
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }

  async function executeAction() {
    try {
      const endpoint = `/api/calendar/booking/${token}/${action}`;
      const res = await fetch(endpoint, {
        method: action === "suggest-time" ? "POST" : "GET",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message || `Action failed (${res.status})`);
      }

      const data = await res.json();
      setResult({ ...data, action });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
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
      setResult({ ...data, action: "suggest-time" });
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
          <p className="text-muted-foreground">
            {action === "confirm" ? "Confirming booking..." : action === "decline" ? "Processing..." : "Loading..."}
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-primary/5 to-background flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="bg-card rounded-[var(--container-radius)] border border-border/50 shadow-lg p-8 text-center">
            <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-destructive/15 flex items-center justify-center">
              <X className="w-7 h-7 text-destructive" />
            </div>
            <h1 className="text-2xl font-display font-heading mb-2" data-testid="text-action-error">Unable to Process</h1>
            <p className="text-muted-foreground text-sm">{error}</p>
          </div>
          <p className="text-center text-xs text-muted-foreground mt-4">
            Powered by <span className="font-ui text-primary">{companyName}</span>
          </p>
        </div>
      </div>
    );
  }

  if (action === "suggest-time" && result?.action === "info") {
    const booking = result.booking;
    const start = booking ? new Date(booking.scheduledAt) : null;

    return (
      <div className="min-h-screen bg-gradient-to-b from-primary/5 to-background flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="bg-card rounded-[var(--container-radius)] border border-border/50 shadow-lg p-8">
            <div className="text-center mb-6">
              <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
                <CalendarClock className="w-7 h-7 text-primary" />
              </div>
              <h1 className="text-2xl font-display font-heading" data-testid="text-suggest-title">Suggest a New Time</h1>
              <p className="text-muted-foreground text-sm mt-1">
                Propose an alternative time for {booking?.attendeeName || "the parent"}'s booking request.
              </p>
            </div>

            {start && (
              <div className="bg-secondary/30 rounded-[var(--radius)] p-3 mb-4">
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
                  data-testid="input-suggest-date"
                />
              </div>
              <div className="space-y-1">
                <Label>New Time</Label>
                <Input
                  type="time"
                  value={suggestTime}
                  onChange={(e) => setSuggestTime(e.target.value)}
                  required
                  data-testid="input-suggest-time"
                />
              </div>
              <Button type="submit" className="w-full" disabled={submitting} data-testid="button-send-suggestion">
                {submitting ? "Sending..." : "Send Suggestion"}
              </Button>
            </form>
          </div>
          <p className="text-center text-xs text-muted-foreground mt-4">
            Powered by <span className="font-ui text-primary">{companyName}</span>
          </p>
        </div>
      </div>
    );
  }

  const booking = result?.booking;
  const start = booking ? new Date(booking.scheduledAt) : null;

  const isConfirm = action === "confirm" || result?.action === "confirm";
  const isDecline = action === "decline" || result?.action === "decline";
  const isSuggest = result?.action === "suggest-time";

  return (
    <div className="min-h-screen bg-gradient-to-b from-primary/5 to-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-card rounded-[var(--container-radius)] border border-border/50 shadow-lg p-8 text-center">
          <div className={`w-14 h-14 mx-auto mb-4 rounded-full flex items-center justify-center ${
            isConfirm ? "bg-[hsl(var(--brand-success)/0.12)]" : isDecline ? "bg-destructive/15" : "bg-primary/10"
          }`}>
            {isConfirm ? <Check className="w-7 h-7 text-[hsl(var(--brand-success))]" /> :
             isDecline ? <X className="w-7 h-7 text-destructive" /> :
             <CalendarClock className="w-7 h-7 text-primary" />}
          </div>
          <h1 className="text-2xl font-display font-heading mb-1" data-testid="text-action-result">
            {isConfirm ? "Meeting Confirmed!" : isDecline ? "Meeting Declined" : "New Time Suggested"}
          </h1>
          <p className="text-muted-foreground text-sm mb-6">
            {isConfirm ? `${booking?.attendeeName || "The parent"} has been notified that you've confirmed the meeting.` :
             isDecline ? `${booking?.attendeeName || "The parent"} has been notified that the meeting was declined.` :
             `${booking?.attendeeName || "The parent"} has been notified about the suggested new time.`}
          </p>

          {start && booking && (
            <div className="bg-secondary/30 rounded-[var(--radius)] p-4 space-y-3 text-left mb-4">
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="w-4 h-4 text-primary shrink-0" />
                <span className="font-ui">{format(start, "EEEE, MMMM d, yyyy")}</span>
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
                <span>{booking.attendeeName || "Parent"} ({booking.attendeeEmails?.[0] || ""})</span>
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
