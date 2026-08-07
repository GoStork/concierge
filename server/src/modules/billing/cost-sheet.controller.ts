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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { emitJourneyEvent } from "../../../journey-events";
import { Request, Response } from "express";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { BillingService, humanizeLineServiceType, providerTypeNameToServiceType } from "./billing.service";
import { NotificationService } from "../notifications/notification.service";
import { StorageService } from "../storage/storage.service";
import { prisma } from "../../../db";
import { formatMoneyCents } from "../../lib/format-money";
import { resolveQuotePaymentSchedule } from "../costs/payment-schedule.service";
import { resolveParentEvaSessionId } from "../../../parent-visibility";

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

    // A cost sheet is paperwork between the family and the provider. It rides
    // the 3-way chat, never the family's private conversation with Eva.
    //
    // This is reachable, not theoretical: a whisper stamps providerId onto the
    // Eva thread, the provider inbox lists sessions by providerId, so that
    // thread can appear in the sidebar and be picked. The auto-draft service
    // was fixed to never TARGET it; this is the manual twin.
    const accountIds = session.user?.parentAccountId
      ? (await this.db.user.findMany({
          where: { parentAccountId: session.user.parentAccountId },
          select: { id: true },
        })).map((u: any) => u.id)
      : [session.userId];
    const evaSessionId = await resolveParentEvaSessionId(accountIds, this.db);
    if (evaSessionId && evaSessionId === session.id) {
      throw new ForbiddenException(
        "This is the family's private concierge conversation. Cost sheets go in your shared chat with them.",
      );
    }

    return { session, isAdmin, isProviderMember, roles };
  }

  // ─── Payment schedule snapshot ─────────────────────────────────────────────

  /**
   * The provider's published installment plan, shaped for the parent, to be
   * frozen onto the quote being sent.
   *
   * Uses the provider's most recently updated APPROVED master sheet that
   * actually carries a confirmed schedule. Returns null when they have none,
   * which is the common case and renders as no timeline at all - never as an
   * invented one.
   */
  private resolvePaymentScheduleSnapshot(providerId: string, sessionId: string) {
    return resolveQuotePaymentSchedule(this.db, providerId, { sessionId });
  }

  // ─── Send a cost sheet ─────────────────────────────────────────────────────

  @Post("api/sessions/:sessionId/cost-sheet")
  @UseGuards(SessionOrJwtGuard)
  @UseInterceptors(FileInterceptor("file"))
  async sendCostSheet(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @UploadedFile() file: any,
    @Body() body: { totalCostCents?: string | number; notes?: string; quantity?: string | number; lineItems?: string },
  ) {
    const user = req.user as any;
    const { session, isAdmin, roles: csRoles } = await this.loadAuthorisedSession(sessionId, user);
    if (!isAdmin && (csRoles.includes("BILLING_MANAGER") || csRoles.includes("SCHEDULER"))) {
      throw new ForbiddenException("Your role cannot send cost sheets");
    }

    const totalCostCents = Number(body.totalCostCents);
    if (!Number.isFinite(totalCostCents) || totalCostCents <= 0) {
      throw new HttpException("totalCostCents must be a positive number", HttpStatus.BAD_REQUEST);
    }

    // Quantity = number of priced units the total represents (e.g. 2 vials).
    // Stored on the quote so FLAT referral fees scale correctly when the
    // invoice is later created. Defaults to 1.
    const rawQty = Number(body.quantity);
    const quantity = Number.isFinite(rawQty) && rawQty >= 1 ? Math.round(rawQty) : 1;

    // Structured line items sent by the picker (one entry per vial / egg
    // lot). The form encodes the array as a JSON string so multer can carry
    // it alongside the file upload. We parse + lightly validate before
    // persisting to ProviderQuote.lineItems so the invoice form can later
    // pre-fill with the same rows instead of collapsing them into one line.
    let parsedLineItems: Array<{
      serviceType: string;
      label?: string;
      quantity?: number;
      unitCostCents?: number;
      amountCents: number;
      description?: string;
    }> | null = null;
    if (typeof body.lineItems === "string" && body.lineItems.trim()) {
      try {
        const raw = JSON.parse(body.lineItems);
        if (Array.isArray(raw)) {
          parsedLineItems = raw
            .filter((it: any) => it && typeof it === "object" && Number.isFinite(Number(it.amountCents)) && Number(it.amountCents) > 0)
            .map((it: any) => ({
              serviceType: String(it.serviceType || "OTHER"),
              label: typeof it.label === "string" ? it.label : undefined,
              quantity: Number.isFinite(Number(it.quantity)) ? Math.round(Number(it.quantity)) : undefined,
              unitCostCents: Number.isFinite(Number(it.unitCostCents)) ? Math.round(Number(it.unitCostCents)) : undefined,
              amountCents: Math.round(Number(it.amountCents)),
              description: typeof it.description === "string" ? it.description : undefined,
            }));
          if (parsedLineItems.length === 0) parsedLineItems = null;
        }
      } catch {
        // Malformed JSON: ignore silently - the quote still has its total
        // and notes, so the invoice falls back to a single combined line.
        parsedLineItems = null;
      }
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

    // Snapshot the provider's installment plan onto the quote. Taken at send
    // time and frozen: a parent plans around the schedule they were shown, so
    // a later edit to the source sheet must not rewrite a quote already in
    // their hands. Falls back to the provider's most recent approved sheet
    // when the send isn't tied to a specific one.
    const paymentScheduleSnapshot = await this.resolvePaymentScheduleSnapshot(session.providerId!, sessionId);

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
          quantity,
          costSheetFileUrl,
          costSheetFileName,
          notes: body.notes?.trim() || null,
          lineItems: parsedLineItems ?? undefined,
          paymentSchedule: paymentScheduleSnapshot ?? undefined,
          source: isAdmin ? "ADMIN_OVERRIDE" : "PROVIDER",
          createdByUserId: user.id || null,
        },
      });
    });

    void emitJourneyEvent({ eventType: "COST_SHEET_SHARED", parentUserId: session.userId, providerId: session.providerId, sessionId, actorRole: "provider", metadata: { quoteId: quote.id } });

    // Post the inline chat card for both parent and provider to see.
    await this.db.aiChatMessage.create({
      data: {
        sessionId,
        role: "assistant",
        content: `${session.provider?.name || "Your provider"} sent you a cost sheet. Total: ${formatMoneyCents(totalCostCents)}${
          paymentScheduleSnapshot
            ? `. It includes a payment schedule so you can see what is due and when.`
            : ""
        }`,
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
          parentAcknowledgedAt: null,
          sentAt: quote.createdAt.toISOString(),
          paymentSchedule: paymentScheduleSnapshot ?? null,
          // The provider reads their own copy of this card, so the sentence
          // above it has to make sense from their side too - a parent must
          // never read about themselves in the third person in their own chat.
          providerContent: `You sent a cost sheet. Total: ${formatMoneyCents(totalCostCents)}${
            paymentScheduleSnapshot
              ? `, with a ${paymentScheduleSnapshot.tranches.length}-payment schedule attached.`
              : "."
          }`,
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
        totalCostFormatted: formatMoneyCents(totalCostCents),
        hasFile: !!costSheetFileUrl,
      }).catch(err => this.logger.error(`Cost-sheet parent notification failed: ${err.message}`));
    }

    this.logger.log(
      `Cost sheet sent: session=${sessionId} quote=${quote.id} total=${formatMoneyCents(totalCostCents)} source=${quote.source}`,
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

  // ─── Download a cost-sheet file via signed URL ─────────────────────────────
  //
  // The raw URL returned by uploadBufferPublic only works when the GCS bucket
  // grants allUsers read access. With uniform bucket-level access enabled the
  // upload still succeeds but anonymous viewers get AccessDenied. This route
  // verifies the caller is a participant in the session, mints a 1-hour
  // signed URL on demand, and 302-redirects so the browser fetches the PDF
  // with proper authentication.
  @Get("api/sessions/:sessionId/cost-sheets/:quoteId/file")
  @UseGuards(SessionOrJwtGuard)
  async downloadCostSheetFile(
    @Req() req: Request,
    @Res() res: Response,
    @Param("sessionId") sessionId: string,
    @Param("quoteId") quoteId: string,
  ) {
    const user = req.user as any;
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

    const quote = await this.db.providerQuote.findUnique({
      where: { id: quoteId },
      select: { id: true, sessionId: true, costSheetFileUrl: true, costSheetFileName: true },
    });
    if (!quote || quote.sessionId !== sessionId) {
      throw new NotFoundException("Cost sheet not found");
    }
    if (!quote.costSheetFileUrl) {
      throw new NotFoundException("This cost sheet has no attached file");
    }

    // Strip the "https://storage.googleapis.com/{bucket}/" prefix to recover
    // the GCS object path. Works whether the bucket is the default one or
    // overridden via env.
    const m = quote.costSheetFileUrl.match(/^https?:\/\/storage\.googleapis\.com\/[^/]+\/(.+)$/);
    if (!m) {
      throw new HttpException("Stored cost-sheet URL is not a GCS object", HttpStatus.INTERNAL_SERVER_ERROR);
    }
    const objectPath = decodeURIComponent(m[1]);

    try {
      const signed = await this.storage.getSignedUrl(objectPath, 60);
      return res.redirect(302, signed);
    } catch (err: any) {
      this.logger.error(`Cost-sheet signed URL failed for quote ${quoteId}: ${err?.message}`);
      throw new HttpException("Failed to generate download link", HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─── Cancel a cost sheet (provider or admin) ───────────────────────────────
  // Marks the quote as superseded (the same way Edit & Resend does) without
  // creating a replacement, and stamps `cancelledAt` into the chat card's
  // uiCardData so the UI can show a "Cancelled" indicator and hide the
  // parent-side Acknowledge/Have questions actions.

  @Post("api/sessions/:sessionId/cost-sheets/:quoteId/cancel")
  @UseGuards(SessionOrJwtGuard)
  async cancelCostSheet(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @Param("quoteId") quoteId: string,
  ) {
    const user = req.user as any;
    await this.loadAuthorisedSession(sessionId, user);

    const quote = await this.db.providerQuote.findUnique({ where: { id: quoteId } });
    if (!quote) throw new NotFoundException("Cost sheet not found");
    if (quote.sessionId !== sessionId) {
      throw new ForbiddenException("Cost sheet does not belong to this session");
    }
    if (quote.supersededAt) {
      throw new HttpException("Cost sheet is no longer active", HttpStatus.BAD_REQUEST);
    }

    const now = new Date();
    const updated = await this.db.providerQuote.update({
      where: { id: quoteId },
      data: { supersededAt: now },
    });

    // Flip the in-chat card so both sides see "Cancelled" and the parent's
    // Acknowledge / Have questions buttons stop rendering.
    try {
      const existingCardMsg = await this.db.aiChatMessage.findFirst({
        where: {
          sessionId,
          uiCardType: "cost_sheet",
          uiCardData: { path: ["quoteId"], equals: quoteId },
        },
        select: { id: true, uiCardData: true },
      });
      if (existingCardMsg) {
        const updatedData = {
          ...((existingCardMsg.uiCardData as any) || {}),
          cancelledAt: now.toISOString(),
        };
        await this.db.aiChatMessage.update({
          where: { id: existingCardMsg.id },
          data: { uiCardData: updatedData },
        });
      }
    } catch (e: any) {
      this.logger.warn(`Failed to update cost-sheet card cancelled state: ${e?.message}`);
    }

    // Short system note so the thread shows the cancellation explicitly.
    try {
      const actorLabel = user?.firstName || user?.name || "Provider";
      await this.db.aiChatMessage.create({
        data: {
          sessionId,
          role: "assistant",
          content: `${actorLabel} cancelled this cost sheet (${formatMoneyCents(quote.totalCostCents)}).`,
          senderType: "system",
          senderName: "Provider",
        },
      });
    } catch (e: any) {
      this.logger.warn(`Failed to post cost-sheet cancellation message: ${e?.message}`);
    }

    return { quote: updated };
  }

  // ─── Manually trigger an invoice (provider or admin) ───────────────────────

  @Post("api/sessions/:sessionId/invoice")
  @UseGuards(SessionOrJwtGuard)
  async triggerInvoice(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @Body()
    body: {
      parentPaysOverrideCents?: number;
      description?: string;
      lineItems?: Array<{ serviceType: string; description?: string | null; amountCents: number }>;
    },
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
      lineItems: body?.lineItems,
    });

    // Post the invoice card + send email/SMS to the parent.
    await this.billing.sendPaymentNotificationsToParent(invoice.id);

    return { invoice };
  }

  // ─── Cancel an invoice (provider or admin) ─────────────────────────────────
  // Provider clicks Cancel on their in-chat invoice card. Only AWAITING_PAYMENT
  // invoices can be cancelled this way - paid/authorized ones go through the
  // admin refund flow instead. Updates the chat card status so the parent's
  // Pay button disappears.

  @Post("api/sessions/:sessionId/invoices/:invoiceId/cancel")
  @UseGuards(SessionOrJwtGuard)
  async cancelInvoice(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @Param("invoiceId") invoiceId: string,
  ) {
    const user = req.user as any;
    await this.loadAuthorisedSession(sessionId, user);

    const existing = await this.db.invoice.findUnique({ where: { id: invoiceId } });
    if (!existing) throw new NotFoundException("Invoice not found");
    if (existing.sessionId !== sessionId) {
      throw new ForbiddenException("Invoice does not belong to this session");
    }

    const actorLabel = user?.firstName || user?.name || existing.providerName;
    const invoice = await this.billing.cancelInvoice(invoiceId, actorLabel);
    return { invoice };
  }

  // ─── List a session's invoices (parent sidebar + provider views) ───────────
  // Parents see their payment history for this conversation next to the cost
  // sheets; providers/admins see the same list. Read-only.

  @Get("api/sessions/:sessionId/invoices")
  @UseGuards(SessionOrJwtGuard)
  async listSessionInvoices(@Req() req: Request, @Param("sessionId") sessionId: string) {
    const user = req.user as any;
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

    const invoices = await this.db.invoice.findMany({
      where: { sessionId },
      include: { lineItems: { orderBy: { displayOrder: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
    return {
      invoices: invoices.map((inv: any) => ({
        id: inv.id,
        paymentToken: inv.paymentToken,
        serviceType: inv.serviceType,
        providerName: inv.providerName,
        serviceAmount: inv.serviceAmount,
        status: inv.status,
        dueAt: inv.dueAt,
        createdAt: inv.createdAt,
        paidAt: inv.paidAt ?? null,
        description: inv.description,
        medicalClearanceStatus: inv.medicalClearanceStatus ?? null,
        lineItems: inv.lineItems,
      })),
    };
  }

  // ─── Read a single invoice (for edit prefill) ──────────────────────────────
  // Returns line items + description so the provider's "Edit & Resend" flow can
  // seed the invoice form with what was already sent.

  @Get("api/sessions/:sessionId/invoices/:invoiceId")
  @UseGuards(SessionOrJwtGuard)
  async getInvoice(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @Param("invoiceId") invoiceId: string,
  ) {
    const user = req.user as any;
    await this.loadAuthorisedSession(sessionId, user);

    const invoice = await this.db.invoice.findUnique({
      where: { id: invoiceId },
      include: { lineItems: { orderBy: { displayOrder: "asc" } } },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.sessionId !== sessionId) {
      throw new ForbiddenException("Invoice does not belong to this session");
    }
    return { invoice };
  }

  // ─── Live invoice preview (powers the cost-sheet popup) ────────────────────

  @Post("api/billing/invoice-preview")
  @UseGuards(SessionOrJwtGuard)
  async invoicePreview(
    @Req() req: Request,
    @Body() body: {
      sessionId: string;
      totalCostCents: number;
      parentPaysOverrideCents?: number;
      // When supplied, the preview is computed per-line using each service's
      // ReferralFeeConfig and the line-item amounts (matching the multi-service
      // billing logic in BillingService.createInvoice).
      lineItems?: Array<{ serviceType: string; amountCents: number }>;
      // Number of priced units the total represents (vials, egg lots).
      // FLAT referral fees scale by this multiplier so a 2-vial preview also
      // doubles GoStork's flat fee. Ignored for PERCENTAGE.
      quantity?: number;
    },
  ) {
    const user = req.user as any;
    if (!body?.sessionId) throw new HttpException("sessionId required", HttpStatus.BAD_REQUEST);
    const totalCostCents = Number(body.totalCostCents);
    if (!Number.isFinite(totalCostCents) || totalCostCents < 0) {
      throw new HttpException("totalCostCents must be a non-negative number", HttpStatus.BAD_REQUEST);
    }
    const rawQty = Number(body.quantity);
    const previewQuantity = Number.isFinite(rawQty) && rawQty >= 1 ? Math.round(rawQty) : 1;

    const { session } = await this.loadAuthorisedSession(body.sessionId, user);

    // Latest quote drives the FLAT multiplier for the invoice-sidebar preview
    // path (no `quantity` in body since the quote already exists). For the
    // cost-sheet form path, `body.quantity` is sent live and takes precedence.
    const latestQuote = await this.billing.getLatestProviderQuote(body.sessionId);
    const effectiveQuantity = body.quantity != null
      ? previewQuantity
      : (latestQuote?.quantity ?? 1);

    const provider = await this.db.provider.findUnique({
      where: { id: session.providerId! },
      include: {
        referralFeeConfigs: true,
        services: { where: { status: "APPROVED" }, include: { providerType: { select: { name: true } } } },
      },
    });
    if (!provider) throw new HttpException("Provider not found", HttpStatus.NOT_FOUND);

    const configByService = new Map<string, typeof provider.referralFeeConfigs[number]>();
    for (const c of provider.referralFeeConfigs) {
      if (c.isActive) configByService.set(c.serviceType, c);
    }
    if (configByService.size === 0) {
      throw new HttpException("This provider has no active billing configuration", HttpStatus.BAD_REQUEST);
    }

    // Multi-service path: per-line preview, summed.
    const hasLineItems = Array.isArray(body.lineItems) && body.lineItems.length > 0;
    if (hasLineItems) {
      const lines: Array<{
        serviceType: string;
        serviceTypeLabel: string;
        amountCents: number;
        referralFeeAmount: number;
        providerPayoutAmount: number;
        feeType: string;
        percentage: number | null;
        flatAmount: number | null;
      }> = [];
      let parentPaysCents = 0;
      let referralFeeAmount = 0;
      for (const li of body.lineItems!) {
        const amount = Math.round(Number(li.amountCents) || 0);
        if (amount <= 0) continue;
        const cfg = configByService.get(li.serviceType);
        if (!cfg) {
          throw new HttpException(
            `No referral fee configured for ${humanizeLineServiceType(li.serviceType)} on this provider.`,
            HttpStatus.BAD_REQUEST,
          );
        }
        const { referralFeeAmount: lineFee, providerPayoutAmount: linePayout } =
          this.billing.computeFee(cfg, amount, amount, effectiveQuantity);
        parentPaysCents += amount;
        referralFeeAmount += lineFee;
        lines.push({
          serviceType: li.serviceType,
          serviceTypeLabel: humanizeLineServiceType(li.serviceType),
          amountCents: amount,
          referralFeeAmount: lineFee,
          providerPayoutAmount: linePayout,
          feeType: cfg.feeType,
          percentage: cfg.percentage ? Number(cfg.percentage) : null,
          flatAmount: cfg.flatAmount ? Number(cfg.flatAmount) : null,
        });
      }
      referralFeeAmount = Math.min(referralFeeAmount, parentPaysCents);
      const providerPayoutAmount = parentPaysCents - referralFeeAmount;
      return {
        multiService: true,
        currency: provider.referralFeeConfigs[0]?.currency || "USD",
        feeBasisCents: totalCostCents,
        parentPaysCents,
        referralFeeAmount,
        providerPayoutAmount,
        lines,
      };
    }

    // Single-service fallback: use the provider's primary approved service's config.
    const primaryServiceType = provider.services
      .map(s => providerTypeNameToServiceType(s.providerType?.name))
      .find(st => configByService.has(st))
      ?? Array.from(configByService.keys())[0];
    const feeConfig = configByService.get(primaryServiceType)!;

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
      effectiveQuantity,
    );

    return {
      multiService: false,
      serviceType: primaryServiceType,
      feeType: feeConfig.feeType,
      percentage: feeConfig.percentage ? Number(feeConfig.percentage) : null,
      flatAmount: feeConfig.flatAmount ? Number(feeConfig.flatAmount) : null,
      parentPaysBasis: feeConfig.parentPaysBasis,
      currency: feeConfig.currency,
      feeBasisCents: totalCostCents,
      parentPaysCents,
      referralFeeAmount,
      providerPayoutAmount,
    };
  }
}
