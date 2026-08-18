# GoStork 2.0 Production Launch Runbook - app.gostork.com

**THE standing rule: every time a "we need to do X before/at/after launch" item
comes up in any session, it gets added HERE, in the right section, same commit.**
This file is the single memory for the launch. Do not keep launch tasks in chat,
in heads, or in other docs. Items marked `[ ]` are open, `[x]` done, `[?]`
blocked on a decision.

Context: GoStork 1.0 is live today at https://app.gostork.com (behind
Cloudflare). This repo is GoStork 2.0 and replaces it. Until launch, both dev
Macs act as the live environment via ngrok; at launch everything moves to
app.gostork.com and the dev machines STOP being production.

---

## 0. Open decisions (blocking - answer before sequencing the launch)

Decided 2026-08-18 (Eran):
- [x] **Database strategy: FRESH production DB.** A new Supabase project becomes
  production; the current project `bryzqwfzvgjenijciwaa` stays as the dev DB.
  Consequence: a production data-seeding plan is required - see section 3.
- [x] **Dev Macs after launch: separate dev database** (the current project).
  Complete isolation - a stale dev process can only ever touch dev data.
  PASSIVE_MODE on the Macs becomes optional extra hygiene, not a requirement.

- [x] **Where is 1.0 hosted: Google Cloud.** Verified 2026-08-18 in Cloudflare
  DNS + direct origin probe: `app.gostork.com` -> A `34.28.191.216` (proxied),
  plus siblings `alpha-app` -> `35.238.203.120` and `test-app` ->
  `34.46.187.88`. Origin serves plain HTTP (TLS terminates at Cloudflare -
  Flexible-style). 1.0 was never on the Replit deployment; the 2026-08-18
  shutdown did not affect it.

- [x] **Where does 2.0 production run: GCP** (decided 2026-08-18). Same cloud
  as 1.0/GCS/Speech-to-Text. Sub-decisions to make when provisioning: VM (like
  1.0) vs Cloud Run; region; and CI/CD - wire auto-deploy on push to main
  (Cloud Build/GitHub Actions) so production can never drift behind the repo
  the way the Replit deployment did.

- [x] **Launch style: STAGED via test-app.gostork.com** (decided 2026-08-18).
  2.0 goes live first on the existing `test-app.gostork.com` record (repointed
  to the new GCP origin), used with real families/providers for a validation
  period, then `app.gostork.com` flips to the same origin. Consequences:
  - Staging runs on the PRODUCTION database from beta day one - beta users are
    real users whose data must survive the flip.
  - During beta: `APP_URL=https://test-app.gostork.com` on the staging
    deployment (all email/SMS/PandaDoc links point there); at the final flip it
    becomes `https://app.gostork.com` + restart. Two-line change by design.
  - Turnstile allowed hostnames need test-app.gostork.com AND app.gostork.com.
  - OAuth redirect URIs (Google/Microsoft) need both hostnames.
  - PandaDoc: add a staging webhook subscription for test-app during beta;
    reactivate/repoint the production one at the flip.
  - Bot Fight Mode is ZONE-wide, so it must come off BEFORE the beta starts,
    not at the final flip (it would kill staging webhooks too).
  - A2P note: the campaign declares app.gostork.com as the flow URL; beta
    signups happen on test-app with identical consent UI. Substance matches;
    the declared URL is the permanent home. Acceptable - do not re-file.

- [x] **Environment architecture: TWO isolated environments** (decided
  2026-08-18). Dev (Macs + dev Supabase) and Production (GCP + prod Supabase).
  `test-app.gostork.com` is NOT a third environment - during the beta it is
  production-in-waiting (same origin, same prod DB, different hostname), and
  afterwards it is retired or kept as a spare alias. No permanent staging tier
  unless future scale justifies it.

All section-0 decisions are now closed.

## 1. Domain & Cloudflare

- [ ] Point app.gostork.com origin at the 2.0 production host (keep orange-cloud
  proxy).
- [ ] **Bot Fight Mode must come OFF at launch** (verified ON 2026-08-18 with
  JS Detections; it is what serves `cf-mitigated: challenge` to non-browser
  requests). On standard plans Bot Fight Mode CANNOT be bypassed per-path -
  WAF skip rules do not apply to it - so left on, it silently kills ALL
  server-to-server traffic to app.gostork.com: PandaDoc/Stripe webhooks and
  the nightly-sync pinger. (Likely why the production PandaDoc subscription
  sits deactivated today.) Replace with:
  - Scoped WAF custom rules (challenge browsers on auth/signup paths if
    desired, explicitly skip `/api/webhooks/*` and `/api/cron/*`)
  - Turnstile already guards signup/OTP at the app layer
  - Or upgrade to a plan with configurable Super Bot Fight Mode / Bot
    Management if blanket bot protection is wanted
- [ ] Other Security toggles as of 2026-08-18: Block AI Bots ACTIVE on all
  pages (crawler-focused - fine, but verify it never matches API/webhook
  traffic in smoke tests); AI Labyrinth OFF; Browser Integrity Check OFF.
- [ ] Cache rules: bypass cache for `/api/*`; ensure SSE
  (in-app notifications stream) is not buffered/cached by Cloudflare.
- [ ] SSL mode: currently effectively Flexible (1.0 origin has no TLS -
  verified 2026-08-18). For 2.0, put TLS on the origin and move the zone to
  Full (strict); verify no redirect loops.
- [ ] Decide fate of the 1.0 sibling records at/after launch:
  `alpha-app.gostork.com` (35.238.203.120) and `test-app.gostork.com`
  (34.46.187.88) - retire or repurpose (e.g. test-app as the 2.0 staging/beta
  origin for a staged launch).
- [ ] Decommission plan for the 1.0 GCP resources once 2.0 is stable
  (VMs/IPs behind 34.28.191.216 and the two siblings) - stop billing, keep a
  snapshot.
- [ ] Turnstile: the site key is domain-scoped. Add app.gostork.com to the
  Turnstile widget's allowed hostnames (or mint a production site key) and set
  the production secret in the prod env. Signup OTP send breaks without this.
- [ ] www.gostork.com (WordPress marketing site) stays as-is - separate origin.

## 2. Environment (production host .env / secrets)

- [ ] `APP_URL=https://app.gostork.com` - drives every outbound link in emails,
  SMS, and PandaDoc completion URLs (get-base-url.ts). Env is read at process
  start; restart after changing.
- [ ] `PASSIVE_MODE` must NOT be set on the production host (it strips email/SMS
  creds and disables schedulers - see server/passive-mode.ts).
- [x] Secret inventory: `.env.production.example` in the repo root is the
  authoritative template (built 2026-08-18 from the live dev key list + code
  reads). Every key annotated [copy]/[fresh]/[prod]. Notables: FIELD_ and
  CALDAV_ENCRYPTION_KEY are fresh AND rotation-sensitive; VITE_* keys bake in
  at client BUILD time so production builds need production values; Stripe
  goes live-mode; verify whether Braintree is still in use before launch.
- [ ] Fill the template on the GCP host (values via Eran for the [prod]/[fresh]
  ones).
- [ ] `NODE_ENV=production` and trust-proxy/secure-cookie behavior verified
  behind Cloudflare (session cookies must survive the proxy).
- [ ] Rotate any secrets that lived on the old Replit deployment if it is ever
  deleted-with-history or was shared.

## 3. Database (decided: FRESH production Supabase project; current one stays dev)

- [ ] Provision the production Supabase project (region, tier, PITR/backups
  appropriate for production).
- [ ] Apply the full schema: `prisma migrate deploy` (all of
  `prisma/migrations/*`) against the new DB.
- [ ] **Content seeding plan - the big workstream.** Production starts with no
  users, but the PLATFORM CONTENT must come over from dev. Inventory to copy
  (script it, don't hand-copy): SiteSettings + BrandTemplate (brand),
  ConciergePromptSection (AI prompts - DB is source of truth), Matchmaker
  personas, ProviderType seed rows, Provider orgs + services + cost sheets +
  templates that are real (not test), donor/surrogate profiles + photos,
  knowledge base (KnowledgeChunk/ExpertGuidanceRule + pgvector data), CDC
  datasets, GoStork house provider (GOSTORK_PROVIDER_ID env must match the new
  row id). Explicitly EXCLUDE: test users, test parents, 555-01xx phones,
  chat sessions, notifications, bookings.
- [ ] pgvector extension enabled on the new project before knowledge import.
- [ ] Decide provider/staff account migration: real provider logins (e.g.
  Eggspecting staff) must exist in prod - re-invite vs. copy with password
  hashes.
- [ ] Production `DATABASE_URL` (+ session store - connect-pg-simple uses the
  same DB) into the prod env only. Dev Macs keep pointing at the dev project.
- [ ] Supabase MCP: ops sessions must target the right project per environment -
  the project id `bryzqwfzvgjenijciwaa` in CLAUDE.md becomes DEV; add the prod
  project id to CLAUDE.md at cutover with a "which DB am I touching" warning.
- [ ] Nightly donor-scraper sync: decide target - production pinger writes to
  prod DB; dev scraping stays on dev. Photos/GCS paths must resolve in both.
- [ ] Re-apply the `smsNotificationsOptIn` grandfather intent for any migrated
  users (2026-08-18 dev state: 43/43 with phones opted in).

## 4. Twilio / SMS (A2P 10DLC)

Cutover happens ONLY after the resubmitted campaign shows VERIFIED
(compliance SID QE2c6890da8086d771620e9b13fadeba0b on service
MG6c4e651e006fe5b8a47523b244db96cd; daily watcher `twilio-a2p-campaign-watch`
polls at 7am on the iMac). Then, in ONE sitting, in this order:

- [ ] Move +12058962077 from sole-prop service MGa6b8064464ed2c6cdd94fe2848d70255
  into MG6c4e651e006fe5b8a47523b244db96cd (a number lives in exactly one
  service - this is the cutover moment).
- [ ] Flip `TWILIO_MESSAGING_SERVICE_SID` to MG6c4e... in every non-passive env
  (at launch: the production host; pre-launch: both Macs).
- [ ] Rebuild/restart affected hosts; send one real test SMS; confirm delivery.
- [ ] Delete the old sole-prop campaign CX4XS4N and its brand.
- [ ] Delete the `twilio-a2p-campaign-watch` scheduled task once done.
- [ ] The campaign's declared flow URL is already https://app.gostork.com - no
  Twilio change needed at launch BY DESIGN. Keep it that way.
- [ ] NEVER let www.gostork.com/sms-consent (WordPress page 5461) or
  /terms section 17 be unpublished or reworded except in lockstep with
  the registered copy (carrier audit risk). They must survive launch.
- [ ] OTP: `TWILIO_VERIFY_SERVICE_SID` set in prod (signup verification texts).

## 5. PandaDoc

- [ ] Reactivate webhook subscription "GoStork - Production Agreements"
  (uuid 2d18c09a-e107-4ad4-9b0b-799e8dd3dd5c -> app.gostork.com), currently
  DEACTIVATED.
- [ ] Decide fate of dev subscriptions at launch: MacBook (gostork.ngrok.app),
  iMac (uuid 5161bc69-39b8-4ab9-afc9-7d1e74150c66), Replit (deactivated
  2026-08-18). If dev Macs go PASSIVE_MODE they ignore events anyway.
- [ ] **Webhook signature verification** on POST /api/webhooks/pandadoc -
  currently NONE (any unauthenticated POST is processed; flagged 2026-08-18 as
  a spawned security task). Must ship before production launch. Note each
  subscription has its own shared_key; the env secret must match the
  production subscription's key.
- [ ] The doc-sign task reconciler (task-materializer.ts reconcileDocSignTasks,
  shipped 2026-08-18) is the safety net for missed webhooks - keep it.

## 6. Email (SendGrid)

- [ ] Confirm SendGrid domain authentication (SPF/DKIM) for the sending domain
  and the from-address used in production.
- [ ] All emails already render via buildBrandedEmail() from DB brand settings;
  logo ships as a 7-day signed GCS URL (verified working 2026-08-18). No
  launch action, but: any long-lived email older than 7 days has an expired
  logo link - acceptable, or consider a public logo proxy route later.
- [ ] Old brand green (#26584A / #004D4D) is still hardcoded in the
  receipt/invoice PDF generator and server brand DEFAULTS - update if the
  current brand should apply there (code edit + restart).

## 7. OAuth / Calendar integrations

- [ ] Google OAuth client: add https://app.gostork.com redirect URIs (calendar
  connect + any login), verify consent screen domain, confirm production
  publishing status (not "testing" mode, which expires tokens in 7 days).
- [ ] Microsoft Graph app registration: add production redirect URIs.
- [ ] Apple/CalDAV: no redirect URIs, but verify app-specific password flow
  documentation for users.
- [ ] Reconnect flows tested against the production URL (calendar-health emails
  link users to APP_URL).

## 8. Payments (Stripe)

- [ ] Live-mode keys in prod env.
- [ ] Stripe webhook endpoint(s) registered for app.gostork.com with live
  signing secret (and Cloudflare WAF bypass - see section 1).
- [ ] Stripe Connect (provider payouts) redirect/return URLs on production
  domain.

## 9. Schedulers & background jobs

Rule: exactly ONE environment runs schedulers against the production DB.

- [ ] Production host runs them (no PASSIVE_MODE).
- [ ] Both dev Macs: set PASSIVE_MODE=1 at launch (or move to a dev DB) -
  see Open decisions.
- [ ] Nightly scraper sync: the external pinger (GitHub Actions cron ->
  /api/cron/run-nightly-sync) must target app.gostork.com and pass the
  Cloudflare bypass; ENABLE_NIGHTLY_SCHEDULER stays false everywhere unless
  deliberately chosen.
- [ ] iMac LaunchDaemons (com.gostork.nightly-sync server, tunnel, autosync)
  are DEV infrastructure - decide whether the iMac keeps running as a dev box
  post-launch (with PASSIVE_MODE) or is retired.

## 10. Security hardening (pre-launch)

- [ ] PandaDoc webhook signature verification (section 5).
- [ ] Audit other inbound webhook/callback routes for auth (Twilio inbound,
  Stripe signature checks, cron route secret?).
- [ ] Session cookie flags behind Cloudflare (secure, sameSite) verified.
- [ ] Admin accounts audit; remove/disable test admin logins.
- [ ] Rate limiting sanity on auth + OTP routes at production traffic levels.

## 11. Launch sequence (staged - two phases)

### Phase A - beta on test-app.gostork.com

1. Provision the production Supabase DB; run migrations; execute the content
   seeding plan (section 3).
2. Provision the GCP host for 2.0 with TLS on the origin; wire auto-deploy
   from main.
3. Full production env on it (section 2) with `APP_URL=https://test-app.gostork.com`
   and the production DATABASE_URL.
4. Cloudflare: turn Bot Fight Mode OFF (zone-wide prerequisite); add scoped
   WAF rules + cache bypass for /api; repoint `test-app.gostork.com` A record
   to the new origin; SSL Full (strict).
5. Turnstile + OAuth redirect URIs for test-app.
6. Create the staging PandaDoc webhook subscription (test-app URL); verify one
   signed doc end-to-end.
7. Repoint nightly-sync pinger at test-app; confirm schedulers run ONLY there
   (dev Macs move to the dev DB per section 0, so they are isolated already).
8. Smoke tests (section 12) against test-app.
9. Beta period: real families/providers, watch logs, fix, iterate (auto-deploy
   keeps staging current).

### Phase B - the flip to app.gostork.com

1. Freeze pushes during the window.
2. Cloudflare: repoint `app.gostork.com` A record to the same GCP origin.
3. On the host: `APP_URL=https://app.gostork.com`; restart.
4. PandaDoc: reactivate/repoint the production subscription
   (app.gostork.com); retire the staging one.
5. Repoint the nightly-sync pinger to app.gostork.com.
6. Turnstile/OAuth already include the hostname (Phase A step 5).
7. Re-run smoke tests against app.gostork.com.
8. Decide fate of test-app record (keep as staging alias to the same origin,
   or retire) and decommission 1.0 GCP resources (section 1).
9. Twilio cutover remains INDEPENDENT: it happens when the campaign is
   VERIFIED, before or after either phase (section 4).

## 12. Post-launch smoke tests

- [ ] Signup end-to-end on a real phone: OTP arrives, opt-in checkbox persists
  to smsNotificationsOptIn, account completes with box UNTICKED too.
- [ ] Booking flow: confirmation email (correct 2.0 design, logo loads) + SMS
  (only if opted in).
- [ ] Provider: W-9 sign -> Home task closes without refresh; agreement flow.
- [ ] AI concierge chat (parent + provider assistant) on production URL.
- [ ] Calendar connect + a reconnect email links to app.gostork.com.
- [ ] Payment link end-to-end in live mode (small real charge, refund).
- [ ] SSE in-app notifications arrive through Cloudflare.
- [ ] Verify NO emails/SMS originate from dev Macs anymore (Notification rows
  should all carry stored bodyHtml; bodyHtml NULL = stale/rogue sender).

## 13. Rolling additions

(Add dated items here when they don't fit a section above.)

- 2026-08-18: Replit deployment shut down; PASSIVE_MODE=1 pre-staged in its
  Secrets. If Replit becomes the 2.0 production host, REMOVE that secret there
  and push current code (>= 3e0d0397) before publishing.
