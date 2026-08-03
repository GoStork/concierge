import WebSocket from "ws";
import type { SttProvider, SttStream, SttUtteranceMeta } from "../providers";

// Deepgram streaming STT (budget option, ~$0.008/min). linear16 16kHz mono in,
// interim + final transcripts out. KeepAlive pings hold the socket open across
// silent stretches (the client VAD gates mic frames, so silence gaps are long).

class DeepgramStream implements SttStream {
  private ws: WebSocket;
  private open = false;
  private closed = false;
  private pending: Buffer[] = [];
  private keepAlive: NodeJS.Timeout | null = null;
  private partialCb: ((text: string) => void) | null = null;
  private finalCb: ((text: string, meta?: SttUtteranceMeta) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;

  // Utterance-assembly telemetry (Session 4): when the utterance STARTED
  // being heard, when it last GREW (the true end of speech - dispatch holds
  // sit after this), and the inter-segment gaps the merge logic reasoned
  // about. Shipped with each dispatched utterance so [TURN_METRICS] can
  // attribute over-merges and truncations to a specific path.
  private tFirstActivity = 0;
  private tLastGrowth = 0;
  private tPrevActivity = 0;
  private maxWordCount = 0;
  private segmentGapsMs: number[] = [];
  private minConfidence: number | null = null;

  private noteActivity(candidateText: string, isSegmentPush: boolean) {
    const now = Date.now();
    if (!this.tFirstActivity) this.tFirstActivity = now;
    if (isSegmentPush) {
      this.segmentGapsMs.push(this.tPrevActivity ? now - this.tPrevActivity : 0);
    }
    const wc = candidateText.split(/\s+/).filter(Boolean).length;
    if (wc > this.maxWordCount) {
      this.maxWordCount = wc;
      this.tLastGrowth = now;
    }
    this.tPrevActivity = now;
  }

  // PREMATURE-ENDPOINTING FIX. Deepgram's `is_final` marks SEGMENT
  // finalization (the audio window won't be re-transcribed), NOT the end of
  // the utterance - dispatching a turn per is_final split mid-sentence speech
  // into fragments ("I want you to keep the profile" / "while I'm talking to
  // you") and Eva answered the fragment. Finalized segments now ACCUMULATE
  // here and one utterance is dispatched when the earliest of these fires:
  //   1. speech_final AND the accumulated text ends in terminal punctuation
  //      (fast path - complete sentences keep today's snappy dispatch);
  //   2. Deepgram's UtteranceEnd event (utterance_end_ms of silence in the
  //      audio stream - requires the client VAD hangover to exceed it, see
  //      VAD_HANGOVER_MS in use-voice-session.ts);
  //   3. a 2s wall-clock idle fallback, so a gated mic (VAD stopped sending
  //      frames, so Deepgram's audio clock froze) can never strand a pending
  //      utterance.
  private segments: string[] = [];
  private idleFlush: NodeJS.Timeout | null = null;
  // AEC-audit debug (session 5): when enabled (gateway turns it on for
  // gate-bypassed test sessions only - parent speech is PII), EVERY
  // transcript-bearing Deepgram message is logged, interims included. "Zero
  // dispatches" is not "zero tokens"; this shows what Deepgram actually
  // heard.
  private debug = false;
  setDebug(v: boolean) {
    this.debug = v;
  }
  // Dispatch hold after a punctuated speech_final - GATED (iOS) SESSIONS
  // ONLY since Commit B. On gated clients the VAD/echo-hold starves
  // Deepgram's audio clock, so UtteranceEnd can miss and speech_final +
  // this hold is the working dispatcher; sizing covers Deepgram's
  // ~300-800ms interim latency (an 800ms hold lost the race against an
  // 800ms pause - measured 2026-08-02). On UNGATED (desktop) sessions the
  // mic streams continuously, UtteranceEnd fires reliably first, and the
  // 2026-08-03 15-turn baseline measured this hold firing 0/29 times -
  // dead code there, so ungated sessions skip it (speech_final simply
  // accumulates; UtteranceEnd or the 2s idle fallback dispatches).
  // The gateway declares the session profile via setHoldEnabled() from the
  // client's gatePolicy handshake; default ON (safe for unknown clients).
  private static readonly HOLD_MS = Number(process.env.VOICE_DISPATCH_HOLD_MS || 1400);
  private holdEnabled = true;
  setHoldEnabled(v: boolean) {
    this.holdEnabled = v;
  }
  private holdFlush: NodeJS.Timeout | null = null;

  private cancelHold() {
    if (this.holdFlush) clearTimeout(this.holdFlush);
    this.holdFlush = null;
  }

  private armHoldFlush() {
    this.cancelHold();
    this.holdFlush = setTimeout(() => this.flushUtterance("speech_final_held"), DeepgramStream.HOLD_MS);
  }

  private flushUtterance(reason: string) {
    if (this.idleFlush) clearTimeout(this.idleFlush);
    this.idleFlush = null;
    this.cancelHold();
    if (this.segments.length === 0) return;
    const utterance = this.segments.join(" ");
    const meta: SttUtteranceMeta = {
      tFirstInterim: this.tFirstActivity,
      tLastNewWords: this.tLastGrowth,
      segments: this.segments.length,
      segmentGapsMs: [...this.segmentGapsMs],
      dispatchPath: reason,
      minConfidence: this.minConfidence,
    };
    this.segments = [];
    this.tFirstActivity = 0;
    this.tLastGrowth = 0;
    this.tPrevActivity = 0;
    this.maxWordCount = 0;
    this.segmentGapsMs = [];
    this.minConfidence = null;
    console.log(
      `[voice] deepgram utterance dispatched (${reason}, ${meta.segments} seg, gaps=[${meta.segmentGapsMs.join(",")}]ms): "${utterance.slice(0, 60)}"`,
    );
    this.finalCb?.(utterance, meta);
  }

  private armIdleFlush() {
    if (this.idleFlush) clearTimeout(this.idleFlush);
    this.idleFlush = setTimeout(() => this.flushUtterance("idle_fallback"), 2000);
  }

  constructor(sampleRate: number, language: string, apiKey: string) {
    const params = new URLSearchParams({
      encoding: "linear16",
      sample_rate: String(sampleRate),
      channels: "1",
      language,
      punctuate: "true",
      interim_results: "true",
      // Segment finalization cadence (unchanged) - segments are ACCUMULATED
      // now, so this no longer controls turn dispatch.
      endpointing: "400",
      // UtteranceEnd fires after this much silence between finalized words in
      // the AUDIO stream - the real end-of-utterance signal. Pauses shorter
      // than this stay inside one turn.
      utterance_end_ms: "1200",
      model: "nova-3",
    });
    // Keyterm prompting (nova-3, English): boost the fertility vocabulary
    // parents actually say. Without it, real mishearings happened - "an egg
    // donor" transcribed as "an Angular".
    if (language === "en") {
      for (const term of [
        "egg donor",
        "sperm donor",
        "surrogate",
        "surrogacy",
        "IVF",
        "embryo",
        "embryos",
        "fertility clinic",
        "egg bank",
        "intended parent",
        "PGT-A",
        "GoStork",
      ]) {
        params.append("keyterm", term);
      }
    }
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    this.ws.on("open", () => {
      this.open = true;
      for (const b of this.pending) this.ws.send(b);
      this.pending = [];
      this.keepAlive = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, 8000);
    });
    this.ws.on("message", (data) => {
      if (this.closed) return;
      try {
        const msg = JSON.parse(data.toString());
        // The real end-of-utterance signal: utterance_end_ms of silence after
        // the last finalized word. Dispatch whatever has accumulated.
        if (msg.type === "UtteranceEnd") {
          this.flushUtterance("utterance_end");
          return;
        }
        const alt = msg.channel?.alternatives?.[0];
        const text = alt?.transcript?.trim();
        if (!text) return;
        if (this.debug) {
          console.log(
            `[stt-debug] ${msg.is_final ? "FINAL" : "interim"}${msg.speech_final ? "+speech_final" : ""} ` +
              `(conf=${(alt?.confidence ?? 0).toFixed(2)}): "${text.slice(0, 120)}"`,
          );
        }
        if (msg.is_final) {
          this.cancelHold(); // speech resumed into a new segment - not over
          this.segments.push(text);
          const conf = alt?.confidence;
          if (typeof conf === "number") {
            this.minConfidence = this.minConfidence === null ? conf : Math.min(this.minConfidence, conf);
          }
          const joined = this.segments.join(" ");
          this.noteActivity(joined, true);
          this.partialCb?.(joined);
          // Gated sessions: speech_final on complete-reading text starts the
          // hold; if nothing else arrives it dispatches at +HOLD_MS.
          // Ungated sessions skip the hold entirely (UtteranceEnd owns
          // dispatch; idle fallback is the safety net). Unpunctuated finals
          // always wait for UtteranceEnd / idle fallback.
          if (this.holdEnabled && msg.speech_final && /[.!?…]["')\]]?$/.test(joined)) {
            this.armHoldFlush();
          } else {
            this.armIdleFlush();
          }
        } else {
          // Interim = the parent is talking again; cancel any pending
          // dispatch and keep accumulating. Show the whole utterance so far.
          this.cancelHold();
          const joined = [...this.segments, text].join(" ");
          this.noteActivity(joined, false);
          this.partialCb?.(joined);
          if (this.segments.length > 0) this.armIdleFlush();
        }
      } catch {
        /* non-transcript frame */
      }
    });
    this.ws.on("error", (err) => {
      if (!this.closed) this.errorCb?.(err as Error);
    });
  }

  sendAudio(pcm: Buffer): void {
    if (this.closed) return;
    if (this.open && this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm);
    else this.pending.push(pcm);
  }
  close(): void {
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.idleFlush) clearTimeout(this.idleFlush);
    this.cancelHold();
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      }
      this.ws.close(1000);
    } catch {
      /* already closed */
    }
  }
  onPartial(cb: (text: string) => void): void {
    this.partialCb = cb;
  }
  onFinal(cb: (text: string, meta?: SttUtteranceMeta) => void): void {
    this.finalCb = cb;
  }
  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }
}

export const deepgramStt: SttProvider = {
  name: "deepgram",
  isConfigured: () => !!process.env.DEEPGRAM_API_KEY,
  openStream({ sampleRate, languageCode }) {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) throw new Error("DEEPGRAM_API_KEY is not set");
    return new DeepgramStream(sampleRate, (languageCode || "en-US").split("-")[0], key);
  },
};
