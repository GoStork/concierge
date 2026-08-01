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
  return (body.voices || [])
    .filter((v: any) => tier !== "free" || usableOnFree.has(v.category))
    .map((v: any) => ({
      id: v.voice_id,
      name: v.name,
      description: v.labels?.descriptive || undefined,
      gender: v.labels?.gender,
      age: v.labels?.age?.replace(/_/g, " "),
      accent: v.labels?.accent?.replace(/_/g, " "),
      language: v.labels?.language,
      previewUrl: v.preview_url || undefined,
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

voiceRouter.get("/api/voice/options/voices", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const provider = String(req.query.provider || "elevenlabs");
  try {
    let voices: VoiceOption[];
    if (provider === "openai") voices = OPENAI_VOICES;
    else if (provider === "cartesia") voices = await cached("cartesia-voices", listCartesiaVoices);
    else voices = await cached("elevenlabs-voices", listElevenLabsVoices);
    res.json({ provider, voices });
  } catch (err: any) {
    console.error(`[voice] voice catalog failed (${provider}): ${err?.message}`);
    res.status(502).json({ message: `Could not load ${provider} voices: ${err?.message}` });
  }
});

export interface AvatarOption {
  id: string;
  name: string;
  imageUrl?: string;
  kind: "custom" | "preset";
}

async function listLiveAvatars(): Promise<AvatarOption[]> {
  const key = process.env.LIVEAVATAR_API_KEY || process.env.HEYGEN_API_KEY;
  if (!key) throw new Error("LIVEAVATAR_API_KEY not set");
  const headers = { "X-API-KEY": key };
  const out: AvatarOption[] = [];
  // Custom avatars (created from persona photos) come first.
  const custom = await fetch("https://api.liveavatar.com/v1/avatars", { headers });
  if (custom.ok) {
    const body: any = await custom.json();
    for (const a of body?.data?.results || []) {
      out.push({ id: a.id, name: a.name, imageUrl: a.preview_url || undefined, kind: "custom" });
    }
  }
  let url: string | null = "https://api.liveavatar.com/v1/avatars/public?page_size=50";
  while (url) {
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`LiveAvatar public avatars ${resp.status}`);
    const body: any = await resp.json();
    for (const a of body?.data?.results || []) {
      out.push({ id: a.id, name: a.name, imageUrl: a.preview_url || undefined, kind: "preset" });
    }
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
    return res.status(400).json({ message: "No voice ID: set a default voice or pass voiceId" });
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
