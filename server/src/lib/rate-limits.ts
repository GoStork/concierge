/**
 * Rate limits (OWASP A07 / A06).
 *
 * The platform had none: /api/auth/login accepted unlimited credential guesses,
 * /api/auth/verify-otp unlimited code guesses, and /api/client-errors unlimited
 * writes into the one log file that serves as our forensic record. The OTP
 * *send* path was already well defended by OtpGuardService (per-phone, per-IP,
 * per-country) - these limits cover the paths it does not.
 *
 * Keyed on the first X-Forwarded-For hop, which is what the app already trusts
 * behind ngrok / Caddy. That is forgeable by a determined attacker, so these
 * are a brake on volumetric abuse, not an identity control. Account-level
 * lockout is tracked separately in the launch runbook.
 */
import rateLimit, { ipKeyGenerator, type Options } from "express-rate-limit";
import { clientIpFrom } from "./auth-audit";
import { timingSafeEqual } from "node:crypto";

function clientIp(req: any): string {
  // Same resolution as the audit log. Behind Cloudflare the first
  // X-Forwarded-For hop is a Cloudflare edge address, so keying on it would
  // bucket unrelated visitors together and let one attacker exhaust everyone
  // else's allowance.
  const ip = clientIpFrom(req) || "unknown";
  // ipKeyGenerator normalises IPv6 into a /56 block so a single host cannot
  // rotate through its own address space to get a fresh bucket each request.
  return ipKeyGenerator(ip);
}

/**
 * The ONLY way to skip a limiter.
 *
 * This used to skip when req.ip looked like loopback, which was a hole: with
 * `trust proxy` on, req.ip is derived from X-Forwarded-For, so anyone could
 * send `X-Forwarded-For: 127.0.0.1` and skip every limit on the server.
 * Measured before the fix: 24 consecutive failed logins, not one 429.
 *
 * Nor can it key off the socket address, because in production Caddy proxies
 * from localhost - that would skip all real traffic.
 *
 * So the bypass is an explicit shared secret that only the test runner knows,
 * compared in constant time. No secret configured means no bypass at all.
 */
function isTestRunner(req: any): boolean {
  const token = process.env.TEST_RUNNER_TOKEN;
  if (!token) return false;
  const provided = req.headers?.["x-test-runner-token"];
  if (typeof provided !== "string" || provided.length !== token.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(token));
  } catch {
    return false;
  }
}

const base: Partial<Options> = {
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIp,
  skip: isTestRunner,
};

/** Credential guessing: login, password reset request, OTP verification. */
export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: { message: "Too many attempts. Please wait a few minutes and try again." },
});

/** Password reset emails - also a mail-bomb vector against a known address. */
export const passwordResetLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: { message: "Too many password reset requests. Please try again later." },
});

/** Unauthenticated write endpoints (client crash sink, CSP reports). */
export const publicWriteLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 60,
  message: { message: "Too many requests." },
});

/**
 * Public booking (POST /api/calendar/book/:slug).
 *
 * Unauthenticated by design - a provider's share link has to work for someone
 * with no account. But the slug and the availability behind it are public, so
 * without a ceiling one script can fill an agency's entire calendar with
 * throwaway addresses and deny every real family a slot. Tighter than the
 * generic public limit because a human books once, not twenty times an hour.
 */
export const publicBookingLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 8,
  message: {
    message: "Too many booking attempts from this network. Please wait a little and try again.",
  },
});
