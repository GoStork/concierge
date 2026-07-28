import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Inject,
  UseGuards,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Request } from "express";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { AutoReplyService } from "./auto-reply.service";
import { assertNoContactInfo } from "../../../contact-guard";

/**
 * CRUD for the provider booking auto-reply templates.
 *
 * Access: a provider user manages their own org's templates. A GoStork admin
 * can read and edit any org's templates by passing ?providerId= (there is no
 * approval gate - admins can fix bad copy, they do not have to bless it first).
 */
@ApiTags("Provider Auto-Reply")
@Controller("api/provider-auto-replies")
@UseGuards(SessionOrJwtGuard)
export class AutoReplyController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AutoReplyService) private readonly autoReply: AutoReplyService,
  ) {}

  /** Resolve which provider org this request may act on, or throw. */
  private resolveProviderId(req: Request, requested?: string | null): string {
    const user = req.user as any;
    const isAdmin = (user?.roles || []).includes("GOSTORK_ADMIN");
    if (isAdmin) {
      const id = requested || user?.providerId;
      if (!id) throw new BadRequestException("providerId is required");
      return id;
    }
    if (!user?.providerId) throw new ForbiddenException("Provider account required");
    // A provider user may never reach into another org.
    if (requested && requested !== user.providerId) {
      throw new ForbiddenException("Cannot manage another provider's auto-replies");
    }
    return user.providerId;
  }

  private sanitizeAttachments(input: any): any[] {
    if (!Array.isArray(input)) return [];
    return input
      .filter((f) => f && typeof f.url === "string" && f.url.trim())
      .slice(0, 10)
      .map((f) => ({
        originalName: typeof f.originalName === "string" ? f.originalName.slice(0, 300) : "Attachment",
        url: String(f.url),
        mimeType: typeof f.mimeType === "string" ? f.mimeType : "application/octet-stream",
        size: Number.isFinite(f.size) ? Number(f.size) : null,
      }));
  }

  /** Staff members and approved service lines, for the scope pickers. */
  @Get("options")
  @ApiOperation({ summary: "Staff + service-line options for scoping auto-reply templates" })
  async options(@Req() req: Request, @Query("providerId") providerIdQ?: string) {
    const providerId = this.resolveProviderId(req, providerIdQ);
    const [staff, services, provider] = await Promise.all([
      this.prisma.user.findMany({
        where: { providerId, isDisabled: false },
        select: { id: true, name: true, email: true, photoUrl: true },
        orderBy: { name: "asc" },
      }),
      this.prisma.providerService.findMany({
        where: { providerId, status: "APPROVED" },
        include: { providerType: true },
      }),
      this.prisma.provider.findUnique({ where: { id: providerId }, select: { id: true, name: true } }),
    ]);
    return {
      providerId,
      providerName: provider?.name || null,
      staff,
      serviceTypes: services
        .map((s: any) => ({ id: s.providerTypeId, name: s.providerType?.name || "Service" }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name)),
    };
  }

  @Get()
  @ApiOperation({ summary: "List this provider's auto-reply templates" })
  async list(@Req() req: Request, @Query("providerId") providerIdQ?: string) {
    const providerId = this.resolveProviderId(req, providerIdQ);
    const rows = await this.prisma.providerAutoReply.findMany({
      where: { providerId },
      include: {
        staffUser: { select: { id: true, name: true, email: true, photoUrl: true } },
        providerType: { select: { id: true, name: true } },
      },
      orderBy: [{ staffUserId: "asc" }, { createdAt: "asc" }],
    });
    return { autoReplies: rows };
  }

  @Post()
  @ApiOperation({ summary: "Create an auto-reply template" })
  async create(@Req() req: Request, @Body() body: any) {
    const user = req.user as any;
    const providerId = this.resolveProviderId(req, body?.providerId);
    const text = String(body?.body || "").trim();
    if (!text) throw new BadRequestException("Message body is required");
    assertNoContactInfo(text, "auto-reply.create", { providerId });

    const staffUserId = body?.staffUserId || null;
    const providerTypeId = body?.providerTypeId || null;

    if (staffUserId) {
      const staff = await this.prisma.user.findUnique({
        where: { id: staffUserId },
        select: { providerId: true },
      });
      if (staff?.providerId !== providerId) {
        throw new BadRequestException("That staff member does not belong to this provider");
      }
    }

    const clash = await this.prisma.providerAutoReply.findFirst({
      where: { providerId, staffUserId, providerTypeId },
      select: { id: true },
    });
    if (clash) {
      throw new BadRequestException("A template already exists for this staff member and service line");
    }

    const created = await this.prisma.providerAutoReply.create({
      data: {
        providerId,
        staffUserId,
        providerTypeId,
        body: text,
        attachments: this.sanitizeAttachments(body?.attachments),
        isEnabled: body?.isEnabled !== false,
        createdByUserId: user?.id || null,
      },
      include: {
        staffUser: { select: { id: true, name: true, email: true, photoUrl: true } },
        providerType: { select: { id: true, name: true } },
      },
    });
    return { autoReply: created };
  }

  @Put(":id")
  @ApiOperation({ summary: "Update an auto-reply template" })
  async update(@Req() req: Request, @Param("id") id: string, @Body() body: any) {
    const existing = await this.prisma.providerAutoReply.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Auto-reply not found");
    this.resolveProviderId(req, existing.providerId);

    const data: any = {};
    if (body?.body !== undefined) {
      const text = String(body.body || "").trim();
      if (!text) throw new BadRequestException("Message body is required");
      assertNoContactInfo(text, "auto-reply.update", { providerId: existing.providerId, templateId: id });
      data.body = text;
    }
    if (body?.attachments !== undefined) data.attachments = this.sanitizeAttachments(body.attachments);
    if (body?.isEnabled !== undefined) data.isEnabled = !!body.isEnabled;

    // Scope moves are allowed, but must not collide with an existing template.
    const nextStaff = body?.staffUserId !== undefined ? body.staffUserId || null : existing.staffUserId;
    const nextType = body?.providerTypeId !== undefined ? body.providerTypeId || null : existing.providerTypeId;
    if (nextStaff !== existing.staffUserId || nextType !== existing.providerTypeId) {
      const clash = await this.prisma.providerAutoReply.findFirst({
        where: {
          providerId: existing.providerId,
          staffUserId: nextStaff,
          providerTypeId: nextType,
          id: { not: id },
        },
        select: { id: true },
      });
      if (clash) {
        throw new BadRequestException("A template already exists for this staff member and service line");
      }
      data.staffUserId = nextStaff;
      data.providerTypeId = nextType;
    }

    const updated = await this.prisma.providerAutoReply.update({
      where: { id },
      data,
      include: {
        staffUser: { select: { id: true, name: true, email: true, photoUrl: true } },
        providerType: { select: { id: true, name: true } },
      },
    });
    return { autoReply: updated };
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete an auto-reply template" })
  async remove(@Req() req: Request, @Param("id") id: string) {
    const existing = await this.prisma.providerAutoReply.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Auto-reply not found");
    this.resolveProviderId(req, existing.providerId);

    // The send log is history (it is what keeps "send once" honest), so detach
    // rather than cascade-delete when the template it points at goes away.
    await this.prisma.providerAutoReplySend.updateMany({
      where: { autoReplyId: id },
      data: { autoReplyId: null },
    });
    await this.prisma.providerAutoReply.delete({ where: { id } });
    return { success: true };
  }

  /** Render the template with sample values so the provider can see the real thing. */
  @Post("preview")
  @ApiOperation({ summary: "Preview a rendered auto-reply body" })
  async preview(@Req() req: Request, @Body() body: any) {
    const providerId = this.resolveProviderId(req, body?.providerId);
    const user = req.user as any;
    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
      select: { name: true },
    });
    let staffName: string | null = user?.name || null;
    if (body?.staffUserId) {
      const staff = await this.prisma.user.findUnique({
        where: { id: body.staffUserId },
        select: { name: true },
      });
      staffName = staff?.name || staffName;
    }
    const sample = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    // Preview with a REAL profile from this provider where one exists, so the
    // provider sees the actual shape of the reference and link rather than a
    // made-up id. Falls back to a plausible sample, and the caller can ask for
    // the no-profile case to see what a general consultation looks like.
    let profileRef: string | null = null;
    let profileLink: string | null = null;
    if (body?.withProfile !== false) {
      const sampleProfile = await this.autoReply.sampleProfileReference(providerId);
      profileRef = sampleProfile.profileRef;
      profileLink = sampleProfile.profileLink;
    }

    return {
      rendered: this.autoReply.renderBody(String(body?.body || ""), {
        parentName: "Alex",
        providerName: provider?.name || "Your organization",
        staffName,
        callType: "consultation",
        callTime: this.autoReply.formatCallTime(sample, body?.timezone || null),
        profileRef,
        profileLink,
      }),
      /** Lets the UI say "this paragraph disappears on a general call". */
      hadProfile: !!profileRef,
    };
  }
}
