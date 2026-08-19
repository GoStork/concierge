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

## 0.5 Phase A execution status (living - update as steps complete)

As of 2026-08-18 (MacBook session "Production Preparation" continued from the
iMac handoff):

DONE:
- [x] Content seeder built + dry-run tested against dev: 82,140 rows / 38
  tables (`scripts/seed-production.ts`; dry-run is default, needs
  TARGET_DATABASE_URL + --execute to write).
- [x] Production env template: `.env.production.example` (every key annotated
  copy/fresh/prod).
- [x] **Production Supabase project created** (2026-08-18, $10/mo approved by
  Eran in-session): org `qobelfonalrrtgeopjny`, name "GoStork Production",
  **project id `itlnituvybtnzmrzbkoz`**, region us-east-1, Postgres 17.6.
  Dashboard: https://supabase.com/dashboard/project/itlnituvybtnzmrzbkoz
- [x] **Full schema applied to prod** via Supabase MCP (no DB password
  needed): extensions vector + pg_trgm in `public` (matching dev), pgcrypto +
  uuid-ossp in `extensions`; DDL generated with
  `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`
  (109 tables, 175 indexes, 106 FKs, 4 enums) - NOT by replaying
  `prisma/migrations/*` (0_init is 25KB and cannot rebuild the schema; dev
  was shaped by `db push` + ad hoc SQL). Then the 24 raw-SQL-only indexes
  that dev has and Prisma does not know about (HNSW on the 4
  `profileEmbedding` cols + KnowledgeChunk.embedding, trgm GIN on
  ParentNote/ParentTask, the COALESCE functional uniques on
  ProviderAutoReply/ProviderAutoReplySend/ProviderParentBriefing, the
  ParentOwner partial uniques, lower(city/state), partial Invoice/CostItem).
- [x] **Parity verified prod vs dev**: table set identical; PK 109=109; FK
  106=106; column diff = 15 dev-only DEAD columns that are not in
  schema.prisma (BrandTemplate's 10 legacy chatBubble*/chatInput* cols,
  SiteSettings + ProviderBrandSettings `quickReplyBorderOpacity`/
  `quickReplyBgOpacity`, ProviderCostSheet.matchingRules - code confirms all
  unused). The seeder does column-intersection inserts, so they are simply
  skipped. Skipped on purpose: `ParentFollowUp_pkey` (legacy duplicate) and
  the two `ParentProfileView_account_*` twins of Prisma-named indexes.
- [x] `_prisma_migrations` baselined on prod with all 160 migration dirs
  (sha256 checksums, applied_steps_count=1), so `prisma migrate deploy` in
  CI/CD is a clean no-op instead of re-running 0_init into existing tables.
  Future schema changes: keep writing migration files; deploy applies only
  new ones. `session` (connect-pg-simple) is created by the app on first
  boot (`createTableIfMissing: true`).
- [x] gcloud installed on the MacBook (`brew install --cask
  google-cloud-sdk`, SDK 580.0.0, `/opt/homebrew/bin/gcloud`). No account
  yet.
- [x] Discovery: the GCS/Speech service account lives in GCP project
  `gen-lang-client-0051391254` (auto-created AI Studio project). Compute
  Engine API is NOT enabled there, so the 1.0 VMs (34.28.191.216 etc.) are in
  a DIFFERENT project. Decision needed when provisioning: host 2.0 in the
  1.0 project, or a clean `gostork-prod` project (GCS bucket
  `gostork-recordings` stays where it is either way - the SA key just needs
  to be in the prod env).

- [x] Prod DB password reset by Eran (2026-08-18). Prod pooler host is
  **`aws-0-us-east-1.pooler.supabase.com`** (dev is `aws-1`; the MCP does
  not tell you which - probe). Connection strings for the prod host env:
  transaction pooler `:6543/postgres?pgbouncer=true` = `DATABASE_URL`;
  session pooler `:5432/postgres` = `DIRECT_URL`. On the MacBook the
  session-pooler URL lives ONLY in `~/.gostork-prod.env` (chmod 600, outside
  the repo) as `TARGET_DATABASE_URL`; run the seeder with
  `set -a; source ~/.gostork-prod.env; set +a; npx tsx scripts/seed-production.ts --execute`.
  Never put it in a dev Mac `.env`.
- [ ] **Rotate the prod DB password before beta users arrive** - it was
  pasted into a chat session on 2026-08-18. Rotation = dashboard reset +
  update `~/.gostork-prod.env` + prod host env.
- [x] **PROD SEEDED 2026-08-18** - 82,140 rows / 38 tables, all counts
  equal to source: Provider 467, ProviderLocation 1253, EggDonor 1659,
  Surrogate 40, SpermDonor 90, ConciergePromptSection 30, KnowledgeChunk
  2331 (2277 with embeddings, same as dev), IvfSuccessRate 42044,
  PhotoFingerprint 33268, SiteSettings 1, BrandTemplate 3 (1 active),
  SecurityCountryPolicy 175. User / AiChatSession / Booking / Notification
  = 0 by design. Independent FK sweep over all 106 constraints: zero
  dangling references. Three seeder fixes landed on the way (all in
  `scripts/seed-production.ts`, commit-tracked): (a) json/jsonb columns
  are JSON.stringify'd - pg re-encodes a JS array from jsonb as a PG array
  literal (`Provider.ivfAcceptingPatients=["gay_couple"]` -> 22P02);
  (b) multi-row batched INSERTs - the per-row version ran ~5 rows/s over
  the pooler (hours for the 75k-row tables), batched run took ~2 min;
  (c) `USER_REF_NULL_COLUMNS.Surrogate` was misspelled
  (`reservedByUserId`; real column `reservedByParentId`) so 3 dev
  test-parent reservations came over as orphans - nulled on prod (with
  `reservationExpiresAt`) and the list fixed. Re-running the seeder is
  safe (idempotent, never clobbers prod edits) - BUT see the next item.
- [x] **PROD PRUNED 2026-08-19 (Eran's decision):** dev providers, scraped
  profiles and CDC data are NOT real and Eran wants to test every provider
  feature from scratch in production. Deleted from prod in one transaction:
  466 non-GoStork Providers (+ their services/locations/brand/fees/IP-form
  overrides/provider KB chunks via cascade), all EggDonor/Surrogate/
  SpermDonor + the 7 scraper sync configs, all IvfSuccessRate +
  CdcDatasetMap, all PhotoFingerprint, all 42 CostProgram. KEPT: the
  GoStork house provider `5dc90fe4-15bc-485f-a470-ea325b742072` with
  everything inside it (1 location, brand settings, 2 ReferralFeeConfig,
  global SilenceConfig, 72 tier-1 KnowledgeChunk, 4 playbooks) and all
  platform config (SiteSettings, BrandTemplate, Matchmaker, 30
  ConciergePromptSection, ConciergeAsset, ExpertGuidanceRule,
  AutomationDefaults, 11 ProviderType, 52 CostTemplate, IpForm
  sections/questions, SponsorshipPlan, Security*). Users = 0 - Eran signs
  up on test-app and gets promoted to admin. **Do NOT re-run
  `seed-production.ts --execute` against prod** - it would bring the 466 dev
  providers and scraped profiles back (it is idempotent by id, so it would
  re-insert the deleted rows). If a config-only top-up is ever needed,
  run it with CONTENT_TABLES trimmed to the config tables.

NEXT, in order (items marked ERAN need a human in a browser):
1. [x] prod DB password + connection strings.
2. [x] Seed complete + verified (above).
3. [x] gcloud logged in on the MacBook as eran.amir@gostork.com (2026-08-19,
   with ADC). Discovery: 1.0 runs in GCP project **`gostork`** (project
   number 783186919206, billing account 01AAE7-19EFE9-CE6C03) as a **GKE
   cluster** `main-cluster` (us-central1-a, 3 nodes) built by a self-hosted
   GitLab (`gitlab-1`, `gitlab-runner-2` VMs) - the `34.28.x/35.238.x/34.46.x`
   app IPs are ephemeral GKE load-balancer IPs. Same project also has
   `scrapper`, `gostork-website` (us-east1-b) and `wordpress-1-vm`
   (us-east1-c). `babies-island` is an older project with everything
   TERMINATED. `gen-lang-client-0051391254` = GCS/Speech only.
   **DECISION 2026-08-19 (Eran, on recommendation): 2.0 host = one Compute
   Engine VM in project `gostork`, region us-east4 (next to the us-east-1
   Supabase), NOT Cloud Run and NOT the 1.0 GKE cluster.** Rationale: the
   app is a single long-lived Node process (22 in-process schedulers, WS
   voice gateway, SSE, long Chromium scrapes) - a VM mirrors how it runs on
   the Macs today; local `public/uploads` is only the no-GCS fallback so
   persistence is not a concern either way; ~$50/mo; the whole GKE+GitLab
   footprint retires with 1.0.
   [x] **PROVISIONED 2026-08-19 - the 2.0 production host is live:**
   VM `gostork-2-prod` (project `gostork`, zone us-east4-b, e2-standard-2,
   Ubuntu 24.04, 50GB pd-balanced, shielded VM, OS Login), static IP
   **`34.85.132.142`** (address `gostork-2-prod-ip`, us-east4). Node
   24.19 / npm 11.17 / git / Caddy 2.11 / Chromium libs. App cloned to
   `/srv/gostork/app` (public repo, no deploy key needed), owned by service
   user `gostork`; systemd unit `gostork.service` runs `node dist/index.cjs`
   (the app's own dotenv loads `/srv/gostork/app/.env`, chmod 600 - do NOT
   use systemd EnvironmentFile, its quoting differs from dotenv and broke the
   multi-line GCS JSON key once). Caddy reverse-proxies :80 -> 127.0.0.1:5001
   (flush_interval -1 so SSE streams). Verified: SPA 200, /api/brand/settings
   returns the seeded prod brand, /api/user 401, providers 200, "GCS storage
   configured successfully", all schedulers started, nightly sync in-process
   OFF (pinger-driven). Logs: `journalctl -u gostork -f`. Shell:
   `gcloud compute ssh gostork-2-prod --project=gostork --zone=us-east4-b --tunnel-through-iap`.
   [x] **Auto-deploy from main** (pull model, zero GitHub secrets):
   `/usr/local/bin/gostork-deploy` via `gostork-deploy.timer` every minute -
   fetch origin/main, if changed: reset --hard, npm ci, prisma generate,
   npm run build, **prisma migrate deploy**, restart (`journalctl -u
   gostork-deploy`). Same model as the Macs' auto-sync. A GitHub-Actions
   push deploy can be layered later for visibility if wanted. **Verified
   2026-08-19**: push c892c74c -> deployed in ~2 min; push c434d6d4 ->
   "No pending migrations to apply" -> restart -> 200. Lesson: the first
   run hung in `prisma migrate deploy` because `prisma.config.ts` gave the
   CLI DATABASE_URL (pgbouncer :6543) - fixed in c434d6d4 (CLI now uses
   DIRECT_URL), and the deploy script wraps migrate in `timeout 300` so a
   hang can never wedge the timer again (it logs a WARN instead).
   [x] Prod `.env` on the host: built from `.env.production.example` -
   [copy] keys from the MacBook dev .env (dotenv-parsed, round-trip
   verified), [fresh] SESSION_SECRET / JWT_SECRET / FIELD_ENCRYPTION_KEY /
   CALDAV_ENCRYPTION_KEY / NIGHTLY_SYNC_SECRET generated new,
   APP_URL=https://test-app.gostork.com, prod DATABASE_URL/DIRECT_URL.
   SUPABASE_* and BRAINTREE_* dropped - code never reads them (template can
   lose them). GOSTORK_PROVIDER_ID unset like dev (code falls back to the
   provider named "GoStork", which was copied with its id).
   [ ] STILL EMPTY in the host .env, to be supplied by Eran when each
   integration is wired: STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY /
   VITE_STRIPE_PUBLISHABLE_KEY (live; client REBUILD needed after setting
   the VITE_ one - `sudo gostork-deploy --force`), STRIPE_WEBHOOK_SECRET,
   STRIPE_CONNECT_WEBHOOK_SECRET, PANDADOC_WEBHOOK_SECRET (staging sub),
   DAILY_WEBHOOK_SECRET. Stripe client is lazy so the server runs without
   them; payment actions error until set.
   [ ] Lock-file hygiene lesson: `npm ci` failed on the clean host because
   `bufferutil` (optionalDependency) was never recorded in package-lock.json
   - fixed in eec37dcb. Any future package.json edit must regenerate the
   lock (npm ci is what the host runs).
   [ ] Harden later (section 10): Express sends `X-Powered-By`; restrict
   the GCE firewall 80/443 to Cloudflare IP ranges once proxied DNS is live
   (today `allow-http`/`allow-https` are 0.0.0.0/0 on the default network).
4. [x] **Cloudflare DONE 2026-08-19** (Claude drove Eran's logged-in Chrome;
   the CLOUDFLARE_API_TOKEN in .env is Turnstile-scoped only):
   a. [x] Security > Settings > **Bot Fight Mode OFF** (zone-wide).
   b. [x] SSL/TLS > Origin Server: **Origin Certificate** created (RSA 2048,
      `*.gostork.com` + `gostork.com`, valid to 2041-08-15). Files on the
      MacBook: `~/.gostork-origin.pem` / `~/.gostork-origin.key` (chmod 600,
      outside the repo) and on the VM at `/etc/caddy/tls/origin.{pem,key}`.
      Caddy serves :443 with it and REQUIRES a Cloudflare client cert
      (`/etc/caddy/tls/cloudflare-origin-pull-ca.pem`), and **Authenticated
      Origin Pulls (Global) is ON** in the zone - so nobody but Cloudflare's
      edge can complete a TLS handshake to the origin. :80 is still open on
      Caddy for the transition; close it (and restrict the GCE firewall to
      Cloudflare ranges) once app.gostork.com is on strict too.
   c. [x] The zone encryption mode was NOT changed (1.0's origin is plain
      HTTP). Instead a **Configuration Rule "test-app strict TLS"**
      (`http.host eq "test-app.gostork.com"` -> SSL Full (strict)) is
      Active. At Phase B, add app.gostork.com to that rule (or flip the zone)
      and then the :80 listener can go.
   d. [x] DNS: `test-app.gostork.com` A -> `34.85.132.142`, proxied.
      Verified: https://test-app.gostork.com -> HTTP/2 200 via Cloudflare,
      brand settings from prod, /api/user 401, http:// -> 301 https://,
      origin :443 connections arrive from Cloudflare edge IPs. Note: 1.0's
      test server stays reachable on `test.gostork.com` and
      `dev2.gostork.com` (both still -> 34.46.187.88), so no parking record
      was needed. Other 1.0 names seen: `prod2` -> 34.28.191.216.
   e. [x] Turnstile widget "GoStork signup" (0x4AAAAAAEOXjCUeXzZCwxuu):
      hostnames now app.gostork.com, gostork.com, gostork.ngrok.app,
      test-app.gostork.com.
   [ ] Still to do in Cloudflare: `/api/*` cache bypass + WAF skip rules
      for `/api/webhooks/*` and `/api/cron/*` (section 1) - lower priority
      now that Bot Fight Mode is off; do before the Stripe/PandaDoc
      webhooks go live.
5. Step 5 (2026-08-19):
   a. [x] **PandaDoc staging subscription created**: "GoStork - Staging
      Agreements (test-app)" uuid `3a53a683-64e0-49f2-b932-7817dd816241`,
      ACTIVE, url https://test-app.gostork.com/api/webhooks/pandadoc
      ?signature={signature}, triggers document_state_changed +
      recipient_completed (same as prod/dev subs). Its shared_key is in the
      prod host .env as PANDADOC_WEBHOOK_SECRET (and in
      `~/.gostork-prod-pandadoc-shared-key` on the MacBook). API note: the
      `{signature}` placeholder must be sent URL-encoded (%7Bsignature%7D)
      or the API returns "url: must be valid url". At Phase B: repoint or
      deactivate this one and reactivate 2d18c09a (app.gostork.com) - and
      switch the env secret to THAT subscription's shared_key.
   b. [x] **Nightly-sync pinger rewired** (4bcd4a1a): `.github/workflows/
      nightly-sync.yml` schedules 06:00 + 07:00 UTC (= 2 AM ET across DST)
      against TARGET=https://test-app.gostork.com. [ ] ERAN: the repo secret
      `NIGHTLY_SYNC_SECRET` must be set to the PROD host value - gh CLI and
      the Chrome GitHub session are not repo admins. Value is in
      `~/.gostork-prod-pinger-secret` on the MacBook (`pbcopy <
      ~/.gostork-prod-pinger-secret`), add at
      https://github.com/GoStork/concierge/settings/secrets/actions as the
      `gostorky` admin. Until then the nightly job fails loudly with
      "secret not set" (and prod has no scraper configs yet anyway).
   c. [ ] OAuth redirect URIs - Google OAuth client lives in GCP project
      `gen-lang-client-0051391254` (client id prefix 1053367727632):
      add `https://test-app.gostork.com/api/calendar/google/callback` and
      `https://app.gostork.com/api/calendar/google/callback` at
      https://console.cloud.google.com/auth/clients?project=gen-lang-client-0051391254
      (blocked on a passkey re-auth in Chrome at the time of writing).
      Microsoft: add `https://test-app.gostork.com/api/calendar/microsoft/callback`
      + the app.gostork.com twin in the Azure app registration
      (MICROSOFT_CLIENT_ID in .env) > Authentication > Web redirect URIs.
   d. [ ] Smoke tests (section 12) once Eran has signed up on test-app and
      been promoted to admin.
   Note: `systemctl restart gostork` = ~10s of 502 at the edge (seen when
   setting the PandaDoc secret). Fine for beta; a zero-downtime restart
   (second port + Caddy upstream switch) is a later improvement.

Useful context for the executing session:
- PandaDoc subscription uuids: production (deactivated)
  2d18c09a-e107-4ad4-9b0b-799e8dd3dd5c; iMac dev
  5161bc69-39b8-4ab9-afc9-7d1e74150c66; MacBook dev targets gostork.ngrok.app;
  Replit sub a627a0ed-... deactivated. List via
  GET https://api.pandadoc.com/public/v1/webhook-subscriptions (API-Key auth).
- The A2P/Twilio cutover is INDEPENDENT and waits for VERIFIED (section 4);
  the `twilio-a2p-campaign-watch` scheduled task runs on the iMac at 7am.
- Dev DB (source for the seeder): Supabase `bryzqwfzvgjenijciwaa`.

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

- [x] Provision the production Supabase project - DONE 2026-08-18: id
  `itlnituvybtnzmrzbkoz` (us-east-1, PG 17). Org is on the Pro tier ($10/mo
  project) which includes daily backups; [ ] decide on the PITR add-on before
  real families are on it (section 11 Phase A step 1).
- [x] Apply the full schema - DONE 2026-08-18, but NOT via `migrate deploy`
  (see 0.5 for why): DDL from `prisma migrate diff --from-empty
  --to-schema`, plus dev's raw-SQL indexes, plus a `_prisma_migrations`
  baseline of all 160 dirs so future `migrate deploy` is incremental.
  Parity with dev verified (tables/columns/PK/FK/indexes).
- [x] **Content seeding plan - DONE 2026-08-18 (see 0.5 for counts + FK sweep).** Original scope: Production starts with no
  users, but the PLATFORM CONTENT must come over from dev. Inventory to copy
  (script it, don't hand-copy): SiteSettings + BrandTemplate (brand),
  ConciergePromptSection (AI prompts - DB is source of truth), Matchmaker
  personas, ProviderType seed rows, Provider orgs + services + cost sheets +
  templates that are real (not test), donor/surrogate profiles + photos,
  knowledge base (KnowledgeChunk/ExpertGuidanceRule + pgvector data), CDC
  datasets, GoStork house provider (GOSTORK_PROVIDER_ID env must match the new
  row id). Explicitly EXCLUDE: test users, test parents, 555-01xx phones,
  chat sessions, notifications, bookings.
- [x] pgvector extension enabled on the new project (2026-08-18; `vector`
  and `pg_trgm` in schema `public` to match dev, HNSW indexes pre-created).
- [ ] Decide provider/staff account migration: real provider logins (e.g.
  Eggspecting staff) must exist in prod - re-invite vs. copy with password
  hashes.
- [ ] Production `DATABASE_URL` (+ session store - connect-pg-simple uses the
  same DB) into the prod env only. Dev Macs keep pointing at the dev project.
- [x] Supabase MCP: ops sessions must target the right project per environment -
  `bryzqwfzvgjenijciwaa` = DEV, `itlnituvybtnzmrzbkoz` = PROD. Both are
  visible to the same MCP from 2026-08-18, so the "which DB am I touching"
  warning was added to CLAUDE.md the same day (not deferred to cutover).
- [ ] Nightly donor-scraper sync: decide target - production pinger writes to
  prod DB; dev scraping stays on dev. Photos/GCS paths must resolve in both.
- [ ] Re-apply the `smsNotificationsOptIn` grandfather intent for any migrated
  users (2026-08-18 dev state: 43/43 with phones opted in).

## 4. Twilio / SMS (A2P 10DLC)

**PARKED UNTIL LAUNCH (decided 2026-08-19). The Standard campaign has now been
rejected THREE times and cannot be approved before the new product is actually
serving app.gostork.com.** Rejections: 30909 (CTA not found, Aug 13), 30923
(consent was a required condition, Aug 17 - fixed by splitting the OTP notice
from an optional unticked notifications opt-in), then **30909 AGAIN on Aug 19**
- CTA not verifiable. The consent split worked; the blocker is that the
campaign's declared message-flow URL `https://app.gostork.com` still serves the
OLD 1.0 product, which has no SMS disclosure anywhere (re-verified Aug 19: HTTP
200, EventSoft markup, zero hits for "data rates" / "verification code" /
"STOP"). A reviewer following the declared URL finds no CTA, so the submission
fails no matter how good the WordPress evidence page is. Eran cannot edit the
old signup page, so this is genuinely unfixable until the flip. Declaring
www.gostork.com/sms-consent instead was considered and rejected - it is a static
disclosure page, not a signup flow, and would likely draw the same 30909.

Nothing is broken meanwhile: live SMS still runs on the sole-prop campaign
CX4XS4N via service MGa6b8064464ed2c6cdd94fe2848d70255 (holds both numbers), and
`TWILIO_MESSAGING_SERVICE_SID` still points at MGa6b8... Brand
BN6108e1d38e5bcc6736eddd453978e389 stays APPROVED and needs no rework. The daily
watcher `twilio-a2p-campaign-watch` was PAUSED on 2026-08-19; nobody is polling.

**LAUNCH-DAY SEQUENCE (this section is now Phase B work, not pre-launch):**

- [ ] AFTER app.gostork.com serves the new product (Phase B flip), confirm the
  live signup phone step really does show `<SmsTransactionalNotice />` + the
  unticked `<SmsNotificationsOptIn />` checkbox, and that signup completes with
  the box unticked (if declining ever blocks Verify we are back on 30923).
- [ ] THEN resubmit the campaign (compliance SID
  QE2c6890da8086d771620e9b13fadeba0b, TCR CM00284c7c0bed7dca7c70129accbee03f,
  on service MG6c4e651e006fe5b8a47523b244db96cd). The declared flow URL and the
  stored message_flow already describe exactly what will then be live - no edit
  needed, just resubmit. Re-enable / recreate the `twilio-a2p-campaign-watch`
  daily watcher at that point.
- [ ] Do NOT resubmit before the flip. Two of three rejections died on this
  exact URL mismatch; resubmitting unchanged is the loop.

Cutover happens ONLY after the campaign shows VERIFIED. Then, in ONE sitting,
in this order:

- [ ] Move +12058962077 from sole-prop service MGa6b8064464ed2c6cdd94fe2848d70255
  into MG6c4e651e006fe5b8a47523b244db96cd (a number lives in exactly one
  service - this is the cutover moment).
- [ ] Flip `TWILIO_MESSAGING_SERVICE_SID` to MG6c4e... in every non-passive env
  (at launch: the production host; pre-launch: both Macs).
- [ ] Rebuild/restart affected hosts; send one real test SMS; confirm delivery.
- [ ] Delete the old sole-prop campaign CX4XS4N and its brand.
- [ ] Delete the `twilio-a2p-campaign-watch` scheduled task once done.
- [ ] The campaign's declared flow URL is already https://app.gostork.com -
  keep it that way. Post-flip that URL is finally TRUE, which is the whole
  reason the resubmission can succeed then and could not succeed before.
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
   - Repointing is a DNS-only change: the 1.0 test VM (`34.46.187.88`), its
     files and its DB are NOT touched or overwritten - 2.0 runs on a separate
     host with the fresh prod Supabase. The 1.0 test instance simply stops
     receiving traffic for that hostname.
   - [ ] BEFORE repointing: confirm nobody (QA, provider demos, the 1.0 team)
     still uses 1.0's test-app. If someone does, park it first on a new
     record (e.g. `test-old.gostork.com` -> `34.46.187.88`, proxied) so it
     stays reachable until the 1.0 decommission (section 1).
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
