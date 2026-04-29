import { Injectable, Inject } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

@Injectable()
export class KnowledgeService {
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
      const pdfParse = (await import("pdf-parse")).default;
      const pdfData = await pdfParse(fileBuffer);
      text = pdfData.text;
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
      providerId,
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

  async ingestWebsite(
    url: string,
    providerId: string,
  ): Promise<{ chunks: number }> {
    this.validateExternalUrl(url);

    let text = "";
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; GoStorkBot/1.0; +https://gostork.com)",
        },
        signal: AbortSignal.timeout(15000),
        redirect: "follow",
      });
      const html = await response.text();
      text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    } catch (e: any) {
      throw new Error(`Failed to fetch website: ${e.message}`);
    }

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
      providerId,
      sourceTier: 1,
      sourceType: "WEBSITE",
      sourceUrl: url,
      metadata: { crawledUrl: url, crawledAt: new Date().toISOString() },
    });

    return { chunks };
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
}
