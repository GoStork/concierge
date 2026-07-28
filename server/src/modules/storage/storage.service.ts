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
      this.logger.warn("GCS_SERVICE_ACCOUNT_KEY not set - storage disabled");
      this.storage = null as any;
      this.bucketName = "";
      return;
    }

    try {
      const credentials = JSON.parse(keyJson);
      this.storage = new Storage({ credentials });
      this.bucketName = process.env.GCS_BUCKET_NAME || "gostork-recordings";
      this.logger.log("GCS storage configured successfully");
    } catch (err: any) {
      this.logger.error(`Failed to parse GCS_SERVICE_ACCOUNT_KEY: ${err.message}`);
      this.storage = null as any;
      this.bucketName = "";
    }
  }

  private get bucket() {
    return this.storage.bucket(this.bucketName);
  }

  private ensureConfigured(): void {
    if (!this.storage) {
      throw new Error("Google Cloud Storage is not configured - set GCS_SERVICE_ACCOUNT_KEY and GCS_BUCKET_NAME");
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
    try {
      // Fine-grained ACL buckets: set per-object public read
      await file.save(buffer, { contentType, predefinedAcl: "publicRead" });
    } catch (err: any) {
      // Uniform bucket-level access disables per-object ACLs; upload without ACL
      // and rely on bucket-level IAM (allUsers Storage Object Viewer) for public access
      if (err?.code === 400 || err?.message?.includes("uniform") || err?.message?.includes("ACL") || err?.message?.includes("BucketPolicyOnlyEnabled")) {
        await file.save(buffer, { contentType });
      } else {
        throw err;
      }
    }
    return `https://storage.googleapis.com/${this.bucketName}/${destPath}`;
  }

  // Download an object's bytes + content-type (the bucket is private, so this is
  // how server-side jobs - e.g. the doctor photo upscaler - read existing photos).
  async downloadObject(objectPath: string): Promise<{ buffer: Buffer; contentType: string }> {
    this.ensureConfigured();
    const file = this.bucket.file(objectPath);
    const [buffer] = await file.download();
    let contentType = "image/jpeg";
    try {
      const [meta] = await file.getMetadata();
      contentType = meta.contentType || contentType;
    } catch { /* metadata optional */ }
    return { buffer, contentType };
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

  async downloadBuffer(objectPath: string): Promise<{ buffer: Buffer; contentType: string }> {
    this.ensureConfigured();
    const file = this.bucket.file(objectPath);
    const [metadata] = await file.getMetadata();
    const [contents] = await file.download();
    return { buffer: contents, contentType: (metadata.contentType as string) || "application/octet-stream" };
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

  // Does the object exist? The bucket is private, so an anonymous HTTP HEAD on
  // the storage.googleapis.com URL always answers 403 and tells you nothing -
  // liveness of a stored GCS URL has to be asked through the authenticated
  // client like this.
  async objectExists(objectPath: string): Promise<boolean> {
    this.ensureConfigured();
    const [exists] = await this.bucket.file(objectPath).exists();
    return exists;
  }

  // Inverse of publicUrlFor: pull the object path back out of a stored GCS URL.
  // Returns null for anything that isn't a URL into our bucket.
  objectPathFrom(url: string | null | undefined): string | null {
    if (!url) return null;
    const m = url.match(/storage\.googleapis\.com\/([^/]+)\/(.+)$/i);
    if (!m || m[1] !== this.bucketName) return null;
    return decodeURIComponent(m[2].split("?")[0]);
  }

  isConfigured(): boolean {
    return !!this.storage;
  }

  // Canonical public-style URL for a GCS object path. Matches the format
  // uploadBufferPublic returns and the format the cost-sheet download
  // route parses back into an object path for signing - so callers can
  // store this for objects that were uploaded via filePath-only flows.
  publicUrlFor(objectPath: string): string {
    return `https://storage.googleapis.com/${this.bucketName}/${objectPath}`;
  }
}
