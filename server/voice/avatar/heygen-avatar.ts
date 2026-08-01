import WebSocket from "ws";

// HeyGen LiveAvatar (LITE mode) - realtime lip-synced talking head driven by
// OUR TTS audio. The gateway forwards Eva's 16kHz PCM here instead of down the
// browser WS; LiveAvatar lip-syncs it and streams synced audio+video into a
// LiveKit room the browser joins with the client token.
//
// Protocol (docs.liveavatar.com, LITE mode):
//   POST /v1/sessions/token  (X-API-KEY)            -> { session_token }
//   POST /v1/sessions/start  (Bearer session_token) -> { livekit_url, livekit_client_token, ws_url }
//   WS ws_url: wait for session.state_updated "connected", then
//     {type:"agent.speak", audio:<base64 PCM16 24kHz>} (~1s chunks, <1MB)
//     {type:"agent.interrupt"} on barge-in
//     {type:"session.keep_alive"} periodically

const API_BASE = "https://api.liveavatar.com";

function apiKey(): string | undefined {
  return process.env.LIVEAVATAR_API_KEY || process.env.HEYGEN_API_KEY;
}

// Pipeline PCM is 16kHz; LiveAvatar wants 24kHz. Linear 2:3 upsample.
function upsample16to24(pcm16k: Buffer): Buffer {
  const inSamples = Math.floor(pcm16k.length / 2);
  if (inSamples < 2) return Buffer.alloc(0);
  const outSamples = Math.floor(((inSamples - 1) * 3) / 2) + 1;
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const pos = (i * 2) / 3;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const s0 = pcm16k.readInt16LE(Math.min(i0, inSamples - 1) * 2);
    const s1 = pcm16k.readInt16LE(Math.min(i0 + 1, inSamples - 1) * 2);
    out.writeInt16LE(Math.round(s0 * (1 - frac) + s1 * frac), i * 2);
  }
  return out;
}

export interface AvatarSessionInfo {
  livekitUrl: string;
  livekitClientToken: string;
}

export class HeyGenAvatarSession {
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  // ~400ms of 24kHz PCM per agent.speak frame - smaller frames reach the
  // avatar's lip-sync sooner (docs allow up to 1MB per packet; ~1s was the
  // recommendation, but latency matters more here).
  private buf: Buffer[] = [];
  private bufBytes = 0;
  private static readonly FRAME_BYTES = Math.floor(24000 * 0.4) * 2;
  // The very first frame after an interrupt/flush ships at ~120ms so the
  // avatar's lip-sync starts as early as possible; later frames use the
  // normal size.
  private static readonly FIRST_FRAME_BYTES = Math.floor(24000 * 0.12) * 2;
  private sentSinceReset = false;
  // Epoch ms when the audio queued into the avatar finishes PLAYING. The
  // avatar renders in realtime, so this trails TTS generation by seconds on a
  // long reply - the gateway must not flip back to "listening" (and the
  // client must still be able to barge) until playback actually ends.
  private playheadAt = 0;
  private keepAlive: NodeJS.Timeout | null = null;
  private sessionToken = "";

  async start(avatarId: string): Promise<AvatarSessionInfo> {
    const key = apiKey();
    if (!key) throw new Error("LIVEAVATAR_API_KEY / HEYGEN_API_KEY is not set");

    const tokenResp = await fetch(`${API_BASE}/v1/sessions/token`, {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "LITE", avatar_id: avatarId }),
    });
    if (!tokenResp.ok) {
      throw new Error(`LiveAvatar token ${tokenResp.status}: ${await tokenResp.text()}`);
    }
    const tokenBody: any = await tokenResp.json();
    this.sessionToken = tokenBody?.data?.session_token;
    if (!this.sessionToken) throw new Error("LiveAvatar token response missing session_token");

    const startResp = await fetch(`${API_BASE}/v1/sessions/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!startResp.ok) {
      throw new Error(`LiveAvatar start ${startResp.status}: ${await startResp.text()}`);
    }
    const startBody: any = await startResp.json();
    const d = startBody?.data || {};
    if (!d.livekit_url || !d.livekit_client_token || !d.ws_url) {
      throw new Error("LiveAvatar start response missing livekit/ws fields");
    }

    await this.connectWs(d.ws_url);
    this.keepAlive = setInterval(() => {
      this.sendJson({ type: "session.keep_alive", event_id: `ka-${Date.now()}` });
    }, 15_000);

    return { livekitUrl: d.livekit_url, livekitClientToken: d.livekit_client_token };
  }

  private connectWs(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      const timeout = setTimeout(() => reject(new Error("LiveAvatar WS connect timeout")), 10_000);
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (
            (msg.type === "session.state_updated" && msg.state === "connected") ||
            msg.state === "connected"
          ) {
            if (!this.connected) {
              this.connected = true;
              clearTimeout(timeout);
              resolve();
            }
          }
        } catch {
          /* non-JSON frame */
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timeout);
        if (!this.connected) reject(err as Error);
      });
      ws.on("close", () => {
        this.connected = false;
      });
    });
  }

  private sendJson(obj: object) {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // 16kHz PCM in from the TTS stream; buffered to ~1s 24kHz frames.
  sendAudio(pcm16k: Buffer): void {
    if (this.closed) return;
    const up = upsample16to24(pcm16k);
    this.buf.push(up);
    this.bufBytes += up.length;
    const target = this.sentSinceReset
      ? HeyGenAvatarSession.FRAME_BYTES
      : HeyGenAvatarSession.FIRST_FRAME_BYTES;
    while (this.bufBytes >= target) this.flushFrame(target);
  }

  private flushFrame(frameBytes = HeyGenAvatarSession.FRAME_BYTES) {
    const all = Buffer.concat(this.buf);
    const frame = all.subarray(0, frameBytes);
    const rest = all.subarray(frameBytes);
    this.buf = rest.length ? [Buffer.from(rest)] : [];
    this.bufBytes = rest.length;
    this.speak(frame);
  }

  // Push out whatever is buffered (end of a reply).
  flushSpeech(): void {
    if (this.bufBytes > 0) {
      const all = Buffer.concat(this.buf);
      this.buf = [];
      this.bufBytes = 0;
      this.speak(all);
    }
    // Next reply starts a fresh utterance - give it the fast first frame too.
    this.sentSinceReset = false;
  }

  private speak(frame: Buffer) {
    this.sentSinceReset = true;
    const durMs = (frame.length / 2 / 24000) * 1000;
    const now = Date.now();
    this.playheadAt = Math.max(now, this.playheadAt) + durMs;
    this.sendJson({ type: "agent.speak", audio: frame.toString("base64") });
  }

  // How much longer the avatar will keep TALKING the audio already queued
  // into it. TTS generation finishing means nothing to the viewer - this is
  // what "Eva is still speaking" really means in avatar mode.
  remainingSpeechMs(): number {
    return Math.max(0, this.playheadAt - Date.now());
  }

  interrupt(): void {
    this.buf = [];
    this.bufBytes = 0;
    this.sentSinceReset = false;
    this.playheadAt = 0;
    this.sendJson({ type: "agent.interrupt" });
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    try {
      this.ws?.close(1000);
    } catch {
      /* already closed */
    }
    // Best-effort server-side stop so HeyGen minutes stop accruing even if the
    // socket close is missed.
    try {
      await fetch(`${API_BASE}/v1/sessions/stop`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.sessionToken}` },
      });
    } catch {
      /* session will expire on its own */
    }
  }
}

export function heygenAvatarConfigured(): boolean {
  return !!apiKey();
}
