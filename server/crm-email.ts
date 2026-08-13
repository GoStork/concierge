/**
 * Minimal branded email send for CRM router events (e.g. #7 @mention).
 *
 * The rich NotificationService lives in the Nest layer; this Express router
 * needs a small, self-contained sender for internal staff notifications. Same
 * SendGrid path as sendRawEmail, env-gated - a missing key logs a mock rather
 * than throwing, so a note is never blocked on email.
 */
import { prisma } from "./db";
import { esc, buildBrandedEmail, fetchEmailBrandData } from "./src/modules/notifications/email-builder";

export async function sendCrmEmail(to: string, subject: string, html: string): Promise<void> {
  const key = process.env.SENDGRID_API_KEY;
  if (!key || !to) {
    console.log(`[crm-email MOCK] To: ${to}, Subject: ${subject}`);
    return;
  }
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: process.env.SENDGRID_FROM_EMAIL || "noreply@gostork.com", name: "GoStork" },
        subject,
        content: [{ type: "text/html", value: html }],
      }),
    });
    if (!res.ok) console.warn(`[crm-email] SendGrid ${res.status} for ${to}`);
  } catch (e: any) {
    console.warn(`[crm-email] send failed for ${to}: ${e?.message}`);
  }
}

/**
 * The email a colleague gets when they are @mentioned.
 *
 * Goes through buildBrandedEmail like every other email on the platform - logo,
 * brand colours, fonts and button shape all come from Brand Settings. It used
 * to be hand-rolled HTML with hardcoded hexes, which shipped an unbranded note
 * that looked nothing like the rest of the product.
 */
export async function mentionEmailHtml(params: { mentioner: string; parentName: string; noteText: string; url: string }): Promise<string> {
  const brand = await fetchEmailBrandData(prisma as any);
  return buildBrandedEmail(brand, {
    title: `${esc(params.mentioner)} mentioned you`,
    greeting: `<strong>${esc(params.mentioner)}</strong> mentioned you on <strong>${esc(params.parentName)}</strong>'s record.`,
    body: "",
    // The words they wrote, quoted - the reason this email exists.
    alertBox: { text: esc(params.noteText).slice(0, 600), type: "info" },
    buttons: [{ label: "Open the record", url: params.url }],
  });
}
