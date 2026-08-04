import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCornerDrag } from "@/lib/voice/use-corner-drag";
import { Mic, MicOff, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSharedVoiceSession } from "@/contexts/voice-session-context";
import { interruptVoiceSession } from "@/hooks/use-voice-session";
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
  // Realtime video avatar (Phase 3): LiveKit credentials when active
  avatar?: { livekitUrl: string; livekitToken: string } | null;
  partialTranscript: string;
  caption: string;
  cards: VoiceCardsPayload | null;
  // Eva's reply stream contains a MATCH_CARD tag but the card data hasn't
  // landed yet - open the takeover immediately with a loading shell so the
  // profile appears the moment she starts presenting it.
  cardsPreview?: boolean;
  micMuted: boolean;
  error: string | null;
  onToggleMute: () => void;
  onQuickReply: (text: string) => void;
  onClose: () => void;
  // Renders the pipeline's interactive cards (donor matches, doctors...)
  // INSIDE the panel, so a parent can see the profile Eva is asking about
  // without leaving the call. The chat page supplies this using its own card
  // components - the panel never forks them. opts.fill = size cards to the
  // parent's height (the full-screen profile takeover) instead of 3:4.
  renderCards?: (cards: VoiceCardsPayload, opts?: { fill?: boolean }) => ReactNode;
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
  avatar,
  partialTranscript,
  caption,
  cards,
  cardsPreview,
  micMuted,
  error,
  onToggleMute,
  onQuickReply,
  onClose,
  renderCards,
}: VoiceModePanelProps) {
  // The LiveKit room + <video> live in ONE persistent instance owned by
  // VoiceSessionProvider; this panel only claims it into its stage element,
  // so opening/closing the panel or navigating never re-joins the room.
  const { avatarVideoFailed, registerAvatarHost } = useSharedVoiceSession();
  const showAvatarVideo = !!avatar && !avatarVideoFailed;
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

  // FaceTime-style immersion: when the realtime avatar video is up, it fills
  // the whole panel and everything else (name, captions, chips, controls)
  // overlays it above gradient scrims.
  const overVideo = showAvatarVideo;

  // Profile takeover (FaceTime screen-share style): when Eva recommends a
  // profile, the card fills the screen and her video shrinks to a small
  // draggable frame that snaps to a corner. Any action on the card routes
  // through the voice session, which clears the cards - Eva returns to full
  // screen and the conversation continues.
  const takeover = overVideo && !!renderCards && (hasScreenCards || !!cardsPreview);
  const { ref: pipRef, corner: pipCorner, onPointerDown: onPipPointerDown } = useCornerDrag("tr");

  // Claim the persistent avatar video into this panel's stage while the
  // video is shown here. The unregister is element-guarded, so a surface
  // that registered after us (commit ordering on route change) is never
  // clobbered by our cleanup.
  const stageElRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!showAvatarVideo || !stageElRef.current) return;
    return registerAvatarHost(stageElRef.current);
  }, [showAvatarVideo, registerAvatarHost]);
  const PIP_POS: Record<string, string> = {
    tl: "top-16 left-3",
    tr: "top-16 right-3",
    bl: "bottom-6 left-3",
    br: "bottom-6 right-3",
  };

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-background"
      data-testid="voice-mode-panel"
    >
      {showAvatarVideo && (
        <>
          {/* ONE stable container for the video - full-bleed normally, a
              draggable PiP box during profile takeover. Only the classes
              change, so the LiveKit connection never remounts. */}
          <div
            ref={(el) => {
              pipRef.current = el;
              stageElRef.current = el;
            }}
            className={
              takeover
                ? `absolute z-30 w-28 h-40 sm:w-32 sm:h-44 rounded-[var(--radius)] overflow-hidden border-2 shadow-xl cursor-grab active:cursor-grabbing ${PIP_POS[pipCorner]}`
                : "absolute inset-0"
            }
            style={takeover ? { borderColor: brandColor, touchAction: "none" } : undefined}
            onPointerDown={takeover ? onPipPointerDown : undefined}
            // Tap-to-interrupt: touching Eva while she talks cuts her off -
            // the deterministic interrupt for platforms where acoustic barge
            // detection struggles (iPhone speaker). No-ops when she's quiet.
            onClick={takeover ? undefined : interruptVoiceSession}
            data-testid={takeover ? "voice-avatar-pip" : "voice-avatar-stage"}
          >
            {/* The persistent AvatarVideo portals into this element - see
                VoiceSessionProvider. Nothing is mounted here directly. */}
          </div>
          {!takeover && (
            <>
              <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-foreground/40 to-transparent pointer-events-none" />
              <div className="absolute inset-x-0 bottom-0 h-80 bg-gradient-to-t from-foreground/70 via-foreground/30 to-transparent pointer-events-none" />
            </>
          )}
        </>
      )}

      {/* Profile takeover layer: the recommended profile fills the screen at
          the marketplace card's full size while Eva watches from the PiP
          frame. The call controls move into the top bar to give the card's
          own action buttons the bottom of the screen. */}
      {takeover && (
        <div
          className="absolute inset-0 z-20 bg-background px-3 pt-14 pb-3"
          data-testid="voice-profile-takeover"
        >
          <div
            className={`h-full mx-auto space-y-3 overflow-y-auto overscroll-contain ${
              cards?.comparisonCards?.length ? "max-w-2xl" : "max-w-md"
            }`}
          >
            {hasScreenCards ? (
              renderCards!(cards!, { fill: true })
            ) : (
              <div className="w-full h-full rounded-[var(--container-radius)] bg-secondary animate-pulse flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                <span className="t-helper">Pulling up the profile...</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Top bar: close always; during profile takeover the mute control
          moves up here so the bottom belongs to the card's action buttons. */}
      <div className="relative z-30 flex items-center justify-end gap-2 px-4 pt-4 shrink-0">
        {takeover && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 w-9 p-0 rounded-full border bg-background/70 backdrop-blur-sm hover:bg-background/90"
            onClick={onToggleMute}
            aria-label={micMuted ? "Unmute microphone" : "Mute microphone"}
            data-testid="btn-voice-mute-top"
          >
            {micMuted ? (
              <MicOff className="w-4 h-4 text-destructive" />
            ) : (
              <Mic className="w-4 h-4" style={{ color: brandColor }} />
            )}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className={`h-9 w-9 p-0 rounded-full border ${
            overVideo ? "bg-background/70 backdrop-blur-sm hover:bg-background/90" : ""
          }`}
          onClick={onClose}
          aria-label="End voice conversation"
          data-testid="btn-voice-close"
        >
          <X className="w-5 h-5" />
        </Button>
      </div>

      {/* Persona + state. NOT rendered during profile takeover: even empty,
          this full-height flex-1 layer would sit above the card and the PiP
          and swallow every tap (observed live: no card button worked). */}
      {!takeover && (
      <div
        className={`relative z-10 flex-1 flex flex-col items-center gap-5 px-6 min-h-0 ${
          overVideo ? "justify-end pb-2" : "justify-center"
        }`}
        // Tap-to-interrupt lives HERE, not (only) on the video stage: this
        // full-height layer sits ABOVE the stage and swallows every tap on
        // Eva's face (same trap the takeover comment below describes -
        // observed live on iPhone: "I'm trying to tap on your screen").
        // Buttons/chips/cards keep their own behavior.
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button,a,[role=button]")) return;
          interruptVoiceSession();
        }}
      >
        {!showAvatarVideo && (
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
        )}

        {!takeover && (
        <div className="flex flex-col items-center gap-1">
          <span
            className={`font-heading text-lg font-semibold ${
              overVideo ? "text-background" : "text-foreground"
            }`}
          >
            {personaName || "AI Concierge"}
          </span>
          <span
            className={`flex items-center gap-1.5 min-h-5 ${
              overVideo ? "text-sm font-ui text-background/80" : "t-helper"
            }`}
            data-testid="voice-state-label"
          >
            {(state === "connecting" || state === "thinking") && (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            )}
            {STATE_LABEL[state]}
          </span>
        </div>
        )}

        {/* Captions */}
        {(!takeover || error) && (
        <div className="w-full max-w-md min-h-16 flex flex-col items-center gap-2 text-center">
          {error ? (
            <span className="text-sm text-destructive font-ui">{error}</span>
          ) : (
            <>
              {caption && (
                <p
                  className={`font-body leading-snug line-clamp-2 w-full text-left ${
                    overVideo
                      ? "text-2xl font-medium text-background drop-shadow-md"
                      : "text-xl text-foreground"
                  }`}
                  data-testid="voice-eva-caption"
                >
                  {caption}
                </p>
              )}
              {partialTranscript && (
                <p
                  className={`text-sm font-body italic ${
                    overVideo ? "text-background/75" : "text-muted-foreground"
                  }`}
                  data-testid="voice-partial-transcript"
                >
                  {partialTranscript}
                </p>
              )}
            </>
          )}
        </div>
        )}

        {/* Interactive cards + quick replies. With the avatar up, cards live
            in the full-screen takeover layer instead of this inline box, and
            chips yield the floor to the card's own action buttons. */}
        {!takeover && (quickReplies.length > 0 || hasScreenCards) && (
          <div className="w-full max-w-md flex flex-col items-center gap-2">
            {hasScreenCards && renderCards && !overVideo ? (
              <div
                className="w-full max-h-[38vh] overflow-y-auto space-y-3 overscroll-contain"
                data-testid="voice-cards"
              >
                {renderCards(cards!)}
              </div>
            ) : hasScreenCards && !takeover ? (
              <span
                className="text-xs font-ui px-3 py-1.5 rounded-full bg-secondary text-secondary-foreground"
                data-testid="voice-cards-notice"
              >
                Matches are ready - end the voice chat to view them
              </span>
            ) : null}
            <div className="flex flex-wrap items-center justify-center gap-2">
              {quickReplies.map((qr) => (
                <button
                  key={qr}
                  onClick={() => onQuickReply(qr)}
                  className={`px-4 py-2 rounded-full border text-sm font-ui transition-colors ${
                    overVideo ? "bg-background/85 backdrop-blur-sm" : ""
                  }`}
                  style={{
                    borderColor: `${brandColor}55`,
                    color: brandColor,
                    backgroundColor: overVideo ? undefined : `${brandColor}0d`,
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
      )}

      {/* Controls (hidden during profile takeover - mute lives in the top
          bar there and X ends the call) */}
      {!takeover && (
      <div className="relative z-30 flex items-center justify-center gap-6 pb-10 pt-4 shrink-0">
        <Button
          variant="outline"
          size="lg"
          className={`h-14 w-14 p-0 rounded-full ${
            overVideo ? "bg-background/70 backdrop-blur-sm hover:bg-background/90" : ""
          }`}
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
      )}
    </div>
  );
}
