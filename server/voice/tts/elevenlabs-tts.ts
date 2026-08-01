import WebSocket from "ws";
import type { TtsProvider, TtsStream } from "../providers";

// ElevenLabs Flash v2.5 over the stream-input WebSocket: we push sentence
// chunks as Eva's tokens arrive and receive base64 PCM (16kHz mono) back.
// Docs: wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input

const MODEL_ID = "eleven_flash_v2_5";

class ElevenLabsStream implements TtsStream {
  private ws: WebSocket;
  private open = false;
  private cancelled = false;
  private pendingText: string[] = [];
  private flushRequested = false;
  private audioCb: ((pcm: Buffer) => void) | null = null;
  private endCb: (() => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  // Chars actually sent to ElevenLabs - billed usage, reported for cost audit.
  charsSent = 0;

  constructor(voiceId: string, apiKey: string) {
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input` +
      `?model_id=${MODEL_ID}&output_format=pcm_16000&auto_mode=true`;
    this.ws = new WebSocket(url, { headers: { "xi-api-key": apiKey } });

    this.ws.on("open", () => {
      if (this.cancelled) return;
      this.open = true;
      // Initial handshake frame: a single space primes the stream.
      this.ws.send(
        JSON.stringify({
          text: " ",
          voice_settings: { stability: 0.5, similarity_boost: 0.8 },
        }),
      );
      for (const chunk of this.pendingText) this.sendNow(chunk);
      this.pendingText = [];
      if (this.flushRequested) this.sendEndFrame();
    });

    this.ws.on("message", (data) => {
      if (this.cancelled) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.audio) this.audioCb?.(Buffer.from(msg.audio, "base64"));
        if (msg.isFinal) this.endCb?.();
        if (msg.error) {
          this.errorCb?.(new Error(`ElevenLabs: ${msg.error} ${msg.message || ""}`));
        }
      } catch {
        // Non-JSON frames are unexpected; surface loudly rather than swallow.
        this.errorCb?.(new Error("ElevenLabs: unparseable frame"));
      }
    });

    this.ws.on("error", (err) => {
      if (!this.cancelled) this.errorCb?.(err as Error);
    });
    this.ws.on("close", (code, reason) => {
      this.open = false;
      // 1000 = normal. Anything else while active is an error worth logging.
      if (!this.cancelled && code !== 1000) {
        this.errorCb?.(
          new Error(`ElevenLabs WS closed ${code} ${reason?.toString() || ""}`),
        );
      }
    });
  }

  private sendNow(chunk: string) {
    this.charsSent += chunk.length;
    this.ws.send(JSON.stringify({ text: chunk, try_trigger_generation: true }));
  }

  private sendEndFrame() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ text: "" }));
    }
  }

  sendText(chunk: string): void {
    if (this.cancelled) return;
    if (this.open) this.sendNow(chunk);
    else this.pendingText.push(chunk);
  }

  flush(): void {
    if (this.cancelled) return;
    if (this.open) this.sendEndFrame();
    else this.flushRequested = true;
  }

  cancel(): void {
    this.cancelled = true;
    this.pendingText = [];
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

export const elevenLabsTts: TtsProvider = {
  name: "elevenlabs",
  isConfigured: () => !!process.env.ELEVENLABS_API_KEY,
  openStream({ voiceId }) {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
    return new ElevenLabsStream(voiceId, key);
  },
};
