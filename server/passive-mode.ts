/**
 * PASSIVE MODE - for extra always-on environments that must never perform
 * outbound side effects (the Replit deployment kept around for native-app
 * work is the motivating case: it wakes on any request and runs whatever code
 * was last pushed, against the production DB, with real credentials).
 *
 * Set PASSIVE_MODE=1 in that environment's secrets and the server runs as
 * pure UI + API: schedulers do not start (see index.ts), webhook payloads are
 * acknowledged but not processed (chat-router), and the email/SMS credentials
 * are stripped HERE - at import time, before any module can read them - so
 * every sender falls into its existing no-credentials mock path (logged,
 * never sent). One choke point instead of a guard in nine sender files.
 *
 * This module must be imported IMMEDIATELY after "dotenv/config" in
 * server/index.ts - import order is what guarantees the strip happens before
 * any other module evaluates.
 */
export const PASSIVE_MODE = process.env.PASSIVE_MODE === "1";

if (PASSIVE_MODE) {
  process.env.SMS_DISABLED = "1";
  delete process.env.SENDGRID_API_KEY;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_PHONE_NUMBER;
  delete process.env.TWILIO_MESSAGING_SERVICE_SID;
  delete process.env.TWILIO_VERIFY_SERVICE_SID;
  console.log(
    "[PASSIVE_MODE] This instance is UI/API only: schedulers will not start, webhooks are acknowledged but not processed, and email/SMS credentials are stripped (senders fall back to their mock paths).",
  );
}
