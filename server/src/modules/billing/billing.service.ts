import { Injectable, Inject, Logger, NotFoundException, BadRequestException } from "@nestjs/common";
import { NotificationService } from "../notifications/notification.service";
import { prisma as prismaClient } from "../../../db";
import { generateReceiptPdf } from "./receipt-pdf";
import {
  getCardDetailsForPaymentIntent,
  getOrCreateStripeCustomer,
  createBankTransferPaymentIntent,
  retrieveBankTransferInstructions,
  type WireInstructions,
} from "../../../stripe-service";

function getBaseUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "development") {
    const port = process.env.PORT || 5001;
    return `http://localhost:${port}`;
  }
  return "https://app.gostork.com";
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Maps provider type names to human-readable service types
function resolveServiceType(providerTypeName: string | undefined): string {
  if (!providerTypeName) return "Fertility Service";
  const name = providerTypeName.toLowerCase();
  if (name.includes("ivf") || name.includes("clinic")) return "IVF Treatment";
  if (name.includes("egg donor")) return "Egg Donation";
  if (name.includes("sperm")) return "Sperm Donation";
  if (name.includes("surrogacy")) return "Surrogacy";
  if (name.includes("egg bank")) return "Egg Donation";
  return "Fertility Service";
}

// Maps the line-item enum (DB-stored) to a parent-facing label.
export function humanizeLineServiceType(t: string): string {
  switch ((t || "").toUpperCase()) {
    case "SURROGACY": return "Surrogacy";
    case "EGG_DONATION": return "Egg Donation";
    case "SPERM_DONATION": return "Sperm Donation";
    case "IVF_CLINIC": return "IVF Clinic";
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
  return "OTHER";
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  private readonly prisma = prismaClient;

  constructor(
    @Inject(NotificationService) private readonly notificationService: NotificationService,
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
  ): { referralFeeAmount: number; providerPayoutAmount: number } {
    let referralFeeAmount = 0;
    if (config.feeType === "FLAT") {
      referralFeeAmount = Math.round(Number(config.flatAmount) || 0);
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
    triggerSource?: "PROVIDER_MANUAL" | "ADMIN_MANUAL" | "AUTO_READINESS";
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
    } = params;

    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
      include: {
        referralFeeConfigs: true,
        services: { include: { providerType: true } },
        brandSettings: { select: { legalName: true, taxId: true } },
        w9: { select: { status: true } },
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

    // Billing Identity must be complete before any invoice (manual or automatic)
    // can be issued: Legal Name, Tax ID, and a signed W-9 are all required.
    const missingIdentity: string[] = [];
    if (!provider.brandSettings?.legalName?.trim()) missingIdentity.push("Legal Name");
    if (!provider.brandSettings?.taxId?.trim()) missingIdentity.push("Tax ID");
    if (provider.w9?.status !== "COMPLETED") missingIdentity.push("W-9");
    if (missingIdentity.length > 0) {
      throw new BadRequestException(
        `Billing Identity is incomplete - please add ${missingIdentity.join(", ")} in the Billing tab before sending an invoice.`,
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
    const primaryServiceType = primaryServiceTypeFromServices
      ?? Array.from(configByService.keys())[0];
    const primaryConfig = configByService.get(primaryServiceType)!;

    // Resolve what the parent actually pays + GoStork's fee.
    let parentPaysCents: number;
    let referralFeeAmount: number;
    let providerPayoutAmount: number;

    if (hasLineItems) {
      // Per-line fee calculation: each line uses its own service's config.
      // PERCENTAGE -> % of the line amount. FLAT -> the flat fee once per line.
      parentPaysCents = lineItemsSumCents;
      let totalFee = 0;
      for (const li of lineItems!) {
        const cfg = configByService.get(li.serviceType)!;
        const { referralFeeAmount: lineFee } = this.computeFee(cfg, li.amountCents, li.amountCents);
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

      const computed = this.computeFee(primaryConfig, feeBasisCents, parentPaysCents);
      referralFeeAmount = computed.referralFeeAmount;
      providerPayoutAmount = computed.providerPayoutAmount;
    }

    // When line items are supplied, the invoice's primary serviceType comes
    // from the FIRST line item rather than the provider's first service - so
    // legacy code paths that read invoice.serviceType still render a sensible
    // headline (e.g. "Surrogacy" instead of "Egg Donation").
    const headlineServiceType = hasLineItems
      ? humanizeLineServiceType(lineItems![0].serviceType)
      : resolveServiceType(provider.services.find(s => s.status === "APPROVED")?.providerType?.name
          ?? provider.services[0]?.providerType?.name);

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
      const message = err?.message || "Could not create invoice";
      if (/No active referral fee/.test(message)) return { status: "blocked", reason: "NO_CONFIG", message };
      if (/Billing Identity is incomplete/.test(message)) return { status: "blocked", reason: "BILLING_IDENTITY_INCOMPLETE", message };
      if (/cost sheet/.test(message)) return { status: "blocked", reason: "NO_QUOTE", message };
      if (/Default First Payment/.test(message)) return { status: "blocked", reason: "NO_DEFAULT_PAYMENT", message };
      throw err;
    }
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

    const base = getBaseUrl();
    const paymentUrl = `${base}/pay/${invoice.paymentToken}`;
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
        content: `A payment request has been sent to you for your service with ${invoice.providerName}. Please complete payment to continue your journey.`,
        senderType: "system",
        senderName: "GoStork",
        uiCardType: "invoice",
        uiCardData: {
          invoiceId: invoice.id,
          paymentToken: invoice.paymentToken,
          paymentUrl,
          providerName: invoice.providerName,
          serviceType: invoice.serviceType,
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
      serviceType: invoice.serviceType,
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

  // ─── Post readiness prompt in chat after video call ends ────────────────────

  async postReadinessPromptToChat(params: {
    sessionId: string;
    bookingId: string;    // used for per-booking dedup
    providerName: string;
    providerType: string;
    isMatchCall: boolean; // true for surrogacy match calls
    dueAt?: Date;         // for surrogacy 24h countdown
  }) {
    const { sessionId, bookingId, providerName, providerType, isMatchCall, dueAt } = params;

    let content = "";
    let buttonLabel = "Yes, I'm Ready";

    if (providerType === "Surrogacy Agency" && isMatchCall) {
      const deadline = dueAt
        ? new Date(dueAt).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : "within 24 hours";
      content = `Your match call is complete! ${providerName} has reserved this surrogate exclusively for you until ${deadline}. Confirm your deposit now to secure your match - after the deadline, she may be matched with another family.`;
      buttonLabel = "Reserve Now - Pay Deposit";
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
    const paymentUrl = `${base}/pay/${invoice.paymentToken}`;
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
          uiCardData: reminderType !== "expired" ? {
            invoiceId: invoice.id,
            paymentToken: invoice.paymentToken,
            paymentUrl,
            status: invoice.status,
            dueAt: invoice.dueAt?.toISOString() || null,
          } : null,
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

  // ─── Schedule clearance follow-up check-ins (AT_CLEARANCE flow) ─────────────

  scheduleClearanceFollowUps(invoiceId: string, averageClearanceDays: number) {
    const checkInDays = [
      Math.max(1, averageClearanceDays - 7),
      averageClearanceDays,
      averageClearanceDays + 7,
    ];

    for (const day of checkInDays) {
      const delay = day * 24 * 60 * 60 * 1000;
      const reminderType = `clearance_day${day}`;
      setTimeout(() => this.sendClearanceCheckIn(invoiceId, reminderType), delay);
      this.logger.log(`Scheduled clearance check-in at day ${day} for invoice ${invoiceId}`);
    }
  }

  private async sendClearanceCheckIn(invoiceId: string, reminderType: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { parentUser: true },
    });
    if (!invoice || invoice.status !== "AUTHORIZED") return;

    const content = `Just checking in on your journey with ${invoice.providerName}. Has your surrogate passed her medical screening? Please let us know so we can process your payment and move to the next step.`;

    await this.prisma.aiChatMessage.create({
      data: {
        sessionId: invoice.sessionId,
        role: "assistant",
        content,
        senderType: "system",
        senderName: "GoStork",
        uiCardType: "clearance_tracker",
        uiCardData: {
          invoiceId: invoice.id,
          providerName: invoice.providerName,
          medicalClearanceStatus: invoice.medicalClearanceStatus,
          confirmAction: "CONFIRM_CLEARANCE",
          failAction: "REPORT_CLEARANCE_FAILURE",
        },
      },
    });

    await this.prisma.invoiceReminder.create({
      data: { invoiceId, channel: "chat", reminderType },
    });
  }

  // ─── Stripe authorization / capture / void (AT_CLEARANCE flow) ───────────

  async placeAuthorization(invoiceId: string, authorizationId: string) {
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "AUTHORIZED",
        stripePaymentIntentId: authorizationId,
        authorizedAt: new Date(),
        medicalClearanceStatus: "PENDING",
      },
    });

    // Post clearance tracker card in chat
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { parentUser: true },
    });
    if (invoice) {
      await this.prisma.aiChatMessage.create({
        data: {
          sessionId: invoice.sessionId,
          role: "assistant",
          content: `Your funds are now securely held in GoStork's vault. We will release them to ${invoice.providerName} once the surrogate passes her medical clearance. If clearance fails, your hold is instantly canceled at no cost. Your match is protected by the GoStork Guarantee.`,
          senderType: "system",
          senderName: "GoStork",
          uiCardType: "clearance_tracker",
          uiCardData: {
            invoiceId: invoice.id,
            providerName: invoice.providerName,
            medicalClearanceStatus: "PENDING",
            isProtected: true,
            confirmAction: "CONFIRM_CLEARANCE",
            failAction: "REPORT_CLEARANCE_FAILURE",
          },
        },
      });
    }

    this.logger.log(`Invoice ${invoiceId} authorized (pre-auth placed)`);
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
    await this.notifyAdminInvoicePaid(invoiceId);
  }

  async voidAuthorization(invoiceId: string) {
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "CLEARANCE_FAILED",
        medicalClearanceStatus: "FAILED",
        clearanceConfirmedAt: new Date(),
      },
    });

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { parentUser: true },
    });
    if (invoice) {
      await this.prisma.aiChatMessage.create({
        data: {
          sessionId: invoice.sessionId,
          role: "assistant",
          content: `We're sorry to hear that your surrogate did not pass medical clearance. Your card hold has been fully released - no charges were made. Because you paid through GoStork, your deposit is protected by the GoStork Guarantee. You can apply your deposit to any other agency on the GoStork platform. Our team will reach out to help you with your next steps.`,
          senderType: "system",
          senderName: "GoStork",
          uiCardType: "text",
          uiCardData: null,
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
              message: `GoStork Guarantee activated: ${invoice.parentUser.name || "Parent"}'s surrogate from ${invoice.providerName} failed medical clearance. Deposit of ${formatCents(invoice.serviceAmount)} ready to redirect.`,
            },
          },
        });
      }
    }

    this.logger.log(`Invoice ${invoiceId} voided - clearance failed`);
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
      if (invoice.status === "AUTHORIZED") return;
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: "AUTHORIZED", authorizedAt: new Date(), paymentMethod: "CARD" },
      });
      await this.reflectPaymentInChat(invoice.id, "AUTHORIZED");
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

    await this.reflectPaymentInChat(invoice.id, "PAID");
    await this.notifyAdminInvoicePaid(invoice.id);
    await this.emitPaymentReceipt(invoice.id).catch(e =>
      this.logger.warn(`Payment receipt emission failed for ${invoice.id}: ${e?.message}`),
    );
    this.logger.log(`Invoice ${invoice.id} marked PAID via Stripe`);
  }

  /**
   * Generates the PDF receipt for a paid invoice and emails it to the parent
   * and the agency's billing recipients. Best-effort - failures here must not
   * roll back the PAID state. Called from every success path
   * (Stripe webhook + admin manual override).
   */
  private async emitPaymentReceipt(invoiceId: string) {
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

    // Look up the agency's billing-recipient emails. Falls back to all
    // provider users associated with the providerId so the agency reliably
    // receives the receipt even if no dedicated billing contact is set.
    let providerEmails: string[] = [];
    if (invoice.providerId) {
      const members = await this.prisma.user.findMany({
        where: { providerId: invoice.providerId, email: { not: null } },
        select: { email: true, billingRecipient: true },
      });
      const billingRecipients = members
        .filter((m: any) => m.billingRecipient === true && m.email)
        .map((m: any) => m.email as string);
      const fallback = members.filter((m: any) => m.email).map((m: any) => m.email as string);
      providerEmails = Array.from(new Set(billingRecipients.length > 0 ? billingRecipients : fallback));
    }

    // Card brand + last4 for the receipt.
    const card = invoice.stripePaymentIntentId
      ? await getCardDetailsForPaymentIntent(invoice.stripePaymentIntentId)
      : { brand: null, last4: null, expMonth: null, expYear: null };

    const paidAt = invoice.paidAt || new Date();
    const receiptNumber = `GS-${paidAt.toISOString().slice(0, 10).replace(/-/g, "")}-${invoice.id.slice(0, 8).toUpperCase()}`;

    // Agency brand settings drive the receipt's primary color, logo, legal
    // name, and tax ID. Logo bytes are fetched lazily - if the URL fails we
    // fall back to the wordmark layout.
    const brandSettings = invoice.providerId
      ? await this.prisma.providerBrandSettings.findUnique({
          where: { providerId: invoice.providerId },
          select: { primaryColor: true, logoUrl: true, legalName: true, taxId: true },
        })
      : null;

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
        serviceType: invoice.serviceType,
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
        primaryColor: brandSettings?.primaryColor || null,
        logoBuffer,
        legalName: brandSettings?.legalName || invoice.providerName,
        taxId: brandSettings?.taxId || null,
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
      serviceType: invoice.serviceType,
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
          content: `${parentLabel} has ${verb} ${amount} for ${invoice.serviceType} via ${invoice.providerName}. Thank you!`,
          senderType: "system",
          senderName: "GoStork",
        },
      });
    } catch (e: any) {
      this.logger.warn(`Failed to post payment confirmation message: ${e?.message}`);
    }
  }

  // ─── Admin notifications on payment ─────────────────────────────────────────

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
            serviceType: invoice.serviceType,
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
      providerName: invoice.providerName,
      serviceType: invoice.serviceType,
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

    const updated = await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "PAID",
        paidAt: new Date(),
        manualOverride: true,
        adminNotes: notes,
      },
    });

    this.logger.log(`Invoice ${invoiceId} manually marked PAID by admin ${adminUserId}`);
    await this.reflectPaymentInChat(invoiceId, "PAID");
    await this.notifyAdminInvoicePaid(invoiceId);
    await this.emitPaymentReceipt(invoiceId).catch(e =>
      this.logger.warn(`Payment receipt emission failed for ${invoiceId}: ${e?.message}`),
    );
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
    providerId?: string;
    dateFrom?: Date;
    dateTo?: Date;
    page?: number;
    pageSize?: number;
  }) {
    const { status, providerId, dateFrom, dateTo, page = 1, pageSize = 25 } = filters;
    const where: any = {};
    if (status && status !== "all") where.status = status;
    if (providerId) where.providerId = providerId;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = dateFrom;
      if (dateTo) where.createdAt.lte = dateTo;
    }

    const [invoices, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: {
          parentUser: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    // Aggregate stats
    const stats = await this.prisma.invoice.aggregate({
      where: { status: "PAID" },
      _sum: { serviceAmount: true, referralFeeAmount: true, providerPayoutAmount: true },
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
      totalRevenue: stats._sum.serviceAmount || 0,
      totalGoStorkFees: stats._sum.referralFeeAmount || 0,
      totalProviderPayouts: stats._sum.providerPayoutAmount || 0,
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
    // cancelled, or escrow-hold flow (customer_balance cannot be manual-
    // captured, so it can't back AT_CLEARANCE invoices). Surface the actual
    // status so the UI can show something useful instead of a generic 400.
    if (["PAID", "PAYMENT_PROCESSING", "EXPIRED", "CANCELLED", "REFUNDED"].includes(invoice.status)) {
      return { error: `Invoice is ${invoice.status}; wire transfer not available`, statusCode: 400 };
    }
    if (invoice.medicalClearanceStatus === "PENDING") {
      return {
        error: "Wire transfers are not available for escrow-hold invoices. Please use a card.",
        statusCode: 400,
      };
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
      description: `GoStork - ${invoice.providerName} - ${invoice.serviceType}`,
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
    return this.prisma.invoice.findMany({
      where: { providerId },
      include: {
        parentUser: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  // ─── Stub: QuickBooks sync ───────────────────────────────────────────────────

  async syncToQuickBooks(invoiceId: string) {
    // Phase 2: connect to QBO API and create Payment + Expense records
    this.logger.log(`QuickBooks sync pending for invoice ${invoiceId} (Phase 2 - not yet implemented)`);
  }
}
