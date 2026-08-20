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
  - A2P note: ~~the campaign declares app.gostork.com as the flow URL; beta
    signups happen on test-app with identical consent UI. Substance matches;
    the declared URL is the permanent home. Acceptable - do not re-file.~~
    **SUPERSEDED 2026-08-19 by the third rejection (30909).** The reviewer does
    follow the declared URL, and finding 1.0 there (or a Cloudflare challenge)
    is what fails the submission. "Substance matches" is not enough. The
    resubmit therefore belongs at the FINAL flip, not at beta start - see
    section 4.

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
   [x] Lock-file lesson (twice): `npm ci` failed on the host because
   `bufferutil` (optionalDependency, native, no macOS prebuilt) is dropped
   from package-lock.json whenever a Mac regenerates the lock - it came back
   in the iMac's 2aa52584 right after eec37dcb fixed it. Root fix f7e38633:
   bufferutil REMOVED from package.json (unreferenced; only an optional `ws`
   accelerator). Rule: never add an optionalDependency with a native build
   that a Mac cannot install - the lock will drift and prod `npm ci` breaks.
   [x] Deploy-script lesson: the first failed build left git HEAD at the new
   sha, so every later timer tick saw "up to date" and the failure stuck
   silently for 20+ min. `gostork-deploy` now compares origin/main to a
   last-SUCCESSFUL-deploy marker (`/srv/gostork/.deploy-state`), logs WARN
   with the failing step + npm output, and retries after 15 min or on the
   next push. Source of truth for the script: `deploy/gostork-deploy.sh` in
   the repo (see deploy/README.md for the reinstall command).
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
   c. [x] **Google OAuth** (client "GoStork Calendar" in GCP project
      `gen-lang-client-0051391254`, 2026-08-19): added redirect URI
      `https://test-app.gostork.com/api/calendar/google/callback`
      (app.gostork.com, gostork.com, both ngrok hosts and Replit were
      already there). **Publishing status flipped Testing -> In production**
      (it was Testing with 3 Gmail test users = only they could connect
      and tokens died every 7 days). Google now says the app "requires
      verification" because calendar scopes are sensitive: until verified,
      connecting users see an "unverified app" interstitial and the project
      has a 100-user LIFETIME cap. -> section 7 item added.
      [x] **Microsoft** app registration "GoStork Calendar"
      (42cdb0fb-1332-4c65-8904-3f654954560a, tenant gostork075.onmicrosoft.com,
      sign in as eran.amir@gostork075.onmicrosoft.com): added Web redirect
      URIs `https://test-app.gostork.com/api/calendar/microsoft/callback`
      AND `https://app.gostork.com/api/calendar/microsoft/callback` -
      the pre-existing app.gostork.com/gostork.com entries used the OLD 1.0
      path `/api/microsoft/callback`, which 2.0 does not serve, so Outlook
      connect on app.gostork.com would have failed at the Phase B flip.
      (Dev ngrok hosts are NOT registered for Microsoft - only the old
      Replit dev URL is - so Outlook connect has not been testable on the
      Macs; test it on test-app.)
   d. [~] Smoke tests (section 12) 2026-08-19: PASSED signup/OTP, admin
      pages, Eva chat, Google + Outlook connect, booking end-to-end with
      email/SMS/Google event, SSE. REMAINING: provider-side W-9/agreement
      via PandaDoc (needs a provider user + a real sign - watch
      /api/webhooks/pandadoc on prod), payments (needs live Stripe keys),
      email visual check, cancel/reschedule, untick-SMS signup variant,
      provider assistant Eva. Started: Eran signed up on
      test-app (account created 09:56 UTC; the form's second submit showed
      "already exists" - first click had succeeded, minor UX rough edge),
      promoted to GOSTORK_ADMIN + providerId = GoStork house provider via
      MCP. **First login failed with 500 "Login session error"**: root cause
      = connect-pg-simple `createTableIfMissing` looks for its `table.sql`
      next to the bundle (`/srv/gostork/app/dist/table.sql`, ENOENT) - dev
      never hit it because the dev DB already had `session`. Fixed for
      good with migration `20260819_session_table` (CREATE TABLE IF NOT
      EXISTS "session" ...), applied to prod immediately via MCP too.
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
(It was found still ENABLED and firing daily on 2026-08-19 despite this note -
actually disabled that day. Re-enable it at resubmit time, not before.)

**LAUNCH-DAY SEQUENCE (this section is now Phase B work, not pre-launch):**

- [ ] AFTER app.gostork.com serves the new product (Phase B flip), confirm the
  live signup phone step really does show `<SmsTransactionalNotice />` + the
  unticked `<SmsNotificationsOptIn />` checkbox, and that signup completes with
  the box unticked (if declining ever blocks Verify we are back on 30923).
- [ ] THEN resubmit the campaign (compliance SID
  QE2c6890da8086d771620e9b13fadeba0b, TCR CM00284c7c0bed7dca7c70129accbee03f,
  on service MG6c4e651e006fe5b8a47523b244db96cd). The declared flow URL stays
  https://app.gostork.com and is correct. **The stored message_flow is NOT
  correct any more** - it quotes the long pre-2026-08-19 consent wording
  verbatim, and the shipped UI now carries the shortened wording (commit
  cf98c2bd). Editing that field to match is a REQUIRED step of the resubmit,
  not an optional one; submitting the stale text guarantees a fourth rejection,
  because the quoted copy will not match what the reviewer sees on screen.
  Re-enable / recreate the `twilio-a2p-campaign-watch` daily watcher at that
  point.
- [ ] Same resubmit sitting: confirm WordPress page 5461 quotes the SHORTENED
  wording and shows the SHORTENED screenshot. Source of truth for both strings
  is `client/src/components/ui/sms-consent-disclosure.tsx`; copy from there, do
  not retype.
- [ ] Timing nuance vs section 0's staged launch: the resubmit belongs at the
  FINAL flip (app.gostork.com -> new origin), NOT at beta start. During beta,
  app.gostork.com still serves 1.0 while beta signups run on test-app, so the
  declared URL is still untrue and the 30909 loop repeats. This supersedes the
  "Acceptable - do not re-file" A2P note in section 0, which was written before
  the Aug 19 rejection proved the reviewer does follow the declared URL.
- [ ] Cloudflare, found 2026-08-19: `https://app.gostork.com/onboarding` returns
  **403 with `cf-mitigated: challenge`** to a plain client. Even after the flip,
  an automated vetter hitting the declared URL can be served a challenge page
  instead of the signup step - a second, independent cause of "CTA could not be
  verified". Before resubmitting, exempt the signup path from Bot Fight
  Mode / managed challenge (or verify a clean anonymous fetch reaches the phone
  step) and re-check with `curl -sI`.
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
- [x] **DONE 2026-08-19.** Brand data hygiene: dev `SiteSettings.companyName` was stored as
  `'GoStork '` with a TRAILING SPACE, which every `{brandName}` interpolation
  inherited. Invisible in HTML until the shortened consent copy put a period
  straight after it ("from GoStork . Optional."). Fixed in dev on 2026-08-19
  (`SiteSettings` + all three `BrandTemplate.config` rows btrim'd). **Check the
  PRODUCTION Supabase project (itlnituvybtnzmrzbkoz) for the same trailing
  space and btrim it before launch** - otherwise the carrier-facing consent
  string renders wrong on the very page the reviewer inspects.
  PROD was checked the same day and DID have it, on `SiteSettings` and all
  three `BrandTemplate` rows. Eran ran the btrim UPDATE in the Supabase SQL
  editor; test-app.gostork.com picked it up with NO restart (brand settings are
  read per request, not cached at boot). Verified by rendering the live
  test-app phone step: both consent strings now read correctly and match
  WordPress 5461 word-for-word.

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

- [x] Google OAuth client: app.gostork.com + test-app redirect URIs present;
  publishing status = In production since 2026-08-19 (was Testing).
- [ ] **Google OAuth app verification** (sensitive calendar scopes):
  submit at https://console.cloud.google.com/auth/verification?project=gen-lang-client-0051391254
  - needs homepage, privacy policy URL, scope justification, possibly a
  demo video. Until approved: "unverified app" warning on connect + 100
  users lifetime cap (3 used). Do this early in the beta - review takes
  days to weeks.
- [x] Microsoft Graph app registration: test-app + app.gostork.com redirect URIs with the 2.0 path added 2026-08-19.
- [ ] Apple/CalDAV: no redirect URIs, but verify app-specific password flow
  documentation for users.
- [ ] Reconnect flows tested against the production URL (calendar-health emails
  link users to APP_URL).

## 8. Payments (Stripe)

Decision 2026-08-19 (Eran): test-app IS production-in-waiting, so Stripe
goes LIVE now (not sandbox) - see docs/go-live-checklist.md for the recipe.
State 2026-08-19 (live account acct_1TYZ1aCGqwxDjN6V, done in Eran's Chrome):
- [x] Live account activated (Account status: no tasks; Payments, Payouts,
  Transfers, ACH all Active). Payout schedule already **Manual**.
- [x] Live webhook destinations created (API 2026-04-22.dahlia):
  `gostork-2-main-billing` we_1U67fGCGqwxDjN6VLCLn2AqY -> 
  https://test-app.gostork.com/api/webhooks/stripe (Your account, 8
  events) **Active**; `gostork-2-connect` we_1U67iLCGqwxDjN6VGNbnHZCI ->
  https://test-app.gostork.com/api/webhooks/stripe-connect (Connected
  accounts, 3 events: account.updated, payout.paid, payout.failed) -
  **Requires setup** until Connect platform onboarding completes. Stripe
  no longer offers `account.application.deauthorized` on a Connected-
  accounts destination (platform-level event) - if needed, add it to the
  main destination (handler lives in connect.controller; verify routing).
  Both routes answered 400 (signature rejected) unsigned through
  Cloudflare before creation, per the checklist.
- [ ] ERAN: **Connect platform onboarding is INCOMPLETE on live**
  (Settings > Connect > Platform profile shows "Onboarding incomplete" +
  two acknowledgements: refunds/chargebacks liability, ongoing seller
  compliance). Without it NO provider payouts in live. Complete at
  https://dashboard.stripe.com/acct_1TYZ1aCGqwxDjN6V/settings/connect/platform-profile
  ("View onboarding" + both "Acknowledge"). Found because the live account
  had never been a Connect platform (sandbox was).
- [x] **LIVE KEYS INSTALLED 2026-08-19**: Eran revealed the live secret
  key (one-time reveal, created May 18, first use today) + publishable key
  + both signing secrets into `~/.gostork-stripe-live.env` on the MacBook;
  Claude installed STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY /
  VITE_STRIPE_PUBLISHABLE_KEY / STRIPE_WEBHOOK_SECRET /
  STRIPE_CONNECT_WEBHOOK_SECRET into the host .env, `gostork-deploy
  --force` rebuilt the client (pk_live_ confirmed in the served bundle),
  restarted clean. Live mode has no "send test event", so verified with a
  synthetic event signed with the installed secrets (Stripe's
  generateTestHeaderString) POSTed to both routes on the host: 200
  {received:true} signed, 400 with a bad signature - secrets match.
  Refunds/chargebacks liability acknowledgement: Completed. "Ongoing
  seller compliance" acknowledgement: Completed 2026-08-19 (Settings >
  Connect > Platform profile). Platform "Confirm your integration
  choices" done 2026-08-19 (Connected accounts page > Setup guide > Go
  live; the legacy "View onboarding" button is a dead end): business
  model = Marketplace (buyers pay GoStork, sellers paid individually),
  Stripe-hosted onboarding, Express dashboard, GoStork liable for
  refunds/chargebacks - all matching stripe-service.ts `controller`
  params; Eran accepted the Connect Platform Agreement. Stripe emailed
  "Your Connect application is approved"; the gostork-2-connect webhook
  flipped Requires setup -> Active. First live connected account NOT yet
  created: the Express start from /account/payouts now passes the
  platform gate but live KYC rejects the test agency's dummy EIN
  (00-0000000) and .example.com URL (fixed to gostork.com) - we do not
  fabricate tax IDs on live Stripe. DECISION 2026-08-19 (Eran): do NOT
  create a GoStork-as-its-own-provider connected account to fake this;
  the proof is the first real provider.
  [ ] **LAUNCH TASK - first real provider Connect onboarding**: pick a
  friendly agency as the beta provider; they complete Express onboarding
  from /account/payouts with their real EIN + bank; then run ONE token
  invoice ($5) end-to-end with Eran watching: invoice PAID -> auto
  transfer (stripeTransferId) -> Connect payout -> money lands in their
  bank; confirm the connected-account webhooks (account.updated,
  payout.*) reach gostork-2-connect; then refund that invoice and verify
  the transfer reversal (the clawback path never ran in testing). Only
  after this is green do real invoices start.
  [ ] **INTERNATIONAL PROVIDERS (Mexico, Colombia, ...) - before the first
  non-US payout** (raised 2026-08-19): the Connect path is US-shaped.
  (a) `stripe-service.ts createConnectAccount` hardcodes account
  `country: "US"` - it must come from the provider's legal country
  (ProviderLegalIdentity.businessAddressCountry / a new country field);
  (b) VERIFIED against Stripe docs 2026-08-19: Stripe accounts exist in
  46 countries - Mexico YES (normal connected account, RFC collected by
  the hosted form, MXN payout); Colombia NO. Connect cross-border payouts
  only span US/UK/EEA/CA/CH, so a US platform CANNOT pay a Colombian
  connected account ("contact sales"). Stripe Global Payouts reaches
  160+ countries but shifts compliance to us (possible Money Transmitter
  licensing when we hold customers' funds) - lawyer question, not a
  default. So: Colombia + other non-Stripe countries = manual wire (the
  existing fallback) unless sales/legal opens another route; ask Stripe
  sales before launch since LATAM surrogacy is a core market. BUILT
  2026-08-19 (cadc6127 + e68d7035): legal-entity country on the Legal tab
  drives W-9 vs W-8BEN-E (second PandaDoc template set - [ ] ERAN: upload
  the IRS W-8BEN-E PDF in the admin Legal page), local tax-ID label, the
  invoice guardrail, the Stripe account country (recipient service
  agreement for non-US, EIN pre-filled only for US, in-app bank form
  US-only), the Payouts page rail (Stripe vs "international payouts" card
  for MX/CO/UA/GE/...), and a USD-invoice + local-currency payout estimate
  (open.er-api.com, display only). Verified live: a CY entity created a
  real connected account (acct_1U6GTfFmrxto5Gu4, deleted after the test)
  and reached Stripe-hosted Express onboarding; MX shows the international
  card. International rail = Trolley (decided 2026-08-19, manual Chase
  step dropped) - BUILT 2026-08-20 (82a2e852..): trolley.client (prsign
  auth, signed widget URL, batches/payments, webhook signature t=..,v1=..
  HMAC), TrolleyService (recipient ensure by referenceId=providerId,
  readiness sync, invoice payout via one batch), signature-verified
  idempotent webhook (/api/webhooks/trolley, TrolleyWebhookEvent log),
  payout choke point routes payoutMethod=TROLLEY providers to Trolley,
  Payouts page embeds the widget (brand-colored) with readiness tiles.
  SANDBOX config: keys in ~/.gostork-trolley-sandbox.env + host .env
  (TROLLEY_ACCESS_KEY/SECRET_KEY/WEBHOOK_SECRET); webhook registered All
  Models/All Actions -> test-app, VALID+ENABLED. VERIFIED END-TO-END in
  sandbox on prod code: MX test agency onboarded in the embedded widget
  (Trolley enforced real KYC: valid RFC checksum required, CLABE, SWIFT
  lookup -> BBVA Mexico), recipient active, webhooks
  recipient/recipientAccount processed, Payouts page flipped to
  "Payouts are enabled" (MXN); invoice marked PAID (wire path) -> payout
  sweep adopted it -> Trolley batch/payment created (first attempt failed
  honestly on $0 sandbox balance -> added $100 sandbox funds) -> after two
  resume fixes (re-kick an open/pending batch whose start-processing had
  failed; the already-transferred guard had to move BELOW the rail switch)
  the 00:00 UTC sweep re-kicked the batch and Trolley's payment.processed
  webhook stamped payoutCompletedAt 38s later (payment
  P-H4YqMbgfoPYcA1C578rhkX, batch processed/completed webhooks logged).
  **TROLLEY SANDBOX PAYOUT E2E: PASS** - onboarding widget -> readiness
  webhooks -> invoice PAID -> batch payout -> processed -> stamps.
  GOTCHAS: esbuild strips decorator metadata (every Nest injection must
  be explicit @Inject); Trolley sandbox+live share api.trolley.com (keys
  decide); widget URL signature valid ~30s (mint on click).
  [~] Trolley LIVE activation: business profile SUBMITTED + APPROVED for
  PayPal & Check payouts 2026-08-20 (Eran; countries declared: MX, CO, CY,
  GE). [ ] ERAN: complete the "Bank Transfer Onboarding Form" (yellow
  "Activate Bank Transfer" banner) - bank transfers are the rail we use.
  [ ] AT LAUNCH: create LIVE API keys + webhook
  (same URL) and replace the sandbox values in the host .env; fund the
  Trolley balance (auto-topup or manual) since payouts draw from it;
  decide recipient-pays-fees in Trolley settings (Eran: fees come out of
  the provider's share); DECISION (Eran 2026-08-20): stay on Pay
  Standard ONLY ($199.92/mo, the minimum for bank transfers) - Tax
  (+$200/mo), Sync (+$100/mo) and Trust (+$100/mo) modules stay OFF; the
  PandaDoc W-8BEN-E flow is the tax path (widget now requests products=pay
  only), year-end 1042-S filing goes to the accountant. PARKED (Eran 2026-08-20, option 1):
  ride the free trial until ~2026-09-19; if no international provider has
  signed by then, LET THE SUBSCRIPTION LAPSE (do not add a card) and
  re-subscribe the week the first international provider signs - the
  integration, sandbox keys and webhook config all keep working, only
  live payouts need the paid plan. Alternatives evaluated and declined
  for now: Wise Business API ($0/mo but GoStork would build/store bank
  details + do recipient diligence), Stripe Global Payouts (usage-priced
  but money-transmitter/compliance question), PayPal/Payoneer/Airwallex
  (recipient-account or build-it-yourself caveats). Cost levers if kept:
  yearly billing discount ("Switch to yearly billing").
  ESCAPE HATCH (Eran 2026-08-20): the Payouts page's "I have a US legal
  entity" checkbox (ProviderLegalIdentity.usPayoutEntity) lets a foreign
  operator with a US entity take the full US path - Stripe + US bank +
  W-9/EIN - the effective country flips via effectivePayoutCountry() in
  every payout/tax code path; blocked while a payout method is live on
  the other rail. VERIFIED (2026-08-20, Claude Chat cross-check): Stripe's
  connect/accounts availability list DOES include CO/CY/MX (GE absent)
  BUT the cross-border-payouts page limits self-serve transfers to
  US/UK/EEA/CA/CH and states recipient-service-agreement accounts cannot
  receive Connect cross-border payouts at all - so a US platform still
  cannot pay CO/MX connected accounts; the availability list is about
  where accounts can EXIST, not who can pay them. Trolley stays required.
  RULE (Eran 2026-08-20): US entities =
  Stripe Connect, ALL non-US entities = Trolley, even Stripe-reachable
  countries like Cyprus/Canada/UK - one international flow. Old item (c) the invoice guardrail demands a Tax ID and the Legal
  tab is built around the W-9 - foreign entities have no EIN and file a
  W-8BEN-E, no 1099; ask the accountant about withholding; (d) show
  payout currency/FX to the provider. UNTIL BUILT: international
  providers still work on GoStork - the transfer simply has no Connect
  account, `notifyAdminTransferFailed` fires and the payout is a manual
  wire (how 1.0 paid them). Live charge + refund: done
  twice (section 12). Note: the two $5 refunds left the live balance
  slightly negative ("Add funds to cover your negative balance" banner) -
  Stripe recoups from the next payment; no action needed.
- [ ] Phase B: repoint both destinations to app.gostork.com (or add a
  second pair) - the description on each says so.
- [ ] Stripe Connect (provider payouts) redirect/return URLs on production
  domain - verify after Connect onboarding; the app builds them from
  APP_URL.
- [ ] Cloudflare: `/api/webhooks/*` WAF skip + cache bypass (section 1)
  before the first real payment.

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

0. **GATE PRODUCTION DEPLOYS (pre-req, Eran's rule 2026-08-19):** today the
   VM's `gostork-deploy` timer tracks `origin/main`, so EVERY push deploys to
   production automatically - fine while prod holds only test data, NOT
   allowed once real families are on it. Before the flip: create a
   `production` branch, point `deploy/gostork-deploy.sh` (and the installed
   `/usr/local/bin/gostork-deploy`) at `origin/production`, and promote
   only by explicit instruction: `git push origin main:production` when
   Eran says "deploy to production" in the conversation, logging what went
   out here. `main` stays the dev branch (both Macs). Amend the CLAUDE.md
   "always push to main" rule to say exactly this so no session bypasses
   it. Code must be tested on dev first; no prod deploy without permission.
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

- [x] Admin pages on production (2026-08-19): /account/concierge shows all
  30 prompt sections, 3 personas, 4 rules, KB docs + 6 prep guides;
  Branding shows "GoStork Teal" active with the GCS logo; concierge monitor
  lists live sessions with the parent profile panel.
- [x] Signup end-to-end on a real phone (2026-08-19, test-app): Turnstile
  passed on the new hostname, OTP SMS sent via Twilio Verify (OtpAttempt
  outcome=sent x2), account created with phone + smsNotificationsOptIn=true,
  trustState TRUSTED (eran.amir@gostork.com = admin, eran.amir+beta1 = test
  parent). UNTICKED variant (eran.amir+beta2, 2026-08-19): phone verified,
  smsNotificationsOptIn=false, TRUSTED, zero SMS Notification rows. PASS.
  Observed rough edges:
  signup form double-submit shows "already exists" after a successful
  first submit; login page shows "Invalid email or password" for a server
  500 (should say "something went wrong"). Note: editing the phone on
  /account does NOT re-verify via OTP (by design today - only signup does).
- [x] Booking flow (2026-08-19, public page /book/eran-amir, booker =
  beta1 parent): Booking created PENDING -> Daily.co room provisioned ->
  parent "submitted" email+SMS, provider "new request" email+SMS (all
  Notification rows status=sent, bodyHtml stored, every link ->
  test-app.gostork.com) -> live SSE toast in the provider session ->
  provider Confirm -> CONFIRMED, Google Calendar event created
  (googleEventId set), confirmation email+SMS to both sides, 24h/1h
  reminders queued pending. The in-24h "Action needed soon" urgent nudge
  fired immediately (meeting was <24h away - by design). Reschedule +
  cancel (2026-08-19, admin calendar): Reschedule -> old booking
  RESCHEDULED, new PENDING booking with its own Google event, reschedule
  email+SMS to the parent + email to the host; host Confirm -> CONFIRMED,
  confirmation email+SMS both sides, reminders queued; Cancel Booking ->
  CANCELLED, cancellation email+SMS to parent + email to host, the queued
  reminders stay "pending" but the sender skips CANCELLED/RESCHEDULED
  bookings (notification.service ~L2008). PASS. Observed: after a HOST
  reschedule the new PENDING slot shows in the host's own Pending list
  with Confirm/Decline - the host proposed it, so the parent should be the
  one confirming; review that flow. Email visuals checked in the inbox
  2026-08-19 (cancelled / confirmed / rescheduled / receipts): teal header
  + logo + brand buttons correct. Follow-up shipped: provider/GoStork-facing
  parent emails now carry name + "View profile" link into /parents/:id,
  email + phone (GoStork hosts always; outside providers per Gate B), and
  the admin commitment alert got full detail rows.
- [~] Provider side (2026-08-19): test org "Beta Test Surrogacy Agency"
  (3650c7cb-457c-4431-9565-0c5e5857758e) + PROVIDER_ADMIN
  eran.amir+agency1@gostork.com created via admin UI; provider login OK,
  /provider/home renders (work queue, payouts, funnel), pinned Eva (Ariel)
  present. W-9: "Fill out W-9" -> PandaDoc doc e5uZG3K4EZLwV8PMpKsHdT
  created from the template, sent, signing session issued
  (`POST /api/provider/w9/fill 201`, ProviderW9 4e903a3e... SENT), and the
  STAGING WEBHOOK DELIVERED document_state_changed events to test-app
  through Cloudflare (first events pre-date the W-9 row - expected, the
  poller covers creation). Signed in Chrome with dummy data ->
  `recipient_completed` webhook hit prod -> ProviderW9 COMPLETED ->
  Legal Identity auto-filled (8 fields, source W9_AUTO_FILL) -> Legal tab
  shows "Completed 8/19/2026" + download. **W-9 chain PASS end-to-end on
  production.** Parent Agreement flow (2026-08-19): test agency pointed at
  the dev surrogacy-contract PandaDoc template (5MPnGNZocnjJhcU3i9E5yA,
  role Client - same PandaDoc account serves both envs); 2nd $5 invoice
  paid -> auto-draft fired -> `agreement_draft_approval` card -> agency
  Approve & Send -> Agreement SENT (PandaDoc mUMSeP6rsunWtKacwcYwoF),
  parent "ready to sign" email+SMS -> Eran signed in PandaDoc ->
  `recipient_completed` webhook -> SIGNED, signed-PDF card, kickoff
  message, ladder to Handed Off; "Agreement signed" emails to agency +
  admin commitment alert. **Agreement chain PASS on production.** [ ]
  ProviderAgreement (GoStork <-> provider contract) not yet exercised on
  prod. Note: as a PROVIDER_ADMIN,
  /home shows the PARENT home ("Welcome back, Agency", a journey card)
  while the nav Home goes to /provider/home - routing quirk to fix.
- [x] Nightly-sync pinger: repo secret updated to the prod value (it
  existed from the Replit era); manual workflow_dispatch -> 202 "Nightly
  sync started" on test-app -> server ran (0 configs) -> complete.
- [x] AI concierge chat on production URL (2026-08-19): Eva (Adam persona)
  greeted the beta1 parent with the onboarding-aware opener and answered the
  first message in 1.5s with a rich card - Gemini + MCP + prompt assembly
  + SSE streaming through Cloudflare all good. [ ] provider assistant
  (pinned Eva) still to try once a provider user exists.
- [x] Calendar connect (2026-08-19): Google connected (tokens + refresh,
  events syncing - busy dots on the calendar) and Outlook connected
  (Graph calendar list -> "Calendar" selected) for eran.amir@gostork.com on
  test-app. Found + fixed: admin opening their OWN Team Calendars row was
  mounted in for-another-user mode, hiding the Connect button (4f25f196).
  Remaining quirk: the OAuth callback for a GOSTORK_ADMIN lands on the Team
  Calendars list instead of the owner's row, so the "pick calendars" dialog
  only opens after clicking your row again (normal providers are not
  affected - they land on their own settings). Microsoft consent shows
  "unverified" publisher -> [ ] Microsoft Partner Center publisher
  verification, same class as the Google verification item (section 7).
  [ ] reconnect email -> links to the production URL: not yet exercised.
- [~] Payment link end-to-end in LIVE mode (2026-08-19): agency sent a $5
  cost sheet, then an invoice from the chat (+ -> Invoice; blocked first by
  the Legal Identity guardrail until Tax ID + business URL were set on the
  test agency - correct behaviour). Invoice a6cfdf69 AWAITING_PAYMENT,
  referral fee 10% -> GoStork keeps $0.50 / provider $4.50. Pay page
  /pay/<token> minted a LIVE PaymentIntent (client bundle carries pk_live,
  server sk_live). Eran paid $5 with a real card in Safari -> Stripe
  `payment_intent.succeeded` reached the VM through Cloudflare -> Invoice
  PAID (paymentMethod CARD, pi_3U68bECGqwxDjN6V1Zx2D0mu), parent
  journey stage -> "Deposit Paid". Agreement auto-draft skipped (test
  agency has no agreement template - expected). Refund: admin Billing tab
  -> Refund $5 proportional -> Stripe refund created -> `charge.refunded`
  webhook -> Invoice REFUNDED (refundedAmount 500, reason + notes
  stored), parent card "Your payment has been fully refunded", lead status
  back to "Invoice Sent" (a refunded invoice no longer counts as paid -
  by design). **Live charge + refund PASS.** FOUND + FIXED: the
  `charge.refunded` payload on the current API version does not embed
  `charge.refunds`, so `stripeRefundId` stayed NULL and the refundMode
  metadata was lost (a keep_platform_fee refund would have been clawed
  back proportionally). Webhook handler now fetches the latest refund from
  Stripe when the payload lacks it. No provider transfer existed yet on
  this invoice (agency has no Connect account), so the clawback path was
  not exercised - [ ] re-test refund after the first real Connect payout.
  2nd charge+refund (agreement test, 13:40 UTC): refundRequestedAt ->
  refundedAt 1s apart, stripeRefundId re_3U69Qj... recorded - the
  charge.refunds fix verified live.
  Follow-up shipped same day (2b999765): the journey ladder now has a
  two-step refund BRANCH hanging off "Invoice Paid" (Refund Requested ->
  Refund Completed, like No Show off the call), `Invoice.refundRequestedAt`
  stamped by the admin refund endpoint, and the Match Status badge/filter
  carry both values. Verified on prod: parent record ladder + Parents table.
  Also found in the agency's chat after the refund: the system message
  showed the PARENT wording ("Your payment has been fully refunded") to the
  provider and the invoice card still said "Paid / Payment complete" -
  fixed (providerContent + card status/refundedAmount stamped by the
  charge.refunded handler; today's prod rows patched by hand).
- [x] Provider-assistant Eva (Ariel) on prod (2026-08-19): agency asked
  "What needs my attention today?" -> answered in seconds from real
  pipeline data (no pending whispers, no upcoming calls, the Eran Amir
  consultation thread). PASS.
- [ ] LEFTOVER 1.0 TRAFFIC on test-app: something polls
  `GET /api/v1/surrogates/list-to-update?agencyName=familycreations` every
  ~30 s (404 on 2.0). A 1.0 scraper/cron still targets the test hostname -
  find it in the 1.0 stack (GKE cronjobs / GitLab CI schedules) and stop
  it before the app.gostork.com flip, otherwise the same job will hammer
  production with 404s (or worse, hit a real 2.0 route).
- [x] SSE in-app notifications arrive through Cloudflare (2026-08-19: the
  "New meeting request" toast appeared live in the admin tab).
- [ ] Verify NO emails/SMS originate from dev Macs anymore (Notification rows
  should all carry stored bodyHtml; bodyHtml NULL = stale/rogue sender).

## 13. Rolling additions

(Add dated items here when they don't fit a section above.)

- 2026-08-18: Replit deployment shut down; PASSIVE_MODE=1 pre-staged in its
  Secrets. If Replit becomes the 2.0 production host, REMOVE that secret there
  and push current code (>= 3e0d0397) before publishing.
