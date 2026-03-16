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
      const member = await this.prisma.providerMember.create({
        data: { ...memberData, providerId },
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
