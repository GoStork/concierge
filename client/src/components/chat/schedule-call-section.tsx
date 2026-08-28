import { useEffect, useMemo, useState } from "react";
import { firstNameOf } from "@/lib/display-name";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { CalendarCheck, Loader2, X, Users, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// Phase 4 scheduler flow: propose Match Call / Doctor Call time options.
// The scheduler collects the surrogate's (or doctor's patient-side)
// availability offline, picks matching open slots from the hosting
// coordinator's calendar, and sends the parent a card with those options.
// NOTHING is booked until the parent accepts a slot - acceptance creates
// the booking and invites everyone (parent account, surrogate email, host).

interface SchedulableHost {
  userId: string;
  name: string;
  roles: string[];
  slug: string;
  meetingDuration: number;
  isSelf: boolean;
}

/**
 * The three match-call gates each 409 with their own `code`. Map them to a
 * toast that says what the family still owes and that they have been asked -
 * a bare "failed" would leave the provider with no idea what to do next.
 */
function matchCallGateToast(msg: string): { title: string; description: string } | null {
  if (msg.includes("IP_FORM_REQUIRED") || msg.includes("Intended Parent Form")) {
    return {
      title: "Parent form not submitted yet",
      description:
        "A match call can be scheduled once the family completes and signs their Intended Parent Form. They have been asked and receive reminders.",
    };
  }
  if (msg.includes("BOTH_PARENTS_ACK_REQUIRED")) {
    return {
      title: "Both parents have not confirmed yet",
      description:
        "Both intended parents must attend the match call. We have asked them to confirm in their chat - you can send times as soon as they do.",
    };
  }
  if (msg.includes("MATCH_DECISION_ACK_REQUIRED")) {
    return {
      title: "Decision window not acknowledged yet",
      description:
        "The family still needs to confirm they understand the 24-hour decision window and the match deposit. We have asked them in their chat.",
    };
  }
  return null;
}

function formatTime12(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function roleLabel(roles: string[]): string {
  if (roles.includes("DOCTOR")) return "Doctor";
  const coord = roles.find(r => r.includes("COORDINATOR"));
  if (coord) return coord.replace(/^IP_/, "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  if (roles.includes("PROVIDER_ADMIN")) return "Admin";
  return "";
}

export function ScheduleCallSection({
  sessionId,
  subtype,
  brandColor,
  parentName,
  onClose,
  onSendPickATime,
}: {
  sessionId: string;
  subtype: "MATCH_CALL" | "DOCTOR_CONSULTATION";
  brandColor: string;
  parentName: string | null;
  onClose: () => void;
  /** Fallback: post the full pick-a-time calendar card for the selected host. */
  onSendPickATime?: (host: { slug: string; name: string }) => void;
}) {
  const { toast } = useToast();
  const isMatch = subtype === "MATCH_CALL";
  const callLabel = isMatch ? "Match Call" : "Doctor Call";
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [hostUserId, setHostUserId] = useState<string>("");
  const [date, setDate] = useState<Date>(new Date());
  // Multiple proposed options, possibly across days. ISO strings.
  const [proposed, setProposed] = useState<string[]>([]);
  const [extraEmail, setExtraEmail] = useState("");
  const [extraName, setExtraName] = useState("");
  const [notes, setNotes] = useState("");

  const hostsQuery = useQuery<{ hosts: SchedulableHost[]; defaultHostUserId: string | null }>({
    queryKey: ["/api/chat-session/schedulable-hosts", sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/chat-session/${sessionId}/schedulable-hosts`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load team calendars");
      return res.json();
    },
  });
  const hosts = hostsQuery.data?.hosts || [];
  // Doctor Calls list doctors first.
  const orderedHosts = useMemo(() => {
    if (!isMatch) {
      const doctors = hosts.filter(h => h.roles.includes("DOCTOR"));
      if (doctors.length > 0) return doctors.concat(hosts.filter(h => !h.roles.includes("DOCTOR")));
    }
    return hosts;
  }, [hosts, isMatch]);
  useEffect(() => {
    if (hostUserId || hosts.length === 0) return;
    // Server default: self when the requester can host; otherwise the
    // coordinator who's been working with this parent.
    const def = hostsQuery.data?.defaultHostUserId;
    setHostUserId(def && hosts.some(h => h.userId === def) ? def : orderedHosts[0].userId);
  }, [hosts, orderedHosts, hostUserId, hostsQuery.data?.defaultHostUserId]);
  const selectedHost = hosts.find(h => h.userId === hostUserId) || null;

  const dateStr = format(date, "yyyy-MM-dd");
  const slotsQuery = useQuery<any>({
    queryKey: ["/api/calendar/availability", selectedHost?.slug, dateStr, timezone],
    queryFn: async () => {
      const res = await fetch(`/api/calendar/availability/${selectedHost!.slug}?date=${dateStr}&timezone=${timezone}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load availability");
      return res.json();
    },
    enabled: !!selectedHost?.slug,
  });
  const slots: string[] = (slotsQuery.data?.slots || []).map((s: any) => s.time || s);

  const toggleSlot = (t: string) => {
    const iso = new Date(`${dateStr}T${t}:00`).toISOString();
    setProposed(prev => prev.includes(iso)
      ? prev.filter(p => p !== iso)
      : prev.length >= 6 ? prev : [...prev, iso]);
  };
  const isPicked = (t: string) => proposed.includes(new Date(`${dateStr}T${t}:00`).toISOString());

  const proposeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/chat-session/${sessionId}/propose-call-times`, {
        hostUserId,
        slots: proposed,
        meetingSubtype: subtype,
        extraAttendeeEmail: extraEmail.trim() || undefined,
        extraAttendeeName: extraName.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Time options sent", description: `${parentName || "The parent"} will pick a slot - invites go out to everyone the moment they do.` });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", sessionId] });
      onClose();
    },
    onError: (err: any) => {
      const msg = String(err?.message || "");
      const gate = matchCallGateToast(msg);
      if (gate) {
        toast({ ...gate, variant: "destructive" });
        return;
      }
      toast({ title: "Failed to send time options", description: msg || "Try again.", variant: "destructive" });
    },
  });

  const canSend = !!hostUserId && proposed.length > 0 && !proposeMutation.isPending
    && (!extraEmail.trim() || /^\S+@\S+\.\S+$/.test(extraEmail.trim()));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarCheck className="w-4 h-4" style={{ color: brandColor }} />
          <h3 className="text-sm font-semibold">Schedule {callLabel}</h3>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0 shrink-0" aria-label="Close" data-testid="btn-close-schedule-call">
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>

      <div className="rounded-lg border p-3 space-y-3" style={{ background: "hsl(var(--muted) / 0.4)" }}>
        {/* Host picker - coordinators/doctors only (schedulers never host) */}
        <div className="space-y-1">
          <label className="t-helper">
            {isMatch ? "Coordinator hosting the call" : "Doctor hosting the call"}
          </label>
          {hostsQuery.isLoading ? (
            <div className="t-helper flex items-center gap-2 py-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading team calendars...</div>
          ) : hosts.length === 0 ? (
            <p className="t-helper py-1.5">No coordinator or doctor has a booking calendar set up yet. Ask them to connect one in Settings.</p>
          ) : (
            <select
              value={hostUserId}
              onChange={e => setHostUserId(e.target.value)}
              className="w-full h-9 px-2.5 rounded-[var(--radius)] border bg-background text-sm"
              data-testid="schedule-call-host"
            >
              {orderedHosts.map(h => (
                <option key={h.userId} value={h.userId}>
                  {h.name}{roleLabel(h.roles) ? ` - ${roleLabel(h.roles)}` : ""}{h.isSelf ? " (you)" : ""}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Brand calendar + slots from the HOST's calendar; pick up to 6
            options (across days) that match the surrogate's availability. */}
        {selectedHost && (
          <div className="space-y-1.5">
            <label className="t-helper">
              Pick up to 6 time options on {firstNameOf(selectedHost.name) || selectedHost.name}'s calendar ({selectedHost.meetingDuration} min)
            </label>
            <div className="rounded-md border bg-background flex justify-center">
              <Calendar
                mode="single"
                selected={date}
                onSelect={(d) => d && setDate(d)}
                disabled={{ before: new Date() }}
                data-testid="schedule-call-calendar"
              />
            </div>
            {slotsQuery.isLoading ? (
              <div className="t-helper flex items-center gap-2 py-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking availability...</div>
            ) : slots.length === 0 ? (
              <p className="t-helper py-1.5">No open slots that day - try another date.</p>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {slots.map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleSlot(t)}
                    className={`text-xs py-1.5 rounded-[var(--radius)] border transition-colors ${isPicked(t) ? "text-primary-foreground border-transparent font-semibold" : "border-border bg-background hover:bg-muted"}`}
                    style={isPicked(t) ? { backgroundColor: brandColor } : undefined}
                    data-testid={`schedule-call-slot-${t}`}
                  >
                    {formatTime12(t)}
                  </button>
                ))}
              </div>
            )}
            {proposed.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {proposed.map(iso => (
                  <span key={iso} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-secondary text-foreground">
                    {new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    <button type="button" onClick={() => setProposed(prev => prev.filter(p => p !== iso))} aria-label="Remove option">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Attendees */}
        <div className="space-y-1.5">
          <label className="t-helper flex items-center gap-1"><Users className="w-3 h-3" /> Attendees</label>
          <p className="t-helper">
            {parentName || "The parent"} and their account members are invited automatically once they pick a time.
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            <input
              type="email"
              value={extraEmail}
              onChange={e => setExtraEmail(e.target.value)}
              placeholder={isMatch ? "Surrogate's email address" : "Additional attendee email (optional)"}
              className="w-full h-9 px-2.5 rounded-[var(--radius)] border bg-background text-sm"
              data-testid="schedule-call-extra-email"
            />
            <input
              type="text"
              value={extraName}
              onChange={e => setExtraName(e.target.value)}
              placeholder={isMatch ? "Surrogate's first name (optional)" : "Their first name (optional)"}
              className="w-full h-9 px-2.5 rounded-[var(--radius)] border bg-background text-sm"
              data-testid="schedule-call-extra-name"
            />
          </div>
        </div>

        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Notes for the invite (optional)"
          rows={2}
          className="w-full px-2.5 py-2 rounded-[var(--radius)] border bg-background text-sm resize-none"
          data-testid="schedule-call-notes"
        />

        <div className="flex items-center justify-between gap-2">
          <Button
            onClick={() => proposeMutation.mutate()}
            disabled={!canSend}
            className="gap-1.5 text-primary-foreground"
            style={{ backgroundColor: brandColor }}
            data-testid="schedule-call-send"
          >
            {proposeMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            Send Time Options ({proposed.length})
          </Button>
          {onSendPickATime && selectedHost && (
            <button
              type="button"
              onClick={() => { onSendPickATime({ slug: selectedHost.slug, name: selectedHost.name }); onClose(); }}
              className="t-helper hover:underline"
              data-testid="schedule-call-pick-a-time"
            >
              Or let the parent pick any time
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
