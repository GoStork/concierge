import { useCallback, useEffect, useRef, useState } from "react";
import { createVoiceAudioEngine, getLiveEngineCount, type VoiceAudioEngine } from "@/lib/voice/audio";
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

// PLATFORM GATE POLICY (Commit A, session 6). The mic gate + prebuffer
// existed to keep Eva's speaker echo out of STT. Measured 2026-08-02:
// desktop Chrome's AEC cancels Eva at the TRACK level (silent-room control:
// zero Deepgram tokens, 0.002-0.022 RMS residual), while iPhone Safari
// leaks transcribable fragments that dispatched as real turns (WebKit's
// canceller does not cover WebRTC remote audio). So: desktop streams the
// mic CONTINUOUSLY - Deepgram sees the parent's true timeline (no VAD
// send-gating, no echo-hold, no prebuffer, no frame drops) - while iOS
// keeps the full gate until it has its own mechanism. Barge detection
// stays on BOTH platforms. iPadOS masquerades as MacIntel - the
// maxTouchPoints check catches it.
const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 2);

// RMS above this counts as speech (tuned for echo-cancelled mic input).
const VAD_THRESHOLD = 0.015;
// Keep forwarding this long after the last speech frame so trailing words and
// natural pauses reach STT. MUST exceed Deepgram's utterance_end_ms (1200 in
// deepgram-stt.ts): UtteranceEnd is measured on the AUDIO stream's clock, so
// if the VAD gates frames before that much silence has been delivered, the
// end-of-utterance event can never fire and every turn waits for the 2s
// server-side idle fallback instead.
const VAD_HANGOVER_MS = 1600;
// Frames buffered while silent (or held back during Eva's speech), replayed
// on speech onset so words are never clipped - big enough that a failed
// interruption attempt still reaches STT once she stops talking.
const PREBUFFER_FRAMES = 32; // ~1.3s of 40ms frames
// ACCUMULATED voiced time while Eva talks that counts as a barge-in. The
// first version required 400ms of CONSECUTIVE above-threshold frames with a
// hard reset on any single quiet frame - natural speech dips between words
// and plosives, so real interruption attempts almost never fired (observed
// live on iPhone 2026-08-03: "Ariel, stop talking" went through as a normal
// turn). Voiced milliseconds now accumulate and only a real pause
// (BARGE_GRACE_MS of continuous quiet) resets the attempt.
const BARGE_VOICED_MS = 300;
const BARGE_GRACE_MS = 220;
// Caption pacing: Eva's text streams from the model far faster than she
// speaks it, so painting chunks on arrival dumps the whole reply on screen
// seconds before her voice gets there. Instead: ChatGPT-voice-style rolling
// captions - reveal word-by-word at speech rate, keep only the trailing few
// words on screen (old words disappear), advance only while her voice is
// actually audible, and clear shortly after she stops. The full text still
// lands in the chat transcript after the call.
const CAPTION_WORD_MS = 400; // ~150 wpm, Cartesia's typical speaking rate
const CAPTION_TAIL_WORDS = 10; // roughly one line of large text
const CAPTION_LINGER_MS = 900; // how long the last words stay after she stops

// ---------------------------------------------------------------------------
// Instrumentation only: browser-side timing events reported to the gateway
// (caption paint, first PCM played, LiveKit <audio> playing, first remote
// audio energy) so they land in the same per-turn [TURN_METRICS] line as the
// server marks. The active hook instance registers itself here so components
// that render outside the hook (AvatarVideo's <audio>) can report without new
// prop plumbing - same singleton pattern as remote-level.ts.
let activeMetricReporter: ((event: string) => void) | null = null;
export function reportVoiceClientMetric(event: string) {
  activeMetricReporter?.(event);
}

// AEC test-mode arming (session 6 fix): mirror ?voiceMicGate=off|on into
// localStorage at MODULE LOAD, while the original URL is still intact - the
// app's session redirect rewrites the query string long before the voice
// button is tapped, so reading it at call time missed the param on iPhone.
try {
  const bootFlag = new URLSearchParams(window.location.search).get("voiceMicGate");
  if (bootFlag === "off") localStorage.setItem("voiceMicGate", "off");
  else if (bootFlag === "on") localStorage.removeItem("voiceMicGate");
} catch { /* private mode */ }
// Avatar video health telemetry (Task 4 A/B): AvatarVideo reports rendered
// fps + delivered track resolution + element size every 2s; the gateway logs
// it server-side so adaptiveStream on/off runs are comparable from one log.
let activeFpsReporter: ((stats: Record<string, unknown>) => void) | null = null;
export function reportVoiceFpsStats(stats: Record<string, unknown>) {
  activeFpsReporter?.(stats);
}
// ---------------------------------------------------------------------------
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
  const bargeVoicedMsRef = useRef(0);
  const bargeLastVoiceAtRef = useRef(0);
  // Words of Eva's caption not yet revealed (see CAPTION_WORD_MS).
  const captionBufRef = useRef("");
  const captionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const captionLingerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Learned echo coupling: mic RMS per unit of Eva's output RMS on THIS
  // device (headphones ~0, phone speaker can approach 1). Starts conservative
  // and converges down whenever Eva speaks over a silent parent.
  const echoKRef = useRef(1.2);
  const prebufferRef = useRef<ArrayBuffer[]>([]);
  const activeRef = useRef(false);
  // ZOMBIE-ENGINE GUARD (session 6): start() awaits getUserMedia, which can
  // resolve SECONDS later (the user staring at the mic prompt) - after a
  // stop() and even after a NEW start(). Each start takes a generation
  // ticket; any await that resumes with a stale ticket destroys its engine
  // and exits. Without this, two engines interleaved into one WS and the
  // scrambled PCM made Deepgram silently deaf (observed live 2026-08-02).
  const startGenRef = useRef(0);
  // Mic telemetry: peak RMS + frames forwarded per 5s window, reported to the
  // gateway so "Eva stopped hearing me" is diagnosable from server logs alone.
  const micStatsRef = useRef({ maxRms: 0, sent: 0 });
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Instrumentation: the server's live turn id (from the "turn" frame) and
  // which per-turn events were already reported (each fires once per turn).
  const currentTurnRef = useRef(0);
  const reportedMetricsRef = useRef<Set<string>>(new Set());
  // Paint time of the parent's own transcript (updated on every partial
  // paint). Partials arrive BEFORE the turn id exists, so the latest value is
  // reported retroactively when the "turn" frame lands.
  const userTranscriptPaintRef = useRef(0);
  // eva_caption chunks received this turn - distinguishes an incrementally
  // streamed caption (many chunks) from a single-block paint (1 chunk).
  const captionChunksRef = useRef(0);

  // --- Caption pacing (word-by-word reveal at ~speech rate) ---
  const stopCaptionPacer = useCallback(() => {
    if (captionTimerRef.current) {
      clearInterval(captionTimerRef.current);
      captionTimerRef.current = null;
    }
  }, []);
  const clearCaption = useCallback(() => {
    stopCaptionPacer();
    if (captionLingerRef.current) {
      clearTimeout(captionLingerRef.current);
      captionLingerRef.current = null;
    }
    captionBufRef.current = "";
    setCaption("");
  }, [stopCaptionPacer]);
  // She stopped talking (naturally or barged) - don't dump the un-revealed
  // remainder; linger on the last words briefly, then clear the line.
  const endCaption = useCallback(() => {
    stopCaptionPacer();
    captionBufRef.current = "";
    if (captionLingerRef.current) clearTimeout(captionLingerRef.current);
    captionLingerRef.current = setTimeout(() => setCaption(""), CAPTION_LINGER_MS);
  }, [stopCaptionPacer]);
  const queueCaption = useCallback((text: string) => {
    captionBufRef.current += text;
    if (captionLingerRef.current) {
      clearTimeout(captionLingerRef.current);
      captionLingerRef.current = null;
    }
    if (captionTimerRef.current) return;
    captionTimerRef.current = setInterval(() => {
      const buf = captionBufRef.current;
      if (!buf) {
        // Buffer drained - stop ticking; the next chunk restarts the pacer.
        if (captionTimerRef.current) {
          clearInterval(captionTimerRef.current);
          captionTimerRef.current = null;
        }
        return;
      }
      // Sync to her actual voice: when the avatar's remote audio level is
      // live and currently silent (she hasn't started yet, or is pausing),
      // hold the caption - words should appear as she says them, not as the
      // model streams them. Audio-only sessions (no live level) free-run.
      const haveLiveLevel = Date.now() - remoteAudioLevel.updatedAt < 600;
      if (haveLiveLevel && remoteAudioLevel.rms < 0.02) return;
      // Reveal one word per tick; if far behind (long reply), two at a time.
      const pendingWords = buf.split(/\s+/).filter(Boolean).length;
      const take = pendingWords > 30 ? 2 : 1;
      let cut = 0;
      for (let i = 0; i < take; i++) {
        const m = /^\s*\S+\s?/.exec(buf.slice(cut));
        if (!m) { cut = buf.length; break; }
        cut += m[0].length;
      }
      const next = buf.slice(0, cut);
      captionBufRef.current = buf.slice(cut);
      // Rolling window: keep only the trailing words - one line of large
      // text, like ChatGPT's voice mode. Old words fall away.
      setCaption((prev) => {
        const words = (prev + next).split(/\s+/).filter(Boolean);
        return words.slice(-CAPTION_TAIL_WORDS).join(" ");
      });
    }, CAPTION_WORD_MS);
  }, []);

  const reportMetric = useCallback((event: string, opts?: { tClient?: number; extra?: Record<string, unknown> }) => {
    const turn = currentTurnRef.current;
    if (!turn) return;
    const key = `${turn}:${event}`;
    if (reportedMetricsRef.current.has(key)) return;
    reportedMetricsRef.current.add(key);
    const sock = wsRef.current;
    if (sock?.readyState === WebSocket.OPEN) {
      sock.send(
        JSON.stringify({
          type: "client_metric",
          turn,
          event,
          tClient: opts?.tClient ?? Date.now(),
          ...(opts?.extra ? { extra: opts.extra } : {}),
        }),
      );
    }
  }, []);

  const setStateBoth = (s: VoiceState) => {
    stateRef.current = s;
    setState(s);
  };

  const stop = useCallback((reason = "user_ended") => {
    if (!activeRef.current) return;
    activeRef.current = false;
    // Invalidate any start() still parked on getUserMedia.
    startGenRef.current += 1;
    activeMetricReporter = null;
    activeFpsReporter = null;
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
    clearCaption();
    setEndReason(reason);
    setStateBoth("ended");
  }, [clearCaption]);

  const start = useCallback(async (opts: StartOpts) => {
    if (activeRef.current) return;
    activeRef.current = true;
    const myGen = ++startGenRef.current;
    setError(null);
    setEndReason(null);
    setCards(null);
    clearCaption();
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
      if (myGen === startGenRef.current) {
        activeRef.current = false;
        setError(
          err?.name === "NotAllowedError"
            ? "Microphone access was denied. You can keep chatting in text."
            : `Could not start audio: ${err?.message || err}`,
        );
        setStateBoth("error");
      }
      return;
    }
    // Stale ticket = stop() (or a newer start) happened while we were parked
    // on the mic prompt. This engine must never attach to anything.
    if (!activeRef.current || myGen !== startGenRef.current) {
      console.warn("[voice] zombie-engine guard: discarding engine from a superseded start()");
      engine.destroy();
      return;
    }
    // Single-owner invariant: the hook owns AT MOST one engine, ever.
    if (engineRef.current) {
      console.warn("[voice] zombie-engine guard: destroying orphaned previous engine");
      engineRef.current.destroy();
    }
    engineRef.current = engine;
    currentTurnRef.current = 0;
    reportedMetricsRef.current = new Set();
    activeMetricReporter = reportMetric;

    // AEC AUDIT SWITCH (session 5): localStorage.voiceMicGate = "off" streams
    // EVERY mic frame to STT - no VAD gate, no echo-hold, no prebuffer, and
    // no barge signal (Eva must keep talking during the test). Used to
    // measure what Deepgram transcribes from pure speaker echo while the
    // parent stays silent. Read once per session start.
    let micGateOff = false;
    try {
      // ?voiceMicGate=off in the URL mirrors into localStorage - the only
      // practical way to arm the flag on iPhone Safari for the iOS AEC test.
      const urlFlag = new URLSearchParams(window.location.search).get("voiceMicGate");
      if (urlFlag === "off" || urlFlag === "on") {
        if (urlFlag === "off") localStorage.setItem("voiceMicGate", "off");
        else localStorage.removeItem("voiceMicGate");
      }
      micGateOff = localStorage.getItem("voiceMicGate") === "off";
    } catch { /* private mode */ }
    if (micGateOff) {
      console.warn("[voice] MIC GATE BYPASSED (voiceMicGate=off) - AEC test mode");
      // Test-mode only: lets the AEC control script make Eva speak at length
      // with no human in the loop (silent-room control). Uses wsRef directly
      // (sendText is declared later in the hook).
      (window as any).__voiceSendText = (t: string) => {
        const sock = wsRef.current;
        if (sock?.readyState === WebSocket.OPEN) {
          setCards(null);
          sock.send(JSON.stringify({ type: "text", text: t, fixedReply: false }));
        }
      };
    }
    activeFpsReporter = (stats) => {
      const sock = wsRef.current;
      if (sock?.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: "fps_stats", ...stats, tClient: Date.now() }));
      }
    };

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
      // AEC audit: what the browser GRANTED for the mic (echoCancellation
      // etc.) + the active gate policy - logged server-side so every
      // baseline is attributable to a platform policy.
      ws.send(
        JSON.stringify({
          type: "mic_settings",
          settings: engine.micSettings,
          gateBypassed: micGateOff,
          gatePolicy: micGateOff ? "test-bypass" : IS_IOS ? "gated-ios" : "ungated-desktop",
        }),
      );
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        // Binary = Eva audio (16kHz PCM16)
        // Instrumentation: first PCM pushed into local Web Audio playback for
        // this turn. This path only carries audio when NO avatar is routing
        // (audio-only replies) - seeing it while an avatar is live means the
        // reply's route snapshot predated the avatar connecting.
        reportMetric("local_pcm_play_start");
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
        case "turn":
          // Instrumentation: correlates client metric reports with the
          // server's per-turn record.
          currentTurnRef.current = Number(msg.turn) || 0;
          captionChunksRef.current = 0;
          // The user's own transcript painted before the turn id existed -
          // report it retroactively with its real paint timestamp.
          if (userTranscriptPaintRef.current) {
            reportMetric("user_transcript_painted", { tClient: userTranscriptPaintRef.current });
            userTranscriptPaintRef.current = 0;
          }
          break;
        case "state":
          if (["listening", "thinking", "speaking"].includes(msg.state)) {
            const wasBarge = bargeSentRef.current;
            setStateBoth(msg.state);
            // Eva finished (or was cut off) - linger on the last words, then
            // clear the rolling caption line (full text lives in the chat).
            if (msg.state === "listening") endCaption();
            if (msg.state !== "speaking") {
              bargeSentRef.current = false;
              bargeStartRef.current = 0;
              bargeVoicedMsRef.current = 0;
              // Leaving "speaking" without a barge means the prebuffer holds
              // Eva's own leaked tail, not the parent - drop it. After a real
              // barge it holds the parent's interrupting words - keep those.
              if (!wasBarge) prebufferRef.current = [];
            }
          }
          break;
        case "partial_transcript":
          setPartialTranscript(msg.text || "");
          // Instrumentation: track when the parent's OWN transcript last
          // painted (reported at the next "turn" frame - see case "turn").
          requestAnimationFrame(() =>
            requestAnimationFrame(() => { userTranscriptPaintRef.current = Date.now(); }),
          );
          break;
        case "final_transcript":
          setPartialTranscript("");
          clearCaption();
          setCards(null);
          setCardsPreview(false);
          break;
        case "cards_preview":
          setCardsPreview(true);
          break;
        case "eva_caption":
          queueCaption(msg.text || "");
          // Instrumentation: first paint of the AGENT's caption this turn
          // (double rAF fires after the browser paints the frame containing
          // this state update). reportMetric dedupes to the first chunk.
          captionChunksRef.current += 1;
          requestAnimationFrame(() =>
            requestAnimationFrame(() => reportMetric("agent_caption_first_painted")),
          );
          break;
        case "caption_reset":
          clearCaption();
          setCardsPreview(false);
          break;
        case "cards": {
          if (msg.payload && Object.keys(msg.payload).length) setCards(msg.payload);
          setCardsPreview(false);
          // Instrumentation: "cards" follows the reply's last eva_caption
          // chunk (sent at router done), so the caption is now complete -
          // this paint is "agent caption fully painted". captionChunks shows
          // whether it streamed (many) or landed as one block (1).
          const chunks = captionChunksRef.current;
          if (chunks > 0) {
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                reportMetric("agent_caption_full_painted", { extra: { captionChunks: chunks } }),
              ),
            );
          }
          break;
        }
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
      // liveEngines MUST be 1 - the gateway flags anything else loudly.
      sock.send(JSON.stringify({ type: "mic_stats", maxRms: s.maxRms, sent: s.sent, liveEngines: getLiveEngineCount() }));
      micStatsRef.current = { maxRms: 0, sent: 0 };
    }, 5000);

    engine.onMicFrame((pcm, rms) => {
      // Always the CURRENT socket - after an auto-reconnect the original one
      // is dead and frames must flow to its replacement.
      const sock = wsRef.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      if (rms > micStatsRef.current.maxRms) micStatsRef.current.maxRms = rms;
      if (micGateOff) {
        // AEC test mode: raw pass-through, no VAD, no hold, no barge.
        sock.send(pcm);
        micStatsRef.current.sent += 1;
        return;
      }
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
      // Instrumentation: first audible energy on the avatar's LiveKit audio
      // track after the turn started - the closest client-side proxy for
      // "LiveAvatar first speech frame" (no explicit callback is wired today).
      if (remoteRms > 0.03) reportMetric("remote_audio_first");
      if (evaSpeaking && remoteRms > 0.03) {
        const ratio = rms / remoteRms;
        if (ratio < echoKRef.current) {
          echoKRef.current = echoKRef.current * 0.7 + ratio * 0.3;
        }
      }
      // Margin over the learned echo level: 1.5x (was 1.8x - on a phone
      // speaker the parent talking over Eva at normal volume sat under the
      // stricter margin and interruptions never registered).
      const bargeVoice =
        rms > Math.max(BARGE_MIN_RMS, remoteRms * (echoKRef.current * 1.5 + 0.05));
      const frameMs = (pcm.byteLength / 2 / 16000) * 1000;
      if (evaSpeaking && bargeVoice) {
        if (!bargeStartRef.current) {
          bargeStartRef.current = now;
          bargeVoicedMsRef.current = 0;
        }
        bargeVoicedMsRef.current += frameMs;
        bargeLastVoiceAtRef.current = now;
      } else if (
        !bargeVoice &&
        bargeStartRef.current &&
        now - bargeLastVoiceAtRef.current > BARGE_GRACE_MS
      ) {
        // A real pause, not an inter-word dip - this attempt is over.
        bargeStartRef.current = 0;
        bargeVoicedMsRef.current = 0;
      }
      if (
        evaSpeaking &&
        bargeStartRef.current &&
        bargeVoicedMsRef.current >= BARGE_VOICED_MS &&
        !bargeSentRef.current
      ) {
        bargeSentRef.current = true;
        engine.flushPlayback();
        sock.send(JSON.stringify({ type: "barge" }));
        reportMetric("barge_sent");
      }

      // DESKTOP (AEC verified): stream every frame - Deepgram reasons over
      // the parent's real timeline. Echo is cancelled at the track level, so
      // there is nothing to hold back and nothing to drop.
      if (!IS_IOS) {
        sock.send(pcm);
        micStatsRef.current.sent += 1;
        return;
      }
      // iOS ONLY from here: WebKit's AEC does not cover the avatar's WebRTC
      // audio, so while Eva is audibly speaking (and no barge yet), mic audio
      // must NOT reach transcription - it is largely her own leaked voice and
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
