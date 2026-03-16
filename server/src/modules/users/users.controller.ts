import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  HttpCode,
  HttpStatus,
  Inject,
  UseGuards,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiBody, ApiParam } from "@nestjs/swagger";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "../auth/auth.service";
import { VideoService } from "../video/video.service";
import { NotificationService } from "../notifications/notification.service";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { insertUserSchema } from "@shared/schema";
import { hasProviderRole, PROVIDER_ROLES, PARENT_ACCOUNT_ROLES, isParentAccountAdmin } from "@shared/roles";
import { z } from "zod";
import { CreateUserDto, UserResponseDto } from "../../dto/user.dto";
import { ErrorResponseDto } from "../../dto/auth.dto";

const ROLES_NEEDING_VIDEO_ROOM = [
  "GOSTORK_ADMIN",
  "GOSTORK_CONCIERGE",
  "GOSTORK_DEVELOPER",
  "PROVIDER_ADMIN",
  "SURROGACY_COORDINATOR",
  "EGG_DONOR_COORDINATOR",
  "SPERM_DONOR_COORDINATOR",
  "IVF_CLINIC_COORDINATOR",
  "DOCTOR",
];

@ApiTags("Users")
@Controller("api")
export class UsersController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(VideoService) private readonly videoService: VideoService,
    @Inject(NotificationService) private readonly notificationService: NotificationService,
  ) {}

  private async ensureParentAccount(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, roles: true, parentAccountId: true, parentAccountRole: true } });
    if (!user || !user.roles.includes("PARENT") || user.parentAccountId) return;
    const account = await this.prisma.parentAccount.create({ data: {} });
    await this.prisma.user.update({
      where: { id: userId },
      data: { parentAccountId: account.id, parentAccountRole: "INTENDED_PARENT_1" },
    });
  }

  private async provisionVideoRoom(userId: string, roles: string[]): Promise<void> {
    const needsRoom = roles.some(r => ROLES_NEEDING_VIDEO_ROOM.includes(r));
    if (!needsRoom) return;
    try {
      const room = await this.videoService.createRoom();
      await this.prisma.user.update({
        where: { id: userId },
        data: { dailyRoomUrl: room.url },
      });
    } catch (err) {
      console.error(`[video] Failed to provision Daily.co room for user ${userId}:`, err);
    }
  }

  @Get("user")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get current authenticated user" })
  @ApiResponse({ status: 200, description: "Current user data", type: UserResponseDto })
  @ApiResponse({ status: 401, description: "Not authenticated", type: ErrorResponseDto })
  async me(@Req() req: Request) {
    const user = req.user as any;
    await this.ensureParentAccount(user.id);
    const enriched = await this.authService.getUserWithProvider(user.id);
    const result = enriched || user;
    const { password: _, ...safe } = result;
    return safe;
  }

  @Get("parent-profile")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get current user's intended parent profile" })
  async getParentProfile(@Req() req: Request) {
    const user = req.user as any;
    if (!user.parentAccountId) return {};
    const profile = await this.prisma.intendedParentProfile.findUnique({
      where: { parentAccountId: user.parentAccountId },
    });
    return profile || {};
  }

  @Put("parent-profile/update")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update intended parent profile fields (used by AI concierge)" })
  async updateParentProfile(@Body() body: any, @Req() req: Request) {
    const user = req.user as any;
    if (!user.parentAccountId) {
      throw new BadRequestException("No parent account found");
    }

    const allowedFields = [
      "hasEmbryos", "embryoCount", "embryosTested",
      "eggSource", "spermSource", "carrier", "journeyStage",
      "clinicReason", "clinicPriority",
      "donorEyeColor", "donorHairColor", "donorHeight", "donorEducation",
      "surrogateBudget", "surrogateMedPrefs",
    ];

    const updateData: any = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        if (field === "hasEmbryos" || field === "embryosTested") {
          updateData[field] = body[field] === true || body[field] === "true";
        } else if (field === "embryoCount") {
          const num = parseInt(String(body[field]), 10);
          if (!isNaN(num) && num >= 0) updateData[field] = num;
        } else {
          updateData[field] = body[field];
        }
      }
    }

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestException("No valid fields to update");
    }

    const existing = await this.prisma.intendedParentProfile.findUnique({
      where: { parentAccountId: user.parentAccountId },
    });

    let profile;
    if (existing) {
      profile = await this.prisma.intendedParentProfile.update({
        where: { parentAccountId: user.parentAccountId },
        data: updateData,
      });
    } else {
      profile = await this.prisma.intendedParentProfile.create({
        data: { parentAccountId: user.parentAccountId, ...updateData },
      });
    }
    return profile;
  }

  @Post("parent-profile/hot-lead")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Flag a provider as a hot lead for this parent" })
  async flagHotLead(@Body() body: any, @Req() req: Request) {
    const user = req.user as any;
    if (!user.parentAccountId) {
      throw new BadRequestException("No parent account found");
    }
    const providerId = body.providerId;
    if (!providerId) {
      throw new BadRequestException("providerId is required");
    }

    const profile = await this.prisma.intendedParentProfile.update({
      where: { parentAccountId: user.parentAccountId },
      data: { hotLeadProviderId: providerId, hotLeadAt: new Date() },
    });

    const admins = await this.prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true } });
    const parentName = user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim();
    for (const admin of admins) {
      await this.prisma.inAppNotification.create({
        data: {
          userId: admin.id,
          eventType: "HOT_LEAD",
          payload: {
            parentName,
            parentUserId: user.id,
            parentEmail: user.email,
            providerId,
            message: `${parentName || "A parent"} wants to connect with a provider via AI Concierge`,
          },
        },
      });
    }

    return { success: true };
  }

  @Put("user/complete-profile")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Complete user profile (first login)" })
  @ApiResponse({ status: 200, description: "Profile completed" })
  @ApiResponse({ status: 400, description: "Validation error", type: ErrorResponseDto })
  async completeProfile(@Body() body: any, @Req() req: Request) {
    const user = req.user as any;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const mobileNumber = typeof body.mobileNumber === "string" ? body.mobileNumber.trim() : null;
    if (!name) {
      throw new BadRequestException("Name is required");
    }
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { name, mobileNumber: mobileNumber || null, mustCompleteProfile: false },
    });
    const enriched = await this.authService.getUserWithProvider(updated.id);
    const result = enriched || updated;
    const { password: _, ...safe } = result;
    return safe;
  }

  @Put("user/onboarding")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Complete multi-step onboarding flow" })
  @ApiResponse({ status: 200, description: "Onboarding completed" })
  @ApiResponse({ status: 400, description: "Validation error", type: ErrorResponseDto })
  async completeOnboarding(@Body() body: any, @Req() req: Request) {
    const user = req.user as any;
    const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
    const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
    if (!firstName || !lastName) {
      throw new BadRequestException("First name and last name are required");
    }

    const validGenders = ["I'm a woman", "I'm a man", "I'm non-binary"];
    const validOrientations = ["Straight", "Gay", "Lesbian", "Bi", "Queer"];
    const validRelationships = ["Single", "Partnered", "Married", "Separated/Divorced/Widowed"];
    const validSources = ["Google", "Social Media", "Friend", "Fertility Clinic", "Egg Donor Agency", "Surrogacy Agency", "Fertility Lawyer", "Progyny", "Carrot", "Other"];
    const validServices = ["Fertility Clinic", "Egg Donor", "Surrogate", "Sperm Donor"];

    if (body.gender && !validGenders.includes(body.gender)) throw new BadRequestException("Invalid gender");
    if (body.sexualOrientation && !validOrientations.includes(body.sexualOrientation)) throw new BadRequestException("Invalid orientation");
    if (body.relationshipStatus && !validRelationships.includes(body.relationshipStatus)) throw new BadRequestException("Invalid relationship status");
    if (body.referralSource && !validSources.includes(body.referralSource)) throw new BadRequestException("Invalid referral source");
    if (Array.isArray(body.interestedServices) && body.interestedServices.some((s: string) => !validServices.includes(s))) {
      throw new BadRequestException("Invalid service selection");
    }

    if (body.dateOfBirth) {
      const d = new Date(body.dateOfBirth);
      if (isNaN(d.getTime())) throw new BadRequestException("Invalid date of birth");
    }
    if (body.partnerAge !== undefined && body.partnerAge !== null) {
      const age = Number(body.partnerAge);
      if (!Number.isInteger(age) || age < 18 || age > 120) throw new BadRequestException("Invalid partner age");
    }

    const name = `${firstName} ${lastName}`;
    const updateData: any = {
      firstName,
      lastName,
      name,
    };

    if (body.dateOfBirth) updateData.dateOfBirth = new Date(body.dateOfBirth);
    if (body.gender) updateData.gender = body.gender;
    if (body.sexualOrientation) updateData.sexualOrientation = body.sexualOrientation;
    if (body.relationshipStatus) updateData.relationshipStatus = body.relationshipStatus;
    if (body.partnerFirstName !== undefined) updateData.partnerFirstName = body.partnerFirstName || null;
    if (body.partnerAge !== undefined) updateData.partnerAge = typeof body.partnerAge === "number" ? body.partnerAge : null;
    if (body.city) updateData.city = body.city;
    if (body.state) updateData.state = body.state;
    if (body.mobileNumber) updateData.mobileNumber = body.mobileNumber;
    if (body.referralSource) updateData.referralSource = body.referralSource;

    await this.ensureParentAccount(user.id);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { ...updateData, mustCompleteProfile: false },
      });

      if (Array.isArray(body.interestedServices) && body.interestedServices.length > 0) {
        const refreshedUser = await tx.user.findUnique({ where: { id: user.id }, select: { parentAccountId: true } });
        if (refreshedUser?.parentAccountId) {
          const existing = await tx.intendedParentProfile.findUnique({
            where: { parentAccountId: refreshedUser.parentAccountId },
          });
          if (existing) {
            await tx.intendedParentProfile.update({
              where: { parentAccountId: refreshedUser.parentAccountId },
              data: { interestedServices: body.interestedServices },
            });
          } else {
            await tx.intendedParentProfile.create({
              data: {
                parentAccountId: refreshedUser.parentAccountId,
                interestedServices: body.interestedServices,
              },
            });
          }
        }
      }
    });

    const enriched = await this.authService.getUserWithProvider(user.id);
    const { password: _, ...safe } = enriched || {};
    return safe;
  }

  @Put("user/profile")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update current user's own profile" })
  @ApiResponse({ status: 200, description: "Profile updated" })
  async updateMyProfile(@Body() body: any, @Req() req: Request) {
    const user = req.user as any;
    const updateData: any = {};
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) throw new BadRequestException("Name cannot be empty");
      updateData.name = name;
    }
    if (body.mobileNumber !== undefined) updateData.mobileNumber = body.mobileNumber || null;
    if (body.photoUrl !== undefined) updateData.photoUrl = body.photoUrl || null;
    if (body.city !== undefined) updateData.city = body.city || null;
    if (body.state !== undefined) updateData.state = body.state || null;
    if (body.country !== undefined) updateData.country = body.country || null;
    if (body.identification !== undefined) updateData.identification = body.identification || null;
    if (body.gender !== undefined) {
      const validGenders = ["I'm a woman", "I'm a man", "I'm non-binary"];
      if (body.gender && !validGenders.includes(body.gender)) throw new BadRequestException("Invalid gender");
      updateData.gender = body.gender || null;
    }
    if (body.sexualOrientation !== undefined) {
      const validOrientations = ["Straight", "Gay", "Lesbian", "Bi", "Queer"];
      if (body.sexualOrientation && !validOrientations.includes(body.sexualOrientation)) throw new BadRequestException("Invalid orientation");
      updateData.sexualOrientation = body.sexualOrientation || null;
    }
    if (body.relationshipStatus !== undefined) {
      const validRelationships = ["Single", "Partnered", "Married", "Separated/Divorced/Widowed"];
      if (body.relationshipStatus && !validRelationships.includes(body.relationshipStatus)) throw new BadRequestException("Invalid relationship status");
      updateData.relationshipStatus = body.relationshipStatus || null;
    }
    if (body.dateOfBirth !== undefined) {
      if (body.dateOfBirth) {
        const d = new Date(body.dateOfBirth);
        if (isNaN(d.getTime())) throw new BadRequestException("Invalid date of birth");
        updateData.dateOfBirth = d;
      } else {
        updateData.dateOfBirth = null;
      }
    }
    if (body.partnerFirstName !== undefined) updateData.partnerFirstName = body.partnerFirstName || null;
    if (body.partnerAge !== undefined) {
      const age = body.partnerAge ? Number(body.partnerAge) : null;
      if (age !== null && (!Number.isInteger(age) || age < 18 || age > 120)) throw new BadRequestException("Invalid partner age");
      updateData.partnerAge = age;
    }
    if (body.referralSource !== undefined) {
      const validSources = ["Google", "Social Media", "Friend", "Fertility Clinic", "Egg Donor Agency", "Surrogacy Agency", "Fertility Lawyer", "Progyny", "Carrot", "Other"];
      if (body.referralSource && !validSources.includes(body.referralSource)) throw new BadRequestException("Invalid referral source");
      updateData.referralSource = body.referralSource || null;
    }
    if (body.password !== undefined && body.password.length >= 6) {
      updateData.password = await this.authService.hashPassword(body.password);
    }
    if (Object.keys(updateData).length === 0 && !body.interestedServices) {
      throw new BadRequestException("No fields to update");
    }

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(updateData).length > 0) {
        await tx.user.update({
          where: { id: user.id },
          data: updateData,
        });
      }

      const validServices = ["Fertility Clinic", "Egg Donor", "Surrogate", "Sperm Donor"];
      if (Array.isArray(body.interestedServices) && user.parentAccountId) {
        if (body.interestedServices.some((s: string) => !validServices.includes(s))) {
          throw new BadRequestException("Invalid service selection");
        }
        const existing = await tx.intendedParentProfile.findUnique({
          where: { parentAccountId: user.parentAccountId },
        });
        if (existing) {
          await tx.intendedParentProfile.update({
            where: { parentAccountId: user.parentAccountId },
            data: { interestedServices: body.interestedServices },
          });
        } else {
          await tx.intendedParentProfile.create({
            data: {
              parentAccountId: user.parentAccountId,
              interestedServices: body.interestedServices,
            },
          });
        }
      }
    });

    const enriched = await this.authService.getUserWithProvider(user.id);
    const result = enriched || {};
    const { password: _, ...safe } = result;
    return safe;
  }

  @Put("user/photo")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update current user's profile photo" })
  @ApiResponse({ status: 200, description: "Photo updated" })
  async updateMyPhoto(@Body() body: any, @Req() req: Request) {
    const user = req.user as any;
    const photoUrl = body.photoUrl !== undefined ? (body.photoUrl || null) : undefined;
    if (photoUrl === undefined) {
      throw new BadRequestException("photoUrl is required (string or null to delete)");
    }
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { photoUrl },
    });
    const enriched = await this.authService.getUserWithProvider(updated.id);
    const result = enriched || updated;
    const { password: _, ...safe } = result;
    return safe;
  }

  @Get("users")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List all users (GoStork team only)" })
  @ApiResponse({ status: 200, description: "List of users", type: [UserResponseDto] })
  @ApiResponse({ status: 403, description: "Forbidden — GoStork team only", type: ErrorResponseDto })
  async listUsers(@Req() req: Request) {
    const user = req.user as any;
    const gostorkRoles = ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE", "GOSTORK_DEVELOPER"];
    if (!user.roles?.some((r: string) => gostorkRoles.includes(r))) {
      throw new ForbiddenException("GoStork team only");
    }
    const users = await this.prisma.user.findMany({
      select: {
        id: true, email: true, name: true, photoUrl: true, mobileNumber: true, city: true, state: true, country: true, identification: true, roles: true, providerId: true, allLocations: true, createdAt: true, dailyRoomUrl: true, calendarLink: true,
        provider: { select: { id: true, name: true } },
        assignedLocations: { include: { location: true } },
        calendarConnections: { select: { id: true, provider: true, email: true, label: true, tokenValid: true, connected: true }, orderBy: { createdAt: "desc" } },
        scheduleConfig: { select: { bookingPageSlug: true } },
      },
      orderBy: { email: "asc" },
    });
    return users;
  }

  @Get("users/:id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get a single user by ID (GoStork team only)" })
  @ApiParam({ name: "id", type: String })
  @ApiResponse({ status: 200, description: "User data", type: UserResponseDto })
  @ApiResponse({ status: 403, description: "Forbidden — GoStork team only", type: ErrorResponseDto })
  @ApiResponse({ status: 404, description: "User not found", type: ErrorResponseDto })
  async getUser(@Param("id") id: string, @Req() req: Request) {
    const user = req.user as any;
    const gostorkRoles = ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE", "GOSTORK_DEVELOPER"];
    if (!user.roles?.some((r: string) => gostorkRoles.includes(r))) {
      throw new ForbiddenException("GoStork team only");
    }
    const target = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true, email: true, name: true, photoUrl: true, mobileNumber: true, city: true, state: true, country: true, identification: true, roles: true,
        providerId: true, allLocations: true, createdAt: true, dailyRoomUrl: true, calendarLink: true, parentAccountRole: true,
        provider: { select: { id: true, name: true } },
        assignedLocations: { include: { location: true } },
        calendarConnections: { select: { id: true, provider: true, email: true, label: true, tokenValid: true, connected: true }, orderBy: { createdAt: "desc" } },
        scheduleConfig: { select: { bookingPageSlug: true } },
      },
    });
    if (!target) throw new NotFoundException("User not found");
    return target;
  }

  @Post("users/admin")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create any user (GOSTORK_ADMIN only)" })
  @ApiBody({ type: CreateUserDto })
  @ApiResponse({ status: 201, description: "User created", type: UserResponseDto })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  async adminCreateUser(@Body() body: any, @Req() req: Request) {
    const user = req.user as any;
    if (!user.roles?.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin only");
    }
    try {
      const input = insertUserSchema.parse(body);
      const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
      if (existing) throw new BadRequestException("Email already in use");

      const roles: string[] = Array.isArray(body.roles) ? body.roles : [input.role || "PARENT"];
      const gostorkRoleValues = ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE", "GOSTORK_DEVELOPER"];
      let resolvedProviderId = body.providerId || null;
      if (!resolvedProviderId && roles.some(r => gostorkRoleValues.includes(r))) {
        const gostorkProvider = await this.prisma.provider.findFirst({ where: { name: { contains: "GoStork", mode: "insensitive" } } });
        if (gostorkProvider) resolvedProviderId = gostorkProvider.id;
      }
      const hashedPassword = await this.authService.hashPassword(input.password);
      const isParentRole = roles.includes("PARENT") && !roles.some((r: string) => hasProviderRole([r])) && !roles.some((r: string) => gostorkRoleValues.includes(r));
      let adminParentAccountId: string | null = null;
      if (isParentRole) {
        const account = await this.prisma.parentAccount.create({ data: {} });
        adminParentAccountId = account.id;
      }
      const created = await this.prisma.user.create({
        data: {
          email: input.email,
          password: hashedPassword,
          name: input.name || null,
          photoUrl: input.photoUrl || null,
          mobileNumber: input.mobileNumber || null,
          city: body.city || null,
          state: body.state || null,
          country: body.country || null,
          roles,
          providerId: resolvedProviderId,
          allLocations: body.allLocations === true,
          parentAccountId: adminParentAccountId,
          parentAccountRole: isParentRole ? "INTENDED_PARENT_1" : null,
        },
        include: { provider: { select: { id: true, name: true } }, assignedLocations: { include: { location: true } } },
      });
      this.provisionVideoRoom(created.id, roles).catch(() => {});
      const { password: _, ...safe } = created;
      return safe;
    } catch (err) {
      if (err instanceof z.ZodError) throw new BadRequestException({ message: "Validation error", errors: err.errors });
      throw err;
    }
  }

  @Get("admin/dashboard-stats")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get admin dashboard stats (GOSTORK_ADMIN only)" })
  async getAdminDashboardStats(@Req() req: Request) {
    const user = req.user as any;
    if (!user.roles?.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin only");
    }

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      providerCount,
      userCount,
      usersThisWeek,
      activeScrapers,
      totalDonorProfiles,
      videoBookings,
      completedVideoCalls,
      upcomingVideoCalls,
      roomCount,
    ] = await Promise.all([
      this.prisma.provider.count(),
      this.prisma.user.count({ where: { roles: { has: "PARENT" } } }),
      this.prisma.user.count({ where: { roles: { has: "PARENT" }, createdAt: { gte: weekAgo } } }),
      this.prisma.provider.count({
        where: {
          OR: [
            { eggDonorSyncConfig: { isNot: null } },
            { surrogateSyncConfig: { isNot: null } },
            { spermDonorSyncConfig: { isNot: null } },
          ],
        },
      }),
      this.prisma.eggDonor.count(),
      this.prisma.booking.count({ where: { meetingType: "video" } }),
      this.prisma.booking.count({ where: { meetingType: "video", actualEndedAt: { not: null } } }),
      this.prisma.booking.count({
        where: {
          meetingType: "video",
          status: "CONFIRMED",
          scheduledAt: { gte: now },
        },
      }),
      this.prisma.user.count({ where: { dailyRoomUrl: { not: null } } }),
    ]);

    return {
      providers: providerCount,
      parents: userCount,
      parentsThisWeek: usersThisWeek,
      scrapers: {
        activeScrapers,
        totalDonorProfiles,
      },
      video: {
        totalBookings: videoBookings,
        completedCalls: completedVideoCalls,
        upcomingCalls: upcomingVideoCalls,
        activeRooms: roomCount,
      },
    };
  }

  @Put("users/:id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update any user (GOSTORK_ADMIN only)" })
  @ApiParam({ name: "id", type: String })
  @ApiResponse({ status: 200, description: "User updated", type: UserResponseDto })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  async adminUpdateUser(@Param("id") id: string, @Body() body: any, @Req() req: Request) {
    const user = req.user as any;
    if (!user.roles?.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin only");
    }
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException("User not found");

    const updateData: any = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.photoUrl !== undefined) updateData.photoUrl = body.photoUrl || null;
    if (body.email !== undefined) {
      const existing = await this.prisma.user.findFirst({ where: { email: body.email, id: { not: id } } });
      if (existing) throw new BadRequestException("Email already in use");
      updateData.email = body.email;
    }
    if (body.password && body.password.length >= 6) {
      updateData.password = await this.authService.hashPassword(body.password);
    }
    if (body.mobileNumber !== undefined) updateData.mobileNumber = body.mobileNumber || null;
    if (body.city !== undefined) updateData.city = body.city || null;
    if (body.state !== undefined) updateData.state = body.state || null;
    if (body.country !== undefined) updateData.country = body.country || null;
    if (body.identification !== undefined) updateData.identification = body.identification || null;
    if (Array.isArray(body.roles)) updateData.roles = body.roles;
    if (body.providerId !== undefined) updateData.providerId = body.providerId || null;
    if (body.allLocations !== undefined) updateData.allLocations = body.allLocations;
    if (body.isDisabled !== undefined) updateData.isDisabled = !!body.isDisabled;
    if (body.calendarLink !== undefined) updateData.calendarLink = body.calendarLink || null;

    if (Array.isArray(body.locationIds)) {
      await this.prisma.userLocation.deleteMany({ where: { userId: id } });
      if (body.locationIds.length > 0) {
        await this.prisma.userLocation.createMany({
          data: body.locationIds.map((locId: string) => ({ userId: id, locationId: locId })),
        });
      }
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: updateData,
      include: { provider: { select: { id: true, name: true } }, assignedLocations: { include: { location: true } } },
    });
    const { password: _, ...safe } = updated;
    return safe;
  }

  @Delete("users/:id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete any user (GOSTORK_ADMIN only)" })
  @ApiParam({ name: "id", type: String })
  @ApiResponse({ status: 200, description: "User deleted" })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  async adminDeleteUser(@Param("id") id: string, @Req() req: Request) {
    const user = req.user as any;
    if (!user.roles?.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin only");
    }
    if (id === user.id) throw new BadRequestException("Cannot delete yourself");
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException("User not found");
    if (target.dailyRoomUrl) {
      this.videoService.deleteRoom(target.dailyRoomUrl).catch(() => {});
    }
    await this.prisma.user.delete({ where: { id } });
    return { message: "User deleted" };
  }

  @Get("providers/:providerId/parent-contacts")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List parents who have had meetings with this provider" })
  @ApiParam({ name: "providerId", type: String })
  @ApiResponse({ status: 200, description: "List of parent contacts" })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  async listProviderParentContacts(
    @Param("providerId") providerId: string,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isOwnProvider = user.providerId === providerId;
    if (!isAdmin && !isOwnProvider) {
      throw new ForbiddenException("Access denied");
    }

    const providerStaff = await this.prisma.user.findMany({
      where: { providerId },
      select: { id: true },
    });
    const staffIds = providerStaff.map(s => s.id);

    const bookings = await this.prisma.booking.findMany({
      where: {
        providerUserId: { in: staffIds },
        parentUserId: { not: null },
      },
      select: {
        parentUserId: true,
        scheduledAt: true,
        parentUser: {
          select: {
            id: true, name: true, email: true, mobileNumber: true, photoUrl: true, createdAt: true,
          },
        },
      },
      orderBy: { scheduledAt: "desc" },
    });

    const parentMap = new Map<string, any>();
    for (const b of bookings) {
      if (!b.parentUserId || !b.parentUser) continue;
      if (!parentMap.has(b.parentUserId)) {
        parentMap.set(b.parentUserId, {
          ...b.parentUser,
          lastMeetingAt: b.scheduledAt,
          meetingCount: 1,
        });
      } else {
        parentMap.get(b.parentUserId).meetingCount += 1;
      }
    }

    return Array.from(parentMap.values());
  }

  @Get("providers/:providerId/users")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List users for a specific provider" })
  @ApiParam({ name: "providerId", type: String })
  @ApiResponse({ status: 200, description: "List of provider staff", type: [UserResponseDto] })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  async listProviderUsers(
    @Param("providerId") providerId: string,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isOwnProvider = hasProviderRole(user.roles || []) && user.providerId === providerId;
    if (!isAdmin && !isOwnProvider) {
      throw new ForbiddenException("Forbidden");
    }
    const users = await this.prisma.user.findMany({
      where: { providerId },
      select: {
        id: true, email: true, name: true, photoUrl: true, mobileNumber: true, roles: true, providerId: true,
        allLocations: true, dailyRoomUrl: true, calendarLink: true,
        assignedLocations: { include: { location: true } },
        calendarConnections: { select: { id: true, provider: true, email: true, label: true, tokenValid: true, connected: true }, orderBy: { createdAt: "desc" } },
        scheduleConfig: { select: { bookingPageSlug: true } },
      },
      orderBy: { email: "asc" },
    });
    return users;
  }

  @Post("providers/:providerId/users")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create a staff user for a provider" })
  @ApiParam({ name: "providerId", type: String })
  @ApiBody({ type: CreateUserDto })
  @ApiResponse({ status: 201, description: "Staff user created", type: UserResponseDto })
  @ApiResponse({ status: 400, description: "Validation error", type: ErrorResponseDto })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  async createProviderUser(
    @Param("providerId") providerId: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isProviderAdmin = user.roles?.includes("PROVIDER_ADMIN") && user.providerId === providerId;
    if (!isAdmin && !isProviderAdmin) {
      throw new ForbiddenException("Only PROVIDER_ADMIN or GOSTORK_ADMIN can add staff");
    }

    const provider = await this.prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider) {
      throw new NotFoundException("Provider not found");
    }

    try {
      const input = insertUserSchema.parse(body);
      const roles: string[] = Array.isArray(body.roles) ? body.roles : (input.role ? [input.role] : ["IVF_CLINIC_COORDINATOR"]);
      const invalidRoles = roles.filter(r => !(PROVIDER_ROLES as readonly string[]).includes(r));
      if (invalidRoles.length > 0) {
        throw new BadRequestException("Invalid roles: " + invalidRoles.join(", ") + ". Must be: " + PROVIDER_ROLES.join(", "));
      }

      const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
      if (existing) {
        throw new BadRequestException("Email already in use");
      }

      const allLocations = body.allLocations === true;
      const mustCompleteProfile = body.mustCompleteProfile === true;
      const locationIds: string[] = Array.isArray(body.locationIds) ? body.locationIds : [];

      const hashedPassword = await this.authService.hashPassword(input.password);
      const created = await this.prisma.user.create({
        data: {
          email: input.email,
          password: hashedPassword,
          name: input.name || null,
          photoUrl: input.photoUrl || null,
          mobileNumber: input.mobileNumber || null,
          roles,
          providerId,
          allLocations,
          mustCompleteProfile,
          assignedLocations: locationIds.length > 0 ? {
            create: locationIds.map((locId: string) => ({ locationId: locId })),
          } : undefined,
        },
        include: {
          assignedLocations: { include: { location: true } },
        },
      });
      this.provisionVideoRoom(created.id, roles).catch(() => {});
      const { password: _, ...safe } = created;
      return safe;
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new BadRequestException({ message: "Validation error", errors: err.errors });
      }
      throw err;
    }
  }

  @Get("providers/:providerId/users/:id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get a single staff user for a provider" })
  @ApiParam({ name: "providerId", type: String })
  @ApiParam({ name: "id", type: String })
  @ApiResponse({ status: 200, description: "User data", type: UserResponseDto })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  @ApiResponse({ status: 404, description: "User not found", type: ErrorResponseDto })
  async getProviderUser(
    @Param("providerId") providerId: string,
    @Param("id") id: string,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isOwnProvider = hasProviderRole(user.roles || []) && user.providerId === providerId;
    if (!isAdmin && !isOwnProvider) {
      throw new ForbiddenException("Forbidden");
    }
    const target = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true, email: true, name: true, photoUrl: true, mobileNumber: true, roles: true,
        providerId: true, allLocations: true, createdAt: true, dailyRoomUrl: true, calendarLink: true,
        provider: { select: { id: true, name: true } },
        assignedLocations: { include: { location: true } },
        calendarConnections: { select: { id: true, provider: true, email: true, label: true, tokenValid: true, connected: true }, orderBy: { createdAt: "desc" } },
        scheduleConfig: { select: { bookingPageSlug: true } },
      },
    });
    if (!target || target.providerId !== providerId) {
      throw new NotFoundException("User not found in this provider");
    }
    return target;
  }

  @Put("providers/:providerId/users/:id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update a staff user for a provider" })
  @ApiParam({ name: "providerId", type: String })
  @ApiParam({ name: "id", type: String })
  @ApiResponse({ status: 200, description: "Staff user updated", type: UserResponseDto })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  @ApiResponse({ status: 404, description: "User not found", type: ErrorResponseDto })
  async updateProviderUser(
    @Param("providerId") providerId: string,
    @Param("id") id: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isProviderAdmin = user.roles?.includes("PROVIDER_ADMIN") && user.providerId === providerId;
    if (!isAdmin && !isProviderAdmin) {
      throw new ForbiddenException("Only PROVIDER_ADMIN or GOSTORK_ADMIN can edit staff");
    }

    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target || target.providerId !== providerId) {
      throw new NotFoundException("User not found in this provider");
    }

    const updateData: any = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.photoUrl !== undefined) updateData.photoUrl = body.photoUrl || null;
    if (body.email !== undefined) {
      const existing = await this.prisma.user.findFirst({ where: { email: body.email, id: { not: id } } });
      if (existing) throw new BadRequestException("Email already in use");
      updateData.email = body.email;
    }
    if (body.password && body.password.length >= 6) {
      updateData.password = await this.authService.hashPassword(body.password);
    }
    if (body.mobileNumber !== undefined) updateData.mobileNumber = body.mobileNumber;
    if (Array.isArray(body.roles)) {
      const invalidRoles = body.roles.filter((r: string) => !(PROVIDER_ROLES as readonly string[]).includes(r));
      if (invalidRoles.length > 0) {
        throw new BadRequestException("Invalid roles: " + invalidRoles.join(", "));
      }
      updateData.roles = body.roles;
    }
    if (body.allLocations !== undefined) {
      updateData.allLocations = body.allLocations;
    }
    if (body.calendarLink !== undefined) updateData.calendarLink = body.calendarLink || null;

    if (Array.isArray(body.locationIds)) {
      await this.prisma.userLocation.deleteMany({ where: { userId: id } });
      if (body.locationIds.length > 0) {
        await this.prisma.userLocation.createMany({
          data: body.locationIds.map((locId: string) => ({ userId: id, locationId: locId })),
        });
      }
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: updateData,
      include: {
        assignedLocations: { include: { location: true } },
      },
    });
    const { password: _, ...safe } = updated;
    return safe;
  }

  @Delete("providers/:providerId/users/:id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete a staff user from a provider" })
  @ApiParam({ name: "providerId", type: String })
  @ApiParam({ name: "id", type: String })
  @ApiResponse({ status: 200, description: "User deleted" })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  @ApiResponse({ status: 404, description: "User not found", type: ErrorResponseDto })
  async deleteProviderUser(
    @Param("providerId") providerId: string,
    @Param("id") id: string,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isProviderAdmin = user.roles?.includes("PROVIDER_ADMIN") && user.providerId === providerId;
    if (!isAdmin && !isProviderAdmin) {
      throw new ForbiddenException("Only PROVIDER_ADMIN or GOSTORK_ADMIN can remove staff");
    }

    if (id === user.id) {
      throw new BadRequestException("Cannot delete yourself");
    }

    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target || target.providerId !== providerId) {
      throw new NotFoundException("User not found in this provider");
    }

    if (target.dailyRoomUrl) {
      this.videoService.deleteRoom(target.dailyRoomUrl).catch(() => {});
    }
    await this.prisma.user.delete({ where: { id } });
    return { message: "User deleted" };
  }

  @Post("users")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Register a new user" })
  @ApiBody({ type: CreateUserDto })
  @ApiResponse({ status: 201, description: "User created", type: UserResponseDto })
  @ApiResponse({ status: 400, description: "Validation error or email in use", type: ErrorResponseDto })
  async createUser(@Body() body: any) {
    try {
      const input = insertUserSchema.parse(body);
      const existing = await this.prisma.user.findUnique({
        where: { email: input.email },
      });
      if (existing) {
        throw new BadRequestException("Email already in use");
      }
      const roles = Array.isArray(body.roles) ? body.roles : [input.role || "PARENT"];
      const hashedPassword = await this.authService.hashPassword(input.password);
      const isParent = roles.includes("PARENT") && !roles.some((r: string) => hasProviderRole([r]));
      let parentAccountId: string | null = null;
      if (isParent) {
        const account = await this.prisma.parentAccount.create({ data: {} });
        parentAccountId = account.id;
      }
      const created = await this.prisma.user.create({
        data: {
          email: input.email,
          password: hashedPassword,
          name: input.name || null,
          mobileNumber: input.mobileNumber || null,
          roles,
          providerId: input.providerId || null,
          parentAccountId,
          parentAccountRole: isParent ? "INTENDED_PARENT_1" : null,
        },
      });
      this.provisionVideoRoom(created.id, roles).catch(() => {});
      const { password: _, ...safe } = created;
      return safe;
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new BadRequestException({ message: "Validation error", errors: err.errors });
      }
      throw err;
    }
  }

  @Get("parent-account/members")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List all members of the current user's parent account" })
  @ApiResponse({ status: 200, description: "List of parent account members" })
  async listParentAccountMembers(@Req() req: Request) {
    const user = req.user as any;
    if (!user.roles?.includes("PARENT")) throw new ForbiddenException("Parent users only");
    await this.ensureParentAccount(user.id);
    const currentUser = await this.prisma.user.findUnique({ where: { id: user.id }, select: { parentAccountId: true } });
    if (!currentUser?.parentAccountId) throw new NotFoundException("No parent account found");
    const members = await this.prisma.user.findMany({
      where: { parentAccountId: currentUser.parentAccountId },
      select: {
        id: true, email: true, name: true, photoUrl: true, mobileNumber: true,
        city: true, state: true, country: true, identification: true,
        parentAccountRole: true, createdAt: true, isDisabled: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return members;
  }

  @Post("parent-account/members")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Add a member to the current user's parent account (IP1 only)" })
  @ApiResponse({ status: 201, description: "Member created" })
  async createParentAccountMember(@Body() body: any, @Req() req: Request) {
    const user = req.user as any;
    if (!user.roles?.includes("PARENT")) throw new ForbiddenException("Parent users only");
    await this.ensureParentAccount(user.id);
    const currentUser = await this.prisma.user.findUnique({ where: { id: user.id }, select: { id: true, name: true, parentAccountId: true, parentAccountRole: true } });
    if (!isParentAccountAdmin(currentUser?.parentAccountRole)) throw new ForbiddenException("Only Intended Parent 1 can add members");
    if (!currentUser?.parentAccountId) throw new NotFoundException("No parent account found");

    const input = insertUserSchema.parse(body);
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new BadRequestException("Email already in use");

    const parentAccountRole = body.parentAccountRole || "INTENDED_PARENT_2";
    if (!(PARENT_ACCOUNT_ROLES as readonly string[]).includes(parentAccountRole) || parentAccountRole === "INTENDED_PARENT_1") {
      throw new BadRequestException("Invalid parent account role");
    }

    const hashedPassword = await this.authService.hashPassword(input.password);
    const created = await this.prisma.user.create({
      data: {
        email: input.email,
        password: hashedPassword,
        name: input.name || null,
        mobileNumber: input.mobileNumber || null,
        city: body.city || null,
        state: body.state || null,
        country: body.country || null,
        roles: ["PARENT"],
        parentAccountId: currentUser.parentAccountId,
        parentAccountRole,
        mustCompleteProfile: true,
      },
    });

    this.notificationService.sendMemberInvitation(
      currentUser.name || "Your partner",
      { id: created.id, email: created.email, name: created.name, mobileNumber: created.mobileNumber },
      input.password,
    ).catch((e) => console.error("[notify] Member invitation failed:", e.message));

    const { password: _, ...safe } = created;
    return safe;
  }

  @Patch("parent-account/members/:userId/role")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update a parent account member's role (IP1 only)" })
  @ApiParam({ name: "userId", type: String })
  async updateParentAccountMemberRole(
    @Param("userId") userId: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    if (!user.roles?.includes("PARENT")) throw new ForbiddenException("Parent users only");
    const currentUser = await this.prisma.user.findUnique({ where: { id: user.id }, select: { parentAccountId: true, parentAccountRole: true } });
    if (!isParentAccountAdmin(currentUser?.parentAccountRole)) throw new ForbiddenException("Only Intended Parent 1 can update roles");

    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, parentAccountId: true } });
    if (!target || target.parentAccountId !== currentUser?.parentAccountId) throw new NotFoundException("Member not found");
    if (userId === user.id) throw new BadRequestException("Cannot change your own role");

    const newRole = body.parentAccountRole;
    if (!(PARENT_ACCOUNT_ROLES as readonly string[]).includes(newRole) || newRole === "INTENDED_PARENT_1") {
      throw new BadRequestException("Invalid parent account role");
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { parentAccountRole: newRole },
      select: { id: true, email: true, name: true, parentAccountRole: true },
    });
    return updated;
  }

  @Patch("parent-account/members/:userId")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update a parent account member's details (IP1 or self)" })
  @ApiParam({ name: "userId", type: String })
  async updateParentAccountMember(
    @Param("userId") userId: string,
    @Body() body: { name?: string; email?: string; mobileNumber?: string; password?: string; city?: string; state?: string; country?: string; identification?: string; photoUrl?: string | null },
    @Req() req: Request,
  ) {
    const user = req.user as any;
    if (!user.roles?.includes("PARENT")) throw new ForbiddenException("Parent users only");
    const isSelf = user.id === userId;
    const currentUser = await this.prisma.user.findUnique({ where: { id: user.id }, select: { parentAccountId: true, parentAccountRole: true } });
    if (!isSelf && !isParentAccountAdmin(currentUser?.parentAccountRole)) throw new ForbiddenException("Only Intended Parent 1 can edit other members");

    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, parentAccountId: true } });
    if (!target || target.parentAccountId !== currentUser?.parentAccountId) throw new NotFoundException("Member not found");

    const data: Record<string, any> = {};
    if (body.name !== undefined) data.name = body.name.trim() || null;
    if (body.mobileNumber !== undefined) data.mobileNumber = body.mobileNumber.trim() || null;
    if (body.city !== undefined) data.city = body.city || null;
    if (body.state !== undefined) data.state = body.state || null;
    if (body.country !== undefined) data.country = body.country || null;
    if (body.identification !== undefined) data.identification = body.identification || null;
    if (body.photoUrl !== undefined) data.photoUrl = body.photoUrl || null;
    if (body.email !== undefined) {
      const email = body.email.toLowerCase().trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new BadRequestException("Invalid email address");
      }
      const existing = await this.prisma.user.findUnique({ where: { email } });
      if (existing && existing.id !== userId) throw new BadRequestException("Email already in use");
      data.email = email;
    }
    if (body.password) {
      if (body.password.length < 6) throw new BadRequestException("Password must be at least 6 characters");
      data.password = await this.authService.hashPassword(body.password);
    }

    if (Object.keys(data).length === 0) throw new BadRequestException("No fields to update");

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, email: true, name: true, mobileNumber: true, photoUrl: true, city: true, state: true, country: true, identification: true, parentAccountRole: true },
    });
    return updated;
  }

  @Delete("parent-account/members/:userId")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Remove a member from the parent account (IP1 only)" })
  @ApiParam({ name: "userId", type: String })
  async deleteParentAccountMember(
    @Param("userId") userId: string,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    if (!user.roles?.includes("PARENT")) throw new ForbiddenException("Parent users only");
    const currentUser = await this.prisma.user.findUnique({ where: { id: user.id }, select: { parentAccountId: true, parentAccountRole: true } });
    if (!isParentAccountAdmin(currentUser?.parentAccountRole)) throw new ForbiddenException("Only Intended Parent 1 can remove members");
    if (userId === user.id) throw new BadRequestException("Cannot remove yourself");

    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, parentAccountId: true } });
    if (!target || target.parentAccountId !== currentUser?.parentAccountId) throw new NotFoundException("Member not found");

    await this.prisma.user.delete({ where: { id: userId } });
    return { message: "Member removed" };
  }

  private async ensureParentAccountForEthnicities(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, parentAccountId: true } });
    if (!user) return null;
    if (user.parentAccountId) return user.parentAccountId;
    const account = await this.prisma.parentAccount.create({ data: {} });
    await this.prisma.user.update({ where: { id: userId }, data: { parentAccountId: account.id } });
    return account.id;
  }

  @Get("donor-preferences")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get user's saved and skipped donor IDs" })
  async getDonorPreferences(@Req() req: Request) {
    const user = req.user as any;
    const prefs = await this.prisma.userDonorPreference.findMany({
      where: { userId: user.id },
      select: { donorId: true, type: true },
    });
    const favorited: string[] = [];
    const skipped: string[] = [];
    for (const p of prefs) {
      if (p.type === "favorite") favorited.push(p.donorId);
      else if (p.type === "skip") skipped.push(p.donorId);
    }
    return { favorited, skipped };
  }

  @Post("donor-preferences/:type/:donorId")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Save a donor preference (favorite or skip)" })
  async addDonorPreference(
    @Param("type") type: string,
    @Param("donorId") donorId: string,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    if (!["favorite", "skip"].includes(type)) throw new BadRequestException("Invalid type");
    await this.prisma.userDonorPreference.upsert({
      where: { userId_donorId_type: { userId: user.id, donorId, type } },
      create: { userId: user.id, donorId, type },
      update: {},
    });
    return { success: true };
  }

  @Delete("donor-preferences/:type/:donorId")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Remove a donor preference" })
  async removeDonorPreference(
    @Param("type") type: string,
    @Param("donorId") donorId: string,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    if (!["favorite", "skip"].includes(type)) throw new BadRequestException("Invalid type");
    await this.prisma.userDonorPreference.deleteMany({
      where: { userId: user.id, donorId, type },
    });
    return { success: true };
  }

  private readonly ALLOWED_FILTER_KEYS = ["ethnicity", "eyeColor", "hairColor", "race", "education"];

  @Get("parent-account/custom-filter-tags")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get all custom filter tags for the current user's parent account" })
  async getCustomFilterTags(@Req() req: Request) {
    const user = req.user as any;
    const accountId = await this.ensureParentAccountForEthnicities(user.id);
    if (!accountId) return { tags: {} };
    const account = await this.prisma.parentAccount.findUnique({ where: { id: accountId }, select: { customFilterTags: true, customEthnicities: true } });
    const tags = (account?.customFilterTags as Record<string, string[]>) || {};
    if (account?.customEthnicities?.length && (!tags.ethnicity || !tags.ethnicity.length)) {
      tags.ethnicity = account.customEthnicities;
    }
    return { tags };
  }

  @Post("parent-account/custom-filter-tags/:filterKey")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Add a custom tag for a specific filter key" })
  @ApiParam({ name: "filterKey", type: String })
  async addCustomFilterTag(@Param("filterKey") filterKey: string, @Body() body: { tag: string }, @Req() req: Request) {
    const user = req.user as any;
    if (!this.ALLOWED_FILTER_KEYS.includes(filterKey)) throw new BadRequestException("Invalid filter key");
    const accountId = await this.ensureParentAccountForEthnicities(user.id);
    if (!accountId) throw new NotFoundException("No account found");
    const tag = (body.tag || "").trim();
    if (!tag) throw new BadRequestException("Tag cannot be empty");
    const account = await this.prisma.parentAccount.findUnique({ where: { id: accountId }, select: { customFilterTags: true } });
    const allTags = (account?.customFilterTags as Record<string, string[]>) || {};
    const existing = allTags[filterKey] || [];
    if (existing.includes(tag)) return { tags: allTags };
    allTags[filterKey] = [...existing, tag];
    await this.prisma.parentAccount.update({ where: { id: accountId }, data: { customFilterTags: allTags } });
    return { tags: allTags };
  }

  @Delete("parent-account/custom-filter-tags/:filterKey/:tag")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Remove a custom tag for a specific filter key" })
  @ApiParam({ name: "filterKey", type: String })
  @ApiParam({ name: "tag", type: String })
  async removeCustomFilterTag(@Param("filterKey") filterKey: string, @Param("tag") tag: string, @Req() req: Request) {
    const user = req.user as any;
    if (!this.ALLOWED_FILTER_KEYS.includes(filterKey)) throw new BadRequestException("Invalid filter key");
    const accountId = await this.ensureParentAccountForEthnicities(user.id);
    if (!accountId) throw new NotFoundException("No account found");
    const decodedTag = decodeURIComponent(tag);
    const account = await this.prisma.parentAccount.findUnique({ where: { id: accountId }, select: { customFilterTags: true } });
    const allTags = (account?.customFilterTags as Record<string, string[]>) || {};
    const existing = allTags[filterKey] || [];
    allTags[filterKey] = existing.filter(e => e !== decodedTag);
    await this.prisma.parentAccount.update({ where: { id: accountId }, data: { customFilterTags: allTags } });
    return { tags: allTags };
  }
}
