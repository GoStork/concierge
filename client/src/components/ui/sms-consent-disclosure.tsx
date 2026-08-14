import { useBrandSettings } from "@/hooks/use-brand-settings";

/**
 * A2P 10DLC call-to-action disclosure.
 *
 * This is the consent language a carrier reviewer looks for at the point where we
 * collect a mobile number, and the wording must stay in sync with the message flow
 * declared on the Twilio campaign. It has to state: who is texting, what kinds of
 * messages, that frequency varies, that rates may apply, how to stop, how to get
 * help, and where the Terms and Privacy Policy live.
 *
 * Mount it on EVERY surface that collects a phone number - never re-word it inline,
 * or the campaign's declared flow and the live UI drift apart.
 */
export function SmsConsentDisclosure({
  actionLabel = "continuing",
  className = "",
}: {
  /** The control the user is about to press, e.g. "Verify phone number". */
  actionLabel?: string;
  className?: string;
}) {
  const { data: brand } = useBrandSettings();
  const brandName = brand?.companyName || "GoStork";

  return (
    <div
      className={`rounded-[var(--radius)] bg-secondary p-4 ${className}`}
      data-testid="sms-consent-disclosure"
    >
      <p className="t-helper">
        By {actionLabel}, you agree to receive text messages from {brandName} at the number
        above: your verification code, plus updates about your matches, appointments, and
        messages from your providers. Message frequency varies. Msg &amp; data rates may
        apply. Reply STOP to unsubscribe or HELP for help. See our{" "}
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
