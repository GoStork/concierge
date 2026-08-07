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

## Adding a new agency - the 60-second checklist

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
- **WordPress login uses `log`/`pwd` field names** (not `email`/`password`). The engine
  detects WordPress (by `wp-login.php` URL **or** `name="log"`+`name="pwd"` in the form),
  switches field names automatically, and satisfies WP's cookie check by sending the
  `wordpress_test_cookie` cookie plus the `testcookie` / `wp-submit` hidden fields.
  - **Gotcha:** for WordPress sites the **Source URL must be the donor-list page**, not
    `wp-login.php`. (The engine logs into WP, then needs the list page to scrape.)
- **reCAPTCHA v2** is solved via **token injection** (no headless browser):
  `captcha-solver.ts` extracts the `data-sitekey`, submits it to **2captcha**
  (`in.php`/`res.php`), gets a `g-recaptcha-response` token, and adds it to the login POST.
  - Configure with env **`TWOCAPTCHA_API_KEY`** (alias `CAPTCHA_SOLVER_API_KEY`).
  - Symptom in `SyncLog.errors`: `reCAPTCHA required on POST response` / `404 (reCAPTCHA page)`.
  - **Only reCAPTCHA v2 is auto-solved.** hCaptcha / Cloudflare challenges fail loudly with
    `... not supported by the captcha solver (only reCAPTCHA is)` rather than POSTing blind.
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
| `Failed to extract data ... page may not contain profiles` | Login returned a non-list page, or markup changed | Check login succeeded; verify the AJAX/list endpoint + extraction |
| `(EAUTHTIMEOUT) timeout while waiting for message` | Transient upstream stall (EDC host) | Already retried; re-run if it slips through |
| `Interrupted - server restarted while sync was running` | Benign - server was restarted mid-run | Ignore; auto-resume re-runs it |
| Gallery shrank to 1 photo after a nightly | Hash-skip overwrote the gallery | Preserve existing `All Photos` (`034d8cf`) |
| Only the state shows (no city) | City is in `profileData.Location`, not the scalar | `cleanCityState` recovery (`dfef635`) |
| `Invalid prisma.*.upsert() ... ` on a scalar field (e.g. `education`) | AI section returned a nested object for a String column | `pickScalar` coercion in the section→column mapping |
| Gallery only partially downloaded (some photos missing) | Image host rate-limited the burst (429) | `persistSinglePhoto` 5x exp backoff + `Retry-After` (`034d8cf`) |
| WP donor `profileUrl` points at the wrong/404 page | Built the URL from `externalId` instead of the card's `view-more` href | Internal `donor_id` ≠ public number; capture per card (`extractWpDonorCardProfileUrls`) |
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
