/**
 * Signup risk scoring (Phase 9 §8, #2 per-IP caps + #3 quarantine).
 *
 * Runs once, at parent account creation, AFTER the hard gates (disposable
 * email, alias-flood, Turnstile). Those already refuse the clear-cut abuse;
 * this is the softer layer: a signup that looks risky is not turned away, it
 * is QUARANTINED - the account exists but is flagged for a human in the
 * /parents review queue. This never blocks a real parent by mistake (a shared
 * office IP, a VPN) - worst case they wait for a one-click approve.
 *
 * Signals today:
 *   ip_velocity   - more than the configured cap of accounts from one IP in
 *                   24h. A household has 1-2; a script has dozens.
 *   no_turnstile  - the signup carried no Turnstile pass (only possible when
 *                   Turnstile is configured, so its absence is suspicious).
 *
 * The per-IP cap lives in SecuritySetting (editable on /admin/security),
 * defaulting to 5/day.
 */
import type { PrismaService } from "./src/modules/prisma/prisma.service";

export const DEFAULT_IP_SIGNUP_CAP = 5;

export async function getIpSignupCap(prisma: PrismaService): Promise<number> {
  try {
    const row = await prisma.securitySetting.findUnique({ where: { key: "ip_signup_cap_per_day" } });
    const n = row ? parseInt(row.value, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_IP_SIGNUP_CAP;
  } catch {
    return DEFAULT_IP_SIGNUP_CAP;
  }
}

export interface SignupRisk {
  trustState: "TRUSTED" | "QUARANTINED";
  reasons: string[];
}

export async function evaluateSignupRisk(
  prisma: PrismaService,
  opts: { ip: string | null; turnstilePassed: boolean },
): Promise<SignupRisk> {
  const reasons: string[] = [];

  if (opts.ip) {
    const cap = await getIpSignupCap(prisma);
    const dayAgo = new Date(Date.now() - 86_400_000);
    const recent = await prisma.user.count({
      where: { signupIp: opts.ip, createdAt: { gte: dayAgo } },
    });
    // recent counts accounts ALREADY created from this IP; the one being
    // created now is the (recent + 1)th. Flag when it exceeds the cap.
    if (recent >= cap) reasons.push("ip_velocity");
  }

  if (!opts.turnstilePassed) reasons.push("no_turnstile");

  return { trustState: reasons.length ? "QUARANTINED" : "TRUSTED", reasons };
}

const REASON_LABELS: Record<string, string> = {
  ip_velocity: "Many signups from one IP",
  no_turnstile: "No bot-check token",
  disposable_email: "Disposable email",
};

export function labelSignupReason(code: string): string {
  return REASON_LABELS[code] || code;
}
