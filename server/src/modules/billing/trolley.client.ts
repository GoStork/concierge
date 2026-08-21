/**
 * Thin Trolley (formerly Payment Rails) REST client.
 *
 * Trolley is GoStork's INTERNATIONAL payout rail: every non-US provider is
 * onboarded in Trolley's embedded widget (bank details + W-8BEN-E) and paid
 * through a Trolley batch/payment when their invoice is PAID. US providers
 * stay on Stripe Connect (shared/payout-countries.ts).
 *
 * Auth (per Trolley docs): every request carries
 *   Authorization: prsign <ACCESS_KEY>:<hex HMAC-SHA256(secret, "ts\nMETHOD\npath\nbody\n")>
 *   X-PR-Timestamp: <unix seconds, within 30s of UTC>
 * Sandbox vs live is decided by WHICH key pair is used - one API host.
 *
 * Env: TROLLEY_ACCESS_KEY, TROLLEY_SECRET_KEY (sandbox keys on test-app until
 * the Trolley account is activated), TROLLEY_WEBHOOK_SECRET (the signing key
 * from Settings > Webhooks), optional TROLLEY_API_BASE / TROLLEY_WIDGET_BASE.
 */
import crypto from "crypto";

const API_BASE = process.env.TROLLEY_API_BASE || "https://api.trolley.com";
const WIDGET_BASE = process.env.TROLLEY_WIDGET_BASE || "https://widget.trolley.com";

export function trolleyConfigured(): boolean {
  return !!(process.env.TROLLEY_ACCESS_KEY && process.env.TROLLEY_SECRET_KEY);
}

/**
 * PARKED (2026-08-20): Trolley rejected GoStork's bank-transfer application,
 * so the whole rail is disabled unless TROLLEY_ENABLED=1 is set explicitly
 * (sandbox experiments / a future re-application). While disabled,
 * international providers are paid by manual wire via the admin
 * transfer-failed queue.
 */
export function trolleyEnabled(): boolean {
  return process.env.TROLLEY_ENABLED === "1" && trolleyConfigured();
}

function keys() {
  const accessKey = process.env.TROLLEY_ACCESS_KEY;
  const secretKey = process.env.TROLLEY_SECRET_KEY;
  if (!accessKey || !secretKey) throw new Error("Trolley is not configured (TROLLEY_ACCESS_KEY / TROLLEY_SECRET_KEY missing)");
  return { accessKey, secretKey };
}

export class TrolleyApiError extends Error {
  constructor(public status: number, public body: any, message: string) {
    super(message);
  }
}

async function request<T = any>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const { accessKey, secretKey } = keys();
  const ts = Math.floor(Date.now() / 1000).toString();
  const payload = body === undefined ? "" : JSON.stringify(body);
  const signature = crypto.createHmac("sha256", secretKey).update(`${ts}\n${method}\n${path}\n${payload}\n`).digest("hex");
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `prsign ${accessKey}:${signature}`,
      "X-PR-Timestamp": ts,
      "Content-Type": "application/json",
    },
    body: payload || undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok || json?.ok === false) {
    const msg = json?.errors?.map((e: any) => e?.message || e?.code).filter(Boolean).join("; ") || json?.message || `Trolley ${method} ${path} -> ${res.status}`;
    throw new TrolleyApiError(res.status, json, msg);
  }
  return json as T;
}

// ── Recipients ──────────────────────────────────────────────────────────────

export interface TrolleyRecipientInput {
  type: "individual" | "business";
  email: string;
  name?: string;           // business
  firstName?: string;      // individual
  lastName?: string;
  referenceId?: string;    // our providerId
  address?: { street1?: string; street2?: string; city?: string; region?: string; postalCode?: string; country?: string; phone?: string };
  tags?: string[];
}

export async function createRecipient(input: TrolleyRecipientInput): Promise<any> {
  const r = await request<{ recipient: any }>("POST", "/v1/recipients", input);
  return r.recipient;
}

export async function getRecipient(recipientId: string): Promise<any> {
  const r = await request<{ recipient: any }>("GET", `/v1/recipients/${encodeURIComponent(recipientId)}`);
  return r.recipient;
}

export async function updateRecipient(recipientId: string, patch: Partial<TrolleyRecipientInput>): Promise<void> {
  await request("PATCH", `/v1/recipients/${encodeURIComponent(recipientId)}`, patch);
}

export async function findRecipientByReferenceId(referenceId: string): Promise<any | null> {
  const r = await request<{ recipients: any[] }>("GET", `/v1/recipients?referenceId=${encodeURIComponent(referenceId)}&pageSize=5`);
  return (r.recipients || []).find((x) => x.referenceId === referenceId) || null;
}

export async function listRecipientAccounts(recipientId: string): Promise<any[]> {
  const r = await request<{ accounts: any[] }>("GET", `/v1/recipients/${encodeURIComponent(recipientId)}/accounts`);
  return r.accounts || [];
}

// ── Widget ──────────────────────────────────────────────────────────────────

/**
 * Signed URL for Trolley's embedded recipient widget (payout method + tax
 * form self-onboarding). Per the widget docs: query string (without `sign`)
 * -> HMAC-SHA256 hex with the SECRET key, appended as &sign=. Valid ~30s, so
 * mint it right before the iframe mounts.
 */
export function buildWidgetUrl(opts: {
  email: string;
  referenceId: string;
  products?: string[];      // ["pay","tax"]
  locale?: string;
  prefill?: { firstName?: string; lastName?: string; street1?: string; city?: string; country?: string };
  colors?: Record<string, string>; // e.g. { primary: "08726F" }
}): string {
  const { accessKey, secretKey } = keys();
  const params: Record<string, string> = {
    ts: String(Math.floor(Date.now() / 1000)),
    key: accessKey,
    email: opts.email,
    refid: opts.referenceId,
    hideEmail: "false",
    roEmail: "true",
    products: (opts.products || ["pay", "tax"]).join(","),
  };
  if (opts.locale) params.locale = opts.locale;
  for (const [k, v] of Object.entries(opts.prefill || {})) if (v) params[`addr.${k}`] = v;
  for (const [k, v] of Object.entries(opts.colors || {})) if (v) params[`colors.${k}`] = v;
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const sign = crypto.createHmac("sha256", secretKey).update(qs).digest("hex");
  return `${WIDGET_BASE}/?${qs}&sign=${sign}`;
}

// ── Batches / payments ──────────────────────────────────────────────────────

export async function createBatch(input: { description?: string; sourceCurrency?: string }): Promise<any> {
  const r = await request<{ batch: any }>("POST", "/v1/batches", { description: input.description, sourceCurrency: input.sourceCurrency || "USD" });
  return r.batch;
}

export async function addPayment(batchId: string, input: {
  recipientId: string;
  /** Source amount in the batch's source currency, as a decimal string ("4.50"). */
  sourceAmount: string;
  sourceCurrency?: string;
  memo?: string;
  externalId?: string;  // our invoiceId
}): Promise<any> {
  const r = await request<{ payment: any }>("POST", `/v1/batches/${encodeURIComponent(batchId)}/payments`, {
    recipient: { id: input.recipientId },
    sourceAmount: input.sourceAmount,
    sourceCurrency: input.sourceCurrency || "USD",
    memo: input.memo,
    externalId: input.externalId,
  });
  return r.payment;
}

export async function startBatchProcessing(batchId: string): Promise<any> {
  const r = await request<{ batch: any }>("POST", `/v1/batches/${encodeURIComponent(batchId)}/start-processing`, {});
  return r.batch;
}

export async function getPayment(paymentId: string): Promise<any> {
  const r = await request<{ payment: any }>("GET", `/v1/payments/${encodeURIComponent(paymentId)}`);
  return r.payment;
}

export async function getBalances(): Promise<any[]> {
  const r = await request<{ balances: any[] }>("GET", "/v1/balances");
  return r.balances || [];
}

// ── Webhooks ────────────────────────────────────────────────────────────────

/**
 * Trolley signs deliveries with `x-paymentrails-signature: t=<ts>,v1=<hex>`
 * where v1 = HMAC-SHA256(webhookSigningKey, `${t}${rawBody}`). The signing
 * key lives in Settings > Webhooks. `x-paymentrails-delivery` is the unique
 * delivery id (idempotency), `x-paymentrails-created` the event time.
 */
export function verifyWebhookSignature(headerValue: string | undefined, rawBody: string): { ok: boolean; reason?: string } {
  const secret = process.env.TROLLEY_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: "TROLLEY_WEBHOOK_SECRET not configured" };
  if (!headerValue) return { ok: false, reason: "missing x-paymentrails-signature" };
  const m = headerValue.match(/t=(\d+),\s*v1=([a-f0-9]{64})/i);
  if (!m) return { ok: false, reason: "malformed signature header" };
  const [, t, v1] = m;
  const expected = crypto.createHmac("sha256", secret).update(`${t}${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1.toLowerCase(), "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };
  // Replay window: 5 minutes.
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return { ok: false, reason: "stale timestamp" };
  return { ok: true };
}
