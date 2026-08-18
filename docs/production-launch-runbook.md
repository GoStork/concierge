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

- [?] **Where is 1.0 hosted?** What origin does Cloudflare proxy app.gostork.com
  to today? (Not the go-stork.replit.app deployment - that was shut down
  2026-08-18 and 1.0 must be verified still up.)
- [?] **Where does 2.0 production run?** (New Replit deployment / other host.)
  Whatever it is: deployments are snapshots - wire GitHub auto-deploy on push to
  main, or make "republish after push" part of the workflow.
- [?] **Database strategy.** Dev currently runs on Supabase project
  `bryzqwfzvgjenijciwaa` (shared by both Macs). Does 1.0 production have real
  user data in a different DB that must be migrated/merged? Is the current
  Supabase project the intended 2.0 production DB, and if so do we scrub test
  data (test parents, fictional 555-01xx numbers) before launch?
- [?] **Launch style.** Big-bang DNS swap vs. staged beta (e.g. beta subdomain
  first). Downtime tolerance?
- [?] **What do the dev Macs become after launch?** If they stay on the
  production DB they are zombie-environment risks (exactly the Replit incident
  of 2026-08-18). Options: set PASSIVE_MODE=1 on both Macs post-launch, or move
  dev to a separate DB. Decide before launch day.

## 1. Domain & Cloudflare

- [ ] Point app.gostork.com origin at the 2.0 production host (keep orange-cloud
  proxy).
- [ ] **WAF/bot-challenge bypass for machine endpoints** - verified 2026-08-18
  that Cloudflare currently serves `cf-mitigated: challenge` to non-browser
  requests. Without bypass rules, ALL inbound webhooks die silently. Create
  WAF skip rules for at least:
  - `/api/webhooks/*` (PandaDoc, and any Stripe/Twilio webhook paths)
  - `/api/cron/run-nightly-sync` (external pinger)
- [ ] Cache rules: bypass cache for `/api/*`; ensure SSE
  (in-app notifications stream) is not buffered/cached by Cloudflare.
- [ ] SSL mode Full (strict) against the origin; verify no redirect loops.
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
- [ ] Full secret inventory copied to prod: DATABASE_URL, SESSION secret,
  SENDGRID_API_KEY, TWILIO_* (see SMS section for which SID),
  TWILIO_VERIFY_SERVICE_SID, PANDADOC_API_KEY + PANDADOC_WEBHOOK_SECRET,
  GEMINI_API_KEY, OPENAI_API_KEY, GCS_SERVICE_ACCOUNT_KEY + GCS_BUCKET_NAME,
  Stripe keys (live mode), Daily.co, Google Speech-to-Text, Turnstile secret,
  GOSTORK_PROVIDER_ID.
- [ ] `NODE_ENV=production` and trust-proxy/secure-cookie behavior verified
  behind Cloudflare (session cookies must survive the proxy).
- [ ] Rotate any secrets that lived on the old Replit deployment if it is ever
  deleted-with-history or was shared.

## 3. Database

- [ ] Apply all `prisma/migrations/*` to the production DB (or confirm the
  shared Supabase project already has them - it does as of 2026-08-18 if the
  same project is kept).
- [ ] Scrub/flag test data if the shared DB becomes production (test emails,
  555-01xx fixture phones, test providers).
- [ ] Verify `smsNotificationsOptIn` grandfather state matches intent at launch
  (2026-08-18: 43/43 users with phones opted in).
- [ ] Backups: confirm Supabase PITR/backup tier appropriate for production.

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

## 11. Launch-day sequence (draft - finalize once section 0 is decided)

1. Freeze: no pushes during the window.
2. Production host: deploy current main, full env per section 2, restart.
3. DB: final migration check (and data migration from 1.0 if decided).
4. Cloudflare: flip origin to the 2.0 host; WAF bypass + cache rules live.
5. Reactivate production PandaDoc subscription; verify one signed test doc
   end-to-end.
6. Verify Turnstile, OTP send, login, session persistence through Cloudflare.
7. Repoint nightly-sync pinger; watch one scheduler cycle in prod logs.
8. Set PASSIVE_MODE=1 on both Macs (if that decision stands); restart them.
9. Smoke tests (section 12).
10. Twilio cutover is INDEPENDENT: it happens when the campaign is VERIFIED,
    which may be before or after launch day (section 4).

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
