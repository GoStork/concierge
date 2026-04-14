/**
 * Standalone human escalation notifier.
 * Directly calls SendGrid + Twilio without going through the NestJS DI container,
 * so it works reliably from Express routers (ai-router, chat-router).
 */

import { prisma } from "./db";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function tintHex(hex: string, ratio: number): string {
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  return `#${Math.round(r + (255 - r) * ratio).toString(16).padStart(2, "0")}${Math.round(g + (255 - g) * ratio).toString(16).padStart(2, "0")}${Math.round(b + (255 - b) * ratio).toString(16).padStart(2, "0")}`;
}

function shadeHex(hex: string, ratio: number): string {
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return hex;
  const r = Math.round(parseInt(m[1].slice(0, 2), 16) * (1 - ratio));
  const g = Math.round(parseInt(m[1].slice(2, 4), 16) * (1 - ratio));
  const b = Math.round(parseInt(m[1].slice(4, 6), 16) * (1 - ratio));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function getBaseUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.REPLIT_DEPLOYMENT_URL) return `https://${process.env.REPLIT_DEPLOYMENT_URL}`;
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return "http://localhost:5000";
}

async function getBrandDefaults(): Promise<Record<string, string>> {
  const defaults: Record<string, string> = {
    brandColor: "#004D4D",
    primaryForegroundColor: "#ffffff",
    secondaryColor: "#F0FAF5",
    accentColor: "#0DA4EA",
    successColor: "#16a34a",
    warningColor: "#f59e0b",
    errorColor: "#ef4444",
    foregroundColor: "#0A0A0A",
    mutedForegroundColor: "#737373",
    backgroundColor: "#ffffff",
    cardColor: "#ffffff",
    borderColor: "#e5e5e5",
    companyName: "GoStork",
    logoUrl: "",
    headingFontStack: "'Playfair Display',Georgia,serif",
    bodyFontStack: "'DM Sans',Arial,sans-serif",
    buttonRadius: "8px",
    containerRadius: "12px",
  };
  try {
    const s = await prisma.siteSettings.findFirst() as any;
    if (s) {
      if (s.primaryColor) defaults.brandColor = s.primaryColor;
      if (s.primaryForegroundColor) defaults.primaryForegroundColor = s.primaryForegroundColor;
      if (s.companyName) defaults.companyName = s.companyName;
      const imageBase = process.env.APP_URL?.replace(/\/+$/, "") || getBaseUrl();
      const rawLogo = s.logoWithNameUrl || s.logoUrl || "";
      defaults.logoUrl = rawLogo.startsWith("/") ? `${imageBase}${rawLogo}` : rawLogo;
      if (s.warningColor) defaults.warningColor = s.warningColor;
      if (s.foregroundColor) defaults.foregroundColor = s.foregroundColor;
      if (s.mutedForegroundColor) defaults.mutedForegroundColor = s.mutedForegroundColor;
      if (s.backgroundColor) defaults.backgroundColor = s.backgroundColor;
      if (s.cardColor) defaults.cardColor = s.cardColor;
      if (s.borderColor) defaults.borderColor = s.borderColor;
    }
  } catch {}
  return defaults;
}

function buildEscalationEmail(brand: Record<string, string>, parentName: string, chatUrl: string): string {
  const warn = tintHex(brand.warningColor, 0.9);
  const warnBorder = brand.warningColor;
  const warnText = shadeHex(brand.warningColor, 0.4);
  const logoHtml = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.companyName)}" style="max-height:40px;margin-bottom:8px;" /><br>`
    : "";
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:${tintHex(brand.backgroundColor, 0.03)};font-family:${brand.bodyFontStack};">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:${brand.cardColor};border-radius:${brand.containerRadius};overflow:hidden;">
<tr><td style="background:${brand.brandColor};padding:30px;text-align:center;">
${logoHtml}<h1 style="color:${brand.primaryForegroundColor};font-family:${brand.headingFontStack};font-size:24px;margin:0;">${esc(brand.companyName)}</h1>
</td></tr>
<tr><td style="padding:40px 30px;">
<h2 style="font-family:${brand.headingFontStack};color:${brand.brandColor};font-size:22px;margin:0 0 16px;">Parent Requesting Human Assistance</h2>
<p style="color:${brand.foregroundColor};font-size:15px;line-height:1.6;margin:0 0 12px;"><strong>${esc(parentName)}</strong> has requested to speak with a human concierge.</p>
<div style="background:${warn};border-left:4px solid ${warnBorder};padding:14px 16px;border-radius:4px;margin:16px 0;font-size:14px;color:${warnText};">Please join the chat as soon as possible to assist this parent.</div>
<table cellpadding="0" cellspacing="0" style="margin:24px auto;" align="center"><tr>
<td><table cellpadding="0" cellspacing="0"><tr><td style="background:${brand.brandColor};border-radius:${brand.buttonRadius};">
<a href="${chatUrl}" style="display:inline-block;padding:12px 24px;color:${brand.primaryForegroundColor};text-decoration:none;font-weight:600;font-size:14px;font-family:${brand.bodyFontStack};">Join Chat Now</a>
</td></tr></table></td>
</tr></table>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

export async function notifyAdminsHumanEscalation(params: {
  parentName: string;
  parentEmail: string;
  parentPhone?: string | null;
  sessionId: string;
}): Promise<void> {
  const [brand, admins] = await Promise.all([
    getBrandDefaults(),
    prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" } },
      select: { id: true, email: true, mobileNumber: true },
    }),
  ]);

  const chatUrl = `${getBaseUrl()}/admin/concierge-monitor?sessionId=${params.sessionId}`;
  const subject = `Human Assistance Requested - ${params.parentName}`;
  const html = buildEscalationEmail(brand, params.parentName, chatUrl);
  const smsBody = `${brand.companyName} Alert: ${params.parentName} (${params.parentEmail}) is requesting human assistance. Join chat: ${chatUrl}`;

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
