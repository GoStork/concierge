import twilio, { Twilio } from "twilio";

let cachedClient: Twilio | null = null;

export function getTwilioClient(): Twilio | null {
  if (cachedClient) return cachedClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  cachedClient = twilio(sid, token);
  return cachedClient;
}
