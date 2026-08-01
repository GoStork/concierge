import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import passport from "passport";
import { prisma } from "../db";
import { StreamingTagStripper } from "./tag-stripper";
import { SentenceChunker } from "./sentence-chunker";
import type { SttProvider, SttStream, TtsProvider, TtsStream } from "./providers";
import { VOICE_SAMPLE_RATE } from "./providers";
import { elevenLabsTts } from "./tts/elevenlabs-tts";
import { openAiTts } from "./tts/openai-tts";
import { cartesiaTts } from "./tts/cartesia-tts";
import { fakeTts } from "./tts/fake-tts";
import { googleStt } from "./stt/google-stt";
import { deepgramStt } from "./stt/deepgram-stt";
import { HeyGenAvatarSession, heygenAvatarConfigured } from "./avatar/heygen-avatar";

// Live voice-mode gateway: WS endpoint /api/voice/ws.
//
// Browser mic PCM -> streaming STT -> on final transcript, an INTERNAL fetch to
// the existing POST /api/ai-concierge/chat (cookie forwarded from the WS
// upgrade, so auth + persistence + cards behave exactly like text chat) ->
// the SSE stream is parsed HERE, server-side -> tag-stripped, sentence-chunked
// -> TTS -> PCM frames back down the WS. The client never talks to a voice
// vendor directly and no API key reaches the browser.
//
// SSE frame contract mirrors setupSSE in server/ai-router.ts (:74-95):
//   {type:"token",delta} {type:"reset"} {type:"done",...} {type:"error",message}
//   {type:"retry_needed"}
// If that format changes, THIS parser must change with it.

const TTS_PROVIDERS: Record<string, TtsProvider> = {
  elevenlabs: elevenLabsTts,
  openai: openAiTts,
  cartesia: cartesiaTts,
};
const STT_PROVIDERS: Record<string, SttProvider> = {
  google: googleStt,
  deepgram: deepgramStt,
};

export function resolveTtsProvider(name: string): TtsProvider | null {
  if (process.env.VOICE_FAKE_TTS === "1") return fakeTts;
  return TTS_PROVIDERS[name] || null;
}
export function resolveSttProvider(name: string): SttProvider | null {
  return STT_PROVIDERS[name] || null;
}
export function voiceProviderStatus() {
  return {
    tts: Object.values(TTS_PROVIDERS).map((p) => ({ name: p.name, configured: p.isConfigured() })),
    stt: Object.values(STT_PROVIDERS).map((p) => ({ name: p.name, configured: p.isConfigured() })),
  };
}

// Voice ids are provider-specific (ElevenLabs: opaque ids, OpenAI: named
// voices, Cartesia: UUIDs). The persona is the single source of truth -
// admins pick voices per persona in the AI Concierge tab. The built-ins
// below are EMERGENCY fallbacks only (logged loudly when used), so a
// parent's session never dies because a persona is missing a voice for the
// provider the admin just switched to.
export const BUILTIN_DEFAULT_VOICES: Record<string, string> = {
  elevenlabs: "EXAVITQu4vr4xnSDxMaL", // Sarah (premade - usable on every plan)
  openai: "shimmer",
  cartesia: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4", // Skylar - Friendly Guide
};
export function resolveVoiceForProvider(
  provider: string,
  personaVoiceIds: any,
  personaLegacyVoiceId: string | null | undefined,
): string {
  const personaPick =
    personaVoiceIds?.[provider] ||
    (provider === "elevenlabs" ? personaLegacyVoiceId : null);
  if (personaPick) return personaPick;
  const builtin = BUILTIN_DEFAULT_VOICES[provider] || "";
  if (builtin) {
    log(`no persona voice for provider "${provider}" - using built-in fallback voice`);
  }
  return builtin;
}

function log(msg: string) {
  console.log(`[voice] ${msg}`);
}

// Spoken when a reply's stripped text is empty because the whole answer was a
// card. Keyed on which payload fields the done frame carried.
function cardFallbackLine(done: any): string | null {
  if (done.matchCards?.length || done.doctorCards?.length) {
    return "I've found some matches for you - they're on your screen now.";
  }
  if (done.consultationCard || done.meetingCards?.length) {
    return "I've put the booking details on your screen.";
  }
  if (done.comparisonCards?.length) {
    return "I've put the comparison on your screen.";
  }
  if (done.quickReplies?.length) return null; // chips speak for themselves
  return null;
}

interface VoiceSettings {
  voiceModeEnabled: boolean;
  voiceTtsProvider: string;
  voiceSttProvider: string;
  voiceDefaultVoiceIds: any;
  voiceDefaultVoiceId: string | null;
  voiceSessionCapMinutes: number;
  voiceDailyCapMinutes: number;
  voiceAvatarEnabled: boolean;
  voiceAvatarProvider: string;
  voiceDefaultAvatarId: string | null;
}

type SessionState = "listening" | "thinking" | "speaking";

class VoiceSession {
  private state: SessionState = "listening";
  private stt: SttStream | null = null;
  private tts: TtsStream | null = null;
  private stripper = new StreamingTagStripper();
  private chunker: SentenceChunker | null = null;
  private chatSessionId: string | null = null;
  private matchmakerId: string | null = null;
  private voiceId: string;
  private closed = false;
  // Set on barge-in: the in-flight reply keeps streaming (persistence must
  // finish) but no further chunks reach TTS.
  private speakSuppressed = false;
  private turnCounter = 0;

  // Cost + latency accounting
  private startedAt = Date.now();
  private sttBytes = 0;
  private ttsChars = 0;
  private logId: string | null = null;

  // Phase 3: realtime video avatar. When active, Eva's TTS PCM routes to the
  // avatar session (lip-synced audio+video reach the browser via LiveKit)
  // instead of down our WS.
  private avatar: HeyGenAvatarSession | null = null;
  private avatarStartedAt = 0;
  private avatarSeconds = 0;

  private silenceTimer: NodeJS.Timeout | null = null;
  private capTimer: NodeJS.Timeout | null = null;
  private warned = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly userId: string,
    private readonly cookieHeader: string,
    private readonly settings: VoiceSettings,
    private readonly ttsProvider: TtsProvider,
    private readonly sttProvider: SttProvider,
    defaultVoiceId: string,
  ) {
    this.voiceId = defaultVoiceId;
    ws.on("message", (data, isBinary) => this.onMessage(data as Buffer, isBinary));
    ws.on("close", () => void this.destroy("socket_closed"));
    ws.on("error", () => void this.destroy("socket_error"));

    this.openStt();
    this.armSilenceTimer();
    const capMs = Math.max(1, settings.voiceSessionCapMinutes) * 60_000;
    this.capTimer = setTimeout(() => {
      this.speakSystemLine("We've been talking a while - let's wrap up. You can keep going in text.");
      setTimeout(() => void this.destroy("session_cap"), 15_000);
    }, capMs);
    void this.openLog();
  }

  private async openLog() {
    try {
      const row = await prisma.voiceSessionLog.create({
        data: { userId: this.userId, sessionId: this.chatSessionId || "pending" },
      });
      this.logId = row.id;
    } catch (err: any) {
      log(`VoiceSessionLog create failed: ${err?.message}`);
    }
  }

  private send(obj: object) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
  private sendAudio(pcm: Buffer) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm, { binary: true });
  }
  private setState(state: SessionState) {
    this.state = state;
    this.send({ type: "state", state });
  }

  private openStt() {
    this.stt = this.sttProvider.openStream({ sampleRate: VOICE_SAMPLE_RATE });
    this.stt.onPartial((text) => {
      this.armSilenceTimer();
      this.send({ type: "partial_transcript", text });
    });
    this.stt.onFinal((text) => {
      this.armSilenceTimer();
      if (!text || text.length < 2) return;
      this.send({ type: "final_transcript", text });
      // Ignore new utterances while a turn is already being processed - the
      // client gates the mic during THINKING, this is the server-side guard.
      if (this.state === "thinking") return;
      void this.runTurn(text);
    });
    this.stt.onError((err) => log(`STT error: ${err.message}`));
  }

  private armSilenceTimer() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.warned = false;
    this.silenceTimer = setTimeout(() => {
      this.warned = true;
      this.speakSystemLine("Are you still there?");
      this.silenceTimer = setTimeout(() => void this.destroy("silence_timeout"), 45_000);
    }, 45_000);
  }

  private onMessage(data: Buffer, isBinary: boolean) {
    if (this.closed) return;
    if (isBinary) {
      this.sttBytes += data.length;
      this.stt?.sendAudio(data);
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello":
        this.chatSessionId = msg.sessionId || null;
        this.matchmakerId = msg.matchmakerId || null;
        void this.applyPersonaVoice().then(async () => {
          await this.maybeStartAvatar();
          this.send({ type: "ready" });
          // Voice-first greeting: the client passes the init-session greeting
          // text; Eva speaks it before the parent says anything.
          if (msg.greetingText) this.speakSystemLine(String(msg.greetingText));
        });
        break;
      case "barge":
        this.handleBarge();
        break;
      case "text":
        // Quick-reply chip tapped inside the voice panel - treat as a turn.
        if (typeof msg.text === "string" && msg.text.trim() && this.state !== "thinking") {
          void this.runTurn(msg.text.trim(), msg.fixedReply === true);
        }
        break;
      case "end":
        void this.destroy("user_ended");
        break;
    }
  }

  private async applyPersonaVoice() {
    if (!this.matchmakerId) return;
    try {
      const mm: any = await prisma.matchmaker.findUnique({ where: { id: this.matchmakerId } });
      if (mm) {
        const resolved = resolveVoiceForProvider(
          this.settings.voiceTtsProvider,
          mm.voiceIds,
          mm.voiceId,
        );
        if (resolved) this.voiceId = resolved;
        if (mm.avatarFaceId) this.personaAvatarId = mm.avatarFaceId;
      }
    } catch (err: any) {
      log(`persona voice lookup failed: ${err?.message}`);
    }
  }

  private personaAvatarId: string | null = null;

  // Start the realtime video avatar when enabled + configured. Failure is
  // LOUD in the log and falls back to the audio-over-WS path with the static
  // avatar - never a silent stub.
  private async maybeStartAvatar() {
    if (!this.settings.voiceAvatarEnabled) return;
    if (this.settings.voiceAvatarProvider !== "heygen") {
      log(`avatar provider "${this.settings.voiceAvatarProvider}" not implemented yet - audio-only fallback`);
      return;
    }
    if (!heygenAvatarConfigured()) {
      log("avatar enabled but LIVEAVATAR_API_KEY/HEYGEN_API_KEY missing - audio-only fallback");
      return;
    }
    // The persona's own avatar is the source of truth; without one this
    // session runs audio-only (loudly logged), never a surprise face.
    const avatarId = this.personaAvatarId || this.settings.voiceDefaultAvatarId;
    if (!avatarId) {
      log("avatar enabled but persona has no video avatar - audio-only fallback");
      return;
    }
    try {
      const session = new HeyGenAvatarSession();
      const info = await session.start(avatarId);
      this.avatar = session;
      this.avatarStartedAt = Date.now();
      this.send({
        type: "avatar",
        livekitUrl: info.livekitUrl,
        livekitToken: info.livekitClientToken,
      });
      log(`avatar session started (heygen, avatar ${avatarId})`);
    } catch (err: any) {
      log(`AVATAR START FAILED (falling back to audio-only): ${err?.message}`);
      this.avatar = null;
    }
  }

  // Route synthesized speech to the avatar when active, else raw PCM down the WS.
  private deliverSpeech(pcm: Buffer) {
    if (this.avatar) this.avatar.sendAudio(pcm);
    else this.sendAudio(pcm);
  }

  private handleBarge() {
    if (this.state !== "speaking" && this.state !== "thinking") return;
    this.speakSuppressed = true;
    this.tts?.cancel();
    this.tts = null;
    this.chunker?.reset();
    this.avatar?.interrupt();
    this.send({ type: "caption_reset" });
    this.setState("listening");
  }

  private openTts(): TtsStream {
    const stream = this.ttsProvider.openStream({ voiceId: this.voiceId });
    stream.onAudio((pcm) => {
      if (!this.speakSuppressed) this.deliverSpeech(pcm);
    });
    stream.onError((err) => log(`TTS error (${this.ttsProvider.name}): ${err.message}`));
    return stream;
  }

  // Speak a line that is NOT part of the persisted conversation (greeting,
  // silence prompt, cap warning, card fallback).
  private speakSystemLine(text: string) {
    if (this.closed) return;
    this.speakSuppressed = false;
    this.tts?.cancel();
    this.tts = this.openTts();
    this.ttsChars += text.length;
    this.setState("speaking");
    this.send({ type: "eva_caption", text });
    this.tts.onEnd(() => {
      this.avatar?.flushSpeech();
      if (this.state === "speaking") this.setState("listening");
    });
    this.tts.sendText(text + " ");
    this.tts.flush();
  }

  private async runTurn(userText: string, fixedReply = false) {
    const turnId = ++this.turnCounter;
    const tSttFinal = Date.now();
    let tFirstToken = 0;
    let tFirstAudio = 0;

    this.speakSuppressed = false;
    this.setState("thinking");
    this.stripper.reset();

    this.tts?.cancel();
    this.tts = this.openTts();
    this.tts.onAudio((pcm) => {
      if (this.speakSuppressed || this.turnCounter !== turnId) return;
      if (!tFirstAudio) {
        tFirstAudio = Date.now();
        log(`turn ${turnId}: firstToken->firstAudio ${tFirstAudio - (tFirstToken || tSttFinal)}ms`);
      }
      this.deliverSpeech(pcm);
    });

    this.chunker = new SentenceChunker((sentence) => {
      if (this.speakSuppressed || this.turnCounter !== turnId) return;
      this.ttsChars += sentence.length;
      this.tts?.sendText(sentence);
    });

    // Dead-air filler: Tier2-routed turns can take ~4s to first token. If
    // nothing has streamed after 1.8s, speak a short non-persisted filler so
    // the parent is not left in silence. It rides the same TTS stream, ahead
    // of the real reply.
    const fillerTimer = setTimeout(() => {
      if (this.turnCounter !== turnId || this.speakSuppressed || tFirstToken) return;
      const filler = "One moment, let me look into that. ";
      this.ttsChars += filler.length;
      this.setState("speaking");
      this.send({ type: "eva_caption", text: filler });
      this.tts?.sendText(filler);
    }, 1800);

    const port = process.env.PORT || "5000";
    let done: any = null;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/ai-concierge/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          cookie: this.cookieHeader,
        },
        body: JSON.stringify({
          sessionId: this.chatSessionId,
          message: userText,
          matchmakerId: this.matchmakerId,
          channel: "voice",
          ...(fixedReply ? { fixedReply: userText } : {}),
        }),
      });

      if (!resp.ok || !resp.body) {
        throw new Error(`chat pipeline responded ${resp.status}`);
      }

      const reader = (resp.body as any).getReader
        ? (resp.body as any).getReader()
        : null;
      let buf = "";
      const handleFrame = (json: any) => {
        if (this.turnCounter !== turnId) return; // superseded by a newer turn
        if (json.type === "token" && typeof json.delta === "string") {
          if (!tFirstToken) {
            tFirstToken = Date.now();
            log(`turn ${turnId}: sttFinal->firstToken ${tFirstToken - tSttFinal}ms`);
            if (this.state === "thinking") this.setState("speaking");
          }
          const safe = this.stripper.push(json.delta);
          if (safe) {
            this.send({ type: "eva_caption", text: safe });
            this.chunker?.push(safe);
          }
        } else if (json.type === "reset") {
          // An interceptor replaced the draft: silence what was queued and
          // start clean, mirroring the client's reset handling.
          this.tts?.cancel();
          this.tts = this.openTts();
          this.avatar?.interrupt();
          this.tts.onAudio((pcm) => {
            if (!this.speakSuppressed && this.turnCounter === turnId) this.deliverSpeech(pcm);
          });
          this.stripper.reset();
          this.chunker?.reset();
          this.send({ type: "caption_reset" });
        } else if (json.type === "done") {
          done = json;
        } else if (json.type === "retry_needed") {
          done = { retry: true };
        } else if (json.type === "error") {
          done = { error: json.message || "error" };
        }
      };
      const feed = (text: string) => {
        buf += text;
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of raw.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              handleFrame(JSON.parse(line.slice(6)));
            } catch {
              /* partial frame */
            }
          }
        }
      };

      if (reader) {
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done: rDone } = await reader.read();
          if (rDone) break;
          feed(decoder.decode(value, { stream: true }));
        }
      } else {
        // Node fetch bodies are async-iterable
        for await (const chunk of resp.body as any) {
          feed(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        }
      }
    } catch (err: any) {
      log(`turn ${turnId}: chat pipeline failed: ${err?.message}`);
      done = { error: err?.message || "pipeline failure" };
    }

    clearTimeout(fillerTimer);
    if (this.closed || this.turnCounter !== turnId) return;

    if (done?.retry || done?.error) {
      this.tts?.cancel();
      this.speakSystemLine("I'm sorry, something went wrong on my end. Could you say that again?");
      return;
    }

    if (done) {
      if (done.sessionId && !this.chatSessionId) this.chatSessionId = done.sessionId;
      // Ship the interactive payload (cards, quick replies) to the panel.
      const { type: _t, message: _m, ...extras } = done;
      this.send({ type: "cards", payload: extras });

      const spoke = this.stripper.emittedText().trim().length > 0;
      if (!spoke && !this.speakSuppressed) {
        const line = cardFallbackLine(done);
        if (line) {
          this.speakSystemLine(line);
          return;
        }
      }
    }

    // Flush the tail of the reply through TTS and hand back the floor.
    if (!this.speakSuppressed) {
      this.chunker?.flush();
      const stream = this.tts;
      stream?.onEnd(() => {
        this.avatar?.flushSpeech();
        if (this.state === "speaking" && this.turnCounter === turnId) {
          this.setState("listening");
        }
      });
      stream?.flush();
    } else {
      this.setState("listening");
    }
  }

  async destroy(reason: string) {
    if (this.closed) return;
    this.closed = true;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.capTimer) clearTimeout(this.capTimer);
    this.tts?.cancel();
    this.stt?.close();
    if (this.avatar) {
      this.avatarSeconds = Math.round((Date.now() - this.avatarStartedAt) / 1000);
      void this.avatar.end();
      this.avatar = null;
    }
    this.send({ type: "ended", reason });
    try {
      this.ws.close(1000);
    } catch {
      /* already closed */
    }
    const seconds = Math.round((Date.now() - this.startedAt) / 1000);
    const sttSeconds = Math.round(this.sttBytes / (VOICE_SAMPLE_RATE * 2));
    log(
      `session ended (${reason}): ${seconds}s wall, ~${sttSeconds}s stt audio, ${this.ttsChars} tts chars`,
    );
    if (this.logId) {
      try {
        await prisma.voiceSessionLog.update({
          where: { id: this.logId },
          data: {
            endedAt: new Date(),
            seconds,
            sttSeconds,
            ttsChars: this.ttsChars,
            avatarSeconds: this.avatarSeconds,
            sessionId: this.chatSessionId || "unknown",
          },
        });
      } catch (err: any) {
        log(`VoiceSessionLog update failed: ${err?.message}`);
      }
    }
  }
}

async function loadSettings(): Promise<VoiceSettings | null> {
  const s: any = await prisma.siteSettings.findFirst();
  if (!s) return null;
  return {
    voiceModeEnabled: !!s.voiceModeEnabled,
    voiceTtsProvider: s.voiceTtsProvider || "elevenlabs",
    voiceSttProvider: s.voiceSttProvider || "google",
    voiceDefaultVoiceIds: s.voiceDefaultVoiceIds || null,
    voiceDefaultVoiceId: s.voiceDefaultVoiceId || null,
    voiceSessionCapMinutes: s.voiceSessionCapMinutes ?? 10,
    voiceDailyCapMinutes: s.voiceDailyCapMinutes ?? 30,
    voiceAvatarEnabled: !!s.voiceAvatarEnabled,
    voiceAvatarProvider: s.voiceAvatarProvider || "heygen",
    voiceDefaultAvatarId: s.voiceDefaultAvatarId || null,
  };
}

export function attachVoiceGateway(httpServer: HttpServer, sessionMiddleware: any) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url || !req.url.startsWith("/api/voice/ws")) return;

    const fakeRes: any = { end: () => socket.destroy(), setHeader: () => {}, getHeader: () => undefined };
    sessionMiddleware(req as any, fakeRes, () => {
      passport.initialize()(req as any, fakeRes, () => {
        passport.session()(req as any, fakeRes, async () => {
          const user: any = (req as any).user;
          if (!user?.id) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          let settings: VoiceSettings | null = null;
          try {
            settings = await loadSettings();
          } catch (err: any) {
            log(`settings load failed: ${err?.message}`);
          }
          if (!settings?.voiceModeEnabled) {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\nvoice mode disabled");
            socket.destroy();
            return;
          }
          const tts = resolveTtsProvider(settings.voiceTtsProvider);
          const stt = resolveSttProvider(settings.voiceSttProvider);
          // Session-opening voice; the persona's own pick replaces it on hello.
          const defaultVoiceId = resolveVoiceForProvider(settings.voiceTtsProvider, null, null);
          if (!tts || !tts.isConfigured() || !stt || !stt.isConfigured()) {
            log(
              `voice session rejected: tts=${settings.voiceTtsProvider}(${tts?.isConfigured() ? "ok" : "unconfigured"}) ` +
                `stt=${settings.voiceSttProvider}(${stt?.isConfigured() ? "ok" : "unconfigured"})`,
            );
            socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\nvoice providers not configured");
            socket.destroy();
            return;
          }

          // Per-user daily minutes cap.
          try {
            const since = new Date();
            since.setHours(0, 0, 0, 0);
            const agg = await prisma.voiceSessionLog.aggregate({
              where: { userId: user.id, startedAt: { gte: since } },
              _sum: { seconds: true },
            });
            const usedMin = (agg._sum.seconds || 0) / 60;
            if (usedMin >= settings.voiceDailyCapMinutes) {
              socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\ndaily voice cap reached");
              socket.destroy();
              return;
            }
          } catch (err: any) {
            log(`daily cap check failed: ${err?.message}`);
          }

          wss.handleUpgrade(req, socket, head, (ws) => {
            log(`session opened for user ${user.id} (tts=${tts.name}, stt=${stt.name})`);
            new VoiceSession(
              ws,
              user.id,
              req.headers.cookie || "",
              settings!,
              tts,
              stt,
              defaultVoiceId,
            );
          });
        });
      });
    });
  });

  log("voice gateway attached at /api/voice/ws");
}
