/**
 * Standalone human escalation notifier.
 * Directly calls SendGrid + Twilio without going through the NestJS DI container,
 * so it works reliably from Express routers (ai-router, chat-router).
 */

import { prisma } from "./db";
import { getBaseUrl } from "./src/lib/get-base-url";
import { esc, buildBrandedEmail, fetchEmailBrandData } from "./src/modules/notifications/email-builder";

export async function notifyAdminsHumanEscalation(params: {
  parentName: string;
  parentEmail: string;
  parentPhone?: string | null;
  sessionId: string;
  /** "cancelled" = the parent withdrew a pending request; tells the same admins to stand down. */
  kind?: "requested" | "cancelled";
}): Promise<void> {
  const [brand, admins] = await Promise.all([
    fetchEmailBrandData(prisma),
    prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" } },
      select: { id: true, email: true, mobileNumber: true },
    }),
  ]);

  const chatUrl = `${getBaseUrl()}/admin/concierge-monitor?sessionId=${params.sessionId}`;
  const cancelled = params.kind === "cancelled";
  const subject = cancelled
    ? `Human Assistance Request Cancelled - ${params.parentName}`
    : `Human Assistance Requested - ${params.parentName}`;
  const html = cancelled
    ? buildBrandedEmail(brand, {
        title: "Human Assistance Request Cancelled",
        greeting: `<strong>${esc(params.parentName)}</strong> no longer needs to speak with a human concierge.`,
        body: "",
        alertBox: { text: "No action needed - the parent withdrew the request and is continuing with the AI concierge.", type: "info" },
        buttons: [{ label: "View Chat", url: chatUrl }],
      })
    : buildBrandedEmail(brand, {
        title: "Parent Requesting Human Assistance",
        greeting: `<strong>${esc(params.parentName)}</strong> has requested to speak with a human concierge.`,
        body: "",
        alertBox: { text: "Please join the chat as soon as possible to assist this parent.", type: "warning" },
        buttons: [{ label: "Join Chat Now", url: chatUrl }],
      });
  const smsBody = cancelled
    ? `${brand.companyName}: ${params.parentName} (${params.parentEmail}) cancelled their request for human assistance. No action needed.`
    : `${brand.companyName} Alert: ${params.parentName} (${params.parentEmail}) is requesting human assistance. Join chat: ${chatUrl}`;

  const sendgridKey = process.env.SENDGRID_API_KEY;
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

  await Promise.all(admins.map(async (admin) => {
    // Email
    if (sendgridKey) {
      try {
        const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: `Bearer ${sendgridKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: admin.email }] }],
            from: { email: process.env.SENDGRID_FROM_EMAIL || "noreply@gostork.com", name: brand.companyName },
            subject,
            content: [{ type: "text/html", value: html }],
          }),
        });
        if (!resp.ok) {
          const t = await resp.text();
          console.error(`[ESCALATION] SendGrid error for ${admin.email}: ${resp.status} - ${t}`);
        } else {
          console.log(`[ESCALATION] Email sent to admin ${admin.email}`);
        }
      } catch (e: any) {
        console.error(`[ESCALATION] Email send failed for ${admin.email}:`, e.message);
      }
    } else {
      console.log(`[ESCALATION EMAIL MOCK] To: ${admin.email}, Subject: ${subject}`);
    }

    // SMS
    if (admin.mobileNumber) {
      let to = admin.mobileNumber.replace(/[\s\-\(\)]/g, "");
      if (!to.startsWith("+")) to = `+1${to}`;
      if (twilioSid && twilioToken && twilioFrom) {
        try {
          const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
            method: "POST",
            headers: {
              Authorization: "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64"),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ To: to, From: twilioFrom, Body: smsBody }).toString(),
          });
          if (!resp.ok) {
            const t = await resp.text();
            console.error(`[ESCALATION] Twilio error for ${to}: ${resp.status} - ${t}`);
          } else {
            console.log(`[ESCALATION] SMS sent to admin ${to}`);
          }
        } catch (e: any) {
          console.error(`[ESCALATION] SMS send failed for ${to}:`, e.message);
        }
      } else {
        console.log(`[ESCALATION SMS MOCK] To: ${to}, Body: ${smsBody}`);
      }
    }
  }));
}
