import { useCallback, useEffect, useRef, useState } from "react";
import { createVoiceAudioEngine, type VoiceAudioEngine } from "@/lib/voice/audio";

// Client half of the voice gateway (server/voice/voice-gateway.ts). Owns the
// WebSocket, the audio engine, client-side RMS VAD (mic frames are only
// forwarded while the parent is actually speaking, which is what keeps STT
// minutes cheap), and barge-in detection while Eva is speaking.

export type VoiceState = "connecting" | "listening" | "thinking" | "speaking" | "ended" | "error";

export interface VoiceCardsPayload {
  quickReplies?: any[];
  matchCards?: any[];
  doctorCards?: any[];
  comparisonCards?: any[];
  consultationCard?: any;
  meetingCards?: any[];
  [key: string]: any;
}

interface StartOpts {
  sessionId: string | null;
  matchmakerId: string | null;
  greetingText?: string | null;
}

// RMS above this counts as speech (tuned for echo-cancelled mic input).
const VAD_THRESHOLD = 0.015;
// Keep forwarding this long after the last speech frame so trailing words and
// natural pauses reach STT.
const VAD_HANGOVER_MS = 900;
// Frames buffered while silent, replayed on speech onset so the first word is
// never clipped.
const PREBUFFER_FRAMES = 8; // ~320ms of 40ms frames
// Sustained speech this long while Eva talks = barge-in.
const BARGE_MS = 300;

export function useVoiceSession() {
  const [state, setState] = useState<VoiceState>("ended");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [caption, setCaption] = useState("");
  const [cards, setCards] = useState<VoiceCardsPayload | null>(null);
  const [micMuted, setMicMutedState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [endReason, setEndReason] = useState<string | null>(null);
  // Phase 3: realtime video avatar - LiveKit credentials from the gateway.
  // When set, Eva's audio+video arrive through the LiveKit room instead of
  // PCM frames over the WS.
  const [avatar, setAvatar] = useState<{ livekitUrl: string; livekitToken: string } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const engineRef = useRef<VoiceAudioEngine | null>(null);
  const stateRef = useRef<VoiceState>("ended");
  const lastVoiceAtRef = useRef(0);
  const speechStartRef = useRef(0);
  const bargeSentRef = useRef(false);
  const prebufferRef = useRef<ArrayBuffer[]>([]);
  const activeRef = useRef(false);

  const setStateBoth = (s: VoiceState) => {
    stateRef.current = s;
    setState(s);
  };

  const stop = useCallback((reason = "user_ended") => {
    if (!activeRef.current) return;
    activeRef.current = false;
    try {
      wsRef.current?.send(JSON.stringify({ type: "end" }));
    } catch {
      /* socket already gone */
    }
    wsRef.current?.close();
    wsRef.current = null;
    engineRef.current?.destroy();
    engineRef.current = null;
    setEndReason(reason);
    setStateBoth("ended");
  }, []);

  const start = useCallback(async (opts: StartOpts) => {
    if (activeRef.current) return;
    activeRef.current = true;
    setError(null);
    setEndReason(null);
    setCards(null);
    setCaption("");
    setPartialTranscript("");
    setAvatar(null);
    setStateBoth("connecting");

    let engine: VoiceAudioEngine;
    try {
      // Must run inside the user gesture: resumes AudioContext + mic prompt.
      engine = await createVoiceAudioEngine();
    } catch (err: any) {
      activeRef.current = false;
      setError(
        err?.name === "NotAllowedError"
          ? "Microphone access was denied. You can keep chatting in text."
          : `Could not start audio: ${err?.message || err}`,
      );
      setStateBoth("error");
      return;
    }
    engineRef.current = engine;

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/api/voice/ws`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          sessionId: opts.sessionId,
          matchmakerId: opts.matchmakerId,
          greetingText: opts.greetingText || undefined,
        }),
      );
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        // Binary = Eva audio (16kHz PCM16)
        engine.playPcm(e.data as ArrayBuffer);
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "ready":
          setStateBoth("listening");
          break;
        case "state":
          if (["listening", "thinking", "speaking"].includes(msg.state)) {
            setStateBoth(msg.state);
            if (msg.state !== "speaking") bargeSentRef.current = false;
          }
          break;
        case "partial_transcript":
          setPartialTranscript(msg.text || "");
          break;
        case "final_transcript":
          setPartialTranscript("");
          setCaption("");
          setCards(null);
          break;
        case "eva_caption":
          setCaption((prev) => prev + (msg.text || ""));
          break;
        case "caption_reset":
          setCaption("");
          break;
        case "cards":
          if (msg.payload && Object.keys(msg.payload).length) setCards(msg.payload);
          break;
        case "avatar":
          if (msg.livekitUrl && msg.livekitToken) {
            setAvatar({ livekitUrl: msg.livekitUrl, livekitToken: msg.livekitToken });
          }
          break;
        case "ended":
          stop(msg.reason || "server_ended");
          if (msg.reason === "voice_not_configured") {
            // Loud, honest failure: the persona has no voice for the active
            // provider. Keep the panel open in error state so the parent
            // knows to continue in text (and the admin sees what to fix).
            setError("Voice isn't set up for this assistant yet. Please continue in text.");
            setStateBoth("error");
          }
          break;
      }
    };

    ws.onerror = () => {
      if (stateRef.current === "connecting") {
        setError("Could not connect to voice. You can keep chatting in text.");
        setStateBoth("error");
        activeRef.current = false;
        engine.destroy();
        engineRef.current = null;
      }
    };
    ws.onclose = () => {
      if (activeRef.current) stop("connection_closed");
    };

    engine.onMicFrame((pcm, rms) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      const speaking = rms > VAD_THRESHOLD;

      if (speaking) {
        if (!speechStartRef.current) speechStartRef.current = now;
        lastVoiceAtRef.current = now;
      } else {
        speechStartRef.current = 0;
      }

      // Barge-in: sustained parent speech while Eva talks.
      if (
        stateRef.current === "speaking" &&
        speaking &&
        speechStartRef.current &&
        now - speechStartRef.current >= BARGE_MS &&
        !bargeSentRef.current
      ) {
        bargeSentRef.current = true;
        engine.flushPlayback();
        ws.send(JSON.stringify({ type: "barge" }));
      }

      const active = now - lastVoiceAtRef.current < VAD_HANGOVER_MS;
      if (active) {
        // Replay the prebuffer so speech onset isn't clipped.
        for (const buffered of prebufferRef.current) ws.send(buffered);
        prebufferRef.current = [];
        ws.send(pcm);
      } else {
        prebufferRef.current.push(pcm);
        if (prebufferRef.current.length > PREBUFFER_FRAMES) prebufferRef.current.shift();
      }
    });
  }, [stop]);

  const sendText = useCallback((text: string, fixedReply = false) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setCards(null);
      wsRef.current.send(JSON.stringify({ type: "text", text, fixedReply }));
    }
  }, []);

  const setMicMuted = useCallback((muted: boolean) => {
    engineRef.current?.setMicMuted(muted);
    setMicMutedState(muted);
  }, []);

  // Teardown on unmount.
  useEffect(() => () => stop("unmounted"), [stop]);

  return {
    state,
    partialTranscript,
    caption,
    cards,
    micMuted,
    error,
    endReason,
    avatar,
    start,
    stop,
    sendText,
    setMicMuted,
  };
}
