import { useState } from "react";
import { CalendarCheck, Check, Loader2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";

// Phase 4: the "pick one of these times" card. The scheduler proposed a few
// slots that work for the surrogate/doctor side; the parent taps one and
// ONLY THEN is the booking created and everyone invited. Providers see the
// same card read-only with its status.

export interface ProposedTimesData {
  meetingSubtype?: "MATCH_CALL" | "DOCTOR_CONSULTATION" | null;
  hostName?: string | null;
  subjectLabel?: string | null;
  durationMin?: number;
  slots?: string[];
  status?: "pending" | "booked";
  chosenSlot?: string | null;
  notes?: string | null;
}

function slotLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function ProposedTimesCard({
  data,
  messageId,
  sessionId,
  brandColor,
  canPick,
}: {
  data: ProposedTimesData;
  messageId: string;
  sessionId: string;
  brandColor: string;
  /** Parents pick; providers/admins view read-only. */
  canPick: boolean;
}) {
  const [pendingSlot, setPendingSlot] = useState<string | null>(null);
  const [localChosen, setLocalChosen] = useState<string | null>(null);
  // Two-step: tap to select, then Confirm books it. After booking, "Change
  // time" re-opens the options and confirming a new one reschedules.
  const [selected, setSelected] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slots = Array.isArray(data.slots) ? data.slots : [];
  const chosen = localChosen ?? (data.status === "booked" ? data.chosenSlot ?? null : null);
  const callLabel = data.meetingSubtype === "MATCH_CALL" ? "Match Call"
    : data.meetingSubtype === "DOCTOR_CONSULTATION" ? "Doctor Call" : "Meeting";

  const confirm = async (slot: string) => {
    if (!canPick || pendingSlot || (chosen && !changing)) return;
    setPendingSlot(slot);
    setError(null);
    try {
      await apiRequest("POST", `/api/chat-session/${sessionId}/proposed-times/${messageId}/accept`, { slot });
      setLocalChosen(slot);
      setChanging(false);
      setSelected(null);
      queryClient.invalidateQueries({ queryKey: [`/api/ai-concierge/session/${sessionId}/messages`] });
      queryClient.invalidateQueries({ queryKey: ["/api/chat-session/bookings", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", sessionId] });
    } catch (e: any) {
      setError(e?.message || "That time may have just been taken - try another option.");
    } finally {
      setPendingSlot(null);
    }
  };

  return (
    <div
      className="mt-1 rounded-[var(--radius)] border-2 bg-background overflow-hidden"
      style={{ borderColor: `${brandColor}40`, maxWidth: "min(100%, 420px)" }}
      data-testid={`proposed-times-${messageId}`}
    >
      <div className="flex items-center gap-2 px-3 py-2" style={{ backgroundColor: `${brandColor}14` }}>
        <CalendarCheck className="w-4 h-4" style={{ color: brandColor }} />
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: brandColor }}>
          {callLabel}{data.subjectLabel ? ` with ${data.subjectLabel}` : " time options"}{data.hostName ? ` - hosted by ${data.hostName}` : ""}
        </span>
      </div>
      <div className="p-3 space-y-1.5">
        {slots.map(iso => {
          const isChosen = chosen === iso && !changing;
          const isSelected = (!chosen || changing) && selected === iso;
          const isPast = new Date(iso).getTime() < Date.now();
          const disabled = !canPick || (!!chosen && !changing) || !!pendingSlot || isPast || (changing && chosen === iso);
          return (
            <button
              key={iso}
              type="button"
              disabled={disabled}
              onClick={() => setSelected(prev => (prev === iso ? null : iso))}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-[var(--radius)] border text-sm transition-colors ${
                isChosen || isSelected ? "font-semibold text-primary-foreground border-transparent"
                : chosen || isPast ? "opacity-50 border-border"
                : canPick ? "border-border hover:bg-muted cursor-pointer" : "border-border"
              }`}
              style={isChosen || isSelected ? { backgroundColor: brandColor } : undefined}
              data-testid={`proposed-slot-${iso}`}
            >
              <span>{slotLabel(iso)}</span>
              {(isChosen || isSelected) && <Check className="w-4 h-4" />}
            </button>
          );
        })}
        {canPick && (!chosen || changing) && selected && (
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              disabled={!!pendingSlot}
              onClick={() => confirm(selected)}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
              style={{ backgroundColor: brandColor }}
              data-testid="proposed-times-confirm"
            >
              {pendingSlot ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Confirm {slotLabel(selected)}
            </button>
            {changing && (
              <button
                type="button"
                disabled={!!pendingSlot}
                onClick={() => { setChanging(false); setSelected(null); }}
                className="text-xs text-muted-foreground hover:underline"
                data-testid="proposed-times-keep"
              >
                Keep current time
              </button>
            )}
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        {chosen && !changing ? (
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <p className="text-xs flex items-center gap-1" style={{ color: "hsl(var(--brand-success))" }}>
              <Check className="w-3.5 h-3.5" /> Booked - calendar invites sent to everyone.
            </p>
            {canPick && slots.some(i => i !== chosen && new Date(i).getTime() > Date.now()) && (
              <button
                type="button"
                onClick={() => { setChanging(true); setSelected(null); }}
                className="text-xs text-muted-foreground hover:underline shrink-0"
                data-testid="proposed-times-change"
              >
                Change time
              </button>
            )}
          </div>
        ) : chosen && changing ? (
          <p className="text-xs text-muted-foreground pt-0.5">Pick a new time and confirm - the invite updates for everyone.</p>
        ) : canPick ? (
          <p className="text-xs text-muted-foreground pt-0.5">Tap the time that works best, then hit Confirm - you can change your pick until then.</p>
        ) : (
          <p className="text-xs text-muted-foreground pt-0.5">Waiting for the parent to pick a time.</p>
        )}
      </div>
    </div>
  );
}
