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
 * NEVER-DRIFT RULE: this wording is carrier-registered and lives in three places
 * that must stay word-for-word identical: this file (mounted on the onboarding
 * phone step AND rendered by the public /sms-consent route), the public evidence
 * page https://www.gostork.com/sms-consent (WordPress page 5461), and the campaign's
 * "How do end-users consent to receive messages?" field in the Twilio Console.
 * Never re-word it in one place, and never write inline consent copy on a new
 * surface - mount these components instead.
 */

/**
 * Transactional notice for the one-time verification code. Shown above the
 * Verify button. No opt-in semantics - the tap itself is the request.
 */
export function SmsTransactionalNotice({ className = "" }: { className?: string }) {
  const { data: brand } = useBrandSettings();
  const brandName = brand?.companyName || "GoStork";

  return (
    <div
      className={`rounded-[var(--radius)] bg-secondary p-4 ${className}`}
      data-testid="sms-transactional-notice"
    >
      <p className="t-helper">
        When you tap Verify phone number, {brandName} will text a one-time verification
        code to the number above. This is a single message sent because you requested it.
        Msg &amp; data rates may apply.
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
        Get match updates, appointment confirmations and reminders, and messages from
        providers you connect with, as texts from {brandName} to the number above.
        Message frequency varies. Msg &amp; data rates may apply. Reply STOP to
        unsubscribe or HELP for help. This is optional. You can use {brandName} without
        it, and you can change it anytime in your account settings. See our{" "}
        <a
          href="https://www.gostork.com/terms"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary font-medium hover:underline"
          data-testid="link-sms-terms"
        >
          Terms of Service
        </a>{" "}
        and{" "}
        <a
          href="https://www.gostork.com/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary font-medium hover:underline"
          data-testid="link-sms-privacy"
        >
          Privacy Policy
        </a>
        .
      </p>
    </div>
  );
}
