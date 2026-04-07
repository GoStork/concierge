import { Controller, Get, Inject, UseGuards, Req, Res } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { Request, Response } from "express";
import * as path from "path";
import * as fs from "fs";

@ApiTags("Documents")
@Controller("api/documents")
export class DocumentsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storageService: StorageService,
  ) {}

  private async fetchTemplateBuffer(fileUrl: string): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    const filename = decodeURIComponent(fileUrl.split("/").pop()?.split("?")[0] || "agreement");
    const isLocal = fileUrl.startsWith("/uploads/");
    const gcsMatch = fileUrl.match(/storage\.googleapis\.com\/[^/]+\/(.+)/);

    if (isLocal) {
      const localPath = path.join(process.cwd(), "public", fileUrl);
      if (!fs.existsSync(localPath)) throw new Error("File not found");
      const buffer = fs.readFileSync(localPath);
      const contentType = filename.endsWith(".pdf") ? "application/pdf"
        : filename.endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/msword";
      return { buffer, filename, contentType };
    }

    if (gcsMatch) {
      const objectPath = gcsMatch[1];
      const result = await this.storageService.downloadBuffer(objectPath);
      return { buffer: result.buffer, filename, contentType: result.contentType };
    }

    // Fallback: direct fetch
    const resp = await fetch(fileUrl);
    if (!resp.ok) throw new Error(`Failed to fetch document: ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const contentType = resp.headers.get("content-type") || "application/octet-stream";
    return { buffer, filename, contentType };
  }

  @Get("preview")
  @UseGuards(SessionOrJwtGuard)
  @ApiOperation({ summary: "Render provider agreement template as HTML for inline preview" })
  async previewDocument(@Req() req: Request, @Res() res: Response) {
    const user = req.user as any;
    if (!user?.providerId) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }

    try {
      const provider = await this.prisma.provider.findUnique({
        where: { id: user.providerId },
        select: { agreementTemplateUrl: true },
      });

      if (!provider?.agreementTemplateUrl) {
        res.status(404).json({ message: "No template uploaded" });
        return;
      }

      const fileUrl = provider.agreementTemplateUrl;
      const isPdf = /\.pdf$/i.test(fileUrl);
      const isWord = /\.(docx?)$/i.test(fileUrl);

      if (isPdf) {
        // Stream the PDF directly so the iframe can render it natively
        const { buffer, contentType } = await this.fetchTemplateBuffer(fileUrl);
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "private, max-age=300");
        res.send(buffer);
        return;
      }

      if (!isWord) {
        res.status(400).json({ message: "Unsupported file type" });
        return;
      }

      const { buffer } = await this.fetchTemplateBuffer(fileUrl);

      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml(
        { buffer },
        {
          styleMap: [
            // Map Word page breaks to visible dividers
            "br[type='page'] => hr.page-break",
          ],
        },
      );

      // Highlight {{TOKEN}} placeholders so they stand out visually in the preview
      const highlightedHtml = result.value.replace(
        /\{\{([A-Z0-9_]+)\}\}/g,
        '<mark class="token-highlight">{{$1}}</mark>',
      );

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    html { background: #e8e8e8; }
    body {
      font-family: Georgia, "Times New Roman", serif;
      line-height: 1.7;
      color: #1a1a1a;
      font-size: 13.5px;
      margin: 0;
      padding: 24px 16px;
    }
    .page {
      background: #fff;
      max-width: 760px;
      margin: 0 auto 24px;
      padding: 72px 80px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.18);
      border-radius: 2px;
      min-height: 1040px;
    }
    p { margin: 0 0 0.85em; }
    h1, h2, h3, h4 { font-family: inherit; margin: 1.2em 0 0.4em; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    td, th { border: 1px solid #ccc; padding: 6px 10px; vertical-align: top; }
    ul, ol { margin: 0 0 0.85em; padding-left: 1.5em; }
    li { margin-bottom: 0.3em; }
    hr.page-break {
      border: none;
      height: 0;
      margin: 0;
      page-break-after: always;
    }
    .token-highlight {
      background: #fff3cd;
      color: #7d5a00;
      border: 1px solid #f0c040;
      border-radius: 3px;
      padding: 0 3px;
      font-family: monospace;
      font-size: 0.88em;
    }
  </style>
</head>
<body>
  <div class="page">${highlightedHtml}</div>
</body>
</html>`);
    } catch (err: any) {
      console.error("[DocumentsController] Preview error:", err?.message);
      res.status(500).json({ message: "Failed to generate preview" });
    }
  }

  @Get("download")
  @UseGuards(SessionOrJwtGuard)
  @ApiOperation({ summary: "Download provider agreement template via GoStork (handles GCS auth)" })
  async downloadDocument(@Req() req: Request, @Res() res: Response) {
    const user = req.user as any;
    if (!user?.providerId) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }

    try {
      const provider = await this.prisma.provider.findUnique({
        where: { id: user.providerId },
        select: { agreementTemplateUrl: true },
      });

      if (!provider?.agreementTemplateUrl) {
        res.status(404).json({ message: "No template uploaded" });
        return;
      }

      const { buffer, filename, contentType } = await this.fetchTemplateBuffer(provider.agreementTemplateUrl);

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", buffer.length);
      res.send(buffer);
    } catch (err: any) {
      console.error("[DocumentsController] Download error:", err?.message);
      res.status(500).json({ message: "Failed to download document" });
    }
  }
}
