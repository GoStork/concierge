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
 * Distinguish reCAPTCHA v3 from v2. This decides which 2captcha job type we
 * submit, and getting it wrong is not a soft failure: a v3 sitekey submitted as
 * a v2 job gives the solver's workers no widget to click, so it comes back
 * ERROR_CAPTCHA_UNSOLVABLE every single time. That is exactly what broke the
 * Eggspecting nightly from Aug 14 2026, once they moved their WordPress login
 * behind the WPCaptcha plugin's v3 flow.
 *
 * v2 (checkbox OR invisible) always renders a widget element carrying
 * `data-sitekey`. v3 has no widget at all - the key arrives only as the
 * `render=` param on the api.js loader and the token is produced by a scripted
 * `grecaptcha.execute()`. So: data-sitekey means v2, and a bare render= loader
 * means v3. Checking data-sitekey FIRST matters, because v2-invisible also calls
 * grecaptcha.execute() and would otherwise be misread as v3.
 */
export function isRecaptchaV3(html: string): boolean {
  if (/data-sitekey=["'][^"']+["']/i.test(html)) return false;
  return /recaptcha\/api\.js\?[^"']*\brender=(?!explicit\b)[A-Za-z0-9_-]+/i.test(html);
}

/**
 * The `action` string a v3 page passes to grecaptcha.execute(). The site binds
 * its score to this value, so a token solved under the wrong action can be
 * rejected even when the score is fine. Defaults to "submit" (what WPCaptcha and
 * most login plugins use) when the page doesn't spell it out.
 */
export function extractRecaptchaAction(html: string): string {
  const m = html.match(/grecaptcha\.execute\([^)]*\baction\s*:\s*["']([A-Za-z0-9_\/-]+)["']/i);
  return m ? m[1] : "submit";
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
  const inParams = baseSolveParams(sitekey, pageUrl);
  if (opts.enterprise) inParams.set("enterprise", "1");
  return submitAndPoll(inParams, pageUrl, "v2");
}

/**
 * Solve a Google reCAPTCHA v3 and return the token for the page's hidden
 * `g-recaptcha-response` input.
 *
 * Unlike v2 this is a score, not a pass/fail: Google returns 0.0-1.0 and the
 * site decides its own cutoff. We ask the solver for `min_score` and it keeps
 * working until a worker session scores at least that high. 0.7 sits above the
 * common 0.5-ish plugin default with margin, without pushing into the 0.9 band
 * where solves get slow and often time out. If a site still rejects our token,
 * the score cutoff - not the solve - is the thing to tune.
 */
export async function solveRecaptchaV3(
  sitekey: string,
  pageUrl: string,
  opts: { action?: string; minScore?: number; enterprise?: boolean } = {},
): Promise<string> {
  const inParams = baseSolveParams(sitekey, pageUrl);
  inParams.set("version", "v3");
  inParams.set("action", opts.action || "submit");
  inParams.set("min_score", String(opts.minScore ?? 0.7));
  if (opts.enterprise) inParams.set("enterprise", "1");
  return submitAndPoll(inParams, pageUrl, "v3");
}

function baseSolveParams(sitekey: string, pageUrl: string): URLSearchParams {
  if (!captchaSolverConfigured()) {
    throw new Error(
      "CAPTCHA solver not configured - set TWOCAPTCHA_API_KEY in the environment",
    );
  }
  return new URLSearchParams({
    key: CAPTCHA_API_KEY,
    method: "userrecaptcha",
    googlekey: sitekey,
    pageurl: pageUrl,
    json: "1",
  });
}

async function submitAndPoll(
  inParams: URLSearchParams,
  pageUrl: string,
  version: "v2" | "v3",
): Promise<string> {
  // 1. Submit the captcha job.
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
  console.log(`[captcha-solver] Submitted reCAPTCHA ${version} job ${captchaId} for ${pageUrl}`);

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
      console.log(`[captcha-solver] Solved reCAPTCHA ${version} job ${captchaId}`);
      return String(resJson.request);
    }
    if (resJson.request !== "CAPCHA_NOT_READY") {
      // Name the job type in the error. "ERROR_CAPTCHA_UNSOLVABLE" on a v2 job
      // is the signature of a v3 sitekey solved as v2 - without the version in
      // the message that reads like a flaky solver instead of a wrong job type.
      throw new Error(`2captcha ${version} solve failed: ${resJson.request || "unknown error"}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`2captcha ${version} solve timed out after ${MAX_SOLVE_MS / 1000}s`);
}
