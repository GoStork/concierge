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

  constructor(sampleRate: number, language: string, apiKey: string) {
    const params = new URLSearchParams({
      encoding: "linear16",
      sample_rate: String(sampleRate),
      channels: "1",
      language,
      punctuate: "true",
      interim_results: "true",
      endpointing: "400",
      model: "nova-2",
    });
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
        const alt = msg.channel?.alternatives?.[0];
        const text = alt?.transcript?.trim();
        if (!text) return;
        if (msg.is_final) this.finalCb?.(text);
        else this.partialCb?.(text);
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
