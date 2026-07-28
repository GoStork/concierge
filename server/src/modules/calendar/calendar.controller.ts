import {
  Controller,
  Get,
  Put,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  Sse,
  Inject,
  UseGuards,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { Request, Response } from "express";
import { DateTime } from "luxon";
import { randomBytes, randomUUID, createHmac } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { createDailyRoom, isExternalMeetingUrl } from "../../lib/daily-room";
import { getBaseUrl } from "../../lib/get-base-url";
import { formatWhen, resolveProviderTimezone } from "../../lib/booking-when";
import { emitBookingLifecycleEvent } from "../../../journey-events";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { NotificationService } from "../notifications/notification.service";
import { GoogleCalendarService } from "./google-calendar.service";
import { MicrosoftCalendarService } from "./microsoft-calendar.service";
import { CaldavCalendarService } from "./caldav-calendar.service";
import { encryptPassword } from "./caldav-crypto";
import { BookingEventsService, BookingEvent } from "./booking-events.service";
import { CostSheetAutoDraftService } from "../billing/cost-sheet-auto-draft.service";
import { AutoReplyService } from "../providers/auto-reply.service";
import { ParentBriefingService } from "../providers/parent-briefing.service";
import { assertNoContactInfo } from "../../../contact-guard";
import { Observable } from "rxjs";

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 60);
}

@Controller("api/calendar")
export class CalendarController implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CalendarController.name);
  private cachedCompanyName: string | null = null;
  private companyNameCacheTime: number = 0;
  private static readonly COMPANY_NAME_CACHE_TTL = 5 * 60 * 1000;
  private externalSyncInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(GoogleCalendarService) private readonly googleCalendar: GoogleCalendarService,
    @Inject(MicrosoftCalendarService) private readonly microsoftCalendar: MicrosoftCalendarService,
    @Inject(CaldavCalendarService) private readonly caldavCalendar: CaldavCalendarService,
    @Inject(BookingEventsService) private readonly bookingEvents: BookingEventsService,
    @Inject(CostSheetAutoDraftService) private readonly costSheetAutoDraft: CostSheetAutoDraftService,
    @Inject(AutoReplyService) private readonly autoReply: AutoReplyService,
    @Inject(ParentBriefingService) private readonly parentBriefing: ParentBriefingService,
  ) {}

  // Phase 2: fire-and-forget cost-sheet auto-draft on every booking_created
  // event. Wrapped here so we can call it from each create site without
  // duplicating the catch + log boilerplate.
  private fireCostSheetAutoDraft(bookingId: string) {
    this.costSheetAutoDraft
      .tryAutoDraftForBooking(bookingId)
      .catch(err => this.logger.warn(`Cost-sheet auto-draft failed for ${bookingId}: ${err.message}`));
  }

  onModuleInit() {
    this.externalSyncInterval = setInterval(() => {
      this.checkExternalCalendarDeletions().catch((e) => {
        const msg = e.message || "";
        if (msg.includes("MaxClientsInSessionMode") || msg.includes("pool") || msg.includes("ECONNREFUSED") || msg.includes("Connection")) {
          this.logger.warn(`External calendar sync skipped (connection issue): ${msg}`);
        } else {
          this.logger.error(`External calendar sync failed: ${msg}`);
        }
      });
    }, 5 * 60 * 1000);
    this.logger.log("External calendar deletion sync started (every 5 min)");
  }

  onModuleDestroy() {
    if (this.externalSyncInterval) {
      clearInterval(this.externalSyncInterval);
      this.externalSyncInterval = null;
    }
  }

  private async getCompanyName(): Promise<string> {
    const now = Date.now();
    if (this.cachedCompanyName && (now - this.companyNameCacheTime) < CalendarController.COMPANY_NAME_CACHE_TTL) {
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

  private async getParentAccountMemberIds(userId: string): Promise<string[]> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { parentAccountId: true } });
    if (!user?.parentAccountId) return [userId];
    const members = await this.prisma.user.findMany({
      where: { parentAccountId: user.parentAccountId, isDisabled: false },
      select: { id: true },
    });
    return members.map((m: any) => m.id);
  }

  private async isParentAccountMember(userId: string, bookingParentUserId: string | null): Promise<boolean> {
    if (!bookingParentUserId) return false;
    if (userId === bookingParentUserId) return true;
    const [user, bookingUser] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { parentAccountId: true } }),
      this.prisma.user.findUnique({ where: { id: bookingParentUserId }, select: { parentAccountId: true } }),
    ]);
    return !!(user?.parentAccountId && bookingUser?.parentAccountId && user.parentAccountId === bookingUser.parentAccountId);
  }

  @Sse("events")
  @UseGuards(SessionOrJwtGuard)
  sseEvents(@Req() req: Request): Observable<MessageEvent> {
    const user = req.user as any;
    const userId = user.id;
    req.on("close", () => this.bookingEvents.disconnect(userId));
    return this.bookingEvents.subscribe(userId);
  }

  private async emitBookingEvent(type: BookingEvent["type"], booking: any, actorUserId?: string) {
    const targetUserIds = [booking.providerUserId];
    if (booking.parentUserId) {
      const memberIds = await this.getParentAccountMemberIds(booking.parentUserId);
      targetUserIds.push(...memberIds);
    }
    const uniqueTargetIds = [...new Set(targetUserIds)];
    this.bookingEvents.emit({
      type,
      booking: {
        id: booking.id,
        subject: booking.subject || null,
        status: booking.status,
        scheduledAt: booking.scheduledAt?.toISOString?.() || String(booking.scheduledAt),
        duration: booking.duration,
        attendeeName: booking.attendeeName || null,
        providerUserId: booking.providerUserId,
        parentUserId: booking.parentUserId || null,
      },
      targetUserIds: uniqueTargetIds,
      actorUserId,
    });
  }

  /**
   * Creates a 3-way chat session (parent ↔ provider ↔ AI) after a parent
   * actually books a consultation through the calendar widget.
   */
  private async createConsultationChatSession(body: any, booking: any) {
    const parentUserId = booking.parentUser.id;
    const consultProviderId = body.consultationProviderId || booking.providerUser?.providerId;
    if (!consultProviderId) return;

    const provider = await this.prisma.provider.findUnique({
      where: { id: consultProviderId },
      select: { id: true, name: true, services: { include: { providerType: true }, where: { status: "APPROVED" } } },
    });
    if (!provider) return;

    const parentName = booking.parentUser.name || booking.attendeeName || "Parent";
    // Session title guard: some booking paths (e.g. the win-back reschedule
    // card) carry no subject label, and one path passed the Eva chat's own
    // title through - which created a 3-way session titled "AI Concierge
    // Chat" that looked like a duplicate Eva session and hid the whole
    // provider flow inside "the AI chat". Never accept a generic/blank
    // label: derive from the subject profile, else fall back to the
    // provider name.
    let sessionTitle: string | null = body.profileLabel || null;
    if (!sessionTitle || /^ai concierge/i.test(sessionTitle.trim())) {
      sessionTitle = null;
      if (body.subjectProfileId) {
        const subjType = (body.subjectType || "").toLowerCase();
        const lookup = subjType.includes("egg")
          ? this.prisma.eggDonor
          : subjType.includes("sperm")
            ? this.prisma.spermDonor
            : this.prisma.surrogate;
        const subj = await (lookup as any).findUnique({ where: { id: body.subjectProfileId }, select: { externalId: true } }).catch(() => null);
        if (subj?.externalId) {
          const prefix = subjType.includes("egg") ? "Egg Donor" : subjType.includes("sperm") ? "Sperm Donor" : "Surrogate";
          sessionTitle = `${prefix} #${subj.externalId}`;
        }
      }
      sessionTitle = sessionTitle || provider?.name || null;
    }

    // Check for existing provider session with same title
    const parentAccount = await this.prisma.user.findUnique({
      where: { id: parentUserId },
      select: { parentAccountId: true },
    });
    const accountIds = parentAccount?.parentAccountId
      ? (await this.prisma.user.findMany({ where: { parentAccountId: parentAccount.parentAccountId }, select: { id: true } })).map(u => u.id)
      : [parentUserId];

    const existingSession =
      (sessionTitle
        ? await this.prisma.aiChatSession.findFirst({
            where: { userId: { in: accountIds }, providerId: consultProviderId, title: sessionTitle },
            orderBy: { updatedAt: "desc" },
            select: { id: true },
          })
        : null)
      // Legal chats are firm-level (no per-profile disambiguation), so a
      // differently-titled legacy legal session would be missed by the
      // exact-title match above and booking would spawn a duplicate 3-way
      // chat. Reuse any existing legal session with this firm instead.
      ?? (body.subjectType === "legal"
        ? await this.prisma.aiChatSession.findFirst({
            where: { userId: { in: accountIds }, providerId: consultProviderId, subjectType: "legal" },
            orderBy: { updatedAt: "desc" },
            select: { id: true },
          })
        : null);

    let targetSessionId: string;
    if (existingSession) {
      targetSessionId = existingSession.id;
      await this.prisma.aiChatSession.update({
        where: { id: existingSession.id },
        data: { status: "CONSULTATION_BOOKED", profilePhotoUrl: body.profilePhotoUrl || undefined, subjectProfileId: body.subjectProfileId || undefined, subjectType: body.subjectType || undefined, updatedAt: new Date() },
      });
      this.logger.log(`[CONSULTATION] Reusing session ${targetSessionId} for provider ${consultProviderId}`);
    } else {
      const newSession = await this.prisma.aiChatSession.create({
        data: {
          userId: parentUserId,
          providerId: consultProviderId,
          providerName: provider.name,
          status: "CONSULTATION_BOOKED",
          matchmakerId: body.matchmakerId || undefined,
          title: sessionTitle,
          profilePhotoUrl: body.profilePhotoUrl || undefined,
          subjectProfileId: body.subjectProfileId || undefined,
          subjectType: body.subjectType || undefined,
        },
      });
      targetSessionId = newSession.id;
      this.logger.log(`[CONSULTATION] Created session ${targetSessionId} for provider ${consultProviderId}`);
    }

    // Link the booking to its thread so the journey sidebar can scope the
    // consultation rungs per chat (null stays org-level for legacy rows).
    await this.prisma.booking.update({
      where: { id: booking.id },
      data: { sessionId: targetSessionId },
    }).catch((e: any) => this.logger.warn(`[CONSULTATION] Booking->session link failed: ${e.message}`));

    // Phase 6: first call with a surrogacy / egg-donation agency = the
    // commitment signal for the one-time lawyer-intro offer (fire and
    // forget; internally idempotent via lawyerIntroOfferedAt).
    import("../../../lawyer-intro-flow")
      .then(({ maybeOfferLawyerIntro }) => maybeOfferLawyerIntro(parentUserId, consultProviderId))
      .catch((e: any) => this.logger.warn(`[lawyer-intro] Offer hook failed: ${e?.message}`));

    // Once the parent has booked a consultation with this provider, any pending
    // whispers on OTHER (anonymous) sessions between the same parent+provider
    // are moot - the provider can talk to the parent directly now. Mark them
    // AUTO_RESOLVED so they stop polluting the provider's Chats badge with a
    // ghost unread on a sidebar row the sibling-filter has already hidden.
    try {
      const orphans = await this.prisma.silentQuery.updateMany({
        where: {
          providerId: consultProviderId,
          status: "PENDING",
          sessionId: { not: targetSessionId },
          session: { userId: { in: accountIds } },
        },
        data: { status: "AUTO_RESOLVED" },
      });
      if (orphans.count > 0) {
        this.logger.log(`[CONSULTATION] Auto-resolved ${orphans.count} sibling whisper(s) for parent+provider ${consultProviderId}`);
      }
    } catch (e: any) {
      this.logger.warn(`[CONSULTATION] Sibling whisper auto-resolve failed: ${e.message}`);
    }

    // Announce the consultation in the provider's chat. Backdated 1s before the
    // booking's createdAt so the AI message renders ABOVE the inline booking
    // widget (chat-message-list merges messages + bookings by createdAt) - the
    // provider gets context first, then sees the widget to confirm/decline.
    const announcementCreatedAt = new Date(booking.createdAt.getTime() - 1000);
    await this.prisma.aiChatMessage.create({
      data: {
        sessionId: targetSessionId,
        role: "assistant",
        // Dual-audience: BOTH sides read this thread, so each gets addressed
        // directly. The parent was previously served the provider's copy and
        // read about themselves in the third person ("Eran Amir has scheduled
        // a consultation") in their own chat.
        content: `You're all set - your consultation with ${provider.name} is booked. You can message them directly here any time before the call.`,
        senderType: "system",
        senderName: "GoStork",
        uiCardData: {
          providerContent: `Great news! ${parentName} has scheduled a consultation. You can chat with them directly here.`,
        } as any,
        createdAt: announcementCreatedAt,
      },
    });

    // The provider's own auto-reply, if they configured one. Posted after the
    // announcement (default createdAt = now, which is later than the backdated
    // announcement) so the parent reads context first, then the greeting.
    // Deliberately NOT routed through the provider send endpoint - that flips
    // the session to PROVIDER_CONNECTED, and an automated message must not
    // claim the provider has actually joined. Never blocks the booking.
    await this.autoReply.sendForBooking({
      providerId: consultProviderId,
      staffUserId: booking.providerUserId || null,
      sessionId: targetSessionId,
      parentUserId,
      parentAccountId: parentAccount?.parentAccountId || null,
      parentName,
      providerName: provider.name,
      staffName: booking.providerUser?.name || null,
      subjectType: body.subjectType || null,
      subjectProfileId: body.subjectProfileId || null,
      bookingId: booking.id,
      scheduledAt: booking.scheduledAt || null,
      bookerTimezone: booking.bookerTimezone || null,
      meetingSubtype: booking.meetingSubtype || null,
    });

    // The private parent briefing. INDEPENDENT of the auto-reply on purpose: a
    // provider who never wrote a greeting still gets told who is about to walk
    // into their call. Same once-per-parent-per-service rule, its own log.
    await this.parentBriefing.sendForBooking({
      providerId: consultProviderId,
      providerName: provider.name,
      providerTypeId: await this.autoReply.resolveProviderTypeId({
        providerId: consultProviderId,
        subjectType: body.subjectType || null,
      }),
      sessionId: targetSessionId,
      parentUserId,
      parentAccountId: parentAccount?.parentAccountId || null,
      bookingId: booking.id,
    });

    // Notify provider users
    const providerUsers = await this.prisma.user.findMany({
      where: { providerId: consultProviderId },
      select: { id: true },
    });
    for (const pu of providerUsers) {
      await this.prisma.inAppNotification.create({
        data: {
          userId: pu.id,
          eventType: "CONSULTATION_BOOKED_CHAT",
          payload: {
            sessionId: targetSessionId,
            parentName,
            message: `${parentName} scheduled a consultation - you can chat with them directly.`,
          },
        },
      });
    }

    // Notify admins
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: "GOSTORK_ADMIN" } },
      select: { id: true },
    });
    for (const admin of admins) {
      await this.prisma.inAppNotification.create({
        data: {
          userId: admin.id,
          eventType: "CONSULTATION_REQUESTED",
          payload: {
            parentName,
            parentUserId,
            providerId: consultProviderId,
            providerName: provider.name,
            message: `${parentName} requested a consultation with ${provider.name}`,
          },
        },
      });
    }

    // Booking a consultation is the journey-stage transition - persist it so the
    // AI router activates POST-BOOKING CALL PREP on the next parent message.
    if (parentAccount?.parentAccountId) {
      await this.prisma.intendedParentProfile.update({
        where: { parentAccountId: parentAccount.parentAccountId },
        data: { journeyStage: "Consultation Requested" },
      }).catch(() => {});
    }

    // Send confirmation message back to the AI concierge chat
    if (body.aiSessionId) {
      const conciergeSessionId = body.aiSessionId;

      // Post-booking turns are post-match territory (call prep, next cycles) -
      // handled by Tier 2's full prompt. One-way door, same as [[CURATION]];
      // no-op for sessions where curation already fired.
      await this.prisma.aiChatSession.update({
        where: { id: conciergeSessionId },
        data: { tier2Active: true },
      }).catch(() => {});

      // Build next-step goals from the parent's profile flags
      const parentProfile = parentAccount?.parentAccountId
        ? await this.prisma.intendedParentProfile.findUnique({
            where: { parentAccountId: parentAccount.parentAccountId },
            select: { needsEggDonor: true, needsSurrogate: true, needsClinic: true, interestedServices: true, hasEmbryos: true, embryoCount: true, embryosTested: true, eggSource: true, spermSource: true, isFirstIvf: true, currentClinicName: true, surrogateBudget: true },
          }).catch(() => null)
        : null;
      const parentIdentity = await this.prisma.user.findUnique({
        where: { id: parentUserId },
        select: { gender: true, relationshipStatus: true },
      }).catch(() => null);

      const nextGoals: string[] = [];
      if (parentProfile?.needsEggDonor) nextGoals.push("finding the right egg donor");
      if (parentProfile?.needsSurrogate) nextGoals.push("finding the right surrogate");
      if (parentProfile?.needsClinic) nextGoals.push("finding the right fertility clinic");

      if (nextGoals.length === 0 && parentProfile?.interestedServices?.length) {
        const svcGoalMap: Record<string, string> = {
          "Surrogacy Agency": "finding the right surrogate",
          "Egg Donor Agency": "finding the right egg donor",
          "Egg Bank": "finding the right egg donor",
          "Sperm Bank": "finding the right sperm donor",
          "IVF Clinic": "finding the right fertility clinic",
          "Legal Services": "finding the right legal support",
        };
        for (const svc of parentProfile.interestedServices) {
          const goal = svcGoalMap[svc];
          if (goal && !nextGoals.includes(goal)) nextGoals.push(goal);
        }
      }

      // When the provider still lacks core call-prep info (family type, embryos,
      // clinic, IVF history, budget), invite the parent into the call-prep
      // mini-intake instead of pivoting straight to the next goal. Mirrors the
      // missing-field logic in the AI router's CALL PREP MODE block.
      const prepMissing =
        !parentIdentity?.gender || !parentIdentity?.relationshipStatus ||
        parentProfile?.hasEmbryos == null ||
        (parentProfile?.hasEmbryos === true && (parentProfile?.embryoCount == null || parentProfile?.embryosTested == null)) ||
        (parentProfile?.needsClinic == null && !parentProfile?.currentClinicName) ||
        parentProfile?.isFirstIvf == null ||
        (!parentProfile?.surrogateBudget && parentProfile?.needsSurrogate !== false);

      // INTERNATIONAL PROGRAM - SECOND CALL: an international surrogacy agency is
      // paired with a partner IVF/egg-donor clinic (Provider.partnerProviderIds).
      // Booking the agency covers only ONE leg of the program - proactively offer
      // the partner clinic call right here so the parent gets both calls, one
      // after the other. Takes priority over the call-prep nudge.
      let partnerClinicName: string | null = null;
      try {
        const agencyRec = await this.prisma.provider.findUnique({
          where: { id: consultProviderId },
          select: { partnerProviderIds: true },
        });
        const partnerIds = Array.isArray(agencyRec?.partnerProviderIds)
          ? (agencyRec!.partnerProviderIds as any[]).map(String).filter(Boolean)
          : [];
        if (partnerIds.length > 0) {
          const alreadyBooked = await this.prisma.aiChatSession.findFirst({
            where: { userId: { in: accountIds }, providerId: { in: partnerIds }, status: "CONSULTATION_BOOKED" },
            select: { id: true },
          });
          if (!alreadyBooked) {
            const clinic = await this.prisma.provider.findFirst({ where: { id: { in: partnerIds } }, select: { name: true } });
            partnerClinicName = clinic?.name || null;
          }
        }
      } catch (e: any) {
        this.logger.warn(`[CONSULTATION] Partner-clinic offer lookup failed: ${e?.message}`);
      }

      let continueText: string;
      let confirmQuickReplies: string[] | null = null;
      if (partnerClinicName) {
        continueText = `One more step to get your whole program set up: this program also includes the IVF and egg-donor care, handled by ${partnerClinicName}. Want me to set up a quick call with them too, so both sides of your journey are covered?`;
        confirmQuickReplies = [`Yes, set up the call with ${partnerClinicName}`, "Not right now"];
      } else if (prepMissing) {
        continueText = `While we wait for your call, let's make sure ${provider.name} comes fully prepared. They'll ask a few standard questions on the call - if we cover them now, I'll have your details ready for them and you can spend the call on what really matters. Ready for a couple of quick questions?`;
        confirmQuickReplies = ["Let's do it", "Maybe later"];
      } else if (nextGoals.length === 0) {
        continueText = "Let me know if there's anything else I can help you with on your journey!";
      } else if (nextGoals.length === 1) {
        continueText = `Now let's keep going - I'll help you with ${nextGoals[0]}!`;
      } else {
        const last = nextGoals[nextGoals.length - 1];
        const rest = nextGoals.slice(0, -1);
        continueText = `Now let's keep going - I'll help you with ${rest.join(", ")} and ${last}!`;
      }

      await this.prisma.aiChatMessage.create({
        data: {
          sessionId: conciergeSessionId,
          role: "assistant",
          content: `Great news! Your consultation with ${provider.name} is all set! I've created a separate chat where you can communicate directly with them - you'll find it in your inbox under "Provider Conversations."\n\n${continueText}`,
          senderType: "ai",
          ...(confirmQuickReplies ? { uiCardData: { quickReplies: confirmQuickReplies } } : {}),
        },
      });
    }
  }

  @Get("config")
  @UseGuards(SessionOrJwtGuard)
  async getConfig(@Req() req: Request, @Query("browserTimezone") browserTimezone?: string) {
    const user = req.user as any;
    let config = await this.prisma.scheduleConfig.findUnique({
      where: { userId: user.id },
      include: { availabilitySlots: { orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }] } },
    });

    if (!config) {
      const detectedTz = browserTimezone && isValidTimezone(browserTimezone) ? browserTimezone : "America/New_York";
      const slug = await this.generateUniqueSlug(user.name || user.email.split("@")[0]);
      const fullUser = await this.prisma.user.findUnique({ where: { id: user.id }, include: { provider: { select: { name: true } } } });
      const siteCompanyName = await this.getCompanyName();
      const companyName = fullUser?.provider?.name || siteCompanyName;
      config = await this.prisma.scheduleConfig.create({
        data: {
          userId: user.id,
          timezone: detectedTz,
          defaultSubject: `${companyName} Consultation Call`,
          bookingPageSlug: slug,
          availabilitySlots: {
            create: [
              { dayOfWeek: 1, startTime: "09:00", endTime: "17:00", isActive: true },
              { dayOfWeek: 2, startTime: "09:00", endTime: "17:00", isActive: true },
              { dayOfWeek: 3, startTime: "09:00", endTime: "17:00", isActive: true },
              { dayOfWeek: 4, startTime: "09:00", endTime: "17:00", isActive: true },
              { dayOfWeek: 5, startTime: "09:00", endTime: "17:00", isActive: true },
              { dayOfWeek: 0, startTime: "09:00", endTime: "17:00", isActive: false },
              { dayOfWeek: 6, startTime: "09:00", endTime: "17:00", isActive: false },
            ],
          },
        },
        include: { availabilitySlots: { orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }] } },
      });
    }

    if (config && !config.defaultSubject) {
      const fullUser = await this.prisma.user.findUnique({ where: { id: user.id }, include: { provider: { select: { name: true } } } });
      const siteCompanyName2 = await this.getCompanyName();
      const companyName = fullUser?.provider?.name || siteCompanyName2;
      config = await this.prisma.scheduleConfig.update({
        where: { userId: user.id },
        data: { defaultSubject: `${companyName} Consultation Call` },
        include: { availabilitySlots: { orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }] } },
      });
    }

    const fullUserForUrl = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { dailyRoomUrl: true },
    });

    return { ...config, dailyRoomUrl: fullUserForUrl?.dailyRoomUrl || null };
  }

  @Put("config")
  @UseGuards(SessionOrJwtGuard)
  async updateConfig(@Req() req: Request, @Body() body: any) {
    const user = req.user as any;
    const config = await this.prisma.scheduleConfig.findUnique({ where: { userId: user.id } });
    if (!config) throw new NotFoundException("Schedule config not found");

    if (body.meetingDuration && (body.meetingDuration < 5 || body.meetingDuration > 480)) {
      throw new BadRequestException("Meeting duration must be between 5 and 480 minutes");
    }
    if (body.minBookingNotice !== undefined && body.minBookingNotice < 0) {
      throw new BadRequestException("Minimum booking notice cannot be negative");
    }
    if (body.bufferTime !== undefined && (body.bufferTime < 0 || body.bufferTime > 120)) {
      throw new BadRequestException("Buffer time must be between 0 and 120 minutes");
    }
    if (body.bookingPageSlug && !/^[a-z0-9-]{1,60}$/.test(body.bookingPageSlug)) {
      throw new BadRequestException("Booking slug must be lowercase letters, numbers, and hyphens only (max 60 chars)");
    }

    if (body.bookingPageSlug && body.bookingPageSlug !== config.bookingPageSlug) {
      const existing = await this.prisma.scheduleConfig.findUnique({
        where: { bookingPageSlug: body.bookingPageSlug },
      });
      if (existing && existing.userId !== user.id) {
        throw new ConflictException("This booking link is already taken");
      }
    }

    const data: any = {
      timezone: body.timezone,
      meetingDuration: body.meetingDuration,
      minBookingNotice: body.minBookingNotice,
      bufferTime: body.bufferTime,
      meetingLink: body.meetingLink,
      defaultSubject: body.defaultSubject,
      bookingPageSlug: body.bookingPageSlug,
    };
    if (body.colorExternal !== undefined) data.colorExternal = body.colorExternal;
    if (body.colorBlocks !== undefined) data.colorBlocks = body.colorBlocks;
    if (body.autoConsentRecording !== undefined) data.autoConsentRecording = body.autoConsentRecording;

    const updated = await this.prisma.scheduleConfig.update({
      where: { userId: user.id },
      data,
      include: { availabilitySlots: { orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }] } },
    });

    return updated;
  }

  @Put("availability")
  @UseGuards(SessionOrJwtGuard)
  async updateAvailability(@Req() req: Request, @Body() body: { slots: any[] }) {
    const user = req.user as any;
    const config = await this.prisma.scheduleConfig.findUnique({ where: { userId: user.id } });
    if (!config) throw new NotFoundException("Schedule config not found");

    await this.prisma.availabilitySlot.deleteMany({ where: { scheduleConfigId: config.id } });

    if (body.slots && body.slots.length > 0) {
      await this.prisma.availabilitySlot.createMany({
        data: body.slots.map((s: any) => ({
          scheduleConfigId: config.id,
          dayOfWeek: s.dayOfWeek,
          startTime: s.startTime,
          endTime: s.endTime,
          isActive: s.isActive ?? true,
        })),
      });
    }

    const updated = await this.prisma.scheduleConfig.findUnique({
      where: { userId: user.id },
      include: { availabilitySlots: { orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }] } },
    });

    return updated;
  }

  @Post("connect")
  @UseGuards(SessionOrJwtGuard)
  async connectCalendar(@Req() req: Request, @Body() body: { provider: string }) {
    const user = req.user as any;
    const config = await this.prisma.scheduleConfig.findUnique({ where: { userId: user.id } });
    if (!config) throw new NotFoundException("Schedule config not found");

    const updated = await this.prisma.scheduleConfig.update({
      where: { userId: user.id },
      data: {
        calendarProvider: body.provider,
        calendarConnected: true,
        calendarAccessToken: "mock_access_token_" + Date.now(),
        calendarRefreshToken: "mock_refresh_token_" + Date.now(),
      },
    });

    return updated;
  }

  @Post("disconnect")
  @UseGuards(SessionOrJwtGuard)
  async disconnectCalendar(@Req() req: Request) {
    const user = req.user as any;
    const updated = await this.prisma.scheduleConfig.update({
      where: { userId: user.id },
      data: {
        calendarProvider: null,
        calendarConnected: false,
        calendarAccessToken: null,
        calendarRefreshToken: null,
      },
    });

    return updated;
  }

  @Get("bookings/imminent")
  @UseGuards(SessionOrJwtGuard)
  async getImminentBooking(@Req() req: Request) {
    const user = req.user as any;
    const isParent = user.roles?.includes("PARENT");
    const parentMemberIds = isParent ? await this.getParentAccountMemberIds(user.id) : [user.id];

    const now = new Date();
    const windowStart = new Date(now.getTime() - 15 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 5 * 60 * 1000);

    const candidates = await this.prisma.booking.findMany({
      where: {
        OR: [{ providerUserId: user.id }, { parentUserId: { in: parentMemberIds } }],
        status: "CONFIRMED",
        meetingType: "video",
        scheduledAt: { gte: windowStart, lte: windowEnd },
      },
      include: {
        providerUser: {
          select: {
            id: true, name: true, photoUrl: true,
            provider: { select: { name: true, logoUrl: true } },
          },
        },
        parentUser: { select: { id: true, name: true } },
      },
      orderBy: { scheduledAt: "asc" },
    });

    // A booking whose scheduledAt + duration is already in the past has ended -
    // never prompt the user to join it (short meetings can end inside the
    // 15-minute lookback window).
    const booking = candidates.find(
      (b) => new Date(b.scheduledAt).getTime() + (b.duration || 30) * 60 * 1000 > now.getTime(),
    );

    if (!booking) return { booking: null };

    const isProvider = booking.providerUserId === user.id;

    return {
      booking: {
        id: booking.id,
        subject: booking.subject,
        scheduledAt: booking.scheduledAt,
        duration: booking.duration,
        meetingUrl: booking.meetingUrl,
        meetingType: booking.meetingType,
        providerName: booking.providerUser?.provider?.name || booking.providerUser?.name || "Provider",
        providerLogo: booking.providerUser?.provider?.logoUrl || booking.providerUser?.photoUrl,
        providerUserName: booking.providerUser?.name,
        parentName: booking.parentUser?.name || booking.attendeeName || "Parent",
        counterpartyName: isProvider
          ? (booking.parentUser?.name || booking.attendeeName || "Parent")
          : (booking.providerUser?.name || "Provider"),
        isProvider,
      },
    };
  }

  @Get("bookings/search")
  @UseGuards(SessionOrJwtGuard)
  async searchBookings(
    @Req() req: Request,
    @Query("q") q?: string,
    @Query("from") fromDate?: string,
    @Query("to") toDate?: string,
    @Query("hostId") hostId?: string,
    @Query("parentId") parentId?: string,
    @Query("providerId") providerId?: string,
  ) {
    const user = req.user as any;
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN") || user.roles?.includes("GOSTORK_CONCIERGE");
    const isParent = user.roles?.includes("PARENT");
    const parentMemberIds = isParent ? await this.getParentAccountMemberIds(user.id) : [user.id];
    const where: any = {};

    if (isAdmin && providerId === "all") {
      // no user scope filter - show all bookings
    } else if (isAdmin && providerId) {
      where.providerUser = { providerId };
    } else {
      where.OR = [{ providerUserId: user.id }, { parentUserId: { in: parentMemberIds } }];
    }

    if (fromDate) {
      where.scheduledAt = { ...(where.scheduledAt || {}), gte: new Date(fromDate) };
    }
    if (toDate) {
      where.scheduledAt = { ...(where.scheduledAt || {}), lte: new Date(toDate) };
    }
    if (hostId) {
      where.providerUserId = hostId;
    }
    if (parentId) {
      where.parentUserId = parentId;
    }

    const bookings = await this.prisma.booking.findMany({
      where,
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, dailyRoomUrl: true } },
        parentUser: { select: { id: true, name: true, email: true, photoUrl: true, parentAccountId: true } },
      },
      orderBy: { scheduledAt: "desc" },
    });

    const parentAccountIds = [...new Set(bookings.map(b => (b as any).parentUser?.parentAccountId).filter(Boolean))];
    const accountMembersMap: Record<string, { id: string; name: string; email: string }[]> = {};
    for (const accountId of parentAccountIds) {
      const members = await this.prisma.user.findMany({
        where: { parentAccountId: accountId },
        select: { id: true, name: true, email: true },
      });
      accountMembersMap[accountId] = members;
    }

    let results = bookings.map(b => {
      const accountId = (b as any).parentUser?.parentAccountId;
      return {
        ...b,
        parentAccountMembers: accountId ? (accountMembersMap[accountId] || []) : [],
      };
    });

    if (q && q.trim()) {
      const terms = q.toLowerCase().trim().split(/\s+/);
      results = results.filter((b: any) => {
        const searchable = [
          b.subject,
          b.notes,
          b.attendeeName,
          b.status,
          b.meetingType,
          b.bookerTimezone,
          b.providerUser?.name,
          b.providerUser?.email,
          b.parentUser?.name,
          b.parentUser?.email,
          ...(b.attendeeEmails || []),
          ...(b.parentAccountMembers || []).map((m: any) => `${m.name} ${m.email}`),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return terms.every(term => searchable.includes(term));
      });
    }

    return results;
  }

  @Get("bookings/pending-count")
  @UseGuards(SessionOrJwtGuard)
  async getPendingBookingsCount(@Req() req: Request) {
    const user = req.user as any;
    const count = await this.prisma.booking.count({
      where: { providerUserId: user.id, status: "PENDING" },
    });
    return { count };
  }

  // The "tasks" feed for the calendar page, with NO month window so nothing
  // can hide off-screen the way the month-scoped /bookings query did:
  //   - every PENDING request (still actionable), AND
  //   - recently EXPIRED requests (slot passed unanswered) for the last 30 days,
  //     so the provider keeps seeing what lapsed instead of it vanishing.
  // The nav badge stays PENDING-only (actionable count); this list is a superset
  // (pending + expired history), so they never produce a phantom badge again.
  // Same user-scoping as listBookings.
  @Get("bookings/pending")
  @UseGuards(SessionOrJwtGuard)
  async listPendingBookings(@Req() req: Request) {
    const user = req.user as any;
    const isParent = user.roles?.includes("PARENT");
    const parentMemberIds = isParent ? await this.getParentAccountMemberIds(user.id) : [user.id];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const bookings = await this.prisma.booking.findMany({
      where: {
        AND: [
          { OR: [{ providerUserId: user.id }, { parentUserId: { in: parentMemberIds } }] },
          { OR: [
            { status: "PENDING" },
            { status: "EXPIRED", expiredAt: { gte: thirtyDaysAgo } },
          ] },
        ],
      },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, dailyRoomUrl: true } },
        parentUser: { select: { id: true, name: true, email: true, photoUrl: true, parentAccountId: true } },
      },
      orderBy: { scheduledAt: "asc" },
    });
    return bookings;
  }

  @Get("bookings")
  @UseGuards(SessionOrJwtGuard)
  async listBookings(
    @Req() req: Request,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("providerId") providerId?: string,
  ) {
    const user = req.user as any;
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN") || user.roles?.includes("GOSTORK_CONCIERGE");
    const isParent = user.roles?.includes("PARENT");
    const parentMemberIds = isParent ? await this.getParentAccountMemberIds(user.id) : [user.id];
    const where: any = {};

    if (isAdmin && providerId === "all") {
      // no user scope filter - show all bookings
    } else if (isAdmin && providerId) {
      where.providerUser = { providerId };
    } else {
      where.OR = [{ providerUserId: user.id }, { parentUserId: { in: parentMemberIds } }];
    }

    if (from || to) {
      where.scheduledAt = {};
      if (from) where.scheduledAt.gte = new Date(from);
      if (to) where.scheduledAt.lte = new Date(to);
    }

    const bookings = await this.prisma.booking.findMany({
      where,
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, dailyRoomUrl: true } },
        parentUser: { select: { id: true, name: true, email: true, photoUrl: true, parentAccountId: true } },
      },
      orderBy: { scheduledAt: "asc" },
    });

    const parentAccountIds = [...new Set(bookings.map(b => (b as any).parentUser?.parentAccountId).filter(Boolean))];
    const accountMembersMap: Record<string, { id: string; name: string; email: string }[]> = {};
    for (const accountId of parentAccountIds) {
      const members = await this.prisma.user.findMany({
        where: { parentAccountId: accountId },
        select: { id: true, name: true, email: true },
      });
      accountMembersMap[accountId] = members;
    }

    return bookings.map(b => {
      const accountId = (b as any).parentUser?.parentAccountId;
      return {
        ...b,
        parentAccountMembers: accountId ? (accountMembersMap[accountId] || []) : [],
      };
    });
  }

  @Get("contacts")
  @UseGuards(SessionOrJwtGuard)
  async getContacts(@Req() req: Request) {
    const parentUsers = await this.prisma.user.findMany({
      where: { roles: { hasSome: ["PARENT"] } },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    });

    return parentUsers.map((u) => ({
      name: u.name || "",
      email: u.email,
      parentUserId: u.id,
    }));
  }

  /**
   * Per-booking video room. Every video booking gets its OWN Daily room so
   * two parents of the same provider can never collide in one live call
   * (previous slot running over, early joiners, stale links). An external
   * (Zoom/Meet) link the provider configured is respected as-is. If Daily
   * provisioning fails we fall back to the shared link with a loud log -
   * a degraded booking beats a failed one.
   */
  private async provisionBookingRoom(sharedLink: string | null): Promise<string | null> {
    if (isExternalMeetingUrl(sharedLink)) return sharedLink;
    try {
      const room = await createDailyRoom();
      return room.url;
    } catch (err: any) {
      this.logger.error(`Per-booking Daily room creation FAILED - falling back to shared provider link: ${err.message}`);
      return sharedLink;
    }
  }

  @Post("bookings")
  @UseGuards(SessionOrJwtGuard)
  async createBooking(@Req() req: Request, @Body() body: any) {
    const user = req.user as any;

    if (!body.scheduledAt) throw new BadRequestException("Date and time are required");
    if (!body.subject?.trim()) throw new BadRequestException("Subject is required");
    const emails = body.attendeeEmails?.filter((e: string) => e?.trim()) || [];
    const hasName = body.attendeeName?.trim();
    if (emails.length === 0 && !hasName) throw new BadRequestException("At least one attendee is required");
    assertNoContactInfo(body.notes, "booking.notes.create", { userId: user.id });

    const config = await this.prisma.scheduleConfig.findUnique({ where: { userId: user.id } });

    const meetingType = body.meetingType || "video";
    let meetingUrl: string | null = null;
    if (meetingType === "phone") {
      meetingUrl = null;
    } else if (body.meetingUrl !== undefined) {
      meetingUrl = body.meetingUrl || null;
    } else {
      meetingUrl = await this.provisionBookingRoom(config?.meetingLink || null);
    }

    let parentUserId = body.parentUserId || null;
    if (!parentUserId && emails.length > 0) {
      const primaryUser = await this.prisma.user.findUnique({ where: { email: emails[0].toLowerCase() } });
      if (primaryUser) parentUserId = primaryUser.id;
    }

    const booking = await this.prisma.booking.create({
      data: {
        providerUserId: user.id,
        parentUserId,
        scheduledAt: new Date(body.scheduledAt),
        duration: body.duration || config?.meetingDuration || 30,
        meetingType,
        status: "CONFIRMED",
        meetingUrl,
        subject: body.subject || null,
        notes: body.notes || null,
        attendeeEmails: body.attendeeEmails || [],
        attendeeName: body.attendeeName || null,
        attendeeDetails: body.attendeeDetails || undefined,
        invitedByUserId: user.id,
        bookerTimezone: body.bookerTimezone || null,
      },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });
    void emitBookingLifecycleEvent(booking.id, "SCHEDULED", "provider", { autoConfirmed: true });

    this.notifications.sendBookingConfirmation(booking).catch(() => {});
    this.syncBookingToGoogleCalendar(booking).catch(() => {});
    this.syncBookingToParentGoogleCalendar(booking).catch(() => {});
    this.syncBookingToOutlookCalendar(booking).catch(() => {});
    this.syncBookingToParentOutlookCalendar(booking).catch(() => {});
    this.emitBookingEvent("booking_created", booking, user.id);
    this.fireCostSheetAutoDraft(booking.id);
    return booking;
  }

  async createBookingInternal(input: {
    providerUserId: string;
    parentUserId: string | null;
    scheduledAt: Date;
    duration: number;
    meetingType: string;
    meetingUrl: string | null;
    subject: string | null;
    attendeeName: string | null;
    attendeeEmails: string[];
    invitedByUserId: string;
    /** Phase 4: "MATCH_CALL" (surrogacy) | "DOCTOR_CONSULTATION" (IVF) | null.
     *  Drives the per-type readiness trigger + the 24h surrogate hold. */
    meetingSubtype?: string | null;
    /** Per-email attendee info ({ [email]: { name } }) - names the surrogate
     *  in her lifecycle emails. */
    attendeeDetails?: Record<string, { name?: string; phone?: string }> | null;
  }) {
    // Callers pass the provider's shared link (or null) - upgrade video
    // bookings to a per-booking Daily room; external links pass through.
    const meetingUrl = input.meetingType === "video"
      ? await this.provisionBookingRoom(input.meetingUrl)
      : input.meetingUrl;

    const booking = await this.prisma.booking.create({
      data: {
        providerUserId: input.providerUserId,
        parentUserId: input.parentUserId,
        scheduledAt: input.scheduledAt,
        duration: input.duration,
        meetingType: input.meetingType,
        status: "CONFIRMED",
        meetingUrl,
        subject: input.subject,
        attendeeName: input.attendeeName,
        attendeeEmails: input.attendeeEmails,
        invitedByUserId: input.invitedByUserId,
        meetingSubtype: input.meetingSubtype ?? null,
        attendeeDetails: input.attendeeDetails ?? undefined,
      },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });
    void emitBookingLifecycleEvent(booking.id, "SCHEDULED", "provider", { autoConfirmed: true });

    this.notifications.sendBookingConfirmation(booking).catch(() => {});
    this.syncBookingToGoogleCalendar(booking).catch(() => {});
    this.syncBookingToParentGoogleCalendar(booking).catch(() => {});
    this.syncBookingToOutlookCalendar(booking).catch(() => {});
    this.syncBookingToParentOutlookCalendar(booking).catch(() => {});
    this.emitBookingEvent("booking_created", booking, input.invitedByUserId);
    this.fireCostSheetAutoDraft(booking.id);
    // Bookings created here are born CONFIRMED and never pass through the
    // confirm endpoint - fire the match-call prep bundle (24h-hold explainer
    // + admin prep guide PDF) from this path too. Self-gates on MATCH_CALL.
    this.syncSurrogateStatusForMatchCall(booking as any, "hold").catch((e: any) =>
      this.logger.warn(`Surrogate on-hold status update failed for booking ${(booking as any)?.id}: ${e?.message}`),
    );
    this.fireMatchCallPrep(booking as any).catch((e: any) =>
      this.logger?.error?.(`fireMatchCallPrep failed for booking ${booking.id}: ${e.message}`) ?? console.error(e.message));

    return booking;
  }

  @Get("bookings/:id")
  @UseGuards(SessionOrJwtGuard)
  async getBookingById(@Req() req: Request, @Param("id") id: string) {
    const user = req.user as any;
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, dailyRoomUrl: true, providerId: true, provider: { select: { name: true } } } },
        parentUser: { select: { id: true, name: true, email: true, photoUrl: true, parentAccountId: true } },
      },
    });
    if (!booking) throw new NotFoundException("Booking not found");
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN") || user.roles?.includes("GOSTORK_CONCIERGE");
    const isAccountMember = await this.isParentAccountMember(user.id, booking.parentUserId);
    if (!isAdmin && booking.providerUserId !== user.id && !isAccountMember) {
      throw new ForbiddenException("Not authorized");
    }

    let parentAccountMembers: { id: string; name: string | null; email: string }[] = [];
    if ((booking.parentUser as any)?.parentAccountId) {
      parentAccountMembers = await this.prisma.user.findMany({
        where: { parentAccountId: booking.parentUser.parentAccountId },
        select: { id: true, name: true, email: true },
      });
    }

    return { ...booking, parentAccountMembers };
  }

  @Patch("bookings/:id")
  @UseGuards(SessionOrJwtGuard)
  async updateBooking(@Req() req: Request, @Param("id") id: string, @Body() body: any) {
    const user = req.user as any;
    const booking = await this.prisma.booking.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException("Booking not found");
    if (body.notes !== undefined) assertNoContactInfo(body.notes, "booking.notes.update", { bookingId: id, userId: user.id });
    const isAccountMember = await this.isParentAccountMember(user.id, booking.parentUserId);
    // Phase 4: any member of the HOST's provider team (e.g. a SCHEDULER who
    // booked the call on a coordinator's behalf) can manage the booking too,
    // not just the host themselves.
    let isProviderTeammate = false;
    if (!isAccountMember && booking.providerUserId !== user.id && user.providerId) {
      const host = await this.prisma.user.findUnique({
        where: { id: booking.providerUserId },
        select: { providerId: true },
      });
      isProviderTeammate = !!host?.providerId && host.providerId === user.providerId;
    }
    if (booking.providerUserId !== user.id && !isAccountMember && !isProviderTeammate) {
      throw new ForbiddenException("Not authorized");
    }

    const data: any = {};
    if (body.status) {
      data.status = body.status;
      if (body.status === "CANCELLED") {
        data.cancelledAt = new Date();
        data.cancelledByRole = (user.id === booking.providerUserId || isProviderTeammate) ? "provider" : "parent";
      }
    }
    if (body.notes !== undefined) data.notes = body.notes;

    const updated = await this.prisma.booking.update({
      where: { id },
      data,
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true } },
        parentUser: { select: { id: true, name: true, email: true, photoUrl: true } },
      },
    });

    if (body.status === "CANCELLED") {
      void emitBookingLifecycleEvent(updated.id, "CANCELED", (data.cancelledByRole as any) || "parent");
      this.syncSurrogateStatusForMatchCall(updated as any, "release").catch(() => {});
      this.notifications.sendBookingCancellation(updated).catch(() => {});
      this.deleteGoogleCalendarEvent(updated).catch(() => {});
      this.deleteParentGoogleCalendarEvent(updated).catch(() => {});
      this.deleteOutlookCalendarEvent(updated).catch(() => {});
      this.deleteParentOutlookCalendarEvent(updated).catch(() => {});
      this.emitBookingEvent("booking_cancelled", updated, user.id);
    }
    return updated;
  }

  @Post("bookings/:id/confirm")
  @UseGuards(SessionOrJwtGuard)
  async confirmBookingById(@Req() req: Request, @Param("id") id: string) {
    const user = req.user as any;
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } } } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });
    if (!booking) throw new NotFoundException("Booking not found");
    if (booking.providerUserId !== user.id) {
      throw new ForbiddenException("Only the provider can confirm this booking");
    }
    if (booking.status === "CONFIRMED") return { message: "Already confirmed", booking };
    if (booking.status === "CANCELLED" || booking.status === "RESCHEDULED") {
      throw new BadRequestException("This booking has been cancelled or rescheduled");
    }

    const updated = await this.prisma.booking.update({
      where: { id },
      data: { status: "CONFIRMED", providerConfirmed: true, parentConfirmed: true },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } } } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });

    void emitBookingLifecycleEvent(updated.id, "CONFIRMED", "provider");
    this.notifications.sendBookingConfirmation(updated).catch(() => {});
    this.syncBookingToGoogleCalendar(updated).catch(() => {});
    this.syncBookingToParentGoogleCalendar(updated).catch(() => {});
    this.syncBookingToOutlookCalendar(updated).catch(() => {});
    this.syncBookingToParentOutlookCalendar(updated).catch(() => {});
    this.emitBookingEvent("booking_confirmed", updated, user.id);
    this.syncSurrogateStatusForMatchCall(updated as any, "hold").catch((e: any) =>
      this.logger.warn(`Surrogate on-hold status update failed for booking ${updated?.id}: ${e?.message}`),
    );
    this.fireMatchCallPrep(updated).catch((e: any) =>
      console.error(`[match-call-prep] failed for booking ${updated.id}: ${e.message}`));
    return updated;
  }

  /**
   * Phase 4: a MATCH_CALL just got confirmed - prepare the parent BEFORE the
   * call: explain the 24h hold rule upfront, and attach the admin-uploaded
   * prep-questions guide (ConciergeAsset "match_call_prep_guide") if one
   * exists. Posted in the surrogate's 3-WAY chat so everything about her
   * lives in one thread (it's informational - the decision prompts stay in
   * the parent's private chat). Falls back to the private chat when no
   * 3-way session exists.
   */
  /**
   * Surrogate status lifecycle, scheduling side: the moment a MATCH_CALL is
   * booked her marketplace status flips to ON_HOLD (filterable, badge on the
   * card, excluded from AI suggestions). If the call is cancelled before the
   * 24h reservation exists, she flips back to AVAILABLE. The post-call
   * reservation, official-match (MATCHED) and expiry transitions live in
   * video.controller / billing.service / pending-booking.scheduler.
   */
  private async syncSurrogateStatusForMatchCall(
    booking: { id: string; meetingSubtype?: string | null; parentUserId?: string | null; providerUserId?: string | null; providerUser?: { providerId?: string | null } | null },
    action: "hold" | "release",
  ) {
    if (booking.meetingSubtype !== "MATCH_CALL" || !booking.parentUserId) return;
    let providerId = booking.providerUser?.providerId || null;
    if (!providerId && booking.providerUserId) {
      const host = await this.prisma.user.findUnique({
        where: { id: booking.providerUserId },
        select: { providerId: true },
      }).catch(() => null);
      providerId = host?.providerId || null;
    }
    if (!providerId) return;
    const session = await this.prisma.aiChatSession.findFirst({
      where: {
        userId: booking.parentUserId,
        providerId,
        subjectType: { contains: "surrog", mode: "insensitive" },
        subjectProfileId: { not: null },
      },
      orderBy: { updatedAt: "desc" },
      select: { subjectProfileId: true },
    });
    if (!session?.subjectProfileId) return;

    if (action === "hold") {
      const res = await this.prisma.surrogate.updateMany({
        where: { id: session.subjectProfileId, status: { in: ["AVAILABLE", "PENDING"] } },
        data: { status: "ON_HOLD" },
      });
      if (res.count > 0) this.logger.log(`Surrogate ${session.subjectProfileId} status -> ON_HOLD (match call ${booking.id} scheduled)`);
      return;
    }

    // release: only while the pre-call scheduling hold applies - never after
    // the post-call reservation was placed, and never off MATCHED. Also skip
    // when another live match call exists for the same surrogate journey.
    const otherUpcoming = await this.prisma.booking.count({
      where: {
        id: { not: booking.id },
        parentUserId: booking.parentUserId,
        meetingSubtype: "MATCH_CALL",
        status: { notIn: ["CANCELLED", "DECLINED", "RESCHEDULED"] },
        providerUser: { providerId },
      },
    });
    if (otherUpcoming > 0) return;
    const res = await this.prisma.surrogate.updateMany({
      where: { id: session.subjectProfileId, status: "ON_HOLD", reservedByParentId: null },
      data: { status: "AVAILABLE" },
    });
    if (res.count > 0) this.logger.log(`Surrogate ${session.subjectProfileId} status -> AVAILABLE (match call ${booking.id} cancelled)`);
  }

  private async fireMatchCallPrep(booking: { id: string; meetingSubtype?: string | null; parentUserId?: string | null; providerUserId?: string | null; scheduledAt: Date; providerUser?: { providerId?: string | null; provider?: { name?: string | null } | null } | null }) {
    const isMatch = booking.meetingSubtype === "MATCH_CALL";
    const isDoctor = booking.meetingSubtype === "DOCTOR_CONSULTATION";
    // No subtype = a regular consultation. Prep only applies to SCHEDULED
    // future calls (instant ad-hoc video calls start in seconds - nothing
    // to prepare) and only to the parent's FIRST call with this provider.
    const isConsultation = !isMatch && !isDoctor;
    if (!booking.parentUserId) return;
    if (isConsultation && new Date(booking.scheduledAt).getTime() < Date.now() + 20 * 60 * 1000) return;

    // Prefer the surrogate 3-way session for this (parent, provider) pair.
    // Callers don't always include provider info on the booking object
    // (createBookingInternal's include is slim) - resolve from the host.
    let providerId = booking.providerUser?.providerId || null;
    let resolvedProviderName = booking.providerUser?.provider?.name || null;
    let hostIsGoStorkStaff = false;
    if (booking.providerUserId) {
      const host = await this.prisma.user.findUnique({
        where: { id: booking.providerUserId },
        select: { providerId: true, roles: true, provider: { select: { name: true } } },
      }).catch(() => null);
      providerId = providerId || host?.providerId || null;
      resolvedProviderName = resolvedProviderName || host?.provider?.name || null;
      hostIsGoStorkStaff = !!(host?.roles || []).some(r => r === "GOSTORK_ADMIN" || r === "GOSTORK_CONCIERGE");
    }
    // GoStork concierge calls (staff-hosted, or booked on the GoStork house
    // provider) get NO provider prep bundle - the consultation guides coach
    // parents on questioning CLINICS and AGENCIES; sending the IVF question
    // list before a concierge chat is nonsense (the house provider is
    // approved for every service type, so type-derived guide picks misfire).
    if (hostIsGoStorkStaff || (resolvedProviderName || "").trim().toLowerCase() === "gostork") {
      console.log(`[prep-bundle] Skipping prep guide for GoStork concierge call (booking ${booking.id})`);
      return;
    }
    // Scope to the whole parent ACCOUNT, not just the booking's own user:
    // createConsultationChatSession reuses the shared thread across account
    // members, so a partner's booking looking up by userId alone missed it and
    // stranded the entire prep bundle in the private Eva chat - permanently,
    // since the matchCallPrepForBookingId dedupe blocks a re-post.
    const prepMemberIds = await (async () => {
      const me = await this.prisma.user.findUnique({
        where: { id: booking.parentUserId },
        select: { parentAccountId: true },
      });
      if (!me?.parentAccountId) return [booking.parentUserId];
      const members = await this.prisma.user.findMany({
        where: { parentAccountId: me.parentAccountId },
        select: { id: true },
      });
      return members.map((m) => m.id);
    })();
    const threeWaySession = providerId
      ? await this.prisma.aiChatSession.findFirst({
          where: {
            userId: { in: prepMemberIds },
            providerId,
            status: { in: ["PROVIDER_CONNECTED", "CONSULTATION_BOOKED"] },
            // Match calls live in the surrogate-subject session; doctor
            // calls in whichever session the parent has with the clinic.
            ...(isMatch ? { subjectType: { contains: "surrog", mode: "insensitive" } } : {}),
          },
          orderBy: { updatedAt: "desc" },
          select: { id: true, subjectType: true },
        })
      : null;
    const parentSession = threeWaySession
      ?? await this.prisma.aiChatSession.findFirst({
        where: { userId: { in: prepMemberIds }, status: "ACTIVE", sessionType: "PARENT" },
        orderBy: { updatedAt: "desc" },
        select: { id: true, subjectType: true },
      });
    if (!parentSession) return;

    // First-call-only gate for consultations: if the parent already has any
    // other booking with this provider, this isn't their first call.
    if (isConsultation) {
      if (!providerId) return;
      const priorBookings = await this.prisma.booking.count({
        where: {
          id: { not: booking.id },
          parentUserId: booking.parentUserId,
          status: { notIn: ["CANCELLED", "DECLINED", "RESCHEDULED"] },
          providerUser: { providerId },
        },
      });
      if (priorBookings > 0) return;
    }

    // Dedup: one prep bundle per booking (checked across ALL sessions so a
    // re-confirm can't double-send into a different thread).
    const existing = await this.prisma.aiChatMessage.findFirst({
      where: {
        uiCardData: { path: ["matchCallPrepForBookingId"], equals: booking.id },
      },
    });
    if (existing) return;

    const providerName = resolvedProviderName || "the agency";
    // Dual-audience: parent copy in the parent's zone, provider note in the provider's zone.
    const prepProviderTz = await resolveProviderTimezone(this.prisma, booking.providerUserId, booking.bookerTimezone);
    const prepParentTz = booking.bookerTimezone || prepProviderTz;
    const whenParent = formatWhen(booking.scheduledAt, prepParentTz, { weekday: "long" });
    const when = whenParent; // parent-facing default
    const whenProvider = formatWhen(booking.scheduledAt, prepProviderTz, { weekday: "long" });
    const parentUser = booking.parentUserId
      ? await this.prisma.user.findUnique({ where: { id: booking.parentUserId }, select: { firstName: true, name: true } }).catch(() => null)
      : null;
    const parentLabel = parentUser?.firstName || parentUser?.name || "the parent";

    // Dual-audience (CLAUDE.md rule): the parent reads second-person prep
    // guidance; the provider reads a status note about what the parent got.
    // Consultation guide selection: session subject first (a multi-service
    // agency's egg-donor chat is an egg-donor consult), provider type after.
    let consultKey: string | null = null;
    let consultFlavor = "";
    if (isConsultation) {
      const subj = ((parentSession as any).subjectType || "").toLowerCase();
      let kind: "ivf" | "surrogacy" | "egg_donor" | "sperm_bank" | null =
        subj.includes("surrog") ? "surrogacy"
        : subj.includes("egg") ? "egg_donor"
        : subj.includes("sperm") ? "sperm_bank"
        : subj.includes("clinic") || subj.includes("doctor") ? "ivf"
        : null;
      if (!kind && providerId) {
        const prov = await this.prisma.provider.findUnique({
          where: { id: providerId },
          select: { services: { select: { status: true, providerType: { select: { name: true } } } } },
        }).catch(() => null);
        const names = (prov?.services || []).filter((x: any) => x.status === "APPROVED").map((x: any) => x.providerType?.name || "");
        kind = names.includes("IVF Clinic") ? "ivf"
          : names.includes("Surrogacy Agency") ? "surrogacy"
          : names.some((n: string) => n.includes("Egg")) ? "egg_donor"
          : names.includes("Sperm Bank") ? "sperm_bank"
          : null;
      }
      if (!kind) return; // unknown provider type - nothing sensible to send
      consultKey = `consultation_prep_guide_${kind}`;
      consultFlavor = kind === "ivf"
        ? "about their success rates, programs, lab quality, and real costs"
        : kind === "surrogacy"
          ? "about how they screen and match surrogates, how they'll support you, and what the journey really costs"
          : kind === "egg_donor"
            ? "about their donor pool, screening standards, matching process, and true costs"
            : "about donor screening, choosing the right donor and vial type, and shipping logistics";
    }

    const parentContent = isConsultation
      ? `Your consultation with ${providerName} is confirmed for ${when} - a great first step!

First calls can feel like a lot, so I'm attaching a prep guide with thoughtful questions to ask ${consultFlavor}. Skim it before the call and jot down the ones that matter most to you.

I'll check in with you right after the call. You've got this!`
      : isMatch
      ? `Your match call is confirmed for ${when} - this is such an exciting step!

Two things to know before the call:

1. After the match call ends, the surrogate will be placed on an exclusive 24-hour hold just for you. You'll have those 24 hours to decide whether to move forward - after that, the hold is released and she may be matched with another family. No pressure during the call itself; the clock only starts when it ends.

2. It's completely normal to wonder what to ask. I'm attaching ${providerName === "the agency" ? "our" : "a"} prep guide with thoughtful questions - personal, medical, legal, and everything in between. Skim it before the call and jot down the ones that matter most to you.

I'll check in with you right after the call. You've got this!`
      : `Your doctor call is confirmed for ${when} - a big step toward your treatment plan!

A little preparation goes a long way with these calls, so I'm attaching a prep guide with thoughtful questions to ask the doctor - about success rates for your specific situation, the recommended protocol, genetic testing, medications, and the real costs. Skim it before the call, bring your medical records if you have them, and jot down your top three concerns.

I'll check in with you right after the call. You've got this!`;
    const providerNote = isConsultation
      ? `The consultation is confirmed for ${whenProvider}. We've prepped ${parentLabel} for it: they received our first-consultation questions guide (attached below).`
      : isMatch
      ? `The match call is confirmed for ${whenProvider}. We've prepped ${parentLabel} for it: they know about the exclusive 24-hour hold that starts when the call ends, and they received the Match Call prep-questions guide (attached below).`
      : `The doctor call is confirmed for ${whenProvider}. We've prepped ${parentLabel} for it: they received the Doctor Call prep-questions guide (attached below) and were encouraged to bring their records and top concerns.`;
    await this.prisma.aiChatMessage.create({
      data: {
        sessionId: parentSession.id,
        role: "assistant",
        content: parentContent,
        senderType: "system",
        senderName: "GoStork",
        uiCardData: {
          matchCallPrepForBookingId: booking.id,
          providerContent: providerNote,
        } as any,
      },
    });

    // Attach the admin-uploaded guide when it exists (soft-skip otherwise).
    const guideKey = isConsultation ? consultKey! : isMatch ? "match_call_prep_guide" : "doctor_call_prep_guide";
    const guide = await this.prisma.conciergeAsset.findUnique({ where: { key: guideKey } }).catch(() => null);
    if (guide) {
      await this.prisma.aiChatMessage.create({
        data: {
          sessionId: parentSession.id,
          role: "assistant",
          content: `Here's your ${isConsultation ? "consultation" : isMatch ? "Match Call" : "Doctor Call"} prep guide:`,
          senderType: "system",
          senderName: "GoStork",
          uiCardType: "attachment",
          uiCardData: {
            matchCallPrepForBookingId: `${booking.id}:guide`,
            providerContent: `Prep guide sent to ${parentLabel}:`,
            url: `/api/knowledge/concierge-assets/${guideKey}/file`,
            originalName: guide.fileName || "Prep Guide.pdf",
            mimeType: "application/pdf",
          },
        },
      });
    }
  }

  @Post("bookings/:id/decline")
  @UseGuards(SessionOrJwtGuard)
  async declineBookingById(@Req() req: Request, @Param("id") id: string) {
    const user = req.user as any;
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } }, scheduleConfig: { select: { bookingPageSlug: true } } } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });
    if (!booking) throw new NotFoundException("Booking not found");
    if (booking.providerUserId !== user.id) {
      throw new ForbiddenException("Only the provider can decline this booking");
    }
    if (booking.status === "CANCELLED") return { message: "Already declined", booking };
    if (booking.status === "RESCHEDULED") {
      throw new BadRequestException("This booking has been rescheduled");
    }

    const updated = await this.prisma.booking.update({
      where: { id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledByRole: "provider" },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } }, scheduleConfig: { select: { bookingPageSlug: true } } } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });
    this.syncSurrogateStatusForMatchCall(updated as any, "release").catch(() => {});
    void emitBookingLifecycleEvent(updated.id, "CANCELED", "provider", { declined: true });

    this.notifications.sendBookingDeclinedToParent(updated).catch(() => {});
    this.deleteGoogleCalendarEvent(updated).catch(() => {});
    this.deleteParentGoogleCalendarEvent(updated).catch(() => {});
    this.deleteOutlookCalendarEvent(updated).catch(() => {});
    this.deleteParentOutlookCalendarEvent(updated).catch(() => {});
    this.emitBookingEvent("booking_declined", updated, user.id);
    return updated;
  }

  @Post("bookings/:id/suggest-time")
  @UseGuards(SessionOrJwtGuard)
  async suggestNewTimeById(@Req() req: Request, @Param("id") id: string, @Body() body: any) {
    const user = req.user as any;
    const original = await this.prisma.booking.findUnique({
      where: { id },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } } } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });
    if (!original) throw new NotFoundException("Booking not found");
    if (original.providerUserId !== user.id) {
      throw new ForbiddenException("Only the provider can suggest a new time");
    }
    if (original.status === "CANCELLED" || original.status === "RESCHEDULED") {
      throw new BadRequestException("This booking has already been cancelled or rescheduled");
    }
    if (!body.scheduledAt) throw new BadRequestException("scheduledAt is required");

    await this.prisma.booking.update({
      where: { id: original.id },
      data: { status: "RESCHEDULED", cancelledAt: new Date() },
    });

    const suggestNotes = body.message
      ? `${body.message}${original.notes ? '\n\n' + original.notes : ''}`
      : original.notes;

    const suggested = await this.prisma.booking.create({
      data: {
        providerUserId: original.providerUserId,
        parentUserId: original.parentUserId,
        scheduledAt: new Date(body.scheduledAt),
        duration: body.duration || original.duration,
        meetingType: original.meetingType,
        status: "PENDING",
        parentConfirmed: false,
        providerConfirmed: true,
        confirmToken: randomUUID(),
        meetingUrl: original.meetingUrl,
        subject: original.subject,
        notes: suggestNotes,
        attendeeEmails: original.attendeeEmails,
        attendeeName: original.attendeeName,
        invitedByUserId: original.providerUserId,
        rescheduledFromId: original.id,
        bookerTimezone: original.bookerTimezone,
      },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } } } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });
    void emitBookingLifecycleEvent(suggested.id, "RESCHEDULED", "provider", { suggestedTime: true });

    this.notifications.sendNewTimeSuggested(original, suggested).catch(() => {});
    this.deleteGoogleCalendarEvent(original).catch(() => {});
    this.deleteParentGoogleCalendarEvent(original).catch(() => {});
    this.deleteOutlookCalendarEvent(original).catch(() => {});
    this.deleteParentOutlookCalendarEvent(original).catch(() => {});
    this.emitBookingEvent("booking_new_time", suggested, user.id);
    return { message: "New time suggested", booking: suggested };
  }

  @Post("bookings/:id/reschedule")
  @UseGuards(SessionOrJwtGuard)
  async rescheduleBooking(@Req() req: Request, @Param("id") id: string, @Body() body: any) {
    const user = req.user as any;
    const original = await this.prisma.booking.findUnique({ where: { id } });
    if (!original) throw new NotFoundException("Booking not found");
    const isAccountMember = await this.isParentAccountMember(user.id, original.parentUserId);
    // Phase 4: host's provider teammates (e.g. the SCHEDULER who booked the
    // call) may reschedule too.
    let isProviderTeammate = false;
    if (!isAccountMember && original.providerUserId !== user.id && user.providerId) {
      const host = await this.prisma.user.findUnique({
        where: { id: original.providerUserId },
        select: { providerId: true },
      });
      isProviderTeammate = !!host?.providerId && host.providerId === user.providerId;
    }
    if (original.providerUserId !== user.id && !isAccountMember && !isProviderTeammate) {
      throw new ForbiddenException("Not authorized");
    }

    await this.prisma.booking.update({
      where: { id },
      data: { status: "RESCHEDULED", cancelledAt: new Date() },
    });

    const newBooking = await this.prisma.booking.create({
      data: {
        providerUserId: original.providerUserId,
        parentUserId: original.parentUserId,
        scheduledAt: new Date(body.scheduledAt),
        duration: body.duration || original.duration,
        meetingType: original.meetingType,
        status: "PENDING",
        meetingUrl: original.meetingUrl,
        subject: original.subject,
        notes: original.notes,
        attendeeEmails: original.attendeeEmails,
        attendeeName: original.attendeeName,
        invitedByUserId: original.invitedByUserId,
        rescheduledFromId: original.id,
        bookerTimezone: body.bookerTimezone || original.bookerTimezone,
        // Match/Doctor Calls stay what they are across a reschedule -
        // dropping the subtype would break the readiness gating + 24h hold.
        meetingSubtype: original.meetingSubtype,
      },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true } },
        parentUser: { select: { id: true, name: true, email: true, photoUrl: true } },
      },
    });
    void emitBookingLifecycleEvent(newBooking.id, "RESCHEDULED", user.id === original.providerUserId ? "provider" : "parent");

    this.notifications.sendBookingRescheduled(original, newBooking, body.message || "").catch(() => {});
    this.deleteGoogleCalendarEvent(original).catch(() => {});
    this.deleteParentGoogleCalendarEvent(original).catch(() => {});
    this.deleteOutlookCalendarEvent(original).catch(() => {});
    this.deleteParentOutlookCalendarEvent(original).catch(() => {});
    this.syncBookingToGoogleCalendar(newBooking).catch(() => {});
    this.syncBookingToParentGoogleCalendar(newBooking).catch(() => {});
    this.syncBookingToOutlookCalendar(newBooking).catch(() => {});
    this.syncBookingToParentOutlookCalendar(newBooking).catch(() => {});
    this.emitBookingEvent("booking_rescheduled", newBooking, user.id);
    return newBooking;
  }

  private expandRecurringBlocks(blocks: any[], rangeStart: Date, rangeEnd: Date): any[] {
    const result: any[] = [];
    for (const block of blocks) {
      if (!block.recurrence) {
        if (new Date(block.startTime) <= rangeEnd && new Date(block.endTime) >= rangeStart) {
          result.push(block);
        }
        continue;
      }
      const blockStart = new Date(block.startTime);
      const blockEnd = new Date(block.endTime);
      const duration = blockEnd.getTime() - blockStart.getTime();
      const recEnd = block.recurrenceEnd ? new Date(block.recurrenceEnd) : rangeEnd;
      const effectiveEnd = recEnd < rangeEnd ? recEnd : rangeEnd;

      let current = new Date(blockStart);
      const maxOccurrences = 500;
      let count = 0;

      while (current <= effectiveEnd && count < maxOccurrences) {
        const occEnd = new Date(current.getTime() + duration);
        if (occEnd >= rangeStart) {
          result.push({
            ...block,
            id: `${block.id}_${current.toISOString()}`,
            startTime: current.toISOString(),
            endTime: occEnd.toISOString(),
            _parentId: block.id,
          });
        }
        count++;
        const next = new Date(current);
        switch (block.recurrence) {
          case "daily": next.setDate(next.getDate() + 1); break;
          case "weekly": next.setDate(next.getDate() + 7); break;
          case "monthly": next.setMonth(next.getMonth() + 1); break;
          case "yearly": next.setFullYear(next.getFullYear() + 1); break;
          default: next.setDate(next.getDate() + 1); break;
        }
        current = next;
      }
    }
    return result;
  }

  @Get("blocks")
  @UseGuards(SessionOrJwtGuard)
  async listBlocks(
    @Req() req: Request,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const user = req.user as any;
    const allBlocks = await this.prisma.calendarBlock.findMany({
      where: { userId: user.id },
      orderBy: { startTime: "asc" },
    });

    const rangeStart = from ? new Date(from) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const rangeEnd = to ? new Date(to) : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    return this.expandRecurringBlocks(allBlocks, rangeStart, rangeEnd);
  }

  @Post("blocks")
  @UseGuards(SessionOrJwtGuard)
  async createBlock(@Req() req: Request, @Body() body: any) {
    const user = req.user as any;
    const validRecurrences = ["daily", "weekly", "monthly", "yearly"];
    return this.prisma.calendarBlock.create({
      data: {
        userId: user.id,
        title: body.title || (body.blockType === "available" ? "Available" : "Busy"),
        blockType: body.blockType === "available" ? "available" : "busy",
        startTime: new Date(body.startTime),
        endTime: new Date(body.endTime),
        allDay: body.allDay || false,
        recurrence: body.recurrence && validRecurrences.includes(body.recurrence) ? body.recurrence : null,
        recurrenceEnd: body.recurrenceEnd ? new Date(body.recurrenceEnd) : null,
      },
    });
  }

  @Patch("blocks/:id")
  @UseGuards(SessionOrJwtGuard)
  async updateBlock(@Req() req: Request, @Param("id") id: string, @Body() body: any) {
    const user = req.user as any;
    const block = await this.prisma.calendarBlock.findUnique({ where: { id } });
    if (!block) throw new NotFoundException("Block not found");
    if (block.userId !== user.id) throw new ForbiddenException("Not authorized");

    const validRecurrences = ["daily", "weekly", "monthly", "yearly"];
    const data: any = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.blockType !== undefined) data.blockType = body.blockType === "available" ? "available" : "busy";
    if (body.startTime !== undefined) data.startTime = new Date(body.startTime);
    if (body.endTime !== undefined) data.endTime = new Date(body.endTime);
    if (body.allDay !== undefined) data.allDay = body.allDay;
    if (body.recurrence !== undefined) data.recurrence = body.recurrence && validRecurrences.includes(body.recurrence) ? body.recurrence : null;
    if (body.recurrenceEnd !== undefined) data.recurrenceEnd = body.recurrenceEnd ? new Date(body.recurrenceEnd) : null;

    return this.prisma.calendarBlock.update({ where: { id }, data });
  }

  @Delete("blocks/:id")
  @UseGuards(SessionOrJwtGuard)
  async deleteBlock(@Req() req: Request, @Param("id") id: string) {
    const user = req.user as any;
    const block = await this.prisma.calendarBlock.findUnique({ where: { id } });
    if (!block) throw new NotFoundException("Block not found");
    if (block.userId !== user.id) throw new ForbiddenException("Not authorized");

    await this.prisma.calendarBlock.delete({ where: { id } });
    return { success: true };
  }

  @Get("page/:slug")
  async getBookingPageInfo(@Param("slug") slug: string) {
    const config = await this.prisma.scheduleConfig.findUnique({
      where: { bookingPageSlug: slug },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            photoUrl: true,
            email: true,
            providerId: true,
            provider: {
              select: {
                id: true, name: true, logoUrl: true,
                brandSettings: { select: { logoUrl: true, logoWithNameUrl: true } },
              },
            },
          },
        },
      },
    });

    if (!config) throw new NotFoundException("Booking page not found");

    const siteSettings = await this.prisma.siteSettings.findFirst({
      select: { logoUrl: true, logoWithNameUrl: true },
    });

    return {
      user: config.user,
      timezone: config.timezone,
      meetingDuration: config.meetingDuration,
      minBookingNotice: config.minBookingNotice,
      meetingLink: config.meetingLink,
      siteSettings,
    };
  }

  @Get("availability-days/:slug")
  async getAvailabilityDays(
    @Param("slug") slug: string,
    @Query("month") month: string,
    @Req() req: Request,
    @Query("timezone") timezone?: string,
    @Query("parentUserId") parentUserId?: string,
  ) {
    if (!month) throw new BadRequestException("month query parameter is required (YYYY-MM)");

    if (parentUserId) {
      const authenticatedUser = req.user as any;
      if (!authenticatedUser || authenticatedUser.id !== parentUserId) {
        parentUserId = undefined;
      }
    }

    const config = await this.prisma.scheduleConfig.findUnique({
      where: { bookingPageSlug: slug },
      include: { availabilitySlots: true },
    });
    if (!config) throw new NotFoundException("Booking page not found");

    const userTz = timezone || config.timezone;
    const monthStart = DateTime.fromISO(`${month}-01`, { zone: userTz }).startOf("month");
    const monthEnd = monthStart.endOf("month");
    const today = DateTime.now().setZone(userTz).startOf("day");

    const overrides = await this.prisma.availabilityOverride.findMany({
      where: {
        userId: config.userId,
        date: { gte: monthStart.toJSDate(), lte: monthEnd.toJSDate() },
      },
    });
    const overrideMap = new Map(overrides.map((o) => {
      const d = new Date(o.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return [key, o];
    }));

    const allUserBlocks = await this.prisma.calendarBlock.findMany({
      where: {
        userId: config.userId,
        OR: [
          { recurrence: null, startTime: { lte: monthEnd.toJSDate() }, endTime: { gte: monthStart.toJSDate() } },
          { recurrence: { not: null } },
        ],
      },
    });

    const activeDays = new Set<number>();
    const slotsPerDay = config.availabilitySlots.filter((s) => s.isActive);

    let current = monthStart;
    while (current <= monthEnd) {
      if (current < today) {
        current = current.plus({ days: 1 });
        continue;
      }
      const dateKey = current.toFormat("yyyy-MM-dd");
      const dayOfWeek = current.weekday % 7;
      const override = overrideMap.get(dateKey);

      if (override && !override.isAvailable) {
        current = current.plus({ days: 1 });
        continue;
      }

      let hasTimeWindows = false;
      if (override && override.isAvailable && override.slots) {
        const slots = override.slots as any[];
        hasTimeWindows = slots.length > 0;
      } else {
        hasTimeWindows = slotsPerDay.some((s) => s.dayOfWeek === dayOfWeek);
      }

      const dayStart = current.startOf("day").toJSDate();
      const dayEnd = current.endOf("day").toJSDate();
      const expandedBlocks = this.expandRecurringBlocks(allUserBlocks, dayStart, dayEnd);
      const availableBlocks = expandedBlocks.filter((b) => b.blockType === "available");
      if (availableBlocks.length > 0) hasTimeWindows = true;

      if (hasTimeWindows) {
        activeDays.add(current.day);
      }
      current = current.plus({ days: 1 });
    }

    return { availableDays: Array.from(activeDays) };
  }

  @Get("availability/:slug")
  async getAvailability(
    @Param("slug") slug: string,
    @Query("date") date: string,
    @Req() req: Request,
    @Query("timezone") timezone?: string,
    @Query("parentUserId") parentUserId?: string,
  ) {
    if (!date) throw new BadRequestException("date query parameter is required");

    if (parentUserId) {
      const authenticatedUser = req.user as any;
      if (!authenticatedUser || authenticatedUser.id !== parentUserId) {
        parentUserId = undefined;
      }
    }

    const config = await this.prisma.scheduleConfig.findUnique({
      where: { bookingPageSlug: slug },
      include: {
        availabilitySlots: true,
        user: {
          select: {
            id: true,
            name: true,
            photoUrl: true,
            email: true,
            providerId: true,
            provider: { select: { id: true, name: true, logoUrl: true } },
          },
        },
      },
    });

    if (!config) throw new NotFoundException("Booking page not found");

    const override = await this.prisma.availabilityOverride.findUnique({
      where: { userId_date: { userId: config.userId, date: new Date(date + "T00:00:00") } },
    });

    if (override && !override.isAvailable) {
      return {
        user: config.user,
        date,
        timezone: timezone || config.timezone,
        meetingDuration: config.meetingDuration,
        slots: [],
        overrideLabel: override.label,
      };
    }

    const requestedDate = new Date(date + "T00:00:00");
    const dayOfWeek = requestedDate.getDay();

    let timeWindows: { startTime: string; endTime: string }[];

    if (override && override.isAvailable && override.slots) {
      timeWindows = override.slots as { startTime: string; endTime: string }[];
    } else {
      timeWindows = config.availabilitySlots
        .filter((s) => s.dayOfWeek === dayOfWeek && s.isActive)
        .map((s) => ({ startTime: s.startTime, endTime: s.endTime }));
    }

    const userTz = timezone || config.timezone;
    const dayStart = DateTime.fromISO(date, { zone: userTz }).startOf("day");
    const dayEnd = dayStart.endOf("day");
    const startOfDay = dayStart.toJSDate();
    const endOfDay = dayEnd.toJSDate();

    const allUserBlocks = await this.prisma.calendarBlock.findMany({
      where: {
        userId: config.userId,
        OR: [
          { recurrence: null, startTime: { lte: endOfDay }, endTime: { gte: startOfDay } },
          { recurrence: { not: null } },
        ],
      },
    });
    const existingBlocks = this.expandRecurringBlocks(allUserBlocks, startOfDay, endOfDay);

    const availableBlocks = existingBlocks.filter((b) => b.blockType === "available");
    for (const ab of availableBlocks) {
      const abStart = DateTime.fromJSDate(new Date(ab.startTime), { zone: userTz });
      const abEnd = DateTime.fromJSDate(new Date(ab.endTime), { zone: userTz });
      const abStartTime = abStart.toFormat("HH:mm");
      const abEndTime = abEnd.toFormat("HH:mm");
      const alreadyCovered = timeWindows.some((tw) => tw.startTime <= abStartTime && tw.endTime >= abEndTime);
      if (!alreadyCovered) {
        timeWindows.push({ startTime: abStartTime, endTime: abEndTime });
      }
    }

    if (timeWindows.length === 0) {
      return {
        user: config.user,
        date,
        timezone: timezone || config.timezone,
        meetingDuration: config.meetingDuration,
        slots: [],
      };
    }

    const existingBookings = await this.prisma.booking.findMany({
      where: {
        providerUserId: config.userId,
        scheduledAt: { gte: startOfDay, lte: endOfDay },
        status: { notIn: ["CANCELLED", "RESCHEDULED"] },
      },
    });

    let googleBusyIntervals: { start: Date; end: Date }[] = [];

    const eventFreeOverrides = await this.prisma.eventFreeOverride.findMany({
      where: { userId: config.userId },
    });
    const freeOverrideSet = new Set(
      eventFreeOverrides.map((o) => `${o.provider}::${o.externalEventId}`)
    );
    const freeOverrideBaseIds = eventFreeOverrides.map((o) => ({ provider: o.provider, baseId: o.externalEventId }));

    const isEventOverridden = (provider: string, eventId: string): boolean => {
      if (freeOverrideSet.has(`${provider}::${eventId}`)) return true;
      for (const o of freeOverrideBaseIds) {
        if (o.provider === provider && eventId.startsWith(o.baseId + "_")) return true;
      }
      return false;
    };

    const extractBusyIntervals = (freeBusyData: any, target: { start: Date; end: Date }[], provider?: string) => {
      if (!freeBusyData) return;
      for (const calId of Object.keys(freeBusyData)) {
        const busySlots = (freeBusyData as any)[calId]?.busy || [];
        for (const busy of busySlots) {
          if (provider && busy.eventId && isEventOverridden(provider, busy.eventId)) {
            continue;
          }
          const busyStart = new Date(busy.start);
          const busyEnd = new Date(busy.end);
          const durationMs = busyEnd.getTime() - busyStart.getTime();
          if (durationMs >= 24 * 60 * 60 * 1000) continue;
          target.push({ start: busyStart, end: busyEnd });
        }
      }
    };

    try {
      const conflictConnections = await this.prisma.calendarConnection.findMany({
        where: { userId: config.userId, isConflictCalendar: true, connected: true },
      });
      if (conflictConnections.length > 0) {
        const googleConns = conflictConnections.filter(c => c.provider === "google");
        const microsoftConns = conflictConnections.filter(c => c.provider === "microsoft");

        const hasGoogleOverrides = eventFreeOverrides.some((o) => o.provider === "google");

        if (googleConns.length > 0) {
          const calendarIds = googleConns.map((c) => c.calendarId).filter(Boolean) as string[];
          if (hasGoogleOverrides && calendarIds.length > 0) {
            const eventsPerCal: Record<string, { busy: { start: string; end: string; eventId?: string }[] }> = {};
            for (const calId of calendarIds) {
              try {
                const events = await this.googleCalendar.getEvents(config.userId, calId, startOfDay.toISOString(), endOfDay.toISOString());
                eventsPerCal[calId] = {
                  busy: events
                    .filter((e: any) => e.status !== "cancelled" && e.transparency !== "transparent")
                    .map((e: any) => ({ start: e.start, end: e.end, eventId: e.id })),
                };
              } catch (e: any) {
                console.warn(`[calendar] Failed to fetch Google events for override check: ${e.message}`);
              }
            }
            extractBusyIntervals(eventsPerCal, googleBusyIntervals, "google");
          } else {
            const freeBusyData = await this.googleCalendar.getFreeBusy(
              config.userId, calendarIds, startOfDay.toISOString(), endOfDay.toISOString(),
            );
            extractBusyIntervals(freeBusyData, googleBusyIntervals);
          }
        }

        if (microsoftConns.length > 0) {
          const calendarIds = microsoftConns.map((c) => c.calendarId).filter(Boolean) as string[];
          if (calendarIds.length > 0) {
            const freeBusyData = await this.microsoftCalendar.getFreeBusy(
              config.userId, calendarIds, startOfDay.toISOString(), endOfDay.toISOString(),
            );
            extractBusyIntervals(freeBusyData, googleBusyIntervals, "microsoft");
          }
        }

        const caldavConns = conflictConnections.filter(c => c.provider === "apple");
        if (caldavConns.length > 0) {
          const caldavByProvider: Record<string, string[]> = {};
          for (const conn of caldavConns) {
            if (!conn.calendarId) continue;
            if (!caldavByProvider[conn.provider]) caldavByProvider[conn.provider] = [];
            caldavByProvider[conn.provider].push(conn.calendarId);
          }
          for (const [provider, calendarUrls] of Object.entries(caldavByProvider)) {
            if (calendarUrls.length > 0) {
              const freeBusyData = await this.caldavCalendar.getFreeBusy(
                config.userId, calendarUrls, startOfDay.toISOString(), endOfDay.toISOString(),
              );
              extractBusyIntervals(freeBusyData, googleBusyIntervals, provider);
            }
          }
        }
      }
    } catch (err: any) {
      console.warn(`[calendar] Failed to fetch calendar busy times for user ${config.userId}: ${err.message}`);
    }

    let parentCalendarActive = false;
    if (parentUserId) {
      try {
        const parentConflictConnections = await this.prisma.calendarConnection.findMany({
          where: { userId: parentUserId, isConflictCalendar: true, connected: true },
        });
        if (parentConflictConnections.length > 0) {
          parentCalendarActive = true;
          const parentGoogleConns = parentConflictConnections.filter(c => c.provider === "google");
          const parentMicrosoftConns = parentConflictConnections.filter(c => c.provider === "microsoft");

          if (parentGoogleConns.length > 0) {
            const parentCalendarIds = parentGoogleConns.map((c) => c.calendarId).filter(Boolean) as string[];
            const parentFreeBusy = await this.googleCalendar.getFreeBusy(
              parentUserId, parentCalendarIds, startOfDay.toISOString(), endOfDay.toISOString(),
            );
            extractBusyIntervals(parentFreeBusy, googleBusyIntervals);
          }

          if (parentMicrosoftConns.length > 0) {
            const parentCalendarIds = parentMicrosoftConns.map((c) => c.calendarId).filter(Boolean) as string[];
            if (parentCalendarIds.length > 0) {
              const parentFreeBusy = await this.microsoftCalendar.getFreeBusy(
                parentUserId, parentCalendarIds, startOfDay.toISOString(), endOfDay.toISOString(),
              );
              extractBusyIntervals(parentFreeBusy, googleBusyIntervals);
            }
          }

          const parentCaldavConns = parentConflictConnections.filter(c => c.provider === "apple");
          if (parentCaldavConns.length > 0) {
            const parentCalendarUrls = parentCaldavConns.map((c) => c.calendarId).filter(Boolean) as string[];
            if (parentCalendarUrls.length > 0) {
              const parentFreeBusy = await this.caldavCalendar.getFreeBusy(
                parentUserId, parentCalendarUrls, startOfDay.toISOString(), endOfDay.toISOString(),
              );
              extractBusyIntervals(parentFreeBusy, googleBusyIntervals);
            }
          }
        }
      } catch (err: any) {
        console.warn(`[calendar] Failed to fetch parent calendar busy times for user ${parentUserId}: ${err.message}`);
      }
    }

    const availableSlots: { time: string; endTime: string }[] = [];
    const duration = config.meetingDuration;
    const buffer = config.bufferTime;

    const now = new Date();
    const minNoticeTime = new Date(now.getTime() + config.minBookingNotice * 60 * 1000);

    for (const slot of timeWindows) {
      const [startH, startM] = slot.startTime.split(":").map(Number);
      const [endH, endM] = slot.endTime.split(":").map(Number);

      let currentMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      while (currentMinutes + duration <= endMinutes) {
        const hour = Math.floor(currentMinutes / 60);
        const minute = currentMinutes % 60;
        const slotStartDT = dayStart.set({ hour, minute, second: 0, millisecond: 0 });
        const slotStart = slotStartDT.toJSDate();
        const slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);

        if (slotStart < minNoticeTime) {
          currentMinutes += duration + buffer;
          continue;
        }

        const hasConflict = existingBookings.some((b) => {
          const bStart = new Date(b.scheduledAt);
          const bEnd = new Date(bStart.getTime() + b.duration * 60 * 1000);
          const bStartWithBuffer = new Date(bStart.getTime() - buffer * 60 * 1000);
          const bEndWithBuffer = new Date(bEnd.getTime() + buffer * 60 * 1000);
          return slotStart < bEndWithBuffer && slotEnd > bStartWithBuffer;
        });

        const hasBlockConflict = existingBlocks.some((block) => {
          if (block.blockType === "available") return false;
          return slotStart < new Date(block.endTime) && slotEnd > new Date(block.startTime);
        });

        const hasGoogleConflict = googleBusyIntervals.some((busy) => {
          return slotStart < busy.end && slotEnd > busy.start;
        });

        if (!hasConflict && !hasBlockConflict && !hasGoogleConflict) {
          const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
          const endMin = currentMinutes + duration;
          const endTimeStr = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
          availableSlots.push({ time: timeStr, endTime: endTimeStr });
        }

        currentMinutes += duration + buffer;
      }
    }

    return {
      user: config.user,
      date,
      timezone: userTz,
      meetingDuration: config.meetingDuration,
      slots: availableSlots,
      parentCalendarActive,
    };
  }

  @Post("book/:slug")
  async bookSlot(@Param("slug") slug: string, @Body() body: any) {
    const config = await this.prisma.scheduleConfig.findUnique({
      where: { bookingPageSlug: slug },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    if (!config) throw new NotFoundException("Booking page not found");

    if (!body.scheduledAt || !body.name || !body.email) {
      throw new BadRequestException("scheduledAt, name, and email are required");
    }
    // Booking notes are parent-typed free text that leaves the platform: they
    // are printed verbatim in the provider's notification EMAIL and copied into
    // the external calendar event description. Guarding at the source covers
    // all five of those egress points. `name` and `email` are the booker's own
    // and are the point of the endpoint.
    assertNoContactInfo(body.notes, "booking.notes.public", { slug });

    const bookerTz = body.timezone || config.timezone;
    const parsedDT = DateTime.fromISO(body.scheduledAt, { zone: bookerTz });
    if (!parsedDT.isValid) {
      throw new BadRequestException("Invalid scheduledAt date");
    }
    const scheduledAt = parsedDT.toJSDate();
    const duration = config.meetingDuration;
    const slotEnd = new Date(scheduledAt.getTime() + duration * 60 * 1000);
    const bufferMs = (config.bufferTime || 0) * 60 * 1000;

    // Provision the per-booking room BEFORE the transaction (no external API
    // calls inside a tx). If the slot turns out to conflict, the orphan Daily
    // room is harmless - private, token-gated, never referenced.
    const bookingRoomUrl = await this.provisionBookingRoom(config.meetingLink || null);

    const booking = await this.prisma.$transaction(async (tx) => {
      const potentialConflicts = await tx.booking.findMany({
        where: {
          providerUserId: config.userId,
          status: { notIn: ["CANCELLED", "RESCHEDULED"] },
          scheduledAt: {
            lt: new Date(slotEnd.getTime() + bufferMs),
            gte: new Date(scheduledAt.getTime() - 24 * 60 * 60 * 1000),
          },
        },
      });

      const conflicting = potentialConflicts.find((b) => {
        const bEnd = new Date(b.scheduledAt.getTime() + b.duration * 60 * 1000 + bufferMs);
        const bStart = new Date(b.scheduledAt.getTime() - bufferMs);
        return bStart < slotEnd && bEnd > scheduledAt;
      });

      if (conflicting) {
        throw new ConflictException("This time slot is no longer available");
      }

      const allBlocksForConflict = await tx.calendarBlock.findMany({
        where: {
          userId: config.userId,
          blockType: "busy",
          OR: [
            { recurrence: null, startTime: { lt: slotEnd }, endTime: { gte: scheduledAt } },
            { recurrence: { not: null } },
          ],
        },
      });
      const expandedConflictBlocks = this.expandRecurringBlocks(allBlocksForConflict, scheduledAt, slotEnd);
      const blockConflict = expandedConflictBlocks.find((block) => {
        return new Date(block.startTime) < slotEnd && new Date(block.endTime) >= scheduledAt;
      });

      if (blockConflict) {
        throw new ConflictException("This time slot is blocked");
      }

      let parentUser = await tx.user.findUnique({ where: { email: body.email } });

      const allAttendeeEmails = [body.email];
      if (Array.isArray(body.additionalAttendees)) {
        for (const ae of body.additionalAttendees) {
          const trimmed = String(ae).trim().toLowerCase();
          if (trimmed && !allAttendeeEmails.includes(trimmed)) {
            allAttendeeEmails.push(trimmed);
          }
        }
      }

      // Phase 4: Match Call / Doctor Call bookings carry a subtype that
      // gates the post-call readiness prompt + the 24h surrogate hold.
      // Whitelisted - anything else is stored as a plain consultation.
      const VALID_MEETING_SUBTYPES = new Set(["MATCH_CALL", "DOCTOR_CONSULTATION"]);
      const meetingSubtype = VALID_MEETING_SUBTYPES.has(body.meetingSubtype) ? body.meetingSubtype : null;

      return tx.booking.create({
        data: {
          providerUserId: config.userId,
          parentUserId: parentUser?.id || null,
          scheduledAt,
          duration,
          meetingType: "video",
          status: "PENDING",
          parentConfirmed: true,
          providerConfirmed: false,
          confirmToken: randomUUID(),
          meetingUrl: bookingRoomUrl,
          subject: meetingSubtype === "MATCH_CALL"
            ? `Match Call with ${config.user.name || config.user.email}`
            : meetingSubtype === "DOCTOR_CONSULTATION"
              ? `Doctor Call with ${config.user.name || config.user.email}`
              : config.defaultSubject || `Meeting with ${config.user.name || config.user.email}`,
          meetingSubtype,
          attendeeEmails: allAttendeeEmails,
          attendeeName: body.name,
          attendeeDetails: body.attendeeDetails || undefined,
          bookerTimezone: body.timezone || null,
          notes: body.notes || null,
        },
        include: {
          providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } } } },
          parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
        },
      });
    });

    this.notifications.sendBookingSubmitted(booking).catch(() => {});
    void emitBookingLifecycleEvent(booking.id, "SCHEDULED", "parent");
    this.emitBookingEvent("booking_created", booking, booking.parentUserId || undefined);

    let parentAccountMembers: { id: string; name: string | null; email: string }[] = [];
    if (booking.parentUser) {
      const pu = await this.prisma.user.findUnique({
        where: { id: booking.parentUser.id },
        select: { parentAccountId: true },
      });
      if (pu?.parentAccountId) {
        parentAccountMembers = await this.prisma.user.findMany({
          where: {
            parentAccountId: pu.parentAccountId,
            id: { not: booking.parentUser.id },
          },
          select: { id: true, name: true, email: true },
        });
      }
    }

    // Create 3-way chat session when booking originates from AI concierge
    // consultation. The cost-sheet auto-draft is chained AFTER session
    // creation: it targets the parent+provider's most recently updated
    // session, and firing it concurrently made the draft card land on the
    // Eva chat (a race - the consultation thread didn't exist yet). The
    // journey then continued in the thread while the draft sat orphaned in
    // the Eva session, leaving a permanently stale Home work-queue item.
    if (body.aiSessionId && booking.parentUser) {
      this.createConsultationChatSession(body, booking)
        .catch((e) => this.logger.error(`Failed to create consultation chat session: ${e.message}`))
        .finally(() => this.fireCostSheetAutoDraft(booking.id));
    } else {
      // The provider's own /book/:slug link carries no aiSessionId, so it never
      // reaches createConsultationChatSession. Attach it to the thread the
      // parent already has with this provider (the service explains why it
      // never creates one).
      this.autoReply.attachDirectBookingToThread(booking)
        .then(async (sessionId) => {
          if (!sessionId || !booking.parentUser) return;
          const providerId = booking.providerUser?.providerId;
          if (!providerId) return;
          const parent = await this.prisma.user.findUnique({
            where: { id: booking.parentUser.id },
            select: { parentAccountId: true },
          });
          const session = await this.prisma.aiChatSession.findUnique({
            where: { id: sessionId },
            select: { subjectType: true },
          });
          await this.parentBriefing.sendForBooking({
            providerId,
            providerName: booking.providerUser?.provider?.name || null,
            providerTypeId: await this.autoReply.resolveProviderTypeId({
              providerId,
              subjectType: session?.subjectType || null,
            }),
            sessionId,
            parentUserId: booking.parentUser.id,
            parentAccountId: parent?.parentAccountId || null,
            bookingId: booking.id,
          });
        })
        .catch((e) => this.logger.warn(`[direct-booking] Thread attach failed: ${e.message}`))
        .finally(() => this.fireCostSheetAutoDraft(booking.id));
    }

    return { ...booking, parentAccountMembers };
  }


  @Get("booking/:token")
  async getBookingDetails(@Param("token") token: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { publicToken: token },
      include: {
        providerUser: {
          select: {
            id: true, name: true, email: true, photoUrl: true, providerId: true, dailyRoomUrl: true,
            provider: { select: { id: true, name: true, logoUrl: true } },
          },
        },
        parentUser: {
          select: {
            id: true, name: true, email: true, photoUrl: true,
            parentAccountId: true,
          },
        },
        rescheduledFrom: { select: { id: true, scheduledAt: true } },
      },
    });

    if (!booking) throw new NotFoundException("Booking not found");

    let parentAccountMembers: { id: string; name: string | null; email: string }[] = [];
    if (booking.parentUser?.parentAccountId) {
      const members = await this.prisma.user.findMany({
        where: {
          parentAccountId: booking.parentUser.parentAccountId,
          id: { not: booking.parentUser.id },
        },
        select: { id: true, name: true, email: true },
      });
      parentAccountMembers = members;
    }

    return { ...booking, parentAccountMembers };
  }

  @Post("booking/:token/reschedule-public")
  async reschedulePublic(@Req() req: Request, @Param("token") token: string, @Body() body: any) {
    const original = await this.prisma.booking.findUnique({ where: { publicToken: token } });
    if (!original) throw new NotFoundException("Booking not found");
    if (original.status === "CANCELLED" || original.status === "RESCHEDULED") {
      throw new BadRequestException("Cannot reschedule a cancelled or already rescheduled booking");
    }

    if (!body.scheduledAt) {
      throw new BadRequestException("scheduledAt is required");
    }

    // If the rescheduling user is the booking host (provider/admin), auto-confirm the new booking.
    // No need for the host to then confirm their own reschedule request.
    const requestingUser = (req as any).user;
    const hostIsRescheduling = requestingUser && requestingUser.id === original.providerUserId;

    await this.prisma.booking.update({
      where: { publicToken: token },
      data: { status: "RESCHEDULED", cancelledAt: new Date() },
    });

    const newBooking = await this.prisma.booking.create({
      data: {
        providerUserId: original.providerUserId,
        parentUserId: original.parentUserId,
        scheduledAt: new Date(body.scheduledAt),
        duration: original.duration,
        meetingType: original.meetingType,
        status: hostIsRescheduling ? "CONFIRMED" : "PENDING",
        providerConfirmed: hostIsRescheduling ? true : false,
        parentConfirmed: false,
        meetingUrl: original.meetingUrl,
        subject: original.subject,
        notes: original.notes,
        attendeeEmails: original.attendeeEmails,
        attendeeName: original.attendeeName,
        invitedByUserId: original.invitedByUserId,
        rescheduledFromId: original.id,
        bookerTimezone: body.bookerTimezone || original.bookerTimezone,
      },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } } } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });
    void emitBookingLifecycleEvent(newBooking.id, "RESCHEDULED", hostIsRescheduling ? "provider" : "parent");

    if (hostIsRescheduling) {
      // Host rescheduled - send confirmation email directly (no approval needed)
      this.notifications.sendBookingConfirmation(newBooking).catch(() => {});
    } else {
      this.notifications.sendBookingRescheduled(original, newBooking, body.message || "").catch(() => {});
    }
    this.deleteGoogleCalendarEvent(original).catch(() => {});
    this.deleteParentGoogleCalendarEvent(original).catch(() => {});
    this.deleteOutlookCalendarEvent(original).catch(() => {});
    this.deleteParentOutlookCalendarEvent(original).catch(() => {});
    this.syncBookingToGoogleCalendar(newBooking).catch(() => {});
    this.syncBookingToParentGoogleCalendar(newBooking).catch(() => {});
    this.syncBookingToOutlookCalendar(newBooking).catch(() => {});
    this.syncBookingToParentOutlookCalendar(newBooking).catch(() => {});
    this.emitBookingEvent("booking_rescheduled", newBooking, newBooking.parentUserId || undefined);
    return newBooking;
  }

  @Post("booking/:token/cancel-public")
  async cancelPublic(@Param("token") token: string) {
    const booking = await this.prisma.booking.findUnique({ where: { publicToken: token } });
    if (!booking) throw new NotFoundException("Booking not found");
    if (booking.status === "CANCELLED") {
      throw new BadRequestException("Booking is already cancelled");
    }

    const updated = await this.prisma.booking.update({
      where: { publicToken: token },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledByRole: "parent" },
    });
    void emitBookingLifecycleEvent(updated.id, "CANCELED", "parent");

    this.notifications.sendBookingCancellation(updated).catch(() => {});
    this.deleteGoogleCalendarEvent(updated).catch(() => {});
    this.deleteParentGoogleCalendarEvent(updated).catch(() => {});
    this.deleteOutlookCalendarEvent(updated).catch(() => {});
    this.deleteParentOutlookCalendarEvent(updated).catch(() => {});
    this.emitBookingEvent("booking_cancelled", updated, updated.parentUserId || undefined);
    return updated;
  }

  @Get("booking/:token/info")
  async getBookingByToken(@Param("token") token: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { confirmToken: token },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } } } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });
    if (!booking) throw new NotFoundException("Booking not found");
    return { booking };
  }

  @Get("booking/:token/confirm")
  async confirmBooking(@Param("token") token: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { confirmToken: token },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } } } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });
    if (!booking) throw new NotFoundException("Booking not found");
    if (booking.status === "CONFIRMED") return { message: "Already confirmed", booking };
    if (booking.status === "CANCELLED" || booking.status === "RESCHEDULED") {
      throw new BadRequestException("This booking has been cancelled or rescheduled");
    }

    const updated = await this.prisma.booking.update({
      where: { id: booking.id },
      data: {
        status: "CONFIRMED",
        providerConfirmed: true,
        parentConfirmed: true,
      },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } } } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });

    void emitBookingLifecycleEvent(updated.id, "CONFIRMED", "provider");
    this.notifications.sendBookingConfirmation(updated).catch(() => {});
    this.syncBookingToGoogleCalendar(updated).catch(() => {});
    this.syncBookingToParentGoogleCalendar(updated).catch(() => {});
    this.syncBookingToOutlookCalendar(updated).catch(() => {});
    this.syncBookingToParentOutlookCalendar(updated).catch(() => {});
    this.emitBookingEvent("booking_confirmed", updated, updated.providerUserId);
    return { message: "Booking confirmed", booking: updated };
  }

  @Get("booking/:token/decline")
  async declineBooking(@Param("token") token: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { confirmToken: token },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } }, scheduleConfig: { select: { bookingPageSlug: true } } } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });
    if (!booking) throw new NotFoundException("Booking not found");
    if (booking.status === "CANCELLED") return { message: "Already declined", booking };
    if (booking.status === "RESCHEDULED") {
      throw new BadRequestException("This booking has been rescheduled");
    }

    const updated = await this.prisma.booking.update({
      where: { id: booking.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledByRole: "provider" },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } }, scheduleConfig: { select: { bookingPageSlug: true } } } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });

    this.notifications.sendBookingDeclinedToParent(updated).catch(() => {});
    this.deleteGoogleCalendarEvent(updated).catch(() => {});
    this.deleteParentGoogleCalendarEvent(updated).catch(() => {});
    this.deleteOutlookCalendarEvent(updated).catch(() => {});
    this.deleteParentOutlookCalendarEvent(updated).catch(() => {});
    this.emitBookingEvent("booking_declined", updated, updated.providerUserId);
    return { message: "Booking declined", booking: updated };
  }

  @Post("booking/:token/suggest-time")
  async suggestNewTime(@Param("token") token: string, @Body() body: any) {
    const original = await this.prisma.booking.findFirst({
      where: { confirmToken: token },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } } } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });
    if (!original) throw new NotFoundException("Booking not found");
    if (original.status === "CANCELLED" || original.status === "RESCHEDULED") {
      throw new BadRequestException("This booking has already been cancelled or rescheduled");
    }
    if (!body.scheduledAt) throw new BadRequestException("scheduledAt is required");

    await this.prisma.booking.update({
      where: { id: original.id },
      data: { status: "RESCHEDULED", cancelledAt: new Date() },
    });

    const suggested = await this.prisma.booking.create({
      data: {
        providerUserId: original.providerUserId,
        parentUserId: original.parentUserId,
        scheduledAt: new Date(body.scheduledAt),
        duration: body.duration || original.duration,
        meetingType: original.meetingType,
        status: "PENDING",
        parentConfirmed: false,
        providerConfirmed: true,
        confirmToken: randomUUID(),
        meetingUrl: original.meetingUrl,
        subject: original.subject,
        notes: original.notes,
        attendeeEmails: original.attendeeEmails,
        attendeeName: original.attendeeName,
        invitedByUserId: original.providerUserId,
        rescheduledFromId: original.id,
        bookerTimezone: original.bookerTimezone,
      },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } } } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });
    void emitBookingLifecycleEvent(suggested.id, "RESCHEDULED", "provider", { suggestedTime: true });

    this.notifications.sendNewTimeSuggested(original, suggested).catch(() => {});
    this.deleteGoogleCalendarEvent(original).catch(() => {});
    this.deleteParentGoogleCalendarEvent(original).catch(() => {});
    this.deleteOutlookCalendarEvent(original).catch(() => {});
    this.deleteParentOutlookCalendarEvent(original).catch(() => {});
    this.emitBookingEvent("booking_new_time", suggested, suggested.providerUserId);
    return { message: "New time suggested", booking: suggested };
  }

  @Get("providers/:providerId/booking-members")
  async getProviderBookingMembers(@Param("providerId") providerId: string) {
    const users = await this.prisma.user.findMany({
      where: { providerId },
      select: {
        id: true,
        name: true,
        photoUrl: true,
        scheduleConfig: {
          select: { bookingPageSlug: true, meetingDuration: true },
        },
      },
    });

    return users
      .filter((u) => u.scheduleConfig?.bookingPageSlug)
      .map((u) => ({
        id: u.id,
        name: u.name,
        photoUrl: u.photoUrl,
        slug: u.scheduleConfig!.bookingPageSlug,
        meetingDuration: u.scheduleConfig!.meetingDuration,
      }));
  }

  @Get("bookable-providers")
  @UseGuards(SessionOrJwtGuard)
  async getBookableProviders() {
    const users = await this.prisma.user.findMany({
      where: {
        isDisabled: false,
        scheduleConfig: { bookingPageSlug: { not: null } },
        OR: [
          { providerId: { not: null } },
          { roles: { has: "GOSTORK_ADMIN" } },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        photoUrl: true,
        roles: true,
        providerId: true,
        provider: { select: { id: true, name: true } },
        scheduleConfig: { select: { bookingPageSlug: true, meetingDuration: true } },
      },
    });

    return users
      .filter((u: any) => u.scheduleConfig?.bookingPageSlug)
      .map((u: any) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        photoUrl: u.photoUrl,
        slug: u.scheduleConfig!.bookingPageSlug,
        meetingDuration: u.scheduleConfig!.meetingDuration,
        providerName: u.provider?.name || null,
        isGoStorkMember: u.roles?.includes("GOSTORK_ADMIN") || false,
      }));
  }

  @Get("overrides")
  @UseGuards(SessionOrJwtGuard)
  async getOverrides(@Req() req: Request) {
    const user = req.user as any;
    return this.prisma.availabilityOverride.findMany({
      where: { userId: user.id },
      orderBy: { date: "asc" },
    });
  }

  @Post("overrides")
  @UseGuards(SessionOrJwtGuard)
  async upsertOverride(@Req() req: Request, @Body() body: any) {
    const user = req.user as any;
    if (!body.date) throw new BadRequestException("date is required");

    const date = new Date(body.date + "T00:00:00");
    if (isNaN(date.getTime())) throw new BadRequestException("Invalid date");

    if (body.isAvailable && body.slots) {
      for (const s of body.slots) {
        if (!s.startTime || !s.endTime) throw new BadRequestException("Each slot needs startTime and endTime");
      }
    }

    return this.prisma.availabilityOverride.upsert({
      where: { userId_date: { userId: user.id, date } },
      create: {
        userId: user.id,
        date,
        isAvailable: body.isAvailable !== false,
        slots: body.isAvailable !== false ? (body.slots || null) : null,
        label: body.label || null,
      },
      update: {
        isAvailable: body.isAvailable !== false,
        slots: body.isAvailable !== false ? (body.slots || null) : null,
        label: body.label || null,
      },
    });
  }

  @Delete("overrides/:id")
  @UseGuards(SessionOrJwtGuard)
  async deleteOverride(@Req() req: Request, @Param("id") id: string) {
    const user = req.user as any;
    const override = await this.prisma.availabilityOverride.findUnique({ where: { id } });
    if (!override) throw new NotFoundException("Override not found");
    if (override.userId !== user.id) throw new ForbiddenException("Not authorized");
    await this.prisma.availabilityOverride.delete({ where: { id } });
    return { success: true };
  }

  @Get("event-overrides")
  @UseGuards(SessionOrJwtGuard)
  async getEventFreeOverrides(@Req() req: Request) {
    const user = req.user as any;
    return this.prisma.eventFreeOverride.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
  }

  @Post("event-overrides")
  @UseGuards(SessionOrJwtGuard)
  async createEventFreeOverride(@Req() req: Request, @Body() body: any) {
    const user = req.user as any;
    if (!body.externalEventId || !body.provider || !body.calendarId) {
      throw new BadRequestException("externalEventId, provider, and calendarId are required");
    }
    return this.prisma.eventFreeOverride.upsert({
      where: {
        userId_externalEventId_provider: {
          userId: user.id,
          externalEventId: body.externalEventId,
          provider: body.provider,
        },
      },
      create: {
        userId: user.id,
        externalEventId: body.externalEventId,
        provider: body.provider,
        calendarId: body.calendarId,
        title: body.title || null,
      },
      update: {
        calendarId: body.calendarId,
        title: body.title || null,
      },
    });
  }

  @Delete("event-overrides/:id")
  @UseGuards(SessionOrJwtGuard)
  async deleteEventFreeOverride(@Req() req: Request, @Param("id") id: string) {
    const user = req.user as any;
    const override = await this.prisma.eventFreeOverride.findUnique({ where: { id } });
    if (!override) throw new NotFoundException("Event override not found");
    if (override.userId !== user.id) throw new ForbiddenException("Not authorized");
    await this.prisma.eventFreeOverride.delete({ where: { id } });
    return { success: true };
  }

  @Get("connections")
  @UseGuards(SessionOrJwtGuard)
  async getConnections(@Req() req: Request) {
    const user = req.user as any;
    return this.prisma.calendarConnection.findMany({
      where: { userId: user.id, NOT: { calendarId: "__pending__" } },
      select: {
        id: true, provider: true, label: true, email: true, calendarId: true,
        isConflictCalendar: true, isBookingCalendar: true,
        color: true, connected: true, tokenValid: true, createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
  }

  @Post("connections")
  @UseGuards(SessionOrJwtGuard)
  async addConnection(@Req() req: Request, @Body() body: any) {
    const user = req.user as any;
    if (!body.provider) throw new BadRequestException("provider is required");

    const providerColors: Record<string, string> = {
      google: "#4285f4",
      apple: "#a3aaae",
      microsoft: "#00a4ef",
    };

    const existingBooking = await this.prisma.calendarConnection.findFirst({
      where: { userId: user.id, isBookingCalendar: true, connected: true, NOT: { calendarId: "__pending__" } },
    });

    return this.prisma.calendarConnection.create({
      data: {
        userId: user.id,
        provider: body.provider,
        label: body.label || `${body.provider.charAt(0).toUpperCase() + body.provider.slice(1)} Calendar`,
        email: body.email || null,
        color: providerColors[body.provider] || "#6b7280",
        isConflictCalendar: true,
        isBookingCalendar: !existingBooking,
        connected: true,
      },
      select: {
        id: true, provider: true, label: true, email: true,
        isConflictCalendar: true, isBookingCalendar: true,
        color: true, connected: true, createdAt: true,
      },
    });
  }

  @Patch("connections/:id")
  @UseGuards(SessionOrJwtGuard)
  async updateConnection(@Req() req: Request, @Param("id") id: string, @Body() body: any) {
    const user = req.user as any;
    const conn = await this.prisma.calendarConnection.findUnique({ where: { id } });
    if (!conn) throw new NotFoundException("Connection not found");
    if (conn.userId !== user.id) throw new ForbiddenException("Not authorized");

    if (body.isBookingCalendar === true) {
      await this.prisma.calendarConnection.updateMany({
        where: { userId: user.id, id: { not: id } },
        data: { isBookingCalendar: false },
      });
    }

    const data: any = {};
    if (body.label !== undefined) data.label = body.label;
    if (body.color !== undefined) data.color = body.color;
    if (body.isConflictCalendar !== undefined) data.isConflictCalendar = body.isConflictCalendar;
    if (body.isBookingCalendar !== undefined) data.isBookingCalendar = body.isBookingCalendar;

    return this.prisma.calendarConnection.update({
      where: { id },
      data,
      select: {
        id: true, provider: true, label: true, email: true,
        isConflictCalendar: true, isBookingCalendar: true,
        color: true, connected: true, tokenValid: true, createdAt: true,
      },
    });
  }

  @Delete("connections/:id")
  @UseGuards(SessionOrJwtGuard)
  async deleteConnection(@Req() req: Request, @Param("id") id: string) {
    const user = req.user as any;
    const conn = await this.prisma.calendarConnection.findUnique({ where: { id } });
    if (!conn) throw new NotFoundException("Connection not found");
    if (conn.userId !== user.id) throw new ForbiddenException("Not authorized");
    await this.prisma.calendarConnection.delete({ where: { id } });
    return { success: true };
  }

  @Get("google/status")
  @UseGuards(SessionOrJwtGuard)
  async getGoogleStatus(@Req() req: Request) {
    const user = req.user as any;
    const configured = this.googleCalendar.isConfigured();
    const connected = await this.googleCalendar.hasConnection(user.id);
    return { configured, connected };
  }

  @Get("google/health")
  @UseGuards(SessionOrJwtGuard)
  async checkGoogleHealth(@Req() req: Request) {
    const user = req.user as any;
    if (!this.googleCalendar.isConfigured()) {
      return { healthy: false, error: "Google OAuth is not configured" };
    }
    return this.googleCalendar.checkConnectionHealth(user.id);
  }

  private signOAuthState(payload: Record<string, any>): string {
    const secret = process.env.SESSION_SECRET || process.env.GOOGLE_CLIENT_SECRET || "fallback";
    const nonce = randomBytes(16).toString("hex");
    const data = JSON.stringify({ ...payload, nonce });
    const hmac = createHmac("sha256", secret).update(data).digest("hex");
    return Buffer.from(JSON.stringify({ data, hmac })).toString("base64url");
  }

  private verifyOAuthState(state: string): Record<string, any> | null {
    try {
      const secret = process.env.SESSION_SECRET || process.env.GOOGLE_CLIENT_SECRET || "fallback";
      const { data, hmac } = JSON.parse(Buffer.from(state, "base64url").toString());
      const expected = createHmac("sha256", secret).update(data).digest("hex");
      if (hmac !== expected) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  @Get("google/auth-url")
  @UseGuards(SessionOrJwtGuard)
  async getGoogleAuthUrl(@Req() req: Request, @Query("login_hint") loginHint?: string) {
    if (!this.googleCalendar.isConfigured()) {
      throw new BadRequestException("Google OAuth is not configured. GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required.");
    }
    const user = req.user as any;
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const redirectUri = `${protocol}://${host}/api/calendar/google/callback`;
    const state = this.signOAuthState({ userId: user.id });
    const url = this.googleCalendar.generateAuthUrl(redirectUri, state, loginHint);
    return { url };
  }

  @Get("google/callback")
  async handleGoogleCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (error) {
      return res.redirect("/account/calendar?google_error=" + encodeURIComponent(error));
    }

    if (!code || !state) {
      return res.redirect("/account/calendar?google_error=missing_params");
    }

    const stateData = this.verifyOAuthState(state);
    if (!stateData || !stateData.userId) {
      return res.redirect("/account/calendar?google_error=invalid_state");
    }
    const userId = stateData.userId;

    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const redirectUri = `${protocol}://${host}/api/calendar/google/callback`;

    try {
      const { accessToken, refreshToken, expiry, email } = await this.googleCalendar.exchangeCode(code, redirectUri);

      const existingWithEmail = email
        ? await this.prisma.calendarConnection.findFirst({
            where: { userId, provider: "google", email, NOT: { calendarId: "__pending__" } },
          })
        : null;

      if (existingWithEmail) {
        await this.prisma.calendarConnection.updateMany({
          where: { userId, provider: "google", email },
          data: { accessToken, refreshToken: refreshToken || undefined, tokenExpiry: expiry, tokenValid: true },
        });
        return res.redirect("/account/calendar?google_connected=1&mode=existing&email=" + encodeURIComponent(email));
      } else {
        await this.prisma.calendarConnection.deleteMany({
          where: { userId, provider: "google", calendarId: "__pending__", ...(email ? { email } : {}) },
        });
        await this.prisma.calendarConnection.create({
          data: {
            userId,
            provider: "google",
            label: "__pending__",
            email: email || null,
            calendarId: "__pending__",
            accessToken,
            refreshToken,
            tokenExpiry: expiry,
            isConflictCalendar: false,
            isBookingCalendar: false,
            color: "#4285f4",
            connected: true,
          },
        });
        return res.redirect("/account/calendar?google_connected=1&mode=select&email=" + encodeURIComponent(email));
      }
    } catch (e: any) {
      console.error("Google OAuth callback error:", e.message);
      return res.redirect("/account/calendar?google_error=" + encodeURIComponent(e.message || "oauth_failed"));
    }
  }

  @Get("google/calendars")
  @UseGuards(SessionOrJwtGuard)
  async getGoogleCalendars(@Req() req: Request, @Query("email") email?: string) {
    const user = req.user as any;
    try {
      return await this.googleCalendar.getCalendarList(user.id, email);
    } catch (e: any) {
      throw new BadRequestException(e.message || "Failed to fetch Google calendars");
    }
  }

  @Post("google/connect")
  @UseGuards(SessionOrJwtGuard)
  async connectGoogleCalendar(@Req() req: Request, @Body() body: any) {
    const user = req.user as any;
    const email: string | undefined = body.email;

    const sourceWhere: any = { userId: user.id, provider: "google", connected: true };
    if (email) sourceWhere.email = email;

    const sourceConn = await this.prisma.calendarConnection.findFirst({
      where: sourceWhere,
      orderBy: { createdAt: "asc" },
    });
    if (!sourceConn) {
      throw new BadRequestException("Please authenticate with Google first");
    }

    const calendarIds: string[] = body.calendarIds || (body.calendarId ? [body.calendarId] : []);
    if (calendarIds.length === 0) throw new BadRequestException("calendarIds is required");
    const conflictCalendarIds: string[] | undefined = body.conflictCalendarIds;

    const calendars = await this.googleCalendar.getCalendarList(user.id, email);
    const results: any[] = [];

    const existingBooking = await this.prisma.calendarConnection.findFirst({
      where: { userId: user.id, isBookingCalendar: true, connected: true, NOT: { calendarId: "__pending__" } },
    });
    let bookingAssigned = !!existingBooking;

    for (const calendarId of calendarIds) {
      const calendarInfo = calendars.find((c) => c.id === calendarId);
      if (!calendarInfo) continue;

      const existing = await this.prisma.calendarConnection.findFirst({
        where: { userId: user.id, provider: "google", calendarId, NOT: { calendarId: "__pending__" } },
      });
      if (existing) {
        results.push({ ...existing, alreadyConnected: true });
        continue;
      }

      const shouldConflict = conflictCalendarIds ? conflictCalendarIds.includes(calendarId) : true;
      const shouldBooking = !bookingAssigned;
      if (shouldBooking) bookingAssigned = true;

      const conn = await this.prisma.calendarConnection.create({
        data: {
          userId: user.id,
          provider: "google",
          label: calendarInfo?.summary || "Google Calendar",
          email: sourceConn.email,
          calendarId,
          accessToken: sourceConn.accessToken,
          refreshToken: sourceConn.refreshToken,
          tokenExpiry: sourceConn.tokenExpiry,
          color: calendarInfo?.backgroundColor || "#4285f4",
          isConflictCalendar: shouldConflict,
          isBookingCalendar: shouldBooking,
          connected: true,
        },
        select: {
          id: true, provider: true, label: true, email: true, calendarId: true,
          isConflictCalendar: true, isBookingCalendar: true,
          color: true, connected: true, createdAt: true,
        },
      });
      results.push(conn);
    }

    const pendingWhere: any = { userId: user.id, provider: "google", calendarId: "__pending__" };
    if (email) pendingWhere.email = email;
    await this.prisma.calendarConnection.deleteMany({ where: pendingWhere });

    return results;
  }

  @Get("google/events")
  @UseGuards(SessionOrJwtGuard)
  async getGoogleEvents(
    @Req() req: Request,
    @Query("from") from: string,
    @Query("to") to: string,
  ) {
    const user = req.user as any;

    const connections = await this.prisma.calendarConnection.findMany({
      where: { userId: user.id, provider: "google", connected: true },
    });

    if (connections.length === 0) return [];

    const allEvents: any[] = [];

    for (const conn of connections) {
      const cId = conn.calendarId || conn.email || "primary";
      try {
        const events = await this.googleCalendar.getEvents(user.id, cId, from, to);
        allEvents.push(
          ...events.map((e) => ({
            ...e,
            connectionId: conn.id,
            calendarLabel: conn.label,
            color: conn.color,
            provider: "google",
            calendarId: cId,
          }))
        );
      } catch (e: any) {
        console.error(`Failed to fetch events for ${cId}:`, e.message);
      }
    }

    return allEvents;
  }

  @Get("microsoft/status")
  @UseGuards(SessionOrJwtGuard)
  async getMicrosoftStatus(@Req() req: Request) {
    const user = req.user as any;
    const configured = this.microsoftCalendar.isConfigured();
    const connected = await this.microsoftCalendar.hasConnection(user.id);
    return { configured, connected };
  }

  @Get("microsoft/health")
  @UseGuards(SessionOrJwtGuard)
  async checkMicrosoftHealth(@Req() req: Request) {
    const user = req.user as any;
    if (!this.microsoftCalendar.isConfigured()) {
      return { healthy: false, error: "Microsoft OAuth is not configured" };
    }
    return this.microsoftCalendar.checkConnectionHealth(user.id);
  }

  @Get("microsoft/auth-url")
  @UseGuards(SessionOrJwtGuard)
  async getMicrosoftAuthUrl(@Req() req: Request, @Query("login_hint") loginHint?: string) {
    if (!this.microsoftCalendar.isConfigured()) {
      throw new BadRequestException("Microsoft OAuth is not configured. MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET are required.");
    }
    const user = req.user as any;
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const redirectUri = `${protocol}://${host}/api/calendar/microsoft/callback`;
    const state = this.signOAuthState({ userId: user.id });
    const url = this.microsoftCalendar.generateAuthUrl(redirectUri, state, loginHint);
    return { url };
  }

  @Get("microsoft/callback")
  async handleMicrosoftCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (error) {
      return res.redirect("/account/calendar?microsoft_error=" + encodeURIComponent(error));
    }

    if (!code || !state) {
      return res.redirect("/account/calendar?microsoft_error=missing_params");
    }

    const stateData = this.verifyOAuthState(state);
    if (!stateData || !stateData.userId) {
      return res.redirect("/account/calendar?microsoft_error=invalid_state");
    }
    const userId = stateData.userId;

    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const redirectUri = `${protocol}://${host}/api/calendar/microsoft/callback`;

    try {
      const { accessToken, refreshToken, expiry, email } = await this.microsoftCalendar.exchangeCode(code, redirectUri);

      const existingWithEmail = email
        ? await this.prisma.calendarConnection.findFirst({
            where: { userId, provider: "microsoft", email, NOT: { calendarId: "__pending__" } },
          })
        : null;

      if (existingWithEmail) {
        await this.prisma.calendarConnection.updateMany({
          where: { userId, provider: "microsoft", email },
          data: { accessToken, refreshToken: refreshToken || undefined, tokenExpiry: expiry, tokenValid: true },
        });
        return res.redirect("/account/calendar?microsoft_connected=1&mode=existing&email=" + encodeURIComponent(email));
      } else {
        await this.prisma.calendarConnection.deleteMany({
          where: { userId, provider: "microsoft", calendarId: "__pending__", ...(email ? { email } : {}) },
        });
        await this.prisma.calendarConnection.create({
          data: {
            userId,
            provider: "microsoft",
            label: "__pending__",
            email: email || null,
            calendarId: "__pending__",
            accessToken,
            refreshToken,
            tokenExpiry: expiry,
            isConflictCalendar: false,
            isBookingCalendar: false,
            color: "#0078d4",
            connected: true,
          },
        });
        return res.redirect("/account/calendar?microsoft_connected=1&mode=select&email=" + encodeURIComponent(email));
      }
    } catch (e: any) {
      console.error("Microsoft OAuth callback error:", e.message);
      return res.redirect("/account/calendar?microsoft_error=" + encodeURIComponent(e.message || "oauth_failed"));
    }
  }

  @Get("microsoft/calendars")
  @UseGuards(SessionOrJwtGuard)
  async getMicrosoftCalendars(@Req() req: Request, @Query("email") email?: string) {
    const user = req.user as any;
    try {
      return await this.microsoftCalendar.getCalendarList(user.id, email);
    } catch (e: any) {
      throw new BadRequestException(e.message || "Failed to fetch Microsoft calendars");
    }
  }

  @Post("microsoft/connect")
  @UseGuards(SessionOrJwtGuard)
  async connectMicrosoftCalendar(@Req() req: Request, @Body() body: any) {
    const user = req.user as any;
    const email: string | undefined = body.email;

    const sourceWhere: any = { userId: user.id, provider: "microsoft", connected: true };
    if (email) sourceWhere.email = email;

    const sourceConn = await this.prisma.calendarConnection.findFirst({
      where: sourceWhere,
      orderBy: { createdAt: "asc" },
    });
    if (!sourceConn) {
      throw new BadRequestException("Please authenticate with Microsoft first");
    }

    const calendarIds: string[] = body.calendarIds || (body.calendarId ? [body.calendarId] : []);
    if (calendarIds.length === 0) throw new BadRequestException("calendarIds is required");
    const conflictCalendarIds: string[] | undefined = body.conflictCalendarIds;

    const calendars = await this.microsoftCalendar.getCalendarList(user.id, email);
    const results: any[] = [];

    const existingBooking = await this.prisma.calendarConnection.findFirst({
      where: { userId: user.id, isBookingCalendar: true, connected: true, NOT: { calendarId: "__pending__" } },
    });
    let bookingAssigned = !!existingBooking;

    for (const calendarId of calendarIds) {
      const calendarInfo = calendars.find((c: any) => c.id === calendarId);
      if (!calendarInfo) continue;

      const existing = await this.prisma.calendarConnection.findFirst({
        where: { userId: user.id, provider: "microsoft", calendarId, NOT: { calendarId: "__pending__" } },
      });
      if (existing) {
        results.push({ ...existing, alreadyConnected: true });
        continue;
      }

      const shouldConflict = conflictCalendarIds ? conflictCalendarIds.includes(calendarId) : true;
      const shouldBooking = !bookingAssigned;
      if (shouldBooking) bookingAssigned = true;

      const conn = await this.prisma.calendarConnection.create({
        data: {
          userId: user.id,
          provider: "microsoft",
          label: calendarInfo?.summary || "Outlook Calendar",
          email: sourceConn.email,
          calendarId,
          accessToken: sourceConn.accessToken,
          refreshToken: sourceConn.refreshToken,
          tokenExpiry: sourceConn.tokenExpiry,
          color: calendarInfo?.backgroundColor || "#0078d4",
          isConflictCalendar: shouldConflict,
          isBookingCalendar: shouldBooking,
          connected: true,
        },
        select: {
          id: true, provider: true, label: true, email: true, calendarId: true,
          isConflictCalendar: true, isBookingCalendar: true,
          color: true, connected: true, createdAt: true,
        },
      });
      results.push(conn);
    }

    const pendingWhere: any = { userId: user.id, provider: "microsoft", calendarId: "__pending__" };
    if (email) pendingWhere.email = email;
    await this.prisma.calendarConnection.deleteMany({ where: pendingWhere });

    return results;
  }

  @Get("microsoft/events")
  @UseGuards(SessionOrJwtGuard)
  async getMicrosoftEvents(
    @Req() req: Request,
    @Query("from") from: string,
    @Query("to") to: string,
  ) {
    const user = req.user as any;

    const connections = await this.prisma.calendarConnection.findMany({
      where: { userId: user.id, provider: "microsoft", connected: true },
    });

    if (connections.length === 0) return [];

    const allEvents: any[] = [];

    for (const conn of connections) {
      if (!conn.calendarId || conn.calendarId === "__pending__") continue;
      try {
        const events = await this.microsoftCalendar.getEvents(user.id, conn.calendarId, from, to);
        allEvents.push(
          ...events.map((e: any) => ({
            ...e,
            connectionId: conn.id,
            calendarLabel: conn.label,
            color: conn.color,
            provider: "microsoft",
            calendarId: conn.calendarId,
          }))
        );
      } catch (e: any) {
        console.error(`Failed to fetch Microsoft events for ${conn.calendarId}:`, e.message);
      }
    }

    return allEvents;
  }

  @Post("caldav/connect")
  @UseGuards(SessionOrJwtGuard)
  async connectCaldav(@Req() req: Request, @Body() body: { provider: string; email: string; appPassword: string }) {
    const user = req.user as any;
    if (!body.provider || !body.email || !body.appPassword) {
      throw new BadRequestException("provider, email, and appPassword are required");
    }
    if (body.provider !== "apple") {
      throw new BadRequestException("provider must be 'apple'");
    }

    const valid = await this.caldavCalendar.validateCredentials(body.provider, body.email, body.appPassword);
    if (!valid) {
      throw new BadRequestException("Could not connect. Please check your email and app-specific password are correct.");
    }

    const { encrypted, iv } = encryptPassword(body.appPassword);

    const existing = await this.prisma.calendarConnection.findFirst({
      where: { userId: user.id, provider: body.provider, email: body.email, connected: true },
    });
    if (existing) {
      await this.prisma.calendarConnection.update({
        where: { id: existing.id },
        data: { encryptedPassword: encrypted, passwordIv: iv, tokenValid: true },
      });
    } else {
      await this.prisma.calendarConnection.create({
        data: {
          userId: user.id,
          provider: body.provider,
          email: body.email,
          calendarId: "__pending__",
          label: "Apple Calendar",
          encryptedPassword: encrypted,
          passwordIv: iv,
          color: "#a3aaae",
          connected: true,
          tokenValid: true,
          isConflictCalendar: true,
          isBookingCalendar: false,
        },
      });
    }

    const calendars = await this.caldavCalendar.discoverCalendars(body.provider, body.email, body.appPassword);
    return { success: true, email: body.email, calendars };
  }

  @Get("caldav/calendars/:connectionId")
  @UseGuards(SessionOrJwtGuard)
  async getCaldavCalendars(@Req() req: Request, @Param("connectionId") connectionId: string) {
    const user = req.user as any;
    const conn = await this.prisma.calendarConnection.findUnique({ where: { id: connectionId } });
    if (!conn || conn.userId !== user.id) throw new NotFoundException("Connection not found");
    const calendars = await this.caldavCalendar.discoverCalendarsForConnection(connectionId);
    return calendars;
  }

  @Post("caldav/calendars/select")
  @UseGuards(SessionOrJwtGuard)
  async selectCaldavCalendars(
    @Req() req: Request,
    @Body() body: { provider: string; email: string; calendarIds: string[]; conflictCalendarIds?: string[] },
  ) {
    const user = req.user as any;
    if (!body.provider || !body.email || !body.calendarIds?.length) {
      throw new BadRequestException("provider, email, and calendarIds are required");
    }

    const parentConn = await this.prisma.calendarConnection.findFirst({
      where: { userId: user.id, provider: body.provider, email: body.email, encryptedPassword: { not: null } },
    });
    if (!parentConn) throw new NotFoundException("No CalDAV credentials found for this account");

    const calendars = await this.caldavCalendar.discoverCalendarsForConnection(parentConn.id);
    const calMap = new Map(calendars.map(c => [c.id, c]));

    const existingBooking = await this.prisma.calendarConnection.findFirst({
      where: { userId: user.id, isBookingCalendar: true, connected: true, NOT: { calendarId: "__pending__" } },
    });
    let bookingAssigned = !!existingBooking;

    const results: any[] = [];
    for (const calId of body.calendarIds) {
      const calInfo = calMap.get(calId);
      const isConflict = body.conflictCalendarIds?.includes(calId) ?? true;
      const existing = await this.prisma.calendarConnection.findFirst({
        where: { userId: user.id, provider: body.provider, calendarId: calId },
      });
      if (existing) {
        const updated = await this.prisma.calendarConnection.update({
          where: { id: existing.id },
          data: { connected: true, tokenValid: true, isConflictCalendar: isConflict, label: calInfo?.name || existing.label },
          select: { id: true, provider: true, label: true, email: true, calendarId: true, isConflictCalendar: true, isBookingCalendar: true, color: true, connected: true, tokenValid: true, createdAt: true },
        });
        results.push(updated);
      } else {
        const shouldBooking = !bookingAssigned;
        if (shouldBooking) bookingAssigned = true;

        const created = await this.prisma.calendarConnection.create({
          data: {
            userId: user.id,
            provider: body.provider,
            email: body.email,
            calendarId: calId,
            label: calInfo?.name || "Apple Calendar",
            encryptedPassword: parentConn.encryptedPassword,
            passwordIv: parentConn.passwordIv,
            color: calInfo?.color || "#a3aaae",
            connected: true,
            tokenValid: true,
            isConflictCalendar: isConflict,
            isBookingCalendar: shouldBooking,
          },
          select: { id: true, provider: true, label: true, email: true, calendarId: true, isConflictCalendar: true, isBookingCalendar: true, color: true, connected: true, tokenValid: true, createdAt: true },
        });
        results.push(created);
      }
    }

    await this.prisma.calendarConnection.deleteMany({
      where: { userId: user.id, provider: body.provider, email: body.email, calendarId: "__pending__" },
    });

    return results;
  }

  @Get("caldav/events")
  @UseGuards(SessionOrJwtGuard)
  async getCaldavEvents(
    @Req() req: Request,
    @Query("from") from: string,
    @Query("to") to: string,
  ) {
    const user = req.user as any;

    const connections = await this.prisma.calendarConnection.findMany({
      where: {
        userId: user.id,
        provider: "apple",
        connected: true,
        NOT: { calendarId: "__pending__" },
      },
    });

    if (connections.length === 0) return [];

    const allEvents: any[] = [];

    for (const conn of connections) {
      if (!conn.calendarId) continue;
      try {
        const events = await this.caldavCalendar.getEvents(user.id, conn.calendarId, from, to);
        allEvents.push(
          ...events.map((e: any) => ({
            ...e,
            connectionId: conn.id,
            calendarLabel: conn.label,
            color: conn.color,
            provider: conn.provider,
            calendarId: conn.calendarId,
          }))
        );
      } catch (e: any) {
        console.error(`Failed to fetch CalDAV events for ${conn.calendarId}:`, e.message);
      }
    }

    return allEvents;
  }

  private async getBookingCalendarConnection(userId: string) {
    let conn = await this.prisma.calendarConnection.findFirst({
      where: { userId, provider: "google", connected: true, isBookingCalendar: true },
    });
    if (!conn) {
      conn = await this.prisma.calendarConnection.findFirst({
        where: { userId, provider: "google", connected: true },
        orderBy: { createdAt: "asc" },
      });
    }
    return conn;
  }

  private async getMicrosoftBookingCalendarConnection(userId: string) {
    const conn = await this.prisma.calendarConnection.findFirst({
      where: { userId, provider: "microsoft", connected: true, isBookingCalendar: true },
    });
    return conn;
  }

  private async syncBookingToGoogleCalendar(booking: any) {
    try {
      const googleConn = await this.getBookingCalendarConnection(booking.providerUserId);
      if (!googleConn) return;

      const calendarId = googleConn.calendarId || googleConn.email || "primary";
      const startTime = new Date(booking.scheduledAt);
      const endTime = new Date(startTime.getTime() + booking.duration * 60 * 1000);

      const attendees: { email: string; displayName?: string }[] = [];
      const parentUser = booking.parentUserId ? await this.prisma.user.findUnique({
        where: { id: booking.parentUserId },
        select: { parentAccountId: true },
      }) : null;
      if (parentUser?.parentAccountId) {
        const members = await this.prisma.user.findMany({
          where: { parentAccountId: parentUser.parentAccountId, isDisabled: false },
          select: { email: true, name: true },
        });
        for (const m of members) {
          attendees.push({ email: m.email, displayName: m.name || undefined });
        }
      } else if (booking.attendeeEmails) {
        for (const email of booking.attendeeEmails) {
          attendees.push({ email, displayName: booking.attendeeName || undefined });
        }
      }

      // Internal (Daily) rooms sync as the in-app /room/:bookingId page so
      // joins go through tokens, consent, and attendance tracking - never
      // the raw daily.co URL. External links (Zoom/Meet) pass through.
      const meetingLink = booking.meetingType !== "video" ? null
        : isExternalMeetingUrl(booking.meetingUrl) ? booking.meetingUrl
        : `${getBaseUrl()}/room/${booking.id}`;

      const googleEventId = await this.googleCalendar.createEvent(
        booking.providerUserId,
        calendarId,
        {
          summary: booking.subject || `${await this.getCompanyName()} Meeting with ${booking.attendeeName || "Guest"}`,
          description: booking.notes ? `Notes: ${booking.notes}` : undefined,
          startTime,
          endTime,
          attendees,
          meetingLink: meetingLink || undefined,
          timezone: booking.bookerTimezone || "UTC",
        },
      );

      if (googleEventId) {
        await this.prisma.booking.update({
          where: { id: booking.id },
          data: { googleEventId },
        });
      }
    } catch (err: any) {
      console.error("Google Calendar sync error (create):", err.message);
      if (err.message?.includes("refresh failed") || err.message?.includes("token")) {
        await this.handleCalendarAuthFailure(booking.providerUserId);
      }
    }
  }

  private async syncBookingToParentGoogleCalendar(booking: any) {
    try {
      if (!booking.parentUserId) return;
      const memberUserIds = [booking.parentUserId];
      const parentUser = await this.prisma.user.findUnique({
        where: { id: booking.parentUserId },
        select: { parentAccountId: true },
      });
      if (parentUser?.parentAccountId) {
        const otherMembers = await this.prisma.user.findMany({
          where: { parentAccountId: parentUser.parentAccountId, id: { not: booking.parentUserId }, isDisabled: false },
          select: { id: true },
        });
        memberUserIds.push(...otherMembers.map(m => m.id));
      }

      const existingMap: Record<string, string> = booking.parentGoogleEventId ? (() => {
        try { return JSON.parse(booking.parentGoogleEventId); } catch { return { [booking.parentUserId]: booking.parentGoogleEventId }; }
      })() : {};

      const providerName = booking.providerUser?.name || booking.providerUser?.provider?.name || "Provider";
      const startTime = new Date(booking.scheduledAt);
      const endTime = new Date(startTime.getTime() + booking.duration * 60 * 1000);

      // Same rule as the provider-side sync: internal rooms surface as the
      // in-app /room/:bookingId page, external links pass through.
      const parentMeetingLink = booking.meetingType !== "video" ? null
        : isExternalMeetingUrl(booking.meetingUrl) ? booking.meetingUrl
        : `${getBaseUrl()}/room/${booking.id}`;

      for (const memberId of memberUserIds) {
        try {
          const conn = await this.prisma.calendarConnection.findFirst({
            where: { userId: memberId, provider: "google", connected: true, isBookingCalendar: true },
          });
          if (!conn) continue;
          const calendarId = conn.calendarId || conn.email || "primary";
          const parentAttendees: { email: string; displayName?: string }[] = [];
          if (booking.providerUser?.email) {
            parentAttendees.push({ email: booking.providerUser.email, displayName: providerName });
          }
          if (parentUser?.parentAccountId) {
            const allMembers = await this.prisma.user.findMany({
              where: { parentAccountId: parentUser.parentAccountId, id: { not: memberId }, isDisabled: false },
              select: { email: true, name: true },
            });
            for (const m of allMembers) {
              parentAttendees.push({ email: m.email, displayName: m.name || undefined });
            }
          }

          const eventId = await this.googleCalendar.createEvent(memberId, calendarId, {
            summary: booking.subject || `${await this.getCompanyName()} Meeting with ${providerName}`,
            description: booking.notes ? `Notes: ${booking.notes}` : undefined,
            startTime, endTime,
            attendees: parentAttendees,
            meetingLink: parentMeetingLink || undefined,
            timezone: booking.bookerTimezone || "UTC",
          });
          if (eventId) existingMap[memberId] = eventId;
        } catch (err: any) {
          console.error(`Parent calendar sync error for member ${memberId}:`, err.message);
          if (err.message?.includes("refresh failed") || err.message?.includes("token")) {
            await this.handleCalendarAuthFailure(memberId);
          }
        }
      }

      if (Object.keys(existingMap).length > 0) {
        await this.prisma.booking.update({
          where: { id: booking.id },
          data: { parentGoogleEventId: JSON.stringify(existingMap) },
        });
      }
    } catch (err: any) {
      console.error("Parent Google Calendar sync error (create):", err.message);
    }
  }

  private async deleteParentGoogleCalendarEvent(booking: any) {
    try {
      if (!booking.parentGoogleEventId) return;
      let eventMap: Record<string, string>;
      try {
        eventMap = JSON.parse(booking.parentGoogleEventId);
      } catch {
        eventMap = booking.parentUserId ? { [booking.parentUserId]: booking.parentGoogleEventId } : {};
      }

      for (const [memberId, eventId] of Object.entries(eventMap)) {
        try {
          const conn = await this.prisma.calendarConnection.findFirst({
            where: { userId: memberId, provider: "google", connected: true, isBookingCalendar: true },
          });
          if (!conn) continue;
          const calendarId = conn.calendarId || conn.email || "primary";
          await this.googleCalendar.deleteEvent(memberId, calendarId, eventId);
        } catch (err: any) {
          console.error(`Parent calendar sync error (delete) for member ${memberId}:`, err.message);
          if (err.message?.includes("refresh failed") || err.message?.includes("token")) {
            await this.handleCalendarAuthFailure(memberId);
          }
        }
      }
    } catch (err: any) {
      console.error("Parent Google Calendar sync error (delete):", err.message);
    }
  }

  private async deleteGoogleCalendarEvent(booking: any) {
    try {
      if (!booking.googleEventId) return;
      const googleConn = await this.getBookingCalendarConnection(booking.providerUserId);
      if (!googleConn) return;

      const calendarId = googleConn.calendarId || googleConn.email || "primary";
      await this.googleCalendar.deleteEvent(booking.providerUserId, calendarId, booking.googleEventId);
    } catch (err: any) {
      console.error("Google Calendar sync error (delete):", err.message);
      if (err.message?.includes("refresh failed") || err.message?.includes("token")) {
        await this.handleCalendarAuthFailure(booking.providerUserId);
      }
    }
  }

  private async updateGoogleCalendarEvent(booking: any, newScheduledAt: Date) {
    try {
      if (!booking.googleEventId) return;
      const googleConn = await this.getBookingCalendarConnection(booking.providerUserId);
      if (!googleConn) return;

      const calendarId = googleConn.calendarId || googleConn.email || "primary";
      const endTime = new Date(newScheduledAt.getTime() + booking.duration * 60 * 1000);
      await this.googleCalendar.updateEvent(
        booking.providerUserId,
        calendarId,
        booking.googleEventId,
        {
          startTime: newScheduledAt,
          endTime,
          timezone: booking.bookerTimezone || "UTC",
        },
      );
    } catch (err: any) {
      console.error("Google Calendar sync error (update):", err.message);
      if (err.message?.includes("refresh failed") || err.message?.includes("token")) {
        await this.handleCalendarAuthFailure(booking.providerUserId);
      }
    }
  }

  private async syncBookingToOutlookCalendar(booking: any) {
    try {
      const outlookConn = await this.getMicrosoftBookingCalendarConnection(booking.providerUserId);
      if (!outlookConn || !outlookConn.calendarId) return;

      const calendarId = outlookConn.calendarId;
      const startTime = new Date(booking.scheduledAt);
      const endTime = new Date(startTime.getTime() + booking.duration * 60 * 1000);

      const attendees: { email: string; displayName?: string }[] = [];
      const parentUser = booking.parentUserId ? await this.prisma.user.findUnique({
        where: { id: booking.parentUserId },
        select: { parentAccountId: true },
      }) : null;
      if (parentUser?.parentAccountId) {
        const members = await this.prisma.user.findMany({
          where: { parentAccountId: parentUser.parentAccountId, isDisabled: false },
          select: { email: true, name: true },
        });
        for (const m of members) {
          attendees.push({ email: m.email, displayName: m.name || undefined });
        }
      } else if (booking.attendeeEmails) {
        for (const email of booking.attendeeEmails) {
          attendees.push({ email, displayName: booking.attendeeName || undefined });
        }
      }

      // Internal (Daily) rooms sync as the in-app /room/:bookingId page so
      // joins go through tokens, consent, and attendance tracking - never
      // the raw daily.co URL. External links (Zoom/Meet) pass through.
      const meetingLink = booking.meetingType !== "video" ? null
        : isExternalMeetingUrl(booking.meetingUrl) ? booking.meetingUrl
        : `${getBaseUrl()}/room/${booking.id}`;

      const outlookEventId = await this.microsoftCalendar.createEvent(
        booking.providerUserId,
        calendarId,
        {
          summary: booking.subject || `${await this.getCompanyName()} Meeting with ${booking.attendeeName || "Guest"}`,
          description: booking.notes ? `Notes: ${booking.notes}` : undefined,
          startTime,
          endTime,
          attendees,
          meetingLink: meetingLink || undefined,
          timezone: booking.bookerTimezone || "UTC",
        },
      );

      if (outlookEventId) {
        await this.prisma.booking.update({
          where: { id: booking.id },
          data: { outlookEventId },
        });
      }
    } catch (err: any) {
      console.error("Outlook Calendar sync error (create):", err.message);
      if (err.message?.includes("refresh failed") || err.message?.includes("token")) {
        await this.handleCalendarAuthFailure(booking.providerUserId, "microsoft");
      }
    }
  }

  private async syncBookingToParentOutlookCalendar(booking: any) {
    try {
      if (!booking.parentUserId) return;
      const memberUserIds = [booking.parentUserId];
      const parentUser = await this.prisma.user.findUnique({
        where: { id: booking.parentUserId },
        select: { parentAccountId: true },
      });
      if (parentUser?.parentAccountId) {
        const otherMembers = await this.prisma.user.findMany({
          where: { parentAccountId: parentUser.parentAccountId, id: { not: booking.parentUserId }, isDisabled: false },
          select: { id: true },
        });
        memberUserIds.push(...otherMembers.map(m => m.id));
      }

      const existingMap: Record<string, string> = booking.parentOutlookEventId ? (() => {
        try { return JSON.parse(booking.parentOutlookEventId); } catch { return { [booking.parentUserId]: booking.parentOutlookEventId }; }
      })() : {};

      const providerName = booking.providerUser?.name || booking.providerUser?.provider?.name || "Provider";
      const startTime = new Date(booking.scheduledAt);
      const endTime = new Date(startTime.getTime() + booking.duration * 60 * 1000);

      // Same rule as the provider-side sync: internal rooms surface as the
      // in-app /room/:bookingId page, external links pass through.
      const parentMeetingLink = booking.meetingType !== "video" ? null
        : isExternalMeetingUrl(booking.meetingUrl) ? booking.meetingUrl
        : `${getBaseUrl()}/room/${booking.id}`;

      for (const memberId of memberUserIds) {
        try {
          const conn = await this.prisma.calendarConnection.findFirst({
            where: { userId: memberId, provider: "microsoft", connected: true, isBookingCalendar: true },
          });
          if (!conn || !conn.calendarId) continue;
          const calendarId = conn.calendarId;
          const parentAttendees: { email: string; displayName?: string }[] = [];
          if (booking.providerUser?.email) {
            parentAttendees.push({ email: booking.providerUser.email, displayName: providerName });
          }
          if (parentUser?.parentAccountId) {
            const allMembers = await this.prisma.user.findMany({
              where: { parentAccountId: parentUser.parentAccountId, id: { not: memberId }, isDisabled: false },
              select: { email: true, name: true },
            });
            for (const m of allMembers) {
              parentAttendees.push({ email: m.email, displayName: m.name || undefined });
            }
          }

          const eventId = await this.microsoftCalendar.createEvent(memberId, calendarId, {
            summary: booking.subject || `${await this.getCompanyName()} Meeting with ${providerName}`,
            description: booking.notes ? `Notes: ${booking.notes}` : undefined,
            startTime, endTime,
            attendees: parentAttendees,
            meetingLink: parentMeetingLink || undefined,
            timezone: booking.bookerTimezone || "UTC",
          });
          if (eventId) existingMap[memberId] = eventId;
        } catch (err: any) {
          console.error(`Parent Outlook calendar sync error for member ${memberId}:`, err.message);
          if (err.message?.includes("refresh failed") || err.message?.includes("token")) {
            await this.handleCalendarAuthFailure(memberId, "microsoft");
          }
        }
      }

      if (Object.keys(existingMap).length > 0) {
        await this.prisma.booking.update({
          where: { id: booking.id },
          data: { parentOutlookEventId: JSON.stringify(existingMap) },
        });
      }
    } catch (err: any) {
      console.error("Parent Outlook Calendar sync error (create):", err.message);
    }
  }

  private async deleteParentOutlookCalendarEvent(booking: any) {
    try {
      if (!booking.parentOutlookEventId) return;
      let eventMap: Record<string, string>;
      try {
        eventMap = JSON.parse(booking.parentOutlookEventId);
      } catch {
        eventMap = booking.parentUserId ? { [booking.parentUserId]: booking.parentOutlookEventId } : {};
      }

      for (const [memberId, eventId] of Object.entries(eventMap)) {
        try {
          const conn = await this.prisma.calendarConnection.findFirst({
            where: { userId: memberId, provider: "microsoft", connected: true, isBookingCalendar: true },
          });
          if (!conn || !conn.calendarId) continue;
          await this.microsoftCalendar.deleteEvent(memberId, conn.calendarId, eventId);
        } catch (err: any) {
          console.error(`Parent Outlook calendar sync error (delete) for member ${memberId}:`, err.message);
          if (err.message?.includes("refresh failed") || err.message?.includes("token")) {
            await this.handleCalendarAuthFailure(memberId, "microsoft");
          }
        }
      }
    } catch (err: any) {
      console.error("Parent Outlook Calendar sync error (delete):", err.message);
    }
  }

  private async deleteOutlookCalendarEvent(booking: any) {
    try {
      if (!booking.outlookEventId) return;
      const outlookConn = await this.getMicrosoftBookingCalendarConnection(booking.providerUserId);
      if (!outlookConn || !outlookConn.calendarId) return;

      await this.microsoftCalendar.deleteEvent(booking.providerUserId, outlookConn.calendarId, booking.outlookEventId);
    } catch (err: any) {
      console.error("Outlook Calendar sync error (delete):", err.message);
      if (err.message?.includes("refresh failed") || err.message?.includes("token")) {
        await this.handleCalendarAuthFailure(booking.providerUserId, "microsoft");
      }
    }
  }

  private async updateOutlookCalendarEvent(booking: any, newScheduledAt: Date) {
    try {
      if (!booking.outlookEventId) return;
      const outlookConn = await this.getMicrosoftBookingCalendarConnection(booking.providerUserId);
      if (!outlookConn || !outlookConn.calendarId) return;

      const endTime = new Date(newScheduledAt.getTime() + booking.duration * 60 * 1000);
      await this.microsoftCalendar.updateEvent(
        booking.providerUserId,
        outlookConn.calendarId,
        booking.outlookEventId,
        {
          startTime: newScheduledAt,
          endTime,
          timezone: booking.bookerTimezone || "UTC",
        },
      );
    } catch (err: any) {
      console.error("Outlook Calendar sync error (update):", err.message);
      if (err.message?.includes("refresh failed") || err.message?.includes("token")) {
        await this.handleCalendarAuthFailure(booking.providerUserId, "microsoft");
      }
    }
  }

  private async handleCalendarAuthFailure(userId: string, provider: string = "google") {
    try {
      // Dedup: skip if a reconnection alert was already sent in the last 24 hours
      const recentAlert = await this.prisma.notification.findFirst({
        where: {
          userId,
          channel: "calendar_reconnection",
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });
      if (recentAlert) return;

      const conn = await this.prisma.calendarConnection.findFirst({
        where: { userId, provider, connected: true },
      });

      await this.prisma.calendarConnection.updateMany({
        where: { userId, provider, connected: true },
        data: { tokenValid: false },
      });
      console.warn(`${provider} Calendar connection marked unhealthy for user ${userId}`);

      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, mobileNumber: true, provider: { select: { name: true } } },
      });
      if (user) {
        this.notifications.sendCalendarReconnectionAlert({
          id: user.id,
          email: user.email,
          name: user.name,
          mobileNumber: user.mobileNumber,
          providerName: (user as any).provider?.name || null,
          calendarLabel: conn?.label || null,
          calendarEmail: conn?.email || null,
          calendarProvider: provider,
        }).catch((e) => {
          console.error("Failed to send calendar reconnection alert:", e.message);
        });
      }
    } catch (e: any) {
      console.error("handleCalendarAuthFailure error:", e.message);
    }
  }

  private async generateUniqueSlug(base: string): Promise<string> {
    let slug = slugify(base);
    let attempt = 0;
    while (true) {
      const candidate = attempt === 0 ? slug : `${slug}-${attempt}`;
      const existing = await this.prisma.scheduleConfig.findUnique({
        where: { bookingPageSlug: candidate },
      });
      if (!existing) return candidate;
      attempt++;
    }
  }

  async checkExternalCalendarDeletions() {
    const now = new Date();
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: { in: ["PENDING", "CONFIRMED"] },
        scheduledAt: { gte: now },
        OR: [
          { googleEventId: { not: null } },
          { parentGoogleEventId: { not: null } },
          { outlookEventId: { not: null } },
          { parentOutlookEventId: { not: null } },
        ],
      },
      include: {
        providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } } } },
        parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
      },
    });

    let cancelledCount = 0;
    for (const booking of bookings) {
      try {
        const deleted = await this.isBookingDeletedExternally(booking);
        if (!deleted) continue;

        const updated = await this.prisma.booking.update({
          where: { id: booking.id },
          data: { status: "CANCELLED", cancelledAt: new Date() },
          include: {
            providerUser: { select: { id: true, name: true, email: true, photoUrl: true, mobileNumber: true, providerId: true, provider: { select: { name: true } } } },
            parentUser: { select: { id: true, name: true, email: true, mobileNumber: true } },
          },
        });

        this.notifications.sendBookingCancellation(updated).catch(() => {});
        this.deleteGoogleCalendarEvent(updated).catch(() => {});
        this.deleteParentGoogleCalendarEvent(updated).catch(() => {});
        this.deleteOutlookCalendarEvent(updated).catch(() => {});
        this.deleteParentOutlookCalendarEvent(updated).catch(() => {});
        this.emitBookingEvent("booking_cancelled", updated);

        cancelledCount++;
        this.logger.log(`Booking ${booking.id} cancelled - event deleted from external calendar`);
      } catch (err: any) {
        this.logger.warn(`External sync check failed for booking ${booking.id}: ${err.message}`);
      }
    }

    if (cancelledCount > 0) {
      this.logger.log(`External calendar sync: cancelled ${cancelledCount} booking(s)`);
    }
  }

  private async isBookingDeletedExternally(booking: any): Promise<boolean> {
    if (booking.googleEventId) {
      const conn = await this.getBookingCalendarConnection(booking.providerUserId);
      if (conn) {
        const calendarId = conn.calendarId || conn.email || "primary";
        try {
          const event = await this.googleCalendar.getEvent(booking.providerUserId, calendarId, booking.googleEventId);
          if (!event || event.status === "cancelled") return true;
        } catch {
        }
      }
    }

    if (booking.parentGoogleEventId && booking.parentUserId) {
      let eventMap: Record<string, string>;
      try { eventMap = JSON.parse(booking.parentGoogleEventId); } catch { eventMap = { [booking.parentUserId]: booking.parentGoogleEventId }; }
      for (const [memberId, eventId] of Object.entries(eventMap)) {
        const conn = await this.prisma.calendarConnection.findFirst({
          where: { userId: memberId, provider: "google", connected: true, isBookingCalendar: true },
        });
        if (!conn) continue;
        const calendarId = conn.calendarId || conn.email || "primary";
        try {
          const event = await this.googleCalendar.getEvent(memberId, calendarId, eventId);
          if (!event || event.status === "cancelled") return true;
        } catch {
        }
      }
    }

    if (booking.outlookEventId) {
      const conn = await this.getMicrosoftBookingCalendarConnection(booking.providerUserId);
      if (conn?.calendarId) {
        try {
          const event = await this.microsoftCalendar.getEvent(booking.providerUserId, conn.calendarId, booking.outlookEventId);
          if (!event || event.status === "cancelled") return true;
        } catch {
        }
      }
    }

    if (booking.parentOutlookEventId && booking.parentUserId) {
      let eventMap: Record<string, string>;
      try { eventMap = JSON.parse(booking.parentOutlookEventId); } catch { eventMap = { [booking.parentUserId]: booking.parentOutlookEventId }; }
      for (const [memberId, eventId] of Object.entries(eventMap)) {
        const conn = await this.prisma.calendarConnection.findFirst({
          where: { userId: memberId, provider: "microsoft", connected: true, isBookingCalendar: true },
        });
        if (!conn?.calendarId) continue;
        try {
          const event = await this.microsoftCalendar.getEvent(memberId, conn.calendarId, eventId);
          if (!event || event.status === "cancelled") return true;
        } catch {
        }
      }
    }

    return false;
  }
}
