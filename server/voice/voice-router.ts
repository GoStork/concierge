import { Router, type Request, type Response } from "express";
import { resolveTtsProvider, resolveVoiceForProvider, voiceProviderStatus } from "./voice-gateway";
import { prisma } from "../db";

// HTTP companion to the voice WS gateway:
//   GET  /api/voice/providers - admin: which TTS/STT vendors have API keys set
//                               (drives key-gating in the admin Voice section)
//   POST /api/voice/preview   - admin: synthesize one sentence through the
//                               active provider and return audio for the
//                               "Preview voice" button

export const voiceRouter = Router();

// JWT Bearer fallback (mobile clients + test scripts) - same contract as
// chatRouter / aiRouter; Passport session auth still takes precedence.
voiceRouter.use(async (req: any, _res: any, next: any) => {
  if (!req.isAuthenticated?.()) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const jwt = (await import("jsonwebtoken")).default;
        const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET || "dev-jwt-secret-change-me") as any;
        if (payload?.sub) {
          const jwtUser = await prisma.user.findUnique({ where: { id: payload.sub } });
          if (jwtUser && !jwtUser.isDisabled) {
            req.user = jwtUser;
            req.isAuthenticated = () => true;
          }
        }
      } catch { /* invalid token - continue unauthenticated */ }
    }
  }
  next();
});

function requireAdmin(req: Request, res: Response): boolean {
  const user: any = req.user;
  if (!req.isAuthenticated?.() || !user) {
    res.status(401).json({ message: "Not authenticated" });
    return false;
  }
  if (!(user.roles || []).includes("GOSTORK_ADMIN")) {
    res.status(403).json({ message: "Admin access required" });
    return false;
  }
  return true;
}

voiceRouter.get("/api/voice/providers", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(voiceProviderStatus());
});

// ---------------------------------------------------------------------------
// Voice + avatar catalogs for the admin dropdowns: humans pick by NAME (and
// photo, for avatars), never by raw vendor id. Fetched live from each
// platform and cached in-memory for 10 minutes.
// ---------------------------------------------------------------------------
const catalogCache = new Map<string, { at: number; data: any }>();
const CATALOG_TTL_MS = 10 * 60 * 1000;
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.data as T;
  const data = await fn();
  catalogCache.set(key, { at: Date.now(), data });
  return data;
}

export interface VoiceOption {
  id: string;
  name: string;
  description?: string;
  gender?: string;
  age?: string;
  accent?: string;
  language?: string;
  previewUrl?: string;
  // True when the current plan cannot synthesize this voice via API (e.g.
  // ElevenLabs library voices on the Free tier). Shown greyed out with an
  // upgrade note instead of hidden, so admins know it exists.
  locked?: boolean;
  // ElevenLabs community-library search result not yet in the account;
  // selecting it (on a paid plan) adds it to My Voices first.
  library?: boolean;
  publicOwnerId?: string;
}

async function elevenLabsTier(key: string): Promise<string> {
  try {
    const sub = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": key },
    });
    if (sub.ok) return ((await sub.json()) as any)?.tier || "free";
  } catch {
    /* conservative default below */
  }
  return "free";
}

// Search ElevenLabs' community library (thousands of voices beyond the
// account's own list) - same catalog their Explore page browses.
async function searchElevenLabsLibrary(q: string): Promise<VoiceOption[]> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return [];
  const tier = await elevenLabsTier(key);
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/shared-voices?page_size=12&search=${encodeURIComponent(q)}`,
    { headers: { "xi-api-key": key } },
  );
  if (!resp.ok) return [];
  const body: any = await resp.json();
  return (body.voices || []).map((v: any) => ({
    id: v.voice_id,
    name: v.name,
    description: v.descriptive || undefined,
    gender: v.gender,
    age: v.age?.replace(/_/g, " "),
    accent: v.accent?.replace(/_/g, " "),
    language: v.language,
    previewUrl: v.preview_url || undefined,
    locked: tier === "free" ? true : undefined,
    library: true,
    publicOwnerId: v.public_owner_id,
  }));
}

// OpenAI's TTS voices are a fixed named set - no listing API.
const OPENAI_VOICES: VoiceOption[] = [
  { id: "shimmer", name: "Shimmer", description: "Warm, gentle female", gender: "female" },
  { id: "nova", name: "Nova", description: "Bright, friendly female", gender: "female" },
  { id: "coral", name: "Coral", description: "Calm, caring female", gender: "female" },
  { id: "sage", name: "Sage", description: "Soft, thoughtful female", gender: "female" },
  { id: "alloy", name: "Alloy", description: "Neutral, balanced", gender: "neutral" },
  { id: "onyx", name: "Onyx", description: "Deep, reassuring male", gender: "male" },
  { id: "echo", name: "Echo", description: "Clear, steady male", gender: "male" },
  { id: "fable", name: "Fable", description: "Expressive storyteller", gender: "neutral" },
  { id: "ash", name: "Ash", description: "Grounded, warm male", gender: "male" },
  { id: "ballad", name: "Ballad", description: "Smooth, melodic male", gender: "male" },
  { id: "verse", name: "Verse", description: "Versatile, energetic", gender: "neutral" },
  { id: "marin", name: "Marin", description: "Natural, conversational female", gender: "female" },
  { id: "cedar", name: "Cedar", description: "Rich, natural male", gender: "male" },
];

async function listElevenLabsVoices(): Promise<VoiceOption[]> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY not set");
  // Plan-aware filtering: the Free tier cannot synthesize "professional"
  // library voices via the API (payment_required) - offering them in the
  // dropdown guarantees a failure at preview/session time. Hide what the
  // current plan cannot use; the list self-heals after an upgrade (10 min
  // cache) because the tier is re-checked.
  let tier = "free";
  try {
    const sub = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": key },
    });
    if (sub.ok) tier = ((await sub.json()) as any)?.tier || "free";
  } catch {
    /* tier check failed - keep the conservative default */
  }
  const resp = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", {
    headers: { "xi-api-key": key },
  });
  if (!resp.ok) throw new Error(`ElevenLabs voices ${resp.status}`);
  const body: any = await resp.json();
  const usableOnFree = new Set(["premade", "generated", "cloned"]);
  return (body.voices || []).map((v: any) => ({
    id: v.voice_id,
    name: v.name,
    description: v.labels?.descriptive || undefined,
    gender: v.labels?.gender,
    age: v.labels?.age?.replace(/_/g, " "),
    accent: v.labels?.accent?.replace(/_/g, " "),
    language: v.labels?.language,
    previewUrl: v.preview_url || undefined,
    locked: tier === "free" && !usableOnFree.has(v.category) ? true : undefined,
  }));
}

async function listCartesiaVoices(): Promise<VoiceOption[]> {
  const key = process.env.CARTESIA_API_KEY;
  if (!key) throw new Error("CARTESIA_API_KEY not set");
  const resp = await fetch("https://api.cartesia.ai/voices/?limit=100", {
    headers: { "X-API-Key": key, "Cartesia-Version": "2025-04-16" },
  });
  if (!resp.ok) throw new Error(`Cartesia voices ${resp.status}`);
  const body: any = await resp.json();
  return (body.data || []).map((v: any) => ({
    id: v.id,
    name: v.name,
    description: v.description || undefined,
    language: v.language || undefined,
    gender: v.gender || undefined,
  }));
}

// Real-world cap feedback for the admin: are parents actually hitting the
// session/daily caps, and how long do they really talk?
voiceRouter.get("/api/voice/stats", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    const rows = await prisma.voiceSessionLog.findMany({
      where: { startedAt: { gte: since } },
      select: { userId: true, seconds: true, endReason: true, avatarSeconds: true, ttsChars: true },
    });
    const rejections = rows.filter((r) => r.endReason === "daily_cap_rejected");
    const sessions = rows.filter((r) => r.endReason !== "daily_cap_rejected");
    const durations = sessions.map((s) => s.seconds).sort((a, b) => a - b);
    const pct = (p: number) =>
      durations.length ? durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))] : 0;
    res.json({
      days,
      sessions: sessions.length,
      uniqueParents: new Set(rows.map((r) => r.userId)).size,
      totalMinutes: Math.round(sessions.reduce((a, s) => a + s.seconds, 0) / 60),
      avatarMinutes: Math.round(sessions.reduce((a, s) => a + (s.avatarSeconds || 0), 0) / 60),
      avgSessionSeconds: sessions.length
        ? Math.round(sessions.reduce((a, s) => a + s.seconds, 0) / sessions.length)
        : 0,
      p50SessionSeconds: pct(50),
      p90SessionSeconds: pct(90),
      sessionCapHits: sessions.filter((s) => s.endReason === "session_cap").length,
      silenceTimeouts: sessions.filter((s) => s.endReason === "silence_timeout").length,
      dailyCapRejections: rejections.length,
      notConfiguredFailures: sessions.filter((s) => s.endReason === "voice_not_configured").length,
    });
  } catch (err: any) {
    console.error(`[voice] stats failed: ${err?.message}`);
    res.status(500).json({ message: `Stats failed: ${err?.message}` });
  }
});

voiceRouter.get("/api/voice/options/voices", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const provider = String(req.query.provider || "elevenlabs");
  const q = String(req.query.q || "").trim();
  try {
    let voices: VoiceOption[];
    if (provider === "openai") voices = OPENAI_VOICES;
    else if (provider === "cartesia") voices = await cached("cartesia-voices", listCartesiaVoices);
    else {
      voices = await cached("elevenlabs-voices", listElevenLabsVoices);
      if (q.length >= 2) {
        // Extend the search into the community library, deduped against the
        // voices already in the account.
        const inAccount = new Set(voices.map((v) => v.id));
        const library = (await searchElevenLabsLibrary(q)).filter((v) => !inAccount.has(v.id));
        voices = [...voices, ...library];
      }
    }
    res.json({ provider, voices });
  } catch (err: any) {
    console.error(`[voice] voice catalog failed (${provider}): ${err?.message}`);
    res.status(502).json({ message: `Could not load ${provider} voices: ${err?.message}` });
  }
});

// Add a community-library voice to the account (needed before it can be
// selected/synthesized). Reachable only for non-locked results, i.e. paid
// plans - the Free tier shows library voices locked.
voiceRouter.post("/api/voice/library/add", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { voiceId, publicOwnerId, name } = req.body || {};
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return res.status(503).json({ message: "ELEVENLABS_API_KEY not set" });
  if (!voiceId || !publicOwnerId) return res.status(400).json({ message: "voiceId and publicOwnerId required" });
  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/voices/add/${encodeURIComponent(publicOwnerId)}/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ new_name: name || "Library voice" }),
      },
    );
    if (!resp.ok) throw new Error(`ElevenLabs add ${resp.status}: ${await resp.text()}`);
    catalogCache.delete("elevenlabs-voices"); // account list changed
    res.json({ ok: true });
  } catch (err: any) {
    console.error(`[voice] library add failed: ${err?.message}`);
    res.status(502).json({ message: `Could not add library voice: ${err?.message}` });
  }
});

export interface AvatarOption {
  id: string;
  name: string;
  imageUrl?: string;
  kind: "custom" | "preset";
  gender?: string;
  orientation?: "landscape" | "portrait";
  previewVideoUrl?: string;
}

// Gender for LiveAvatar presets whose first names don't appear in HeyGen's
// labeled catalog. Curated from the preset thumbnails themselves - UI filter
// metadata only, never used for anything else. Unknown names simply carry no
// gender and appear under the "All" filter.
const PRESET_NAME_GENDER: Record<string, string> = {
  katya: "female", alessandra: "female", amina: "female", anastasia: "female",
  marianne: "female", rika: "female",
  graham: "male", anthony: "male", pedro: "male", thaddeus: "male", wayne: "male", santa: "male",
};

const assetHash = (u?: string) => u?.match(/avatar\/v3\/([a-f0-9]{32})/)?.[1] || null;

// HeyGen's public avatar catalog carries gender labels and mp4 talking
// previews for many of the same underlying avatars - join by asset hash
// (exact) and by unambiguous first name.
async function heygenEnrichment(): Promise<{
  byHash: Map<string, any>;
  genderByFirstName: Map<string, string>;
}> {
  const byHash = new Map<string, any>();
  const genderByFirstName = new Map<string, string>();
  const key = process.env.HEYGEN_API_KEY;
  if (!key) return { byHash, genderByFirstName };
  try {
    const resp = await fetch("https://api.heygen.com/v2/avatars", { headers: { "X-Api-Key": key } });
    if (!resp.ok) return { byHash, genderByFirstName };
    const avatars: any[] = ((await resp.json()) as any)?.data?.avatars || [];
    const ambiguous = new Set<string>();
    for (const a of avatars) {
      const h = assetHash(a.preview_video_url);
      if (h) byHash.set(h, a);
      const fn = (a.avatar_name || "").split(" ")[0].toLowerCase();
      if (fn && a.gender) {
        const prev = genderByFirstName.get(fn);
        if (prev && prev !== a.gender) ambiguous.add(fn);
        genderByFirstName.set(fn, a.gender);
      }
    }
    for (const fn of ambiguous) genderByFirstName.delete(fn);
  } catch (err: any) {
    console.error(`[voice] HeyGen enrichment failed (avatars stay unlabeled): ${err?.message}`);
  }
  return { byHash, genderByFirstName };
}

async function listLiveAvatars(): Promise<AvatarOption[]> {
  const key = process.env.LIVEAVATAR_API_KEY || process.env.HEYGEN_API_KEY;
  if (!key) throw new Error("LIVEAVATAR_API_KEY not set");
  const headers = { "X-API-KEY": key };
  const { byHash, genderByFirstName } = await heygenEnrichment();

  const enrich = (a: any, kind: "custom" | "preset"): AvatarOption => {
    const firstName = (a.name || "").split(" ")[0].toLowerCase();
    const joined = byHash.get(assetHash(a.preview_url) || "");
    return {
      id: a.id,
      name: a.name,
      imageUrl: a.preview_url || undefined,
      kind,
      gender: joined?.gender || genderByFirstName.get(firstName) || PRESET_NAME_GENDER[firstName] || undefined,
      orientation: /\(portrait\)/i.test(a.name || "") ? "portrait" : "landscape",
      previewVideoUrl: joined?.preview_video_url || undefined,
    };
  };

  const out: AvatarOption[] = [];
  // Custom avatars (created from persona photos) come first.
  const custom = await fetch("https://api.liveavatar.com/v1/avatars", { headers });
  if (custom.ok) {
    const body: any = await custom.json();
    for (const a of body?.data?.results || []) out.push(enrich(a, "custom"));
  }
  let url: string | null = "https://api.liveavatar.com/v1/avatars/public?page_size=50";
  while (url) {
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`LiveAvatar public avatars ${resp.status}`);
    const body: any = await resp.json();
    for (const a of body?.data?.results || []) out.push(enrich(a, "preset"));
    url = body?.data?.next || null;
  }
  return out;
}

voiceRouter.get("/api/voice/options/avatars", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json({ avatars: await cached("liveavatar-avatars", listLiveAvatars) });
  } catch (err: any) {
    console.error(`[voice] avatar catalog failed: ${err?.message}`);
    res.status(502).json({ message: `Could not load avatars: ${err?.message}` });
  }
});

voiceRouter.post("/api/voice/preview", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const text: string =
    typeof req.body?.text === "string" && req.body.text.trim()
      ? req.body.text.trim().slice(0, 200)
      : "Hi, I'm Eva, your personal fertility concierge. It's lovely to meet you.";
  let voiceId: string | null =
    typeof req.body?.voiceId === "string" && req.body.voiceId.trim()
      ? req.body.voiceId.trim()
      : null;

  const settings: any = await prisma.siteSettings.findFirst();
  const providerName = req.body?.provider || settings?.voiceTtsProvider || "elevenlabs";
  // Voice ids are provider-specific; without an explicit id, preview the
  // provider's built-in fallback voice.
  voiceId = voiceId || resolveVoiceForProvider(providerName, null, null) || null;

  const provider = resolveTtsProvider(providerName);
  if (!provider || !provider.isConfigured()) {
    return res.status(503).json({ message: `TTS provider "${providerName}" is not configured (API key missing)` });
  }
  if (!voiceId) {
    return res.status(400).json({ message: "No voice selected for this provider - choose a voice in the persona form first" });
  }

  try {
    const chunks: Buffer[] = [];
    const stream = provider.openStream({ voiceId });
    const pcm = await new Promise<Buffer>((resolve, reject) => {
      const timeout = setTimeout(() => {
        stream.close();
        reject(new Error("preview synthesis timed out (15s)"));
      }, 15_000);
      stream.onAudio((buf) => chunks.push(buf));
      stream.onEnd(() => {
        clearTimeout(timeout);
        stream.close();
        resolve(Buffer.concat(chunks));
      });
      stream.onError((err) => {
        clearTimeout(timeout);
        stream.close();
        reject(err);
      });
      stream.sendText(text + " ");
      stream.flush();
    });

    // Wrap raw 16kHz mono PCM in a WAV header so the browser can play it.
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(16000 * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    res.setHeader("Content-Type", "audio/wav");
    res.send(Buffer.concat([header, pcm]));
  } catch (err: any) {
    console.error(`[voice] preview failed: ${err?.message}`);
    res.status(502).json({ message: `Voice preview failed: ${err?.message}` });
  }
});
