import { Injectable, Inject, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export type NotificationChannel =
  | "booking_submitted"
  | "booking_request"
  | "booking_confirmation"
  | "booking_reminder"
  | "booking_cancellation"
  | "booking_rescheduled"
  | "booking_declined"
  | "booking_new_time"
  | "calendar_reconnection"
  | "video_waiting"
  | "member_invitation"
  | "recording_ready"
  | "cost_sheet_submitted"
  | "cost_sheet_approved"
  | "cost_sheet_rejected"
  | "human_escalation";


const TWILIO_TEMPLATES = {
  BOOKING_SUBMITTED_PARENT: "HXa677816cb8bf69768464139042b88515",
  BOOKING_REQUEST_PROVIDER: "HX544035e88f6e478c1314e7704064d7a9",
  BOOKING_CONFIRMED_PARENT: "HX84cc7a1854b66a15a69c7bae3c4e448b",
  BOOKING_CONFIRMED_PROVIDER: "HX57ea6e74bad99d093b69863b9777c6bd",
  BOOKING_CANCELLED_PARENT: "HXdbef3610b962e07acfc48e19c0eb9022",
  BOOKING_CANCELLED_PROVIDER: "HX5ba9b231a5b9224899e14d02ec6e2e1c",
  BOOKING_RESCHEDULED_PARENT: "HX93eb1970ccb6a39f7dc832ef3fdd6c85",
  BOOKING_RESCHEDULED_PARENT_WITH_MSG: "HX69dc26c3047d6324b62d46c52daaf1c2",
  BOOKING_RESCHEDULED_PROVIDER: "HX39a6658c894cd89adf3754336c2e50dd",
  BOOKING_REMINDER: "HXe18583f530a691a3e58bc4b033f3a4f6",
  MEETING_DECLINED_PARENT: "HX1ecf20919c598d71728a371ae5a9338c",
  NEW_TIME_SUGGESTED_PARENT: "HX523f2bab235463f38de799c7c9af6e1e",
  NEW_TIME_SUGGESTED_PARENT_WITH_MSG: "HXce262a7c751f702b1bbe5cc5c04c48a1",
  CALENDAR_RECONNECTION: "HXefbbfef684696b94e55cf4cc29534794",
  VIDEO_WAITING_PARENT: "HX5ebdfae8412e2b22814ab321e1eb34c7",
  VIDEO_WAITING_PROVIDER: "HX7a0d4fa0fca197607ea546e80eb5750b",
  MEMBER_INVITATION: "HXe69876a807739e3d399e2f5f33ed8f0a",
};

function getBaseUrl(): string {
  if (process.env.REPLIT_DEPLOYMENT_URL) return `https://${process.env.REPLIT_DEPLOYMENT_URL}`;
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  if (process.env.REPL_SLUG) return `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "development") {
    const port = process.env.PORT || 5001;
    return `http://localhost:${port}`;
  }
  return "https://app.gostork.com";
}

function formatDate(d: Date, tz?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
  if (tz) opts.timeZone = tz;
  return d.toLocaleDateString("en-US", opts);
}

function formatTime(d: Date, tz?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", hour12: true };
  if (tz) opts.timeZone = tz;
  return d.toLocaleTimeString("en-US", opts);
}

function getFirstName(fullName?: string | null): string {
  if (!fullName) return "";
  return fullName.split(" ")[0];
}

function esc(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Mix a hex color toward white by a given ratio (0 = original, 1 = white) */
function tintHex(hex: string, ratio: number): string {
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  const tr = Math.round(r + (255 - r) * ratio);
  const tg = Math.round(g + (255 - g) * ratio);
  const tb = Math.round(b + (255 - b) * ratio);
  return `#${tr.toString(16).padStart(2, "0")}${tg.toString(16).padStart(2, "0")}${tb.toString(16).padStart(2, "0")}`;
}

/** Darken a hex color by a given ratio (0 = original, 1 = black) */
function shadeHex(hex: string, ratio: number): string {
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return hex;
  const r = Math.round(parseInt(m[1].slice(0, 2), 16) * (1 - ratio));
  const g = Math.round(parseInt(m[1].slice(2, 4), 16) * (1 - ratio));
  const b = Math.round(parseInt(m[1].slice(4, 6), 16) * (1 - ratio));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function buildBrandedEmail(
  brand: Record<string, string>,
  opts: {
    title: string;
    greeting: string;
    body: string;
    detailRows?: { label: string; value: string }[];
    buttons?: { label: string; url: string; variant?: "primary" | "secondary" | "destructive" }[];
    footer?: string;
    alertBox?: { text: string; type: "warning" | "success" | "info" | "error" };
  },
): string {
  const btnRadius = brand.buttonRadius || "8px";
  const btnColor = (v?: string) => {
    if (v === "destructive") return brand.errorColor;
    if (v === "secondary") return "transparent";
    return brand.brandColor;
  };
  const btnTextColor = (v?: string) => {
    if (v === "secondary") return brand.brandColor;
    return brand.primaryForegroundColor;
  };
  const btnBorder = (v?: string) => {
    if (v === "secondary") return `2px solid ${brand.brandColor}`;
    return "none";
  };

  const alertBg: Record<string, string> = {
    warning: tintHex(brand.warningColor, 0.9),
    success: tintHex(brand.successColor, 0.9),
    info: brand.secondaryColor,
    error: tintHex(brand.errorColor, 0.9),
  };
  const alertBorderColor: Record<string, string> = { warning: brand.warningColor, success: brand.successColor, info: brand.accentColor, error: brand.errorColor };
  const alertTextColor: Record<string, string> = {
    warning: shadeHex(brand.warningColor, 0.4),
    success: shadeHex(brand.successColor, 0.4),
    info: brand.brandColor,
    error: shadeHex(brand.errorColor, 0.4),
  };

  const detailsHtml = opts.detailRows?.length
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;background:${tintHex(brand.backgroundColor, 0.02)};border-radius:${brand.containerRadius};overflow:hidden;">
${opts.detailRows.map(r => `<tr><td width="160" style="padding:10px 16px;color:${brand.mutedForegroundColor};font-size:14px;font-family:${brand.bodyFontStack};border-bottom:1px solid ${brand.borderColor};white-space:nowrap;vertical-align:top;">${r.label}</td><td style="padding:10px 16px;color:${brand.foregroundColor};font-size:14px;font-family:${brand.bodyFontStack};border-bottom:1px solid ${brand.borderColor};font-weight:500;word-break:break-word;">${r.value}</td></tr>`).join("\n")}
</table>` : "";

  const alertHtml = opts.alertBox
    ? `<div style="background:${alertBg[opts.alertBox.type]};border-left:4px solid ${alertBorderColor[opts.alertBox.type]};padding:14px 16px;border-radius:4px;margin:16px 0;font-size:14px;font-family:${brand.bodyFontStack};color:${alertTextColor[opts.alertBox.type]};">${opts.alertBox.text}</div>` : "";

  const buttonsHtml = opts.buttons?.length
    ? `<table cellpadding="0" cellspacing="0" style="margin:24px auto;" align="center"><tr>${opts.buttons.map(b =>
        `<td style="padding:0 6px;"><table cellpadding="0" cellspacing="0"><tr><td style="background:${btnColor(b.variant)};border-radius:${btnRadius};border:${btnBorder(b.variant)};"><a href="${b.url}" style="display:inline-block;padding:12px 24px;color:${btnTextColor(b.variant)};text-decoration:none;font-weight:600;font-size:14px;font-family:${brand.bodyFontStack};">${b.label}</a></td></tr></table></td>`
      ).join("")}</tr></table>` : "";

  const footerHtml = opts.footer ? `<p style="color:${brand.mutedForegroundColor};font-size:12px;line-height:1.5;margin:24px 0 0;padding-top:16px;border-top:1px solid ${brand.borderColor};font-family:${brand.bodyFontStack};">${opts.footer}</p>` : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:${tintHex(brand.backgroundColor, 0.03)};font-family:${brand.bodyFontStack};">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:${tintHex(brand.backgroundColor, 0.03)};padding:40px 20px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background-color:${brand.cardColor};border-radius:${brand.containerRadius};overflow:hidden;">
<tr><td style="background-color:${brand.brandColor};padding:30px;text-align:center;">
${brand.logoUrl ? `<img src="${brand.logoUrl}" alt="${esc(brand.companyName)}" style="max-height:40px;margin-bottom:8px;" />` : ""}
<h1 style="color:${brand.primaryForegroundColor};font-family:${brand.headingFontStack};font-size:24px;margin:0;">${esc(brand.companyName)}</h1>
</td></tr>
<tr><td style="padding:40px 30px;">
<h2 style="font-family:${brand.headingFontStack};color:${brand.brandColor};font-size:22px;margin:0 0 16px;">${opts.title}</h2>
<p style="color:${brand.foregroundColor};font-size:15px;line-height:1.6;font-family:${brand.bodyFontStack};margin:0 0 12px;">${opts.greeting}</p>
<div style="color:${brand.foregroundColor};font-size:15px;line-height:1.6;font-family:${brand.bodyFontStack};margin:0 0 16px;">${opts.body}</div>
${detailsHtml}
${alertHtml}
${buttonsHtml}
${footerHtml}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);
  private reminderInterval: ReturnType<typeof setInterval> | null = null;
  private cachedCompanyName: string | null = null;
  private companyNameCacheTime: number = 0;
  private cachedBrandData: Record<string, string> | null = null;
  private brandDataCacheTime: number = 0;
  private static readonly COMPANY_NAME_CACHE_TTL = 5 * 60 * 1000;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async getCompanyName(): Promise<string> {
    const now = Date.now();
    if (this.cachedCompanyName && (now - this.companyNameCacheTime) < NotificationService.COMPANY_NAME_CACHE_TTL) {
      return this.cachedCompanyName;
    }
    try {
      const settings = await this.prisma.siteSettings.findFirst();
      this.cachedCompanyName = (settings as any)?.companyName || "GoStork";
      this.companyNameCacheTime = now;
    } catch {
      this.cachedCompanyName = "GoStork";
      this.companyNameCacheTime = now;
    }
    return this.cachedCompanyName!;
  }

  private async getBrandData(): Promise<Record<string, string>> {
    const now = Date.now();
    if (this.cachedBrandData && (now - this.brandDataCacheTime) < NotificationService.COMPANY_NAME_CACHE_TTL) {
      return this.cachedBrandData;
    }
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
      headingFont: "Playfair Display",
      bodyFont: "DM Sans",
      buttonRadius: "8px",
      containerRadius: "12px",
      headingFontStack: "'Playfair Display',Georgia,serif",
      bodyFontStack: "'DM Sans',Arial,sans-serif",
    };
    try {
      const settings = await this.prisma.siteSettings.findFirst();
      if (settings) {
        const s = settings as any;
        defaults.brandColor = s.primaryColor || defaults.brandColor;
        defaults.secondaryColor = s.secondaryColor || defaults.secondaryColor;
        defaults.accentColor = s.accentColor || defaults.accentColor;
        defaults.successColor = s.successColor || defaults.successColor;
        defaults.warningColor = s.warningColor || defaults.warningColor;
        defaults.errorColor = s.errorColor || defaults.errorColor;
        defaults.companyName = s.companyName || defaults.companyName;
        const rawLogo = s.logoWithNameUrl || s.logoUrl || "";
        // For email images, always use a publicly accessible URL (not localhost)
        // Prefer APP_URL or Replit deployment URL for image hosting
        const imageBaseUrl = process.env.APP_URL?.replace(/\/+$/, "")
          || (process.env.REPLIT_DEPLOYMENT_URL ? `https://${process.env.REPLIT_DEPLOYMENT_URL}` : "")
          || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "")
          || getBaseUrl();
        defaults.logoUrl = rawLogo && rawLogo.startsWith("/") ? `${imageBaseUrl}${rawLogo}` : rawLogo;
        defaults.primaryForegroundColor = s.primaryForegroundColor || defaults.primaryForegroundColor;
        defaults.foregroundColor = s.foregroundColor || defaults.foregroundColor;
        defaults.mutedForegroundColor = s.mutedForegroundColor || defaults.mutedForegroundColor;
        defaults.backgroundColor = s.backgroundColor || defaults.backgroundColor;
        defaults.cardColor = s.cardColor || defaults.cardColor;
        defaults.borderColor = s.borderColor || defaults.borderColor;
        defaults.headingFont = s.headingFont || defaults.headingFont;
        defaults.bodyFont = s.bodyFont || defaults.bodyFont;
        const borderRadiusRem = typeof s.borderRadius === "number" ? s.borderRadius : 0.5;
        if (borderRadiusRem <= 0) defaults.buttonRadius = "0px";
        else if (borderRadiusRem <= 0.125) defaults.buttonRadius = "2px";
        else if (borderRadiusRem <= 0.25) defaults.buttonRadius = "4px";
        else if (borderRadiusRem <= 0.5) defaults.buttonRadius = "8px";
        else if (borderRadiusRem <= 0.75) defaults.buttonRadius = "12px";
        else defaults.buttonRadius = "9999px";
        const containerRadiusRem = typeof s.containerRadius === "number" ? s.containerRadius : 0.75;
        defaults.containerRadius = `${Math.round(containerRadiusRem * 16)}px`;
        const hf = defaults.headingFont;
        defaults.headingFontStack = `'${hf}',Georgia,serif`;
        const bf = defaults.bodyFont;
        defaults.bodyFontStack = `'${bf}',Arial,sans-serif`;
      }
    } catch {
    }
    this.cachedBrandData = defaults;
    this.brandDataCacheTime = now;
    return this.cachedBrandData;
  }

  onModuleInit() {
    this.reminderInterval = setInterval(() => {
      this.processReminders().catch((e) => {
        const msg = e.message || "";
        if (msg.includes("MaxClientsInSessionMode") || msg.includes("pool") || msg.includes("ECONNREFUSED") || msg.includes("Connection")) {
          this.logger.warn(`Reminder scheduler skipped cycle (connection issue): ${msg}`);
        } else {
          this.logger.error(`Reminder processing failed: ${msg}`);
        }
      });
    }, 60_000);
    this.logger.log("Reminder scheduler started (every 60s)");
  }

  async sendBookingSubmitted(booking: any) {
    const providerUser = booking.providerUser || (await this.prisma.user.findUnique({ where: { id: booking.providerUserId } }));
    const attendeeEmail = booking.attendeeEmails?.[0] || booking.parentUser?.email;
    const attendeeName = booking.attendeeName || booking.parentUser?.name || attendeeEmail;
    const providerEmail = providerUser?.email;
    const providerName = providerUser?.provider?.name || providerUser?.name || "Provider";
    const staffMember = providerUser?.name || "";
    const scheduledAt = new Date(booking.scheduledAt);
    const base = getBaseUrl();
    const brandData = await this.getBrandData();
    const location = booking.meetingType === "phone" ? "Phone Call" : "Video Call";
    const dateStr = formatDate(scheduledAt, booking.bookerTimezone);
    const timeStr = formatTime(scheduledAt, booking.bookerTimezone);
    const detailsLink = `${base}/booking/${booking.publicToken}`;

    const parentEmailBuilder = (firstName: string) => buildBrandedEmail(brandData, {
      title: "Meeting Request Submitted",
      greeting: `Hi ${esc(firstName)},`,
      body: `Your meeting request with <strong>${esc(providerName)}</strong> has been submitted and is awaiting confirmation.`,
      detailRows: [
        { label: "Date", value: dateStr },
        { label: "Time", value: timeStr },
        { label: "Duration", value: `${booking.duration} minutes` },
        { label: "Location", value: location },
        ...(staffMember ? [{ label: "With", value: esc(staffMember) }] : []),
      ],
      alertBox: { text: "We'll notify you once the provider confirms your meeting.", type: "info" },
      buttons: [
        { label: "View Details", url: detailsLink },
        { label: "Reschedule", url: detailsLink, variant: "secondary" },
        { label: "Cancel", url: detailsLink, variant: "destructive" },
      ],
    });

    if (attendeeEmail) {
      const html = parentEmailBuilder(getFirstName(attendeeName));
      await this.dispatchNotification({
        userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_submitted", recipient: attendeeEmail,
        subject: `Your meeting with ${providerName} has been submitted`, body: html,
      });

      const submittedDetails: Record<string, { name?: string; phone?: string }> = booking.attendeeDetails || {};
      const submittedPrimaryDetails = submittedDetails[attendeeEmail.toLowerCase()] || {};
      const parentPhone = booking.parentUser?.mobileNumber || submittedPrimaryDetails.phone;
      if (parentPhone) {
        await this.dispatchSmsTemplate({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, channel: "booking_submitted", recipient: parentPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_SUBMITTED_PARENT, contentVars: { "1": getFirstName(attendeeName), "2": providerName, "3": dateStr, "4": timeStr, "5": detailsLink },
        });
      }
    }

    await this.fanOutParentNotification(booking, async (memberEmail, memberPhone, memberName, memberId) => {
      const html = parentEmailBuilder(getFirstName(memberName));
      await this.dispatchNotification({ userId: memberId, bookingId: booking.id, type: "EMAIL", channel: "booking_submitted", recipient: memberEmail,
        subject: `Your meeting with ${providerName} has been submitted`, body: html,
      });
      if (memberPhone) {
        await this.dispatchSmsTemplate({ userId: memberId, bookingId: booking.id, channel: "booking_submitted", recipient: memberPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_SUBMITTED_PARENT, contentVars: { "1": getFirstName(memberName), "2": providerName, "3": dateStr, "4": timeStr, "5": detailsLink },
        });
      }
    });

    await this.fanOutAdditionalAttendees(booking, async (ae, aeName, aePhone) => {
      const html = parentEmailBuilder(getFirstName(aeName) || ae.split("@")[0]);
      await this.dispatchNotification({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_submitted", recipient: ae,
        subject: `Your meeting with ${providerName} has been submitted`, body: html,
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, channel: "booking_submitted", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_SUBMITTED_PARENT, contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": dateStr, "4": timeStr, "5": detailsLink },
        });
      }
    });

    if (providerEmail && booking.confirmToken) {
      const manageLink = `${base}/booking/${booking.confirmToken}/manage`;
      const providerHtml = buildBrandedEmail(brandData, {
        title: "New Meeting Request",
        greeting: `Hi ${esc(getFirstName(providerUser?.name))},`,
        body: `<strong>${esc(attendeeName)}</strong> has requested a meeting with you.`,
        detailRows: [
          { label: "Date", value: dateStr },
          { label: "Time", value: timeStr },
          { label: "Duration", value: `${booking.duration} minutes` },
          { label: "Location", value: location },
          { label: "Client", value: esc(attendeeName) },
          ...(attendeeEmail ? [{ label: "Email", value: esc(attendeeEmail) }] : []),
          ...(booking.parentUser?.mobileNumber ? [{ label: "Phone", value: esc(booking.parentUser.mobileNumber) }] : []),
          ...(booking.notes ? [{ label: "Notes", value: esc(booking.notes) }] : []),
        ],
        alertBox: { text: "This meeting requires your confirmation. Please confirm, decline, or suggest a new time.", type: "warning" },
        buttons: [
          { label: "Confirm Meeting", url: manageLink },
          { label: "Suggest New Time", url: manageLink, variant: "secondary" },
          { label: "Decline", url: manageLink, variant: "destructive" },
        ],
      });
      await this.dispatchNotification({ userId: booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_request", recipient: providerEmail,
        subject: `New meeting request from ${attendeeName}`, body: providerHtml,
      });

      const providerPhone = providerUser?.mobileNumber;
      if (providerPhone) {
        await this.dispatchSmsTemplate({ userId: booking.providerUserId, bookingId: booking.id, channel: "booking_request", recipient: providerPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_REQUEST_PROVIDER, contentVars: { "1": getFirstName(providerUser?.name), "2": attendeeName, "3": dateStr, "4": timeStr, "5": manageLink },
        });
      }
    }
  }

  async sendBookingConfirmation(booking: any) {
    const providerUser = booking.providerUser || (await this.prisma.user.findUnique({ where: { id: booking.providerUserId } }));
    const attendeeEmail = booking.attendeeEmails?.[0] || booking.parentUser?.email;
    const attendeeName = booking.attendeeName || booking.parentUser?.name || attendeeEmail;
    const providerEmail = providerUser?.email;
    const providerName = providerUser?.provider?.name || providerUser?.name || "Provider";
    const staffMember = providerUser?.name || "";
    const scheduledAt = new Date(booking.scheduledAt);
    const base = getBaseUrl();
    const videoRoomLink = `${base}/room/${booking.id}`;
    const brandData = await this.getBrandData();
    const location = booking.meetingType === "phone" ? "Phone Call" : "Video Call";
    const dateStr = formatDate(scheduledAt, booking.bookerTimezone);
    const timeStr = formatTime(scheduledAt, booking.bookerTimezone);
    const detailsLink = `${base}/booking/${booking.publicToken}`;
    const joinLink = booking.meetingUrl || videoRoomLink;

    const parentEmailBuilder = (firstName: string) => buildBrandedEmail(brandData, {
      title: "Meeting Confirmed",
      greeting: `Hi ${esc(firstName)},`,
      body: `Great news! Your meeting with <strong>${esc(providerName)}</strong> has been confirmed.`,
      detailRows: [
        { label: "Date", value: dateStr },
        { label: "Time", value: timeStr },
        { label: "Duration", value: `${booking.duration} minutes` },
        { label: "Location", value: location },
        ...(staffMember ? [{ label: "With", value: esc(staffMember) }] : []),
      ],
      alertBox: { text: "Your meeting is confirmed! Make sure to join on time.", type: "success" },
      buttons: [
        ...(location === "Video Call" ? [{ label: "Join Meeting", url: joinLink }] : []),
        { label: "Reschedule", url: detailsLink, variant: "secondary" as const },
        { label: "Cancel", url: detailsLink, variant: "destructive" as const },
      ],
    });

    if (attendeeEmail) {
      const html = parentEmailBuilder(getFirstName(attendeeName));
      await this.dispatchNotification({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_confirmation", recipient: attendeeEmail,
        subject: `Your meeting with ${providerName} is confirmed`, body: html,
      });
      const details: Record<string, { name?: string; phone?: string }> = booking.attendeeDetails || {};
      const primaryDetails = details[attendeeEmail.toLowerCase()] || {};
      const parentPhone = booking.parentUser?.mobileNumber || primaryDetails.phone;
      if (parentPhone) {
        await this.dispatchSmsTemplate({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, channel: "booking_confirmation", recipient: parentPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CONFIRMED_PARENT, contentVars: { "1": getFirstName(attendeeName), "2": providerName, "3": dateStr, "4": timeStr, "5": joinLink },
        });
      }
    }

    await this.fanOutParentNotification(booking, async (memberEmail, memberPhone, memberName, memberId) => {
      const html = parentEmailBuilder(getFirstName(memberName));
      await this.dispatchNotification({ userId: memberId, bookingId: booking.id, type: "EMAIL", channel: "booking_confirmation", recipient: memberEmail,
        subject: `Your meeting with ${providerName} is confirmed`, body: html,
      });
      if (memberPhone) {
        await this.dispatchSmsTemplate({ userId: memberId, bookingId: booking.id, channel: "booking_confirmation", recipient: memberPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CONFIRMED_PARENT, contentVars: { "1": getFirstName(memberName), "2": providerName, "3": dateStr, "4": timeStr, "5": joinLink },
        });
      }
    });

    await this.fanOutAdditionalAttendees(booking, async (ae, aeName, aePhone) => {
      const html = parentEmailBuilder(getFirstName(aeName) || ae.split("@")[0]);
      await this.dispatchNotification({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_confirmation", recipient: ae,
        subject: `Your meeting with ${providerName} is confirmed`, body: html,
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, channel: "booking_confirmation", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CONFIRMED_PARENT, contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": dateStr, "4": timeStr, "5": joinLink },
        });
      }
    });

    if (providerEmail) {
      const providerHtml = buildBrandedEmail(brandData, {
        title: "Meeting Confirmed",
        greeting: `Hi ${esc(getFirstName(providerUser?.name))},`,
        body: `Your meeting with <strong>${esc(attendeeName)}</strong> has been confirmed.`,
        detailRows: [
          { label: "Date", value: dateStr },
          { label: "Time", value: timeStr },
          { label: "Duration", value: `${booking.duration} minutes` },
          { label: "Location", value: location },
          { label: "Client", value: esc(attendeeName) },
          ...(attendeeEmail ? [{ label: "Email", value: esc(attendeeEmail) }] : []),
        ],
        buttons: [
          ...(location === "Video Call" ? [{ label: "Start Meeting", url: videoRoomLink }] : []),
          { label: "Reschedule", url: detailsLink, variant: "secondary" as const },
          { label: "Cancel", url: detailsLink, variant: "destructive" as const },
        ],
      });
      await this.dispatchNotification({ userId: booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_confirmation", recipient: providerEmail,
        subject: `Meeting with ${attendeeName} confirmed`, body: providerHtml,
      });
      const providerPhone = providerUser?.mobileNumber;
      if (providerPhone) {
        await this.dispatchSmsTemplate({ userId: booking.providerUserId, bookingId: booking.id, channel: "booking_confirmation", recipient: providerPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CONFIRMED_PROVIDER, contentVars: { "1": getFirstName(providerUser?.name), "2": attendeeName, "3": dateStr, "4": timeStr, "5": joinLink },
        });
      }
    }

    await this.scheduleReminders(booking);
  }

  async sendBookingCancellation(booking: any, cancelledBy?: "parent" | "provider" | "gostork") {
    const providerUser = booking.providerUser || (await this.prisma.user.findUnique({ where: { id: booking.providerUserId } }));
    const attendeeEmail = booking.attendeeEmails?.[0] || booking.parentUser?.email;
    const attendeeName = booking.attendeeName || booking.parentUser?.name || attendeeEmail;
    const providerEmail = providerUser?.email;
    const providerName = providerUser?.provider?.name || providerUser?.name || "Provider";
    const scheduledAt = new Date(booking.scheduledAt);
    const base = getBaseUrl();
    const brandData = await this.getBrandData();
    const dateStr = formatDate(scheduledAt, booking.bookerTimezone);
    const timeStr = formatTime(scheduledAt, booking.bookerTimezone);
    const rebookLink = providerUser?.scheduleConfig?.bookingPageSlug ? `${base}/book/${providerUser.scheduleConfig.bookingPageSlug}` : base;

    const parentEmailBuilder = (firstName: string) => buildBrandedEmail(brandData, {
      title: "Meeting Cancelled",
      greeting: `Hi ${esc(firstName)},`,
      body: `Your meeting with <strong>${esc(providerName)}</strong> has been cancelled.`,
      detailRows: [
        { label: "Date", value: dateStr },
        { label: "Time", value: timeStr },
      ],
      alertBox: { text: "This meeting has been cancelled. You can book a new meeting at any time.", type: "warning" },
      buttons: [
        { label: "Book New Meeting", url: rebookLink },
      ],
    });

    if (attendeeEmail) {
      const html = parentEmailBuilder(getFirstName(attendeeName));
      await this.dispatchNotification({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_cancellation", recipient: attendeeEmail,
        subject: `Your meeting with ${providerName} has been cancelled`, body: html,
      });
      const cancelDetails: Record<string, { name?: string; phone?: string }> = booking.attendeeDetails || {};
      const cancelPrimaryDetails = cancelDetails[attendeeEmail.toLowerCase()] || {};
      const parentPhone = booking.parentUser?.mobileNumber || cancelPrimaryDetails.phone;
      if (parentPhone) {
        await this.dispatchSmsTemplate({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, channel: "booking_cancellation", recipient: parentPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CANCELLED_PARENT, contentVars: { "1": getFirstName(attendeeName), "2": providerName, "3": dateStr, "4": timeStr, "5": rebookLink },
        });
      }
    }

    await this.fanOutParentNotification(booking, async (memberEmail, memberPhone, memberName, memberId) => {
      const html = parentEmailBuilder(getFirstName(memberName));
      await this.dispatchNotification({ userId: memberId, bookingId: booking.id, type: "EMAIL", channel: "booking_cancellation", recipient: memberEmail,
        subject: `Your meeting with ${providerName} has been cancelled`, body: html,
      });
      if (memberPhone) {
        await this.dispatchSmsTemplate({ userId: memberId, bookingId: booking.id, channel: "booking_cancellation", recipient: memberPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CANCELLED_PARENT, contentVars: { "1": getFirstName(memberName), "2": providerName, "3": dateStr, "4": timeStr, "5": rebookLink },
        });
      }
    });

    await this.fanOutAdditionalAttendees(booking, async (ae, aeName, aePhone) => {
      const html = parentEmailBuilder(getFirstName(aeName) || ae.split("@")[0]);
      await this.dispatchNotification({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_cancellation", recipient: ae,
        subject: `Your meeting with ${providerName} has been cancelled`, body: html,
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, channel: "booking_cancellation", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CANCELLED_PARENT, contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": dateStr, "4": timeStr, "5": rebookLink },
        });
      }
    });

    if (providerEmail) {
      const providerHtml = buildBrandedEmail(brandData, {
        title: "Meeting Cancelled",
        greeting: `Hi ${esc(getFirstName(providerUser?.name))},`,
        body: `The meeting with <strong>${esc(attendeeName)}</strong> has been cancelled.`,
        detailRows: [
          { label: "Date", value: dateStr },
          { label: "Time", value: timeStr },
          { label: "Client", value: esc(attendeeName) },
          ...(attendeeEmail ? [{ label: "Email", value: esc(attendeeEmail) }] : []),
        ],
      });
      await this.dispatchNotification({ userId: booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_cancellation", recipient: providerEmail,
        subject: `Meeting with ${attendeeName} cancelled`, body: providerHtml,
      });
      const providerPhone = providerUser?.mobileNumber;
      if (providerPhone) {
        await this.dispatchSmsTemplate({ userId: booking.providerUserId, bookingId: booking.id, channel: "booking_cancellation", recipient: providerPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CANCELLED_PROVIDER, contentVars: { "1": getFirstName(providerUser?.name), "2": attendeeName, "3": dateStr, "4": timeStr },
        });
      }
    }
  }

  async sendBookingRescheduled(originalBooking: any, newBooking: any, message: string = "") {
    const providerUser = newBooking.providerUser || (await this.prisma.user.findUnique({ where: { id: newBooking.providerUserId } }));
    const attendeeEmail = newBooking.attendeeEmails?.[0] || newBooking.parentUser?.email;
    const attendeeName = newBooking.attendeeName || newBooking.parentUser?.name || attendeeEmail;
    const providerEmail = providerUser?.email;
    const providerName = providerUser?.provider?.name || providerUser?.name || "Provider";
    const staffMember = providerUser?.name || "";
    const oldDate = new Date(originalBooking.scheduledAt);
    const newDate = new Date(newBooking.scheduledAt);
    const base = getBaseUrl();
    const videoRoomLink = `${base}/room/${newBooking.id}`;
    const brandData = await this.getBrandData();
    const oldDateStr = formatDate(oldDate, newBooking.bookerTimezone);
    const oldTimeStr = formatTime(oldDate, newBooking.bookerTimezone);
    const newDateStr = formatDate(newDate, newBooking.bookerTimezone);
    const newTimeStr = formatTime(newDate, newBooking.bookerTimezone);
    const detailsLink = `${base}/booking/${newBooking.publicToken}`;
    const joinLink = newBooking.meetingUrl || videoRoomLink;

    const parentEmailBuilder = (firstName: string) => buildBrandedEmail(brandData, {
      title: "Meeting Rescheduled",
      greeting: `Hi ${esc(firstName)},`,
      body: `Your meeting with <strong>${esc(providerName)}</strong> has been rescheduled.${message ? `<br><br><em>"${esc(message)}"</em>` : ""}`,
      detailRows: [
        { label: "Previous", value: `${oldDateStr} at ${oldTimeStr}` },
        { label: "New Date", value: newDateStr },
        { label: "New Time", value: newTimeStr },
        { label: "Duration", value: `${newBooking.duration} minutes` },
        ...(staffMember ? [{ label: "With", value: esc(staffMember) }] : []),
      ],
      alertBox: { text: "Your meeting has been rescheduled to a new time.", type: "info" },
      buttons: [
        { label: "View Details", url: detailsLink },
        { label: "Reschedule", url: detailsLink, variant: "secondary" },
        { label: "Cancel", url: detailsLink, variant: "destructive" },
      ],
    });

    if (attendeeEmail) {
      const html = parentEmailBuilder(getFirstName(attendeeName));
      await this.dispatchNotification({ userId: newBooking.parentUserId || newBooking.providerUserId, bookingId: newBooking.id, type: "EMAIL", channel: "booking_rescheduled", recipient: attendeeEmail,
        subject: `Your meeting with ${providerName} has been rescheduled`, body: html,
      });
      const reschedDetails: Record<string, { name?: string; phone?: string }> = newBooking.attendeeDetails || {};
      const reschedPrimaryDetails = reschedDetails[attendeeEmail.toLowerCase()] || {};
      const parentPhone = newBooking.parentUser?.mobileNumber || reschedPrimaryDetails.phone;
      if (parentPhone) {
        const smsVars: Record<string, string> = { "1": getFirstName(attendeeName), "2": providerName, "3": newDateStr, "4": newTimeStr, "5": joinLink };
        if (message) { smsVars["6"] = message; }
        await this.dispatchSmsTemplate({ userId: newBooking.parentUserId || newBooking.providerUserId, bookingId: newBooking.id, channel: "booking_rescheduled", recipient: parentPhone,
          contentSid: message ? TWILIO_TEMPLATES.BOOKING_RESCHEDULED_PARENT_WITH_MSG : TWILIO_TEMPLATES.BOOKING_RESCHEDULED_PARENT, contentVars: smsVars,
        });
      }
    }

    await this.fanOutParentNotification(newBooking, async (memberEmail, memberPhone, memberName, memberId) => {
      const html = parentEmailBuilder(getFirstName(memberName));
      await this.dispatchNotification({ userId: memberId, bookingId: newBooking.id, type: "EMAIL", channel: "booking_rescheduled", recipient: memberEmail,
        subject: `Your meeting with ${providerName} has been rescheduled`, body: html,
      });
      if (memberPhone) {
        const smsVars: Record<string, string> = { "1": getFirstName(memberName), "2": providerName, "3": newDateStr, "4": newTimeStr, "5": joinLink };
        if (message) { smsVars["6"] = message; }
        await this.dispatchSmsTemplate({ userId: memberId, bookingId: newBooking.id, channel: "booking_rescheduled", recipient: memberPhone,
          contentSid: message ? TWILIO_TEMPLATES.BOOKING_RESCHEDULED_PARENT_WITH_MSG : TWILIO_TEMPLATES.BOOKING_RESCHEDULED_PARENT, contentVars: smsVars,
        });
      }
    });

    await this.fanOutAdditionalAttendees(newBooking, async (ae, aeName, aePhone) => {
      const html = parentEmailBuilder(getFirstName(aeName) || ae.split("@")[0]);
      await this.dispatchNotification({ userId: newBooking.parentUserId || newBooking.providerUserId, bookingId: newBooking.id, type: "EMAIL", channel: "booking_rescheduled", recipient: ae,
        subject: `Your meeting with ${providerName} has been rescheduled`, body: html,
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({ userId: newBooking.parentUserId || newBooking.providerUserId, bookingId: newBooking.id, channel: "booking_rescheduled", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_RESCHEDULED_PARENT, contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": newDateStr, "4": newTimeStr, "5": detailsLink },
        });
      }
    });

    if (providerEmail) {
      const providerHtml = buildBrandedEmail(brandData, {
        title: "Meeting Rescheduled",
        greeting: `Hi ${esc(getFirstName(providerUser?.name))},`,
        body: `The meeting with <strong>${esc(attendeeName)}</strong> has been rescheduled.`,
        detailRows: [
          { label: "Previous", value: `${oldDateStr} at ${oldTimeStr}` },
          { label: "New Date", value: newDateStr },
          { label: "New Time", value: newTimeStr },
          { label: "Duration", value: `${newBooking.duration} minutes` },
          { label: "Client", value: esc(attendeeName) },
          ...(attendeeEmail ? [{ label: "Email", value: esc(attendeeEmail) }] : []),
        ],
        buttons: [
          { label: "Start Meeting", url: videoRoomLink },
          { label: "Reschedule", url: detailsLink, variant: "secondary" },
          { label: "Cancel", url: detailsLink, variant: "destructive" },
        ],
      });
      await this.dispatchNotification({ userId: newBooking.providerUserId, bookingId: newBooking.id, type: "EMAIL", channel: "booking_rescheduled", recipient: providerEmail,
        subject: `Meeting with ${attendeeName} rescheduled`, body: providerHtml,
      });
      const providerPhone = providerUser?.mobileNumber;
      if (providerPhone) {
        await this.dispatchSmsTemplate({ userId: newBooking.providerUserId, bookingId: newBooking.id, channel: "booking_rescheduled", recipient: providerPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_RESCHEDULED_PROVIDER, contentVars: { "1": getFirstName(providerUser?.name), "2": attendeeName, "3": newDateStr, "4": newTimeStr, "5": joinLink },
        });
      }
    }
  }

  async sendBookingDeclinedToParent(booking: any) {
    const providerUser = booking.providerUser || (await this.prisma.user.findUnique({ where: { id: booking.providerUserId }, include: { scheduleConfig: { select: { bookingPageSlug: true } } } }));
    const attendeeEmail = booking.attendeeEmails?.[0] || booking.parentUser?.email;
    const attendeeName = booking.attendeeName || booking.parentUser?.name || attendeeEmail;
    const providerName = providerUser?.provider?.name || providerUser?.name || "Provider";
    const scheduledAt = new Date(booking.scheduledAt);
    const base = getBaseUrl();
    const brandData = await this.getBrandData();
    const dateStr = formatDate(scheduledAt, booking.bookerTimezone);
    const timeStr = formatTime(scheduledAt, booking.bookerTimezone);
    const rebookLink = providerUser?.scheduleConfig?.bookingPageSlug ? `${base}/book/${providerUser.scheduleConfig.bookingPageSlug}` : base;

    const parentEmailBuilder = (firstName: string) => buildBrandedEmail(brandData, {
      title: "Meeting Declined",
      greeting: `Hi ${esc(firstName)},`,
      body: `Unfortunately, <strong>${esc(providerName)}</strong> was unable to accommodate your meeting request.`,
      detailRows: [
        { label: "Date", value: dateStr },
        { label: "Time", value: timeStr },
      ],
      alertBox: { text: "Don't worry - you can book a new meeting at a different time.", type: "warning" },
      buttons: [
        { label: "Book New Meeting", url: rebookLink },
      ],
    });

    if (attendeeEmail) {
      const html = parentEmailBuilder(getFirstName(attendeeName));
      await this.dispatchNotification({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_declined", recipient: attendeeEmail,
        subject: `Your meeting request with ${providerName} was declined`, body: html,
      });
      const declineDetails: Record<string, { name?: string; phone?: string }> = booking.attendeeDetails || {};
      const declinePrimaryDetails = declineDetails[attendeeEmail.toLowerCase()] || {};
      const parentPhone = booking.parentUser?.mobileNumber || declinePrimaryDetails.phone;
      if (parentPhone) {
        await this.dispatchSmsTemplate({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, channel: "booking_declined", recipient: parentPhone,
          contentSid: TWILIO_TEMPLATES.MEETING_DECLINED_PARENT, contentVars: { "1": getFirstName(attendeeName), "2": providerName, "3": dateStr, "4": timeStr, "5": rebookLink },
        });
      }
    }

    await this.fanOutParentNotification(booking, async (memberEmail, memberPhone, memberName, memberId) => {
      const html = parentEmailBuilder(getFirstName(memberName));
      await this.dispatchNotification({ userId: memberId, bookingId: booking.id, type: "EMAIL", channel: "booking_declined", recipient: memberEmail,
        subject: `Your meeting request with ${providerName} was declined`, body: html,
      });
      if (memberPhone) {
        await this.dispatchSmsTemplate({ userId: memberId, bookingId: booking.id, channel: "booking_declined", recipient: memberPhone,
          contentSid: TWILIO_TEMPLATES.MEETING_DECLINED_PARENT, contentVars: { "1": getFirstName(memberName), "2": providerName, "3": dateStr, "4": timeStr, "5": rebookLink },
        });
      }
    });

    await this.fanOutAdditionalAttendees(booking, async (ae, aeName, aePhone) => {
      const html = parentEmailBuilder(getFirstName(aeName) || ae.split("@")[0]);
      await this.dispatchNotification({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_declined", recipient: ae,
        subject: `Your meeting request with ${providerName} was declined`, body: html,
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, channel: "booking_declined", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.MEETING_DECLINED_PARENT, contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": dateStr, "4": timeStr, "5": rebookLink },
        });
      }
    });
  }

  async sendNewTimeSuggested(originalBooking: any, suggestedBooking: any) {
    const newBooking = suggestedBooking;
    const providerUser = suggestedBooking.providerUser || (await this.prisma.user.findUnique({ where: { id: suggestedBooking.providerUserId } }));
    const attendeeEmail = suggestedBooking.attendeeEmails?.[0] || suggestedBooking.parentUser?.email;
    const attendeeName = suggestedBooking.attendeeName || suggestedBooking.parentUser?.name || attendeeEmail;
    const providerName = providerUser?.provider?.name || providerUser?.name || "Provider";
    const oldDate = new Date(originalBooking.scheduledAt);
    const newDate = new Date(suggestedBooking.scheduledAt);
    const base = getBaseUrl();
    const brandData = await this.getBrandData();

    let providerMessage = "";
    if (suggestedBooking.notes && originalBooking.notes) {
      const originalNotes = originalBooking.notes as string;
      const newNotes = suggestedBooking.notes as string;
      if (newNotes !== originalNotes && newNotes.endsWith(originalNotes)) {
        providerMessage = newNotes.slice(0, newNotes.length - originalNotes.length).replace(/\n\n$/, "").trim();
      } else if (newNotes !== originalNotes) {
        providerMessage = newNotes.trim();
      }
    } else if (suggestedBooking.notes && !originalBooking.notes) {
      providerMessage = (suggestedBooking.notes as string).trim();
    }

    const oldDateStr = formatDate(oldDate, newBooking.bookerTimezone);
    const oldTimeStr = formatTime(oldDate, newBooking.bookerTimezone);
    const newDateStr = formatDate(newDate, newBooking.bookerTimezone);
    const newTimeStr = formatTime(newDate, newBooking.bookerTimezone);
    const acceptLink = `${base}/booking/${suggestedBooking.confirmToken}/confirm`;
    const declineLink = `${base}/booking/${suggestedBooking.confirmToken}/decline`;

    const parentEmailBuilder = (firstName: string) => buildBrandedEmail(brandData, {
      title: "New Time Suggested",
      greeting: `Hi ${esc(firstName)},`,
      body: `<strong>${esc(providerName)}</strong> has suggested a new time for your meeting.${providerMessage ? `<br><br><em>"${esc(providerMessage)}"</em>` : ""}`,
      detailRows: [
        { label: "Original", value: `${oldDateStr} at ${oldTimeStr}` },
        { label: "New Date", value: newDateStr },
        { label: "New Time", value: newTimeStr },
        { label: "Duration", value: `${suggestedBooking.duration} minutes` },
      ],
      alertBox: { text: "Please review the suggested time and accept or decline.", type: "info" },
      buttons: [
        { label: "Accept New Time", url: acceptLink },
        { label: "Decline", url: declineLink, variant: "destructive" },
      ],
    });

    if (attendeeEmail) {
      const html = parentEmailBuilder(getFirstName(attendeeName));
      await this.dispatchNotification({ userId: suggestedBooking.parentUserId || suggestedBooking.providerUserId, bookingId: suggestedBooking.id, type: "EMAIL", channel: "booking_new_time", recipient: attendeeEmail,
        subject: `${providerName} suggested a new meeting time`, body: html,
      });
      const parentPhone = suggestedBooking.parentUser?.mobileNumber;
      if (parentPhone) {
        const smsVars: Record<string, string> = { "1": getFirstName(attendeeName), "2": providerName, "3": newDateStr, "4": newTimeStr, "5": acceptLink };
        if (providerMessage) { smsVars["6"] = providerMessage; }
        await this.dispatchSmsTemplate({ userId: suggestedBooking.parentUserId || suggestedBooking.providerUserId, bookingId: suggestedBooking.id, channel: "booking_new_time", recipient: parentPhone,
          contentSid: providerMessage ? TWILIO_TEMPLATES.NEW_TIME_SUGGESTED_PARENT_WITH_MSG : TWILIO_TEMPLATES.NEW_TIME_SUGGESTED_PARENT, contentVars: smsVars,
        });
      }
    }

    await this.fanOutParentNotification(suggestedBooking, async (memberEmail, memberPhone, memberName, memberId) => {
      const html = parentEmailBuilder(getFirstName(memberName));
      await this.dispatchNotification({ userId: memberId, bookingId: suggestedBooking.id, type: "EMAIL", channel: "booking_new_time", recipient: memberEmail,
        subject: `${providerName} suggested a new meeting time`, body: html,
      });
      if (memberPhone) {
        const smsVars: Record<string, string> = { "1": getFirstName(memberName), "2": providerName, "3": newDateStr, "4": newTimeStr, "5": acceptLink };
        if (providerMessage) { smsVars["6"] = providerMessage; }
        await this.dispatchSmsTemplate({ userId: memberId, bookingId: suggestedBooking.id, channel: "booking_new_time", recipient: memberPhone,
          contentSid: providerMessage ? TWILIO_TEMPLATES.NEW_TIME_SUGGESTED_PARENT_WITH_MSG : TWILIO_TEMPLATES.NEW_TIME_SUGGESTED_PARENT, contentVars: smsVars,
        });
      }
    });

    await this.fanOutAdditionalAttendees(suggestedBooking, async (ae, aeName, aePhone) => {
      const html = parentEmailBuilder(getFirstName(aeName) || ae.split("@")[0]);
      await this.dispatchNotification({ userId: suggestedBooking.parentUserId || suggestedBooking.providerUserId, bookingId: suggestedBooking.id, type: "EMAIL", channel: "booking_new_time", recipient: ae,
        subject: `${providerName} suggested a new meeting time`, body: html,
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({ userId: suggestedBooking.parentUserId || suggestedBooking.providerUserId, bookingId: suggestedBooking.id, channel: "booking_new_time", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.NEW_TIME_SUGGESTED_PARENT, contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": newDateStr, "4": newTimeStr, "5": acceptLink },
        });
      }
    });
  }

  async sendCalendarReconnectionAlert(user: {
    id: string;
    email: string;
    name?: string | null;
    mobileNumber?: string | null;
    providerName?: string | null;
    calendarLabel?: string | null;
    calendarEmail?: string | null;
  }) {
    const base = getBaseUrl();
    const reconnectLink = `${base}/account/calendar?connect=true`;
    const fullName = user.name || "Team Member";
    const providerName = user.providerName || "";
    const calendarName = user.calendarLabel || user.calendarEmail || "your calendar";
    const brandData = await this.getBrandData();

    const adminEmails = await this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" }, isDisabled: false },
      select: { email: true },
    });
    const bccList = adminEmails.map((a) => a.email).filter((e) => e !== user.email);

    const html = buildBrandedEmail(brandData, {
      title: "Calendar Reconnection Required",
      greeting: `Hi ${esc(getFirstName(user.name))},`,
      body: `Your calendar connection (<strong>${esc(calendarName)}</strong>) has been disconnected${providerName ? ` for ${esc(providerName)}` : ""}. Please reconnect it to continue receiving booking updates.`,
      alertBox: { text: "Your calendar is disconnected. New bookings won't sync until you reconnect.", type: "error" },
      buttons: [
        { label: "Reconnect Calendar", url: reconnectLink },
      ],
    });

    await this.dispatchNotification({
      userId: user.id, type: "EMAIL", channel: "calendar_reconnection", recipient: user.email,
      subject: "Action Required: Reconnect Your Calendar", body: html, bcc: bccList,
    });

    if (user.mobileNumber) {
      await this.dispatchSmsTemplate({ userId: user.id, channel: "calendar_reconnection", recipient: user.mobileNumber,
        contentSid: TWILIO_TEMPLATES.CALENDAR_RECONNECTION, contentVars: { "1": getFirstName(user.name), "2": fullName, "3": providerName || "GoStork", "4": reconnectLink },
      });
    }
  }

  async sendVideoWaitingNotification(params: {
    booking: any;
    joinerRole: "provider" | "parent";
  }) {
    const { booking, joinerRole } = params;
    const providerUser = booking.providerUser || (await this.prisma.user.findUnique({
      where: { id: booking.providerUserId },
      include: { provider: { select: { name: true } } },
    }));
    const attendeeName = booking.attendeeName || booking.parentUser?.name || booking.attendeeEmails?.[0] || "Your client";
    const providerName = providerUser?.provider?.name || providerUser?.name || "Your provider";
    const staffMember = providerUser?.name || "";
    const base = getBaseUrl();
    const roomLink = `${base}/room/${booking.id}`;
    const brandData = await this.getBrandData();

    if (joinerRole === "provider") {
      const parentEmail = booking.attendeeEmails?.[0] || booking.parentUser?.email;
      const waitingDetails: Record<string, { name?: string; phone?: string }> = booking.attendeeDetails || {};
      const waitingPrimaryDetails = parentEmail ? (waitingDetails[parentEmail.toLowerCase()] || {}) : {};
      const parentPhone = booking.parentUser?.mobileNumber || waitingPrimaryDetails.phone;

      if (parentEmail) {
        const html = buildBrandedEmail(brandData, {
          title: "Your Meeting is Starting",
          greeting: `Hi ${esc(getFirstName(attendeeName))},`,
          body: `<strong>${esc(staffMember || providerName)}</strong> is waiting for you in the video room. Join now!`,
          alertBox: { text: "Your provider is in the meeting room and waiting for you.", type: "success" },
          buttons: [{ label: "Join Now", url: roomLink }],
        });
        await this.dispatchNotification({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "video_waiting", recipient: parentEmail,
          subject: `${staffMember || providerName} is waiting for you`, body: html,
        });
      }
      if (parentPhone) {
        await this.dispatchSmsTemplate({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, channel: "video_waiting", recipient: parentPhone,
          contentSid: TWILIO_TEMPLATES.VIDEO_WAITING_PARENT, contentVars: { "1": getFirstName(attendeeName), "2": staffMember, "3": providerName, "4": roomLink },
        });
      }
    } else {
      const providerEmail = providerUser?.email;
      const providerPhone = providerUser?.mobileNumber;

      if (providerEmail) {
        const html = buildBrandedEmail(brandData, {
          title: "Client Waiting in Meeting Room",
          greeting: `Hi ${esc(getFirstName(staffMember))},`,
          body: `<strong>${esc(attendeeName)}</strong> has joined the video room and is waiting for you.`,
          alertBox: { text: "Your client is in the meeting room. Please join as soon as possible.", type: "warning" },
          buttons: [{ label: "Join Now", url: roomLink }],
        });
        await this.dispatchNotification({ userId: booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "video_waiting", recipient: providerEmail,
          subject: `${attendeeName} is waiting in the meeting room`, body: html,
        });
      }
      if (providerPhone) {
        await this.dispatchSmsTemplate({ userId: booking.providerUserId, bookingId: booking.id, channel: "video_waiting", recipient: providerPhone,
          contentSid: TWILIO_TEMPLATES.VIDEO_WAITING_PROVIDER, contentVars: { "1": getFirstName(staffMember), "2": attendeeName, "3": roomLink },
        });
      }
    }
  }

  async sendMemberInvitation(
    inviterName: string,
    newUser: { id: string; email: string; name?: string | null; mobileNumber?: string | null },
    tempPassword: string,
  ) {
    const base = getBaseUrl();
    const loginLink = `${base}/login`;
    const brandData = await this.getBrandData();

    const html = buildBrandedEmail(brandData, {
      title: "You've Been Invited",
      greeting: `Hi ${esc(getFirstName(newUser.name) || "there")},`,
      body: `<strong>${esc(inviterName)}</strong> has invited you to join ${esc(brandData.companyName)}. Use the credentials below to log in.`,
      detailRows: [
        { label: "Email", value: esc(newUser.email) },
        { label: "Password", value: esc(tempPassword) },
      ],
      alertBox: { text: "Please change your password after your first login.", type: "info" },
      buttons: [{ label: "Log In", url: loginLink }],
    });

    await this.dispatchNotification({ userId: newUser.id, type: "EMAIL", channel: "member_invitation", recipient: newUser.email,
      subject: `${inviterName} invited you to ${brandData.companyName}`, body: html,
    });

    if (newUser.mobileNumber) {
      await this.dispatchSmsTemplate({ userId: newUser.id, channel: "member_invitation", recipient: newUser.mobileNumber,
        contentSid: TWILIO_TEMPLATES.MEMBER_INVITATION, contentVars: { "1": inviterName, "2": loginLink },
      });
    }
  }

  async sendRecordingReady(booking: any) {
    const providerUser = booking.providerUser || (await this.prisma.user.findUnique({ where: { id: booking.providerUserId } }));
    const providerEmail = providerUser?.email;
    const parentUser = booking.parentUser || (booking.parentUserId ? await this.prisma.user.findUnique({ where: { id: booking.parentUserId } }) : null);
    const scheduledAt = new Date(booking.scheduledAt);
    const base = getBaseUrl();
    const brandData = await this.getBrandData();
    const recordingLink = `${base}/recordings/${booking.id}`;
    const meetingSubject = booking.subject || "Consultation";
    const meetingDate = formatDate(scheduledAt, booking.bookerTimezone);

    const buildRecordingEmail = (firstName: string) => buildBrandedEmail(brandData, {
      title: "Recording Ready",
      greeting: `Hi ${esc(firstName)},`,
      body: `The recording from your meeting <strong>${esc(meetingSubject)}</strong> on ${esc(meetingDate)} is now available to view.`,
      buttons: [
        { label: "View Recording", url: recordingLink },
      ],
    });

    if (providerEmail) {
      const html = buildRecordingEmail(getFirstName(providerUser?.name));
      await this.dispatchNotification({
        userId: booking.providerUserId,
        bookingId: booking.id,
        type: "EMAIL",
        channel: "recording_ready",
        recipient: providerEmail,
        subject: `Recording ready: ${meetingSubject} - ${meetingDate}`,
        body: html,
      });
    }

    if (parentUser?.email) {
      const html = buildRecordingEmail(getFirstName(parentUser.name));
      await this.dispatchNotification({
        userId: parentUser.id,
        bookingId: booking.id,
        type: "EMAIL",
        channel: "recording_ready",
        recipient: parentUser.email,
        subject: `Recording ready: ${meetingSubject} - ${meetingDate}`,
        body: html,
      });
    }

    await this.fanOutParentNotification(booking, async (memberEmail, memberPhone, memberName, memberId) => {
      const html = buildRecordingEmail(getFirstName(memberName));
      await this.dispatchNotification({
        userId: memberId,
        bookingId: booking.id,
        type: "EMAIL",
        channel: "recording_ready",
        recipient: memberEmail,
        subject: `Recording ready: ${meetingSubject} - ${meetingDate}`,
        body: html,
      });
    });

    this.logger.log(`Recording ready notifications sent for booking ${booking.id}`);
  }

  async getParentAccountMembers(parentUserId: string): Promise<Array<{ id: string; email: string; name: string | null; mobileNumber: string | null; parentAccountRole: string | null }>> {
    const user = await this.prisma.user.findUnique({
      where: { id: parentUserId },
      select: { parentAccountId: true },
    });
    if (!user?.parentAccountId) return [];
    const members = await this.prisma.user.findMany({
      where: {
        parentAccountId: user.parentAccountId,
        id: { not: parentUserId },
        isDisabled: false,
      },
      select: { id: true, email: true, name: true, mobileNumber: true, parentAccountRole: true },
    });
    return members;
  }

  private async fanOutParentNotification(
    booking: any,
    sendFn: (memberEmail: string, memberPhone: string | null, memberName: string | null, memberId: string) => Promise<void>,
  ) {
    if (!booking.parentUserId) return;
    try {
      const members = await this.getParentAccountMembers(booking.parentUserId);
      for (const member of members) {
        try {
          await sendFn(member.email, member.mobileNumber, member.name, member.id);
        } catch (e: any) {
          this.logger.warn(`Fan-out notification failed for member ${member.id}: ${e.message}`);
        }
      }
    } catch (e: any) {
      this.logger.warn(`Fan-out lookup failed: ${e.message}`);
    }
  }

  private async fanOutAdditionalAttendees(
    booking: any,
    sendFn: (attendeeEmail: string, attendeeName: string | null, attendeePhone: string | null) => Promise<void>,
  ) {
    const emails: string[] = booking.attendeeEmails || [];
    if (emails.length <= 1) return;
    const primaryEmail = emails[0]?.toLowerCase();
    const parentMembers = booking.parentUserId
      ? await this.getParentAccountMembers(booking.parentUserId)
      : [];
    const parentMemberEmails = new Set(parentMembers.map((m) => m.email.toLowerCase()));
    const parentEmail = booking.parentUser?.email?.toLowerCase();

    const details: Record<string, { name?: string; phone?: string }> = booking.attendeeDetails || {};

    for (let i = 1; i < emails.length; i++) {
      const ae = emails[i].toLowerCase();
      if (ae === primaryEmail || ae === parentEmail || parentMemberEmails.has(ae)) continue;
      const info = details[ae] || {};
      try {
        await sendFn(ae, info.name || null, info.phone || null);
      } catch (e: any) {
        this.logger.warn(`Additional attendee notification failed for ${ae}: ${e.message}`);
      }
    }
  }

  private async scheduleReminders(booking: any) {
    const scheduledAt = new Date(booking.scheduledAt);
    const attendeeEmail = booking.attendeeEmails?.[0] || booking.parentUser?.email;
    const providerUser = booking.providerUser || (await this.prisma.user.findUnique({ where: { id: booking.providerUserId } }));
    const providerEmail = providerUser?.email;

    const now = new Date();
    const offsets = [
      { ms: 24 * 60 * 60 * 1000, label: "24h" },
      { ms: 60 * 60 * 1000, label: "1h" },
      { ms: 5 * 60 * 1000, label: "5min" },
    ];

    for (const offset of offsets) {
      const reminderTime = new Date(scheduledAt.getTime() - offset.ms);
      if (reminderTime <= now) continue;

      if (attendeeEmail) {
        await this.prisma.notification.create({
          data: {
            userId: booking.parentUserId || booking.providerUserId,
            bookingId: booking.id,
            type: "EMAIL",
            channel: "booking_reminder",
            recipient: attendeeEmail,
            status: "pending",
            scheduledFor: reminderTime,
          },
        });
      }

      if (providerEmail) {
        await this.prisma.notification.create({
          data: {
            userId: booking.providerUserId,
            bookingId: booking.id,
            type: "EMAIL",
            channel: "booking_reminder",
            recipient: providerEmail,
            status: "pending",
            scheduledFor: reminderTime,
          },
        });
      }

      const reminderDetails: Record<string, { name?: string; phone?: string }> = booking.attendeeDetails || {};
      const reminderPrimaryDetails = attendeeEmail ? (reminderDetails[attendeeEmail.toLowerCase()] || {}) : {};
      const parentPhone = booking.parentUser?.mobileNumber || reminderPrimaryDetails.phone;
      if (parentPhone) {
        await this.prisma.notification.create({
          data: {
            userId: booking.parentUserId || booking.providerUserId,
            bookingId: booking.id,
            type: "SMS",
            channel: "booking_reminder",
            recipient: parentPhone,
            status: "pending",
            scheduledFor: reminderTime,
          },
        });
      }

      const providerPhone = providerUser?.mobileNumber;
      if (providerPhone) {
        await this.prisma.notification.create({
          data: {
            userId: booking.providerUserId,
            bookingId: booking.id,
            type: "SMS",
            channel: "booking_reminder",
            recipient: providerPhone,
            status: "pending",
            scheduledFor: reminderTime,
          },
        });
      }

      const members = booking.parentUserId ? await this.getParentAccountMembers(booking.parentUserId) : [];
      for (const member of members) {
        if (member.email) {
          await this.prisma.notification.create({
            data: { userId: member.id, bookingId: booking.id, type: "EMAIL", channel: "booking_reminder", recipient: member.email, status: "pending", scheduledFor: reminderTime },
          });
        }
        if (member.mobileNumber) {
          await this.prisma.notification.create({
            data: { userId: member.id, bookingId: booking.id, type: "SMS", channel: "booking_reminder", recipient: member.mobileNumber, status: "pending", scheduledFor: reminderTime },
          });
        }
      }

      const additionalEmails: string[] = booking.attendeeEmails || [];
      if (additionalEmails.length > 1) {
        const primaryLower = additionalEmails[0]?.toLowerCase();
        const parentEmail = booking.parentUser?.email?.toLowerCase();
        const memberEmailSet = new Set(members.map((m: any) => m.email.toLowerCase()));
        for (let i = 1; i < additionalEmails.length; i++) {
          const ae = additionalEmails[i].toLowerCase();
          if (ae === primaryLower || ae === parentEmail || memberEmailSet.has(ae)) continue;
          await this.prisma.notification.create({
            data: { userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_reminder", recipient: ae, status: "pending", scheduledFor: reminderTime },
          });
        }
      }
    }
  }

  async processReminders() {
    const now = new Date();
    let pendingReminders: any[];
    try {
      pendingReminders = await this.prisma.notification.findMany({
        where: {
          channel: "booking_reminder",
          status: "pending",
          scheduledFor: { lte: now },
        },
        include: {
          booking: {
            include: {
              providerUser: { select: { id: true, name: true, email: true, mobileNumber: true, providerId: true, provider: { select: { name: true } } } },
              parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
            },
          },
          user: { select: { id: true, name: true, email: true } },
        },
        take: 50,
      });
    } catch (dbErr: any) {
      const msg = dbErr.message || "";
      if (msg.includes("MaxClientsInSessionMode") || msg.includes("pool") || msg.includes("ECONNREFUSED")) {
        this.logger.warn(`Reminder scheduler skipped cycle (DB connection issue): ${msg}`);
      } else {
        this.logger.error(`Reminder query failed: ${msg}`);
      }
      return 0;
    }

    let processed = 0;
    for (const reminder of pendingReminders) {
      if (!reminder.booking || reminder.booking.status === "CANCELLED" || reminder.booking.status === "RESCHEDULED") {
        await this.prisma.notification.update({
          where: { id: reminder.id },
          data: { status: "skipped", sentAt: new Date() },
        });
        continue;
      }

      try {
        const booking = reminder.booking;
        const scheduledAt = new Date(booking.scheduledAt);
        const providerName = booking.providerUser?.provider?.name || booking.providerUser?.name || "Provider";
        const attendeeName = booking.attendeeName || booking.parentUser?.name || "";
        const base = getBaseUrl();
        const timeDiff = scheduledAt.getTime() - now.getTime();
        let reminderLabel = "is coming up";
        if (timeDiff <= 6 * 60 * 1000) reminderLabel = "starts in 5 minutes";
        else if (timeDiff <= 90 * 60 * 1000) reminderLabel = "is in 1 hour";
        else reminderLabel = "is tomorrow";

        const isProvider = reminder.recipient === booking.providerUser?.email || reminder.recipient === booking.providerUser?.mobileNumber;

        if (reminder.type === "EMAIL") {
          const brandData = await this.getBrandData();
          const reminderVideoRoomLink = `${base}/room/${booking.id}`;
          const dateStr = formatDate(scheduledAt, booking.bookerTimezone);
          const timeStr = formatTime(scheduledAt, booking.bookerTimezone);
          const detailsLink = `${base}/booking/${booking.publicToken}`;
          const joinLink = booking.meetingUrl || reminderVideoRoomLink;
          const location = booking.meetingType === "phone" ? "Phone Call" : "Video Call";
          const staffMember = booking.providerUser?.name || "";

          let html: string;
          let subject: string;
          if (isProvider) {
            subject = `Reminder: Your meeting with ${attendeeName} ${reminderLabel}`;
            html = buildBrandedEmail(brandData, {
              title: "Meeting Reminder",
              greeting: `Hi ${esc(getFirstName(booking.providerUser?.name))},`,
              body: `This is a reminder that your meeting with <strong>${esc(attendeeName)}</strong> ${reminderLabel}.`,
              detailRows: [
                { label: "Date", value: dateStr },
                { label: "Time", value: timeStr },
                { label: "Duration", value: `${booking.duration} minutes` },
                { label: "Client", value: esc(attendeeName) },
                ...(booking.attendeeEmails?.[0] ? [{ label: "Email", value: esc(booking.attendeeEmails[0]) }] : []),
              ],
              buttons: [
                ...(location === "Video Call" ? [{ label: "Start Meeting", url: joinLink }] : []),
                { label: "Reschedule", url: detailsLink, variant: "secondary" as const },
                { label: "Cancel", url: detailsLink, variant: "destructive" as const },
              ],
            });
          } else {
            subject = `Reminder: Your meeting with ${providerName} ${reminderLabel}`;
            html = buildBrandedEmail(brandData, {
              title: "Meeting Reminder",
              greeting: `Hi ${esc(getFirstName(attendeeName))},`,
              body: `This is a reminder that your meeting with <strong>${esc(providerName)}</strong> ${reminderLabel}.`,
              detailRows: [
                { label: "Date", value: dateStr },
                { label: "Time", value: timeStr },
                { label: "Duration", value: `${booking.duration} minutes` },
                { label: "Location", value: location },
                ...(staffMember ? [{ label: "With", value: esc(staffMember) }] : []),
              ],
              buttons: [
                ...(location === "Video Call" ? [{ label: "Join Meeting", url: joinLink }] : []),
                { label: "Reschedule", url: detailsLink, variant: "secondary" as const },
                { label: "Cancel", url: detailsLink, variant: "destructive" as const },
              ],
            });
          }

          await this.sendRawEmail(reminder.recipient, subject, html);
        } else if (reminder.type === "SMS") {
          const otherPartyName = isProvider ? attendeeName : providerName;
          await this.sendSmsWithTemplate(
            reminder.recipient,
            TWILIO_TEMPLATES.BOOKING_REMINDER,
            {
              "1": getFirstName(isProvider ? booking.providerUser?.name : attendeeName),
              "2": otherPartyName,
              "3": reminderLabel,
              "4": booking.meetingUrl || `${base}/booking/${booking.publicToken}`,
            },
          );
        }

        await this.prisma.notification.update({
          where: { id: reminder.id },
          data: { status: "sent", sentAt: new Date() },
        });
        processed++;
      } catch (error: any) {
        this.logger.warn(`Reminder send failed: ${error.message}`);
        await this.prisma.notification.update({
          where: { id: reminder.id },
          data: { status: "failed" },
        });
      }
    }

    if (processed > 0) {
      this.logger.log(`Processed ${processed} reminders`);
    }
    return pendingReminders.length;
  }

  private async dispatchNotification(params: {
    userId: string;
    bookingId?: string;
    type: "EMAIL" | "SMS";
    channel: NotificationChannel;
    recipient: string;
    templateId?: string;
    templateData?: Record<string, string>;
    subject?: string;
    body?: string;
    bcc?: string[];
  }) {
    const notification = await this.prisma.notification.create({
      data: {
        userId: params.userId,
        bookingId: params.bookingId || null,
        type: params.type,
        channel: params.channel,
        recipient: params.recipient,
        status: "pending",
      },
    });

    try {
      if (params.type === "EMAIL") {
        if (params.templateId) {
          await this.sendTemplateEmail(params.recipient, params.templateId, params.templateData || {}, params.bcc ? { bcc: params.bcc } : undefined);
        } else {
          await this.sendRawEmail(params.recipient, params.subject || "", params.body || "");
        }
      }

      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { status: "sent", sentAt: new Date() },
      });
    } catch (error: any) {
      this.logger.warn(`Notification dispatch failed for ${params.type} to ${params.recipient}: ${error.message}`);
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { status: "failed" },
      });
    }
  }

  private async dispatchSmsTemplate(params: {
    userId: string;
    bookingId?: string;
    channel: NotificationChannel;
    recipient: string;
    contentSid: string;
    contentVars: Record<string, string>;
  }) {
    const notification = await this.prisma.notification.create({
      data: {
        userId: params.userId,
        bookingId: params.bookingId || null,
        type: "SMS",
        channel: params.channel,
        recipient: params.recipient,
        status: "pending",
      },
    });

    try {
      await this.sendSmsWithTemplate(params.recipient, params.contentSid, params.contentVars);
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { status: "sent", sentAt: new Date() },
      });
    } catch (error: any) {
      this.logger.warn(`SMS dispatch failed to ${params.recipient}: ${error.message}`);
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { status: "failed" },
      });
    }
  }

  private async sendTemplateEmail(to: string, templateId: string, dynamicData: Record<string, string>, opts?: { bcc?: string[] }) {
    const sendgridKey = process.env.SENDGRID_API_KEY;
    if (!sendgridKey) {
      this.logger.log(`[EMAIL MOCK] To: ${to}, Template: ${templateId}, Data: ${JSON.stringify(dynamicData)}${opts?.bcc ? `, BCC: ${opts.bcc.join(",")}` : ""}`);
      return;
    }

    const brandData = await this.getBrandData();
    const mergedData = { ...brandData, ...dynamicData };

    const personalization: any = {
      to: [{ email: to }],
      dynamic_template_data: mergedData,
    };
    if (opts?.bcc && opts.bcc.length > 0) {
      personalization.bcc = opts.bcc.map((e) => ({ email: e }));
    }

    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sendgridKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [personalization],
        from: { email: process.env.SENDGRID_FROM_EMAIL || "noreply@gostork.com", name: brandData.companyName },
        template_id: templateId,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`SendGrid error: ${response.status} - ${text}`);
    }
  }

  async sendPasswordResetEmail(email: string, userName: string | null, resetLink: string) {
    const brandData = await this.getBrandData();
    const companyName = brandData.companyName;
    const firstName = userName ? getFirstName(userName) : "there";

    const html = buildBrandedEmail(brandData, {
      title: "Reset Your Password",
      greeting: `Hi ${firstName},`,
      body: `We received a request to reset your password. Click the button below to create a new password. This link will expire in 1 hour.`,
      buttons: [{ label: "Reset Password", url: resetLink }],
      footer: `If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.<br><br>If the button doesn't work, copy and paste this link into your browser:<br><a href="${resetLink}" style="color:${brandData.brandColor};word-break:break-all;">${resetLink}</a>`,
    });

    await this.sendRawEmail(email, `Reset Your ${companyName} Password`, html);
  }

  private async sendRawEmail(to: string, subject: string, body: string) {
    const sendgridKey = process.env.SENDGRID_API_KEY;
    if (!sendgridKey) {
      this.logger.log(`[EMAIL MOCK] To: ${to}, Subject: ${subject}`);
      return;
    }

    const senderName = await this.getCompanyName();
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sendgridKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: process.env.SENDGRID_FROM_EMAIL || "noreply@gostork.com", name: senderName },
        subject,
        content: [{ type: "text/html", value: body }],
      }),
    });

    if (!response.ok) {
      throw new Error(`SendGrid error: ${response.status}`);
    }
  }

  private async sendSmsWithTemplate(to: string, contentSid: string, contentVars: Record<string, string>) {
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

    if (!twilioSid || !twilioToken || !twilioFrom) {
      this.logger.log(`[SMS MOCK] To: ${to}, ContentSid: ${contentSid}, Vars: ${JSON.stringify(contentVars)}`);
      return;
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
    const params = new URLSearchParams({
      To: to,
      From: twilioFrom,
      ContentSid: contentSid,
      ContentVariables: JSON.stringify(contentVars),
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Twilio error: ${response.status} - ${text}`);
    }
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async sendCostSheetSubmitted(params: {
    providerName: string;
    providerId: string;
    version: number;
    submitterEmail: string;
    submitterName: string;
  }) {
    const brandData = await this.getBrandData();
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" } },
      select: { id: true, email: true },
    });
    const providerName = this.escapeHtml(params.providerName);
    const submitterName = this.escapeHtml(params.submitterName);
    const submitterEmail = this.escapeHtml(params.submitterEmail);
    const reviewUrl = `${getBaseUrl()}/admin/providers/${params.providerId}?tab=costs`;
    const subject = `Cost Sheet Submitted - ${params.providerName} (v${params.version})`;
    const html = buildBrandedEmail(brandData, {
      title: "New Cost Sheet Submitted",
      greeting: `<strong>${providerName}</strong> has submitted a cost sheet for review.`,
      body: "",
      detailRows: [
        { label: "Submitted by", value: `${submitterName} (${submitterEmail})` },
        { label: "Version", value: `${params.version}` },
      ],
      buttons: [{ label: "Review Cost Sheet", url: reviewUrl }],
    });

    for (const admin of admins) {
      await this.dispatchNotification({
        userId: admin.id,
        type: "EMAIL",
        channel: "cost_sheet_submitted",
        recipient: admin.email,
        subject,
        body: html,
      });
    }
  }

  async sendCostSheetApproved(params: {
    providerName: string;
    providerUserEmails: string[];
    version: number;
  }) {
    const brandData = await this.getBrandData();
    const providerName = this.escapeHtml(params.providerName);
    const viewUrl = `${getBaseUrl()}/account/costs`;
    const subject = `Cost Sheet Approved - Now Live`;
    const html = buildBrandedEmail(brandData, {
      title: "Cost Sheet Approved",
      greeting: `Great news! Your cost sheet (v${params.version}) for <strong>${providerName}</strong> has been approved by the admin team.`,
      body: "Parents browsing the marketplace will see your latest pricing immediately.",
      alertBox: { text: "Your updated costs are now live on your profile.", type: "success" },
      buttons: [{ label: "View Your Cost Sheet", url: viewUrl }],
    });

    for (const email of params.providerUserEmails) {
      const user = await this.prisma.user.findFirst({ where: { email } });
      if (user) {
        await this.dispatchNotification({
          userId: user.id,
          type: "EMAIL",
          channel: "cost_sheet_approved",
          recipient: email,
          subject,
          body: html,
        });
      }
    }
  }

  async sendCostSheetRejected(params: {
    providerName: string;
    providerUserEmails: string[];
    feedback: string;
    version: number;
  }) {
    const brandData = await this.getBrandData();
    const providerName = this.escapeHtml(params.providerName);
    const feedback = this.escapeHtml(params.feedback);
    const viewUrl = `${getBaseUrl()}/account/costs`;
    const subject = `Cost Sheet Rejected - Action Required`;
    const html = buildBrandedEmail(brandData, {
      title: "Cost Sheet Rejected",
      greeting: `Your cost sheet (v${params.version}) for <strong>${providerName}</strong> has been rejected by the admin team.`,
      body: `<strong>Admin Feedback:</strong><br>${feedback}`,
      alertBox: { text: `<strong>Admin Feedback:</strong> ${feedback}`, type: "error" },
      buttons: [{ label: "Revise Cost Sheet", url: viewUrl }],
    });

    for (const email of params.providerUserEmails) {
      const user = await this.prisma.user.findFirst({ where: { email } });
      if (user) {
        await this.dispatchNotification({
          userId: user.id,
          type: "EMAIL",
          channel: "cost_sheet_rejected",
          recipient: email,
          subject,
          body: html,
        });
      }
    }
  }

  async sendHumanEscalationNotification(params: {
    parentName: string;
    parentEmail: string;
    parentPhone?: string | null;
    parentUserId: string;
    sessionId: string;
    profileDetails: { label: string; value: string }[];
  }) {
    const brandData = await this.getBrandData();
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" } },
      select: { id: true, email: true, mobileNumber: true },
    });
    const parentName = this.escapeHtml(params.parentName);
    const chatUrl = `${getBaseUrl()}/admin/concierge-monitor?sessionId=${params.sessionId}`;
    const subject = `Human Assistance Requested - ${params.parentName}`;
    const html = buildBrandedEmail(brandData, {
      title: "Parent Requesting Human Assistance",
      greeting: `<strong>${parentName}</strong> has requested to speak with a human concierge.`,
      body: "Here is everything we know about this parent so far:",
      detailRows: params.profileDetails.map(d => ({
        label: this.escapeHtml(d.label),
        value: this.escapeHtml(d.value),
      })),
      alertBox: { text: "Please join the chat as soon as possible to assist this parent.", type: "warning" },
      buttons: [{ label: "Join Chat Now", url: chatUrl }],
    });

    for (const admin of admins) {
      // Send email
      this.dispatchNotification({
        userId: admin.id,
        type: "EMAIL",
        channel: "human_escalation",
        recipient: admin.email,
        subject,
        body: html,
      }).catch(e => this.logger.error(`Failed to send escalation email to ${admin.email}: ${e.message}`));

      // Send SMS if admin has a phone number
      if (admin.mobileNumber) {
        this.sendRawSms(
          admin.mobileNumber,
          `${brandData.companyName} Alert: ${params.parentName} (${params.parentEmail}) is requesting human assistance in the AI concierge. Join the chat: ${chatUrl}`,
        ).catch(e => this.logger.error(`Failed to send escalation SMS to ${admin.mobileNumber}: ${e.message}`));
      }
    }
  }

  private async sendRawSms(to: string, body: string) {
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

    if (!twilioSid || !twilioToken || !twilioFrom) {
      this.logger.log(`[SMS MOCK] To: ${to}, Body: ${body}`);
      return;
    }

    // Normalize to E.164 format - add +1 for US numbers without country code
    let normalizedTo = to.replace(/[\s\-\(\)]/g, "");
    if (!normalizedTo.startsWith("+")) {
      normalizedTo = `+1${normalizedTo}`;
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
    const params = new URLSearchParams({ To: normalizedTo, From: twilioFrom, Body: body });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Twilio error: ${response.status} - ${text}`);
    }
  }
}
