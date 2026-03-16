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

  private backgroundParseAndSave(
    sheetId: string,
    buffer: Buffer,
    contentType: string,
    providerType: string,
    filename: string,
  ) {
    (async () => {
      try {
        this.logger.log(`Background AI parse started for sheet ${sheetId}`);
        const items = await this.costsAiService.parseFile(buffer, contentType, providerType, filename);
        await this.costsService.saveParseResults(sheetId, items);
      } catch (err: any) {
        this.logger.error(`Background AI parse failed for sheet ${sheetId}: ${err.message}`);
        await this.costsService.markParseError(sheetId);
      }
    })();
  }

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
      const providerType = parsed.fields.providerType;
      const { sheet, buffer, contentType } = await this.costsService.uploadFile(
        providerId,
        parsed.data,
        parsed.filename,
        parsed.contentType,
        providerTypeId,
        subType,
      );

      if (providerType) {
        this.backgroundParseAndSave(sheet.id, buffer, contentType, providerType, parsed.filename);
      }

      return res.status(201).json(sheet);
    } catch (err: any) {
      this.logger.error(`Upload failed: ${err.message}`);
      if (err.message === "File too large") {
        return res.status(413).json({ message: "File too large. Maximum size is 20MB." });
      }
      if (err.status) return res.status(err.status).json({ message: err.message });
      return res.status(500).json({ message: err.message });
    }
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
    @Req() req: Request,
  ) {
    this.assertProviderOrAdmin(req, providerId);
    const result = await this.costsService.resetProviderCosts(providerId, providerTypeId || undefined, subType || undefined);

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
    @Req() req: Request,
  ) {
    this.assertProviderOrAdmin(req, providerId);
    return this.costsService.getProviderSheets(providerId, status || undefined, providerTypeId || undefined, subType || undefined);
  }

  @Get("provider/:providerId/approved")
  @UseGuards(SessionOrJwtGuard)
  async getApprovedSheet(
    @Param("providerId") providerId: string,
    @Query("providerTypeId") providerTypeId: string,
    @Query("subType") subType: string,
    @Req() req: Request,
  ) {
    this.assertProviderOrAdmin(req, providerId);
    return this.costsService.getApprovedMasterSheet(providerId, providerTypeId || undefined, subType || undefined);
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
    @Body() body: { providerId: string; items: any[]; sheetId?: string; providerTypeId?: string; subType?: string },
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

    const result = await this.costsService.submitCostSheet(body.providerId, body.items || [], body.sheetId, body.providerTypeId, body.subType);

    const user = this.getUserFromRequest(req);
    const provider = await this.prisma.provider.findUnique({ where: { id: body.providerId } });
    const providerName = provider?.name || "Unknown Provider";

    this.notifications.sendCostSheetSubmitted({
      providerName,
      providerId: body.providerId,
      version: (result as any)?.version || 1,
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
          version: (result as any)?.version || 1,
          sheetId: (result as any)?.id,
        },
        targetUserIds: admins.map((a) => a.id),
        actorUserId: user?.id,
      });
    }).catch((err) => this.logger.warn(`Failed to emit cost sheet SSE: ${err.message}`));

    return result;
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

  @Post("save-draft")
  @UseGuards(SessionOrJwtGuard)
  async saveDraft(
    @Body() body: { providerId: string; items: any[]; sheetId?: string; providerTypeId?: string; subType?: string },
    @Req() req: Request,
  ) {
    this.assertProviderOrAdmin(req, body.providerId);
    return this.costsService.saveDraft(body.providerId, body.items || [], body.sheetId, body.providerTypeId, body.subType);
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
