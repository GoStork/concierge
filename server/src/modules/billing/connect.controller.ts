import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  Inject,
  HttpException,
  HttpStatus,
  Logger,
  UseGuards,
  Param,
} from "@nestjs/common";
import { Request, Response } from "express";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { ConnectService, type CustomPayoutFormData } from "./connect.service";
import { prisma } from "../../../db";
import * as stripeService from "../../../stripe-service";
import type Stripe from "stripe";

/**
 * Provider payout endpoints (Stripe Connect Express + Custom) + the
 * Connect-events webhook handler.
 *
 * Routes:
 *   GET  /api/provider/payouts           - current payout-account state
 *   POST /api/provider/payouts/express/start  - kick off Stripe-hosted onboarding
 *   GET  /api/provider/payouts/express/return - return URL after Stripe hosted onboarding
 *   POST /api/provider/payouts/custom/save    - submit Custom-path KYC + bank info
 *   POST /api/webhooks/stripe-connect    - Stripe -> GoStork webhook (Connected accounts events)
 *
 * Admin variants (only the GET, for now - all mutations happen on the
 * provider side):
 *   GET /api/admin/providers/:providerId/payouts
 */
@Controller()
export class ConnectController {
  private readonly logger = new Logger(ConnectController.name);

  constructor(
    @Inject(ConnectService) private readonly connectService: ConnectService,
  ) {}

  // ── Provider: read current state ─────────────────────────────────────────

  @Get("api/provider/payouts")
  @UseGuards(SessionOrJwtGuard)
  async getOwnPayouts(@Req() req: Request) {
    const user = req.user as any;
    if (!user?.providerId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const row = await this.connectService.getOrCreatePayoutAccount(user.providerId);
    return this.shapeForUi(row);
  }

  @Get("api/admin/providers/:providerId/payouts")
  @UseGuards(SessionOrJwtGuard)
  async getProviderPayouts(@Req() req: Request, @Param("providerId") providerId: string) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const row = await this.connectService.getOrCreatePayoutAccount(providerId);
    return this.shapeForUi(row);
  }

  /**
   * Admin: force-pull the latest Stripe Connect account state for a
   * provider and mirror it into the DB. Useful when the account.updated
   * webhook missed something or was retried out of order.
   */
  @Post("api/admin/providers/:providerId/payouts/refresh")
  @UseGuards(SessionOrJwtGuard)
  async refreshFromStripe(@Req() req: Request, @Param("providerId") providerId: string) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const row = await this.connectService.getOrCreatePayoutAccount(providerId);
    if (!row.stripeConnectAccountId) {
      throw new HttpException("Provider has no Stripe Connect account yet", HttpStatus.BAD_REQUEST);
    }
    try {
      await this.connectService.refreshFromStripe(row.stripeConnectAccountId);
      const fresh = await this.connectService.getOrCreatePayoutAccount(providerId);
      return this.shapeForUi(fresh);
    } catch (e: any) {
      throw new HttpException(`Refresh failed: ${e?.message}`, HttpStatus.BAD_GATEWAY);
    }
  }

  /**
   * Admin: retry a failed transfer. Reads the invoice, clears
   * payoutFailedAt, and re-invokes createTransferForPaidInvoice. Will
   * fail again with the same error if the underlying condition (KYC,
   * balance, account state) hasn't been fixed.
   */
  @Post("api/admin/invoices/:invoiceId/retry-payout")
  @UseGuards(SessionOrJwtGuard)
  async retryPayout(@Req() req: Request, @Param("invoiceId") invoiceId: string) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { payoutFailedAt: null, payoutFailureReason: null },
    });
    const result = await this.connectService.createTransferForPaidInvoice(invoiceId);
    return result;
  }

  /**
   * Admin: list invoices currently stuck without a successful payout.
   * Drives the "payouts needing attention" widget on the admin payouts
   * tab. Either failed outright (payoutFailedAt set) or never auto-fired
   * (provider not onboarded when invoice was PAID).
   */
  @Get("api/admin/providers/:providerId/payouts/pending")
  @UseGuards(SessionOrJwtGuard)
  async listPending(@Req() req: Request, @Param("providerId") providerId: string) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const invoices = await prisma.invoice.findMany({
      where: {
        providerId,
        status: "PAID",
        stripeTransferId: null,
      },
      select: {
        id: true,
        serviceAmount: true,
        providerPayoutAmount: true,
        referralFeeAmount: true,
        currency: true,
        paidAt: true,
        payoutFailedAt: true,
        payoutFailureReason: true,
        serviceType: true,
      },
      orderBy: { paidAt: "desc" },
      take: 25,
    });
    return { invoices };
  }

  // ── Provider: Express path ───────────────────────────────────────────────

  @Post("api/provider/payouts/express/start")
  @UseGuards(SessionOrJwtGuard)
  async startExpress(@Req() req: Request) {
    const user = req.user as any;
    if (!user?.providerId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);

    // Pull email + business name to pre-fill Stripe's hosted onboarding.
    const provider = await prisma.provider.findUnique({
      where: { id: user.providerId },
      select: {
        name: true,
        email: true,
        brandSettings: { select: { taxId: true } },
      },
    });
    if (!provider) throw new HttpException("Provider not found", HttpStatus.NOT_FOUND);

    const baseUrl = process.env.APP_URL?.replace(/\/+$/, "") || "http://localhost:5001";
    const { url } = await this.connectService.startExpressOnboarding({
      providerId: user.providerId,
      providerEmail: provider.email || user.email,
      providerName: provider.name,
      // Return URL = back to the GoStork payouts page so we can show status.
      returnUrl: `${baseUrl}/account/payouts?onboarding=complete`,
      // Refresh URL = same page; the page will re-call /express/start to mint
      // a new link if the prior one expired.
      refreshUrl: `${baseUrl}/account/payouts?onboarding=refresh`,
      taxId: provider.brandSettings?.taxId || null,
    });
    return { url };
  }

  /**
   * Stripe redirects the provider back here after they finish (or abandon)
   * onboarding. We pull the latest state from Stripe immediately so the
   * page doesn't have to wait for the account.updated webhook to catch up.
   */
  @Get("api/provider/payouts/express/return")
  @UseGuards(SessionOrJwtGuard)
  async expressReturn(@Req() req: Request, @Res() res: Response) {
    const user = req.user as any;
    if (!user?.providerId) {
      return res.redirect("/login");
    }
    const row = await this.connectService.getOrCreatePayoutAccount(user.providerId);
    if (row.stripeConnectAccountId) {
      try {
        await this.connectService.refreshFromStripe(row.stripeConnectAccountId);
      } catch (e: any) {
        this.logger.warn(`Express return refresh failed for ${row.stripeConnectAccountId}: ${e?.message}`);
      }
    }
    return res.redirect("/account/payouts?onboarding=complete");
  }

  // ── Provider: Custom path ────────────────────────────────────────────────

  @Post("api/provider/payouts/custom/save")
  @UseGuards(SessionOrJwtGuard)
  async saveCustom(@Req() req: Request, @Body() body: CustomPayoutFormData) {
    const user = req.user as any;
    if (!user?.providerId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);

    // Minimum validation - Stripe will reject anything malformed, but we
    // give an earlier error if obvious fields are missing.
    if (!body?.businessName?.trim()) throw new HttpException("businessName required", HttpStatus.BAD_REQUEST);
    if (!body?.bank?.routingNumber || !body?.bank?.accountNumber) {
      throw new HttpException("Bank routing + account numbers required", HttpStatus.BAD_REQUEST);
    }
    if (!body?.representative?.firstName || !body?.representative?.lastName) {
      throw new HttpException("Representative name required", HttpStatus.BAD_REQUEST);
    }
    if (!body?.representative?.ssnLast4 || body.representative.ssnLast4.length !== 4) {
      throw new HttpException("Representative SSN last 4 must be 4 digits", HttpStatus.BAD_REQUEST);
    }
    if (!body?.address?.line1 || !body?.address?.city || !body?.address?.state || !body?.address?.postalCode) {
      throw new HttpException("Full business address required", HttpStatus.BAD_REQUEST);
    }

    const provider = await prisma.provider.findUnique({
      where: { id: user.providerId },
      select: { name: true, email: true },
    });
    if (!provider) throw new HttpException("Provider not found", HttpStatus.NOT_FOUND);

    try {
      const result = await this.connectService.saveCustomPayoutInfo({
        providerId: user.providerId,
        providerEmail: provider.email || user.email,
        providerName: provider.name,
        form: body,
      });
      return result;
    } catch (e: any) {
      this.logger.error(`Custom payout save failed for provider ${user.providerId}: ${e?.message}`, e?.stack);
      // Stripe API errors include useful detail in `message`. Surface it
      // to the UI so the provider can correct (e.g. "Invalid routing number").
      throw new HttpException(
        e?.message || "Failed to save payout information",
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  // ── Stripe Connect webhook ───────────────────────────────────────────────

  /**
   * Receives Connect-events from Stripe. "Connected accounts" destination
   * in Stripe Dashboard. Listens to:
   *   account.updated                  - KYC state, capabilities, requirements
   *   account.application.deauthorized - provider disconnected
   *   payout.paid                      - provider's bank received the payout
   *   payout.failed                    - provider's bank rejected the payout
   *
   * Signed with STRIPE_CONNECT_WEBHOOK_SECRET (separate from the
   * platform-events webhook secret).
   */
  @Post("api/webhooks/stripe-connect")
  async stripeConnectWebhook(@Req() req: Request, @Res() res: Response) {
    try {
      const sig = req.headers["stripe-signature"] as string;
      if (!sig) return res.status(400).json({ error: "Missing stripe-signature header" });

      const rawBody = (req as any).rawBody ?? req.body;
      const event = stripeService.constructConnectWebhookEvent(rawBody, sig);

      this.logger.log(`Connect webhook: ${event.type} | account: ${(event as any).account || "n/a"}`);

      switch (event.type) {
        case "account.updated": {
          const account = event.data.object as Stripe.Account;
          await this.connectService.handleAccountUpdated(account);
          break;
        }
        case "account.application.deauthorized": {
          // The account ID is on the event's top-level `account` field for
          // this event type (the data.object is the application, not the
          // account itself).
          const accountId = (event as any).account as string | undefined;
          if (accountId) await this.connectService.handleAccountDeauthorized(accountId);
          break;
        }
        case "payout.paid":
        case "payout.failed": {
          // payout.* fires on the CONNECTED ACCOUNT when Stripe sweeps its
          // balance to the provider's bank. One payout aggregates multiple
          // Transfers (the connected account's payout schedule batches them),
          // so we can't tie a single Invoice to a single payout - we just
          // log here so admins have a record. The Invoice.payoutCompletedAt
          // we already stamped at transfer.create time is the right
          // "GoStork's money reached the provider" timestamp.
          //
          // payout.failed is the loud signal: the provider's bank rejected
          // the credit (closed account, wrong routing, NSF on debit). The
          // money sits in the connected account's balance until the
          // provider updates their bank. We notify admins in-app.
          const payout = event.data.object as Stripe.Payout;
          const accountId = (event as any).account as string | undefined;
          this.logger.log(
            `Connect ${event.type}: payout=${payout.id} account=${accountId} amount=${payout.amount} ${payout.currency}`,
          );
          if (event.type === "payout.failed" && accountId) {
            try {
              await this.notifyAdminPayoutFailed(accountId, payout);
            } catch (e: any) {
              this.logger.warn(`Failed to notify admins of payout.failed: ${e?.message}`);
            }
          }
          break;
        }
        default:
          // Subscribed to nothing else, but if Stripe sends something
          // unexpected (e.g. they auto-subscribe new events) we just ack
          // it with 200 so they don't retry.
          break;
      }

      res.status(200).json({ received: true });
    } catch (error: any) {
      this.logger.error(`Connect webhook error: ${error.message}`);
      res.status(400).json({ error: error.message });
    }
  }

  // ── Webhook helpers ──────────────────────────────────────────────────────

  /**
   * In-app admin notification when a connected-account's bank rejected the
   * payout. The money is still in the connected account's Stripe balance -
   * admin needs to coordinate with the provider to update their bank info,
   * and Stripe will retry on the next payout schedule.
   */
  private async notifyAdminPayoutFailed(stripeAccountId: string, payout: Stripe.Payout) {
    const row = await prisma.providerBankAccount.findFirst({
      where: { stripeConnectAccountId: stripeAccountId },
      include: { provider: { select: { id: true, name: true } } },
    });
    if (!row?.provider) return;

    const admins = await prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" } },
      select: { id: true },
    });
    const amount = ((payout.amount || 0) / 100).toLocaleString("en-US", {
      style: "currency",
      currency: (payout.currency || "USD").toUpperCase(),
    });
    const reason = payout.failure_message || payout.failure_code || "Bank rejected the payout";
    for (const admin of admins) {
      await prisma.inAppNotification.create({
        data: {
          userId: admin.id,
          eventType: "CONNECT_PAYOUT_FAILED",
          payload: {
            providerId: row.provider.id,
            providerName: row.provider.name,
            stripeAccountId,
            payoutId: payout.id,
            amount,
            reason,
            message: `Payout to ${row.provider.name} failed (${amount}). Reason: ${reason}. Money is still in their Stripe Connect balance - they need to update their bank info.`,
          },
        },
      });
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Shape a ProviderBankAccount row for the UI. Drops nothing-yet
   * implementation details (createdAt, internal ids) and provides
   * derived flags the frontend wants.
   */
  private shapeForUi(row: any) {
    return {
      payoutMethod: row.payoutMethod ?? null,
      stripeConnectAccountId: row.stripeConnectAccountId ?? null,
      payoutsEnabled: !!row.payoutsEnabled,
      chargesEnabled: !!row.chargesEnabled,
      detailsSubmitted: !!row.detailsSubmitted,
      requirementsCurrentlyDue: Array.isArray(row.requirementsCurrentlyDue) ? row.requirementsCurrentlyDue : [],
      requirementsEventuallyDue: Array.isArray(row.requirementsEventuallyDue) ? row.requirementsEventuallyDue : [],
      requirementsPastDue: Array.isArray(row.requirementsPastDue) ? row.requirementsPastDue : [],
      requirementsDisabledReason: row.requirementsDisabledReason ?? null,
      bankName: row.bankName ?? null,
      accountLast4: row.accountLast4 ?? null,
      accountType: row.accountType ?? null,
      onboardingStartedAt: row.onboardingStartedAt ?? null,
      onboardingCompletedAt: row.onboardingCompletedAt ?? null,
      // Derived "ready to receive payouts" used by the auto-transfer code
      // path. Centralised so server + client agree on the predicate.
      readyForPayouts: !!row.payoutsEnabled && !!row.stripeConnectAccountId,
    };
  }
}
