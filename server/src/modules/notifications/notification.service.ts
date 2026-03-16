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
  | "cost_sheet_rejected";

const SENDGRID_TEMPLATES = {
  BOOKING_SUBMITTED_PARENT: "d-4384e4c09fb64e92bb05e5658c57893c",
  BOOKING_REQUEST_PROVIDER: "d-e2437b8055c64f8db0a577d691cfd01f",
  BOOKING_CONFIRMED_PARENT: "d-4b37ca0d1a114dda8e9372a8614055a6",
  BOOKING_CONFIRMED_PROVIDER: "d-6ed7b16b58c047ea8433544eef3d8b25",
  BOOKING_CANCELLED_PARENT: "d-ed61237a5f3e448e8761d754f760dfd0",
  BOOKING_CANCELLED_PROVIDER: "d-fbebfc18f6dd4b68ae52ca066cae4a76",
  BOOKING_RESCHEDULED_PARENT: "d-ba2512c071f74241805f2f987011ebc0",
  BOOKING_RESCHEDULED_PROVIDER: "d-5d3bd4d458454e5a851753a2d1eea8c8",
  BOOKING_REMINDER_PARENT: "d-32c08ebc87934a89ab4e27408a42710a",
  BOOKING_REMINDER_PROVIDER: "d-33d33b56da404a21853977d3ff08e3ac",
  MEETING_DECLINED_PARENT: "d-5da5879df4ae4cfd9ed9c7e8251f5243",
  NEW_TIME_SUGGESTED_PARENT: "d-bb2a04d6800641ed8111b3c1e27b549c",
  CALENDAR_RECONNECTION: "d-61a10d14449b432187b40ef74dff109a",
  VIDEO_WAITING_PARENT: "d-5ea2aeb3d5b04aca8fdba4692aaaeadd",
  VIDEO_WAITING_PROVIDER: "d-4820b728f2e1441cb07360de8646115e",
  MEMBER_INVITATION: "d-47a18c5cfdf14af581a572f3529e90b2",
  RECORDING_READY: "d-9fdb56ce9e804deb9f70cc22ac57e615",
};

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
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.REPLIT_DEPLOYMENT_URL) return `https://${process.env.REPLIT_DEPLOYMENT_URL}`;
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  if (process.env.REPL_SLUG) return `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
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
      secondaryColor: "#F0FAF5",
      accentColor: "#0DA4EA",
      successColor: "#16a34a",
      warningColor: "#f59e0b",
      errorColor: "#ef4444",
      companyName: "GoStork",
      logoUrl: "",
      headingFont: "Playfair Display",
      bodyFont: "DM Sans",
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
        defaults.logoUrl = s.logoWithNameUrl || s.logoUrl || "";
        defaults.headingFont = s.headingFont || defaults.headingFont;
        defaults.bodyFont = s.bodyFont || defaults.bodyFont;
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
        this.logger.error(`Reminder processing failed: ${e.message}`);
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
    const videoRoomLink = `${base}/room/${booking.id}`;

    if (attendeeEmail) {
      await this.dispatchNotification({
        userId: booking.parentUserId || booking.providerUserId,
        bookingId: booking.id,
        type: "EMAIL",
        channel: "booking_submitted",
        recipient: attendeeEmail,
        templateId: SENDGRID_TEMPLATES.BOOKING_SUBMITTED_PARENT,
        templateData: {
          firstName: getFirstName(attendeeName),
          providerName,
          staffMember,
          subject: booking.subject || "",
          date: formatDate(scheduledAt, booking.bookerTimezone),
          time: formatTime(scheduledAt, booking.bookerTimezone),
          duration: String(booking.duration),
          location: booking.meetingType === "phone" ? "Phone Call" : "Video Call",
          meetingLink: booking.meetingUrl || "",
          videoRoomLink: "",
          rescheduleLink: `${base}/booking/${booking.publicToken}`,
          cancelLink: `${base}/booking/${booking.publicToken}`,
          bookingDetailsLink: `${base}/booking/${booking.publicToken}`,
        },
      });

      const submittedDetails: Record<string, { name?: string; phone?: string }> = booking.attendeeDetails || {};
      const submittedPrimaryDetails = submittedDetails[attendeeEmail.toLowerCase()] || {};
      const parentPhone = booking.parentUser?.mobileNumber || submittedPrimaryDetails.phone;
      if (parentPhone) {
        await this.dispatchSmsTemplate({
          userId: booking.parentUserId || booking.providerUserId,
          bookingId: booking.id,
          channel: "booking_submitted",
          recipient: parentPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_SUBMITTED_PARENT,
          contentVars: {
            "1": getFirstName(attendeeName),
            "2": providerName,
            "3": formatDate(scheduledAt, booking.bookerTimezone),
            "4": formatTime(scheduledAt, booking.bookerTimezone),
            "5": `${base}/booking/${booking.publicToken}`,
          },
        });
      }
    }

    await this.fanOutParentNotification(booking, async (memberEmail, memberPhone, memberName, memberId) => {
      await this.dispatchNotification({
        userId: memberId, bookingId: booking.id, type: "EMAIL", channel: "booking_submitted", recipient: memberEmail,
        templateId: SENDGRID_TEMPLATES.BOOKING_SUBMITTED_PARENT,
        templateData: {
          firstName: getFirstName(memberName), providerName, staffMember, subject: booking.subject || "",
          date: formatDate(scheduledAt, booking.bookerTimezone), time: formatTime(scheduledAt, booking.bookerTimezone), duration: String(booking.duration),
          location: booking.meetingType === "phone" ? "Phone Call" : "Video Call",
          meetingLink: booking.meetingUrl || "", videoRoomLink: "", rescheduleLink: `${base}/booking/${booking.publicToken}`,
          cancelLink: `${base}/booking/${booking.publicToken}`, bookingDetailsLink: `${base}/booking/${booking.publicToken}`,
        },
      });
      if (memberPhone) {
        await this.dispatchSmsTemplate({
          userId: memberId, bookingId: booking.id, channel: "booking_submitted", recipient: memberPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_SUBMITTED_PARENT,
          contentVars: { "1": getFirstName(memberName), "2": providerName, "3": formatDate(scheduledAt, booking.bookerTimezone), "4": formatTime(scheduledAt, booking.bookerTimezone), "5": `${base}/booking/${booking.publicToken}` },
        });
      }
    });

    await this.fanOutAdditionalAttendees(booking, async (ae, aeName, aePhone) => {
      await this.dispatchNotification({
        userId: booking.parentUserId || booking.providerUserId,
        bookingId: booking.id, type: "EMAIL", channel: "booking_submitted", recipient: ae,
        templateId: SENDGRID_TEMPLATES.BOOKING_SUBMITTED_PARENT,
        templateData: {
          firstName: getFirstName(aeName) || ae.split("@")[0], providerName, staffMember, subject: booking.subject || "",
          date: formatDate(scheduledAt, booking.bookerTimezone), time: formatTime(scheduledAt, booking.bookerTimezone), duration: String(booking.duration),
          location: booking.meetingType === "phone" ? "Phone Call" : "Video Call",
          meetingLink: booking.meetingUrl || "", videoRoomLink: "", rescheduleLink: `${base}/booking/${booking.publicToken}`,
          cancelLink: `${base}/booking/${booking.publicToken}`, bookingDetailsLink: `${base}/booking/${booking.publicToken}`,
        },
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({
          userId: booking.parentUserId || booking.providerUserId,
          bookingId: booking.id, channel: "booking_submitted", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_SUBMITTED_PARENT,
          contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": formatDate(scheduledAt, booking.bookerTimezone), "4": formatTime(scheduledAt, booking.bookerTimezone), "5": `${base}/booking/${booking.publicToken}` },
        });
      }
    });

    if (providerEmail && booking.confirmToken) {
      await this.dispatchNotification({
        userId: booking.providerUserId,
        bookingId: booking.id,
        type: "EMAIL",
        channel: "booking_request",
        recipient: providerEmail,
        templateId: SENDGRID_TEMPLATES.BOOKING_REQUEST_PROVIDER,
        templateData: {
          firstName: getFirstName(providerUser?.name),
          parentName: attendeeName,
          parentEmail: attendeeEmail || "",
          parentPhone: booking.parentUser?.mobileNumber || "",
          subject: booking.subject || "",
          date: formatDate(scheduledAt, booking.bookerTimezone),
          time: formatTime(scheduledAt, booking.bookerTimezone),
          duration: String(booking.duration),
          location: booking.meetingType === "phone" ? "Phone Call" : "Video Call",
          meetingLink: booking.meetingUrl || "",
          videoRoomLink,
          buttonText: "START MEETING",
          notes: booking.notes || "",
          confirmLink: `${base}/booking/${booking.confirmToken}/manage`,
          declineLink: `${base}/booking/${booking.confirmToken}/manage`,
          suggestLink: `${base}/booking/${booking.confirmToken}/manage`,
          providerName,
          staffMember,
        },
      });

      const providerPhone = providerUser?.mobileNumber;
      if (providerPhone) {
        await this.dispatchSmsTemplate({
          userId: booking.providerUserId,
          bookingId: booking.id,
          channel: "booking_request",
          recipient: providerPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_REQUEST_PROVIDER,
          contentVars: {
            "1": getFirstName(providerUser?.name),
            "2": attendeeName,
            "3": formatDate(scheduledAt, booking.bookerTimezone),
            "4": formatTime(scheduledAt, booking.bookerTimezone),
            "5": `${base}/booking/${booking.confirmToken}/manage`,
          },
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

    if (attendeeEmail) {
      await this.dispatchNotification({
        userId: booking.parentUserId || booking.providerUserId,
        bookingId: booking.id,
        type: "EMAIL",
        channel: "booking_confirmation",
        recipient: attendeeEmail,
        templateId: SENDGRID_TEMPLATES.BOOKING_CONFIRMED_PARENT,
        templateData: {
          firstName: getFirstName(attendeeName),
          providerName,
          staffMember,
          subject: booking.subject || "",
          date: formatDate(scheduledAt, booking.bookerTimezone),
          time: formatTime(scheduledAt, booking.bookerTimezone),
          duration: String(booking.duration),
          location: booking.meetingType === "phone" ? "Phone Call" : "Video Call",
          meetingLink: booking.meetingUrl || "",
          videoRoomLink,
          buttonText: "JOIN MEETING",
          rescheduleLink: `${base}/booking/${booking.publicToken}`,
          cancelLink: `${base}/booking/${booking.publicToken}`,
          bookingDetailsLink: `${base}/booking/${booking.publicToken}`,
        },
      });

      const details: Record<string, { name?: string; phone?: string }> = booking.attendeeDetails || {};
      const primaryDetails = details[attendeeEmail.toLowerCase()] || {};
      const parentPhone = booking.parentUser?.mobileNumber || primaryDetails.phone;
      if (parentPhone) {
        await this.dispatchSmsTemplate({
          userId: booking.parentUserId || booking.providerUserId,
          bookingId: booking.id,
          channel: "booking_confirmation",
          recipient: parentPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CONFIRMED_PARENT,
          contentVars: {
            "1": getFirstName(attendeeName),
            "2": providerName,
            "3": formatDate(scheduledAt, booking.bookerTimezone),
            "4": formatTime(scheduledAt, booking.bookerTimezone),
            "5": booking.meetingUrl || `${base}/booking/${booking.publicToken}`,
          },
        });
      }
    }

    await this.fanOutParentNotification(booking, async (memberEmail, memberPhone, memberName, memberId) => {
      await this.dispatchNotification({
        userId: memberId, bookingId: booking.id, type: "EMAIL", channel: "booking_confirmation", recipient: memberEmail,
        templateId: SENDGRID_TEMPLATES.BOOKING_CONFIRMED_PARENT,
        templateData: {
          firstName: getFirstName(memberName), providerName, staffMember, subject: booking.subject || "",
          date: formatDate(scheduledAt, booking.bookerTimezone), time: formatTime(scheduledAt, booking.bookerTimezone), duration: String(booking.duration),
          location: booking.meetingType === "phone" ? "Phone Call" : "Video Call",
          meetingLink: booking.meetingUrl || "", videoRoomLink, buttonText: "JOIN MEETING",
          rescheduleLink: `${base}/booking/${booking.publicToken}`, cancelLink: `${base}/booking/${booking.publicToken}`,
          bookingDetailsLink: `${base}/booking/${booking.publicToken}`,
        },
      });
      if (memberPhone) {
        await this.dispatchSmsTemplate({
          userId: memberId, bookingId: booking.id, channel: "booking_confirmation", recipient: memberPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CONFIRMED_PARENT,
          contentVars: { "1": getFirstName(memberName), "2": providerName, "3": formatDate(scheduledAt, booking.bookerTimezone), "4": formatTime(scheduledAt, booking.bookerTimezone), "5": booking.meetingUrl || `${base}/booking/${booking.publicToken}` },
        });
      }
    });

    await this.fanOutAdditionalAttendees(booking, async (ae, aeName, aePhone) => {
      await this.dispatchNotification({
        userId: booking.parentUserId || booking.providerUserId,
        bookingId: booking.id, type: "EMAIL", channel: "booking_confirmation", recipient: ae,
        templateId: SENDGRID_TEMPLATES.BOOKING_CONFIRMED_PARENT,
        templateData: {
          firstName: getFirstName(aeName) || ae.split("@")[0], providerName, staffMember, subject: booking.subject || "",
          date: formatDate(scheduledAt, booking.bookerTimezone), time: formatTime(scheduledAt, booking.bookerTimezone), duration: String(booking.duration),
          location: booking.meetingType === "phone" ? "Phone Call" : "Video Call",
          meetingLink: booking.meetingUrl || "", videoRoomLink, buttonText: "JOIN MEETING",
          rescheduleLink: `${base}/booking/${booking.publicToken}`, cancelLink: `${base}/booking/${booking.publicToken}`,
          bookingDetailsLink: `${base}/booking/${booking.publicToken}`,
        },
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({
          userId: booking.parentUserId || booking.providerUserId,
          bookingId: booking.id, channel: "booking_confirmation", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CONFIRMED_PARENT,
          contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": formatDate(scheduledAt, booking.bookerTimezone), "4": formatTime(scheduledAt, booking.bookerTimezone), "5": booking.meetingUrl || `${base}/booking/${booking.publicToken}` },
        });
      }
    });

    if (providerEmail) {
      await this.dispatchNotification({
        userId: booking.providerUserId,
        bookingId: booking.id,
        type: "EMAIL",
        channel: "booking_confirmation",
        recipient: providerEmail,
        templateId: SENDGRID_TEMPLATES.BOOKING_CONFIRMED_PROVIDER,
        templateData: {
          firstName: getFirstName(providerUser?.name),
          parentName: attendeeName,
          parentEmail: attendeeEmail || "",
          subject: booking.subject || "",
          date: formatDate(scheduledAt, booking.bookerTimezone),
          time: formatTime(scheduledAt, booking.bookerTimezone),
          duration: String(booking.duration),
          location: booking.meetingType === "phone" ? "Phone Call" : "Video Call",
          meetingLink: booking.meetingUrl || "",
          videoRoomLink,
          buttonText: "START MEETING",
          rescheduleLink: `${base}/booking/${booking.publicToken}`,
          cancelLink: `${base}/booking/${booking.publicToken}`,
          providerName,
        },
      });

      const providerPhone = providerUser?.mobileNumber;
      if (providerPhone) {
        await this.dispatchSmsTemplate({
          userId: booking.providerUserId,
          bookingId: booking.id,
          channel: "booking_confirmation",
          recipient: providerPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CONFIRMED_PROVIDER,
          contentVars: {
            "1": getFirstName(providerUser?.name),
            "2": attendeeName,
            "3": formatDate(scheduledAt, booking.bookerTimezone),
            "4": formatTime(scheduledAt, booking.bookerTimezone),
            "5": booking.meetingUrl || `${base}/booking/${booking.publicToken}`,
          },
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
    const staffMember = providerUser?.name || "";
    const scheduledAt = new Date(booking.scheduledAt);
    const base = getBaseUrl();

    if (attendeeEmail) {
      await this.dispatchNotification({
        userId: booking.parentUserId || booking.providerUserId,
        bookingId: booking.id,
        type: "EMAIL",
        channel: "booking_cancellation",
        recipient: attendeeEmail,
        templateId: SENDGRID_TEMPLATES.BOOKING_CANCELLED_PARENT,
        templateData: {
          firstName: getFirstName(attendeeName),
          providerName,
          staffMember,
          date: formatDate(scheduledAt, booking.bookerTimezone),
          time: formatTime(scheduledAt, booking.bookerTimezone),
          rebookLink: providerUser?.scheduleConfig?.bookingPageSlug ? `${base}/book/${providerUser.scheduleConfig.bookingPageSlug}` : base,
        },
      });

      const cancelDetails: Record<string, { name?: string; phone?: string }> = booking.attendeeDetails || {};
      const cancelPrimaryDetails = cancelDetails[attendeeEmail.toLowerCase()] || {};
      const parentPhone = booking.parentUser?.mobileNumber || cancelPrimaryDetails.phone;
      if (parentPhone) {
        await this.dispatchSmsTemplate({
          userId: booking.parentUserId || booking.providerUserId,
          bookingId: booking.id,
          channel: "booking_cancellation",
          recipient: parentPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CANCELLED_PARENT,
          contentVars: {
            "1": getFirstName(attendeeName),
            "2": providerName,
            "3": formatDate(scheduledAt, booking.bookerTimezone),
            "4": formatTime(scheduledAt, booking.bookerTimezone),
            "5": providerUser?.scheduleConfig?.bookingPageSlug ? `${base}/book/${providerUser.scheduleConfig.bookingPageSlug}` : base,
          },
        });
      }
    }

    const cancelRebookLink = providerUser?.scheduleConfig?.bookingPageSlug ? `${base}/book/${providerUser.scheduleConfig.bookingPageSlug}` : base;
    await this.fanOutParentNotification(booking, async (memberEmail, memberPhone, memberName, memberId) => {
      await this.dispatchNotification({
        userId: memberId, bookingId: booking.id, type: "EMAIL", channel: "booking_cancellation", recipient: memberEmail,
        templateId: SENDGRID_TEMPLATES.BOOKING_CANCELLED_PARENT,
        templateData: {
          firstName: getFirstName(memberName), providerName, staffMember,
          date: formatDate(scheduledAt, booking.bookerTimezone), time: formatTime(scheduledAt, booking.bookerTimezone), rebookLink: cancelRebookLink,
        },
      });
      if (memberPhone) {
        await this.dispatchSmsTemplate({
          userId: memberId, bookingId: booking.id, channel: "booking_cancellation", recipient: memberPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CANCELLED_PARENT,
          contentVars: { "1": getFirstName(memberName), "2": providerName, "3": formatDate(scheduledAt, booking.bookerTimezone), "4": formatTime(scheduledAt, booking.bookerTimezone), "5": cancelRebookLink },
        });
      }
    });

    await this.fanOutAdditionalAttendees(booking, async (ae, aeName, aePhone) => {
      await this.dispatchNotification({
        userId: booking.parentUserId || booking.providerUserId,
        bookingId: booking.id, type: "EMAIL", channel: "booking_cancellation", recipient: ae,
        templateId: SENDGRID_TEMPLATES.BOOKING_CANCELLED_PARENT,
        templateData: {
          firstName: getFirstName(aeName) || ae.split("@")[0], providerName, staffMember,
          date: formatDate(scheduledAt, booking.bookerTimezone), time: formatTime(scheduledAt, booking.bookerTimezone), rebookLink: cancelRebookLink,
        },
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({
          userId: booking.parentUserId || booking.providerUserId,
          bookingId: booking.id, channel: "booking_cancellation", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CANCELLED_PARENT,
          contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": formatDate(scheduledAt, booking.bookerTimezone), "4": formatTime(scheduledAt, booking.bookerTimezone), "5": cancelRebookLink },
        });
      }
    });

    if (providerEmail) {
      await this.dispatchNotification({
        userId: booking.providerUserId,
        bookingId: booking.id,
        type: "EMAIL",
        channel: "booking_cancellation",
        recipient: providerEmail,
        templateId: SENDGRID_TEMPLATES.BOOKING_CANCELLED_PROVIDER,
        templateData: {
          firstName: getFirstName(providerUser?.name),
          parentName: attendeeName,
          parentEmail: attendeeEmail || "",
          date: formatDate(scheduledAt, booking.bookerTimezone),
          time: formatTime(scheduledAt, booking.bookerTimezone),
          providerName,
        },
      });

      const providerPhone = providerUser?.mobileNumber;
      if (providerPhone) {
        await this.dispatchSmsTemplate({
          userId: booking.providerUserId,
          bookingId: booking.id,
          channel: "booking_cancellation",
          recipient: providerPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CANCELLED_PROVIDER,
          contentVars: {
            "1": getFirstName(providerUser?.name),
            "2": attendeeName,
            "3": formatDate(scheduledAt, booking.bookerTimezone),
            "4": formatTime(scheduledAt, booking.bookerTimezone),
          },
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

    if (attendeeEmail) {
      await this.dispatchNotification({
        userId: newBooking.parentUserId || newBooking.providerUserId,
        bookingId: newBooking.id,
        type: "EMAIL",
        channel: "booking_rescheduled",
        recipient: attendeeEmail,
        templateId: SENDGRID_TEMPLATES.BOOKING_RESCHEDULED_PARENT,
        templateData: {
          firstName: getFirstName(attendeeName),
          providerName,
          staffMember,
          subject: newBooking.subject || "",
          oldDate: formatDate(oldDate, newBooking.bookerTimezone),
          oldTime: formatTime(oldDate, newBooking.bookerTimezone),
          date: formatDate(newDate, newBooking.bookerTimezone),
          time: formatTime(newDate, newBooking.bookerTimezone),
          duration: String(newBooking.duration),
          meetingLink: newBooking.meetingUrl || "",
          videoRoomLink,
          buttonText: "JOIN MEETING",
          message: message || "",
          rescheduleLink: `${base}/booking/${newBooking.publicToken}`,
          cancelLink: `${base}/booking/${newBooking.publicToken}`,
        },
      });

      const reschedDetails: Record<string, { name?: string; phone?: string }> = newBooking.attendeeDetails || {};
      const reschedPrimaryDetails = reschedDetails[attendeeEmail.toLowerCase()] || {};
      const parentPhone = newBooking.parentUser?.mobileNumber || reschedPrimaryDetails.phone;
      if (parentPhone) {
        if (message) {
          await this.dispatchSmsTemplate({
            userId: newBooking.parentUserId || newBooking.providerUserId,
            bookingId: newBooking.id,
            channel: "booking_rescheduled",
            recipient: parentPhone,
            contentSid: TWILIO_TEMPLATES.BOOKING_RESCHEDULED_PARENT_WITH_MSG,
            contentVars: {
              "1": getFirstName(attendeeName),
              "2": providerName,
              "3": formatDate(newDate, newBooking.bookerTimezone),
              "4": formatTime(newDate, newBooking.bookerTimezone),
              "5": newBooking.meetingUrl || `${base}/booking/${newBooking.publicToken}`,
              "6": message,
            },
          });
        } else {
          await this.dispatchSmsTemplate({
            userId: newBooking.parentUserId || newBooking.providerUserId,
            bookingId: newBooking.id,
            channel: "booking_rescheduled",
            recipient: parentPhone,
            contentSid: TWILIO_TEMPLATES.BOOKING_RESCHEDULED_PARENT,
            contentVars: {
              "1": getFirstName(attendeeName),
              "2": providerName,
              "3": formatDate(newDate, newBooking.bookerTimezone),
              "4": formatTime(newDate, newBooking.bookerTimezone),
              "5": newBooking.meetingUrl || `${base}/booking/${newBooking.publicToken}`,
            },
          });
        }
      }
    }

    await this.fanOutParentNotification(newBooking, async (memberEmail, memberPhone, memberName, memberId) => {
      await this.dispatchNotification({
        userId: memberId, bookingId: newBooking.id, type: "EMAIL", channel: "booking_rescheduled", recipient: memberEmail,
        templateId: SENDGRID_TEMPLATES.BOOKING_RESCHEDULED_PARENT,
        templateData: {
          firstName: getFirstName(memberName), providerName, staffMember, subject: newBooking.subject || "",
          oldDate: formatDate(oldDate, newBooking.bookerTimezone), oldTime: formatTime(oldDate, newBooking.bookerTimezone), date: formatDate(newDate, newBooking.bookerTimezone), time: formatTime(newDate, newBooking.bookerTimezone),
          duration: String(newBooking.duration), meetingLink: newBooking.meetingUrl || "", videoRoomLink, buttonText: "JOIN MEETING", message: message || "",
          rescheduleLink: `${base}/booking/${newBooking.publicToken}`, cancelLink: `${base}/booking/${newBooking.publicToken}`,
        },
      });
      if (memberPhone) {
        if (message) {
          await this.dispatchSmsTemplate({
            userId: memberId, bookingId: newBooking.id, channel: "booking_rescheduled", recipient: memberPhone,
            contentSid: TWILIO_TEMPLATES.BOOKING_RESCHEDULED_PARENT_WITH_MSG,
            contentVars: { "1": getFirstName(memberName), "2": providerName, "3": formatDate(newDate, newBooking.bookerTimezone), "4": formatTime(newDate, newBooking.bookerTimezone), "5": newBooking.meetingUrl || `${base}/booking/${newBooking.publicToken}`, "6": message },
          });
        } else {
          await this.dispatchSmsTemplate({
            userId: memberId, bookingId: newBooking.id, channel: "booking_rescheduled", recipient: memberPhone,
            contentSid: TWILIO_TEMPLATES.BOOKING_RESCHEDULED_PARENT,
            contentVars: { "1": getFirstName(memberName), "2": providerName, "3": formatDate(newDate, newBooking.bookerTimezone), "4": formatTime(newDate, newBooking.bookerTimezone), "5": newBooking.meetingUrl || `${base}/booking/${newBooking.publicToken}` },
          });
        }
      }
    });

    await this.fanOutAdditionalAttendees(newBooking, async (ae, aeName, aePhone) => {
      await this.dispatchNotification({
        userId: newBooking.parentUserId || newBooking.providerUserId,
        bookingId: newBooking.id, type: "EMAIL", channel: "booking_rescheduled", recipient: ae,
        templateId: SENDGRID_TEMPLATES.BOOKING_RESCHEDULED_PARENT,
        templateData: {
          firstName: getFirstName(aeName) || ae.split("@")[0], providerName, staffMember, subject: newBooking.subject || "",
          oldDate: formatDate(oldDate, newBooking.bookerTimezone), oldTime: formatTime(oldDate, newBooking.bookerTimezone), date: formatDate(newDate, newBooking.bookerTimezone), time: formatTime(newDate, newBooking.bookerTimezone),
          duration: String(newBooking.duration), meetingLink: newBooking.meetingUrl || "", videoRoomLink, buttonText: "JOIN MEETING", message: message || "",
          rescheduleLink: `${base}/booking/${newBooking.publicToken}`, cancelLink: `${base}/booking/${newBooking.publicToken}`,
        },
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({
          userId: newBooking.parentUserId || newBooking.providerUserId,
          bookingId: newBooking.id, channel: "booking_rescheduled", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_RESCHEDULED_PARENT,
          contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": formatDate(newDate, newBooking.bookerTimezone), "4": formatTime(newDate, newBooking.bookerTimezone), "5": `${base}/booking/${newBooking.publicToken}` },
        });
      }
    });

    if (providerEmail) {
      await this.dispatchNotification({
        userId: newBooking.providerUserId,
        bookingId: newBooking.id,
        type: "EMAIL",
        channel: "booking_rescheduled",
        recipient: providerEmail,
        templateId: SENDGRID_TEMPLATES.BOOKING_RESCHEDULED_PROVIDER,
        templateData: {
          firstName: getFirstName(providerUser?.name),
          parentName: attendeeName,
          parentEmail: attendeeEmail || "",
          subject: newBooking.subject || "",
          oldDate: formatDate(oldDate, newBooking.bookerTimezone),
          oldTime: formatTime(oldDate, newBooking.bookerTimezone),
          date: formatDate(newDate, newBooking.bookerTimezone),
          time: formatTime(newDate, newBooking.bookerTimezone),
          duration: String(newBooking.duration),
          meetingLink: newBooking.meetingUrl || "",
          videoRoomLink,
          buttonText: "START MEETING",
          rescheduleLink: `${base}/booking/${newBooking.publicToken}`,
          cancelLink: `${base}/booking/${newBooking.publicToken}`,
          providerName,
        },
      });

      const providerPhone = providerUser?.mobileNumber;
      if (providerPhone) {
        await this.dispatchSmsTemplate({
          userId: newBooking.providerUserId,
          bookingId: newBooking.id,
          channel: "booking_rescheduled",
          recipient: providerPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_RESCHEDULED_PROVIDER,
          contentVars: {
            "1": getFirstName(providerUser?.name),
            "2": attendeeName,
            "3": formatDate(newDate, newBooking.bookerTimezone),
            "4": formatTime(newDate, newBooking.bookerTimezone),
            "5": newBooking.meetingUrl || `${base}/booking/${newBooking.publicToken}`,
          },
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
    const rebookLink = providerUser?.scheduleConfig?.bookingPageSlug ? `${base}/book/${providerUser.scheduleConfig.bookingPageSlug}` : base;

    if (attendeeEmail) {
      await this.dispatchNotification({
        userId: booking.parentUserId || booking.providerUserId,
        bookingId: booking.id,
        type: "EMAIL",
        channel: "booking_declined",
        recipient: attendeeEmail,
        templateId: SENDGRID_TEMPLATES.MEETING_DECLINED_PARENT,
        templateData: {
          firstName: getFirstName(attendeeName),
          providerName,
          date: formatDate(scheduledAt, booking.bookerTimezone),
          time: formatTime(scheduledAt, booking.bookerTimezone),
          rebookLink,
        },
      });

      const declineDetails: Record<string, { name?: string; phone?: string }> = booking.attendeeDetails || {};
      const declinePrimaryDetails = declineDetails[attendeeEmail.toLowerCase()] || {};
      const parentPhone = booking.parentUser?.mobileNumber || declinePrimaryDetails.phone;
      if (parentPhone) {
        await this.dispatchSmsTemplate({
          userId: booking.parentUserId || booking.providerUserId,
          bookingId: booking.id,
          channel: "booking_declined",
          recipient: parentPhone,
          contentSid: TWILIO_TEMPLATES.MEETING_DECLINED_PARENT,
          contentVars: {
            "1": getFirstName(attendeeName),
            "2": providerName,
            "3": formatDate(scheduledAt, booking.bookerTimezone),
            "4": formatTime(scheduledAt, booking.bookerTimezone),
            "5": rebookLink,
          },
        });
      }
    }

    await this.fanOutParentNotification(booking, async (memberEmail, memberPhone, memberName, memberId) => {
      await this.dispatchNotification({
        userId: memberId, bookingId: booking.id, type: "EMAIL", channel: "booking_declined", recipient: memberEmail,
        templateId: SENDGRID_TEMPLATES.MEETING_DECLINED_PARENT,
        templateData: { firstName: getFirstName(memberName), providerName, date: formatDate(scheduledAt, booking.bookerTimezone), time: formatTime(scheduledAt, booking.bookerTimezone), rebookLink },
      });
      if (memberPhone) {
        await this.dispatchSmsTemplate({
          userId: memberId, bookingId: booking.id, channel: "booking_declined", recipient: memberPhone,
          contentSid: TWILIO_TEMPLATES.MEETING_DECLINED_PARENT,
          contentVars: { "1": getFirstName(memberName), "2": providerName, "3": formatDate(scheduledAt, booking.bookerTimezone), "4": formatTime(scheduledAt, booking.bookerTimezone), "5": rebookLink },
        });
      }
    });

    await this.fanOutAdditionalAttendees(booking, async (ae, aeName, aePhone) => {
      await this.dispatchNotification({
        userId: booking.parentUserId || booking.providerUserId,
        bookingId: booking.id, type: "EMAIL", channel: "booking_declined", recipient: ae,
        templateId: SENDGRID_TEMPLATES.MEETING_DECLINED_PARENT,
        templateData: { firstName: getFirstName(aeName) || ae.split("@")[0], providerName, date: formatDate(scheduledAt, booking.bookerTimezone), time: formatTime(scheduledAt, booking.bookerTimezone), rebookLink },
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({
          userId: booking.parentUserId || booking.providerUserId,
          bookingId: booking.id, channel: "booking_declined", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.MEETING_DECLINED_PARENT,
          contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": formatDate(scheduledAt, booking.bookerTimezone), "4": formatTime(scheduledAt, booking.bookerTimezone), "5": rebookLink },
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

    if (attendeeEmail) {
      await this.dispatchNotification({
        userId: suggestedBooking.parentUserId || suggestedBooking.providerUserId,
        bookingId: suggestedBooking.id,
        type: "EMAIL",
        channel: "booking_new_time",
        recipient: attendeeEmail,
        templateId: SENDGRID_TEMPLATES.NEW_TIME_SUGGESTED_PARENT,
        templateData: {
          firstName: getFirstName(attendeeName),
          providerName,
          oldDate: formatDate(oldDate, newBooking.bookerTimezone),
          oldTime: formatTime(oldDate, newBooking.bookerTimezone),
          date: formatDate(newDate, newBooking.bookerTimezone),
          time: formatTime(newDate, newBooking.bookerTimezone),
          duration: String(suggestedBooking.duration),
          message: providerMessage || "",
          acceptLink: `${base}/booking/${suggestedBooking.confirmToken}/confirm`,
          declineLink: `${base}/booking/${suggestedBooking.confirmToken}/decline`,
        },
      });

      const parentPhone = suggestedBooking.parentUser?.mobileNumber;
      if (parentPhone) {
        if (providerMessage) {
          await this.dispatchSmsTemplate({
            userId: suggestedBooking.parentUserId || suggestedBooking.providerUserId,
            bookingId: suggestedBooking.id,
            channel: "booking_new_time",
            recipient: parentPhone,
            contentSid: TWILIO_TEMPLATES.NEW_TIME_SUGGESTED_PARENT_WITH_MSG,
            contentVars: {
              "1": getFirstName(attendeeName),
              "2": providerName,
              "3": formatDate(newDate, newBooking.bookerTimezone),
              "4": formatTime(newDate, newBooking.bookerTimezone),
              "5": `${base}/booking/${suggestedBooking.confirmToken}/confirm`,
              "6": providerMessage,
            },
          });
        } else {
          await this.dispatchSmsTemplate({
            userId: suggestedBooking.parentUserId || suggestedBooking.providerUserId,
            bookingId: suggestedBooking.id,
            channel: "booking_new_time",
            recipient: parentPhone,
            contentSid: TWILIO_TEMPLATES.NEW_TIME_SUGGESTED_PARENT,
            contentVars: {
              "1": getFirstName(attendeeName),
              "2": providerName,
              "3": formatDate(newDate, newBooking.bookerTimezone),
              "4": formatTime(newDate, newBooking.bookerTimezone),
              "5": `${base}/booking/${suggestedBooking.confirmToken}/confirm`,
            },
          });
        }
      }
    }

    await this.fanOutParentNotification(suggestedBooking, async (memberEmail, memberPhone, memberName, memberId) => {
      await this.dispatchNotification({
        userId: memberId, bookingId: suggestedBooking.id, type: "EMAIL", channel: "booking_new_time", recipient: memberEmail,
        templateId: SENDGRID_TEMPLATES.NEW_TIME_SUGGESTED_PARENT,
        templateData: {
          firstName: getFirstName(memberName), providerName,
          oldDate: formatDate(oldDate, newBooking.bookerTimezone), oldTime: formatTime(oldDate, newBooking.bookerTimezone), date: formatDate(newDate, newBooking.bookerTimezone), time: formatTime(newDate, newBooking.bookerTimezone),
          duration: String(suggestedBooking.duration), message: providerMessage || "",
          acceptLink: `${base}/booking/${suggestedBooking.confirmToken}/confirm`,
          declineLink: `${base}/booking/${suggestedBooking.confirmToken}/decline`,
        },
      });
      if (memberPhone) {
        if (providerMessage) {
          await this.dispatchSmsTemplate({
            userId: memberId, bookingId: suggestedBooking.id, channel: "booking_new_time", recipient: memberPhone,
            contentSid: TWILIO_TEMPLATES.NEW_TIME_SUGGESTED_PARENT_WITH_MSG,
            contentVars: { "1": getFirstName(memberName), "2": providerName, "3": formatDate(newDate, newBooking.bookerTimezone), "4": formatTime(newDate, newBooking.bookerTimezone), "5": `${base}/booking/${suggestedBooking.confirmToken}/confirm`, "6": providerMessage },
          });
        } else {
          await this.dispatchSmsTemplate({
            userId: memberId, bookingId: suggestedBooking.id, channel: "booking_new_time", recipient: memberPhone,
            contentSid: TWILIO_TEMPLATES.NEW_TIME_SUGGESTED_PARENT,
            contentVars: { "1": getFirstName(memberName), "2": providerName, "3": formatDate(newDate, newBooking.bookerTimezone), "4": formatTime(newDate, newBooking.bookerTimezone), "5": `${base}/booking/${suggestedBooking.confirmToken}/confirm` },
          });
        }
      }
    });

    await this.fanOutAdditionalAttendees(suggestedBooking, async (ae, aeName, aePhone) => {
      await this.dispatchNotification({
        userId: suggestedBooking.parentUserId || suggestedBooking.providerUserId,
        bookingId: suggestedBooking.id, type: "EMAIL", channel: "booking_new_time", recipient: ae,
        templateId: SENDGRID_TEMPLATES.NEW_TIME_SUGGESTED_PARENT,
        templateData: {
          firstName: getFirstName(aeName) || ae.split("@")[0], providerName,
          oldDate: formatDate(oldDate, newBooking.bookerTimezone), oldTime: formatTime(oldDate, newBooking.bookerTimezone), date: formatDate(newDate, newBooking.bookerTimezone), time: formatTime(newDate, newBooking.bookerTimezone),
          duration: String(suggestedBooking.duration), message: providerMessage || "",
          acceptLink: `${base}/booking/${suggestedBooking.confirmToken}/confirm`,
          declineLink: `${base}/booking/${suggestedBooking.confirmToken}/decline`,
        },
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({
          userId: suggestedBooking.parentUserId || suggestedBooking.providerUserId,
          bookingId: suggestedBooking.id, channel: "booking_new_time", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.NEW_TIME_SUGGESTED_PARENT,
          contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": formatDate(newDate, newBooking.bookerTimezone), "4": formatTime(newDate, newBooking.bookerTimezone), "5": `${base}/booking/${suggestedBooking.confirmToken}/confirm` },
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

    const adminEmails = await this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" }, isDisabled: false },
      select: { email: true },
    });
    const bccList = adminEmails.map((a) => a.email).filter((e) => e !== user.email);

    await this.dispatchNotification({
      userId: user.id,
      type: "EMAIL",
      channel: "calendar_reconnection",
      recipient: user.email,
      templateId: SENDGRID_TEMPLATES.CALENDAR_RECONNECTION,
      templateData: {
        firstName: getFirstName(user.name),
        fullName,
        providerName,
        calendarName,
        reconnectLink,
      },
      bcc: bccList,
    });

    if (user.mobileNumber) {
      await this.dispatchSmsTemplate({
        userId: user.id,
        channel: "calendar_reconnection",
        recipient: user.mobileNumber,
        contentSid: TWILIO_TEMPLATES.CALENDAR_RECONNECTION,
        contentVars: {
          "1": getFirstName(user.name),
          "2": fullName,
          "3": providerName || "GoStork",
          "4": reconnectLink,
        },
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

    if (joinerRole === "provider") {
      const parentEmail = booking.attendeeEmails?.[0] || booking.parentUser?.email;
      const waitingDetails: Record<string, { name?: string; phone?: string }> = booking.attendeeDetails || {};
      const waitingPrimaryDetails = parentEmail ? (waitingDetails[parentEmail.toLowerCase()] || {}) : {};
      const parentPhone = booking.parentUser?.mobileNumber || waitingPrimaryDetails.phone;

      if (parentEmail) {
        await this.dispatchNotification({
          userId: booking.parentUserId || booking.providerUserId,
          bookingId: booking.id,
          type: "EMAIL",
          channel: "video_waiting",
          recipient: parentEmail,
          templateId: SENDGRID_TEMPLATES.VIDEO_WAITING_PARENT,
          templateData: {
            firstName: getFirstName(attendeeName),
            staffMember,
            providerName,
            roomLink,
          },
        });
      }

      if (parentPhone) {
        await this.dispatchSmsTemplate({
          userId: booking.parentUserId || booking.providerUserId,
          bookingId: booking.id,
          channel: "video_waiting",
          recipient: parentPhone,
          contentSid: TWILIO_TEMPLATES.VIDEO_WAITING_PARENT,
          contentVars: {
            "1": getFirstName(attendeeName),
            "2": staffMember,
            "3": providerName,
            "4": roomLink,
          },
        });
      }
    } else {
      const providerEmail = providerUser?.email;
      const providerPhone = providerUser?.mobileNumber;

      if (providerEmail) {
        await this.dispatchNotification({
          userId: booking.providerUserId,
          bookingId: booking.id,
          type: "EMAIL",
          channel: "video_waiting",
          recipient: providerEmail,
          templateId: SENDGRID_TEMPLATES.VIDEO_WAITING_PROVIDER,
          templateData: {
            firstName: getFirstName(staffMember),
            attendeeName,
            roomLink,
          },
        });
      }

      if (providerPhone) {
        await this.dispatchSmsTemplate({
          userId: booking.providerUserId,
          bookingId: booking.id,
          channel: "video_waiting",
          recipient: providerPhone,
          contentSid: TWILIO_TEMPLATES.VIDEO_WAITING_PROVIDER,
          contentVars: {
            "1": getFirstName(staffMember),
            "2": attendeeName,
            "3": roomLink,
          },
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

    await this.dispatchNotification({
      userId: newUser.id,
      type: "EMAIL",
      channel: "member_invitation",
      recipient: newUser.email,
      templateId: SENDGRID_TEMPLATES.MEMBER_INVITATION,
      templateData: {
        firstName: getFirstName(newUser.name),
        inviterName,
        email: newUser.email,
        tempPassword,
        loginLink,
      },
    });

    if (newUser.mobileNumber) {
      await this.dispatchSmsTemplate({
        userId: newUser.id,
        channel: "member_invitation",
        recipient: newUser.mobileNumber,
        contentSid: TWILIO_TEMPLATES.MEMBER_INVITATION,
        contentVars: {
          "1": inviterName,
          "2": loginLink,
        },
      });
    }
  }

  async sendRecordingReady(booking: any) {
    const providerUser = booking.providerUser || (await this.prisma.user.findUnique({ where: { id: booking.providerUserId } }));
    const providerEmail = providerUser?.email;
    const parentUser = booking.parentUser || (booking.parentUserId ? await this.prisma.user.findUnique({ where: { id: booking.parentUserId } }) : null);
    const scheduledAt = new Date(booking.scheduledAt);
    const base = getBaseUrl();
    const recordingLink = `${base}/recordings/${booking.id}`;
    const meetingSubject = booking.subject || "Consultation";
    const meetingDate = formatDate(scheduledAt, booking.bookerTimezone);

    if (providerEmail) {
      await this.dispatchNotification({
        userId: booking.providerUserId,
        bookingId: booking.id,
        type: "EMAIL",
        channel: "recording_ready",
        recipient: providerEmail,
        templateId: SENDGRID_TEMPLATES.RECORDING_READY,
        templateData: {
          firstName: getFirstName(providerUser?.name),
          meetingSubject,
          meetingDate,
          recordingLink,
        },
      });
    }

    if (parentUser?.email) {
      await this.dispatchNotification({
        userId: parentUser.id,
        bookingId: booking.id,
        type: "EMAIL",
        channel: "recording_ready",
        recipient: parentUser.email,
        templateId: SENDGRID_TEMPLATES.RECORDING_READY,
        templateData: {
          firstName: getFirstName(parentUser.name),
          meetingSubject,
          meetingDate,
          recordingLink,
        },
      });
    }

    await this.fanOutParentNotification(booking, async (memberEmail, memberPhone, memberName, memberId) => {
      await this.dispatchNotification({
        userId: memberId,
        bookingId: booking.id,
        type: "EMAIL",
        channel: "recording_ready",
        recipient: memberEmail,
        templateId: SENDGRID_TEMPLATES.RECORDING_READY,
        templateData: {
          firstName: getFirstName(memberName),
          meetingSubject,
          meetingDate,
          recordingLink,
        },
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
    const pendingReminders = await this.prisma.notification.findMany({
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
          const templateId = isProvider ? SENDGRID_TEMPLATES.BOOKING_REMINDER_PROVIDER : SENDGRID_TEMPLATES.BOOKING_REMINDER_PARENT;
          const reminderVideoRoomLink = `${base}/room/${booking.id}`;
          const templateData = isProvider
            ? {
                firstName: getFirstName(booking.providerUser?.name),
                parentName: attendeeName,
                parentEmail: booking.attendeeEmails?.[0] || "",
                date: formatDate(scheduledAt, booking.bookerTimezone),
                time: formatTime(scheduledAt, booking.bookerTimezone),
                duration: String(booking.duration),
                reminderLabel,
                meetingLink: booking.meetingUrl || "",
                videoRoomLink: reminderVideoRoomLink,
                buttonText: "START MEETING",
                rescheduleLink: `${base}/booking/${booking.publicToken}`,
                cancelLink: `${base}/booking/${booking.publicToken}`,
                providerName,
              }
            : {
                firstName: getFirstName(attendeeName),
                providerName,
                staffMember: booking.providerUser?.name || "",
                date: formatDate(scheduledAt, booking.bookerTimezone),
                time: formatTime(scheduledAt, booking.bookerTimezone),
                duration: String(booking.duration),
                reminderLabel,
                meetingLink: booking.meetingUrl || "",
                videoRoomLink: reminderVideoRoomLink,
                buttonText: "JOIN MEETING",
                rescheduleLink: `${base}/booking/${booking.publicToken}`,
                cancelLink: `${base}/booking/${booking.publicToken}`,
              };

          await this.sendTemplateEmail(reminder.recipient, templateId, templateData);
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

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f5f5f0;font-family:'DM Sans',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f0;padding:40px 20px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="background-color:${brandData.brandColor};padding:30px;text-align:center;">
<h1 style="color:#ffffff;font-family:'Playfair Display',Georgia,serif;font-size:24px;margin:0;">${companyName}</h1>
</td></tr>
<tr><td style="padding:40px 30px;">
<h2 style="font-family:'Playfair Display',Georgia,serif;color:${brandData.brandColor};font-size:22px;margin:0 0 16px;">Reset Your Password</h2>
<p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 12px;">Hi ${firstName},</p>
<p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 24px;">We received a request to reset your password. Click the button below to create a new password. This link will expire in 1 hour.</p>
<table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;"><tr><td style="background-color:${brandData.brandColor};border-radius:8px;padding:14px 32px;">
<a href="${resetLink}" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;display:inline-block;">Reset Password</a>
</td></tr></table>
<p style="color:#666;font-size:13px;line-height:1.5;margin:0 0 8px;">If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
<p style="color:#999;font-size:12px;line-height:1.5;margin:24px 0 0;padding-top:16px;border-top:1px solid #eee;">If the button doesn't work, copy and paste this link into your browser:<br><a href="${resetLink}" style="color:${brandData.brandColor};word-break:break-all;">${resetLink}</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

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
    const subject = `Cost Sheet Submitted — ${params.providerName} (v${params.version})`;
    const btnStyle = `display:inline-block;background:${brandData.brandColor};color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;`;
    const html = `
<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px;">
<div style="background:${brandData.brandColor};padding:20px;border-radius:8px 8px 0 0;">
  <h2 style="color:#fff;margin:0;">${this.escapeHtml(brandData.companyName)}</h2>
</div>
<div style="border:1px solid #e5e5e5;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
  <h3 style="margin-top:0;">New Cost Sheet Submitted</h3>
  <p><strong>${providerName}</strong> has submitted a cost sheet for review.</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;">
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666;">Submitted by</td><td style="padding:8px 0;border-bottom:1px solid #eee;">${submitterName} (${submitterEmail})</td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666;">Version</td><td style="padding:8px 0;border-bottom:1px solid #eee;">${params.version}</td></tr>
  </table>
  <div style="text-align:center;margin:24px 0;">
    <a href="${reviewUrl}" style="${btnStyle}">Review Cost Sheet</a>
  </div>
</div>
</body></html>`;

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
    const subject = `Cost Sheet Approved — Now Live`;
    const btnStyle = `display:inline-block;background:${brandData.brandColor};color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;`;
    const html = `
<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px;">
<div style="background:${brandData.brandColor};padding:20px;border-radius:8px 8px 0 0;">
  <h2 style="color:#fff;margin:0;">${this.escapeHtml(brandData.companyName)}</h2>
</div>
<div style="border:1px solid #e5e5e5;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
  <h3 style="margin-top:0;">Cost Sheet Approved</h3>
  <p>Great news! Your cost sheet (v${params.version}) for <strong>${providerName}</strong> has been approved by the admin team.</p>
  <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-left:4px solid #22C55E;padding:16px;border-radius:4px;margin:16px 0;">
    <strong style="color:#166534;">Your updated costs are now live on your GoStork profile.</strong>
    <p style="margin:8px 0 0;color:#15803D;">Parents browsing the marketplace will see your latest pricing immediately.</p>
  </div>
  <div style="text-align:center;margin:24px 0;">
    <a href="${viewUrl}" style="${btnStyle}">View Your Cost Sheet</a>
  </div>
</div>
</body></html>`;

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
    const subject = `Cost Sheet Rejected — Action Required`;
    const btnStyle = `display:inline-block;background:${brandData.brandColor};color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;`;
    const html = `
<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px;">
<div style="background:${brandData.brandColor};padding:20px;border-radius:8px 8px 0 0;">
  <h2 style="color:#fff;margin:0;">${this.escapeHtml(brandData.companyName)}</h2>
</div>
<div style="border:1px solid #e5e5e5;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
  <h3 style="margin-top:0;">Cost Sheet Rejected</h3>
  <p>Your cost sheet (v${params.version}) for <strong>${providerName}</strong> has been rejected by the admin team.</p>
  <div style="background:#FEF2F2;border:1px solid #FECACA;border-left:4px solid #EF4444;padding:16px;border-radius:4px;margin:16px 0;">
    <strong style="color:#991B1B;">Admin Feedback:</strong>
    <p style="margin:8px 0 0;color:#7F1D1D;">${feedback}</p>
  </div>
  <div style="text-align:center;margin:24px 0;">
    <a href="${viewUrl}" style="${btnStyle}">Revise Cost Sheet</a>
  </div>
</div>
</body></html>`;

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
}
