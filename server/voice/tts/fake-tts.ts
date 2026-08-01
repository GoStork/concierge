import type { TtsProvider, TtsStream } from "../providers";
import { VOICE_SAMPLE_RATE } from "../providers";

// VOICE_FAKE_TTS=1 loopback provider: synthesizes a quiet sine tone whose
// duration is proportional to the text length (~55ms per word). Lets the whole
// gateway -> /chat -> chunker -> audio -> client playback path be exercised
// end-to-end with zero ElevenLabs spend. This is a TEST harness, selected only
// by the explicit env flag - never a silent production fallback.

class FakeTtsStream implements TtsStream {
  private audioCb: ((pcm: Buffer) => void) | null = null;
  private endCb: (() => void) | null = null;
  private cancelled = false;
  private timer: NodeJS.Timeout | null = null;
  private queue: string[] = [];
  private draining = false;
  private flushed = false;
  charsSent = 0;

  sendText(chunk: string): void {
    if (this.cancelled) return;
    this.charsSent += chunk.length;
    this.queue.push(chunk);
    this.drain();
  }

  private drain(): void {
    if (this.draining || this.cancelled) return;
    const chunk = this.queue.shift();
    if (!chunk) {
      if (this.flushed) this.endCb?.();
      return;
    }
    this.draining = true;
    const words = Math.max(1, chunk.trim().split(/\s+/).length);
    const seconds = (words * 55) / 1000;
    const samples = Math.floor(seconds * VOICE_SAMPLE_RATE);
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 330 * i) / VOICE_SAMPLE_RATE) * 2500);
      pcm.writeInt16LE(v, i * 2);
    }
    // Emit in ~100ms frames to mimic streaming.
    const frame = VOICE_SAMPLE_RATE / 10 * 2;
    let off = 0;
    this.timer = setInterval(() => {
      if (this.cancelled) return;
      if (off >= pcm.length) {
        clearInterval(this.timer!);
        this.timer = null;
        this.draining = false;
        this.drain();
        return;
      }
      this.audioCb?.(pcm.subarray(off, Math.min(off + frame, pcm.length)));
      off += frame;
    }, 100);
  }

  flush(): void {
    this.flushed = true;
    if (!this.draining && this.queue.length === 0) this.endCb?.();
  }

  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
  onError(_cb: (err: Error) => void): void {
    /* fake stream never errors */
  }
}

export const fakeTts: TtsProvider = {
  name: "fake",
  isConfigured: () => process.env.VOICE_FAKE_TTS === "1",
  openStream() {
    return new FakeTtsStream();
  },
};
