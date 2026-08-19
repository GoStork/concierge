import { useBrandSettings } from "@/hooks/use-brand-settings";

/**
 * A2P 10DLC consent surfaces - split into TWO separate pieces after the 30923
 * rejection ("consent cannot be a required condition for service or transaction
 * completion").
 *
 * 1. <SmsTransactionalNotice /> - the one-time verification code only. The user is
 *    explicitly requesting this single message by tapping Verify, so it carries no
 *    ongoing-consent language and no STOP/HELP promise.
 * 2. <SmsNotificationsOptIn /> - the optional ongoing notification stream. Rendered
 *    as the label of an UNTICKED checkbox on the phone step. Signup MUST complete
 *    whether or not the box is ticked - if declining ever blocks the Verify button,
 *    we are straight back on 30923.
 *
 * SHORTENED 2026-08-19. The post-30923 wording was padded; this cut is roughly 60%
 * with every carrier-required element kept. The opt-in must always carry all six:
 * brand name, what the messages are, frequency, "msg & data rates may apply",
 * STOP/HELP, and links to Terms + Privacy. "Optional." also stays - it is the
 * sentence a reviewer looks for on a 30923 re-review. Do not cut any of those.
 *
 * NEVER-DRIFT RULE: this wording is carrier-registered and lives in three places
 * that must stay word-for-word identical: this file (mounted on the onboarding
 * phone step AND rendered by the public /sms-consent route), the public evidence
 * page https://www.gostork.com/sms-consent (WordPress page 5461), and the campaign's
 * "How do end-users consent to receive messages?" field in the Twilio Console.
 * Never re-word it in one place, and never write inline consent copy on a new
 * surface - mount these components instead.
 *
 * KNOWN DRIFT, deliberate, opened 2026-08-19: places 2 and 3 still hold the long
 * pre-shortening wording. The campaign registration is FAILED (30909, MESSAGE_FLOW)
 * with campaign_id null, so no registered flow is in force and nothing live depends
 * on the long text. Editing the Twilio field IS the resubmission, and resubmitting
 * is parked until the cited signup URL actually serves this flow. Close the drift by
 * pushing this exact wording to WordPress 5461 (copy + a fresh screenshot) and the
 * Twilio message-flow field in the same sitting as that resubmit.
 */

/**
 * Transactional notice for the one-time verification code. Shown above the
 * Verify button. No opt-in semantics - the tap itself is the request.
 *
 * Renders as plain helper text and carries NO container chrome of its own: the
 * signup step wants this to recede next to the opt-in checkbox, while the public
 * evidence page wants it boxed as a quoted UI sample. Pass the surface-specific
 * background/padding via className. The WORDING is the carrier-registered part
 * and never varies; presentation is the caller's.
 */
export function SmsTransactionalNotice({ className = "" }: { className?: string }) {
  const { data: brand } = useBrandSettings();
  const brandName = brand?.companyName || "GoStork";

  return (
    <div className={className} data-testid="sms-transactional-notice">
      <p className="t-helper">
        {brandName} will text you a one-time code to verify this number. Msg &amp; data
        rates may apply.
      </p>
    </div>
  );
}

/**
 * The optional ongoing-notifications consent. Rendered as the label of an
 * unticked checkbox; also shown on the public /sms-consent evidence page.
 */
export function SmsNotificationsOptIn({ className = "" }: { className?: string }) {
  const { data: brand } = useBrandSettings();
  const brandName = brand?.companyName || "GoStork";

  return (
    <div className={className} data-testid="sms-notifications-opt-in">
      <p className="t-body font-medium text-foreground">
        Yes, text me updates about my journey
      </p>
      <p className="t-helper mt-1">
        Match updates, appointment reminders, and messages from providers you connect
        with, by text from {brandName}. Optional. Frequency varies, msg &amp; data rates
        may apply. Reply STOP to cancel, HELP for help.{" "}
        <a
          href="https://www.gostork.com/terms"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary font-medium hover:underline"
          data-testid="link-sms-terms"
        >
          Terms
        </a>{" "}
        &middot;{" "}
        <a
          href="https://www.gostork.com/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary font-medium hover:underline"
          data-testid="link-sms-privacy"
        >
          Privacy
        </a>
      </p>
    </div>
  );
}
