import WebSocket from "ws";
import type { TtsProvider, TtsStream } from "../providers";

// Cartesia Sonic over their TTS WebSocket - the lowest time-to-first-audio in
// the market. Sentence chunks stream in with continue:true on one context;
// raw pcm_s16le at 16kHz comes back, matching the pipeline format directly.
// voiceId = a Cartesia voice id.

class CartesiaStream implements TtsStream {
  private ws: WebSocket;
  private open = false;
  private cancelled = false;
  private pending: string[] = [];
  private flushRequested = false;
  private audioCb: ((pcm: Buffer) => void) | null = null;
  private endCb: (() => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private readonly contextId = `ctx-${Math.random().toString(36).slice(2)}`;
  charsSent = 0;

  constructor(private readonly voiceId: string, apiKey: string) {
    this.ws = new WebSocket(
      `wss://api.cartesia.ai/tts/websocket?api_key=${encodeURIComponent(apiKey)}&cartesia_version=2025-04-16`,
    );
    this.ws.on("open", () => {
      if (this.cancelled) return;
      this.open = true;
      for (const t of this.pending) this.sendNow(t, true);
      this.pending = [];
      if (this.flushRequested) this.sendNow("", false);
    });
    this.ws.on("message", (data) => {
      if (this.cancelled) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "chunk" && msg.data) this.audioCb?.(Buffer.from(msg.data, "base64"));
        else if (msg.type === "done") this.endCb?.();
        else if (msg.type === "error") this.errorCb?.(new Error(`Cartesia: ${msg.error}`));
      } catch {
        this.errorCb?.(new Error("Cartesia: unparseable frame"));
      }
    });
    this.ws.on("error", (err) => {
      if (!this.cancelled) this.errorCb?.(err as Error);
    });
  }

  private sendNow(transcript: string, cont: boolean) {
    this.ws.send(
      JSON.stringify({
        // sonic-2 was sunsetted by Cartesia (Aug 2026) - sonic-3 is current
        model_id: "sonic-3",
        transcript,
        voice: { mode: "id", id: this.voiceId },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 16000 },
        context_id: this.contextId,
        continue: cont,
      }),
    );
  }

  sendText(chunk: string): void {
    if (this.cancelled) return;
    this.charsSent += chunk.length;
    if (this.open) this.sendNow(chunk, true);
    else this.pending.push(chunk);
  }
  flush(): void {
    if (this.cancelled) return;
    if (this.open) this.sendNow("", false);
    else this.flushRequested = true;
  }
  cancel(): void {
    this.cancelled = true;
    this.pending = [];
    try {
      this.ws.close(1000);
    } catch {
      /* already closed */
    }
  }
  close(): void {
    this.cancel();
  }
  onAudio(cb: (pcm: Buffer) => void): void {
    this.audioCb = cb;
  }
  onEnd(cb: () => void): void {
    this.endCb = cb;
  }
  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }
}

export const cartesiaTts: TtsProvider = {
  name: "cartesia",
  isConfigured: () => !!process.env.CARTESIA_API_KEY,
  openStream({ voiceId }) {
    const key = process.env.CARTESIA_API_KEY;
    if (!key) throw new Error("CARTESIA_API_KEY is not set");
    return new CartesiaStream(voiceId, key);
  },
};
