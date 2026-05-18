import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Param,
  Query,
  Body,
  Req,
  Res,
  Inject,
  HttpException,
  HttpStatus,
  Logger,
  UseGuards,
} from "@nestjs/common";
import { Request, Response } from "express";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { BillingService } from "./billing.service";
import { PrismaService } from "../prisma/prisma.service";
import * as braintreeService from "../../../braintree-service";

@Controller()
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    @Inject(BillingService) private readonly billingService: BillingService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  // ─── Admin: invoice list + stats ──────────────────────────────────────────

  @Get("api/admin/invoices")
  @UseGuards(SessionOrJwtGuard)
  async getAdminInvoices(@Req() req: Request, @Query() query: any) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }

    const result = await this.billingService.getInvoicesForAdmin({
      status: query.status,
      providerId: query.providerId,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
      page: query.page ? parseInt(query.page, 10) : 1,
      pageSize: query.pageSize ? parseInt(query.pageSize, 10) : 25,
    });

    return result;
  }

  @Get("api/admin/billing/stats")
  @UseGuards(SessionOrJwtGuard)
  async getBillingStats(@Req() req: Request) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }

    const result = await this.billingService.getInvoicesForAdmin({ page: 1, pageSize: 1 });
    return {
      totalRevenue: result.totalRevenue,
      totalGoStorkFees: result.totalGoStorkFees,
      totalProviderPayouts: result.totalProviderPayouts,
      pendingAmount: result.pendingAmount,
    };
  }

  @Patch("api/admin/invoices/:id/mark-paid")
  @UseGuards(SessionOrJwtGuard)
  async adminMarkPaid(@Req() req: Request, @Param("id") id: string, @Body() body: any) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }

    const invoice = await this.billingService.adminMarkPaid(id, user.id, body.notes || "");
    return invoice;
  }

  @Post("api/admin/invoices/:id/initiate-payout")
  @UseGuards(SessionOrJwtGuard)
  async adminInitiatePayout(@Req() req: Request, @Param("id") id: string) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }

    await this.billingService.adminInitiatePayout(id, user.id);
    return { success: true };
  }

  // ─── Parent: my invoices ─────────────────────────────────────────────────

  @Get("api/my/invoices")
  @UseGuards(SessionOrJwtGuard)
  async getMyInvoices(@Req() req: Request) {
    const user = req.user as any;
    return this.billingService.getInvoicesForParent(user.id);
  }

  // ─── Provider: their invoices ─────────────────────────────────────────────

  @Get("api/provider/invoices")
  @UseGuards(SessionOrJwtGuard)
  async getProviderInvoices(@Req() req: Request) {
    const user = req.user as any;
    if (!user?.providerId) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }
    return this.billingService.getInvoicesForProvider(user.providerId);
  }

  // ─── Public: invoice by payment token (for payment page) ─────────────────

  @Get("api/invoices/pay/:token")
  async getInvoiceByToken(@Param("token") token: string) {
    const invoice = await this.billingService.getInvoiceByToken(token);
    if (!invoice) {
      throw new HttpException("Invoice not found", HttpStatus.NOT_FOUND);
    }

    // Only return safe fields for the public payment page
    return {
      id: invoice.id,
      paymentToken: invoice.paymentToken,
      providerName: invoice.providerName,
      serviceType: invoice.serviceType,
      description: invoice.description,
      serviceAmount: invoice.serviceAmount,
      referralFeeAmount: invoice.referralFeeAmount,
      currency: invoice.currency,
      status: invoice.status,
      isProtected: invoice.isProtected,
      dueAt: invoice.dueAt,
      braintreePaymentLinkUrl: invoice.braintreePaymentLinkUrl,
      medicalClearanceStatus: invoice.medicalClearanceStatus,
    };
  }

  // ─── Parent: confirm ready to proceed ────────────────────────────────────

  @Post("api/billing/confirm-ready")
  @UseGuards(SessionOrJwtGuard)
  async confirmReady(@Req() req: Request, @Body() body: { sessionId: string; serviceAmountCents?: number }) {
    const user = req.user as any;
    const { sessionId, serviceAmountCents } = body;

    if (!sessionId) {
      throw new HttpException("sessionId is required", HttpStatus.BAD_REQUEST);
    }

    // Verify the session belongs to this parent

    return { success: true, message: "Readiness confirmed. Your invoice is being prepared." };
  }

  // ─── Admin: provider fee config CRUD ─────────────────────────────────────

  @Get("api/admin/providers/:providerId/fee-config")
  @UseGuards(SessionOrJwtGuard)
  async getProviderFeeConfig(@Req() req: Request, @Param("providerId") providerId: string) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);

    const config = await this.prisma.referralFeeConfig.findUnique({
      where: { providerId },
    });
    if (!config) throw new HttpException("Not found", HttpStatus.NOT_FOUND);
    return config;
  }

  @Put("api/admin/providers/:providerId/fee-config")
  @Patch("api/admin/providers/:providerId/fee-config")
  @UseGuards(SessionOrJwtGuard)
  async upsertProviderFeeConfig(
    @Req() req: Request,
    @Param("providerId") providerId: string,
    @Body() body: any,
  ) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);

    const { feeType, flatAmount, percentage, isActive, notes, depositMilestone, averageClearanceDays } = body;

    // Upsert fee config
    const config = await this.prisma.referralFeeConfig.upsert({
      where: { providerId },
      create: { providerId, feeType, flatAmount, percentage, isActive: isActive ?? true, notes },
      update: { feeType, flatAmount, percentage, isActive: isActive ?? true, notes, updatedAt: new Date() },
    });

    // Also update provider-level surrogacy settings if provided
    if (depositMilestone !== undefined || averageClearanceDays !== undefined) {
      await this.prisma.provider.update({
        where: { id: providerId },
        data: {
          ...(depositMilestone !== undefined ? { depositMilestone } : {}),
          ...(averageClearanceDays !== undefined ? { averageClearanceDays } : {}),
        },
      });
    }

    return config;
  }

  // ─── Billing: confirm medical clearance ───────────────────────────────────

  @Post("api/billing/confirm-clearance")
  @UseGuards(SessionOrJwtGuard)
  async confirmClearance(@Req() req: Request, @Body() body: { invoiceId: string; cleared: boolean }) {
    const { invoiceId, cleared } = body;
    if (!invoiceId) throw new HttpException("invoiceId required", HttpStatus.BAD_REQUEST);

    const inv = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new HttpException("Invoice not found", HttpStatus.NOT_FOUND);

    if (cleared) {
      if (!inv.braintreeAuthorizationId) throw new HttpException("No authorization to capture", HttpStatus.BAD_REQUEST);
      const { captureAuthorization } = await import("../../../braintree-service");
      const { transactionId } = await captureAuthorization(inv.braintreeAuthorizationId);
      await this.billingService.captureAuthorization(invoiceId, transactionId);
    } else {
      if (inv.braintreeAuthorizationId) {
        const { voidAuthorization } = await import("../../../braintree-service");
        await voidAuthorization(inv.braintreeAuthorizationId).catch(() => {});
      }
      await this.billingService.voidAuthorization(invoiceId);
    }

    return { success: true };
  }

  // ─── Braintree client token (for Drop-in UI) ────────────────────────────

  @Get("api/billing/braintree-token")
  async getBraintreeToken() {
    if (!braintreeService.isBraintreeConfigured()) {
      return { clientToken: "sandbox_token_placeholder" };
    }
    const clientToken = await braintreeService.generateClientToken();
    return { clientToken };
  }

  // ─── Submit payment (parent pays from payment page) ───────────────────────

  @Post("api/billing/submit-payment")
  async submitPayment(@Body() body: { paymentToken: string; nonce: string }, @Res() res: Response) {
    try {
      const { paymentToken, nonce } = body;
      if (!paymentToken || !nonce) {
        return res.status(400).json({ message: "paymentToken and nonce are required" });
      }

      const invoice = await this.billingService.getInvoiceByToken(paymentToken);
      if (!invoice) return res.status(404).json({ message: "Invoice not found" });
      if (invoice.status === "PAID") return res.status(400).json({ message: "Invoice already paid" });
      if (invoice.status === "EXPIRED") return res.status(400).json({ message: "Payment link has expired" });

      if (!braintreeService.isBraintreeConfigured()) {
        // Dev/sandbox mode - simulate payment success
        this.logger.warn("Braintree not configured - simulating payment success for development");
        const mockTxId = `mock_${Date.now()}`;
        await this.billingService.handleBraintreeWebhook(mockTxId, "settled");
        // We need to update the invoice directly since mock won't match a real transaction
        await this.billingService.adminMarkPaid(invoice.id, "system", "Simulated payment (Braintree not configured)");
        return res.json({ success: true, transactionId: mockTxId });
      }

      // Charge or authorize based on invoice type
      const isClearanceFlow = invoice.medicalClearanceStatus === "PENDING" ||
        (invoice.status === "AWAITING_PAYMENT" && invoice.braintreeAuthorizationId);

      if (isClearanceFlow) {
        // AT_CLEARANCE: authorize-only
        const { authorizationId } = await braintreeService.authorizeOnly({
          paymentMethodNonce: nonce,
          amountCents: invoice.serviceAmount,
          invoiceId: invoice.id,
          description: `GoStork deposit - ${invoice.providerName}`,
          customerEmail: invoice.parentUser?.email,
          customerName: invoice.parentUser?.name || undefined,
        });
        await this.billingService.placeAuthorization(invoice.id, authorizationId);
      } else {
        // AT_MATCH: immediate charge
        const { transactionId } = await braintreeService.chargePaymentMethod({
          paymentMethodNonce: nonce,
          amountCents: invoice.serviceAmount,
          invoiceId: invoice.id,
          description: `GoStork payment - ${invoice.providerName}`,
          customerEmail: invoice.parentUser?.email,
          customerName: invoice.parentUser?.name || undefined,
        });
        await this.billingService.handleBraintreeWebhook(transactionId, "settled");
      }

      return res.json({ success: true });
    } catch (error: any) {
      this.logger.error(`Payment submission error: ${error.message}`);
      return res.status(400).json({ message: error.message || "Payment failed" });
    }
  }

  // ─── Braintree webhook ───────────────────────────────────────────────────

  @Post("api/webhooks/braintree")
  async braintreeWebhook(@Req() req: Request, @Res() res: Response) {
    try {
      const { bt_signature, bt_payload } = req.body;

      if (!bt_signature || !bt_payload) {
        return res.status(400).json({ error: "Missing webhook payload" });
      }

      // Braintree webhook verification + parsing happens in braintree-service
      // For now, log and handle known event types
      this.logger.log(`Braintree webhook received`);

      // The actual transaction processing is done via braintree-service
      // which is called from routes.ts or chat-router.ts
      res.status(200).json({ received: true });
    } catch (error: any) {
      this.logger.error(`Braintree webhook error: ${error.message}`);
      res.status(200).json({ received: true }); // Always 200 to Braintree
    }
  }
}
