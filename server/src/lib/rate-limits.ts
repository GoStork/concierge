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

function clientIp(req: any): string {
  const fwd = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  // ipKeyGenerator normalises IPv6 into a /56 block so a single host cannot
  // rotate through its own address space to get a fresh bucket each request.
  return ipKeyGenerator(fwd || req.ip || req.socket?.remoteAddress || "unknown");
}

const base: Partial<Options> = {
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIp,
  // Tests and health checks hammer the server from localhost; never let a
  // limiter turn the suite red. Production traffic never arrives from ::1.
  skip: (req: any) => {
    const ip = String(req.ip || "");
    return ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1";
  },
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

/** Unauthenticated write endpoints (client crash sink, public booking). */
export const publicWriteLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 60,
  message: { message: "Too many requests." },
});
