import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request } from "express";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { BillingService } from "./billing.service";
import { NotificationService } from "../notifications/notification.service";
import { StorageService } from "../storage/storage.service";
import { prisma } from "../../../db";

/**
 * Endpoints for the cost-sheet + invoice flow that sits between the AI chat and Stripe billing.
 *
 *  - Provider can send a cost sheet (informational quote) at any time. Each send creates
 *    a new ProviderQuote row and supersedes prior ones.
 *  - Provider or admin can trigger an invoice manually; the auto-trigger lives in
 *    chat-router.ts when the parent confirms readiness.
 *  - Live invoice preview powers the popup in the "Send Cost Sheet" sidebar form so
 *    the provider sees the future invoice split before sending.
 */
@Controller()
export class CostSheetController {
  private readonly logger = new Logger(CostSheetController.name);
  private readonly db = prisma;

  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  // ─── Auth helpers ──────────────────────────────────────────────────────────

  private async loadAuthorisedSession(sessionId: string, user: any) {
    const session = await this.db.aiChatSession.findUnique({
      where: { id: sessionId },
      include: { user: true, provider: true },
    });
    if (!session) throw new NotFoundException("Session not found");
    if (!session.providerId) {
      throw new HttpException("This session is not linked to a provider yet", HttpStatus.BAD_REQUEST);
    }

    const roles: string[] = user?.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN");
    const isProviderMember = user?.providerId && user.providerId === session.providerId;
    if (!isAdmin && !isProviderMember) {
      throw new ForbiddenException("You don't have access to this session");
    }

    return { session, isAdmin, isProviderMember };
  }

  // ─── Send a cost sheet ─────────────────────────────────────────────────────

  @Post("api/sessions/:sessionId/cost-sheet")
  @UseGuards(SessionOrJwtGuard)
  @UseInterceptors(FileInterceptor("file"))
  async sendCostSheet(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @UploadedFile() file: any,
    @Body() body: { totalCostCents?: string | number; notes?: string },
  ) {
    const user = req.user as any;
    const { session, isAdmin } = await this.loadAuthorisedSession(sessionId, user);

    const totalCostCents = Number(body.totalCostCents);
    if (!Number.isFinite(totalCostCents) || totalCostCents <= 0) {
      throw new HttpException("totalCostCents must be a positive number", HttpStatus.BAD_REQUEST);
    }

    // Upload file to GCS if provided. Public URL so parent + provider + admin can all open it.
    let costSheetFileUrl: string | null = null;
    let costSheetFileName: string | null = null;
    if (file?.buffer && file?.originalname) {
      const allowed = [".pdf", ".csv", ".txt", ".docx", ".xlsx", ".png", ".jpg", ".jpeg"];
      const ext = "." + String(file.originalname).split(".").pop()?.toLowerCase();
      if (!allowed.includes(ext)) {
        throw new HttpException(
          `Unsupported file type. Allowed: ${allowed.join(", ")}`,
          HttpStatus.BAD_REQUEST,
        );
      }
      const destPath = `cost-sheets/${session.providerId}/${sessionId}/${Date.now()}-${file.originalname}`;
      costSheetFileUrl = await this.storage.uploadBufferPublic(file.buffer, destPath, file.mimetype || "application/octet-stream");
      costSheetFileName = file.originalname;
    }

    // Supersede prior active quotes for this session, then create the new one.
    const quote = await this.db.$transaction(async tx => {
      await tx.providerQuote.updateMany({
        where: { sessionId, supersededAt: null },
        data: { supersededAt: new Date() },
      });
      return tx.providerQuote.create({
        data: {
          sessionId,
          providerId: session.providerId!,
          parentUserId: session.userId,
          totalCostCents,
          costSheetFileUrl,
          costSheetFileName,
          notes: body.notes?.trim() || null,
          source: isAdmin ? "ADMIN_OVERRIDE" : "PROVIDER",
          createdByUserId: user.id || null,
        },
      });
    });

    // Post the inline chat card for both parent and provider to see.
    await this.db.aiChatMessage.create({
      data: {
        sessionId,
        role: "assistant",
        content: `${session.provider?.name || "Your provider"} sent a cost sheet. Total: $${(totalCostCents / 100).toFixed(2)}`,
        senderType: "system",
        senderName: session.provider?.name || "Provider",
        uiCardType: "cost_sheet",
        uiCardData: {
          quoteId: quote.id,
          providerName: session.provider?.name || null,
          totalCostCents,
          costSheetFileUrl,
          costSheetFileName,
          notes: quote.notes,
          sentAt: quote.createdAt.toISOString(),
        },
      },
    });

    // Notify the parent (email + SMS). Failures are logged inside the notification method.
    if (session.user?.email) {
      await this.notifications.sendCostSheetReadyToParent({
        parentUserId: session.userId,
        parentName: session.user.name || session.user.firstName || "there",
        parentEmail: session.user.email,
        parentPhone: session.user.mobileNumber,
        providerName: session.provider?.name || "Your provider",
        providerId: session.providerId!,
        sessionId,
        totalCostFormatted: `$${(totalCostCents / 100).toFixed(2)}`,
        hasFile: !!costSheetFileUrl,
      }).catch(err => this.logger.error(`Cost-sheet parent notification failed: ${err.message}`));
    }

    this.logger.log(
      `Cost sheet sent: session=${sessionId} quote=${quote.id} total=$${(totalCostCents / 100).toFixed(2)} source=${quote.source}`,
    );

    return { quote };
  }

  // ─── List cost sheets for the right-side panel ─────────────────────────────

  @Get("api/sessions/:sessionId/cost-sheets")
  @UseGuards(SessionOrJwtGuard)
  async listCostSheets(@Req() req: Request, @Param("sessionId") sessionId: string) {
    const user = req.user as any;
    // Parents accessing their own session must also work - relax the auth check here.
    const session = await this.db.aiChatSession.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true, providerId: true },
    });
    if (!session) throw new NotFoundException("Session not found");

    const roles: string[] = user?.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN");
    const isProviderMember = user?.providerId && user.providerId === session.providerId;
    const isParent = user?.id === session.userId;
    if (!isAdmin && !isProviderMember && !isParent) {
      throw new ForbiddenException("You don't have access to this session");
    }

    const quotes = await this.db.providerQuote.findMany({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
    });
    return { quotes };
  }

  // ─── Manually trigger an invoice (provider or admin) ───────────────────────

  @Post("api/sessions/:sessionId/invoice")
  @UseGuards(SessionOrJwtGuard)
  async triggerInvoice(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @Body() body: { parentPaysOverrideCents?: number; description?: string },
  ) {
    const user = req.user as any;
    const { session, isAdmin } = await this.loadAuthorisedSession(sessionId, user);

    const invoice = await this.billing.createInvoice({
      sessionId,
      providerId: session.providerId!,
      parentUserId: session.userId,
      triggerSource: isAdmin ? "ADMIN_MANUAL" : "PROVIDER_MANUAL",
      parentPaysOverrideCents: body?.parentPaysOverrideCents,
      description: body?.description,
    });

    // Post the invoice card + send email/SMS to the parent.
    await this.billing.sendPaymentNotificationsToParent(invoice.id);

    return { invoice };
  }

  // ─── Live invoice preview (powers the cost-sheet popup) ────────────────────

  @Post("api/billing/invoice-preview")
  @UseGuards(SessionOrJwtGuard)
  async invoicePreview(
    @Req() req: Request,
    @Body() body: { sessionId: string; totalCostCents: number; parentPaysOverrideCents?: number },
  ) {
    const user = req.user as any;
    if (!body?.sessionId) throw new HttpException("sessionId required", HttpStatus.BAD_REQUEST);
    const totalCostCents = Number(body.totalCostCents);
    if (!Number.isFinite(totalCostCents) || totalCostCents < 0) {
      throw new HttpException("totalCostCents must be a non-negative number", HttpStatus.BAD_REQUEST);
    }

    const { session } = await this.loadAuthorisedSession(body.sessionId, user);

    const feeConfig = await this.db.referralFeeConfig.findUnique({
      where: { providerId: session.providerId! },
    });
    if (!feeConfig || !feeConfig.isActive) {
      throw new HttpException("This provider has no active billing configuration", HttpStatus.BAD_REQUEST);
    }

    // Mirrors the resolution rules in BillingService.createInvoice so the preview matches reality.
    let parentPaysCents: number;
    if (body.parentPaysOverrideCents != null) {
      parentPaysCents = Number(body.parentPaysOverrideCents);
    } else if (feeConfig.parentPaysBasis === "TOTAL_COST") {
      parentPaysCents = totalCostCents;
    } else {
      parentPaysCents = feeConfig.defaultServiceAmount ? Math.round(Number(feeConfig.defaultServiceAmount)) : 0;
    }

    const { referralFeeAmount, providerPayoutAmount } = this.billing.computeFee(
      { feeType: feeConfig.feeType, flatAmount: feeConfig.flatAmount, percentage: feeConfig.percentage },
      totalCostCents,
      parentPaysCents,
    );

    return {
      feeType: feeConfig.feeType,
      percentage: feeConfig.percentage ? Number(feeConfig.percentage) : null,
      flatAmount: feeConfig.flatAmount ? Number(feeConfig.flatAmount) : null,
      parentPaysBasis: feeConfig.parentPaysBasis,
      currency: feeConfig.currency,
      // Amounts in cents
      feeBasisCents: totalCostCents,
      parentPaysCents,
      referralFeeAmount,
      providerPayoutAmount,
    };
  }
}
