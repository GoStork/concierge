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
import { normalizeCountry, payoutRailFor, currencyFor, effectivePayoutCountry } from "../../../../shared/payout-countries";
import { trolleyEnabled } from "./trolley.client";
import { getBaseUrl } from "../../lib/get-base-url";
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
    const _r = user?.roles || []; if (!user?.providerId || (!_r.includes("PROVIDER_ADMIN") && !_r.includes("BILLING_MANAGER"))) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const row = await this.connectService.getOrCreatePayoutAccount(user.providerId);
    return this.shapeForUi(row, await this.railInfo(user.providerId));
  }

  @Get("api/admin/providers/:providerId/payouts")
  @UseGuards(SessionOrJwtGuard)
  async getProviderPayouts(@Req() req: Request, @Param("providerId") providerId: string) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const row = await this.connectService.getOrCreatePayoutAccount(providerId);
    return this.shapeForUi(row, await this.railInfo(providerId));
  }

  /**
   * Which payout rail the provider's legal country allows, plus the
   * currency they would be paid in - the Payouts page shows the matching
   * options and the "you receive approx." estimate from this.
   */
  private async railInfo(providerId: string) {
    const legal = await prisma.providerLegalIdentity.findUnique({
      where: { providerId },
      select: { businessAddressCountry: true, usPayoutEntity: true },
    });
    // "I have a US entity" makes the payout/tax machinery treat the
    // provider as US while the address stays their real country.
    const country = effectivePayoutCountry(legal?.businessAddressCountry, legal?.usPayoutEntity);
    return {
      legalCountry: normalizeCountry(legal?.businessAddressCountry),
      usPayoutEntity: !!legal?.usPayoutEntity,
      payoutRail: payoutRailFor(country),
      payoutCurrency: currencyFor(country),
      // The in-app bank form (Custom account) is US-only.
      customFormAvailable: country === "US",
      // Trolley is parked (application rejected 2026-08-20); false means the
      // INTERNATIONAL rail is a manual bank wire arranged by GoStork admin.
      internationalAutomated: trolleyEnabled(),
    };
  }

  /**
   * The "I have a US entity" checkbox on the Payouts page: flips the
   * provider's effective payout/tax country to US (Stripe + W-9 + US bank)
   * or back. Blocked once a payout method is live on the other rail - the
   * account has to be disconnected first so money never straddles rails.
   */
  @Post("api/provider/payouts/us-entity")
  @UseGuards(SessionOrJwtGuard)
  async setUsPayoutEntity(@Req() req: Request, @Body() body: { enabled: boolean }) {
    const user = req.user as any;
    const _r = user?.roles || []; if (!user?.providerId || (!_r.includes("PROVIDER_ADMIN") && !_r.includes("BILLING_MANAGER"))) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const enabled = !!body?.enabled;
    const account = await prisma.providerBankAccount.findUnique({ where: { providerId: user.providerId }, select: { payoutMethod: true } });
    if (enabled && account?.payoutMethod === "TROLLEY") {
      throw new HttpException("International payouts are already set up. Contact GoStork support to switch to a US entity.", HttpStatus.BAD_REQUEST);
    }
    if (!enabled && (account?.payoutMethod === "STRIPE_CONNECT_EXPRESS" || account?.payoutMethod === "STRIPE_CONNECT_CUSTOM")) {
      throw new HttpException("Stripe payouts are already set up on your US entity. Disconnect the payout account first, then switch.", HttpStatus.BAD_REQUEST);
    }
    // getOrCreate semantics: the legal-identity row may not exist yet.
    await prisma.providerLegalIdentity.upsert({
      where: { providerId: user.providerId },
      create: { providerId: user.providerId, usPayoutEntity: enabled },
      update: { usPayoutEntity: enabled },
    });
    return { success: true, usPayoutEntity: enabled };
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
  /**
   * Admin: run the remainder sweep NOW instead of waiting for the daily
   * 06:00 run. Pays out (available balance - outstanding provider
   * obligations) to GoStork's bank. No-ops with an explanatory `skipped`
   * message when the platform payout schedule isn't Manual or the
   * remainder is under the minimum.
   */
  @Post("api/admin/payouts/remainder-sweep")
  @UseGuards(SessionOrJwtGuard)
  async remainderSweep(@Req() req: Request) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const { runRemainderSweep } = await import("./remainder-sweep.scheduler");
    return runRemainderSweep(prisma as any);
  }

  @Post("api/admin/invoices/:invoiceId/retry-payout")
  @UseGuards(SessionOrJwtGuard)
  async retryPayout(@Req() req: Request, @Param("invoiceId") invoiceId: string) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    await prisma.invoice.update({
      where: { id: invoiceId },
      // Reset the auto-retry ladder along with the failure stamps - a
      // manual retry is a fresh start, and if funds STILL aren't settled
      // the deferral path re-schedules from attempt #1.
      data: { payoutFailedAt: null, payoutFailureReason: null, payoutNextAttemptAt: null, payoutAttemptCount: 0 },
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
    const _r = user?.roles || []; if (!user?.providerId || (!_r.includes("PROVIDER_ADMIN") && !_r.includes("BILLING_MANAGER"))) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);

    // Pre-fill EVERYTHING Stripe Express asks for that we already have.
    // The provider shouldn't have to retype data they already entered into
    // the W-9 / Legal Identity / Company tabs. Concretely we feed Stripe:
    //   - legal business name        Legal Identity.legalName
    //   - DBA / display name         Provider.name
    //   - tax ID (EIN)               Legal Identity.taxId
    //   - business website           Legal Identity.businessUrl
    //                                  -> Provider.websiteUrl fallback
    //   - business address           Legal Identity.businessAddress*
    //   - business phone             Provider.phone
    //   - business type              Legal Identity.businessType (company
    //                                  vs individual, derived from tax
    //                                  classification)
    const [provider, legalIdentity] = await Promise.all([
      prisma.provider.findUnique({
        where: { id: user.providerId },
        select: { name: true, email: true, phone: true, websiteUrl: true },
      }),
      prisma.providerLegalIdentity.findUnique({
        where: { providerId: user.providerId },
        select: {
          legalName: true,
          businessName: true,
          businessUrl: true,
          taxId: true,
          businessType: true,
          businessAddressLine1: true,
          businessAddressLine2: true,
          businessAddressCity: true,
          businessAddressState: true,
          businessAddressPostalCode: true,
          businessAddressCountry: true,
          usPayoutEntity: true,
        },
      }),
    ]);
    if (!provider) throw new HttpException("Provider not found", HttpStatus.NOT_FOUND);

    const baseUrl = getBaseUrl();
    const { url } = await this.connectService.startExpressOnboarding({
      providerId: user.providerId,
      providerEmail: provider.email || user.email,
      providerName: provider.name,
      legalName: legalIdentity?.legalName || null,
      businessUrl: legalIdentity?.businessUrl || provider.websiteUrl || null,
      taxId: legalIdentity?.taxId || null,
      businessType: legalIdentity?.businessType === "individual" ? "individual" : "company",
      phone: provider.phone || null,
      country: effectivePayoutCountry(legalIdentity?.businessAddressCountry, (legalIdentity as any)?.usPayoutEntity),
      address: legalIdentity?.businessAddressLine1 ? {
        line1: legalIdentity.businessAddressLine1,
        line2: legalIdentity.businessAddressLine2 || undefined,
        city: legalIdentity.businessAddressCity || "",
        state: legalIdentity.businessAddressState || "",
        postalCode: legalIdentity.businessAddressPostalCode || "",
        country: legalIdentity.businessAddressCountry || "US",
      } : null,
      // Return URL = back to the GoStork payouts page so we can show status.
      returnUrl: `${baseUrl}/account/payouts?onboarding=complete`,
      // Refresh URL = same page; the page will re-call /express/start to mint
      // a new link if the prior one expired.
      refreshUrl: `${baseUrl}/account/payouts?onboarding=refresh`,
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
    const retRoles = user?.roles || [];
    if (!user?.providerId || (!retRoles.includes("PROVIDER_ADMIN") && !retRoles.includes("BILLING_MANAGER"))) {
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
    const _r = user?.roles || []; if (!user?.providerId || (!_r.includes("PROVIDER_ADMIN") && !_r.includes("BILLING_MANAGER"))) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);

    // Minimum validation - Stripe will reject anything malformed, but we
    // give an earlier error if obvious fields are missing. Business
    // identity / address fields are NOT validated here - they come from
    // ProviderLegalIdentity, and the service throws a clear error if
    // anything's missing there.
    if (!body?.bank?.routingNumber || !body?.bank?.accountNumber) {
      throw new HttpException("Bank routing + account numbers required", HttpStatus.BAD_REQUEST);
    }
    if (!body?.representative?.firstName || !body?.representative?.lastName) {
      throw new HttpException("Representative name required", HttpStatus.BAD_REQUEST);
    }
    if (!body?.representative?.ssnLast4 || body.representative.ssnLast4.length !== 4) {
      throw new HttpException("Representative SSN last 4 must be 4 digits", HttpStatus.BAD_REQUEST);
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

  // ── Provider: bank management (post-onboarding) ─────────────────────────

  /**
   * Replace the provider's external bank account. Works for both Custom
   * (Stripe-hosted onboarding here) and Express (provider can also do
   * this via the Stripe Express dashboard - either path is fine).
   */
  @Post("api/provider/payouts/bank")
  @UseGuards(SessionOrJwtGuard)
  async updateBank(
    @Req() req: Request,
    @Body() body: { routingNumber: string; accountNumber: string; accountHolderName?: string; accountType: "checking" | "savings" },
  ) {
    const user = req.user as any;
    const _r = user?.roles || []; if (!user?.providerId || (!_r.includes("PROVIDER_ADMIN") && !_r.includes("BILLING_MANAGER"))) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    if (!body?.routingNumber || !body?.accountNumber) {
      throw new HttpException("Routing + account number required", HttpStatus.BAD_REQUEST);
    }
    try {
      const result = await this.connectService.updateBankAccount({
        providerId: user.providerId,
        bank: {
          routingNumber: body.routingNumber,
          accountNumber: body.accountNumber,
          accountHolderName: body.accountHolderName || "",
          accountType: body.accountType || "checking",
        },
      });
      return result;
    } catch (e: any) {
      this.logger.error(`Bank update failed for ${user.providerId}: ${e?.message}`);
      throw new HttpException(e?.message || "Failed to update bank account", HttpStatus.BAD_REQUEST);
    }
  }

  /**
   * Express-only: returns a short-lived URL into the provider's Stripe
   * Express dashboard. Client opens it in a new tab so the provider can
   * change bank, view payouts, etc. directly on Stripe.
   */
  @Post("api/provider/payouts/express/login-link")
  @UseGuards(SessionOrJwtGuard)
  async expressLoginLink(@Req() req: Request) {
    const user = req.user as any;
    const _r = user?.roles || []; if (!user?.providerId || (!_r.includes("PROVIDER_ADMIN") && !_r.includes("BILLING_MANAGER"))) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    try {
      return await this.connectService.getExpressLoginLink(user.providerId);
    } catch (e: any) {
      throw new HttpException(e?.message || "Failed to generate Stripe login link", HttpStatus.BAD_REQUEST);
    }
  }

  /**
   * Disconnect the provider's payout account. Refuses if any pending /
   * failed payouts exist or the Connect balance is non-zero, returning
   * a structured "blocked" response with a human-readable reason. On
   * success: Stripe account is deleted (Custom) and the local row is
   * reset to "not yet onboarded".
   */
  @Post("api/provider/payouts/disconnect")
  @UseGuards(SessionOrJwtGuard)
  async disconnect(@Req() req: Request) {
    const user = req.user as any;
    const _r = user?.roles || []; if (!user?.providerId || (!_r.includes("PROVIDER_ADMIN") && !_r.includes("BILLING_MANAGER"))) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    try {
      return await this.connectService.disconnect(user.providerId);
    } catch (e: any) {
      this.logger.error(`Disconnect failed for ${user.providerId}: ${e?.message}`);
      throw new HttpException(e?.message || "Failed to disconnect", HttpStatus.BAD_REQUEST);
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
          // so we list the payout's balance transactions and stamp every
          // invoice the payout settled with bankPayoutCompletedAt /
          // bankPayoutFailedAt. The UI then renders "Received" or
          // "Failed at bank" per row.
          //
          // payout.failed also notifies admins in-app so they can coordinate
          // with the provider to update their bank info (Stripe auto-retries
          // on the next payout schedule).
          const payout = event.data.object as Stripe.Payout;
          const accountId = (event as any).account as string | undefined;
          this.logger.log(
            `Connect ${event.type}: payout=${payout.id} account=${accountId} amount=${payout.amount} ${payout.currency}`,
          );
          if (accountId) {
            try {
              if (event.type === "payout.paid") {
                await this.connectService.handlePayoutSucceeded(payout, accountId);
              } else {
                await this.connectService.handlePayoutFailed(payout, accountId);
                await this.notifyAdminPayoutFailed(accountId, payout).catch(e =>
                  this.logger.warn(`Failed to notify admins of payout.failed: ${e?.message}`),
                );
              }
            } catch (e: any) {
              this.logger.error(`Failed to process ${event.type} for ${accountId}: ${e?.message}`, e?.stack);
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
  private shapeForUi(row: any, rail?: { legalCountry: string; payoutRail: string; payoutCurrency: string; customFormAvailable: boolean }) {
    return {
      ...(rail || {}),
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
      // International rail (Trolley) mirror
      trolleyRecipientId: row.trolleyRecipientId ?? null,
      trolleyRecipientStatus: row.trolleyRecipientStatus ?? null,
      trolleyPayoutMethodReady: !!row.trolleyPayoutMethodReady,
      trolleyPayoutCurrency: row.trolleyPayoutCurrency ?? null,
      trolleyTaxFormStatus: row.trolleyTaxFormStatus ?? null,
      trolleyLastSyncAt: row.trolleyLastSyncAt ?? null,
      // Derived "ready to receive payouts" used by the auto-transfer code
      // path. Centralised so server + client agree on the predicate.
      readyForPayouts: row.payoutMethod === "TROLLEY"
        ? !!row.trolleyRecipientId && !!row.trolleyPayoutMethodReady
        : !!row.payoutsEnabled && !!row.stripeConnectAccountId,
    };
  }
}
