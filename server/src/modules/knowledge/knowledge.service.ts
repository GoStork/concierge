import { Injectable, Inject } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { randomUUID } from "crypto";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

type BulkSyncJob = {
  status: "running" | "done" | "error";
  current: number;
  total: number;
  currentName: string;
  synced: number;
  failed: number;
  errors: string[];
  startedAt: string;
  completedAt?: string;
};

@Injectable()
export class KnowledgeService {
  private bulkSyncJobs = new Map<string, BulkSyncJob>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async generateEmbedding(text: string): Promise<number[]> {
    const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
    const result = await model.embedContent({ content: { parts: [{ text }], role: "user" }, outputDimensionality: 768 } as any);
    return result.embedding.values;
  }

  chunkText(text: string, chunkSize = 300, overlap = 50): string[] {
    const words = text.split(/\s+/);
    const chunks: string[] = [];
    let i = 0;
    while (i < words.length) {
      const chunk = words.slice(i, i + chunkSize).join(" ");
      if (chunk.trim().length > 10) {
        chunks.push(chunk.trim());
      }
      i += chunkSize - overlap;
    }
    return chunks;
  }

  async ingestText(
    content: string,
    options: {
      providerId?: string;
      sourceTier: number;
      sourceType: string;
      sourceFileName?: string;
      sourceUrl?: string;
      metadata?: any;
    },
  ): Promise<number> {
    const chunks = this.chunkText(content);
    let count = 0;

    for (const chunk of chunks) {
      const embedding = await this.generateEmbedding(chunk);
      const vectorStr = `[${embedding.join(",")}]`;

      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "KnowledgeChunk" (id, content, metadata, embedding, "sourceTier", "providerId", "sourceType", "sourceFileName", "sourceUrl", "createdAt")
         VALUES (gen_random_uuid(), $1, $2::jsonb, $3::vector, $4, $5, $6, $7, $8, NOW())`,
        chunk,
        JSON.stringify(options.metadata || {}),
        vectorStr,
        options.sourceTier,
        options.providerId || null,
        options.sourceType,
        options.sourceFileName || null,
        options.sourceUrl || null,
      );
      count++;
    }

    return count;
  }

  async ingestDocument(
    fileBuffer: Buffer,
    fileName: string,
    providerId: string | null,
    sourceTier: number = 1,
  ): Promise<{ chunks: number }> {
    let text = "";

    if (fileName.toLowerCase().endsWith(".pdf")) {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: fileBuffer });
      // getText() loads on demand; load() is private API.
      const textResult = await parser.getText();
      text = (typeof textResult === "string" ? textResult : textResult?.text) || "";
    } else if (
      fileName.toLowerCase().endsWith(".csv") ||
      fileName.toLowerCase().endsWith(".txt")
    ) {
      text = fileBuffer.toString("utf-8");
    } else if (fileName.toLowerCase().endsWith(".docx")) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      text = result.value;
    } else {
      text = fileBuffer.toString("utf-8");
    }

    if (!text.trim()) {
      throw new Error("No text content extracted from file");
    }

    await this.prisma.knowledgeChunk.deleteMany({
      where: {
        providerId,
        sourceType: "DOCUMENT",
        sourceFileName: fileName,
      },
    });

    const chunks = await this.ingestText(text, {
      // ingestDocument takes providerId as nullable (GoStork-wide docs have
      // none); ingestText's option is optional, so normalise here.
      providerId: providerId ?? undefined,
      sourceTier,
      sourceType: "DOCUMENT",
      sourceFileName: fileName,
      metadata: { originalFileName: fileName },
    });

    return { chunks };
  }

  private validateExternalUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Invalid URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Only HTTP/HTTPS URLs are allowed");
    }
    const hostname = parsed.hostname.toLowerCase();
    const blockedHostnames = [
      "localhost",
      "127.0.0.1",
      "0.0.0.0",
      "::1",
      "[::1]",
      "metadata.google.internal",
      "169.254.169.254",
    ];
    if (
      blockedHostnames.includes(hostname) ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("172.") ||
      hostname.startsWith("192.168.")
    ) {
      throw new Error("URL points to a restricted address");
    }
  }

  private htmlToText(html: string): string {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Multi-page website ingestion: homepage + the same subpages the
   *  provider-creation scraper discovers (about / team / locations / contact,
   *  JS-rendered sites included), so Eva's memory covers the whole site -
   *  not just the homepage. Runs automatically when a provider is created
   *  and on manual re-sync. */
  async ingestWebsite(
    url: string,
    providerId: string,
  ): Promise<{ chunks: number; pages: number }> {
    this.validateExternalUrl(url);

    const PER_PAGE_CHAR_CAP = 20_000;
    const TOTAL_CHAR_CAP = 150_000;
    const MAX_SUBPAGES = 10;

    // Same fetch + subpage discovery as the provider-creation scraper.
    const { fetchHtml, findSubpageUrls } = await import("../providers/scrape.service");

    let mainHtml = "";
    let effectiveUrl = url;
    try {
      const main = await fetchHtml(url);
      mainHtml = main.html;
      effectiveUrl = main.finalUrl || url;
    } catch (e: any) {
      throw new Error(`Failed to fetch website: ${e.message}`);
    }

    const pageTexts: string[] = [];
    const mainText = this.htmlToText(mainHtml).slice(0, PER_PAGE_CHAR_CAP);
    if (mainText.length >= 50) pageTexts.push(`PAGE: ${effectiveUrl}\n${mainText}`);

    const subpageUrls = findSubpageUrls(mainHtml, effectiveUrl)
      .filter((u) => {
        try { this.validateExternalUrl(u); return true; } catch { return false; }
      })
      .slice(0, MAX_SUBPAGES);

    const subpages = await Promise.allSettled(
      subpageUrls.map(async (u) => ({ url: u, html: (await fetchHtml(u, 20000)).html })),
    );
    let pagesIngested = pageTexts.length;
    let totalChars = mainText.length;
    for (const r of subpages) {
      if (r.status !== "fulfilled") continue;
      if (totalChars >= TOTAL_CHAR_CAP) break;
      const t = this.htmlToText(r.value.html).slice(0, PER_PAGE_CHAR_CAP);
      if (t.length < 200) continue;
      pageTexts.push(`PAGE: ${r.value.url}\n${t}`);
      pagesIngested++;
      totalChars += t.length;
    }

    const text = pageTexts.join("\n\n");
    if (!text || text.length < 50) {
      throw new Error("Insufficient content extracted from website");
    }

    await this.prisma.knowledgeChunk.deleteMany({
      where: {
        providerId,
        sourceType: "WEBSITE",
      },
    });

    const chunks = await this.ingestText(text, {
      // ingestDocument takes providerId as nullable (GoStork-wide docs have
      // none); ingestText's option is optional, so normalise here.
      providerId: providerId ?? undefined,
      sourceTier: 1,
      sourceType: "WEBSITE",
      sourceUrl: url,
      metadata: { crawledUrl: url, crawledAt: new Date().toISOString(), pagesIngested },
    });

    return { chunks, pages: pagesIngested };
  }

  async searchKnowledge(
    query: string,
    options: {
      providerId?: string;
      maxResults?: number;
    } = {},
  ): Promise<
    { content: string; sourceTier: number; sourceType: string; score: number }[]
  > {
    const embedding = await this.generateEmbedding(query);
    const vectorStr = `[${embedding.join(",")}]`;
    const limit = options.maxResults || 5;

    let results: any[];

    if (options.providerId) {
      results = await this.prisma.$queryRawUnsafe(
        `SELECT content, "sourceTier", "sourceType", "sourceFileName",
                1 - (embedding <=> $1::vector) as score
         FROM "KnowledgeChunk"
         WHERE ("providerId" = $2 AND "sourceTier" = 1)
            OR "sourceTier" IN (2, 3)
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        vectorStr,
        options.providerId,
        limit,
      );
    } else {
      results = await this.prisma.$queryRawUnsafe(
        `SELECT content, "sourceTier", "sourceType", "sourceFileName",
                1 - (embedding <=> $1::vector) as score
         FROM "KnowledgeChunk"
         WHERE "sourceTier" IN (2, 3)
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        vectorStr,
        limit,
      );
    }

    return results.map((r: any) => ({
      content: r.content,
      sourceTier: r.sourceTier,
      sourceType: r.sourceType,
      score: parseFloat(r.score),
    }));
  }

  async getProviderDocuments(providerId: string | null) {
    let docs: any[];
    if (providerId) {
      docs = await this.prisma.$queryRawUnsafe(
        `SELECT "sourceFileName", "sourceType", "sourceUrl", COUNT(*)::int as chunk_count, MIN("createdAt") as "createdAt"
         FROM "KnowledgeChunk"
         WHERE "providerId" = $1
         GROUP BY "sourceFileName", "sourceType", "sourceUrl"
         ORDER BY MIN("createdAt") DESC`,
        providerId,
      );
    } else {
      // Admin: return system-level documents (no provider)
      docs = await this.prisma.$queryRawUnsafe(
        `SELECT "sourceFileName", "sourceType", "sourceUrl", COUNT(*)::int as chunk_count, MIN("createdAt") as "createdAt"
         FROM "KnowledgeChunk"
         WHERE "providerId" IS NULL
         GROUP BY "sourceFileName", "sourceType", "sourceUrl"
         ORDER BY MIN("createdAt") DESC`,
      );
    }
    return docs;
  }

  async deleteProviderDocument(
    providerId: string | null,
    sourceFileName: string,
  ): Promise<number> {
    const result = await this.prisma.knowledgeChunk.deleteMany({
      where: { providerId: providerId ?? null, sourceFileName },
    });
    return result.count;
  }

  async bulkSyncProviderWebsites(
    onProgress?: (current: number, total: number, name: string) => void,
  ): Promise<{ synced: number; failed: number; errors: string[] }> {
    const providers = await this.prisma.provider.findMany({
      where: { websiteUrl: { not: null } },
      select: { id: true, name: true, websiteUrl: true },
    });

    let synced = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      if (!p.websiteUrl) continue;

      try {
        if (onProgress) onProgress(i + 1, providers.length, p.name);
        await this.ingestWebsite(p.websiteUrl, p.id);
        synced++;
      } catch (e: any) {
        failed++;
        errors.push(`${p.name}: ${e.message}`);
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    return { synced, failed, errors };
  }

  startBulkSyncJob(): string {
    const jobId = randomUUID();
    const job: BulkSyncJob = {
      status: "running",
      current: 0,
      total: 0,
      currentName: "",
      synced: 0,
      failed: 0,
      errors: [],
      startedAt: new Date().toISOString(),
    };
    this.bulkSyncJobs.set(jobId, job);

    this.bulkSyncProviderWebsites((current, total, name) => {
      job.current = current;
      job.total = total;
      job.currentName = name;
    }).then((result) => {
      job.status = "done";
      job.synced = result.synced;
      job.failed = result.failed;
      job.errors = result.errors;
      job.completedAt = new Date().toISOString();
    }).catch((e: any) => {
      job.status = "error";
      job.errors = [e.message];
      job.completedAt = new Date().toISOString();
    });

    return jobId;
  }

  getBulkSyncJob(jobId: string): BulkSyncJob | null {
    return this.bulkSyncJobs.get(jobId) ?? null;
  }
}