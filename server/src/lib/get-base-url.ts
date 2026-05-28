/**
 * Single source of truth for "what URL should we put in links we send
 * out" (SMS, email, PandaDoc completion URLs, etc.). Previously this
 * lived as four duplicated helpers across the codebase, each just
 * reading `APP_URL`. That meant if `APP_URL` got copied between deploys
 * (e.g. a dev ngrok URL ending up in Replit's secrets), every outbound
 * link broke.
 *
 * Resolution order (first one that returns a non-empty value wins):
 *
 *   1. `APP_URL` - explicit override. Set this on a custom domain or
 *      anywhere you don't want auto-detection. Trailing slashes stripped.
 *
 *   2. `REPLIT_DOMAINS` - comma-separated list Replit injects on every
 *      deploy. We take the first domain. Auto-handles staging vs prod
 *      Replit URLs without manual config.
 *
 *   3. `RENDER_EXTERNAL_URL` - Render's auto-injected public URL.
 *
 *   4. `VERCEL_PROJECT_PRODUCTION_URL` then `VERCEL_URL` - Vercel.
 *
 *   5. `RAILWAY_PUBLIC_DOMAIN` - Railway.
 *
 *   6. `FLY_APP_NAME` -> `https://{name}.fly.dev` - Fly.io.
 *
 *   7. Dev fallback: `http://localhost:{PORT|5001}` when NODE_ENV !==
 *      "production".
 *
 *   8. Production fallback: `https://app.gostork.com`. Last resort -
 *      only hit if we ship to a host that doesn't match any of the
 *      detectors above and forgot to set APP_URL.
 *
 * Always returns with NO trailing slash so callers can do
 * `${getBaseUrl()}/some/path` safely.
 */
export function getBaseUrl(): string {
  const strip = (u: string) => u.replace(/\/+$/, "");

  if (process.env.APP_URL) return strip(process.env.APP_URL);

  // Replit: REPLIT_DOMAINS is "domain1,domain2,..." - first wins.
  if (process.env.REPLIT_DOMAINS) {
    const first = process.env.REPLIT_DOMAINS.split(",")[0].trim();
    if (first) return strip(`https://${first}`);
  }

  if (process.env.RENDER_EXTERNAL_URL) return strip(process.env.RENDER_EXTERNAL_URL);

  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return strip(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  }
  if (process.env.VERCEL_URL) return strip(`https://${process.env.VERCEL_URL}`);

  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return strip(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  }

  if (process.env.FLY_APP_NAME) return `https://${process.env.FLY_APP_NAME}.fly.dev`;

  if (process.env.NODE_ENV !== "production") {
    return `http://localhost:${process.env.PORT || 5001}`;
  }

  return "https://app.gostork.com";
}
