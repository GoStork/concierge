/**
 * International payout rail (Trolley) - the non-US counterpart of
 * ConnectService's Stripe path.
 *
 * Lifecycle:
 *   1. Provider (non-US legal entity) opens Payouts -> we ensure a Trolley
 *      recipient (referenceId = providerId) and mint a signed widget URL.
 *      The embedded widget collects their bank account (local currency) and
 *      the W-8BEN-E tax form inside Trolley.
 *   2. Trolley webhooks (recipient.*, recipientAccount.*, taxForm.*) mirror
 *      readiness onto ProviderBankAccount.trolley* so the Payouts page and
 *      the payout gate never need a Trolley round-trip.
 *   3. Invoice PAID -> ConnectService.createTransferForPaidInvoice routes
 *      here for payoutMethod TROLLEY: one batch, one payment, start
 *      processing; Invoice.trolleyPaymentId stamps "initiated".
 *   4. payment.processed / failed / returned webhooks stamp completion /
 *      failure exactly like Stripe's payout.paid path, so the provider's
 *      payout table and the admin views read the same for both rails.
 *
 * Fees: Trolley's recipient-pays-fees setting is configured in the Trolley
 * dashboard (Eran's rule: transfer fees come out of the provider's share).
 */
import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { prisma as prismaClient } from "../../../db";
import { normalizeCountry, payoutRailFor } from "../../../../shared/payout-countries";
import * as trolley from "./trolley.client";

const READY_RECIPIENT_STATUSES = new Set(["active"]);

@Injectable()
export class TrolleyService {
  private readonly logger = new Logger(TrolleyService.name);
  private readonly prisma = prismaClient;

  configured(): boolean {
    return trolley.trolleyConfigured();
  }

  /** The provider's legal identity + the fields Trolley wants on a recipient. */
  private async recipientInputFor(providerId: string): Promise<trolley.TrolleyRecipientInput & { country: string }> {
    const [provider, legal, adminUser] = await Promise.all([
      this.prisma.provider.findUnique({ where: { id: providerId }, select: { name: true, email: true, phone: true } }),
      this.prisma.providerLegalIdentity.findUnique({ where: { providerId } }),
      this.prisma.user.findFirst({ where: { providerId, roles: { has: "PROVIDER_ADMIN" } }, orderBy: { createdAt: "asc" }, select: { email: true, firstName: true, lastName: true, name: true } }),
    ]);
    if (!provider) throw new BadRequestException("Provider not found");
    const country = normalizeCountry(legal?.businessAddressCountry);
    if (payoutRailFor(country) !== "INTERNATIONAL") {
      throw new BadRequestException("International payouts are for non-US legal entities. US entities are paid through Stripe.");
    }
    const email = adminUser?.email || provider.email;
    if (!email) throw new BadRequestException("The provider needs an email address before international payouts can be set up.");
    const isIndividual = legal?.businessType === "individual";
    const [first, ...rest] = (adminUser?.name || `${adminUser?.firstName || ""} ${adminUser?.lastName || ""}`.trim() || provider.name).split(" ");
    return {
      country,
      type: isIndividual ? "individual" : "business",
      email,
      ...(isIndividual
        ? { firstName: adminUser?.firstName || first, lastName: adminUser?.lastName || rest.join(" ") || "-" }
        : { name: legal?.legalName?.trim() || provider.name, firstName: adminUser?.firstName || first, lastName: adminUser?.lastName || rest.join(" ") || "-" }),
      referenceId: providerId,
      address: {
        street1: legal?.businessAddressLine1 || undefined,
        street2: legal?.businessAddressLine2 || undefined,
        city: legal?.businessAddressCity || undefined,
        region: legal?.businessAddressState || undefined,
        postalCode: legal?.businessAddressPostalCode || undefined,
        country,
        phone: provider.phone || undefined,
      },
      tags: ["gostork-provider"],
    };
  }

  /**
   * Find-or-create the Trolley recipient for a provider and mirror its id on
   * ProviderBankAccount (payoutMethod TROLLEY). Idempotent: referenceId =
   * providerId, so a retry finds the same recipient.
   */
  async ensureRecipient(providerId: string): Promise<{ recipientId: string; created: boolean }> {
    if (!this.configured()) throw new BadRequestException("International payouts are not configured yet (Trolley keys missing).");
    const account = await this.prisma.providerBankAccount.upsert({
      where: { providerId },
      create: { providerId },
      update: {},
    });
    if (account.payoutMethod && account.payoutMethod !== "TROLLEY") {
      throw new BadRequestException(`This provider is already set up on ${account.payoutMethod}. Contact GoStork support to switch rails.`);
    }
    if (account.trolleyRecipientId) return { recipientId: account.trolleyRecipientId, created: false };

    const input = await this.recipientInputFor(providerId);
    let recipient = await trolley.findRecipientByReferenceId(providerId).catch(() => null);
    let created = false;
    if (!recipient) {
      const { country: _c, ...body } = input;
      recipient = await trolley.createRecipient(body);
      created = true;
    }
    await this.prisma.providerBankAccount.update({
      where: { providerId },
      data: {
        payoutMethod: "TROLLEY",
        trolleyRecipientId: recipient.id,
        trolleyRecipientStatus: recipient.status || null,
        trolleyPayoutCurrency: recipient.payoutMethod?.currency || account.trolleyPayoutCurrency || null,
        onboardingStartedAt: account.onboardingStartedAt || new Date(),
        trolleyLastSyncAt: new Date(),
      },
    });
    this.logger.log(`Trolley recipient ${recipient.id} ${created ? "created" : "linked"} for provider ${providerId}`);
    return { recipientId: recipient.id, created };
  }

  /** Signed widget URL for the provider's Payouts page iframe. */
  async widgetUrl(providerId: string, opts?: { locale?: string }): Promise<{ url: string; recipientId: string }> {
    const { recipientId } = await this.ensureRecipient(providerId);
    const input = await this.recipientInputFor(providerId);
    const brand = await this.prisma.siteSettings.findFirst({ select: { primaryColor: true } }).catch(() => null);
    const url = trolley.buildWidgetUrl({
      email: input.email,
      referenceId: providerId,
      products: ["pay", "tax"],
      locale: opts?.locale,
      prefill: { firstName: input.firstName, lastName: input.lastName, street1: input.address?.street1, city: input.address?.city, country: input.country },
      colors: brand?.primaryColor ? { primary: brand.primaryColor.replace("#", "") } : undefined,
    });
    return { url, recipientId };
  }

  /**
   * Pull the recipient + accounts from Trolley and mirror readiness. Used by
   * the Payouts page "Refresh" and as a safety net if a webhook is missed.
   */
  async syncFromTrolley(providerId: string): Promise<void> {
    const account = await this.prisma.providerBankAccount.findUnique({ where: { providerId } });
    if (!account?.trolleyRecipientId) return;
    const [recipient, accounts] = await Promise.all([
      trolley.getRecipient(account.trolleyRecipientId),
      trolley.listRecipientAccounts(account.trolleyRecipientId).catch(() => [] as any[]),
    ]);
    const primary = accounts.find((a: any) => a.primary && a.status !== "disabled") || accounts.find((a: any) => a.status !== "disabled") || null;
    const ready = !!primary && READY_RECIPIENT_STATUSES.has(recipient.status);
    await this.prisma.providerBankAccount.update({
      where: { providerId },
      data: {
        trolleyRecipientStatus: recipient.status || null,
        trolleyPayoutMethodReady: ready,
        trolleyPayoutCurrency: primary?.currency || account.trolleyPayoutCurrency || null,
        trolleyTaxFormStatus: recipient.taxFormStatus || account.trolleyTaxFormStatus || null,
        payoutsEnabled: ready,
        detailsSubmitted: !!primary,
        bankName: primary?.bankName || account.bankName || null,
        accountLast4: primary?.accountNum ? String(primary.accountNum).slice(-4) : primary?.iban ? String(primary.iban).slice(-4) : account.accountLast4,
        accountType: primary?.type || account.accountType || null,
        onboardingCompletedAt: ready ? account.onboardingCompletedAt || new Date() : account.onboardingCompletedAt,
        trolleyLastSyncAt: new Date(),
      },
    });
  }

  /**
   * Pay a PAID invoice's provider share through Trolley. Called by
   * ConnectService.createTransferForPaidInvoice when the provider's
   * payoutMethod is TROLLEY - all the upstream gates (PAID, clearance,
   * zero payout, already transferred) are applied there.
   */
  async createPayoutForInvoice(invoice: { id: string; providerId: string; providerPayoutAmount: number; currency: string | null; payoutInitiatedAt: Date | null }): Promise<
    | { status: "transferred"; transferId: string }
    | { status: "skipped"; reason: "PROVIDER_NOT_READY" | "ALREADY_TRANSFERRED"; message: string }
    | { status: "failed"; reason: string }
  > {
    const account = await this.prisma.providerBankAccount.findUnique({ where: { providerId: invoice.providerId } });
    if (!account?.trolleyRecipientId) {
      return { status: "skipped", reason: "PROVIDER_NOT_READY", message: "Provider has not set up international payouts yet" };
    }
    if (!account.trolleyPayoutMethodReady) {
      // One live check before giving up - the readiness webhook may simply
      // not have landed yet.
      await this.syncFromTrolley(invoice.providerId).catch(() => {});
      const again = await this.prisma.providerBankAccount.findUnique({ where: { providerId: invoice.providerId }, select: { trolleyPayoutMethodReady: true } });
      if (!again?.trolleyPayoutMethodReady) {
        return { status: "skipped", reason: "PROVIDER_NOT_READY", message: "Provider's international payout method is not ready (bank account or verification incomplete in Trolley)" };
      }
    }
    const existing = await this.prisma.invoice.findUnique({ where: { id: invoice.id }, select: { trolleyPaymentId: true } });
    if (existing?.trolleyPaymentId) {
      return { status: "skipped", reason: "ALREADY_TRANSFERRED", message: `Already paid out via Trolley ${existing.trolleyPaymentId}` };
    }

    const sourceCurrency = (invoice.currency || "USD").toUpperCase();
    const sourceAmount = (invoice.providerPayoutAmount / 100).toFixed(2);
    try {
      const batch = await trolley.createBatch({ description: `GoStork payout - invoice ${invoice.id}`, sourceCurrency });
      const payment = await trolley.addPayment(batch.id, {
        recipientId: account.trolleyRecipientId,
        sourceAmount,
        sourceCurrency,
        memo: `GoStork payout for invoice ${invoice.id}`,
        externalId: invoice.id,
      });
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          trolleyPaymentId: payment.id,
          trolleyBatchId: batch.id,
          trolleyPaymentStatus: payment.status || "pending",
          payoutInitiatedAt: invoice.payoutInitiatedAt || new Date(),
          payoutFailedAt: null,
          payoutFailureReason: null,
          payoutNextAttemptAt: null,
          payoutAttemptCount: 0,
        },
      });
      // Processing moves the money; payment.processed webhook stamps completion.
      await trolley.startBatchProcessing(batch.id);
      this.logger.log(`Trolley payment ${payment.id} (batch ${batch.id}) started for invoice ${invoice.id}: ${sourceAmount} ${sourceCurrency} -> recipient ${account.trolleyRecipientId}`);
      return { status: "transferred", transferId: payment.id };
    } catch (e: any) {
      const reason = e?.message || "Trolley payout failed";
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { payoutInitiatedAt: invoice.payoutInitiatedAt || new Date(), payoutFailedAt: new Date(), payoutFailureReason: `Trolley: ${reason}` },
      }).catch(() => {});
      this.logger.error(`Trolley payout failed for invoice ${invoice.id}: ${reason}`);
      return { status: "failed", reason };
    }
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  /**
   * Dispatch one verified, de-duplicated Trolley event. Returns what we did
   * (for the TrolleyWebhookEvent log).
   */
  async handleEvent(model: string, action: string, body: any): Promise<"processed" | "ignored"> {
    const key = `${model}.${action}`;
    switch (key) {
      case "recipient.created":
      case "recipient.updated":
      case "recipient.deleted": {
        const recipientId = body?.recipient?.id || body?.id;
        const providerId = body?.recipient?.referenceId || body?.referenceId;
        const row = await this.rowFor(recipientId, providerId);
        if (!row) return "ignored";
        await this.syncFromTrolley(row.providerId).catch((e) => this.logger.warn(`Trolley sync after ${key} failed: ${e?.message}`));
        return "processed";
      }
      case "recipientAccount.created":
      case "recipientAccount.updated":
      case "recipientAccount.deleted": {
        const recipientId = body?.recipientAccount?.recipientId || body?.recipientId || body?.recipient?.id;
        const row = await this.rowFor(recipientId, body?.recipientReferenceId);
        if (!row) return "ignored";
        await this.syncFromTrolley(row.providerId).catch((e) => this.logger.warn(`Trolley sync after ${key} failed: ${e?.message}`));
        return "processed";
      }
      case "taxForm.status_updated":
      case "taxForm.created":
      case "taxForm.updated": {
        const data = body?.taxForm || body?.data || body;
        const row = await this.rowFor(data?.recipientId, null);
        if (!row) return "ignored";
        await this.prisma.providerBankAccount.update({
          where: { providerId: row.providerId },
          data: { trolleyTaxFormStatus: data?.status || null, trolleyLastSyncAt: new Date() },
        });
        return "processed";
      }
      case "payment.processed":
      case "payment.failed":
      case "payment.returned":
      case "payment.updated":
      case "payment.created": {
        const p = body?.payment || body;
        const paymentId = p?.id;
        if (!paymentId) return "ignored";
        const invoice = await this.prisma.invoice.findFirst({ where: { OR: [{ trolleyPaymentId: paymentId }, ...(p?.externalId ? [{ id: p.externalId }] : [])] }, select: { id: true, trolleyPaymentId: true } });
        if (!invoice) return "ignored";
        const status: string = p?.status || action;
        const data: any = { trolleyPaymentId: invoice.trolleyPaymentId || paymentId, trolleyPaymentStatus: status };
        if (status === "processed") {
          // Money left Trolley for the provider's bank - the equivalent of
          // Stripe's payout.paid on the connected account.
          data.payoutCompletedAt = new Date();
          data.bankPayoutCompletedAt = new Date();
          data.payoutFailedAt = null;
          data.payoutFailureReason = null;
        } else if (status === "failed" || status === "returned") {
          data.payoutFailedAt = new Date();
          data.payoutFailureReason = `Trolley ${status}: ${p?.failureMessage || p?.returnedNote || (Array.isArray(p?.errors) ? p.errors.join("; ") : "") || "see Trolley dashboard"}`;
          data.bankPayoutFailedAt = new Date();
          data.bankPayoutFailureReason = data.payoutFailureReason;
        }
        await this.prisma.invoice.update({ where: { id: invoice.id }, data });
        return "processed";
      }
      default:
        return "ignored";
    }
  }

  private async rowFor(recipientId: string | null | undefined, providerId: string | null | undefined) {
    if (recipientId) {
      const byRecipient = await this.prisma.providerBankAccount.findUnique({ where: { trolleyRecipientId: recipientId }, select: { providerId: true } });
      if (byRecipient) return byRecipient;
    }
    if (providerId) {
      const byProvider = await this.prisma.providerBankAccount.findUnique({ where: { providerId }, select: { providerId: true, trolleyRecipientId: true } });
      if (byProvider) {
        // A recipient created in the Trolley dashboard with our providerId as
        // referenceId - adopt it.
        if (!byProvider.trolleyRecipientId && recipientId) {
          await this.prisma.providerBankAccount.update({ where: { providerId }, data: { trolleyRecipientId: recipientId, payoutMethod: "TROLLEY" } }).catch(() => {});
        }
        return byProvider;
      }
    }
    return null;
  }
}
