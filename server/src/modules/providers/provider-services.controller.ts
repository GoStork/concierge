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
import { insertProviderServiceSchema } from "@shared/schema";
import { hasProviderRole } from "@shared/roles";
import { z } from "zod";
import {
  CreateProviderServiceDto,
  UpdateProviderServiceDto,
  ProviderServiceDto,
} from "../../dto/provider.dto";
import { ErrorResponseDto } from "../../dto/auth.dto";

@ApiTags("Provider Services")
@Controller("api/providers/:providerId/services")
export class ProviderServicesController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: "List services for a provider" })
  @ApiParam({ name: "providerId", description: "Provider UUID" })
  @ApiResponse({ status: 200, description: "List of provider services", type: [ProviderServiceDto] })
  async list(@Param("providerId") providerId: string) {
    return this.prisma.providerService.findMany({
      where: { providerId },
      include: { providerType: true },
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Add a service to a provider" })
  @ApiParam({ name: "providerId", description: "Provider UUID" })
  @ApiBody({ type: CreateProviderServiceDto })
  @ApiResponse({ status: 201, description: "Provider service created", type: ProviderServiceDto })
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
      const input = insertProviderServiceSchema.omit({ providerId: true }).parse(body);
      return await this.prisma.providerService.create({
        data: { ...input, providerId },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new BadRequestException({ message: "Validation error", errors: err.errors });
      }
      throw err;
    }
  }

  @Post(":id/delete")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Delete a provider service" })
  @ApiParam({ name: "providerId", description: "Provider UUID" })
  @ApiParam({ name: "id", description: "Provider Service UUID" })
  @ApiResponse({ status: 200, description: "Provider service deleted" })
  @ApiResponse({ status: 401, description: "Unauthorized", type: ErrorResponseDto })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  async remove(
    @Param("providerId") providerId: string,
    @Param("id") id: string,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");
    if (!isAdmin) {
      throw new ForbiddenException("Only admins can remove services");
    }
    await this.prisma.providerService.delete({ where: { id } });
    return { success: true };
  }

  @Put(":id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update a provider service" })
  @ApiParam({ name: "providerId", description: "Provider UUID" })
  @ApiParam({ name: "id", description: "Provider Service UUID" })
  @ApiBody({ type: UpdateProviderServiceDto })
  @ApiResponse({ status: 200, description: "Provider service updated", type: ProviderServiceDto })
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
      const input = insertProviderServiceSchema
        .omit({ providerId: true })
        .partial()
        .parse(body);
      return await this.prisma.providerService.update({
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
