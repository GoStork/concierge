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
  NotFoundException,
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
    const isOwnProvider = user.roles?.includes("PROVIDER_ADMIN") && user.providerId === providerId;
    if (!isAdmin && !isOwnProvider) {
      throw new ForbiddenException("Forbidden");
    }
    try {
      const input = insertProviderServiceSchema.omit({ providerId: true }).parse(body);
      // A provider can only REQUEST a service: it enters as NEW and goes
      // live solely through GoStork's approval (status === APPROVED is the
      // marketplace publish switch - never self-service).
      if (!isAdmin) input.status = "NEW";
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
    const isOwnProvider = user.roles?.includes("PROVIDER_ADMIN") && user.providerId === providerId;
    if (!isAdmin && !isOwnProvider) {
      throw new ForbiddenException("Forbidden");
    }
    const existing = await this.prisma.providerService.findFirst({ where: { id, providerId } });
    if (!existing) {
      throw new NotFoundException("Service not found");
    }
    // Removing an APPROVED line unpublishes live inventory - GoStork only.
    // Providers may withdraw their own unapproved requests.
    if (!isAdmin && existing.status === "APPROVED") {
      throw new ForbiddenException("Approved services can only be removed by GoStork - contact us to retire a service line.");
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
    const isOwnProvider = user.roles?.includes("PROVIDER_ADMIN") && user.providerId === providerId;
    if (!isAdmin && !isOwnProvider) {
      throw new ForbiddenException("Forbidden");
    }
    try {
      const input = insertProviderServiceSchema
        .omit({ providerId: true })
        .partial()
        .parse(body);
      // Status is GoStork's publish switch - a provider must never move it
      // (self-approving here would bypass the entire go-live review).
      if (!isAdmin) delete (input as any).status;
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
