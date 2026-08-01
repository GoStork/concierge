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
  // Voice ids are provider-specific - resolve for the provider being previewed.
  voiceId = voiceId || resolveVoiceForProvider(providerName, null, null, settings || {}) || null;

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
