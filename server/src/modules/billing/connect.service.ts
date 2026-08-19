import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { prisma as prismaClient } from "../../../db";
import { normalizeCountry, payoutRailFor } from "../../../../shared/payout-countries";
import {
  createConnectAccount,
  createConnectAccountLink,
  createExpressLoginLink,
  retrieveConnectAccount,
  retrieveConnectAccountBalance,
  updateConnectAccount,
  attachConnectBankAccount,
  upsertConnectAccountRepresentative,
  createConnectTransfer,
  deleteConnectAccount,
  listConnectedPayoutBalanceTransactions,
  listConnectedAccountPaymentBalanceTransactions,
  retrievePlatformAvailableBalance,
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
    /** DBA / display name (Provider.name). */
    providerName: string;
    /** Legal entity name from W-9 / Legal Identity. Distinct from
     *  providerName because LLCs / corps often DBA something different. */
    legalName?: string | null;
    /** Public business website (Legal Identity or Company tab). Stripe
     *  requires this on business_profile.url for KYC. */
    businessUrl?: string | null;
    taxId?: string | null;
    businessType?: "company" | "individual";
    phone?: string | null;
    /** ISO-3166 alpha-2 of the legal entity (Legal tab). Decides the Stripe
     *  account country - US when unset. */
    country?: string | null;
    address?: {
      line1: string;
      line2?: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    } | null;
    returnUrl: string;
    refreshUrl: string;
  }): Promise<{ url: string }> {
    const country = normalizeCountry(params.country);
    // Product rule: US entities on Stripe, every non-US entity on the
    // international payout partner (shared/payout-countries.ts). Creating a
    // Stripe account for a non-US provider would only strand it.
    if (payoutRailFor(country) !== "STRIPE") {
      throw new BadRequestException(
        `Stripe payouts are for US businesses. GoStork pays non-US providers through its international payout partner - use that option on the Payouts page.`,
      );
    }
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

    // First time: create the Stripe Connect account, pre-filling every
    // field we already collected so the provider doesn't have to retype.
    if (!account.stripeConnectAccountId) {
      const { accountId } = await createConnectAccount({
        type: "EXPRESS",
        email: params.providerEmail,
        country,
        businessName: params.providerName,
        legalName: params.legalName || undefined,
        businessUrl: params.businessUrl || undefined,
        // Only a US EIN is pre-filled: Stripe validates tax_id per country
        // and a foreign identifier in the wrong format would reject the
        // whole account creation. The hosted form collects the local one.
        taxId: country === "US" ? params.taxId || undefined : undefined,
        businessType: params.businessType,
        phone: params.phone || undefined,
        address: params.address || undefined,
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
    // The in-app bank form is the US path (routing number, SSN-last-4, USD):
    // non-US entities use Stripe-hosted onboarding or the international rail.
    if (normalizeCountry(legalIdentity?.businessAddressCountry) !== "US") {
      throw new BadRequestException(
        "The in-app bank form is for US businesses only. Non-US providers connect through Stripe-hosted onboarding (where available) or GoStork's international payout partner.",
      );
    }
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

    // 3. Upsert the representative (company accounts only - individual
    // accounts already have the representative fields on Account.individual).
    // The helper finds an existing representative person on the account and
    // updates it, or creates a new one if none exists. This makes "edit
    // and re-save" idempotent instead of Stripe rejecting with "An account
    // can only have one representative".
    if (businessTypeForStripe === "company") {
      const repAddr = params.form.representative.address;
      await upsertConnectAccountRepresentative({
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

  // ── Bank management (post-onboarding) ───────────────────────────────────────

  /**
   * Replace the provider's external bank account. Attaches a new
   * external_account to the existing Connect account with
   * default_for_currency: true, so future payouts route to it. Stripe
   * keeps the prior external_account on the account history but stops
   * sending funds to it. Used by the "Change bank account" flow on the
   * Payouts tab.
   *
   * Requires the Connect account to already exist. Does not touch
   * representative / business identity - those remain unchanged.
   */
  async updateBankAccount(params: {
    providerId: string;
    bank: { routingNumber: string; accountNumber: string; accountHolderName: string; accountType: "checking" | "savings" };
  }): Promise<{ bankName: string | null; accountLast4: string | null }> {
    const account = await this.prisma.providerBankAccount.findUnique({
      where: { providerId: params.providerId },
      select: { stripeConnectAccountId: true },
    });
    if (!account?.stripeConnectAccountId) {
      throw new BadRequestException("No Stripe Connect account on file. Complete payout setup first.");
    }
    // Reuse business_type from the existing account so account_holder_type
    // matches what Stripe expects (company vs individual).
    const stripeAcct = await retrieveConnectAccount(account.stripeConnectAccountId);
    const holderType: "company" | "individual" = stripeAcct.business_type === "individual" ? "individual" : "company";

    const attached = await attachConnectBankAccount({
      accountId: account.stripeConnectAccountId,
      routingNumber: params.bank.routingNumber,
      accountNumber: params.bank.accountNumber,
      accountHolderName: params.bank.accountHolderName,
      accountHolderType: holderType,
    });

    const updated = await this.prisma.providerBankAccount.update({
      where: { providerId: params.providerId },
      data: {
        bankName: (attached as any).bank_name || null,
        accountLast4: (attached as any).last4 || null,
        accountType: params.bank.accountType,
      },
      select: { bankName: true, accountLast4: true },
    });
    this.logger.log(`Provider ${params.providerId} replaced bank account on ${account.stripeConnectAccountId} (last4=${updated.accountLast4})`);
    return updated;
  }

  /**
   * Express-only: short-lived URL into the Stripe Express dashboard.
   * Provider clicks "Manage on Stripe" and lands directly on their
   * account - they can change bank, view payouts, update info there.
   */
  async getExpressLoginLink(providerId: string): Promise<{ url: string }> {
    const account = await this.prisma.providerBankAccount.findUnique({
      where: { providerId },
      select: { stripeConnectAccountId: true, payoutMethod: true, detailsSubmitted: true },
    });
    if (!account?.stripeConnectAccountId) {
      throw new BadRequestException("No Stripe Connect account on file.");
    }
    if (account.payoutMethod !== "STRIPE_CONNECT_EXPRESS") {
      throw new BadRequestException("This action is only available for Stripe Express onboarding.");
    }
    return await createExpressLoginLink(account.stripeConnectAccountId);
  }

  /**
   * Disconnect / unlink the provider's payout account.
   *
   * Safety checks (refuse if any are true):
   *   - Any PAID invoice without a stripeTransferId (transfer never fired)
   *   - Any invoice with payoutFailedAt set (transfer attempted, errored)
   *   - Non-zero Connect-account balance (money still parked at Stripe)
   *
   * If clear: Custom accounts get deleted on Stripe's side and the
   * ProviderBankAccount row is reset. Express accounts can't be deleted
   * via API - we null out the local fields and the provider has to also
   * disconnect from their Stripe Express dashboard; the resulting
   * account.application.deauthorized webhook closes the loop.
   */
  async disconnect(providerId: string): Promise<
    | { status: "disconnected" }
    | { status: "blocked"; reason: string; pendingCount?: number; failedCount?: number; balanceCents?: number }
  > {
    const account = await this.prisma.providerBankAccount.findUnique({
      where: { providerId },
      select: { stripeConnectAccountId: true, payoutMethod: true, detailsSubmitted: true },
    });
    if (!account?.stripeConnectAccountId) {
      return { status: "disconnected" };
    }

    // 1. Pending payouts (PAID, no transfer ID, no failure stamp - never fired)
    const pendingCount = await this.prisma.invoice.count({
      where: { providerId, status: "PAID", stripeTransferId: null, payoutFailedAt: null, providerPayoutAmount: { gt: 0 } },
    });
    if (pendingCount > 0) {
      return {
        status: "blocked",
        reason: `You have ${pendingCount} payout${pendingCount === 1 ? "" : "s"} waiting to be sent. Wait for them to clear, or contact GoStork support, before disconnecting.`,
        pendingCount,
      };
    }

    // 2. Failed payouts (transfer attempted, errored, not yet retried successfully)
    const failedCount = await this.prisma.invoice.count({
      where: { providerId, status: "PAID", payoutFailedAt: { not: null }, stripeTransferId: null },
    });
    if (failedCount > 0) {
      return {
        status: "blocked",
        reason: `${failedCount} payout${failedCount === 1 ? "" : "s"} failed and need to be resolved before disconnecting. Contact GoStork support.`,
        failedCount,
      };
    }

    // 3. Money still sitting on the Connect account (transferred but not yet
    // paid out to the provider's bank).
    try {
      const bal = await retrieveConnectAccountBalance(account.stripeConnectAccountId);
      const total = bal.available + bal.pending;
      if (total > 0) {
        return {
          status: "blocked",
          reason: `Your Stripe Connect balance is ${(total / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}. Wait for Stripe to pay it out to your bank before disconnecting.`,
          balanceCents: total,
        };
      }
    } catch (e: any) {
      // If we can't read the balance (permissions, network), err on the
      // safe side and refuse - better to ask the user to retry than to
      // strand funds on Stripe.
      this.logger.warn(`Could not verify Connect balance for ${account.stripeConnectAccountId} before disconnect: ${e?.message}`);
      return { status: "blocked", reason: "Could not verify your Stripe balance. Try again in a few minutes." };
    }

    // 4. Safe to disconnect. Custom: delete the account on Stripe. An
    // Express account the provider never finished (details not submitted)
    // is deleted too - leaving half-created live accounts on the platform
    // is clutter Stripe's risk team notices, and the provider gets a fresh
    // one on re-onboarding anyway. Platform-liable accounts with a zero
    // balance are deletable per Stripe.
    if (account.payoutMethod === "STRIPE_CONNECT_CUSTOM" || !account.detailsSubmitted) {
      try {
        await deleteConnectAccount(account.stripeConnectAccountId);
      } catch (e: any) {
        this.logger.warn(`Stripe account delete failed for ${account.stripeConnectAccountId}: ${e?.message}. Proceeding with local disconnect.`);
      }
    }
    // Reset our row either way - if the provider re-onboards we'll
    // provision a fresh account.
    await this.prisma.providerBankAccount.update({
      where: { providerId },
      data: {
        payoutMethod: null,
        stripeConnectAccountId: null,
        payoutsEnabled: false,
        chargesEnabled: false,
        detailsSubmitted: false,
        requirementsCurrentlyDue: [],
        requirementsEventuallyDue: [],
        requirementsPastDue: [],
        requirementsDisabledReason: null,
        bankName: null,
        accountLast4: null,
        accountType: null,
        onboardingStartedAt: null,
        onboardingCompletedAt: null,
      },
    });
    this.logger.log(`Provider ${providerId} disconnected payout account ${account.stripeConnectAccountId}`);
    return { status: "disconnected" };
  }

  // ── Bank-side settlement (payout.paid / payout.failed) ──────────────────────

  /**
   * Returns the list of source ids (py_xxx Charges on the connected account)
   * that the given Payout bundled. Tries the direct filter first (only works
   * for automatic payouts - Stripe rejects it for manual ones with the error
   * "Balance transaction history can only be filtered on automatic transfers,
   * not manual"). On that specific failure, falls back to listing the
   * connected account's recent payment BTs and letting the caller intersect
   * those against our unsettled invoices.
   *
   * Production: payouts are automatic (Stripe runs the schedule) so the
   * direct filter is the path that always runs. The fallback only fires for
   * dev/test where we trigger payouts manually via the API.
   */
  private async resolvePayoutSourceIds(payout: Stripe.Payout, accountId: string): Promise<string[]> {
    try {
      const bts = await listConnectedPayoutBalanceTransactions({ accountId, payoutId: payout.id });
      return bts.map(b => b.source).filter((s): s is string => !!s);
    } catch (e: any) {
      const msg = (e?.message || "").toLowerCase();
      const isManualFilterError = /can only be filtered on automatic|not manual/.test(msg);
      if (!isManualFilterError) throw e;
      this.logger.warn(`Payout ${payout.id} is manual; falling back to listing payment BTs on ${accountId}`);
      // Bound the window to recent activity so we don't scan years of history.
      // Anything 60 days back covers the realistic delay between transfer
      // creation and bank settlement; sized generously since pagination is
      // capped at 100/page.
      const since = Math.floor(Date.now() / 1000) - 60 * 24 * 60 * 60;
      const bts = await listConnectedAccountPaymentBalanceTransactions({ accountId, sinceUnix: since });
      return bts.map(b => b.source).filter((s): s is string => !!s);
    }
  }

  /**
   * payout.paid on a connected account = Stripe finished sweeping that
   * account's available balance to the provider's bank. One Stripe Payout
   * can bundle multiple platform-originated Transfers (the connected
   * account's payout schedule batches them by date), so we list the
   * payout's balance transactions and stamp every invoice the payout
   * settled.
   *
   * Matching key: BT.source is the Charge id (py_xxx) on the connected
   * account that the platform Transfer created. We stored that as
   * Invoice.stripeConnectPaymentId at transfer time, so it's a direct
   * lookup.
   */
  async handlePayoutSucceeded(payout: Stripe.Payout, accountId: string): Promise<{ matched: number }> {
    const sources = await this.resolvePayoutSourceIds(payout, accountId);
    if (sources.length === 0) {
      this.logger.warn(`payout.paid ${payout.id} on ${accountId}: no balance transactions returned`);
      return { matched: 0 };
    }
    // Idempotent: only update rows that don't already have a bank-payout
    // stamp. Re-deliveries of the webhook (which Stripe does on retry) are
    // safe and won't churn the timestamp.
    const result = await this.prisma.invoice.updateMany({
      where: {
        stripeConnectPaymentId: { in: sources },
        bankPayoutCompletedAt: null,
      },
      data: {
        bankPayoutCompletedAt: new Date(),
        stripeBankPayoutId: payout.id,
        bankPayoutFailedAt: null,
        bankPayoutFailureReason: null,
      },
    });
    this.logger.log(`payout.paid ${payout.id} on ${accountId}: settled ${result.count} of ${sources.length} bundled transfer(s)`);
    return { matched: result.count };
  }

  /**
   * payout.failed = provider's bank rejected the credit (closed account,
   * wrong routing, NSF). Money stays on the connected account's balance
   * and Stripe retries on the next payout schedule. Same matching logic
   * as success - stamp the invoices that the failed payout would have
   * settled so the UI can show "Failed at bank" per row.
   */
  async handlePayoutFailed(payout: Stripe.Payout, accountId: string): Promise<{ matched: number }> {
    const sources = await this.resolvePayoutSourceIds(payout, accountId);
    if (sources.length === 0) {
      this.logger.warn(`payout.failed ${payout.id} on ${accountId}: no balance transactions returned`);
      return { matched: 0 };
    }
    const reason = (payout.failure_message || payout.failure_code || "Bank rejected the payout").slice(0, 500);
    const result = await this.prisma.invoice.updateMany({
      where: {
        stripeConnectPaymentId: { in: sources },
        // Don't overwrite a successful settlement if a stale payout.failed
        // arrives out-of-order (Stripe doesn't guarantee delivery order).
        bankPayoutCompletedAt: null,
      },
      data: {
        bankPayoutFailedAt: new Date(),
        bankPayoutFailureReason: reason,
        stripeBankPayoutId: payout.id,
      },
    });
    this.logger.warn(`payout.failed ${payout.id} on ${accountId}: ${reason} (affected ${result.count} invoice(s))`);
    return { matched: result.count };
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
    | { status: "skipped"; reason: "ALREADY_TRANSFERRED" | "ZERO_PAYOUT" | "PROVIDER_NOT_READY" | "CLEARANCE_PENDING"; message: string }
    | { status: "deferred"; nextAttemptAt: Date; message: string }
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
        payoutAttemptCount: true,
        medicalClearanceStatus: true,
      },
    });
    if (!invoice) return { status: "failed", reason: "Invoice not found" };
    if (invoice.status !== "PAID") return { status: "skipped", reason: "PROVIDER_NOT_READY", message: `Invoice not PAID (status=${invoice.status})` };
    // Escrow vault gate - THE choke point for held funds. A PAID invoice
    // with clearance still PENDING is money sitting in GoStork's vault
    // (hybrid AT_CLEARANCE flow): the parent has been charged, but nothing
    // may reach the provider until medical clearance is confirmed. Every
    // transfer path (payment webhook, capture, admin mark-paid, payout
    // retry sweep, admin retry endpoint) routes through this method, so
    // this single check protects them all. releaseEscrowVault clears the
    // PENDING status and re-invokes the transfer.
    if (invoice.medicalClearanceStatus === "PENDING") {
      return {
        status: "skipped",
        reason: "CLEARANCE_PENDING",
        message: "Funds held in GoStork vault - medical clearance not confirmed yet",
      };
    }
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

    // Pre-flight: card payments settle into the PENDING platform balance
    // first (~2 business days live, simulated in test mode), and
    // transfers.create only draws from AVAILABLE. If the available
    // balance can't cover this payout yet, attempting the transfer is a
    // guaranteed failure - so instead of failing we schedule an automatic
    // retry (backoff ladder below) and keep the payout honestly "Pending".
    // Balance-check errors themselves are non-fatal: we fall through and
    // let the transfer attempt speak for itself.
    try {
      const available = await retrievePlatformAvailableBalance(invoice.currency || "USD");
      if (available < invoice.providerPayoutAmount) {
        return await this.deferPayout(
          invoice,
          `Platform available balance (${available}) cannot cover payout (${invoice.providerPayoutAmount}) yet - funds still settling`,
        );
      }
    } catch (e: any) {
      this.logger.warn(`Platform balance pre-check failed for invoice ${invoice.id} (attempting transfer anyway): ${e?.message}`);
    }

    // Retry loop. The first attempt usually succeeds; the retries are
    // there for two real-world cases that look identical to our caller:
    //   1. Test mode: even the 4000000000000077 "instant-available" card
    //      can lag a couple of seconds before the funds register as
    //      available - the platform-paid webhook fires faster than the
    //      balance ledger settles.
    //   2. Live mode race: payment_intent.succeeded sometimes fires
    //      microseconds before Stripe's internal ledger commits the
    //      gross amount to available.
    // In both cases the same error message comes back ("You have
    // insufficient available funds in your Stripe account"). Quick
    // backoff (3s, 8s, 20s) lets the ledger catch up without surfacing
    // a fake failure to the provider.
    const TRANSFER_RETRY_DELAYS_MS = [3000, 8000, 20000];
    const isTransientFundsError = (msg: string) =>
      /insufficient available funds|insufficient_funds|Try adding funds/i.test(msg || "");

    let lastError: any = null;
    for (let attempt = 0; attempt <= TRANSFER_RETRY_DELAYS_MS.length; attempt++) {
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
            // attempt index so we can correlate retries in Stripe Dashboard
            attempt: String(attempt + 1),
          },
        });

        // Transfer.create succeeded -> the money has moved from the platform
        // balance into the connected account's balance. Stripe's own payout
        // schedule then moves it from the connected account to the
        // provider's bank. We stamp both initiated + completed here because
        // platform->connect transfers are synchronous and have no separate
        // async "transfer succeeded" signal beyond the API call returning.
        // Also clear any prior failure stamps so retried-success rows
        // don't keep showing "Failed" in the provider's table.
        await this.prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            stripeTransferId: transfer.id,
            // destination_payment is the Charge id (py_xxx) created on the
            // connected account when this Transfer landed. The bank-side
            // payout.paid webhook references it as the BT source, so we
            // stamp it here for the match-back lookup.
            stripeConnectPaymentId: (transfer as any).destination_payment || null,
            payoutInitiatedAt: invoice.payoutInitiatedAt || new Date(),
            payoutCompletedAt: new Date(),
            payoutFailedAt: null,
            payoutFailureReason: null,
            payoutNextAttemptAt: null,
            payoutAttemptCount: 0,
          },
        });
        if (attempt > 0) {
          this.logger.log(`Transfer ${transfer.id} succeeded for invoice ${invoice.id} on retry #${attempt}`);
        } else {
          this.logger.log(`Transfer ${transfer.id} created for invoice ${invoice.id} -> Connect account ${payoutAccount.stripeConnectAccountId} (${invoice.providerPayoutAmount} ${invoice.currency})`);
        }
        return { status: "transferred", transferId: transfer.id };
      } catch (e: any) {
        lastError = e;
        const reason = e?.message || "Unknown Stripe transfer error";
        const transient = isTransientFundsError(reason);
        const hasMoreRetries = attempt < TRANSFER_RETRY_DELAYS_MS.length;
        if (transient && hasMoreRetries) {
          const wait = TRANSFER_RETRY_DELAYS_MS[attempt];
          this.logger.warn(`Transfer for invoice ${invoice.id} hit transient funds error on attempt ${attempt + 1}; retrying in ${wait}ms: ${reason}`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        // Transient funds error with in-process retries exhausted: the
        // money just hasn't settled yet. Hand off to the payout-retry
        // scheduler instead of stamping a fake failure.
        if (transient) {
          return await this.deferPayout(invoice, reason);
        }
        // Non-transient (account restricted, bad destination, ...) -
        // record a real failure; auto-retry won't fix these.
        await this.prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            payoutInitiatedAt: invoice.payoutInitiatedAt || new Date(),
            payoutFailedAt: new Date(),
            payoutFailureReason: reason.slice(0, 500),
            payoutNextAttemptAt: null,
          },
        });
        this.logger.error(`Transfer failed for invoice ${invoice.id} after ${attempt + 1} attempt(s): ${reason}`);
        return { status: "failed", reason };
      }
    }
    // Unreachable in practice - the loop either returns or records failure.
    return { status: "failed", reason: lastError?.message || "Exhausted retries" };
  }

  /**
   * Schedules the next automatic transfer attempt for an invoice whose
   * platform funds haven't settled yet. Backoff ladder: 2h, 8h, 24h, 48h,
   * 72h after the respective attempt. While scheduled, the payout status
   * stays "Pending" (payoutFailedAt is NOT stamped) because nothing is
   * actually wrong - the money is on its way. Only when the ladder is
   * exhausted (~6 days) do we flip to a real failure so the admin
   * Needs-attention queue picks it up.
   */
  private async deferPayout(
    invoice: { id: string; payoutInitiatedAt: Date | null; payoutAttemptCount: number },
    why: string,
  ): Promise<{ status: "deferred"; nextAttemptAt: Date; message: string } | { status: "failed"; reason: string }> {
    const BACKOFF_HOURS = [2, 8, 24, 48, 72];
    const attemptCount = (invoice.payoutAttemptCount || 0) + 1;
    const delayHours = BACKOFF_HOURS[attemptCount - 1];
    if (delayHours == null) {
      const reason = `Funds still unavailable after ${attemptCount - 1} automatic attempts: ${why}`.slice(0, 500);
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          payoutInitiatedAt: invoice.payoutInitiatedAt || new Date(),
          payoutFailedAt: new Date(),
          payoutFailureReason: reason,
          payoutNextAttemptAt: null,
          payoutAttemptCount: attemptCount,
        },
      });
      this.logger.error(`Payout for invoice ${invoice.id} exhausted the auto-retry ladder: ${why}`);
      return { status: "failed", reason };
    }
    const nextAttemptAt = new Date(Date.now() + delayHours * 60 * 60 * 1000);
    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        payoutInitiatedAt: invoice.payoutInitiatedAt || new Date(),
        payoutFailedAt: null,
        payoutFailureReason: `Waiting for platform funds to settle - automatic retry #${attemptCount} scheduled`.slice(0, 500),
        payoutNextAttemptAt: nextAttemptAt,
        payoutAttemptCount: attemptCount,
      },
    });
    this.logger.log(`Payout for invoice ${invoice.id} deferred (attempt ${attemptCount}, next try in ${delayHours}h): ${why}`);
    return { status: "deferred", nextAttemptAt, message: why };
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
