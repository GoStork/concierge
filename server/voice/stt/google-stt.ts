import type { SttProvider, SttStream } from "../providers";

// Google Cloud streaming STT over the existing @google-cloud/speech dependency
// (same credentials env as video.service.ts: GCS_SERVICE_ACCOUNT_KEY). 16kHz
// LINEAR16 mono, interim results on, automatic punctuation for readable
// transcripts in the chat record.
//
// Google caps a single streamingRecognize stream at ~5 minutes; the stream is
// transparently restarted on end/error while the voice session is alive.

class GoogleSttStream implements SttStream {
  private client: any = null;
  private stream: any = null;
  private closed = false;
  private partialCb: ((text: string) => void) | null = null;
  private finalCb: ((text: string) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private lastAudioAt = Date.now();
  private keepAlive: NodeJS.Timeout | null = null;

  constructor(private readonly sampleRate: number, private readonly languageCode: string) {
    void this.start();
    // The client VAD gates mic frames, so long silences are normal - but
    // Google kills streams that go quiet ("Audio Timeout Error"), and the
    // restart can clip the parent's next words. A 100ms silence frame every
    // 4 quiet seconds keeps the stream alive at ~2.5% duty cost.
    this.keepAlive = setInterval(() => {
      if (this.closed || !this.stream) return;
      if (Date.now() - this.lastAudioAt > 4000) {
        try {
          this.stream.write(Buffer.alloc(Math.floor(this.sampleRate * 0.1) * 2));
          this.lastAudioAt = Date.now();
        } catch {
          /* restart path handles it */
        }
      }
    }, 2000);
  }

  private async start(): Promise<void> {
    try {
      if (!this.client) {
        const keyJson = process.env.GCS_SERVICE_ACCOUNT_KEY;
        if (!keyJson) throw new Error("GCS_SERVICE_ACCOUNT_KEY not configured");
        const { SpeechClient } = await import("@google-cloud/speech");
        this.client = new SpeechClient({ credentials: JSON.parse(keyJson) });
      }
      if (this.closed) return;
      this.stream = this.client
        .streamingRecognize({
          config: {
            encoding: "LINEAR16",
            sampleRateHertz: this.sampleRate,
            languageCode: this.languageCode,
            enableAutomaticPunctuation: true,
            model: "latest_short",
          },
          interimResults: true,
        })
        .on("data", (data: any) => {
          const result = data.results?.[0];
          const text = result?.alternatives?.[0]?.transcript;
          if (!text) return;
          if (result.isFinal) this.finalCb?.(text.trim());
          else this.partialCb?.(text.trim());
        })
        .on("error", (err: Error) => {
          // Stream-duration limits and transient network errors: restart while
          // the session is alive. Anything else surfaces via onError too so
          // the gateway can log it loudly.
          this.errorCb?.(err);
          this.restart();
        })
        .on("end", () => this.restart());
    } catch (err) {
      this.errorCb?.(err as Error);
    }
  }

  private restart(): void {
    if (this.closed) return;
    this.stream = null;
    setTimeout(() => void this.start(), 100);
  }

  sendAudio(pcm: Buffer): void {
    if (this.closed || !this.stream) return;
    try {
      this.lastAudioAt = Date.now();
      this.stream.write(pcm);
    } catch (err) {
      this.errorCb?.(err as Error);
    }
  }

  close(): void {
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    try {
      this.stream?.end();
    } catch {
      /* already ended */
    }
    this.stream = null;
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

export const googleStt: SttProvider = {
  name: "google",
  isConfigured: () => !!process.env.GCS_SERVICE_ACCOUNT_KEY,
  openStream({ sampleRate, languageCode }) {
    return new GoogleSttStream(sampleRate, languageCode || "en-US");
  },
};
