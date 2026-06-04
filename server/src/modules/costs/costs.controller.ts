import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Query,
  Body,
  Req,
  Res,
  Sse,
  Inject,
  HttpException,
  HttpStatus,
  Logger,
  UseGuards,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { Request, Response } from "express";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { CostsService } from "./costs.service";
import { CostsAiService } from "./costs-ai.service";
import { NotificationService } from "../notifications/notification.service";
import { AppEventsService } from "../notifications/app-events.service";
import { PrismaService } from "../prisma/prisma.service";

const MAX_FILE_SIZE = 20 * 1024 * 1024;

function parseMultipart(
  body: Buffer,
  boundary: string,
): { filename: string; contentType: string; data: Buffer; fields: Record<string, string> } | null {
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

  let fileResult: { filename: string; contentType: string; data: Buffer } | null = null;
  const fields: Record<string, string> = {};

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const headerStr = part.subarray(0, headerEnd).toString("utf-8");
    let dataStart = headerEnd + 4;
    let dataEnd = part.length;
    if (part[dataEnd - 1] === 0x0a && part[dataEnd - 2] === 0x0d) {
      dataEnd -= 2;
    }

    if (headerStr.includes("filename=")) {
      const filenameMatch = headerStr.match(/filename="([^"]+)"/);
      const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);
      fileResult = {
        filename: filenameMatch?.[1] || "upload",
        contentType: ctMatch?.[1]?.trim() || "application/octet-stream",
        data: part.subarray(dataStart, dataEnd),
      };
    } else {
      const nameMatch = headerStr.match(/name="([^"]+)"/);
      if (nameMatch) {
        fields[nameMatch[1]] = part.subarray(dataStart, dataEnd).toString("utf-8");
      }
    }
  }

  if (!fileResult) return null;
  return { ...fileResult, fields };
}

function collectBody(req: Request, maxSize: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        req.destroy();
        reject(new Error("File too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

@Controller("api/costs")
export class CostsController {
  private readonly logger = new Logger(CostsController.name);

  constructor(
    @Inject(CostsService) private readonly costsService: CostsService,
    @Inject(CostsAiService) private readonly costsAiService: CostsAiService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(AppEventsService) private readonly appEvents: AppEventsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  // backgroundParseAndSave moved to CostsService.runBackgroundParse so the
  // same pipeline is reused by the startup resume sweep (when the server
  // restarts mid-parse and we need to pick up orphaned PARSING sheets).

  @Sse("events")
  @UseGuards(SessionOrJwtGuard)
  sseEvents(@Req() req: Request): Observable<MessageEvent> {
    const user = req.user as any;
    const userId = user.id;
    req.on("close", () => this.appEvents.disconnect(userId));
    return this.appEvents.subscribe(userId);
  }

  private getUserFromRequest(req: Request): any {
    return (req as any).user;
  }

  private assertAdmin(req: Request) {
    const user = this.getUserFromRequest(req);
    if (!user?.roles?.includes("GOSTORK_ADMIN")) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }
  }

  private assertProviderOrAdmin(req: Request, providerId: string) {
    const user = this.getUserFromRequest(req);
    if (!user) throw new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED);
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");
    if (!isAdmin && user.providerId !== providerId) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }
  }

  private assertAuthenticated(req: Request) {
    const user = this.getUserFromRequest(req);
    if (!user) throw new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED);
  }

  @Get("templates/:providerType")
  @UseGuards(SessionOrJwtGuard)
  async getTemplates(
    @Param("providerType") providerType: string,
    @Query("subType") subType: string,
  ) {
    return this.costsService.getTemplatesByProviderType(providerType, subType || undefined);
  }

  @Post("upload")
  @UseGuards(SessionOrJwtGuard)
  async uploadFile(@Req() req: Request, @Res() res: Response) {
    const contentTypeHeader = req.headers["content-type"] || "";
    if (!contentTypeHeader.includes("multipart/form-data")) {
      return res.status(400).json({ message: "Content-Type must be multipart/form-data" });
    }

    const boundaryMatch = contentTypeHeader.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      return res.status(400).json({ message: "Missing boundary" });
    }

    try {
      const body = await collectBody(req, MAX_FILE_SIZE);
      const parsed = parseMultipart(body, boundaryMatch[1]);
      if (!parsed) {
        return res.status(400).json({ message: "No file found in request" });
      }

      const providerId = parsed.fields.providerId;
      if (!providerId) {
        return res.status(400).json({ message: "providerId is required" });
      }

      this.assertProviderOrAdmin(req, providerId);

      const providerTypeId = parsed.fields.providerTypeId;
      const subType = parsed.fields.subType;
      const providerTypeFromClient = parsed.fields.providerType;
      const programId = parsed.fields.programId;
      const { sheet, buffer, contentType, programId: resolvedProgramId } = await this.costsService.uploadFile(
        providerId,
        parsed.data,
        parsed.filename,
        parsed.contentType,
        providerTypeId,
        subType,
        programId,
      );

      // When a provider offers >1 service (e.g. Eggspecting: IVF Clinic +
      // Surrogacy Agency + Egg Donor Agency), the client sends whichever
      // service is first by createdAt as `providerType`. That signal is
      // misleading: a surrogacy PDF dropped on this provider would be
      // parsed under the IVF prompt branch and force-classified as an IVF
      // subtype. Override to "multi-service" so the AI prompt uses the
      // union branch and the AI's content-detected serviceTypes drives
      // classification instead.
      const activeServiceCount = await this.prisma.providerService.count({
        where: { providerId, status: "APPROVED" },
      });
      const providerType = activeServiceCount > 1 ? "multi-service" : providerTypeFromClient;

      if (providerType) {
        this.costsService.runBackgroundParse(sheet.id, buffer, contentType, providerType, parsed.filename, subType);
      }

      // Return the programId (whether pre-existing or auto-created in the
      // upload-first flow) so the client can refresh the program list and
      // expand the new row.
      return res.status(201).json({ ...sheet, programId: resolvedProgramId });
    } catch (err: any) {
      this.logger.error(`Upload failed: ${err.message}`);
      if (err.message === "File too large") {
        return res.status(413).json({ message: "File too large. Maximum size is 20MB." });
      }
      if (err.status) return res.status(err.status).json({ message: err.message });
      return res.status(500).json({ message: err.message });
    }
  }

  @Delete(":sheetId/cancel")
  @UseGuards(SessionOrJwtGuard)
  async cancelUpload(@Param("sheetId") sheetId: string, @Req() req: Request) {
    const sheet = await this.costsService.getSheet(sheetId);
    if (!sheet) throw new HttpException("Sheet not found", HttpStatus.NOT_FOUND);
    this.assertProviderOrAdmin(req, sheet.providerId);
    return this.costsService.cancelUpload(sheetId);
  }

  @Delete(":sheetId/file")
  @UseGuards(SessionOrJwtGuard)
  async deleteFile(@Param("sheetId") sheetId: string, @Req() req: Request) {
    const sheet = await this.costsService.getSheet(sheetId);
    if (!sheet) throw new HttpException("Sheet not found", HttpStatus.NOT_FOUND);
    this.assertProviderOrAdmin(req, sheet.providerId);
    return this.costsService.deleteFile(sheetId);
  }

  @Delete("reset/:providerId")
  @UseGuards(SessionOrJwtGuard)
  async resetProviderCosts(
    @Param("providerId") providerId: string,
    @Query("providerTypeId") providerTypeId: string,
    @Query("subType") subType: string,
    @Query("programId") programId: string,
    @Req() req: Request,
  ) {
    this.assertProviderOrAdmin(req, providerId);
    const result = await this.costsService.resetProviderCosts(providerId, providerTypeId || undefined, subType || undefined, programId || undefined);

    const user = this.getUserFromRequest(req);
    const provider = await this.prisma.provider.findUnique({ where: { id: providerId } });
    const providerName = provider?.name || "Unknown Provider";

    this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" } },
      select: { id: true },
    }).then((admins) => {
      this.appEvents.emit({
        type: "cost_sheet_deleted",
        payload: { providerName, providerId },
        targetUserIds: admins.map((a) => a.id),
        actorUserId: user?.id,
      });
    }).catch((err) => this.logger.warn(`Failed to emit cost sheet delete SSE: ${err.message}`));

    return result;
  }

  @Get(":sheetId/download")
  @UseGuards(SessionOrJwtGuard)
  async downloadFile(@Param("sheetId") sheetId: string, @Req() req: Request, @Res() res: Response) {
    const sheet = await this.costsService.getSheet(sheetId);
    if (!sheet) throw new HttpException("Sheet not found", HttpStatus.NOT_FOUND);
    this.assertProviderOrAdmin(req, sheet.providerId);
    const { url } = await this.costsService.getDownloadUrl(sheetId);
    res.redirect(url);
  }

  @Get("provider/:providerId")
  @UseGuards(SessionOrJwtGuard)
  async getProviderSheets(
    @Param("providerId") providerId: string,
    @Query("status") status: string,
    @Query("providerTypeId") providerTypeId: string,
    @Query("subType") subType: string,
    @Query("programId") programId: string,
    @Req() req: Request,
  ) {
    this.assertProviderOrAdmin(req, providerId);
    return this.costsService.getProviderSheets(providerId, status || undefined, providerTypeId || undefined, subType || undefined, programId || undefined);
  }

  @Get("provider/:providerId/approved")
  @UseGuards(SessionOrJwtGuard)
  async getApprovedSheet(
    @Param("providerId") providerId: string,
    @Query("providerTypeId") providerTypeId: string,
    @Query("subType") subType: string,
    @Query("programId") programId: string,
    @Req() req: Request,
  ) {
    this.assertProviderOrAdmin(req, providerId);
    return this.costsService.getApprovedMasterSheet(providerId, providerTypeId || undefined, subType || undefined, programId || undefined);
  }

  @Get("sheet/:sheetId")
  @UseGuards(SessionOrJwtGuard)
  async getSheet(@Param("sheetId") sheetId: string, @Req() req: Request) {
    const sheet = await this.costsService.getSheet(sheetId);
    if (!sheet) throw new HttpException("Sheet not found", HttpStatus.NOT_FOUND);
    this.assertProviderOrAdmin(req, sheet.providerId);
    return sheet;
  }

  @Post("submit")
  @UseGuards(SessionOrJwtGuard)
  async submitSheet(
    @Body() body: { providerId: string; items: any[]; sheetId?: string; providerTypeId?: string; subType?: string; programId?: string },
    @Req() req: Request,
  ) {
    if (!body.providerId) throw new HttpException("providerId required", HttpStatus.BAD_REQUEST);
    this.assertProviderOrAdmin(req, body.providerId);

    if (body.sheetId) {
      const existing = await this.costsService.getSheet(body.sheetId);
      if (!existing) throw new HttpException("Sheet not found", HttpStatus.NOT_FOUND);
      if (existing.providerId !== body.providerId) {
        throw new HttpException("Sheet does not belong to this provider", HttpStatus.FORBIDDEN);
      }
    }

    const user = this.getUserFromRequest(req);
    const isAdmin = user?.roles?.includes("GOSTORK_ADMIN") ?? false;
    const submitted = await this.costsService.submitCostSheet(body.providerId, body.items || [], body.sheetId, body.providerTypeId, body.subType, body.programId);

    if (isAdmin) {
      const approved = await this.costsService.approveSheet((submitted as any).id);
      return approved;
    }

    const provider = await this.prisma.provider.findUnique({ where: { id: body.providerId } });
    const providerName = provider?.name || "Unknown Provider";

    this.notifications.sendCostSheetSubmitted({
      providerName,
      providerId: body.providerId,
      version: (submitted as any)?.version || 1,
      submitterEmail: user?.email || "",
      submitterName: user?.name || "Provider",
    }).catch((err) => this.logger.warn(`Failed to send submit notification: ${err.message}`));

    this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" } },
      select: { id: true },
    }).then((admins) => {
      this.appEvents.emit({
        type: "cost_sheet_submitted",
        payload: {
          providerName,
          providerId: body.providerId,
          version: (submitted as any)?.version || 1,
          sheetId: (submitted as any)?.id,
        },
        targetUserIds: admins.map((a) => a.id),
        actorUserId: user?.id,
      });
    }).catch((err) => this.logger.warn(`Failed to emit cost sheet SSE: ${err.message}`));

    return submitted;
  }

  @Post("approve/:sheetId")
  @UseGuards(SessionOrJwtGuard)
  async approveSheet(@Param("sheetId") sheetId: string, @Req() req: Request) {
    this.assertAdmin(req);
    const result = await this.costsService.approveSheet(sheetId);

    const provider = await this.prisma.provider.findUnique({ where: { id: result.providerId } });
    const providerUsers = await this.prisma.user.findMany({
      where: { providerId: result.providerId },
      select: { id: true, email: true },
    });
    this.notifications.sendCostSheetApproved({
      providerName: provider?.name || "Unknown Provider",
      providerUserEmails: providerUsers.map((u) => u.email),
      version: result.version,
    }).catch((err) => this.logger.warn(`Failed to send approval notification: ${err.message}`));

    const user = this.getUserFromRequest(req);
    this.appEvents.emit({
      type: "cost_sheet_approved",
      payload: {
        providerName: provider?.name || "Unknown Provider",
        providerId: result.providerId,
        version: result.version,
        sheetId: result.id,
      },
      targetUserIds: providerUsers.map((u) => u.id),
      actorUserId: user?.id,
    });

    return result;
  }

  @Post("reject/:sheetId")
  @UseGuards(SessionOrJwtGuard)
  async rejectSheet(
    @Param("sheetId") sheetId: string,
    @Body() body: { feedback: string },
    @Req() req: Request,
  ) {
    this.assertAdmin(req);
    if (!body.feedback) throw new HttpException("feedback required", HttpStatus.BAD_REQUEST);
    const result = await this.costsService.rejectSheet(sheetId, body.feedback);

    const provider = await this.prisma.provider.findUnique({ where: { id: result.providerId } });
    const providerUsers = await this.prisma.user.findMany({
      where: { providerId: result.providerId },
      select: { id: true, email: true },
    });
    this.notifications.sendCostSheetRejected({
      providerName: provider?.name || "Unknown Provider",
      providerUserEmails: providerUsers.map((u) => u.email),
      feedback: body.feedback,
      version: result.version,
    }).catch((err) => this.logger.warn(`Failed to send rejection notification: ${err.message}`));

    const user = this.getUserFromRequest(req);
    this.appEvents.emit({
      type: "cost_sheet_rejected",
      payload: {
        providerName: provider?.name || "Unknown Provider",
        providerId: result.providerId,
        version: result.version,
        sheetId: result.id,
        feedback: body.feedback,
      },
      targetUserIds: providerUsers.map((u) => u.id),
      actorUserId: user?.id,
    });

    return result;
  }

  @Patch("sheet/:sheetId")
  @UseGuards(SessionOrJwtGuard)
  async updateSheet(
    @Param("sheetId") sheetId: string,
    @Body() body: { items: any[] },
    @Req() req: Request,
  ) {
    const sheet = await this.costsService.getSheet(sheetId);
    if (!sheet) throw new HttpException("Sheet not found", HttpStatus.NOT_FOUND);
    this.assertProviderOrAdmin(req, sheet.providerId);
    return this.costsService.updateSheetItems(sheetId, body.items || []);
  }

  /**
   * Clinic confirms or overrides the AI's proposed classification on a
   * freshly-parsed (or legacy-migrated) sheet. Setting any of tab/subType/
   * isFixedCost flips the source to 'clinic_confirmed' and clears
   * legacyNeedsReview.
   */
  @Patch("sheet/:sheetId/classification")
  @UseGuards(SessionOrJwtGuard)
  async updateSheetClassification(
    @Param("sheetId") sheetId: string,
    @Body() body: { tab?: string; subType?: string; isFixedCost?: boolean; confirm?: boolean },
    @Req() req: Request,
  ) {
    const sheet = await this.costsService.getSheet(sheetId);
    if (!sheet) throw new HttpException("Sheet not found", HttpStatus.NOT_FOUND);
    this.assertProviderOrAdmin(req, sheet.providerId);
    return this.costsService.saveClinicClassification(sheetId, body as any);
  }

  /**
   * Resolved template for a (tab, subType) pair. Mandatory flags are
   * collapsed against the caller-provided isFixedCost so the UI gets a
   * straight list to render.
   */
  @Get("templates/v2/:tab/:subType")
  @UseGuards(SessionOrJwtGuard)
  async getResolvedTemplate(
    @Param("tab") tab: string,
    @Param("subType") subType: string,
    @Query("isFixedCost") isFixedCost: string,
  ) {
    const fixed = isFixedCost === "true";
    return this.costsService.getResolvedTemplate(tab, subType, fixed);
  }

  /**
   * Parent-facing: which cost-sheet subtypes does this parent qualify for?
   * Drives the filter on the clinic profile cost grid.
   */
  @Get("parent/:parentAccountId/matching-subtypes")
  @UseGuards(SessionOrJwtGuard)
  async getMatchingSubtypesForParent(
    @Param("parentAccountId") parentAccountId: string,
    @Req() req: Request,
  ) {
    this.assertAuthenticated(req);
    return this.costsService.getMatchingSubtypesForParent(parentAccountId);
  }

  /**
   * Parent-facing: which of this clinic's approved programs apply to the
   * given parent. Returns one card payload per program.
   */
  @Get("provider/:providerId/parent-programs")
  @UseGuards(SessionOrJwtGuard)
  async getProviderParentPrograms(
    @Param("providerId") providerId: string,
    @Query("parentAccountId") parentAccountId: string,
    @Query("specificDonorId") specificDonorId: string,
    @Query("specificDonorType") specificDonorType: string,
    @Query("showAll") showAll: string,
    @Req() req: Request,
  ) {
    this.assertAuthenticated(req);
    if (!parentAccountId) {
      throw new HttpException("parentAccountId required", HttpStatus.BAD_REQUEST);
    }
    return this.costsService.getProviderParentPrograms(
      providerId,
      parentAccountId,
      specificDonorId || undefined,
      specificDonorType || undefined,
      showAll === "true" || showAll === "1",
    );
  }

  @Post("save-draft")
  @UseGuards(SessionOrJwtGuard)
  async saveDraft(
    @Body() body: { providerId: string; items: any[]; sheetId?: string; providerTypeId?: string; subType?: string; programId?: string },
    @Req() req: Request,
  ) {
    this.assertProviderOrAdmin(req, body.providerId);
    return this.costsService.saveDraft(body.providerId, body.items || [], body.sheetId, body.providerTypeId, body.subType, body.programId);
  }

  @Post("custom-quote/:providerId/:parentId")
  @UseGuards(SessionOrJwtGuard)
  async createCustomQuote(
    @Param("providerId") providerId: string,
    @Param("parentId") parentId: string,
    @Req() req: Request,
  ) {
    this.assertProviderOrAdmin(req, providerId);
    return this.costsService.createCustomQuote(providerId, parentId);
  }

  @Get("programs")
  @UseGuards(SessionOrJwtGuard)
  async getPrograms(
    @Query("providerId") providerId: string,
    @Query("providerTypeId") providerTypeId: string,
    @Query("subType") subType: string,
    @Req() req: Request,
  ) {
    if (!providerId) throw new HttpException("providerId required", HttpStatus.BAD_REQUEST);
    this.assertProviderOrAdmin(req, providerId);
    return this.costsService.getPrograms(providerId, providerTypeId || undefined, subType || undefined);
  }

  @Post("programs")
  @UseGuards(SessionOrJwtGuard)
  async createProgram(
    @Body() body: { providerId: string; providerTypeId?: string; subType?: string; tab?: string; name: string; country: string },
    @Req() req: Request,
  ) {
    if (!body.providerId || !body.name || !body.country) {
      throw new HttpException("providerId, name, and country are required", HttpStatus.BAD_REQUEST);
    }
    this.assertProviderOrAdmin(req, body.providerId);
    return this.costsService.createProgram(body.providerId, body.providerTypeId || null, body.subType || null, body.name, body.country, body.tab || null);
  }

  @Patch("programs/:programId")
  @UseGuards(SessionOrJwtGuard)
  async updateProgram(
    @Param("programId") programId: string,
    @Body() body: { name?: string; country?: string; subType?: string; tab?: string; serviceTypes?: string[]; subTypes?: string[] },
    @Req() req: Request,
  ) {
    const existing = await this.prisma.costProgram.findUnique({ where: { id: programId } });
    if (!existing) throw new HttpException("Program not found", HttpStatus.NOT_FOUND);
    this.assertProviderOrAdmin(req, existing.providerId);
    return this.costsService.updateProgram(
      programId,
      body.name ?? existing.name,
      body.country ?? existing.country,
      body.subType,
      body.tab,
      body.serviceTypes,
      body.subTypes,
    );
  }

  @Delete("programs/:programId")
  @UseGuards(SessionOrJwtGuard)
  async deleteProgram(@Param("programId") programId: string, @Req() req: Request) {
    const existing = await this.prisma.costProgram.findUnique({ where: { id: programId } });
    if (!existing) throw new HttpException("Program not found", HttpStatus.NOT_FOUND);
    this.assertProviderOrAdmin(req, existing.providerId);
    return this.costsService.deleteProgram(programId);
  }

  @Post("send-quote/:sheetId")
  @UseGuards(SessionOrJwtGuard)
  async sendQuote(@Param("sheetId") sheetId: string, @Req() req: Request) {
    const sheet = await this.costsService.getSheet(sheetId);
    if (!sheet) throw new HttpException("Sheet not found", HttpStatus.NOT_FOUND);
    if (!sheet.parentClientId) {
      throw new HttpException("Can only send custom quotes, not master sheets", HttpStatus.BAD_REQUEST);
    }
    this.assertProviderOrAdmin(req, sheet.providerId);
    return this.costsService.sendQuote(sheetId);
  }

  @Post("parse")
  @UseGuards(SessionOrJwtGuard)
  async parseFile(@Req() req: Request, @Res() res: Response) {
    const user = this.getUserFromRequest(req);
    if (!user) throw new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED);
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");
    if (!isAdmin && !user.providerId) {
      throw new HttpException("Only providers or admins can parse cost files", HttpStatus.FORBIDDEN);
    }

    const contentTypeHeader = req.headers["content-type"] || "";
    if (!contentTypeHeader.includes("multipart/form-data")) {
      return res.status(400).json({ message: "Content-Type must be multipart/form-data" });
    }

    const boundaryMatch = contentTypeHeader.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      return res.status(400).json({ message: "Missing boundary" });
    }

    try {
      const body = await collectBody(req, MAX_FILE_SIZE);
      const parsed = parseMultipart(body, boundaryMatch[1]);
      if (!parsed) {
        return res.status(400).json({ message: "No file found in request" });
      }

      const providerType = parsed.fields.providerType;
      if (!providerType) {
        return res.status(400).json({ message: "providerType field is required" });
      }

      const items = await this.costsAiService.parseFile(
        parsed.data,
        parsed.contentType,
        providerType,
        parsed.filename,
      );

      return res.status(200).json({ items });
    } catch (err: any) {
      this.logger.error(`Parse failed: ${err.message}`);
      return res.status(500).json({ message: err.message });
    }
  }

  @Post("seed-templates")
  @UseGuards(SessionOrJwtGuard)
  async seedTemplates(@Req() req: Request, @Body() body: { force?: boolean }) {
    this.assertAdmin(req);
    return this.costsService.seedTemplates(body?.force === true);
  }

  @Post("backfill-template-ids")
  @UseGuards(SessionOrJwtGuard)
  async backfillTemplateIds(@Req() req: Request) {
    this.assertAdmin(req);
    return this.costsService.backfillTemplateFieldIds();
  }

}
