// Voice-mode audio engine: mic capture (AudioWorklet, downsampled to 16kHz
// PCM16 mono) and streamed playback (ring-buffer worklet fed with 16kHz PCM16
// from the server, resampled to the hardware rate). One shared AudioContext,
// resumed by the user gesture that opens voice mode - browsers will not play
// audio without it. echoCancellation is load-bearing: without it Eva's own
// voice trips the barge-in detector.

export const VOICE_SAMPLE_RATE = 16000;

// Both worklet processors are inlined and loaded via a Blob URL so no extra
// Vite asset wiring is needed and they always ship with the bundle.
const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${VOICE_SAMPLE_RATE};
    this.acc = [];
    this.accLen = 0;
    this.readPos = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    this.acc.push(ch.slice(0));
    this.accLen += ch.length;
    // Emit ~40ms frames (640 samples at 16k = 640*ratio source samples)
    const needed = Math.ceil(640 * this.ratio) + 2;
    if (this.accLen < needed) return true;
    const flat = new Float32Array(this.accLen);
    let o = 0;
    for (const b of this.acc) { flat.set(b, o); o += b.length; }
    const outLen = Math.floor((flat.length - 1) / this.ratio);
    const out = new Int16Array(outLen);
    let rms = 0;
    for (let i = 0; i < outLen; i++) {
      const pos = i * this.ratio;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s = flat[i0] * (1 - frac) + flat[i0 + 1] * frac;
      rms += s * s;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    }
    rms = Math.sqrt(rms / Math.max(1, outLen));
    this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
    // Keep the tail sample for interpolation continuity
    const consumed = Math.floor(outLen * this.ratio);
    const tail = flat.slice(consumed);
    this.acc = [tail];
    this.accLen = tail.length;
    return true;
  }
}
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = ${VOICE_SAMPLE_RATE} / sampleRate;
    this.buf = new Float32Array(0);
    this.pos = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === "push") {
        const pcm = new Int16Array(e.data.pcm);
        const f = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
        const intPos = Math.floor(this.pos);
        const rest = this.buf.subarray(intPos);
        const merged = new Float32Array(rest.length + f.length);
        merged.set(rest, 0);
        merged.set(f, rest.length);
        this.buf = merged;
        this.pos = this.pos - intPos;
      } else if (e.data.type === "flush") {
        this.buf = new Float32Array(0);
        this.pos = 0;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    let speaking = false;
    for (let i = 0; i < out.length; i++) {
      const i0 = Math.floor(this.pos);
      if (i0 + 1 < this.buf.length) {
        const frac = this.pos - i0;
        out[i] = this.buf[i0] * (1 - frac) + this.buf[i0 + 1] * frac;
        this.pos += this.ratio;
        speaking = true;
      } else {
        out[i] = 0;
      }
    }
    this.port.postMessage({ speaking });
    return true;
  }
}
registerProcessor("voice-capture", CaptureProcessor);
registerProcessor("voice-playback", PlaybackProcessor);
`;

export interface VoiceAudioEngine {
  // Fires for every mic frame with 16kHz PCM16 bytes and the frame's RMS level.
  onMicFrame: (cb: (pcm: ArrayBuffer, rms: number) => void) => void;
  // Fires when the playback buffer drains (Eva finished being audible).
  onPlaybackState: (cb: (speaking: boolean) => void) => void;
  playPcm(pcm: ArrayBuffer): void;
  flushPlayback(): void;
  setMicMuted(muted: boolean): void;
  destroy(): void;
}

// Must be called from a user-gesture handler.
export async function createVoiceAudioEngine(): Promise<VoiceAudioEngine> {
  const ctx = new AudioContext();
  await ctx.resume();

  const workletUrl = URL.createObjectURL(
    new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
  );
  try {
    await ctx.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }

  const MIC_CONSTRAINTS: MediaStreamConstraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  };
  let stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);

  const capture = new AudioWorkletNode(ctx, "voice-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  let source = ctx.createMediaStreamSource(stream);
  source.connect(capture);

  // --- iOS Safari mic resilience -------------------------------------------
  // When WebRTC playback starts (the avatar's LiveKit audio) or the audio
  // route changes (speaker/earpiece/AirPods), iOS is known to suspend the
  // AudioContext or end/mute the capture track - which used to leave the
  // session silently deaf ("she just ignores me"). Resume the context and
  // reacquire the mic whenever that happens.
  let destroyed = false;
  const resumeCtx = () => {
    if (!destroyed && ctx.state !== "running") void ctx.resume().catch(() => {});
  };
  ctx.onstatechange = resumeCtx;
  const onVisible = () => {
    if (document.visibilityState === "visible") resumeCtx();
  };
  document.addEventListener("visibilitychange", onVisible);

  const reacquireMic = async () => {
    if (destroyed) return;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      if (destroyed) {
        fresh.getTracks().forEach((t) => t.stop());
        return;
      }
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      stream.getTracks().forEach((t) => t.stop());
      stream = fresh;
      source = ctx.createMediaStreamSource(stream);
      source.connect(capture);
      watchTrack();
      resumeCtx();
      console.warn("[voice] mic track reacquired after the OS dropped it");
    } catch (err) {
      console.error("[voice] mic reacquire failed:", err);
    }
  };
  const watchTrack = () => {
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    track.onended = () => void reacquireMic();
    track.onmute = () => {
      // iOS mutes the track during route changes; give it a moment to
      // unmute on its own, then force a fresh capture.
      setTimeout(() => {
        const t = stream.getAudioTracks()[0];
        if (!destroyed && t && t.muted) void reacquireMic();
      }, 1500);
    };
  };
  watchTrack();
  // --------------------------------------------------------------------------

  const playback = new AudioWorkletNode(ctx, "voice-playback", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  playback.connect(ctx.destination);

  let micCb: ((pcm: ArrayBuffer, rms: number) => void) | null = null;
  let playCb: ((speaking: boolean) => void) | null = null;
  let muted = false;
  let lastSpeaking = false;

  capture.port.onmessage = (e) => {
    if (muted) return;
    micCb?.(e.data.pcm, e.data.rms);
  };
  playback.port.onmessage = (e) => {
    if (e.data.speaking !== lastSpeaking) {
      lastSpeaking = e.data.speaking;
      playCb?.(e.data.speaking);
    }
  };

  return {
    onMicFrame: (cb) => {
      micCb = cb;
    },
    onPlaybackState: (cb) => {
      playCb = cb;
    },
    playPcm: (pcm) => {
      playback.port.postMessage({ type: "push", pcm }, [pcm]);
    },
    flushPlayback: () => {
      playback.port.postMessage({ type: "flush" });
    },
    setMicMuted: (m) => {
      muted = m;
    },
    destroy: () => {
      destroyed = true;
      micCb = null;
      playCb = null;
      ctx.onstatechange = null;
      document.removeEventListener("visibilitychange", onVisible);
      try {
        source.disconnect();
        capture.disconnect();
        playback.disconnect();
      } catch {
        /* already disconnected */
      }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
