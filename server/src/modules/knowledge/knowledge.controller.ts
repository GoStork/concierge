import {
  Controller,
  Post,
  Get,
  Delete,
  Put,
  Body,
  Param,
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
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { Request } from "express";

@ApiTags("Knowledge")
@Controller("api/knowledge")
export class KnowledgeController {
  constructor(
    @Inject(KnowledgeService) private readonly knowledgeService: KnowledgeService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Post("upload")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @UseInterceptors(FileInterceptor("file"))
  @ApiOperation({ summary: "Upload a document for AI knowledge base" })
  async uploadDocument(
    @UploadedFile() file: any,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    if (!user.providerId) {
      throw new ForbiddenException("Only providers can upload documents");
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

    const result = await this.knowledgeService.ingestDocument(
      file.buffer,
      file.originalname,
      user.providerId,
      1,
    );

    return { success: true, fileName: file.originalname, ...result };
  }

  @Post("sync-website")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Sync provider website content for AI knowledge" })
  async syncWebsite(@Req() req: Request) {
    const user = req.user as any;
    if (!user.providerId) {
      throw new ForbiddenException("Only providers can sync website");
    }

    const provider = await this.prisma.provider.findUnique({
      where: { id: user.providerId },
      select: { websiteUrl: true },
    });

    if (!provider?.websiteUrl) {
      throw new BadRequestException(
        "No website URL configured for this provider",
      );
    }

    const result = await this.knowledgeService.ingestWebsite(
      provider.websiteUrl,
      user.providerId,
    );

    return { success: true, url: provider.websiteUrl, ...result };
  }

  @Get("documents")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List provider's knowledge base documents" })
  async listDocuments(@Req() req: Request) {
    const user = req.user as any;
    if (!user.providerId) {
      throw new ForbiddenException("Only providers can view documents");
    }

    const docs =
      await this.knowledgeService.getProviderDocuments(user.providerId);
    return docs;
  }

  @Delete("documents/:fileName")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Delete a document from the knowledge base" })
  async deleteDocument(
    @Param("fileName") fileName: string,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    if (!user.providerId) {
      throw new ForbiddenException("Only providers can delete documents");
    }

    const deleted = await this.knowledgeService.deleteProviderDocument(
      user.providerId,
      decodeURIComponent(fileName),
    );

    return { success: true, deletedChunks: deleted };
  }

  @Post("bulk-sync")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Admin: Sync all provider websites (rate-limited)",
  })
  async bulkSync(@Req() req: Request) {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Only GoStork admins can bulk sync");
    }

    const result =
      await this.knowledgeService.bulkSyncProviderWebsites();

    return result;
  }

  @Get("rules")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List all expert guidance rules" })
  async listRules(@Req() req: Request) {
    const user = req.user as any;
    const roles: string[] = user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
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
    if (!roles.includes("GOSTORK_ADMIN")) {
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
  async listWhispers(@Req() req: Request) {
    const user = req.user as any;
    if (!user.providerId) {
      throw new ForbiddenException("Only providers can view whisper questions");
    }

    return this.prisma.silentQuery.findMany({
      where: { providerId: user.providerId },
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
    if (!user.providerId) {
      throw new ForbiddenException("Only providers can answer whisper questions");
    }

    if (!body.answer || !body.answer.trim()) {
      throw new BadRequestException("answer is required");
    }

    const query = await this.prisma.silentQuery.findUnique({ where: { id } });
    if (!query || query.providerId !== user.providerId) {
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
        providerId: user.providerId,
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
        where: { id: user.providerId },
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
