# GoStork 2.0 Launch Checklist

Pre-flight steps to run **before** pointing `app.gostork.com` at the
v2 deployment. v2 is a greenfield codebase with no shared code, schema,
or data with the currently-live v1 product at `app.gostork.com`; the
cutover is a DNS / domain-mapping swap, not a code or data migration.

Use as a copy-paste runbook on launch day. Tick items off as you go.

---

## Phase 0 — Pre-cutover v2 verification

Confirm v2 is healthy in a non-production environment before the
domain swap.

- [ ] v2 is deployed to a staging URL (e.g. the Replit deployment URL
      `go-stork.replit.app` or a separate staging host) and serving
      traffic successfully against the v2 production database.
- [ ] v2's last commit on `main` is the one you intend to ship. Note
      the SHA so rollback can return to the prior v2 commit if needed.
- [ ] Snapshot the v2 production database (Supabase point-in-time
      recovery or manual `pg_dump`). Keep for ≥ 7 days post-launch.
      Not strictly required since v2 starts effectively empty, but
      cheap insurance for any pre-launch data (admin accounts,
      provider configs, AI prompt edits) you don't want to redo.
- [ ] Inventory v2's production environment variables in a secure
      vault, in case the production host needs to be rebuilt.
- [ ] v1 is a separate product on a separate stack - leave it alone.
      The only thing v1 owns that v2 will take over is the
      `app.gostork.com` DNS record. v1's database, secrets, and
      Stripe account are not touched.

---

## Phase 1 — Stripe live-mode setup

Switch the Stripe Dashboard to **Live mode** (toggle, top-right). Test
mode stays untouched; live and test webhook configs are independent.

### 1.1 API keys

- [ ] Developers → API keys.
- [ ] Reveal `sk_live_...` (secret key) OR create a **Restricted key**
      with these permissions (mirror our dev `rk_test_...` setup):
  - `Charges`: Write
  - `Customers`: Write
  - `PaymentIntents`: Write
  - `Refunds`: Write
  - `Payouts`: Write *(needed for the dev test-payout script; less
      critical in live since Stripe runs the schedule automatically)*
  - `Connect / Accounts`: Write
  - `Connect / External accounts`: Write
  - `Connect / Transfers`: Write
  - `Connect / Transfer reversals`: Write
  - `Balance`: Read
  - `Balance transactions`: Read
  - `Webhook endpoints`: Read *(useful for ad-hoc verification scripts)*
- [ ] Copy `pk_live_...` (publishable key) for the client bundle.

### 1.2 Live webhook destinations

Mirror the test setup exactly so the code paths are unchanged.

- [ ] **Platform webhook**: Developers → Webhooks → Add endpoint
  - URL: `https://app.gostork.com/api/webhooks/stripe`
  - Events from: **Your account**
  - Events: `payment_intent.succeeded`, `payment_intent.processing`,
    `payment_intent.amount_capturable_updated`,
    `payment_intent.canceled`, `payment_intent.payment_failed`,
    `charge.refunded`
  - Copy the signing secret (`whsec_...`)
- [ ] **Connect webhook**: Add another endpoint
  - URL: `https://app.gostork.com/api/webhooks/stripe-connect`
  - Events from: **Connected accounts**
  - Events: `account.updated`,
    `account.application.deauthorized`, `payout.paid`, `payout.failed`
  - Copy the signing secret (`whsec_...`) - this is a DIFFERENT secret
    from the platform webhook above

### 1.3 Production environment variables

Set these in the production env (Replit Secrets, or whatever
production-secrets surface app.gostork.com uses). The variable **names**
are unchanged from dev; only the **values** swap to live equivalents.

Stripe-specific:

```bash
STRIPE_SECRET_KEY=sk_live_...                # or rk_live_... (restricted)
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...              # from the Platform webhook
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...      # from the Connect webhook
VITE_STRIPE_PUBLISHABLE_KEY=pk_live_...      # client bundle reads this too
```

Other env vars to verify are live-production values (not dev):

```bash
DATABASE_URL=                # production Supabase / Postgres connection string
DIRECT_URL=                  # direct (non-pooler) DB connection for migrations
APP_URL=https://app.gostork.com   # used by getBaseUrl() for payment redirect URLs
JWT_SECRET=                  # rotate from dev value
FIELD_ENCRYPTION_KEY=        # production encryption key (DO NOT reuse dev's)
CALDAV_ENCRYPTION_KEY=       # production CalDAV encryption key
```

External services - confirm each points at the production account/number:

```bash
SUPABASE_URL=                # production project
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=           # production key, with prod rate limit
GEMINI_API_KEY=              # production key
GCS_BUCKET_NAME=             # production bucket
GCS_SERVICE_ACCOUNT_KEY=     # production service account
SENDGRID_API_KEY=            # production key, verified sender domain
SENDGRID_FROM_EMAIL=         # verified sender domain on SendGrid
TWILIO_ACCOUNT_SID=          # production Twilio account
TWILIO_AUTH_TOKEN=
TWILIO_MESSAGING_SERVICE_SID=
TWILIO_PHONE_NUMBER=
TWILIO_VERIFY_SERVICE_SID=
DAILY_API_KEY=               # production Daily.co account
DAILY_WEBHOOK_SECRET=
GOOGLE_CLIENT_ID=            # OAuth client configured for app.gostork.com origin
GOOGLE_CLIENT_SECRET=
GOOGLE_SERVICE_ACCOUNT=      # Speech-to-Text / Calendar service account
MICROSOFT_CLIENT_ID=         # Azure app configured for app.gostork.com redirect URI
MICROSOFT_CLIENT_SECRET=
PANDADOC_API_KEY=
PANDADOC_WEBHOOK_SECRET=
```

### 1.4 Stripe Verified (optional, for Instant Payouts on platform)

- [ ] Stripe → Settings → Business → Verified → run the verification
      flow (you did this in sandbox already - now repeat in live mode).
      Unlocks Instant Payouts for the platform's own balance. Skip if
      2-business-day standard payouts are fine.

### 1.5 Stripe Dashboard email settings

- [ ] Stripe → Settings → Customer emails → ensure "Successful
      payments" Stripe-generated receipts are **OFF**. GoStork sends its
      own branded receipts via SendGrid (`buildBrandedEmail()`); leaving
      Stripe's on duplicates them.

---

## Phase 2 — Database migrations

Apply every v2 migration against the production DB before v2 boots. Each
migration uses `ADD COLUMN IF NOT EXISTS`, so re-running is safe. v2's
DB is independent of v1's - this is a fresh, self-contained schema, not
a migration of v1 data.

Run from the v2 codebase root on production DATABASE_URL:

```bash
npx prisma generate
npx tsx scripts/apply_bank_payout_migration.ts
npx tsx scripts/apply_refund_migration.ts
npx tsx scripts/apply_recoup_migration.ts
```

(Or `npx prisma migrate deploy` if you've moved off the manual ADD
COLUMN pattern by then.)

- [ ] Confirm new columns exist on `Invoice`:
  - From `20260527_invoice_bank_payout`: `stripeConnectPaymentId`,
    `stripeBankPayoutId`, `bankPayoutCompletedAt`, `bankPayoutFailedAt`,
    `bankPayoutFailureReason`
  - From `20260528_invoice_refunds`: `refundedAt`, `refundedAmount`,
    `refundReason`, `refundNotes`, `stripeRefundId`, `payoutReversalId`,
    `payoutReversedAt`, `payoutReversedAmount`
  - From `20260528_invoice_reversal_recoup`: `payoutReversalAtRisk`,
    `payoutReversalRecoupedAt`

---

## Phase 3 — Provider Connect onboarding (one-time)

Stripe Connect accounts created in test mode do **not** carry over to
live mode. Every provider that needs to receive payouts must onboard
fresh on live.

- [ ] Email all active providers letting them know the platform is
      upgrading and they'll be asked to re-link their bank account.
      Wording can promise: "Same UI, takes 5 minutes, your prior
      onboarding doesn't transfer because Stripe keeps test and live
      data separate."
- [ ] After cutover, providers log into `/account/payouts` and complete
      the Custom or Express flow on live mode. Their first live invoice
      can't transfer until this is done (the system handles this
      gracefully - PROVIDER_NOT_READY skip - but the row will sit at
      "Pending" forever until they onboard).

---

## Phase 4 — DNS cutover (the actual go-live moment)

This is the irreversible moment. Until DNS flips, all real customer
traffic is hitting v1. After DNS flips, all real customer traffic is
hitting v2. Stripe live webhooks pointing at `app.gostork.com/api/*`
only start delivering successfully once the flip is done.

Pre-flip checks (do BEFORE touching DNS):

- [ ] v2 is up at its staging URL with live Stripe keys + live webhook
      secrets already configured. The Stripe live webhooks are
      already created (Phase 1) pointing at `app.gostork.com` even
      though that domain still serves v1 - Stripe will accept the
      configuration; the deliveries will just fail until the DNS
      flip. That's fine - Stripe retries for 3 days.
- [ ] Phase 5 smoke tests pass against the staging URL with live
      keys (yes, real money on a staging URL is a real thing - do it
      to catch live-key issues before cutover).

The flip:

- [ ] Update DNS / load balancer / Replit domain mapping so
      `app.gostork.com` points at the v2 deployment instead of v1.
- [ ] Verify TLS certificate covers `app.gostork.com` on the v2
      stack (apex + any `www` variant you advertise).
- [ ] Confirm v2 is reachable at the production URL:
      ```bash
      curl https://app.gostork.com/                   # expect 200
      curl https://app.gostork.com/api/health         # or whatever your health endpoint is
      curl -X POST https://app.gostork.com/api/webhooks/stripe \
        -H "Stripe-Signature: invalid" -d '{}'
      # expect 400 "No signatures found matching the expected signature"
      # confirms the route is mounted and signature verification is on
      ```
- [ ] In Stripe Dashboard (live mode) → Webhooks → confirm the next
      few `payment_intent.succeeded` / `account.updated` events deliver
      with 200 OK. If they were retrying during the v1-still-serving
      window, Stripe will redeliver them automatically within minutes.

---

## Phase 5 — Smoke tests (live mode, real money)

Do these with a real card YOU own, low amount ($1-10). Refund yourself
after to recover the funds.

- [ ] **Payment flow**: create an invoice in admin, pay it from a fresh
      browser. Confirm:
  - Stripe Dashboard (live) shows the PaymentIntent succeeded
  - Server log shows `Stripe webhook: payment_intent.succeeded`
  - Invoice flips to PAID in DB
  - Receipt PDF emails to both parent and provider (SendGrid)
  - If the provider is Connect-onboarded: row flips to "Sent" within
    seconds (transfer fired)
- [ ] **Payout flow**: wait for Stripe's payout schedule (or trigger
      manually via Dashboard → Connected account → Payouts → Create
      payout). Confirm:
  - `payout.paid` webhook hits `/api/webhooks/stripe-connect`
  - Server log shows the manual/automatic path taken
  - Invoice row flips to "Received" with green check
- [ ] **Refund flow (proportional)**: admin clicks Refund → confirm
      $1 → submit. Confirm:
  - Stripe Dashboard shows the refund
  - `charge.refunded` webhook hits `/api/webhooks/stripe`
  - Invoice flips to REFUNDED, badge updates
  - Provider's Connect balance decreases (or goes negative if already
    Received)
  - Refund hits your card in 5-10 business days (test by check, not
    blocker)
- [ ] **Refund flow (keep_platform_fee)**: refund a different invoice
      with mode = "Keep GoStork fee". Confirm provider's reversal
      equals the full refund amount (not proportional).
- [ ] **Recoupment monitor**: server log shows `[reversal-recoup]
      Scheduler started - runs every 30 minutes, immediate startup
      check enabled` on boot. If you refunded a Received invoice
      above, confirm the inline "Recoupment pending" badge appears,
      then watch it clear within an hour after the provider's next
      activity.

---

## Phase 6 — Post-launch monitoring (first 48 hours)

- [ ] Stripe Dashboard → Webhooks → both live endpoints should show
      0% error rate. Investigate any 4xx/5xx delivery failures
      immediately.
- [ ] Admin notification bell - watch for `payout_failed_notification`
      events (provider bank rejected a payout) or
      `admin_transfer_failed` events (platform → Connect transfer
      errored).
- [ ] `/api/admin/billing/recoupments-pending` - check daily for any
      providers whose negative Connect balance isn't clearing within
      72h. Manual coordination may be needed.
- [ ] Check the `[reversal-recoup]` log lines every 30 min for the
      first day - confirm it's running and not erroring.
- [ ] Spot-check a few `payment_intent.succeeded` events end-to-end:
      did the invoice flip to PAID? Did the transfer fire? Did the
      receipt PDF emit?

---

## Rollback procedure (if something is on fire)

Two flavors of rollback depending on how broken things are.

**Light rollback - bad v2 commit, code-level issue:**

1. `git revert <bad-commit>` on `main` (or reset to a known-good v2
   SHA) and redeploy. v2's deployment infra still serves
   `app.gostork.com`.
2. If the bad commit included a DB migration, the columns are additive
   and safe to leave in place - earlier v2 code ignores them.
3. Triage in dev/staging.

**Full rollback - DNS flip back to v1:**

1. Revert the DNS / load balancer / domain mapping for
   `app.gostork.com` to point back at the v1 stack.
2. In Stripe Dashboard (live mode) → Webhooks → temporarily **disable**
   the v2 destinations (`app.gostork.com/api/webhooks/stripe(-connect)`).
   Otherwise Stripe keeps delivering live customer events to v2 while
   v1 is serving the domain - the events would either land on v2's DB
   (creating divergent state) or fail signature validation. Stripe
   retries for 3 days, so you can re-enable later without losing
   events.
3. Disable v2's Connect webhook similarly so no provider events leak
   in during the rollback window.
4. v2's DB sits frozen at the rollback moment. Triage in
   dev/staging, fix forward, then re-flip DNS to v2 when ready and
   re-enable the webhooks.

---

## Notes worth remembering

- **Test mode Connect accounts don't migrate.** Providers must
  re-onboard in live mode after cutover.
- **The 4 test-mode webhooks stay configured.** They keep working for
  sandbox testing post-launch. Live and test webhook configs are
  independent in Stripe.
- **Refunds initiated in the Stripe Dashboard work too.** Our webhook
  handler is the source of truth; admin UI is just one entry point.
  Mode defaults to proportional when admin uses the Dashboard
  directly (no metadata).
- **The recoup monitor runs every 30 min** plus immediate boot pass.
  In production with real volume, expect to see at-risk invoices
  clear within hours, not days.
