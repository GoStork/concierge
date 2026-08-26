import { Injectable, Inject, Logger, OnModuleInit } from "@nestjs/common";
import { createHash } from "crypto";
import { BRAND_PRIMARY_FALLBACK } from "../../../../shared/brand-fallback";
import { PrismaService } from "../prisma/prisma.service";
import { formatMoneyCents } from "../../lib/format-money";
import { formatPhoneDisplay } from "../../lib/format-phone";
import { getBaseUrl } from "../../lib/get-base-url";
import { isExternalMeetingUrl } from "../../lib/daily-room";
import { esc, buildBrandedEmail, fetchEmailBrandData } from "./email-builder";
import { parentAccountKey, resolveParentGates } from "../../../parent-privacy";
import { type NightlySyncResult } from "../providers/profile-sync.service";

export type NotificationChannel =
  // These four are dispatched in this file but were missing from the union.
  | "winback_nudge"
  | "invoice_processing"
  | "wire_instructions"
  | "whisper_pending"
  | "booking_submitted"
  | "booking_request"
  | "booking_confirmation"
  | "booking_reminder"
  | "booking_cancellation"
  | "booking_rescheduled"
  | "booking_declined"
  | "booking_new_time"
  | "booking_pending_reminder"
  | "booking_pending_urgent"
  | "booking_expired"
  | "calendar_reconnection"
  | "video_waiting"
  | "member_invitation"
  | "recording_ready"
  | "cost_sheet_submitted"
  | "cost_sheet_approved"
  | "cost_sheet_rejected"
  | "cost_sheet_ready"
  | "cost_sheet_missing"
  | "human_escalation"
  | "agreement_ready"
  | "agreement_signed"
  // Cross-provider outcome: the losing agency is told, once, per line.
  | "matched_elsewhere"
  // A task's own reminder, and the once-a-day roundup of what is due.
  | "task_reminder"
  | "task_digest"
  // GoStork's own alert when a family commits (immediate or digested).
  | "commitment_alert"
  | "invoice_payment_request"
  | "invoice_reminder"
  | "invoice_paid_admin"
  | "consultation_ended"
  | "billing_admin"
  | "w9_request"
  | "provider_agreement_request"
  | "provider_agreement_completed"
  | "w9_completed"
  // Stripe security sentry: unknown connected account, foreign payout,
  // charge-volume spike. Always to GOSTORK_ADMINs, email + in-app.
  | "security_alert"
  | "sponsorship_payment_request"
  | "sponsorship_activated"
  | "sponsorship_past_due"
  | "sponsorship_ended";


// [V3] generation, Aug 9 2026: every body reformatted with line breaks so a
// text reads as a message (greeting / when / action link on their own lines)
// instead of one run-on sentence. The [V2] content resources still exist on
// Twilio untouched - swapping a sid back is the whole rollback.
const TWILIO_TEMPLATES = {
  // V3.1: {{6}} carries the whole "We'll notify you once <host> from <org>
  // confirms." sentence, built in code - the host name is not always known,
  // and an empty template variable would leave a dangling "once confirms."
  BOOKING_SUBMITTED_PARENT: "HXcad9487dccd95ef2ee65f6765815c5dd",
  BOOKING_REQUEST_PROVIDER: "HX89473ec423381115929d767cb700452f",
  BOOKING_CONFIRMED_PARENT: "HX2ad3886a826af603d4255f6abe59d57e",
  BOOKING_CONFIRMED_PROVIDER: "HX21d5758b976a2b90fc9a34db77381983",
  BOOKING_CANCELLED_PARENT: "HX9363d211407a375ac0c1c37abb8119af",
  // Expired is NOT cancelled: nobody called it off - the provider simply
  // never confirmed before the requested time. The cancelled template said
  // "has been cancelled", which reads as an action someone took. This one
  // explains what actually happened AND names the provider as the side that
  // failed to confirm ("Nothing was needed from you") - without that, the
  // parent reads "wasn't confirmed" and wonders if the missed confirmation
  // was theirs. V3.1 supersedes HX969429d8a0485e16333d84df0207ff8f.
  BOOKING_EXPIRED_PARENT: "HXb5dddb53ab656cc5ff0b6d949bea9187",
  BOOKING_CANCELLED_PROVIDER: "HX9c33671d45aef4cfd2a76e7f1acc4cac",
  BOOKING_RESCHEDULED_PARENT: "HX1676457910398959bfebf36808cee8d6",
  BOOKING_RESCHEDULED_PARENT_WITH_MSG: "HX898c696ecb971b0be5efbf6b95c09a5b",
  BOOKING_RESCHEDULED_PROVIDER: "HX7f182ab67e197501c5b6c9997f536039",
  BOOKING_REMINDER: "HXb21f3284bbf0096009ef3b2fce8c5ed9",
  MEETING_DECLINED_PARENT: "HX029fcadeabe2f8c1e1786e129e9c78b5",
  NEW_TIME_SUGGESTED_PARENT: "HX6aec537d5db26764f61b202ce90bb66a",
  NEW_TIME_SUGGESTED_PARENT_WITH_MSG: "HXe5caee98b84bf91564d7a973386af243",
  CALENDAR_RECONNECTION: "HX18ed59c1954d4d44406ff50d5252ae86",
  CALENDAR_RECONNECTION_REAUTH: "HX6ee12a3a806ed0361e075a9e77216a3c",
  VIDEO_WAITING_PARENT: "HX581a002549a2034f12ef023fd2cde7e1",
  VIDEO_WAITING_PROVIDER: "HX7bacb24092cc54215cbe7d6120c919eb",
  MEMBER_INVITATION: "HXf0f33ae9bd167179316d9b48d5a9d8d3",
  AGREEMENT_READY_PARENT: "HXed034f64aac61228d1e5aae190985212",
  POST_CALL_FOLLOWUP_PARENT: "PLACEHOLDER", // TODO: create Twilio Content Template; falls back to sendRawSms
};


function formatDate(d: Date, tz?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
  if (tz) opts.timeZone = tz;
  return d.toLocaleDateString("en-US", opts);
}

// Always include the timezone abbreviation (e.g. "PST", "EST") so the reader
// knows which zone the time is in. The abbreviation is derived from the passed
// tz, so a parent formatted in their zone sees their zone and a provider
// formatted in theirs sees theirs.
function formatTime(d: Date, tz?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" };
  if (tz) opts.timeZone = tz;
  return d.toLocaleTimeString("en-US", opts);
}


function getFirstName(fullName?: string | null): string {
  if (!fullName) return "";
  return fullName.split(" ")[0];
}

// Two servers run the same crons. Both can decide a nudge is due in the same
// millisecond, so "have we sent this yet?" can never be answered by reading
// first and writing after - both reads say no. Instead every dispatch stakes a
// claim on a unique key, and the database decides the winner: the loser's
// insert violates the index and its send is dropped.
//
// The window makes the key self-expiring, so a genuinely new send of the same
// message later (a re-invite next week) is not blocked forever. It is coarse
// enough that racing servers always land in the same bucket, and no legitimate
// flow sends a byte-identical message to the same person twice inside it.
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

function buildDedupeKey(parts: Array<string | null | undefined>): string {
  const window = Math.floor(Date.now() / DEDUPE_WINDOW_MS);
  // NUL separator, so ["a b","c"] and ["a","b c"] cannot hash alike. Written
  // as the ESCAPE, never a literal NUL byte: the literal made this whole file
  // binary as far as grep is concerned, so every search across it silently
  // returned nothing - including searches for this function.
  const raw = parts.map((p) => (p ?? "").toString().trim().toLowerCase()).join("\u0000");
  return `${window}:${createHash("sha256").update(raw).digest("hex").slice(0, 40)}`;
}


/**
 * A readable plain-text version of an email, for the activity timeline's
 * preview line. Not a full HTML-to-text renderer - it strips tags and
 * collapses whitespace, which is all a two-line preview needs. The exact
 * HTML is kept alongside it in bodyHtml.
 */
function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

/**
 * Twilio renders the final SMS from a Content Template on their side, so we
 * never hold the sent string. Record the template and the variables we
 * supplied - the truthful thing we DO have - rather than guessing at wording.
 * Fallback only: renderSmsTemplateForLog below fetches the REAL template
 * body from Twilio and reproduces the exact text the parent's phone shows.
 */
function summarizeSmsTemplate(contentSid: string, vars: Record<string, string>): string {
  const parts = Object.entries(vars)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([k, v]) => `{{${k}}} ${v}`);
  return `Template ${contentSid}\n${parts.join("\n")}`;
}

/**
 * The activity timeline showed "Template HXdbef..." plus raw {{n}} pairs -
 * technically truthful, humanly unreadable. Twilio's Content API returns the
 * template's actual text body, so fetch it once per SID (cached for the
 * process lifetime - template bodies change ~never), substitute the
 * variables, and log the SAME sentence the parent's phone received. Any
 * failure falls back to the raw summary rather than inventing wording.
 */
const smsTemplateBodyCache = new Map<string, string | null>();
async function fetchSmsTemplateBody(contentSid: string): Promise<string | null> {
  if (smsTemplateBodyCache.has(contentSid)) return smsTemplateBodyCache.get(contentSid)!;
  let body: string | null = null;
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (sid && token && contentSid.startsWith("HX")) {
      const res = await fetch(`https://content.twilio.com/v1/Content/${contentSid}`, {
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
      });
      if (res.ok) {
        const json: any = await res.json();
        const types = json?.types || {};
        body = types["twilio/text"]?.body || types["twilio/quick-reply"]?.body || null;
      }
    }
  } catch { /* fall through to null */ }
  smsTemplateBodyCache.set(contentSid, body);
  return body;
}

async function renderSmsTemplateForLog(contentSid: string, vars: Record<string, string>): Promise<string> {
  const body = await fetchSmsTemplateBody(contentSid);
  if (!body) return summarizeSmsTemplate(contentSid, vars);
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (vars[key] !== undefined ? vars[key] : m));
}

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);

  /**
   * The Email / Phone rows in a PROVIDER-facing booking email, or nothing.
   *
   * Seven emails printed this same block, and nulling `parentUser.email` alone
   * would not have stopped any of them: `attendeeEmail` is computed as
   * `attendeeEmails?.[0] || parentUser?.email` at nine call sites, so the
   * address arrives through the booking's own attendee list.
   *
   * The parent-facing branches of these same methods never call this - the
   * parent's own address is theirs, and the provider's is not private.
   */
  private async providerContactRows(
    booking: any,
    attendeeEmail?: string | null,
  ): Promise<{ label: string; value: string }[]> {
    try {
      const parentUserId = booking?.parentUserId || booking?.parentUser?.id;
      const host = booking?.providerUserId
        ? await this.prisma.user.findUnique({
            where: { id: booking.providerUserId },
            select: { providerId: true, roles: true, provider: { select: { name: true } } },
          })
        : null;
      // A guest booking with no parent account has no gate to apply: the person
      // typed their own address into a public booking page for this provider.
      if (!parentUserId || !host?.providerId) {
        return attendeeEmail ? [{ label: "Email", value: esc(attendeeEmail) }] : [];
      }
      // GoStork staff and the house provider are the platform: the gates exist
      // to keep OUTSIDE providers from taking the relationship off-platform,
      // not to hide a family from the concierge team. Same rule as GATES_OPEN
      // in parent-privacy.ts - the first prod booking email to the GoStork
      // host arrived with no email/phone because this path applied Gate B to
      // GoStork itself.
      const isStaff = (host.roles || []).some((r: string) => r === "GOSTORK_ADMIN" || r === "GOSTORK_CONCIERGE");
      const isHouse = process.env.GOSTORK_PROVIDER_ID
        ? host.providerId === process.env.GOSTORK_PROVIDER_ID
        : (host.provider?.name || "").trim().toLowerCase() === "gostork";
      let showContact = isStaff || isHouse;
      if (!showContact) {
        const parent = booking?.parentUser?.parentAccountId !== undefined
          ? booking.parentUser
          : await this.prisma.user.findUnique({ where: { id: parentUserId }, select: { id: true, parentAccountId: true } });
        const gates = await resolveParentGates(host.providerId, parentAccountKey(parent), { hasBooking: true });
        showContact = gates.showContact;
      }
      if (!showContact) return [];
      const phone = booking.parentUser?.mobileNumber
        || (await this.prisma.user.findUnique({ where: { id: parentUserId }, select: { mobileNumber: true } }))?.mobileNumber;
      return [
        ...(attendeeEmail ? [{ label: "Email", value: esc(attendeeEmail) }] : []),
        ...(phone ? [{ label: "Phone", value: esc(formatPhoneDisplay(phone)) }] : []),
      ];
    } catch (e: any) {
      // Fail CLOSED: a lookup failure must not print an address we were unsure
      // about. The provider still gets the meeting, just without the contact row.
      this.logger.error(`providerContactRows failed: ${e?.message || e}`);
      return [];
    }
  }

  /**
   * The "Client" row of a PROVIDER-facing booking email: the parent's name
   * plus a small link into the Parents CRM record (/parents/:id), so the
   * provider or the GoStork team can open who this family is straight from
   * the inbox. The record page applies the privacy gates itself, so the link
   * is safe to print for everyone. Guest bookings (no parent account) get
   * the plain name.
   */
  private clientRow(booking: any, attendeeName: string): { label: string; value: string } {
    const parentUserId = booking?.parentUserId || booking?.parentUser?.id;
    if (!parentUserId) return { label: "Client", value: esc(attendeeName) };
    const url = `${getBaseUrl()}/parents/${parentUserId}`;
    return {
      label: "Client",
      value: `${esc(attendeeName)}&nbsp;&nbsp;<a href="${url}" title="Open in Parents">&#8599;&#xFE0E; View profile</a>`,
    };
  }

  /**
   * "Parent" + Email + Phone rows for a provider- or GoStork-facing email
   * about a family, looked up from the parent's user row. `contact: false`
   * prints only the name + CRM link (for recipients still behind Gate B).
   * Same "View profile" link as clientRow() so every such email opens the
   * Parents record the same way.
   */
  private async parentDetailRows(
    parentUserId: string | null | undefined,
    fallbackName: string,
    opts: { contact: boolean; label?: string } = { contact: true },
  ): Promise<{ label: string; value: string }[]> {
    const label = opts.label || "Parent";
    if (!parentUserId) return [{ label, value: esc(fallbackName) }];
    try {
      const u = await this.prisma.user.findUnique({
        where: { id: parentUserId },
        select: { name: true, email: true, mobileNumber: true },
      });
      const rows = [this.clientRow({ parentUserId }, u?.name || fallbackName)];
      rows[0].label = label;
      if (opts.contact) {
        if (u?.email) rows.push({ label: "Email", value: esc(u.email) });
        if (u?.mobileNumber) rows.push({ label: "Phone", value: esc(formatPhoneDisplay(u.mobileNumber)) });
      }
      return rows;
    } catch (e: any) {
      this.logger.warn(`parentDetailRows failed for ${parentUserId}: ${e?.message}`);
      return [{ label, value: esc(fallbackName) }];
    }
  }

  private reminderInterval: ReturnType<typeof setInterval> | null = null;
  private smsReconcileInterval: ReturnType<typeof setInterval> | null = null;
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
    this.cachedBrandData = await fetchEmailBrandData(this.prisma);
    this.brandDataCacheTime = now;
    return this.cachedBrandData;
  }

  /**
   * The provider's own timezone for a booking. Providers must read meeting
   * times in their own timezone, not the parent's - `booking.bookerTimezone`
   * captures the booker (parent), so provider-facing emails/SMS format times in
   * the provider's ScheduleConfig.timezone instead. Uses an already-loaded
   * scheduleConfig when present, otherwise fetches it; falls back to the
   * booker's zone and finally a US default.
   */
  private async resolveProviderTz(booking: any, providerUser?: any): Promise<string> {
    const loaded = providerUser?.scheduleConfig?.timezone;
    if (loaded) return loaded;
    try {
      const cfg = await this.prisma.scheduleConfig.findUnique({
        where: { userId: booking.providerUserId },
        select: { timezone: true },
      });
      if (cfg?.timezone) return cfg.timezone;
    } catch {
      /* fall through to booker/default */
    }
    return booking?.bookerTimezone || "America/Los_Angeles";
  }

  /**
   * A server restart (or crash) between handing an SMS to Twilio and writing
   * "sent" back strands the Notification row as pending forever - the parent
   * HAS the text, the timeline says "Queued - not sent yet". Both Macs
   * auto-restart on every push, so this is a routine event, not a freak one.
   * Reconcile against Twilio's own records: a stale pending row whose
   * recipient has a Twilio message within +-20 minutes of the row's creation
   * is marked sent (with Twilio's timestamp); if Twilio answers and has no
   * such message, the send truly never happened - failed. Twilio unreachable
   * leaves the row for the next pass. Runs on both servers; the
   * status-guarded updateMany makes the passes idempotent.
   */
  private async reconcileStalePendingSms() {
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    if (!twilioSid || !twilioToken) return;

    // A future-scheduled reminder is SUPPOSED to sit pending until its time
    // comes - sweeping it here married it to whatever Twilio message went out
    // at booking time (the confirmation), which both duplicated the
    // confirmation card on the activity timeline AND killed the real
    // reminder (no longer pending = processReminders never sends it). Only
    // rows past their scheduled time by the same 10-minute grace are stale.
    const staleCutoff = new Date(Date.now() - 10 * 60_000);
    const stale = await this.prisma.notification.findMany({
      where: {
        type: "SMS",
        status: "pending",
        createdAt: { lt: staleCutoff },
        OR: [{ scheduledFor: null }, { scheduledFor: { lt: staleCutoff } }],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    if (stale.length === 0) return;

    const auth = "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
    for (const row of stale) {
      let to = String(row.recipient || "").replace(/[\s\-\(\)]/g, "");
      if (to && !to.startsWith("+")) to = `+1${to}`;
      if (!to) continue;
      try {
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json?To=${encodeURIComponent(to)}&PageSize=50`,
          { headers: { Authorization: auth } },
        );
        if (!res.ok) continue; // Twilio unhappy - retry next pass
        const body = await res.json();
        // A scheduled row's send happens at scheduledFor, not createdAt -
        // anchor the match on when the message was supposed to leave.
        const created = (row.scheduledFor ?? row.createdAt).getTime();
        // NEAREST in time, not first-in-window: several texts often go out
        // within the same minute (reminder + confirmation), and first-match
        // backfilled a sibling message's body onto this row.
        const match = (body.messages || [])
          .filter((m: any) => !["failed", "canceled"].includes(m.status)
            && Math.abs(new Date(m.date_created).getTime() - created) <= 20 * 60_000)
          .sort((a: any, b: any) =>
            Math.abs(new Date(a.date_created).getTime() - created) - Math.abs(new Date(b.date_created).getTime() - created))[0];
        await this.prisma.notification.updateMany({
          // status guard: the other server may have reconciled it already
          where: { id: row.id, status: "pending" },
          data: match
            ? { status: "sent", sentAt: new Date(match.date_created), ...(row.bodyText ? {} : { bodyText: match.body || null }) }
            : { status: "failed" },
        });
        this.logger.log(`[SMS RECONCILE] ${row.id} -> ${match ? "sent" : "failed"} (${to})`);
      } catch (e: any) {
        this.logger.warn(`[SMS RECONCILE] ${row.id} skipped: ${e.message}`);
      }
    }
  }

  onModuleInit() {
    // One early pass picks up rows stranded by the restart that just
    // happened, then every 10 minutes for anything new.
    setTimeout(() => this.reconcileStalePendingSms().catch(() => {}), 45_000);
    this.smsReconcileInterval = setInterval(() => {
      this.reconcileStalePendingSms().catch((e) => this.logger.warn(`SMS reconcile pass failed: ${e.message}`));
    }, 10 * 60_000);
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


  /**
   * Callers load bookings with wildly different includes - one selects
   * parentUser without mobileNumber, the public-token cancel path loads no
   * relations at all - and the missing phone silently killed the parent's
   * SMS while the email (which falls back to attendeeEmails on the booking
   * row itself) still went out. Hydrate what notifications need instead of
   * trusting every caller's select. undefined = "not selected" (refetch);
   * null = the user genuinely has no number (respect it).
   */
  private async withParentContact<T extends { parentUserId?: string | null; parentUser?: any }>(booking: T): Promise<T> {
    if (booking?.parentUserId && booking.parentUser?.mobileNumber === undefined) {
      const parent = await this.prisma.user.findUnique({
        where: { id: booking.parentUserId },
        select: { id: true, name: true, email: true, mobileNumber: true, photoUrl: true },
      });
      if (parent) return { ...booking, parentUser: { ...(booking.parentUser || {}), ...parent } };
    }
    return booking;
  }

  async sendBookingSubmitted(booking: any) {
    booking = await this.withParentContact(booking);
    const cc = this.bookingCallCopy(booking);
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
    // Name the human who actually has to approve - "the provider confirms"
    // told the parent nothing the "With:" row didn't already contradict.
    const confirmLine = staffMember
      ? `We'll notify you once ${staffMember} from ${providerName} confirms.`
      : `We'll notify you once ${providerName} confirms.`;

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
      alertBox: { text: esc(confirmLine), type: "info" },
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
          contentSid: TWILIO_TEMPLATES.BOOKING_SUBMITTED_PARENT, contentVars: { "1": getFirstName(attendeeName), "2": providerName, "3": dateStr, "4": timeStr, "5": detailsLink, "6": confirmLine },
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
          contentSid: TWILIO_TEMPLATES.BOOKING_SUBMITTED_PARENT, contentVars: { "1": getFirstName(memberName), "2": providerName, "3": dateStr, "4": timeStr, "5": detailsLink, "6": confirmLine },
        });
      }
    });

    await this.fanOutAdditionalAttendees(booking, async (ae, aeName, aePhone) => {
      const html = cc.isCall
        ? buildBrandedEmail(brandData, {
            title: `${cc.noun} Request Submitted`,
            greeting: `Hi ${esc(aeName ? getFirstName(aeName) : "there")},`,
            body: `You're invited to a <strong>${cc.noun}</strong> with <strong>${esc(attendeeName)}</strong>${staffMember ? `, hosted by <strong>${esc(staffMember)}</strong> from <strong>${esc(providerName)}</strong>` : ""}. The request is awaiting confirmation.<br/><br/>${esc(cc.externalNote)}`,
            detailRows: [
              { label: "Date", value: dateStr },
              { label: "Time", value: timeStr },
              { label: "Duration", value: `${booking.duration} minutes` },
              { label: "Location", value: location },
              ...(staffMember ? [{ label: "Hosted by", value: esc(staffMember) }] : []),
            ],
            alertBox: { text: `We'll send you the join details once the ${cc.noun} is confirmed.`, type: "info" },
            buttons: [{ label: "View Details", url: detailsLink }],
          })
        : parentEmailBuilder(getFirstName(aeName) || ae.split("@")[0]);
      await this.dispatchNotification({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_submitted", recipient: ae,
        subject: `Your meeting with ${providerName} has been submitted`, body: html,
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, channel: "booking_submitted", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_SUBMITTED_PARENT, contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": dateStr, "4": timeStr, "5": detailsLink, "6": confirmLine },
        });
      }
    });

    if (providerEmail && booking.confirmToken) {
      const manageLink = `${base}/booking/${booking.confirmToken}/manage`;
      const provTz = await this.resolveProviderTz(booking, providerUser);
      const provDateStr = formatDate(scheduledAt, provTz);
      const provTimeStr = formatTime(scheduledAt, provTz);
      const providerHtml = buildBrandedEmail(brandData, {
        title: "New Meeting Request",
        greeting: `Hi ${esc(getFirstName(providerUser?.name))},`,
        body: `<strong>${esc(attendeeName)}</strong> has requested a meeting with you.`,
        detailRows: [
          { label: "Date", value: provDateStr },
          { label: "Time", value: provTimeStr },
          { label: "Duration", value: `${booking.duration} minutes` },
          { label: "Location", value: location },
          this.clientRow(booking, attendeeName),
          ...(await this.providerContactRows(booking, attendeeEmail)),
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
          contentSid: TWILIO_TEMPLATES.BOOKING_REQUEST_PROVIDER, contentVars: { "1": getFirstName(providerUser?.name), "2": attendeeName, "3": provDateStr, "4": provTimeStr, "5": manageLink },
        });
      }
    }
  }

  /**
   * Nudge a provider that a booking request is still PENDING and needs their action.
   * Two flavors:
   *   - urgent: the requested slot is < 24h away (fires once, gated by pendingUrgentSentAt)
   *   - daily : the request has been sitting unanswered (re-fires ~once a day until acted/expired)
   * Provider-only (the parent already knows they're waiting on the provider).
   */
  async sendPendingBookingReminder(booking: any, opts: { urgent: boolean }) {
    const providerUser = booking.providerUser || (await this.prisma.user.findUnique({ where: { id: booking.providerUserId } }));
    const providerEmail = providerUser?.email;
    if (!providerEmail || !booking.confirmToken) return;
    const attendeeEmail = booking.attendeeEmails?.[0] || booking.parentUser?.email;
    const attendeeName = booking.attendeeName || booking.parentUser?.name || attendeeEmail || "A prospective parent";
    const scheduledAt = new Date(booking.scheduledAt);
    const base = getBaseUrl();
    const brandData = await this.getBrandData();
    const location = booking.meetingType === "phone" ? "Phone Call" : "Video Call";
    // Provider-only reminder - format in the provider's own timezone.
    const provTz = await this.resolveProviderTz(booking, providerUser);
    const dateStr = formatDate(scheduledAt, provTz);
    const timeStr = formatTime(scheduledAt, provTz);
    const manageLink = `${base}/booking/${booking.confirmToken}/manage`;

    const title = opts.urgent ? "Meeting Request Needs a Response Soon" : "Meeting Request Still Awaiting Your Confirmation";
    const alertText = opts.urgent
      ? `The requested time is less than 24 hours away and still needs your response. Please confirm, decline, or suggest a new time before it expires.`
      : `This request is still waiting on you. Please confirm, decline, or suggest a new time - it will expire automatically if the requested time passes.`;

    const providerHtml = buildBrandedEmail(brandData, {
      title,
      greeting: `Hi ${esc(getFirstName(providerUser?.name))},`,
      body: `You still have an unanswered meeting request from <strong>${esc(attendeeName)}</strong>.`,
      detailRows: [
        { label: "Date", value: dateStr },
        { label: "Time", value: timeStr },
        { label: "Duration", value: `${booking.duration} minutes` },
        { label: "Location", value: location },
        this.clientRow(booking, attendeeName),
        ...(await this.providerContactRows(booking, attendeeEmail)),
      ],
      alertBox: { text: alertText, type: opts.urgent ? "error" : "warning" },
      buttons: [
        { label: "Confirm Meeting", url: manageLink },
        { label: "Suggest New Time", url: manageLink, variant: "secondary" },
        { label: "Decline", url: manageLink, variant: "destructive" },
      ],
    });
    await this.dispatchNotification({
      userId: booking.providerUserId, bookingId: booking.id, type: "EMAIL",
      channel: opts.urgent ? "booking_pending_urgent" : "booking_pending_reminder", recipient: providerEmail,
      subject: opts.urgent ? `Action needed soon: meeting request from ${attendeeName}` : `Reminder: meeting request from ${attendeeName} awaits your confirmation`,
      body: providerHtml,
    });

    const providerPhone = providerUser?.mobileNumber;
    if (providerPhone) {
      await this.dispatchSmsTemplate({
        userId: booking.providerUserId, bookingId: booking.id,
        channel: opts.urgent ? "booking_pending_urgent" : "booking_pending_reminder", recipient: providerPhone,
        contentSid: TWILIO_TEMPLATES.BOOKING_REQUEST_PROVIDER,
        contentVars: { "1": getFirstName(providerUser?.name), "2": attendeeName, "3": dateStr, "4": timeStr, "5": manageLink },
      });
    }
  }

  /**
   * Sponsorship lifecycle notification to a provider's billing contacts (email +
   * in-app). Fired by the SponsorshipService on the meaningful transitions:
   * a payment request from an admin, activation, a failed renewal (past due),
   * and the end of a sponsorship. Branded email via buildBrandedEmail per the
   * no-SendGrid-templates rule.
   */
  async sendSponsorshipNotification(params: {
    providerId: string;
    kind: "payment_requested" | "activated" | "payment_failed" | "expired" | "canceled";
    planName: string;
    /** Human summary of what the program includes, e.g. "up to 5 egg donor profiles". */
    programDetail?: string;
    currentPeriodEnd?: Date | null;
  }) {
    const users = await this.prisma.user.findMany({
      where: { providerId: params.providerId, roles: { hasSome: ["PROVIDER_ADMIN", "BILLING_MANAGER"] } },
      select: { id: true, email: true, name: true },
    });
    if (!users.length) return;

    const base = getBaseUrl();
    const manageUrl = `${base}/account/sponsorship`;
    const brandData = await this.getBrandData();
    const endStr = params.currentPeriodEnd ? formatDate(new Date(params.currentPeriodEnd), undefined) : null;
    const detail = params.programDetail ? esc(params.programDetail) : null;
    const planLabel = detail ? `${esc(params.planName)} (${detail})` : esc(params.planName);

    const channelMap: Record<typeof params.kind, NotificationChannel> = {
      payment_requested: "sponsorship_payment_request",
      activated: "sponsorship_activated",
      payment_failed: "sponsorship_past_due",
      expired: "sponsorship_ended",
      canceled: "sponsorship_ended",
    };
    const eventTypeMap: Record<typeof params.kind, string> = {
      payment_requested: "SPONSORSHIP_PAYMENT_REQUEST",
      activated: "SPONSORSHIP_ACTIVE",
      payment_failed: "SPONSORSHIP_PAST_DUE",
      expired: "SPONSORSHIP_EXPIRED",
      canceled: "SPONSORSHIP_CANCELED",
    };

    const content: Record<typeof params.kind, { title: string; subject: string; body: string; alert?: { text: string; type: "warning" | "success" | "info" | "error" }; button: string }> = {
      payment_requested: {
        title: "Complete your sponsorship payment",
        subject: detail ? `Payment requested: ${params.planName} - ${params.programDetail}` : `Payment requested: ${params.planName} sponsorship`,
        body: `GoStork has set up a <strong>${planLabel}</strong> sponsorship for your profiles. Complete payment to activate the boost and your "Sponsored" badge in the marketplace.`,
        alert: { text: detail ? `This program sponsors ${detail}. Your profiles are not boosted until payment is completed.` : "Your profiles are not boosted until payment is completed.", type: "info" },
        button: "Complete Payment",
      },
      activated: {
        title: "Your sponsorship is active",
        subject: `Your ${params.planName} sponsorship is now active`,
        body: `Your <strong>${planLabel}</strong> sponsorship is live. Your selected profiles now appear at the top of the marketplace with a "Sponsored" badge and are prioritized by the AI concierge.`,
        alert: { text: endStr ? `Current period runs through ${endStr}.` : "Boost is active.", type: "success" },
        button: "Manage Sponsorship",
      },
      payment_failed: {
        title: "Sponsorship payment failed",
        subject: `Action needed: your ${params.planName} sponsorship payment failed`,
        body: `We couldn't process the latest payment for your <strong>${esc(params.planName)}</strong> sponsorship. Please update your payment method to keep your boost active.`,
        alert: { text: "Your boost may pause if payment isn't resolved.", type: "warning" },
        button: "Update Payment",
      },
      expired: {
        title: "Your sponsorship has ended",
        subject: `Your ${params.planName} sponsorship has ended`,
        body: `Your <strong>${esc(params.planName)}</strong> sponsorship has ended and your profiles are no longer boosted. You can renew anytime.`,
        button: "Renew Sponsorship",
      },
      canceled: {
        title: "Your sponsorship was canceled",
        subject: `Your ${params.planName} sponsorship was canceled`,
        body: `Your <strong>${esc(params.planName)}</strong> sponsorship has been canceled and your profiles are no longer boosted. You can start a new sponsorship anytime.`,
        button: "Start Sponsorship",
      },
    };

    const c = content[params.kind];
    for (const u of users) {
      if (u.email) {
        const html = buildBrandedEmail(brandData, {
          title: c.title,
          greeting: `Hi ${esc(getFirstName(u.name))},`,
          body: c.body,
          ...(c.alert ? { alertBox: c.alert } : {}),
          buttons: [{ label: c.button, url: manageUrl }],
        });
        await this.dispatchNotification({
          userId: u.id, type: "EMAIL", channel: channelMap[params.kind], recipient: u.email,
          subject: c.subject, body: html,
        }).catch((e) => console.error(`[sponsorship-notify] email failed for ${u.id}: ${e.message}`));
      }
      await this.prisma.inAppNotification.create({
        data: { userId: u.id, eventType: eventTypeMap[params.kind], payload: { planName: params.planName, providerId: params.providerId } },
      }).catch(() => {});
    }
  }

  /**
   * A PENDING request was auto-expired because its slot passed with no provider action.
   * Notifies both sides (parent + account members + extra attendees, and the provider),
   * mirroring the cancellation fan-out. SMS reuses the cancelled templates (same meaning:
   * the meeting won't happen, please rebook); the branded email carries the precise wording.
   */
  /**
   * Phase 7A win-back: the single gentle email nudge sent 48h after an
   * unanswered win-back message (no-show or canceled-not-rebooked call).
   * One per booking - the sweep gates via winbackNudgedAt.
   */
  async sendWinbackNudgeEmail(booking: any) {
    const providerUser = booking.providerUser || (await this.prisma.user.findUnique({ where: { id: booking.providerUserId }, include: { provider: true, scheduleConfig: true } as any }));
    const attendeeEmail = booking.attendeeEmails?.[0] || booking.parentUser?.email;
    if (!attendeeEmail) return;
    const attendeeName = booking.attendeeName || booking.parentUser?.name || attendeeEmail;
    const providerName = providerUser?.provider?.name || providerUser?.name || "your provider";
    const base = getBaseUrl();
    const brandData = await this.getBrandData();
    const rebookLink = providerUser?.scheduleConfig?.bookingPageSlug ? `${base}/book/${providerUser.scheduleConfig.bookingPageSlug}` : `${base}/chat`;

    const html = buildBrandedEmail(brandData, {
      title: "Whenever you're ready",
      greeting: `Hi ${esc(getFirstName(attendeeName))},`,
      body: `Just a gentle check-in - your call with <strong>${esc(providerName)}</strong> never found a new time. There's no pressure at all: whenever you're ready, you can pick a new slot in one click, or reply in your GoStork chat and your concierge will take care of everything.`,
      buttons: [
        { label: "Pick a New Time", url: rebookLink },
        { label: "Open My Chat", url: `${base}/chat` },
      ],
    });
    await this.dispatchNotification({
      userId: booking.parentUserId || booking.providerUserId,
      bookingId: booking.id,
      type: "EMAIL",
      channel: "winback_nudge",
      recipient: attendeeEmail,
      subject: `Ready to rebook with ${providerName}? We're here`,
      body: html,
    });
  }

  async sendBookingExpired(booking: any) {
    booking = await this.withParentContact(booking);
    const providerUser = booking.providerUser || (await this.prisma.user.findUnique({ where: { id: booking.providerUserId } }));
    const attendeeEmail = booking.attendeeEmails?.[0] || booking.parentUser?.email;
    const attendeeName = booking.attendeeName || booking.parentUser?.name || attendeeEmail;
    const providerEmail = providerUser?.email;
    const staffMemberName = providerUser?.name || "";
    const clinicName = providerUser?.provider?.name || "";
    const providerName = clinicName || staffMemberName || "Provider";
    const scheduledAt = new Date(booking.scheduledAt);
    const base = getBaseUrl();
    const brandData = await this.getBrandData();
    const dateStr = formatDate(scheduledAt, booking.bookerTimezone);
    const timeStr = formatTime(scheduledAt, booking.bookerTimezone);
    const rebookLink = providerUser?.scheduleConfig?.bookingPageSlug ? `${base}/book/${providerUser.scheduleConfig.bookingPageSlug}` : base;

    const parentEmailBuilder = (firstName: string) => buildBrandedEmail(brandData, {
      title: "Meeting Request Expired",
      greeting: `Hi ${esc(firstName)},`,
      // Passive "wasn't confirmed" left the parent wondering whether THEY
      // were the ones who forgot to confirm. Name the provider as the side
      // that never confirmed, and say outright that nothing was expected of
      // the parent.
      body: `Your meeting request with <strong>${esc(staffMemberName || clinicName)}</strong>${staffMemberName && clinicName ? ` from <strong>${esc(clinicName)}</strong>` : ""} expired because <strong>${esc(providerName)}</strong> didn't confirm it before the requested time. Nothing was needed from you.`,
      detailRows: [
        { label: "Requested Date", value: dateStr },
        { label: "Requested Time", value: timeStr },
      ],
      alertBox: { text: `${providerName} didn't confirm this request in time, so it expired - no action was missed on your side. You can book a new time whenever you're ready.`, type: "warning" },
      buttons: [
        { label: "Book a New Time", url: rebookLink },
      ],
    });

    if (attendeeEmail) {
      const html = parentEmailBuilder(getFirstName(attendeeName));
      await this.dispatchNotification({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_expired", recipient: attendeeEmail,
        subject: `Your meeting request with ${providerName} expired`, body: html,
      });
      const expDetails: Record<string, { name?: string; phone?: string }> = booking.attendeeDetails || {};
      const expPrimaryDetails = expDetails[attendeeEmail.toLowerCase()] || {};
      const parentPhone = booking.parentUser?.mobileNumber || expPrimaryDetails.phone;
      if (parentPhone) {
        await this.dispatchSmsTemplate({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, channel: "booking_expired", recipient: parentPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_EXPIRED_PARENT, contentVars: { "1": getFirstName(attendeeName), "2": providerName, "3": dateStr, "4": timeStr, "5": rebookLink },
        });
      }
    }

    await this.fanOutParentNotification(booking, async (memberEmail, memberPhone, memberName, memberId) => {
      const html = parentEmailBuilder(getFirstName(memberName));
      await this.dispatchNotification({ userId: memberId, bookingId: booking.id, type: "EMAIL", channel: "booking_expired", recipient: memberEmail,
        subject: `Your meeting request with ${providerName} expired`, body: html,
      });
      if (memberPhone) {
        await this.dispatchSmsTemplate({ userId: memberId, bookingId: booking.id, channel: "booking_expired", recipient: memberPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_EXPIRED_PARENT, contentVars: { "1": getFirstName(memberName), "2": providerName, "3": dateStr, "4": timeStr, "5": rebookLink },
        });
      }
    });

    await this.fanOutAdditionalAttendees(booking, async (ae, aeName, aePhone) => {
      const html = parentEmailBuilder(getFirstName(aeName) || ae.split("@")[0]);
      await this.dispatchNotification({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_expired", recipient: ae,
        subject: `Your meeting request with ${providerName} expired`, body: html,
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, channel: "booking_expired", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_EXPIRED_PARENT, contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": dateStr, "4": timeStr, "5": rebookLink },
        });
      }
    });

    if (providerEmail) {
      const provTz = await this.resolveProviderTz(booking, providerUser);
      const provDateStr = formatDate(scheduledAt, provTz);
      const provTimeStr = formatTime(scheduledAt, provTz);
      const providerHtml = buildBrandedEmail(brandData, {
        title: "Meeting Request Expired",
        greeting: `Hi ${esc(getFirstName(providerUser?.name))},`,
        body: `The meeting request from <strong>${esc(attendeeName)}</strong> expired because it wasn't confirmed before the requested time.`,
        detailRows: [
          { label: "Requested Date", value: provDateStr },
          { label: "Requested Time", value: provTimeStr },
          this.clientRow(booking, attendeeName),
          ...(await this.providerContactRows(booking, attendeeEmail)),
        ],
        alertBox: { text: "No action is needed. The request has been removed from your pending list.", type: "info" },
      });
      await this.dispatchNotification({ userId: booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_expired", recipient: providerEmail,
        subject: `Meeting request from ${attendeeName} expired`, body: providerHtml,
      });
      const providerPhone = providerUser?.mobileNumber;
      if (providerPhone) {
        await this.dispatchSmsTemplate({ userId: booking.providerUserId, bookingId: booking.id, channel: "booking_expired", recipient: providerPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CANCELLED_PROVIDER, contentVars: { "1": getFirstName(providerUser?.name), "2": attendeeName, "3": provDateStr, "4": provTimeStr },
        });
      }
    }
  }

  // Phase 4: Match Calls / Doctor Calls are not generic meetings - every
  // lifecycle email names the call type and, for match calls, the surrogate
  // (parsed from the booking subject "... with Surrogate #X (hosted by ...)").
  private bookingCallCopy(booking: any) {
    const subtype = booking.meetingSubtype;
    const m = typeof booking.subject === "string" ? booking.subject.match(/with (.+?) \(hosted by/i) : null;
    const subjectLabel: string | null = m?.[1] || null;
    if (subtype === "MATCH_CALL") {
      return { noun: "Match Call", isCall: true, subjectLabel,
        parentNote: `This is your Match Call${subjectLabel ? ` with ${subjectLabel}` : ""} - the conversation where you get to know each other and decide whether to move forward together. Your coordinator will host and guide the whole conversation.`,
        externalNote: `This is a GoStork Match Call - a friendly video conversation with intended parents who are excited to meet you. Your coordinator will host the call, guide the conversation, and be there for you the entire time. Just come as you are.` };
    }
    if (subtype === "DOCTOR_CONSULTATION") {
      return { noun: "Doctor Call", isCall: true, subjectLabel,
        parentNote: `This is your Doctor Call - a one-on-one conversation with the physician who would guide your treatment. Bring any medical questions you have.`,
        externalNote: `This is a GoStork Doctor Call with the intended parents, hosted by the doctor.` };
    }
    return { noun: "meeting", isCall: false, subjectLabel: null, parentNote: "", externalNote: "" };
  }

  async sendBookingConfirmation(booking: any) {
    booking = await this.withParentContact(booking);
    const cc = this.bookingCallCopy(booking);
    const providerUser = booking.providerUser || (await this.prisma.user.findUnique({ where: { id: booking.providerUserId } }));
    const attendeeEmail = booking.attendeeEmails?.[0] || booking.parentUser?.email;
    const attendeeName = booking.attendeeName || booking.parentUser?.name || attendeeEmail;
    const providerEmail = providerUser?.email;
    // Detect GoStork admin host: fetch roles if not already on the loaded providerUser object
    const hostRoles = Array.isArray(providerUser?.roles)
      ? (providerUser!.roles as string[])
      : ((await this.prisma.user.findUnique({ where: { id: booking.providerUserId }, select: { roles: true } }))?.roles as string[] ?? []);
    const isGoStorkAdminHost = hostRoles.includes("GOSTORK_ADMIN");
    const providerName = isGoStorkAdminHost ? "GoStork Team" : (providerUser?.provider?.name || providerUser?.name || "Provider");
    const staffMember = isGoStorkAdminHost ? "" : (providerUser?.name || "");
    const scheduledAt = new Date(booking.scheduledAt);
    const base = getBaseUrl();
    const videoRoomLink = `${base}/room/${booking.id}`;
    const brandData = await this.getBrandData();
    const location = booking.meetingType === "phone" ? "Phone Call" : "Video Call";
    const dateStr = formatDate(scheduledAt, booking.bookerTimezone);
    const timeStr = formatTime(scheduledAt, booking.bookerTimezone);
    const detailsLink = `${base}/booking/${booking.publicToken}`;
    // Reconstruct GoStork internal room URLs with current base URL to avoid stale stored domains (e.g. old Replit URLs).
    // Only use booking.meetingUrl as-is for external meeting links (Zoom, Google Meet, etc.)
    const joinLink = isExternalMeetingUrl(booking.meetingUrl) ? booking.meetingUrl : videoRoomLink;

    const parentEmailBuilder = (firstName: string) => buildBrandedEmail(brandData, {
      title: `${cc.isCall ? cc.noun : "Meeting"} Confirmed`,
      greeting: `Hi ${esc(firstName)},`,
      body: cc.isCall
        ? `Great news! Your <strong>${cc.noun}</strong>${cc.subjectLabel ? ` with <strong>${esc(cc.subjectLabel)}</strong>` : ""} is confirmed${staffMember ? `, hosted by <strong>${esc(staffMember)}</strong> from <strong>${esc(providerName)}</strong>` : ` with <strong>${esc(providerName)}</strong>`}.<br/><br/>${esc(cc.parentNote)}`
        : `Great news! Your meeting with <strong>${esc(providerName)}</strong> has been confirmed.`,
      detailRows: [
        { label: "Date", value: dateStr },
        { label: "Time", value: timeStr },
        { label: "Duration", value: `${booking.duration} minutes` },
        { label: "Location", value: location },
        ...(staffMember ? [{ label: "With", value: esc(staffMember) }] : []),
      ],
      alertBox: { text: `Your ${cc.isCall ? cc.noun : "meeting"} is confirmed! Make sure to join on time.`, type: "success" },
      buttons: [
        ...(location === "Video Call" ? [{ label: "Join Meeting", url: joinLink }] : []),
        { label: "Reschedule", url: detailsLink, variant: "secondary" as const },
        { label: "Cancel", url: detailsLink, variant: "destructive" as const },
      ],
    });

    if (attendeeEmail) {
      const html = parentEmailBuilder(getFirstName(attendeeName));
      await this.dispatchNotification({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_confirmation", recipient: attendeeEmail,
        subject: cc.isCall ? `Your ${cc.noun}${cc.subjectLabel ? ` with ${cc.subjectLabel}` : ""} is confirmed` : `Your meeting with ${providerName} is confirmed`, body: html,
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
        subject: cc.isCall ? `Your ${cc.noun}${cc.subjectLabel ? ` with ${cc.subjectLabel}` : ""} is confirmed` : `Your meeting with ${providerName} is confirmed`, body: html,
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
        subject: cc.isCall ? `Your ${cc.noun} with ${attendeeName} is confirmed` : `Your meeting with ${providerName} is confirmed`, body: html,
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, channel: "booking_confirmation", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CONFIRMED_PARENT, contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": dateStr, "4": timeStr, "5": joinLink },
        });
      }
    });

    if (providerEmail) {
      const provTz = await this.resolveProviderTz(booking, providerUser);
      const provDateStr = formatDate(scheduledAt, provTz);
      const provTimeStr = formatTime(scheduledAt, provTz);
      const providerHtml = buildBrandedEmail(brandData, {
        title: `${cc.isCall ? cc.noun : "Meeting"} Confirmed`,
        greeting: `Hi ${esc(getFirstName(providerUser?.name))},`,
        body: cc.isCall
          ? `You're hosting a confirmed <strong>${cc.noun}</strong>${cc.subjectLabel ? ` for <strong>${esc(cc.subjectLabel)}</strong>` : ""} with <strong>${esc(attendeeName)}</strong>.`
          : `Your meeting with <strong>${esc(attendeeName)}</strong> has been confirmed.`,
        detailRows: [
          { label: "Date", value: provDateStr },
          { label: "Time", value: provTimeStr },
          { label: "Duration", value: `${booking.duration} minutes` },
          { label: "Location", value: location },
          this.clientRow(booking, attendeeName),
          ...(await this.providerContactRows(booking, attendeeEmail)),
        ],
        buttons: [
          ...(location === "Video Call" ? [{ label: "Start Meeting", url: videoRoomLink }] : []),
          { label: "Reschedule", url: detailsLink, variant: "secondary" as const },
          { label: "Cancel", url: detailsLink, variant: "destructive" as const },
        ],
      });
      await this.dispatchNotification({ userId: booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_confirmation", recipient: providerEmail,
        subject: `${cc.isCall ? cc.noun : "Meeting"} with ${attendeeName} confirmed`, body: providerHtml,
      });
      const providerPhone = providerUser?.mobileNumber;
      if (providerPhone) {
        await this.dispatchSmsTemplate({ userId: booking.providerUserId, bookingId: booking.id, channel: "booking_confirmation", recipient: providerPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CONFIRMED_PROVIDER, contentVars: { "1": getFirstName(providerUser?.name), "2": attendeeName, "3": provDateStr, "4": provTimeStr, "5": joinLink },
        });
      }
    }

    await this.scheduleReminders(booking);
  }

  async sendBookingCancellation(booking: any, cancelledBy?: "parent" | "provider" | "gostork") {
    booking = await this.withParentContact(booking);
    const cc = this.bookingCallCopy(booking);
    const providerUser = booking.providerUser || (await this.prisma.user.findUnique({ where: { id: booking.providerUserId } }));
    const attendeeEmail = booking.attendeeEmails?.[0] || booking.parentUser?.email;
    const attendeeName = booking.attendeeName || booking.parentUser?.name || attendeeEmail;
    const providerEmail = providerUser?.email;
    const staffMemberName = providerUser?.name || "";
    const clinicName = providerUser?.provider?.name || "";
    const providerName = clinicName || staffMemberName || "Provider";
    const scheduledAt = new Date(booking.scheduledAt);
    const base = getBaseUrl();
    const brandData = await this.getBrandData();
    const dateStr = formatDate(scheduledAt, booking.bookerTimezone);
    const timeStr = formatTime(scheduledAt, booking.bookerTimezone);
    const rebookLink = providerUser?.scheduleConfig?.bookingPageSlug ? `${base}/book/${providerUser.scheduleConfig.bookingPageSlug}` : base;

    const parentEmailBuilder = (firstName: string) => buildBrandedEmail(brandData, {
      title: `${cc.isCall ? cc.noun : "Meeting"} Cancelled`,
      greeting: `Hi ${esc(firstName)},`,
      body: cc.isCall
        ? `Your <strong>${cc.noun}</strong>${cc.subjectLabel ? ` with <strong>${esc(cc.subjectLabel)}</strong>` : ""}${staffMemberName ? `, hosted by <strong>${esc(staffMemberName)}</strong>` : ""} has been cancelled. Don't worry - this happens, and new times can be arranged.`
        : `Your meeting with <strong>${esc(staffMemberName || clinicName)}</strong>${staffMemberName && clinicName ? ` from <strong>${esc(clinicName)}</strong>` : ""} has been cancelled.`,
      detailRows: [
        { label: "Date", value: dateStr },
        { label: "Time", value: timeStr },
      ],
      alertBox: { text: `This ${cc.isCall ? cc.noun : "meeting"} has been cancelled. New times can be arranged at any time.`, type: "warning" },
      buttons: [
        { label: "Book New Meeting", url: rebookLink },
      ],
    });

    if (attendeeEmail) {
      const html = parentEmailBuilder(getFirstName(attendeeName));
      await this.dispatchNotification({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_cancellation", recipient: attendeeEmail,
        subject: cc.isCall ? `Your ${cc.noun}${cc.subjectLabel ? ` with ${cc.subjectLabel}` : ""} has been cancelled` : `Your meeting with ${providerName} has been cancelled`, body: html,
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
        subject: cc.isCall ? `Your ${cc.noun}${cc.subjectLabel ? ` with ${cc.subjectLabel}` : ""} has been cancelled` : `Your meeting with ${providerName} has been cancelled`, body: html,
      });
      if (memberPhone) {
        await this.dispatchSmsTemplate({ userId: memberId, bookingId: booking.id, channel: "booking_cancellation", recipient: memberPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CANCELLED_PARENT, contentVars: { "1": getFirstName(memberName), "2": providerName, "3": dateStr, "4": timeStr, "5": rebookLink },
        });
      }
    });

    await this.fanOutAdditionalAttendees(booking, async (ae, aeName, aePhone) => {
      // External attendees (e.g. the surrogate) get their own copy - the call
      // is "with the parents" from her side, never with herself.
      const html = cc.isCall
        ? buildBrandedEmail(brandData, {
            title: `${cc.noun} Cancelled`,
            greeting: `Hi ${esc(aeName ? getFirstName(aeName) : "there")},`,
            body: `The <strong>${cc.noun}</strong> with <strong>${esc(attendeeName)}</strong>${staffMemberName ? `, hosted by <strong>${esc(staffMemberName)}</strong>` : ""} has been cancelled. Don't worry - this happens, and new times can be arranged.`,
            detailRows: [
              { label: "Date", value: dateStr },
              { label: "Time", value: timeStr },
            ],
            alertBox: { text: `This ${cc.noun} has been cancelled. New times can be arranged at any time.`, type: "warning" },
          })
        : parentEmailBuilder(getFirstName(aeName) || ae.split("@")[0]);
      await this.dispatchNotification({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_cancellation", recipient: ae,
        subject: cc.isCall ? `Your ${cc.noun} with ${attendeeName} has been cancelled` : `Your meeting with ${providerName} has been cancelled`, body: html,
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({ userId: booking.parentUserId || booking.providerUserId, bookingId: booking.id, channel: "booking_cancellation", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CANCELLED_PARENT, contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": dateStr, "4": timeStr, "5": rebookLink },
        });
      }
    });

    if (providerEmail) {
      const provTz = await this.resolveProviderTz(booking, providerUser);
      const provDateStr = formatDate(scheduledAt, provTz);
      const provTimeStr = formatTime(scheduledAt, provTz);
      const providerHtml = buildBrandedEmail(brandData, {
        title: `${cc.isCall ? cc.noun : "Meeting"} Cancelled`,
        greeting: `Hi ${esc(getFirstName(providerUser?.name))},`,
        body: `The ${cc.isCall ? cc.noun : "meeting"} with <strong>${esc(attendeeName)}</strong> has been cancelled.`,
        detailRows: [
          { label: "Date", value: provDateStr },
          { label: "Time", value: provTimeStr },
          this.clientRow(booking, attendeeName),
          ...(await this.providerContactRows(booking, attendeeEmail)),
        ],
      });
      await this.dispatchNotification({ userId: booking.providerUserId, bookingId: booking.id, type: "EMAIL", channel: "booking_cancellation", recipient: providerEmail,
        subject: `Meeting with ${attendeeName} cancelled`, body: providerHtml,
      });
      const providerPhone = providerUser?.mobileNumber;
      if (providerPhone) {
        await this.dispatchSmsTemplate({ userId: booking.providerUserId, bookingId: booking.id, channel: "booking_cancellation", recipient: providerPhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_CANCELLED_PROVIDER, contentVars: { "1": getFirstName(providerUser?.name), "2": attendeeName, "3": provDateStr, "4": provTimeStr },
        });
      }
    }
  }

  async sendBookingRescheduled(originalBooking: any, newBooking: any, message: string = "") {
    newBooking = await this.withParentContact(newBooking);
    const cc = this.bookingCallCopy(newBooking.meetingSubtype ? newBooking : originalBooking);
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
    const joinLink = isExternalMeetingUrl(newBooking.meetingUrl) ? newBooking.meetingUrl : videoRoomLink;

    const parentEmailBuilder = (firstName: string) => buildBrandedEmail(brandData, {
      title: `${cc.isCall ? cc.noun : "Meeting"} Rescheduled`,
      greeting: `Hi ${esc(firstName)},`,
      body: cc.isCall
        ? `Your <strong>${cc.noun}</strong>${cc.subjectLabel ? ` with <strong>${esc(cc.subjectLabel)}</strong>` : ""} has been rescheduled to a new time.${message ? `<br><br><em>"${esc(message)}"</em>` : ""}`
        : `Your meeting with <strong>${esc(providerName)}</strong> has been rescheduled.${message ? `<br><br><em>"${esc(message)}"</em>` : ""}`,
      detailRows: [
        { label: "Previous", value: `${oldDateStr} at ${oldTimeStr}` },
        { label: "New Date", value: newDateStr },
        { label: "New Time", value: newTimeStr },
        { label: "Duration", value: `${newBooking.duration} minutes` },
        ...(staffMember ? [{ label: "With", value: esc(staffMember) }] : []),
      ],
      alertBox: { text: `Your ${cc.isCall ? cc.noun : "meeting"} has been rescheduled to a new time.`, type: "info" },
      buttons: [
        { label: "View Details", url: detailsLink },
        { label: "Reschedule", url: detailsLink, variant: "secondary" },
        { label: "Cancel", url: detailsLink, variant: "destructive" },
      ],
    });

    if (attendeeEmail) {
      const html = parentEmailBuilder(getFirstName(attendeeName));
      await this.dispatchNotification({ userId: newBooking.parentUserId || newBooking.providerUserId, bookingId: newBooking.id, type: "EMAIL", channel: "booking_rescheduled", recipient: attendeeEmail,
        subject: cc.isCall ? `Your ${cc.noun}${cc.subjectLabel ? ` with ${cc.subjectLabel}` : ""} has been rescheduled` : `Your meeting with ${providerName} has been rescheduled`, body: html,
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
        subject: cc.isCall ? `Your ${cc.noun}${cc.subjectLabel ? ` with ${cc.subjectLabel}` : ""} has been rescheduled` : `Your meeting with ${providerName} has been rescheduled`, body: html,
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
      // External attendees (e.g. the surrogate) get their own copy - the call
      // is "with the parents" from her side, never with herself.
      const attendeeName = newBooking.attendeeName || newBooking.parentUser?.name || "the intended parents";
      const html = cc.isCall
        ? buildBrandedEmail(brandData, {
            title: `${cc.noun} Rescheduled`,
            greeting: `Hi ${esc(aeName ? getFirstName(aeName) : "there")},`,
            body: `Your <strong>${cc.noun}</strong> with <strong>${esc(attendeeName)}</strong> has been rescheduled to a new time.${message ? `<br><br><em>"${esc(message)}"</em>` : ""}`,
            detailRows: [
              { label: "Previous", value: `${oldDateStr} at ${oldTimeStr}` },
              { label: "New Date", value: newDateStr },
              { label: "New Time", value: newTimeStr },
              { label: "Duration", value: `${newBooking.duration} minutes` },
            ],
            alertBox: { text: `Your ${cc.noun} has been rescheduled to a new time.`, type: "info" },
          })
        : parentEmailBuilder(getFirstName(aeName) || ae.split("@")[0]);
      await this.dispatchNotification({ userId: newBooking.parentUserId || newBooking.providerUserId, bookingId: newBooking.id, type: "EMAIL", channel: "booking_rescheduled", recipient: ae,
        subject: cc.isCall ? `Your ${cc.noun} with ${attendeeName} has been rescheduled` : `Your meeting with ${providerName} has been rescheduled`, body: html,
      });
      if (aePhone) {
        await this.dispatchSmsTemplate({ userId: newBooking.parentUserId || newBooking.providerUserId, bookingId: newBooking.id, channel: "booking_rescheduled", recipient: aePhone,
          contentSid: TWILIO_TEMPLATES.BOOKING_RESCHEDULED_PARENT, contentVars: { "1": getFirstName(aeName) || ae.split("@")[0], "2": providerName, "3": newDateStr, "4": newTimeStr, "5": detailsLink },
        });
      }
    });

    if (providerEmail) {
      const provTz = await this.resolveProviderTz(newBooking, providerUser);
      const provOldDateStr = formatDate(oldDate, provTz);
      const provOldTimeStr = formatTime(oldDate, provTz);
      const provNewDateStr = formatDate(newDate, provTz);
      const provNewTimeStr = formatTime(newDate, provTz);
      const providerHtml = buildBrandedEmail(brandData, {
        title: "Meeting Rescheduled",
        greeting: `Hi ${esc(getFirstName(providerUser?.name))},`,
        body: `The meeting with <strong>${esc(attendeeName)}</strong> has been rescheduled.`,
        detailRows: [
          { label: "Previous", value: `${provOldDateStr} at ${provOldTimeStr}` },
          { label: "New Date", value: provNewDateStr },
          { label: "New Time", value: provNewTimeStr },
          { label: "Duration", value: `${newBooking.duration} minutes` },
          this.clientRow(newBooking, attendeeName),
          ...(await this.providerContactRows(newBooking, attendeeEmail)),
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
          contentSid: TWILIO_TEMPLATES.BOOKING_RESCHEDULED_PROVIDER, contentVars: { "1": getFirstName(providerUser?.name), "2": attendeeName, "3": provNewDateStr, "4": provNewTimeStr, "5": joinLink },
        });
      }
    }
  }

  async sendBookingDeclinedToParent(booking: any) {
    booking = await this.withParentContact(booking);
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
    suggestedBooking = await this.withParentContact(suggestedBooking);
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
    calendarProvider?: string | null;
    disconnectReason?: string | null;
  }) {
    const base = getBaseUrl();
    const reconnectLink = `${base}/account/calendar`;
    const fullName = user.name || "Team Member";
    const calendarName = user.calendarLabel || user.calendarEmail || "your calendar";
    const calendarProviderLabel =
      user.calendarProvider === "microsoft" ? "Microsoft Outlook"
      : user.calendarProvider === "apple" ? "Apple iCloud"
      : "Google";
    const brandData = await this.getBrandData();

    const adminEmails = await this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" }, isDisabled: false },
      select: { email: true },
    });
    const bccList = adminEmails.map((a) => a.email).filter((e) => e !== user.email);

    // Craft user-friendly copy based on why the connection dropped
    const calendarAccountEmail = user.calendarEmail || calendarName;
    const isInvalidGrant = user.disconnectReason === "invalid_grant";
    const emailSubject = isInvalidGrant
      ? `Action Required: Re-authorize Your ${calendarProviderLabel} Calendar`
      : `Action Required: Reconnect Your ${calendarProviderLabel} Calendar`;
    const emailBody = isInvalidGrant
      ? `Your GoStork account <strong>${esc(user.email)}</strong> has been disconnected from your <strong>${esc(calendarProviderLabel)}</strong> Calendar <strong>${esc(calendarAccountEmail)}</strong>. This happens periodically and has nothing to do with your password - your account and data are completely safe. New bookings won't sync until you reconnect. Click the button below and sign in with ${calendarProviderLabel} to restore the connection.`
      : `Your GoStork account <strong>${esc(user.email)}</strong> has been disconnected from your <strong>${esc(calendarProviderLabel)}</strong> Calendar <strong>${esc(calendarAccountEmail)}</strong>. New bookings won't sync until you reconnect. Click the button below to fix this now.`;
    const alertText = isInvalidGrant
      ? `Your GoStork account ${user.email} has been disconnected from your ${calendarProviderLabel} Calendar ${calendarAccountEmail}. New bookings won't sync until you reconnect.`
      : `Your GoStork account ${user.email} has been disconnected from your ${calendarProviderLabel} Calendar ${calendarAccountEmail}. New bookings won't sync until you reconnect.`;

    const html = buildBrandedEmail(brandData, {
      title: isInvalidGrant ? "Calendar Re-Authorization Required" : "Calendar Connection Lost",
      greeting: `Hi ${esc(getFirstName(user.name))},`,
      body: emailBody,
      alertBox: { text: alertText, type: "error" },
      buttons: [
        { label: `Reconnect ${esc(calendarProviderLabel)} Calendar`, url: reconnectLink },
      ],
    });

    await this.dispatchNotification({
      userId: user.id, type: "EMAIL", channel: "calendar_reconnection", recipient: user.email,
      subject: emailSubject, body: html, bcc: bccList,
    });

    if (user.mobileNumber) {
      if (isInvalidGrant) {
        await this.dispatchSmsTemplate({ userId: user.id, channel: "calendar_reconnection", recipient: user.mobileNumber,
          contentSid: TWILIO_TEMPLATES.CALENDAR_RECONNECTION_REAUTH, contentVars: { "1": user.email, "2": calendarProviderLabel, "3": calendarAccountEmail, "4": reconnectLink },
        });
      } else {
        await this.dispatchSmsTemplate({ userId: user.id, channel: "calendar_reconnection", recipient: user.mobileNumber,
          contentSid: TWILIO_TEMPLATES.CALENDAR_RECONNECTION, contentVars: { "1": user.email, "2": calendarProviderLabel, "3": calendarAccountEmail, "4": reconnectLink },
        });
      }
    }
  }

  /**
   * Morning triage digest for the nightly scraper run. Emails GoStork admins
   * ONLY when a provider genuinely needs a human (bad creds, captcha, lockout,
   * or a network failure that survived all auto-retries). Transient blips that
   * self-healed and fully-green nights send nothing - silence means "all good",
   * so you stop waking up to noise.
   */
  async sendNightlySyncDigest(results: NightlySyncResult[] | undefined | void) {
    if (!results || results.length === 0) return;

    const reasonFor = (errors: string[] | undefined): string => {
      const blob = (errors || []).join(" | ").toLowerCase();
      if (/recaptcha|hcaptcha|captcha|cloudflare|verify you are human/.test(blob)) return "Captcha challenge on login - needs a solver key or manual login";
      if (/invalid|incorrect|wrong password|bad credential|unauthorized|not authorized|forbidden/.test(blob)) return "Login rejected - check the stored username/password";
      if (/locked|lockout|too many|suspended|blocked|rate.?limit/.test(blob)) return "Account temporarily locked / rate-limited by the site (usually clears on its own)";
      if (/failed to extract|no profiles|may not contain/.test(blob)) return "Logged in but no profiles extracted - the site markup may have changed";
      if (/fetch failed|timeout|timed out|eauthtimeout|econn|enotfound|socket hang up|5\d\d|405/.test(blob)) return "Site unreachable after retries - likely a transient network/egress issue";
      return (errors && errors[0]) ? errors[0].slice(0, 160) : "Unknown failure";
    };

    // Reconcile against the CURRENT DB status before alarming. The in-memory
    // results are per-attempt and can be stale: a retry (or a concurrent run)
    // may have since succeeded for the same provider. Only report providers
    // whose live config status is still FAILED - never a provider that ended
    // green, regardless of what an earlier attempt recorded.
    const [eggCfgs, surCfgs, spermCfgs] = await Promise.all([
      this.prisma.eggDonorSyncConfig.findMany({ select: { providerId: true, syncStatus: true } }),
      this.prisma.surrogateSyncConfig.findMany({ select: { providerId: true, syncStatus: true } }),
      this.prisma.spermDonorSyncConfig.findMany({ select: { providerId: true, syncStatus: true } }),
    ]);
    const liveStatus = new Map<string, string>();
    for (const c of eggCfgs) liveStatus.set(`${c.providerId}:egg-donor`, c.syncStatus);
    for (const c of surCfgs) liveStatus.set(`${c.providerId}:surrogate`, c.syncStatus);
    for (const c of spermCfgs) liveStatus.set(`${c.providerId}:sperm-donor`, c.syncStatus);

    const needsAttention = results.filter(
      (r) => liveStatus.get(`${r.providerId}:${r.type}`) === "FAILED",
    );
    const okCount = results.length - needsAttention.length;
    const selfHealed = results.filter(
      (r) => (r.retries || 0) > 0 && liveStatus.get(`${r.providerId}:${r.type}`) !== "FAILED",
    );

    if (needsAttention.length === 0) {
      this.logger.log(`[nightly-sync] Digest: all ${results.length} configs OK (${selfHealed.length} self-healed after retry) - no alert sent`);
      return;
    }

    const admins = await this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" }, isDisabled: false },
      select: { email: true },
    });
    const recipients = admins.map((a) => a.email).filter(Boolean);
    if (recipients.length === 0) {
      this.logger.warn(`[nightly-sync] Digest: ${needsAttention.length} need attention but no admin emails to notify`);
      return;
    }

    const brandData = await this.getBrandData();
    const base = getBaseUrl();
    const detailRows = needsAttention.map((r) => ({
      label: `${esc(r.providerName)} (${r.type})`,
      value: `${esc(reasonFor(r.errors))}${(r.retries || 0) > 0 ? ` - failed after ${r.retries} retr${r.retries === 1 ? "y" : "ies"}` : ""}`,
    }));
    const summaryLine =
      `${needsAttention.length} provider${needsAttention.length === 1 ? "" : "s"} need attention` +
      `${okCount > 0 ? `, ${okCount} synced fine` : ""}` +
      `${selfHealed.length > 0 ? ` (${selfHealed.length} recovered automatically after a transient blip)` : ""}.`;

    const html = buildBrandedEmail(brandData, {
      title: "Nightly Sync - Attention Needed",
      greeting: "Hi team,",
      body: `Last night's scraper sync finished. ${esc(summaryLine)} The providers below could not be auto-recovered and need a look:`,
      detailRows,
      alertBox: { text: `${needsAttention.length} scraper${needsAttention.length === 1 ? "" : "s"} need attention. Transient/network failures were already retried automatically and are not listed here.`, type: "warning" },
      buttons: [{ label: "Open Scraper Dashboard", url: `${base}/account/scrapers` }],
      footer: "You only receive this email when a scraper needs a human. A silent night means everything synced (or self-healed). To re-run one, use Restart on the dashboard.",
    });

    const subject = `Nightly Sync: ${needsAttention.length} scraper${needsAttention.length === 1 ? "" : "s"} need attention`;
    for (const to of recipients) {
      await this.sendRawEmail(to, subject, html).catch((err: any) =>
        this.logger.warn(`[nightly-sync] Digest email to ${to} failed: ${err.message}`),
      );
    }
    this.logger.log(`[nightly-sync] Digest sent to ${recipients.length} admin(s): ${needsAttention.length} need attention, ${okCount} ok`);
  }

  /**
   * The Twilio abuse watchdog found a burst that looks like a bot wave.
   * Emails every active GoStork admin; the once-per-hour claim lives in the
   * scheduler, not here.
   */
  async sendSecurityAbuseAlert(params: {
    windowMinutes: number;
    total: number;
    nonUsCa: number;
    failed: number;
    topDestinations: string[];
    balance: string | null;
  }) {
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" }, isDisabled: false },
      select: { email: true },
    });
    const recipients = admins.map((a) => a.email).filter(Boolean);
    if (recipients.length === 0) {
      this.logger.warn("[twilio-watchdog] Abuse burst detected but no admin emails to notify");
      return;
    }

    const brandData = await this.getBrandData();
    const detailRows = [
      { label: "Messages in window", value: `${params.total} in ${params.windowMinutes} minutes` },
      { label: "To numbers outside +1", value: String(params.nonUsCa) },
      { label: "Failed / undelivered", value: String(params.failed) },
      { label: "Top destinations", value: esc(params.topDestinations.join(", ") || "-") },
      ...(params.balance ? [{ label: "Twilio balance", value: esc(params.balance) }] : []),
    ];

    const html = buildBrandedEmail(brandData, {
      title: "Verification Burst Detected",
      greeting: "Hi team,",
      body:
        "The Twilio watchdog spotted an unusual burst of verification messages - the signature of the signup bot wave resuming. " +
        "Failed sends are the geo block refusing blocked countries (not billed); sends to allowed countries go out and cost money.",
      detailRows,
      alertBox: {
        text: "If this is not expected traffic, escalate the Cloudflare challenge on the signup pages to the interactive tier and review Twilio Monitor - Logs - Messaging.",
        type: "warning",
      },
      buttons: [{ label: "Open Twilio Message Logs", url: "https://console.twilio.com/us1/monitor/logs/sms" }],
      footer: "Sent at most once per hour by the abuse watchdog on the GoStork platform server.",
    });

    const subject = `Security alert: ${params.total} verification sends in ${params.windowMinutes} minutes`;
    for (const to of recipients) {
      await this.sendRawEmail(to, subject, html).catch((err: any) =>
        this.logger.warn(`[twilio-watchdog] Alert email to ${to} failed: ${err.message}`),
      );
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
          body: `<strong>${esc(staffMember || providerName)}</strong>${staffMember && providerName && staffMember !== providerName ? ` from <strong>${esc(providerName)}</strong>` : ""} is waiting for you in the video room. Join now!`,
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
    booking = await this.withParentContact(booking);
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

      let sentSubject: string | null = null;
      let sentHtml: string | null = null;
      let sentSmsText: string | null = null;
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
          // Provider reads the reminder in their own timezone; the parent in theirs (bookerTimezone).
          const reminderTz = isProvider ? await this.resolveProviderTz(booking, booking.providerUser) : booking.bookerTimezone;
          const dateStr = formatDate(scheduledAt, reminderTz);
          const timeStr = formatTime(scheduledAt, reminderTz);
          const detailsLink = `${base}/booking/${booking.publicToken}`;
          const joinLink = isExternalMeetingUrl(booking.meetingUrl) ? booking.meetingUrl : reminderVideoRoomLink;
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
                this.clientRow(booking, attendeeName),
                ...(await this.providerContactRows(booking, booking.attendeeEmails?.[0])),
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
          sentSubject = subject;
          sentHtml = html;
        } else if (reminder.type === "SMS") {
          // A2P: reminder SMS bypasses dispatchSmsTemplate, so gate here too.
          if (!(await this.recipientHasSmsOptIn(reminder.recipient, reminder.userId, "booking_reminder"))) {
            await this.prisma.notification.update({
              where: { id: reminder.id },
              data: { status: "skipped", sentAt: new Date() },
            });
            continue;
          }
          const otherPartyName = isProvider ? attendeeName : providerName;
          const reminderVars = {
              "1": getFirstName(isProvider ? booking.providerUser?.name : attendeeName),
              "2": otherPartyName,
              "3": reminderLabel,
            "4": isExternalMeetingUrl(booking.meetingUrl) ? booking.meetingUrl : `${base}/room/${booking.id}`,
          };
          await this.sendSmsWithTemplate(reminder.recipient, TWILIO_TEMPLATES.BOOKING_REMINDER, reminderVars);
          sentSmsText = await renderSmsTemplateForLog(TWILIO_TEMPLATES.BOOKING_REMINDER, reminderVars);
        }

        await this.prisma.notification.update({
          where: { id: reminder.id },
          data: {
            status: "sent",
            sentAt: new Date(),
            subject: sentSubject,
            bodyHtml: sentHtml,
            bodyText: sentHtml ? htmlToText(sentHtml) : sentSmsText,
          },
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
    subject?: string;
    body?: string;
    bcc?: string[];
  }) {
    const dedupeKey = buildDedupeKey([
      params.type,
      params.channel,
      params.recipient,
      params.bookingId,
      params.subject,
      params.body,
    ]);
    let notification: { id: string };
    try {
      notification = await this.prisma.notification.create({
        data: {
          userId: params.userId,
          bookingId: params.bookingId || null,
          type: params.type,
          channel: params.channel,
          recipient: params.recipient,
          status: "pending",
          dedupeKey,
        },
      });
    } catch (error: any) {
      // The other server already claimed this exact send in this window.
      // Losing the race is the correct outcome: the recipient gets it once.
      if (error?.code === "P2002") {
        this.logger.warn(`Duplicate ${params.channel} to ${params.recipient} suppressed (already dispatched)`);
        return;
      }
      throw error;
    }

    try {
      if (params.type === "EMAIL") {
        await this.sendRawEmail(params.recipient, params.subject || "", params.body || "", params.bcc?.length ? { bcc: params.bcc } : undefined);
      }

      await this.prisma.notification.update({
        where: { id: notification.id },
        // Store what was sent, here, where it is in hand. Nothing can
        // reconstruct it later - buildBrandedEmail resolves brand settings,
        // links and one-time tokens at send time.
        data: {
          status: "sent",
          sentAt: new Date(),
          subject: params.subject || null,
          bodyHtml: params.body || null,
          bodyText: htmlToText(params.body),
        },
      });
    } catch (error: any) {
      this.logger.warn(`Notification dispatch failed for ${params.type} to ${params.recipient}: ${error.message}`);
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { status: "failed" },
      });
    }
  }

  /**
   * A2P 10DLC consent gate for ongoing notification SMS.
   *
   * Every non-OTP SMS requires the recipient's separate opt-in
   * (User.smsNotificationsOptIn - an unticked checkbox at signup, changeable in
   * account settings). OTP verification codes never pass through here; they are
   * transactional and stay ungated. Consent belongs to the owner of the phone
   * number, so resolve by recipient number first and fall back to the attributed
   * userId (some booking call sites attribute the row to the parent while
   * texting another party). Email is the untouched fallback channel for anyone
   * who has not opted in - that is what keeps the opt-in genuinely optional.
   */
  private async recipientHasSmsOptIn(recipient: string, fallbackUserId?: string | null, channel?: string): Promise<boolean> {
    const consentUser =
      (await this.prisma.user.findFirst({
        where: { mobileNumber: recipient },
        select: { id: true, smsNotificationsOptIn: true },
      })) ||
      (fallbackUserId
        ? await this.prisma.user.findUnique({
            where: { id: fallbackUserId },
            select: { id: true, smsNotificationsOptIn: true },
          })
        : null);
    if (consentUser?.smsNotificationsOptIn) return true;
    this.logger.log(
      `SMS${channel ? ` (${channel})` : ""} to ${recipient} suppressed: recipient has not opted in to notification texts (user ${consentUser?.id ?? "unknown"})`,
    );
    return false;
  }

  private async dispatchSmsTemplate(params: {
    userId: string;
    bookingId?: string;
    channel: NotificationChannel;
    recipient: string;
    contentSid: string;
    contentVars: Record<string, string>;
  }) {
    if (!(await this.recipientHasSmsOptIn(params.recipient, params.userId, params.channel))) return;
    // The exact sentence the parent's phone shows: the real template body
    // fetched from Twilio with our variables substituted. Falls back to the
    // template-id + variables summary if the fetch fails - a faithful record
    // either way, never an invented one. Rendered BEFORE the row is created:
    // a server restart between send and status-update used to strand a row
    // as pending with no body, and the timeline then claimed the message
    // predated content recording.
    const bodyText = await renderSmsTemplateForLog(params.contentSid, params.contentVars);
    const dedupeKey = buildDedupeKey([
      "SMS",
      params.channel,
      params.recipient,
      params.bookingId,
      params.contentSid,
      JSON.stringify(params.contentVars),
    ]);
    let notification: { id: string };
    try {
      notification = await this.prisma.notification.create({
        data: {
          userId: params.userId,
          bookingId: params.bookingId || null,
          type: "SMS",
          channel: params.channel,
          recipient: params.recipient,
          status: "pending",
          bodyText,
          dedupeKey,
        },
      });
    } catch (error: any) {
      if (error?.code === "P2002") {
        this.logger.warn(`Duplicate SMS (${params.channel}) to ${params.recipient} suppressed (already dispatched)`);
        return;
      }
      throw error;
    }

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

  /**
   * Security alert to every GOSTORK_ADMIN: branded email + in-app
   * notification. Used by the Stripe security sentry (unknown connected
   * account, foreign payout, charge-volume spike). The Notification
   * dedupeKey (type+channel+recipient+subject+body) makes this safe to fire
   * from both dev machines' sweeps - the second send is suppressed as long
   * as the subject/body are identical, so callers should keep per-incident
   * wording stable (e.g. no timestamps in the body).
   */
  async sendSecurityAlertToAdmins(params: {
    subject: string;
    title: string;
    /** One paragraph of context - what fired and why it matters. */
    summary: string;
    detailRows?: { label: string; value: string }[];
    /** What the admin should do right now. */
    action: string;
    /** Where to look first. Defaults to the Stripe dashboard. */
    linkUrl?: string;
    linkLabel?: string;
  }) {
    const brandData = await this.getBrandData();
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" }, isDisabled: false },
      select: { id: true, email: true },
    });
    const html = buildBrandedEmail(brandData, {
      title: params.title,
      greeting: "Security alert from the Stripe sentry.",
      body: esc(params.summary),
      detailRows: params.detailRows || [],
      alertBox: { text: esc(params.action), type: "warning" as const },
      buttons: [{ label: params.linkLabel || "Open Stripe Dashboard", url: params.linkUrl || "https://dashboard.stripe.com" }],
    });
    for (const admin of admins) {
      if (admin.email) {
        await this.dispatchNotification({
          userId: admin.id,
          type: "EMAIL",
          channel: "security_alert",
          recipient: admin.email,
          subject: params.subject,
          body: html,
        });
      }
      await this.prisma.inAppNotification.create({
        data: {
          userId: admin.id,
          eventType: "SECURITY_ALERT",
          payload: {
            message: `${params.title}: ${params.summary} ${params.action}`,
            detailRows: params.detailRows || [],
          },
        },
      }).catch((e: any) => this.logger.warn(`Security alert in-app row failed for admin ${admin.id}: ${e?.message}`));
    }
    this.logger.warn(`[stripe-sentry] ${params.subject} - alerted ${admins.length} admin(s)`);
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

  private async sendRawEmail(
    to: string,
    subject: string,
    body: string,
    opts?: { attachments?: Array<{ filename: string; content: Buffer; mimeType?: string }>; bcc?: string[] },
  ) {
    const sendgridKey = process.env.SENDGRID_API_KEY;
    if (!sendgridKey) {
      this.logger.log(
        `[EMAIL MOCK] To: ${to}, Subject: ${subject}${opts?.bcc?.length ? `, BCC: ${opts.bcc.join(",")}` : ""}${opts?.attachments?.length ? `, attachments: ${opts.attachments.map(a => a.filename).join(", ")}` : ""}`,
      );
      return;
    }

    const senderName = await this.getCompanyName();
    const personalization: any = { to: [{ email: to }] };
    if (opts?.bcc?.length) {
      personalization.bcc = opts.bcc.map((e) => ({ email: e }));
    }
    const payload: any = {
      personalizations: [personalization],
      from: { email: process.env.SENDGRID_FROM_EMAIL || "noreply@gostork.com", name: senderName },
      subject,
      content: [{ type: "text/html", value: body }],
    };

    // SendGrid v3 attachments: base64-encoded content with filename + MIME
    // type. Used for the payment-receipt PDF so the parent can save / forward
    // it to their employer or insurance.
    if (opts?.attachments?.length) {
      payload.attachments = opts.attachments.map((a) => ({
        content: a.content.toString("base64"),
        filename: a.filename,
        type: a.mimeType || "application/octet-stream",
        disposition: "attachment",
      }));
    }

    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sendgridKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`SendGrid error: ${response.status}`);
    }
  }

  private async sendSmsWithTemplate(to: string, contentSid: string, contentVars: Record<string, string>) {
    // Kill-switch for test runs. Fixtures carry real-looking phone numbers,
    // and a suite that exercises a booking or invoice flow was texting real
    // phones through the real Twilio account ("Hi Privacy, you have a payment
    // request of $5,000..."). The test runner sets SMS_DISABLED=1.
    if (process.env.SMS_DISABLED === "1") {
      this.logger.log(`[SMS DISABLED] To: ${to}, ContentSid: ${contentSid}`);
      return;
    }
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
    const twilioMessagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

    if (!twilioSid || !twilioToken || (!twilioFrom && !twilioMessagingServiceSid)) {
      this.logger.log(`[SMS MOCK] To: ${to}, ContentSid: ${contentSid}, Vars: ${JSON.stringify(contentVars)}`);
      return;
    }

    // Reserved fictional range (test fixtures) - see sendRawSms.
    if (/^\+?1?\d{3}55501\d{2}$/.test(to.replace(/[\s\-\(\)]/g, ""))) {
      this.logger.log(`[SMS FICTIONAL] Skipping test-fixture number ${to}`);
      return;
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
    const paramsInit: Record<string, string> = {
      To: to,
      ContentSid: contentSid,
      ContentVariables: JSON.stringify(contentVars),
    };
    if (twilioMessagingServiceSid) {
      paramsInit.MessagingServiceSid = twilioMessagingServiceSid;
    } else {
      paramsInit.From = twilioFrom!;
    }
    const params = new URLSearchParams(paramsInit);

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

      // Send SMS if admin has a phone number. Internal staff alert to our own
      // team, not a consumer notification - bypasses the A2P consent gate.
      if (admin.mobileNumber) {
        this.sendRawSms(
          admin.mobileNumber,
          `${brandData.companyName} Alert: ${params.parentName} (${params.parentEmail}) is requesting human assistance in the AI concierge.\n\nJoin the chat: ${chatUrl}`,
          { skipConsentGate: true },
        ).catch(e => this.logger.error(`Failed to send escalation SMS to ${admin.mobileNumber}: ${e.message}`));
      }
    }
  }

  async sendAgreementReadyNotification(params: {
    parentUserId: string;
    parentName: string;
    parentEmail: string;
    parentPhone?: string | null;
    providerName: string;
    providerId: string;
    signingUrl: string | null;
    sessionId: string;
    isGoStorkMember?: boolean;
  }) {
    const brandData = await this.getBrandData();
    const firstName = getFirstName(params.parentName) || "there";
    const providerName = this.escapeHtml(params.providerName);
    const chatUrl = `${getBaseUrl()}/chat/${params.providerId}/${params.sessionId}`;
    const subject = `Your Agreement from ${params.providerName} is Ready to Sign`;
    const isGoStorkMember = params.isGoStorkMember !== false; // default true for backwards compat

    const buttons: Array<{ label: string; url: string }> = [];
    if (params.signingUrl) buttons.push({ label: "Review & Sign Agreement", url: params.signingUrl });
    if (isGoStorkMember) buttons.push({ label: "View in Chat", url: chatUrl });

    const html = buildBrandedEmail(brandData, {
      title: "Your Agreement is Ready",
      greeting: `Hi ${firstName},`,
      body: `<strong>${providerName}</strong> has prepared an official agreement for you. Please review it carefully and sign electronically to move forward in your journey.`,
      alertBox: { text: "This agreement requires your signature before proceeding.", type: "info" },
      buttons,
      footer: isGoStorkMember
        ? "If you have any questions about this agreement, please reach out through your GoStork chat."
        : "If you have any questions about this agreement, please contact the agency directly.",
    });

    // Email - awaited so failures surface and callers can log them
    await this.dispatchNotification({
      userId: params.parentUserId,
      type: "EMAIL",
      channel: "agreement_ready",
      recipient: params.parentEmail,
      subject,
      body: html,
    }).catch(e => this.logger.error(`Failed to send agreement email to ${params.parentEmail}: ${e.message}`));

    // SMS
    if (params.parentPhone) {
      const smsContentSid = TWILIO_TEMPLATES.AGREEMENT_READY_PARENT;
      if (smsContentSid && !smsContentSid.includes("PLACEHOLDER")) {
        this.dispatchSmsTemplate({
          userId: params.parentUserId,
          channel: "agreement_ready",
          recipient: params.parentPhone,
          contentSid: smsContentSid,
          contentVars: {
            "1": firstName,
            "2": params.providerName,
            "3": params.signingUrl || chatUrl,
          },
        }).catch(e => this.logger.error(`Failed to send agreement SMS: ${e.message}`));
      } else {
        // Fallback raw SMS until template is created. A2P consent gate applies
        // inside sendRawSms, same as the template path gates in dispatchSmsTemplate.
        this.sendRawSms(
          params.parentPhone,
          `Hi ${firstName}, your agreement from ${params.providerName} is ready to sign.\n\nReview and sign: ${params.signingUrl || chatUrl}`,
        ).catch(e => this.logger.error(`Failed to send agreement SMS (raw): ${e.message}`));
      }
    }
  }

  async sendAgreementSignedNotification(params: {
    /** GoStork userId of the recipient. Pass null for non-GoStork signers (e.g. Case D partner override) - email still sends, but no Notification DB row is created. */
    recipientUserId: string | null;
    recipientEmail: string;
    recipientName: string;
    recipientRole: "provider" | "parent";
    providerName: string;
    /** Full name of the parent who initiated the agreement */
    parentName: string;
    parentUserId?: string | null;
    providerId: string;
    sessionId: string;
    agreementId?: string;
  }) {
    const brandData = await this.getBrandData();
    const firstName = getFirstName(params.recipientName) || "there";
    const baseUrl = getBaseUrl();
    const isProvider = params.recipientRole === "provider";
    const providerButtonUrl = params.agreementId
      ? `${baseUrl}/agreements/${params.agreementId}`
      : `${baseUrl}/chat`;
    const parentButtonUrl = `${baseUrl}/chat`;

    const subject = isProvider
      ? `Agreement signed - ${params.parentName}`
      : "Your agreement has been signed";

    const html = buildBrandedEmail(brandData, {
      title: isProvider ? "Agreement Complete" : "Agreement Fully Signed",
      greeting: `Hi ${firstName},`,
      body: isProvider
        ? `The agreement with <strong>${this.escapeHtml(params.parentName)}</strong> has been signed by all parties and is now fully executed. You can download the completed document from your GoStork Documents tab.`
        : `Your agreement with <strong>${this.escapeHtml(params.providerName)}</strong> is now fully signed by all parties. The process is complete - you're one step closer on your journey.`,
      // Provider copy: who this family is + how to reach them (a sent
      // agreement opened Gate B) and the CRM link.
      ...(isProvider ? { detailRows: await this.parentDetailRows(params.parentUserId, params.parentName, { contact: true }) } : {}),
      alertBox: { text: "All parties have signed. The agreement is now complete.", type: "success" },
      buttons: [{ label: isProvider ? "View Documents" : "Continue in GoStork", url: isProvider ? providerButtonUrl : parentButtonUrl }],
      footer: isProvider
        ? "You can view and download the signed agreement from your GoStork Documents tab."
        : "If you have any questions, reach out through your GoStork chat.",
    });

    if (params.recipientUserId) {
      await this.dispatchNotification({
        userId: params.recipientUserId,
        type: "EMAIL",
        channel: "agreement_signed",
        recipient: params.recipientEmail,
        subject,
        body: html,
      }).catch(e => this.logger.error(`Failed to send agreement-signed email to ${params.recipientEmail}: ${e.message}`));
    } else {
      // Non-GoStork signer (e.g. Case D partner override) - send email without creating a Notification row
      this.logger.log(`[Notifications] Sending untracked agreement-signed email to ${params.recipientEmail} (no GoStork userId)`);
      await this.sendRawEmail(params.recipientEmail, subject, html)
        .catch(e => this.logger.error(`Failed to send untracked agreement-signed email to ${params.recipientEmail}: ${e.message}`));
    }
  }

  /**
   * "This family moved on." Sent once to the losing provider's lead owner (or
   * the org's staff when nobody is assigned).
   *
   * NEVER names the winner - the whole design rests on that, so the copy has
   * no slot for it. Email and in-app only; a lost lead does not warrant SMS.
   * The tone is deliberately matter-of-fact: this is routine in this business,
   * and the useful thing is that the agency stops chasing.
   */
  async sendMatchedElsewhereNotice(params: {
    recipients: Array<{ userId: string; email: string; name: string | null }>;
    providerName: string;
    familyName: string;
    serviceLine: string;
    parentAccountId: string;
  }) {
    const brandData = await this.getBrandData();
    const baseUrl = getBaseUrl();
    const subject = `${params.familyName} has matched elsewhere - ${params.serviceLine}`;

    for (const r of params.recipients) {
      const firstName = getFirstName(r.name || "") || "there";
      const html = buildBrandedEmail(brandData, {
        title: "A family has matched elsewhere",
        greeting: `Hi ${firstName},`,
        body: `<strong>${this.escapeHtml(params.familyName)}</strong> has moved forward with another provider for ${this.escapeHtml(params.serviceLine)}. Their ${this.escapeHtml(params.serviceLine)} lead is now marked <strong>Matched Elsewhere</strong> in your Parents list, and we have stopped the automated follow-ups on that service.`,
        alertBox: {
          text: "Your chat with this family stays open - they may still be exploring other services with you.",
          type: "info",
        },
        buttons: [{ label: "Open Parents", url: `${baseUrl}/parents` }],
        footer: "We let you know so your team can spend its time on the families still deciding.",
      });
      await this.dispatchNotification({
        userId: r.userId,
        type: "EMAIL",
        channel: "matched_elsewhere",
        recipient: r.email,
        subject,
        body: html,
      }).catch(e => this.logger.error(`Failed matched-elsewhere email to ${r.email}: ${e.message}`));
    }
  }

  /**
   * GoStork's commitment alert: one invoice paid or agreement signed
   * (immediate), or a digest of them (daily / weekly). Same renderer for both,
   * so the two cadences can never describe the same event differently.
   */
  async sendCommitmentAlert(params: {
    recipients: Array<{ userId: string; email: string; name: string | null }>;
    items: Array<{
      kind: "invoice_paid" | "agreement_signed";
      providerName: string;
      parentName: string;
      parentUserId?: string | null;
      serviceType: string | null;
      amountCents: number | null;
      at: Date | string;
    }>;
  }) {
    if (!params.items.length) return;
    const brandData = await this.getBrandData();
    const baseUrl = getBaseUrl();
    const many = params.items.length > 1;
    const profileLink = (i: (typeof params.items)[number]) =>
      i.parentUserId ? ` <a href="${baseUrl}/parents/${i.parentUserId}" title="Open in Parents">&#8599;&#xFE0E; View profile</a>` : "";
    const describe = (i: (typeof params.items)[number]) => {
      const what = i.kind === "invoice_paid"
        ? `paid ${i.amountCents != null ? formatMoneyCents(i.amountCents) : "an invoice"}`
        : "signed an agreement";
      const svc = i.serviceType ? ` (${this.escapeHtml(i.serviceType)})` : "";
      return `<strong>${this.escapeHtml(i.parentName)}</strong> ${what} with ${this.escapeHtml(i.providerName)}${svc}${profileLink(i)}`;
    };
    // Single-event alert: who the family is (name + CRM link, email, phone -
    // GoStork staff see everything) and what they committed to. The digest
    // keeps the list form with a View profile link per line.
    const single = params.items[0];
    const detailRows = many
      ? undefined
      : [
          ...(await this.parentDetailRows(single.parentUserId, single.parentName, { contact: true })),
          { label: "Provider", value: esc(single.providerName) },
          ...(single.serviceType ? [{ label: "Service", value: esc(single.serviceType) }] : []),
          ...(single.kind === "invoice_paid" && single.amountCents != null ? [{ label: "Amount", value: esc(formatMoneyCents(single.amountCents)) }] : []),
          { label: single.kind === "invoice_paid" ? "Paid" : "Signed", value: esc(new Date(single.at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })) },
        ];
    const subject = many
      ? `${params.items.length} commitments on GoStork`
      : params.items[0].kind === "invoice_paid" ? "Invoice paid on GoStork" : "Agreement signed on GoStork";

    const body = many
      ? `<ul>${params.items.map(i => `<li>${describe(i)}</li>`).join("")}</ul>`
      : `${describe(params.items[0])}.`;

    for (const r of params.recipients) {
      const firstName = getFirstName(r.name || "") || "there";
      const html = buildBrandedEmail(brandData, {
        title: many ? "Commitments" : "A family committed",
        greeting: `Hi ${firstName},`,
        body,
        ...(detailRows ? { detailRows } : {}),
        buttons: [{ label: many || !single.parentUserId ? "Open Parents" : "Open parent record", url: many || !single.parentUserId ? `${baseUrl}/parents` : `${baseUrl}/parents/${single.parentUserId}` }],
        footer: "You are receiving this because GoStork commitment alerts are on. Change the cadence in Concierge settings.",
      });
      await this.dispatchNotification({
        userId: r.userId,
        type: "EMAIL",
        channel: "commitment_alert",
        recipient: r.email,
        subject,
        body: html,
      }).catch(e => this.logger.error(`Failed commitment alert to ${r.email}: ${e.message}`));
    }
  }

  /** One task, at the offset its owner chose. */
  async sendTaskReminder(params: {
    recipient: { userId: string; email: string; name: string | null };
    task: { id: string; title: string; dueAt: Date | string; type: string; priority: string };
    parentAccountId: string;
  }) {
    const brandData = await this.getBrandData();
    const baseUrl = getBaseUrl();
    const firstName = getFirstName(params.recipient.name || "") || "there";
    // Rendered with no timeZone option on purpose: the reader's mail client
    // shows their own clock, which is the same rule the app follows.
    const due = new Date(params.task.dueAt).toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    const html = buildBrandedEmail(brandData, {
      title: "A task is due",
      greeting: `Hi ${firstName},`,
      body: `<strong>${this.escapeHtml(params.task.title)}</strong> is due ${this.escapeHtml(due)}.`,
      buttons: [{ label: "Open the record", url: `${baseUrl}/parents/${params.parentAccountId}` }],
      footer: "You set this reminder when you created the task.",
    });
    await this.dispatchNotification({
      userId: params.recipient.userId,
      type: "EMAIL",
      channel: "task_reminder",
      recipient: params.recipient.email,
      subject: `Due: ${params.task.title}`,
      body: html,
    }).catch(e => this.logger.error(`Failed task reminder to ${params.recipient.email}: ${e.message}`));
  }

  /** The 8am roundup, sent at 8am in the recipient's own timezone. */
  async sendTaskDigest(params: {
    recipient: { userId: string; email: string; name: string | null };
    timezone: string;
    overdue: { id: string; title: string; dueAt: Date | string }[];
    today: { id: string; title: string; dueAt: Date | string }[];
  }) {
    const brandData = await this.getBrandData();
    const baseUrl = getBaseUrl();
    const firstName = getFirstName(params.recipient.name || "") || "there";
    const time = (d: Date | string) => new Date(d).toLocaleString("en-US", {
      timeZone: params.timezone, hour: "numeric", minute: "2-digit",
    });
    const list = (rows: { title: string; dueAt: Date | string }[]) =>
      `<ul>${rows.map(r => `<li>${this.escapeHtml(r.title)} - ${this.escapeHtml(time(r.dueAt))}</li>`).join("")}</ul>`;

    const counts = [
      params.overdue.length ? `${params.overdue.length} overdue` : "",
      params.today.length ? `${params.today.length} due today` : "",
    ].filter(Boolean).join(" and ");

    const html = buildBrandedEmail(brandData, {
      title: "Your day",
      greeting: `Hi ${firstName},`,
      body: `You have ${counts}.`
        + (params.overdue.length ? `<p style="margin:16px 0 4px"><strong>Overdue</strong></p>${list(params.overdue)}` : "")
        + (params.today.length ? `<p style="margin:16px 0 4px"><strong>Due today</strong></p>${list(params.today)}` : ""),
      buttons: [{ label: "Open your queue", url: `${baseUrl}/provider/home` }],
      footer: "Sent each morning when you have something due.",
    });
    await this.dispatchNotification({
      userId: params.recipient.userId,
      type: "EMAIL",
      channel: "task_digest",
      recipient: params.recipient.email,
      subject: counts ? `Your day: ${counts}` : "Your day",
      body: html,
    }).catch(e => this.logger.error(`Failed task digest to ${params.recipient.email}: ${e.message}`));
  }

  async sendW9RequestNotification(params: {
    providerId: string;
    providerName: string;
    /** GoStork page that loads the embedded signing session. */
    signingUrl: string;
    /**
     * Used only when the provider has no PROVIDER_ADMIN / BILLING_MANAGER user
     * on record - so a request is never silently dropped. Null userId means a
     * non-GoStork email (provider.email): email still sends, no Notification row.
     */
    fallbackSigner: { userId: string | null; email: string; name: string };
  }) {
    const brandData = await this.getBrandData();
    const companyName = brandData.companyName;
    const subject = `Action required: complete your W-9 for ${companyName}`;

    // W-9 requests are addressed to the people responsible for billing and
    // compliance: every PROVIDER_ADMIN and BILLING_MANAGER at the provider.
    // Anyone at the provider can still open and sign the form - this only
    // controls who gets asked.
    const roleUsers = await this.prisma.user.findMany({
      where: {
        providerId: params.providerId,
        isDisabled: false,
        roles: { hasSome: ["PROVIDER_ADMIN", "BILLING_MANAGER"] },
      },
      select: { id: true, email: true, name: true, firstName: true },
    });

    let recipients: { userId: string | null; email: string; firstName: string }[] = roleUsers
      .filter(u => !!u.email)
      .map(u => ({ userId: u.id, email: u.email as string, firstName: getFirstName(u.firstName || u.name || "") || "there" }));

    if (recipients.length === 0 && params.fallbackSigner.email) {
      recipients = [{
        userId: params.fallbackSigner.userId,
        email: params.fallbackSigner.email,
        firstName: getFirstName(params.fallbackSigner.name) || "there",
      }];
    }

    for (const r of recipients) {
      const html = buildBrandedEmail(brandData, {
        title: "Complete Your W-9",
        greeting: `Hi ${r.firstName},`,
        body: `${this.escapeHtml(companyName)} needs a completed W-9 form for <strong>${this.escapeHtml(params.providerName)}</strong>. Please fill out and sign the form using the button below - it only takes a minute.`,
        alertBox: { text: "Your W-9 is required before payouts can be processed.", type: "info" },
        buttons: [{ label: "Fill Out & Sign W-9", url: params.signingUrl }],
        footer: "If you have any questions about this request, please reply to this email.",
      });

      if (r.userId) {
        await this.dispatchNotification({
          userId: r.userId,
          type: "EMAIL",
          channel: "w9_request",
          recipient: r.email,
          subject,
          body: html,
        }).catch(e => this.logger.error(`Failed to send W-9 request email to ${r.email}: ${e.message}`));
      } else {
        await this.sendRawEmail(r.email, subject, html)
          .catch(e => this.logger.error(`Failed to send W-9 request email to ${r.email}: ${e.message}`));
      }
    }
  }

  /** GoStork provider service agreement: notify the provider's billing/admin
   *  users that the contract is ready for their signature. Sent AFTER the
   *  GoStork signer completed (fees filled in), never on initial creation. */
  async sendProviderAgreementRequestNotification(params: {
    providerId: string;
    providerName: string;
    /** GoStork page that loads the embedded signing session. */
    signingUrl: string;
    fallbackSigner: { userId: string | null; email: string; name: string };
  }) {
    const brandData = await this.getBrandData();
    const companyName = brandData.companyName;
    const subject = `Action required: sign your ${companyName} agreement`;

    const roleUsers = await this.prisma.user.findMany({
      where: {
        providerId: params.providerId,
        isDisabled: false,
        roles: { hasSome: ["PROVIDER_ADMIN", "BILLING_MANAGER"] },
      },
      select: { id: true, email: true, name: true, firstName: true },
    });

    let recipients: { userId: string | null; email: string; firstName: string }[] = roleUsers
      .filter(u => !!u.email)
      .map(u => ({ userId: u.id, email: u.email as string, firstName: getFirstName(u.firstName || u.name || "") || "there" }));

    if (recipients.length === 0 && params.fallbackSigner.email) {
      recipients = [{
        userId: params.fallbackSigner.userId,
        email: params.fallbackSigner.email,
        firstName: getFirstName(params.fallbackSigner.name) || "there",
      }];
    }

    for (const r of recipients) {
      const html = buildBrandedEmail(brandData, {
        title: "Your Agreement Is Ready to Sign",
        greeting: `Hi ${r.firstName},`,
        body: `${this.escapeHtml(companyName)} has prepared the service agreement for <strong>${this.escapeHtml(params.providerName)}</strong>. The referral-fee terms are filled in - please review and sign using the button below.`,
        alertBox: { text: "Your signed agreement is required to activate your partnership with " + this.escapeHtml(companyName) + ".", type: "info" },
        buttons: [{ label: "Review & Sign Agreement", url: params.signingUrl }],
        footer: "If you have any questions about this agreement, please reply to this email.",
      });

      if (r.userId) {
        await this.dispatchNotification({
          userId: r.userId,
          type: "EMAIL",
          channel: "provider_agreement_request",
          recipient: r.email,
          subject,
          body: html,
        }).catch(e => this.logger.error(`Failed to send agreement request email to ${r.email}: ${e.message}`));
      } else {
        await this.sendRawEmail(r.email, subject, html)
          .catch(e => this.logger.error(`Failed to send agreement request email to ${r.email}: ${e.message}`));
      }
    }
  }

  /** Tell a GoStork admin the provider signed the GoStork service agreement. */
  async sendProviderAgreementCompletedNotification(params: {
    adminUserId: string;
    adminEmail: string;
    adminName: string | null;
    providerName: string;
    /** Deep-links the button to the exact row (?agreement=<id> scroll+highlight). */
    agreementId: string;
  }) {
    const brandData = await this.getBrandData();
    const firstName = params.adminName ? getFirstName(params.adminName) : "there";
    const subject = `Agreement signed - ${params.providerName}`;

    const html = buildBrandedEmail(brandData, {
      title: "Agreement Signed",
      greeting: `Hi ${firstName},`,
      body: `<strong>${this.escapeHtml(params.providerName)}</strong> has signed the GoStork Provider Service Agreement. The executed contract is ready to view and download from the Agreements tab.`,
      alertBox: { text: "The fully signed agreement is ready to download.", type: "success" },
      buttons: [{ label: "View Sent Contracts", url: `${getBaseUrl()}/account/documents?agreement=${params.agreementId}` }],
      footer: "You can download the signed agreement from the Agreements tab at any time.",
    });

    await this.dispatchNotification({
      userId: params.adminUserId,
      type: "EMAIL",
      channel: "provider_agreement_completed",
      recipient: params.adminEmail,
      subject,
      body: html,
    }).catch(e => this.logger.error(`Failed to send agreement completed email to ${params.adminEmail}: ${e.message}`));
  }

  async sendW9CompletedNotification(params: {
    adminUserId: string;
    adminEmail: string;
    adminName: string | null;
    providerName: string;
    providerId: string;
  }) {
    const brandData = await this.getBrandData();
    const firstName = params.adminName ? getFirstName(params.adminName) : "there";
    const providerUrl = `${getBaseUrl()}/admin/providers/${params.providerId}?tab=billing`;
    const subject = `W-9 completed - ${params.providerName}`;

    const html = buildBrandedEmail(brandData, {
      title: "W-9 Completed",
      greeting: `Hi ${firstName},`,
      body: `<strong>${this.escapeHtml(params.providerName)}</strong> has completed and signed their W-9 form. You can view and download it from the provider's Billing tab.`,
      alertBox: { text: "The signed W-9 is ready to view and download.", type: "success" },
      buttons: [{ label: "View W-9", url: providerUrl }],
      footer: "You can download the signed W-9 from the provider's Billing tab at any time.",
    });

    await this.dispatchNotification({
      userId: params.adminUserId,
      type: "EMAIL",
      channel: "w9_completed",
      recipient: params.adminEmail,
      subject,
      body: html,
    }).catch(e => this.logger.error(`Failed to send W-9 completed email to ${params.adminEmail}: ${e.message}`));
  }

  private async sendRawSms(to: string, body: string, opts?: { skipConsentGate?: boolean }) {
    // Same test-run kill-switch as sendSmsWithTemplate - see the comment there.
    if (process.env.SMS_DISABLED === "1") {
      this.logger.log(`[SMS DISABLED] To: ${to}, Body: ${body.slice(0, 80)}`);
      return;
    }
    // A2P consent gate, applied here so no call site can forget it. The only
    // legitimate bypass is an internal staff alert (admin escalation), which is
    // not a consumer notification - it must be explicit at the call site.
    if (!opts?.skipConsentGate && !(await this.recipientHasSmsOptIn(to))) return;
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
    const twilioMessagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

    if (!twilioSid || !twilioToken || (!twilioFrom && !twilioMessagingServiceSid)) {
      this.logger.log(`[SMS MOCK] To: ${to}, Body: ${body}`);
      return;
    }

    // Normalize to E.164 format - add +1 for US numbers without country code
    let normalizedTo = to.replace(/[\s\-\(\)]/g, "");
    if (!normalizedTo.startsWith("+")) {
      normalizedTo = `+1${normalizedTo}`;
    }

    // 555-01xx is the reserved fictional range test fixtures use. Attempting
    // them against Twilio just burns undeliverable sends into the account's
    // reputation.
    if (/^\+1\d{3}55501\d{2}$/.test(normalizedTo)) {
      this.logger.log(`[SMS FICTIONAL] Skipping test-fixture number ${normalizedTo}`);
      return;
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
    // Prefer MessagingServiceSid (better deliverability) over raw From number
    const paramsInit: Record<string, string> = { To: normalizedTo, Body: body };
    if (twilioMessagingServiceSid) {
      paramsInit.MessagingServiceSid = twilioMessagingServiceSid;
    } else {
      paramsInit.From = twilioFrom!;
    }
    const params = new URLSearchParams(paramsInit);

    this.logger.log(`[SMS] Sending raw SMS to ${normalizedTo} via ${twilioMessagingServiceSid ? "MessagingService" : "From"}`);

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
    this.logger.log(`[SMS] Raw SMS sent successfully to ${normalizedTo}`);
  }

  // ─── Billing notifications ──────────────────────────────────────────────────

  /**
   * All logins on the same shared parent account as the given user - a
   * couple has two. Invoices, sessions, and agreements are stamped with a
   * single parentUserId, but the journey belongs to the household, so
   * every parent-facing billing/journey notification fans out through
   * this resolver to keep BOTH partners in the loop. The requested user
   * sorts first; falls back to just that user for solo accounts (or an
   * empty array if the user no longer exists).
   */
  async getParentAccountRecipients(parentUserId: string): Promise<Array<{ id: string; name: string | null; email: string; mobileNumber: string | null }>> {
    const user = await this.prisma.user.findUnique({
      where: { id: parentUserId },
      select: { id: true, name: true, email: true, mobileNumber: true, parentAccountId: true },
    });
    if (!user) return [];
    if (!user.parentAccountId) return [{ id: user.id, name: user.name, email: user.email, mobileNumber: user.mobileNumber }];
    const members = await this.prisma.user.findMany({
      where: { parentAccountId: user.parentAccountId, roles: { has: "PARENT" } },
      select: { id: true, name: true, email: true, mobileNumber: true },
      orderBy: { createdAt: "asc" },
    });
    const list = members.some(m => m.id === user.id)
      ? members
      : [{ id: user.id, name: user.name, email: user.email, mobileNumber: user.mobileNumber }, ...members];
    return list.sort((a, b) => (a.id === parentUserId ? -1 : b.id === parentUserId ? 1 : 0));
  }

  async sendPaymentRequestNotification(params: {
    parentUserId: string;
    parentName: string;
    parentEmail: string;
    parentPhone?: string | null;
    providerName: string;
    serviceType: string;
    serviceAmountFormatted: string;
    referralFeeFormatted: string;
    paymentUrl: string;
    invoiceId: string;
    sessionId: string;
    dueAt?: Date | null;
    /** Free-text description the provider attached to the invoice. */
    description?: string | null;
    /** Itemized lines. When provided, an HTML table is added to the body
     *  in addition to the row-by-row detailRows so the parent sees the same
     *  itemization they'll see in chat / on the payment page. */
    lineItems?: Array<{ label: string; description?: string | null; amountFormatted: string }>;
  }) {
    const brandData = await this.getBrandData();
    const firstName = getFirstName(params.parentName) || "there";
    const providerName = this.escapeHtml(params.providerName);
    const subject = `Payment Request - ${params.providerName} via GoStork`;
    const urgencyNote = params.dueAt
      ? `<strong>Please complete payment by ${new Date(params.dueAt).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} to secure your match.</strong>`
      : "";

    const hasLines = Array.isArray(params.lineItems) && params.lineItems.length > 0;

    // Itemized HTML table - rendered above the urgency note when line items
    // are present. Built with inline styles for email client compatibility.
    const lineItemsTable = hasLines
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:12px 0;font-family:inherit">
          <thead>
            <tr>
              <th style="text-align:left;padding:8px 8px 8px 0;border-bottom:1px solid #e5e7eb;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:600">Service</th>
              <th style="text-align:right;padding:8px 0 8px 8px;border-bottom:1px solid #e5e7eb;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:600">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${params.lineItems!.map(li => `
              <tr>
                <td style="text-align:left;padding:8px 8px 8px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#1f2937;vertical-align:top">
                  <div style="font-weight:500">${esc(li.label)}</div>
                  ${li.description && li.description.trim() ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">${esc(li.description.trim())}</div>` : ""}
                </td>
                <td style="text-align:right;padding:8px 0 8px 8px;border-bottom:1px solid #f3f4f6;font-size:14px;color:#1f2937;white-space:nowrap;vertical-align:top">${esc(li.amountFormatted)}</td>
              </tr>
            `).join("")}
            <tr>
              <td style="text-align:left;padding:10px 8px 8px 0;font-size:14px;font-weight:700;color:#1f2937">Total</td>
              <td style="text-align:right;padding:10px 0 8px 8px;font-size:16px;font-weight:700;color:${esc(brandData.brandColor || BRAND_PRIMARY_FALLBACK)};white-space:nowrap">${esc(params.serviceAmountFormatted)}</td>
            </tr>
          </tbody>
        </table>`
      : "";

    const detailRows: Array<{ label: string; value: string }> = [
      { label: "Provider", value: params.providerName },
    ];
    if (!hasLines) {
      // Legacy single-amount layout - keep Service / Total in the detail rows.
      detailRows.push({ label: "Service", value: params.serviceType });
      if (params.description && params.description.trim().length > 0) {
        detailRows.push({ label: "Description", value: params.description.trim() });
      }
      detailRows.push({ label: "Total Amount", value: params.serviceAmountFormatted });
    }
    detailRows.push({ label: "GoStork Deposit Protection", value: "Included - your funds are protected" });

    // Fan out to every login on the shared parent account so both
    // partners get the payment request, each greeted by their own name.
    const members = await this.getParentAccountRecipients(params.parentUserId);
    const targets = members.length
      ? members
      : [{ id: params.parentUserId, name: params.parentName, email: params.parentEmail, mobileNumber: params.parentPhone || null }];

    const smsSentTo = new Set<string>();
    for (const member of targets) {
      const memberFirst = getFirstName(member.name) || firstName;
      const html = buildBrandedEmail(brandData, {
        title: "Payment Request",
        greeting: `Hi ${esc(memberFirst)}, you have a payment request from <strong>${providerName}</strong> via GoStork.`,
        body: `${lineItemsTable}${urgencyNote}`,
        detailRows,
        alertBox: params.dueAt ? { text: `Time-sensitive: payment required by ${new Date(params.dueAt).toLocaleString()}`, type: "warning" as const } : undefined,
        buttons: [{ label: "Pay Now Securely", url: params.paymentUrl }],
      });

      await this.dispatchNotification({
        userId: member.id,
        type: "EMAIL",
        channel: "invoice_payment_request",
        recipient: member.email,
        subject,
        body: html,
      }).catch(e => this.logger.error(`Failed to send payment request email to ${member.email}: ${e.message}`));

      // SMS - dedupe by number since partners often share one phone.
      if (member.mobileNumber && !smsSentTo.has(member.mobileNumber)) {
        smsSentTo.add(member.mobileNumber);
        const smsBody = params.dueAt
          ? `Hi ${memberFirst}, your payment of ${params.serviceAmountFormatted} for ${params.providerName} is due soon.\n\nPay securely via GoStork:\n${params.paymentUrl}`
          : `Hi ${memberFirst}, you have a payment request of ${params.serviceAmountFormatted} from ${params.providerName}.\n\nPay securely via GoStork:\n${params.paymentUrl}`;
        await this.sendRawSms(member.mobileNumber, smsBody).catch(e =>
          this.logger.error(`Failed to send payment request SMS: ${e.message}`),
        );
      }
    }
  }

  /**
   * Sends the payment receipt email (with a detailed PDF attached) to both
   * the parent who paid and to the provider's billing-recipient email
   * addresses. Triggered from billing.service after the Stripe webhook
   * marks the invoice PAID.
   *
   * The PDF is rendered once and attached to both emails so parent and
   * agency see the same document.
   */
  async sendPaymentReceiptEmails(params: {
    parentName: string;
    parentEmail: string;
    parentUserId?: string;
    providerName: string;
    providerEmails: string[]; // billing-recipient emails for the agency
    receiptNumber: string;
    paidAmountFormatted: string;
    serviceType: string;
    description?: string | null;
    paidAtIso: string;
    pdf: Buffer;
    /** Itemized lines, rendered as an HTML table in both emails. */
    lineItems?: Array<{ label: string; description?: string | null; amountFormatted: string }>;
  }) {
    const brandData = await this.getBrandData();
    const firstName = getFirstName(params.parentName) || "there";
    const filename = `GoStork-Receipt-${params.receiptNumber}.pdf`;
    const attachments = [{ filename, content: params.pdf, mimeType: "application/pdf" }];

    const hasLines = Array.isArray(params.lineItems) && params.lineItems.length > 0;
    const lineItemsTable = hasLines
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:12px 0;font-family:inherit">
          <thead>
            <tr>
              <th style="text-align:left;padding:8px 8px 8px 0;border-bottom:1px solid #e5e7eb;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:600">Service</th>
              <th style="text-align:right;padding:8px 0 8px 8px;border-bottom:1px solid #e5e7eb;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:600">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${params.lineItems!.map(li => `
              <tr>
                <td style="text-align:left;padding:8px 8px 8px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#1f2937;vertical-align:top">
                  <div style="font-weight:500">${esc(li.label)}</div>
                  ${li.description && li.description.trim() ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">${esc(li.description.trim())}</div>` : ""}
                </td>
                <td style="text-align:right;padding:8px 0 8px 8px;border-bottom:1px solid #f3f4f6;font-size:14px;color:#1f2937;white-space:nowrap;vertical-align:top">${esc(li.amountFormatted)}</td>
              </tr>
            `).join("")}
            <tr>
              <td style="text-align:left;padding:10px 8px 8px 0;font-size:14px;font-weight:700;color:#1f2937">Total Paid</td>
              <td style="text-align:right;padding:10px 0 8px 8px;font-size:16px;font-weight:700;color:${esc(brandData.brandColor || BRAND_PRIMARY_FALLBACK)};white-space:nowrap">${esc(params.paidAmountFormatted)}</td>
            </tr>
          </tbody>
        </table>`
      : "";

    const baseRows: Array<{ label: string; value: string }> = [
      { label: "Receipt Number", value: params.receiptNumber },
      { label: "Provider",       value: params.providerName },
    ];
    if (!hasLines) {
      baseRows.push({ label: "Service", value: params.serviceType });
      if (params.description && params.description.trim()) {
        baseRows.push({ label: "Description", value: params.description.trim() });
      }
      baseRows.push({ label: "Amount Paid", value: params.paidAmountFormatted });
    }
    baseRows.push({
      label: "Date Processed",
      value: new Date(params.paidAtIso).toLocaleString("en-US", {
        year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
      }),
    });

    // ── Parent: receipt + thank-you ─────────────────────────────────────
    // Both partners on a shared account get the receipt, each greeted by
    // their own name and deduped by email address.
    const members = params.parentUserId ? await this.getParentAccountRecipients(params.parentUserId) : [];
    const parentTargets = members.length
      ? members
      : [{ id: params.parentUserId || "", name: params.parentName, email: params.parentEmail, mobileNumber: null }];

    const parentSubject = `Receipt for your payment to ${params.providerName} via GoStork`;
    const emailedTo = new Set<string>();
    for (const member of parentTargets) {
      if (!member.email || emailedTo.has(member.email)) continue;
      emailedTo.add(member.email);
      const parentHtml = buildBrandedEmail(brandData, {
        title: "Payment Receipt",
        greeting: `Hi ${esc(getFirstName(member.name) || firstName)}, thank you for your payment!`,
        body: `Your payment to <strong>${esc(params.providerName)}</strong> has been received and processed successfully. A detailed receipt is attached to this email as a PDF - you can save it or forward it to your employer (FSA/HSA), insurance carrier, or accountant as needed.${lineItemsTable}`,
        detailRows: baseRows,
        footer: "Need help? Reply to this email or contact billing@gostork.com.",
      });
      try {
        await this.sendRawEmail(member.email, parentSubject, parentHtml, { attachments });
      } catch (e: any) {
        this.logger.warn(`Receipt email to parent ${member.email} failed: ${e?.message}`);
      }
    }

    // ── Agency: payment-received notice + same PDF ──────────────────────
    const agencySubject = `Payment received - ${params.paidAmountFormatted} from ${params.parentName}`;
    // Receiving an invoice opened Gate B for this provider, so the contact
    // rows are fine here; the CRM link lets them open the family's record.
    const agencyRows: Array<{ label: string; value: string }> = [
      { label: "Receipt Number", value: params.receiptNumber },
      ...(await this.parentDetailRows(params.parentUserId, params.parentName, { contact: true })),
    ];
    if (!hasLines) {
      agencyRows.push({ label: "Service", value: params.serviceType });
      if (params.description && params.description.trim()) {
        agencyRows.push({ label: "Description", value: params.description.trim() });
      }
      agencyRows.push({ label: "Amount Paid", value: params.paidAmountFormatted });
    }
    agencyRows.push({
      label: "Date Processed",
      value: new Date(params.paidAtIso).toLocaleString("en-US", {
        year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
      }),
    });
    const agencyHtml = buildBrandedEmail(brandData, {
      title: "Payment Received",
      greeting: `Hi team,`,
      body: `<strong>${esc(params.parentName)}</strong> has paid <strong>${esc(params.paidAmountFormatted)}</strong> for services with <strong>${esc(params.providerName)}</strong>. A receipt PDF is attached for your records. Your provider payout will be initiated per the GoStork billing schedule.${lineItemsTable}`,
      detailRows: agencyRows,
    });

    for (const email of params.providerEmails) {
      if (!email) continue;
      try {
        await this.sendRawEmail(email, agencySubject, agencyHtml, { attachments });
      } catch (e: any) {
        this.logger.warn(`Receipt email to agency ${email} failed: ${e?.message}`);
      }
    }
  }

  async sendInvoiceReminderNotification(params: {
    parentUserId: string;
    parentEmail: string;
    parentPhone?: string | null;
    providerName: string;
    paymentUrl: string;
    reminderType: string;
    invoiceId: string;
  }) {
    let smsBody = "";
    if (params.reminderType === "4h_remaining") {
      smsBody = `Urgent: Only 4 hours left to secure your surrogate match with ${params.providerName}.\n\nPay now: ${params.paymentUrl}`;
    } else if (params.reminderType === "1h_remaining") {
      smsBody = `Last chance: 1 hour remaining to reserve your match with ${params.providerName}.\n\nPay now: ${params.paymentUrl}`;
    } else if (params.reminderType === "expired") {
      smsBody = `Your 24-hour hold with ${params.providerName} has expired. Contact GoStork to explore next steps.`;
    }

    if (!smsBody) return;
    // Countdown reminders reach every partner on the account (deduped by
    // phone - couples often share one number).
    const members = await this.getParentAccountRecipients(params.parentUserId);
    const phones = new Set<string>(
      (members.length ? members.map(m => m.mobileNumber) : [params.parentPhone]).filter(Boolean) as string[],
    );
    for (const phone of Array.from(phones)) {
      await this.sendRawSms(phone, smsBody).catch(e =>
        this.logger.error(`Failed to send reminder SMS (${params.reminderType}): ${e.message}`),
      );
    }
  }

  async sendPostCallReadinessNotification(params: {
    parentUserId: string;
    parentName: string;
    parentEmail: string;
    parentPhone?: string | null;
    providerName: string;
    chatUrl: string; // deep link back to the private Ariel chat session
  }) {
    const brandData = await this.getBrandData();
    const firstName = getFirstName(params.parentName) || "there";
    const providerName = this.escapeHtml(params.providerName);
    const subject = `How did your consultation with ${params.providerName} go?`;

    const html = buildBrandedEmail(brandData, {
      title: "How did your consultation go?",
      greeting: `Hi ${esc(firstName)},`,
      body: `Your consultation with <strong>${providerName}</strong> has just ended. We'd love to hear how it went and help you decide on next steps.`,
      buttons: [{ label: "Share Your Thoughts", url: params.chatUrl }],
      footer: "You can reply directly in your GoStork AI Concierge chat. Your response is private.",
    });

    await this.dispatchNotification({
      userId: params.parentUserId,
      type: "EMAIL",
      channel: "consultation_ended",
      recipient: params.parentEmail,
      subject,
      body: html,
    }).catch(e => this.logger.error(`Failed to send post-call email to ${params.parentEmail}: ${e.message}`));

    // SMS - use Twilio Content Template if configured, otherwise fall back to raw SMS
    if (params.parentPhone) {
      const smsSid = TWILIO_TEMPLATES.POST_CALL_FOLLOWUP_PARENT;
      if (smsSid && !smsSid.includes("PLACEHOLDER")) {
        this.dispatchSmsTemplate({
          userId: params.parentUserId,
          channel: "consultation_ended",
          recipient: params.parentPhone,
          contentSid: smsSid,
          contentVars: { "1": firstName, "2": params.providerName, "3": params.chatUrl },
        }).catch(e => this.logger.error(`Failed to send post-call SMS: ${e.message}`));
      } else {
        this.sendRawSms(
          params.parentPhone,
          `Hi ${firstName}, your consultation with ${params.providerName} just ended. How did it go?\n\nLet Ariel know: ${params.chatUrl}`,
        ).catch(e => this.logger.error(`Failed to send post-call SMS (raw): ${e.message}`));
      }
    }
  }

  async sendParentReadyAdminNotification(params: {
    adminUserId: string;
    adminEmail: string;
    parentName: string;
    parentUserId?: string | null;
    providerName: string;
    providerType: string;
    billingUrl: string;
  }) {
    const brandData = await this.getBrandData();
    const subject = `${params.parentName} is ready to move forward with ${params.providerName}`;
    const providerLabel = params.providerType ? `${params.providerName} (${params.providerType})` : params.providerName;

    const html = buildBrandedEmail(brandData, {
      title: "Parent Ready to Proceed",
      greeting: "Hi GoStork Team,",
      body: `<strong>${esc(params.parentName)}</strong> has confirmed they are ready to move forward with <strong>${esc(providerLabel)}</strong>. Please create their invoice in the billing dashboard.`,
      detailRows: await this.parentDetailRows(params.parentUserId, params.parentName, { contact: true }),
      buttons: [{ label: "Create Invoice", url: params.billingUrl }],
      footer: "This is an automated notification from the GoStork billing system.",
    });

    await this.dispatchNotification({
      userId: params.adminUserId,
      type: "EMAIL",
      channel: "billing_admin",
      recipient: params.adminEmail,
      subject,
      body: html,
    }).catch(e => this.logger.error(`Failed to send parent-ready admin email to ${params.adminEmail}: ${e.message}`));
  }

  async sendInvoicePaidAdminNotification(params: {
    invoiceId: string;
    parentName: string;
    parentUserId?: string | null;
    providerName: string;
    serviceType: string;
    serviceAmountFormatted: string;
    referralFeeFormatted: string;
    providerPayoutFormatted: string;
    sessionId: string;
  }) {
    const brandData = await this.getBrandData();
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" } },
      select: { id: true, email: true },
    });

    const billingUrl = `${getBaseUrl()}/admin/billing`;
    const subject = `Payment Received - ${params.providerName} (${params.serviceAmountFormatted})`;
    const html = buildBrandedEmail(brandData, {
      title: "Payment Received",
      greeting: `A parent has completed their payment for <strong>${esc(params.providerName)}</strong>.`,
      body: "",
      detailRows: [
        ...(await this.parentDetailRows(params.parentUserId, params.parentName, { contact: true })),
        { label: "Provider",        value: params.providerName },
        { label: "Service",         value: params.serviceType },
        { label: "Total Collected", value: params.serviceAmountFormatted },
        { label: "GoStork Fee",     value: params.referralFeeFormatted },
        { label: "Provider Payout", value: params.providerPayoutFormatted },
      ],
      alertBox: { text: `Action required: initiate provider payout of ${params.providerPayoutFormatted} to ${params.providerName}.`, type: "warning" as const },
      buttons: [{ label: "View in Billing Dashboard", url: billingUrl }],
    });

    for (const admin of admins) {
      await this.dispatchNotification({
        userId: admin.id,
        type: "EMAIL",
        channel: "invoice_paid_admin",
        recipient: admin.email,
        subject,
        body: html,
      });
    }
  }

  /**
   * Sent to the parent when a delayed-notification payment (ACH Direct Debit)
   * has been submitted but funds have not yet cleared. The transaction will
   * complete in 3-5 business days; a second email goes out on payment_intent.
   * succeeded (the existing payment-receipt flow). Without this notification
   * the parent's only signal would be the invoice flipping from
   * AWAITING_PAYMENT to PAID days later - they'd assume the payment failed
   * and re-attempt, sometimes resulting in a duplicate authorization on a card.
   */
  async sendInvoiceProcessingNotification(params: { invoiceId: string }) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: params.invoiceId },
      include: { parentUser: true },
    });
    if (!invoice || !invoice.parentUser?.email) return;

    const brandData = await this.getBrandData();
    const firstName = getFirstName(invoice.parentUser.name) || "there";
    const providerName = this.escapeHtml(invoice.providerName);
    const amountFormatted = `${formatMoneyCents(invoice.serviceAmount, invoice.currency || "USD")} ${invoice.currency || "USD"}`;
    const isAch = invoice.paymentMethod === "ACH";
    const methodLabel = isAch ? "ACH bank transfer" : "payment";
    const subject = `Your ${methodLabel} to ${invoice.providerName} is processing`;

    // Both partners on a shared account get the processing notice.
    const members = await this.getParentAccountRecipients(invoice.parentUserId);
    const targets = members.length
      ? members
      : [{ id: invoice.parentUserId, name: invoice.parentUser.name, email: invoice.parentUser.email, mobileNumber: null }];
    for (const member of targets) {
      const html = buildBrandedEmail(brandData, {
        title: "Payment Processing",
        greeting: `Hi ${esc(getFirstName(member.name) || firstName)},`,
        body: isAch
          ? `Your ACH bank transfer of <strong>${amountFormatted}</strong> to <strong>${providerName}</strong> has been submitted and is now processing. ACH transfers typically take <strong>3-5 business days</strong> to clear.`
          : `Your payment of <strong>${amountFormatted}</strong> to <strong>${providerName}</strong> has been submitted and is now processing.`,
        detailRows: [
          { label: "Provider", value: invoice.providerName },
          { label: "Amount",   value: amountFormatted },
          { label: "Method",   value: isAch ? "ACH Direct Debit" : "Bank transfer" },
          { label: "Status",   value: "Processing - awaiting clearance" },
        ],
        alertBox: {
          text: isAch
            ? "No further action is required. We'll email you a receipt as soon as the funds clear. Please do not re-submit this payment."
            : "No further action is required. We'll email you a receipt as soon as the payment clears.",
          type: "info",
        },
        footer: "Questions? Reply to this email and we'll help right away.",
      });

      await this.dispatchNotification({
        userId: member.id,
        type: "EMAIL",
        channel: "invoice_processing",
        recipient: member.email,
        subject,
        body: html,
      }).catch(e => this.logger.error(`Failed to send invoice-processing email to ${member.email}: ${e.message}`));
    }
  }

  /**
   * Sent to the parent right after they request wire-transfer instructions,
   * so they have a copy of the bank details + reference code to take into
   * their bank's app. Stripe will not match the inbound wire unless the
   * parent puts the reference code in the memo - that field is highlighted
   * separately in the email so it's hard to miss.
   */
  async sendWireInstructionsNotification(params: { invoiceId: string }) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: params.invoiceId },
      include: { parentUser: true },
    });
    if (!invoice || !invoice.parentUser?.email) return;
    const wire = (invoice as any).wireInstructionsJson;
    if (!wire || !wire.accounts || wire.accounts.length === 0) return;

    const brandData = await this.getBrandData();
    const firstName = getFirstName(invoice.parentUser.name) || "there";
    const providerName = this.escapeHtml(invoice.providerName);
    const amountFormatted = `${formatMoneyCents(invoice.serviceAmount, invoice.currency || "USD")} ${(invoice.currency || "USD").toUpperCase()}`;
    const reference = this.escapeHtml(wire.reference || "");
    const subject = `Wire transfer instructions for ${invoice.providerName}`;

    // Build a detailRows list per bank account Stripe returned. Most parents
    // will only see a single us_bank_account entry; we still iterate so EU/UK
    // additions later just work.
    const detailRows: Array<{ label: string; value: string }> = [
      { label: "Amount",   value: amountFormatted },
      { label: "Provider", value: invoice.providerName },
    ];
    const acct = wire.accounts[0] || {};
    if (acct.bankName)          detailRows.push({ label: "Bank",              value: this.escapeHtml(String(acct.bankName)) });
    if (acct.accountHolderName) detailRows.push({ label: "Beneficiary",       value: this.escapeHtml(String(acct.accountHolderName)) });
    if (acct.routingNumber)     detailRows.push({ label: "Routing number",    value: this.escapeHtml(String(acct.routingNumber)) });
    if (acct.accountNumber)     detailRows.push({ label: "Account number",    value: this.escapeHtml(String(acct.accountNumber)) });
    if (acct.swiftCode)         detailRows.push({ label: "SWIFT / BIC",       value: this.escapeHtml(String(acct.swiftCode)) });
    if (acct.iban)              detailRows.push({ label: "IBAN",              value: this.escapeHtml(String(acct.iban)) });
    if (acct.sortCode)          detailRows.push({ label: "Sort code",         value: this.escapeHtml(String(acct.sortCode)) });

    const buttons = wire.hostedInstructionsUrl
      ? [{ label: "View Instructions Online", url: String(wire.hostedInstructionsUrl) }]
      : [];

    // Both partners on a shared account get the wire instructions - either
    // of them may be the one walking into their bank app.
    const members = await this.getParentAccountRecipients(invoice.parentUserId);
    const targets = members.length
      ? members
      : [{ id: invoice.parentUserId, name: invoice.parentUser.name, email: invoice.parentUser.email, mobileNumber: null }];
    for (const member of targets) {
      const html = buildBrandedEmail(brandData, {
        title: "Your Wire Transfer Instructions",
        greeting: `Hi ${esc(getFirstName(member.name) || firstName)},`,
        body: `Use the bank details below to wire <strong>${amountFormatted}</strong> to <strong>${providerName}</strong>. International wires usually arrive within 1-3 business days; your bank may charge a wire fee that is not included in the invoice total.`,
        detailRows,
        alertBox: {
          text: `<strong>IMPORTANT:</strong> You must include this reference code in your wire memo, or your bank cannot match the payment: <strong style="font-family: monospace; font-size: 16px;">${reference}</strong>`,
          type: "warning" as const,
        },
        buttons,
        footer: "Questions? Reply to this email and we'll help right away.",
      });

      await this.dispatchNotification({
        userId: member.id,
        type: "EMAIL",
        channel: "wire_instructions",
        recipient: member.email,
        subject,
        body: html,
      }).catch(e => this.logger.error(`Failed to send wire-instructions email to ${member.email}: ${e.message}`));
    }
  }

  // ─── Cost sheet notifications ───────────────────────────────────────────────

  async sendCostSheetReadyToParent(params: {
    parentUserId: string;
    parentName: string;
    parentEmail: string;
    parentPhone?: string | null;
    providerName: string;
    providerId: string;
    sessionId: string;
    totalCostFormatted: string;
    hasFile: boolean;
  }) {
    const brandData = await this.getBrandData();
    const firstName = getFirstName(params.parentName) || "there";
    const providerName = this.escapeHtml(params.providerName);
    const chatUrl = `${getBaseUrl()}/chat/${params.providerId}/${params.sessionId}`;
    const subject = `${params.providerName} sent you a cost sheet`;

    // Both partners on a shared account get the cost sheet notice, each
    // greeted by their own name.
    const members = await this.getParentAccountRecipients(params.parentUserId);
    const targets = members.length
      ? members
      : [{ id: params.parentUserId, name: params.parentName, email: params.parentEmail, mobileNumber: params.parentPhone || null }];
    const smsSentTo = new Set<string>();
    for (const member of targets) {
      const html = buildBrandedEmail(brandData, {
        title: "Cost Sheet from Your Provider",
        greeting: `Hi ${esc(getFirstName(member.name) || firstName)},`,
        body: `<strong>${providerName}</strong> has sent you ${params.hasFile ? "a cost sheet and" : ""} a total quoted cost for your service. You can review the details in your GoStork chat.`,
        detailRows: [
          { label: "Provider",           value: params.providerName },
          { label: "Total Quoted Cost",  value: params.totalCostFormatted },
        ],
        buttons: [{ label: "View in Chat", url: chatUrl }],
      });
      await this.dispatchNotification({
        userId: member.id,
        type: "EMAIL",
        channel: "cost_sheet_ready",
        recipient: member.email,
        subject,
        body: html,
      }).catch(e => this.logger.error(`Failed to send cost sheet email to ${member.email}: ${e.message}`));

      if (member.mobileNumber && !smsSentTo.has(member.mobileNumber)) {
        smsSentTo.add(member.mobileNumber);
        await this.sendRawSms(
          member.mobileNumber,
          `Hi ${getFirstName(member.name) || firstName}, ${params.providerName} sent a cost sheet (${params.totalCostFormatted}) via GoStork.\n\nView it here: ${chatUrl}`,
        ).catch(e => this.logger.error(`Failed to send cost sheet SMS: ${e.message}`));
      }
    }
  }

  async sendWhisperPendingReminder(params: {
    providerUserIds: string[];
    providerName: string;
    parentName: string;
    sessionId: string;
    providerId: string;
    // The provider conversations page resolves /chat/:entityId/:subjectId
    // with entityId = parent userId for provider viewers. Pass the parent
    // userId so the deep link auto-opens the conversation instead of
    // dumping the provider on the inbox shell.
    parentUserId: string;
    questionPreview: string;
    stage: "first" | "second" | "escalation";
    ageFormatted: string;
  }) {
    const brandData = await this.getBrandData();
    const chatUrl = `${getBaseUrl()}/chat/${params.parentUserId}/${params.sessionId}`;
    const preview = params.questionPreview.length > 220
      ? params.questionPreview.slice(0, 220) + "..."
      : params.questionPreview;

    const copy = {
      first: {
        title: `A prospective parent is waiting for an answer (${params.ageFormatted})`,
        body: `A prospective parent asked a question through the GoStork AI concierge and has been waiting <strong>${esc(params.ageFormatted)}</strong> for a reply. Your answer is relayed by Eva and stays anonymous.<br/><br/><em>"${esc(preview)}"</em>`,
        smsBody: `GoStork: a parent is waiting ${params.ageFormatted} for your reply.\n\nQuestion: "${preview.slice(0, 80)}..."\n\nReply: ${chatUrl}`,
      },
      second: {
        title: `Still waiting (${params.ageFormatted}) - parent may move on`,
        body: `A prospective parent has now been waiting <strong>${esc(params.ageFormatted)}</strong> for an answer through the GoStork AI concierge. Parents who don't hear back within 24-48 hours often move on to other providers.<br/><br/><em>"${esc(preview)}"</em>`,
        smsBody: `GoStork reminder: parent has waited ${params.ageFormatted}. They may move on if no reply.\n\nQuestion: "${preview.slice(0, 80)}..."\n\nReply: ${chatUrl}`,
      },
      escalation: {
        title: `Escalated: parent has waited ${params.ageFormatted} for an answer`,
        body: `A prospective parent has waited <strong>${esc(params.ageFormatted)}</strong> without a response. GoStork has been notified and may follow up on your behalf. Please reply as soon as possible.<br/><br/><em>"${esc(preview)}"</em>`,
        smsBody: `GoStork ESCALATED: parent waited ${params.ageFormatted}. GoStork has been notified.\n\nReply now: ${chatUrl}`,
      },
    }[params.stage];

    const html = buildBrandedEmail(brandData, {
      title: copy.title,
      greeting: `Hi ${params.providerName},`,
      body: copy.body,
      buttons: [{ label: "Open Chat & Reply", url: chatUrl }],
    });

    for (const userId of params.providerUserIds) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, mobileNumber: true },
      });
      if (!user?.email) continue;

      await this.dispatchNotification({
        userId,
        type: "EMAIL",
        channel: "whisper_pending",
        recipient: user.email,
        subject: copy.title,
        body: html,
      }).catch(e => this.logger.error(`Failed to send whisper-pending email: ${e.message}`));

      if (user.mobileNumber) {
        await this.sendRawSms(user.mobileNumber, copy.smsBody).catch(e =>
          this.logger.error(`Failed to send whisper-pending SMS: ${e.message}`),
        );
      }
    }
  }

  async sendCostSheetMissingToProvider(params: {
    providerUserIds: string[];
    providerName: string;
    parentName: string;
    sessionId: string;
    providerId: string;
    // Provider chat URLs route by parent userId, not provider id. See
    // sendWhisperPendingReminder above for the same reason.
    parentUserId: string;
    reason: "pre_meeting_24h" | "pre_meeting_1h" | "post_readiness";
    meetingTimeFormatted?: string;
  }) {
    const brandData = await this.getBrandData();
    const chatUrl = `${getBaseUrl()}/chat/${params.parentUserId}/${params.sessionId}`;
    const reasonCopy = {
      pre_meeting_24h: {
        title: "Send a cost sheet before tomorrow's meeting",
        body: `Your meeting with <strong>${esc(params.parentName)}</strong>${params.meetingTimeFormatted ? ` (${params.meetingTimeFormatted})` : ""} is coming up. Send a cost sheet now so the parent's invoice can be issued automatically once they're ready to proceed.`,
        smsBody: `Reminder: your meeting with ${params.parentName}${params.meetingTimeFormatted ? ` (${params.meetingTimeFormatted})` : ""} is in ~24h.\n\nSend a cost sheet on GoStork so we can invoice them when they're ready:\n${chatUrl}`,
      },
      pre_meeting_1h: {
        title: "Your meeting starts in 1 hour - send a cost sheet",
        body: `Your meeting with <strong>${esc(params.parentName)}</strong>${params.meetingTimeFormatted ? ` (${params.meetingTimeFormatted})` : ""} starts soon. Send a cost sheet so the invoice can flow automatically afterwards.`,
        smsBody: `Your meeting with ${params.parentName} starts in ~1h.\n\nSend a cost sheet on GoStork: ${chatUrl}`,
      },
      post_readiness: {
        title: "Parent is ready - please send a cost sheet",
        body: `<strong>${esc(params.parentName)}</strong> has confirmed they are ready to proceed, but no cost sheet has been sent yet. Send one now so we can issue their invoice.`,
        smsBody: `${params.parentName} is ready to proceed but no cost sheet has been sent. Send one on GoStork to issue their invoice: ${chatUrl}`,
      },
    }[params.reason];

    const html = buildBrandedEmail(brandData, {
      title: reasonCopy.title,
      greeting: `Hi,`,
      body: reasonCopy.body,
      buttons: [{ label: "Send Cost Sheet", url: chatUrl }],
    });

    for (const userId of params.providerUserIds) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, mobileNumber: true },
      });
      if (!user?.email) continue;

      await this.dispatchNotification({
        userId,
        type: "EMAIL",
        channel: "cost_sheet_missing",
        recipient: user.email,
        subject: reasonCopy.title,
        body: html,
      }).catch(e => this.logger.error(`Failed to send cost-sheet reminder email: ${e.message}`));

      if (user.mobileNumber) {
        await this.sendRawSms(user.mobileNumber, reasonCopy.smsBody).catch(e =>
          this.logger.error(`Failed to send cost-sheet reminder SMS: ${e.message}`),
        );
      }
    }
  }
}
