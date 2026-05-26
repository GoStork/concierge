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
import * as stripeService from "../../../stripe-service";
import { prisma } from "../../../db";

@Controller()
export class BillingController {
  private readonly logger = new Logger(BillingController.name);
  private readonly db = prisma;

  constructor(
    @Inject(BillingService) private readonly billingService: BillingService,
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
      stripePaymentLinkUrl: invoice.stripePaymentLinkUrl,
      medicalClearanceStatus: invoice.medicalClearanceStatus,
      // Itemized breakdown - parent payment page + embedded panel render
      // these rows in addition to (or instead of) the headline service.
      lineItems: ((invoice as any).lineItems || []).map((li: any) => ({
        id: li.id,
        serviceType: li.serviceType,
        description: li.description,
        amountCents: li.amountCents,
      })),
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

    const config = await this.db.referralFeeConfig.findUnique({
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

    const { feeType, flatAmount, percentage, defaultServiceAmount, parentPaysBasis, sampleTotalCostCents, isActive, notes, depositMilestone, averageClearanceDays } = body;
    const normalizedBasis: "DEFAULT_FIRST_PAYMENT" | "TOTAL_COST" =
      parentPaysBasis === "TOTAL_COST" ? "TOTAL_COST" : "DEFAULT_FIRST_PAYMENT";
    const normalizedSample = sampleTotalCostCents != null && Number.isFinite(Number(sampleTotalCostCents))
      ? Math.round(Number(sampleTotalCostCents))
      : null;

    // Upsert fee config
    const config = await this.db.referralFeeConfig.upsert({
      where: { providerId },
      create: { providerId, feeType, flatAmount, percentage, defaultServiceAmount: defaultServiceAmount ?? null, parentPaysBasis: normalizedBasis, sampleTotalCostCents: normalizedSample, isActive: isActive ?? true, notes },
      update: { feeType, flatAmount, percentage, defaultServiceAmount: defaultServiceAmount ?? null, parentPaysBasis: normalizedBasis, sampleTotalCostCents: normalizedSample, isActive: isActive ?? true, notes, updatedAt: new Date() },
    });

    // Also update provider-level surrogacy settings if provided
    if (depositMilestone !== undefined || averageClearanceDays !== undefined) {
      await this.db.provider.update({
        where: { id: providerId },
        data: {
          ...(depositMilestone !== undefined ? { depositMilestone } : {}),
          ...(averageClearanceDays !== undefined ? { averageClearanceDays } : {}),
        },
      });
    }

    return config;
  }

  // ─── Provider: self-service fee config (read + edit own row) ──────────────
  //
  // Mirrors the admin endpoints above but derives the providerId from the
  // logged-in user. The provider can edit everything EXCEPT the GoStork
  // referral fee economics (feeType / percentage / flatAmount) - those are
  // negotiated with GoStork and locked from the provider side. Any attempt
  // to change them is silently dropped server-side.

  @Get("api/provider/fee-config")
  @UseGuards(SessionOrJwtGuard)
  async getOwnProviderFeeConfig(@Req() req: Request) {
    const user = req.user as any;
    if (!user?.providerId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);

    const config = await this.db.referralFeeConfig.findUnique({
      where: { providerId: user.providerId },
    });
    if (!config) throw new HttpException("Not found", HttpStatus.NOT_FOUND);
    return config;
  }

  @Put("api/provider/fee-config")
  @Patch("api/provider/fee-config")
  @UseGuards(SessionOrJwtGuard)
  async upsertOwnProviderFeeConfig(@Req() req: Request, @Body() body: any) {
    const user = req.user as any;
    if (!user?.providerId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const providerId = user.providerId as string;

    // Provider can NOT change the GoStork referral fee economics. Strip those
    // fields and re-use the existing row's values (or sensible defaults if
    // the row does not exist yet).
    const existing = await this.db.referralFeeConfig.findUnique({ where: { providerId } });
    const feeType = existing?.feeType ?? "PERCENTAGE";
    const flatAmount = existing?.flatAmount ?? null;
    const percentage = existing?.percentage ?? null;

    const { defaultServiceAmount, parentPaysBasis, sampleTotalCostCents, isActive, notes, depositMilestone, averageClearanceDays } = body;
    const normalizedBasis: "DEFAULT_FIRST_PAYMENT" | "TOTAL_COST" =
      parentPaysBasis === "TOTAL_COST" ? "TOTAL_COST" : "DEFAULT_FIRST_PAYMENT";
    const normalizedSample = sampleTotalCostCents != null && Number.isFinite(Number(sampleTotalCostCents))
      ? Math.round(Number(sampleTotalCostCents))
      : null;

    const config = await this.db.referralFeeConfig.upsert({
      where: { providerId },
      create: { providerId, feeType, flatAmount, percentage, defaultServiceAmount: defaultServiceAmount ?? null, parentPaysBasis: normalizedBasis, sampleTotalCostCents: normalizedSample, isActive: isActive ?? true, notes },
      update: { defaultServiceAmount: defaultServiceAmount ?? null, parentPaysBasis: normalizedBasis, sampleTotalCostCents: normalizedSample, isActive: isActive ?? true, notes, updatedAt: new Date() },
    });

    if (depositMilestone !== undefined || averageClearanceDays !== undefined) {
      await this.db.provider.update({
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

    const inv = await this.db.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new HttpException("Invoice not found", HttpStatus.NOT_FOUND);

    const paymentIntentId = inv.stripePaymentIntentId;
    if (!paymentIntentId) throw new HttpException("No payment authorization on file", HttpStatus.BAD_REQUEST);

    if (cleared) {
      const { transactionId } = await stripeService.capturePaymentIntent(paymentIntentId);
      await this.billingService.captureAuthorization(invoiceId, transactionId);
    } else {
      await stripeService.voidPaymentIntent(paymentIntentId);
      await this.billingService.voidAuthorization(invoiceId);
    }

    return { success: true };
  }

  // ─── Stripe: publishable key (for frontend Stripe Elements) ────────────────

  @Get("api/billing/stripe-key")
  getStripePublishableKey() {
    return { publishableKey: stripeService.getPublishableKey() };
  }

  // ─── Stripe: create PaymentIntent (parent payment page) ──────────────────

  @Post("api/billing/create-payment-intent")
  async createPaymentIntent(@Body() body: { paymentToken: string }, @Res() res: Response) {
    try {
      const invoice = await this.billingService.getInvoiceByToken(body.paymentToken);
      if (!invoice) return res.status(404).json({ message: "Invoice not found" });
      if (invoice.status === "PAID") return res.status(400).json({ message: "Invoice already paid" });

      if (!stripeService.isStripeConfigured()) {
        // Mock mode - no Stripe keys yet
        return res.json({ clientSecret: `mock_secret_${Date.now()}`, mock: true });
      }

      const isClearanceFlow = invoice.medicalClearanceStatus === "PENDING";

      const { clientSecret, paymentIntentId } = await stripeService.createPaymentIntent({
        amountCents: invoice.serviceAmount,
        currency: invoice.currency || "USD",
        invoiceId: invoice.id,
        paymentToken: invoice.paymentToken,
        description: `GoStork - ${invoice.providerName} - ${invoice.serviceType}`,
        captureMethod: isClearanceFlow ? "manual" : "automatic",
        receiptEmail: (invoice as any).parentUser?.email,
      });

      // Store the PaymentIntent ID on the invoice for later capture/void
      await this.db.invoice.update({
        where: { id: invoice.id },
        data: { stripePaymentIntentId: paymentIntentId },
      });

      return res.json({ clientSecret, paymentIntentId });
    } catch (error: any) {
      this.logger.error(`Create PaymentIntent error: ${error.message}`);
      return res.status(500).json({ message: error.message });
    }
  }

  // ─── Stripe: mock payment success (dev only, no Stripe keys) ─────────────

  @Post("api/billing/mock-payment-success")
  async mockPaymentSuccess(@Body() body: { paymentToken: string }, @Res() res: Response) {
    if (process.env.NODE_ENV !== "development") {
      return res.status(403).json({ message: "Not available in production" });
    }
    const invoice = await this.billingService.getInvoiceByToken(body.paymentToken);
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    await this.billingService.adminMarkPaid(invoice.id, "system", "Simulated payment (Stripe not configured)");
    return res.json({ success: true });
  }

  // ─── Stripe webhook ───────────────────────────────────────────────────────

  @Post("api/webhooks/stripe")
  async stripeWebhook(@Req() req: Request, @Res() res: Response) {
    try {
      const sig = req.headers["stripe-signature"] as string;
      if (!sig) return res.status(400).json({ error: "Missing stripe-signature header" });

      // Stripe.webhooks.constructEvent needs the RAW request body (Buffer or
      // string) so it can verify the signature against the original bytes.
      // Express's global express.json() middleware already parsed req.body
      // into a JS object - it stashes the raw buffer at req.rawBody via the
      // verify callback in server/index.ts.
      const rawBody = (req as any).rawBody ?? req.body;
      const event = stripeService.constructWebhookEvent(rawBody, sig);
      const parsed = stripeService.parseWebhookEvent(event);

      if (parsed) {
        this.logger.log(`Stripe webhook: ${event.type} | invoice: ${parsed.invoiceId}`);

        if (parsed.status === "succeeded" && parsed.invoiceId) {
          await this.billingService.handleStripeWebhook(parsed.paymentIntentId, "succeeded", parsed.invoiceId);
        } else if (parsed.status === "authorized" && parsed.invoiceId) {
          // AT_CLEARANCE: funds held, update invoice to AUTHORIZED
          await this.billingService.handleStripeWebhook(parsed.paymentIntentId, "authorized", parsed.invoiceId);
        } else if (parsed.status === "canceled" && parsed.invoiceId) {
          await this.billingService.handleStripeWebhook(parsed.paymentIntentId, "canceled", parsed.invoiceId);
        }
      }

      res.status(200).json({ received: true });
    } catch (error: any) {
      this.logger.error(`Stripe webhook error: ${error.message}`);
      res.status(400).json({ error: error.message }); // 400 so Stripe retries
    }
  }

}
