import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  Inject,
  UseGuards,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from "@nestjs/swagger";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { insertProviderMemberSchema } from "@shared/schema";
import { hasProviderRole } from "@shared/roles";
import { z } from "zod";
import { ErrorResponseDto } from "../../dto/auth.dto";

// Doctor-profile fields the authoritative scrapers (NPPES/ABOG/bio) can set.
// When a provider edits one of these, we mark it "self" so it's never clobbered.
const SELF_PROVENANCE_FIELDS = [
  "specialties", "languagesSpoken", "boardCertifications", "education",
  "professionalMemberships", "npiNumber", "medicalSchool", "graduationYear",
  "yearsExperience", "providerGender",
];

/**
 * Did the provider actually enter something for this field?
 *
 * The team editor submits every profile field on save, blank ones included.
 * Stamping "self" on a blank told the enrichment pipeline a human had chosen to
 * leave it empty - and buildDoctorEnrichment never clobbers "self" - so one
 * save with an empty Specialties box locked NPPES/ABOG/bio out of that field
 * permanently. Blank means "nothing entered", not "keep it blank".
 */
function hasEnteredValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return value != null;
}

@ApiTags("Provider Members")
@Controller("api/providers/:providerId/members")
export class MembersController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: "List members for a provider" })
  @ApiParam({ name: "providerId", description: "Provider UUID" })
  @ApiResponse({ status: 200, description: "List of provider members" })
  async list(@Param("providerId") providerId: string) {
    return this.prisma.providerMember.findMany({
      where: { providerId },
      include: { locations: { include: { location: true } } },
      orderBy: { sortOrder: "asc" },
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Add a member to a provider" })
  @ApiParam({ name: "providerId", description: "Provider UUID" })
  @ApiResponse({ status: 201, description: "Member created" })
  @ApiResponse({ status: 400, description: "Validation error", type: ErrorResponseDto })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  async create(
    @Param("providerId") providerId: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isOwnProvider = hasProviderRole(user.roles || []) && user.providerId === providerId;
    if (!isAdmin && !isOwnProvider) {
      throw new ForbiddenException("Forbidden");
    }
    try {
      const input = insertProviderMemberSchema.omit({ providerId: true }).parse(body);
      const { locationIds, ...memberData } = input;
      const editedSelf = SELF_PROVENANCE_FIELDS.filter(
        (f) => f in memberData && hasEnteredValue((memberData as any)[f]),
      );
      const fieldSources: Record<string, string> = {};
      for (const f of editedSelf) fieldSources[f] = "self";
      const member = await this.prisma.providerMember.create({
        data: { ...memberData, providerId, ...(editedSelf.length > 0 ? { fieldSources } : {}) },
      });
      if (locationIds && locationIds.length > 0) {
        await this.prisma.providerMemberLocation.createMany({
          data: locationIds.map(locationId => ({ memberId: member.id, locationId })),
          skipDuplicates: true,
        });
      }
      return this.prisma.providerMember.findUnique({
        where: { id: member.id },
        include: { locations: { include: { location: true } } },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new BadRequestException({ message: "Validation error", errors: err.errors });
      }
      throw err;
    }
  }

  @Put(":id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update a provider member" })
  @ApiParam({ name: "providerId", description: "Provider UUID" })
  @ApiParam({ name: "id", description: "Member UUID" })
  @ApiResponse({ status: 200, description: "Member updated" })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  async update(
    @Param("providerId") providerId: string,
    @Param("id") id: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isOwnProvider = hasProviderRole(user.roles || []) && user.providerId === providerId;
    if (!isAdmin && !isOwnProvider) {
      throw new ForbiddenException("Forbidden");
    }
    try {
      const input = insertProviderMemberSchema.omit({ providerId: true }).partial().parse(body);
      const { locationIds, ...memberData } = input;
      // Stamp "self" provenance on any doctor-profile field the provider edited
      // so the authoritative scrapers (NPPES/ABOG/bio) never overwrite it.
      const submitted = SELF_PROVENANCE_FIELDS.filter((f) => f in memberData);
      if (submitted.length > 0) {
        const existing = await this.prisma.providerMember.findUnique({ where: { id }, select: { fieldSources: true } });
        const sources: Record<string, string> = { ...((existing?.fieldSources as any) || {}) };
        for (const f of submitted) {
          if (hasEnteredValue((memberData as any)[f])) {
            sources[f] = "self";
          } else if (sources[f] === "self") {
            // Cleared by hand: release the lock so the registries and bio
            // extraction can fill it again, rather than freezing it empty.
            delete sources[f];
          }
        }
        (memberData as any).fieldSources = sources;
      }
      await this.prisma.providerMember.update({
        where: { id },
        data: memberData,
      });
      if (locationIds !== undefined) {
        await this.prisma.providerMemberLocation.deleteMany({ where: { memberId: id } });
        if (locationIds.length > 0) {
          await this.prisma.providerMemberLocation.createMany({
            data: locationIds.map(locationId => ({ memberId: id, locationId })),
            skipDuplicates: true,
          });
        }
      }
      return this.prisma.providerMember.findUnique({
        where: { id },
        include: { locations: { include: { location: true } } },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new BadRequestException({ message: "Validation error", errors: err.errors });
      }
      throw err;
    }
  }

  @Delete(":id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete a provider member" })
  @ApiParam({ name: "providerId", description: "Provider UUID" })
  @ApiParam({ name: "id", description: "Member UUID" })
  @ApiResponse({ status: 200, description: "Member deleted" })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  async delete(
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
    const member = await this.prisma.providerMember.findUnique({ where: { id } });
    if (!member || member.providerId !== providerId) {
      throw new NotFoundException("Member not found");
    }
    await this.prisma.providerMember.delete({ where: { id } });
    return { message: "Member deleted" };
  }
}
