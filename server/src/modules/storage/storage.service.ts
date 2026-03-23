import { Injectable, Logger } from "@nestjs/common";
import { Storage } from "@google-cloud/storage";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private storage: Storage;
  private bucketName: string;

  constructor() {
    const keyJson = process.env.GCS_SERVICE_ACCOUNT_KEY;
    if (!keyJson) {
      this.logger.warn("GCS_SERVICE_ACCOUNT_KEY not set — storage disabled");
      this.storage = null as any;
      this.bucketName = "";
      return;
    }

    const credentials = JSON.parse(keyJson);
    this.storage = new Storage({ credentials });
    this.bucketName = process.env.GCS_BUCKET_NAME || "gostork-recordings";
  }

  private get bucket() {
    return this.storage.bucket(this.bucketName);
  }

  private ensureConfigured(): void {
    if (!this.storage) {
      throw new Error("Google Cloud Storage is not configured — set GCS_SERVICE_ACCOUNT_KEY and GCS_BUCKET_NAME");
    }
  }

  async uploadFromUrl(
    sourceUrl: string,
    destPath: string,
  ): Promise<{ fileSize: number }> {
    this.ensureConfigured();
    this.logger.log(`Uploading from URL to GCS: ${destPath}`);

    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to download from source URL: ${response.status} ${response.statusText}`,
      );
    }

    const file = this.bucket.file(destPath);
    const writeStream = file.createWriteStream({
      resumable: false,
      contentType: response.headers.get("content-type") || "video/mp4",
    });

    const body = response.body;
    if (!body) {
      throw new Error("Response body is null");
    }

    const reader = body.getReader();
    let totalBytes = 0;

    const readable = new Readable({
      async read() {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
        } else {
          totalBytes += value.length;
          this.push(Buffer.from(value));
        }
      },
    });

    await pipeline(readable, writeStream);

    this.logger.log(
      `Upload complete: ${destPath} (${totalBytes} bytes)`,
    );
    return { fileSize: totalBytes };
  }

  async uploadBuffer(
    buffer: Buffer,
    destPath: string,
    contentType: string = "audio/wav",
  ): Promise<void> {
    this.ensureConfigured();
    const file = this.bucket.file(destPath);
    await file.save(buffer, { contentType });
  }

  async uploadBufferPublic(
    buffer: Buffer,
    destPath: string,
    contentType: string = "image/jpeg",
  ): Promise<string> {
    this.ensureConfigured();
    const file = this.bucket.file(destPath);
    await file.save(buffer, { contentType, predefinedAcl: "publicRead" });
    return `https://storage.googleapis.com/${this.bucketName}/${destPath}`;
  }

  async getSignedUrl(
    objectPath: string,
    expiresInMinutes: number = 60,
  ): Promise<string> {
    this.ensureConfigured();
    const file = this.bucket.file(objectPath);
    const [url] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + expiresInMinutes * 60 * 1000,
    });
    return url;
  }

  async deleteObject(objectPath: string): Promise<void> {
    this.ensureConfigured();
    this.logger.log(`Deleting from GCS: ${objectPath}`);
    const file = this.bucket.file(objectPath);
    await file.delete({ ignoreNotFound: true });
  }

  async downloadToBuffer(objectPath: string): Promise<Buffer> {
    this.ensureConfigured();
    const file = this.bucket.file(objectPath);
    const [contents] = await file.download();
    return contents;
  }

  isConfigured(): boolean {
    return !!this.storage;
  }
}
