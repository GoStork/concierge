import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  Inject,
  UseGuards,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiBody } from "@nestjs/swagger";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { insertProviderLocationSchema } from "@shared/schema";
import { hasProviderRole } from "@shared/roles";
import { z } from "zod";
import {
  CreateProviderLocationDto,
  UpdateProviderLocationDto,
  ProviderLocationDto,
} from "../../dto/provider.dto";
import { ErrorResponseDto } from "../../dto/auth.dto";

@ApiTags("Provider Locations")
@Controller("api/providers/:providerId/locations")
export class ProviderLocationsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: "List locations for a provider" })
  @ApiParam({ name: "providerId", description: "Provider UUID" })
  @ApiResponse({ status: 200, description: "List of provider locations", type: [ProviderLocationDto] })
  async list(@Param("providerId") providerId: string) {
    return this.prisma.providerLocation.findMany({
      where: { providerId },
      orderBy: { sortOrder: "asc" },
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Add a location to a provider" })
  @ApiParam({ name: "providerId", description: "Provider UUID" })
  @ApiBody({ type: CreateProviderLocationDto })
  @ApiResponse({ status: 201, description: "Location created", type: ProviderLocationDto })
  @ApiResponse({ status: 400, description: "Validation error", type: ErrorResponseDto })
  @ApiResponse({ status: 401, description: "Unauthorized", type: ErrorResponseDto })
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
      const input = insertProviderLocationSchema.omit({ providerId: true }).parse(body);
      return await this.prisma.providerLocation.create({
        data: { ...input, providerId },
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
  @ApiOperation({ summary: "Update a provider location" })
  @ApiParam({ name: "providerId", description: "Provider UUID" })
  @ApiParam({ name: "id", description: "Location UUID" })
  @ApiBody({ type: UpdateProviderLocationDto })
  @ApiResponse({ status: 200, description: "Location updated", type: ProviderLocationDto })
  @ApiResponse({ status: 400, description: "Validation error", type: ErrorResponseDto })
  @ApiResponse({ status: 401, description: "Unauthorized", type: ErrorResponseDto })
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
      const input = insertProviderLocationSchema
        .omit({ providerId: true })
        .partial()
        .parse(body);
      return await this.prisma.providerLocation.update({
        where: { id },
        data: input,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new BadRequestException({ message: "Validation error", errors: err.errors });
      }
      throw err;
    }
  }
}
