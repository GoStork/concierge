/**
 * CAPTCHA solver integration for the donor/surrogate/sperm scraper login flow.
 *
 * Some agency login pages (e.g. Eggspecting, a WordPress site) sit behind
 * Google reCAPTCHA v2. Our login engine (`authenticateAndGetCookies` in
 * profile-sync.service.ts) is a plain HTTP form POST - it cannot click a
 * reCAPTCHA checkbox or solve an image grid. The standard, reliable way to get
 * past a static-sitekey reCAPTCHA v2 without a real browser is "token
 * injection": hand the page's sitekey + URL to a solving service, which returns
 * a `g-recaptcha-response` token, and we add that token to the form POST body.
 * The site's server validates the token exactly as if a human had solved it.
 *
 * Provider: 2captcha (https://2captcha.com) via the classic in.php/res.php API.
 * Configure with TWOCAPTCHA_API_KEY (alias: CAPTCHA_SOLVER_API_KEY).
 *
 * Cost is only incurred when a captcha is actually detected on a login page, so
 * sites without a captcha never hit the solver. If a captcha is detected and no
 * key is configured, the caller surfaces a loud error rather than silently
 * importing zero profiles (per the project's "loud failures beat fabricated
 * successes" rule).
 */

const CAPTCHA_API_KEY =
  process.env.TWOCAPTCHA_API_KEY || process.env.CAPTCHA_SOLVER_API_KEY || "";

const SUBMIT_URL = "https://2captcha.com/in.php";
const RESULT_URL = "https://2captcha.com/res.php";

// reCAPTCHA solves typically take 15-40s of human-worker time. Poll up to 180s
// before giving up so a single slow solve doesn't fail an otherwise-fine sync.
const INITIAL_WAIT_MS = 15_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_SOLVE_MS = 180_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function captchaSolverConfigured(): boolean {
  return CAPTCHA_API_KEY.length > 0;
}

/**
 * Extract a reCAPTCHA sitekey from a login page's HTML.
 * Handles both the `data-sitekey="..."` attribute (v2 checkbox / invisible)
 * and the `render=<sitekey>` query param on the api.js script tag (v3).
 */
export function extractRecaptchaSitekey(html: string): string | null {
  const dataAttr = html.match(/data-sitekey=["']([^"']+)["']/i);
  if (dataAttr) return dataAttr[1];
  const renderParam = html.match(/recaptcha\/api\.js\?[^"']*\brender=([A-Za-z0-9_-]+)/i);
  if (renderParam && renderParam[1] !== "explicit") return renderParam[1];
  return null;
}

/** Detect Google reCAPTCHA Enterprise (solved via a different 2captcha flag). */
export function isRecaptchaEnterprise(html: string): boolean {
  return /enterprise\.js|grecaptcha\.enterprise/i.test(html);
}

/**
 * Solve a Google reCAPTCHA v2 and return the `g-recaptcha-response` token.
 * Throws (loudly) on misconfiguration, solver error, or timeout - the caller
 * turns this into a clear sync failure reason.
 */
export async function solveRecaptchaV2(
  sitekey: string,
  pageUrl: string,
  opts: { enterprise?: boolean } = {},
): Promise<string> {
  if (!captchaSolverConfigured()) {
    throw new Error(
      "CAPTCHA solver not configured - set TWOCAPTCHA_API_KEY in the environment",
    );
  }

  // 1. Submit the captcha job.
  const inParams = new URLSearchParams({
    key: CAPTCHA_API_KEY,
    method: "userrecaptcha",
    googlekey: sitekey,
    pageurl: pageUrl,
    json: "1",
  });
  if (opts.enterprise) inParams.set("enterprise", "1");

  const submitResp = await fetch(SUBMIT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: inParams.toString(),
  });
  const submitJson: any = await submitResp.json().catch(() => ({}));
  if (submitJson.status !== 1) {
    throw new Error(`2captcha submit rejected: ${submitJson.request || "unknown error"}`);
  }
  const captchaId = String(submitJson.request);
  console.log(`[captcha-solver] Submitted reCAPTCHA job ${captchaId} for ${pageUrl}`);

  // 2. Poll for the token.
  await sleep(INITIAL_WAIT_MS);
  const deadline = Date.now() + MAX_SOLVE_MS;
  while (Date.now() < deadline) {
    const resParams = new URLSearchParams({
      key: CAPTCHA_API_KEY,
      action: "get",
      id: captchaId,
      json: "1",
    });
    const resResp = await fetch(`${RESULT_URL}?${resParams.toString()}`);
    const resJson: any = await resResp.json().catch(() => ({}));
    if (resJson.status === 1) {
      console.log(`[captcha-solver] Solved reCAPTCHA job ${captchaId}`);
      return String(resJson.request);
    }
    if (resJson.request !== "CAPCHA_NOT_READY") {
      throw new Error(`2captcha solve failed: ${resJson.request || "unknown error"}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`2captcha solve timed out after ${MAX_SOLVE_MS / 1000}s`);
}
