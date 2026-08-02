import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { useSharedVoiceSession } from "@/contexts/voice-session-context";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { useCornerDrag } from "@/lib/voice/use-corner-drag";

// Floating FaceTime-style frame shown while a voice call is live and the chat
// page's full VoiceModePanel is NOT on screen (e.g. the parent tapped "View
// full profile" and is browsing). Draggable with corner snapping; a tap
// returns to the conversation, the small X ends the call. The session itself
// lives in VoiceSessionProvider, so browsing never interrupts the audio - the
// mic and Eva's voice keep flowing the whole time.

const ACTIVE_STATES = ["connecting", "listening", "thinking", "speaking"];

const PIP_POS: Record<string, string> = {
  tl: "top-20 left-3",
  tr: "top-20 right-3",
  bl: "bottom-24 left-3",
  br: "bottom-24 right-3",
};

const STATE_LABEL: Record<string, string> = {
  connecting: "Connecting...",
  listening: "Listening",
  thinking: "Thinking...",
  speaking: "Speaking",
};

export function GlobalVoicePip() {
  const voice = useSharedVoiceSession();
  const { data: brand } = useBrandSettings();
  const navigate = useNavigate();
  // Plain tap = back to the conversation
  const { ref: boxRef, corner, onPointerDown } = useCornerDrag("br", () =>
    navigate(voice.meta?.returnTo || "/chat/concierge"),
  );

  const active = ACTIVE_STATES.includes(voice.state);
  const visible = active && !voice.panelActive;
  const showVideo = visible && !!voice.avatar && !voice.avatarVideoFailed;

  // Claim the persistent avatar video (owned by VoiceSessionProvider) into
  // this frame while the PiP is the visible surface - re-parents the SAME
  // LiveKit room + <video>, no re-join, no spinner. Must run before the
  // early return so the hook order is stable.
  const videoHostRef = useRef<HTMLDivElement | null>(null);
  const { registerAvatarHost } = voice;
  useEffect(() => {
    if (!showVideo || !videoHostRef.current) return;
    return registerAvatarHost(videoHostRef.current);
  }, [showVideo, registerAvatarHost]);

  if (!visible) return null;

  const brandColor = brand?.primaryColor || "#004D4D";
  const name = voice.meta?.personaName || "AI Concierge";

  return (
    <div
      ref={boxRef}
      className={`fixed z-[70] w-28 h-40 sm:w-32 sm:h-44 rounded-[var(--radius)] overflow-hidden border-2 shadow-xl cursor-grab active:cursor-grabbing bg-secondary ${PIP_POS[corner]}`}
      style={{ borderColor: brandColor, touchAction: "none" }}
      onPointerDown={onPointerDown}
      data-testid="global-voice-pip"
    >
      {showVideo ? (
        <div ref={videoHostRef} className="absolute inset-0">
          {/* Persistent AvatarVideo portals in here - see VoiceSessionProvider */}
        </div>
      ) : voice.meta?.avatarUrl ? (
        <img src={voice.meta.avatarUrl} alt={name} className="absolute inset-0 w-full h-full object-cover" />
      ) : (
        <div
          className="absolute inset-0 flex items-center justify-center text-primary-foreground text-xl font-bold"
          style={{ backgroundColor: brandColor }}
        >
          {name.charAt(0)}
        </div>
      )}

      {/* End-call chip */}
      <button
        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-background/80 backdrop-blur-sm border flex items-center justify-center"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          voice.stop();
        }}
        aria-label="End voice conversation"
        data-testid="global-voice-pip-end"
      >
        <X className="w-3.5 h-3.5" />
      </button>

      {/* State strip */}
      <div className="absolute inset-x-0 bottom-0 px-1.5 py-1 bg-gradient-to-t from-foreground/70 to-transparent pointer-events-none">
        <span className="block text-[10px] font-ui text-background truncate">
          {name} - {STATE_LABEL[voice.state] || ""}
        </span>
      </div>
    </div>
  );
}
