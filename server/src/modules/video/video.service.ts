import { Injectable, Logger, Inject, OnModuleInit } from "@nestjs/common";
import { createHmac } from "crypto";
import { StorageService } from "../storage/storage.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationService } from "../notifications/notification.service";
import { createDailyRoom } from "../../lib/daily-room";

const DAILY_API_BASE = "https://api.daily.co/v1";

// Daily.co's POST /v1/webhooks requires an explicit `eventTypes` array. If it
// is omitted the webhook is created but subscribed to NOTHING - Daily never
// delivers a single event (lastMomentPushed stays null), so recordings pile up
// in Daily's cloud and are never downloaded/transcribed. These are exactly the
// events handleWebhook() in video.controller.ts acts on.
const DAILY_WEBHOOK_EVENTS = [
  "meeting.started",
  "meeting.ended",
  "recording.ready-to-download",
];

@Injectable()
export class VideoService implements OnModuleInit {
  private readonly logger = new Logger(VideoService.name);

  constructor(
    @Inject(StorageService) private readonly storageService: StorageService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationService) private readonly notificationService: NotificationService,
  ) {}

  async onModuleInit() {
    setTimeout(() => this.autoRegisterWebhook(), 5000);
  }

  private async autoRegisterWebhook() {
    try {
      const replitDomains = process.env.REPLIT_DOMAINS || process.env.REPLIT_DEV_DOMAIN;
      if (!replitDomains) {
        this.logger.debug("No REPLIT_DOMAINS set - skipping webhook auto-registration");
        return;
      }

      const domain = replitDomains.split(",")[0].trim();
      const webhookUrl = `https://${domain}/api/video/webhook`;
      const hmacSecret = process.env.DAILY_WEBHOOK_SECRET || undefined;

      let existing: any[] = [];
      try {
        existing = await this.listWebhooks();
      } catch (listErr: any) {
        this.logger.warn(`Could not list Daily.co webhooks: ${listErr.message}`);
        return;
      }

      // A webhook with the right URL is NOT enough - it must also be subscribed
      // to the events we handle. A webhook created without `eventTypes` (the old
      // bug) matches by URL but delivers nothing, so we must verify the event
      // subscription and recreate if it's missing/incomplete rather than
      // early-returning on a URL match.
      const existingMatch = existing.find((wh) => wh.url === webhookUrl);
      if (existingMatch) {
        const subscribed: string[] = Array.isArray(existingMatch.eventTypes)
          ? existingMatch.eventTypes
          : [];
        const hasAllEvents = DAILY_WEBHOOK_EVENTS.every((e) => subscribed.includes(e));
        if (hasAllEvents) {
          this.logger.log(`Daily.co webhook already registered with correct events: ${webhookUrl}`);
          return;
        }
        this.logger.warn(
          `Daily.co webhook ${existingMatch.uuid || existingMatch.id} is missing event subscriptions ` +
          `(has: ${subscribed.join(", ") || "none"}) - recreating with [${DAILY_WEBHOOK_EVENTS.join(", ")}]`,
        );
      }

      try {
        for (const wh of existing) {
          const whId = wh.uuid || wh.id;
          if (whId && wh.url && wh.url.includes("/api/video/webhook")) {
            this.logger.log(`Deleting stale Daily.co webhook ${whId} (${wh.url})`);
            await this.deleteWebhook(whId);
          }
        }

        const result = await this.registerWebhook(webhookUrl, hmacSecret);
        this.logger.log(
          `Daily.co webhook auto-registered with events [${DAILY_WEBHOOK_EVENTS.join(", ")}]: ` +
          `${webhookUrl} (id: ${result?.uuid || result?.id})`,
        );
      } catch (regErr: any) {
        const msg = regErr.message || "";
        if (msg.includes("only 1 webhook") || msg.includes("already")) {
          this.logger.log(`Daily.co webhook already exists for this domain - skipping`);
        } else {
          this.logger.warn(`Daily.co webhook registration failed: ${msg}`);
        }
      }
    } catch (err: any) {
      this.logger.warn(`Daily.co webhook auto-registration failed: ${err.message}`);
    }
  }

  private getApiKey(): string {
    const key = process.env.DAILY_API_KEY;
    if (!key) throw new Error("DAILY_API_KEY is not configured");
    return key;
  }

  async createRoom(): Promise<{ url: string; name: string }> {
    return createDailyRoom();
  }

  async ensurePrejoinDisabled(roomName: string): Promise<void> {
    try {
      const res = await fetch(`${DAILY_API_BASE}/rooms/${roomName}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.getApiKey()}`,
        },
        body: JSON.stringify({
          properties: {
            enable_prejoin_ui: false,
          },
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        this.logger.warn(`Failed to update room ${roomName} prejoin setting: ${err}`);
      }
    } catch (err: any) {
      this.logger.warn(`Error updating room prejoin setting: ${err.message}`);
    }
  }

  async generateToken(opts: {
    roomName: string;
    userId: string;
    userName?: string;
    isOwner: boolean;
    consentGiven: boolean;
  }): Promise<string> {
    const properties: Record<string, any> = {
      room_name: opts.roomName,
      user_id: opts.userId,
      user_name: opts.userName || opts.userId,
      is_owner: opts.isOwner,
      enable_screenshare: true,
      start_video_off: false,
      start_audio_off: false,
    };

    if (opts.isOwner && opts.consentGiven) {
      properties.enable_recording = "cloud";
    }

    const res = await fetch(`${DAILY_API_BASE}/meeting-tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.getApiKey()}`,
      },
      body: JSON.stringify({ properties }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Daily.co generate token failed: ${err}`);
    }

    const data = await res.json();
    return data.token;
  }

  async deleteRoom(roomUrl: string): Promise<void> {
    const roomName = roomUrl.split("/").pop();
    if (!roomName) return;

    const res = await fetch(`${DAILY_API_BASE}/rooms/${roomName}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.getApiKey()}`,
      },
    });

    if (!res.ok && res.status !== 404) {
      const err = await res.text();
      throw new Error(`Daily.co delete room failed: ${err}`);
    }
  }

  verifyWebhookSignature(
    rawBody: Buffer | string,
    signature: string | undefined,
    timestamp?: string,
    allHeaders?: Record<string, any>,
  ): boolean {
    const secret = process.env.DAILY_WEBHOOK_SECRET;
    if (!secret) {
      this.logger.warn("DAILY_WEBHOOK_SECRET not set - skipping signature verification");
      return true;
    }
    if (!signature) return false;

    // Daily.co's actual signing scheme (confirmed against a real captured event):
    //
    //   signature = base64( HMAC-SHA256( base64Decode(secret), `${X-Webhook-Timestamp}.${rawBody}` ) )
    //
    // - The hmac value supplied at webhook creation is treated as base64;
    //   Daily decodes it to raw bytes and uses those as the HMAC key.
    // - The signed payload is the X-Webhook-Timestamp header value, a literal
    //   "." separator, and the raw request body bytes (no JSON re-serialization).
    // - Digest is base64-encoded.
    //
    // Their docs only said "BASE-64 encoded HMAC-sha256 secret" and didn't
    // document the rest - this was reverse-engineered by capturing a real
    // participant.left event in /tmp/gostork-server.log and brute-forcing the
    // matrix of (key derivation x payload composition x digest encoding).
    if (timestamp) {
      try {
        const key = Buffer.from(secret, "base64");
        const bodyBuf = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
        const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), bodyBuf]);
        const expected = createHmac("sha256", key).update(signedPayload).digest("base64");
        if (expected === signature) return true;
      } catch {
        // fall through to the diagnostic / fallback path
      }
    }

    // Daily's signature scheme isn't well-documented. Build candidate keys
    // (secret as-is, hex-decoded, base64-decoded) x candidate payloads
    // (body alone, ts.body for Stripe-style headers) x encodings (base64, hex)
    // and accept whichever matches. The diagnostic block at the end logs
    // enough to identify the scheme if none match.
    const bodyBuf = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;

    const hexDecodedKey = (() => {
      if (!/^[0-9a-fA-F]+$/.test(secret) || secret.length % 2 !== 0) return null;
      try { return Buffer.from(secret, "hex"); } catch { return null; }
    })();
    // Always attempt b64-decode - Daily's docs say the hmac value should be
    // "base64-encoded", so decoding it to raw bytes is the most likely key
    // derivation regardless of whether the input string round-trips cleanly.
    const b64DecodedKey = (() => { try { return Buffer.from(secret, "base64"); } catch { return null; } })();

    const candidateKeys: Array<{ key: Buffer | string; label: string }> = [
      { key: secret, label: "secret-utf8" },
    ];
    if (hexDecodedKey) candidateKeys.push({ key: hexDecodedKey, label: "secret-hex-decoded" });
    if (b64DecodedKey && b64DecodedKey.length > 0) candidateKeys.push({ key: b64DecodedKey, label: "secret-b64-decoded" });

    // Daily ships an X-Webhook-Timestamp header that's likely part of the
    // signed payload. Build candidate payloads using both the explicit
    // timestamp arg and any "t=" component in a Stripe-style header.
    const parts = signature.split(",").map(s => s.trim());
    const tPart = parts.find(p => p.startsWith("t="))?.slice(2);
    const vPart = parts.find(p => p.startsWith("v1="))?.slice(3) || parts.find(p => p.startsWith("v="))?.slice(2);
    const tsCandidates = [timestamp, tPart].filter((x): x is string => !!x);

    const candidatePayloads: Array<{ buf: Buffer; label: string }> = [
      { buf: bodyBuf, label: "body" },
    ];
    for (const ts of tsCandidates) {
      candidatePayloads.push(
        { buf: Buffer.concat([Buffer.from(`${ts}.`, "utf8"), bodyBuf]), label: `${ts}.body` },
        { buf: Buffer.concat([Buffer.from(ts, "utf8"), bodyBuf]), label: `${ts}body` },
        { buf: Buffer.concat([bodyBuf, Buffer.from(`.${ts}`, "utf8")]), label: `body.${ts}` },
      );
    }

    const targetSig = vPart || signature;
    const triedDescriptions: string[] = [];
    const candidateDigestPrefixes: string[] = [];
    for (const k of candidateKeys) {
      for (const p of candidatePayloads) {
        for (const enc of ["base64", "hex"] as const) {
          const digest = createHmac("sha256", k.key).update(p.buf).digest(enc);
          const label = `${k.label}|${p.label}|${enc}`;
          triedDescriptions.push(label);
          if (digest === targetSig) {
            this.logger.debug(`Daily signature matched scheme: ${label}`);
            return true;
          }
          candidateDigestPrefixes.push(`${label}=${digest.slice(0, 16)}`);
        }
      }
    }

    // Nothing matched. Daily's documented HMAC scheme is opaque enough that
    // we couldn't pin it down from their docs or by capturing real events
    // (their delivery is non-deterministic for short single-participant
    // meetings, and circuit-breaker tripped before we could inspect a real
    // event). Until we get a definitive scheme from Daily support, default
    // to ACCEPTING webhooks with a loud warning so:
    //   - the webhook registers successfully (handshake returns 200)
    //   - real Daily events are processed downstream
    //   - every mismatched signature is logged with full diagnostic so a
    //     future fix can pin down the scheme by reading one real event
    // Set DAILY_WEBHOOK_VERIFY_STRICT=true once we have the correct scheme
    // implemented to enforce verification.
    const bodyPreview = bodyBuf.length <= 200 ? bodyBuf.toString("utf8") : `${bodyBuf.slice(0, 200).toString("utf8")}...`;
    // Log all x-* / x-daily-* / x-webhook-* headers so we can see exactly
    // what Daily sent. Drop generic infra headers to keep the log readable.
    const interestingHeaders = allHeaders
      ? Object.entries(allHeaders)
          .filter(([k]) => /^(x-|user-agent|content-type)/i.test(k))
          .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
          .join(" | ")
      : "(not provided)";
    // The primary check at the top of this function covers Daily's actual
    // scheme. Reaching this fallback either means the scheme changed, an
    // attacker is forging events, or we hit a code path we didn't expect.
    // Default is now REJECT. To temporarily relax (e.g. while debugging a
    // new Daily API version), set DAILY_WEBHOOK_PERMISSIVE=true in env.
    const permissive = process.env.DAILY_WEBHOOK_PERMISSIVE === "true";
    this.logger.warn(
      `Daily webhook signature mismatch (${permissive ? "ACCEPTING with warning - DAILY_WEBHOOK_PERMISSIVE=true" : "REJECTING"}).\n` +
      `  header_full=${signature}\n` +
      `  timestamp=${timestamp ?? "(none)"}\n` +
      `  body_bytes=${bodyBuf.length}\n` +
      `  body_preview=${bodyPreview}\n` +
      `  headers=${interestingHeaders}\n` +
      `  candidates=${candidateDigestPrefixes.join(" | ")}\n` +
      `  tried=${triedDescriptions.join(", ")}`,
    );
    return permissive;
  }

  async processRecordingReady(
    bookingId: string,
    dailyRecordingId: string,
    downloadUrl: string,
    duration?: number,
  ): Promise<void> {
    const timestamp = Date.now();
    const gcsPath = `recordings/${bookingId}_${timestamp}.mp4`;

    const recording = await this.prisma.recording.create({
      data: {
        bookingId,
        dailyRecordingId,
        gcsObjectPath: gcsPath,
        status: "processing",
        transcriptStatus: "pending",
        duration: duration ? Math.round(duration) : null,
      },
    });

    try {
      const { fileSize } = await this.storageService.uploadFromUrl(
        downloadUrl,
        gcsPath,
      );

      await this.prisma.recording.update({
        where: { id: recording.id },
        data: { status: "ready", fileSize },
      });

      this.logger.log(
        `Recording uploaded to GCS: ${gcsPath} (${fileSize} bytes)`,
      );

      this.transcribeRecording(recording.id, gcsPath).catch((err) => {
        this.logger.error(
          `Transcription failed for recording ${recording.id}: ${err.message}`,
        );
      });
    } catch (err: any) {
      this.logger.error(
        `Failed to upload recording for booking ${bookingId}: ${err.message}`,
      );
      await this.prisma.recording.update({
        where: { id: recording.id },
        data: { status: "failed" },
      });
    }
  }

  async transcribeRecording(
    recordingId: string,
    gcsObjectPath: string,
  ): Promise<void> {
    try {
      await this.prisma.recording.update({
        where: { id: recordingId },
        data: { transcriptStatus: "processing" },
      });

      const bucketName =
        process.env.GCS_BUCKET_NAME || "gostork-recordings";

      const keyJson = process.env.GCS_SERVICE_ACCOUNT_KEY;
      if (!keyJson) {
        throw new Error("GCS_SERVICE_ACCOUNT_KEY not configured");
      }
      const credentials = JSON.parse(keyJson);

      const { Storage } = await import("@google-cloud/storage");
      const storage = new Storage({ credentials });
      const { execSync } = await import("child_process");
      const fs = await import("fs");
      const path = await import("path");
      const os = await import("os");

      const tmpDir = os.tmpdir();
      const mp4Path = path.join(tmpDir, `recording_${recordingId}.mp4`);
      const flacPath = path.join(tmpDir, `recording_${recordingId}.flac`);

      try {
        this.logger.log(`Downloading ${gcsObjectPath} from GCS for audio extraction...`);
        await storage.bucket(bucketName).file(gcsObjectPath).download({ destination: mp4Path });

        this.logger.log(`Extracting audio to FLAC for recording ${recordingId}...`);
        execSync(`ffmpeg -i "${mp4Path}" -vn -ac 1 -ar 16000 -y "${flacPath}"`, {
          timeout: 120_000,
          stdio: "pipe",
        });

        const flacGcsPath = gcsObjectPath.replace(/\.mp4$/, ".flac");
        this.logger.log(`Uploading FLAC audio to GCS: ${flacGcsPath}`);
        await storage.bucket(bucketName).upload(flacPath, {
          destination: flacGcsPath,
          metadata: { contentType: "audio/flac" },
        });

        const gcsUri = `gs://${bucketName}/${flacGcsPath}`;

        const { SpeechClient } = await import("@google-cloud/speech");
        const speechClient = new SpeechClient({ credentials });

        const [operation] = await speechClient.longRunningRecognize({
          audio: { uri: gcsUri },
          config: {
            encoding: "FLAC" as any,
            sampleRateHertz: 16000,
            languageCode: "en-US",
            enableAutomaticPunctuation: true,
            enableWordTimeOffsets: true,
            diarizationConfig: {
              enableSpeakerDiarization: true,
              minSpeakerCount: 2,
              maxSpeakerCount: 4,
            },
            model: "latest_long",
            useEnhanced: true,
          },
        });

        this.logger.log(
          `Transcription started for recording ${recordingId}`,
        );

        const [response] = await operation.promise();

        try { fs.unlinkSync(mp4Path); } catch {}
        try { fs.unlinkSync(flacPath); } catch {}
        try { storage.bucket(bucketName).file(flacGcsPath).delete().catch(() => {}); } catch {}

        let transcriptText = "";
        if (response.results) {
          const lines: string[] = [];
          for (const result of response.results) {
            if (result.alternatives && result.alternatives[0]) {
              const alt = result.alternatives[0];
              const speakerTag = alt.words?.[0]?.speakerTag;
              const prefix = speakerTag ? `Speaker ${speakerTag}: ` : "";
              lines.push(`${prefix}${alt.transcript}`);
            }
          }
          transcriptText = lines.join("\n").trim();
        }

        await this.prisma.recording.update({
          where: { id: recordingId },
          data: {
            transcriptText: transcriptText || null,
            transcriptStatus: transcriptText ? "ready" : "none",
          },
        });

        this.logger.log(
          `Transcription complete for recording ${recordingId} (${transcriptText.length} chars)`,
        );

        try {
          const recording = await this.prisma.recording.findUnique({
            where: { id: recordingId },
            select: { bookingId: true },
          });
          if (recording?.bookingId) {
            const booking = await this.prisma.booking.findUnique({
              where: { id: recording.bookingId },
              include: { providerUser: { include: { provider: true } }, parentUser: true },
            });
            if (booking) {
              await this.notificationService.sendRecordingReady(booking);
            }
          }
        } catch (notifErr: any) {
          this.logger.warn(`Recording ready notification failed: ${notifErr.message}`);
        }
      } catch (innerErr: any) {
        try { fs.unlinkSync(mp4Path); } catch {}
        try { fs.unlinkSync(flacPath); } catch {}
        throw innerErr;
      }
    } catch (err: any) {
      this.logger.error(
        `Transcription error for recording ${recordingId}: ${err.message}`,
      );
      await this.prisma.recording.update({
        where: { id: recordingId },
        data: { transcriptStatus: "failed" },
      });

      try {
        const recording = await this.prisma.recording.findUnique({
          where: { id: recordingId },
          select: { bookingId: true, status: true },
        });
        if (recording?.bookingId && recording.status === "ready") {
          const booking = await this.prisma.booking.findUnique({
            where: { id: recording.bookingId },
            include: { providerUser: { include: { provider: true } }, parentUser: true },
          });
          if (booking) {
            await this.notificationService.sendRecordingReady(booking);
          }
        }
      } catch (notifErr: any) {
        this.logger.warn(`Recording ready notification failed (after transcript failure): ${notifErr.message}`);
      }
    }
  }

  async getRecordingAccessUrl(gcsObjectPath: string): Promise<string> {
    return this.storageService.getSignedUrl(gcsObjectPath, 60);
  }

  async deleteRecording(recordingId: string): Promise<void> {
    const recording = await this.prisma.recording.findUnique({
      where: { id: recordingId },
    });
    if (!recording) return;

    await this.storageService.deleteObject(recording.gcsObjectPath);
    await this.prisma.recording.delete({ where: { id: recordingId } });
    this.logger.log(`Recording ${recordingId} deleted`);
  }

  async getRecordingAccessLink(recordingId: string): Promise<string | null> {
    try {
      const res = await fetch(`${DAILY_API_BASE}/recordings/${encodeURIComponent(recordingId)}/access-link`, {
        headers: {
          Authorization: `Bearer ${this.getApiKey()}`,
        },
      });
      if (!res.ok) {
        this.logger.warn(`Failed to get access link for recording ${recordingId}: ${res.status}`);
        return null;
      }
      const data = await res.json();
      return data.download_link || null;
    } catch (err: any) {
      this.logger.warn(`Error fetching access link for recording ${recordingId}: ${err.message}`);
      return null;
    }
  }

  async listRoomRecordings(roomName: string): Promise<any[]> {
    const res = await fetch(`${DAILY_API_BASE}/recordings?room_name=${encodeURIComponent(roomName)}`, {
      headers: {
        Authorization: `Bearer ${this.getApiKey()}`,
      },
    });
    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`Failed to list room recordings: ${err}`);
      return [];
    }
    const data = await res.json();
    return data.data || [];
  }

  async listWebhooks(): Promise<any[]> {
    const res = await fetch(`${DAILY_API_BASE}/webhooks`, {
      headers: {
        Authorization: `Bearer ${this.getApiKey()}`,
      },
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to list webhooks: ${err}`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : (data.data || []);
  }

  async registerWebhook(
    webhookUrl: string,
    hmacSecret?: string,
    eventTypes: string[] = DAILY_WEBHOOK_EVENTS,
  ): Promise<any> {
    const body: Record<string, any> = {
      url: webhookUrl,
      // Without this, Daily subscribes the webhook to zero events and never
      // delivers meeting/recording callbacks. See DAILY_WEBHOOK_EVENTS above.
      eventTypes,
    };

    if (hmacSecret) {
      // Daily.co's POST /v1/webhooks expects the field name "hmac" - not
      // "hmac_secret". An earlier draft of this code used the wrong key and
      // Daily rejected the request with `"hmac_secret" is not allowed`,
      // which caused auto-registration to silently fail on every server
      // restart and left the webhook unauthenticated.
      body.hmac = hmacSecret;
    }

    const res = await fetch(`${DAILY_API_BASE}/webhooks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.getApiKey()}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to register webhook: ${err}`);
    }

    return res.json();
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    const res = await fetch(`${DAILY_API_BASE}/webhooks/${webhookId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.getApiKey()}`,
      },
    });

    if (!res.ok && res.status !== 404) {
      const err = await res.text();
      throw new Error(`Failed to delete webhook: ${err}`);
    }
  }
}
