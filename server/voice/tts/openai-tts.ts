import type { TtsProvider, TtsStream } from "../providers";

// OpenAI gpt-4o-mini-tts (budget option, ~3x cheaper than ElevenLabs). The
// speech endpoint takes whole text per request (no input streaming), so each
// sentence chunk is synthesized as its own request, serialized to preserve
// order. PCM output is 24kHz mono; resampled to the pipeline's 16kHz.
// voiceId = an OpenAI voice name (alloy, shimmer, coral, sage, ...).

function resample24to16(pcm24: Buffer): Buffer {
  const inSamples = Math.floor(pcm24.length / 2);
  const outSamples = Math.floor((inSamples * 2) / 3);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const pos = i * 1.5;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const s0 = pcm24.readInt16LE(Math.min(i0, inSamples - 1) * 2);
    const s1 = pcm24.readInt16LE(Math.min(i0 + 1, inSamples - 1) * 2);
    out.writeInt16LE(Math.round(s0 * (1 - frac) + s1 * frac), i * 2);
  }
  return out;
}

class OpenAiTtsStream implements TtsStream {
  private queue: string[] = [];
  private running = false;
  private cancelled = false;
  private flushed = false;
  private audioCb: ((pcm: Buffer) => void) | null = null;
  private endCb: (() => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  charsSent = 0;

  constructor(private readonly voiceId: string, private readonly apiKey: string) {}

  sendText(chunk: string): void {
    if (this.cancelled) return;
    this.charsSent += chunk.length;
    this.queue.push(chunk);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running || this.cancelled) return;
    this.running = true;
    try {
      while (this.queue.length && !this.cancelled) {
        const text = this.queue.shift()!;
        const resp = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini-tts",
            voice: this.voiceId || "shimmer",
            input: text,
            response_format: "pcm",
          }),
        });
        if (!resp.ok) throw new Error(`OpenAI TTS ${resp.status}: ${await resp.text()}`);
        // Stream the body through as it arrives, carrying remainder bytes so
        // 16-bit samples never split across resample calls.
        let carry: Buffer = Buffer.alloc(0);
        for await (const raw of resp.body as any) {
          if (this.cancelled) break;
          const buf = Buffer.concat([carry, Buffer.isBuffer(raw) ? raw : Buffer.from(raw)]);
          const usable = buf.length - (buf.length % 6); // 3 in-samples -> 2 out
          carry = buf.subarray(usable);
          if (usable) this.audioCb?.(resample24to16(buf.subarray(0, usable)));
        }
      }
      if (this.flushed && !this.queue.length && !this.cancelled) this.endCb?.();
    } catch (err) {
      if (!this.cancelled) this.errorCb?.(err as Error);
    } finally {
      this.running = false;
      if (this.queue.length && !this.cancelled) void this.drain();
    }
  }

  flush(): void {
    this.flushed = true;
    if (!this.running && !this.queue.length && !this.cancelled) this.endCb?.();
  }
  cancel(): void {
    this.cancelled = true;
    this.queue = [];
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

export const openAiTts: TtsProvider = {
  name: "openai",
  isConfigured: () => !!process.env.OPENAI_API_KEY,
  openStream({ voiceId }) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set");
    return new OpenAiTtsStream(voiceId, key);
  },
};
