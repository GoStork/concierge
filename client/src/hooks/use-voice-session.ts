import { useCallback, useEffect, useRef, useState } from "react";
import { createVoiceAudioEngine, type VoiceAudioEngine } from "@/lib/voice/audio";
import { remoteAudioLevel } from "@/lib/voice/remote-level";

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
// Frames buffered while silent (or held back during Eva's speech), replayed
// on speech onset so words are never clipped - big enough that a failed
// interruption attempt still reaches STT once she stops talking.
const PREBUFFER_FRAMES = 32; // ~1.3s of 40ms frames
// Sustained speech this long while Eva talks = barge-in.
const BARGE_MS = 400;
// Barge-in noise floor: while Eva is audible, plain VAD level is not enough -
// on iOS her own speaker output leaks into the mic (AEC does not cancel
// WebRTC remote audio). The echo COUPLING (mic level per unit of her output)
// varies wildly by device and volume, so a fixed multiplier was either
// uninterruptible (speaker) or self-barging. Instead the coupling is LEARNED:
// while Eva speaks and the parent is silent, mic/remote ratio converges to
// the true echo level, and a barge must clearly exceed it.
const BARGE_MIN_RMS = 0.035;

export function useVoiceSession() {
  const [state, setState] = useState<VoiceState>("ended");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [caption, setCaption] = useState("");
  const [cards, setCards] = useState<VoiceCardsPayload | null>(null);
  // Eva's stream contains a MATCH_CARD tag; the card payload lands at done.
  // This bridges the gap so the profile UI opens the moment she presents it.
  const [cardsPreview, setCardsPreview] = useState(false);
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
  const bargeStartRef = useRef(0);
  const bargeSentRef = useRef(false);
  // Learned echo coupling: mic RMS per unit of Eva's output RMS on THIS
  // device (headphones ~0, phone speaker can approach 1). Starts conservative
  // and converges down whenever Eva speaks over a silent parent.
  const echoKRef = useRef(1.2);
  const prebufferRef = useRef<ArrayBuffer[]>([]);
  const activeRef = useRef(false);
  // Mic telemetry: peak RMS + frames forwarded per 5s window, reported to the
  // gateway so "Eva stopped hearing me" is diagnosable from server logs alone.
  const micStatsRef = useRef({ maxRms: 0, sent: 0 });
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const setStateBoth = (s: VoiceState) => {
    stateRef.current = s;
    setState(s);
  };

  const stop = useCallback((reason = "user_ended") => {
    if (!activeRef.current) return;
    activeRef.current = false;
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
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
    setCardsPreview(false);
    echoKRef.current = 1.2;
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

    // The socket is reconnectable: a server deploy or a mobile network blip
    // closes the WS mid-conversation, and dying to text for that reads as a
    // crash. On an unexpected close we reopen (2 attempts) with the same
    // session - the server starts a fresh avatar session and the panel swaps
    // in the new video. Deliberate ends (user, caps, server "ended" frames)
    // go through stop() first, so they never reconnect.
    let reconnects = 0;

    const connectSocket = (isReconnect: boolean) => {
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
          // Never re-greet on a reconnect mid-conversation
          greetingText: isReconnect ? undefined : opts.greetingText || undefined,
          // Phones get the persona's portrait avatar variant when one is set
          portrait: window.innerHeight > window.innerWidth,
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
          reconnects = 0;
          setStateBoth("listening");
          break;
        case "state":
          if (["listening", "thinking", "speaking"].includes(msg.state)) {
            const wasBarge = bargeSentRef.current;
            setStateBoth(msg.state);
            if (msg.state !== "speaking") {
              bargeSentRef.current = false;
              bargeStartRef.current = 0;
              // Leaving "speaking" without a barge means the prebuffer holds
              // Eva's own leaked tail, not the parent - drop it. After a real
              // barge it holds the parent's interrupting words - keep those.
              if (!wasBarge) prebufferRef.current = [];
            }
          }
          break;
        case "partial_transcript":
          setPartialTranscript(msg.text || "");
          break;
        case "final_transcript":
          setPartialTranscript("");
          setCaption("");
          setCards(null);
          setCardsPreview(false);
          break;
        case "cards_preview":
          setCardsPreview(true);
          break;
        case "eva_caption":
          setCaption((prev) => prev + (msg.text || ""));
          break;
        case "caption_reset":
          setCaption("");
          setCardsPreview(false);
          break;
        case "cards":
          if (msg.payload && Object.keys(msg.payload).length) setCards(msg.payload);
          setCardsPreview(false);
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
      if (stateRef.current === "connecting" && !isReconnect && reconnects === 0) {
        setError("Could not connect to voice. You can keep chatting in text.");
        setStateBoth("error");
        activeRef.current = false;
        engine.destroy();
        engineRef.current = null;
      }
    };
    ws.onclose = () => {
      if (!activeRef.current || wsRef.current !== ws) return;
      reconnects += 1;
      if (reconnects <= 2) {
        setStateBoth("connecting");
        setTimeout(() => {
          if (activeRef.current && wsRef.current === ws) connectSocket(true);
        }, reconnects === 1 ? 800 : 2500);
      } else {
        stop("connection_closed");
      }
    };
    }; // end connectSocket

    connectSocket(false);

    micStatsRef.current = { maxRms: 0, sent: 0 };
    if (statsTimerRef.current) clearInterval(statsTimerRef.current);
    statsTimerRef.current = setInterval(() => {
      const sock = wsRef.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      const s = micStatsRef.current;
      sock.send(JSON.stringify({ type: "mic_stats", maxRms: s.maxRms, sent: s.sent }));
      micStatsRef.current = { maxRms: 0, sent: 0 };
    }, 5000);

    engine.onMicFrame((pcm, rms) => {
      // Always the CURRENT socket - after an auto-reconnect the original one
      // is dead and frames must flow to its replacement.
      const sock = wsRef.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      if (rms > micStatsRef.current.maxRms) micStatsRef.current.maxRms = rms;
      const now = Date.now();
      const speaking = rms > VAD_THRESHOLD;

      if (speaking) {
        if (!speechStartRef.current) speechStartRef.current = now;
        lastVoiceAtRef.current = now;
      } else {
        speechStartRef.current = 0;
      }

      const evaSpeaking = stateRef.current === "speaking";

      // Echo-aware barge-in with a LEARNED coupling: whenever Eva is audible,
      // the observed mic/remote ratio pulls the coupling estimate down toward
      // the true echo level (a silent parent = pure echo). A real interruption
      // must beat that estimate with clear margin, sustained.
      const remoteRms =
        now - remoteAudioLevel.updatedAt < 400 ? remoteAudioLevel.rms : 0;
      if (evaSpeaking && remoteRms > 0.03) {
        const ratio = rms / remoteRms;
        if (ratio < echoKRef.current) {
          echoKRef.current = echoKRef.current * 0.7 + ratio * 0.3;
        }
      }
      const bargeVoice =
        rms > Math.max(BARGE_MIN_RMS, remoteRms * (echoKRef.current * 1.8 + 0.05));
      if (evaSpeaking && bargeVoice) {
        if (!bargeStartRef.current) bargeStartRef.current = now;
      } else if (!bargeVoice) {
        bargeStartRef.current = 0;
      }
      if (
        evaSpeaking &&
        bargeVoice &&
        bargeStartRef.current &&
        now - bargeStartRef.current >= BARGE_MS &&
        !bargeSentRef.current
      ) {
        bargeSentRef.current = true;
        engine.flushPlayback();
        sock.send(JSON.stringify({ type: "barge" }));
      }

      // While Eva is audibly speaking (and no barge yet), mic audio must NOT
      // reach transcription - on iOS it is largely her own leaked voice and
      // was being transcribed as the parent. Prebuffer instead, so when a
      // barge (or the end of her reply) opens the floor, the parent's first
      // words replay into STT unclipped.
      const holdForEcho = evaSpeaking && !bargeSentRef.current;
      const active = now - lastVoiceAtRef.current < VAD_HANGOVER_MS;
      if (active && !holdForEcho) {
        // Replay the prebuffer so speech onset isn't clipped.
        for (const buffered of prebufferRef.current) sock.send(buffered);
        prebufferRef.current = [];
        sock.send(pcm);
        micStatsRef.current.sent += 1;
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
    cardsPreview,
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
