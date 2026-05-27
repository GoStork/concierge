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
export async function createPaymentIntent(params: {
  amountCents: number;
  currency: string;
  invoiceId: string;
  paymentToken: string;
  description: string;
  captureMethod?: "automatic" | "manual"; // manual = escrow/hold
  receiptEmail?: string;
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
  // automatic_payment_methods lets Stripe surface every method enabled in the
  // Dashboard (card + Apple Pay + Google Pay + ACH + Link + ...) based on the
  // buyer's device and the currency. For escrow holds (capture_method=manual)
  // we restrict to card only, because ACH / wallets backed by ACH cannot be
  // manual-captured - Stripe rejects the intent otherwise.
  const isManualCapture = (params.captureMethod ?? "automatic") === "manual";
  const intent = await stripe.paymentIntents.create({
    amount: params.amountCents,
    currency: params.currency.toLowerCase(),
    capture_method: params.captureMethod ?? "automatic",
    description: params.description,
    ...(isManualCapture
      ? { payment_method_types: ["card"] }
      : { automatic_payment_methods: { enabled: true } }),
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

// ─── Publishable key (safe to expose to frontend) ────────────────────────────

export function getPublishableKey(): string {
  return process.env.STRIPE_PUBLISHABLE_KEY || "";
}

function getBaseUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  return "http://localhost:5001";
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
  /** Display name + URL Stripe shows on hosted Express pages and on the connected account's payout statements. */
  businessName?: string;
  businessUrl?: string;
  /** Snapshot of the provider's GoStork tax ID (EIN). Pre-fills Stripe's KYC. */
  taxId?: string;
}

export async function createConnectAccount(params: CreateConnectAccountParams): Promise<{ accountId: string }> {
  const stripe = getStripe();
  const dashboardType = params.type === "EXPRESS" ? "express" : "none";
  const requirementCollection = params.type === "EXPRESS" ? "stripe" : "application";

  const account = await stripe.accounts.create({
    controller: {
      fees: { payer: "application" },
      losses: { payments: "application" },
      requirement_collection: requirementCollection,
      stripe_dashboard: { type: dashboardType },
    },
    country: params.country || "US",
    email: params.email,
    business_type: params.businessType || "company",
    capabilities: {
      transfers: { requested: true },
    },
    business_profile: {
      ...(params.businessName ? { name: params.businessName } : {}),
      ...(params.businessUrl ? { url: params.businessUrl } : {}),
    },
    ...(params.taxId && (params.businessType || "company") === "company"
      ? { company: { tax_id: params.taxId } }
      : {}),
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
