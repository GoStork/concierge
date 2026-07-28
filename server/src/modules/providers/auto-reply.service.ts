import { Injectable, Inject, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { renderAutoReplyBody, type AutoReplyVars } from "../../../../shared/auto-reply-starters";
import { logContactBlock, scanForContactInfo } from "../../../contact-guard";
import { getBaseUrl } from "../../lib/get-base-url";

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
   * The thread a booking made through the provider's own /book/:slug link
   * belongs to, or null when there is none.
   *
   * That path carries no aiSessionId, so it never creates a session - this
   * finds an EXISTING one to attach to. Anonymous whisper-stage sessions
   * (status ACTIVE) are deliberately excluded: the parent has not revealed
   * themselves to the provider there, and posting a named greeting into one
   * would leak their identity ahead of the consent moment.
   */
  async findThreadForDirectBooking(opts: {
    providerId: string;
    parentUserId: string;
  }): Promise<{ id: string; subjectType: string | null; subjectProfileId: string | null } | null> {
    const parent = await this.prisma.user.findUnique({
      where: { id: opts.parentUserId },
      select: { parentAccountId: true },
    });
    const accountIds = parent?.parentAccountId
      ? (
          await this.prisma.user.findMany({
            where: { parentAccountId: parent.parentAccountId },
            select: { id: true },
          })
        ).map((u: any) => u.id)
      : [opts.parentUserId];

    return this.prisma.aiChatSession.findFirst({
      where: {
        userId: { in: accountIds },
        providerId: opts.providerId,
        status: { in: ["CONSULTATION_BOOKED", "PROVIDER_CONNECTED"] },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, subjectType: true, subjectProfileId: true },
    });
  }

  /**
   * Direct-booking path: link the booking to the thread the parent already has
   * with this provider, then post the greeting there.
   *
   * The provider's shareable /book/:slug link carries no aiSessionId, so it
   * never reaches createConsultationChatSession and the booking lands unlinked
   * even when a thread exists. Two things go wrong then: the journey sidebar
   * counts the call org-level instead of against the thread, and the auto-reply
   * never fires because there is no session in hand to post into.
   *
   * Never creates a session. An unknown booker with no prior relationship has
   * no thread to belong to, and inventing one would put inbox rows in front of
   * providers for people who never used the concierge.
   *
   * Returns the session id it attached to, or null when it did nothing - the
   * caller treats this as fire-and-forget, the return value is for tests.
   */
  async attachDirectBookingToThread(booking: any): Promise<string | null> {
    if (!booking?.parentUser?.id) return null;
    const providerId = booking.providerUser?.providerId;
    if (!providerId) return null;

    const session = await this.findThreadForDirectBooking({
      providerId,
      parentUserId: booking.parentUser.id,
    });
    if (!session) return null;

    const parent = await this.prisma.user.findUnique({
      where: { id: booking.parentUser.id },
      select: { parentAccountId: true, name: true },
    });

    await this.prisma.booking.update({
      where: { id: booking.id },
      data: { sessionId: session.id },
    });
    this.logger.log(`[direct-booking] Linked booking ${booking.id} to existing session ${session.id}`);

    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
      select: { name: true },
    });

    await this.sendForBooking({
      providerId,
      staffUserId: booking.providerUserId || null,
      sessionId: session.id,
      parentUserId: booking.parentUser.id,
      parentAccountId: parent?.parentAccountId || null,
      parentName: booking.parentUser.name || parent?.name || booking.attendeeName || "Parent",
      providerName: provider?.name || null,
      staffName: booking.providerUser?.name || null,
      subjectType: session.subjectType || null,
      subjectProfileId: session.subjectProfileId || null,
      bookingId: booking.id,
      scheduledAt: booking.scheduledAt || null,
      bookerTimezone: booking.bookerTimezone || null,
      meetingSubtype: booking.meetingSubtype || null,
    });
    return session.id;
  }

  /**
   * Resolve the specific donor / surrogate this booking is about, as a display
   * reference plus a link to their profile.
   *
   * Returns nulls when the call is not about one profile (a general agency
   * consultation), which makes renderAutoReplyBody drop the paragraph that
   * would have named them.
   */
  async resolveProfileReference(opts: {
    subjectProfileId?: string | null;
    subjectType?: string | null;
  }): Promise<{ profileRef: string | null; profileLink: string | null }> {
    const none = { profileRef: null, profileLink: null };
    if (!opts.subjectProfileId) return none;

    const t = (opts.subjectType || "").toLowerCase();
    // Same loose matching the session-title derivation uses - subjectType has
    // historically been "egg_donor" / "egg" / "surrog" / "surrogate".
    const kind = t.includes("sperm")
      ? { model: this.prisma.spermDonor, label: "Sperm Donor", path: "spermdonor" }
      : t.includes("egg") || t.includes("donor")
        ? { model: this.prisma.eggDonor, label: "Egg Donor", path: "eggdonor" }
        : t.includes("surrog")
          ? { model: this.prisma.surrogate, label: "Surrogate", path: "surrogate" }
          : null;
    if (!kind) return none;

    const row = await (kind.model as any)
      .findUnique({
        where: { id: opts.subjectProfileId },
        select: { id: true, externalId: true, providerId: true },
      })
      .catch(() => null);
    // No externalId means there is no number a parent would recognise, so there
    // is nothing useful to say - drop the reference rather than invent one.
    if (!row?.externalId) return none;

    const base = getBaseUrl();
    return {
      profileRef: `${kind.label} #${row.externalId}`,
      profileLink: `${base}/${kind.path}/${row.providerId}/${row.id}`,
    };
  }

  /**
   * A real profile from this provider, for the settings preview - so a provider
   * sees the shape of an actual reference and link rather than a made-up id.
   * Falls back to a plausible sample when the org has no profiles loaded yet.
   */
  async sampleProfileReference(providerId: string): Promise<{ profileRef: string | null; profileLink: string | null }> {
    const candidates: Array<{ model: any; label: string; path: string }> = [
      { model: this.prisma.eggDonor, label: "Egg Donor", path: "eggdonor" },
      { model: this.prisma.surrogate, label: "Surrogate", path: "surrogate" },
      { model: this.prisma.spermDonor, label: "Sperm Donor", path: "spermdonor" },
    ];
    for (const c of candidates) {
      const row = await c.model
        .findFirst({
          where: { providerId, externalId: { not: null } },
          select: { id: true, externalId: true, providerId: true },
        })
        .catch(() => null);
      if (row?.externalId) {
        return {
          profileRef: `${c.label} #${row.externalId}`,
          profileLink: `${getBaseUrl()}/${c.path}/${row.providerId}/${row.id}`,
        };
      }
    }
    return { profileRef: "Egg Donor #4821", profileLink: `${getBaseUrl()}/eggdonor/...` };
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
   * Fill the personalization tokens. The implementation lives in
   * shared/auto-reply-starters next to the token list it substitutes, so the
   * two cannot drift and it stays testable without a database.
   */
  renderBody(body: string, vars: AutoReplyVars): string {
    return renderAutoReplyBody(body, vars);
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
    subjectProfileId?: string | null;
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

      const { profileRef, profileLink } = await this.resolveProfileReference({
        subjectProfileId: opts.subjectProfileId,
        subjectType: opts.subjectType,
      });

      const content = this.renderBody(String(template.body), {
        profileRef,
        profileLink,
        parentName: opts.parentName,
        providerName: opts.providerName,
        staffName: opts.staffName,
        callType,
        callTime: opts.scheduledAt ? this.formatCallTime(opts.scheduledAt, opts.bookerTimezone) : null,
      });

      // Contact guard. This path deliberately bypasses the provider send
      // endpoint (see the note below), so it would otherwise be the one way a
      // provider could put a phone number in front of every parent who books.
      // The controller rejects a bad body at save time; this is the backstop for
      // templates saved before that shipped.
      //
      // Never throws - the contract of this method is that a failure here does
      // not take down a booking that already succeeded. The send row stays
      // claimed so we do not retry a message we will only reject again.
      const bodyScan = scanForContactInfo(content);
      if (bodyScan.blocked) {
        logContactBlock("auto-reply.send", bodyScan, {
          providerId: opts.providerId, sessionId: opts.sessionId, templateId: (template as any).id,
        });
        return false;
      }

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
