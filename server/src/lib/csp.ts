/**
 * Content Security Policy (OWASP A02).
 *
 * The app shipped with no CSP, so any successful script injection ran with
 * full privileges. Two concrete reasons this is worth the effort here:
 *
 *  - the image proxy used to echo an upstream Content-Type, which meant HTML
 *    could be served from our own origin (fixed separately, but CSP is the
 *    layer that would have contained it);
 *  - profile-detail-page renders a SCRAPED url in an iframe whenever it merely
 *    contains "embed", "player" or "iframe", so an agency page we sync can
 *    frame arbitrary content into the app. frame-src is the control for that.
 *
 * Nonce: our own built index.html carries no inline script, so `'self'` would
 * be enough for OUR code. The nonce exists for Cloudflare. Behind the proxy,
 * Cloudflare injects an inline bot-detection script into every HTML page
 * (found in the report-only log on test-app, 2026-09-18 - it never appears on
 * the dev Macs). Cloudflare reads the nonce out of our CSP response header and
 * stamps it onto the script it injects, so a per-request nonce lets that one
 * script run without opening the door to 'unsafe-inline'. The nonce is never
 * written into our own HTML, so an attacker who injects markup cannot reuse it.
 * `style-src` does need 'unsafe-inline' because the UI sets style attributes
 * throughout (Radix, and our own inline brand tones); inline styles are a far
 * smaller risk than inline script.
 *
 * MODE: set CSP_MODE to
 *   enforce (default) - block violations
 *   report            - send Content-Security-Policy-Report-Only instead, so
 *                       nothing breaks while violations are collected
 *   off               - send no header at all (emergency escape hatch)
 */

export type CspMode = "enforce" | "report" | "off";

export function cspMode(): CspMode {
  const raw = (process.env.CSP_MODE || "enforce").toLowerCase();
  if (raw === "off" || raw === "report") return raw;
  return "enforce";
}

/** Swapped for a fresh random value on every response - see cspWithNonce(). */
const NONCE_PLACEHOLDER = "__CSP_NONCE__";

/** Stamps one request's nonce into the policy built once at boot. */
export function cspWithNonce(policy: string, nonce: string): string {
  return policy.replace(NONCE_PLACEHOLDER, nonce);
}

/** Where violation reports are posted. Same origin, so no CORS dance. */
export const CSP_REPORT_PATH = "/api/csp-report";

export function buildCsp(opts: { isProduction: boolean }): string {
  const { isProduction } = opts;

  // Vite's dev server injects an inline preamble and talks over a websocket,
  // neither of which survives a strict policy. Both dev Macs actually run with
  // NODE_ENV=production and serve the built bundle, so this branch is only for
  // a true `npm run dev`.
  const devScript = isProduction ? [] : ["'unsafe-inline'", "'unsafe-eval'"];
  const devConnect = isProduction ? [] : ["ws:", "wss:", "http://localhost:*", "ws://localhost:*"];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],

    "script-src": [
      "'self'",
      `'nonce-${NONCE_PLACEHOLDER}'`,       // Cloudflare's injected bot-detection script
      // Ask the browser to include the first 40 characters of a blocked inline
      // script in the report. Without it a violation only says "inline" and
      // the culprit has to be guessed.
      "'report-sample'",
      "https://static.cloudflareinsights.com", // Cloudflare Web Analytics, injected at the edge
      "https://js.stripe.com",              // Stripe Elements / card fields
      "https://challenges.cloudflare.com",  // Turnstile bot check on signup
      // Daily.co ships in our bundle, but the call client pulls extra pieces
      // from its own domain at runtime. Video calls are the one critical
      // surface that cannot be exercised from here without a live booking, so
      // this is deliberately permissive toward their origin rather than
      // risking a blocked call in production.
      "https://*.daily.co",
      // Voice mode builds its AudioWorklet from a Blob URL
      // (client/src/lib/voice/audio.ts). AudioWorklet module loads are
      // governed by script-src, so without this the microphone pipeline dies.
      "blob:",
      ...devScript,
    ],

    // Radix and our own components set style attributes; CSS-in-JS and the
    // brand variables are applied at runtime. Blocking inline style would
    // break the entire UI for very little security gain.
    "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    "style-src-attr": ["'self'", "'unsafe-inline'"],

    "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],

    // Photos come from a long tail of agency CDNs, Google Cloud Storage and
    // logo.dev, plus data:/blob: for previews, cropping and the 2FA QR code.
    // An https: allowlist here would be a maintenance trap that silently hides
    // donor photos; images are not an execution sink.
    "img-src": ["'self'", "data:", "blob:", "https:"],

    // Recordings (GCS signed URLs), proxied agency videos, recorded audio.
    "media-src": ["'self'", "blob:", "data:", "https:"],

    "connect-src": [
      "'self'",
      // Stripe.js talks to more than api.stripe.com at runtime.
      "https://api.stripe.com",
      "https://js.stripe.com",
      "https://m.stripe.network",
      "https://r.stripe.com",
      "https://challenges.cloudflare.com",
      "https://cloudflareinsights.com",     // where the analytics beacon posts
      "https://*.daily.co",                 // video call signalling
      "wss://*.daily.co",
      // The talking-avatar session connects to a LiveKit URL that LiveAvatar
      // hands out per session, so there is no single host to pin. Their
      // regions live under livekit.cloud; if that ever changes the avatar goes
      // silent and the violation shows up at /api/csp-report.
      "https://*.livekit.cloud",
      "wss://*.livekit.cloud",
      "https://nominatim.openstreetmap.org",// address autocomplete
      "https://ipapi.co",                   // country guess on the address step
      ...devConnect,
    ],

    "frame-src": [
      "'self'",                             // /video/:id is framed same-origin
      "https://*.daily.co",
      "https://js.stripe.com",
      "https://hooks.stripe.com",
      "https://challenges.cloudflare.com",
      "https://*.pandadoc.com",             // agreement and W-9 signing
      "https://*.pandadoc.eu",              // the template editor SDK hardcodes both
      "https://widget.trolley.com",         // provider payout onboarding
      "https://player.vimeo.com",           // donor intro videos
      "https://www.youtube.com",
      "https://www.youtube-nocookie.com",
    ],

    // Daily.co creates workers from blob: URLs.
    "worker-src": ["'self'", "blob:"],

    // Nothing legitimately embeds GoStork, and this is the modern replacement
    // for X-Frame-Options (which we also still send for older browsers).
    "frame-ancestors": ["'self'"],

    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };

  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`);
  parts.push(`report-uri ${CSP_REPORT_PATH}`);
  // Deliberately NOT upgrade-insecure-requests: it would rewrite http://
  // localhost calls during local testing.
  return parts.join("; ");
}
