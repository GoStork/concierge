import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Format a stored phone number (E.164 or any international string) for display,
 * as calling code + the number's own national grouping, e.g. "+1 (917) 224-7761".
 * This matches the display string the client PhoneInput builds, so the same
 * number renders identically everywhere. Falls back to the raw value when it
 * can't be parsed. Use this anywhere a phone number is shown to a human (email
 * bodies, rendered documents) - never for SMS/Twilio recipients, which must
 * stay raw E.164.
 */
export function formatPhoneDisplay(raw: string | null | undefined): string {
  if (!raw) return "";
  const parsed = parsePhoneNumberFromString(raw);
  if (!parsed) return raw;
  return `+${parsed.countryCallingCode} ${parsed.formatNational()}`;
}
