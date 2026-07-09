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
import geoip from "geoip-lite";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { BillingService } from "./billing.service";
import { SponsorshipService } from "../sponsorship/sponsorship.service";
import * as stripeService from "../../../stripe-service";
import { prisma } from "../../../db";
import { canSendProviderMessage } from "../../../../shared/roles";

/**
 * Best-effort buyer-country lookup. Decides whether to show our US-flavored
 * payment-method tile order or let Stripe optimize for the buyer's country.
 *
 * Resolution order (first hit wins):
 *  1. `?country=XX` query param - manual override for testing. Lets you
 *     simulate a US or non-US buyer without messing with VPNs.
 *  2. Geoip lookup on the real client IP. We try req.ip first (set by
 *     Express trust-proxy from x-forwarded-for), then walk x-forwarded-for
 *     ourselves in case the proxy chain is non-standard (ngrok in dev,
 *     CDN -> Render in prod).
 *  3. `BILLING_DEFAULT_BUYER_COUNTRY` env var - deployment-side default
 *     when nothing else resolves. Set to "US" in dev so local testing
 *     always hits the US order.
 *  4. undefined -> caller falls back to Stripe automatic ordering.
 *
 * Returns ISO-3166 alpha-2 like "US" / "GB" / "DE", or undefined.
 */
function getBuyerCountry(req: Request, logger: Logger): string | undefined {
  // 1. Explicit override (testing)
  const queryOverride = (req.query?.country as string | undefined)?.toUpperCase();
  if (queryOverride && /^[A-Z]{2}$/.test(queryOverride)) {
    logger.log(`getBuyerCountry: using ?country=${queryOverride} override`);
    return queryOverride;
  }

  // 2. Geoip lookup. Collect candidate IPs in order of trust.
  const candidates: string[] = [];
  if (req.ip) candidates.push(req.ip);
  const xff = (req.headers["x-forwarded-for"] as string | undefined) || "";
  for (const part of xff.split(",")) {
    const trimmed = part.trim();
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
  }
  const realIp = (req.headers["x-real-ip"] as string | undefined)?.trim();
  if (realIp && !candidates.includes(realIp)) candidates.push(realIp);

  for (const raw of candidates) {
    // Strip IPv6-mapped IPv4 prefix (::ffff:1.2.3.4 -> 1.2.3.4)
    const ip = raw.replace(/^::ffff:/i, "");
    if (!ip || ip === "::1" || ip.startsWith("127.") || ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172.")) {
      continue;
    }
    const looked = geoip.lookup(ip);
    if (looked?.country) {
      logger.log(`getBuyerCountry: ip=${ip} -> ${looked.country}`);
      return looked.country;
    }
    logger.log(`getBuyerCountry: ip=${ip} not found in geoip db`);
  }

  // 3. Env-var fallback - useful for dev (req.ip is always localhost)
  const envDefault = process.env.BILLING_DEFAULT_BUYER_COUNTRY?.toUpperCase();
  if (envDefault && /^[A-Z]{2}$/.test(envDefault)) {
    logger.log(`getBuyerCountry: using BILLING_DEFAULT_BUYER_COUNTRY=${envDefault}`);
    return envDefault;
  }

  logger.log(`getBuyerCountry: no country resolved (candidates=${JSON.stringify(candidates)}) - falling back to Stripe automatic`);
  return undefined;
}

const VALID_SERVICE_TYPES = new Set([
  "SURROGACY", "EGG_DONATION", "SPERM_DONATION", "IVF_CLINIC", "OTHER",
]);
function normalizeServiceType(raw: string): string {
  const s = (raw || "").toUpperCase();
  if (!VALID_SERVICE_TYPES.has(s)) {
    throw new HttpException(`Invalid serviceType: ${raw}`, HttpStatus.BAD_REQUEST);
  }
  return s;
}

@Controller()
export class BillingController {
  private readonly logger = new Logger(BillingController.name);
  private readonly db = prisma;

  constructor(
    @Inject(BillingService) private readonly billingService: BillingService,
    @Inject(SponsorshipService) private readonly sponsorshipService: SponsorshipService,
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
      serviceType: query.serviceType,
      search: query.search,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
      paidFrom: query.paidFrom ? new Date(query.paidFrom) : undefined,
      // paidTo: include the whole day by pushing to end-of-day when only a date is given
      paidTo: query.paidTo ? new Date(new Date(query.paidTo).setHours(23, 59, 59, 999)) : undefined,
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

  // Admin-only: list invoices currently at risk of provider recoupment -
  // i.e. a refund + transfer reversal happened AFTER the provider's bank
  // payout landed, so Stripe is recouping from a negative Connect balance
  // (no recoupment yet). Grouped by provider with totals so admins can see
  // who owes how much before chasing manual repayment.
  @Get("api/admin/billing/recoupments-pending")
  @UseGuards(SessionOrJwtGuard)
  async listRecoupmentsPending(@Req() req: Request) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }
    const invoices = await prisma.invoice.findMany({
      where: {
        payoutReversalAtRisk: true,
        payoutReversalRecoupedAt: null,
      },
      select: {
        id: true,
        providerId: true,
        providerPayoutAmount: true,
        payoutReversedAmount: true,
        refundedAmount: true,
        payoutReversedAt: true,
        currency: true,
        provider: { select: { id: true, name: true } },
        parentUser: { select: { id: true, name: true, email: true } },
      },
      orderBy: { payoutReversedAt: "desc" },
    });
    const byProvider = new Map<string, { providerId: string; providerName: string; invoices: any[]; totalAtRiskCents: number }>();
    for (const inv of invoices) {
      const key = inv.providerId;
      const at = inv.payoutReversedAmount || 0;
      const existing = byProvider.get(key);
      if (existing) {
        existing.invoices.push(inv);
        existing.totalAtRiskCents += at;
      } else {
        byProvider.set(key, {
          providerId: inv.providerId,
          providerName: inv.provider?.name || "Unknown",
          invoices: [inv],
          totalAtRiskCents: at,
        });
      }
    }
    return {
      totalInvoices: invoices.length,
      totalAtRiskCents: invoices.reduce((s, i) => s + (i.payoutReversedAmount || 0), 0),
      providers: Array.from(byProvider.values()),
    };
  }

  // Admin-only: refund a paid invoice. Full refund if amount omitted, else
  // partial. Stripe processes the refund async and fires charge.refunded,
  // which our webhook handler then uses to update DB + reverse provider's
  // proportional share. So this endpoint just kicks things off.
  @Post("api/admin/invoices/:id/refund")
  @UseGuards(SessionOrJwtGuard)
  async adminRefund(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: {
      amountCents?: number;
      reason?: "duplicate" | "fraudulent" | "requested_by_customer" | "other";
      notes?: string;
      mode?: "proportional" | "keep_platform_fee";
    },
  ) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }
    try {
      const result = await this.billingService.adminCreateRefund({
        invoiceId: id,
        amountCents: body?.amountCents,
        reason: body?.reason,
        notes: body?.notes,
        mode: body?.mode,
        actorUserId: user.id,
      });
      return result;
    } catch (e: any) {
      this.logger.error(`Admin refund failed for invoice ${id}: ${e?.message}`, e?.stack);
      throw new HttpException(e?.message || "Refund failed", HttpStatus.BAD_REQUEST);
    }
  }

  // Admin-only: re-emit the parent + provider receipt PDF emails for an
  // already-PAID invoice. Useful when the original emission failed (the
  // common case being the `billingRecipient` bug that silently swallowed
  // every receipt before that field was removed).
  @Post("api/admin/invoices/:id/resend-receipt")
  @UseGuards(SessionOrJwtGuard)
  async adminResendReceipt(@Req() req: Request, @Param("id") id: string) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }
    try {
      await this.billingService.emitPaymentReceipt(id);
      return { success: true };
    } catch (e: any) {
      this.logger.error(`Resend receipt failed for invoice ${id}: ${e?.message}`, e?.stack);
      throw new HttpException(
        `Resend receipt failed: ${e?.message || "unknown error"}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── Parent: my invoices ─────────────────────────────────────────────────

  @Get("api/my/invoices")
  @UseGuards(SessionOrJwtGuard)
  async getMyInvoices(@Req() req: Request) {
    const user = req.user as any;
    return this.billingService.getInvoicesForParent(user.id);
  }

  // ─── Parent: all their cost sheets across providers ────────────────────────
  // Powers the parent Billing page's Cost Sheets tab. Same scoping model as
  // /api/my/invoices (quotes addressed to this parent user).

  @Get("api/my/cost-sheets")
  @UseGuards(SessionOrJwtGuard)
  async getMyCostSheets(@Req() req: Request) {
    const user = req.user as any;
    if (!user?.id) throw new HttpException("Not authenticated", HttpStatus.FORBIDDEN);

    const quotes = await this.db.providerQuote.findMany({
      where: { parentUserId: user.id },
      orderBy: { createdAt: "desc" },
    });
    const providerIds = Array.from(new Set(quotes.map((q: any) => q.providerId).filter(Boolean)));
    const providers = providerIds.length
      ? await this.db.provider.findMany({
          where: { id: { in: providerIds as string[] } },
          select: { id: true, name: true, logoUrl: true },
        })
      : [];
    const providerById = new Map(providers.map((p: any) => [p.id, p]));

    return {
      quotes: quotes.map((q: any) => ({
        id: q.id,
        sessionId: q.sessionId,
        providerId: q.providerId,
        providerName: providerById.get(q.providerId)?.name ?? null,
        providerLogoUrl: providerById.get(q.providerId)?.logoUrl ?? null,
        totalCostCents: q.totalCostCents,
        costSheetFileName: q.costSheetFileName,
        hasFile: !!q.costSheetFileUrl,
        notes: q.notes,
        source: q.source,
        supersededAt: q.supersededAt,
        parentAcknowledgedAt: q.parentAcknowledgedAt,
        createdAt: q.createdAt,
      })),
    };
  }

  // ─── Provider: their cost sheets (all parents) ────────────────────────────

  @Get("api/provider/cost-sheets")
  @UseGuards(SessionOrJwtGuard)
  async getProviderCostSheets(@Req() req: Request) {
    const user = req.user as any;
    if (!user?.providerId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);

    const quotes = await this.db.providerQuote.findMany({
      where: { providerId: user.providerId },
      orderBy: { createdAt: "desc" },
    });
    // Quotes carry no service type - derive it from the session subject so
    // the Cost Sheets page can offer the same type filter as invoices.
    const quoteSessionIds = Array.from(new Set(quotes.map((q: any) => q.sessionId).filter(Boolean)));
    const quoteSessions = quoteSessionIds.length
      ? await this.db.aiChatSession.findMany({
          where: { id: { in: quoteSessionIds as string[] } },
          select: { id: true, subjectType: true },
        })
      : [];
    const serviceTypeBySession = new Map(
      quoteSessions.map((cs: any) => {
        const st = (cs.subjectType || "").toLowerCase();
        const svc = st.includes("egg") ? "EGG_DONATION"
          : st.includes("surrog") ? "SURROGACY"
          : st.includes("sperm") ? "SPERM_DONATION"
          : st.includes("ivf") || st.includes("clinic") || st.includes("doctor") ? "IVF_CLINIC"
          : null;
        return [cs.id, svc];
      }),
    );
    const parentIds = Array.from(new Set(quotes.map((q: any) => q.parentUserId).filter(Boolean)));
    const parents = parentIds.length
      ? await this.db.user.findMany({
          where: { id: { in: parentIds as string[] } },
          select: { id: true, name: true, firstName: true, lastName: true, email: true },
        })
      : [];
    const parentById = new Map(parents.map((u: any) => [u.id, u]));

    return {
      quotes: quotes.map((q: any) => {
        const p = parentById.get(q.parentUserId);
        return {
          id: q.id,
          sessionId: q.sessionId,
          serviceType: serviceTypeBySession.get(q.sessionId) || null,
          parentName: p?.name || `${p?.firstName || ""} ${p?.lastName || ""}`.trim() || p?.email || "Parent",
          totalCostCents: q.totalCostCents,
          costSheetFileName: q.costSheetFileName,
          hasFile: !!q.costSheetFileUrl,
          notes: q.notes,
          source: q.source,
          supersededAt: q.supersededAt,
          parentAcknowledgedAt: q.parentAcknowledgedAt,
          createdAt: q.createdAt,
        };
      }),
    };
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

  /**
   * Serves the "document" view of an invoice for the provider:
   *   - PAID  -> the receipt PDF (the same one the parent + agency got
   *              by email), regenerated on demand so any branding /
   *              legal-identity edits flow through.
   *   - Other -> an HTML page styled like the payment-request email so
   *              the provider can see exactly what the parent received,
   *              with no payment buttons (this isn't a payment widget).
   *
   * Scoped: the invoice must belong to the logged-in provider. Admin
   * gets the same payload via the explicit providerId query.
   */
  @Get("api/provider/invoices/:invoiceId/document")
  @UseGuards(SessionOrJwtGuard)
  async getProviderInvoiceDocument(
    @Param("invoiceId") invoiceId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = req.user as any;
    const isAdmin = user?.roles?.includes?.("GOSTORK_ADMIN");
    let providerId: string | null = user?.providerId || null;
    if (isAdmin && req.query.providerId) providerId = String(req.query.providerId);
    if (!providerId) {
      return res.status(HttpStatus.FORBIDDEN).json({ message: "Forbidden" });
    }
    try {
      const doc = await this.billingService.getInvoiceDocumentForProvider(invoiceId, providerId);
      if (doc.kind === "pdf") {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${doc.filename}"`);
        return res.send(doc.pdf);
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(doc.html);
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      this.logger.error(`Document fetch failed for invoice ${invoiceId}: ${e?.message}`);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ message: e?.message || "Failed" });
    }
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
      paymentMethod: invoice.paymentMethod,
      // wireInstructionsJson is non-secret (it's just the public wire
      // destination for this invoice). Surfacing it on the GET lets the
      // payment page restore the wire panel on reload without a POST.
      wireInstructions: (invoice as any).wireInstructionsJson || null,
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
  //
  // A provider can have multiple ReferralFeeConfig rows - one per service
  // they offer (SURROGACY / EGG_DONATION / SPERM_DONATION / IVF_CLINIC /
  // OTHER) - so GoStork can negotiate different referral terms per service.
  // The enabled-services list comes from the provider's APPROVED
  // ProviderService rows.

  @Get("api/admin/providers/:providerId/fee-configs")
  @UseGuards(SessionOrJwtGuard)
  async listProviderFeeConfigs(@Req() req: Request, @Param("providerId") providerId: string) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    return this.billingService.getFeeConfigsForProvider(providerId);
  }

  @Put("api/admin/providers/:providerId/fee-configs/:serviceType")
  @Patch("api/admin/providers/:providerId/fee-configs/:serviceType")
  @UseGuards(SessionOrJwtGuard)
  async upsertProviderFeeConfig(
    @Req() req: Request,
    @Param("providerId") providerId: string,
    @Param("serviceType") serviceType: string,
    @Body() body: any,
  ) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);

    const normalizedService = normalizeServiceType(serviceType);
    const { feeType, flatAmount, percentage, defaultServiceAmount, parentPaysBasis, sampleTotalCostCents, isActive, notes, depositMilestone, averageClearanceDays } = body;
    const normalizedBasis: "DEFAULT_FIRST_PAYMENT" | "TOTAL_COST" =
      parentPaysBasis === "TOTAL_COST" ? "TOTAL_COST" : "DEFAULT_FIRST_PAYMENT";
    const normalizedSample = sampleTotalCostCents != null && Number.isFinite(Number(sampleTotalCostCents))
      ? Math.round(Number(sampleTotalCostCents))
      : null;

    const config = await this.db.referralFeeConfig.upsert({
      where: { providerId_serviceType: { providerId, serviceType: normalizedService } },
      create: { providerId, serviceType: normalizedService, feeType, flatAmount, percentage, defaultServiceAmount: defaultServiceAmount ?? null, parentPaysBasis: normalizedBasis, sampleTotalCostCents: normalizedSample, isActive: isActive ?? true, notes },
      update: { feeType, flatAmount, percentage, defaultServiceAmount: defaultServiceAmount ?? null, parentPaysBasis: normalizedBasis, sampleTotalCostCents: normalizedSample, isActive: isActive ?? true, notes, updatedAt: new Date() },
    });

    // Provider-wide surrogacy settings (deposit milestone + clearance days)
    // are saved on the SURROGACY tab only.
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

  // ─── Provider: self-service fee config (read + edit own rows) ─────────────
  //
  // Mirrors the admin endpoints above but derives the providerId from the
  // logged-in user. The provider can edit everything EXCEPT the GoStork
  // referral fee economics (feeType / percentage / flatAmount) - those are
  // negotiated with GoStork and locked from the provider side. Any attempt
  // to change them is silently dropped server-side.

  @Get("api/provider/fee-configs")
  @UseGuards(SessionOrJwtGuard)
  async getOwnProviderFeeConfigs(@Req() req: Request) {
    const user = req.user as any;
    if (!user?.providerId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    return this.billingService.getFeeConfigsForProvider(user.providerId);
  }

  @Put("api/provider/fee-configs/:serviceType")
  @Patch("api/provider/fee-configs/:serviceType")
  @UseGuards(SessionOrJwtGuard)
  async upsertOwnProviderFeeConfig(
    @Req() req: Request,
    @Param("serviceType") serviceType: string,
    @Body() body: any,
  ) {
    const user = req.user as any;
    if (!user?.providerId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const providerId = user.providerId as string;
    const normalizedService = normalizeServiceType(serviceType);

    // Provider can NOT change GoStork-owned referral-fee economics:
    // feeType, flatAmount, percentage. We pull those values from the
    // existing row (or sensible defaults for a fresh row) and ignore
    // whatever the provider posted for them. Parent-pays basis IS
    // editable by the provider - it controls their own invoice flow.
    const existing = await this.db.referralFeeConfig.findUnique({
      where: { providerId_serviceType: { providerId, serviceType: normalizedService } },
    });
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
      where: { providerId_serviceType: { providerId, serviceType: normalizedService } },
      create: { providerId, serviceType: normalizedService, feeType, flatAmount, percentage, defaultServiceAmount: defaultServiceAmount ?? null, parentPaysBasis: normalizedBasis, sampleTotalCostCents: normalizedSample, isActive: isActive ?? true, notes },
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
  async createPaymentIntent(@Body() body: { paymentToken: string }, @Req() req: Request, @Res() res: Response) {
    try {
      const invoice = await this.billingService.getInvoiceByToken(body.paymentToken);
      if (!invoice) return res.status(404).json({ message: "Invoice not found" });
      if (invoice.status === "PAID") return res.status(400).json({ message: "Invoice already paid" });

      if (!stripeService.isStripeConfigured()) {
        // Mock mode - no Stripe keys yet
        return res.json({ clientSecret: `mock_secret_${Date.now()}`, mock: true });
      }

      const isClearanceFlow = invoice.medicalClearanceStatus === "PENDING";
      const buyerCountry = getBuyerCountry(req, this.logger);

      const { clientSecret, paymentIntentId } = await stripeService.createPaymentIntent({
        amountCents: invoice.serviceAmount,
        currency: invoice.currency || "USD",
        invoiceId: invoice.id,
        paymentToken: invoice.paymentToken,
        description: `GoStork - ${invoice.providerName} - ${invoice.serviceType}`,
        captureMethod: isClearanceFlow ? "manual" : "automatic",
        receiptEmail: (invoice as any).parentUser?.email,
        buyerCountry,
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

  // ─── Stripe: create wire-transfer instructions (customer_balance) ────────
  //
  // International parents (and US parents with large invoices) often prefer
  // bank wires over card/ACH due to per-transaction limits and FX costs.
  // This endpoint mints a customer_balance PaymentIntent and returns the
  // wire instructions (account/routing/reference) for the parent to wire
  // funds from their bank. Stripe reconciles the inbound wire to the
  // PaymentIntent via the unique reference code.
  //
  // Idempotent: if the invoice already has a cached wire intent + addresses,
  // we return them as-is rather than minting a duplicate.

  @Post("api/billing/create-wire-transfer")
  async createWireTransfer(@Body() body: { paymentToken: string }, @Res() res: Response) {
    try {
      const result = await this.billingService.createWireTransferInstructions(body.paymentToken);
      if ("error" in result) return res.status(result.statusCode).json({ message: result.error });
      return res.json(result.instructions);
    } catch (error: any) {
      this.logger.error(`Create wire-transfer error: ${error.message}`);
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
        this.logger.log(`Stripe webhook: ${event.type} | invoice: ${parsed.invoiceId} | method: ${parsed.paymentMethod ?? "unknown"}`);

        if (parsed.status === "succeeded" && parsed.invoiceId) {
          await this.billingService.handleStripeWebhook(parsed.paymentIntentId, "succeeded", parsed.invoiceId, parsed.paymentMethod ?? null);
        } else if (parsed.status === "authorized" && parsed.invoiceId) {
          // AT_CLEARANCE: funds held, update invoice to AUTHORIZED
          await this.billingService.handleStripeWebhook(parsed.paymentIntentId, "authorized", parsed.invoiceId, parsed.paymentMethod ?? null);
        } else if (parsed.status === "processing" && parsed.invoiceId) {
          // Delayed-notification methods (ACH Direct Debit, Bank Transfers) -
          // intent accepted, funds still settling.
          await this.billingService.handleStripeWebhook(parsed.paymentIntentId, "processing", parsed.invoiceId, parsed.paymentMethod ?? null);
        } else if (parsed.status === "canceled" && parsed.invoiceId) {
          await this.billingService.handleStripeWebhook(parsed.paymentIntentId, "canceled", parsed.invoiceId, parsed.paymentMethod ?? null);
        }
      }

      // Refunds: separate parser since refund events have different shape
      // (no payment_intent metadata; we look up by stripeTransactionId).
      // Handles refunds initiated through our admin endpoint AND refunds
      // initiated directly in the Stripe Dashboard, so the DB stays consistent
      // regardless of which surface the admin used.
      const refund = stripeService.parseRefundEvent(event);
      if (refund) {
        this.logger.log(`Stripe refund webhook: pi=${refund.paymentIntentId} refunded=${refund.amountRefundedCents}/${refund.amountCents} full=${refund.fullyRefunded} mode=${refund.latestRefundMetadata?.refundMode || "proportional"}`);
        try {
          await this.billingService.handleChargeRefunded({
            paymentIntentId: refund.paymentIntentId,
            amountRefundedCents: refund.amountRefundedCents,
            fullyRefunded: refund.fullyRefunded,
            latestRefundId: refund.latestRefundId,
            latestRefundReason: refund.latestRefundReason,
            latestRefundMetadata: refund.latestRefundMetadata,
          });
        } catch (e: any) {
          this.logger.error(`Refund handler raised for pi=${refund.paymentIntentId}: ${e?.message}`);
          // Still ack so Stripe doesn't retry forever on a logic bug.
        }
        // A refunded/disputed sponsorship charge deactivates its boost (no-op for
        // invoice PIs, which have no matching sponsorship row).
        try {
          await this.sponsorshipService.deactivateByPaymentIntent(refund.paymentIntentId);
        } catch (e: any) {
          this.logger.error(`Sponsorship refund handler raised for pi=${refund.paymentIntentId}: ${e?.message}`);
        }
      }

      // Sponsorship lifecycle (subscriptions, one-time charges, renewals). Routes
      // away from the invoice flow via metadata.kind="sponsorship"; returns null
      // for non-sponsorship events.
      const sponsorshipEvent = stripeService.parseSponsorshipEvent(event);
      if (sponsorshipEvent) {
        this.logger.log(`Stripe sponsorship webhook: ${event.type} | sponsorship=${sponsorshipEvent.sponsorshipId || sponsorshipEvent.stripeSubscriptionId || sponsorshipEvent.paymentIntentId}`);
        try {
          await this.sponsorshipService.handleStripeWebhook(sponsorshipEvent);
        } catch (e: any) {
          this.logger.error(`Sponsorship webhook handler raised for ${event.type}: ${e?.message}`);
        }
      }

      res.status(200).json({ received: true });
    } catch (error: any) {
      this.logger.error(`Stripe webhook error: ${error.message}`);
      res.status(400).json({ error: error.message }); // 400 so Stripe retries
    }
  }

  // ─── Phase 3: invoice draft approval (provider-only chat card) ─────────────
  //
  //   POST /api/sessions/:sessionId/invoice-draft/:messageId/approve
  //        - provider approves: creates the real Invoice (same engine as the
  //          manual panel), sends the payment card + email/SMS to the parent,
  //          marks the draft card approved
  //   POST /api/sessions/:sessionId/invoice-draft/:messageId/reject
  //        - provider dismisses: nothing is sent; manual invoice stays open

  private async loadSessionForProviderBilling(sessionId: string, user: any) {
    const session = await this.db.aiChatSession.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true, providerId: true, subjectType: true },
    });
    if (!session) throw new HttpException("Session not found", HttpStatus.NOT_FOUND);
    if (!session.providerId) throw new HttpException("Session has no provider", HttpStatus.BAD_REQUEST);
    const roles: string[] = user?.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN") || roles.includes("GOSTORK_CONCIERGE");
    const isProviderMember = user?.providerId && user.providerId === session.providerId;
    if (!isAdmin && !isProviderMember) {
      throw new HttpException("You don't have access to this session", HttpStatus.FORBIDDEN);
    }
    if (!isAdmin && !canSendProviderMessage(roles, session.subjectType)) {
      throw new HttpException("Your role cannot send invoices for this session", HttpStatus.FORBIDDEN);
    }
    return session;
  }

  private async loadInvoiceDraftCard(sessionId: string, messageId: string) {
    const msg = await this.db.aiChatMessage.findUnique({ where: { id: messageId } });
    if (!msg || msg.sessionId !== sessionId || msg.uiCardType !== "invoice_draft_approval") {
      throw new HttpException("Invoice draft card not found", HttpStatus.NOT_FOUND);
    }
    const data = (msg.uiCardData as any) || {};
    if (data.resolvedAt) {
      throw new HttpException(`Draft already ${data.resolvedAs || "resolved"}`, HttpStatus.CONFLICT);
    }
    return { msg, data };
  }

  @Post("api/sessions/:sessionId/invoice-draft/:messageId/approve")
  @UseGuards(SessionOrJwtGuard)
  async approveInvoiceDraft(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @Param("messageId") messageId: string,
    @Body() body: {
      lineItems?: Array<{ serviceType: string; description?: string | null; amountCents: number }>;
      description?: string | null;
    },
  ) {
    const user = req.user as any;
    const session = await this.loadSessionForProviderBilling(sessionId, user);
    const { msg, data } = await this.loadInvoiceDraftCard(sessionId, messageId);

    const lineItems = (Array.isArray(body.lineItems) && body.lineItems.length > 0
      ? body.lineItems
      : (data.lineItems || [])
    ).map((li: any) => ({
      serviceType: li.serviceType,
      description: li.description ?? null,
      amountCents: Math.round(Number(li.amountCents) || 0),
    }));
    if (lineItems.length === 0) {
      throw new HttpException("Invoice draft has no line items", HttpStatus.BAD_REQUEST);
    }
    const description = typeof body.description === "string"
      ? body.description.trim() || null
      : data.description ?? null;

    // Same engine as the manual panel - loud failures surface to the provider.
    const invoice = await this.billingService.createInvoice({
      sessionId,
      providerId: session.providerId!,
      parentUserId: session.userId,
      triggerSource: "AUTO_READINESS",
      lineItems,
      description: description ?? undefined,
    });
    await this.billingService.sendPaymentNotificationsToParent(invoice.id);

    // createInvoice just superseded every pending draft (including this one);
    // overwrite this card's resolution to "approved" so the UI reads right.
    const freshMsg = await this.db.aiChatMessage.findUnique({ where: { id: msg.id }, select: { uiCardData: true } });
    await this.db.aiChatMessage.update({
      where: { id: msg.id },
      data: {
        uiCardData: {
          ...((freshMsg?.uiCardData as any) || data),
          lineItems,
          totalCents: lineItems.reduce((s: number, li: any) => s + li.amountCents, 0),
          description,
          resolvedAt: new Date().toISOString(),
          resolvedAs: "approved",
          resultingInvoiceId: invoice.id,
        },
      },
    });

    this.logger.log(`Invoice draft ${messageId} approved -> invoice ${invoice.id} (session=${sessionId}, by=${user?.id})`);
    return { ok: true, invoiceId: invoice.id };
  }

  // ─── Phase 4: provider answers the match readiness question ────────────────
  // The agency answers on the surrogate's behalf. "yes" + parent already yes
  // -> official match, deposit invoice fires with a 24h window. "no" ->
  // release the hold and tell the parent gently.

  @Post("api/sessions/:sessionId/provider-readiness/:messageId/respond")
  @UseGuards(SessionOrJwtGuard)
  async respondProviderReadiness(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @Param("messageId") messageId: string,
    @Body() body: { answer: "yes" | "no" },
  ) {
    const user = req.user as any;
    if (!["yes", "no"].includes(body?.answer)) {
      throw new HttpException("answer (yes|no) required", HttpStatus.BAD_REQUEST);
    }
    await this.loadSessionForProviderBilling(sessionId, user);

    const msg = await this.db.aiChatMessage.findUnique({ where: { id: messageId } });
    if (!msg || msg.sessionId !== sessionId || msg.uiCardType !== "provider_readiness_prompt") {
      throw new HttpException("Readiness question not found", HttpStatus.NOT_FOUND);
    }
    const data = (msg.uiCardData as any) || {};
    if (data.answered) {
      return { ok: true, alreadyAnswered: true, answered: data.answered };
    }

    await this.db.aiChatMessage.update({
      where: { id: messageId },
      data: { uiCardData: { ...data, answered: body.answer, answeredByUserId: user.id, answeredAt: new Date().toISOString() } },
    });

    if (body.answer === "no") {
      await this.billingService.releaseMatchAfterProviderDecline(sessionId, data.subjectLabel ?? null);
      await this.db.aiChatMessage.create({
        data: {
          sessionId,
          role: "assistant",
          content: `Understood - we've released the hold and let the parent know gently. Thanks for the quick answer.`,
          senderType: "system",
          senderName: "GoStork",
          uiCardType: "provider_only",
        },
      }).catch(() => {});
      return { ok: true, result: "declined" };
    }

    // "yes" - try to finalize; if the parent hasn't answered yet, we wait.
    const matchRes = await this.billingService.tryFinalizeMatch(data.bookingId);
    if (matchRes.status === "waiting" && matchRes.waitingOn === "parent") {
      await this.db.aiChatMessage.create({
        data: {
          sessionId,
          role: "assistant",
          content: `Noted! We're waiting for ${data.parentName || "the parent"} to confirm on their side - the moment they do, the deposit invoice goes out automatically.`,
          senderType: "system",
          senderName: "GoStork",
          uiCardType: "provider_only",
        },
      }).catch(() => {});
    } else if (matchRes.status === "blocked") {
      await this.db.aiChatMessage.create({
        data: {
          sessionId,
          role: "assistant",
          content: `Both sides confirmed, but we can't issue the deposit invoice yet: ${matchRes.message}`,
          senderType: "system",
          senderName: "GoStork",
          uiCardType: "provider_only",
        },
      }).catch(() => {});
    }
    return { ok: true, result: matchRes.status };
  }

  @Post("api/sessions/:sessionId/invoice-draft/:messageId/reject")
  @UseGuards(SessionOrJwtGuard)
  async rejectInvoiceDraft(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @Param("messageId") messageId: string,
  ) {
    const user = req.user as any;
    await this.loadSessionForProviderBilling(sessionId, user);
    const { msg, data } = await this.loadInvoiceDraftCard(sessionId, messageId);

    await this.db.aiChatMessage.update({
      where: { id: msg.id },
      data: {
        uiCardData: { ...data, resolvedAt: new Date().toISOString(), resolvedAs: "rejected" },
      },
    });
    this.logger.log(`Invoice draft ${messageId} rejected (session=${sessionId}, by=${user?.id})`);
    return { ok: true };
  }

  // ─── Phase 5: provider approves/rejects the auto-drafted agreement ──────────

  private async loadAgreementDraftCard(sessionId: string, messageId: string) {
    const msg = await this.db.aiChatMessage.findUnique({ where: { id: messageId } });
    if (!msg || msg.sessionId !== sessionId || msg.uiCardType !== "agreement_draft_approval") {
      throw new HttpException("Agreement draft card not found", HttpStatus.NOT_FOUND);
    }
    const data = (msg.uiCardData as any) || {};
    if (data.resolvedAt) {
      throw new HttpException(`Draft already ${data.resolvedAs || "resolved"}`, HttpStatus.CONFLICT);
    }
    return { msg, data };
  }

  @Post("api/sessions/:sessionId/agreement-draft/:messageId/approve")
  @UseGuards(SessionOrJwtGuard)
  async approveAgreementDraft(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @Param("messageId") messageId: string,
    @Body() body: {
      partnerOverride?: { firstName: string; lastName: string; email: string };
      skipPartner?: boolean;
    },
  ) {
    const user = req.user as any;
    const session = await this.loadSessionForProviderBilling(sessionId, user);
    const { msg, data } = await this.loadAgreementDraftCard(sessionId, messageId);

    // Same engine as the manual + menu panel - loud failures surface to the provider.
    const { generateAndAnnounceAgreement } = await import("../../../agreement-flow");
    let agreement: any;
    try {
      agreement = await generateAndAnnounceAgreement({
        sessionId,
        providerId: session.providerId!,
        generatedByUserId: user.id,
        partnerOverride: body?.partnerOverride,
        skipPartner: body?.skipPartner === true,
        trigger: "approval",
      });
    } catch (e: any) {
      if (e?.code === "PARTNER_INFO_REQUIRED") {
        // Card stays unresolved - client collects partner details and retries.
        throw new HttpException(
          { code: "PARTNER_INFO_REQUIRED", parent1: e.parent1, parentRoles: e.parentRoles },
          HttpStatus.CONFLICT,
        );
      }
      if (e?.code === "PAYMENT_REQUIRED") {
        throw new HttpException({ code: "PAYMENT_REQUIRED", message: e.message }, HttpStatus.PAYMENT_REQUIRED);
      }
      throw e;
    }

    await this.db.aiChatMessage.update({
      where: { id: msg.id },
      data: {
        uiCardData: {
          ...data,
          resolvedAt: new Date().toISOString(),
          resolvedAs: "approved",
          resultingAgreementId: agreement.id,
        },
      },
    });
    this.logger.log(`Agreement draft ${messageId} approved -> agreement ${agreement.id} (session=${sessionId}, by=${user?.id})`);
    return { ok: true, agreementId: agreement.id };
  }

  @Post("api/sessions/:sessionId/agreement-draft/:messageId/reject")
  @UseGuards(SessionOrJwtGuard)
  async rejectAgreementDraft(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @Param("messageId") messageId: string,
  ) {
    const user = req.user as any;
    await this.loadSessionForProviderBilling(sessionId, user);
    const { msg, data } = await this.loadAgreementDraftCard(sessionId, messageId);

    await this.db.aiChatMessage.update({
      where: { id: msg.id },
      data: {
        uiCardData: { ...data, resolvedAt: new Date().toISOString(), resolvedAs: "rejected" },
      },
    });
    this.logger.log(`Agreement draft ${messageId} rejected (session=${sessionId}, by=${user?.id})`);
    return { ok: true };
  }

}
