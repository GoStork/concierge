import { Injectable, Inject, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Provider booking auto-reply.
 *
 * A provider writes a first message (plus optional attachments) in their
 * settings; the moment a parent books a call with them it is posted into the
 * shared 3-way chat as a real provider message - their name, their avatar - so
 * the parent gets an immediate, human-feeling response instead of silence
 * until the provider logs in.
 *
 * Two rules make this non-trivial and both live here:
 *
 *  1. SCOPE. One org-wide default, overridable per staff member, and scoped per
 *     service line (a coordinator who runs both egg-donor and surrogacy calls
 *     needs a different greeting for each). Resolution walks most-specific to
 *     least: staff+service -> staff-any -> org+service -> org-any -> nothing.
 *
 *  2. SEND ONCE per parent + provider + service line. The second egg-donor
 *     thread with the same agency stays quiet; a surrogacy thread with that
 *     same agency still gets its own greeting.
 */

export type AutoReplyAttachment = {
  originalName?: string | null;
  url?: string | null;
  mimeType?: string | null;
  size?: number | null;
};

/** Session subjectType -> ProviderType.name. Session values are loose and
 *  historically inconsistent ("egg_donor", "egg", "surrog", "surrogate"), so
 *  match on substrings rather than an exact set. */
const SUBJECT_TYPE_TO_PROVIDER_TYPE: Array<{ test: RegExp; typeName: string }> = [
  { test: /egg.*bank/i, typeName: "Egg Bank" },
  { test: /sperm/i, typeName: "Sperm Bank" },
  { test: /egg|donor/i, typeName: "Egg Donor Agency" },
  { test: /surrog/i, typeName: "Surrogacy Agency" },
  { test: /legal|lawyer|attorney/i, typeName: "Legal Services" },
  { test: /clinic|doctor|ivf/i, typeName: "IVF Clinic" },
];

@Injectable()
export class AutoReplyService {
  private readonly logger = new Logger(AutoReplyService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Which of this provider's service lines does this booking belong to?
   *
   * Prefers the chat thread's own subjectType (the parent booked about a
   * specific egg donor / surrogate / clinic). When that is absent or does not
   * map, falls back to the provider's single approved service - an org that
   * only runs one service line has no ambiguity to resolve. Returns null when
   * genuinely unknown, which the resolver treats as "any service".
   */
  async resolveProviderTypeId(opts: {
    providerId: string;
    subjectType?: string | null;
  }): Promise<string | null> {
    const services = await this.prisma.providerService.findMany({
      where: { providerId: opts.providerId, status: "APPROVED" },
      include: { providerType: true },
    });
    if (services.length === 0) return null;

    const subject = (opts.subjectType || "").trim();
    if (subject) {
      const match = SUBJECT_TYPE_TO_PROVIDER_TYPE.find((m) => m.test.test(subject));
      if (match) {
        const svc = services.find((s: any) => s.providerType?.name === match.typeName);
        if (svc) return svc.providerTypeId;
      }
    }

    // No usable subject label: unambiguous only when the org runs exactly one line.
    if (services.length === 1) return services[0].providerTypeId;
    return null;
  }

  /**
   * Walk the scope chain from most specific to least. Only enabled templates
   * with a non-empty body are eligible.
   */
  async resolveTemplate(opts: {
    providerId: string;
    staffUserId?: string | null;
    providerTypeId?: string | null;
  }): Promise<any | null> {
    const { providerId, staffUserId, providerTypeId } = opts;

    const candidates: Array<{ staffUserId: string | null; providerTypeId: string | null }> = [];
    if (staffUserId && providerTypeId) candidates.push({ staffUserId, providerTypeId });
    if (staffUserId) candidates.push({ staffUserId, providerTypeId: null });
    if (providerTypeId) candidates.push({ staffUserId: null, providerTypeId });
    candidates.push({ staffUserId: null, providerTypeId: null });

    for (const scope of candidates) {
      const found = await this.prisma.providerAutoReply.findFirst({
        where: {
          providerId,
          staffUserId: scope.staffUserId,
          providerTypeId: scope.providerTypeId,
          isEnabled: true,
        },
      });
      if (found && String(found.body || "").trim()) return found;
    }
    return null;
  }

  /**
   * Fill the personalization tokens. Unknown tokens are left untouched rather
   * than blanked, so a typo is visible to the provider instead of silently
   * producing a hole in the sentence.
   */
  renderBody(
    body: string,
    vars: {
      parentName?: string | null;
      providerName?: string | null;
      staffName?: string | null;
      callType?: string | null;
      callTime?: string | null;
    },
  ): string {
    const map: Record<string, string> = {
      parent_name: vars.parentName || "there",
      provider_name: vars.providerName || "our team",
      staff_name: vars.staffName || vars.providerName || "our team",
      call_type: vars.callType || "call",
      call_time: vars.callTime || "the scheduled time",
    };
    return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key: string) => {
      const v = map[String(key).toLowerCase()];
      return v === undefined ? whole : v;
    });
  }

  /** Human-readable call time in the booker's own timezone. */
  formatCallTime(scheduledAt: Date, timezone?: string | null): string {
    try {
      return new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
        timeZone: timezone || "America/New_York",
      }).format(scheduledAt);
    } catch {
      return new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(scheduledAt);
    }
  }

  /**
   * Post the greeting into `sessionId`, if one is configured and this parent
   * has not already received one for this provider + service line.
   *
   * Never throws: a failure here must not take down a booking that already
   * succeeded. Returns whether a message was actually posted.
   */
  async sendForBooking(opts: {
    providerId: string;
    staffUserId?: string | null;
    sessionId: string;
    parentUserId: string;
    parentAccountId?: string | null;
    parentName?: string | null;
    providerName?: string | null;
    staffName?: string | null;
    subjectType?: string | null;
    bookingId?: string | null;
    scheduledAt?: Date | null;
    bookerTimezone?: string | null;
    meetingSubtype?: string | null;
  }): Promise<boolean> {
    try {
      const providerTypeId = await this.resolveProviderTypeId({
        providerId: opts.providerId,
        subjectType: opts.subjectType,
      });

      const template = await this.resolveTemplate({
        providerId: opts.providerId,
        staffUserId: opts.staffUserId,
        providerTypeId,
      });
      if (!template) return false;

      // Send-once check. The unique index is the real guard (two concurrent
      // booking POSTs would both pass this read), but checking first keeps the
      // common case out of the exception path.
      const dedupeOwner = opts.parentAccountId || opts.parentUserId;
      const alreadySent = await this.prisma.providerAutoReplySend.findFirst({
        where: {
          providerId: opts.providerId,
          providerTypeId,
          ...(opts.parentAccountId
            ? { parentAccountId: opts.parentAccountId }
            : { parentAccountId: null, parentUserId: opts.parentUserId }),
        },
        select: { id: true },
      });
      if (alreadySent) {
        this.logger.log(
          `[auto-reply] Already sent to ${dedupeOwner} for provider ${opts.providerId} / type ${providerTypeId ?? "any"} - skipping`,
        );
        return false;
      }

      // Claim the slot BEFORE posting. If a concurrent request already claimed
      // it the unique index rejects us here and we bail without double-posting.
      let sendRow: any;
      try {
        sendRow = await this.prisma.providerAutoReplySend.create({
          data: {
            autoReplyId: template.id,
            providerId: opts.providerId,
            parentAccountId: opts.parentAccountId || null,
            parentUserId: opts.parentUserId,
            providerTypeId,
            sessionId: opts.sessionId,
            bookingId: opts.bookingId || null,
          },
        });
      } catch (e: any) {
        this.logger.log(`[auto-reply] Lost the send race for ${dedupeOwner} - skipping (${e?.message})`);
        return false;
      }

      const callType =
        opts.meetingSubtype === "MATCH_CALL"
          ? "match call"
          : opts.meetingSubtype === "DOCTOR_CONSULTATION"
            ? "doctor call"
            : "consultation";

      const content = this.renderBody(String(template.body), {
        parentName: opts.parentName,
        providerName: opts.providerName,
        staffName: opts.staffName,
        callType,
        callTime: opts.scheduledAt ? this.formatCallTime(opts.scheduledAt, opts.bookerTimezone) : null,
      });

      // senderType "provider" is what makes this render with the provider's
      // name and avatar on the parent's side. Note this writes the message
      // directly rather than going through the provider send endpoint in
      // chat-router.ts, which is deliberate: that endpoint flips the session to
      // PROVIDER_CONNECTED, and an automated greeting must NOT mark a provider
      // as having actually joined the conversation.
      const senderName = opts.staffName || opts.providerName || "Provider";
      await this.prisma.aiChatMessage.create({
        data: {
          sessionId: opts.sessionId,
          role: "assistant",
          content,
          senderType: "provider",
          senderName,
          uiCardData: { isAutoReply: true } as any,
        },
      });

      const attachments: AutoReplyAttachment[] = Array.isArray(template.attachments)
        ? (template.attachments as any[])
        : [];
      for (const file of attachments) {
        if (!file?.url) continue;
        await this.prisma.aiChatMessage.create({
          data: {
            sessionId: opts.sessionId,
            role: "assistant",
            content: `Shared a file: ${file.originalName || "Attachment"}`,
            senderType: "provider",
            senderName,
            uiCardType: "attachment",
            uiCardData: {
              isAutoReply: true,
              url: file.url,
              originalName: file.originalName || "Attachment",
              mimeType: file.mimeType || "application/octet-stream",
              size: file.size ?? null,
            } as any,
          },
        });
      }

      // Surface it the same way a real provider message is surfaced, so the
      // parent's unread badge and bell fire. Account-scoped: every member of a
      // shared parent account reads the same thread.
      const notifyUserIds = opts.parentAccountId
        ? (
            await this.prisma.user.findMany({
              where: { parentAccountId: opts.parentAccountId },
              select: { id: true },
            })
          ).map((u: any) => u.id)
        : [opts.parentUserId];
      for (const notifyId of notifyUserIds) {
        await this.prisma.inAppNotification.create({
          data: {
            userId: notifyId,
            eventType: "PROVIDER_MESSAGE",
            payload: {
              sessionId: opts.sessionId,
              message: `${opts.providerName || "Your provider"} sent you a message`,
              preview: content.trim().slice(0, 100),
            },
          },
        }).catch(() => {});
      }

      this.logger.log(
        `[auto-reply] Sent template ${template.id} (send ${sendRow.id}) into session ${opts.sessionId} with ${attachments.length} attachment(s)`,
      );
      return true;
    } catch (e: any) {
      this.logger.warn(`[auto-reply] Send failed for session ${opts.sessionId}: ${e?.message}`);
      return false;
    }
  }
}
