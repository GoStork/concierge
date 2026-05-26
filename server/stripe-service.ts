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
  const intent = await stripe.paymentIntents.create({
    amount: params.amountCents,
    currency: params.currency.toLowerCase(),
    capture_method: params.captureMethod ?? "automatic",
    description: params.description,
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
  status: "succeeded" | "authorized" | "canceled" | "failed";
  amountCents: number;
  invoiceId: string;
  paymentToken: string;
} | null {
  const relevantEvents = [
    "payment_intent.succeeded",
    "payment_intent.amount_capturable_updated", // authorized (manual capture)
    "payment_intent.canceled",
    "payment_intent.payment_failed",
  ];

  if (!relevantEvents.includes(event.type)) return null;

  const intent = event.data.object as Stripe.PaymentIntent;
  const meta = intent.metadata || {};

  let status: "succeeded" | "authorized" | "canceled" | "failed";
  if (event.type === "payment_intent.succeeded") status = "succeeded";
  else if (event.type === "payment_intent.amount_capturable_updated") status = "authorized";
  else if (event.type === "payment_intent.canceled") status = "canceled";
  else status = "failed";

  return {
    paymentIntentId: intent.id,
    status,
    amountCents: intent.amount,
    invoiceId: meta.invoiceId || "",
    paymentToken: meta.paymentToken || "",
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
