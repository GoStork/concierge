// Voice provider interfaces. The ACTIVE provider is an admin setting on
// SiteSettings (voiceTtsProvider / voiceSttProvider), read per session start -
// env vars hold API keys only. Implementations live in ./tts/* and ./stt/*.

export interface TtsStream {
  // Push a chunk of text (typically one sentence) to be synthesized.
  sendText(chunk: string): void;
  // Signal that no more text is coming for this reply; the stream should
  // finish synthesizing whatever is buffered and then emit onEnd.
  flush(): void;
  // Hard-stop synthesis (barge-in). Pending audio must be dropped.
  cancel(): void;
  close(): void;
  onAudio(cb: (pcm: Buffer) => void): void;
  onEnd(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
}

export interface TtsProvider {
  readonly name: string;
  // True when the required API key env var is configured. The admin Voice
  // settings UI disables providers where this is false - no silent fallback.
  isConfigured(): boolean;
  openStream(opts: { voiceId: string }): TtsStream;
}

export interface SttStream {
  sendAudio(pcm: Buffer): void;
  close(): void;
  onPartial(cb: (text: string) => void): void;
  onFinal(cb: (text: string) => void): void;
  onError(cb: (err: Error) => void): void;
}

export interface SttProvider {
  readonly name: string;
  isConfigured(): boolean;
  openStream(opts: { sampleRate: number; languageCode?: string }): SttStream;
}

// Phase 3: realtime video avatar vendors (HeyGen prototype, Simli at scale).
export interface AvatarProvider {
  readonly name: string;
  isConfigured(): boolean;
  startSession(opts: { faceId: string }): Promise<{ sessionToken: string }>;
  sendAudio(pcm: Buffer): void;
  end(): Promise<void>;
}

// PCM format used across the pipeline: 16-bit signed little-endian mono.
export const VOICE_SAMPLE_RATE = 16000;
