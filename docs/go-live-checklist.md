# Go-Live Checklist

Items that MUST happen when GoStork switches to the live/production Stripe
account and the real production domain. Add new go-live tasks here as they
come up - this file is the single place to check before launch.

## Stripe: create live-mode webhook destinations (DONE 2026-08-19 for test-app.gostork.com - we_1U67fGCGqwxDjN6VLCLn2AqY main, we_1U67iLCGqwxDjN6VGNbnHZCI connect; repoint/add for app.gostork.com at Phase B)

The production Stripe account (`acct_1TYZ1aCGqwxDjN6V`, "GoStork") has NO
webhook destinations. The sandbox (`acct_1TYZ1kC5oC6HdQow`) has them; live
mode needs its own copies. Do this AT go-live, not before - Stripe disables
destinations that consistently fail, so creating them against a dead
production URL guarantees a disabled webhook by launch day.

Create two event destinations in the live dashboard (Workbench -> Webhooks),
mirroring the sandbox:

1. **Main billing** -> `https://<prod-domain>/api/webhooks/stripe`
   - Events from: Your account
   - Events (8): `payment_intent.succeeded`, `payment_intent.processing`,
     `payment_intent.canceled`, `payment_intent.payment_failed`,
     `payment_intent.amount_capturable_updated`, `charge.refunded`,
     `invoice.payment_succeeded`, `invoice.payment_failed`
   - Handler: `server/src/modules/billing/billing.controller.ts` (`POST api/webhooks/stripe`)

2. **Connect** -> `https://<prod-domain>/api/webhooks/stripe-connect`
   - Events from: Connected accounts
   - Events (3): `account.updated`, `payout.paid`, `payout.failed`.
     NOTE 2026-08-19: Stripe no longer allows `account.application.deauthorized`
     on a Connected-accounts destination (it is a platform-level event); if it
     is needed, add it to the MAIN destination and make sure the handler
     routing covers it.
   - Handler: `server/src/modules/billing/connect.controller.ts` (`POST api/webhooks/stripe-connect`)

Then, in the production environment:

- Set `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` /
  `VITE_STRIPE_PUBLISHABLE_KEY` to the LIVE keys.
- Set `STRIPE_WEBHOOK_SECRET` to the main destination's signing secret and
  `STRIPE_CONNECT_WEBHOOK_SECRET` to the Connect destination's signing secret
  (each destination has its own secret - reveal it in the dashboard after
  creating the destination).
- Set `APP_URL` to the production domain (outbound links + webhook targets).

## Stripe: platform payout schedule must be Manual

The live platform account's payout schedule MUST be set to Manual before the
payout automation runs (Settings -> Business -> Payouts). The payout pipeline
(balance pre-check, defer ladder, remainder sweep) assumes it controls payout
timing; an automatic schedule drains the balance out from under it.

## Verify after creating the live webhooks

An unsigned `POST https://<prod-domain>/api/webhooks/stripe` (and
`.../stripe-connect`) should return **400** (signature rejection), not 404 -
that proves the route is reachable through the production domain. Then send a
test event from the Stripe dashboard and confirm it shows as succeeded.
