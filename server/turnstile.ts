/**
 * Cloudflare Turnstile verification for the signup flow.
 *
 * Turnstile is a CAPTCHA-style bot check that runs as a widget IN the signup
 * form and is verified server-side on the send-otp call. Unlike the Cloudflare
 * edge challenge (which a direct-to-API bot skips by never loading the page),
 * Turnstile's token is minted client-side and MUST be presented to our own
 * endpoint - so a script that calls /api/auth/send-otp directly has no valid
 * token and is refused, no matter what host or IP it comes from. This is the
 * URL-independent permanent fix; it protects the app even on the ngrok dev URL,
 * which sits outside the Cloudflare zone entirely.
 *
 * Env-gated, exactly like the Cloudflare edge sync:
 *
 *   TURNSTILE_SITE_KEY    public, safe to hand the browser (served by the
 *                         /api/auth/turnstile-config endpoint)
 *   TURNSTILE_SECRET_KEY  private, server only - used for siteverify
 *
 * With the SECRET unset, verification is skipped (returns ok) so dev and the
 * test suite are never blocked, and the widget stays inert until the keys are
 * added. Loud-failure principle: when the secret IS set, a missing or invalid
 * token is a hard 400 - we never silently let an unverified signup through.
 */

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The secret gates enforcement; the site key alone only renders a widget. */
export function turnstileEnforced(): boolean {
  return !!process.env.TURNSTILE_SECRET_KEY;
}

export function turnstileSiteKey(): string | null {
  return process.env.TURNSTILE_SITE_KEY || null;
}

interface TurnstileResult {
  ok: boolean;
  /** cloudflare error codes, e.g. "invalid-input-response", for logging */
  errorCodes?: string[];
}

/**
 * Verify a Turnstile token with Cloudflare. Returns ok:true (skip) when no
 * secret is configured. Never throws - the caller decides how to react so the
 * failure surfaces as a clean 400, not a 500.
 */
export async function verifyTurnstile(token: string | undefined | null, ip: string | null): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true }; // not configured - inert

  if (!token || typeof token !== "string") {
    return { ok: false, errorCodes: ["missing-input-response"] };
  }

  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (ip) form.set("remoteip", ip);

    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: !!body?.success, errorCodes: body?.["error-codes"] };
  } catch {
    // Cloudflare unreachable. Fail OPEN rather than lock every parent out of
    // signup on a transient network blip - the OTP guard (rate limits,
    // country policy) is still in front, so this is defence-in-depth, not the
    // only gate. A hard network outage should not equal "nobody can sign up".
    return { ok: true, errorCodes: ["siteverify-unreachable"] };
  }
}
