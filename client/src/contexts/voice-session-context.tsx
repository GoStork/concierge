import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVoiceSession } from "@/hooks/use-voice-session";
import { AvatarVideo } from "@/components/voice/AvatarVideo";

// App-level voice session. The session (mic, WebSocket, avatar credentials)
// lives HERE, above the router, so navigating between pages never kills a
// live call: the chat page renders the full VoiceModePanel while mounted, and
// GlobalVoicePip renders a small floating video frame everywhere else -
// FaceTime semantics. The chat page reports whether its panel is currently
// showing via setPanelActive, and stores the display meta (persona name,
// avatar photo, the chat URL to return to) via setMeta.
//
// PERSISTENT MEDIA (Session 3, brief B6/E2): the LiveKit room + <video> also
// live here, in ONE AvatarVideo instance rendered through a portal into
// whichever surface is currently on screen. Surfaces (VoiceModePanel's stage,
// GlobalVoicePip's frame) REGISTER a host element instead of mounting their
// own AvatarVideo; switching surfaces re-parents the same DOM nodes and the
// WebRTC connection never tears down. Before this, every panel<->PiP toggle
// and route change created a fresh Room join (~1s black frame + spinner, the
// 0.33s white-flash remount in B6) and kicked the previous connection via the
// same-identity join - repeated joins were the prime suspect for E2's
// progressive framerate decay. When no surface is registered the portal parks
// in an off-screen holder (opacity-0, NOT display:none - browsers throttle
// decoding of hidden videos) so the stream stays warm between surfaces.

export interface VoicePipMeta {
  personaName: string | null;
  avatarUrl: string | null;
  returnTo: string;
}

type VoiceSessionValue = ReturnType<typeof useVoiceSession> & {
  meta: VoicePipMeta | null;
  setMeta: (m: VoicePipMeta | null) => void;
  panelActive: boolean;
  setPanelActive: (v: boolean) => void;
  // True once the persistent AvatarVideo reported a failure for the CURRENT
  // avatar credentials - surfaces fall back to the static persona photo.
  avatarVideoFailed: boolean;
  // Claim the avatar video for a surface. Returns an unregister function that
  // only releases the claim if this element still holds it (a new surface
  // registering before the old one unmounts must not be clobbered).
  registerAvatarHost: (el: HTMLElement) => () => void;
};

const VoiceSessionContext = createContext<VoiceSessionValue | null>(null);

export function VoiceSessionProvider({ children }: { children: ReactNode }) {
  const session = useVoiceSession();
  const [meta, setMeta] = useState<VoicePipMeta | null>(null);
  const [panelActive, setPanelActive] = useState(false);
  const [hostEl, setHostEl] = useState<HTMLElement | null>(null);
  const [parkEl, setParkEl] = useState<HTMLElement | null>(null);
  const [avatarVideoFailed, setAvatarVideoFailed] = useState(false);

  // New credentials (fresh session or gateway reconnect) get a fresh chance.
  const livekitToken = session.avatar?.livekitToken || null;
  useEffect(() => {
    setAvatarVideoFailed(false);
  }, [livekitToken]);

  const registerAvatarHost = useCallback((el: HTMLElement) => {
    setHostEl(el);
    return () => setHostEl((cur) => (cur === el ? null : cur));
  }, []);

  return (
    <VoiceSessionContext.Provider
      value={{ ...session, meta, setMeta, panelActive, setPanelActive, avatarVideoFailed, registerAvatarHost }}
    >
      {children}
      {/* Off-screen parking holder for the persistent avatar video. */}
      <div
        ref={setParkEl}
        aria-hidden="true"
        className="fixed top-0 -left-full w-px h-px opacity-0 overflow-hidden pointer-events-none"
      />
      {session.avatar && !avatarVideoFailed && parkEl &&
        createPortal(
          <AvatarVideo
            fullBleed
            livekitUrl={session.avatar.livekitUrl}
            livekitToken={session.avatar.livekitToken}
            brandColor=""
            onFailed={(reason) => {
              console.warn(`[voice] persistent avatar video failed: ${reason}`);
              setAvatarVideoFailed(true);
            }}
          />,
          hostEl ?? parkEl,
        )}
    </VoiceSessionContext.Provider>
  );
}

export function useSharedVoiceSession(): VoiceSessionValue {
  const v = useContext(VoiceSessionContext);
  if (!v) throw new Error("useSharedVoiceSession must be used inside VoiceSessionProvider");
  return v;
}
