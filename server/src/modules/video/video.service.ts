import { Injectable, Logger, Inject, OnModuleInit } from "@nestjs/common";
import { createHmac } from "crypto";
import { StorageService } from "../storage/storage.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationService } from "../notifications/notification.service";

const DAILY_API_BASE = "https://api.daily.co/v1";

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
        this.logger.warn("No REPLIT_DOMAINS set — skipping webhook auto-registration");
        return;
      }

      const domain = replitDomains.split(",")[0].trim();
      const webhookUrl = `https://${domain}/api/video/webhook`;
      const hmacSecret = process.env.DAILY_WEBHOOK_SECRET || undefined;

      const existing = await this.listWebhooks();
      for (const wh of existing) {
        if (wh.url === webhookUrl) {
          this.logger.log(`Daily.co webhook already registered: ${webhookUrl}`);
          return;
        }
      }

      for (const wh of existing) {
        const whId = wh.uuid || wh.id;
        if (whId) {
          this.logger.log(`Deleting stale Daily.co webhook ${whId} (${wh.url})`);
          await this.deleteWebhook(whId);
        }
      }

      const result = await this.registerWebhook(webhookUrl, hmacSecret);
      this.logger.log(`Daily.co webhook auto-registered: ${webhookUrl} (id: ${result?.uuid || result?.id})`);
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
    const res = await fetch(`${DAILY_API_BASE}/rooms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.getApiKey()}`,
      },
      body: JSON.stringify({
        privacy: "private",
        properties: {
          enable_knocking: true,
          enable_prejoin_ui: false,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Daily.co create room failed: ${err}`);
    }

    const data = await res.json();
    return { url: data.url, name: data.name };
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
    rawBody: string,
    signature: string | undefined,
  ): boolean {
    const secret = process.env.DAILY_WEBHOOK_SECRET;
    if (!secret) {
      this.logger.warn("DAILY_WEBHOOK_SECRET not set — skipping signature verification");
      return true;
    }
    if (!signature) return false;

    const hmac = createHmac("sha256", secret);
    hmac.update(rawBody);
    const expected = hmac.digest("hex");
    return expected === signature;
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

  async registerWebhook(webhookUrl: string, hmacSecret?: string): Promise<any> {
    const body: Record<string, any> = {
      url: webhookUrl,
    };

    if (hmacSecret) {
      body.hmac_secret = hmacSecret;
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
