import { parsePhoneNumberFromString } from "libphonenumber-js";

export type VerificationChannel = "sms" | "whatsapp";

const SMS_DEFAULT_COUNTRIES = new Set<string>(["US", "CA"]);

export function parsePhoneIso(e164: string): string | null {
  try {
    const parsed = parsePhoneNumberFromString(e164);
    return parsed?.country ?? null;
  } catch {
    return null;
  }
}

export function pickChannel(isoCode: string | null): VerificationChannel {
  if (!isoCode) return "sms";
  return SMS_DEFAULT_COUNTRIES.has(isoCode.toUpperCase()) ? "sms" : "whatsapp";
}
