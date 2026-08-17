import {
  SmsTransactionalNotice,
  SmsNotificationsOptIn,
} from "@/components/ui/sms-consent-disclosure";
import { useBrandSettings } from "@/hooks/use-brand-settings";

/**
 * Public, unauthenticated evidence page for the A2P 10DLC campaign registration.
 *
 * Carrier reviewers have to be able to verify our SMS call-to-action, but the real
 * opt-in sits behind account signup where they cannot reach it. This page renders the
 * exact same components the user sees on the phone step - the transactional
 * verification-code notice and the separate, optional notifications opt-in checkbox -
 * so the declared message flow and the live UI are the same code and cannot drift.
 *
 * Referenced by the Twilio campaign's message flow - keep it publicly reachable,
 * with no auth guard, forever (including after launch).
 */
export default function SmsConsentPage() {
  const { data: brand } = useBrandSettings();
  const brandName = brand?.companyName || "GoStork";

  return (
    <div className="min-h-screen bg-background py-12 px-6">
      <div className="mx-auto max-w-2xl space-y-8">
        <div className="space-y-3">
          <h1 className="t-page-title font-heading" data-testid="text-sms-consent-title">
            How {brandName} SMS consent works
          </h1>
          <p className="t-field-prose">
            {brandName} collects SMS consent in two separate steps on the phone number
            step of account signup. Consent to receive text messages is never a
            condition of using {brandName} or of any purchase.
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="t-section-title font-heading">
            Step 1: the one-time verification code
          </h2>
          <p className="t-field-prose">
            The user enters their mobile number and taps "Verify phone number". This
            sends a single one-time verification code that the user has explicitly
            requested. Immediately above the button, every user sees this notice:
          </p>
          <SmsTransactionalNotice />
        </div>

        <div className="space-y-3">
          <h2 className="t-section-title font-heading">
            Step 2: the optional notifications opt-in
          </h2>
          <p className="t-field-prose">
            On the same screen, a separate checkbox offers ongoing notification texts.
            The box starts unticked, and signup completes whether or not it is ticked.
            The checkbox label reads:
          </p>
          <div className="rounded-[var(--radius)] border-2 border-primary/40 bg-accent/10 p-4 flex items-start gap-3">
            <input
              type="checkbox"
              disabled
              className="mt-0.5 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
              aria-label="Example of the unticked opt-in checkbox"
            />
            <SmsNotificationsOptIn />
          </div>
        </div>

        <div className="rounded-[var(--radius)] bg-accent/10 p-5 space-y-2">
          <p className="t-field-prose">
            Message frequency varies. Msg &amp; data rates may apply.
          </p>
          <p className="t-field-prose">
            Reply <strong>STOP</strong> to unsubscribe, or <strong>HELP</strong> for
            assistance. Users can also turn notification texts on or off at any time
            from their account settings.
          </p>
          <p className="t-field-prose">
            Consent to receive text messages is not a condition of using {brandName} or
            of any purchase. We never sell or share your number.
          </p>
        </div>

        <p className="t-helper">
          See our{" "}
          <a
            href="https://www.gostork.com/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary font-medium hover:underline"
            data-testid="link-consent-terms"
          >
            Terms of Service
          </a>{" "}
          and{" "}
          <a
            href="https://www.gostork.com/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary font-medium hover:underline"
            data-testid="link-consent-privacy"
          >
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </div>
  );
}
