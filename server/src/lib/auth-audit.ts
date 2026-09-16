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

export interface AuthAuditInput {
  event: AuthAuditEvent;
  userId?: string | null;
  email?: string | null;
  actorId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: string | null;
}

/** First X-Forwarded-For hop, which is what the app already trusts behind
 *  ngrok / Caddy. Forgeable by a determined attacker, so treat it as a hint. */
export function requestIp(req: any): string | null {
  const fwd = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req?.socket?.remoteAddress || req?.ip || null;
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
  try {
    await db.authAuditLog.create({
      data: {
        event: input.event,
        userId: input.userId ?? null,
        email: oneLine(input.email?.toLowerCase(), 320),
        actorId: input.actorId ?? null,
        ip: oneLine(input.ip, 60),
        userAgent: oneLine(input.userAgent, 300),
        detail: oneLine(input.detail, 300),
      },
    });
  } catch (e: any) {
    console.error(`[auth-audit] Failed to record ${input.event}: ${e?.message}`);
  }
}

/** Fire-and-forget wrapper for hot paths that must not wait on the insert. */
export function recordAuthEventAsync(db: any, input: AuthAuditInput): void {
  void recordAuthEvent(db, input);
}
