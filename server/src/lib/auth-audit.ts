/**
 * Authentication audit trail (OWASP A09 - Security Logging and Alerting).
 *
 * Before this existed the platform recorded nothing about authentication: a
 * failed login, a password reset, a role change and an admin creating another
 * admin all left zero trace. After an incident there was nothing to read.
 *
 * Two rules:
 *  1. Never store credential material. No passwords, codes, tokens or secrets.
 *  2. Never break the request. Writing an audit row is best-effort - if the
 *     insert fails we log and carry on rather than failing someone's login.
 */
import { shipAuthEventOffbox } from "./auth-audit-offbox";

export type AuthAuditEvent =
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILURE"
  | "TWO_FACTOR_SUCCESS"
  | "TWO_FACTOR_FAILURE"
  | "TWO_FACTOR_ENABLED"
  | "TWO_FACTOR_DISABLED"
  | "RECOVERY_CODE_USED"
  | "PASSWORD_RESET_REQUESTED"
  | "PASSWORD_RESET_COMPLETED"
  | "ROLES_CHANGED"
  | "USER_CREATED_BY_ADMIN"
  | "USER_DELETED_BY_ADMIN"
  | "USER_DISABLED";

/**
 * Prefix on `detail` for events caused by our own test suites (the request
 * carried the valid TEST_RUNNER_TOKEN). The row is still written - the audit
 * trail stays complete - but the watchdog does not alert on it.
 */
export const TEST_RUNNER_DETAIL_PREFIX = "test_runner:";

export interface AuthAuditInput {
  event: AuthAuditEvent;
  userId?: string | null;
  email?: string | null;
  actorId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: string | null;
}

/**
 * The visitor's address.
 *
 * Production sits behind Cloudflare in front of Caddy, and in that chain the
 * first X-Forwarded-For hop is a CLOUDFLARE EDGE address (verified in the
 * production audit log: 162.158.63.201). Keying on that makes the audit trail
 * useless for identifying an attacker and makes the rate limiter bucket half
 * the internet together. CF-Connecting-IP is the header Cloudflare sets to the
 * original visitor address, so prefer it.
 *
 * Caveat: CF-Connecting-IP is only trustworthy because the origin is reachable
 * solely through Cloudflare. If the origin is ever exposed directly, a client
 * can set that header itself. Restricting the origin to Cloudflare's ranges is
 * tracked in the launch runbook.
 */
export function clientIpFrom(req: any): string | null {
  const cf = req?.headers?.["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  const real = req?.headers?.["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  const fwd = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req?.socket?.remoteAddress || req?.ip || null;
}

/** Alias kept for the audit call sites. */
export function requestIp(req: any): string | null {
  return clientIpFrom(req);
}

export function requestUserAgent(req: any): string | null {
  const ua = req?.headers?.["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 300) : null;
}

const oneLine = (v: string | null | undefined, max: number): string | null =>
  typeof v === "string" ? v.replace(/[\r\n\u2028\u2029]+/g, " ").slice(0, max) : null;

/**
 * Writes one audit row. `db` is any Prisma-ish client exposing `authAuditLog`
 * (PrismaService or the raw client). Never throws.
 */
export async function recordAuthEvent(db: any, input: AuthAuditInput): Promise<void> {
  const data = {
    event: input.event,
    userId: input.userId ?? null,
    email: oneLine(input.email?.toLowerCase(), 320),
    actorId: input.actorId ?? null,
    ip: oneLine(input.ip, 60),
    userAgent: oneLine(input.userAgent, 300),
    detail: oneLine(input.detail, 300),
  };
  // Off-box first and independently: if the database is the thing under attack
  // (or down), the copy the application cannot delete must still be written.
  void shipAuthEventOffbox({ ...data, at: new Date().toISOString() });
  try {
    await db.authAuditLog.create({ data });
  } catch (e: any) {
    console.error(`[auth-audit] Failed to record ${input.event}: ${e?.message}`);
  }
}

/** Fire-and-forget wrapper for hot paths that must not wait on the insert. */
export function recordAuthEventAsync(db: any, input: AuthAuditInput): void {
  void recordAuthEvent(db, input);
}
