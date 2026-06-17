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

- **Candidate-URL fallback.** The engine tries the Source URL, then `/Account/Login`,
  then `/login` (and `/user/login`). It auto-detects the form `action`, CSRF/verification
  tokens (`__RequestVerificationToken`, `_token`, `csrf-token`), and email/password fields.
- **WordPress login uses `log`/`pwd` field names** (not `email`/`password`). The engine
  detects `wp-login.php` and switches field names automatically.
  - **Gotcha:** for WordPress sites the **Source URL must be the donor-list page**, not
    `wp-login.php`. (The engine logs into WP, then needs the list page to scrape.)
- **reCAPTCHA v2** is solved via **token injection** (no headless browser):
  `captcha-solver.ts` extracts the `data-sitekey`, submits it to **2captcha**
  (`in.php`/`res.php`), gets a `g-recaptcha-response` token, and adds it to the login POST.
  - Configure with env **`TWOCAPTCHA_API_KEY`** (alias `CAPTCHA_SOLVER_API_KEY`).
  - Symptom in `SyncLog.errors`: `reCAPTCHA required on POST response` / `404 (reCAPTCHA page)`.
- **HTTP 405 on `/Account/Login` is NOT the real error** - it means the *correct* login
  URL (e.g. `/user/login` on JMS/o-jms, `/login` on Symfony) failed transiently and the
  engine fell through to the EDC fallback path, which those non-EDC platforms reject with
  405. The engine now **retries transient auth failures** (commit `f30ddf6`), so a momentary
  `fetch failed` no longer cascades to a bogus 405. If you see 405, check whether the *real*
  login URL had a transient blip first.

## Profile pages - fetch EVERYTHING, never assume one page

- **Always discover and fetch ALL tabs/views** (Overview, Profile, Photos, etc.).
  Many sites load tabs via **separate AJAX partial views** - e.g. EDC platforms serve
  `/Recipient/_DonorDashboardMatching` and `_DonorProfileHTML?DonorId=...` as AJAX
  fragments. The engine fires the AJAX request (with `RecipientId`/`ClinicId` from the
  dashboard) rather than assuming all data is in the first HTML response.
- **Card-list sites (WordPress, e.g. Eggspecting):** capture each donor's **profileUrl**
  from the listing card so the per-donor page can be fetched (commit `465af14`).

## Pagination

- The AI extraction returns **`paginationLinks`** (Next / page 2 / ...). The engine
  discovers **all** listing pages, capped at **100 pages** as a runaway guard (was 10,
  which silently truncated large catalogs).
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
- **Hash-skip must never shrink a gallery** (commit `034d8cf`): when a donor's `cardHash`
  is unchanged, the run carries only the single listing-card photo - so preserve the
  existing `All Photos` gallery instead of overwriting it.
- **Survive image-host 429s** - the shared `fetchHtml` retries `429 Too Many Requests`
  (and other transient errors) with backoff, so a rate-limiting image host doesn't fail
  the run.

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

## Data mapping gotchas

- **Location city lives in `profileData.Location`** (e.g. `"Hemet CA | $70,000"`,
  `"Bakersfield, CA"`) even when the stored `location` scalar is just the state (`"CA"`).
  The card/detail recover the city for display via `cleanCityState` (commit `dfef635`).
  Keep the raw `location` scalar for filtering/Matched-Preferences.
- **Never assume HTML attribute order in regex** - `src` may come before or after `class`.
- **Compensation / cost** is often appended to the location field (`"City, ST | $70,000"`);
  strip the `| $...` suffix when reading the city.

## Troubleshooting - symptom → cause (check `SyncLog.errors` + `/tmp/gostork-server.log`)

| Symptom in `SyncLog.errors` / log | Cause | Fix / where |
|---|---|---|
| `Login failed ... 405 (Method Not Allowed)` | Transient blip on real login URL → bogus EDC fallback | Auth retry (`f30ddf6`); confirm Source URL is the right login/list page |
| `reCAPTCHA required` / `404 (reCAPTCHA page)` | Site needs captcha solving | Set `TWOCAPTCHA_API_KEY`; `captcha-solver.ts` |
| `Failed to extract data ... page may not contain profiles` | Login returned a non-list page, or markup changed | Check login succeeded; verify the AJAX/list endpoint + extraction |
| `(EAUTHTIMEOUT) timeout while waiting for message` | Transient upstream stall (EDC host) | Already retried; re-run if it slips through |
| `Interrupted - server restarted while sync was running` | Benign - server was restarted mid-run | Ignore; auto-resume re-runs it |
| Gallery shrank to 1 photo after a nightly | Hash-skip overwrote the gallery | Preserve existing `All Photos` (`034d8cf`) |
| Only the state shows (no city) | City is in `profileData.Location`, not the scalar | `cleanCityState` recovery (`dfef635`) |

## Platform cheat-sheet

- **EDC** (`/Recipient/...`): AJAX partial views (`_DonorDashboardMatching`,
  `_DonorProfileHTML`, `_DonorPhotoGalleryHTML`); `/Account/Login`; dynamic `/Photo/Get` URLs.
- **JMS / o-jms** (e.g. genesis): login at **`/user/login`** (NOT `/Account/Login` → 405);
  `profileData.Location` = `"City ST | $comp"`.
- **WordPress** (e.g. Eggspecting): `log`/`pwd` login fields; Source URL = donor-list page,
  not `wp-login.php`; per-card `profileUrl` capture; image-host rate-limits (429) - retried.
- **Symfony** (e.g. app.spermbankcalifornia): login at **`/login`**; `/Account/Login` → 405.

---

*When you solve a NEW scraper problem, add it here* (and to the shared engine) so the next
agency doesn't rediscover it. Related: the CLAUDE.md "Donor Sync Scraping Rules" bullet
points here.
