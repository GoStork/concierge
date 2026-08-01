import { useMemo } from "react";
import { Mic, MicOff, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { VoiceCardsPayload, VoiceState } from "@/hooks/use-voice-session";

// Voice-first landing: shown over a brand-new session so Eva can START the
// conversation by talking. Browsers refuse audio without a user gesture, so
// the tap IS the gesture (resumes AudioContext + mic permission + WS).
export function VoiceStartHero({
  avatarUrl,
  personaName,
  brandColor,
  onStart,
  onContinueInText,
}: {
  avatarUrl: string | null;
  personaName: string | null;
  brandColor: string;
  onStart: () => void;
  onContinueInText: () => void;
}) {
  const name = personaName || "your AI Concierge";
  return (
    <div
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-background px-6"
      data-testid="voice-start-hero"
    >
      <button
        onClick={onStart}
        className="relative flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Start talking with ${name}`}
        data-testid="btn-voice-hero-start"
      >
        <span
          className="absolute rounded-full animate-ping"
          style={{ width: 168, height: 168, backgroundColor: `${brandColor}1f`, animationDuration: "2s" }}
        />
        <span className="absolute rounded-full" style={{ width: 148, height: 148, backgroundColor: `${brandColor}14` }} />
        <span
          className="relative w-32 h-32 rounded-full overflow-hidden border-4 flex items-center justify-center"
          style={{ borderColor: brandColor }}
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt={name} className="w-full h-full object-cover" />
          ) : (
            <span
              className="w-full h-full flex items-center justify-center text-primary-foreground text-3xl font-bold"
              style={{ backgroundColor: brandColor }}
            >
              {(personaName || "AI").slice(0, 1).toUpperCase()}
            </span>
          )}
        </span>
        <span
          className="absolute -bottom-1 -right-1 w-11 h-11 rounded-full flex items-center justify-center border-4 border-background"
          style={{ backgroundColor: brandColor }}
        >
          <Mic className="w-5 h-5 text-primary-foreground" />
        </span>
      </button>
      <div className="flex flex-col items-center gap-1.5 text-center">
        <span className="font-heading text-xl font-semibold text-foreground">
          {personaName || "Eva"} is ready to talk
        </span>
        <span className="t-helper max-w-xs">
          Tap to start a voice conversation - you can switch to text any time
        </span>
      </div>
      <Button
        size="lg"
        className="h-12 px-8 rounded-full text-primary-foreground font-ui"
        style={{ backgroundColor: brandColor }}
        onClick={onStart}
        data-testid="btn-voice-hero-start-cta"
      >
        <Mic className="w-4 h-4 mr-2" /> Start talking
      </Button>
      <button
        onClick={onContinueInText}
        className="text-sm font-ui underline underline-offset-4 text-muted-foreground hover:text-foreground transition-colors"
        data-testid="btn-voice-hero-text-instead"
      >
        Continue in text instead
      </button>
    </div>
  );
}

// Full-height inline takeover of the chat column while a live voice
// conversation runs (NOT a modal/portal - rendered in the page tree, per the
// no-dialogs rule). Shows the persona with a state-driven animation, live
// captions for both sides, quick-reply chips from the pipeline, and
// mute / end controls. The transcript persists through the normal /chat
// pipeline server-side; closing the panel just reveals it.

interface VoiceModePanelProps {
  state: VoiceState;
  avatarUrl: string | null;
  personaName: string | null;
  brandColor: string;
  partialTranscript: string;
  caption: string;
  cards: VoiceCardsPayload | null;
  micMuted: boolean;
  error: string | null;
  onToggleMute: () => void;
  onQuickReply: (text: string) => void;
  onClose: () => void;
}

const STATE_LABEL: Record<string, string> = {
  connecting: "Connecting...",
  listening: "Listening",
  thinking: "Thinking...",
  speaking: "",
  ended: "",
  error: "",
};

export function VoiceModePanel({
  state,
  avatarUrl,
  personaName,
  brandColor,
  partialTranscript,
  caption,
  cards,
  micMuted,
  error,
  onToggleMute,
  onQuickReply,
  onClose,
}: VoiceModePanelProps) {
  const quickReplies: string[] = useMemo(() => {
    if (!cards?.quickReplies?.length) return [];
    return cards.quickReplies
      .map((qr: any) => (typeof qr === "string" ? qr : qr?.label || qr?.text || ""))
      .filter(Boolean)
      .slice(0, 4);
  }, [cards]);

  const hasScreenCards = !!(
    cards?.matchCards?.length ||
    cards?.doctorCards?.length ||
    cards?.comparisonCards?.length ||
    cards?.consultationCard ||
    cards?.meetingCards?.length
  );

  const initials = (personaName || "AI")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-background"
      data-testid="voice-mode-panel"
    >
      {/* Close */}
      <div className="flex items-center justify-end px-4 pt-4 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-9 p-0 rounded-full border"
          onClick={onClose}
          aria-label="End voice conversation"
          data-testid="btn-voice-close"
        >
          <X className="w-5 h-5" />
        </Button>
      </div>

      {/* Persona + state */}
      <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6 min-h-0">
        <div className="relative flex items-center justify-center">
          {/* Pulse rings driven by state */}
          {(state === "speaking" || state === "listening") && (
            <>
              <span
                className="absolute rounded-full animate-ping"
                style={{
                  width: state === "speaking" ? 152 : 136,
                  height: state === "speaking" ? 152 : 136,
                  backgroundColor: `${brandColor}22`,
                  animationDuration: state === "speaking" ? "1.2s" : "2.4s",
                }}
              />
              <span
                className="absolute rounded-full"
                style={{
                  width: 136,
                  height: 136,
                  backgroundColor: `${brandColor}14`,
                }}
              />
            </>
          )}
          <div
            className="relative w-28 h-28 rounded-full overflow-hidden border-4 flex items-center justify-center"
            style={{ borderColor: brandColor }}
          >
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={personaName || "AI Concierge"}
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            ) : (
              <div
                className="w-full h-full flex items-center justify-center text-primary-foreground text-2xl font-bold"
                style={{ backgroundColor: brandColor }}
              >
                {initials}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col items-center gap-1">
          <span className="font-heading text-lg font-semibold text-foreground">
            {personaName || "AI Concierge"}
          </span>
          <span className="t-helper flex items-center gap-1.5 min-h-5" data-testid="voice-state-label">
            {(state === "connecting" || state === "thinking") && (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            )}
            {STATE_LABEL[state]}
          </span>
        </div>

        {/* Captions */}
        <div className="w-full max-w-md min-h-16 flex flex-col items-center gap-2 text-center">
          {error ? (
            <span className="text-sm text-destructive font-ui">{error}</span>
          ) : (
            <>
              {caption && (
                <p
                  className="text-base font-body text-foreground leading-relaxed max-h-36 overflow-y-auto"
                  data-testid="voice-eva-caption"
                >
                  {caption}
                </p>
              )}
              {partialTranscript && (
                <p className="text-sm font-body text-muted-foreground italic" data-testid="voice-partial-transcript">
                  {partialTranscript}
                </p>
              )}
            </>
          )}
        </div>

        {/* Quick replies + card notice */}
        {(quickReplies.length > 0 || hasScreenCards) && (
          <div className="w-full max-w-md flex flex-col items-center gap-2">
            {hasScreenCards && (
              <span
                className="text-xs font-ui px-3 py-1.5 rounded-full bg-secondary text-secondary-foreground"
                data-testid="voice-cards-notice"
              >
                Matches are ready - end the voice chat to view them
              </span>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              {quickReplies.map((qr) => (
                <button
                  key={qr}
                  onClick={() => onQuickReply(qr)}
                  className="px-4 py-2 rounded-full border text-sm font-ui transition-colors"
                  style={{
                    borderColor: `${brandColor}55`,
                    color: brandColor,
                    backgroundColor: `${brandColor}0d`,
                  }}
                  data-testid="voice-quick-reply"
                >
                  {qr}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-6 pb-10 pt-4 shrink-0">
        <Button
          variant="outline"
          size="lg"
          className="h-14 w-14 p-0 rounded-full"
          onClick={onToggleMute}
          aria-label={micMuted ? "Unmute microphone" : "Mute microphone"}
          data-testid="btn-voice-mute"
        >
          {micMuted ? (
            <MicOff className="w-6 h-6 text-destructive" />
          ) : (
            <Mic className="w-6 h-6" style={{ color: brandColor }} />
          )}
        </Button>
        <Button
          size="lg"
          className="h-14 px-7 rounded-full text-primary-foreground font-ui"
          style={{ backgroundColor: brandColor }}
          onClick={onClose}
          data-testid="btn-voice-end"
        >
          End voice chat
        </Button>
      </div>
    </div>
  );
}
