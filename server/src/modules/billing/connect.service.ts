import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { prisma as prismaClient } from "../../../db";
import {
  createConnectAccount,
  createConnectAccountLink,
  retrieveConnectAccount,
  updateConnectAccount,
  attachConnectBankAccount,
  createConnectAccountRepresentative,
  createConnectTransfer,
} from "../../../stripe-service";
import type Stripe from "stripe";

/**
 * Stripe Connect business logic. Owns:
 *   - Provisioning the Stripe Connect account (Express or Custom controller)
 *   - Generating onboarding redirect URLs (Express path)
 *   - Submitting KYC fields the provider typed into a GoStork form (Custom path)
 *   - Mirroring Stripe's account state into ProviderBankAccount so the UI
 *     can render onboarding status without a Stripe round-trip per page load
 *   - Handling account.updated / account.application.deauthorized webhook
 *     events (called from the webhook controller)
 */

export type PayoutMethod = "STRIPE_CONNECT_EXPRESS" | "STRIPE_CONNECT_CUSTOM";

/**
 * Custom-payout body shape. Business identity (name, tax id, address,
 * business type) is NOT collected here - it comes from
 * ProviderLegalIdentity. The provider edits it on /account/legal-identity
 * and we read it server-side at save time.
 */
export interface CustomPayoutFormData {
  representative: {
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    dob: { day: number; month: number; year: number };
    ssnLast4: string;
    address: {
      line1: string;
      line2?: string;
      city: string;
      state: string;
      postalCode: string;
      country?: string;
    };
  };
  bank: {
    routingNumber: string;
    accountNumber: string;
    accountHolderName: string;
    accountType: "checking" | "savings";
  };
}

@Injectable()
export class ConnectService {
  private readonly logger = new Logger(ConnectService.name);
  private readonly prisma = prismaClient;

  // ── Read current state for UI ──────────────────────────────────────────────

  /**
   * Returns the row the UI renders against. Creates an empty row on first
   * read so the rest of the code doesn't have to handle the "no row yet"
   * case everywhere.
   */
  async getOrCreatePayoutAccount(providerId: string) {
    const existing = await this.prisma.providerBankAccount.findUnique({
      where: { providerId },
    });
    if (existing) return existing;

    return await this.prisma.providerBankAccount.create({
      data: { providerId },
    });
  }

  // ── Express path ───────────────────────────────────────────────────────────

  /**
   * Starts (or resumes) Stripe-hosted onboarding for a provider. Idempotent:
   * if a Stripe account already exists for this provider, we reuse it and
   * just mint a new account-link URL. Stripe's account links expire after a
   * few minutes, so providers may hit this multiple times.
   *
   * Returns the redirect URL.
   */
  async startExpressOnboarding(params: {
    providerId: string;
    providerEmail: string;
    providerName: string;
    returnUrl: string;
    refreshUrl: string;
    taxId?: string | null;
  }): Promise<{ url: string }> {
    let account = await this.getOrCreatePayoutAccount(params.providerId);

    // If the provider had previously started a Custom-method setup and is
    // now switching to Express (or vice-versa), block it - the controller
    // type is fixed at account-creation time and can't be changed.
    if (account.payoutMethod && account.payoutMethod !== "STRIPE_CONNECT_EXPRESS") {
      throw new BadRequestException(
        `This provider has already started ${account.payoutMethod} onboarding. ` +
        `Contact GoStork support to switch methods.`,
      );
    }

    // First time: create the Stripe Connect account.
    if (!account.stripeConnectAccountId) {
      const { accountId } = await createConnectAccount({
        type: "EXPRESS",
        email: params.providerEmail,
        businessName: params.providerName,
        taxId: params.taxId || undefined,
      });
      account = await this.prisma.providerBankAccount.update({
        where: { providerId: params.providerId },
        data: {
          payoutMethod: "STRIPE_CONNECT_EXPRESS",
          stripeConnectAccountId: accountId,
          onboardingStartedAt: new Date(),
        },
      });
      this.logger.log(`Created Stripe Connect EXPRESS account ${accountId} for provider ${params.providerId}`);
    }

    const { url } = await createConnectAccountLink({
      accountId: account.stripeConnectAccountId!,
      returnUrl: params.returnUrl,
      refreshUrl: params.refreshUrl,
    });
    return { url };
  }

  // ── Custom path ────────────────────────────────────────────────────────────

  /**
   * Saves the GoStork-collected KYC + bank info to a Custom Connect account.
   * Creates the Stripe account on first call, then submits each piece of
   * KYC. Provider never sees Stripe.
   *
   * Returns the live requirements list so the UI can surface any field
   * Stripe still needs.
   */
  async saveCustomPayoutInfo(params: {
    providerId: string;
    providerEmail: string;
    providerName: string;
    form: CustomPayoutFormData;
  }): Promise<{ requirementsCurrentlyDue: string[]; payoutsEnabled: boolean }> {
    let account = await this.getOrCreatePayoutAccount(params.providerId);

    if (account.payoutMethod && account.payoutMethod !== "STRIPE_CONNECT_CUSTOM") {
      throw new BadRequestException(
        `This provider has already started ${account.payoutMethod} onboarding. ` +
        `Contact GoStork support to switch methods.`,
      );
    }

    // Business identity / address / tax id all live on ProviderLegalIdentity
    // (single source of truth, auto-fills from the W-9). businessUrl is
    // pre-filled from Provider.websiteUrl by the Legal Identity service on
    // first read, so by the time the provider hits Save it's either copied
    // from the Company tab or explicitly set on the Legal Identity tab.
    const legalIdentity = await this.prisma.providerLegalIdentity.findUnique({
      where: { providerId: params.providerId },
    });
    const missingLegal: string[] = [];
    if (!legalIdentity?.legalName?.trim()) missingLegal.push("legal name");
    if (!legalIdentity?.businessName?.trim()) missingLegal.push("legal business name");
    if (!legalIdentity?.businessUrl?.trim()) missingLegal.push("business website URL");
    if (!legalIdentity?.taxId?.trim()) missingLegal.push("tax ID");
    if (!legalIdentity?.taxClassification) missingLegal.push("tax classification");
    if (!legalIdentity?.businessAddressLine1?.trim()) missingLegal.push("business address");
    if (!legalIdentity?.businessAddressCity?.trim()) missingLegal.push("city");
    if (!legalIdentity?.businessAddressState?.trim()) missingLegal.push("state");
    if (!legalIdentity?.businessAddressPostalCode?.trim()) missingLegal.push("ZIP");
    if (missingLegal.length > 0) {
      throw new BadRequestException(
        `Complete your Legal Identity tab first - missing: ${missingLegal.join(", ")}.`,
      );
    }
    const businessTypeForStripe: "company" | "individual" =
      (legalIdentity!.businessType === "individual" ? "individual" : "company");

    // 1. Create the Connect account if not already done. Pulls business
    // identity from Legal Identity, not the form body.
    if (!account.stripeConnectAccountId) {
      const { accountId } = await createConnectAccount({
        type: "CUSTOM",
        email: params.providerEmail,
        businessName: legalIdentity!.legalName || params.providerName,
        businessType: businessTypeForStripe,
        taxId: legalIdentity!.taxId || undefined,
      });
      account = await this.prisma.providerBankAccount.update({
        where: { providerId: params.providerId },
        data: {
          payoutMethod: "STRIPE_CONNECT_CUSTOM",
          stripeConnectAccountId: accountId,
          onboardingStartedAt: new Date(),
        },
      });
      this.logger.log(`Created Stripe Connect CUSTOM account ${accountId} for provider ${params.providerId}`);
    }

    const accountId = account.stripeConnectAccountId!;

    // 2. Submit business profile + address + tax id via accounts.update.
    const businessAddress = {
      line1: legalIdentity!.businessAddressLine1!,
      ...(legalIdentity!.businessAddressLine2 ? { line2: legalIdentity!.businessAddressLine2 } : {}),
      city: legalIdentity!.businessAddressCity!,
      state: legalIdentity!.businessAddressState!,
      postal_code: legalIdentity!.businessAddressPostalCode!,
      country: legalIdentity!.businessAddressCountry || "US",
    };
    const updateParams: Stripe.AccountUpdateParams = {
      business_profile: {
        name: legalIdentity!.legalName!,
        url: legalIdentity!.businessUrl!,
      },
      tos_acceptance: {
        date: Math.floor(Date.now() / 1000),
        // For Custom accounts the platform records ToS acceptance on the
        // provider's behalf. Provider's IP would be ideal here; we use
        // 0.0.0.0 as the API requires a value and we don't reliably have
        // the provider's IP in this code path.
        ip: "0.0.0.0",
      },
    };
    if (businessTypeForStripe === "company") {
      updateParams.company = {
        address: businessAddress,
        tax_id: legalIdentity!.taxId!,
        name: legalIdentity!.legalName!,
      };
    } else {
      updateParams.individual = {
        first_name: params.form.representative.firstName,
        last_name: params.form.representative.lastName,
        address: businessAddress,
        dob: params.form.representative.dob,
        ssn_last_4: params.form.representative.ssnLast4,
        id_number: legalIdentity!.taxId!,
      };
    }
    await updateConnectAccount(accountId, updateParams);

    // 3. Create the representative (company accounts only - individual
    // accounts already have the representative fields on Account.individual).
    if (businessTypeForStripe === "company") {
      try {
        const repAddr = params.form.representative.address;
        await createConnectAccountRepresentative({
          accountId,
          firstName: params.form.representative.firstName,
          lastName: params.form.representative.lastName,
          email: params.form.representative.email,
          phone: params.form.representative.phone,
          dob: params.form.representative.dob,
          ssnLast4: params.form.representative.ssnLast4,
          address: {
            line1: repAddr.line1 || businessAddress.line1,
            line2: repAddr.line2,
            city: repAddr.city || businessAddress.city,
            state: repAddr.state || businessAddress.state,
            postalCode: repAddr.postalCode || businessAddress.postal_code,
            country: repAddr.country || "US",
          },
        });
      } catch (e: any) {
        // If a person already exists (re-submit case) Stripe returns 400.
        // Surface other errors but don't abort the whole flow on this case.
        if (!/already exists|duplicate/i.test(e?.message || "")) throw e;
        this.logger.warn(`Representative already exists on ${accountId}: ${e.message}`);
      }
    }

    // 4. Attach the bank account.
    const attached = await attachConnectBankAccount({
      accountId,
      routingNumber: params.form.bank.routingNumber,
      accountNumber: params.form.bank.accountNumber,
      accountHolderName: params.form.bank.accountHolderName,
      accountHolderType: businessTypeForStripe,
    });

    // 5. Pull the latest snapshot from Stripe and mirror to the DB.
    const refreshed = await this.refreshFromStripe(accountId);

    await this.prisma.providerBankAccount.update({
      where: { providerId: params.providerId },
      data: {
        bankName: (attached as any).bank_name || null,
        accountLast4: (attached as any).last4 || null,
        accountType: params.form.bank.accountType,
      },
    });

    return {
      requirementsCurrentlyDue: refreshed.requirementsCurrentlyDue,
      payoutsEnabled: refreshed.payoutsEnabled,
    };
  }

  // ── State refresh ──────────────────────────────────────────────────────────

  /**
   * Pulls the latest snapshot from Stripe and mirrors it into the row.
   * Called from (a) every Custom save (b) the account.updated webhook
   * (c) the Express return URL (so we update immediately when the
   * provider lands back on GoStork, not on the next webhook).
   */
  async refreshFromStripe(stripeAccountId: string) {
    const account = await retrieveConnectAccount(stripeAccountId);
    const row = await this.prisma.providerBankAccount.findFirst({
      where: { stripeConnectAccountId: stripeAccountId },
    });
    if (!row) {
      throw new NotFoundException(`No ProviderBankAccount row for Stripe account ${stripeAccountId}`);
    }

    const transfersActive = account.capabilities?.transfers === "active";
    const previouslyEnabled = row.payoutsEnabled;
    const detailsSubmitted = !!account.details_submitted;
    const chargesEnabled = !!account.charges_enabled;
    const requirements = account.requirements;

    // First time we see payouts flip on -> stamp onboardingCompletedAt.
    const onboardingCompletedAt = !previouslyEnabled && transfersActive
      ? new Date()
      : row.onboardingCompletedAt;

    // Try to pull a bank-name + last4 snapshot for display. external_accounts
    // is a List; we grab the first bank_account on file.
    let bankName: string | null = row.bankName;
    let accountLast4: string | null = row.accountLast4;
    const externalAccount = account.external_accounts?.data.find(
      ea => (ea as any).object === "bank_account",
    ) as Stripe.BankAccount | undefined;
    if (externalAccount) {
      bankName = externalAccount.bank_name || bankName;
      accountLast4 = externalAccount.last4 || accountLast4;
    }

    const updated = await this.prisma.providerBankAccount.update({
      where: { id: row.id },
      data: {
        payoutsEnabled: transfersActive,
        chargesEnabled,
        detailsSubmitted,
        requirementsCurrentlyDue: (requirements?.currently_due || []) as any,
        requirementsEventuallyDue: (requirements?.eventually_due || []) as any,
        requirementsPastDue: (requirements?.past_due || []) as any,
        requirementsDisabledReason: requirements?.disabled_reason || null,
        bankName,
        accountLast4,
        onboardingCompletedAt,
      },
    });

    if (!previouslyEnabled && transfersActive) {
      this.logger.log(`Provider ${row.providerId} payouts ENABLED (Stripe Connect ${stripeAccountId})`);
    }

    return {
      ...updated,
      requirementsCurrentlyDue: requirements?.currently_due || [],
    };
  }

  // ── Webhook handlers ───────────────────────────────────────────────────────

  /** account.updated - re-pulls and mirrors the new state. */
  async handleAccountUpdated(stripeAccount: Stripe.Account) {
    try {
      await this.refreshFromStripe(stripeAccount.id);
    } catch (e: any) {
      // Most common: webhook fires for an account we don't have a row for
      // (someone created it in the Stripe Dashboard outside our flow).
      // Log and ignore - nothing to mirror.
      this.logger.warn(`account.updated for unknown account ${stripeAccount.id}: ${e?.message}`);
    }
  }

  // ── Auto-transfer on invoice PAID ─────────────────────────────────────────

  /**
   * Fires the platform-to-provider transfer for a paid invoice. Called from
   * BillingService.handleStripeWebhook the moment an invoice flips to PAID.
   *
   * Idempotent: if Invoice.stripeTransferId is already set we skip (e.g.
   * Stripe re-delivers the payment_intent.succeeded webhook). On failure
   * we stamp payoutFailedAt + payoutFailureReason and surface the error
   * via in-app admin notification, but do NOT throw - the invoice stays
   * PAID and the parent's payment is not affected.
   *
   * Returns a discriminated result so callers can log + react.
   */
  async createTransferForPaidInvoice(invoiceId: string): Promise<
    | { status: "transferred"; transferId: string }
    | { status: "skipped"; reason: "ALREADY_TRANSFERRED" | "ZERO_PAYOUT" | "PROVIDER_NOT_READY"; message: string }
    | { status: "failed"; reason: string }
  > {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        providerId: true,
        providerPayoutAmount: true,
        currency: true,
        status: true,
        stripeTransferId: true,
        payoutInitiatedAt: true,
      },
    });
    if (!invoice) return { status: "failed", reason: "Invoice not found" };
    if (invoice.status !== "PAID") return { status: "skipped", reason: "PROVIDER_NOT_READY", message: `Invoice not PAID (status=${invoice.status})` };
    if (invoice.stripeTransferId) {
      return { status: "skipped", reason: "ALREADY_TRANSFERRED", message: `Already transferred via ${invoice.stripeTransferId}` };
    }
    if (!invoice.providerPayoutAmount || invoice.providerPayoutAmount <= 0) {
      return { status: "skipped", reason: "ZERO_PAYOUT", message: "Nothing to transfer (provider payout = 0)" };
    }

    const payoutAccount = await this.prisma.providerBankAccount.findUnique({
      where: { providerId: invoice.providerId },
    });
    if (!payoutAccount?.stripeConnectAccountId || !payoutAccount.payoutsEnabled) {
      return {
        status: "skipped",
        reason: "PROVIDER_NOT_READY",
        message: payoutAccount?.stripeConnectAccountId
          ? "Provider's Stripe Connect account has payouts disabled (KYC incomplete or restricted)"
          : "Provider has not connected a payout account yet",
      };
    }

    try {
      const transfer = await createConnectTransfer({
        amountCents: invoice.providerPayoutAmount,
        currency: invoice.currency || "USD",
        destinationAccountId: payoutAccount.stripeConnectAccountId,
        transferGroup: invoice.id,
        description: `GoStork payout for invoice ${invoice.id}`,
        metadata: {
          invoiceId: invoice.id,
          providerId: invoice.providerId,
        },
      });

      // Transfer.create succeeded -> the money has moved from the platform
      // balance into the connected account's balance. Stripe's own payout
      // schedule then moves it from the connected account to the
      // provider's bank. We stamp both initiated + completed here because
      // platform->connect transfers are synchronous and have no separate
      // async "transfer succeeded" signal beyond the API call returning.
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          stripeTransferId: transfer.id,
          payoutInitiatedAt: invoice.payoutInitiatedAt || new Date(),
          payoutCompletedAt: new Date(),
        },
      });
      this.logger.log(`Transfer ${transfer.id} created for invoice ${invoice.id} -> Connect account ${payoutAccount.stripeConnectAccountId} (${invoice.providerPayoutAmount} ${invoice.currency})`);
      return { status: "transferred", transferId: transfer.id };
    } catch (e: any) {
      const reason = e?.message || "Unknown Stripe transfer error";
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          payoutInitiatedAt: invoice.payoutInitiatedAt || new Date(),
          payoutFailedAt: new Date(),
          payoutFailureReason: reason.slice(0, 500),
        },
      });
      this.logger.error(`Transfer failed for invoice ${invoice.id}: ${reason}`);
      return { status: "failed", reason };
    }
  }

  /** account.application.deauthorized - provider disconnected, mark as off. */
  async handleAccountDeauthorized(stripeAccountId: string) {
    const row = await this.prisma.providerBankAccount.findFirst({
      where: { stripeConnectAccountId: stripeAccountId },
    });
    if (!row) return;
    await this.prisma.providerBankAccount.update({
      where: { id: row.id },
      data: {
        payoutsEnabled: false,
        chargesEnabled: false,
        requirementsDisabledReason: "account_deauthorized",
      },
    });
    this.logger.warn(`Provider ${row.providerId} deauthorized Stripe Connect account ${stripeAccountId}`);
  }
}
