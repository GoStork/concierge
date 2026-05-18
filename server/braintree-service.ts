/**
 * Braintree payment service for GoStork.
 *
 * Supports two flows:
 *   1. Standard capture (AT_MATCH) - immediate charge
 *   2. Authorize-only + manual capture (AT_CLEARANCE) - pre-auth held until medical clearance confirmed
 *
 * Required env vars:
 *   BRAINTREE_MERCHANT_ID
 *   BRAINTREE_PUBLIC_KEY
 *   BRAINTREE_PRIVATE_KEY
 *   BRAINTREE_ENVIRONMENT  ("sandbox" | "production", defaults to "sandbox")
 */

import braintree from "braintree";

function getGateway() {
  const env = process.env.BRAINTREE_ENVIRONMENT === "production"
    ? braintree.Environment.Production
    : braintree.Environment.Sandbox;

  return new braintree.BraintreeGateway({
    environment: env,
    merchantId: process.env.BRAINTREE_MERCHANT_ID || "",
    publicKey:  process.env.BRAINTREE_PUBLIC_KEY  || "",
    privateKey: process.env.BRAINTREE_PRIVATE_KEY || "",
  });
}

/**
 * Generate a Braintree client token for the frontend Drop-in UI.
 */
export async function generateClientToken(): Promise<string> {
  const gateway = getGateway();
  const result = await gateway.clientToken.generate({});
  return result.clientToken;
}

/**
 * Charge a payment method immediately (AT_MATCH flow).
 * Returns the transaction ID on success.
 */
export async function chargePaymentMethod(params: {
  paymentMethodNonce: string;
  amountCents: number;
  invoiceId: string;
  description: string;
  customerEmail?: string;
  customerName?: string;
}): Promise<{ transactionId: string }> {
  const gateway = getGateway();
  const amountStr = (params.amountCents / 100).toFixed(2);

  const result = await gateway.transaction.sale({
    amount: amountStr,
    paymentMethodNonce: params.paymentMethodNonce,
    orderId: params.invoiceId,
    descriptor: { name: "GoStork*Pay" },
    options: {
      submitForSettlement: true,
    },
    customer: {
      email: params.customerEmail,
      firstName: params.customerName?.split(" ")[0],
      lastName: params.customerName?.split(" ").slice(1).join(" ") || undefined,
    },
  });

  if (!result.success) {
    const msg = result.transaction?.processorResponseText || result.message || "Payment failed";
    throw new Error(`Braintree charge failed: ${msg}`);
  }

  return { transactionId: result.transaction.id };
}

/**
 * Place an authorization-only hold (AT_CLEARANCE flow).
 * Funds are frozen but NOT captured. Returns the authorization ID.
 */
export async function authorizeOnly(params: {
  paymentMethodNonce: string;
  amountCents: number;
  invoiceId: string;
  description: string;
  customerEmail?: string;
  customerName?: string;
}): Promise<{ authorizationId: string }> {
  const gateway = getGateway();
  const amountStr = (params.amountCents / 100).toFixed(2);

  const result = await gateway.transaction.sale({
    amount: amountStr,
    paymentMethodNonce: params.paymentMethodNonce,
    orderId: `hold-${params.invoiceId}`,
    descriptor: { name: "GoStork*Hold" },
    options: {
      submitForSettlement: false, // Authorize only - NOT captured
    },
    customer: {
      email: params.customerEmail,
      firstName: params.customerName?.split(" ")[0],
      lastName: params.customerName?.split(" ").slice(1).join(" ") || undefined,
    },
  });

  if (!result.success) {
    const msg = result.transaction?.processorResponseText || result.message || "Authorization failed";
    throw new Error(`Braintree authorization failed: ${msg}`);
  }

  return { authorizationId: result.transaction.id };
}

/**
 * Capture a previously authorized transaction (fire when clearance confirmed).
 */
export async function captureAuthorization(
  authorizationId: string,
): Promise<{ transactionId: string }> {
  const gateway = getGateway();
  const result = await gateway.transaction.submitForSettlement(authorizationId);

  if (!result.success) {
    throw new Error(`Braintree capture failed: ${result.message}`);
  }

  return { transactionId: result.transaction.id };
}

/**
 * Void an authorization (fire when clearance fails - releases the hold immediately).
 */
export async function voidAuthorization(authorizationId: string): Promise<void> {
  const gateway = getGateway();
  const result = await gateway.transaction.void(authorizationId);

  if (!result.success) {
    throw new Error(`Braintree void failed: ${result.message}`);
  }
}

/**
 * Verify a Braintree webhook signature.
 * Returns the parsed notification or throws if invalid.
 */
export async function parseWebhookNotification(
  signature: string,
  payload: string,
): Promise<{ kind: string; subject: any }> {
  const gateway = getGateway();
  const notification = await gateway.webhookNotification.parse(signature, payload);
  return { kind: notification.kind, subject: notification.subject };
}

/**
 * Check if Braintree credentials are configured.
 */
export function isBraintreeConfigured(): boolean {
  return !!(
    process.env.BRAINTREE_MERCHANT_ID &&
    process.env.BRAINTREE_PUBLIC_KEY &&
    process.env.BRAINTREE_PRIVATE_KEY
  );
}
