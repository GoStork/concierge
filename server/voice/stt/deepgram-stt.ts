import WebSocket from "ws";
import type { SttProvider, SttStream } from "../providers";

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
  private finalCb: ((text: string) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;

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
  // Dispatch hold after a punctuated speech_final. Deepgram PUNCTUATES
  // fragments ("I want you to keep the profile.") so terminal punctuation
  // alone cannot prove the utterance is over, and speech_final's own timing
  // is inconsistent (some 900ms pauses fired it, some didn't - measured
  // 2026-08-02). The hold gives resumed speech time to cancel the dispatch.
  // CRITICAL SIZING (measured): cancellation depends on the resumed speech's
  // first INTERIM arriving, and Deepgram's interim latency is ~300-800ms -
  // an 800ms hold lost the race against an 800ms pause. The hold must cover
  // max_tolerated_pause - endpointing(400) + interim_latency(~800), so 1400
  // tolerates ~1.1s conversational pauses. In practice UtteranceEnd (1200ms
  // of stream silence) usually fires FIRST and dispatches; the hold is the
  // fallback for finals whose UtteranceEnd never comes. This is deliberate
  // latency spent on correctness (Session 2 Task 1: mid-sentence splits are
  // the most damaging behavior in the product); pauses beyond the tolerance
  // are repaired by the gateway's supersession merge.
  private static readonly HOLD_MS = Number(process.env.VOICE_DISPATCH_HOLD_MS || 1400);
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
    this.segments = [];
    console.log(`[voice] deepgram utterance dispatched (${reason}): "${utterance.slice(0, 60)}"`);
    this.finalCb?.(utterance);
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
        if (msg.is_final) {
          this.cancelHold(); // speech resumed into a new segment - not over
          this.segments.push(text);
          const joined = this.segments.join(" ");
          this.partialCb?.(joined);
          // Fast-ish path: speech_final on text that reads complete starts a
          // short hold; if nothing else arrives it dispatches at +HOLD_MS.
          // Unpunctuated finals wait for UtteranceEnd / the idle fallback.
          if (msg.speech_final && /[.!?…]["')\]]?$/.test(joined)) {
            this.armHoldFlush();
          } else {
            this.armIdleFlush();
          }
        } else {
          // Interim = the parent is talking again; cancel any pending
          // dispatch and keep accumulating. Show the whole utterance so far.
          this.cancelHold();
          this.partialCb?.([...this.segments, text].join(" "));
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
  onFinal(cb: (text: string) => void): void {
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
