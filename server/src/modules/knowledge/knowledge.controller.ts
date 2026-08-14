import {
  Controller,
  Post,
  Get,
  Delete,
  Put,
  Body,
  Param,
  Query,
  Req,
  Inject,
  UseGuards,
  BadRequestException,
  ForbiddenException,
  UseInterceptors,
  UploadedFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { KnowledgeService } from "./knowledge.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { Request, Response } from "express";
import { Res, NotFoundException } from "@nestjs/common";

// Well-known ConciergeAsset keys. Adding a new admin-managed document =
// adding a key here + an upload card in the admin Concierge settings UI.
const CONCIERGE_ASSET_KEYS = new Set([
  "match_call_prep_guide",
  "doctor_call_prep_guide",
  "consultation_prep_guide_ivf",
  "consultation_prep_guide_surrogacy",
  "consultation_prep_guide_egg_donor",
  "consultation_prep_guide_sperm_bank",
]);

@ApiTags("Knowledge")
@Controller("api/knowledge")
export class KnowledgeController {
  constructor(
    @Inject(KnowledgeService) private readonly knowledgeService: KnowledgeService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  // ─── Phase 4: admin-managed concierge documents ─────────────────────────────
  // e.g. the Match Call prep guide PDF that Eva sends to parents when a match
  // call gets scheduled. Upload replaces the previous file for the key.

  @Post("concierge-assets/:key")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @UseInterceptors(FileInterceptor("file"))
  @ApiOperation({ summary: "Admin: upload/replace a concierge document (e.g. match call prep guide)" })
  async uploadConciergeAsset(
    @Param("key") key: string,
    @UploadedFile() file: any,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    const roles: string[] = user?.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Only GoStork admins can manage concierge documents");
    }
    if (!CONCIERGE_ASSET_KEYS.has(key)) throw new BadRequestException(`Unknown asset key: ${key}`);
    if (!file) throw new BadRequestException("No file uploaded");
    const ext = "." + (file.originalname.split(".").pop() || "").toLowerCase();
    if (ext !== ".pdf") throw new BadRequestException("Only PDF files are supported for this document");

    const objectPath = `concierge-assets/${key}.pdf`;
    await this.storage.uploadBuffer(file.buffer, objectPath, "application/pdf");
    const asset = await this.prisma.conciergeAsset.upsert({
      where: { key },
      create: { key, fileName: file.originalname, objectPath, contentType: "application/pdf", uploadedByUserId: user.id },
      update: { fileName: file.originalname, objectPath, uploadedByUserId: user.id },
    });
    return { ok: true, asset: { key: asset.key, fileName: asset.fileName, updatedAt: asset.updatedAt } };
  }

  @Get("concierge-assets/:key")
  @UseGuards(SessionOrJwtGuard)
  @ApiOperation({ summary: "Read a concierge document's metadata (for the admin settings UI)" })
  async getConciergeAsset(@Param("key") key: string) {
    const asset = await this.prisma.conciergeAsset.findUnique({
      where: { key },
      select: { key: true, fileName: true, updatedAt: true },
    });
    return { asset: asset ?? null };
  }

  // Public download - the guide is generic prep content (no PII) and the
  // link is sent in emails where the recipient may not be logged in yet.
  @Get("concierge-assets/:key/file")
  @ApiOperation({ summary: "Download a concierge document (302 to a signed URL)" })
  async downloadConciergeAsset(@Param("key") key: string, @Res() res: Response) {
    const asset = await this.prisma.conciergeAsset.findUnique({ where: { key } });
    if (!asset) throw new NotFoundException("Document not uploaded yet");
    const url = await this.storage.getSignedUrl(asset.objectPath, 60);
    res.redirect(302, url);
  }

  // GoStork admins may manage a specific provider's knowledge base from the
  // admin provider edit page by passing ?providerId=; everyone else is scoped
  // to their own org.
  private effectiveProviderId(user: any, queryProviderId?: string): string | null {
    const roles: string[] = user.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN") || roles.includes("GOSTORK_DEVELOPER");
    if (isAdmin && queryProviderId) return queryProviderId;
    return user.providerId || null;
  }

  @Post("upload")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @UseInterceptors(FileInterceptor("file"))
  @ApiOperation({ summary: "Upload a document for AI knowledge base" })
  async uploadDocument(
    @UploadedFile() file: any,
    @Req() req: Request,
    @Query("providerId") queryProviderId?: string,
  ) {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN") || roles.includes("GOSTORK_DEVELOPER");
    if (!user.providerId && !isAdmin) {
      throw new ForbiddenException("Only providers or admins can upload documents");
    }

    if (!file) {
      throw new BadRequestException("No file uploaded");
    }

    const allowedExtensions = [".pdf", ".csv", ".txt", ".docx"];
    const ext = "." + file.originalname.split(".").pop()?.toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      throw new BadRequestException(
        `Unsupported file type. Allowed: ${allowedExtensions.join(", ")}`,
      );
    }

    try {
      const result = await this.knowledgeService.ingestDocument(
        file.buffer,
        file.originalname,
        this.effectiveProviderId(user, queryProviderId),
        1,
      );

      return { success: true, fileName: file.originalname, ...result };
    } catch (err: any) {
      console.error("Knowledge upload error:", err);
      throw new BadRequestException(err.message || "Failed to process document");
    }
  }

  @Post("sync-website")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Sync provider website content for AI knowledge" })
  async syncWebsite(@Req() req: Request, @Query("providerId") queryProviderId?: string) {
    const user = req.user as any;
    const providerId = this.effectiveProviderId(user, queryProviderId);
    if (!providerId) {
      throw new ForbiddenException("Only providers can sync website");
    }
    const r: string[] = user.roles || [];
    if (r.includes("BILLING_MANAGER") || r.includes("SCHEDULER")) {
      throw new ForbiddenException("Your role cannot trigger website sync");
    }

    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
      select: { websiteUrl: true },
    });

    if (!provider?.websiteUrl) {
      throw new BadRequestException(
        "No website URL configured for this provider",
      );
    }

    const result = await this.knowledgeService.ingestWebsite(
      provider.websiteUrl,
      providerId,
    );

    return { success: true, url: provider.websiteUrl, ...result };
  }

  @Get("documents")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List provider's knowledge base documents" })
  async listDocuments(@Req() req: Request, @Query("providerId") queryProviderId?: string) {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN") || roles.includes("GOSTORK_DEVELOPER");
    if (!user.providerId && !isAdmin) {
      throw new ForbiddenException("Only providers or admins can view documents");
    }

    const docs =
      await this.knowledgeService.getProviderDocuments(this.effectiveProviderId(user, queryProviderId));
    return docs;
  }

  @Delete("documents/:fileName")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Delete a document from the knowledge base" })
  async deleteDocument(
    @Param("fileName") fileName: string,
    @Req() req: Request,
    @Query("providerId") queryProviderId?: string,
  ) {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN");
    if (!user.providerId && !isAdmin) {
      throw new ForbiddenException("Only providers or admins can delete documents");
    }

    const deleted = await this.knowledgeService.deleteProviderDocument(
      this.effectiveProviderId(user, queryProviderId),
      decodeURIComponent(fileName),
    );

    return { success: true, deletedChunks: deleted };
  }

  @Post("bulk-sync")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Admin: Start background bulk sync of all provider websites" })
  async bulkSync(@Req() req: Request) {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN") && !roles.includes("GOSTORK_DEVELOPER")) {
      throw new ForbiddenException("Only GoStork admins can bulk sync");
    }
    const jobId = this.knowledgeService.startBulkSyncJob();
    return { jobId, status: "running" };
  }

  @Get("bulk-sync/:jobId")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Admin: Poll background bulk sync job status" })
  async bulkSyncStatus(@Param("jobId") jobId: string, @Req() req: Request) {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN") && !roles.includes("GOSTORK_DEVELOPER")) {
      throw new ForbiddenException("Only GoStork admins can view sync status");
    }
    const job = this.knowledgeService.getBulkSyncJob(jobId);
    if (!job) throw new BadRequestException("Job not found");
    return job;
  }

  @Get("rules")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List all expert guidance rules" })
  async listRules(@Req() req: Request) {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN") && !roles.includes("GOSTORK_DEVELOPER")) {
      throw new ForbiddenException("Only GoStork admins can manage rules");
    }

    return this.prisma.expertGuidanceRule.findMany({
      orderBy: { sortOrder: "asc" },
    });
  }

  @Post("rules")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Create an expert guidance rule" })
  async createRule(@Body() body: any, @Req() req: Request) {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Only GoStork admins can manage rules");
    }

    if (!body.condition || !body.guidance) {
      throw new BadRequestException("condition and guidance are required");
    }

    return this.prisma.expertGuidanceRule.create({
      data: {
        condition: body.condition,
        guidance: body.guidance,
        isActive: body.isActive ?? true,
        sortOrder: body.sortOrder ?? 0,
      },
    });
  }

  @Put("rules/:id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update an expert guidance rule" })
  async updateRule(
    @Param("id") id: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Only GoStork admins can manage rules");
    }

    const updateData: any = {};
    if (body.condition !== undefined) updateData.condition = body.condition;
    if (body.guidance !== undefined) updateData.guidance = body.guidance;
    if (body.isActive !== undefined) updateData.isActive = body.isActive;
    if (body.sortOrder !== undefined) updateData.sortOrder = body.sortOrder;

    return this.prisma.expertGuidanceRule.update({
      where: { id },
      data: updateData,
    });
  }

  @Delete("rules/:id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Delete an expert guidance rule" })
  async deleteRule(@Param("id") id: string, @Req() req: Request) {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Only GoStork admins can manage rules");
    }

    await this.prisma.expertGuidanceRule.delete({ where: { id } });
    return { success: true };
  }

  @Post("search")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Search knowledge base (for testing)" })
  async searchKnowledge(@Body() body: any, @Req() req: Request) {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN") && !roles.includes("GOSTORK_DEVELOPER")) {
      throw new ForbiddenException("Only GoStork admins can search KB");
    }

    if (!body.query) {
      throw new BadRequestException("query is required");
    }

    const results = await this.knowledgeService.searchKnowledge(body.query, {
      providerId: body.providerId,
      maxResults: body.maxResults || 5,
    });

    return results;
  }

  @Get("whispers")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List pending whisper questions for provider" })
  async listWhispers(@Req() req: Request, @Query("providerId") queryProviderId?: string) {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN");
    if (!user.providerId && !isAdmin) {
      throw new ForbiddenException("Only providers or admins can view whisper questions");
    }

    const effectiveId = this.effectiveProviderId(user, queryProviderId);
    return this.prisma.silentQuery.findMany({
      where: effectiveId ? { providerId: effectiveId } : {},
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        questionText: true,
        answerText: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  @Post("whispers/:id/answer")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Answer a whisper question and auto-ingest into KB" })
  async answerWhisper(
    @Param("id") id: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN");
    if (!user.providerId && !isAdmin) {
      throw new ForbiddenException("Only providers or admins can answer whisper questions");
    }
    if (!isAdmin && (roles.includes("BILLING_MANAGER") || roles.includes("SCHEDULER"))) {
      throw new ForbiddenException("Your role cannot answer whisper questions");
    }

    if (!body.answer || !body.answer.trim()) {
      throw new BadRequestException("answer is required");
    }

    const query = await this.prisma.silentQuery.findUnique({ where: { id } });
    if (!query) {
      throw new ForbiddenException("Question not found");
    }
    if (!isAdmin && query.providerId !== user.providerId) {
      throw new ForbiddenException("Question not found or not yours");
    }

    if (query.status === "ANSWERED") {
      throw new BadRequestException("Question already answered");
    }

    const updated = await this.prisma.silentQuery.update({
      where: { id },
      data: {
        answerText: body.answer.trim(),
        status: "ANSWERED",
      },
    });

    try {
      const kbContent = `Q: ${query.questionText}\nA: ${body.answer.trim()}`;
      await this.knowledgeService.ingestText(kbContent, {
        providerId: query.providerId,
        sourceTier: 1,
        sourceType: "WHISPER",
        sourceFileName: `whisper-${id}`,
        metadata: { whisperQueryId: id, question: query.questionText },
      });
    } catch (e) {
      console.error("Failed to auto-ingest whisper answer into KB:", e);
    }

    try {
      const provider = await this.prisma.provider.findUnique({
        where: { id: query.providerId },
        select: { name: true },
      });
      await this.prisma.inAppNotification.create({
        data: {
          userId: query.parentUserId,
          eventType: "WHISPER_ANSWERED",
          payload: {
            message: `Eva has an update for you regarding your question for ${provider?.name || "a provider"}.`,
            silentQueryId: id,
            providerName: provider?.name,
          },
        },
      });
    } catch (e) {
      console.error("Failed to notify parent of whisper answer:", e);
    }

    return { success: true, id: updated.id };
  }
}