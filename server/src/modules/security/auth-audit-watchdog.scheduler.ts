import * as cron from "node-cron";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationService } from "../notifications/notification.service";

/**
 * Watches the authentication audit trail and emails admins when it looks like
 * an attack rather than a bad morning (OWASP A09 - Security Logging AND
 * ALERTING).
 *
 * AuthAuditLog started recording logins, second-factor events, resets and role
 * changes, but nothing read it. A log nobody watches tells you what happened
 * only after someone already thought to look, which for an account takeover is
 * far too late - GoStork 1.0 lost its Stripe account to exactly that gap.
 *
 * Four signals, every 15 minutes, all read-only over the last window:
 *
 *   - 25+ failed logins from ONE address: credential stuffing. The per-address
 *     rate limit already slows this down; the point here is to be told it is
 *     happening.
 *   - 12+ failed logins against ONE account from any number of addresses:
 *     someone is working on a specific person, usually a known admin.
 *   - 6+ rejected second factors on one account: the attacker HAS the password
 *     and is guessing codes. The most serious of the four, because everything
 *     except the second factor has already fallen.
 *   - ANY privilege grant into a GoStork staff role, or any account deletion
 *     by an admin. Not volumetric - these are rare and each one should be
 *     recognised. An unexpected one is the signature of a takeover in progress.
 *
 * Alerts email every active admin, at most once per hour per signal, claimed
 * through Notification.dedupeKey exactly like the Twilio watchdog - both Macs
 * and the prod VM run this same cron, and a read-then-send gate would
 * double-send (see docs: duplicate notification guard).
 */

let scheduledTask: cron.ScheduledTask | null = null;

const WINDOW_MINUTES = 15;
const FAILS_PER_IP = 25;
const FAILS_PER_ACCOUNT = 12;
const TWO_FACTOR_FAILS_PER_ACCOUNT = 6;

const STAFF_ROLES = ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE", "GOSTORK_DEVELOPER"];

export interface AuthAuditFinding {
  kind: "ip_burst" | "account_burst" | "two_factor_burst" | "privilege_change";
  /** Stable within the hour, so repeated detections claim the same dedupe key. */
  key: string;
  headline: string;
  detail: string;
}

/**
 * Pure analysis, exported so it can be tested without a scheduler or a clock.
 * `rows` is the audit window, newest first or oldest first, order does not
 * matter.
 */
export function findAuthAnomalies(
  rows: Array<{ event: string; email: string | null; userId: string | null; ip: string | null; detail: string | null }>,
): AuthAuditFinding[] {
  const findings: AuthAuditFinding[] = [];

  const failsByIp = new Map<string, number>();
  const failsByAccount = new Map<string, number>();
  const twoFactorFailsByAccount = new Map<string, number>();

  for (const r of rows) {
    if (r.event === "LOGIN_FAILURE") {
      const ip = r.ip || "unknown";
      failsByIp.set(ip, (failsByIp.get(ip) || 0) + 1);
      const who = r.email || r.userId;
      if (who) failsByAccount.set(who, (failsByAccount.get(who) || 0) + 1);
    }
    if (r.event === "TWO_FACTOR_FAILURE") {
      const who = r.email || r.userId;
      if (who) twoFactorFailsByAccount.set(who, (twoFactorFailsByAccount.get(who) || 0) + 1);
    }
    // A grant INTO a staff role. The detail is "before -> after", so only a
    // role appearing on the right-hand side is an escalation.
    if (r.event === "ROLES_CHANGED" && r.detail) {
      const [, after = ""] = r.detail.split("->");
      const gained = STAFF_ROLES.filter((role) => after.includes(role));
      if (gained.length) {
        findings.push({
          kind: "privilege_change",
          key: `roles:${r.email || r.userId}`,
          headline: `${r.email || r.userId} was granted ${gained.join(", ")}`,
          detail: `Roles changed: ${r.detail.trim()}`,
        });
      }
    }
    if (r.event === "USER_DELETED_BY_ADMIN") {
      findings.push({
        kind: "privilege_change",
        key: `deleted:${r.email || r.userId}`,
        headline: `An admin deleted the account ${r.email || r.userId}`,
        detail: r.detail || "Account deleted",
      });
    }
  }

  for (const [ip, n] of failsByIp) {
    if (n >= FAILS_PER_IP) {
      findings.push({
        kind: "ip_burst",
        key: `ip:${ip}`,
        headline: `${n} failed sign-ins from ${ip} in ${WINDOW_MINUTES} minutes`,
        detail: "Looks like credential stuffing. The per-address rate limit is already refusing most of these.",
      });
    }
  }
  for (const [who, n] of failsByAccount) {
    if (n >= FAILS_PER_ACCOUNT) {
      findings.push({
        kind: "account_burst",
        key: `account:${who}`,
        headline: `${n} failed sign-ins against ${who} in ${WINDOW_MINUTES} minutes`,
        detail: "Someone is working on this specific account rather than spraying.",
      });
    }
  }
  for (const [who, n] of twoFactorFailsByAccount) {
    if (n >= TWO_FACTOR_FAILS_PER_ACCOUNT) {
      findings.push({
        kind: "two_factor_burst",
        key: `2fa:${who}`,
        headline: `${n} rejected second-factor codes on ${who} in ${WINDOW_MINUTES} minutes`,
        detail:
          "Treat this as the password already being known - only the authenticator is holding. " +
          "Consider resetting that password and checking the account's recent activity.",
      });
    }
  }

  return findings;
}

async function runOnce(prisma: PrismaService, notifications: NotificationService) {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000);
  let rows: any[];
  try {
    rows = await prisma.authAuditLog.findMany({
      where: { createdAt: { gte: since } },
      select: { event: true, email: true, userId: true, ip: true, detail: true },
    });
  } catch (e: any) {
    console.error(`[auth-watchdog] Could not read the audit log: ${e?.message}`);
    return;
  }
  if (!rows.length) return;

  const findings = findAuthAnomalies(rows);
  if (!findings.length) return;

  const admin = await prisma.user.findFirst({
    where: { roles: { has: "GOSTORK_ADMIN" }, isDisabled: false },
    select: { id: true, email: true },
  });
  if (!admin) {
    console.warn("[auth-watchdog] Anomaly detected but no active GOSTORK_ADMIN to notify");
    return;
  }

  const hourKey = new Date().toISOString().slice(0, 13);
  const toSend: AuthAuditFinding[] = [];
  for (const f of findings) {
    // One claim per signal per hour. P2002 means another instance (or an
    // earlier tick) already took this one.
    try {
      await prisma.notification.create({
        data: {
          userId: admin.id,
          type: "security_auth_alert",
          channel: "email",
          recipient: admin.email || "",
          status: "sent",
          sentAt: new Date(),
          dedupeKey: `auth-anomaly:${f.key}:${hourKey}`,
        },
      });
      toSend.push(f);
    } catch (e: any) {
      if (e?.code === "P2002") continue;
      console.error(`[auth-watchdog] Could not claim alert ${f.key}: ${e?.message}`);
    }
  }
  if (!toSend.length) return;

  for (const f of toSend) {
    console.warn(`[auth-watchdog] ALERT ${f.kind}: ${f.headline}`);
  }
  await notifications.sendAuthAnomalyAlert({ windowMinutes: WINDOW_MINUTES, findings: toSend });
}

export function startAuthAuditWatchdog(prisma: PrismaService, notifications: NotificationService) {
  if (scheduledTask) return;
  scheduledTask = cron.schedule("*/15 * * * *", () => {
    runOnce(prisma, notifications).catch((e: any) =>
      console.error(`[auth-watchdog] Run failed: ${e?.message}`),
    );
  });
  console.log("[auth-watchdog] Scheduler started - reads the authentication audit log every 15 minutes");
}

/** Exposed for the admin "run it now" path and for tests. */
export const runAuthAuditWatchdogOnce = runOnce;
