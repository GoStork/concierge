import { createContext, useContext, useState, type ReactNode } from "react";
import { useVoiceSession } from "@/hooks/use-voice-session";

// App-level voice session. The session (mic, WebSocket, avatar credentials)
// lives HERE, above the router, so navigating between pages never kills a
// live call: the chat page renders the full VoiceModePanel while mounted, and
// GlobalVoicePip renders a small floating video frame everywhere else -
// FaceTime semantics. The chat page reports whether its panel is currently
// showing via setPanelActive, and stores the display meta (persona name,
// avatar photo, the chat URL to return to) via setMeta.

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
};

const VoiceSessionContext = createContext<VoiceSessionValue | null>(null);

export function VoiceSessionProvider({ children }: { children: ReactNode }) {
  const session = useVoiceSession();
  const [meta, setMeta] = useState<VoicePipMeta | null>(null);
  const [panelActive, setPanelActive] = useState(false);
  return (
    <VoiceSessionContext.Provider value={{ ...session, meta, setMeta, panelActive, setPanelActive }}>
      {children}
    </VoiceSessionContext.Provider>
  );
}

export function useSharedVoiceSession(): VoiceSessionValue {
  const v = useContext(VoiceSessionContext);
  if (!v) throw new Error("useSharedVoiceSession must be used inside VoiceSessionProvider");
  return v;
}
