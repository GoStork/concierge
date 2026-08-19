import { asJson } from "../../../../shared/prisma-json";
import { serviceTypeOfSession } from "../../../service-lines";
import { platformPrimaryColor } from "../../../brand-color";
import { taxFormFor, isUsEntity, TAX_FORM_LABELS, effectivePayoutCountry } from "../../../../shared/payout-countries";
import { Prisma } from "@prisma/client";
import { Injectable, Inject, Logger, NotFoundException, BadRequestException } from "@nestjs/common";
import { emitJourneyEvent, emitInvoiceJourneyEvent } from "../../../journey-events";
import {
  GATES_CLOSED, parentAccountKey, redactParentContact, releaseParentContact, resolveParentGatesBatch,
} from "../../../parent-privacy";
import { NotificationService } from "../notifications/notification.service";
import { ConnectService } from "./connect.service";
import { prisma as prismaClient } from "../../../db";
import { generateReceiptPdf } from "./receipt-pdf";
import { formatMoneyCents } from "../../lib/format-money";
import { getBaseUrl } from "../../lib/get-base-url";
import { formatWhen, resolveProviderTimezone } from "../../lib/booking-when";
import {
  effectiveAgreementMode,
  agreementServiceTypeForSession,
  generateAndAnnounceAgreement,
  maybeCompleteHandoff,
} from "../../../agreement-flow";
import { getAutomationDefaults, resolveDocMode } from "../../../automation-defaults";
import { resolveAgreementTemplate, agreementDocumentType } from "../../../pandadoc-service";
import { resolveParentEvaSessionId } from "../../../parent-visibility";
import { resolveQuotePaymentSchedule } from "../costs/payment-schedule.service";
import {
  getCardDetailsForPaymentIntent,
  getOrCreateStripeCustomer,
  createBankTransferPaymentIntent,
  retrieveBankTransferInstructions,
  createRefund,
  createTransferReversal,
  capturePaymentIntent,
  type WireInstructions,
} from "../../../stripe-service";

const formatCents = (cents: number, currency?: string) => formatMoneyCents(cents, currency || "USD");

// Maps provider type names to human-readable service types
// resolveServiceType lived here: the label-returning twin of
// providerTypeNameToServiceType below. Its only caller stamped
// Invoice.serviceType, which now stores the enum like every other model, so
// keeping it would leave a second, subtly different vocabulary
// ("IVF Treatment" vs "IVF Clinic") waiting to be picked up by mistake.

// Maps the line-item enum (DB-stored) to a parent-facing label.
export function humanizeLineServiceType(t: string): string {
  switch ((t || "").toUpperCase()) {
    case "SURROGACY": return "Surrogacy";
    case "EGG_DONATION": return "Egg Donation";
    case "SPERM_DONATION": return "Sperm Donation";
    case "IVF_CLINIC": return "IVF Clinic";
    case "LEGAL_SERVICES": return "Legal Services";
    case "OTHER": return "Other";
    default: return t || "Service";
  }
}

// Maps a ProviderType.name (e.g. "Surrogacy Agency", "Egg Donor Agency")
// to the LineServiceType enum used everywhere downstream (InvoiceLineItem,
// ReferralFeeConfig.serviceType). Mirrors the SQL backfill in
// 20260527_per_service_referral_fee_config/migration.sql.
export function providerTypeNameToServiceType(providerTypeName: string | undefined | null): string {
  if (!providerTypeName) return "OTHER";
  const n = providerTypeName.toLowerCase();
  if (n.includes("surrogacy")) return "SURROGACY";
  if (n.includes("egg donor") || n.includes("egg bank")) return "EGG_DONATION";
  if (n.includes("sperm")) return "SPERM_DONATION";
  if (n.includes("ivf") || n.includes("clinic")) return "IVF_CLINIC";
  if (n.includes("legal")) return "LEGAL_SERVICES";
  return "OTHER";
}

// Maps an AiChatSession.subjectType (e.g. "Egg Donor", "Surrogate") to the
// LineServiceType the session's journey is actually about. Null when the
// session has no subject (clinic-only chats) - callers fall back to the
// provider's primary approved service.
export function serviceTypeFromSubject(subjectType: string | null | undefined): string | null {
  const s = (subjectType || "").toLowerCase();
  if (!s) return null;
  if (s.includes("egg")) return "EGG_DONATION";
  if (s.includes("surrog")) return "SURROGACY";
  if (s.includes("sperm")) return "SPERM_DONATION";
  if (s.includes("ivf") || s.includes("clinic") || s.includes("doctor")) return "IVF_CLINIC";
  if (s.includes("legal") || s.includes("lawyer")) return "LEGAL_SERVICES";
  return null;
}

/**
 * Sortable columns on the admin Billing Dashboard, mapped to Prisma orderBy.
 * Payout Status has no single column behind it (it is derived from four
 * timestamps plus the refund fields), so it orders by the timestamp that
 * actually moves a row through the payout lifecycle.
 */
const ADMIN_INVOICE_ORDER_BY: Record<string, (d: "asc" | "desc") => any> = {
  parent: (d) => ({ parentUser: { name: d } }),
  provider: (d) => ({ providerName: d }),
  service: (d) => ({ serviceType: d }),
  amount: (d) => ({ serviceAmount: d }),
  fee: (d) => ({ referralFeeAmount: d }),
  payout: (d) => ({ providerPayoutAmount: d }),
  invoiceStatus: (d) => ({ status: d }),
  payoutStatus: (d) => ({ payoutInitiatedAt: { sort: d, nulls: "last" } }),
  date: (d) => ({ paidAt: { sort: d, nulls: "last" } }),
};

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  private readonly prisma = prismaClient;

  constructor(
    @Inject(NotificationService) private readonly notificationService: NotificationService,
    @Inject(ConnectService) private readonly connectService: ConnectService,
  ) {}

  // ─── Per-service fee-config listing ─────────────────────────────────────────

  /**
   * Returns every ReferralFeeConfig the provider has, plus the list of
   * services they're enabled to offer (derived from APPROVED ProviderService
   * rows). Used by the admin and provider billing tabs to render one config
   * panel per service.
   *
   * The `services` array always contains at least one entry per APPROVED
   * provider service. The `configs` array may be shorter (a config row is
   * only created the first time admin saves one for that service).
   */
  async getFeeConfigsForProvider(providerId: string) {
    const [configs, provider] = await Promise.all([
      this.prisma.referralFeeConfig.findMany({
        where: { providerId },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.provider.findUnique({
        where: { id: providerId },
        select: {
          depositMilestone: true,
          averageClearanceDays: true,
          services: {
            where: { status: "APPROVED" },
            include: { providerType: { select: { name: true } } },
          },
        },
      }),
    ]);

    if (!provider) throw new NotFoundException("Provider not found");

    // De-dupe by serviceType: two ProviderService rows with the same
    // mapped service (e.g. "Egg Bank" + "Egg Donor Agency" both -> EGG_DONATION)
    // collapse to a single tab in the UI.
    const seen = new Set<string>();
    const services: Array<{ serviceType: string; providerTypeName: string }> = [];
    for (const ps of provider.services) {
      const st = providerTypeNameToServiceType(ps.providerType?.name);
      if (seen.has(st)) continue;
      seen.add(st);
      services.push({ serviceType: st, providerTypeName: ps.providerType?.name ?? "" });
    }

    return {
      configs: configs.map(c => ({
        ...c,
        flatAmount: c.flatAmount ? Number(c.flatAmount) : null,
        percentage: c.percentage ? Number(c.percentage) : null,
        defaultServiceAmount: c.defaultServiceAmount ? Number(c.defaultServiceAmount) : null,
      })),
      services,
      provider: {
        depositMilestone: provider.depositMilestone,
        averageClearanceDays: provider.averageClearanceDays,
      },
    };
  }

  // ─── Fee computation ────────────────────────────────────────────────────────

  /**
   * Computes the GoStork referral fee and the provider's payout for a single invoice.
   *
   *  - `feeBasisCents`   = the quoted total cost (what the % is taken from). Ignored for FLAT.
   *  - `parentPaysCents` = what the parent is actually being charged on this invoice.
   *
   * Payout is always `parentPaysCents - referralFeeAmount`, clamped so the provider
   * never receives a negative amount.
   */
  computeFee(
    config: { feeType: string; flatAmount: any; percentage: any },
    feeBasisCents: number,
    parentPaysCents: number,
    flatMultiplier: number = 1,
  ): { referralFeeAmount: number; providerPayoutAmount: number } {
    let referralFeeAmount = 0;
    if (config.feeType === "FLAT") {
      const units = Math.max(1, Math.round(flatMultiplier) || 1);
      referralFeeAmount = Math.round((Number(config.flatAmount) || 0) * units);
    } else if (config.feeType === "PERCENTAGE") {
      const pct = Number(config.percentage) || 0;
      referralFeeAmount = Math.round((feeBasisCents * pct) / 100);
    }
    // Provider payout must not go negative if the fee somehow exceeds what the parent pays.
    referralFeeAmount = Math.min(referralFeeAmount, parentPaysCents);
    const providerPayoutAmount = parentPaysCents - referralFeeAmount;
    return { referralFeeAmount, providerPayoutAmount };
  }

  // ─── Quote lookup ──────────────────────────────────────────────────────────

  /** Latest non-superseded ProviderQuote for a session, or null. */
  async getLatestProviderQuote(sessionId: string) {
    return this.prisma.providerQuote.findFirst({
      where: { sessionId, supersededAt: null },
      orderBy: { createdAt: "desc" },
    });
  }

  // ─── Invoice creation ───────────────────────────────────────────────────────

  /**
   * Creates an Invoice. Resolves what the parent pays and what fee basis to apply
   * from the provider's ReferralFeeConfig + the latest ProviderQuote on the session.
   *
   * Loud failures (no silent fallback):
   *  - PERCENTAGE fee config but no ProviderQuote exists -> BadRequest
   *  - parentPaysBasis = TOTAL_COST but no ProviderQuote exists -> BadRequest
   *  - parentPaysBasis = DEFAULT_FIRST_PAYMENT but defaultServiceAmount is unset -> BadRequest
   *
   * Use `createInvoiceFromReadiness` for the auto-trigger path; it converts these
   * loud failures into a structured `blocked` result so the caller can send the
   * provider a "please send a cost sheet" reminder instead of throwing.
   */
  async createInvoice(params: {
    sessionId: string;
    providerId: string;
    parentUserId: string;
    triggerSource?: "PROVIDER_MANUAL" | "ADMIN_MANUAL" | "AUTO_READINESS" | "BANK_CHECKOUT";
    parentPaysOverrideCents?: number;
    description?: string;
    dueAt?: Date;
    /**
     * Optional itemized lines for this invoice. When provided and non-empty,
     * the parent-pays amount is the SUM of all line items - the legacy
     * basis/override math is bypassed. Each line: serviceType (one of
     * SURROGACY / EGG_DONATION / SPERM_DONATION / IVF_CLINIC / OTHER),
     * description (free text), amountCents (positive integer).
     */
    lineItems?: Array<{
      serviceType: string;
      description?: string | null;
      amountCents: number;
    }>;
    /**
     * When true, run every validation and amount resolution but create
     * NOTHING - returns the computed amounts instead of an Invoice. Used by
     * the Phase 3 invoice auto-draft to build the provider approval card
     * with the exact numbers a real createInvoice would produce, while
     * keeping the loud-failure semantics (same throws, same messages).
     */
    dryRun?: boolean;
    /**
     * Prefer this service's fee config as the primary (e.g. EGG_DONATION
     * when the session's subject is an egg donor) instead of the provider's
     * first approved service. Only honored when an active config exists for
     * it - keeps multi-service agencies from drafting the wrong service.
     */
    preferredServiceType?: string;
  }) {
    const {
      sessionId,
      providerId,
      parentUserId,
      triggerSource = "PROVIDER_MANUAL",
      parentPaysOverrideCents,
      description,
      dueAt,
      lineItems,
      dryRun,
      preferredServiceType,
    } = params;

    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
      include: {
        referralFeeConfigs: true,
        services: { include: { providerType: true } },
        legalIdentity: { select: { legalName: true, taxId: true, businessAddressCountry: true, usPayoutEntity: true } },
        w9: { select: { status: true, formType: true } },
      },
    });
    if (!provider) throw new NotFoundException("Provider not found");

    // Per-service fee config lookup: at least one active config must exist,
    // and (for multi-line invoices) every line item's service must have one.
    const configByService = new Map<string, typeof provider.referralFeeConfigs[number]>();
    for (const c of provider.referralFeeConfigs) {
      if (c.isActive) configByService.set(c.serviceType, c);
    }
    if (configByService.size === 0) {
      throw new BadRequestException(
        "No active referral fee configured for this provider. GoStork admin must set up billing before an invoice can be issued.",
      );
    }

    // Legal Identity must be complete before any invoice (manual or
    // automatic) can be issued: Legal Name, Tax ID, and a signed W-9 are
    // all required. (Legal Name + Tax ID come from ProviderLegalIdentity;
    // W-9 status still lives on ProviderW9.)
    // Country-aware: a non-US entity has a local tax ID (RFC, NIT, VAT...)
    // and signs a W-8BEN-E instead of a W-9 - same ProviderW9 row, formType
    // tells which form it was.
    const legalCountry = effectivePayoutCountry(provider.legalIdentity?.businessAddressCountry, (provider.legalIdentity as any)?.usPayoutEntity);
    const requiredForm = taxFormFor(legalCountry);
    const missingIdentity: string[] = [];
    if (!provider.legalIdentity?.legalName?.trim()) missingIdentity.push("Legal Name");
    if (!provider.legalIdentity?.taxId?.trim()) missingIdentity.push(isUsEntity(legalCountry) ? "Tax ID" : "Tax ID (local tax number)");
    if (provider.w9?.status !== "COMPLETED" || ((provider.w9 as any)?.formType || "W9") !== requiredForm) {
      missingIdentity.push(`a signed ${TAX_FORM_LABELS[requiredForm]}`);
    }
    if (missingIdentity.length > 0) {
      throw new BadRequestException(
        `Legal Identity is incomplete - please add ${missingIdentity.join(", ")} in the Legal tab before sending an invoice.`,
      );
    }

    const latestQuote = await this.getLatestProviderQuote(sessionId);

    // Validate line items if any were supplied. They take precedence over both
    // the override and the basis math: an agency that itemizes is telling us
    // exactly what the parent will pay for what.
    const hasLineItems = Array.isArray(lineItems) && lineItems.length > 0;
    const VALID_LINE_TYPES = new Set([
      "SURROGACY", "EGG_DONATION", "SPERM_DONATION", "IVF_CLINIC", "OTHER",
    ]);
    if (hasLineItems) {
      for (const li of lineItems!) {
        if (!VALID_LINE_TYPES.has(li.serviceType)) {
          throw new BadRequestException(`Invalid line item serviceType: ${li.serviceType}`);
        }
        if (!Number.isFinite(li.amountCents) || li.amountCents <= 0) {
          throw new BadRequestException("Line item amounts must be positive integers in cents");
        }
        if (!configByService.has(li.serviceType)) {
          throw new BadRequestException(
            `No referral fee configured for ${humanizeLineServiceType(li.serviceType)} on this provider. ` +
            `GoStork admin must add a Referral Fee Configuration for this service in the provider's Billing tab.`,
          );
        }
      }
    }
    const lineItemsSumCents = hasLineItems
      ? lineItems!.reduce((sum, li) => sum + Math.round(li.amountCents), 0)
      : 0;

    // Resolve the primary service config used for non-itemized invoices and
    // for snapshotting `Invoice.referralFeeConfigId`. Picks the first
    // APPROVED service that has an active config, falling back to any active
    // config if no approved service is configured.
    const primaryServiceTypeFromServices = provider.services
      .filter(s => s.status === "APPROVED")
      .map(s => providerTypeNameToServiceType(s.providerType?.name))
      .find(st => configByService.has(st));
    const primaryServiceType = (preferredServiceType && configByService.has(preferredServiceType)
      ? preferredServiceType
      : primaryServiceTypeFromServices)
      ?? Array.from(configByService.keys())[0];
    const primaryConfig = configByService.get(primaryServiceType)!;

    // Resolve what the parent actually pays + GoStork's fee.
    let parentPaysCents: number;
    let referralFeeAmount: number;
    let providerPayoutAmount: number;

    if (hasLineItems) {
      // Per-line fee calculation: each line uses its own service's config.
      // PERCENTAGE -> % of the line amount. FLAT -> the flat fee once per line,
      // scaled by the quote's quantity (e.g. 3 vials -> 3x the flat fee). For
      // multi-line surrogacy quotes the quantity is 1 (manually entered) so
      // this is a no-op there; it only fires in the per-unit picker flow.
      parentPaysCents = lineItemsSumCents;
      const flatMultiplier = latestQuote?.quantity ?? 1;
      let totalFee = 0;
      for (const li of lineItems!) {
        const cfg = configByService.get(li.serviceType)!;
        const { referralFeeAmount: lineFee } = this.computeFee(cfg, li.amountCents, li.amountCents, flatMultiplier);
        totalFee += lineFee;
      }
      referralFeeAmount = Math.min(totalFee, parentPaysCents);
      providerPayoutAmount = parentPaysCents - referralFeeAmount;
    } else {
      // Single-service legacy path: fall back to the primary service's config.
      let feeBasisCents: number;
      if (primaryConfig.feeType === "PERCENTAGE") {
        if (!latestQuote) {
          throw new BadRequestException(
            "Provider must send a cost sheet before a percentage-based invoice can be issued.",
          );
        }
        feeBasisCents = latestQuote.totalCostCents;
      } else {
        feeBasisCents = latestQuote?.totalCostCents ?? 0;
      }

      if (parentPaysOverrideCents != null) {
        parentPaysCents = parentPaysOverrideCents;
      } else if (primaryConfig.parentPaysBasis === "TOTAL_COST") {
        if (!latestQuote) {
          throw new BadRequestException(
            "Provider must send a cost sheet before this invoice can be issued (parent-pays basis is Total Cost).",
          );
        }
        parentPaysCents = latestQuote.totalCostCents;
      } else {
        const defaultCents = primaryConfig.defaultServiceAmount
          ? Math.round(Number(primaryConfig.defaultServiceAmount))
          : 0;
        if (!defaultCents) {
          throw new BadRequestException(
            "Provider has no Default First Payment configured for the primary service. " +
            "Admin must set one in the Billing tab before this invoice can be issued.",
          );
        }
        parentPaysCents = defaultCents;
      }

      const flatMultiplier = latestQuote?.quantity ?? 1;
      const computed = this.computeFee(primaryConfig, feeBasisCents, parentPaysCents, flatMultiplier);
      referralFeeAmount = computed.referralFeeAmount;
      providerPayoutAmount = computed.providerPayoutAmount;
    }

    // When line items are supplied, the invoice's primary serviceType comes
    // from the FIRST line item rather than the provider's first service - so
    // code paths that read invoice.serviceType still show a sensible headline
    // (e.g. "Surrogacy" instead of "Egg Donation").
    //
    // Stored as the ENUM, matching Agreement.serviceType and
    // ProviderQuote.serviceType. It used to be a display label, so the three
    // models disagreed about the same field: an enum-keyed lookup applied to
    // "Egg Donation" silently missed, which is how a parent's match status
    // came out wrong. Every render point humanizes at the boundary instead.
    const headlineServiceType = hasLineItems
      ? String(lineItems![0].serviceType || "OTHER").toUpperCase()
      : providerTypeNameToServiceType(provider.services.find(s => s.status === "APPROVED")?.providerType?.name
          ?? provider.services[0]?.providerType?.name);

    if (dryRun) {
      return {
        dryRun: true,
        parentPaysCents,
        referralFeeAmount,
        providerPayoutAmount,
        headlineServiceType,
        primaryServiceType,
        quotedTotalCostCents: latestQuote?.totalCostCents ?? null,
      } as any;
    }

    // AT_CLEARANCE escrow: surrogacy deposits from providers who chose the
    // "After medical clearance" milestone are authorize-only. Stamping
    // medicalClearanceStatus = PENDING here is what routes the whole flow:
    // create-payment-intent reads it to pick manual capture (card hold, not
    // charge), the payment page shows "Authorize Hold", wire transfers are
    // blocked, and the authorized webhook posts the vault tracker card.
    // BANK_CHECKOUT (frozen inventory) is never an escrow deposit.
    const isEscrowDeposit =
      provider.depositMilestone === "AT_CLEARANCE" &&
      triggerSource !== "BANK_CHECKOUT" &&
      (hasLineItems ? lineItems![0].serviceType === "SURROGACY" : primaryServiceType === "SURROGACY");

    const invoice = await this.prisma.invoice.create({
      data: {
        providerId,
        parentUserId,
        sessionId,
        // Multi-line invoices use multiple configs - we snapshot the primary
        // one here for legacy code paths; the per-line fee breakdown is
        // recoverable from the line item amounts + each service's config.
        referralFeeConfigId: primaryConfig.id,
        serviceAmount: parentPaysCents,
        referralFeeAmount,
        providerPayoutAmount,
        quotedTotalCostCents: latestQuote?.totalCostCents ?? null,
        providerQuoteId: latestQuote?.id ?? null,
        triggerSource,
        serviceType: headlineServiceType,
        providerName: provider.name,
        description: description || null,
        dueAt: dueAt || null,
        status: "AWAITING_PAYMENT",
        isProtected: true,
        medicalClearanceStatus: isEscrowDeposit ? "PENDING" : null,
      },
    });

    // Persist line items in the same transaction context (best effort - if
    // this fails we delete the invoice rather than leaving an orphaned one).
    if (hasLineItems) {
      try {
        await this.prisma.invoiceLineItem.createMany({
          data: lineItems!.map((li, idx) => ({
            invoiceId: invoice.id,
            serviceType: li.serviceType,
            description: li.description?.trim() || null,
            amountCents: Math.round(li.amountCents),
            displayOrder: idx,
          })),
        });
      } catch (e: any) {
        await this.prisma.invoice.delete({ where: { id: invoice.id } }).catch(() => {});
        throw new BadRequestException(`Failed to save line items: ${e?.message || "unknown error"}`);
      }
    }

    this.logger.log(
      `Invoice ${invoice.id} created (trigger=${triggerSource}, lineItems=${hasLineItems ? lineItems!.length : 0}): parent pays ${formatCents(parentPaysCents)}, GoStork fee ${formatCents(referralFeeAmount)}, provider payout ${formatCents(providerPayoutAmount)}` +
        (latestQuote ? ` (basis: quote ${latestQuote.id} = ${formatCents(latestQuote.totalCostCents)})` : ""),
    );

    // Any pending invoice-draft approval cards on this session are now stale -
    // whatever invoice just got created (draft approval, manual panel send,
    // admin dashboard) IS the invoice. Flip them to "superseded" so the
    // provider chat never shows an actionable draft next to a live invoice.
    // The approve endpoint overwrites its own card to "approved" right after.
    // Pending COST-SHEET drafts are equally moot once an invoice exists -
    // the journey has moved past the quoting stage, and leaving them
    // unresolved keeps a stale "review cost sheet" item in the provider's
    // Home work queue forever.
    try {
      const pendingDrafts = await this.prisma.aiChatMessage.findMany({
        where: { sessionId, uiCardType: { in: ["invoice_draft_approval", "cost_sheet_draft_approval"] } },
        select: { id: true, uiCardData: true },
      });
      for (const d of pendingDrafts) {
        const dd = (d.uiCardData as any) || {};
        if (dd.resolvedAt) continue;
        await this.prisma.aiChatMessage.update({
          where: { id: d.id },
          data: {
            uiCardData: {
              ...dd,
              resolvedAt: new Date().toISOString(),
              resolvedAs: "superseded",
              resultingInvoiceId: invoice.id,
            },
          },
        });
      }
    } catch (e: any) {
      this.logger.warn(`Failed to supersede pending invoice drafts for session ${sessionId}: ${e.message}`);
    }

    // Fresh egg donors go ON HOLD the moment the parent commits ("I'm ready"
    // after the consultation -> AUTO_READINESS invoice). No hold machinery
    // like surrogates (no reservation columns) - the agency releases her
    // manually if the invoice is never paid; payment flips her to IN_CYCLE
    // (stickSubjectStatusOnPayment). Choke point: every readiness path
    // (auto-create, draft approval, match finalize) lands here.
    if (params.triggerSource === "AUTO_READINESS") {
      try {
        const sess = await this.prisma.aiChatSession.findUnique({
          where: { id: sessionId },
          select: { subjectProfileId: true, subjectType: true },
        });
        if (sess?.subjectProfileId && (sess.subjectType || "").toLowerCase().includes("egg")) {
          const held = await this.prisma.eggDonor.updateMany({
            where: { id: sess.subjectProfileId, status: "AVAILABLE" },
            data: { status: "ON_HOLD" },
          });
          if (held.count > 0) this.logger.log(`Egg donor ${sess.subjectProfileId} ON_HOLD (readiness invoice ${invoice.id})`);
        }
      } catch (e: any) {
        this.logger.warn(`Egg donor readiness hold failed for session ${sessionId}: ${e.message}`);
      }
    }

    return invoice;
  }

  /**
   * Auto-trigger path used when the parent confirms "I'm ready" after a video call.
   *
   * Returns a structured result rather than throwing so the caller can write a
   * `POST_READINESS_BLOCKED` CostSheetReminder and nudge the provider to send a
   * cost sheet, instead of swallowing an exception.
   *
   * Idempotency: skips if an open invoice (AWAITING_PAYMENT or AUTHORIZED) already
   * exists for this session.
   */
  async createInvoiceFromReadiness(sessionId: string): Promise<
    | { status: "created"; invoice: Awaited<ReturnType<BillingService["createInvoice"]>> }
    | { status: "skipped"; reason: "ALREADY_OPEN" | "NO_PROVIDER" }
    | { status: "blocked"; reason: "NO_QUOTE" | "NO_CONFIG" | "NO_DEFAULT_PAYMENT" | "BILLING_IDENTITY_INCOMPLETE"; message: string }
  > {
    const session = await this.prisma.aiChatSession.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true, providerId: true },
    });
    if (!session?.providerId) return { status: "skipped", reason: "NO_PROVIDER" };

    const openInvoice = await this.prisma.invoice.findFirst({
      where: { sessionId, status: { in: ["AWAITING_PAYMENT", "AUTHORIZED"] } },
      select: { id: true },
    });
    if (openInvoice) return { status: "skipped", reason: "ALREADY_OPEN" };

    try {
      const invoice = await this.createInvoice({
        sessionId,
        providerId: session.providerId,
        parentUserId: session.userId,
        triggerSource: "AUTO_READINESS",
      });
      return { status: "created", invoice };
    } catch (err: any) {
      return this.mapInvoiceCreationError(err);
    }
  }

  /** Shared loud-failure -> structured-blocked mapping for the readiness paths. */
  private mapInvoiceCreationError(err: any):
    { status: "blocked"; reason: "NO_QUOTE" | "NO_CONFIG" | "NO_DEFAULT_PAYMENT" | "BILLING_IDENTITY_INCOMPLETE"; message: string } {
    const message = err?.message || "Could not create invoice";
    if (/No active referral fee/.test(message)) return { status: "blocked", reason: "NO_CONFIG", message };
    // The service throws "Legal Identity is incomplete"; older callers matched
    // "Billing Identity" which never fired - keep both patterns matched.
    if (/(Legal|Billing) Identity is incomplete/.test(message)) return { status: "blocked", reason: "BILLING_IDENTITY_INCOMPLETE", message };
    if (/cost sheet/.test(message)) return { status: "blocked", reason: "NO_QUOTE", message };
    if (/Default First Payment/.test(message)) return { status: "blocked", reason: "NO_DEFAULT_PAYMENT", message };
    throw err;
  }

  // ─── Phase 3: invoice auto-draft with provider approval gate ───────────────

  /**
   * Dry-run twin of createInvoiceFromReadiness: resolves the exact amounts a
   * real invoice would carry (same validations, same loud failures mapped to
   * structured blocked results) without creating anything.
   */
  async previewInvoiceFromReadiness(sessionId: string): Promise<
    | { status: "ok"; providerId: string; parentUserId: string; preview: { parentPaysCents: number; referralFeeAmount: number; providerPayoutAmount: number; headlineServiceType: string; primaryServiceType: string; quotedTotalCostCents: number | null } }
    | { status: "skipped"; reason: "ALREADY_OPEN" | "NO_PROVIDER" }
    | { status: "blocked"; reason: "NO_QUOTE" | "NO_CONFIG" | "NO_DEFAULT_PAYMENT" | "BILLING_IDENTITY_INCOMPLETE"; message: string }
  > {
    const session = await this.prisma.aiChatSession.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true, providerId: true, subjectType: true },
    });
    if (!session?.providerId) return { status: "skipped", reason: "NO_PROVIDER" };

    const openInvoice = await this.prisma.invoice.findFirst({
      where: { sessionId, status: { in: ["AWAITING_PAYMENT", "AUTHORIZED"] } },
      select: { id: true },
    });
    if (openInvoice) return { status: "skipped", reason: "ALREADY_OPEN" };

    try {
      const preview = (await this.createInvoice({
        sessionId,
        providerId: session.providerId,
        parentUserId: session.userId,
        triggerSource: "AUTO_READINESS",
        dryRun: true,
        // Multi-service agencies: draft the service the session is actually
        // about (an egg-donor session must not draft a Surrogacy line).
        preferredServiceType: serviceTypeFromSubject(session.subjectType) ?? undefined,
      })) as any;
      return { status: "ok", providerId: session.providerId, parentUserId: session.userId, preview };
    } catch (err: any) {
      return this.mapInvoiceCreationError(err);
    }
  }

  /**
   * Phase 3 entry point, called when the parent confirms "Yes, I'm ready".
   *
   * Two-gate check (mirrors the cost-sheet auto-draft):
   *   Gate 1 - ConciergePromptSection "auto_invoice_on_ready".isActive
   *   Gate 2 - effective mode from resolveDocMode (org override -> legacy
   *   autoInvoiceDraft flag -> AutomationDefaults.invoiceAutomation):
   *   "auto_send" -> { status: "legacy" }, the caller runs the old direct
   *   createInvoiceFromReadiness path; "approval" -> draft card; "off" ->
   *   nothing fires, the provider invoices manually.
   *
   * Match-call deposits (surrogate on a hard 24h reservation window) always
   * take the legacy direct path - a provider approval gate would eat into
   * the parent's 24h decide-and-pay window.
   *
   * When both gates pass: post ONE provider-only "invoice_draft_approval"
   * card in the provider session with the resolved amounts as editable line
   * items. The provider approves (creates + sends the real invoice), edits
   * (opens the invoice panel prefilled; sending supersedes the draft), or
   * rejects it.
   */
  async tryDraftInvoiceForReadiness(
    sessionId: string,
    parentName: string,
    opts: { isMatchCall?: boolean } = {},
  ): Promise<
    | { status: "legacy" }
    | { status: "drafted"; messageId: string }
    | { status: "skipped"; reason: string }
    | { status: "blocked"; reason: "NO_QUOTE" | "NO_CONFIG" | "NO_DEFAULT_PAYMENT" | "BILLING_IDENTITY_INCOMPLETE"; message: string }
  > {
    if (opts.isMatchCall) return { status: "legacy" };

    const session = await this.prisma.aiChatSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        providerId: true,
        provider: { select: { id: true, name: true, autoFeaturesEnabled: true, users: { select: { id: true } } } },
      },
    });
    if (!session?.providerId || !session.provider) return { status: "legacy" };

    const gate1 = await this.prisma.conciergePromptSection.findUnique({
      where: { key: "auto_invoice_on_ready" },
      select: { isActive: true },
    });
    if (!gate1?.isActive) return { status: "legacy" };
    // Mode ladder: auto_send = the legacy DIRECT send (the caller runs
    // createInvoiceFromReadiness unchanged); approval = draft card; off =
    // nothing fires and the provider invoices manually from the panel.
    const defaults = await getAutomationDefaults(this.prisma);
    const mode = resolveDocMode(session.provider.autoFeaturesEnabled, "invoice", defaults);
    if (mode === "auto_send") return { status: "legacy" };
    if (mode === "off") return { status: "skipped", reason: "AUTOMATION_OFF" };

    // Idempotency: one pending draft card per session, ever.
    const existingDrafts = await this.prisma.aiChatMessage.findMany({
      where: { sessionId, uiCardType: "invoice_draft_approval" },
      select: { uiCardData: true },
    });
    if (existingDrafts.some(d => !((d.uiCardData as any) || {}).resolvedAt)) {
      return { status: "skipped", reason: "DRAFT_ALREADY_PENDING" };
    }

    const previewRes = await this.previewInvoiceFromReadiness(sessionId);
    if (previewRes.status !== "ok") return previewRes;
    const p = previewRes.preview;

    const lineItems = [
      {
        serviceType: p.primaryServiceType,
        serviceTypeLabel: humanizeLineServiceType(p.primaryServiceType),
        description: `${humanizeLineServiceType(p.primaryServiceType)} - first payment`,
        amountCents: p.parentPaysCents,
      },
    ];

    const msg = await this.prisma.aiChatMessage.create({
      data: {
        sessionId,
        role: "assistant",
        content: `${parentName} confirmed they're ready to move forward, so I drafted their first-payment invoice from the approved quote. Next step: review the amounts below - Approve sends the invoice to ${parentName} for payment, Edit opens it so you can adjust the line items first, and Reject discards the draft. Nothing is sent to ${parentName} until you approve.`,
        senderType: "system",
        senderName: "GoStork",
        uiCardType: "invoice_draft_approval",
        uiCardData: {
          parentName,
          providerId: session.providerId,
          lineItems,
          totalCents: p.parentPaysCents,
          referralFeeAmountCents: p.referralFeeAmount,
          providerPayoutAmountCents: p.providerPayoutAmount,
          quotedTotalCostCents: p.quotedTotalCostCents,
          description: null,
          autoDraftedAt: new Date().toISOString(),
          resolvedAt: null,
          resolvedAs: null,
          resultingInvoiceId: null,
        },
      },
    });

    for (const u of session.provider.users) {
      await this.prisma.inAppNotification.create({
        data: {
          userId: u.id,
          eventType: "INVOICE_DRAFT_READY",
          payload: {
            sessionId,
            messageId: msg.id,
            parentName,
            totalCents: p.parentPaysCents,
            message: `${parentName} is ready to move forward. Review and send their auto-drafted ${formatCents(p.parentPaysCents)} invoice.`,
          },
        },
      }).catch(() => {});
    }

    this.logger.log(`Invoice draft ${msg.id} posted for provider approval (session=${sessionId}, total=${formatCents(p.parentPaysCents)})`);
    return { status: "drafted", messageId: msg.id };
  }

  // ─── Phase 5: auto-draft agreement when the deposit invoice is PAID ─────────
  //
  // Gate-1: ConciergePromptSection "auto_agreement_on_paid".isActive (global
  // kill switch). Gate-2: effective per-provider mode - the provider's own
  // agreementAutomation setting overrides the GoStork-admin autoAgreementDraft
  // rollout toggle. "approval" posts a provider-only approval card;
  // "auto_send" generates AND sends for signature immediately.
  async tryDraftAgreementOnPaid(invoiceId: string): Promise<
    | { status: "off" }
    | { status: "skipped"; reason: string }
    | { status: "blocked"; reason: "NO_TEMPLATE" | "PARTNER_INFO_REQUIRED" }
    | { status: "drafted"; messageId: string }
    | { status: "sent"; agreementId: string }
  > {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        sessionId: true,
        providerId: true,
        parentUserId: true,
        parentUser: { select: { name: true, firstName: true, lastName: true, email: true } },
        provider: { select: { id: true, name: true, agreementAutomation: true, autoFeaturesEnabled: true, users: { select: { id: true } } } },
      },
    });
    // Journey stage sync: this method fires on EVERY invoice-PAID transition
    // (Stripe webhook, clearance capture, admin mark-paid) BEFORE any
    // automation gates - the one choke point for "the parent paid a deposit".
    if (invoice?.parentUserId) {
      const { advanceJourneyStage } = await import("../../../journey-stage");
      await advanceJourneyStage(invoice.parentUserId, "Deposit Paid");
    }
    if (!invoice?.sessionId || !invoice.provider) return { status: "off" };
    const sessionId = invoice.sessionId;

    const gate1 = await this.prisma.conciergePromptSection.findUnique({
      where: { key: "auto_agreement_on_paid" },
      select: { isActive: true },
    });
    if (!gate1?.isActive) return { status: "off" };
    const mode = effectiveAgreementMode(invoice.provider, await getAutomationDefaults(this.prisma));
    if (mode === "off") return { status: "off" };

    // Idempotency: one live agreement per session (any status except the
    // terminal failures), and never a second pending approval card.
    const existingAgreement = await this.prisma.agreement.findFirst({
      where: { sessionId, status: { notIn: ["REJECTED", "EXPIRED", "ERROR"] } },
      select: { id: true },
    });
    if (existingAgreement) return { status: "skipped", reason: "AGREEMENT_EXISTS" };
    const existingCards = await this.prisma.aiChatMessage.findMany({
      where: { sessionId, uiCardType: "agreement_draft_approval" },
      select: { uiCardData: true },
    });
    if (existingCards.some(c => !((c.uiCardData as any) || {}).resolvedAt)) {
      return { status: "skipped", reason: "DRAFT_ALREADY_PENDING" };
    }

    const parentName =
      invoice.parentUser?.firstName ||
      invoice.parentUser?.name ||
      invoice.parentUser?.email ||
      "The parent";

    // Template must exist BEFORE we announce anything. Missing template =
    // loud provider-only nudge, never a fabricated document.
    const serviceType = await agreementServiceTypeForSession(sessionId);
    const tpl = await resolveAgreementTemplate(invoice.provider.id, serviceType);
    if (!tpl.agreementTemplateUrl || !tpl.pandaDocTemplateId) {
      const alreadyNudged = await this.prisma.aiChatMessage.findFirst({
        where: { sessionId, uiCardType: "provider_only", content: { contains: "agreement template" } },
        select: { id: true },
      });
      if (!alreadyNudged) {
        const docTitle = agreementDocumentType(serviceType).toLowerCase();
        await this.prisma.aiChatMessage.create({
          data: {
            sessionId,
            role: "assistant",
            content: `${parentName} completed their payment, but I couldn't draft the ${docTitle} because no agreement template is configured${serviceType ? ` for ${humanizeLineServiceType(serviceType)}` : ""}. Upload your template and assign signature fields in Settings > Documents, then send the agreement from the + menu here.`,
            senderType: "system",
            senderName: "GoStork",
            uiCardType: "provider_only",
          },
        });
      }
      this.logger.warn(`Agreement auto-draft blocked for session ${sessionId}: no template (serviceType=${serviceType})`);
      return { status: "blocked", reason: "NO_TEMPLATE" };
    }

    const docTitle = agreementDocumentType(serviceType);

    if (mode === "auto_send") {
      try {
        const agreement = await generateAndAnnounceAgreement({
          sessionId,
          providerId: invoice.provider.id,
          trigger: "auto",
        });
        for (const u of invoice.provider.users) {
          await this.prisma.inAppNotification.create({
            data: {
              userId: u.id,
              eventType: "AGREEMENT_AUTO_SENT",
              payload: {
                sessionId,
                agreementId: agreement.id,
                parentName,
                message: `${parentName}'s payment cleared - their ${docTitle} was generated and sent for signature automatically.`,
              },
            },
          }).catch(() => {});
        }
        this.logger.log(`Agreement ${agreement.id} auto-sent on PAID (session=${sessionId})`);
        return { status: "sent", agreementId: agreement.id };
      } catch (e: any) {
        if (e?.code !== "PARTNER_INFO_REQUIRED") throw e;
        // Fully-automated send needs the partner's signer details. The
        // PARENT is the one who knows them - ask right in the chat (a
        // partner_info_request card with a "just me" escape hatch) and
        // auto-send the moment they answer. Falling back to the provider
        // approval card here would break the "fully automated" promise.
        const existingPartnerCards = await this.prisma.aiChatMessage.findMany({
          where: { sessionId, uiCardType: "partner_info_request" },
          select: { uiCardData: true },
        });
        if (!existingPartnerCards.some(c => !((c.uiCardData as any) || {}).resolvedAt)) {
          const msg = await this.prisma.aiChatMessage.create({
            data: {
              sessionId,
              role: "assistant",
              content: `One last step before I can send your ${docTitle} for signature: it includes both parents as signers. Add your partner's details below - or tap "It's just me" and I'll send it with you as the only signer.`,
              senderType: "system",
              senderName: "GoStork",
              uiCardType: "partner_info_request",
              uiCardData: {
                providerId: invoice.provider.id,
                serviceType,
                documentType: docTitle,
                invoiceId,
                requestedAt: new Date().toISOString(),
                providerContent: `${parentName}'s ${docTitle} is drafted and will send automatically - waiting on their partner's signer details (or single-parent confirmation).`,
              },
            },
          });
          this.logger.log(`Agreement auto-send needs partner info (session=${sessionId}) - asked the parent (message ${msg.id})`);
          return { status: "blocked", reason: "PARTNER_INFO_REQUIRED" };
        }
        this.logger.log(`Agreement auto-send still waiting on partner info (session=${sessionId}) - card already pending`);
        return { status: "blocked", reason: "PARTNER_INFO_REQUIRED" };
      }
    }

    const msg = await this.prisma.aiChatMessage.create({
      data: {
        sessionId,
        role: "assistant",
        content: `${parentName} completed their payment, so I drafted their ${docTitle} from your configured template. Next step: review it below - Approve sends the document to ${parentName} for signature, and Reject discards the draft (you can always send one manually from the + menu). Nothing is sent to ${parentName} until you approve.`,
        senderType: "system",
        senderName: "GoStork",
        uiCardType: "agreement_draft_approval",
        uiCardData: {
          parentName,
          providerId: invoice.provider.id,
          serviceType,
          documentType: docTitle,
          invoiceId: invoice.id,
          autoDraftedAt: new Date().toISOString(),
          resolvedAt: null,
          resolvedAs: null,
          resultingAgreementId: null,
        },
      },
    });
    for (const u of invoice.provider.users) {
      await this.prisma.inAppNotification.create({
        data: {
          userId: u.id,
          eventType: "AGREEMENT_DRAFT_READY",
          payload: {
            sessionId,
            messageId: msg.id,
            parentName,
            message: `${parentName}'s payment cleared. Review and send their ${docTitle} for signature.`,
          },
        },
      }).catch(() => {});
    }
    this.logger.log(`Agreement draft ${msg.id} posted for provider approval (session=${sessionId})`);
    return { status: "drafted", messageId: msg.id };
  }

  // ─── Send payment notifications to parent ──────────────────────────────────

  async sendPaymentNotificationsToParent(invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        parentUser: true,
        lineItems: { orderBy: { displayOrder: "asc" } },
      },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");

    void emitInvoiceJourneyEvent(invoiceId, "INVOICE_SENT");

    // Sending an invoice opens Gate B for this pair: the parent is now
    // transacting with this provider, GoStork has earned the relationship, and
    // the invoice itself carries their name. Idempotent, so replays are free.
    void (async () => {
      const accountKey = parentAccountKey(invoice.parentUser as any);
      await releaseParentContact({ providerId: invoice.providerId, parentAccountId: accountKey, reason: "INVOICE" });
      void emitJourneyEvent({
        eventType: "CONTACT_RELEASED",
        parentAccountId: accountKey,
        providerId: invoice.providerId,
        actorRole: "provider",
        metadata: { reason: "INVOICE", invoiceId },
      });
    })();

    const base = getBaseUrl();
    // Include the chat session in returnTo so post-payment redirects the
    // parent back to the exact conversation, not the generic /chat landing.
    // The success page validates the returnTo is a same-origin path.
    const paymentUrl = `${base}/pay/${invoice.paymentToken}?returnTo=${encodeURIComponent(`/chat/${invoice.sessionId}`)}`;
    const parentName = invoice.parentUser.name || invoice.parentUser.firstName || "there";

    // Itemized rows for both the chat card payload and the email body.
    const lineItems = (invoice as any).lineItems || [];
    const lineItemsForCard = lineItems.map((li: any) => ({
      id: li.id,
      serviceType: li.serviceType,
      serviceTypeLabel: humanizeLineServiceType(li.serviceType),
      description: li.description,
      amountCents: li.amountCents,
    }));

    // 1. Post in-chat invoice card (primary delivery channel)
    await this.prisma.aiChatMessage.create({
      data: {
        sessionId: invoice.sessionId,
        role: "assistant",
        content: `${invoice.providerName} sent an invoice. Total: ${formatCents(invoice.serviceAmount)}`,
        senderType: "system",
        senderName: invoice.providerName || "Provider",
        uiCardType: "invoice",
        uiCardData: {
          invoiceId: invoice.id,
          paymentToken: invoice.paymentToken,
          paymentUrl,
          providerName: invoice.providerName,
          serviceType: humanizeLineServiceType(invoice.serviceType),
          serviceAmount: invoice.serviceAmount,
          referralFeeAmount: invoice.referralFeeAmount,
          providerPayoutAmount: invoice.providerPayoutAmount,
          currency: invoice.currency,
          status: invoice.status,
          isProtected: invoice.isProtected,
          dueAt: invoice.dueAt?.toISOString() || null,
          description: invoice.description,
          lineItems: lineItemsForCard,
        },
      },
    });

    // 2. Email + SMS via notification service
    await this.notificationService.sendPaymentRequestNotification({
      parentUserId: invoice.parentUserId,
      parentName,
      parentEmail: invoice.parentUser.email,
      parentPhone: invoice.parentUser.mobileNumber,
      providerName: invoice.providerName,
      serviceType: humanizeLineServiceType(invoice.serviceType),
      serviceAmountFormatted: formatCents(invoice.serviceAmount),
      referralFeeFormatted: formatCents(invoice.referralFeeAmount),
      paymentUrl,
      invoiceId: invoice.id,
      sessionId: invoice.sessionId,
      dueAt: invoice.dueAt || null,
      description: invoice.description || null,
      lineItems: lineItemsForCard.map((li: any) => ({
        label: li.serviceTypeLabel,
        description: li.description,
        amountFormatted: formatCents(li.amountCents),
      })),
    });

    // Track that initial notification was sent
    await this.prisma.invoiceReminder.create({
      data: { invoiceId: invoice.id, channel: "chat", reminderType: "initial" },
    });

    return invoice;
  }

  // ─── Bank skip-to-checkout (Phase 6) ────────────────────────────────────────

  /**
   * Egg/Sperm Bank donors are ready inventory - no match calls, no
   * agreements. When a parent hits "Buy" (marketplace card CTA or Eva's
   * bank_checkout chat card) this does the whole dance in one shot:
   * find-or-create the 3-way session with the bank (identity revealed -
   * the purchase IS the consent moment, same rationale as consultation
   * booking), post the bank's cost sheet as a quote card, auto-fire the
   * invoice from the donor's published Total Cost, and send the parent
   * the Pay Now link. No bank staff action required.
   *
   * Loud failures by design: no published donor price, missing referral
   * fee config, or incomplete provider legal identity all throw - never
   * fabricate a price.
   */
  async bankCheckout(params: {
    parentUserId: string;
    donorId: string;
    donorType: "egg-donor" | "sperm-donor";
    providerId: string;
  }): Promise<{ status: "created" | "already_pending" | "already_paid"; sessionId: string; invoiceId: string }> {
    const { parentUserId, donorId, donorType, providerId } = params;
    const bankTypeName = donorType === "egg-donor" ? "Egg Bank" : "Sperm Bank";
    const serviceType = donorType === "egg-donor" ? "EGG_DONATION" : "SPERM_DONATION";

    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
      select: { id: true, name: true, services: { where: { status: "APPROVED" }, include: { providerType: true } } },
    });
    if (!provider) throw new NotFoundException("Provider not found");
    if (!provider.services.some((sv: any) => sv.providerType?.name === bankTypeName)) {
      throw new BadRequestException(`Skip-to-checkout is only available for ${bankTypeName} donors - agency donors go through the match process.`);
    }

    const donor: any = donorType === "egg-donor"
      ? await this.prisma.eggDonor.findUnique({ where: { id: donorId }, select: { id: true, firstName: true, externalId: true, totalCost: true, photos: true, providerId: true } })
      : await this.prisma.spermDonor.findUnique({ where: { id: donorId }, select: { id: true, firstName: true, externalId: true, totalCost: true, photos: true, providerId: true } });
    if (!donor || donor.providerId !== providerId) throw new NotFoundException("Donor not found at this provider");

    // Donor totalCost is stored in DOLLARS (see total-cost.utils) - invoices are cents.
    const priceCents = donor.totalCost != null ? Math.round(Number(donor.totalCost) * 100) : null;
    if (!priceCents || priceCents <= 0) {
      throw new BadRequestException("This donor has no published total cost yet. The bank needs an approved cost sheet before checkout is possible.");
    }
    const donorLabel = [donor.firstName, donor.externalId ? `#${donor.externalId}` : null].filter(Boolean).join(" ") || "this donor";

    const parentUser = await this.prisma.user.findUnique({
      where: { id: parentUserId },
      select: { id: true, name: true, firstName: true, parentAccountId: true },
    });
    if (!parentUser) throw new NotFoundException("Parent not found");
    const parentName = parentUser.firstName || parentUser.name || "The parent";
    const accountIds = parentUser.parentAccountId
      ? (await this.prisma.user.findMany({ where: { parentAccountId: parentUser.parentAccountId }, select: { id: true } })).map(u => u.id)
      : [parentUserId];

    // Find-or-create the 3-way session for THIS donor. CONSULTATION_BOOKED
    // is the identity-reveal status the rest of the app already honors, and
    // promoting an ACTIVE subject thread to it is the designed lifecycle.
    //
    // But this lookup keys on providerId + subjectProfileId, and those are
    // EXACTLY the two fields that get stamped onto the parent's private Eva
    // thread: providerId by a whisper, subjectProfileId by opening a donor
    // from the marketplace. Whisper an agency, then browse their donor, and
    // Eva matches - at which point checkout would post a cost sheet and an
    // invoice into the private thread AND rewrite its status to
    // CONSULTATION_BOOKED, permanently converting a private conversation into
    // a shared one and back-exposing the entire transcript to the provider.
    //
    // So the family's Eva thread is excluded by id. A subject thread is still
    // promoted in place; the private one is never touched.
    const evaSessionId = await resolveParentEvaSessionId(accountIds, this.prisma);
    let session = await this.prisma.aiChatSession.findFirst({
      where: {
        userId: { in: accountIds },
        providerId,
        subjectProfileId: donorId,
        ...(evaSessionId ? { id: { not: evaSessionId } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (session) {
      await this.prisma.aiChatSession.update({
        where: { id: session.id },
        data: { status: "CONSULTATION_BOOKED", updatedAt: new Date() },
      });
    } else {
      const created = await this.prisma.aiChatSession.create({
        data: {
          userId: parentUserId,
          providerId,
          providerName: provider.name,
          status: "CONSULTATION_BOOKED",
          title: `${donorLabel} - ${provider.name}`,
          profilePhotoUrl: donor.photos?.[0] || undefined,
          subjectProfileId: donorId,
          subjectType: donorType,
        },
        select: { id: true },
      });
      session = created;
    }

    // Idempotency: one live purchase per donor session.
    const existing = await this.prisma.invoice.findFirst({
      where: { sessionId: session.id, status: { in: ["AWAITING_PAYMENT", "AUTHORIZED", "AT_CLEARANCE", "PAID"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });
    if (existing) {
      return {
        status: existing.status === "PAID" ? "already_paid" : "already_pending",
        sessionId: session.id,
        invoiceId: existing.id,
      };
    }

    // Dual-audience kickoff message (parent reads 2nd person; provider reads
    // the providerContent variant automatically).
    await this.prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: `You're all set! Here's the full cost breakdown and your invoice for ${donorLabel} from ${provider.name}. Once payment is complete, ${provider.name} will coordinate the next steps with you right here.`,
        senderType: "system",
        senderName: "GoStork",
        uiCardData: {
          providerContent: `${parentName} started checkout for ${donorLabel}. The cost sheet and invoice were sent automatically - payment confirmation will appear here.`,
        },
      },
    });

    // Snapshot the bank's installment plan, same as every other send path.
    const paymentScheduleSnapshot = await resolveQuotePaymentSchedule(this.prisma, providerId, {
      sessionId: session.id,
    });

    // Post the bank's price as a quote + cost-sheet card (supersede priors).
    const quote = await this.prisma.$transaction(async (tx: any) => {
      await tx.providerQuote.updateMany({
        where: { sessionId: session!.id, supersededAt: null },
        data: { supersededAt: new Date() },
      });
      return tx.providerQuote.create({
        data: {
          sessionId: session!.id,
          providerId,
          parentUserId,
          totalCostCents: priceCents,
          notes: `${donorLabel} - ${bankTypeName} package (published total cost)`,
          source: "BANK_CHECKOUT",
          serviceType: await serviceTypeOfSession(session!.id),
          paymentSchedule: (paymentScheduleSnapshot ?? undefined) as any,
        },
      });
    });
    await this.prisma.aiChatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: `${provider.name} sent you a cost sheet. Total: ${formatMoneyCents(priceCents)}${
          paymentScheduleSnapshot ? ". It includes a payment schedule so you can see what is due and when." : ""
        }`,
        senderType: "system",
        senderName: provider.name,
        uiCardType: "cost_sheet",
        uiCardData: {
          quoteId: quote.id,
          providerName: provider.name,
          totalCostCents: priceCents,
          notes: quote.notes,
          parentAcknowledgedAt: null,
          sentAt: quote.createdAt.toISOString(),
          paymentSchedule: paymentScheduleSnapshot ?? null,
          providerContent: `A cost sheet was sent automatically. Total: ${formatMoneyCents(priceCents)}${
            paymentScheduleSnapshot
              ? `, with a ${paymentScheduleSnapshot.tranches.length}-payment schedule attached.`
              : "."
          }`,
        },
      },
    });

    void emitJourneyEvent({ eventType: "COST_SHEET_SHARED", parentUserId, providerId, sessionId: session.id, actorRole: "system", metadata: { quoteId: quote.id, bank: true } });

    const invoice = await this.createInvoice({
      sessionId: session.id,
      providerId,
      parentUserId,
      triggerSource: "BANK_CHECKOUT",
      description: `${donorLabel} - ${bankTypeName} package`,
      lineItems: [{ serviceType, description: `${donorLabel} - ${bankTypeName} package (published total cost)`, amountCents: priceCents }],
      preferredServiceType: serviceType,
    });
    void emitJourneyEvent({ eventType: "BANK_CHECKOUT_STARTED", parentUserId, providerId, sessionId: session.id, actorRole: "parent", metadata: { invoiceId: invoice.id, priceCents } });
    await this.sendPaymentNotificationsToParent(invoice.id);

    // Heads-up to the bank's users.
    const providerUsers = await this.prisma.user.findMany({ where: { providerId }, select: { id: true } });
    for (const pu of providerUsers) {
      await this.prisma.inAppNotification.create({
        data: {
          userId: pu.id,
          eventType: "BANK_CHECKOUT_STARTED",
          payload: {
            sessionId: session.id,
            parentName,
            donorLabel,
            message: `${parentName} started checkout for ${donorLabel} - invoice sent automatically.`,
          },
        },
      }).catch(() => {});
    }

    this.logger.log(`[bank-checkout] ${parentName} -> ${donorLabel} @ ${provider.name}: invoice ${invoice.id} (${priceCents} cents)`);
    return { status: "created", sessionId: session.id, invoiceId: invoice.id };
  }

  // ─── Cancel an invoice (provider/admin) ────────────────────────────────────

  /**
   * Cancel an AWAITING_PAYMENT invoice. Used when a provider needs to retract
   * an invoice they sent (mistake, change in scope, parent asked for a revision).
   * Flips Invoice.status to "CANCELLED", flips the in-chat card's
   * uiCardData.status so the Pay button disappears and the badge updates, and
   * posts a short system note. No Stripe refund logic - the invoice never
   * captured funds (status must be AWAITING_PAYMENT). For PAID/AUTHORIZED
   * invoices, admins use the refund flow instead.
   */
  async cancelInvoice(invoiceId: string, actorLabel?: string) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.status !== "AWAITING_PAYMENT") {
      throw new BadRequestException(
        `Only pending invoices can be cancelled (current status: ${invoice.status}).`,
      );
    }

    const updated = await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: "CANCELLED" },
    });

    // Flip the in-chat card's status so the parent's Pay button disappears and
    // the badge reads "Cancelled" on both sides.
    try {
      const existingCardMsg = await this.prisma.aiChatMessage.findFirst({
        where: {
          sessionId: invoice.sessionId,
          uiCardType: "invoice",
          uiCardData: { path: ["invoiceId"], equals: invoice.id },
        },
        select: { id: true, uiCardData: true },
      });
      if (existingCardMsg) {
        const updatedData = {
          ...((existingCardMsg.uiCardData as any) || {}),
          status: "CANCELLED",
        };
        await this.prisma.aiChatMessage.update({
          where: { id: existingCardMsg.id },
          data: { uiCardData: updatedData },
        });
      }
    } catch (e: any) {
      this.logger.warn(`Failed to update invoice card status to CANCELLED: ${e?.message}`);
    }

    // Short system note so the thread shows the cancellation explicitly.
    try {
      await this.prisma.aiChatMessage.create({
        data: {
          sessionId: invoice.sessionId,
          role: "assistant",
          content: `${actorLabel || invoice.providerName} cancelled this invoice (${formatCents(invoice.serviceAmount)}).`,
          senderType: "system",
          senderName: invoice.providerName || "Provider",
        },
      });
    } catch (e: any) {
      this.logger.warn(`Failed to post invoice cancellation message: ${e?.message}`);
    }

    return updated;
  }

  // ─── Post readiness prompt in chat after video call ends ────────────────────

  async postReadinessPromptToChat(params: {
    sessionId: string;
    bookingId: string;    // used for per-booking dedup
    providerName: string;
    providerType: string;
    isMatchCall: boolean; // true for surrogacy match calls
    dueAt?: Date;         // for surrogacy 24h countdown
    /** e.g. "Surrogate #00070" - names the match-call subject in the copy. */
    subjectLabel?: string | null;
    /** When the 24h hold on the surrogate releases (match calls only). */
    holdUntil?: Date | null;
  }) {
    const { sessionId, bookingId, providerName, providerType, isMatchCall, dueAt, subjectLabel, holdUntil } = params;

    let content = "";
    let buttonLabel = "Yes, I'm Ready";

    // Match call branch FIRST - a multi-service agency (e.g. surrogacy +
    // egg donation) resolves to its dominant providerType, so keying the
    // match-call copy off providerType alone misses it.
    if (isMatchCall) {
      const who = subjectLabel || "your surrogate match";
      // Parent-facing prompt - show the deadline in the parent's (booker's) zone.
      const rpBooking = await this.prisma.booking.findUnique({ where: { id: bookingId }, select: { bookerTimezone: true } }).catch(() => null);
      const deadline = (holdUntil || dueAt)
        ? formatWhen((holdUntil || dueAt)!, rpBooking?.bookerTimezone)
        : "the next 24 hours";
      content = `That was a big moment - you just finished your match call with ${who}! Take a breath, talk it over together, and know that we're here for any questions. Everything about her - the prep guide, cost sheets, and updates - lives in your chat with ${providerName}; this space is just between us.

One important thing: ${who} is now on hold exclusively for you until ${deadline}. If you'd like to move forward, let us know within that window - once it passes, the hold is released and she may be matched with another family. So, how are you feeling? Ready to move forward with her?`;
      buttonLabel = "Yes, I'm Ready";
    } else if (providerType === "IVF Clinic") {
      content = `How did your consultation with ${providerName} go? Are you ready to move forward and begin your fertility treatment?`;
    } else if (providerType === "Egg Donor Agency" || providerType === "Egg Bank") {
      content = `How did your consultation with ${providerName} go? Are you ready to move forward and begin the matching process?`;
    } else if (providerType === "Sperm Bank") {
      content = `How did your consultation with ${providerName} go? Are you ready to move forward with your selected donor?`;
    } else {
      content = `How did your session with ${providerName} go? Are you ready to move forward?`;
    }

    await this.prisma.aiChatMessage.create({
      data: {
        sessionId,
        role: "assistant",
        content,
        senderType: "system",
        senderName: "GoStork",
        uiCardType: "readiness_prompt",
        uiCardData: {
          bookingId,
          providerName,
          providerType,
          isMatchCall,
          dueAt: dueAt?.toISOString() || null,
          buttonLabel,
          yesAction: "CONFIRM_READY",
          noAction: "NOT_YET",
        },
      },
    });
  }

  // ─── Schedule surrogacy 24h countdown reminders ─────────────────────────────

  scheduleCountdownReminders(invoiceId: string, dueAt: Date) {
    const now = Date.now();
    const due = dueAt.getTime();
    const reminders: { label: string; fireAt: number; reminderType: string }[] = [
      { label: "12h remaining", fireAt: due - 12 * 60 * 60 * 1000, reminderType: "12h_remaining" },
      { label: "4h remaining",  fireAt: due - 4  * 60 * 60 * 1000, reminderType: "4h_remaining"  },
      { label: "1h remaining",  fireAt: due - 1  * 60 * 60 * 1000, reminderType: "1h_remaining"  },
      { label: "expired",       fireAt: due,                        reminderType: "expired"        },
    ];

    for (const r of reminders) {
      const delay = r.fireAt - now;
      if (delay > 0) {
        setTimeout(() => this.sendCountdownReminder(invoiceId, r.reminderType), delay);
        this.logger.log(`Scheduled ${r.label} reminder for invoice ${invoiceId} in ${Math.round(delay / 60000)}m`);
      }
    }
  }

  private async sendCountdownReminder(invoiceId: string, reminderType: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { parentUser: true },
    });
    if (!invoice || invoice.status !== "AWAITING_PAYMENT") return;

    const base = getBaseUrl();
    // Include the chat session in returnTo so post-payment lands back in
    // the right chat thread (see sendInvoiceNotifications for the same).
    const paymentUrl = `${base}/pay/${invoice.paymentToken}?returnTo=${encodeURIComponent(`/chat/${invoice.sessionId}`)}`;
    let content = "";

    if (reminderType === "12h_remaining") {
      content = `Reminder: You have 12 hours left to secure your surrogate match with ${invoice.providerName}. Don't miss your window!`;
    } else if (reminderType === "4h_remaining") {
      content = `Urgent: Only 4 hours left to reserve your surrogate match with ${invoice.providerName}.`;
    } else if (reminderType === "1h_remaining") {
      content = `Last chance: 1 hour remaining to secure your match with ${invoice.providerName}.`;
    } else if (reminderType === "expired") {
      content = `Your 24-hour hold has expired. The surrogate from ${invoice.providerName} is now available to other families. Please contact GoStork if you would like to explore other matches.`;
      // Mark invoice expired
      await this.prisma.invoice.update({ where: { id: invoiceId }, data: { status: "EXPIRED" } });
    }

    if (content) {
      await this.prisma.aiChatMessage.create({
        data: {
          sessionId: invoice.sessionId,
          role: "assistant",
          content,
          senderType: "system",
          senderName: "GoStork",
          uiCardType: reminderType === "expired" ? "text" : "invoice",
          uiCardData: reminderType !== "expired" ? asJson({
            invoiceId: invoice.id,
            paymentToken: invoice.paymentToken,
            paymentUrl,
            status: invoice.status,
            dueAt: invoice.dueAt?.toISOString() || null,
          }) : Prisma.DbNull,
        },
      });

      await this.prisma.invoiceReminder.create({
        data: { invoiceId, channel: "chat", reminderType },
      });

      // Also send email/SMS for urgent reminders
      if (["4h_remaining", "1h_remaining", "expired"].includes(reminderType)) {
        await this.notificationService.sendInvoiceReminderNotification({
          parentUserId: invoice.parentUserId,
          parentEmail: invoice.parentUser.email,
          parentPhone: invoice.parentUser.mobileNumber,
          providerName: invoice.providerName,
          paymentUrl,
          reminderType,
          invoiceId,
        });
      }
    }
  }

  // ─── Schedule follow-up reminders (for non-surrogacy readiness prompts) ─────

  scheduleFollowUpReminders(params: {
    sessionId: string;
    providerName: string;
    providerType: string;
  }) {
    const delays = [
      { hours: 24,  reminderType: "followup_24h" },
      { hours: 48,  reminderType: "followup_48h" },
      { hours: 72,  reminderType: "followup_72h" },
    ];

    for (const d of delays) {
      setTimeout(async () => {
        // Check if session already has a paid invoice - if so skip
        const paid = await this.prisma.invoice.findFirst({
          where: { sessionId: params.sessionId, status: "PAID" },
        });
        if (paid) return;

        // Also check if readiness prompt was already answered positively
        // (invoice in any non-expired state means parent responded)
        const activeInvoice = await this.prisma.invoice.findFirst({
          where: { sessionId: params.sessionId, status: { not: "EXPIRED" } },
        });
        if (activeInvoice) return;

        await this.prisma.aiChatMessage.create({
          data: {
            sessionId: params.sessionId,
            role: "assistant",
            content: `Just following up - are you ready to move forward with ${params.providerName}? We're here to help whenever you're ready.`,
            senderType: "system",
            senderName: "GoStork",
            uiCardType: "readiness_prompt",
            uiCardData: {
              providerName: params.providerName,
              providerType: params.providerType,
              isMatchCall: false,
              dueAt: null,
              buttonLabel: "Yes, I'm Ready",
              yesAction: "CONFIRM_READY",
              noAction: "NOT_YET",
            },
          },
        });
      }, d.hours * 60 * 60 * 1000);
    }
  }

  // ─── Stripe authorization / capture / void (AT_CLEARANCE flow) ───────────
  //
  // NOTE: clearance check-in reminders are NOT scheduled here. They run from
  // runClearanceCheckinSweep (clearance.sweep.ts) on the shared 10-minute
  // scheduler - durable across restarts and cross-process safe, unlike the
  // old setTimeout-based follow-ups this replaced.

  // Everything that happens the moment escrow protection lands: sticks the
  // surrogate hold (funds are committed, the expiry sweeps must not release
  // her during screening) and posts the vault tracker card in the shared
  // chat. Two entry shapes:
  //   "hold"  - the authorized webhook placed a card hold (failure = the
  //             hold is instantly canceled, nothing was charged)
  //   "vault" - funds were captured directly into GoStork's balance (wire
  //             payment; failure = full refund)
  // Check-in cadence comes from the clearance sweep.
  private async onEscrowAuthorized(invoiceId: string, variant: "hold" | "vault" = "hold") {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        parentUser: { select: { firstName: true, name: true } },
      },
    });
    if (!invoice?.sessionId) return;

    await this.stickSurrogateHoldOnPayment(invoiceId);

    const parentName = invoice.parentUser?.firstName || invoice.parentUser?.name || "The parent";
    const failureClause = variant === "hold"
      ? "If clearance fails, your hold is instantly canceled at no cost."
      : "If clearance fails, you receive a full refund.";
    await this.prisma.aiChatMessage.create({
      data: {
        sessionId: invoice.sessionId,
        role: "assistant",
        content: `Your funds are now securely held in GoStork's vault. We will release them to ${invoice.providerName} once the surrogate passes her medical clearance. ${failureClause} Your match is protected by the GoStork Guarantee.`,
        senderType: "system",
        senderName: "GoStork",
        uiCardType: "clearance_tracker",
        uiCardData: {
          invoiceId: invoice.id,
          providerName: invoice.providerName,
          parentName,
          medicalClearanceStatus: "PENDING",
          isProtected: true,
          confirmAction: "CONFIRM_CLEARANCE",
          failAction: "REPORT_CLEARANCE_FAILURE",
          providerContent: `${parentName}'s deposit of ${formatCents(invoice.serviceAmount)} is ${variant === "hold" ? "authorized and held" : "secured"} in GoStork's vault. It will be released to you as soon as medical clearance is confirmed - you can confirm the screening outcome right on this card.`,
        },
      },
    });

    this.logger.log(`Invoice ${invoiceId} escrow ${variant} secured - tracker card posted (check-ins run from clearance sweep)`);
  }

  // ─── Hybrid escrow: day-6 hold -> vault conversion ────────────────────────
  //
  // A plain card authorization expires after ~7 days, but medical clearance
  // averages ~21. The hybrid flow keeps the fee-free hold for fast
  // clearances, and on day 6 - one day before Stripe would silently expire
  // the hold - captures the funds INTO GoStork's vault: the invoice becomes
  // PAID while medicalClearanceStatus stays PENDING, and the
  // CLEARANCE_PENDING gate in ConnectService keeps every cent away from the
  // provider until clearance is confirmed. Runs from the shared 10-minute
  // scheduler on both hosts; the AUTHORIZED->PAID updateMany claim decides
  // which host runs the side effects.
  private static readonly ESCROW_CONVERT_AFTER_MS = 6 * 24 * 60 * 60 * 1000;

  async runEscrowConversionSweep(): Promise<void> {
    const cutoff = new Date(Date.now() - BillingService.ESCROW_CONVERT_AFTER_MS);
    const holds = await this.prisma.invoice.findMany({
      where: {
        status: "AUTHORIZED",
        medicalClearanceStatus: "PENDING",
        authorizedAt: { not: null, lte: cutoff },
      },
      select: { id: true },
    });
    for (const h of holds) {
      try {
        await this.convertEscrowHoldToVault(h.id);
      } catch (e: any) {
        this.logger.error(`Escrow vault conversion failed for invoice ${h.id}: ${e?.message}`);
      }
    }
  }

  private async convertEscrowHoldToVault(invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { parentUser: { select: { firstName: true, name: true } } },
    });
    if (!invoice?.stripePaymentIntentId) return;
    if (invoice.status !== "AUTHORIZED" || invoice.medicalClearanceStatus !== "PENDING") return;

    // Capture the hold. "already captured" means confirm-clearance or the
    // other host's sweep won a race - fall through to the DB claim, which
    // decides who runs the side effects. A canceled/expired PI means the
    // hold lapsed (e.g. this sweep was down past day 7) - reopen the
    // invoice for payment instead of pretending funds exist.
    let transactionId = invoice.stripePaymentIntentId;
    try {
      const captured = await capturePaymentIntent(invoice.stripePaymentIntentId);
      transactionId = captured.transactionId;
    } catch (e: any) {
      const msg = e?.message || "";
      if (/already been captured|already captured/i.test(msg)) {
        // fall through to the claim
      } else if (/status of canceled|status of cancelled|expired/i.test(msg)) {
        await this.handleLapsedEscrowHold(invoice.id, msg);
        return;
      } else {
        throw e; // transient (network, Stripe 5xx) - stay AUTHORIZED, next tick retries
      }
    }

    // Cross-process claim: exactly one host flips AUTHORIZED -> PAID.
    const claimed = await this.prisma.invoice.updateMany({
      where: { id: invoiceId, status: "AUTHORIZED" },
      data: {
        status: "PAID",
        paidAt: new Date(),
        capturedAt: new Date(),
        stripeTransactionId: transactionId,
        // medicalClearanceStatus stays PENDING - that IS the vault state.
      },
    });
    if (claimed.count === 0) return;

    this.logger.log(`Invoice ${invoiceId} escrow hold converted to vault - captured, clearance still pending`);
    void emitInvoiceJourneyEvent(invoiceId, "INVOICE_PAID", { path: "escrow_vault_conversion" });

    // Dual-audience conversion notice. The tracker card stays PENDING - only
    // the vault's backing changed (hold -> captured funds), not its state.
    try {
      const parentName = invoice.parentUser?.firstName || invoice.parentUser?.name || "The parent";
      const amount = formatCents(invoice.serviceAmount, invoice.currency);
      await this.prisma.aiChatMessage.create({
        data: {
          sessionId: invoice.sessionId,
          role: "assistant",
          content: `A quick update on your protected deposit: card holds expire after 7 days, so to keep your funds secured while medical screening continues, we've completed the charge of ${amount}. The full amount now sits in GoStork's vault - nothing is released to ${invoice.providerName} until clearance is confirmed, and if clearance fails you'll receive a full refund.`,
          senderType: "system",
          senderName: "GoStork",
          uiCardType: "text",
          uiCardData: {
            providerContent: `${parentName}'s deposit of ${amount} has moved from a card hold into GoStork's vault while screening continues. It will be released to you the moment medical clearance is confirmed.`,
          },
        },
      });
    } catch (e: any) {
      this.logger.warn(`Failed to post vault conversion message for ${invoiceId}: ${e?.message}`);
    }

    // Receipt + admin heads-up + agreement automation (journey stage
    // "Deposit Paid"). The provider transfer is deliberately NOT fired here,
    // and any indirect caller is blocked by the CLEARANCE_PENDING gate.
    await this.emitPaymentReceipt(invoiceId).catch(e =>
      this.logger.warn(`Receipt emission failed for ${invoiceId} (vault conversion): ${e?.message}`),
    );
    await this.notifyAdminInvoicePaid(invoiceId).catch(() => {});
    await this.tryDraftAgreementOnPaid(invoiceId).catch(e =>
      this.logger.warn(`Agreement auto-draft failed for ${invoiceId} (vault conversion): ${e?.message}`),
    );
  }

  // The hold expired before we could convert it (sweep down past day 7, or
  // an issuer that voids early). Reopen the invoice so the parent can pay
  // again - loudly, to parent, provider, and admins. The surrogate stays
  // reserved; the donor-hold sweep polices the now-overdue invoice.
  private async handleLapsedEscrowHold(invoiceId: string, stripeMsg: string) {
    const reopened = await this.prisma.invoice.updateMany({
      where: { id: invoiceId, status: "AUTHORIZED" },
      data: { status: "AWAITING_PAYMENT", authorizedAt: null },
    });
    if (reopened.count === 0) return;
    this.logger.error(`Escrow hold LAPSED for invoice ${invoiceId} (${stripeMsg}) - reopened for payment`);

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { parentUser: { select: { firstName: true, name: true } } },
    });
    if (!invoice) return;
    const parentName = invoice.parentUser?.firstName || invoice.parentUser?.name || "The parent";

    // Flip the chat invoice card back to payable.
    try {
      const cardMsg = await this.prisma.aiChatMessage.findFirst({
        where: { sessionId: invoice.sessionId, uiCardType: "invoice", uiCardData: { path: ["invoiceId"], equals: invoice.id } },
        select: { id: true, uiCardData: true },
      });
      if (cardMsg) {
        await this.prisma.aiChatMessage.update({
          where: { id: cardMsg.id },
          data: { uiCardData: { ...((cardMsg.uiCardData as any) || {}), status: "AWAITING_PAYMENT" } },
        });
      }
    } catch (e: any) {
      this.logger.warn(`Failed to reopen invoice card for ${invoiceId}: ${e?.message}`);
    }

    await this.prisma.aiChatMessage.create({
      data: {
        sessionId: invoice.sessionId,
        role: "assistant",
        content: `Heads up: the card hold protecting your deposit with ${invoice.providerName} has expired, so no funds are currently secured. Please complete the payment again from the invoice above - your match protection resumes the moment the new authorization lands.`,
        senderType: "system",
        senderName: "GoStork",
        uiCardData: {
          providerContent: `${parentName}'s card hold for the deposit expired before medical clearance completed. We've asked them to re-authorize - we'll confirm here as soon as the deposit is secured again.`,
        },
      },
    }).catch(() => {});

    const admins = await this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" } },
      select: { id: true },
    });
    for (const admin of admins) {
      await this.prisma.inAppNotification.create({
        data: {
          userId: admin.id,
          eventType: "ESCROW_HOLD_LAPSED",
          payload: {
            invoiceId: invoice.id,
            parentName,
            providerName: invoice.providerName,
            amount: formatCents(invoice.serviceAmount),
            message: `Escrow hold lapsed for ${parentName}'s ${formatCents(invoice.serviceAmount)} deposit with ${invoice.providerName} - invoice reopened, parent asked to re-authorize.`,
          },
        },
      }).catch(() => {});
    }
  }

  // Flip every clearance_tracker card for this invoice to its final state so
  // no viewer (parent, provider, admin monitor) is left with live buttons on
  // an already-resolved escrow. The card component renders from
  // uiCardData.medicalClearanceStatus, so this is what the OTHER side sees
  // after one side clicks Cleared/Failed.
  private async resolveClearanceTrackerCards(
    invoiceId: string,
    finalStatus: "CLEARED" | "FAILED",
    // How the escrow resolved - the card copy differs (a voided hold
    // vanishes instantly; a vault refund takes 5-10 business days).
    resolution?: "voided" | "refunded" | "released" | "captured",
  ) {
    try {
      const cards = await this.prisma.aiChatMessage.findMany({
        where: { uiCardType: "clearance_tracker", uiCardData: { path: ["invoiceId"], equals: invoiceId } },
        select: { id: true, uiCardData: true },
      });
      for (const c of cards) {
        const dd = (c.uiCardData as any) || {};
        if (dd.medicalClearanceStatus === finalStatus && dd.resolution === resolution) continue;
        await this.prisma.aiChatMessage.update({
          where: { id: c.id },
          data: {
            uiCardData: {
              ...dd,
              medicalClearanceStatus: finalStatus,
              ...(resolution ? { resolution } : {}),
              resolvedAt: new Date().toISOString(),
            },
          },
        }).catch(() => {});
      }
    } catch (e: any) {
      this.logger.warn(`Failed to resolve clearance tracker cards for ${invoiceId}: ${e?.message}`);
    }
  }

  async captureAuthorization(invoiceId: string, transactionId: string) {
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "PAID",
        stripeTransactionId: transactionId,
        capturedAt: new Date(),
        paidAt: new Date(),
        medicalClearanceStatus: "CLEARED",
        clearanceConfirmedAt: new Date(),
      },
    });
    this.logger.log(`Invoice ${invoiceId} captured - PAID`);
    void emitInvoiceJourneyEvent(invoiceId, "INVOICE_PAID", { path: "capture" });
    await this.resolveClearanceTrackerCards(invoiceId, "CLEARED", "captured");
    // The capture path never gets a chat confirmation from the succeeded
    // webhook (it early-returns on the already-PAID invoice), so post it
    // here - same for the receipt.
    await this.reflectPaymentInChat(invoiceId, "PAID");
    await this.emitPaymentReceipt(invoiceId).catch(e =>
      this.logger.warn(`Payment receipt emission failed for ${invoiceId} (capture path): ${e?.message}`),
    );
    await this.stickSurrogateHoldOnPayment(invoiceId);
    await this.notifyAdminInvoicePaid(invoiceId);
    // Phase 5: clearance captured -> deposit is truly PAID -> agreement flow
    await this.tryDraftAgreementOnPaid(invoiceId).catch(e =>
      this.logger.warn(`Agreement auto-draft failed for ${invoiceId} (capture path): ${e?.message}`),
    );
    {
      const inv = await this.prisma.invoice.findUnique({ where: { id: invoiceId }, select: { sessionId: true } });
      if (inv?.sessionId) {
        await maybeCompleteHandoff(inv.sessionId).catch(e =>
          this.logger.warn(`Handoff check failed for session ${inv.sessionId}: ${e?.message}`),
        );
      }
    }
    // AT_CLEARANCE path also auto-fires the provider transfer.
    try {
      const r = await this.connectService.createTransferForPaidInvoice(invoiceId);
      if (r.status === "failed") {
        await this.notifyAdminTransferFailed(invoiceId, r.reason).catch(() => {});
      }
    } catch (e: any) {
      this.logger.warn(`Auto-transfer raised unexpectedly for ${invoiceId} (capture path): ${e?.message}`);
    }
  }

  // Failed clearance while the money was still a card HOLD: cancel the
  // authorization (the controller already voided the PaymentIntent) and run
  // the shared failure machinery. No funds ever moved.
  async voidAuthorization(invoiceId: string) {
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "CLEARANCE_FAILED",
        medicalClearanceStatus: "FAILED",
        clearanceConfirmedAt: new Date(),
      },
    });
    await this.resolveClearanceTrackerCards(invoiceId, "FAILED", "voided");
    await this.handleClearanceFailureFallout(invoiceId, "voided");
    this.logger.log(`Invoice ${invoiceId} voided - clearance failed`);
  }

  // ─── Hybrid escrow: resolving a VAULT-state invoice (PAID + clearance
  // PENDING - the funds were captured into GoStork's balance) ──────────────

  /** Clearance confirmed on vaulted funds: stamp CLEARED and release the
   *  provider transfer that the CLEARANCE_PENDING gate has been blocking. */
  async releaseEscrowVault(invoiceId: string) {
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { medicalClearanceStatus: "CLEARED", clearanceConfirmedAt: new Date() },
    });
    await this.resolveClearanceTrackerCards(invoiceId, "CLEARED", "released");

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { parentUser: { select: { firstName: true, name: true } } },
    });
    if (invoice) {
      const parentName = invoice.parentUser?.firstName || invoice.parentUser?.name || "The parent";
      const amount = formatCents(invoice.serviceAmount, invoice.currency);
      await this.prisma.aiChatMessage.create({
        data: {
          sessionId: invoice.sessionId,
          role: "assistant",
          content: `Wonderful news - medical clearance is confirmed! 🎉 Your deposit of ${amount} has been released from GoStork's vault to ${invoice.providerName}, and your journey moves to the next step.`,
          senderType: "system",
          senderName: "GoStork",
          uiCardData: {
            providerContent: `Medical clearance confirmed for ${parentName}'s match! Their vaulted deposit of ${amount} has been released - your payout is on its way.`,
            celebration: "payment_received",
          },
        },
      }).catch(() => {});
    }

    try {
      const r = await this.connectService.createTransferForPaidInvoice(invoiceId);
      if (r.status === "failed") {
        await this.notifyAdminTransferFailed(invoiceId, r.reason).catch(() => {});
      }
    } catch (e: any) {
      this.logger.warn(`Vault release transfer raised unexpectedly for ${invoiceId}: ${e?.message}`);
    }
    this.logger.log(`Invoice ${invoiceId} escrow vault released - clearance confirmed`);
  }

  /** Clearance failed on vaulted funds: full refund to the parent through
   *  the existing refund pipeline (charge.refunded webhook stamps REFUNDED
   *  and posts the refund confirmation), plus the shared failure fallout. */
  async refundEscrowVault(invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, stripeTransactionId: true, stripePaymentIntentId: true, serviceAmount: true },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    const paymentIntentId = invoice.stripeTransactionId || invoice.stripePaymentIntentId;
    if (!paymentIntentId) throw new BadRequestException("No captured payment on file to refund");

    // Refund FIRST - if Stripe rejects, fail loudly and leave the escrow
    // PENDING so the admin sees a stuck vault, not a phantom refund.
    await createRefund({
      paymentIntentId,
      reason: "requested_by_customer",
      metadata: { invoiceId, refundContext: "clearance_failed" },
    });

    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { medicalClearanceStatus: "FAILED", clearanceConfirmedAt: new Date() },
    });
    await this.resolveClearanceTrackerCards(invoiceId, "FAILED", "refunded");
    await this.handleClearanceFailureFallout(invoiceId, "refunded");
    this.logger.log(`Invoice ${invoiceId} escrow vault refunded - clearance failed`);
  }

  // Shared fallout for a failed clearance, whichever way the money went
  // back: GoStork Guarantee messaging (copy varies: a voided hold vanishes
  // instantly, a refund takes 5-10 business days), admin redirect
  // notifications, and releasing the surrogate from the match.
  private async handleClearanceFailureFallout(invoiceId: string, path: "voided" | "refunded") {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { parentUser: true },
    });
    if (invoice) {
      const parentName = invoice.parentUser?.firstName || invoice.parentUser?.name || "The parent";
      const parentContent = path === "voided"
        ? `We're sorry to hear that your surrogate did not pass medical clearance. Your card hold has been fully released - no charges were made. Because you paid through GoStork, you're protected by the GoStork Guarantee: you're free to start fresh with any other agency on our platform whenever you're ready. Our team will reach out to help you with your next steps.`
        : `We're sorry to hear that your surrogate did not pass medical clearance. A full refund of ${formatCents(invoice.serviceAmount, invoice.currency)} is on its way from GoStork's vault - it usually lands within 5-10 business days. Because you paid through GoStork, you're protected by the GoStork Guarantee: you're free to start fresh with any other agency on our platform whenever you're ready. Our team will reach out to help you with your next steps.`;
      const providerContent = path === "voided"
        ? `Medical clearance was not passed, so ${parentName}'s held deposit has been released back to them - no funds changed hands. The GoStork team has been notified and will follow up with ${parentName} on next steps.`
        : `Medical clearance was not passed, so ${parentName}'s vaulted deposit has been fully refunded to them - no funds were released to you. The GoStork team has been notified and will follow up with ${parentName} on next steps.`;
      await this.prisma.aiChatMessage.create({
        data: {
          sessionId: invoice.sessionId,
          role: "assistant",
          content: parentContent,
          senderType: "system",
          senderName: "GoStork",
          uiCardType: "text",
          uiCardData: { providerContent },
        },
      });

      // Notify admin to handle GoStork Guarantee redirect
      const admins = await this.prisma.user.findMany({
        where: { roles: { has: "GOSTORK_ADMIN" } },
        select: { id: true },
      });
      for (const admin of admins) {
        await this.prisma.inAppNotification.create({
          data: {
            userId: admin.id,
            eventType: "CLEARANCE_FAILED",
            payload: {
              invoiceId: invoice.id,
              parentName: invoice.parentUser.name,
              parentUserId: invoice.parentUserId,
              providerName: invoice.providerName,
              amount: formatCents(invoice.serviceAmount),
              resolution: path,
              message: `GoStork Guarantee activated: ${invoice.parentUser.name || "Parent"}'s surrogate from ${invoice.providerName} failed medical clearance. Deposit of ${formatCents(invoice.serviceAmount)} ${path === "voided" ? "hold released" : "refunded"} - ready to redirect.`,
            },
          },
        });
      }
    }

    // Release the parent's claim on the surrogate - she failed medical
    // screening, so she must not stay MATCHED to this family. She does NOT
    // go back to AVAILABLE automatically (a failed screening is the agency's
    // call to re-list); ON_HOLD keeps her out of the marketplace until the
    // agency updates her status from their roster.
    if (invoice?.sessionId) {
      try {
        const session = await this.prisma.aiChatSession.findUnique({
          where: { id: invoice.sessionId },
          select: { subjectProfileId: true, subjectType: true },
        });
        if (session?.subjectProfileId && (session.subjectType || "").toLowerCase().includes("surrog")) {
          await this.prisma.surrogate.updateMany({
            where: { id: session.subjectProfileId, reservedByParentId: invoice.parentUserId },
            data: { reservedByParentId: null, reservationExpiresAt: null, status: "ON_HOLD" },
          });
          this.logger.log(`Surrogate ${session.subjectProfileId} released from match (clearance failed, invoice ${invoiceId})`);
        }
      } catch (e: any) {
        this.logger.warn(`Failed to release surrogate after clearance failure for ${invoiceId}: ${e?.message}`);
      }
    }
  }

  // ─── Stripe webhook handler ───────────────────────────────────────────────

  async handleStripeWebhook(paymentIntentId: string, status: string, invoiceId?: string, paymentMethod?: "ACH" | "CARD" | "BANK_TRANSFER" | null) {
    // Resolve the invoice by all known links. Webhook metadata.invoiceId is
    // the most reliable lookup because the PaymentIntent ID on the invoice
    // can be overwritten if a new PaymentIntent gets created (e.g. the
    // inline payment panel remounts and the create-payment-intent endpoint
    // mints a fresh PI). Fall back to lookup by PaymentIntent ID, then by
    // transaction ID, so older invoices still resolve.
    const findInvoice = async () => {
      if (invoiceId) {
        const byId = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
        if (byId) return byId;
      }
      const byPi = await this.prisma.invoice.findFirst({
        where: { stripePaymentIntentId: paymentIntentId },
      });
      if (byPi) return byPi;
      return await this.prisma.invoice.findFirst({
        where: { stripeTransactionId: paymentIntentId },
      });
    };

    if (status === "authorized") {
      // AT_CLEARANCE: funds held, mark invoice as AUTHORIZED
      const invoice = await findInvoice();
      if (!invoice) {
        this.logger.warn(`No invoice found for Stripe PaymentIntent ${paymentIntentId} (invoiceId hint: ${invoiceId || "none"})`);
        return;
      }
      if (invoice.status === "AUTHORIZED" || invoice.status === "PAID") return;
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: "AUTHORIZED", authorizedAt: new Date(), paymentMethod: "CARD" },
      });
      await this.reflectPaymentInChat(invoice.id, "AUTHORIZED");
      await this.onEscrowAuthorized(invoice.id).catch(e =>
        this.logger.warn(`Escrow-authorized follow-up failed for ${invoice.id}: ${e?.message}`),
      );
      this.logger.log(`Invoice ${invoice.id} AUTHORIZED via Stripe (AT_CLEARANCE)`);
      return;
    }

    if (status === "processing") {
      // Delayed-notification methods (primarily ACH Direct Debit). Funds are
      // not yet available; the invoice sits in PAYMENT_PROCESSING until
      // payment_intent.succeeded fires 3-5 business days later. We email the
      // parent so they don't re-attempt payment, but do NOT emit a receipt
      // yet - that happens on succeeded.
      const invoice = await findInvoice();
      if (!invoice) {
        this.logger.warn(`No invoice found for Stripe PaymentIntent ${paymentIntentId} (invoiceId hint: ${invoiceId || "none"})`);
        return;
      }
      if (invoice.status === "PAYMENT_PROCESSING" || invoice.status === "PAID") return; // idempotent
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          status: "PAYMENT_PROCESSING",
          paymentMethod: paymentMethod ?? "ACH",
          stripePaymentIntentId: paymentIntentId,
        },
      });
      await this.notificationService.sendInvoiceProcessingNotification({ invoiceId: invoice.id }).catch(e =>
        this.logger.warn(`Processing notification failed for ${invoice.id}: ${e?.message}`),
      );
      this.logger.log(`Invoice ${invoice.id} PAYMENT_PROCESSING (method: ${paymentMethod ?? "ACH"})`);
      return;
    }

    if (!["succeeded"].includes(status)) return;

    const invoice = await findInvoice();
    if (!invoice) {
      this.logger.warn(`No invoice found for Stripe PaymentIntent ${paymentIntentId} (invoiceId hint: ${invoiceId || "none"})`);
      return;
    }

    if (invoice.status === "PAID") return; // idempotent

    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: "PAID",
        paidAt: new Date(),
        paymentMethod: paymentMethod ?? invoice.paymentMethod ?? "CARD",
        stripeTransactionId: paymentIntentId,
        capturedAt: new Date(),
      },
    });

    void emitInvoiceJourneyEvent(invoice.id, "INVOICE_PAID");
    await this.reflectPaymentInChat(invoice.id, "PAID");
    await this.stickSurrogateHoldOnPayment(invoice.id);
    // Escrow invoice paid by a method that captures immediately (wire /
    // bank transfer - no hold phase possible): the funds land straight in
    // the vault. Post the tracker card; the CLEARANCE_PENDING gate below
    // keeps the transfer blocked until clearance is confirmed.
    if (invoice.medicalClearanceStatus === "PENDING") {
      await this.onEscrowAuthorized(invoice.id, "vault").catch(e =>
        this.logger.warn(`Vault tracker card failed for ${invoice.id}: ${e?.message}`),
      );
    }
    await this.notifyAdminInvoicePaid(invoice.id);
    // Phase 5: auto-draft/send the agreement now that the deposit is paid,
    // and complete the stage 13 handoff if the agreement was already signed
    // (AT_CLEARANCE flows can sign against an AUTHORIZED invoice).
    await this.tryDraftAgreementOnPaid(invoice.id).catch(e =>
      this.logger.warn(`Agreement auto-draft failed for ${invoice.id}: ${e?.message}`),
    );
    if (invoice.sessionId) {
      await maybeCompleteHandoff(invoice.sessionId).catch(e =>
        this.logger.warn(`Handoff check failed for session ${invoice.sessionId}: ${e?.message}`),
      );
    }
    await this.emitPaymentReceipt(invoice.id).catch(e =>
      this.logger.warn(`Payment receipt emission failed for ${invoice.id}: ${e?.message}`),
    );
    // Auto-fire the platform -> provider transfer. Best-effort; failures
    // (provider not onboarded, KYC restricted, insufficient platform
    // balance, etc.) leave the invoice PAID and the parent's payment
    // intact - admin is notified via the result so they can intervene.
    try {
      const transferResult = await this.connectService.createTransferForPaidInvoice(invoice.id);
      if (transferResult.status === "skipped") {
        this.logger.log(`Transfer skipped for invoice ${invoice.id}: ${transferResult.reason} - ${transferResult.message}`);
      } else if (transferResult.status === "failed") {
        // Loud admin notification so ops can manually wire the payout.
        await this.notifyAdminTransferFailed(invoice.id, transferResult.reason).catch(e =>
          this.logger.warn(`Admin transfer-failed notification failed: ${e?.message}`),
        );
      }
    } catch (e: any) {
      this.logger.warn(`Auto-transfer raised unexpectedly for ${invoice.id}: ${e?.message}`);
    }
    this.logger.log(`Invoice ${invoice.id} marked PAID via Stripe`);
  }

  // ─── Refunds (admin-issued) ─────────────────────────────────────────────────

  /**
   * Admin path: initiate a refund via Stripe. Called from the admin
   * endpoint after permission checks. We do NOT do the DB writes here -
   * Stripe fires charge.refunded asynchronously and our webhook handler
   * does the stamping + clawback. That keeps the system consistent even
   * if a refund originates outside our UI (e.g. an admin clicks "Refund"
   * in the Stripe Dashboard directly).
   */
  async adminCreateRefund(params: {
    invoiceId: string;
    amountCents?: number;
    reason?: "duplicate" | "fraudulent" | "requested_by_customer" | "other";
    notes?: string;
    actorUserId: string;
    /**
     * proportional (default): refund splits across provider + platform fee
     *   like the original payment did. Use for goodwill / fraud / duplicate.
     * keep_platform_fee: refund comes entirely from provider's share, GoStork
     *   keeps the full fee. Use for Guarantee scenarios where provider didn't
     *   deliver but GoStork's service (vetting, matching, holding funds) was.
     */
    mode?: "proportional" | "keep_platform_fee";
  }) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: params.invoiceId },
      select: {
        id: true,
        status: true,
        serviceAmount: true,
        refundedAmount: true,
        stripeTransactionId: true,
      },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (!["PAID", "PARTIALLY_REFUNDED"].includes(invoice.status)) {
      throw new BadRequestException(`Cannot refund invoice in status ${invoice.status}`);
    }
    if (!invoice.stripeTransactionId || invoice.stripeTransactionId.startsWith("mock_")) {
      throw new BadRequestException("Invoice has no Stripe PaymentIntent on file - refund must be handled manually");
    }
    const alreadyRefunded = invoice.refundedAmount || 0;
    const remaining = invoice.serviceAmount - alreadyRefunded;
    if (remaining <= 0) {
      throw new BadRequestException("Invoice is already fully refunded");
    }
    const refundAmount = params.amountCents ?? remaining;
    if (refundAmount > remaining) {
      throw new BadRequestException(
        `Refund amount (${refundAmount}) exceeds remaining refundable balance (${remaining})`,
      );
    }

    // Stash the admin's free-text notes on the invoice now (the webhook
    // doesn't carry it) so the audit trail captures who initiated and why.
    // refundedAmount itself is set by the webhook to stay consistent with
    // Stripe's charge.amount_refunded, the canonical source.
    if (params.notes || params.reason) {
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          ...(params.notes ? { refundNotes: params.notes.slice(0, 1000) } : {}),
          ...(params.reason ? { refundReason: params.reason } : {}),
        },
      });
    }

    // For keep_platform_fee mode, clamp the refund to the provider's share -
    // GoStork's fee never gets refunded to the parent under this policy.
    const mode = params.mode || "proportional";
    let finalRefundAmount = refundAmount;
    if (mode === "keep_platform_fee") {
      const invoiceForCap = await this.prisma.invoice.findUnique({
        where: { id: invoice.id },
        select: { providerPayoutAmount: true, payoutReversedAmount: true },
      });
      const providerShareRemaining = Math.max(
        0,
        (invoiceForCap?.providerPayoutAmount || 0) - (invoiceForCap?.payoutReversedAmount || 0),
      );
      if (refundAmount > providerShareRemaining) {
        throw new BadRequestException(
          `Refund of ${refundAmount} cents exceeds the provider's remaining share (${providerShareRemaining}) under keep_platform_fee mode. Reduce the amount or switch to Proportional mode.`,
        );
      }
      finalRefundAmount = refundAmount;
    }

    // Mode is tagged in Stripe refund metadata so the async charge.refunded
    // webhook can read it and compute the correct reversal. We can't rely
    // on the invoice column alone because stacked refunds in different
    // modes would race.
    const refund = await createRefund({
      paymentIntentId: invoice.stripeTransactionId,
      amountCents: finalRefundAmount,
      reason: params.reason,
      metadata: {
        invoiceId: invoice.id,
        actorUserId: params.actorUserId,
        refundMode: mode,
      },
    });
    this.logger.log(
      `Admin ${params.actorUserId} refunded ${finalRefundAmount} cents on invoice ${invoice.id} via ${mode} (refund=${refund.id})`,
    );
    // "Refund Requested" on the journey ladder: the refund exists at Stripe
    // now; charge.refunded will stamp refundedAt ("Refund Completed") when
    // it lands. Reason/notes are stored up front so the audit trail exists
    // even if the webhook is delayed. Keep the first request timestamp on a
    // stacked partial refund.
    await this.prisma.invoice.updateMany({
      where: { id: invoice.id, refundRequestedAt: null },
      data: { refundRequestedAt: new Date() },
    });
    return { refundId: refund.id, amountCents: finalRefundAmount, mode, status: refund.status };
  }

  /**
   * Webhook path: charge.refunded fired. Stripe accumulates
   * charge.amount_refunded as multiple refunds stack up, so we diff against
   * what we have stored and (a) stamp the new total + latest refund id, (b)
   * proportionally reverse the provider's transfer for the DELTA only.
   *
   * Idempotent: re-deliveries with the same amount_refunded value are
   * detected and skipped (no double-reversal).
   *
   * Provider clawback math: the original parent payment was split between
   * platform fee + provider payout. A refund should be split the same way,
   * so the provider returns their share proportional to the refunded amount.
   *
   *   reversalDelta = providerPayoutAmount * (deltaRefunded / serviceAmount)
   *
   * The reversal goes against the original Transfer. Stripe handles whether
   * the connected account still has the funds (debit Connect balance) or
   * already swept them to bank (debit next incoming balance).
   */
  async handleChargeRefunded(params: {
    paymentIntentId: string;
    amountRefundedCents: number;
    fullyRefunded: boolean;
    latestRefundId: string | null;
    latestRefundReason: string | null;
    /** Refund metadata from Stripe. We read `refundMode` here to decide
     *  proportional vs keep_platform_fee clawback. Defaults to proportional
     *  for refunds initiated outside our admin UI (e.g. Stripe Dashboard). */
    latestRefundMetadata?: Record<string, string> | null;
  }): Promise<{ matched: boolean; reversalCents?: number; reversalId?: string }> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { stripeTransactionId: params.paymentIntentId },
      select: {
        id: true,
        status: true,
        serviceAmount: true,
        providerPayoutAmount: true,
        refundedAmount: true,
        stripeTransferId: true,
        payoutReversedAmount: true,
        // bankPayoutCompletedAt tells us whether the funds had already
        // swept to the provider's bank when we issue the reversal. If yes,
        // Stripe creates a negative Connect balance (recouped from future
        // transfers) instead of pulling from the bank - we stamp the
        // at-risk flag so the monitor can track it.
        bankPayoutCompletedAt: true,
        sessionId: true,
        providerId: true,
        parentUserId: true,
        parentUser: { select: { firstName: true, name: true } },
      },
    });
    if (!invoice) {
      this.logger.warn(`charge.refunded for unknown PaymentIntent ${params.paymentIntentId}`);
      return { matched: false };
    }

    const previouslyRefunded = invoice.refundedAmount || 0;
    if (params.amountRefundedCents <= previouslyRefunded) {
      this.logger.log(
        `charge.refunded for invoice ${invoice.id}: no new refund (already=${previouslyRefunded}, event=${params.amountRefundedCents}) - idempotent skip`,
      );
      return { matched: true };
    }
    const deltaRefunded = params.amountRefundedCents - previouslyRefunded;

    // Reverse the provider's share for the DELTA only. Two modes:
    //   proportional (default + refunds from Stripe Dashboard): provider
    //     returns a share proportional to the refunded amount.
    //   keep_platform_fee: provider returns the full refunded amount (capped
    //     at their original payout). GoStork keeps its fee untouched.
    const mode: "proportional" | "keep_platform_fee" =
      params.latestRefundMetadata?.refundMode === "keep_platform_fee"
        ? "keep_platform_fee"
        : "proportional";
    let reversalId: string | undefined;
    let reversalDelta: number | undefined;
    if (invoice.stripeTransferId && (invoice.providerPayoutAmount || 0) > 0 && invoice.serviceAmount > 0) {
      const previouslyReversed = invoice.payoutReversedAmount || 0;
      // targetReversal: the total amount that *should* be reversed across
      // all refunds against this invoice given the current mode. We
      // subtract previouslyReversed below to get the DELTA for this event.
      const targetReversal = mode === "keep_platform_fee"
        // 1:1 with the parent's refund total, capped at the provider's original payout.
        ? Math.min(invoice.providerPayoutAmount, params.amountRefundedCents)
        // round() so the proportional split lands on the nearest cent rather
        // than truncating in the platform's favor.
        : Math.round(invoice.providerPayoutAmount * (params.amountRefundedCents / invoice.serviceAmount));
      reversalDelta = Math.max(0, Math.min(invoice.providerPayoutAmount - previouslyReversed, targetReversal - previouslyReversed));
      if (reversalDelta > 0) {
        try {
          const reversal = await createTransferReversal({
            transferId: invoice.stripeTransferId,
            amountCents: reversalDelta,
            metadata: { invoiceId: invoice.id, refundId: params.latestRefundId || "", refundMode: mode },
          });
          reversalId = reversal.id;
          this.logger.log(
            `Reversed ${reversalDelta} cents of transfer ${invoice.stripeTransferId} for invoice ${invoice.id} via ${mode} (refund delta=${deltaRefunded})`,
          );
        } catch (e: any) {
          // Don't block the refund DB update on reversal failure - admin will
          // see it in the notification bell and can claw back manually.
          this.logger.error(
            `Transfer reversal failed for invoice ${invoice.id}: ${e?.message}. Admin will need to claw back manually.`,
          );
        }
      }
    }

    const newStatus = params.fullyRefunded
      ? "REFUNDED"
      : params.amountRefundedCents >= invoice.serviceAmount
        ? "REFUNDED"
        : "PARTIALLY_REFUNDED";

    // At-risk: reversal fired AFTER bank payout completed. Stripe creates
    // a negative Connect balance that recoups from future transfers - until
    // then, GoStork is extending uncollateralized credit. The monitor stamps
    // payoutReversalRecoupedAt when the provider's Connect balance is >= 0.
    const reversalIsAtRisk = !!reversalId && !!invoice.bankPayoutCompletedAt;

    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: newStatus,
        refundedAt: new Date(),
        refundedAmount: params.amountRefundedCents,
        ...(params.latestRefundId ? { stripeRefundId: params.latestRefundId } : {}),
        ...(params.latestRefundReason ? { refundReason: params.latestRefundReason } : {}),
        ...(reversalId
          ? {
              payoutReversalId: reversalId,
              payoutReversedAt: new Date(),
              payoutReversedAmount: (invoice.payoutReversedAmount || 0) + (reversalDelta || 0),
              ...(reversalIsAtRisk ? { payoutReversalAtRisk: true, payoutReversalRecoupedAt: null } : {}),
            }
          : {}),
      },
    });
    if (reversalIsAtRisk) {
      this.logger.warn(
        `Invoice ${invoice.id}: reversal ${reversalId} for ${reversalDelta} cents hit an already-paid-out invoice. Negative Connect balance pending recoupment.`,
      );
    }

    // In-chat: flip the invoice card to the refund status (it was still
    // showing "Paid / Payment complete" after the first real prod refund)
    // and post a VIEWER-SPECIFIC system message - the parent reads "your
    // payment", the provider reads "<parent>'s payment" (dual-audience
    // rule). Best-effort - don't block on it.
    if (invoice.sessionId) {
      const moneyStr = (params.amountRefundedCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
      const parentLabel = invoice.parentUser?.firstName || invoice.parentUser?.name || "The parent";
      try {
        const existingCardMsg = await this.prisma.aiChatMessage.findFirst({
          where: {
            sessionId: invoice.sessionId,
            uiCardType: "invoice",
            uiCardData: { path: ["invoiceId"], equals: invoice.id },
          },
          select: { id: true, uiCardData: true },
        });
        if (existingCardMsg) {
          await this.prisma.aiChatMessage.update({
            where: { id: existingCardMsg.id },
            data: { uiCardData: { ...((existingCardMsg.uiCardData as any) || {}), status: newStatus, refundedAmount: params.amountRefundedCents } },
          });
        }
      } catch (e: any) {
        this.logger.warn(`Failed to update invoice card status after refund for invoice ${invoice.id}: ${e?.message}`);
      }
      try {
        await this.prisma.aiChatMessage.create({
          data: {
            sessionId: invoice.sessionId,
            role: "assistant",
            content: params.fullyRefunded
              ? `Your payment has been fully refunded (${moneyStr}). The refund usually appears on your card statement within 5-10 business days.`
              : `A partial refund of ${moneyStr} has been issued. It usually appears on your card statement within 5-10 business days.`,
            senderType: "system",
            senderName: "GoStork",
            uiCardType: "text",
            uiCardData: {
              providerContent: params.fullyRefunded
                ? `${parentLabel}'s payment of ${moneyStr} has been fully refunded by GoStork. ${
                    reversalDelta ? `Your share (${(reversalDelta / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}) was reversed from your payout.` : "No payout had been made to you for this invoice."
                  }`
                : `A partial refund of ${moneyStr} was issued to ${parentLabel} by GoStork.${
                    reversalDelta ? ` ${(reversalDelta / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} was reversed from your payout.` : ""
                  }`,
            },
          },
        });
      } catch (e: any) {
        this.logger.warn(`Failed to post refund chat message for invoice ${invoice.id}: ${e?.message}`);
      }
    }

    return { matched: true, reversalCents: reversalDelta, reversalId };
  }

  /**
   * In-app admin notification when a platform -> provider transfer fails.
   * Surfaces in the admin's notification bell so they can manually wire
   * the payout from Chase as a fallback. Kept lightweight to avoid a
   * dedicated email template - the existing notifyAdminInvoicePaid
   * already covers the "money arrived from parent" notification; this
   * is the "we couldn't forward it" follow-up.
   */
  private async notifyAdminTransferFailed(invoiceId: string, reason: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        providerName: true,
        providerPayoutAmount: true,
        currency: true,
      },
    });
    if (!invoice) return;
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" } },
      select: { id: true },
    });
    const amount = formatCents(invoice.providerPayoutAmount, invoice.currency);
    for (const admin of admins) {
      await this.prisma.inAppNotification.create({
        data: {
          userId: admin.id,
          eventType: "PAYOUT_TRANSFER_FAILED",
          payload: {
            invoiceId: invoice.id,
            providerName: invoice.providerName,
            amount,
            reason,
            message: `Payout transfer failed for ${invoice.providerName} (${amount}). Reason: ${reason}. Manually wire from Chase.`,
          },
        },
      });
    }
  }

  /**
   * Generates the PDF receipt for a paid invoice and emails it to the parent
   * and the agency's billing recipients. Best-effort - failures here must not
   * roll back the PAID state. Called from every success path
   * (Stripe webhook + admin manual override).
   */
  async emitPaymentReceipt(invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        parentUser: true,
        lineItems: { orderBy: { displayOrder: "asc" } },
      },
    });
    if (!invoice || invoice.status !== "PAID") return;

    const lineItems = (invoice as any).lineItems || [];
    const emailLineItems = lineItems.map((li: any) => ({
      label: humanizeLineServiceType(li.serviceType),
      description: li.description,
      amountFormatted: formatCents(li.amountCents, invoice.currency || "USD"),
    }));

    // Send the receipt to every provider user with an email. There's no
    // `billingRecipient` flag in the schema yet - when that ships we can
    // narrow this to designated billing contacts; for now de-duped emails
    // across the whole provider team is the right behavior. NOTE: the old
    // code selected `billingRecipient`, which silently threw at runtime
    // (column doesn't exist) and caused this entire receipt emission to
    // fail - hence the symptom of admin getting the payment-received email
    // but parent + provider getting nothing.
    let providerEmails: string[] = [];
    if (invoice.providerId) {
      // User.email is `String @unique` (not nullable), so no filter needed -
      // every provider user has an email. Filter at the JS layer just in case
      // the DB ever ends up with a blank string.
      const members = await this.prisma.user.findMany({
        where: { providerId: invoice.providerId },
        select: { email: true },
      });
      providerEmails = Array.from(
        new Set(members.map((m: any) => m.email as string).filter(Boolean)),
      );
    }

    // Card brand + last4 for the receipt.
    const card = invoice.stripePaymentIntentId
      ? await getCardDetailsForPaymentIntent(invoice.stripePaymentIntentId)
      : { brand: null, last4: null, expMonth: null, expYear: null };

    const paidAt = invoice.paidAt || new Date();
    const receiptNumber = `GS-${paidAt.toISOString().slice(0, 10).replace(/-/g, "")}-${invoice.id.slice(0, 8).toUpperCase()}`;

    // Agency brand settings drive the receipt's primary color + logo;
    // Legal Name + Tax ID come from ProviderLegalIdentity (separate
    // model, single source of truth, also feeds Stripe Connect KYC).
    // Logo bytes are fetched lazily - if the URL fails we fall back to
    // the wordmark layout.
    const [brandSettings, legalIdentity] = invoice.providerId
      ? await Promise.all([
          this.prisma.providerBrandSettings.findUnique({
            where: { providerId: invoice.providerId },
            select: { primaryColor: true, logoUrl: true },
          }),
          this.prisma.providerLegalIdentity.findUnique({
            where: { providerId: invoice.providerId },
            select: { legalName: true, taxId: true },
          }),
        ])
      : [null, null];

    let logoBuffer: Buffer | null = null;
    if (brandSettings?.logoUrl) {
      try {
        const res = await fetch(brandSettings.logoUrl);
        if (res.ok) {
          const ct = res.headers.get("content-type") || "";
          // pdfkit only embeds PNG / JPEG. Skip SVGs and other formats.
          if (/png|jpeg|jpg/i.test(ct)) {
            const ab = await res.arrayBuffer();
            logoBuffer = Buffer.from(ab);
          }
        }
      } catch (e: any) {
        this.logger.warn(`Logo fetch failed for receipt PDF: ${e?.message}`);
      }
    }

    const pdf = await generateReceiptPdf({
      invoice: {
        id: invoice.id,
        invoiceNumber: (invoice as any).invoiceNumber ?? null,
        serviceAmount: invoice.serviceAmount,
        referralFeeAmount: invoice.referralFeeAmount,
        providerPayoutAmount: invoice.providerPayoutAmount,
        currency: invoice.currency || "USD",
        serviceType: humanizeLineServiceType(invoice.serviceType),
        providerName: invoice.providerName,
        description: invoice.description || null,
        paidAt,
        isProtected: invoice.isProtected ?? false,
        stripeTransactionId: invoice.stripeTransactionId || null,
        stripePaymentIntentId: invoice.stripePaymentIntentId || null,
        lineItems: lineItems.map((li: any) => ({
          serviceType: li.serviceType,
          serviceTypeLabel: humanizeLineServiceType(li.serviceType),
          description: li.description,
          amountCents: li.amountCents,
        })),
      },
      parent: {
        name: invoice.parentUser?.name || invoice.parentUser?.firstName || "Customer",
        email: invoice.parentUser?.email || "",
        city: (invoice.parentUser as any)?.city || null,
        state: (invoice.parentUser as any)?.state || null,
      },
      card,
      brand: {
        // Falls back to GoStork's LIVE primary, not a hex typed here - the PDF
        // otherwise printed a retired green for any agency without a brand colour.
        primaryColor: brandSettings?.primaryColor || await platformPrimaryColor(this.prisma),
        logoBuffer,
        legalName: legalIdentity?.legalName || invoice.providerName,
        taxId: legalIdentity?.taxId || null,
      },
    });

    const paidAmountFormatted = formatCents(invoice.serviceAmount, invoice.currency || "USD");

    await this.notificationService.sendPaymentReceiptEmails({
      parentName: invoice.parentUser?.name || "Customer",
      parentEmail: invoice.parentUser?.email || "",
      parentUserId: invoice.parentUserId,
      providerName: invoice.providerName,
      providerEmails,
      receiptNumber,
      paidAmountFormatted,
      serviceType: humanizeLineServiceType(invoice.serviceType),
      description: invoice.description || null,
      paidAtIso: paidAt.toISOString(),
      pdf,
      lineItems: emailLineItems.length > 0 ? emailLineItems : undefined,
    });

    this.logger.log(`Payment receipt sent: invoice=${invoice.id} parent=${invoice.parentUser?.email} agency=${providerEmails.length}`);
  }

  /**
   * After an invoice transitions to PAID (or AUTHORIZED), keep the chat in
   * sync with reality:
   *   1. Update the existing invoice card message's uiCardData.status so the
   *      "Pay Now Securely" CTA disappears and the card shows the paid state
   *      ("Payment complete" / "Funds securely held").
   *   2. Post a fresh system message in the chat confirming the payment so
   *      the parent and provider both see explicit confirmation.
   */
  private async reflectPaymentInChat(
    invoiceId: string,
    newStatus: "PAID" | "AUTHORIZED",
  ) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { parentUser: true },
    });
    if (!invoice) return;

    // Find the existing invoice card message for this invoice and update its
    // uiCardData.status. Prisma JSON filtering via path lets us target the
    // exact card row without scanning the whole session.
    try {
      const existingCardMsg = await this.prisma.aiChatMessage.findFirst({
        where: {
          sessionId: invoice.sessionId,
          uiCardType: "invoice",
          uiCardData: { path: ["invoiceId"], equals: invoice.id },
        },
        select: { id: true, uiCardData: true },
      });
      if (existingCardMsg) {
        const updatedData = {
          ...((existingCardMsg.uiCardData as any) || {}),
          status: newStatus,
        };
        await this.prisma.aiChatMessage.update({
          where: { id: existingCardMsg.id },
          data: { uiCardData: updatedData },
        });
      }
    } catch (e: any) {
      this.logger.warn(`Failed to update invoice card status in chat: ${e?.message}`);
    }

    // Post a confirmation system message so the chat thread shows explicit
    // proof of payment to both parent and provider.
    try {
      const amount = formatCents(invoice.serviceAmount, invoice.currency);
      const parentLabel = invoice.parentUser?.firstName || invoice.parentUser?.name || "The parent";
      const verb = newStatus === "AUTHORIZED" ? "authorized" : "paid";
      await this.prisma.aiChatMessage.create({
        data: {
          sessionId: invoice.sessionId,
          role: "assistant",
          // Viewer-specific voices (dual-audience rule) + the fireworks
          // celebration on a completed payment (not on authorizations).
          content: `You've ${verb} ${amount} for ${humanizeLineServiceType(invoice.serviceType)} via ${invoice.providerName} - thank you!`,
          senderType: "system",
          senderName: "GoStork",
          uiCardData: {
            providerContent: `${parentLabel} has ${verb} ${amount} for ${humanizeLineServiceType(invoice.serviceType)} via ${invoice.providerName}. Thank you!`,
            ...(verb === "paid" ? { celebration: "payment_received" } : {}),
          },
        },
      });
    } catch (e: any) {
      this.logger.warn(`Failed to post payment confirmation message: ${e?.message}`);
    }
  }

  // ─── Admin notifications on payment ─────────────────────────────────────────

  // ─── Phase 4: both-sides match gate ─────────────────────────────────────────
  //
  // For match calls the deposit invoice fires only when BOTH sides confirm:
  //   - parent: readiness_prompt card (private session) answered "yes"
  //   - agency (on the surrogate's behalf): provider_readiness_prompt card
  //     (3-way session) answered "yes"
  // Called after either side answers. Returns "waiting" until both are in.

  async tryFinalizeMatch(bookingId: string): Promise<
    | { status: "finalized"; invoiceId: string }
    | { status: "waiting"; waitingOn: "parent" | "provider" }
    | { status: "skipped"; reason: "NOT_A_MATCH_CALL" | "NO_PROVIDER" | "INVOICE_EXISTS" }
    | { status: "blocked"; reason: "NO_QUOTE" | "NO_CONFIG" | "NO_DEFAULT_PAYMENT" | "BILLING_IDENTITY_INCOMPLETE"; message: string }
  > {
    const cards = await this.prisma.aiChatMessage.findMany({
      where: {
        uiCardType: { in: ["readiness_prompt", "provider_readiness_prompt"] },
        uiCardData: { path: ["bookingId"], equals: bookingId },
      },
      select: { sessionId: true, uiCardType: true, uiCardData: true },
      orderBy: { createdAt: "desc" },
    });
    const providerCard = cards.find(c => c.uiCardType === "provider_readiness_prompt");
    if (!providerCard) return { status: "skipped", reason: "NOT_A_MATCH_CALL" };
    const parentYes = cards.some(c => c.uiCardType === "readiness_prompt" && ((c.uiCardData as any) || {}).answered === "yes");
    const providerYes = ((providerCard.uiCardData as any) || {}).answered === "yes";
    if (!parentYes) return { status: "waiting", waitingOn: "parent" };
    if (!providerYes) return { status: "waiting", waitingOn: "provider" };

    const providerSessionId = providerCard.sessionId;
    const session = await this.prisma.aiChatSession.findUnique({
      where: { id: providerSessionId },
      select: { userId: true, providerId: true, subjectProfileId: true, subjectType: true },
    });
    if (!session?.providerId) return { status: "skipped", reason: "NO_PROVIDER" };

    const openInvoice = await this.prisma.invoice.findFirst({
      where: { sessionId: providerSessionId, status: { in: ["AWAITING_PAYMENT", "AUTHORIZED", "PAYMENT_PROCESSING", "PAID"] } },
      select: { id: true },
    });
    if (openInvoice) return { status: "skipped", reason: "INVOICE_EXISTS" };

    // Official match: deposit invoice due in 24h from the double-yes moment.
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    let invoice;
    try {
      invoice = await this.createInvoice({
        sessionId: providerSessionId,
        providerId: session.providerId,
        parentUserId: session.userId,
        triggerSource: "AUTO_READINESS",
        dueAt,
        preferredServiceType: "SURROGACY",
      });
    } catch (err: any) {
      return this.mapInvoiceCreationError(err);
    }
    void emitJourneyEvent({ eventType: "MATCH_CONFIRMED", parentUserId: session.userId, providerId: session.providerId, sessionId: providerSessionId, bookingId, metadata: { invoiceId: invoice.id } });
    // Phase 8: the match unlocks the "matched" review checkpoint.
    import("../../../review-prompts")
      .then(({ maybePostReviewPrompt }) => maybePostReviewPrompt({ parentUserId: session.userId, providerId: session.providerId!, stage: "matched" }))
      .catch(() => {});

    // Extend the surrogate's hold to cover the full payment window - the
    // expiry sweep must not release her while the invoice is live.
    if (session.subjectProfileId && (session.subjectType || "").toLowerCase().includes("surrog")) {
      await this.prisma.surrogate.updateMany({
        where: { id: session.subjectProfileId, reservedByParentId: session.userId },
        // Official match: she's MATCHED from this moment - hidden from the
        // parent marketplace and AI search; only her agency still sees her.
        data: { reservationExpiresAt: dueAt, status: "MATCHED" },
      }).catch(() => {});
    }
    {
      const { advanceJourneyStage } = await import("../../../journey-stage");
      await advanceJourneyStage(session.userId, "Matched");
    }

    // Celebrate FIRST, then the invoice lands right below it. The
    // celebration flag makes the client fire the full-screen confetti.
    const parentUser = await this.prisma.user.findUnique({
      where: { id: session.userId },
      select: { firstName: true, name: true },
    }).catch(() => null);
    const parentLabel = parentUser?.firstName || parentUser?.name || "you";
    const who = ((providerCard.uiCardData as any) || {}).subjectLabel || "your surrogate";
    // Dual-audience deadline: parent copy in the parent's zone, provider copy in theirs.
    const finBooking = await this.prisma.booking.findUnique({ where: { id: bookingId }, select: { bookerTimezone: true, providerUserId: true } }).catch(() => null);
    const matchProviderTz = await resolveProviderTimezone(this.prisma, finBooking?.providerUserId, finBooking?.bookerTimezone);
    const matchParentTz = finBooking?.bookerTimezone || matchProviderTz;
    const deadlineParent = formatWhen(dueAt, matchParentTz);
    const deadlineProvider = formatWhen(dueAt, matchProviderTz);
    // Dual-audience message: `content` is the parent-facing copy, and
    // `uiCardData.providerContent` is the provider-phrased variant the
    // provider chat renders instead (the agency SENDS the invoice, they
    // don't pay it). One message, adapted per viewer.
    const provider = await this.prisma.provider.findUnique({
      where: { id: session.providerId },
      select: { name: true },
    }).catch(() => null);
    const providerName = provider?.name || "the agency";
    await this.prisma.aiChatMessage.create({
      data: {
        sessionId: providerSessionId,
        role: "assistant",
        content: `Congratulations, ${parentLabel} - IT'S A MATCH! 🎉

You said yes, ${who} said yes, and we couldn't be happier for you. This is one of those moments this whole journey is about - take a second to soak it in.

One last step to make it official: your deposit invoice is coming right up below. Complete it by ${deadlineParent} and the match is yours.`,
        senderType: "system",
        senderName: "GoStork",
        uiCardData: {
          celebration: "match_confirmed",
          bookingId,
          providerContent: `It's a match, ${providerName}! 🎉

${parentLabel} said yes, and you confirmed on ${who}'s side - congratulations on the new match. The deposit invoice has been sent to ${parentLabel} automatically; once they complete the payment by ${deadlineProvider}, the match is locked in. We'll let you know the moment it's paid.`,
        },
      },
    }).catch(() => {});

    await this.sendPaymentNotificationsToParent(invoice.id);
    this.scheduleCountdownReminders(invoice.id, dueAt);

    this.logger.log(`Match finalized for booking ${bookingId}: invoice ${invoice.id}, due ${dueAt.toISOString()}`);
    return { status: "finalized", invoiceId: invoice.id };
  }

  /**
   * Phase 4: the agency answered "no" on the surrogate's behalf - the match
   * is off. Release the hold immediately and let the parent know gently.
   */
  async releaseMatchAfterProviderDecline(providerSessionId: string, subjectLabel: string | null) {
    const session = await this.prisma.aiChatSession.findUnique({
      where: { id: providerSessionId },
      select: { userId: true, providerId: true, subjectProfileId: true, subjectType: true, provider: { select: { name: true } } },
    });
    if (!session) return;
    if (session.subjectProfileId && (session.subjectType || "").toLowerCase().includes("surrog")) {
      await this.prisma.surrogate.updateMany({
        where: { id: session.subjectProfileId, reservedByParentId: session.userId },
        data: { reservedByParentId: null, reservationExpiresAt: null, status: "AVAILABLE" },
      }).catch(() => {});
    }
    const parentSession = await this.prisma.aiChatSession.findFirst({
      where: { userId: session.userId, status: "ACTIVE", sessionType: "PARENT" },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (parentSession) {
      const who = subjectLabel || "the surrogate";
      await this.prisma.aiChatMessage.create({
        data: {
          sessionId: parentSession.id,
          role: "assistant",
          content: `I have an update from ${session.provider?.name || "the agency"}: after the match call, ${who} has decided not to move forward at this time. I know that's disappointing - this happens sometimes, and it's about her circumstances, not about you. When you're ready, I'd love to help you find other wonderful matches. Want me to pull some options?`,
          senderType: "system",
          senderName: "GoStork",
        },
      }).catch(() => {});
    }
  }

  // Phase 4: a paid deposit makes the surrogate's 24h match-call hold
  // permanent - reservedByParentId stays, reservationExpiresAt is cleared so
  // the expiry sweep never releases her and the AI keeps excluding her.
  // No-op for non-surrogacy sessions or when no active hold exists.
  private async stickSurrogateHoldOnPayment(invoiceId: string) {
    try {
      const invoice = await this.prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: { sessionId: true, parentUserId: true, triggerSource: true },
      });
      if (!invoice?.sessionId) return;
      const session = await this.prisma.aiChatSession.findUnique({
        where: { id: invoice.sessionId },
        select: { subjectType: true, subjectProfileId: true },
      });
      if (!session?.subjectProfileId) return;
      const subjType = (session.subjectType || "").toLowerCase();
      // Payment settles the hold conversation for ANY subject type - close
      // open decision / release-warning cards so nothing keeps counting
      // down or nagging (must run before the surrogate branch's early
      // return).
      const holdCards = await this.prisma.aiChatMessage.findMany({
        where: { sessionId: invoice.sessionId, uiCardType: { in: ["donor_hold_decision", "donor_release_warning"] } },
        select: { id: true, uiCardData: true },
      });
      for (const c of holdCards) {
        const dd = (c.uiCardData as any) || {};
        if (dd.resolvedAt) continue;
        await this.prisma.aiChatMessage.update({
          where: { id: c.id },
          data: { uiCardData: { ...dd, resolvedAt: new Date().toISOString(), resolvedAs: "paid" } },
        }).catch(() => {});
      }
      if (subjType.includes("surrog")) {
        // The paid deposit is authoritative: she's MATCHED with this family
        // even if the hold/reservation step never ran (some flows - winback
        // reschedules, direct agreements - skip the double-yes hold, which
        // used to leave her AVAILABLE forever). Only a reservation held by a
        // DIFFERENT parent blocks the flip.
        const res = await this.prisma.surrogate.updateMany({
          where: {
            id: session.subjectProfileId,
            OR: [{ reservedByParentId: invoice.parentUserId }, { reservedByParentId: null }],
          },
          data: { reservationExpiresAt: null, reservedByParentId: invoice.parentUserId, status: "MATCHED" },
        });
        if (res.count > 0) {
          this.logger.log(`Surrogate ${session.subjectProfileId} status MATCHED (invoice ${invoiceId} paid)`);
        }
        return;
      }
      // Fresh egg donors: the paid deposit makes the commitment final - she
      // is now IN A CYCLE with this family and unavailable to everyone else
      // (ON_HOLD started at the readiness "I'm ready"; AVAILABLE covers
      // legacy journeys that predate the hold). Bank purchases (frozen eggs
      // / sperm vials) are inventory, not exclusivity - never flip those.
      if (subjType.includes("egg") && invoice.triggerSource !== "BANK_CHECKOUT") {
        const res = await this.prisma.eggDonor.updateMany({
          where: { id: session.subjectProfileId, status: { in: ["AVAILABLE", "ON_HOLD"] } },
          data: { status: "IN_CYCLE" },
        });
        if (res.count > 0) {
          this.logger.log(`Egg donor ${session.subjectProfileId} status IN_CYCLE (invoice ${invoiceId} paid)`);
        }
        // Phase 8: for egg donors the paid deposit IS the match moment -
        // unlock the "matched" review checkpoint.
        if (invoice.parentUserId) {
          const inv2 = await this.prisma.invoice.findUnique({ where: { id: invoiceId }, select: { providerId: true } }).catch(() => null);
          if (inv2?.providerId) {
            import("../../../review-prompts")
              .then(({ maybePostReviewPrompt }) => maybePostReviewPrompt({ parentUserId: invoice.parentUserId!, providerId: inv2.providerId, stage: "matched" }))
              .catch(() => {});
          }
        }
      }
    } catch (e: any) {
      this.logger.warn(`stickSurrogateHoldOnPayment failed for invoice ${invoiceId}: ${e.message}`);
    }
  }

  private async notifyAdminInvoicePaid(invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { parentUser: true },
    });
    if (!invoice) return;

    const admins = await this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" } },
      select: { id: true },
    });

    for (const admin of admins) {
      await this.prisma.inAppNotification.create({
        data: {
          userId: admin.id,
          eventType: "INVOICE_PAID",
          payload: {
            invoiceId: invoice.id,
            parentName: invoice.parentUser.name || invoice.parentUser.email,
            parentUserId: invoice.parentUserId,
            providerName: invoice.providerName,
            serviceType: humanizeLineServiceType(invoice.serviceType),
            serviceAmount: formatCents(invoice.serviceAmount),
            referralFee: formatCents(invoice.referralFeeAmount),
            providerPayout: formatCents(invoice.providerPayoutAmount),
            message: `Payment received: ${formatCents(invoice.serviceAmount)} from ${invoice.parentUser.name || invoice.parentUser.email} for ${invoice.providerName}. GoStork fee: ${formatCents(invoice.referralFeeAmount)}. Provider payout due: ${formatCents(invoice.providerPayoutAmount)}.`,
          },
        },
      });
    }

    await this.notificationService.sendInvoicePaidAdminNotification({
      invoiceId: invoice.id,
      parentName: invoice.parentUser.name || invoice.parentUser.email,
      parentUserId: invoice.parentUserId,
      providerName: invoice.providerName,
      serviceType: humanizeLineServiceType(invoice.serviceType),
      serviceAmountFormatted: formatCents(invoice.serviceAmount),
      referralFeeFormatted: formatCents(invoice.referralFeeAmount),
      providerPayoutFormatted: formatCents(invoice.providerPayoutAmount),
      sessionId: invoice.sessionId,
    });
  }

  // ─── Admin overrides ─────────────────────────────────────────────────────────

  async adminMarkPaid(invoiceId: string, adminUserId: string, notes: string) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException("Invoice not found");

    // Escrow (AT_CLEARANCE) invoices hold an uncaptured card authorization.
    // Marking one PAID without capturing would record revenue that never
    // moved - capture first, and fail LOUDLY if Stripe rejects so the admin
    // sees the real problem instead of a silently inconsistent invoice.
    let escrowCapture: { transactionId: string } | null = null;
    if (invoice.status === "AUTHORIZED" && invoice.medicalClearanceStatus === "PENDING" && invoice.stripePaymentIntentId) {
      try {
        escrowCapture = await capturePaymentIntent(invoice.stripePaymentIntentId);
      } catch (e: any) {
        throw new BadRequestException(
          `This invoice holds an uncaptured escrow authorization and Stripe refused the capture: ${e?.message}. ` +
          `Resolve the hold via the clearance flow (or in the Stripe Dashboard) before marking paid.`,
        );
      }
      await this.resolveClearanceTrackerCards(invoiceId, "CLEARED", "captured");
    }

    const updated = await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "PAID",
        paidAt: new Date(),
        manualOverride: true,
        adminNotes: notes,
        ...(escrowCapture ? {
          stripeTransactionId: escrowCapture.transactionId,
          capturedAt: new Date(),
          medicalClearanceStatus: "CLEARED",
          clearanceConfirmedAt: new Date(),
        } : {}),
      },
    });

    this.logger.log(`Invoice ${invoiceId} manually marked PAID by admin ${adminUserId}`);
    await this.reflectPaymentInChat(invoiceId, "PAID");
    await this.notifyAdminInvoicePaid(invoiceId);
    // Phase 5: admin manual-mark-paid also fires the agreement flow + handoff check
    await this.tryDraftAgreementOnPaid(invoiceId).catch(e =>
      this.logger.warn(`Agreement auto-draft failed for ${invoiceId} (admin manual path): ${e?.message}`),
    );
    if (invoice.sessionId) {
      await maybeCompleteHandoff(invoice.sessionId).catch(e =>
        this.logger.warn(`Handoff check failed for session ${invoice.sessionId}: ${e?.message}`),
      );
    }
    await this.emitPaymentReceipt(invoiceId).catch(e =>
      this.logger.warn(`Payment receipt emission failed for ${invoiceId}: ${e?.message}`),
    );
    // Admin manual-mark-paid also triggers the auto-transfer.
    try {
      const r = await this.connectService.createTransferForPaidInvoice(invoiceId);
      if (r.status === "failed") {
        await this.notifyAdminTransferFailed(invoiceId, r.reason).catch(() => {});
      }
    } catch (e: any) {
      this.logger.warn(`Auto-transfer raised unexpectedly for ${invoiceId} (admin manual path): ${e?.message}`);
    }
    return updated;
  }

  async adminInitiatePayout(invoiceId: string, adminUserId: string) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.status !== "PAID") throw new BadRequestException("Invoice must be PAID before initiating payout");

    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { payoutInitiatedAt: new Date() },
    });

    // Phase 2: trigger Dwolla transfer here. For now, just log and notify.
    this.logger.log(`Payout initiated for invoice ${invoiceId} by admin ${adminUserId} - manual transfer required: ${formatCents(invoice.providerPayoutAmount)} to ${invoice.providerName}`);

    // Notify admin team with exact transfer details
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" } },
      select: { id: true },
    });
    for (const admin of admins) {
      await this.prisma.inAppNotification.create({
        data: {
          userId: admin.id,
          eventType: "PAYOUT_INITIATED",
          payload: {
            invoiceId: invoice.id,
            providerName: invoice.providerName,
            amount: formatCents(invoice.providerPayoutAmount),
            message: `Payout initiated: transfer ${formatCents(invoice.providerPayoutAmount)} to ${invoice.providerName}`,
          },
        },
      });
    }
  }

  // ─── Queries ─────────────────────────────────────────────────────────────────

  async getInvoicesForAdmin(filters: {
    status?: string;
    payoutStatus?: string;
    providerId?: string;
    serviceType?: string;
    search?: string;
    dateFrom?: Date;
    dateTo?: Date;
    paidFrom?: Date;
    paidTo?: Date;
    page?: number;
    pageSize?: number;
    /** Column key from the admin table header, e.g. "amount". */
    sortBy?: string;
    sortDir?: "asc" | "desc";
  }) {
    const { status, payoutStatus, providerId, serviceType, search, dateFrom, dateTo, paidFrom, paidTo, page = 1, pageSize = 25, sortBy, sortDir = "desc" } = filters;
    const where: any = {};
    const andConditions: any[] = [];
    if (status && status !== "all") where.status = status;
    // Payout-status filter - mirrors the client derivePayoutStatus precedence
    // (bank completed > bank failed / transfer failed > transfer sent > pending)
    if (payoutStatus && payoutStatus !== "all") {
      if (payoutStatus === "received") {
        andConditions.push({ bankPayoutCompletedAt: { not: null } });
      } else if (payoutStatus === "failed") {
        andConditions.push({
          bankPayoutCompletedAt: null,
          OR: [{ bankPayoutFailedAt: { not: null } }, { payoutFailedAt: { not: null } }],
        });
      } else if (payoutStatus === "sent") {
        andConditions.push({
          stripeTransferId: { not: null },
          bankPayoutCompletedAt: null,
          bankPayoutFailedAt: null,
          payoutFailedAt: null,
        });
      } else if (payoutStatus === "pending") {
        andConditions.push({
          status: "PAID",
          stripeTransferId: null,
          payoutFailedAt: null,
          bankPayoutFailedAt: null,
          bankPayoutCompletedAt: null,
        });
      }
    }
    if (providerId) where.providerId = providerId;
    if (serviceType && serviceType !== "all") where.serviceType = serviceType;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = dateFrom;
      if (dateTo) where.createdAt.lte = dateTo;
    }
    // Date range filters on the same date shown in the UI's "Date" column:
    // the paid date when the invoice has been paid, otherwise the created date.
    // (Filtering paidAt alone would return nothing for AWAITING_PAYMENT invoices,
    // which have a null paidAt - that was the original bug.)
    if (paidFrom || paidTo) {
      const range: any = {};
      if (paidFrom) range.gte = paidFrom;
      if (paidTo) range.lte = paidTo;
      andConditions.push({
        OR: [
          { paidAt: { not: null, ...range } },
          { paidAt: null, createdAt: range },
        ],
      });
    }
    // Free-text search across parent name/email, provider name, invoice id, session id.
    const term = search?.trim();
    if (term) {
      andConditions.push({
        OR: [
          { id: { contains: term, mode: "insensitive" } },
          { sessionId: { contains: term, mode: "insensitive" } },
          { providerName: { contains: term, mode: "insensitive" } },
          { parentUser: { is: { name: { contains: term, mode: "insensitive" } } } },
          { parentUser: { is: { email: { contains: term, mode: "insensitive" } } } },
        ],
      });
    }
    if (andConditions.length > 0) where.AND = andConditions;

    const [invoices, total, distinctServiceTypes] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: {
          // Full contact card for the expanded row - admin uses this to
          // recognize the parent and chase unpaid invoices.
          parentUser: {
            select: {
              id: true,
              name: true,
              firstName: true,
              lastName: true,
              email: true,
              mobileNumberDisplay: true,
              mobileNumber: true,
              createdAt: true,
              parentAccount: {
                select: {
                  members: { select: { id: true, name: true, email: true } },
                },
              },
            },
          },
        },
        // Sorting has to happen here, not in the client: the table is
        // paginated, so a client-side sort would only reorder the 25 rows
        // already on screen and quietly lie about "highest amount".
        orderBy: ADMIN_INVOICE_ORDER_BY[sortBy || ""]?.(sortDir) || { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({ distinct: ["serviceType"], select: { serviceType: true }, orderBy: { serviceType: "asc" } }),
    ]);

    // Aggregate stats
    const stats = await this.prisma.invoice.aggregate({
      where: { status: "PAID" },
      _sum: { serviceAmount: true, referralFeeAmount: true },
    });
    // "Payouts Sent" = transfers that actually went out. Summing the provider
    // share of every paid invoice (old behavior) silently counted pending and
    // FAILED payouts as sent and disagreed with the Home dashboard.
    const sentStats = await this.prisma.invoice.aggregate({
      where: { status: "PAID", stripeTransferId: { not: null } },
      _sum: { providerPayoutAmount: true },
    });

    const pendingStats = await this.prisma.invoice.aggregate({
      where: { status: { in: ["AWAITING_PAYMENT", "AUTHORIZED"] } },
      _sum: { serviceAmount: true },
    });

    return {
      invoices,
      total,
      page,
      pageSize,
      serviceTypes: distinctServiceTypes.map((s) => s.serviceType).filter(Boolean),
      totalRevenue: stats._sum.serviceAmount || 0,
      totalGoStorkFees: stats._sum.referralFeeAmount || 0,
      totalProviderPayouts: sentStats._sum.providerPayoutAmount || 0,
      pendingAmount: pendingStats._sum.serviceAmount || 0,
    };
  }

  async getInvoiceByToken(paymentToken: string) {
    return this.prisma.invoice.findUnique({
      where: { paymentToken },
      include: {
        parentUser: { select: { id: true, name: true, email: true } },
        lineItems: { orderBy: { displayOrder: "asc" } },
      },
    });
  }

  /**
   * Mints (or retrieves) wire-transfer instructions for an invoice. Used by
   * the public payment page when the parent picks "Pay by bank wire".
   *
   * Idempotent: if the invoice already has cached wireInstructionsJson the
   * cached copy is returned. If we have a wire PaymentIntent ID but the JSON
   * was lost (e.g. partial DB write), we re-fetch from Stripe before falling
   * back to creating a fresh intent. The freshly-minted intent + JSON are
   * persisted and the parent receives an email copy of the instructions.
   *
   * Returns a structured success / error so the controller can map the right
   * HTTP status without leaking internals.
   */
  async createWireTransferInstructions(
    paymentToken: string,
  ): Promise<{ instructions: WireInstructions } | { error: string; statusCode: number }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { paymentToken },
      include: { parentUser: true },
    });
    if (!invoice) return { error: "Invoice not found", statusCode: 404 };

    // Block any state where a wire would be wrong: already-paid, expired,
    // cancelled. Surface the actual status so the UI can show something
    // useful instead of a generic 400.
    //
    // Escrow (AT_CLEARANCE) invoices ARE wire-eligible under the hybrid
    // flow: customer_balance can't be manual-captured, so the wire skips
    // the hold phase and lands straight in the vault - the succeeded
    // webhook marks the invoice PAID with clearance still PENDING, and the
    // CLEARANCE_PENDING transfer gate keeps the funds from the provider
    // until clearance is confirmed.
    if (["PAID", "PAYMENT_PROCESSING", "EXPIRED", "CANCELLED", "REFUNDED"].includes(invoice.status)) {
      return { error: `Invoice is ${invoice.status}; wire transfer not available`, statusCode: 400 };
    }
    if (!invoice.parentUser?.email) {
      return { error: "Parent email missing on invoice", statusCode: 400 };
    }

    // Fast path: cached instructions on the invoice.
    if (invoice.wireInstructionsJson) {
      return { instructions: invoice.wireInstructionsJson as unknown as WireInstructions };
    }

    // Recovery path: we have a PI but no cached JSON (interrupted write).
    if (invoice.stripeWirePaymentIntentId) {
      const recovered = await retrieveBankTransferInstructions(
        invoice.stripeWirePaymentIntentId,
        invoice.serviceAmount,
        invoice.currency || "USD",
      );
      if (recovered) {
        await this.prisma.invoice.update({
          where: { id: invoice.id },
          data: { wireInstructionsJson: recovered as any },
        });
        return { instructions: recovered };
      }
    }

    // Cold path: mint a fresh customer_balance PaymentIntent.
    const customerId = await getOrCreateStripeCustomer({
      userId: invoice.parentUser.id,
      email: invoice.parentUser.email,
      name: invoice.parentUser.name || null,
      existingCustomerId: (invoice.parentUser as any).stripeCustomerId || null,
    });
    if (customerId && customerId !== (invoice.parentUser as any).stripeCustomerId) {
      await this.prisma.user.update({
        where: { id: invoice.parentUser.id },
        data: { stripeCustomerId: customerId },
      });
    }

    const instructions = await createBankTransferPaymentIntent({
      amountCents: invoice.serviceAmount,
      currency: invoice.currency || "USD",
      invoiceId: invoice.id,
      paymentToken: invoice.paymentToken,
      customerId,
      description: `GoStork - ${invoice.providerName} - ${humanizeLineServiceType(invoice.serviceType)}`,
    });

    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        stripeWirePaymentIntentId: instructions.paymentIntentId,
        wireInstructionsJson: instructions as any,
      },
    });

    await this.notificationService.sendWireInstructionsNotification({ invoiceId: invoice.id }).catch(e =>
      this.logger.warn(`Wire-instructions email failed for ${invoice.id}: ${e?.message}`),
    );

    this.logger.log(`Wire instructions issued for invoice ${invoice.id} (PI ${instructions.paymentIntentId}, ref ${instructions.reference})`);
    return { instructions };
  }

  async getInvoicesForParent(parentUserId: string) {
    return this.prisma.invoice.findMany({
      where: { parentUserId },
      orderBy: { createdAt: "desc" },
    });
  }

  async getInvoicesForProvider(providerId: string) {
    const invoices = await this.prisma.invoice.findMany({
      where: { providerId },
      include: {
        // Same contact card the admin dashboard gets - the provider uses
        // it to recognize the parent and chase unpaid invoices.
        parentUser: {
          select: {
            id: true,
            name: true,
            firstName: true,
            lastName: true,
            email: true,
            mobileNumberDisplay: true,
            mobileNumber: true,
            createdAt: true,
            parentAccountId: true,
            parentAccount: {
              select: {
                members: { select: { id: true, name: true, email: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Every row here has an Invoice, which by definition opened Gate B - so in
    // practice nothing is redacted. It still runs through the helper rather than
    // relying on that, because the invariant is invisible from this file and a
    // future draft-invoice row would silently start leaking. Note BOTH phone
    // fields are selected: nulling one and not the other would change nothing.
    const gates = await resolveParentGatesBatch(
      providerId,
      invoices.map((i: any) => ({ accountKey: parentAccountKey(i.parentUser) })),
      this.prisma,
    );
    return invoices.map((i: any) => ({
      ...i,
      parentUser: redactParentContact(i.parentUser, gates.get(parentAccountKey(i.parentUser)) || GATES_CLOSED),
    }));
  }

  // ─── On-demand invoice document (provider view) ────────────────────────────
  //
  // Returns the same artifact the parent received:
  //   - PAID invoices  -> the receipt PDF that was emailed (regenerated
  //                        from current data, so any branding tweaks land).
  //   - UNPAID         -> an HTML page styled like the payment-request
  //                        email body, with no payment buttons (provider
  //                        is just inspecting, not paying).
  //
  // We don't store the PDF; receipts are regenerated on demand. Cheap
  // enough at our volume and lets brand/legal-identity edits flow through
  // retroactively.
  async getInvoiceDocumentForProvider(invoiceId: string, providerId: string | null): Promise<
    | { kind: "pdf"; pdf: Buffer; filename: string }
    | { kind: "html"; html: string; filename: string }
  > {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        parentUser: true,
        lineItems: { orderBy: { displayOrder: "asc" } },
      },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    // providerId null = GoStork admin (the controller only passes null after
    // verifying the role) - admins span every org, so the ownership check is
    // skipped rather than forcing the client to thread a providerId it does
    // not have on every surface.
    if (providerId !== null && invoice.providerId !== providerId) {
      throw new NotFoundException("Invoice not found");
    }

    const [brandSettings, legalIdentity] = await Promise.all([
      this.prisma.providerBrandSettings.findUnique({
        where: { providerId: invoice.providerId },
        select: { primaryColor: true, logoUrl: true },
      }),
      this.prisma.providerLegalIdentity.findUnique({
        where: { providerId: invoice.providerId },
        select: { legalName: true, taxId: true },
      }),
    ]);

    const lineItems = (invoice as any).lineItems || [];
    const currency = invoice.currency || "USD";

    // PAID -> regenerate the receipt PDF exactly like emitPaymentReceipt
    // does, then stream it back.
    if (invoice.status === "PAID") {
      let logoBuffer: Buffer | null = null;
      if (brandSettings?.logoUrl) {
        try {
          const res = await fetch(brandSettings.logoUrl);
          if (res.ok) {
            const ct = res.headers.get("content-type") || "";
            if (/png|jpeg|jpg/i.test(ct)) {
              const ab = await res.arrayBuffer();
              logoBuffer = Buffer.from(ab);
            }
          }
        } catch {
          /* fall back to wordmark layout */
        }
      }
      const card = invoice.stripePaymentIntentId
        ? await getCardDetailsForPaymentIntent(invoice.stripePaymentIntentId)
        : { brand: null, last4: null, expMonth: null, expYear: null };
      const paidAt = invoice.paidAt || new Date();
      const receiptNumber = `GS-${paidAt.toISOString().slice(0, 10).replace(/-/g, "")}-${invoice.id.slice(0, 8).toUpperCase()}`;

      const pdf = await generateReceiptPdf({
        invoice: {
          id: invoice.id,
          invoiceNumber: (invoice as any).invoiceNumber ?? null,
          serviceAmount: invoice.serviceAmount,
          referralFeeAmount: invoice.referralFeeAmount,
          providerPayoutAmount: invoice.providerPayoutAmount,
          currency,
          serviceType: humanizeLineServiceType(invoice.serviceType),
          providerName: invoice.providerName,
          description: invoice.description || null,
          paidAt,
          isProtected: invoice.isProtected ?? false,
          stripeTransactionId: invoice.stripeTransactionId || null,
          stripePaymentIntentId: invoice.stripePaymentIntentId || null,
          lineItems: lineItems.map((li: any) => ({
            serviceType: li.serviceType,
            serviceTypeLabel: humanizeLineServiceType(li.serviceType),
            description: li.description,
            amountCents: li.amountCents,
          })),
        },
        parent: {
          name: invoice.parentUser?.name || (invoice.parentUser as any)?.firstName || "Customer",
          email: invoice.parentUser?.email || "",
          city: (invoice.parentUser as any)?.city || null,
          state: (invoice.parentUser as any)?.state || null,
        },
        card,
        brand: {
          // Falls back to GoStork's LIVE primary, not a hex typed here - the PDF
          // otherwise printed a retired green for any agency without a brand colour.
          primaryColor: brandSettings?.primaryColor || await platformPrimaryColor(this.prisma),
          logoBuffer,
          legalName: legalIdentity?.legalName || invoice.providerName,
          taxId: legalIdentity?.taxId || null,
        },
      });
      return {
        kind: "pdf",
        pdf,
        filename: `GoStork-Receipt-${receiptNumber}.pdf`,
      };
    }

    // UNPAID -> render a document-style HTML page showing what the
    // parent sees in their payment-request email + on /pay/{token}.
    // Inline styles only so the same markup looks right whether the
    // provider opens it in the browser or prints to PDF.
    // The agency's own colour when they have set one - this is THEIR payment
    // request, carrying their logo. Otherwise GoStork's live primary, read
    // from SiteSettings rather than typed here, so it follows a rebrand. It
    // used to fall back to #26584A, a green GoStork had already retired: every
    // provider without a brand colour was billing in it.
    const brandColor = brandSettings?.primaryColor || await platformPrimaryColor(this.prisma);
    const parentFirstName = invoice.parentUser?.name?.split(" ")[0] || (invoice.parentUser as any)?.firstName || "there";
    const escHtml = (s: string) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    const lineRowsHtml = (lineItems.length > 0
      ? lineItems
      : [{ serviceType: humanizeLineServiceType(invoice.serviceType), description: invoice.description, amountCents: invoice.serviceAmount }]
    )
      .map((li: any) => `
        <tr>
          <td style="text-align:left;padding:12px 8px 12px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#1f2937;vertical-align:top">
            <div style="font-weight:500">${escHtml(humanizeLineServiceType(li.serviceType || ""))}</div>
            ${li.description ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">${escHtml(li.description)}</div>` : ""}
          </td>
          <td style="text-align:right;padding:12px 0 12px 8px;border-bottom:1px solid #f3f4f6;font-size:14px;color:#1f2937;white-space:nowrap;vertical-align:top">${escHtml(formatCents(li.amountCents))}</td>
        </tr>
      `).join("");

    const statusBadge = invoice.status === "PAYMENT_PROCESSING"
      ? `<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:#fef3c7;color:#92400e;font-size:12px;font-weight:600">Payment processing</span>`
      : invoice.status === "AUTHORIZED"
        ? `<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:#dbeafe;color:#1e40af;font-size:12px;font-weight:600">Authorized (held)</span>`
        : invoice.status === "AWAITING_PAYMENT"
          ? `<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:#fef3c7;color:#92400e;font-size:12px;font-weight:600">Awaiting payment</span>`
          : `<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:#f3f4f6;color:#374151;font-size:12px;font-weight:600">${escHtml(invoice.status)}</span>`;

    const dueLine = invoice.dueAt
      ? `<p style="margin:16px 0 0;font-size:13px;color:#92400e"><strong>Due by ${escHtml(new Date(invoice.dueAt).toLocaleString())}</strong></p>`
      : "";

    const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Invoice ${escHtml(invoice.id.slice(0, 8))} - ${escHtml(invoice.providerName)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; padding: 24px; background: #ffffff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1f2937; }
  .doc { max-width: 720px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
  .header { background: ${escHtml(brandColor)}; color: white; padding: 48px 32px; text-align: center; }
  .header h1 { margin: 0; font-size: 28px; letter-spacing: -0.02em; }
  .header .logo { max-height: 56px; max-width: 220px; margin-bottom: 16px; }
  .body { padding: 32px; }
  .meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; gap: 12px; flex-wrap: wrap; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  .totals-row td { padding: 16px 0 4px; font-weight: 700; font-size: 16px; }
  .total-value { color: ${escHtml(brandColor)}; font-size: 22px; }
  .detail-grid { display: grid; grid-template-columns: 160px 1fr; gap: 12px 16px; margin-top: 24px; font-size: 14px; }
  .detail-grid dt { color: #6b7280; }
  .footer { padding: 24px 32px; background: #ffffff; font-size: 12px; color: #6b7280; text-align: center; border-top: 1px solid #e5e7eb; }
  .provider-note { padding: 16px; background: #f3f4f6; border-radius: 8px; margin-top: 24px; font-size: 13px; color: #374151; }
</style>
</head><body>
<div class="doc">
  <div class="header">
    ${brandSettings?.logoUrl ? `<img class="logo" src="${escHtml(brandSettings.logoUrl)}" alt="${escHtml(invoice.providerName)}">` : ""}
    <h1>${escHtml(legalIdentity?.legalName || invoice.providerName)}</h1>
  </div>
  <div class="body">
    <div class="meta">
      <div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;font-weight:600">Payment Request</div>
        <div style="font-size:13px;color:#6b7280;margin-top:4px">Invoice #${escHtml(invoice.id.slice(0, 8).toUpperCase())} • ${escHtml(new Date(invoice.createdAt).toLocaleDateString())}</div>
      </div>
      ${statusBadge}
    </div>
    <p style="margin:8px 0 4px;font-size:15px">Hi ${escHtml(parentFirstName)}, you have a payment request from <strong>${escHtml(invoice.providerName)}</strong> via GoStork.</p>
    ${dueLine}
    <table>
      <thead>
        <tr>
          <th style="text-align:left;padding:12px 8px 12px 0;border-bottom:1px solid #e5e7eb;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;font-weight:600">Service</th>
          <th style="text-align:right;padding:12px 0 12px 8px;border-bottom:1px solid #e5e7eb;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;font-weight:600">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${lineRowsHtml}
        <tr class="totals-row">
          <td>Total</td>
          <td style="text-align:right" class="total-value">${escHtml(formatCents(invoice.serviceAmount))}</td>
        </tr>
      </tbody>
    </table>
    <dl class="detail-grid">
      <dt>Provider</dt><dd>${escHtml(invoice.providerName)}</dd>
      <dt>GoStork Deposit Protection</dt><dd>Included - your funds are protected</dd>
      ${legalIdentity?.taxId ? `<dt>Tax ID</dt><dd>${escHtml(legalIdentity.taxId)}</dd>` : ""}
    </dl>
    <div class="provider-note">
      This is the invoice document that was sent to the parent. The parent receives it via email, SMS, and inside the chat with a "Pay Now Securely" button.
    </div>
  </div>
  <div class="footer">Powered by GoStork • Secure payments processed by Stripe</div>
</div>
</body></html>`;

    return {
      kind: "html",
      html,
      filename: `Invoice-${invoice.id.slice(0, 8).toUpperCase()}.html`,
    };
  }

  // ─── Stub: QuickBooks sync ───────────────────────────────────────────────────

  async syncToQuickBooks(invoiceId: string) {
    // Phase 2: connect to QBO API and create Payment + Expense records
    this.logger.log(`QuickBooks sync pending for invoice ${invoiceId} (Phase 2 - not yet implemented)`);
  }
}
