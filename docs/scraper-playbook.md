# Donor / Surrogate / Provider Scraper Playbook

**Read this before adding or debugging any agency scraper.** It is the single
source of truth for everything we've learned the hard way. The goal: stop
re-discovering the same problems on every new agency.

> **Key architectural fact:** there is **ONE shared scraper engine** -
> `runSyncJob` / `startSync` in `server/src/modules/providers/profile-sync.service.ts`
> - used by **every** provider and all three types (`egg-donor`, `surrogate`,
> `sperm-donor`). Every fix below is already baked into that engine, so a **new
> agency automatically inherits all of it**. You configure a scraper with just a
> **Source URL + username/password + type**; you do *not* write per-agency code.
> If a new site breaks, the fix almost always belongs *in the shared engine*
> (make it handle the new shape too), never in a per-agency fork.

---

## Definition of a successful sync - the acceptance contract

"Login worked and the run says completed" is NOT success. A sync is done only
when the imported data would satisfy a parent browsing the marketplace and Eva
recommending from it. The gates below are the contract; the audit script checks
them mechanically:

```bash
npx tsx -r dotenv/config scripts/audit-sync.ts "<provider name or id>" egg-donor   # or surrogate / sperm-donor
```

(Point `DATABASE_URL` at the DB the provider lives in - real providers are on
PROD; see `project_scraper_env_ownership`. Exit code 1 = not accepted.)

**Hard gates (all must pass):**

1. **Run outcome**: last `SyncLog` row is `completed` (or `partial` with an
   explained, source-side cause), zero entries in `errors`.
2. **Coverage**: imported >= 98% of what the source listed (`succeeded/total`);
   failed <= 2%. A 10-profile test run does not count - the FULL run does.
3. **Identity**: every profile has a stable `externalId` from the source (never
   an `auto-...` fallback); zero duplicates per provider.
4. **Photos**: >= 95% of profiles have a photo, and the photo lives on OUR
   storage (`storage.googleapis.com/...`), never hotlinked to the source.
   Galleries (2+ photos) whenever the source shows more than one.
5. **Pricing**: >= 90% of profiles carry a price the marketplace can show -
   `totalCost` (egg donors; for frozen egg banks = the standard banked lot,
   not the cheapest remainder), `totalCostMin/Max` (surrogates),
   `compensation` (sperm). A sync that leaves "Total Cost: -" on every card
   is not done.
6. **Status**: mapped through `normalizeDonorStatus`; not everyone AVAILABLE
   when the source shows sold-out/matched profiles, and not everyone hidden.
7. **Required fields**: each field in `getMandatoryFieldChecks(type)` filled
   on >= 90% of profiles - **unless the source does not publish it at all**
   (0% filled = source-limited, see below). A field that is present on SOME
   records and missing on others is a mapping bug on our side. Fix it.
8. **Profile hygiene**: no platform-internal keys on `profileData` (thumb URLs,
   view/like counters, duplicate ids, "real" flags), no texture words stored as
   a hair color, race codes humanized (`hisp` -> Hispanic), values readable by
   a parent.
9. **Idempotence**: a second run right after the first imports 0 new profiles,
   marks nothing stale, and changes nothing a human edited
   (`manuallyEditedFields` wins).
10. **Budget**: the run fits the source's rate limits with headroom for one
    retry (e.g. Lucina 1,000 req/24h -> list-only, ~10 requests).

**Source-limited fields** are the ONLY acceptable gap: the audit tags a field
`SRC` when it is absent on every record, which means the source does not
publish it. Never fabricate it (no defaults, no AI guesses). Instead, report it
as a concrete ask to the provider listing the exact fields, and note it in the
Platform cheat-sheet so nobody re-investigates.

**Working rule for agents (this is the part Eran cares about):** after any
scraper or API-sync change, run the FULL sync, run the audit, and fix every
`FAIL`/`GAP` yourself - mapper, pagination, auth, photo persistence, cost
recalc, whatever it is - re-run, re-audit, until only `SRC` items remain. Do
not ask the human to "check the cards"; do not report mid-way. The final
report is: what the audit says now, what was fixed, and the exact list of
source-limited fields to request from the provider.

---

## Adding a new agency - the 60-second checklist

0. **Sync Method** - if the provider hands us an **API key/secret** instead of a
   scrapeable portal, pick **Provider API** in the Sync Configuration and skip
   the scraper entirely (see "API sync method" at the bottom). Default is
   **Source URL** (scrape).
1. **Source URL** = the page that lists donors/surrogates **after login** (or the
   login page itself). For WordPress sites this is the **donor-list page, NOT
   `wp-login.php`** (see Login below).
2. **Username / password** = the agency's portal credentials (stored encrypted in
   the `*SyncConfig` row).
3. **Type** = egg-donor / surrogate / sperm-donor.
4. Run **"Sync 10 Profiles"** first (test mode) and watch `/tmp/gostork-server.log`
   for `[donor-sync]` lines - confirm login, list extraction, and per-profile
   fetch before kicking the full run.
5. If it fails, find the cause in the **Troubleshooting table** below - it's
   almost certainly a shape we've already solved.

---

## Login / authentication

- **Candidate-URL fallback.** The engine tries the Source URL, then **`/wp-login.php`**
  (WordPress), `/Account/Login`, then `/login` (and `/user/login`). It auto-detects the form
  `action`, CSRF/verification tokens (`__RequestVerificationToken`, `_token`, `csrf-token`),
  and email/password fields.
  - **The walk STOPS as soon as a candidate serves a real login form** (`reachedLoginForm`).
    Past that point the path is right and the failure is captcha/credentials/edge, so the
    later candidates are guesses at paths the site doesn't have - they cost requests that
    raise our threat score at the WAF, and their 404s/403s land at the *end* of the joined
    error string where they read like the cause. Eggspecting on Aug 15 2026 is the worked
    example: `wp-login.php` served a real form and failed on captcha, then `/Account/Login`
    404'd and `/login` 403'd from Cloudflare - and that trailing 403 made a captcha bug look
    like a WAF block. **Read `SyncLog.errors` left to right; the FIRST candidate is the one
    that matters.**
- **WordPress login uses `log`/`pwd` field names** (not `email`/`password`). The engine
  detects WordPress (by `wp-login.php` URL **or** `name="log"`+`name="pwd"` in the form),
  switches field names automatically, and satisfies WP's cookie check by sending the
  `wordpress_test_cookie` cookie plus the `testcookie` / `wp-submit` hidden fields.
  - **Gotcha:** for WordPress sites the **Source URL must be the donor-list page**, not
    `wp-login.php`. (The engine logs into WP, then needs the list page to scrape.)
- **Some WP sites HIDE `wp-login.php` (404) and log in via a Gravity Forms page** (Family
  Creations, Aug 24 2026: login lives at `/login/`, a GF form). The engine handles this:
  - **A 404 candidate with no login form is skipped, not fatal** - and crucially the
    `isWordPress` flag alone (from a `wp-login.php` URL) no longer sets `reachedLoginForm`
    on a formless 404, so the walk continues to the next candidate.
  - **Structured form parsing is quote- and attribute-order-agnostic.** GF emits
    single-quoted attributes (`name='input_1'`), which the legacy double-quote regexes
    never matched. The engine now parses every POST form into typed inputs and picks the
    form with **exactly one** password input; **two password inputs = a registration /
    password-confirm form - never log in through one** (FC's logged-out Source URL
    redirects to exactly such a recipient-registration form).
  - **GF field names carry no keywords** (`input_1`/`input_2`), so the email field falls
    back to the nearest text/email input above the password input in the same form.
  - **ALL hidden inputs of the login form are posted back verbatim** - GF silently ignores
    a submission missing `is_submit_N` / `gform_submit` / `state_N` / currency fields.
  - **`login_redirect` / `redirect_to` hidden fields are overwritten with the Source URL**,
    so a successful sign-in redirects to the list page instead of back to `/login/` (which
    would read as "redirected back to login page"). Belt-and-braces: a 3xx whose
    `Set-Cookie` contains `wordpress_logged_in_*` counts as success even when the location
    contains "login".
  - Quirk: FC's themed 404 pages embed a login widget, so even the `/Account/Login`
    candidate (404) logs in successfully through the new parser. Harmless - any candidate
    that yields the session cookie is fine.
- **reCAPTCHA (v2 and v3)** is solved via **token injection** (no headless browser):
  `captcha-solver.ts` extracts the sitekey, submits it to **2captcha**
  (`in.php`/`res.php`), gets a `g-recaptcha-response` token, and adds it to the login POST.
  - Configure with env **`TWOCAPTCHA_API_KEY`** (alias `CAPTCHA_SOLVER_API_KEY`).
  - Symptom in `SyncLog.errors`: `reCAPTCHA required on POST response` / `404 (reCAPTCHA page)`.
  - **v2 vs v3 is a different 2captcha job type - getting it wrong fails 100% of the time.**
    `isRecaptchaV3()` decides: a `data-sitekey` attribute means **v2** (checkbox *or*
    invisible); no `data-sitekey` plus a bare `api.js?render=<key>` loader means **v3**.
    Check `data-sitekey` FIRST - v2-invisible also calls `grecaptcha.execute()` and would
    otherwise be misread as v3. v3 additionally sends `version=v3`, the page's `action`
    (from `grecaptcha.execute(k,{action:"..."})`, default `submit`), and `min_score` (0.7:
    above the common ~0.5 plugin cutoff, below the 0.9 band where solves time out).
  - **Symptom: `2captcha v2 solve failed: ERROR_CAPTCHA_UNSOLVABLE` = a v3 sitekey submitted
    as a v2 job.** The workers get no widget to click. This broke Eggspecting from Aug 14
    2026 when they put their WP login behind the **WPCaptcha** plugin's v3 flow; the extractor
    already understood `render=`, but the caller always used the v2 path. The error string
    names the job type now, so "v2 solve failed" on a v3 page is self-diagnosing.
  - **v3 is a score, not a pass/fail.** A perfectly valid purchased token can still be
    rejected if the site's cutoff is above what the solver's session scored. If v3 solves
    succeed but the POST still bounces, tune `min_score` - don't blame the solve.
  - **Only reCAPTCHA is auto-solved.** hCaptcha / Cloudflare challenges fail loudly with
    `... not supported by the captcha solver (only reCAPTCHA is)` rather than POSTing blind.
- **Edge/WAF blocks are NOT captchas, and must never be retried into** (commit `a1472442`).
  `detectWafBlock()` runs *before* `detectCaptcha()` everywhere, because Cloudflare's block
  page embeds the origin's own reCAPTCHA script - captcha-first ordering labels every edge
  block `(reCAPTCHA page)` and sends you auditing the wrong vendor. Detection keys strictly
  on **block-page markers** (`sorry, you have been blocked`, `error code 1020/1015`,
  `_cf_chl_opt` / `orchestrate/chl_page` / `__cf_chl`, `cloudflare ray id`), never on the
  mere presence of "cloudflare" - most of these agency sites are Cloudflare-fronted while
  serving a perfectly normal login form.
  - **A bare `cdn-cgi/challenge-platform` reference is NOT a challenge marker** (fixed
    Aug 24 2026). Cloudflare bot management passively injects
    `/cdn-cgi/challenge-platform/scripts/jsd/main.js` into EVERY HTML response it fronts -
    including plain 404 pages. Family Creations hides `wp-login.php` (404), the passive
    script on that 404 read as "Cloudflare JS challenge (status=404)", and the misdetected
    "block" aborted the whole candidate walk before `/login` was ever tried. A real JS
    challenge interstitial is a 403/503 carrying `_cf_chl_opt` / `orchestrate/chl_page` /
    `__cf_chl_*` tokens - key on those only. A **403 with `server: cloudflare`** counts as a block even
  when the body matches no marker; this is checked on the login **GET** as well as the POST,
  so a marker-less block page never reaches the *paid* solver.
  - A block **aborts the candidate loop**: the remaining candidates are the same closed door
    on the same origin, and each one buys another solve and pushes our IP further up the
    WAF's threat score. That is how one Eggspecting block became **9 paid solves across 3
    retries**.
  - **The block is often rate-based on OUR IP, not a standing ban** (Eggspecting, confirmed
    Aug 15 2026). A single login attempt succeeded; a second attempt ~3 minutes later from
    the same IP got a bare `403 + server: cloudflare` on `wp-login.php` with the captcha
    solved and valid. This is why the once-a-night sync mostly works while any retry ladder
    or manual re-test cascades into failure. **Practical rule: when debugging one of these,
    you get roughly ONE live login attempt - make it count, then stop and let the next
    nightly be the test.** The durable fix is asking the agency to allowlist our sync IP or
    exempt our account, not more scraper cleverness.
  - **The site may have no Cloudflare account of its own - check who HOSTS it**
    (Eggspecting, Sep 2 2026). Their developer confirmed Eggspecting has no Cloudflare
    account at all: the `server: cloudflare` + `cf-ray` headers come from **WP Engine's
    Global Edge Security**, which is Cloudflare-backed. So the allowlist request goes to
    the *host's* control panel (WP Engine -> access rules -> Allow `<IP>`), not to a
    Cloudflare dashboard nobody has. Asking the agency to "check your Cloudflare" gets you
    "we don't have Cloudflare" and stalls the thread. That WP Engine rule DOES reach the
    edge and does lift the block - see the next bullet for how far it gets you.
  - **An IP allowlist fixes the GET but NOT the login POST** (Eggspecting, Sep 2 2026).
    After WP Engine allowlisted `34.85.132.142`:

    | Request | Result | cf-ray |
    |---|---|---|
    | `GET /wp-login.php` | **200**, real login form (`name="log"`) | `a34ed093ebb6b4a5-IAD` |
    | login `POST /wp-login.php` (15s later) | **403** from the edge | `a34ed797acc9822d-IAD` |
    | `GET /wp-login.php` (re-confirm, right after the 403) | **200**, form again | `a34edb313c2d884e-IAD` |

    Same IP, same UA, seconds apart. That **GET-passes / POST-blocked** signature is the
    host's **brute-force protection on `wp-login.php`** - a layer separate from the WAF and
    from IP access rules, which an allowlist does not lift. It needs the host's
    login-protection toggle or a support exemption, quoting a passing-GET and blocked-POST
    ray ID pair so support can see which rule fires.
  - **Diagnose with a bare GET before spending a sync run.** One unauthenticated
    `curl -sS -o /dev/null -D - -A "<our UA>" https://<site>/wp-login.php` from the sync
    host costs no captcha solve, writes nothing, and splits the three cases cleanly:
    403 = still IP/WAF-blocked (allowlist not applied, or applied to the wrong
    environment - host access rules are usually per-environment); 200-with-form then a
    403 on the real run = login protection, ask about that specifically, not about IP
    allowlisting; 200 then a clean run = fixed. Note also that a Cloudflare IP allowlist
    does **not** override Bot Fight Mode, so "we allowlisted you and it still fails" does
    not mean the allowlist was wrong.
  - **When you are two layers deep in a login form neither side controls, escalate to an
    API.** We ingest provider APIs generically (`syncMethod = "API"`): Bearer /
    `X-API-Key` / `Api-Key` (with or without a secret) / Basic, list + optional detail
    endpoints, GET or POST, offset pagination, and flexible field-name mapping - so the
    agency builds to *their* convenience, not our spec. That is a cheaper ask than a
    third round of WAF archaeology.
- **HTTP 405 on `/Account/Login` is NOT the real error** - it means the *correct* login
  URL (e.g. `/user/login` on JMS/o-jms, `/login` on Symfony) failed transiently and the
  engine fell through to the EDC fallback path, which those non-EDC platforms reject with
  405. The engine now **retries transient auth failures** (commit `f30ddf6`), so a momentary
  `fetch failed` no longer cascades to a bogus 405. If you see 405, check whether the *real*
  login URL had a transient blip first.
- **Auth failures are diagnostic, not generic** (commits `e506762`, `4d7ac03`). The legacy
  `Login failed. Please verify your username and password...` is gone - `SyncLog.errors`
  now carries a specific reason **per candidate URL**, so the row tells a credential
  rejection apart from a lockout, captcha, timeout, or network error. Every shape is in the
  **Troubleshooting table** below; the two non-obvious ones to internalize:
  - **`fetch failed` hides the real cause.** Node's undici reports DNS/TCP/TLS failures as a
    bare `fetch failed`; the engine unwraps `err.cause` so the row shows the real
    `ENOTFOUND` / `ECONNRESET` / `ECONNREFUSED` / `UND_ERR_SOCKET`. That is an
    upstream-or-egress issue, **NOT** credentials.
  - **`200 OK` with an error phrase** means the page named the cause itself: `invalid` /
    `incorrect` / `wrong password` ⇒ bad credentials, but `locked` / `too many` / `rate` /
    `blocked` / `suspended` ⇒ rate-limit lockout (see Per-day dedup), **not** a credential
    issue. Don't rotate credentials for a lockout.
- **30s per-attempt auth-fetch timeout** (commit `b2fc975`). Every `fetch()` in
  `authenticateAndGetCookies` (GET form, POST credentials, follow-redirect) is wrapped in
  an `AbortController` with a **30s deadline**, retried up to 3 attempts on transient
  blips (`isTransientFetchError`). Without this, a stalled TLS handshake to certain hosts
  (we saw it on `genesiseggdonation.o-jms.com` / `app.spermbankcalifornia.com` via Replit
  Autoscale's egress) held `SyncLog` `"running"` indefinitely; the next container restart
  then triggered auto-resume which re-hung the same way - a cascading loop that never
  converged. 30s × 3 caps the cost of "site silently dropping our packets" so the row
  resolves quickly with `auth timed out after 30s ...`.
- **Per-day login dedup (20h window in `runNightlySync`)** (commit `e506762`). Some
  agencies rate-limit / briefly lock the account after the first successful login of the
  day - Eggceptional Fertility on the **eggdonorconnect.com** platform is the canonical
  case (one success at 02:00 ET, three rejections later the same morning, all clear by
  the next day). Replit Autoscale spins up multiple containers, so the in-memory
  `nightlySyncRunning` flag does NOT stop the in-process cron + GitHub Actions pinger +
  startup catch-up + post-restart auto-resume from each launching a fresh `runNightlySync`.
  A DB-level check at the top of `runNightlySync` skips if any `nightly`-source `SyncLog`
  reached `completed` / `partial` in the last **20h** (admin "Trigger nightly" passes
  `{force:true}` to override). Net: **one login attempt per agency per day**, regardless
  of how many triggers fire. Log line `[nightly-sync] Skip - last successful nightly was ...`
  means the dedup absorbed a duplicate trigger and is working as designed.

## Profile pages - fetch EVERYTHING, never assume one page

- **Always discover and fetch ALL tabs/views** (Overview, Profile, Photos, etc.).
  Many sites load tabs via **separate AJAX partial views** - e.g. EDC platforms serve
  `/Recipient/_DonorDashboardMatching` and `_DonorProfileHTML?DonorId=...` as AJAX
  fragments. The engine fires the AJAX request (with `RecipientId`/`ClinicId` from the
  dashboard) rather than assuming all data is in the first HTML response.
- **Card-list sites (WordPress, e.g. Eggspecting):** capture each donor's **profileUrl**
  from the listing card so the per-donor page can be fetched (commit `465af14`).
  - **Gotcha: the profile URL's internal id is NOT the public donor number** we store as
    `externalId`. A card shows `Donor ID : 6501` but links to `/donor-view?donor_id=353` -
    so you **cannot build the URL from `externalId`**. Pair the card's `view-more` href with
    the public number in its `old-site-id` div, per card (`extractWpDonorCardProfileUrls`).
  - **Skip the Gemini section pass for these sites' egg donors** - their donor-view pages
    are large enough to reliably **time out Gemini** (120s x4 retries) for no benefit. Once
    the gallery is captured, `return` (`if (hasWpPaging && job.type === "egg-donor")`). Non-WP
    egg providers (e.g. Family Creations) still run section extraction.

## Pagination

- **AI-pagination path:** the AI extraction returns **`paginationLinks`** (Next / page 2 /
  ...). The engine discovers **all** listing pages, capped at **100 pages** as a runaway
  guard (was 10, which silently truncated large catalogs).
- **WP `?paged=N` path: WordPress (wp-paginate) sites use deterministic `?paged=N`
  pagination, NOT the AI's `paginationLinks`.** When the listing HTML has `?paged=` or a `wp-paginate` widget
  (`hasWpPaging`), the engine ignores Gemini's pagination links and crawls `?paged=2,3,...`
  off the same listing URL itself. It reads the total page count straight from **"Page 1 of
  N"** on page 1 (no extra fetch) to fix the progress denominator and stop exactly at the
  last page; if that count is absent it stops after **2 consecutive pages add no new donors**
  (a `404` past the last page is the normal terminator, 200-page runaway guard). Each page is
  **streamed straight into the importer** so records + the progress bar fill live during
  discovery, and its per-card `profileUrl`s are captured (`extractWpDonorCardProfileUrls`)
  before that page's donors import.
- **Checkpoint resume** makes long runs safe: each profile's content hash + completeness
  is persisted, so an interrupted sync resumes where it stopped and **skips already-synced
  profiles** instead of restarting. Every restart converges toward completion.

## Photos

- **Always pass session cookies when fetching images** - authenticated sites gate image
  downloads on cookies, not just the page HTML.
- **Never hardcode a single S3 bucket / CDN domain.** Different agencies use different
  storage backends; use broad patterns.
- **Handle dynamic photo URLs with no file extension** - `/Photo/Get?id=123`,
  `/DonorPhoto?PhotoId=456`, `/DonorImage`, etc. are valid images on EDC/JMS platforms.
  See the `DYNAMIC_PHOTO_PATHS` regex.
- **Photos tab is often a separate AJAX fragment** (e.g. `_DonorPhotoGalleryHTML?DonorId=`).
  Fetch it; merge into `profileData["All Photos"]`.
- **WordPress galleries are a Fotorama widget on the donor-view page** (not an AJAX
  fragment). The **raw HTML** holds a flat list of `<img src=...>` directly inside
  `<div class="fotorama" ...>`; the `fotorama__img` nodes you see in DevTools Elements are
  **JS-rendered and absent** from what the scraper fetches. Parse the raw `<img>` tags
  (`extractFotoramaPhotos`) and skip WordPress `-150x150` thumbnail size-variants.
- **Hash-skip must never shrink a gallery** (commit `034d8cf`): when a donor's `cardHash`
  is unchanged, the run carries only the single listing-card photo - so preserve the
  existing `All Photos` gallery instead of overwriting it.
- **Survive image-host 429s** - image downloads go through `persistSinglePhoto` (**not**
  `fetchHtml`), which retries `429` up to **5x with exponential 2s/4s/8s/16s backoff and
  honours `Retry-After`** (commit `034d8cf`). WordPress image hosts rate-limit photo bursts
  hard; without this the gallery only downloads partially and the rest is silently dropped.
  (Page fetches via `fetchHtml` retry `429` separately - see Resilience.)

## Resilience (all in the shared engine)

- **`fetchHtml` and the auth fetch retry transient errors** (timeouts, `fetch failed`,
  dropped sockets, `429`, `502/503/504`, the EDC `EAUTHTIMEOUT` wire string) up to 2x with
  backoff. Hard errors (4xx, bad markup) still fail fast so the real cause stays visible.
- **Per-batch fault isolation:** a throw in one batch's profile-fetch is logged and the run
  continues - one bad profile can't zero a 560-profile catalog.
- **PARTIAL status:** if some profiles saved before a fatal error, the run is marked
  `partial` (not `failed`) so good saves aren't discarded; the error is still recorded.
- **`(EAUTHTIMEOUT) timeout while waiting for message` comes from the EDC host/proxy over
  the wire - it is NOT in our code.** It's a transient upstream stall; the retry absorbs it.

## Nightly sync orchestration (the run-level layer)

The nightly is **not a separate scraper** - `runNightlySync` (`profile-sync.service.ts`)
just loops every `*SyncConfig` row and calls the same `startSync()` engine with
`source: "nightly"`. So every per-site fix above applies automatically. The
orchestration layer adds:

- **Bounded concurrency (`NIGHTLY_CONCURRENCY`, default 3)** - logins run a few at a time,
  not all-at-once, so a single egress blip can't fail every provider simultaneously and we
  don't burst rate-limited sites. (Pre-fix it was a full `Promise.all` - one blip = a wall
  of red.)
- **In-run auto-retry of transient failures** (`NIGHTLY_MAX_RETRIES`=2, 5-min backoff). After
  the first pass, providers whose error is **transient** (network/timeout/`EAUTHTIMEOUT`/5xx/
  `405` cascade/"Interrupted - server restarted") are retried; **actionable** ones
  (captcha / bad creds / lockout - `isActionableSyncError`) are **not** (retrying won't help,
  and re-login worsens a lockout). A 2 AM blip self-heals before morning instead of greeting
  you red. This is the run-level analog of `fetchHtml`'s per-request retry.
- **Morning digest** (`NotificationService.sendNightlySyncDigest`) emails GoStork admins
  **only when a provider truly needs a human** (survived retries as `failed`, or actionable).
  Transient/self-healed runs and fully-green nights send **nothing** - silence = all good.
- **Dashboard triage** (`scrapers-summary-page.tsx`): a `FAILED` row whose last error is
  transient renders amber **"Interrupted"** (engine auto-retries it), red **"Needs attention"**
  is reserved for actionable failures. Driven by `lastFailureActionable` from `getScrapersSummary`.
- **Dedup is global + work-gated**: a `completed`/`partial` nightly within 20h skips re-runs
  (admin "Trigger nightly" passes `{force:true}`), but **only if it actually did work**
  (`total > 0`) - a 0-found empty "completed" run must not anchor the dedup and silently
  block the whole next nightly. The schedule is in-process `node-cron` at 2 AM ET +
  boot-time catch-up if >25h stale; if the box sleeps through 2 AM, catch-up covers it.

## Data mapping gotchas

- **Location city lives in `profileData.Location`** (e.g. `"Hemet CA | $70,000"`,
  `"Bakersfield, CA"`) even when the stored `location` scalar is just the state (`"CA"`).
  The card/detail recover the city for display via `cleanCityState` (commit `dfef635`).
  Keep the raw `location` scalar for filtering/Matched-Preferences.
- **Provider-location dedup lives in a DIFFERENT scraper.** Coarse/duplicate
  `ProviderLocation` rows (a bare `"Los Angeles, CA"` beside `"…, Woodland Hills, CA"`, or a
  region label `"Mid-West, USA"`) come from `scrape.service.ts` - the provider "Scrape"
  button - **not** this donor-sync engine. For display, the engine's `prunedLocations` /
  `REGION_STATE_TOKENS` pass + the client's `dedupeProviderLocations()`
  (`client/src/lib/format-location.ts`) hide an address-less row when the same state/country
  already has a street address.
  - **Footgun: that broad state-level rule is for display suppression ONLY - never a
    permanent DB delete.** It also hides **legitimate satellite offices** that merely lack a
    scraped street address (one dry run: the broad rule matched ~340 rows, mostly real
    offices; the narrow rule found 41 genuine junk). For an actual DB cleanup use the
    **narrow** rule - delete only when the **city** duplicates an existing street-address
    city, plus region-token rows and provider-name-as-city junk (`"Brown Fertility"` as a city).
- **Never assume HTML attribute order in regex** - `src` may come before or after `class`.
- **Coerce section fields to scalars before writing scalar columns.** AI section extraction
  sometimes returns a **nested object** for a field (e.g. an "Education" group of sub-fields),
  but `education`/`occupation`/`height`/`race`/... are String columns - assigning an object
  **throws on the Prisma upsert** and silently drops that donor. Map via `pickScalar(...)`,
  which takes the first string/number candidate and ignores objects/arrays.
- **Compensation / cost** is often appended to the location field (`"City, ST | $70,000"`);
  strip the `| $...` suffix when reading the city.
- **Some agencies publish no per-donor compensation at all** (e.g. Eggspecting - their donor
  pages have zero `$` figures). The scraper correctly stores `null` - **don't hunt for it in
  the scraper.** The **cost-sheet base-compensation fallback** fills `donorCompensation` /
  `baseCompensation` / `compensation` from the agency's uploaded cost sheet downstream
  (`total-cost.utils.ts`, matched by canonical `subTypes[]`), as does `totalCost`.

## Post-scrape verification - "finished with no errors" ≠ "scraped correctly"

A run can complete `successful` with zero errors and still be **wrong**. The
Eggspecting run looked perfect but had captured **only 1 photo per donor** (no
gallery) and was **missing the `profileUrl`** (so the admin had no "View on
Provider Site" link). Always verify quality at the end, not just the status.

**The sync report now flags these automatically** (in the same "missing" report
that lists missing fields - see `getMandatoryFieldChecks` / `analyzeMissingFields`):

- **Photo Gallery (2+ photos)** - donors carrying only the single listing-card
  thumbnail (gallery not scraped, the Eggspecting bug).
- **Provider Profile Link** - donors missing `profileUrl` (no "View on Provider Site").
- plus every per-type field (Age, Location, Race, Compensation, ...).

**Manual end-of-scrape checklist (do this on the first run of any new agency):**

1. **Count sanity** - synced + skipped ≈ the number of profiles visible on the
   source site. A big shortfall means pagination or list extraction missed pages.
2. **Open 3-5 random profiles** in the marketplace/detail page and confirm:
   - **Photos**: a full gallery, not one thumbnail (compare to the source profile).
   - **"View on Provider Site"** link is present and opens the real source profile.
   - **Location** shows city + state (not just the state - see Data mapping).
   - **Costs / compensation** populated where the source has them.
   - Core fields (age, race, etc.) match the source.
3. **Read the report's "missing" list** - if "Photo Gallery" or "Provider Profile
   Link" shows a high count, the run "succeeded" but a whole dimension didn't
   scrape; fix it in the engine before trusting the data.
4. **Re-run once** - a clean second run should mostly *skip* (unchanged via
   cardHash). If it re-does everything, the checkpoint/hash isn't working.

When you add a new quality signal we should check, add it as a `qualityCheck` in
`getMandatoryFieldChecks` (so it lands in the report) **and** list it here.

## Troubleshooting - symptom → cause (check `SyncLog.errors` + `/tmp/gostork-server.log`)

| Symptom in `SyncLog.errors` / log | Cause | Fix / where |
|---|---|---|
| `Login failed ... 405 (Method Not Allowed)` | Transient blip on real login URL → bogus EDC fallback | Auth retry (`f30ddf6`); confirm Source URL is the right login/list page |
| `auth timed out after 30s ...` | TLS/TCP stall from our egress to upstream | Already capped at 30s × 3 (`b2fc975`); if it persists for one host, suspect egress / IP block from that site |
| `exception during auth: fetch failed (cause: ENOTFOUND ...)` / `ECONNRESET` / `ECONNREFUSED` | Low-level network error; `err.cause` carries the real code (`4d7ac03`) | Upstream / egress issue, not credentials |
| `200 OK with error phrase "locked"` / `"blocked"` / `"too many"` / `"suspended"` | Site rate-limited or temporarily locked the account (NOT bad creds) | Usually auto-clears in hours; per-day dedup (`e506762`) keeps the rest of today from re-triggering |
| `200 OK with error phrase "invalid"` / `"incorrect"` / `"wrong password"` | Real credential rejection | Rotate the stored `username` / `password` in the `*SyncConfig` row |
| `<captcha-type> required on POST response` (hCaptcha / Cloudflare / generic) | Non-reCAPTCHA challenge | Not solvable here; needs a headless-browser path or manual intervention |
| Log: `[nightly-sync] Skip - last successful nightly was ...` | 20h DB-level dedup absorbed a duplicate trigger | Working as designed; benign |
| `reCAPTCHA required` / `404 (reCAPTCHA page)` | Site needs captcha solving | Set `TWOCAPTCHA_API_KEY`; `captcha-solver.ts` |
| `Cloudflare JS challenge on the login page (status=404)` | HISTORICAL false positive: passive `cdn-cgi/challenge-platform` script on an ordinary 404 (hidden `wp-login.php`) | Fixed Aug 24 2026 - `detectWafBlock` keys on `_cf_chl_opt`/`orchestrate/chl_page`/`__cf_chl` only; formless 404 candidates are skipped, not fatal |
| `login page returned 404 with no login form` | Benign per-candidate skip - that path doesn't exist on the site | Walk continues; only worry if EVERY candidate 404s (then find the site's real login URL) |
| Sync SUCCEEDS but every profile field is blank; externalIds are `auto-...` or bare card numbers | Slug-card catalog (FacetWP): cards carry no data + no numeric ids, so items were listing scraps with no profileUrl | `isSlugCardCatalog` path (Aug 24 2026) - see the "Slug-card catalogs" section |
| `Failed to extract data ... page may not contain profiles` | Login returned a non-list page, or markup changed | Check login succeeded; verify the AJAX/list endpoint + extraction |
| `(EAUTHTIMEOUT) timeout while waiting for message` | Transient upstream stall (EDC host) | Already retried; re-run if it slips through |
| `Interrupted - server restarted while sync was running` | Benign - server was restarted mid-run | Ignore; auto-resume re-runs it |
| Gallery shrank to 1 photo after a nightly | Hash-skip overwrote the gallery | Preserve existing `All Photos` (`034d8cf`) |
| Only the state shows (no city) | City is in `profileData.Location`, not the scalar | `cleanCityState` recovery (`dfef635`) |
| `Invalid prisma.*.upsert() ... ` on a scalar field (e.g. `education`) | AI section returned a nested object for a String column | `pickScalar` coercion in the section→column mapping |
| Gallery only partially downloaded (some photos missing) | Image host rate-limited the burst (429) | `persistSinglePhoto` 5x exp backoff + `Retry-After` (`034d8cf`) |
| WP donor `profileUrl` points at the wrong/404 page | Built the URL from `externalId` instead of the card's `view-more` href | Internal `donor_id` ≠ public number; capture per card (`extractWpDonorCardProfileUrls`) |
| Scraper report shows a GREEN "completed / N profiles synced" banner while the Run History table right below it says **Failed** | The banner inferred the outcome instead of reading it: `lastSyncAt >= lastSyncStartedAt` was treated as "the run completed" (but lastSyncAt is stamped on failure too), and stats were then synthesised as `{succeeded: totalProfiles}` - the CURRENT donor count reported as that run's output | Fixed Sep 2 2026: `getSyncReport` now reads the authoritative `SyncLog` row and returns `lastRunStatus`; the banner keys on it and never claims a profile count it wasn't given (`scrapers.controller.ts`, `sync-report-content.tsx`). **A green banner over a dead scraper is how a broken agency stays invisible - distrust any success indicator that isn't sourced from SyncLog** |
| Compensation / Total Cost blank after a clean scrape | Agency publishes no per-donor comp (e.g. Eggspecting) | Expected; cost-sheet base-comp fallback fills it (`total-cost.utils.ts`, by `subTypes[]`) |
| WP catalog truncated / only page 1 synced | Relied on Gemini `paginationLinks` instead of `?paged=N` | Deterministic `?paged=N` crawl reading "Page 1 of N" (`hasWpPaging` path) |
| Provider profile shows duplicate / region-label locations (`Los Angeles, CA` beside `Woodland Hills, CA`; `Mid-West, USA`) | AI extractor emitted coarse address-less rows next to street addresses | `prunedLocations`/`REGION_STATE_TOKENS` pass in `scrape.service.ts` + client `dedupeProviderLocations`. **Permanent delete: narrow city-dup rule only - the broad state rule erases real satellite offices** |
| Profiles import fine but the Missing Mandatory Fields report flags nearly EVERY field (Education, Religion, Ethnicity, Blood Type, gallery...) for every donor | Only listing-card data was captured: donors never got a `profileUrl` (card markup lacked `donor-card`/`view-more`, so `wpProfileUrlMap` stayed empty) AND the WP egg-donor branch skipped Gemini section extraction entirely (old Eggspecting perf carve-out) | `addNumericProfileDetailUrls` captures `/donor/<id>/` links from every listing page as a generic fallback, and the WP egg section-extraction skip now applies only to donors that ALREADY have `profileData._sections` from a prior run (`existingHasSections`, now also loaded for egg donors) - `profile-sync.service.ts` (Conceptions Center, Aug 2026) |
| 0 profiles though login succeeded; log shows `Found type-aware nav link ...` navigating away from the configured Source URL (to a `...-login/` or info page like "Egg Donor Requirements") | The type-aware nav heuristic matched a keyword link (login CTA, requirements page) and left the correct listing page | Three guards in `profile-sync.service.ts`: `countProfileDetailLinks` skips nav discovery when the source page already has >= 5 profile-detail links, a nav switch requires MORE profile links than the current page, and `loginLinkPattern` + quote-agnostic `type=["']password["']` exclude login pages (Conceptions Center, Aug 2026) |

## Platform cheat-sheet

- **EDC** (`/Recipient/...`): AJAX partial views (`_DonorDashboardMatching`,
  `_DonorProfileHTML`, `_DonorPhotoGalleryHTML`); `/Account/Login`; dynamic `/Photo/Get` URLs.
- **JMS / o-jms** (e.g. genesis): login at **`/user/login`** (NOT `/Account/Login` → 405);
  `profileData.Location` = `"City ST | $comp"`.
- **WordPress** (e.g. Eggspecting): `log`/`pwd` login fields (+ `wordpress_test_cookie` /
  `testcookie` / `wp-submit`); login candidate `/wp-login.php`; Source URL = donor-list page,
  not `wp-login.php`; **deterministic `?paged=N` pagination** (read "Page 1 of N", stream each
  page), NOT Gemini `paginationLinks`; per-card `profileUrl` capture (internal `donor_id` ≠
  public donor number - pair `view-more` href with the `old-site-id` number); gallery =
  **Fotorama** raw `<img>` list on the donor-view page (`extractFotoramaPhotos`, skip
  `-150x150` thumbs); **skip Gemini section extraction** (donor-view pages time it out);
  image-host 429s retried in `persistSinglePhoto`.
- **Symfony** (e.g. app.spermbankcalifornia): login at **`/login`**; `/Account/Login` → 405.
- **WordPress + Gravity Forms login** (e.g. Family Creations, both egg donors and
  surrogates): `wp-login.php` is hidden (404 - and the 404 carries Cloudflare's passive
  `challenge-platform` script, see the WAF false-positive note above); real login at
  **`/login/`** via a GF form (`input_1`/`input_2` + GF hidden fields). Source URLs:
  `/find-a-donor/` (egg) and `/find-a-surrogate` (surrogates), each with its own account.
  Logged-out, those URLs redirect to a registration form with TWO password inputs - the
  single-password rule keeps the engine off it. Detail pages: `/egg-donors/<slug>/` and
  `/surrogate/<slug>/` (singular). The listing is a **FacetWP slug-card catalog** - see the
  dedicated section below; Gemini listing extraction alone once imported 10 surrogates with
  EVERY field blank because no numeric ids exist and no profileUrl was ever assigned.

## Slug-card catalogs (FacetWP etc.) - the `isSlugCardCatalog` path (Aug 24 2026)

Some WP sites list profiles as a grid of cards where each card is ONE `<a>` wrapping an
`<img>`, linking to `/<type-word>/<name-slug>/` (e.g. `/egg-donors/alyssa-108/`). No numeric
id exists anywhere, listing cards carry almost no data, and FacetWP paginates via AJAX (the
pager anchors have `data-page` attributes but no hrefs, so Gemini finds no pagination links
either). Symptoms before this path existed: profiles import "successfully" with auto-generated
externalIds and every field blank.

The engine now detects >= 5 slug-card links (`extractSlugCardProfileLinks`: anchor containing
an `<img>` whose URL's final two path segments are `<type-word>/<slug>`) and switches to a
deterministic crawl:
- **Pagination**: FacetWP honors its URL prefix server-side, so `GET <listing>?_paged=N`
  renders page N without JS. Total pages = max `data-page` in the HTML (also matches the
  escaped `data-page=\"N\"` inside the `FWP_JSON` preload blob) - `maxFacetwpPageCount`.
- **Items are built FROM the detail pages**, not the listing: each card URL is fetched and
  run through the typed Gemini extraction (`extractDonorsFromPage`), which returns the full
  profile (age/BMI/deliveries/compensation/...). The listing card contributes only the name
  (`first-name` div) and cover photo.
- **externalId = the URL slug, always.** Gemini's externalId on these pages is the display
  name ("Paige 11"), which varies between runs and would fork duplicates; the slug is the
  only stable unique key. Gemini's value is demoted to a name fallback. NOTE: the display
  name on the card can differ completely from the slug (card "Paige 11" ->
  `/egg-donors/alyssa-108/`), so never try to derive one from the other.
- profileUrl is set on every item, so the standard section-extraction enrichment fills
  `profileData._sections` + the photo gallery in the same pass (FC galleries use
  `gallery-item-image` markup, not Fotorama - the Gemini `sections.photos` merge covers it).
- Known cost: re-syncs still fetch + type-extract every detail page (the cardHash skip can't
  help because the hash inputs come from the detail fetch itself). Fine at ~100 profiles;
  revisit if a slug-card site is much larger.

---

*When you solve a NEW scraper problem, add it here* (and to the shared engine) so the next
agency doesn't rediscover it. Related: the CLAUDE.md "Donor Sync Scraping Rules" bullet
points here.

## Duplicate field labels are the provider's, not ours

Genesis (`genesiseggdonation.o-jms.com`) labels **two different questions
`Ethnicity`** on the same donor page:

```html
<!-- section: Physical Traits -->
<label class="field">Ethnicity</label><div class="answer">Peruvian 50%, English 25%, Irish 25%</div>
<!-- section: Additional Information, data-profile-question-id="639" -->
<label class="field">Ethnicity</label><div class="answer">No</div>
```

The parser is right to store both - the label really is `Ethnicity` in both
places. 388 donors carry `Additional Information.Ethnicity = "No"`, a handful
carry real text ("We are 100% Venezuelan"). Do NOT "fix" this in the scraper by
renaming or dropping the field: the DB stays faithful to the source. The profile
page reconciles it at render time (`collectDuplicateLabels` /
`isSubstantiveAnswer` in `profile-detail-page.tsx`) by hiding a duplicate label
only when its answer is contentless AND the same label has substance elsewhere.

To inspect real markup before changing any parser:
`npx tsx -r dotenv/config scripts/dump-donor-profile-html.ts <externalId> /tmp/p.html`
It reuses the sync engine's own login + fetch, so it authenticates exactly the
way a real sync does.

---

## API sync method (Sync Method = "Provider API")

Some providers offer an API with a key/secret instead of a scrapeable portal.
The admin selects **Provider API** in the Sync Configuration (per provider, per
type - egg-donor / surrogate / sperm-donor) and enters the **API Endpoint URL**
plus the **API Key** and optional **API Secret** (both stored AES-256-GCM
encrypted in the `*SyncConfig` row, same as the scraper password). Username and
password stay available for APIs that also need a login (used as Basic auth).

Implementation: `runApiSyncJob` in `profile-sync.service.ts`. No AI in this
path - API payloads are already structured JSON.

- **Auth conventions are auto-detected**, tried in order until one returns 2xx
  JSON *with a profile array*: `Authorization: Bearer <key>` (+ `X-API-Secret`),
  `X-API-Key`/`X-API-Secret` headers, `Basic key:secret`, `?api_key=&api_secret=`
  query params, then `Basic username:password`. **Key/secret are optional** -
  with none saved, a bare unauthenticated request is made (open endpoints like
  Lucina's); an auth-required endpoint then fails loudly with the HTTP codes.
  The first accepted strategy is reused for every call.
- **GET and POST both work** - GET is tried first, then form-encoded POST with
  `limit`/`offset` params (PHP-style endpoints, e.g. Lucina's `get_donors`).
  The winning method is reused everywhere.
- **The endpoint must return the profile list as JSON**: a top-level array, or
  under `data` / `results` / `items` / `records` / `profiles` / `donors` /
  `surrogates` / `list` / `rows` (one level of nesting tolerated).
- **Pagination** follows standard next-link conventions (`next`,
  `next_page_url`, `links.next`, `meta.next`, `pagination.next`, `paging.next`);
  POST endpoints without next-links get `limit`/`offset` paging that advances
  until an empty or repeated page (do NOT stop on a "short" page - servers may
  cap `limit` below what we ask, e.g. Lucina defaults to 6). Capped at 100 pages.
- **List + detail APIs**: when the list only carries IDs/summaries, set the
  optional **Profile Detail Endpoint URL**. It is called once per record
  (concurrency 4) with the record's identifier fields (`case_id`, `display_id`,
  `id`, `donor_id`, ... as POST params, or substituted into `{placeholders}` in
  the URL) and the response is merged over the list record - list identifiers
  stay authoritative. A failed detail fetch keeps the list record and logs the
  error.
- **Member-session login for gated detail endpoints**: some platforms gate the
  full-profile endpoint behind a normal member login, NOT the API key. When the
  config has username+password and a detail URL, the engine logs in once via the
  common JSON login routes (`/api/auth/login`, `/api/login`, `/api/auth/signin`,
  body `{identifier, email, username, password}`), and rides the session cookies
  on every detail call.
- **Page-number paging**: when the list URL carries `?page=N`, the engine
  advances `page` until the body's `pages` / `totalPages` / `total_pages` count
  is reached (or a page comes back empty). Structured error envelopes
  (`{ok:false, code, message}`) are surfaced by code in `SyncLog.errors`.
- **Worked example - Lucina Egg Bank (egg-donor), Sep 3 2026** (per Palash
  Basak's email, thread "Lucina egg bank API Access"). Their partner gateway is
  `https://donors.lucinaeggbank.com/api/ext/API-MT1YZ7QG/` with `Api-Key` +
  `Api-Secret` request HEADERS on every call (the `X-` spellings also work;
  never query params or body fields):
  - API Endpoint URL: `.../get-all-donors?page=1&per=100` - GET, 935 donors
    over 10 pages, body `{ok, code, message, page, pages, per, total, donors[]}`.
    Records: `caseId`, `donorId` (= externalId, e.g. BD2874), `tier`, `photo`,
    ethnicity, race, age, height, education, `status`, `journeys[].cohorts[]`
    (`cohortId`, `eggs`, `price`, `status`, `availability` e.g. "Incoming").
  - `.../get-individual-donor?caseId=<caseId>` returns the SAME fields as the
    list record (Palash: it "IS the complete partner-facing profile"). Do NOT
    configure it as the Profile Detail Endpoint - 935 calls/run against a
    **1,000 requests per rolling 24h per endpoint** rate limit buys nothing.
    Leave the detail field empty; the list is the full partner profile.
  - The gated full profile on their website (essays, medical detail, full
    photo set) is intentionally NOT available via any API. The website's own
    `/api/donors` + `/api/donors/{id}/full` routes are internal/unversioned -
    Lucina asked us not to build against them (the earlier Sep 2 setup did).
  - The 2023-era `/donor-api/get_donors` endpoints are the retired platform:
    404 with any credentials.
- **Field mapping is deterministic** (`mapApiRecordToItem`): well-known key names
  (case/underscore-insensitive) map onto the DB columns; the FULL record is
  preserved in `profileData` with titleized keys; photo URLs are collected from
  photo/image/gallery-ish keys and persisted to GCS by the same upsert path the
  scraper uses. Status goes through `normalizeDonorStatus`.
- Everything downstream is shared with the scraper: upserts, manual-edit
  protection, ASRM gate, stale marking, SyncLog, nightly sync, total-cost recalc.
- Failures are loud: zero profiles, non-JSON responses, or all-auth-rejected
  abort the run with the per-strategy HTTP codes in `SyncLog.errors`.

When an API doesn't fit these conventions, extend `runApiSyncJob` (auth
strategy, wrapper key, pagination) in the shared engine - never fork a
per-provider client.
