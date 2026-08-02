import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { useSharedVoiceSession } from "@/contexts/voice-session-context";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { AvatarVideo } from "@/components/voice/AvatarVideo";

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
  const [corner, setCorner] = useState<"tl" | "tr" | "bl" | "br">("br");
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ startX: 0, startY: 0, moved: false, dragging: false });

  const active = ACTIVE_STATES.includes(voice.state);
  if (!active || voice.panelActive) return null;

  const brandColor = brand?.primaryColor || "#004D4D";
  const name = voice.meta?.personaName || "AI Concierge";

  const onPointerDown = (e: ReactPointerEvent) => {
    drag.current = { startX: e.clientX, startY: e.clientY, moved: false, dragging: true };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.current.dragging || !boxRef.current) return;
    const dx = e.clientX - drag.current.startX;
    const dy = e.clientY - drag.current.startY;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) drag.current.moved = true;
    boxRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    if (!drag.current.dragging) return;
    drag.current.dragging = false;
    if (boxRef.current) boxRef.current.style.transform = "";
    if (drag.current.moved) {
      const left = e.clientX < window.innerWidth / 2;
      const top = e.clientY < window.innerHeight / 2;
      setCorner(top ? (left ? "tl" : "tr") : left ? "bl" : "br");
    } else {
      // Plain tap = back to the conversation
      navigate(voice.meta?.returnTo || "/chat/concierge");
    }
  };

  return (
    <div
      ref={boxRef}
      className={`fixed z-[70] w-28 h-40 sm:w-32 sm:h-44 rounded-[var(--radius)] overflow-hidden border-2 shadow-xl cursor-grab active:cursor-grabbing bg-secondary ${PIP_POS[corner]}`}
      style={{ borderColor: brandColor, touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      data-testid="global-voice-pip"
    >
      {voice.avatar ? (
        <AvatarVideo
          fullBleed
          livekitUrl={voice.avatar.livekitUrl}
          livekitToken={voice.avatar.livekitToken}
          brandColor={brandColor}
          onFailed={() => {
            /* audio keeps flowing through the session; frame shows the photo */
          }}
        />
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
