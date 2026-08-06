import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import passport from "passport";
import { prisma } from "../db";
import { StreamingTagStripper, stripTags } from "./tag-stripper";
import { SentenceChunker } from "./sentence-chunker";
import { SpokenBudget, normalizeSpeech, forTts } from "./spoken-budget";
import type { SttProvider, SttStream, SttUtteranceMeta, TtsProvider, TtsStream } from "./providers";
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
// admins pick voices per persona in the AI Concierge tab. There is
// deliberately NO hardcoded fallback voice: a persona without a voice for
// the active provider fails LOUDLY (session rejected with
// "voice_not_configured", admin UI warns on switch) rather than speaking
// with a voice nobody chose.
export function resolveVoiceForProvider(
  provider: string,
  personaVoiceIds: any,
  personaLegacyVoiceId: string | null | undefined,
): string {
  return (
    personaVoiceIds?.[provider] ||
    (provider === "elevenlabs" ? personaLegacyVoiceId : null) ||
    ""
  );
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
  private lastTurnText = "";
  private lastTurnStartedAt = 0;
  // Chip-tap turns (fixedReply) are actions, not speech - a supersede must
  // not splice their label into the parent's next sentence.
  private lastTurnWasFixedReply = false;
  // In avatar mode "speaking" must outlive TTS generation: the avatar plays
  // the queued audio in realtime, so the flip back to "listening" is deferred
  // until its playhead actually drains (client barge-in depends on this).
  private listenTimer: NodeJS.Timeout | null = null;

  // Cost + latency accounting
  private startedAt = Date.now();
  private sttBytes = 0;
  private ttsChars = 0;
  private logId: string | null = null;

  // Per-turn structured timing (instrumentation only). Key = turnId. Each
  // record becomes ONE [TURN_METRICS] JSON log line, emitted ~3s after the
  // turn's speech ends so late client-side metrics (caption paint, audio
  // play) can still attach. corrPrefix makes corrIds unique across sessions.
  private readonly corrPrefix = Math.random().toString(36).slice(2, 8);
  private turnMetrics = new Map<number, any>();
  private emitTimers = new Map<number, NodeJS.Timeout>();

  private scheduleEmitMetrics(turnId: number | null, delayMs = 3000) {
    if (turnId === null || !this.turnMetrics.has(turnId)) return;
    if (this.emitTimers.has(turnId)) return;
    this.emitTimers.set(
      turnId,
      setTimeout(() => this.emitMetrics(turnId), delayMs),
    );
  }

  private emitMetrics(turnId: number) {
    const timer = this.emitTimers.get(turnId);
    if (timer) clearTimeout(timer);
    this.emitTimers.delete(turnId);
    const m = this.turnMetrics.get(turnId);
    if (!m) return;
    this.turnMetrics.delete(turnId);
    m.sessionLogId = this.logId;
    m.chatSessionId = this.chatSessionId;
    m.avatarActive = m.avatarActive ?? false;
    if (this.multiEngineSuspected) m.multiEngineSuspected = true;
    const mk = m.marks || {};
    const num = (v: any) => (typeof v === "number" ? v : null);
    const diff = (a: any, b: any) =>
      num(a) !== null && num(b) !== null ? (b as number) - (a as number) : null;
    m.derived = {
      // What the parent actually experiences: silence from their last spoken
      // word to Eva's first audio. speech_final-anchored metrics exclude the
      // dispatch hold (~1.2-1.5s) and understate this.
      last_word_to_first_audio_ms: diff(mk.stt_last_new_words, mk.tts_first_audio),
      stt_to_first_token_ms: diff(mk.speech_final, mk.first_token),
      stt_to_first_audio_ms: diff(mk.speech_final, mk.tts_first_audio),
      first_token_to_first_audio_ms: diff(mk.first_token, mk.tts_first_audio),
      router_total_ms: diff(mk.router_fetch_sent, mk.router_done),
      tts_generation_ms: diff(mk.tts_first_audio, mk.tts_last_audio),
      tools_total_ms: Array.isArray(m.toolCalls)
        ? m.toolCalls.reduce((s: number, c: any) => s + (c.ms || 0), 0)
        : 0,
    };
    console.log(`[TURN_METRICS] ${JSON.stringify(m)}`);
  }

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
    // Stamp when her audible speech ENDED - the echo filter may only act
    // while echo is physically possible (during speech or its immediate
    // tail), never against a parent speaking into her silence.
    if (this.state === "speaking" && state !== "speaking") {
      this.speakingEndedAt = Date.now();
    }
    this.state = state;
    this.send({ type: "state", state });
  }
  private speakingEndedAt = 0;

  private sttRestarts = 0;
  // Utterance telemetry from the STT provider for the NEXT turn, plus the
  // last time a mic frame arrived (whether the client VAD gate was open at
  // dispatch - held/replayed audio is the prime suspect for boundary bugs).
  private pendingSttMeta: SttUtteranceMeta | null = null;
  private lastMicFrameAt = 0;
  // Transcript-level debug for gate-bypassed AEC test sessions; survives the
  // STT self-reopen path.
  private sttDebug = false;
  // Last filler phrase index - the rotation never repeats back-to-back.
  private lastFillerIdx = -1;
  // Commit B: false for ungated (desktop) sessions - survives STT reopen.
  private sttHoldEnabled = true;
  // Set when mic_stats ever reports >1 live engine (or an impossible frame
  // rate) - stamped onto every turn's metrics from then on.
  private multiEngineSuspected = false;
  // CONTENT-BASED ECHO/BARGE (session 10): every word Eva speaks, normalized,
  // ring-buffered. The mic now streams continuously on EVERY platform - her
  // speaker echo transcribes as words she just said, the parent's speech as
  // words she did not. Levels cannot separate parent from echo on an iPhone
  // speaker (echo at the mic is often LOUDER than the parent); words can.
  private recentSpoken: string[] = [];
  private lastBargeAt = 0;
  private noteSpoken(text: string) {
    for (const w of text.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/)) {
      if (w.length >= 2) this.recentSpoken.push(w);
    }
    // ~2+ minutes of speech - must outlive the longest monologue, because
    // echo segments can accumulate for its entire duration before dispatch.
    if (this.recentSpoken.length > 400) this.recentSpoken.splice(0, this.recentSpoken.length - 400);
  }
  // Alphabetic words only (>= 3 chars): TTS/STT orthography drift on numbers
  // and IDs ("23899" vs "two three eight...") would fake novelty from pure
  // echo and stop her mid-sentence for no reason.
  private novelWordInfo(text: string): { novel: number; total: number; novelWords: string[] } {
    const spoken = new Set(this.recentSpoken);
    const novelWords: string[] = [];
    let total = 0;
    for (const w of text.toLowerCase().replace(/[^a-z\s']/g, " ").split(/\s+/)) {
      if (w.length < 3) continue;
      total++;
      if (!spoken.has(w)) novelWords.push(w);
    }
    return { novel: novelWords.length, total, novelWords };
  }
  // Interjection command words: ONE of these (novel) is enough to barge -
  // parents open interruptions with a command or her name, and waiting for a
  // second word means she talks over their first ("didn't stop on my first
  // word" - live feedback). Persona names included; she almost never says
  // them herself, so novelty holds.
  private static readonly BARGE_HOTWORDS = new Set([
    "stop", "wait", "hold", "pause", "shush", "excuse", "sorry", "ariel", "eva",
  ]);
  // A pure stop-command has NO content to answer. She stops (the barge
  // already did that) and stays SILENT - replying "I am completely silent
  // and listening" is not how humans take an interruption (live feedback).
  private static readonly PURE_STOP_RE =
    /^(?:(?:hey|hi)[,!. ]+)?(?:(?:ariel|eva)[,!. ]+)?(?:please[,!. ]+)?(?:stop|wait|hold on|pause|shh+|shush|quiet|be quiet|one (?:sec|second|moment)|give me a (?:sec|second|minute|moment))(?:[,!. ]+(?:please|for a (?:sec|second|minute|moment)|a (?:sec|second|minute|moment)|right now|now|talking))*[\s!.,]*$/i;
  private openStt() {
    this.stt = this.sttProvider.openStream({ sampleRate: VOICE_SAMPLE_RATE });
    if (this.sttDebug) (this.stt as any)?.setDebug?.(true);
    if (!this.sttHoldEnabled) (this.stt as any)?.setHoldEnabled?.(false);
    this.stt.onPartial((text) => {
      this.sttRestarts = 0;
      this.armSilenceTimer();
      // INSTANT CONTENT BARGE: while Eva is audibly speaking, an interim
      // carrying words she did NOT recently say is the parent talking over
      // her - stop her the moment it appears, like a human would. (During
      // "thinking" nothing is playing; the supersession/merge machinery owns
      // that case.)
      if (this.state === "speaking" && text && this.recentSpoken.length > 0) {
        const nov = this.novelWordInfo(text);
        const hotWord = nov.novelWords.find((w) => VoiceSession.BARGE_HOTWORDS.has(w));
        if (nov.novel >= 2 || hotWord) {
          log(`content barge: ${hotWord ? `hot word "${hotWord}"` : `${nov.novel} non-echo words`}: "${text.slice(0, 60)}"`);
          this.handleBarge();
        }
      }
      this.send({ type: "partial_transcript", text });
    });
    this.stt.onFinal((text, meta) => {
      this.sttRestarts = 0;
      this.armSilenceTimer();
      if (!text || text.length < 2) return;
      // ECHO-UTTERANCE FILTER: with the mic always streaming, Eva's own
      // speaker echo reaches STT on iOS and dispatches as parent turns (the
      // junk-whisper incident). An utterance whose words are nearly all
      // words she recently spoke is her own voice - drop it. Single-word
      // and mostly-novel utterances always pass.
      // Echo is only physically possible while her speech is audible (or in
      // its immediate ~3s tail: playback + STT latency). Outside that window
      // the filter must NEVER fire - observed live (0g3kop): the parent's
      // "Are you there? Are you showing me [sperm donor profiles]?" scored
      // 2/8 novel (common words she had recently said) and was suppressed
      // while she sat SILENT - the parent was ignored and hung up.
      const echoPossible = this.state === "speaking" || Date.now() - this.speakingEndedAt < 3000;
      const nov = this.novelWordInfo(text);
      if (echoPossible && this.recentSpoken.length > 0 && nov.total >= 2 && nov.novel / nov.total < 0.3) {
        log(`echo utterance suppressed (${nov.novel}/${nov.total} novel words): "${text.slice(0, 80)}"`);
        this.send({ type: "partial_transcript", text: "" });
        return;
      }
      // A pure stop-command right after a barge (or while she was talking)
      // carries no content - she has already stopped, so she simply LISTENS.
      // No turn, no reply, no "I am completely silent" meta-speech. The
      // parent's next real utterance becomes a normal fresh turn.
      // While she is SPEAKING, a real interruption barges FIRST (hot word or
      // 2+ novel interim words stop her before the utterance finalizes). A
      // final that lands mid-speech WITHOUT having barged and with fewer
      // than 2 novel words is echo/mishear debris - observed live (jzpw4j):
      // "I pulled that up." materialized 1s into her correct answer, cut it
      // via the stale-speech flush, and she replied to the phantom ("I'm
      // glad you have that pulled up on your screen!"). Drop it.
      if (this.state === "speaking" && nov.novel < 2 && !nov.novelWords.some((w) => VoiceSession.BARGE_HOTWORDS.has(w))) {
        log(`low-novelty mid-speech utterance suppressed (${nov.novel}/${nov.total} novel): "${text.slice(0, 60)}"`);
        this.send({ type: "partial_transcript", text: "" });
        return;
      }
      const stopContext = this.state === "speaking" || Date.now() - this.lastBargeAt < 5000;
      if (stopContext && VoiceSession.PURE_STOP_RE.test(text.trim())) {
        log(`pure stop-command absorbed silently: "${text.slice(0, 60)}"`);
        this.setState("listening");
        this.send({ type: "partial_transcript", text: "" });
        return;
      }
      // Stash for the runTurn this final is about to start (or merge into) -
      // carries the utterance-assembly telemetry into [TURN_METRICS].
      this.pendingSttMeta = meta || null;
      this.send({ type: "final_transcript", text });
      // Continuation window: a final landing while the previous turn is in
      // flight (thinking) OR just after Eva started speaking is the rest of
      // the SAME utterance, not a reaction to a reply the parent has barely
      // heard. Baseline turns 14/15 proved the speaking case: "Okay. I want
      // to" was answered as its own turn and "schedule the call." became the
      // next one. 4s covers dispatch hold + router thinking + first words.
      const inFlight =
        this.state === "thinking" ||
        (this.state === "speaking" && Date.now() - this.lastTurnStartedAt < 4000);
      if (inFlight) {
        // The parent spoke over Eva's thinking. Supersede the in-flight turn:
        // it keeps streaming for persistence but its speech is abandoned, and
        // the new utterance becomes the live turn. The two texts are ALWAYS
        // concatenated (baseline turns 7/8 proved the old 1.5s merge window
        // silently discarded "I want you to keep the profile" and answered
        // "while I'm talking to you" - losing the first half of what someone
        // said is never the right outcome). Exception: a superseded CHIP turn
        // (fixedReply) is an action, not speech - splicing its label into the
        // parent's sentence would corrupt both; it is dropped and counted.
        const sincePrev = Date.now() - this.lastTurnStartedAt;
        const mergeable = !!this.lastTurnText && !this.lastTurnWasFixedReply;
        const merged = mergeable ? `${this.lastTurnText} ${text}` : text;
        log(
          `turn ${this.turnCounter} superseded by new speech during thinking (${sincePrev}ms in, ` +
            `${mergeable ? "merged into next" : "DISCARDED (fixedReply action)"}): "${this.lastTurnText.slice(0, 60)}"`,
        );
        // Count it: superseded turns previously showed up only as missing
        // marks. The record now says so explicitly, with the discarded text.
        const oldRec = this.turnMetrics.get(this.turnCounter);
        if (oldRec) {
          oldRec.superseded = true;
          oldRec.supersededAfterMs = sincePrev;
          oldRec.discardedText = this.lastTurnText.slice(0, 160);
          oldRec.mergedIntoNext = mergeable;
        }
        this.tts?.cancel();
        this.avatar?.interrupt();
        this.send({ type: "caption_reset" });
        void this.runTurn(merged);
        return;
      }
      void this.runTurn(text);
    });
    this.stt.onError((err) => {
      log(`STT error: ${err.message}`);
      // A dead recognizer must never mean a deaf session: reopen it. Partials
      // reset the counter, so this only gives up on a hard provider outage.
      if (this.closed) return;
      if (this.sttRestarts >= 5) {
        log("STT failed 5 times in a row - giving up, ending session loudly");
        void this.destroy("stt_failed");
        return;
      }
      this.sttRestarts += 1;
      const old = this.stt;
      this.stt = null;
      try {
        old?.close();
      } catch {
        /* already dead */
      }
      setTimeout(() => {
        if (this.closed) return;
        log(`STT stream reopened (restart #${this.sttRestarts})`);
        this.openStt();
      }, 300);
    });
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
      this.lastMicFrameAt = Date.now();
      // The client only forwards mic frames while the parent is actually
      // speaking (VAD-gated), so incoming audio = an active parent even if a
      // transcript hasn't landed yet. Keeps "Are you still there?" honest.
      this.armSilenceTimer();
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
        // Phones report a portrait viewport; personas can carry a
        // portrait-framed avatar variant for them.
        this.portraitViewport = msg.portrait === true;
        void this.applyPersonaVoice().then(() => {
          // No voice for the active provider = loud failure, never a voice
          // nobody chose. The admin UI warns about this on provider switch.
          if (!this.voiceId) {
            log(
              `VOICE NOT CONFIGURED: persona ${this.matchmakerId || "(none)"} has no voice for ` +
                `provider "${this.settings.voiceTtsProvider}" - rejecting session. Set it in the admin persona form.`,
            );
            void this.destroy("voice_not_configured");
            return;
          }
          // Ready IMMEDIATELY - the LiveAvatar handshake (~2-3s) happens in
          // parallel and the client swaps the static photo for video whenever
          // the "avatar" frame lands. Blocking here was the slow "Connecting...".
          this.send({ type: "ready" });
          const avatarReady = this.maybeStartAvatar();
          // Voice-first greeting: give the avatar up to 3s to connect so the
          // greeting is lip-synced, then speak it regardless (audio-only
          // greeting beats silence). Skipped if the parent already spoke.
          if (msg.greetingText) {
            const greeting = String(msg.greetingText);
            void Promise.race([avatarReady, new Promise((r) => setTimeout(r, 3000))]).then(() => {
              if (!this.closed && this.turnCounter === 0 && this.state === "listening") {
                this.speakSystemLine(greeting);
              }
            });
          }
        });
        break;
      case "client_metric": {
        // Browser-side timestamps (caption paint, first audio play, first
        // remote audio energy) reported per turn. Clock caveat: tClient is the
        // BROWSER's clock; tServerRecv is ours - use tServerRecv for cross-
        // boundary ordering and tClient only for client-internal deltas.
        const rec = this.turnMetrics.get(Number(msg.turn));
        if (rec && msg.event) {
          rec.client[String(msg.event)] = {
            tClient: Number(msg.tClient) || null,
            tServerRecv: Date.now(),
            ...(msg.extra && typeof msg.extra === "object" ? { extra: msg.extra } : {}),
          };
        }
        break;
      }
      case "fps_stats":
        // Avatar video health (Task 4 A/B): rendered fps, delivered track
        // resolution, element size, and whether adaptiveStream was on.
        log(
          `avatar fps: ${Number(msg.fps || 0).toFixed(1)} | track ${msg.videoW}x${msg.videoH} | ` +
            `element ${msg.elemW}x${msg.elemH} | adaptiveStream=${msg.adaptive}`,
        );
        break;
      case "mic_settings":
        // AEC audit (session 5): what the browser GRANTED, verbatim.
        log(
          `mic settings (granted): ${JSON.stringify(msg.settings || {})} gateBypassed=${msg.gateBypassed === true} gatePolicy=${msg.gatePolicy || "unknown"}`,
        );
        // Gate-bypassed TEST sessions also log every Deepgram transcript
        // message (interims included) - never normal sessions (PII).
        if (msg.gateBypassed === true) {
          this.sttDebug = true;
          (this.stt as any)?.setDebug?.(true);
        }
        // Commit B: ungated sessions stream the mic continuously, so
        // UtteranceEnd is the dispatcher and the speech_final hold is dead
        // weight (0/29 fires in the desktop baseline) - disable it. Gated
        // (iOS) and unknown clients keep it.
        if (msg.gatePolicy === "ungated-desktop" || msg.gatePolicy === "ungated-ios" || msg.gatePolicy === "test-bypass") {
          this.sttHoldEnabled = false;
          (this.stt as any)?.setHoldEnabled?.(false);
        }
        break;
      case "mic_stats": {
        // Client-side VAD telemetry (max mic RMS + frames forwarded per 5s
        // window) - the remote-diagnosis line for "Eva stopped hearing me".
        log(
          `mic stats: peak rms ${Number(msg.maxRms || 0).toFixed(4)}, ` +
            `${msg.sent || 0} frames forwarded, vad ${msg.maxRms > 0.015 ? "above" : "BELOW"} threshold` +
            (msg.liveEngines !== undefined ? `, engines ${msg.liveEngines}` : ""),
        );
        // ZOMBIE-ENGINE ALARM: >1 live engine (or a frame rate no single
        // 40ms-cadence engine can produce) means interleaved capture streams
        // - scrambled PCM that makes Deepgram silently deaf. Flag on the
        // session AND on every subsequent turn's metrics so baselines
        // contaminated by this are identifiable in the JSONL.
        const engines = Number(msg.liveEngines);
        if ((Number.isFinite(engines) && engines > 1) || Number(msg.sent || 0) > 150) {
          this.multiEngineSuspected = true;
          log(
            `MULTIPLE ENGINE ALARM: liveEngines=${msg.liveEngines ?? "?"} frames/5s=${msg.sent} - ` +
              `mic capture is interleaved, STT will be unreliable (zombie-engine bug signature)`,
          );
        }
        break;
      }
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
        // Portrait clients get the portrait variant when it exists; otherwise
        // the landscape avatar (client crops it).
        const avatarPick =
          (this.portraitViewport && mm.avatarFaceIdPortrait) || mm.avatarFaceId;
        if (avatarPick) this.personaAvatarId = avatarPick;
      }
    } catch (err: any) {
      log(`persona voice lookup failed: ${err?.message}`);
    }
  }

  private personaAvatarId: string | null = null;
  private portraitViewport = false;

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
    // The persona's own avatar is the SOLE source of truth; without one this
    // session runs audio-only (loudly logged), never a surprise face. The
    // old fallback to SiteSettings.voiceDefaultAvatarId contradicted that
    // rule (the admin field was removed b16ae7c1) and gave persona-less
    // sessions a face nobody chose - discovered when a no-avatar test persona
    // still spun up a LiveAvatar session (real credits) on the site default.
    const avatarId = this.personaAvatarId;
    if (!avatarId) {
      log("avatar enabled but persona has no video avatar - audio-only fallback");
      return;
    }
    try {
      const session = new HeyGenAvatarSession();
      const tAvatarStart = Date.now();
      const info = await session.start(avatarId);
      // The isolated LiveAvatar spin-up hop (token + start + WS "connected").
      log(`avatar handshake took ${Date.now() - tAvatarStart}ms (session token + start + WS connected)`);
      this.avatar = session;
      this.avatarStartedAt = Date.now();
      // Mid-session avatar death (HeyGen limit/credits/upstream): clear the
      // route so speech falls back to WS-PCM audio IMMEDIATELY, and tell the
      // client to drop to the persona photo. Without this the gateway spoke
      // into the dead session while the parent watched captions in silence.
      session.onDied = (reason: string) => {
        if (this.closed || this.avatar !== session) return;
        log(`AVATAR DIED mid-session (${reason}) - falling back to audio-only`);
        this.avatar = null;
        this.send({ type: "avatar_failed" });
        session.end().catch(() => {});
      };
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

  // Route synthesized speech to the avatar when active, else raw PCM down the
  // WS. The route is SNAPSHOTTED per reply: if the avatar connects while a
  // reply is mid-flight, that reply finishes on the WS path (splitting one
  // reply across both outputs would garble it) and the next one is lip-synced.
  private deliverSpeech(pcm: Buffer, route: HeyGenAvatarSession | null) {
    // A reply snapshots its route at turn start - if the avatar died since,
    // the snapshot is stale and audio must fall back to the WS-PCM path
    // mid-reply (better a voice without lips than lips without a voice).
    const live = route && route === this.avatar ? route : null;
    if (live) live.sendAudio(pcm);
    else this.sendAudio(pcm);
  }

  private handleBarge() {
    if (this.state !== "speaking" && this.state !== "thinking") return;
    this.lastBargeAt = Date.now();
    log(`barge-in (turn ${this.turnCounter}, was ${this.state})`);
    this.speakSuppressed = true;
    if (this.listenTimer) clearTimeout(this.listenTimer);
    this.tts?.cancel();
    this.tts = null;
    this.chunker?.reset();
    this.avatar?.interrupt();
    this.send({ type: "caption_reset" });
    this.setState("listening");
  }

  // TTS generation finished - but with an avatar the parent is still WATCHING
  // Eva talk. Hold "speaking" until the avatar's queued audio drains, then
  // hand back the floor. Audio-only sessions flip immediately (the client's
  // own playback buffer is ~real-time behind generation).
  private finishSpeaking(turnId: number | null, route: HeyGenAvatarSession | null) {
    // Instrumentation: TTS generation is done for this turn; note when the
    // avatar's realtime playhead is expected to drain (audible speech end).
    if (turnId !== null) {
      const rec = this.turnMetrics.get(turnId);
      if (rec) {
        rec.marks.tts_generation_done = Date.now();
        if (route) rec.marks.avatar_playhead_drain_expected = Date.now() + route.remainingSpeechMs();
      }
    }
    const stale = () =>
      this.closed ||
      this.state !== "speaking" ||
      (turnId !== null && this.turnCounter !== turnId);
    if (stale()) {
      this.scheduleEmitMetrics(turnId);
      return;
    }
    const remaining = route ? route.remainingSpeechMs() + 600 : 0;
    if (remaining <= 0) {
      this.setState("listening");
      if (turnId !== null) {
        const rec = this.turnMetrics.get(turnId);
        if (rec) rec.marks.back_to_listening = Date.now();
      }
      this.scheduleEmitMetrics(turnId);
      return;
    }
    if (this.listenTimer) clearTimeout(this.listenTimer);
    this.listenTimer = setTimeout(() => {
      if (!stale()) {
        this.setState("listening");
        if (turnId !== null) {
          const rec = this.turnMetrics.get(turnId);
          if (rec) rec.marks.back_to_listening = Date.now();
        }
      }
      this.scheduleEmitMetrics(turnId);
    }, remaining);
  }

  private openTts(route: HeyGenAvatarSession | null): TtsStream {
    const stream = this.ttsProvider.openStream({ voiceId: this.voiceId });
    stream.onAudio((pcm) => {
      if (!this.speakSuppressed) this.deliverSpeech(pcm, route);
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
    const route = this.avatar;
    // Instrumentation: system lines (greeting, silence prompt, card fallback)
    // snapshot the route at THIS moment. A null route here with an avatar
    // connecting moments later = audio plays locally over an idle avatar -
    // the exact decoupling signature under investigation (Section E1).
    log(
      `system line via ${route ? "AVATAR" : "WS-PCM"} route at ${new Date().toISOString()}: "${text.slice(0, 48)}"`,
    );
    this.tts = this.openTts(route);
    this.ttsChars += text.length;
    this.setState("speaking");
    this.send({ type: "eva_caption", text });
    this.tts.onEnd(() => {
      route?.flushSpeech();
      this.finishSpeaking(null, route);
    });
    this.noteSpoken(forTts(text));
    this.tts.sendText(forTts(text) + " ");
    this.tts.flush();
  }

  private async runTurn(userText: string, fixedReply = false) {
    // A new turn supersedes the previous one - flush the old turn's metrics
    // now (its client events have had their window).
    if (this.turnCounter > 0) this.scheduleEmitMetrics(this.turnCounter, 0);
    const turnId = ++this.turnCounter;
    const tSttFinal = Date.now();
    this.lastTurnText = userText;
    this.lastTurnStartedAt = tSttFinal;
    this.lastTurnWasFixedReply = fixedReply;
    if (this.listenTimer) clearTimeout(this.listenTimer);
    let tFirstToken = 0;
    let tFirstAudio = 0;

    // One record per turn -> one [TURN_METRICS] JSON line. All server marks
    // share this process's clock (the /chat fetch is served in-process).
    const metrics: any = {
      tag: "TURN_METRICS",
      corrId: `${this.corrPrefix}:${turnId}`,
      turn: turnId,
      fixedReply,
      userText: userText.slice(0, 160),
      toolCallCount: 0,
      toolCalls: [],
      routerMarks: null,
      marks: { speech_final: tSttFinal } as Record<string, number>,
      client: {},
    };
    // Utterance-assembly telemetry (Session 4): how this turn's text was
    // built and which dispatch path released it. vadGateOpenAtDispatch =
    // mic frames were still arriving when the turn fired (open gate), vs a
    // gated/held stream whose silence Deepgram never saw.
    const sttMeta = this.pendingSttMeta;
    this.pendingSttMeta = null;
    if (sttMeta && !fixedReply) {
      if (sttMeta.tFirstInterim) metrics.marks.stt_first_interim = sttMeta.tFirstInterim;
      if (sttMeta.tLastNewWords) metrics.marks.stt_last_new_words = sttMeta.tLastNewWords;
      metrics.stt = {
        segments: sttMeta.segments,
        segmentGapsMs: sttMeta.segmentGapsMs,
        dispatchPath: sttMeta.dispatchPath,
        minConfidence: sttMeta.minConfidence,
        vadGateOpenAtDispatch: Date.now() - this.lastMicFrameAt < 250,
      };
    }
    // Forwarded to /chat so side-effect gates (SAVE, whisper, releases) can
    // refuse to act on weak-provenance turns (fragments, low confidence,
    // idle-fallback dispatches - the echo/hallucination signature).
    const sttProvenance = sttMeta && !fixedReply
      ? { dispatchPath: sttMeta.dispatchPath, minConfidence: sttMeta.minConfidence, segments: sttMeta.segments }
      : null;
    this.turnMetrics.set(turnId, metrics);
    // Tell the client which turn is live so its metric reports can correlate.
    this.send({ type: "turn", turn: turnId });

    this.speakSuppressed = false;
    this.setState("thinking");
    this.stripper.reset();

    const route = this.avatar;
    // A new turn OWNS the floor: flush any speech still queued in the avatar
    // from the PREVIOUS turn. Observed live on iPhone 2026-08-03 (session
    // fj7qre): a walkthrough reply queued 197 SECONDS of avatar audio, and
    // the parent's "Ariel, stop" utterances dispatched as new turns whose
    // replies APPENDED to that backlog - she was unstoppable for 3 minutes.
    // With this, any dispatched parent utterance cuts the stale audio, so
    // saying anything stops her even when acoustic barge detection misses.
    if (route && route.remainingSpeechMs() > 400) {
      log(`turn ${turnId}: flushing ${Math.round(route.remainingSpeechMs() / 1000)}s of stale avatar speech from the previous turn`);
      route.interrupt();
      this.send({ type: "caption_reset" });
    }
    metrics.avatarActive = !!route;
    if (route) {
      route.onSpeakSubmitted = (t: number) => {
        if (this.turnCounter === turnId && !metrics.marks.avatar_first_speak_submitted) {
          metrics.marks.avatar_first_speak_submitted = t;
        }
      };
    }
    this.tts?.cancel();
    this.tts = this.openTts(route);
    metrics.marks.tts_ws_open = Date.now();
    metrics.ttsProvider = this.ttsProvider.name;
    this.tts.onAudio((pcm) => {
      if (this.speakSuppressed || this.turnCounter !== turnId) return;
      if (!tFirstAudio) {
        tFirstAudio = Date.now();
        metrics.marks.tts_first_audio = tFirstAudio;
        log(
          tFirstToken
            ? `turn ${turnId}: firstToken->firstAudio ${tFirstAudio - tFirstToken}ms`
            : `turn ${turnId}: sttFinal->fillerAudio ${tFirstAudio - tSttFinal}ms (filler spoke first)`,
        );
      }
      metrics.marks.tts_last_audio = Date.now();
      this.deliverSpeech(pcm, route);
    });

    this.chunker = new SentenceChunker((sentence) => {
      if (this.speakSuppressed || this.turnCounter !== turnId) return;
      if (!metrics.marks.tts_first_text_sent) metrics.marks.tts_first_text_sent = Date.now();
      // Pronunciation rewrites apply HERE only - captions upstream keep the
      // written form ("GoStork"). The echo vocabulary records the TTS
      // variant, because that is what Deepgram will hear coming back.
      const spoken = forTts(sentence);
      this.ttsChars += spoken.length;
      this.noteSpoken(spoken);
      this.tts?.sendText(spoken);
    });

    // Dead-air filler: Tier2-routed turns can take ~4s to first token. If
    // nothing has streamed after 1.8s, speak a short non-persisted filler so
    // the parent is not left in silence. It rides the same TTS stream, ahead
    // of the real reply. ONLY for substantive requests - after "hey" or
    // "thanks", "let me look into that" is nonsense; short social utterances
    // just wait the extra second in silence, like a human would.
    // "Substantive" = worth covering dead air with "let me look into that".
    // Word count alone let greetings through ("Hey, can you hear me?" is 5
    // words) - social/presence phrases never get the lookup filler.
    const SOCIAL_UTTERANCE =
      /\b(hey|hi|hello|good (morning|afternoon|evening)|are you (there|here|with me)|can you hear( me)?|hear me|thank(s| you)?|ok(ay)?|got it)\b/i;
    const wordCount = userText.trim().split(/\s+/).length;
    const substantive = wordCount >= 4 && !(wordCount <= 8 && SOCIAL_UTTERANCE.test(userText));
    // SPOKEN CEILING REMOVED (live feedback 2026-08-05, session 6syttk): the
    // cut landed mid-LIST - "First... Second... I've put the full details in
    // our chat" with three steps unsaid - which reads as broken, not brief
    // ("do not stop her in the middle of what she needs to say"). Length
    // pressure lives in the prompt (rule 5) and in how easy interrupting now
    // is (content barge); the budget survives ONLY as the per-sentence
    // buffer that feeds the speech normalizer and the echo vocabulary.
    const spokenBudget = new SpokenBudget(Number.POSITIVE_INFINITY);
    // Conditional early filler: fires at FILLER_MS only when the first token
    // has NOT arrived yet - fast turns never hear it. 650ms fired on nearly
    // EVERY substantive turn (Tier2 first token is rarely that fast), and the
    // fixed 8-word phrase made Eva open every answer with "One moment, let me
    // look into that" - the single most-complained-about behavior of the
    // 2026-08-03 live test. Now: only genuinely slow turns (>1200ms) hear a
    // filler at all, the phrase rotates through short varied acknowledgments,
    // and the same phrase never plays twice in a row.
    const FILLER_MS = Number(process.env.VOICE_FILLER_MS || 1200);
    const FILLERS = [
      "Let me check.",
      "Mm-hm, one sec.",
      "Sure, let me see.",
      "Okay, checking.",
      "Let me pull that up.",
    ];
    const fillerTimer = substantive
      ? setTimeout(() => {
          if (this.turnCounter !== turnId || this.speakSuppressed || tFirstToken) return;
          let idx = Math.floor(Math.random() * FILLERS.length);
          if (idx === this.lastFillerIdx) idx = (idx + 1) % FILLERS.length;
          this.lastFillerIdx = idx;
          const filler = FILLERS[idx] + " ";
          this.ttsChars += filler.length;
          this.setState("speaking");
          this.send({ type: "eva_caption", text: filler });
          this.noteSpoken(filler);
          this.tts?.sendText(filler);
        }, FILLER_MS)
      : null;
    // DEAD-AIR CHECK-IN: observed live (turn stn78n:8) - filler at 1.4s,
    // then 18 seconds of SILENCE while the model hung; the parent gave up
    // and ended the call. One more short line at +8s keeps the call alive;
    // the root latency belongs to the model round, not this stopgap.
    const stillWorkingTimer = substantive
      ? setTimeout(() => {
          if (this.turnCounter !== turnId || this.speakSuppressed || tFirstToken) return;
          const line = "Sorry, this one's taking me a little longer. Almost there. ";
          this.ttsChars += line.length;
          this.send({ type: "eva_caption", text: line });
          this.noteSpoken(line);
          this.tts?.sendText(line);
        }, FILLER_MS + 8000)
      : null;

    const port = process.env.PORT || "5000";
    let done: any = null;
    metrics.marks.router_fetch_sent = Date.now();
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
          ...(sttProvenance ? { sttProvenance } : {}),
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
      let rawSoFar = "";
      let previewSent = false;
      const handleFrame = (json: any) => {
        if (this.turnCounter !== turnId) return; // superseded by a newer turn
        if (json.type === "token" && typeof json.delta === "string") {
          if (!tFirstToken) {
            tFirstToken = Date.now();
            metrics.marks.first_token = tFirstToken;
            log(`turn ${turnId}: sttFinal->firstToken ${tFirstToken - tSttFinal}ms`);
            if (this.state === "thinking") this.setState("speaking");
          }
          // A MATCH_CARD tag in the stream = a profile is coming. Tell the
          // client NOW so the profile UI opens while Eva is still talking,
          // instead of seconds later when the full card payload lands at done.
          if (!previewSent) {
            rawSoFar += json.delta;
            if (rawSoFar.includes("[[MATCH_CARD:")) {
              previewSent = true;
              this.send({ type: "cards_preview" });
            }
          }
          const safe = this.stripper.push(json.delta);
          if (safe) {
            // The budget releases complete NORMALIZED sentences until the
            // word ceiling; past it, one deferral line and silence. Captions
            // mirror speech exactly - unspoken text never paints.
            const speak = spokenBudget.push(safe);
            if (speak) {
              // After a barge the reply keeps streaming for persistence, but
              // neither audio NOR captions - captions crawling on after her
              // voice stopped read as a crash.
              if (!this.speakSuppressed) this.send({ type: "eva_caption", text: speak });
              this.chunker?.push(speak);
            }
          }
        } else if (json.type === "reset") {
          // An interceptor replaced the draft: silence what was queued and
          // start clean, mirroring the client's reset handling.
          this.tts?.cancel();
          this.tts = this.openTts(route);
          route?.interrupt();
          this.tts.onAudio((pcm) => {
            if (!this.speakSuppressed && this.turnCounter === turnId) this.deliverSpeech(pcm, route);
          });
          this.stripper.reset();
          this.chunker?.reset();
          spokenBudget.reset();
          this.send({ type: "caption_reset" });
        } else if (json.type === "done") {
          done = json;
          metrics.marks.router_done = Date.now();
          // Router-side timings (layer marks + per-tool durations) attached
          // by setupSSE's sendDone - merge them into this turn's record.
          if (json.__turnTimings) {
            metrics.routerMarks = json.__turnTimings.marks || null;
            metrics.toolCalls = json.__turnTimings.toolCalls || [];
            metrics.toolCallCount = metrics.toolCalls.length;
            metrics.interceptors = json.__turnTimings.interceptors || [];
          }
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
      // Explicit mark: the /chat fetch threw or the stream broke. Before
      // this, a turn with router_fetch_sent but no router_entry had to be
      // diagnosed by absence (session teardown vs real failure).
      metrics.marks.router_fetch_failed = Date.now();
      metrics.fetchError = String(err?.message || "pipeline failure").slice(0, 200);
      done = { error: err?.message || "pipeline failure" };
    }

    if (fillerTimer) clearTimeout(fillerTimer);
    if (stillWorkingTimer) clearTimeout(stillWorkingTimer);
    if (this.closed || this.turnCounter !== turnId) return;

    if (done?.retry || done?.error) {
      metrics.marks.turn_errored = Date.now();
      metrics.error = done?.error || "retry_needed";
      this.scheduleEmitMetrics(turnId);
      this.tts?.cancel();
      this.speakSystemLine("I'm sorry, something went wrong on my end. Could you say that again?");
      return;
    }

    if (done) {
      if (done.sessionId && !this.chatSessionId) this.chatSessionId = done.sessionId;
      // Ship the interactive payload (cards, quick replies) to the panel.
      // __turnTimings is server-side instrumentation - never forward it.
      const { type: _t, message: _m, __turnTimings: _tt, ...extras } = done;
      this.send({ type: "cards", payload: extras });

      const spokenText = this.stripper.emittedText().trim();
      const finalText =
        typeof done.message === "string" ? stripTags(done.message).trim() : "";
      if (!spokenText && !this.speakSuppressed) {
        const line = cardFallbackLine(done);
        if (line) {
          this.speakSystemLine(line);
          return;
        }
      } else if (spokenText && finalText && !this.speakSuppressed) {
        // The streamed draft must be a prefix of the persisted message. When
        // it is not, an upstream interceptor replaced the reply WITHOUT
        // emitting a reset frame - Eva just spoke words that are not in the
        // transcript. Backstop: wipe the caption and speak the real reply
        // (she corrects herself), and log loudly so the reset-less ai-router
        // path can be found and fixed at the source.
        const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
        const ns = norm(spokenText);
        const nf = norm(finalText);
        if (!nf.startsWith(ns.slice(0, 80))) {
          log(
            `turn ${turnId}: reply REPLACED upstream without reset - spoke "${ns.slice(0, 48)}..." ` +
              `but persisted "${nf.slice(0, 48)}...". Re-speaking the real reply. ` +
              `Root cause: an ai-router path mutates finalContent after streaming without sse.sendReset().`,
          );
          this.tts?.cancel();
          route?.interrupt();
          this.send({ type: "caption_reset" });
          // The re-spoken reply obeys the same ceiling + normalization as the
          // streamed path - the backstop must not reopen the monologue hole.
          spokenBudget.reset();
          const respeak = spokenBudget.push(finalText + " ") + spokenBudget.flush();
          this.send({ type: "eva_caption", text: respeak });
          this.tts = this.openTts(route);
          this.ttsChars += respeak.length;
          this.setState("speaking");
          const stream = this.tts;
          stream.onEnd(() => {
            route?.flushSpeech();
            this.finishSpeaking(turnId, route);
          });
          this.noteSpoken(forTts(respeak));
          stream.sendText(forTts(respeak) + " ");
          stream.flush();
          return;
        }
      }
    }

    // Flush the tail of the reply through TTS and hand back the floor.
    if (!this.speakSuppressed) {
      const tail = spokenBudget.flush();
      if (tail) {
        this.send({ type: "eva_caption", text: tail });
        this.chunker?.push(tail);
      }
      this.chunker?.flush();
      const stream = this.tts;
      stream?.onEnd(() => {
        route?.flushSpeech();
        this.finishSpeaking(turnId, route);
      });
      stream?.flush();
    } else if (this.turnCounter === turnId) {
      this.setState("listening");
    }
  }

  async destroy(reason: string) {
    if (this.closed) return;
    this.closed = true;
    // Flush any pending per-turn metrics before the session record closes.
    // A turn still awaiting its done frame is stamped with WHY it never got
    // one - the "router_fetch_sent but no router_entry" signature previously
    // had to be inferred (baseline turn 3g5s61:10 was exactly this: the
    // parent hung up ~2.5s in; the router completed fine afterward).
    for (const [, rec] of this.turnMetrics) {
      if (!rec.marks?.router_done && !rec.marks?.router_fetch_failed) {
        rec.sessionEndedBeforeDone = reason;
      }
    }
    for (const id of [...this.turnMetrics.keys()]) this.emitMetrics(id);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.capTimer) clearTimeout(this.capTimer);
    if (this.listenTimer) clearTimeout(this.listenTimer);
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
            endReason: reason,
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
              // Record the refusal - this is the signal the admin stats use to
              // answer "is the daily cap too low?".
              prisma.voiceSessionLog
                .create({
                  data: { userId: user.id, sessionId: "rejected", endedAt: new Date(), endReason: "daily_cap_rejected" },
                })
                .catch((err: any) => log(`daily-cap rejection log failed: ${err?.message}`));
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
