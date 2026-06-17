/**
 * Stripe payment service for GoStork.
 *
 * Supports two flows:
 *   1. Standard capture (AT_MATCH)    - immediate charge via PaymentIntent
 *   2. Authorize-only (AT_CLEARANCE)  - manual capture for escrow hold until medical clearance
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY          - sk_test_... or sk_live_...
 *   STRIPE_WEBHOOK_SECRET      - whsec_... from Stripe Dashboard webhook settings
 */

import Stripe from "stripe";
import { getBaseUrl } from "./src/lib/get-base-url";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return new Stripe(key, { apiVersion: "2026-04-22.dahlia" });
}

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

// ─── Payment Link (hosted page, no auth required) ────────────────────────────

/**
 * Creates a Stripe Payment Link for standard (AT_MATCH) flow.
 * Parent visits the URL and pays by card. No pre-auth.
 */
export async function createPaymentLink(params: {
  amountCents: number;
  currency: string;
  invoiceId: string;
  paymentToken: string;
  parentEmail?: string;
  description: string;
  successUrl: string;
}): Promise<{ url: string; paymentLinkId: string }> {
  if (!isStripeConfigured()) {
    // Mock mode for development without Stripe keys
    return {
      url: `${getBaseUrl()}/pay/${params.paymentToken}?mock=1`,
      paymentLinkId: `mock_${Date.now()}`,
    };
  }

  const stripe = getStripe();

  // Create a product + price on the fly
  const product = await stripe.products.create({
    name: params.description,
    metadata: { invoiceId: params.invoiceId, paymentToken: params.paymentToken },
  });

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: params.amountCents,
    currency: params.currency.toLowerCase(),
  });

  const link = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    after_completion: {
      type: "redirect",
      redirect: { url: params.successUrl },
    },
    customer_creation: "always",
    metadata: { invoiceId: params.invoiceId, paymentToken: params.paymentToken },
  });

  return { url: link.url, paymentLinkId: link.id };
}

// ─── PaymentIntent for Drop-in UI (client secret flow) ───────────────────────

/**
 * Creates a PaymentIntent for use with Stripe Elements (embedded payment UI).
 * For AT_MATCH: capture_method = automatic (charged immediately on confirm).
 * For AT_CLEARANCE: capture_method = manual (authorized/held, captured later).
 */
/**
 * US-only checkout tile order. When the buyer's IP geolocates to the US we
 * pass this explicit list so Card + ACH lead, with BNPL options tucked
 * further down. Card automatically surfaces Apple Pay / Google Pay / Link
 * as wallet sub-options on supported devices - they don't need separate
 * entries here.
 *
 * For non-US buyers we fall back to automatic_payment_methods so Stripe
 * picks the optimal order for the buyer's country (Bancontact for BE,
 * iDEAL for NL, SEPA for EU, etc.) - hard-coding a US-flavored list would
 * just hurt conversion outside the US.
 *
 * Edit this constant (not the call site) when you want to change the
 * order or add/remove methods. The order in the array IS the tile order.
 */
// Just Card and US bank account. Two reasons we don't include BNPL
// (Klarna / Affirm / Cash App Pay) here:
//   1. Stripe Payment Element reorders payment_method_types based on its
//      own conversion-optimization heuristics regardless of the order we
//      pass. With BNPL in the list, it would slot Affirm between Card
//      and US bank account, which doesn't match the spec ("card then
//      bank for USA"). Removing them removes anything that could sneak
//      in between.
//   2. GoStork invoices are typically $5k-$20k for fertility services.
//      BNPL is designed for sub-$1000 retail and the providers don't
//      generally accept it for these amounts anyway.
// Apple Pay / Google Pay / Link still surface automatically as wallet
// buttons inside the Card tile on supported devices - no separate
// entries needed.
const US_PAYMENT_METHOD_ORDER = [
  "card",            // includes Apple Pay + Google Pay + Link wallets
  "us_bank_account", // ACH
] as const;

// ─── Payment Method Configuration (PMC) cache ───────────────────────────────
//
// PMC is Stripe's mechanism for per-method "display preference":
//   - "on"  -> show as a top-level tile in Payment Element
//   - "off" -> still available, but tucked behind the "More" dropdown
//   - "none" -> disabled entirely
//
// This is the only way to get Card + US bank account visible as the
// primary tiles AND keep BNPL (Klarna / Affirm / Cash App Pay) available
// for the parents who want them - just not promoted to the visible tile
// row. payment_method_types alone can't do this because Stripe's
// Payment Element reorders the array based on its own heuristics.
//
// We create one PMC named "GoStork checkout default" on first use and
// cache its id in-process. On every PaymentIntent create we pass
// payment_method_configuration: <pmcId> instead of payment_method_types.
// Cheap (one extra API call per cold start) and fully deterministic.
let cachedPmcIdPromise: Promise<string | null> | null = null;

async function getOrCreateGoStorkPmc(): Promise<string | null> {
  if (cachedPmcIdPromise) return cachedPmcIdPromise;
  cachedPmcIdPromise = (async () => {
    try {
      const stripe = getStripe();
      const PMC_NAME = "GoStork checkout default";

      // Find an existing PMC by our well-known name so we don't create a
      // new one on every server boot. If found, also UPDATE it - the
      // display preferences we want may have changed since the last
      // server version that ran. Update is idempotent (no diff = no
      // change in Stripe).
      const list = await stripe.paymentMethodConfigurations.list({ limit: 100 });
      const existing = list.data.find(p => p.name === PMC_NAME && !p.is_default);
      if (existing) {
        await stripe.paymentMethodConfigurations.update(existing.id, {
          card: { display_preference: { preference: "on" } },
          us_bank_account: { display_preference: { preference: "on" } },
          link: { display_preference: { preference: "on" } },
          apple_pay: { display_preference: { preference: "on" } },
          google_pay: { display_preference: { preference: "on" } },
          klarna: { display_preference: { preference: "on" } },
          affirm: { display_preference: { preference: "on" } },
          cashapp: { display_preference: { preference: "on" } },
        });
        return existing.id;
      }

      // First boot - create the PMC with every method enabled. Order
      // of the tiles is then Stripe's choice - the embedded Payment
      // Element runs its own ML-driven conversion heuristics and we
      // can't override them (we tried). The trade-off: parents get
      // every available payment option (BNPL included for the rare
      // case it makes sense), at the cost of the tile order not being
      // strictly Card -> Bank.
      // If we ever need strict ordering, the path is Stripe-hosted
      // Checkout (off-site redirect) - the embedded Element doesn't
      // support it.
      const created = await stripe.paymentMethodConfigurations.create({
        name: PMC_NAME,
        card: { display_preference: { preference: "on" } },
        us_bank_account: { display_preference: { preference: "on" } },
        link: { display_preference: { preference: "on" } },
        apple_pay: { display_preference: { preference: "on" } },
        google_pay: { display_preference: { preference: "on" } },
        klarna: { display_preference: { preference: "off" } },
        affirm: { display_preference: { preference: "off" } },
        cashapp: { display_preference: { preference: "off" } },
      });
      return created.id;
    } catch (e: any) {
      // Restricted key without paymentMethodConfigurations:write, or any
      // other transient failure. Cache the null so we don't hammer the
      // API on every PaymentIntent - the caller will fall back to
      // payment_method_types instead.
      console.warn(`[stripe] PMC create/list failed, falling back to payment_method_types: ${e?.message}`);
      return null;
    }
  })();
  return cachedPmcIdPromise;
}

export async function createPaymentIntent(params: {
  amountCents: number;
  currency: string;
  invoiceId: string;
  paymentToken: string;
  description: string;
  captureMethod?: "automatic" | "manual"; // manual = escrow/hold
  receiptEmail?: string;
  /** ISO-3166 alpha-2 country code of the buyer (from IP geolocation). */
  buyerCountry?: string;
}): Promise<{ clientSecret: string; paymentIntentId: string }> {
  if (!isStripeConfigured()) {
    return {
      clientSecret: `mock_secret_${Date.now()}`,
      paymentIntentId: `mock_pi_${Date.now()}`,
    };
  }

  const stripe = getStripe();

  // Note: receipt_email is intentionally NOT passed. GoStork sends its own
  // branded receipt (with itemized line items + agency logo + tax ID via
  // PDF attachment) from the webhook handler. Letting Stripe ALSO email a
  // generic receipt would just create a duplicate. Stripe Dashboard ->
  // Settings -> Customer emails -> "Successful payments" must also be off.
  // Three modes:
  //  - Manual capture (escrow hold): card-only via payment_method_types.
  //    ACH / wallets backed by ACH cannot be manual-captured, Stripe
  //    rejects the intent otherwise. We can't use PMC here because PMC
  //    enables multiple methods and we need to restrict to card only.
  //  - US buyer OR unknown country: use our Payment Method Configuration
  //    (PMC). Card + US bank account get display_preference "on" so they
  //    appear as the visible top tiles in this order; BNPL methods get
  //    "off" so they're available but tucked behind the "More" dropdown.
  //    Falls back to payment_method_types: [card, us_bank_account] if
  //    PMC creation fails (e.g. restricted key without PMC write perm).
  //  - Explicit non-US buyer: automatic_payment_methods. Stripe picks
  //    the optimal order for the buyer's actual country (Bancontact
  //    for BE, iDEAL for NL, SEPA for EU, etc.).
  const isManualCapture = (params.captureMethod ?? "automatic") === "manual";
  const explicitCountry = params.buyerCountry?.toUpperCase();
  const useUsOrder = !explicitCountry || explicitCountry === "US";
  let paymentMethodOpts: Stripe.PaymentIntentCreateParams;
  if (isManualCapture) {
    paymentMethodOpts = { payment_method_types: ["card"] };
  } else if (useUsOrder) {
    const pmcId = await getOrCreateGoStorkPmc();
    paymentMethodOpts = pmcId
      ? { payment_method_configuration: pmcId }
      : { payment_method_types: [...US_PAYMENT_METHOD_ORDER] };
  } else {
    paymentMethodOpts = { automatic_payment_methods: { enabled: true } };
  }

  const intent = await stripe.paymentIntents.create({
    amount: params.amountCents,
    currency: params.currency.toLowerCase(),
    capture_method: params.captureMethod ?? "automatic",
    description: params.description,
    ...paymentMethodOpts,
    metadata: {
      invoiceId: params.invoiceId,
      paymentToken: params.paymentToken,
    },
  });

  return {
    clientSecret: intent.client_secret!,
    paymentIntentId: intent.id,
  };
}

// ─── Capture (AT_CLEARANCE - after medical clearance confirmed) ───────────────

/**
 * Captures a previously authorized PaymentIntent.
 * Called when parent confirms surrogate passed medical clearance.
 */
export async function capturePaymentIntent(paymentIntentId: string): Promise<{ transactionId: string }> {
  if (!isStripeConfigured() || paymentIntentId.startsWith("mock_")) {
    return { transactionId: `mock_txn_${Date.now()}` };
  }

  const stripe = getStripe();
  const intent = await stripe.paymentIntents.capture(paymentIntentId);
  return { transactionId: intent.id };
}

// ─── Void / Cancel (AT_CLEARANCE - surrogate failed clearance) ────────────────

/**
 * Cancels a PaymentIntent (releases the hold).
 * Called when surrogate fails medical clearance - no charge to parent.
 */
export async function voidPaymentIntent(paymentIntentId: string): Promise<void> {
  if (!isStripeConfigured() || paymentIntentId.startsWith("mock_")) return;

  const stripe = getStripe();
  await stripe.paymentIntents.cancel(paymentIntentId);
}

// ─── Bank Transfer (customer_balance / VBAN) ─────────────────────────────────

/**
 * Wire-transfer instructions returned by Stripe after we confirm a
 * customer_balance PaymentIntent. The `reference` field is what Stripe uses
 * to reconcile the inbound wire to the PaymentIntent - parents MUST include
 * it in the wire memo or the funds will not be matched.
 */
export interface WireInstructions {
  paymentIntentId: string;
  clientSecret: string | null;
  /** Currency the parent must wire in (matches the invoice currency). */
  currency: string;
  amountCents: number;
  /** The reference code parents put in the wire memo - critical for reconciliation. */
  reference: string;
  /** Stripe-hosted page with the same instructions, useful as a fallback URL in emails. */
  hostedInstructionsUrl: string | null;
  /** One or more bank accounts the parent can wire to. US transfers return
   *  two: "aba" (domestic ACH/wire) + "swift" (international wire). */
  accounts: Array<{
    /** "aba" | "swift" | "iban" | "sort_code" | "zengin" | "spei" | etc. */
    type: string;
    /** Bank legal name. */
    bankName?: string | null;
    /** Beneficiary / account-holder name (Stripe Payments Inc. by default). */
    accountHolderName?: string | null;
    /** Flattened single-line address string. */
    accountHolderAddress?: string | null;
    accountNumber?: string | null;
    routingNumber?: string | null;
    swiftCode?: string | null;
    iban?: string | null;
    sortCode?: string | null;
    /** Stripe lists which networks this entry supports (e.g. ["ach","domestic_wire_us"] or ["swift"]). */
    supportedNetworks?: string[];
    /** Original blob for anything we don't recognize. */
    rawJson: unknown;
  }>;
}

/**
 * Idempotent helper. If `existingCustomerId` is set we trust it. Otherwise we
 * search Stripe for an existing customer matching this email + metadata.userId
 * (covers the case where the DB column got wiped but Stripe still has them)
 * before falling back to creating a new one.
 */
export async function getOrCreateStripeCustomer(params: {
  userId: string;
  email: string;
  name?: string | null;
  existingCustomerId?: string | null;
}): Promise<string> {
  if (!isStripeConfigured()) {
    return params.existingCustomerId || `mock_cus_${params.userId}`;
  }

  const stripe = getStripe();

  if (params.existingCustomerId) {
    try {
      const c = await stripe.customers.retrieve(params.existingCustomerId);
      if (c && !(c as any).deleted) return params.existingCustomerId;
    } catch {
      // fall through to recreate
    }
  }

  // Look for an existing customer by metadata so we don't create duplicates
  // when the DB has lost the ID but Stripe still has the record.
  const search = await stripe.customers.search({
    query: `metadata['gostorkUserId']:'${params.userId}'`,
    limit: 1,
  }).catch(() => null);
  const existing = search?.data?.[0];
  if (existing) return existing.id;

  const created = await stripe.customers.create({
    email: params.email,
    name: params.name || undefined,
    metadata: { gostorkUserId: params.userId },
  });
  return created.id;
}

/**
 * Mints + server-confirms a customer_balance PaymentIntent so we can hand
 * the parent wire instructions immediately. USD only for MVP
 * (`us_bank_transfer`). Adding EU/UK/JP/MX requires (a) multi-currency
 * invoicing, and (b) selecting the bank_transfer.type that matches the
 * invoice currency: eur=>eu_bank_transfer, gbp=>gb_bank_transfer,
 * jpy=>jp_bank_transfer, mxn=>mx_bank_transfer.
 */
export async function createBankTransferPaymentIntent(params: {
  amountCents: number;
  currency: string;
  invoiceId: string;
  paymentToken: string;
  customerId: string;
  description: string;
}): Promise<WireInstructions> {
  if (!isStripeConfigured()) {
    // Mock mode for local dev without Stripe keys.
    return {
      paymentIntentId: `mock_wire_${Date.now()}`,
      clientSecret: `mock_secret_${Date.now()}`,
      currency: params.currency.toUpperCase(),
      amountCents: params.amountCents,
      reference: `MOCK-REF-${params.paymentToken.slice(0, 8).toUpperCase()}`,
      hostedInstructionsUrl: null,
      accounts: [{
        type: "us_bank_account",
        bankName: "Mock Bank",
        accountHolderName: "GoStork (Mock)",
        accountNumber: "000123456789",
        routingNumber: "110000000",
        swiftCode: null,
        iban: null,
        sortCode: null,
        rawJson: { mock: true },
      }],
    };
  }

  const stripe = getStripe();
  const currency = params.currency.toLowerCase();

  // MVP: USD only. Reject other currencies loudly so future multi-currency
  // invoices don't silently fail to render wire instructions.
  if (currency !== "usd") {
    throw new Error(
      `Bank transfer not yet supported for currency ${currency.toUpperCase()}. ` +
      `Add the matching bank_transfer.type (eu/gb/jp/mx) in stripe-service.ts.`,
    );
  }

  const intent = await stripe.paymentIntents.create({
    amount: params.amountCents,
    currency,
    customer: params.customerId,
    description: params.description,
    payment_method_types: ["customer_balance"],
    payment_method_data: { type: "customer_balance" },
    payment_method_options: {
      customer_balance: {
        funding_type: "bank_transfer",
        bank_transfer: { type: "us_bank_transfer" },
      },
    },
    confirm: true,
    metadata: {
      invoiceId: params.invoiceId,
      paymentToken: params.paymentToken,
      gostorkFlow: "wire_transfer",
    },
  });

  return parseWireInstructions(intent, params.amountCents, params.currency);
}

/**
 * Re-reads wire instructions from Stripe. Used when the parent reloads
 * /pay/<token> after we already minted a wire PaymentIntent for this invoice.
 * Avoids creating duplicates.
 */
export async function retrieveBankTransferInstructions(paymentIntentId: string, fallbackAmount: number, fallbackCurrency: string): Promise<WireInstructions | null> {
  if (!isStripeConfigured() || paymentIntentId.startsWith("mock_")) return null;
  try {
    const stripe = getStripe();
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    return parseWireInstructions(intent, fallbackAmount, fallbackCurrency);
  } catch {
    return null;
  }
}

function flattenAddress(addr: any): string | null {
  if (!addr) return null;
  if (typeof addr === "string") return addr;
  const parts = [addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country]
    .filter((p) => p && typeof p === "string");
  return parts.length > 0 ? parts.join(", ") : null;
}

function parseWireInstructions(intent: Stripe.PaymentIntent, fallbackAmount: number, fallbackCurrency: string): WireInstructions {
  const action: any = (intent as any).next_action?.display_bank_transfer_instructions;
  const financialAddresses: any[] = action?.financial_addresses || [];
  const reference: string = action?.reference || "";
  const hostedUrl: string | null = action?.hosted_instructions_url || null;

  const accounts = financialAddresses.map((addr) => {
    // Stripe returns one of: aba, iban, sort_code, spei, zengin, swift. The
    // shape varies per type - normalize to a flat object the UI can render
    // directly, and keep the original blob for anything we don't recognize.
    const type: string = addr.type;
    const detail = addr[type] || {};
    return {
      type,
      bankName: detail.bank_name || detail.bankName || null,
      accountHolderName: detail.account_holder_name || detail.accountHolderName || null,
      accountHolderAddress: flattenAddress(detail.account_holder_address),
      accountNumber: detail.account_number || detail.iban || detail.clabe || null,
      routingNumber: detail.routing_number || detail.aba_routing_number || null,
      swiftCode: detail.swift_code || detail.bic || null,
      iban: detail.iban || null,
      sortCode: detail.sort_code || null,
      supportedNetworks: addr.supported_networks || [],
      rawJson: addr,
    };
  });

  return {
    paymentIntentId: intent.id,
    clientSecret: intent.client_secret,
    currency: (intent.currency || fallbackCurrency).toUpperCase(),
    amountCents: intent.amount || fallbackAmount,
    reference,
    hostedInstructionsUrl: hostedUrl,
    accounts,
  };
}

// ─── Card details (for receipt PDFs) ─────────────────────────────────────────

/**
 * Fetches the card brand / last4 / expiry for a successful PaymentIntent so
 * the receipt PDF can show "Visa ending in 4242" rather than just an opaque
 * transaction ID. Returns nulls in mock mode or if the PaymentIntent didn't
 * use a card (Klarna, Affirm, ACH, etc).
 */
export async function getCardDetailsForPaymentIntent(paymentIntentId: string): Promise<{
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}> {
  const empty = { brand: null, last4: null, expMonth: null, expYear: null };
  if (!isStripeConfigured() || paymentIntentId.startsWith("mock_")) return empty;
  try {
    const stripe = getStripe();
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge.payment_method_details"],
    });
    const charge = (intent as any).latest_charge;
    const card = charge?.payment_method_details?.card;
    if (!card) return empty;
    return {
      brand: card.brand || null,
      last4: card.last4 || null,
      expMonth: card.exp_month || null,
      expYear: card.exp_year || null,
    };
  } catch {
    return empty;
  }
}

// ─── Webhook verification ─────────────────────────────────────────────────────

/**
 * Verifies and parses a Stripe webhook event.
 * Uses STRIPE_WEBHOOK_SECRET for signature verification.
 */
export function constructWebhookEvent(payload: Buffer | string, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");

  const stripe = getStripe();
  return stripe.webhooks.constructEvent(payload, signature, secret);
}

/**
 * Extracts payment info from a Stripe webhook event.
 * Returns null for irrelevant event types.
 */
export function parseWebhookEvent(event: Stripe.Event): {
  paymentIntentId: string;
  status: "succeeded" | "authorized" | "processing" | "canceled" | "failed";
  amountCents: number;
  invoiceId: string;
  paymentToken: string;
  /** Best-effort detection from the intent payload. */
  paymentMethod: "ACH" | "CARD" | "BANK_TRANSFER" | null;
} | null {
  const relevantEvents = [
    "payment_intent.succeeded",
    "payment_intent.amount_capturable_updated", // authorized (manual capture)
    "payment_intent.processing",                 // delayed-notification methods (ACH submitted, awaiting clearance)
    "payment_intent.canceled",
    "payment_intent.payment_failed",
  ];

  if (!relevantEvents.includes(event.type)) return null;

  const intent = event.data.object as Stripe.PaymentIntent;
  const meta = intent.metadata || {};

  let status: "succeeded" | "authorized" | "processing" | "canceled" | "failed";
  if (event.type === "payment_intent.succeeded") status = "succeeded";
  else if (event.type === "payment_intent.amount_capturable_updated") status = "authorized";
  else if (event.type === "payment_intent.processing") status = "processing";
  else if (event.type === "payment_intent.canceled") status = "canceled";
  else status = "failed";

  // Best-effort payment-method inference. For "processing" events Stripe
  // populates latest_charge.payment_method_details.type once the method is
  // attached; us_bank_account => ACH. Fall back to the intent's
  // payment_method_types when latest_charge isn't expanded.
  const charge = (intent as any).latest_charge;
  const pmType: string | undefined =
    typeof charge === "object" && charge?.payment_method_details?.type
      ? charge.payment_method_details.type
      : intent.payment_method_types?.[0];
  const paymentMethod: "ACH" | "CARD" | "BANK_TRANSFER" | null =
    pmType === "us_bank_account" ? "ACH"
      : pmType === "card" ? "CARD"
      : pmType === "customer_balance" ? "BANK_TRANSFER"
      : null;

  return {
    paymentIntentId: intent.id,
    status,
    amountCents: intent.amount,
    invoiceId: meta.invoiceId || "",
    paymentToken: meta.paymentToken || "",
    paymentMethod,
  };
}

// ─── Refunds ─────────────────────────────────────────────────────────────────

/**
 * Surfaces charge.refunded events. Stripe accumulates amount_refunded on the
 * Charge as multiple refunds stack up, so the webhook handler only needs to
 * diff against what we previously stored to learn the delta. The latest
 * refund object (refunds.data[0] - Stripe lists refunds newest-first) gives
 * us its id + reason for stamping on the invoice.
 */
export function parseRefundEvent(event: Stripe.Event): {
  chargeId: string;
  paymentIntentId: string;
  amountCents: number;          // charge.amount (total original)
  amountRefundedCents: number;  // charge.amount_refunded (running total)
  fullyRefunded: boolean;
  latestRefundId: string | null;
  latestRefundReason: string | null;
  /** Refund metadata, used to read the refund mode set at create time. */
  latestRefundMetadata: Record<string, string> | null;
} | null {
  if (event.type !== "charge.refunded") return null;
  const charge = event.data.object as Stripe.Charge;
  const piRaw: any = (charge as any).payment_intent;
  const paymentIntentId = typeof piRaw === "string" ? piRaw : (piRaw?.id || "");
  if (!paymentIntentId) return null;

  // refunds.data is newest-first; the refund that triggered this event is
  // typically the first entry. If the list isn't expanded, we fall back to
  // null and let the service look it up.
  const refunds = (charge as any).refunds?.data as Stripe.Refund[] | undefined;
  const latest = refunds && refunds.length > 0 ? refunds[0] : null;

  return {
    chargeId: charge.id,
    paymentIntentId,
    amountCents: charge.amount,
    amountRefundedCents: charge.amount_refunded,
    fullyRefunded: charge.refunded === true,
    latestRefundId: latest?.id || null,
    latestRefundReason: latest?.reason || null,
    latestRefundMetadata: (latest?.metadata as Record<string, string> | undefined) || null,
  };
}

/**
 * Creates a refund on a PaymentIntent. Used by the admin Refund endpoint.
 * Stripe fires charge.refunded asynchronously after the refund is processed;
 * our webhook handler does the DB updates + provider clawback then.
 *
 * amount is in cents. Omit for a full refund.
 * reason maps to Stripe's enum (duplicate / fraudulent / requested_by_customer).
 * "other" is not a valid Stripe enum value - we pass undefined in that case.
 */
export async function createRefund(params: {
  paymentIntentId: string;
  amountCents?: number;
  reason?: "duplicate" | "fraudulent" | "requested_by_customer" | "other";
  metadata?: Record<string, string>;
}): Promise<Stripe.Refund> {
  const stripe = getStripe();
  const reasonForStripe = params.reason === "other" ? undefined : params.reason;
  return await stripe.refunds.create({
    payment_intent: params.paymentIntentId,
    ...(params.amountCents != null ? { amount: params.amountCents } : {}),
    ...(reasonForStripe ? { reason: reasonForStripe } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  });
}

/**
 * Reverses (clawback) a Transfer that was sent to a connected account. Used
 * after a refund so the provider's payout matches the parent's net payment.
 *
 * If the connected account hasn't paid out to bank yet, Stripe debits its
 * Connect balance. If the funds already swept (Received), Stripe debits the
 * connected account's next incoming balance (creating a negative balance
 * that recoups from the next transfer).
 *
 * amount: cents to reverse. Omit for the full remaining (unreversed) amount.
 */
export async function createTransferReversal(params: {
  transferId: string;
  amountCents?: number;
  metadata?: Record<string, string>;
}): Promise<Stripe.TransferReversal> {
  const stripe = getStripe();
  return await stripe.transfers.createReversal(params.transferId, {
    ...(params.amountCents != null ? { amount: params.amountCents } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  });
}

// ─── Profile Sponsorship (provider PAYS GoStork - platform charge, not Connect) ─
//
// Two billing modes:
//   AUTO_RENEW - a monthly Stripe Subscription. The first month confirms via the
//                Payment Element (we return the latest invoice's PI client secret).
//   ONE_TIME   - a single-month PaymentIntent (no auto-renew).
// All objects carry metadata { sponsorshipId, providerId, kind: "sponsorship" }
// so the webhook handler routes them away from the parent-invoice flow (which
// keys off metadata.invoiceId, deliberately absent here).

/** Reads the current period end (unix seconds) from a Subscription across API
 *  versions - newer Stripe moved current_period_end onto the subscription item. */
function subscriptionPeriodEnd(sub: Stripe.Subscription): number | null {
  const top = (sub as any).current_period_end;
  if (typeof top === "number") return top;
  const item = sub.items?.data?.[0] as any;
  if (item && typeof item.current_period_end === "number") return item.current_period_end;
  return null;
}

/**
 * Creates a monthly auto-renewing sponsorship Subscription. If the plan has a
 * pre-provisioned recurring Price we reuse it; otherwise we mint a Product +
 * recurring Price on the fly (mirrors createPaymentLink). The subscription is
 * created `incomplete` so the provider confirms month 1 in the Payment Element -
 * sponsorship stays PENDING_PAYMENT until invoice.payment_succeeded fires.
 */
export async function createSponsorshipSubscription(params: {
  customerId: string;
  planDisplayName: string;
  amountCents: number;
  currency: string;
  preProvisionedPriceId?: string | null;
  sponsorshipId: string;
  providerId: string;
}): Promise<{
  subscriptionId: string;
  priceId: string;
  latestInvoiceId: string | null;
  paymentIntentClientSecret: string | null;
  status: string;
  currentPeriodEnd: number | null;
}> {
  if (!isStripeConfigured()) {
    return {
      subscriptionId: `mock_sub_${Date.now()}`,
      priceId: `mock_price_${Date.now()}`,
      latestInvoiceId: `mock_in_${Date.now()}`,
      paymentIntentClientSecret: `mock_secret_${Date.now()}`,
      status: "incomplete",
      currentPeriodEnd: Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000),
    };
  }

  const stripe = getStripe();

  let priceId = params.preProvisionedPriceId || "";
  if (!priceId) {
    const product = await stripe.products.create({
      name: params.planDisplayName,
      metadata: { kind: "sponsorship", sponsorshipId: params.sponsorshipId, providerId: params.providerId },
    });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: params.amountCents,
      currency: params.currency.toLowerCase(),
      recurring: { interval: "month" },
    });
    priceId = price.id;
  }

  const subscription = await stripe.subscriptions.create({
    customer: params.customerId,
    items: [{ price: priceId }],
    payment_behavior: "default_incomplete",
    payment_settings: {
      save_default_payment_method: "on_subscription",
      payment_method_types: ["card"],
    },
    expand: ["latest_invoice.payment_intent"],
    metadata: { kind: "sponsorship", sponsorshipId: params.sponsorshipId, providerId: params.providerId },
  });

  const latestInvoice = subscription.latest_invoice as Stripe.Invoice | null;
  const pi = (latestInvoice as any)?.payment_intent as Stripe.PaymentIntent | null;

  return {
    subscriptionId: subscription.id,
    priceId,
    latestInvoiceId: latestInvoice?.id || null,
    paymentIntentClientSecret: pi?.client_secret || null,
    status: subscription.status,
    currentPeriodEnd: subscriptionPeriodEnd(subscription),
  };
}

/**
 * Creates a one-time single-month sponsorship PaymentIntent. Unlike the parent
 * invoice flow this is not tied to an Invoice row - the sponsorship row holds
 * the linkage via metadata.sponsorshipId.
 */
export async function createSponsorshipOneTimeIntent(params: {
  customerId?: string | null;
  amountCents: number;
  currency: string;
  description: string;
  sponsorshipId: string;
  providerId: string;
}): Promise<{ clientSecret: string; paymentIntentId: string }> {
  if (!isStripeConfigured()) {
    return {
      clientSecret: `mock_secret_${Date.now()}`,
      paymentIntentId: `mock_pi_${Date.now()}`,
    };
  }

  const stripe = getStripe();
  const pmcId = await getOrCreateGoStorkPmc();
  const intent = await stripe.paymentIntents.create({
    amount: params.amountCents,
    currency: params.currency.toLowerCase(),
    capture_method: "automatic",
    description: params.description,
    ...(params.customerId ? { customer: params.customerId } : {}),
    ...(pmcId
      ? { payment_method_configuration: pmcId }
      : { payment_method_types: [...US_PAYMENT_METHOD_ORDER] }),
    metadata: { kind: "sponsorship", sponsorshipId: params.sponsorshipId, providerId: params.providerId },
  });

  return { clientSecret: intent.client_secret!, paymentIntentId: intent.id };
}

/**
 * Retrieves the client secret of a pending sponsorship Subscription's latest
 * invoice PaymentIntent, so the provider can complete a payment the admin
 * initiated ("send payment request"). Returns null if there's nothing to pay
 * (already active) or the incomplete subscription's window has lapsed.
 */
export async function getSponsorshipSubscriptionClientSecret(subscriptionId: string): Promise<string | null> {
  if (!isStripeConfigured() || subscriptionId.startsWith("mock_")) {
    return `mock_secret_${Date.now()}`;
  }
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice.payment_intent"] });
  const pi = (sub.latest_invoice as any)?.payment_intent as Stripe.PaymentIntent | null;
  return pi?.client_secret || null;
}

/**
 * Cancels a sponsorship Subscription. cancelAtPeriodEnd=true lets the provider
 * keep the boost through the month they already paid for; false ends it now.
 */
export async function cancelSponsorshipSubscription(params: {
  subscriptionId: string;
  cancelAtPeriodEnd?: boolean;
}): Promise<{ status: string; currentPeriodEnd: number | null }> {
  if (!isStripeConfigured() || params.subscriptionId.startsWith("mock_")) {
    return { status: "canceled", currentPeriodEnd: null };
  }
  const stripe = getStripe();
  const sub = params.cancelAtPeriodEnd
    ? await stripe.subscriptions.update(params.subscriptionId, { cancel_at_period_end: true })
    : await stripe.subscriptions.cancel(params.subscriptionId);
  return { status: sub.status, currentPeriodEnd: subscriptionPeriodEnd(sub) };
}

/**
 * Normalizes a sponsorship-relevant webhook event. Returns null for events that
 * have nothing to do with sponsorship. The service resolves the Sponsorship row
 * by whichever identifier is present (sponsorshipId from metadata, else the
 * subscription id, else the payment-intent id) and no-ops if none match.
 */
export function parseSponsorshipEvent(event: Stripe.Event): {
  type: string;
  sponsorshipId: string | null;
  stripeSubscriptionId: string | null;
  paymentIntentId: string | null;
  currentPeriodEnd: number | null; // unix seconds
  cancelAtPeriodEnd: boolean | null;
  subscriptionStatus: string | null;
  billingReason: string | null;
} | null {
  const t = event.type;
  const base = {
    type: t,
    sponsorshipId: null as string | null,
    stripeSubscriptionId: null as string | null,
    paymentIntentId: null as string | null,
    currentPeriodEnd: null as number | null,
    cancelAtPeriodEnd: null as boolean | null,
    subscriptionStatus: null as string | null,
    billingReason: null as string | null,
  };

  if (t.startsWith("payment_intent.")) {
    const intent = event.data.object as Stripe.PaymentIntent;
    const meta = intent.metadata || {};
    if (meta.kind !== "sponsorship") return null;
    return { ...base, sponsorshipId: meta.sponsorshipId || null, paymentIntentId: intent.id };
  }

  if (t.startsWith("customer.subscription.")) {
    const sub = event.data.object as Stripe.Subscription;
    const meta = sub.metadata || {};
    if (meta.kind !== "sponsorship") return null;
    return {
      ...base,
      sponsorshipId: meta.sponsorshipId || null,
      stripeSubscriptionId: sub.id,
      currentPeriodEnd: subscriptionPeriodEnd(sub),
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? null,
      subscriptionStatus: sub.status,
    };
  }

  if (t === "invoice.payment_succeeded" || t === "invoice.payment_failed") {
    const invoice = event.data.object as Stripe.Invoice;
    const subId = typeof (invoice as any).subscription === "string"
      ? (invoice as any).subscription
      : (invoice as any).subscription?.id || null;
    const subMeta = (invoice as any).subscription_details?.metadata || {};
    if (!subId && subMeta.kind !== "sponsorship") return null;
    // Period end of the subscription line, if present.
    const line = invoice.lines?.data?.[0] as any;
    const periodEnd = line?.period?.end ?? (invoice as any).period_end ?? null;
    return {
      ...base,
      sponsorshipId: subMeta.sponsorshipId || null,
      stripeSubscriptionId: subId,
      currentPeriodEnd: typeof periodEnd === "number" ? periodEnd : null,
      billingReason: (invoice as any).billing_reason || null,
    };
  }

  return null;
}

// ─── Publishable key (safe to expose to frontend) ────────────────────────────

export function getPublishableKey(): string {
  return process.env.STRIPE_PUBLISHABLE_KEY || "";
}

// ─── Stripe Connect (provider payouts) ────────────────────────────────────────
//
// Two flavours of connected account, both v1 accounts with the controller
// property set:
//
//   EXPRESS - controller.stripe_dashboard.type = "express"
//             controller.requirement_collection = "stripe"
//             Provider is redirected to Stripe-hosted onboarding via
//             accountLinks.create. Stripe collects KYC.
//
//   CUSTOM  - controller.stripe_dashboard.type = "none"
//             controller.requirement_collection = "application"
//             GoStork collects KYC fields in its own form and POSTs them
//             via accounts.update + accounts.createPerson. Provider never
//             sees Stripe.
//
// In both cases:
//   fees.payer        = "application" -> Stripe deducts processing fees from
//                       GoStork's platform balance (not the provider's
//                       transfer amount).
//   losses.payments   = "application" -> chargebacks debit GoStork's
//                       platform balance, not the provider's.
//   capabilities.transfers.requested = true so we can use transfers.create.

export interface CreateConnectAccountParams {
  type: "EXPRESS" | "CUSTOM";
  email: string;
  /** US-only at launch. Adding other countries later flips this and the bank-account currency. */
  country?: string;
  /** "company" for agencies / clinics; "individual" for sole-proprietor donors etc. */
  businessType?: "company" | "individual";
  /** DBA / display name Stripe shows on hosted pages + payout statements. */
  businessName?: string;
  /** Legal entity name (W-9 line 1). For Stripe this fills company.name,
   *  which is the registered legal business name - distinct from the DBA. */
  legalName?: string;
  businessUrl?: string;
  /** Snapshot of the provider's GoStork tax ID (EIN). Pre-fills Stripe's KYC. */
  taxId?: string;
  phone?: string;
  address?: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
}

export async function createConnectAccount(params: CreateConnectAccountParams): Promise<{ accountId: string }> {
  const stripe = getStripe();
  const dashboardType = params.type === "EXPRESS" ? "express" : "none";
  const requirementCollection = params.type === "EXPRESS" ? "stripe" : "application";

  const businessType = params.businessType || "company";
  const isCompany = businessType === "company";

  // Stripe address object shape. Stripe-hosted onboarding accepts these
  // pre-fills on company.address; the form shows them already populated
  // so the provider just confirms instead of retyping.
  const stripeAddress = params.address
    ? {
        line1: params.address.line1,
        ...(params.address.line2 ? { line2: params.address.line2 } : {}),
        city: params.address.city,
        state: params.address.state,
        postal_code: params.address.postalCode,
        country: params.address.country || "US",
      }
    : null;

  const account = await stripe.accounts.create({
    controller: {
      fees: { payer: "application" },
      losses: { payments: "application" },
      requirement_collection: requirementCollection,
      stripe_dashboard: { type: dashboardType },
    },
    country: params.country || "US",
    email: params.email,
    business_type: businessType,
    capabilities: {
      transfers: { requested: true },
    },
    business_profile: {
      // name = DBA / display name shown to customers
      ...(params.businessName ? { name: params.businessName } : {}),
      ...(params.businessUrl ? { url: params.businessUrl } : {}),
      // 8099 = Health Services - Not Elsewhere Classified, which is the
      // standard MCC for fertility / IVF / surrogacy / donor agencies.
      mcc: "8099",
      ...(params.phone ? { support_phone: params.phone } : {}),
    },
    ...(isCompany
      ? {
          company: {
            // name = legal business name as it appears on IRS documents
            ...(params.legalName ? { name: params.legalName } : {}),
            ...(params.taxId ? { tax_id: params.taxId } : {}),
            ...(params.phone ? { phone: params.phone } : {}),
            ...(stripeAddress ? { address: stripeAddress } : {}),
          },
        }
      : {
          // Individual / sole-prop path: same address + phone go on
          // individual instead of company.
          individual: {
            ...(params.phone ? { phone: params.phone } : {}),
            ...(stripeAddress ? { address: stripeAddress } : {}),
          },
        }),
    metadata: {
      gostorkProvider: "true",
    },
  });

  return { accountId: account.id };
}

/**
 * Generates a one-time onboarding link for Express accounts. The provider is
 * redirected here, completes Stripe's hosted KYC, then sent back to returnUrl.
 * refreshUrl is hit if the link expires before they finish.
 */
export async function createConnectAccountLink(params: {
  accountId: string;
  returnUrl: string;
  refreshUrl: string;
}): Promise<{ url: string }> {
  const stripe = getStripe();
  const link = await stripe.accountLinks.create({
    account: params.accountId,
    refresh_url: params.refreshUrl,
    return_url: params.returnUrl,
    type: "account_onboarding",
  });
  return { url: link.url };
}

/**
 * Express path: short-lived URL that drops the provider straight into the
 * Stripe Express dashboard with their account selected. Used by the
 * "Manage on Stripe" button on the Payouts tab.
 */
export async function createExpressLoginLink(accountId: string): Promise<{ url: string }> {
  const stripe = getStripe();
  const link = await stripe.accounts.createLoginLink(accountId);
  return { url: link.url };
}

/**
 * Fetches Connect account balance (available + pending). Used by the
 * disconnect-safety check - we refuse to disconnect while money is still
 * sitting on the connected account.
 */
export async function retrieveConnectAccountBalance(accountId: string): Promise<{
  available: number;
  pending: number;
}> {
  const stripe = getStripe();
  const bal = await stripe.balance.retrieve({ stripeAccount: accountId });
  const sum = (arr: Stripe.Balance.Available[] | Stripe.Balance.Pending[] | undefined) =>
    (arr || []).reduce((s, a) => s + a.amount, 0);
  return { available: sum(bal.available as any), pending: sum(bal.pending as any) };
}

/**
 * Deletes a Connect account. Only valid for Custom accounts created by the
 * platform (which is what GoStork uses). Express accounts cannot be deleted
 * via API - they require the provider to disconnect from the Express
 * dashboard, which fires our account.application.deauthorized webhook.
 */
export async function deleteConnectAccount(accountId: string): Promise<void> {
  const stripe = getStripe();
  await stripe.accounts.del(accountId);
}

/**
 * Lists the balance transactions a bank-side Payout swept, scoped to the
 * connected account that received the Payout. Used by the payout.paid /
 * payout.failed Connect webhook to map back from the Payout to the set of
 * platform-originated Transfers it bundled.
 *
 * Each BT's `source` is the Charge id on the connected account (py_xxx)
 * created by the original platform->Connect Transfer - that's what we
 * stamped onto Invoice.stripeConnectPaymentId at transfer time, so the
 * match is direct.
 *
 * Stripe paginates at 100; we follow `has_more` so a single huge payout
 * (many invoices in one sweep) still returns everything.
 */
export async function listConnectedPayoutBalanceTransactions(params: {
  accountId: string;
  payoutId: string;
}): Promise<Array<{ id: string; source: string | null; type: string; amount: number; currency: string }>> {
  const stripe = getStripe();
  const out: Array<{ id: string; source: string | null; type: string; amount: number; currency: string }> = [];
  let startingAfter: string | undefined = undefined;
  for (;;) {
    const page: any = await stripe.balanceTransactions.list(
      { payout: params.payoutId, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      { stripeAccount: params.accountId },
    );
    for (const bt of page.data) {
      const src = typeof bt.source === "string" ? bt.source : (bt.source as any)?.id || null;
      out.push({ id: bt.id, source: src, type: bt.type, amount: bt.amount, currency: bt.currency });
    }
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return out;
}

/**
 * Fallback for the `manual payout` case: Stripe refuses to filter
 * balanceTransactions.list by a manual payout ("Balance transaction
 * history can only be filtered on automatic transfers, not manual.").
 * In live mode this never matters because Stripe creates payouts
 * automatically on the schedule (those ARE filterable). In dev / test
 * we sometimes trigger payouts manually via the API.
 *
 * Strategy: list `payment` type BTs on the connected account that
 * Stripe says are part of *some* payout already (i.e. settled), bounded
 * by a reasonable time window (last 60 days). Caller filters those
 * against Invoice.stripeConnectPaymentId where bankPayoutCompletedAt is
 * still null to find the just-settled set.
 */
export async function listConnectedAccountPaymentBalanceTransactions(params: {
  accountId: string;
  sinceUnix?: number;
}): Promise<Array<{ id: string; source: string | null; type: string; amount: number; currency: string }>> {
  const stripe = getStripe();
  const out: Array<{ id: string; source: string | null; type: string; amount: number; currency: string }> = [];
  const since = params.sinceUnix ?? Math.floor(Date.now() / 1000) - 60 * 24 * 60 * 60; // 60 days
  let startingAfter: string | undefined = undefined;
  for (;;) {
    const page: any = await stripe.balanceTransactions.list(
      {
        type: "payment",
        created: { gte: since },
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      { stripeAccount: params.accountId },
    );
    for (const bt of page.data) {
      const src = typeof bt.source === "string" ? bt.source : (bt.source as any)?.id || null;
      out.push({ id: bt.id, source: src, type: bt.type, amount: bt.amount, currency: bt.currency });
    }
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return out;
}

/** Pulls the latest snapshot from Stripe so we can mirror state into ProviderBankAccount. */
export async function retrieveConnectAccount(accountId: string): Promise<Stripe.Account> {
  const stripe = getStripe();
  return await stripe.accounts.retrieve(accountId);
}

/**
 * Custom path: submit KYC fields the provider entered into a GoStork form.
 * Stripe's KYC is incremental - you can submit what you have, then call again
 * with whatever Stripe asks for next (surfaced via requirements.currently_due).
 */
export async function updateConnectAccount(
  accountId: string,
  updates: Stripe.AccountUpdateParams,
): Promise<Stripe.Account> {
  const stripe = getStripe();
  return await stripe.accounts.update(accountId, updates);
}

/**
 * Custom path: attach the provider's bank account so payouts can land. Uses
 * raw routing + account numbers passed from the GoStork server (the form
 * value is server-side, never tokenised on the client, so this code path
 * must only run on https and the server endpoint must enforce auth).
 */
export async function attachConnectBankAccount(params: {
  accountId: string;
  routingNumber: string;
  accountNumber: string;
  accountHolderName: string;
  accountHolderType: "company" | "individual";
  country?: string;
  currency?: string;
}): Promise<Stripe.BankAccount> {
  const stripe = getStripe();
  const result = await stripe.accounts.createExternalAccount(params.accountId, {
    external_account: {
      object: "bank_account",
      country: params.country || "US",
      currency: params.currency || "usd",
      routing_number: params.routingNumber,
      account_number: params.accountNumber,
      account_holder_name: params.accountHolderName,
      account_holder_type: params.accountHolderType,
    } as Stripe.AccountCreateExternalAccountParams["external_account"],
  });
  return result as Stripe.BankAccount;
}

/**
 * Custom path: upsert the company representative (a "Person") for company
 * accounts. Required for KYC of LLC / corp providers. Skip for
 * business_type = individual - Stripe collects representative fields
 * directly on the Account in that case.
 *
 * Stripe rejects createPerson with "An account can only have one
 * representative" when one already exists, so we list existing persons,
 * find the one flagged representative=true, and update them instead of
 * creating a duplicate. This makes the provider's "edit and re-save"
 * flow work as expected.
 */
export async function upsertConnectAccountRepresentative(params: {
  accountId: string;
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
}): Promise<Stripe.Person> {
  const stripe = getStripe();
  const body: Stripe.PersonCreateParams = {
    first_name: params.firstName,
    last_name: params.lastName,
    ...(params.email ? { email: params.email } : {}),
    ...(params.phone ? { phone: params.phone } : {}),
    dob: params.dob,
    ssn_last_4: params.ssnLast4,
    address: {
      line1: params.address.line1,
      ...(params.address.line2 ? { line2: params.address.line2 } : {}),
      city: params.address.city,
      state: params.address.state,
      postal_code: params.address.postalCode,
      country: params.address.country || "US",
    },
    relationship: {
      representative: true,
      executive: true,
      title: "Owner",
    },
  };

  // Find an existing representative on the account. We iterate the
  // (usually short) persons list and pick the one with
  // relationship.representative === true; falling back to any person if
  // none is flagged that way (legacy data).
  const existing = await stripe.accounts.listPersons(params.accountId, { limit: 100 });
  const rep =
    existing.data.find(p => p.relationship?.representative === true) ||
    existing.data[0];

  if (rep) {
    return await stripe.accounts.updatePerson(params.accountId, rep.id, body as Stripe.PersonUpdateParams);
  }
  return await stripe.accounts.createPerson(params.accountId, body);
}

/**
 * @deprecated use upsertConnectAccountRepresentative - kept as a thin
 * compat shim so any other callers don't break mid-refactor.
 */
export async function createConnectAccountRepresentative(params: Parameters<typeof upsertConnectAccountRepresentative>[0]): Promise<Stripe.Person> {
  return await upsertConnectAccountRepresentative(params);
}

/**
 * Fires the actual transfer from GoStork's platform balance to the
 * provider's connected account. Called when an invoice flips to PAID and
 * the provider's payoutsEnabled is true. Synchronous - if the transfer
 * fails (insufficient platform balance, restricted destination, etc.)
 * this throws and the caller handles it (no async transfer.failed event
 * exists, contrary to Stripe's general async pattern).
 */
export async function createConnectTransfer(params: {
  amountCents: number;
  currency: string;
  destinationAccountId: string;
  /** Used for tracing in Stripe Dashboard - usually the GoStork invoice ID. */
  transferGroup?: string;
  description?: string;
  metadata?: Record<string, string>;
}): Promise<Stripe.Transfer> {
  if (!isStripeConfigured()) {
    throw new Error("Stripe not configured - cannot create transfer");
  }
  const stripe = getStripe();
  return await stripe.transfers.create({
    amount: params.amountCents,
    currency: params.currency.toLowerCase(),
    destination: params.destinationAccountId,
    ...(params.transferGroup ? { transfer_group: params.transferGroup } : {}),
    ...(params.description ? { description: params.description } : {}),
    metadata: params.metadata || {},
  });
}

/** Connect-events webhook verifier. Uses STRIPE_CONNECT_WEBHOOK_SECRET (separate from STRIPE_WEBHOOK_SECRET). */
export function constructConnectWebhookEvent(payload: Buffer | string, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_CONNECT_WEBHOOK_SECRET is not set");
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(payload, signature, secret);
}
