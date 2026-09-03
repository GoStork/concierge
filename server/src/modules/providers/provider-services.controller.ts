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
import { NotificationService } from "../notifications/notification.service";
import { AppEventsService } from "../notifications/app-events.service";

@ApiTags("Provider Services")
@Controller("api/providers/:providerId/services")
export class ProviderServicesController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(AppEventsService) private readonly appEvents: AppEventsService,
  ) {}

  /**
   * A provider requested a new service line. Tell every GoStork admin three
   * ways: branded email, live in-app toast (persisted for offline admins by
   * AppEventsService), and the admin Home "Needs attention" row, which reads
   * NEW services straight from the DB so it needs no extra write here.
   */
  private async notifyAdminsOfServiceRequest(service: { id: string; providerId: string; providerTypeId: string }, actor: any) {
    try {
      const [provider, providerType, admins] = await Promise.all([
        this.prisma.provider.findUnique({ where: { id: service.providerId }, select: { name: true } }),
        this.prisma.providerType.findUnique({ where: { id: service.providerTypeId }, select: { name: true } }),
        this.prisma.user.findMany({ where: { roles: { has: "GOSTORK_ADMIN" }, isDisabled: false }, select: { id: true } }),
      ]);
      const providerName = provider?.name || "A provider";
      const serviceName = providerType?.name || "a new service";
      await this.appEvents.emit({
        type: "provider_service_requested",
        targetUserIds: admins.map(a => a.id),
        actorUserId: actor?.id,
        payload: {
          serviceId: service.id,
          providerId: service.providerId,
          providerName,
          serviceName,
          message: `${providerName} requested ${serviceName} - approval needed`,
        },
      });
      await this.notifications.sendProviderServiceRequestedNotification({
        providerId: service.providerId,
        providerName,
        serviceName,
        requestedByName: actor?.name || null,
      });
    } catch (err: any) {
      // Never fail the request itself - but say loudly that admins were not told.
      console.error(`[ProviderServices] Admin notification for service request ${service.id} failed: ${err?.message}`);
    }
  }

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
      const created = await this.prisma.providerService.create({
        data: { ...input, providerId },
      });
      // Only a provider's own request needs GoStork's attention - an admin
      // adding a line is already the approval.
      if (!isAdmin) await this.notifyAdminsOfServiceRequest(created, user);
      return created;
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
