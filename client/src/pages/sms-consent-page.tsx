import { SmsConsentDisclosure } from "@/components/ui/sms-consent-disclosure";
import { useBrandSettings } from "@/hooks/use-brand-settings";

/**
 * Public, unauthenticated evidence page for the A2P 10DLC campaign registration.
 *
 * Carrier reviewers have to be able to verify our SMS call-to-action, but the real
 * opt-in sits behind account signup where they cannot reach it. This page shows the
 * exact same <SmsConsentDisclosure /> the user sees on the phone step, so the
 * declared message flow and the live UI are the same code and cannot drift apart.
 *
 * Referenced by the Twilio campaign's message flow - keep it publicly reachable.
 */
export default function SmsConsentPage() {
  const { data: brand } = useBrandSettings();
  const brandName = brand?.companyName || "GoStork";

  return (
    <div className="min-h-screen bg-background py-12 px-6">
      <div className="mx-auto max-w-2xl space-y-8">
        <div className="space-y-3">
          <h1 className="t-page-title font-heading" data-testid="text-sms-consent-title">
            How {brandName} SMS opt-in works
          </h1>
          <p className="t-field-prose">
            {brandName} sends text messages only to people who provide a mobile number and
            agree to receive them during account signup.
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="t-section-title font-heading">The disclosure users see</h2>
          <p className="t-field-prose">
            On the phone number step of signup, immediately above the "Verify phone number"
            button, every user sees this:
          </p>
          <SmsConsentDisclosure actionLabel="tapping Verify phone number" />
        </div>

        <div className="space-y-3">
          <h2 className="t-section-title font-heading">What we send</h2>
          <ul className="t-field-prose list-disc space-y-1 pl-5">
            <li>One-time account verification codes</li>
            <li>Match updates</li>
            <li>Appointment confirmations and reminders</li>
            <li>Messages from providers you connect with</li>
          </ul>
        </div>

        <div className="rounded-[var(--radius)] bg-accent/10 p-5 space-y-2">
          <p className="t-field-prose">
            Message frequency varies. Msg &amp; data rates may apply.
          </p>
          <p className="t-field-prose">
            Reply <strong>STOP</strong> to unsubscribe, or <strong>HELP</strong> for
            assistance.
          </p>
          <p className="t-field-prose">
            Consent is not a condition of purchase. We never sell or share your number.
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
