import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  Res,
  UseGuards,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Inject,
  RawBodyRequest,
  Logger,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Response } from "express";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { VideoService } from "./video.service";
import { NotificationService } from "../notifications/notification.service";
import { BookingEventsService } from "../calendar/booking-events.service";
import { CalendarController } from "../calendar/calendar.controller";
import { hasProviderRole } from "../../../../shared/roles";

@ApiTags("Video")
@Controller("api/video")
export class VideoController {
  private readonly logger = new Logger(VideoController.name);
  private readonly waitingNotificationSent = new Set<string>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(VideoService) private readonly videoService: VideoService,
    @Inject(NotificationService) private readonly notificationService: NotificationService,
    @Inject(BookingEventsService) private readonly bookingEvents: BookingEventsService,
    @Inject(CalendarController) private readonly calendarController: CalendarController,
  ) {}

  private async isParentAccountMember(userId: string, bookingParentUserId: string | null): Promise<boolean> {
    if (!bookingParentUserId) return false;
    if (userId === bookingParentUserId) return true;
    const [user, bookingUser] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { parentAccountId: true } }),
      this.prisma.user.findUnique({ where: { id: bookingParentUserId }, select: { parentAccountId: true } }),
    ]);
    return !!(user?.parentAccountId && bookingUser?.parentAccountId && user.parentAccountId === bookingUser.parentAccountId);
  }

  private async assertBookingAccess(userId: string, roles: string[], booking: any): Promise<void> {
    const isProvider = userId === booking.providerUserId;
    const isParent = await this.isParentAccountMember(userId, booking.parentUserId);
    const isAdmin = roles?.includes("GOSTORK_ADMIN");
    if (!isProvider && !isParent && !isAdmin) {
      throw new ForbiddenException("You are not a participant of this booking");
    }
  }

  @Post("chat-booking")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Create an ad-hoc video booking from a chat session" })
  async createChatVideoBooking(
    @Req() req: any,
    @Body() body: { sessionId: string },
  ) {
    const user = req.user;
    const { sessionId } = body;
    if (!sessionId) throw new BadRequestException("sessionId is required");

    const session = await this.prisma.aiChatSession.findUnique({
      where: { id: sessionId },
      include: {
        provider: { select: { id: true, name: true } },
      },
    });
    if (!session) throw new NotFoundException("Chat session not found");

    const isProvider = hasProviderRole(user.roles || []);
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");

    let callerIsSessionParent = session.userId === user.id;
    if (!callerIsSessionParent && user.parentAccountId) {
      const sessionOwner = await this.prisma.user.findUnique({
        where: { id: session.userId },
        select: { parentAccountId: true },
      });
      callerIsSessionParent = !!(sessionOwner?.parentAccountId && sessionOwner.parentAccountId === user.parentAccountId);
    }

    let callerIsSessionProvider = false;
    if ((isProvider || isAdmin) && session.providerId) {
      if (isAdmin) {
        callerIsSessionProvider = true;
      } else if (user.providerId === session.providerId) {
        callerIsSessionProvider = true;
      }
    }

    if (!callerIsSessionParent && !callerIsSessionProvider) {
      throw new ForbiddenException("You are not a participant of this chat session");
    }

    const callerActsAsProvider = callerIsSessionProvider && !callerIsSessionParent;

    let providerUserId: string | null = null;
    let parentUserId: string | null = null;
    let attendeeName: string | null = null;
    let attendeeEmails: string[] = [];

    if (callerActsAsProvider) {
      if (isAdmin && user.providerId !== session.providerId) {
        const actualProviderUser = await this.prisma.user.findFirst({
          where: { providerId: session.providerId || undefined },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });
        providerUserId = actualProviderUser?.id || user.id;
      } else {
        providerUserId = user.id;
      }
      parentUserId = session.userId;
      const parentUser = await this.prisma.user.findUnique({
        where: { id: session.userId },
        select: { name: true, email: true, parentAccountId: true },
      });
      attendeeName = parentUser?.name || null;
      attendeeEmails = [];
      if (parentUser?.parentAccountId) {
        const members = await this.prisma.user.findMany({
          where: { parentAccountId: parentUser.parentAccountId, isDisabled: false },
          select: { email: true },
        });
        attendeeEmails = members.map(m => m.email).filter(Boolean);
      } else if (parentUser?.email) {
        attendeeEmails = [parentUser.email];
      }
    } else {
      parentUserId = user.id;
      if (session.providerId) {
        const providerUser = await this.prisma.user.findFirst({
          where: { providerId: session.providerId },
          orderBy: { createdAt: "asc" },
          select: { id: true, name: true, email: true },
        });
        if (providerUser) {
          providerUserId = providerUser.id;
        }
      }
      if (!providerUserId) {
        throw new BadRequestException("No provider found for this session");
      }
      attendeeEmails = [];
      const parentAccount = user.parentAccountId
        ? await this.prisma.user.findMany({
            where: { parentAccountId: user.parentAccountId, isDisabled: false },
            select: { email: true, name: true },
          })
        : null;
      if (parentAccount && parentAccount.length > 0) {
        attendeeName = parentAccount.map(m => m.name).filter(Boolean).join(", ") || user.name || null;
        attendeeEmails = parentAccount.map(m => m.email).filter(Boolean);
      } else {
        attendeeName = user.name || null;
        attendeeEmails = user.email ? [user.email] : [];
      }
    }

    const room = await this.videoService.createRoom();

    const subject = `Ad-hoc Video Call${session.provider?.name ? ` - ${session.provider.name}` : ""}`;

    const booking = await this.calendarController.createBookingInternal({
      providerUserId: providerUserId!,
      parentUserId,
      scheduledAt: new Date(),
      duration: 30,
      meetingType: "video",
      meetingUrl: room.url,
      subject,
      attendeeName,
      attendeeEmails,
      invitedByUserId: user.id,
    });

    const nameParts = (user.firstName && user.lastName)
      ? [user.firstName, user.lastName]
      : (user.name || "").trim().split(/\s+/);
    const senderDisplayName = nameParts.length >= 2
      ? `${nameParts[0]} ${nameParts[nameParts.length - 1][0]}.`
      : nameParts[0] || (callerActsAsProvider ? "Provider" : "Parent");

    const senderType = callerActsAsProvider ? "provider" : "parent";
    const messageContent = callerActsAsProvider
      ? "I've started a video call - join when you're ready!"
      : "I'd like to start a video call!";

    await this.prisma.aiChatMessage.create({
      data: {
        sessionId,
        role: callerActsAsProvider ? "assistant" : "user",
        content: messageContent,
        senderType,
        senderName: senderDisplayName,
        uiCardType: "video_invite",
        uiCardData: { bookingId: booking.id },
      },
    });

    return { bookingId: booking.id };
  }

  @Post("room")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Provision a Daily.co room for the current user" })
  async createRoom(@Req() req: any) {
    const user = req.user;
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isProvider = hasProviderRole(user.roles || []);

    if (!user) {
      throw new ForbiddenException("Authentication required");
    }

    const room = await this.videoService.createRoom();

    await this.prisma.user.update({
      where: { id: user.id },
      data: { dailyRoomUrl: room.url },
    });

    return { url: room.url, name: room.name };
  }

  @Get("room/:userId")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get a user's Daily.co room URL" })
  async getRoom(@Req() req: any, @Param("userId") userId: string) {
    const currentUser = req.user;
    const isAdmin = currentUser.roles?.includes("GOSTORK_ADMIN");
    const isSelf = currentUser.id === userId;

    if (!isAdmin && !isSelf) {
      const hasBookingRelationship = await this.prisma.booking.findFirst({
        where: {
          OR: [
            { providerUserId: userId, parentUserId: currentUser.id },
            { providerUserId: currentUser.id, parentUserId: userId },
          ],
          status: { in: ["CONFIRMED", "PENDING"] },
        },
      });
      if (!hasBookingRelationship) {
        throw new ForbiddenException("You don't have access to this user's room");
      }
    }

    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { dailyRoomUrl: true },
    });

    if (!target) throw new NotFoundException("User not found");

    return { url: target.dailyRoomUrl || null };
  }

  @Post("token")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Generate a Daily.co meeting token for a booking" })
  async generateToken(@Req() req: any, @Body() body: { bookingId: string }) {
    const user = req.user;
    const { bookingId } = body;

    if (!bookingId) throw new BadRequestException("bookingId is required");

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        providerUser: { select: { id: true, name: true, dailyRoomUrl: true } },
        parentUser: { select: { id: true, name: true } },
      },
    });

    if (!booking) throw new NotFoundException("Booking not found");

    const roomUrl = booking.meetingUrl || booking.providerUser?.dailyRoomUrl;
    if (!roomUrl) {
      throw new BadRequestException("No video room configured for this booking");
    }

    const roomName = roomUrl.split("/").pop();
    if (!roomName) throw new BadRequestException("Invalid room URL");

    let isProvider = user.id === booking.providerUserId;
    if (!isProvider && user.providerId && booking.providerUser) {
      const providerUser = await this.prisma.user.findUnique({
        where: { id: booking.providerUserId },
        select: { providerId: true },
      });
      isProvider = !!(providerUser?.providerId && providerUser.providerId === user.providerId);
    }
    const isParent = await this.isParentAccountMember(user.id, booking.parentUserId);
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");

    if (!isProvider && !isParent && !isAdmin) {
      throw new ForbiddenException("You are not a participant of this booking");
    }

    const isOwner = isProvider || isAdmin;

    await this.videoService.ensurePrejoinDisabled(roomName);

    const token = await this.videoService.generateToken({
      roomName,
      userId: user.id,
      userName: user.name || user.email,
      isOwner,
      consentGiven: booking.consentGiven,
    });

    return { token, roomUrl, bookingId: booking.id };
  }

  @Patch("consent")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update consent status for a booking" })
  async updateConsent(
    @Req() req: any,
    @Body() body: { bookingId: string; consentGiven: boolean },
  ) {
    const user = req.user;
    const { bookingId, consentGiven } = body;

    if (!bookingId) throw new BadRequestException("bookingId is required");

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) throw new NotFoundException("Booking not found");

    const isAccountMember = await this.isParentAccountMember(user.id, booking.parentUserId);
    const isParticipant =
      user.id === booking.providerUserId ||
      isAccountMember ||
      user.roles?.includes("GOSTORK_ADMIN");

    if (!isParticipant) {
      throw new ForbiddenException("You are not a participant of this booking");
    }

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { consentGiven },
    });

    return { bookingId: updated.id, consentGiven: updated.consentGiven };
  }

  @Get("room-info/:bookingId")
  @ApiOperation({ summary: "Get basic booking info for the video room (public)" })
  async getRoomInfo(@Param("bookingId") bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        duration: true,
        subject: true,
        meetingType: true,
        consentGiven: true,
        providerUser: { select: { name: true, photoUrl: true, provider: { select: { name: true } } } },
      },
    });
    if (!booking) throw new NotFoundException("Booking not found");
    return booking;
  }

  @Post("guest-token")
  @ApiOperation({ summary: "Generate a Daily.co meeting token for a guest (no account required)" })
  async generateGuestToken(@Body() body: { bookingId: string; email: string; name: string }) {
    const { bookingId, email, name } = body;
    if (!bookingId || !email?.trim() || !name?.trim()) {
      throw new BadRequestException("bookingId, email, and name are required");
    }

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        providerUser: { select: { id: true, name: true, dailyRoomUrl: true } },
      },
    });

    if (!booking) throw new NotFoundException("Booking not found");

    const normalizedEmail = email.trim().toLowerCase();
    const attendeeEmails: string[] = (booking.attendeeEmails as string[]) || [];
    const isAttendee = attendeeEmails.some(e => e.toLowerCase() === normalizedEmail);
    if (!isAttendee) {
      throw new ForbiddenException("You are not an attendee of this meeting");
    }

    const existingUser = await this.prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
    if (existingUser) {
      throw new ForbiddenException("ACCOUNT_EXISTS");
    }

    const roomUrl = booking.meetingUrl || booking.providerUser?.dailyRoomUrl;
    if (!roomUrl) throw new BadRequestException("No video room configured for this booking");
    const roomName = roomUrl.split("/").pop();
    if (!roomName) throw new BadRequestException("Invalid room URL");

    await this.videoService.ensurePrejoinDisabled(roomName);

    const token = await this.videoService.generateToken({
      roomName,
      userId: `guest-${normalizedEmail}`,
      userName: name.trim(),
      isOwner: false,
      consentGiven: booking.consentGiven,
    });

    return { token, roomUrl, bookingId: booking.id, publicToken: booking.publicToken };
  }

  @Patch("guest-consent")
  @ApiOperation({ summary: "Update consent status for a booking as a guest" })
  async updateGuestConsent(@Body() body: { bookingId: string; email: string; consentGiven: boolean }) {
    const { bookingId, email, consentGiven } = body;
    if (!bookingId || !email?.trim()) throw new BadRequestException("bookingId and email are required");

    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException("Booking not found");

    const normalizedEmail = email.trim().toLowerCase();
    const attendeeEmails: string[] = (booking.attendeeEmails as string[]) || [];
    const isAttendee = attendeeEmails.some(e => e.toLowerCase() === normalizedEmail);
    if (!isAttendee) throw new ForbiddenException("You are not an attendee of this meeting");

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { consentGiven },
    });

    return { bookingId: updated.id, consentGiven: updated.consentGiven };
  }

  @Patch("call-ended")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Mark a booking as ended when a participant leaves the call" })
  async markCallEnded(@Req() req: any, @Body() body: { bookingId: string }) {
    const user = req.user;
    const { bookingId } = body;
    if (!bookingId) throw new BadRequestException("bookingId is required");

    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException("Booking not found");

    const isParticipant =
      user.id === booking.providerUserId ||
      (await this.isParentAccountMember(user.id, booking.parentUserId)) ||
      user.roles?.includes("GOSTORK_ADMIN");
    if (!isParticipant) throw new ForbiddenException("Not a participant");

    if (!booking.actualEndedAt && booking.status === "CONFIRMED") {
      await this.prisma.booking.update({
        where: { id: bookingId },
        data: { actualEndedAt: new Date() },
      });
    }

    return { success: true };
  }

  @Post("retry-recording/:bookingId")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Retry fetching a missed recording from Daily.co (admin only)" })
  async retryRecording(@Req() req: any, @Param("bookingId") bookingId: string) {
    if (!req.user.roles?.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin only");
    }

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { providerUser: { select: { id: true, dailyRoomUrl: true } } },
    });
    if (!booking) throw new NotFoundException("Booking not found");
    if (!booking.consentGiven) {
      return { found: false, message: "Recording consent was not given for this call." };
    }
    const roomUrl = booking.meetingUrl || booking.providerUser?.dailyRoomUrl;
    if (!roomUrl) {
      return { found: false, message: "No video room associated with this booking." };
    }
    const roomName = roomUrl.split("/").pop();
    if (!roomName) {
      return { found: false, message: "Could not determine room name." };
    }

    const recordings = await this.videoService.listRoomRecordings(roomName);
    if (!recordings || recordings.length === 0) {
      return { found: false, message: "No recordings found on Daily.co for this room. The recording may have expired." };
    }

    const existingRecordings = await this.prisma.recording.findMany({
      where: { bookingId },
    });
    const existingDailyIds = new Set(existingRecordings.map((r: any) => r.dailyRecordingId));

    const unprocessed = recordings
      .filter((r: any) => !existingDailyIds.has(r.id))
      .sort((a: any, b: any) => (b.started_at || 0) - (a.started_at || 0));
    if (unprocessed.length === 0) {
      return { found: false, message: "All available recordings have already been processed." };
    }

    const latest = unprocessed[0];
    let downloadUrl = latest.download_url;
    if (!downloadUrl && latest.status === "finished") {
      this.logger.log(`Retry: recording ${latest.id} has no download_url, trying access-link...`);
      downloadUrl = await this.videoService.getRecordingAccessLink(latest.id);
    }
    if (!downloadUrl) {
      return { found: true, message: "Recording found but download URL is not yet available. Please try again in a minute." };
    }

    this.logger.log(`Retrying recording ${latest.id} for booking ${bookingId}`);
    this.videoService
      .processRecordingReady(bookingId, latest.id, downloadUrl, latest.duration)
      .catch((err) => {
        this.logger.error(`Retry recording processing failed: ${err.message}`);
      });

    return { found: true, message: "Recording found - processing started.", recordingId: latest.id };
  }

  @Post("retry-transcription/:recordingId")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Retry transcription for a recording" })
  async retryTranscription(@Req() req: any, @Param("recordingId") recordingId: string) {
    const recording = await this.prisma.recording.findUnique({
      where: { id: recordingId },
    });
    if (!recording) throw new NotFoundException("Recording not found");

    const booking = await this.prisma.booking.findUnique({
      where: { id: recording.bookingId },
    });
    if (!booking) throw new NotFoundException("Booking not found");

    const isAccountMember = booking.parentUserId ? await this.prisma.user.findFirst({
      where: { id: req.user.id, parentAccountId: (await this.prisma.user.findUnique({ where: { id: booking.parentUserId }, select: { parentAccountId: true } }))?.parentAccountId || undefined },
    }) : null;

    if (booking.providerUserId !== req.user.id && booking.parentUserId !== req.user.id && !isAccountMember && !req.user.roles?.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Not authorized");
    }

    if (!recording.gcsObjectPath) {
      return { success: false, message: "No GCS path found for this recording." };
    }

    this.videoService.transcribeRecording(recording.id, recording.gcsObjectPath).catch((err) => {
      this.logger.error(`Retry transcription failed: ${err.message}`);
    });

    return { success: true, message: "Transcription retry started." };
  }

  private async notifyWaitingParty(booking: any, joinerRole: "provider" | "parent", joinerName: string) {
    const targetId = joinerRole === "provider" ? booking.parentUserId : booking.providerUserId;
    const key = `${booking.id}:${joinerRole}:${targetId || "none"}`;
    if (this.waitingNotificationSent.has(key)) return;
    this.waitingNotificationSent.add(key);
    setTimeout(() => this.waitingNotificationSent.delete(key), 30 * 60 * 1000);

    try {
      await this.notificationService.sendVideoWaitingNotification({ booking, joinerRole });
    } catch (err: any) {
      this.logger.error(`Failed to send waiting notification: ${err.message}`);
    }

    const targetUserIds: string[] = [];
    if (joinerRole === "provider" && booking.parentUserId) {
      targetUserIds.push(booking.parentUserId);
    } else if (joinerRole === "parent") {
      targetUserIds.push(booking.providerUserId);
    }
    if (targetUserIds.length > 0) {
      this.bookingEvents.emit({
        type: "video_participant_joined",
        booking: {
          id: booking.id,
          subject: booking.subject,
          status: booking.status,
          scheduledAt: booking.scheduledAt?.toISOString?.() || String(booking.scheduledAt),
          duration: booking.duration,
          attendeeName: booking.attendeeName,
          providerUserId: booking.providerUserId,
          parentUserId: booking.parentUserId,
        },
        targetUserIds,
        joinerName,
      });
    }
  }

  @Post("participant-joined")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Notify the other party that a participant has joined the call" })
  async participantJoined(@Req() req: any, @Body() body: { bookingId: string }) {
    const { bookingId } = body;
    if (!bookingId) throw new BadRequestException("bookingId is required");

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        providerUser: { include: { provider: { select: { name: true } } } },
        parentUser: true,
      },
    });
    if (!booking) return { ok: true };

    await this.assertBookingAccess(req.user.id, req.user.roles || [], booking);

    const userId = req.user.id;
    const isProviderSide = userId === booking.providerUserId;
    const joinerRole: "provider" | "parent" = isProviderSide ? "provider" : "parent";
    const joinerName = req.user.name || req.user.email || "Someone";

    await this.notifyWaitingParty(booking, joinerRole, joinerName);
    return { ok: true };
  }

  @Post("guest-joined")
  @ApiOperation({ summary: "Notify the host that a guest has joined the call (no auth required)" })
  async guestJoined(@Body() body: { bookingId: string; email: string; name: string; token: string }) {
    const { bookingId, email, name, token } = body;
    if (!bookingId || !email?.trim() || !token?.trim()) throw new BadRequestException("bookingId, email, and token are required");

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        providerUser: { include: { provider: { select: { name: true } } } },
        parentUser: true,
      },
    });
    if (!booking) return { ok: true };

    if (booking.publicToken !== token.trim()) return { ok: true };

    const normalizedEmail = email.trim().toLowerCase();
    const attendeeEmails: string[] = (booking.attendeeEmails as string[]) || [];
    const isAttendee = attendeeEmails.some(e => e.toLowerCase() === normalizedEmail);
    if (!isAttendee) return { ok: true };

    await this.notifyWaitingParty(booking, "parent", name?.trim() || email);
    return { ok: true };
  }

  @Post("webhook")
  @ApiOperation({ summary: "Daily.co webhook endpoint" })
  async handleWebhook(@Req() req: RawBodyRequest<any>) {
    const rawBody =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const signature = req.headers["x-webhook-signature"] as string | undefined;

    if (!this.videoService.verifyWebhookSignature(rawBody, signature)) {
      throw new ForbiddenException("Invalid webhook signature");
    }

    const event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const eventType = event?.event;
    const payload = event?.payload;
    const roomName = payload?.room_name;

    if (!roomName) return { ok: true };

    const providerUser = await this.prisma.user.findFirst({
      where: {
        dailyRoomUrl: { contains: roomName },
      },
      select: { id: true },
    });

    if (!providerUser) return { ok: true };

    if (eventType === "meeting.started") {
      const activeBooking = await this.findActiveBooking(providerUser.id);
      if (activeBooking) {
        await this.prisma.booking.update({
          where: { id: activeBooking.id },
          data: { actualStartedAt: new Date() },
        });
      }
    } else if (eventType === "meeting.ended") {
      const activeBooking = await this.findActiveBooking(providerUser.id);
      if (activeBooking) {
        await this.prisma.booking.update({
          where: { id: activeBooking.id },
          data: { actualEndedAt: new Date() },
        });
      }
    } else if (eventType === "recording.ready-to-download") {
      const recordingId = payload?.recording_id;
      let downloadUrl = payload?.download_url;
      const duration = payload?.duration;

      if (!downloadUrl && recordingId) {
        this.logger.log(`recording.ready-to-download missing download_url, trying access-link for ${recordingId}...`);
        downloadUrl = await this.videoService.getRecordingAccessLink(recordingId);
      }

      if (!downloadUrl) {
        this.logger.warn("recording.ready-to-download: no download_url available");
        return { ok: true };
      }

      const booking = await this.prisma.booking.findFirst({
        where: {
          providerUserId: providerUser.id,
          status: "CONFIRMED",
          consentGiven: true,
          actualStartedAt: { not: null },
        },
        orderBy: { actualStartedAt: "desc" },
      });

      if (booking) {
        const existingRecording = await this.prisma.recording.findFirst({
          where: { bookingId: booking.id, dailyRecordingId: recordingId },
        });
        if (existingRecording) {
          this.logger.warn(`Duplicate recording event for ${recordingId}, skipping`);
          return { ok: true };
        }

        this.logger.log(
          `Processing recording for booking ${booking.id} (Daily recording: ${recordingId})`,
        );
        this.videoService
          .processRecordingReady(booking.id, recordingId, downloadUrl, duration)
          .catch((err) => {
            this.logger.error(
              `Failed to process recording: ${err.message}`,
            );
          });
      } else {
        this.logger.warn(
          `No matching booking found for provider ${providerUser.id} room ${roomName}`,
        );
      }
    }

    return { ok: true };
  }

  private async findActiveBooking(providerUserId: string) {
    return this.prisma.booking.findFirst({
      where: {
        providerUserId,
        status: "CONFIRMED",
        actualEndedAt: null,
      },
      orderBy: { scheduledAt: "desc" },
    });
  }


  @Get("all-recordings")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List all past meetings with recordings/transcripts for current user" })
  async getAllRecordings(@Req() req: any) {
    const user = req.user;
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isProvider = hasProviderRole(user.roles || []);
    const isParent = user.roles?.includes("PARENT");

    const parentMemberIds: string[] = [];
    if (isParent) {
      const u = await this.prisma.user.findUnique({ where: { id: user.id }, select: { parentAccountId: true } });
      if (u?.parentAccountId) {
        const members = await this.prisma.user.findMany({
          where: { parentAccountId: u.parentAccountId },
          select: { id: true },
        });
        parentMemberIds.push(...members.map(m => m.id));
      } else {
        parentMemberIds.push(user.id);
      }
    }

    const where: any = {
      status: "CONFIRMED",
      actualEndedAt: { not: null },
    };

    if (isAdmin) {
    } else if (isProvider && isParent) {
      where.OR = [
        { providerUserId: user.id },
        { parentUserId: { in: parentMemberIds } },
      ];
    } else if (isProvider) {
      where.providerUserId = user.id;
    } else if (isParent) {
      where.parentUserId = { in: parentMemberIds };
    } else {
      where.providerUserId = user.id;
    }

    const bookings = await this.prisma.booking.findMany({
      where,
      include: {
        providerUser: { select: { id: true, name: true, email: true } },
        parentUser: { select: { id: true, name: true, email: true } },
        recordings: {
          select: {
            id: true,
            status: true,
            duration: true,
            fileSize: true,
            transcriptStatus: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { scheduledAt: "desc" },
      take: 100,
    });

    return bookings.map(b => ({
      id: b.id,
      scheduledAt: b.scheduledAt,
      duration: b.duration,
      subject: b.subject,
      consentGiven: b.consentGiven,
      actualEndedAt: b.actualEndedAt,
      meetingType: b.meetingType,
      providerUser: b.providerUser,
      parentUser: b.parentUser,
      attendeeName: b.attendeeName,
      recording: b.recordings[0] || null,
    }));
  }

  private readonly autoFetchAttempted = new Set<string>();

  @Get("recordings/:bookingId")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get recordings for a booking" })
  async getRecordings(@Req() req: any, @Param("bookingId") bookingId: string) {
    const user = req.user;

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        providerUser: { select: { id: true, name: true, email: true, dailyRoomUrl: true } },
        parentUser: { select: { id: true, name: true, email: true, parentAccountId: true } },
      },
    });

    if (!booking) throw new NotFoundException("Booking not found");
    await this.assertBookingAccess(user.id, user.roles, booking);

    let recordings = await this.prisma.recording.findMany({
      where: { bookingId },
      orderBy: { createdAt: "desc" },
    });

    if (
      recordings.length === 0 &&
      booking.consentGiven &&
      booking.actualEndedAt &&
      booking.providerUser?.dailyRoomUrl &&
      !this.autoFetchAttempted.has(bookingId)
    ) {
      const endedAgo = Date.now() - new Date(booking.actualEndedAt).getTime();
      if (endedAgo > 30_000 && endedAgo < 24 * 60 * 60 * 1000) {
        this.autoFetchAttempted.add(bookingId);

        const roomUrl = booking.providerUser.dailyRoomUrl;
        const roomName = roomUrl.split("/").pop();
        let cooldown = 5 * 60 * 1000;
        if (roomName) {
          try {
            const dailyRecordings = await this.videoService.listRoomRecordings(roomName);
            if (dailyRecordings && dailyRecordings.length > 0) {
              const existingDailyIds = new Set(recordings.map((r: any) => r.dailyRecordingId));
              const unprocessed = dailyRecordings.filter((r: any) => !existingDailyIds.has(r.id));

              if (unprocessed.length > 0) {
                const latest = unprocessed.sort((a: any, b: any) => (b.started_at || 0) - (a.started_at || 0))[0];
                this.logger.log(`Auto-fetching recording ${latest.id} from Daily.co for booking ${bookingId}`);

                let downloadUrl = latest.download_url;
                if (!downloadUrl && latest.status === "finished") {
                  this.logger.log(`Recording ${latest.id} has no download_url, trying access-link endpoint...`);
                  downloadUrl = await this.videoService.getRecordingAccessLink(latest.id);
                }

                if (downloadUrl) {
                  this.videoService
                    .processRecordingReady(bookingId, latest.id, downloadUrl, latest.duration)
                    .catch((err) => {
                      this.logger.error(`Auto-fetch recording processing failed: ${err.message}`);
                    });

                  recordings = await this.prisma.recording.findMany({
                    where: { bookingId },
                    orderBy: { createdAt: "desc" },
                  });
                } else {
                  this.logger.warn(`Daily.co recording ${latest.id} has no download_url yet - will retry in 30s`);
                  cooldown = 30_000;
                }
              }
            } else {
              cooldown = 30_000;
            }
          } catch (err: any) {
            this.logger.warn(`Auto-fetch from Daily.co failed for booking ${bookingId}: ${err.message}`);
            cooldown = 30_000;
          }
        }
        setTimeout(() => this.autoFetchAttempted.delete(bookingId), cooldown);
      }
    }

    const recordingsWithUrls = await Promise.all(
      recordings.map(async (rec) => {
        let playbackUrl: string | null = null;
        if (rec.status === "ready") {
          try {
            playbackUrl = await this.videoService.getRecordingAccessUrl(
              rec.gcsObjectPath,
            );
          } catch {
            playbackUrl = null;
          }
        }
        return {
          id: rec.id,
          bookingId: rec.bookingId,
          status: rec.status,
          duration: rec.duration,
          fileSize: rec.fileSize,
          transcriptText: rec.transcriptText,
          transcriptStatus: rec.transcriptStatus,
          playbackUrl,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
        };
      }),
    );

    let parentAccountMembers: { id: string; name: string | null; email: string }[] = [];
    if ((booking.parentUser as any)?.parentAccountId) {
      parentAccountMembers = await this.prisma.user.findMany({
        where: { parentAccountId: (booking.parentUser as any).parentAccountId },
        select: { id: true, name: true, email: true },
      });
    }

    return {
      booking: {
        id: booking.id,
        scheduledAt: booking.scheduledAt,
        duration: booking.duration,
        subject: booking.subject,
        consentGiven: booking.consentGiven,
        actualEndedAt: booking.actualEndedAt,
        providerUser: {
          id: booking.providerUser?.id,
          name: booking.providerUser?.name,
          email: booking.providerUser?.email,
        },
        parentUser: booking.parentUser,
        parentAccountMembers,
      },
      recordings: recordingsWithUrls,
    };
  }

  @Get("recordings/:recordingId/download")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get a signed download URL for a recording" })
  async downloadRecording(
    @Req() req: any,
    @Param("recordingId") recordingId: string,
    @Res() res: Response,
  ) {
    const user = req.user;

    const recording = await this.prisma.recording.findUnique({
      where: { id: recordingId },
      include: { booking: true },
    });

    if (!recording) throw new NotFoundException("Recording not found");
    if (recording.status !== "ready") {
      throw new BadRequestException("Recording is not ready for download");
    }

    await this.assertBookingAccess(user.id, user.roles, recording.booking);

    const signedUrl = await this.videoService.getRecordingAccessUrl(
      recording.gcsObjectPath,
    );

    res.redirect(signedUrl);
  }

  @Delete("recordings/:recordingId")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Delete a recording" })
  async deleteRecording(
    @Req() req: any,
    @Param("recordingId") recordingId: string,
  ) {
    const user = req.user;
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isProvider = hasProviderRole(user.roles || []);

    if (!isAdmin && !isProvider) {
      throw new ForbiddenException(
        "Only providers and admins can delete recordings",
      );
    }

    const recording = await this.prisma.recording.findUnique({
      where: { id: recordingId },
      include: { booking: true },
    });

    if (!recording) throw new NotFoundException("Recording not found");

    if (!isAdmin && recording.booking.providerUserId !== user.id) {
      throw new ForbiddenException(
        "You can only delete recordings from your own bookings",
      );
    }

    await this.videoService.deleteRecording(recordingId);

    return { ok: true };
  }

  @Get("webhooks")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List Daily.co webhooks (admin only)" })
  async listWebhooks(@Req() req: any) {
    if (!req.user.roles?.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin only");
    }
    const webhooks = await this.videoService.listWebhooks();
    return { webhooks };
  }

  @Post("webhooks/register")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Register Daily.co webhook for recording events (admin only)" })
  async registerWebhook(@Req() req: any, @Body() body: { webhookUrl?: string }) {
    if (!req.user.roles?.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin only");
    }

    let webhookUrl = body.webhookUrl;
    if (!webhookUrl) {
      const replitDomains = process.env.REPLIT_DOMAINS || process.env.REPLIT_DEV_DOMAIN;
      if (replitDomains) {
        const domain = replitDomains.split(",")[0].trim();
        webhookUrl = `https://${domain}/api/video/webhook`;
      }
    }

    if (!webhookUrl) {
      throw new BadRequestException("Could not determine webhook URL. Please provide webhookUrl in the request body.");
    }

    const hmacSecret = process.env.DAILY_WEBHOOK_SECRET || undefined;

    const existing = await this.videoService.listWebhooks();
    for (const wh of existing) {
      if (wh.url === webhookUrl) {
        this.logger.log(`Webhook already registered: ${webhookUrl}`);
        return { message: "Webhook already registered", webhook: wh };
      }
    }

    if (existing.length > 0) {
      for (const wh of existing) {
        const whId = wh.uuid || wh.id;
        if (!whId) {
          this.logger.warn(`Skipping webhook with no uuid/id: ${JSON.stringify(wh)}`);
          continue;
        }
        this.logger.log(`Deleting stale webhook ${whId} (${wh.url}) to re-register at ${webhookUrl}`);
        await this.videoService.deleteWebhook(whId);
      }
    }

    const result = await this.videoService.registerWebhook(webhookUrl, hmacSecret);
    this.logger.log(`Webhook registered: ${webhookUrl}`);
    return { message: "Webhook registered successfully", webhook: result, url: webhookUrl };
  }

  @Delete("webhooks/:webhookId")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Delete a Daily.co webhook (admin only)" })
  async deleteWebhook(@Req() req: any, @Param("webhookId") webhookId: string) {
    if (!req.user.roles?.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin only");
    }
    await this.videoService.deleteWebhook(webhookId);
    return { ok: true };
  }
}
