import {
  Controller,
  Post,
  Get,
  Query,
  UseGuards,
  Req,
  Res,
  HttpException,
  HttpStatus,
  Inject,
} from "@nestjs/common";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { Request, Response } from "express";
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiQuery } from "@nestjs/swagger";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { GoogleGenAI } from "@google/genai";

const UPLOADS_DIR = path.resolve(process.cwd(), "public/uploads");
const MAX_FILE_SIZE = 16 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"];

@ApiTags("Uploads")
@Controller("api/uploads")
export class UploadsController {
  @Post()
  @UseGuards(SessionOrJwtGuard)
  @ApiOperation({ summary: "Upload an image file" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ schema: { type: "object", properties: { file: { type: "string", format: "binary" } } } })
  async uploadFile(@Req() req: Request, @Res() res: Response) {
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }

    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      throw new HttpException("Content-Type must be multipart/form-data", HttpStatus.BAD_REQUEST);
    }

    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      throw new HttpException("Missing boundary in content-type", HttpStatus.BAD_REQUEST);
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;

    return new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_FILE_SIZE) {
          req.destroy();
          res.status(413).json({ message: "File too large. Maximum size is 16MB." });
          resolve();
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", async () => {
        try {
          const body = Buffer.concat(chunks);
          const boundary = boundaryMatch![1];
          const parsed = parseMultipart(body, boundary);

          if (!parsed) {
            res.status(400).json({ message: "No file found in request" });
            resolve();
            return;
          }

          if (!ALLOWED_TYPES.includes(parsed.contentType)) {
            res.status(400).json({ message: `File type not allowed. Allowed: ${ALLOWED_TYPES.join(", ")}` });
            resolve();
            return;
          }

          const ext = getExtension(parsed.contentType, parsed.filename);
          const uniqueName = `${crypto.randomBytes(16).toString("hex")}${ext}`;
          const filePath = path.join(UPLOADS_DIR, uniqueName);

          let fileData = parsed.data;
          if (["image/jpeg", "image/png", "image/webp"].includes(parsed.contentType)) {
            try {
              const sharp = require("sharp");
              const metadata = await sharp(parsed.data).metadata();
              if (metadata.width && metadata.height && (metadata.width > 1200 || metadata.height > 1200)) {
                fileData = await sharp(parsed.data)
                  .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
                  .jpeg({ quality: 85 })
                  .toBuffer();
              }
            } catch {}
          }

          fs.writeFileSync(filePath, fileData);

          const url = `/uploads/${uniqueName}`;
          res.status(201).json({ url });
          resolve();
        } catch (err) {
          res.status(500).json({ message: "Failed to process upload" });
          resolve();
        }
      });

      req.on("error", () => {
        res.status(500).json({ message: "Upload failed" });
        resolve();
      });
    });
  }

  @Get("proxy")
  @ApiOperation({ summary: "Proxy an external image to avoid cross-origin issues" })
  @ApiQuery({ name: "url", required: true, type: String })
  async proxyImage(@Query("url") url: string, @Res() res: Response) {
    if (!url || typeof url !== "string") {
      res.status(400).json({ message: "url query parameter is required" });
      return;
    }

    try {
      new URL(url);
    } catch {
      res.status(400).json({ message: "Invalid URL" });
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; GoStork/1.0)",
          "Accept": "image/*",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timeout);

      if (!response.ok) {
        res.status(502).json({ message: `Upstream returned ${response.status}` });
        return;
      }

      let ct = response.headers.get("content-type") || "image/jpeg";
      const buffer = Buffer.from(await response.arrayBuffer());

      if (!ct.startsWith("image/")) {
        const head = buffer.subarray(0, 12);
        if (head[0] === 0xFF && head[1] === 0xD8) ct = "image/jpeg";
        else if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) ct = "image/png";
        else if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) ct = "image/gif";
        else if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
                 head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) ct = "image/webp";
        else {
          res.status(400).json({ message: "URL did not return an image" });
          return;
        }
      }
      if (buffer.length > MAX_FILE_SIZE) {
        res.status(413).json({ message: "Image too large" });
        return;
      }

      res.set({
        "Content-Type": ct,
        "Cache-Control": "public, max-age=604800, immutable",
        "Content-Length": String(buffer.length),
      });
      res.send(buffer);
    } catch (err: any) {
      res.status(502).json({ message: "Failed to fetch image" });
    }
  }

  @Post("transform")
  @UseGuards(SessionOrJwtGuard)
  @ApiOperation({ summary: "Apply transformation (rotate/flip) to an uploaded image" })
  async transformImage(@Req() req: Request, @Res() res: Response) {
    try {
      const { imageUrl, rotation, flipH } = req.body || {};
      if (!imageUrl || typeof imageUrl !== "string") {
        res.status(400).json({ message: "imageUrl is required" });
        return;
      }
      if (!imageUrl.startsWith("/uploads/")) {
        res.status(400).json({ message: "Only uploaded images (/uploads/*) are allowed" });
        return;
      }
      const localPath = path.join(UPLOADS_DIR, path.basename(imageUrl));
      if (!fs.existsSync(localPath)) {
        res.status(404).json({ message: "Image not found" });
        return;
      }

      const sharp = (await import("sharp")).default;
      let pipeline = sharp(localPath);

      if (rotation && typeof rotation === "number" && rotation !== 0) {
        pipeline = pipeline.rotate(rotation);
      }
      if (flipH) {
        pipeline = pipeline.flop();
      }

      const resultBuffer = await pipeline.toBuffer();
      const ext = path.extname(localPath).toLowerCase() || ".jpg";
      const uniqueName = `${crypto.randomBytes(16).toString("hex")}${ext}`;
      const outPath = path.join(UPLOADS_DIR, uniqueName);
      fs.writeFileSync(outPath, resultBuffer);

      const url = `/uploads/${uniqueName}`;
      res.status(200).json({ url });
    } catch (err: any) {
      console.error("Transform image error:", err?.message || err);
      res.status(500).json({ message: "Failed to transform image" });
    }
  }

  @Post("remove-background")
  @UseGuards(SessionOrJwtGuard)
  @ApiOperation({ summary: "Remove background from an image using Gemini AI" })
  async removeBackground(@Req() req: Request, @Res() res: Response) {
    try {
      let imageBuffer: Buffer;
      let imageMime: string;

      const body = req.body;
      if (!body?.imageUrl || typeof body.imageUrl !== "string") {
        res.status(400).json({ message: "imageUrl is required in JSON body" });
        return;
      }

      const imageUrl: string = body.imageUrl;
      if (!imageUrl.startsWith("/uploads/")) {
        res.status(400).json({ message: "Only uploaded images (/uploads/*) are allowed" });
        return;
      }

      const localPath = path.join(UPLOADS_DIR, path.basename(imageUrl));
      if (!fs.existsSync(localPath)) {
        res.status(404).json({ message: "Image not found" });
        return;
      }

      imageBuffer = fs.readFileSync(localPath);
      const ext = path.extname(localPath).toLowerCase();
      const mimeMap: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
      imageMime = mimeMap[ext] || "image/png";

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        res.status(500).json({ message: "Gemini API key not configured" });
        return;
      }

      if (imageBuffer.length > MAX_FILE_SIZE) {
        res.status(413).json({ message: "Image too large. Maximum size is 16MB." });
        return;
      }

      const ai = new GoogleGenAI({ apiKey });
      const base64Image = imageBuffer.toString("base64");

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: imageMime,
                  data: base64Image,
                },
              },
              {
                text: "Remove the background from this image completely and replace it with solid pure white (#FFFFFF, RGB 255,255,255). Every single background pixel must be exactly RGB(255,255,255) — no gradients, no shadows, no anti-aliasing on the background, no off-white pixels. Keep the foreground subject/logo intact with clean edges. Output only the processed image.",
              },
            ],
          },
        ],
        config: {
          responseModalities: ["IMAGE"],
        },
      });

      const parts = response?.candidates?.[0]?.content?.parts;
      if (!parts) {
        res.status(502).json({ message: "Gemini returned no response" });
        return;
      }

      let resultImageData: string | undefined;
      let resultMimeType: string = "image/png";
      for (const part of parts) {
        if (part.inlineData) {
          resultImageData = part.inlineData.data;
          resultMimeType = part.inlineData.mimeType || "image/png";
          break;
        }
      }

      if (!resultImageData) {
        res.status(502).json({ message: "Gemini did not return an image" });
        return;
      }

      if (!fs.existsSync(UPLOADS_DIR)) {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      }

      const outExt = resultMimeType.includes("png") ? ".png" : resultMimeType.includes("webp") ? ".webp" : ".png";
      const uniqueName = `${crypto.randomBytes(16).toString("hex")}${outExt}`;
      const filePath = path.join(UPLOADS_DIR, uniqueName);
      fs.writeFileSync(filePath, Buffer.from(resultImageData, "base64"));

      const url = `/uploads/${uniqueName}`;
      res.status(200).json({ url });
    } catch (err: any) {
      console.error("Remove background error:", err?.message || err);
      res.status(500).json({ message: "Failed to remove background" });
    }
  }
}

function getExtension(contentType: string, filename: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
  };
  if (map[contentType]) return map[contentType];
  const match = filename.match(/\.\w+$/);
  return match ? match[0] : ".jpg";
}

function parseMultipart(body: Buffer, boundary: string): { filename: string; contentType: string; data: Buffer } | null {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];

  let start = 0;
  while (true) {
    const idx = body.indexOf(boundaryBuffer, start);
    if (idx === -1) break;
    if (start > 0) {
      parts.push(body.subarray(start, idx));
    }
    start = idx + boundaryBuffer.length;
  }

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const headerStr = part.subarray(0, headerEnd).toString("utf-8");
    if (!headerStr.includes("filename=")) continue;

    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);

    const filename = filenameMatch?.[1] || "upload";
    const contentType = ctMatch?.[1]?.trim() || "application/octet-stream";

    let dataStart = headerEnd + 4;
    let dataEnd = part.length;
    if (part[dataEnd - 1] === 0x0a && part[dataEnd - 2] === 0x0d) {
      dataEnd -= 2;
    }

    return {
      filename,
      contentType,
      data: part.subarray(dataStart, dataEnd),
    };
  }

  return null;
}
