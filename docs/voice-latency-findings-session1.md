# Voice pipeline - Session 1 findings (instrumentation only)

Date: 2026-08-02. Scope: instrumentation + code-path tracing for the
concierge-brief-v3 diagnostic. NO behavior was changed - every edit is a
timestamp, a log line, or an additive message field.

## 1. Where the Cartesia bytes actually go (Section E1 answer)

The audio path is EXCLUSIVE per reply, not dual. `deliverSpeech()` in
`server/voice/voice-gateway.ts` routes each TTS PCM chunk to exactly one of
two destinations, chosen by a route snapshot taken ONCE at the start of each
reply (`const route = this.avatar`):

- **Avatar route** (snapshot non-null): 16kHz PCM is upsampled to 24kHz and
  pushed over LiveAvatar's session WebSocket as base64 `agent.speak` frames
  (`heygen-avatar.ts`). HeyGen lip-syncs it and streams synced audio+video
  into a LiveKit room; the browser hears it via the LiveKit audio track
  attached to an `<audio>` element in `AvatarVideo.tsx`. The raw Cartesia
  bytes never reach the browser on this route.
- **WS-PCM route** (snapshot null): raw PCM goes down our voice WebSocket and
  plays through a Web Audio AudioWorklet ring buffer (`lib/voice/audio.ts`).
  There is NO `<audio>` element on this path. The avatar - if one connects -
  receives nothing and keeps playing its idle loop.

So the brief's hypothesis ("audio played by the browser on a path that is not
driving lip-sync") is structurally half right: it is never BOTH at once, but
several windows put a live avatar on screen while audio plays on the WS-PCM
path, producing exactly the idle-mouth-over-speech signature:

1. **The greeting race.** The gateway sends `ready` immediately and gives the
   avatar handshake only 3s before speaking the greeting; the route is
   snapshotted at speak time. Our fresh smoke run reproduced this: turn 1
   fired before the handshake finished and ran `avatarActive=false` (local
   audio, avatar idle), turn 2 ran on the avatar route. The desktop trace's
   7s greeting at 0.93x idle motion with r~0 matches this window exactly.
2. **Any reply started before the avatar connects mid-session** (same
   snapshot rule, deliberate - splitting one reply across outputs would
   garble it), including after the auto-reconnect path, which starts a FRESH
   avatar session while the conversation continues.
3. **Avatar start failure fallback** (audio-only, loudly logged).

For the four utterances that showed elevated-but-uncorrelated mouth motion:
those are consistent with the avatar route + LiveKit degradation. Note
`AvatarVideo` joins with `adaptiveStream: true` - LiveKit deliberately
degrades/pauses the VIDEO track for small or occluded elements (the 84x120
PiP) while the audio track keeps playing. That would also explain E2's
framerate collapse beginning exactly at the first navigation (PiP mode) while
steady-state fullscreen was rock solid. The new per-turn fields
(`avatarActive`, `local_pcm_play_start` vs `livekit_audio_element_playing`)
now disambiguate the route per utterance in one recorded session.

## 2. Turn latency attribution (Section E0 instrumentation)

One JSON line per voice turn is now emitted to the server log:
`[TURN_METRICS] {...}` - grep it and load into a dataframe:

```
grep -o '\[TURN_METRICS\] {.*}' /tmp/gostork-server.log | sed 's/^\[TURN_METRICS\] //' > turns.jsonl
```

Fields (all epoch ms; gateway and router share one process/clock):
- `corrId` (sessionPrefix:turnId), `turn`, `userText`, `avatarActive`,
  `ttsProvider`, `fixedReply`
- `toolCallCount` (top-level, as requested) and `toolCalls[]` with
  `{name, tStart, tEnd, ms}` - recorded by a single wrapper around
  `mcpClient.callTool`, covering all ~25 call sites
- `marks{}`: `speech_final`, `router_fetch_sent`, `first_token`,
  `tts_ws_open`, `tts_first_text_sent`, `tts_first_audio`, `tts_last_audio`,
  `tts_generation_done`, `avatar_first_speak_submitted` (first agent.speak
  frame actually sent - the "LiveAvatar task submitted" boundary),
  `avatar_playhead_drain_expected`, `back_to_listening`, `router_done`
- `routerMarks[]` from inside `/api/ai-concierge/chat` (attached to the SSE
  done frame as `__turnTimings`, stripped before anything reaches a client):
  `router_entry`, `context_sections_loaded`, `skip_directives_done`,
  `bypass_served`, `prework_done_tier1|tier2`, `tier1_start/end`,
  `tier2_start/end`, `tier2_round_N`, `done_sent`
- `client{}`: browser-reported events (`caption_painted` via double-rAF
  after the first caption chunk commits, `local_pcm_play_start`,
  `livekit_audio_element_playing`, `remote_audio_first` = first audible
  energy on the LiveKit track, the closest current proxy for "first speech
  frame" client-side). Each carries `tClient` (browser clock) and
  `tServerRecv` (server clock) - use `tServerRecv` for cross-boundary
  ordering, `tClient` only for client-internal deltas.
- `derived{}`: the headline spans precomputed (`stt_to_first_token_ms`,
  `stt_to_first_audio_ms`, `router_total_ms`, `tools_total_ms`, ...).

Deepgram `speech_final` note: the gateway's `speech_final` mark is stamped
when the STT final callback fires (the earliest the server knows the user
stopped) - Deepgram endpointing delay sits upstream of it and is not yet
separately measured.

**Early evidence from the smoke turns (fresh, on gostork.ngrok.app):** even a
turn served by a deterministic bypass paid ~1.5s before its first token, of
which ~1.1s was `context_sections_loaded` (session/profile/prompt-section
loading) - i.e. meaningful pre-model cost exists on EVERY turn, before any
tier or tool runs. A Tier1 turn showed prework 1.9s + Tier1 1.5s. This is
consistent with the E0 median but the 4x spread attribution (tool calls) still
needs the 10-15 turn run.

## 3. Which router layers call tools

The "4 layers" are routing ALTERNATIVES, not sequential stages - a turn is
served by exactly one of them, after shared pre-work that every turn pays:

- **Shared pre-work** (`router_entry` -> `context_sections_loaded` ->
  `skip_directives_done` -> `prework_done_*`): session load, profile, RAG,
  prompt assembly. No MCP tool calls, but it does DB + embedding work and is
  1-2.5s in fresh measurements. Serialized before everything.
- **Layer 1 - deterministic bypasses** (19 marked sites: lawyer connect,
  review, Phase 0 Part2/PathB/Q&A, Phase 1, schedule-with-concierge, ...):
  NO model, NO tools (rare direct card resolution aside). Fast path.
- **Layer 2 - intake state machine**: decision logic inside pre-work/prompt
  assembly; not a separately-timed model stage. No tools itself.
- **Layer 3 - Tier 1 Gemini** (`callTier1Gemini`): NO tools at all - it
  cannot call any. Streams tokens live.
- **Layer 4 - Tier 2** (`callTier2Claude`, actually gemini-3.5-flash with
  function calling): the ONLY tool-calling layer. Tool rounds (up to 8) run
  BEFORE the text round; there are also post-model tool calls outside the
  tiers (card resolution `resolve_match_card`/`resolve_provider`, whisper
  paths) that run between `tier2_end` and `done_sent`. All are captured by
  the callTool wrapper regardless of location.

## 4. Which paths could commit to an opening sentence before tool resolution (A0)

Today's streaming reality (relevant to the two-channel design):

- **Tier 1 and bypasses**: stream/emit text immediately, no tools - already
  effectively "channel 1"; nothing blocks them except shared pre-work.
- **Tier 2, text-only turns**: TRUE streaming with an 80-char peek window
  (`streamTurn`) - tokens reach the voice gateway (and TTS) as Gemini
  produces them. Also already streamable.
- **Tier 2, tool turns**: the model decides its own tool use, so NOTHING is
  emitted until the last tool round finishes - the model text in a tool round
  is deliberately held (the round usually opens with a functionCall). This is
  where A0's serialization lives. Candidates that could commit to an opening
  sentence early, because the tool result changes what Eva SHOWS, not what
  she SAYS: pre-searched ready turns (the search result is known before the
  model writes - an opening line like "Let me show you who I found" is
  path-determined), and post-model card/provider resolution (text is already
  final when those tools run - speech could start immediately; today the
  done frame waits for them). Candidates that CANNOT stream: turns where the
  tool result determines the sentence content (cost answers, availability,
  knowledge-base answers) - the brief's fallback-to-blocking rule applies.
- **Two paths mutate `finalContent` after streaming without a reset frame**
  (the gateway logs `reply REPLACED upstream` and re-speaks) - any streaming
  contract must fix those at the source first; they are the existing
  known-unsafe streamers.

## 5. LiveAvatar session lifecycle: hand-rolled vs LiveKit plugin

We hand-roll everything: `POST /v1/sessions/token` -> `POST
/v1/sessions/start` -> raw WS (`agent.speak` base64 frames, keep-alive every
15s, `agent.interrupt`), playhead tracked by arithmetic
(`remainingSpeechMs()`), teardown via socket close + best-effort
`/v1/sessions/stop`. The browser side joins LiveKit directly with
`livekit-client` (dynamic import), manual track attach + chroma-key canvas.
We do NOT use LiveKit's agent-session LiveAvatar plugin - and cannot without
an architecture change: the plugin belongs to LiveKit's Agents framework
(a Python/Node agent process owning the session), while our gateway is a
bespoke WS bridge inside Express. Adopting it would replace the hand-rolled
token/start/WS/keep-alive/reconnect code but would also mean running the
voice pipeline as a LiveKit Agent - a much bigger move than the remount fix
(which was already solved app-side by the persistent VoiceSessionProvider).

**New discovery (from the instrumentation run):** LiveAvatar's WS emits
`agent.audio_buffer_appended`, `agent.speak_started`, `agent.speak_ended`,
`agent.idle_started`, `agent.idle_ended` - all with task ids - and we ignore
every one of them. `agent.speak_started` is the true "avatar began speaking"
callback (B4's unresolved question) and `agent.speak_ended` is the exact
playhead-drain signal that `remainingSpeechMs()` currently estimates by
arithmetic. First-seen events are now logged as `[voice][avatar-evt]`.

Measured on this host: avatar handshake (token + start + WS connected) is
logged per session (`avatar handshake took Nms`); the smoke sessions also
showed LiveAvatar speak_started arriving ~200ms after the first
`agent.speak` frame - supporting the brief's "sub-second avatar hop" claim,
to be confirmed across the 10-15 turn run.

## 6. Environment / measurement-hygiene notes

- All fresh numbers here were collected against `https://gostork.ngrok.app`.
- **B5 mic-permission (~1.7s):** desktop Chrome/Safari persist mic permission
  per origin, so on desktop this cost should now be gone (verify once in the
  browser session of the measurement run). iOS Safari re-prompts per session
  by OS design regardless of origin stability - on iPhone the only removal is
  the user-side Safari AA menu -> Website Settings -> Microphone -> Allow.
  So B5's line item splits: desktop 0, iOS unchanged-by-domain-move.
- Client clocks are not the server clock: use `tServerRecv` for cross-machine
  ordering (WS transit on this LAN is small but not zero).
- Section F remains untouched per scope.

## 6b. Session 1b addendum - caption events split + pre-work sub-marks

**Caption events (replaces the conflated `caption_painted`):**
- `user_transcript_painted` - last paint of the parent's OWN transcript,
  captured on partial-transcript paints and reported retroactively when the
  turn id arrives (partials precede the turn frame).
- `agent_caption_first_painted` - first paint of Eva's caption this turn.
- `agent_caption_full_painted` - paint after the caption completed (reported
  on the `cards` frame, which follows the last caption chunk); carries
  `extra.captionChunks` - 1 chunk = painted as a block, many = streamed.
The 2ms-after-speech_final artifact in the verification turn came from the
verification script sending a synthetic `caption_painted` at turn start; the
real client also only had the single conflated event. Both fixed.

**Pre-work sub-marks now in `routerMarks`:** span 1 is bracketed by `pw:*`
marks (auth_user_loaded, session_resolved, user_msg_saved,
session_flags_loaded, tier2_lookups_kickoff, history_user_tools_loaded,
memory_block_start/done, handoff_scan_start, consult_lookup_start,
billing_context_start, consultation_locks_start, match_gates_start,
ip_form_start, prompt_sections_start) plus
`prompt_sections_cache_hit` / `prompt_sections_db_fetch_start/done`.
Span 2 has `pw2:*` marks (intercepts_evaluated, bypasses_evaluated,
prompt_sections2_start/done, d1_carrier|dcycle|intake_costs_start/done).
Consecutive-mark deltas attribute the whole span; conditional items
(D1 costs) carry their own start/done pair so skipping them cannot
mis-attribute time.

**First fresh breakdown (one Tier1 intake turn):** span 1 = 1032ms was ~13
SEQUENTIAL Supabase round trips: auth 20ms, session resolution 80ms, message
save 27ms, session flags 23ms, history+user+matchmaker+MCP-tools Promise.all
157ms, memory block 38ms, journey-state block (handoff scan 127ms, consult
lookup 145ms, billing 71ms, consultation locks 110ms, gates 34ms, IP form
18ms) = ~505ms, prompt-sections DB fetch 164ms (30s cache expired). Span 2 =
693ms was almost entirely ONE item: `getD1CountryCosts` 671ms (agency
discovery SQL + sequential per-agency combined-cost computations, three
countries in parallel).

Classification (analysis only - nothing changed):
- **Genuinely per-turn:** user-message persist (~27ms); chat-history CONTENT
  (though it is refetched in full each turn); explicit memory capture (regex-
  gated, rare).
- **Per-session** (stable within a session, refetched every turn today):
  auth user, session access + account member ids, session flags, matchmaker
  row, user record + intended-parent profile, concierge memory block, and
  the entire journey-state block (handoffs, upcoming consult, quotes/
  invoices/agreements, consultation locks, latest card, gates, IP form) -
  all change on discrete events (booking, billing, capture), not per turn.
  This is roughly 700-850ms of span 1 on a warm turn.
- **Effectively static, redone for lack of caching:** prompt sections (admin
  text, 30s TTL -> a ~164ms fetch every 30s, called twice per turn with the
  second call cached); MCP tool list (5min TTL, usually free); and the D1
  country-cost aggregate - cost sheets change on admin approval, parent
  coverage changes per session, yet the full multi-query aggregation reruns
  on every intake-education turn. Largest single known item in the pipeline.

## Session 2 - Task 3 investigation: LLM rounds (report, no implementation)

**The 9.3s "gap between the 5th and 6th tool call" on turn 9 is not a tool
round at all.** Reconstructing turn 9 from its marks: tier-2 ran 1.25s ->
5.31s (round 1 model ~1.3s -> search_sperm_donors 267ms -> round 2 model
~1.2s -> resolve_match_card 114ms -> text round ~1.2s, first_token at 5.15s,
`tier2_end` at 5.31s). Everything after that is POST-PROCESSING: the
QUESTION INTERCEPTOR (ai-router ~7584) decided the reply wrongly showed a new
match card while the parent had asked a question, fetched the profile (the
"5th tool call", search_sperm_donors at 5.34s), then called `claudeRetry` -
which despite its name is **gemini-3.5-flash, NON-streaming, and without
`thinkingBudget: 0`** - to regenerate the entire reply with full history +
profile data. That call is the 9.3s (6.6s on turn 11). The hidden thinking
phase this project already measured at ~7s (2026-07-17) was never disabled in
this one code path. The "6th tool call" is just card hydration after the
replacement. Compounding harm: the interceptor fires after the text already
streamed (and was already SPOKEN in voice mode), so Eva audibly corrects
herself ~7-9s later and the card waits for `done`.

Both intercepted turns were triggered by endpointing fragments ("That's what
I wanted to tell you to" matches the question regex via "what") - the Task 1
fix removes most triggers organically.

**Q1 - can independent tool calls share a round?** The observed
search -> resolve_match_card chain is data-dependent (resolve needs the id
from the search result), so those rounds cannot merge. When the model DOES
emit multiple calls in one round, we execute them sequentially in a for-loop
(callTier2Claude round loop + execCallsForReplay) - parallelizing that loop
is safe for these read-only tools but the observed rounds carried one call
each, so the win is small. The proven big lever is the existing ready-turn
`preSearch` (server runs the known-required search before round 1, collapsing
decide-then-write into one round) - extending it to more predictable turns
removes whole rounds, which at ~1.2s of model time per round is the real
variable cost.

**Q2 - the 9.3s generation:** answered above (`claudeRetry`, thinking
enabled, non-streaming, full-reply regeneration). Cheapest fixes when
implementation is authorized: `thinkingBudget: 0` on `claudeRetry` (one
line, expected to remove ~5-7s), and/or streaming the replacement.

**Q3 - smaller model for tool-selection rounds?** Not feasible per-round
inside one Gemini ChatSession: Gemini 3.x functionCall parts carry
thought_signatures that cannot be forged or transplanted across models (the
history-repair comment in callTier2Claude documents the 400s). Splitting
models would require restructuring to manual-history generateContent calls.
`TIER2_MODEL` already exists as a whole-turn A/B knob (e.g. flash-lite) and
any change must pass the 73-test suite. Recommendation: don't split models -
kill the claudeRetry thinking cost and reduce round count via preSearch.

## Session 2 - fixes shipped (2026-08-02 evening)

**Task 1 - premature endpointing: FIXED, acceptance PASS.**
Root cause was worse than the brief's: the gateway dispatched a turn on
Deepgram `is_final` (SEGMENT finalization), not `speech_final`/utterance end
- every finalized segment became a turn. Baseline splits confirmed from the
log (turn 7/8: "I want you to keep the profile" discarded, Eva answered
"while I'm talking to you."). Fix, in layers:
- deepgram-stt.ts accumulates finalized segments and dispatches ONE utterance
  on the earliest of: UtteranceEnd (`utterance_end_ms=1200`, newly enabled),
  a punctuated speech_final + 1400ms hold (`VOICE_DISPATCH_HOLD_MS`; sized
  for Deepgram's ~300-800ms interim latency - 800ms lost the race), or a 2s
  idle fallback (a VAD-gated mic can freeze Deepgram's audio clock).
- Client VAD hangover 900 -> 1600ms (UtteranceEnd needs >1200ms of DELIVERED
  silence or it can never fire).
- Gateway supersession now ALWAYS merges spoken fragments (the 1.5s window
  discarded first halves), covers early-`speaking` (<4s) as well as
  `thinking`, never merges chip/fixedReply actions, and emits
  `superseded/discardedText/mergedIntoNext` in TURN_METRICS.
Acceptance (15 synthesized turns, real Deepgram, mid-sentence pauses
600-1100ms): 15/15 single turns, 0 superseded, 0 apologies. Trade-off:
dispatch now waits ~1.2-1.5s of true silence (was ~0.4s but mid-sentence);
the filler still masks router time.

**Task 2 - pre-work parallelised (call ordering only, zero caching).**
All journey-state reads (memory block, handoffs, upcoming consult,
quotes/invoices/agreements, consultation locks, latest-card/gates chain, IP
form) now start together right after the user record loads and are awaited
where consumed; prompt-sections fetch starts at handler entry; household
expansion folded into the existing Promise.all (3 duplicate queries
removed); D1 country costs speculatively started for non-tier2 sessions so
intake turns overlap its ~550ms. Measured (15-turn run, intake-path turns):
entry->context median 472ms (was 900-1130), best 283ms; entry->prework_done
median 929ms - still D1-bound on intake turns; tier2 turns (no D1) should
land ~450-550ms. The <300ms target is not fully met: the floor is now the
serial auth/session chain (~130ms) + the slowest single read (full chat
history / booking lookup, ~150-350ms on the remote pooler). Next lever would
be caching or history-tail fetches - deliberately out of scope per the brief.

**Task 4 - adaptiveStream A/B: instrumented, awaiting the manual run.**
`localStorage.voiceAdaptiveStream = "off"` (new call) joins LiveKit with
adaptiveStream disabled; delete the key to restore. AvatarVideo now measures
decoded fps via requestVideoFrameCallback and reports fps + delivered track
resolution + element size every 2s; the gateway logs it as
`[voice] avatar fps: ... | track WxH | element WxH | adaptiveStream=...`.
Run the navigation sequence twice (on/off) and compare those log lines; if
adaptiveStream is the cause, the "off" run holds ~25fps and full resolution
in the PiP while "on" shows resolution drops/0fps windows.

**Found along the way:**
- **Cartesia account out of credits** - every TTS request returns 402;
  live voice is SILENT until the account is topped up. The 402 also broke
  the state machine during the first acceptance attempt (states hang when
  no audio is ever produced).
- **Surprise-face fallback removed**: `maybeStartAvatar` fell back to
  `SiteSettings.voiceDefaultAvatarId` when the persona had no avatar,
  contradicting the "no persona avatar = audio-only" rule (b16ae7c1) and
  silently consuming LiveAvatar credits; persona is now the sole source.
- Test persona "E2E Endpointing Test" (b8eb393a..., isActive=false, Cartesia
  voice, no avatar) exists for harness runs; scratchpad harness synthesizes
  speech with `say` and real mid-sentence silences.

## 7. Next session (the experiment)

Run 10-15 voice turns of varying complexity, then:

```
grep -o '\[TURN_METRICS\] {.*}' /tmp/gostork-server.log | sed 's/^\[TURN_METRICS\] //' > turns.jsonl
# pandas: df = pd.read_json("turns.jsonl", lines=True)
# x = df.toolCallCount, y = df.derived.str["stt_to_first_audio_ms"]
```

A near-linear relationship confirms A0. The per-mark columns additionally
split each slow turn into prework / tier / tool / TTS / avatar components, so
even a non-linear result is attributable.
