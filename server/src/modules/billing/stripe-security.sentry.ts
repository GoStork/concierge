/**
 * Stripe security sentry.
 *
 * Born from the GoStork 1.0 breach (Aug-Sep 2024): attackers took over the
 * Stripe account (SMS 2FA), enabled Connect, created 52 fraudulent connected
 * accounts, charged ~$100k+ to stolen cards and paid it out to themselves.
 * The chargebacks became platform negative balances and Stripe debited
 * $42,199.32 from GoStork's bank - discovered weeks later, from the bank
 * statement, because nothing was watching. This module is the watching.
 *
 * Three defenses, all alerting through
 * NotificationService.sendSecurityAlertToAdmins (email + in-app, deduped
 * across both dev machines by the Notification dedupeKey):
 *
 *   1. verifyConnectedAccountKnown - called from the Connect webhook for
 *      every event. An account id our ProviderBankAccount table doesn't
 *      know is frozen (payout schedule -> manual) and alerted immediately.
 *   2. handlePlatformPayout - called from the platform webhook on
 *      payout.created. Legit platform payouts carry
 *      metadata.source="remainder-sweep" (stamped by createPlatformPayout);
 *      anything else moving money out of the platform balance is alerted.
 *   3. runStripeSecuritySweep - hourly cron. Reconciles Stripe's full
 *      connected-account list against the DB (webhooks can be missed;
 *      the sweep cannot), and checks 24h charge count/volume against
 *      ceilings (card-testing bursts are unmissable on our small profile).
 *
 * Alert wording is deliberately timestamp-free so the dedupeKey suppresses
 * the second machine's identical alert; a NEW day's sweep re-alerts because
 * unresolved incidents should keep making noise (dedupe includes the day).
 */
import * as cron from "node-cron";
import type Stripe from "stripe";
import { NotificationService } from "../notifications/notification.service";
import {
  isStripeConfigured,
  listAllConnectedAccounts,
  freezeConnectAccountPayouts,
  summarizeRecentCharges,
} from "../../../stripe-service";

// Anomaly ceilings - env-overridable, defaults sized for GoStork's real
// charge profile (a handful of large invoices, not hundreds of small ones).
const DAILY_CHARGE_COUNT_CEILING = parseInt(process.env.STRIPE_DAILY_CHARGE_COUNT_CEILING || "50", 10);
const DAILY_CHARGE_GROSS_CEILING_CENTS = parseInt(process.env.STRIPE_DAILY_CHARGE_GROSS_CEILING_CENTS || String(150_000_00), 10);

type SentryPrisma = {
  providerBankAccount: { findFirst: (args: any) => Promise<any>; findMany: (args: any) => Promise<any[]> };
};

/** In-process memo so one webhook burst doesn't re-freeze/re-alert per event. */
const alertedUnknownAccounts = new Set<string>();

function dashboardAccountUrl(accountId: string) {
  return `https://dashboard.stripe.com/connect/accounts/${accountId}`;
}

/**
 * Is this connected account one WE created? Unknown -> freeze + alert.
 * Called with every account id seen on the Connect webhook, and by the
 * reconcile sweep for every account Stripe lists.
 */
export async function verifyConnectedAccountKnown(
  prisma: SentryPrisma,
  notifications: NotificationService,
  accountId: string,
  context: string,
): Promise<boolean> {
  const known = await prisma.providerBankAccount.findFirst({
    where: { stripeConnectAccountId: accountId },
    select: { id: true },
  });
  if (known) return true;

  if (alertedUnknownAccounts.has(accountId)) return false;
  alertedUnknownAccounts.add(accountId);

  let frozen = false;
  try {
    await freezeConnectAccountPayouts(accountId);
    frozen = true;
  } catch (e: any) {
    console.error(`[stripe-sentry] Could not freeze payouts on unknown account ${accountId}: ${e?.message}`);
  }

  const day = new Date().toISOString().slice(0, 10);
  await notifications.sendSecurityAlertToAdmins({
    subject: `SECURITY: unknown Stripe connected account ${accountId}`,
    title: "Unknown Stripe Connected Account",
    summary: `Stripe reports a connected account (${accountId}) that GoStork's database did not create (seen via ${context}, ${day}). This is the exact pattern of the 2024 breach - fraudulent connected accounts charging stolen cards under our platform.`,
    detailRows: [
      { label: "Stripe account", value: accountId },
      { label: "Seen via", value: context },
      { label: "Payouts frozen", value: frozen ? "Yes - schedule set to manual" : "NO - freeze failed, act immediately" },
    ],
    action: "Review the account in the Stripe dashboard NOW. If it is not a provider you onboarded: reject the account, rotate all API keys, check Team/security history for unauthorized logins, and verify your 2FA methods (no SMS).",
    linkUrl: dashboardAccountUrl(accountId),
    linkLabel: "Review account in Stripe",
  }).catch((e: any) => console.error(`[stripe-sentry] Alert send failed for ${accountId}: ${e?.message}`));

  return false;
}

/**
 * Platform-balance payout watchdog. Every payout our code creates is stamped
 * metadata.source="remainder-sweep"; a payout without the stamp means
 * someone else - dashboard session or stolen key - is moving money out of
 * the platform balance.
 */
export async function handlePlatformPayout(
  notifications: NotificationService,
  payout: Stripe.Payout,
): Promise<void> {
  if (payout?.metadata?.source === "remainder-sweep") return;
  const amount = ((payout.amount || 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: (payout.currency || "usd").toUpperCase(),
  });
  await notifications.sendSecurityAlertToAdmins({
    subject: `SECURITY: platform payout ${payout.id} not created by GoStork code`,
    title: "Unexpected Platform Payout",
    summary: `A payout of ${amount} was created from the PLATFORM Stripe balance without the remainder-sweep stamp. GoStork code did not initiate it.`,
    detailRows: [
      { label: "Payout", value: payout.id },
      { label: "Amount", value: amount },
      { label: "Destination", value: typeof payout.destination === "string" ? payout.destination : payout.destination?.id || "unknown" },
    ],
    action: "If no admin created this payout manually in the dashboard, treat the account as compromised: cancel the payout if still pending, rotate keys, review Team + security history.",
    linkUrl: `https://dashboard.stripe.com/payouts/${payout.id}`,
    linkLabel: "Review payout in Stripe",
  }).catch((e: any) => console.error(`[stripe-sentry] Platform payout alert failed for ${payout.id}: ${e?.message}`));
}

export interface SecuritySweepResult {
  skipped?: string;
  accountsAtStripe?: number;
  unknownAccounts?: string[];
  chargeCount24h?: number;
  chargeGross24h?: number;
  volumeAlerted?: boolean;
}

/**
 * The hourly reconcile: webhooks can be missed or unsubscribed (the 1.0
 * attackers operated for a month unseen) - the sweep asks Stripe directly.
 */
export async function runStripeSecuritySweep(
  prisma: SentryPrisma,
  notifications: NotificationService,
): Promise<SecuritySweepResult> {
  if (!isStripeConfigured()) return { skipped: "Stripe not configured" };

  // 1. Connected-account reconcile.
  const accounts = await listAllConnectedAccounts();
  const unknown: string[] = [];
  for (const account of accounts) {
    const ok = await verifyConnectedAccountKnown(prisma, notifications, account.id, "hourly reconcile sweep");
    if (!ok) unknown.push(account.id);
  }

  // 2. Charge-volume anomaly (last 24h).
  const since = Math.floor(Date.now() / 1000) - 24 * 3600;
  let volumeAlerted = false;
  const { count, grossCents, truncated } = await summarizeRecentCharges(since);
  if (truncated || count > DAILY_CHARGE_COUNT_CEILING || grossCents > DAILY_CHARGE_GROSS_CEILING_CENTS) {
    volumeAlerted = true;
    const day = new Date().toISOString().slice(0, 10);
    const gross = (grossCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
    await notifications.sendSecurityAlertToAdmins({
      subject: `SECURITY: Stripe charge volume anomaly (${day})`,
      title: "Charge Volume Anomaly",
      summary: `The last 24 hours saw ${truncated ? "1,000+" : String(count)} charges totaling ${gross} - above the configured ceiling (${DAILY_CHARGE_COUNT_CEILING} charges / ${(DAILY_CHARGE_GROSS_CEILING_CENTS / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}). Card-testing bursts through a stolen key or hijacked session look exactly like this.`,
      detailRows: [
        { label: "Charges (24h)", value: truncated ? "1,000+ (listing truncated)" : String(count) },
        { label: "Gross (24h)", value: gross },
      ],
      action: "Review recent payments in the Stripe dashboard. If the charges are not yours: rotate keys immediately, enable Radar card-testing rules, and pause the integration.",
      linkUrl: "https://dashboard.stripe.com/payments",
      linkLabel: "Review payments in Stripe",
    }).catch((e: any) => console.error(`[stripe-sentry] Volume alert failed: ${e?.message}`));
  }

  if (unknown.length) {
    console.error(`[stripe-sentry] Sweep found ${unknown.length} UNKNOWN connected account(s): ${unknown.join(", ")}`);
  }
  return {
    accountsAtStripe: accounts.length,
    unknownAccounts: unknown,
    chargeCount24h: count,
    chargeGross24h: grossCents,
    volumeAlerted,
  };
}

let scheduledTask: cron.ScheduledTask | null = null;

export function startStripeSecuritySweep(prisma: SentryPrisma, notifications: NotificationService) {
  if (scheduledTask) {
    console.log("[stripe-sentry] Sweep already scheduled");
    return;
  }
  // :17 hourly - off the hour to avoid the top-of-hour cron pile-up.
  scheduledTask = cron.schedule("17 * * * *", async () => {
    try {
      const r = await runStripeSecuritySweep(prisma, notifications);
      if (r.skipped) return;
      if (!r.unknownAccounts?.length && !r.volumeAlerted) {
        console.log(`[stripe-sentry] Sweep clean: ${r.accountsAtStripe} connected account(s) all known, ${r.chargeCount24h} charge(s) in 24h`);
      }
    } catch (e: any) {
      console.error(`[stripe-sentry] Sweep failed: ${e?.message}`);
    }
  });
  console.log("[stripe-sentry] Hourly security sweep scheduled (connected-account reconcile + charge-volume anomaly)");
}

export function stopStripeSecuritySweep() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}
