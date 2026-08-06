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
import { emitJourneyEvent } from "../../../journey-events";
import { JOURNEY_STAGE_ORDER, LEGACY_MATCH_STATUS_TO_STAGE, resolveJourneyStage, journeyStageLabel } from "../../../../shared/journey-ladder";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "../auth/auth.service";
import { VideoService } from "../video/video.service";
import { NotificationService } from "../notifications/notification.service";
import { AppEventsService } from "../notifications/app-events.service";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { insertUserSchema } from "@shared/schema";
import { hasProviderRole, PROVIDER_ROLES, GOSTORK_ROLES, PARENT_ACCOUNT_ROLES, isParentAccountAdmin } from "@shared/roles";
import { z } from "zod";
import { CreateUserDto, UserResponseDto } from "../../dto/user.dto";
import { ErrorResponseDto } from "../../dto/auth.dto";
import { encryptNullable, decryptNullable } from "../../lib/encrypt";
import {
  GATES_CLOSED, redactParentContact, redactParentMembers, releasedAccountIds, resolveParentGatesBatch,
} from "../../../parent-privacy";

// EVERY provider-side role and all GoStork staff get a personal video room -
// derived from the shared role registry so newly added roles (Lawyer, Legal
// Assistant, ...) are covered automatically instead of silently skipped by
// a stale hardcoded list.
const ROLES_NEEDING_VIDEO_ROOM: string[] = [...GOSTORK_ROLES, ...PROVIDER_ROLES];

// Combine the names of all logins on a shared parent account into one
// display name. Same last name -> "Eran & Dana Amir"; different last
// names -> "Eran Amir & Dana Levy". Solo accounts pass through as-is.
function combineParentNames(members: { name: string | null }[]): string {
  const names = members.map(m => (m.name || "").trim()).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  const parts = names.map(n => n.split(/\s+/));
  const lastNames = parts.map(p => (p.length >= 2 ? p[p.length - 1].toLowerCase() : null));
  const sameLast = lastNames.every(l => l && l === lastNames[0]);
  if (sameLast) {
    const firsts = parts.map(p => p.slice(0, -1).join(" "));
    return `${firsts.join(" & ")} ${parts[0][parts[0].length - 1]}`;
  }
  return names.join(" & ");
}

@ApiTags("Users")
@Controller("api")
export class UsersController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(VideoService) private readonly videoService: VideoService,
    @Inject(NotificationService) private readonly notificationService: NotificationService,
    @Inject(AppEventsService) private readonly appEvents: AppEventsService,
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

  private async provisionVideoRoom(userId: string, roles: string[]): Promise<string | null> {
    const needsRoom = roles.some(r => ROLES_NEEDING_VIDEO_ROOM.includes(r));
    if (!needsRoom) return null;
    try {
      const room = await this.videoService.createRoom();
      await this.prisma.user.update({
        where: { id: userId },
        data: { dailyRoomUrl: room.url },
      });
      return room.url;
    } catch (err) {
      console.error(`[video] Failed to provision Daily.co room for user ${userId}:`, err);
      return null;
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

  @Get("surrogate-countries")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get distinct countries where surrogacy agencies or surrogates operate" })
  async getSurrogateCountries() {
    // Base list of known surrogacy-friendly countries
    const KNOWN_COUNTRIES = [
      "United States", "Colombia", "Mexico", "Canada",
      "Ukraine", "Georgia", "Cyprus", "Greece", "Czech Republic",
      "Israel", "Australia", "Portugal", "Albania", "Belarus",
      "Taiwan", "Cambodia", "Argentina", "Kenya", "South Africa",
    ];

    // Pull countries from CostProgram (has explicit country field for surrogacy programs)
    const US_STATES = new Set([
      "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY",
      "LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND",
      "OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
      "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware",
      "Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky",
      "Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi",
      "Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico",
      "New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania",
      "Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont",
      "Virginia","Washington","West Virginia","Wisconsin","Wyoming",
      "USA","Mid-West",
    ]);

    const [costPrograms, providerLocations] = await Promise.all([
      this.prisma.$queryRaw<{ country: string }[]>`
        SELECT DISTINCT cp.country
        FROM "CostProgram" cp
        JOIN "ProviderService" ps ON ps."providerTypeId" = cp."providerTypeId"
        JOIN "ProviderType" pt ON pt.id = cp."providerTypeId"
        WHERE cp.country IS NOT NULL AND cp.country != '' AND pt.name = 'Surrogacy Agency'
      `,
      this.prisma.$queryRaw<{ state: string }[]>`
        SELECT DISTINCT pl.state
        FROM "ProviderLocation" pl
        JOIN "Provider" p ON p.id = pl."providerId"
        JOIN "ProviderService" ps ON ps."providerId" = p.id
        JOIN "ProviderType" pt ON pt.id = ps."providerTypeId"
        WHERE pt.name = 'Surrogacy Agency' AND pl.state IS NOT NULL AND pl.state != ''
      `,
    ]);

    const dbCountries = new Set<string>(KNOWN_COUNTRIES);
    for (const row of costPrograms) {
      if (row.country) dbCountries.add(row.country.trim());
    }
    for (const row of providerLocations) {
      const s = (row.state || "").trim();
      if (s && !US_STATES.has(s) && s.length > 2) {
        dbCountries.add(s);
      }
    }

    return Array.from(dbCountries).sort();
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

    // Composite family-type capture: when the onboarding flow asks
    // "Solo Man / Solo Woman / 2 dads / 2 moms / straight couple", the
    // client posts a single familyType token and we derive the two
    // gender fields the cost-sheet matcher reads. Optional - existing
    // gender + relationshipStatus answers still work.
    // gender writes use the legacy "I'm a man" / "I'm a woman" labels so they
    // match the existing onboarding form. partnerGender is the short "man" /
    // "woman" form to mirror how Eva's [[SAVE:familyType]] block persists it.
    // The cost-sheet matcher accepts both formats.
    if (typeof body.familyType === "string") {
      const ft = body.familyType;
      const primary = body.primaryGenderForStraight === "male" ? "man" : "woman";
      switch (ft) {
        case "solo_man":
          updateData.gender = "I'm a man";
          updateData.partnerGender = null;
          break;
        case "solo_woman":
          updateData.gender = "I'm a woman";
          updateData.partnerGender = null;
          break;
        case "two_dads":
          updateData.gender = "I'm a man";
          updateData.partnerGender = "man";
          break;
        case "two_moms":
          updateData.gender = "I'm a woman";
          updateData.partnerGender = "woman";
          break;
        case "straight_couple":
          updateData.gender = primary === "man" ? "I'm a man" : "I'm a woman";
          updateData.partnerGender = primary === "woman" ? "man" : "woman";
          break;
        default:
          throw new BadRequestException(`Invalid familyType: ${ft}`);
      }
    }

    // Direct partnerGender setter (for flows that already know it).
    if (body.partnerGender !== undefined) {
      if (body.partnerGender !== null && body.partnerGender !== "man" && body.partnerGender !== "woman") {
        throw new BadRequestException("partnerGender must be 'man', 'woman', or null");
      }
      updateData.partnerGender = body.partnerGender;
    }
    if (body.city) updateData.city = body.city;
    if (body.state) updateData.state = body.state;
    if (body.country !== undefined) updateData.country = body.country || null;
    if (body.mobileNumber) updateData.mobileNumber = body.mobileNumber;
    if (body.mobileNumberDisplay) updateData.mobileNumberDisplay = body.mobileNumberDisplay;
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
    if (body.mobileNumberDisplay !== undefined) updateData.mobileNumberDisplay = body.mobileNumberDisplay || null;
    if (body.photoUrl !== undefined) updateData.photoUrl = body.photoUrl || null;
    if (body.city !== undefined) updateData.city = body.city || null;
    if (body.state !== undefined) updateData.state = body.state || null;
    if (body.country !== undefined) updateData.country = body.country || null;
    if (body.address !== undefined) updateData.address = body.address || null;
    if (body.zip !== undefined) updateData.zip = body.zip || null;
    if (body.ssn !== undefined) updateData.ssn = encryptNullable(body.ssn);
    if (body.passport !== undefined) updateData.passport = encryptNullable(body.passport);
    if (body.passportCountryOfIssue !== undefined) updateData.passportCountryOfIssue = body.passportCountryOfIssue || null;
    if (body.nationality !== undefined) updateData.nationality = body.nationality || null;
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
    // partnerGender is the field the cost-sheet matcher reads to tell a
    // straight couple apart from a 2-mom couple. Without this case the
    // value sent from the settings page was silently dropped, the column
    // stayed null, and the matcher could never finalize. Accept the short
    // wire-format Eva and the settings UI both use.
    if (body.partnerGender !== undefined) {
      if (body.partnerGender !== null && body.partnerGender !== "man" && body.partnerGender !== "woman") {
        throw new BadRequestException("partnerGender must be 'man', 'woman', or null");
      }
      updateData.partnerGender = body.partnerGender || null;
    }
    if (body.referralSource !== undefined) {
      const validSources = ["Google", "Social Media", "Friend", "Fertility Clinic", "Egg Donor Agency", "Surrogacy Agency", "Fertility Lawyer", "Progyny", "Carrot", "Other"];
      if (body.referralSource && !validSources.includes(body.referralSource)) throw new BadRequestException("Invalid referral source");
      updateData.referralSource = body.referralSource || null;
    }
    if (body.password !== undefined && body.password.length >= 6) {
      updateData.password = await this.authService.hashPassword(body.password);
    }
    // Only reject if there are no User-model fields AND no profile/services fields in the body
    if (Object.keys(updateData).length === 0 && !body.interestedServices && Object.keys(body).length === 0) {
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
      if (user.parentAccountId) {
        const profileData: any = {};

        if (Array.isArray(body.interestedServices)) {
          if (body.interestedServices.some((s: string) => !validServices.includes(s))) {
            throw new BadRequestException("Invalid service selection");
          }
          profileData.interestedServices = body.interestedServices;
        }

        // All editable IntendedParentProfile string fields from account page
        const stringProfileFields = [
          "journeyStage", "eggSource", "spermSource", "carrier",
          "clinicPriority", "currentClinicName", "currentAgencyName", "currentAttorneyName",
          "surrogateCountries", "surrogateTermination", "surrogateTwins",
          "surrogateAgeRange", "surrogateBudget", "surrogateExperience", "surrogateMedPrefs",
          "surrogateRace", "surrogateEthnicity", "surrogateRelationship",
          "surrogateBmiRange", "surrogateTotalCostRange",
          "donorPreferences", "donorEyeColor", "donorHairColor", "donorHeight",
          "donorEducation", "donorEthnicity", "spermDonorType", "spermDonorPreferences",
          "spermDonorAgeRange", "spermDonorEyeColor", "spermDonorHairColor",
          "spermDonorHeightRange", "spermDonorRace", "spermDonorEthnicity", "spermDonorEducation", "spermDonorVialType",
          "eggDonorAgeRange", "eggDonorCompensationRange", "eggDonorTotalCostRange", "eggDonorLotCostRange",
          "eggDonorEggType", "eggDonorDonationType",
          "clinicAgeGroup", "clinicPriorityTags",
          "surrogateLiveBirthsRange",
          "insurance",
        ];
        for (const field of stringProfileFields) {
          if (body[field] !== undefined) profileData[field] = body[field] || null;
        }

        // costProgramsPreference is a controlled enum: null | "tailored"
        // | "show_all". The provider-profile tailor form writes "tailored"
        // when the parent answers and "show_all" when they tick skip; both
        // values stop us from re-rendering the form on future provider
        // profiles.
        if (body.costProgramsPreference !== undefined) {
          const pref = body.costProgramsPreference;
          if (pref !== null && pref !== "tailored" && pref !== "show_all" && pref !== "") {
            throw new BadRequestException(
              "costProgramsPreference must be 'tailored', 'show_all', or null",
            );
          }
          profileData.costProgramsPreference = pref || null;
        }

        // Non-nullable booleans (schema: Boolean @default(false)) - skip null to avoid Prisma error
        const nonNullableBoolFields = ["hasEmbryos", "embryosTested", "needsClinic", "needsEggDonor", "needsSurrogate"];
        for (const field of nonNullableBoolFields) {
          if (body[field] !== undefined) {
            const val = body[field] === true || body[field] === "true" ? true : (body[field] === false || body[field] === "false" ? false : null);
            if (val !== null) profileData[field] = val;
          }
        }
        // Nullable booleans (schema: Boolean?) - null allowed to clear the value
        const nullableBoolFields = [
          "isFirstIvf", "sameSexCouple",
          "surrogateCovidVaccinated", "surrogateSelectiveReduction", "surrogateInternationalParents",
          "spermDonorCovidVaccinated",
        ];
        for (const field of nullableBoolFields) {
          if (body[field] !== undefined) {
            profileData[field] = body[field] === true || body[field] === "true" ? true : (body[field] === false || body[field] === "false" ? false : null);
          }
        }

        // embryoCount is non-nullable (Int @default(0)) - null/empty maps to 0
        if (body.embryoCount !== undefined) {
          if (body.embryoCount === null || body.embryoCount === "") {
            profileData.embryoCount = 0;
          } else {
            const num = parseInt(String(body.embryoCount), 10);
            if (!isNaN(num) && num >= 0) profileData.embryoCount = num;
          }
        }

        // Nullable int fields
        const nullableIntFields = [
          "surrogateMaxCSections", "surrogateMaxMiscarriages",
          "surrogateMaxAbortions", "surrogateLastDeliveryYear",
          "spermDonorMaxPrice",
        ];
        for (const field of nullableIntFields) {
          if (body[field] !== undefined) {
            if (body[field] === null || body[field] === "") {
              profileData[field] = null;
            } else {
              const num = parseInt(String(body[field]), 10);
              if (!isNaN(num) && num >= 0) profileData[field] = num;
            }
          }
        }

        if (Object.keys(profileData).length > 0) {
          // Filter out null values for non-nullable fields to avoid Prisma errors on create
          const createData = Object.fromEntries(
            Object.entries(profileData).filter(([, v]) => v !== null)
          );
          await tx.intendedParentProfile.upsert({
            where: { parentAccountId: user.parentAccountId },
            create: {
              parentAccount: { connect: { id: user.parentAccountId } },
              ...createData,
            },
            update: profileData,
          });
        }
      }
    });

    const enriched = await this.authService.getUserWithProvider(user.id);
    const result = enriched || {};
    const { password: _, ...safe } = result;

    // Notify all providers with active sessions + GoStork admins so open chat views refresh
    this.emitProfileUpdated(user.id).catch(() => {});

    return safe;
  }

  private async emitProfileUpdated(parentUserId: string): Promise<void> {
    const [sessions, admins] = await Promise.all([
      this.prisma.aiChatSession.findMany({
        where: { userId: parentUserId },
        select: { provider: { select: { users: { select: { id: true } } } } },
      }),
      this.prisma.user.findMany({
        where: { roles: { has: "GOSTORK_ADMIN" } },
        select: { id: true },
      }),
    ]);

    const providerUserIds = sessions.flatMap(
      (s) => s.provider?.users.map((u) => u.id) ?? [],
    );
    const adminIds = admins.map((u) => u.id);
    const targetUserIds = [...new Set([...providerUserIds, ...adminIds])].filter(
      (id) => id !== parentUserId,
    );

    if (targetUserIds.length === 0) return;

    await this.appEvents.emit({
      type: "user_profile_updated",
      payload: { userId: parentUserId },
      targetUserIds,
      actorUserId: parentUserId,
    });
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
  @ApiResponse({ status: 403, description: "Forbidden - GoStork team only", type: ErrorResponseDto })
  async listUsers(@Req() req: Request) {
    const user = req.user as any;
    const gostorkRoles = ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE", "GOSTORK_DEVELOPER"];
    if (!user.roles?.some((r: string) => gostorkRoles.includes(r))) {
      throw new ForbiddenException("GoStork team only");
    }
    const users = await this.prisma.user.findMany({
      select: {
        id: true, email: true, name: true, photoUrl: true, mobileNumber: true, mobileNumberDisplay: true, city: true, state: true, country: true, roles: true, providerId: true, allLocations: true, createdAt: true, dailyRoomUrl: true, calendarLink: true, isDisabled: true,
        provider: { select: { id: true, name: true } },
        assignedLocations: { include: { location: true } },
        calendarConnections: { select: { id: true, provider: true, email: true, label: true, tokenValid: true, connected: true }, orderBy: { createdAt: "desc" } },
        scheduleConfig: { select: { bookingPageSlug: true } },
      },
      orderBy: { email: "asc" },
    });
    return users;
  }

  @Get("gostork/users")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List GoStork team members (GoStork team only)" })
  @ApiResponse({ status: 200, description: "List of GoStork team members", type: [UserResponseDto] })
  @ApiResponse({ status: 403, description: "Forbidden - GoStork team only", type: ErrorResponseDto })
  async listGostorkUsers(@Req() req: Request) {
    const user = req.user as any;
    const gostorkRoles = ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE", "GOSTORK_DEVELOPER"];
    if (!user.roles?.some((r: string) => gostorkRoles.includes(r))) {
      throw new ForbiddenException("GoStork team only");
    }
    const users = await this.prisma.user.findMany({
      where: { roles: { hasSome: gostorkRoles as any } },
      select: {
        id: true, email: true, name: true, photoUrl: true, mobileNumber: true, mobileNumberDisplay: true, city: true, state: true, country: true, roles: true, providerId: true, allLocations: true, createdAt: true, dailyRoomUrl: true, calendarLink: true, isDisabled: true,
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
  @ApiResponse({ status: 403, description: "Forbidden - GoStork team only", type: ErrorResponseDto })
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
        id: true, email: true, name: true, photoUrl: true, mobileNumber: true, mobileNumberDisplay: true, city: true, state: true, country: true, roles: true,
        providerId: true, allLocations: true, createdAt: true, dailyRoomUrl: true, calendarLink: true, parentAccountRole: true, isDisabled: true,
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
      const dailyRoomUrl = await this.provisionVideoRoom(created.id, roles);
      const { password: _, ...safe } = created;
      return { ...safe, dailyRoomUrl: dailyRoomUrl ?? safe.dailyRoomUrl };
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

  // GoStork admin Parents page: journey aggregates per parent across ALL
  // providers (services interested, cost sheets, invoices, agreements,
  // last activity). Joined client-side with the /api/users list.
  @Get("admin/parents-overview")
  @UseGuards(SessionOrJwtGuard)
  async adminParentsOverview(@Req() req: Request) {
    const user = req.user as any;
    const roles: string[] = user?.roles || [];
    if (!roles.includes("GOSTORK_ADMIN") && !roles.includes("GOSTORK_CONCIERGE")) {
      throw new ForbiddenException("GoStork admin only");
    }
    const parents = await this.prisma.user.findMany({
      where: { roles: { has: "PARENT" } },
      select: { id: true, name: true, parentAccountId: true },
    });
    const ids = parents.map(p => p.id);
    const accountIds = Array.from(new Set(parents.map(p => p.parentAccountId).filter(Boolean))) as string[];
    // "Updated" = the parent's most recent journey activity (their latest
    // chat-session update) - User itself has no updatedAt column.
    const latestSessions = ids.length
      ? await this.prisma.aiChatSession.groupBy({
          by: ["userId"],
          where: { userId: { in: ids } },
          _max: { updatedAt: true },
        })
      : [];
    const lastActivityByUser = new Map(latestSessions.map((r: any) => [r.userId, r._max.updatedAt]));

    const [profiles, quotes, invoices, agreements] = await Promise.all([
      accountIds.length
        ? this.prisma.intendedParentProfile.findMany({
            where: { parentAccountId: { in: accountIds } },
            select: { parentAccountId: true, interestedServices: true },
          })
        : [],
      ids.length
        ? this.prisma.providerQuote.findMany({
            where: { parentUserId: { in: ids } },
            select: { id: true, parentUserId: true, sessionId: true, totalCostCents: true, supersededAt: true, parentAcknowledgedAt: true, createdAt: true },
            orderBy: { createdAt: "desc" },
          })
        : [],
      ids.length
        ? this.prisma.invoice.findMany({
            where: { parentUserId: { in: ids } },
            select: { id: true, parentUserId: true, serviceType: true, serviceAmount: true, status: true },
            orderBy: { createdAt: "desc" },
          })
        : [],
      ids.length
        ? this.prisma.agreement.findMany({
            where: { parentUserId: { in: ids } },
            select: { id: true, parentUserId: true, status: true, documentType: true, createdAt: true },
            orderBy: { createdAt: "desc" },
          })
        : [],
    ]);
    // Most-advanced journey status per parent across ALL their sessions -
    // same ladder as the provider Parents table.
    const sessions = ids.length
      ? await this.prisma.aiChatSession.findMany({
          where: { userId: { in: ids }, status: { in: ["CONSULTATION_BOOKED", "PROVIDER_CONNECTED"] } },
          select: { userId: true, status: true, subjectProfileId: true, subjectType: true, handoffCompletedAt: true },
        })
      : [];
    const matchCallUsers = new Set(
      ids.length
        ? (await this.prisma.booking.findMany({
            where: { parentUserId: { in: ids }, meetingSubtype: "MATCH_CALL", status: { notIn: ["CANCELLED", "DECLINED", "RESCHEDULED", "EXPIRED"] } },
            select: { parentUserId: true },
          })).map(b => b.parentUserId)
        : [],
    );
    const overviewSurrogateIds = sessions
      .filter(cs => (cs.subjectType || "").toLowerCase().includes("surrog") && cs.subjectProfileId)
      .map(cs => cs.subjectProfileId as string);
    const overviewMatched = overviewSurrogateIds.length
      ? await this.prisma.surrogate.findMany({
          where: { id: { in: overviewSurrogateIds }, status: "MATCHED" },
          select: { id: true, reservedByParentId: true },
        })
      : [];
    const overviewMatchedById = new Map(overviewMatched.map(su => [su.id, su.reservedByParentId]));
    // Evidence for the two rungs this ladder never had. Same predicates the
    // journey timeline uses, so the column and the timeline agree.
    const consultCompletedUsers = new Set(
      ids.length
        ? (await this.prisma.booking.findMany({
            where: {
              parentUserId: { in: ids },
              meetingSubtype: { not: "MATCH_CALL" },
              outcome: { in: ["COMPLETED", "UNVERIFIED"] },
            },
            select: { parentUserId: true },
          })).map(b => b.parentUserId)
        : [],
    );
    const submittedFormAccounts = new Set(
      (await this.prisma.ipFormResponse.findMany({
        where: { status: "SUBMITTED" },
        select: { parentAccountId: true },
      })).map(f => f.parentAccountId),
    );
    const accountKeyOf = new Map(parents.map((p: any) => [p.id, p.parentAccountId || p.id]));

    // ONE ladder, shared with the journey timeline - see
    // shared/journey-ladder.ts. The old local LADDER const had no rung for a
    // completed consultation or a submitted form, so the Match Status column
    // lagged the timeline that renders beside it.
    const rank = (st: string | null) => (st ? (JOURNEY_STAGE_ORDER as readonly string[]).indexOf(st) : -1);
    const statusByUser = new Map<string, string>();
    const bump = (userId: string, st: string | null) => {
      if (!st) return;
      if (rank(st) > rank(statusByUser.get(userId) || null)) statusByUser.set(userId, st);
    };
    for (const cs of sessions) {
      bump(cs.userId, LEGACY_MATCH_STATUS_TO_STAGE[cs.status] || null);
      if (cs.handoffCompletedAt) bump(cs.userId, "handed_off");
      if (cs.subjectProfileId && overviewMatchedById.get(cs.subjectProfileId) === cs.userId) bump(cs.userId, "matched");
    }
    for (const uid of Array.from(consultCompletedUsers)) { if (uid) bump(uid as string, "consult_completed"); }
    for (const [uid, key] of Array.from(accountKeyOf.entries())) {
      if (submittedFormAccounts.has(key as string)) bump(uid as string, "ip_form_submitted");
    }
    for (const uid of Array.from(matchCallUsers)) { if (uid) bump(uid as string, "match_call_scheduled"); }
    for (const inv of invoices) { bump(inv.parentUserId, inv.status === "PAID" ? "invoice_paid" : "invoice_sent"); }
    for (const a of agreements) { bump(a.parentUserId, a.status === "SIGNED" ? "agreement_signed" : "agreement_sent"); }

    const servicesByAccount = new Map(profiles.map((pr: any) => [pr.parentAccountId, pr.interestedServices || []]));

    // Services fallback: parents who never finished onboarding have no
    // IntendedParentProfile row, so the profile-based services list comes
    // back empty even though their chat sessions say exactly what they
    // are looking for. Derive from session subjectType in that case
    // (display only - the profile itself stays untouched). Labels match
    // the profile vocabulary: Surrogate / Egg Donor / Sperm Donor /
    // Fertility Clinic.
    const subjectRows = ids.length
      ? await this.prisma.aiChatSession.findMany({
          where: { userId: { in: ids }, subjectType: { not: null } },
          select: { userId: true, subjectType: true },
        })
      : [];
    const SUBJECT_SERVICE_LABELS: [RegExp, string][] = [
      [/egg/i, "Egg Donor"],
      [/surrog/i, "Surrogate"],
      [/sperm/i, "Sperm Donor"],
      [/ivf|clinic|doctor/i, "Fertility Clinic"],
    ];

    /**
     * The admin and provider parents tables used to speak different service
     * vocabularies: this endpoint emitted human labels ("Surrogate",
     * "Fertility Clinic") from IntendedParentProfile.interestedServices, while
     * parent-contacts emitted enum keys (SURROGACY, IVF_CLINIC). The two
     * filters therefore had to work differently - substring match here,
     * equality there - and the same dropdown behaved differently per role.
     *
     * Normalise to the enum keys at the API boundary rather than migrating the
     * stored values: interestedServices is user-facing text shown verbatim on
     * the parent profile card, so rewriting it would change what parents see.
     */
    const SERVICE_KEY_BY_LABEL: [RegExp, string][] = [
      [/egg/i, "EGG_DONATION"],
      [/surrog/i, "SURROGACY"],
      [/sperm/i, "SPERM_DONATION"],
      [/ivf|clinic|doctor/i, "IVF_CLINIC"],
    ];
    const toServiceKeys = (labels: string[]): string[] =>
      Array.from(new Set(
        (labels || [])
          .map((l) => SERVICE_KEY_BY_LABEL.find(([re]) => re.test(l))?.[1])
          .filter(Boolean) as string[],
      ));
    const chatServicesByUser = new Map<string, string[]>();
    for (const r of subjectRows) {
      const label = SUBJECT_SERVICE_LABELS.find(([re]) => re.test(r.subjectType || ""))?.[1];
      if (!label) continue;
      const list = chatServicesByUser.get(r.userId) || [];
      if (!list.includes(label)) list.push(label);
      chatServicesByUser.set(r.userId, list);
    }

    // CRM state (owner / next step / tags), three indexed reads.
    //
    // NOTE the separate key array. `accountIds` above is deliberately non-null
    // only, because it feeds IntendedParentProfile whose parentAccountId is a
    // real FK - a solo parent has no row there. The CRM tables carry NO FK and
    // key on parentAccountKey (parentAccountId ?? userId), so widening that
    // array would have queried garbage while narrowing this one would silently
    // render every solo parent as unassigned.
    const crmKeys = Array.from(new Set(parents.map(p => p.parentAccountId || p.id)));
    const [crmOwners, crmFollowUps, crmTags, ipForms] = crmKeys.length
      ? await Promise.all([
          this.prisma.parentOwner.findMany({
            where: { parentAccountId: { in: crmKeys } },
            select: { parentAccountId: true, scope: true, ownerUserId: true, ownerName: true },
          }),
          this.prisma.parentFollowUp.findMany({
            where: { parentAccountId: { in: crmKeys }, status: "OPEN" },
            select: { parentAccountId: true, id: true, scope: true, providerId: true, body: true, dueAt: true },
            orderBy: { dueAt: "asc" },
          }),
          this.prisma.parentTagAssignment.findMany({
            where: { parentAccountId: { in: crmKeys } },
            select: {
              parentAccountId: true, tagId: true,
              tag: { select: { label: true, colorToken: true } },
            },
          }),
          // Whether the family completed their Intended Parent form. Keyed on
          // parentAccountId, the same parentAccountKey the CRM tables use.
          this.prisma.ipFormResponse.findMany({
            where: { parentAccountId: { in: crmKeys } },
            select: { parentAccountId: true, status: true },
          }),
        ])
      : [[], [], [], []];
    const ipFormByKey = new Map((ipForms as any[]).map((f: any) => [f.parentAccountId, f.status]));

    // The owner row snapshots the name (so a rename never blanks a byline) but
    // not the photo - a photo snapshot goes stale the moment someone changes
    // theirs. Resolve it live; a missing photo falls back to initials.
    const ownerPhotoById = new Map<string, string | null>();
    {
      const ids = Array.from(new Set(crmOwners.map((o: any) => o.ownerUserId).filter(Boolean)));
      if (ids.length) {
        const us = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, photoUrl: true } });
        for (const u of us) ownerPhotoById.set(u.id, u.photoUrl);
      }
    }
    const ownerByKey = new Map<string, any>();
    for (const o of crmOwners) if (o.scope === "GOSTORK") ownerByKey.set(o.parentAccountId, o);
    const nextStepByKey = new Map<string, any>();
    for (const f of crmFollowUps) {
      // The GoStork step is the one the admin table sorts on; an org's step is
      // that org's business. Earliest due wins, and the query is already sorted.
      if (f.scope === "GOSTORK" && !nextStepByKey.has(f.parentAccountId)) nextStepByKey.set(f.parentAccountId, f);
    }
    const tagsByKey = new Map<string, any[]>();
    for (const t of crmTags) {
      const list = tagsByKey.get(t.parentAccountId) || [];
      list.push({ tagId: t.tagId, label: t.tag?.label ?? "", colorToken: t.tag?.colorToken ?? "accent" });
      tagsByKey.set(t.parentAccountId, list);
    }
    const nowMs = Date.now();

    const overview: Record<string, any> = {};
    for (const parent of parents) {
      const profileServices = parent.parentAccountId ? (servicesByAccount.get(parent.parentAccountId) || []) : [];
      const crmKey = parent.parentAccountId || parent.id;
      const owner = ownerByKey.get(crmKey);
      const step = nextStepByKey.get(crmKey);
      const svcLabels = profileServices.length ? profileServices : (chatServicesByUser.get(parent.id) || []);
      overview[parent.id] = {
        services: svcLabels,
        // Enum keys, so the admin table filters exactly like the provider one.
        serviceKeys: toServiceKeys(svcLabels),
        costSheets: [],
        invoices: [],
        agreements: [],
        updatedAt: lastActivityByUser.get(parent.id) || null,
        matchStatus: statusByUser.get(parent.id) || null,
        ipFormStatus: ipFormByKey.get(crmKey) ?? null,
        owner: owner ? { userId: owner.ownerUserId, name: owner.ownerName, photoUrl: ownerPhotoById.get(owner.ownerUserId) ?? null } : null,
        nextStep: step
          ? { id: step.id, body: step.body, dueAt: step.dueAt, overdue: new Date(step.dueAt).getTime() < nowMs }
          : null,
        tags: tagsByKey.get(crmKey) || [],
      };
    }
    for (const q of quotes) overview[q.parentUserId]?.costSheets.push(q);
    for (const inv of invoices) overview[inv.parentUserId]?.invoices.push(inv);
    for (const a of agreements) overview[a.parentUserId]?.agreements.push(a);

    // Shared-account (couple) rollup: partners on the same parentAccountId
    // share one journey, so each member's row shows the ACCOUNT's
    // aggregates - the same match status, activity, cost sheets, invoices,
    // and agreements regardless of which login the artifact was stamped
    // with. `household` lets the UI badge the logins as one family.
    const membersByAccount = new Map<string, typeof parents>();
    for (const p of parents) {
      if (!p.parentAccountId) continue;
      const list = membersByAccount.get(p.parentAccountId) || [];
      list.push(p);
      membersByAccount.set(p.parentAccountId, list);
    }
    const latestOf = (dates: any[]) =>
      dates.filter(Boolean).sort((a, b) => new Date(a).getTime() - new Date(b).getTime()).pop() || null;
    const byCreatedDesc = (a: any, b: any) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    for (const members of Array.from(membersByAccount.values())) {
      if (members.length < 2) continue;
      const memberIds = members.map(m => m.id);
      const bestStatus = memberIds
        .map(id => overview[id]?.matchStatus || null)
        .reduce((best, st) => (rank(st) > rank(best) ? st : best), null as string | null);
      const latest = latestOf(memberIds.map(id => overview[id]?.updatedAt));
      const costSheetsMerged = memberIds.flatMap(id => overview[id]?.costSheets || []).sort(byCreatedDesc);
      const invoicesMerged = memberIds.flatMap(id => overview[id]?.invoices || []);
      const agreementsMerged = memberIds.flatMap(id => overview[id]?.agreements || []).sort(byCreatedDesc);
      const servicesMerged = Array.from(new Set(memberIds.flatMap(id => overview[id]?.services || [])));
      const serviceKeysMerged = Array.from(new Set(memberIds.flatMap(id => overview[id]?.serviceKeys || [])));
      const household = { memberIds, memberNames: members.map(m => m.name || "") };
      for (const id of memberIds) {
        if (!overview[id]) continue;
        overview[id].matchStatus = bestStatus;
        overview[id].updatedAt = latest;
        overview[id].costSheets = costSheetsMerged;
        overview[id].invoices = invoicesMerged;
        overview[id].agreements = agreementsMerged;
        overview[id].services = servicesMerged;
        overview[id].serviceKeys = serviceKeysMerged;
        overview[id].household = household;
      }
    }
    return overview;
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

    // Parent-level aggregates we display on every row that belongs to that
    // parent (meeting count + last meeting + source flavor). These are
    // shared across all chat-session rows for the same parent.
    const bookings = await this.prisma.booking.findMany({
      where: {
        providerUserId: { in: staffIds },
        parentUserId: { not: null },
      },
      select: {
        meetingSubtype: true,
        status: true,
        // Proves the consult_completed rung, exactly as journey-timeline does.
        outcome: true,
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

    // Each chat session = one match between this parent and this provider.
    // A parent can have multiple sessions (e.g. one for Surrogacy Q&A, one
    // for Egg Donation Q&A) and each has its own status + invoices. So we
    // return one row per session - never collapse sessions into a single
    // parent row.
    //
    // IMPORTANT: only surface sessions where the parent has actually
    // committed to a consultation. ACTIVE sessions are anonymous "whisper"
    // Q&A - the parent is intentionally masked as "Prospective Parent"
    // and the agency is not supposed to see any identifying info until
    // the parent books a call. Including ACTIVE rows here would leak
    // contacts the parent hasn't agreed to share. So we filter to
    // CONSULTATION_BOOKED (call scheduled, identity revealed) and
    // PROVIDER_CONNECTED (agency has chatted directly post-call).
    //
    // Widened for contact releases: an IP-form-only or invoice-only pair has
    // legitimately shared their details with this provider and must appear here
    // even if their session never left ACTIVE.
    const releasedAccounts = await releasedAccountIds(providerId, this.prisma);
    const chatSessions = await this.prisma.aiChatSession.findMany({
      where: {
        providerId,
        OR: [
          { status: { in: ["CONSULTATION_BOOKED", "PROVIDER_CONNECTED"] } },
          ...(releasedAccounts.length
            ? [{ user: { OR: [{ parentAccountId: { in: releasedAccounts } }, { id: { in: releasedAccounts } }] } }]
            : []),
        ],
      },
      select: {
        id: true,
        userId: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        providerJoinedAt: true,
        subjectProfileId: true,
        subjectType: true,
        handoffCompletedAt: true,
        user: {
          select: {
            id: true, name: true, email: true, mobileNumber: true, photoUrl: true, createdAt: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    // Journey-stage inputs: the chat-session status stops at
    // PROVIDER_CONNECTED, but the journey continues (match call -> official
    // match -> deposit -> agreement signed). Derive the most-advanced stage
    // per session from the same facts the automations write.
    const surrogateIds = chatSessions
      .filter(cs => (cs.subjectType || "").toLowerCase().includes("surrog") && cs.subjectProfileId)
      .map(cs => cs.subjectProfileId as string);
    const matchedSurrogates = surrogateIds.length
      ? await this.prisma.surrogate.findMany({
          where: { id: { in: surrogateIds }, status: "MATCHED" },
          select: { id: true, reservedByParentId: true },
        })
      : [];
    const matchedSurrogateById = new Map(matchedSurrogates.map(su => [su.id, su.reservedByParentId]));

    // Shared-account (couple) resolution: partners on the same
    // parentAccountId share the chat session and the journey, so every
    // aggregate below is keyed by ACCOUNT (falling back to the login id
    // for solo parents) - never by the individual login. Otherwise a
    // couple fragments into two rows: the session sits on whoever started
    // the chat while a Match Call booked by the partner lands on a
    // separate meeting-only row with no status.
    const involvedUserIds = new Set<string>();
    for (const b of bookings) if (b.parentUserId) involvedUserIds.add(b.parentUserId);
    for (const cs of chatSessions) if (cs.userId) involvedUserIds.add(cs.userId);
    for (const rid of Array.from(matchedSurrogateById.values())) if (rid) involvedUserIds.add(rid);
    const involvedUsers = involvedUserIds.size
      ? await this.prisma.user.findMany({
          where: { id: { in: Array.from(involvedUserIds) } },
          select: { id: true, parentAccountId: true },
        })
      : [];
    const accountIdByUser = new Map<string, string | null>(involvedUsers.map(u => [u.id, u.parentAccountId]));
    const accountIds = Array.from(new Set(involvedUsers.map(u => u.parentAccountId).filter(Boolean))) as string[];
    const accountMembersList = accountIds.length
      ? await this.prisma.user.findMany({
          where: { parentAccountId: { in: accountIds }, roles: { has: "PARENT" } },
          select: { id: true, name: true, email: true, mobileNumber: true, photoUrl: true, createdAt: true, parentAccountId: true },
          orderBy: { createdAt: "asc" },
        })
      : [];
    const membersByAccount = new Map<string, any[]>();
    for (const m of accountMembersList) {
      const list = membersByAccount.get(m.parentAccountId as string) || [];
      list.push(m);
      membersByAccount.set(m.parentAccountId as string, list);
      accountIdByUser.set(m.id, m.parentAccountId);
    }
    const accountKey = (userId: string) => {
      const acctId = accountIdByUser.get(userId);
      return acctId ? `acct-${acctId}` : `user-${userId}`;
    };
    // All logins on the row's account, primary (the one the row's session
    // or booking belongs to) first so the spread `...primary` fields and
    // the /parents/:id navigation target stay stable.
    const membersFor = (userId: string, fallbackUser: any) => {
      const acctId = accountIdByUser.get(userId);
      const members = (acctId ? membersByAccount.get(acctId) : null) || [];
      if (members.length === 0) return fallbackUser ? [fallbackUser] : [];
      return [...members].sort((a, b) => (a.id === userId ? -1 : b.id === userId ? 1 : 0));
    };
    const toMemberDto = (m: any) => ({ id: m.id, name: m.name, email: m.email, mobileNumber: m.mobileNumber, photoUrl: m.photoUrl });

    // Parent-level aggregates (meeting count + last meeting), shared by
    // every row that belongs to the same account.
    type ParentAgg = {
      parentUser: any;
      lastMeetingAt: Date | null;
      meetingCount: number;
      hasMeeting: boolean;
    };
    const parentAgg = new Map<string, ParentAgg>();
    for (const b of bookings) {
      if (!b.parentUserId || !b.parentUser) continue;
      const key = accountKey(b.parentUserId);
      const existing = parentAgg.get(key);
      if (!existing) {
        parentAgg.set(key, {
          parentUser: b.parentUser,
          lastMeetingAt: b.scheduledAt,
          meetingCount: 1,
          hasMeeting: true,
        });
      } else {
        existing.meetingCount += 1;
        // bookings are ordered scheduledAt desc, so the first one we saw
        // is already the latest - no update needed.
      }
    }

    const matchCallAccounts = new Set(
      bookings
        .filter((b: any) => b.meetingSubtype === "MATCH_CALL" && !["CANCELLED", "DECLINED", "RESCHEDULED", "EXPIRED"].includes(b.status))
        .map((b: any) => (b.parentUserId ? accountKey(b.parentUserId) : null))
        .filter(Boolean),
    );
    // Scoped to the accounts on this page rather than every submitted form.
    const ipFormKeys = Array.from(new Set(chatSessions.map((cs: any) => cs.userId).filter(Boolean).map((id: string) => accountKey(id))));
    const ipFormSubmittedAccounts = new Set(
      ipFormKeys.length
        ? (await this.prisma.ipFormResponse.findMany({
            where: { parentAccountId: { in: ipFormKeys }, status: "SUBMITTED" },
            select: { parentAccountId: true },
          })).map((f: any) => f.parentAccountId)
        : [],
    );

    // Same predicate journey-timeline uses, so the column and the timeline
    // cannot disagree about whether a call actually happened.
    const consultCompletedAccounts = new Set(
      bookings
        .filter((b: any) => b.meetingSubtype !== "MATCH_CALL" && (b.outcome === "COMPLETED" || b.outcome === "UNVERIFIED"))
        .map((b: any) => (b.parentUserId ? accountKey(b.parentUserId) : null))
        .filter(Boolean),
    );

    // Invoices grouped by sessionId so each match row only shows its own
    // invoices. Single query, in-memory grouping = no N+1.
    const sessionIds = chatSessions.map(s => s.id);
    const invoicesBySession = new Map<string, any[]>();
    if (sessionIds.length > 0) {
      const invoices = await this.prisma.invoice.findMany({
        where: {
          providerId,
          sessionId: { in: sessionIds },
        },
        select: {
          id: true,
          paymentToken: true,
          serviceType: true,
          serviceAmount: true,
          providerPayoutAmount: true,
          currency: true,
          status: true,
          stripeTransferId: true,
          payoutFailedAt: true,
          paidAt: true,
          createdAt: true,
          sessionId: true,
          parentUserId: true,
        },
        orderBy: { createdAt: "desc" },
      });
      for (const inv of invoices) {
        if (!inv.sessionId) continue;
        const list = invoicesBySession.get(inv.sessionId) || [];
        list.push(inv);
        invoicesBySession.set(inv.sessionId, list);
      }
    }

    // Cost sheets grouped by sessionId - same single-query pattern as invoices.
    const costSheetsBySession = new Map<string, any[]>();
    if (sessionIds.length > 0) {
      const quotes = await this.prisma.providerQuote.findMany({
        where: { providerId, sessionId: { in: sessionIds } },
        select: {
          id: true,
          sessionId: true,
          totalCostCents: true,
          supersededAt: true,
          parentAcknowledgedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });
      for (const q of quotes) {
        if (!q.sessionId) continue;
        const list = costSheetsBySession.get(q.sessionId) || [];
        list.push(q);
        costSheetsBySession.set(q.sessionId, list);
      }
    }

    // Agreements grouped by sessionId - same single-query pattern as invoices.
    const agreementsBySession = new Map<string, any[]>();
    if (sessionIds.length > 0) {
      const agreements = await this.prisma.agreement.findMany({
        where: {
          providerId,
          sessionId: { in: sessionIds },
        },
        select: {
          id: true,
          status: true,
          documentType: true,
          serviceType: true,
          pandaDocViewUrl: true,
          signedAt: true,
          createdAt: true,
          sessionId: true,
        },
        orderBy: { createdAt: "desc" },
      });
      for (const agr of agreements) {
        const list = agreementsBySession.get(agr.sessionId) || [];
        list.push(agr);
        agreementsBySession.set(agr.sessionId, list);
      }
    }

    // Handoff is a JOURNEY-level (parent account x provider org) fact, not a
    // per-session one: the signed agreement and paid invoice can live on two
    // different sessions of the same journey (e.g. Surrogate #24054 signed,
    // #25714 paid). Any handed-off session marks the whole account handed
    // off with this provider - matching the timeline's org-level bucketing.
    const handedOffAccounts = new Set<string>();
    for (const cs of chatSessions) {
      if (cs.userId && cs.handoffCompletedAt) handedOffAccounts.add(accountKey(cs.userId));
    }

    // Build the rows: one per chat session.
    const rows: any[] = [];
    const accountsWithSession = new Set<string>();
    for (const cs of chatSessions) {
      if (!cs.userId || !cs.user) continue;
      const key = accountKey(cs.userId);
      accountsWithSession.add(key);
      const agg = parentAgg.get(key);
      const rowMembers = membersFor(cs.userId, cs.user);
      const rowInvoices = invoicesBySession.get(cs.id) || [];
      const rowAgreements = agreementsBySession.get(cs.id) || [];
      // Most-advanced journey stage wins. Mirrors the 13-stage spine:
      // Connected -> Match Call -> Matched (double-yes) -> Deposit Paid ->
      // Agreement Signed (handoff).
      // ONE ladder, shared with the journey timeline - see
      // shared/journey-ladder.ts. This used to be a hand-rolled six-rung
      // chain with no rung for a completed consultation or a submitted form,
      // so a family well past both still read "Call Booked" in this column
      // while the timeline beside it showed them ticked.
      const journeyStatus = resolveJourneyStage({
        handedOff: !!cs.handoffCompletedAt || handedOffAccounts.has(key),
        agreementSigned: rowAgreements.some((a: any) => a.status === "SIGNED"),
        agreementSent: rowAgreements.length > 0,
        invoicePaid: rowInvoices.some((inv: any) => inv.status === "PAID"),
        invoiceSent: rowInvoices.length > 0,
        matched: !!(cs.subjectProfileId && matchedSurrogateById.get(cs.subjectProfileId)
          && accountKey(matchedSurrogateById.get(cs.subjectProfileId) as string) === key),
        matchCallScheduled: matchCallAccounts.has(key),
        ipFormSubmitted: ipFormSubmittedAccounts.has(key),
        consultCompleted: consultCompletedAccounts.has(key),
        consultScheduled: cs.status === "CONSULTATION_BOOKED",
        connected: cs.status === "PROVIDER_CONNECTED" || !!cs.providerJoinedAt,
      });

      rows.push({
        // Stable React key - use sessionId so multiple matches for the
        // same parent get distinct rows.
        rowId: cs.id,
        sessionId: cs.id,
        matchStatus: journeyStatus,
        chatStartedAt: cs.providerJoinedAt || cs.createdAt,
        // Parent fields are duplicated on every row that belongs to the
        // parent. UI keeps them visible per row so each row reads
        // standalone in the scan-down direction.
        ...cs.user,
        // Couples: `name` becomes the combined household name and
        // `members` carries each login's contact info so the table can
        // show both partners on the one row.
        name: combineParentNames(rowMembers) || cs.user.name,
        members: rowMembers.map(toMemberDto),
        lastMeetingAt: agg?.lastMeetingAt || null,
        meetingCount: agg?.meetingCount || 0,
        source: agg?.hasMeeting ? "both" : "chat",
        invoices: invoicesBySession.get(cs.id) || [],
        agreements: agreementsBySession.get(cs.id) || [],
        costSheets: costSheetsBySession.get(cs.id) || [],
        // The service this match/session is about (from the session subject)
        serviceType: (() => {
          const st = (cs.subjectType || "").toLowerCase();
          if (st.includes("egg")) return "EGG_DONATION";
          if (st.includes("surrog")) return "SURROGACY";
          if (st.includes("sperm")) return "SPERM_DONATION";
          if (st.includes("ivf") || st.includes("clinic") || st.includes("doctor")) return "IVF_CLINIC";
          return null;
        })(),
        sessionCreatedAt: cs.createdAt,
        sessionUpdatedAt: cs.updatedAt,
      });
    }

    // Meeting-only parents (had a booking with us but never opened a
    // chat) still get one row each, with no session-level fields.
    for (const [key, agg] of parentAgg) {
      if (accountsWithSession.has(key)) continue;
      const aggMembers = membersFor(agg.parentUser.id, agg.parentUser);
      rows.push({
        rowId: `meeting-${key}`,
        sessionId: null,
        matchStatus: null,
        chatStartedAt: null,
        ...agg.parentUser,
        name: combineParentNames(aggMembers) || agg.parentUser.name,
        members: aggMembers.map(toMemberDto),
        lastMeetingAt: agg.lastMeetingAt,
        meetingCount: agg.meetingCount,
        source: "meeting",
        invoices: [],
        agreements: [],
        costSheets: [],
        serviceType: null,
        sessionCreatedAt: null,
        sessionUpdatedAt: null,
      });
    }

    // ── The two gates, applied once over every row ──────────────────────────
    //
    // One pass rather than two, because the chat-session rows and the
    // meeting-only rows both build their contact fields by spreading a raw
    // `user` (`...cs.user` / `...agg.parentUser`) and would otherwise need
    // identical treatment in two places.
    //
    // The meeting-only half had NO gate at all: a parent who booked through a
    // public booking page handed over name, email and mobile with nothing in
    // between. A booking now opens Gate A (they chose to meet) and never Gate B.
    //
    // Gate A must be fed the RAW chat-session status. `row.matchStatus` is the
    // DERIVED journey ladder built above (HANDED_OFF, AGREEMENT_SIGNED,
    // DEPOSIT_PAID, MATCHED, MATCH_CALL), and none of those promoted strings
    // are in the resolver's IDENTITY_STATUSES. Passing it here closed Gate A on
    // the most advanced parents in the table and dropped them at the filter
    // below. Most rungs were rescued by accident - an invoice or agreement
    // implies a release row, a MATCH_CALL implies a booking - but MATCHED was a
    // live failure: an agency sets Surrogate.status itself, so a
    // PROVIDER_CONNECTED parent could vanish from their own agency's table.
    //
    // NOTE: gateKeyFor returns `parentAccountId ?? userId`, matching
    // parentAccountKey - the key release rows are written under. It is NOT the
    // local accountKey() above, which returns a prefixed `acct-<id>` /
    // `user-<id>` grouping key. The two look interchangeable and are not.
    const gateKeyFor = (userId: string) => accountIdByUser.get(userId) || userId;
    const rawStatusesByAccount = new Map<string, string[]>();
    for (const cs of chatSessions) {
      if (!cs.userId) continue;
      const k = gateKeyFor(cs.userId);
      const list = rawStatusesByAccount.get(k) || [];
      list.push(cs.status);
      rawStatusesByAccount.set(k, list);
    }
    const bookingAccounts = new Set(
      rows
        .filter((r: any) => !!r.lastMeetingAt || r.source === "meeting")
        .map((r: any) => gateKeyFor(r.id)),
    );
    const gateKeys = Array.from(new Set(rows.map((r: any) => gateKeyFor(r.id))));
    const rowGates = await resolveParentGatesBatch(
      providerId,
      gateKeys.map((k) => ({
        accountKey: k,
        sessionStatus: null,
        siblingStatuses: rawStatusesByAccount.get(k) || [],
        hasBooking: bookingAccounts.has(k),
      })),
      this.prisma,
    );
    // CRM state for this org only. Scoped in the WHERE clause, and read AFTER
    // the gate batch so it is keyed on exactly the same gateKeys - a row the
    // drop-filter below removes never gets its tags built at all.
    const [crmOwners, crmFollowUps, crmTags, ipForms] = gateKeys.length
      ? await Promise.all([
          this.prisma.parentOwner.findMany({
            where: { parentAccountId: { in: gateKeys }, scope: "PROVIDER", providerId },
            select: { parentAccountId: true, ownerUserId: true, ownerName: true },
          }),
          this.prisma.parentFollowUp.findMany({
            where: { parentAccountId: { in: gateKeys }, scope: "PROVIDER", providerId, status: "OPEN" },
            select: { parentAccountId: true, id: true, body: true, dueAt: true },
            orderBy: { dueAt: "asc" },
          }),
          this.prisma.parentTagAssignment.findMany({
            where: { parentAccountId: { in: gateKeys }, scope: "PROVIDER", providerId },
            select: { parentAccountId: true, tagId: true, tag: { select: { label: true, colorToken: true } } },
          }),
          // Not gated: whether a form exists is a workflow fact the agency
          // needs (a match call cannot be booked without it). The form's
          // CONTENTS stay behind Gate B - only the status travels here.
          this.prisma.ipFormResponse.findMany({
            where: { parentAccountId: { in: gateKeys } },
            select: { parentAccountId: true, status: true },
          }),
        ])
      : [[], [], [], []];
    const ipFormByKey = new Map((ipForms as any[]).map((f: any) => [f.parentAccountId, f.status]));
    // The partial unique indexes guarantee at most one owner and one OPEN
    // follow-up per key, so these are plain Maps with no dedup pass.
    // Same as the admin list: resolve the owner photo live rather than storing
    // a snapshot that goes stale.
    const ownerPhotoById = new Map<string, string | null>();
    {
      const ids = Array.from(new Set(crmOwners.map((o: any) => o.ownerUserId).filter(Boolean)));
      if (ids.length) {
        const us = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, photoUrl: true } });
        for (const u of us) ownerPhotoById.set(u.id, u.photoUrl);
      }
    }
    const ownerByKey = new Map(crmOwners.map((o: any) => [o.parentAccountId, o]));
    const stepByKey = new Map<string, any>();
    for (const f of crmFollowUps) if (!stepByKey.has(f.parentAccountId)) stepByKey.set(f.parentAccountId, f);
    const tagsByKey = new Map<string, any[]>();
    for (const t of crmTags as any[]) {
      const list = tagsByKey.get(t.parentAccountId) || [];
      list.push({ tagId: t.tagId, label: t.tag?.label ?? "", colorToken: t.tag?.colorToken ?? "accent" });
      tagsByKey.set(t.parentAccountId, list);
    }
    const nowMs = Date.now();

    return rows
      .map((r: any) => {
        const g = rowGates.get(gateKeyFor(r.id)) || GATES_CLOSED;
        const crmKey = gateKeyFor(r.id);
        const owner = ownerByKey.get(crmKey) as any;
        const step = stepByKey.get(crmKey);
        return {
          ...redactParentContact(r, g),
          // combineParentNames built this from the raw member names, so it has
          // to be re-derived rather than trusted.
          name: g.showIdentity ? r.name : "Prospective Parent",
          members: redactParentMembers(r.members || [], g),
          contactReleased: g.showContact,
          contactReleaseReason: g.contactReason,
          // Staff data about the parent, not parent PII, so it sits outside
          // redactParentContact - but still only on rows that survive Gate A.
          ipFormStatus: ipFormByKey.get(crmKey) ?? null,
          owner: owner ? { userId: owner.ownerUserId, name: owner.ownerName, photoUrl: ownerPhotoById.get(owner.ownerUserId) ?? null } : null,
          nextStep: step
            ? { id: step.id, body: step.body, dueAt: step.dueAt, overdue: new Date(step.dueAt).getTime() < nowMs }
            : null,
          tags: tagsByKey.get(crmKey) || [],
        };
      })
      // A row whose identity is still closed has nothing to show on a contacts
      // page: no name, no email, no phone. Drop it rather than render a row of
      // blanks that looks like a bug.
      .filter((r: any) => rowGates.get(gateKeyFor(r.id))?.showIdentity !== false);
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
        allLocations: true, dailyRoomUrl: true, calendarLink: true, isDisabled: true,
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
      const roles: string[] = Array.isArray(body.roles) ? body.roles : (input.role ? [input.role] : ["IP_IVF_COORDINATOR"]);
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
      const dailyRoomUrl = await this.provisionVideoRoom(created.id, roles);
      const { password: _, ...safe } = created;
      return { ...safe, dailyRoomUrl: dailyRoomUrl ?? safe.dailyRoomUrl };
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
      const dailyRoomUrl = await this.provisionVideoRoom(created.id, roles);
      const { password: _, ...safe } = created;
      return { ...safe, dailyRoomUrl: dailyRoomUrl ?? safe.dailyRoomUrl };
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
        city: true, state: true, country: true,
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
    @Body() body: { name?: string; email?: string; mobileNumber?: string; password?: string; city?: string; state?: string; country?: string; photoUrl?: string | null },
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
      select: { id: true, email: true, name: true, mobileNumber: true, mobileNumberDisplay: true, photoUrl: true, city: true, state: true, country: true, parentAccountRole: true },
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
    if (type === "favorite") {
      void emitJourneyEvent({ eventType: "PROFILE_FAVORITED", parentUserId: user.id, actorRole: "parent", metadata: { entityType: "donor", entityId: donorId } });
    }
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

  // --- Phase 6: saved/passed preferences for doctors (slug) + clinics (providerId) ---
  @Get("profile-preferences")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get user's saved and skipped doctor slugs and clinic IDs" })
  async getProfilePreferences(@Req() req: Request) {
    const user = req.user as any;
    const prefs = await this.prisma.userProfilePreference.findMany({
      where: { userId: user.id },
      select: { entityType: true, entityId: true, type: true },
    });
    const favoritedDoctors: string[] = [];
    const passedDoctors: string[] = [];
    const favoritedClinics: string[] = [];
    const passedClinics: string[] = [];
    const favoritedAgencies: string[] = [];
    const passedAgencies: string[] = [];
    for (const p of prefs) {
      if (p.entityType === "doctor") {
        if (p.type === "favorite") favoritedDoctors.push(p.entityId);
        else if (p.type === "skip") passedDoctors.push(p.entityId);
      } else if (p.entityType === "clinic") {
        if (p.type === "favorite") favoritedClinics.push(p.entityId);
        else if (p.type === "skip") passedClinics.push(p.entityId);
      } else if (p.entityType === "agency") {
        if (p.type === "favorite") favoritedAgencies.push(p.entityId);
        else if (p.type === "skip") passedAgencies.push(p.entityId);
      }
    }
    return { favoritedDoctors, passedDoctors, favoritedClinics, passedClinics, favoritedAgencies, passedAgencies };
  }

  @Post("profile-preferences/:entityType/:type/:entityId")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Save a doctor/clinic preference (favorite or skip)" })
  async addProfilePreference(
    @Param("entityType") entityType: string,
    @Param("type") type: string,
    @Param("entityId") entityId: string,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    if (!["doctor", "clinic", "agency"].includes(entityType)) throw new BadRequestException("Invalid entityType");
    if (!["favorite", "skip"].includes(type)) throw new BadRequestException("Invalid type");
    await this.prisma.userProfilePreference.upsert({
      where: { userId_entityType_entityId_type: { userId: user.id, entityType, entityId, type } },
      create: { userId: user.id, entityType, entityId, type },
      update: {},
    });
    if (type === "favorite") {
      void emitJourneyEvent({ eventType: "PROFILE_FAVORITED", parentUserId: user.id, actorRole: "parent", metadata: { entityType, entityId } });
    }
    return { success: true };
  }

  @Delete("profile-preferences/:entityType/:type/:entityId")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Remove a doctor/clinic preference" })
  async removeProfilePreference(
    @Param("entityType") entityType: string,
    @Param("type") type: string,
    @Param("entityId") entityId: string,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    if (!["doctor", "clinic", "agency"].includes(entityType)) throw new BadRequestException("Invalid entityType");
    if (!["favorite", "skip"].includes(type)) throw new BadRequestException("Invalid type");
    await this.prisma.userProfilePreference.deleteMany({
      where: { userId: user.id, entityType, entityId, type },
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

  private readonly ALLOWED_PROFILE_TYPES = ["egg-donor", "surrogate", "sperm-donor", "doctor", "clinic", "agency"];
  private readonly MARKETPLACE_SESSION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

  // Returns the marketplace view context for the current parent account:
  //
  //   previousVisitAt: ISO timestamp - the cutoff for the "New" badge.
  //                    A profile is "New" iff profile.createdAt > previousVisitAt
  //                    AND its id is NOT in viewedIds.
  //   viewedIds:       all profile IDs this account has interacted with
  //                    (tapped, hearted, passed, scrolled-past, or had
  //                    surfaced as a MATCH_CARD). Used to clear the New
  //                    badge per-profile on first interaction.
  //
  // Side effect: slides the watermark forward following a 30-min sliding
  // session window. If the last bump was more than 30 min ago, the parent
  // is starting a fresh session - slide marketplaceWatermarkAt to that
  // last-bump time so anything created since then shows as New. Reloads
  // within 30 min keep the existing watermark so the parent keeps seeing
  // the same set of New badges throughout a browsing session.
  @Get("parent-account/profile-views/recent")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Return the marketplace view context: previousVisitAt watermark for the 'New' badge cutoff + viewed profile IDs. Slides the watermark on a 30-min sliding-session window." })
  async getRecentProfileViews(@Req() req: Request) {
    const user = req.user as any;
    const accountId = await this.ensureParentAccountForEthnicities(user.id);
    if (!accountId) return { previousVisitAt: new Date().toISOString(), viewedIds: [] };

    const account = await this.prisma.parentAccount.findUnique({
      where: { id: accountId },
      select: { marketplaceWatermarkAt: true, marketplaceWatermarkUpdatedAt: true },
    });
    const now = new Date();
    let previousVisitAt: Date;
    if (!account || !account.marketplaceWatermarkUpdatedAt) {
      // First-ever marketplace visit for this account - nothing is "new"
      // because the parent is seeing the whole catalog for the first time.
      previousVisitAt = now;
    } else {
      const sinceLastBump = now.getTime() - account.marketplaceWatermarkUpdatedAt.getTime();
      if (sinceLastBump > this.MARKETPLACE_SESSION_WINDOW_MS) {
        // True new session - slide the watermark to the actual previous
        // visit time so anything created since then shows as New.
        previousVisitAt = account.marketplaceWatermarkUpdatedAt;
      } else {
        // Same session (within 30 min) - keep the existing cutoff so the
        // parent doesn't lose the New badges on a quick reload.
        previousVisitAt = account.marketplaceWatermarkAt ?? account.marketplaceWatermarkUpdatedAt;
      }
    }
    await this.prisma.parentAccount.update({
      where: { id: accountId },
      data: {
        marketplaceWatermarkAt: previousVisitAt,
        marketplaceWatermarkUpdatedAt: now,
      },
    });

    const views = await this.prisma.parentProfileView.findMany({
      where: { parentAccountId: accountId },
      select: { profileId: true },
    });
    return {
      previousVisitAt: previousVisitAt.toISOString(),
      viewedIds: views.map(v => v.profileId),
    };
  }

  @Post("parent-account/profile-views")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Record one or more profile views for the current parent account. Batched so scroll-past doesn't hammer the API. Idempotent: re-recording an existing view is a no-op." })
  async recordProfileViews(@Body() body: { views: Array<{ profileId: string; profileType: string }> }, @Req() req: Request) {
    const user = req.user as any;
    const accountId = await this.ensureParentAccountForEthnicities(user.id);
    if (!accountId) throw new NotFoundException("No account found");
    const views = Array.isArray(body?.views) ? body.views : [];
    if (views.length === 0) return { recorded: 0 };
    // Cap to prevent a malicious / buggy client flooding the table in one call.
    const capped = views.slice(0, 500);
    const seen = new Set<string>();
    const rows: { parentAccountId: string; profileId: string; profileType: string }[] = [];
    for (const v of capped) {
      if (!v?.profileId || typeof v.profileId !== "string") continue;
      const profileType = (v.profileType || "").toLowerCase();
      if (!this.ALLOWED_PROFILE_TYPES.includes(profileType)) continue;
      const key = `${profileType}:${v.profileId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ parentAccountId: accountId, profileId: v.profileId, profileType });
    }
    if (rows.length === 0) return { recorded: 0 };
    // Idempotent insert: existing (parentAccountId, profileId, profileType)
    // rows are silently skipped so the first viewedAt sticks.
    const result = await this.prisma.parentProfileView.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return { recorded: result.count };
  }

  @Post("parent-account/profile-events")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Record ad-funnel events (IMPRESSION = shown, VIEW = opened) for the current parent account. Append-only and NOT deduped - powers true impressions, unique reach, and click-through on the sponsorship dashboard. Batched client-side." })
  async recordProfileEvents(@Body() body: { events: Array<{ profileId: string; profileType: string; eventType: string }> }, @Req() req: Request) {
    const user = req.user as any;
    const accountId = await this.ensureParentAccountForEthnicities(user.id);
    if (!accountId) throw new NotFoundException("No account found");
    const events = Array.isArray(body?.events) ? body.events : [];
    if (events.length === 0) return { recorded: 0 };
    const ALLOWED_EVENT_TYPES = ["IMPRESSION", "VIEW"];
    // Cap to prevent a buggy / malicious client flooding the table in one call.
    const capped = events.slice(0, 1000);
    const rows: { parentAccountId: string; profileId: string; profileType: string; eventType: string }[] = [];
    for (const e of capped) {
      if (!e?.profileId || typeof e.profileId !== "string") continue;
      const profileType = (e.profileType || "").toLowerCase();
      if (!this.ALLOWED_PROFILE_TYPES.includes(profileType)) continue;
      const eventType = (e.eventType || "").toUpperCase();
      if (!ALLOWED_EVENT_TYPES.includes(eventType)) continue;
      rows.push({ parentAccountId: accountId, profileId: e.profileId, profileType, eventType });
    }
    if (rows.length === 0) return { recorded: 0 };
    // Append-only: every display / open is its own row (Google-style impression
    // counting). Dedup of repeats is intentionally NOT done here.
    const result = await this.prisma.profileEvent.createMany({ data: rows });
    return { recorded: result.count };
  }
}
