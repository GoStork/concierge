/**
 * W-9 routes - GoStork owns one global W-9 template; each provider signs their own copy.
 *
 * Endpoints:
 *  - Admin template management   /api/admin/w9/template + /sync-template + /template-editor-session + /refresh-roles
 *  - Admin per-provider           /api/admin/providers/:providerId/w9 + /w9/send
 *  - Provider self-service        /api/provider/w9 + /w9/fill
 *  - Shared                       /api/w9/:id/signing-session + /w9/:id/download
 *
 * Was previously living as dead Express handlers in server/routes.ts (a file that
 * was never wired into the running NestJS app). Moved here so the routes actually
 * exist.
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Req,
  Res,
  Inject,
  HttpException,
  HttpStatus,
  Logger,
  UseGuards,
} from "@nestjs/common";
import { Request, Response } from "express";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { getBaseUrl } from "../../lib/get-base-url";
import { NotificationService } from "../notifications/notification.service";
import { prisma } from "../../../db";
import {
  syncW9TemplateToPandaDoc,
  createW9TemplateEditingSession,
  refreshW9TemplateRoles,
  ensureW9Document,
  getW9SigningSession,
} from "../../../pandadoc-service";

function isAdmin(user: any): boolean {
  return !!user?.roles?.includes("GOSTORK_ADMIN");
}

function appBaseUrl(): string {
  return getBaseUrl();
}

async function buildW9Status(providerId: string) {
  const [settings, w9] = await Promise.all([
    prisma.siteSettings.findFirst({ select: { w9TemplateUrl: true, w9TemplateOriginalName: true, w9PandaDocTemplateId: true, w9PandaDocRoles: true } }),
    (prisma as any).providerW9.findUnique({ where: { providerId } }),
  ]);
  // "Configured" means: file uploaded, synced to PandaDoc, AND at least one field
  // assigned to a role (w9PandaDocRoles set by refreshW9TemplateRoles after Save).
  // Without the field assignment step, sending the W-9 produces an unsignable doc.
  const templateUploaded = !!(settings?.w9TemplateUrl && settings?.w9PandaDocTemplateId);
  const fieldsConfigured = !!settings?.w9PandaDocRoles;
  return {
    templateConfigured: templateUploaded && fieldsConfigured,
    templateNeedsFields: templateUploaded && !fieldsConfigured,
    templateName: settings?.w9TemplateOriginalName || null,
    w9Id: w9?.id || null,
    status: w9?.status || "NOT_SENT",
    requestedAt: w9?.requestedAt || null,
    completedAt: w9?.completedAt || null,
  };
}

@Controller()
export class W9Controller {
  private readonly logger = new Logger(W9Controller.name);

  constructor(
    @Inject(NotificationService) private readonly notificationService: NotificationService,
  ) {}

  // ── Admin: global W-9 template management ──

  @Get("api/admin/w9/template")
  @UseGuards(SessionOrJwtGuard)
  async getTemplate(@Req() req: Request) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const settings = await prisma.siteSettings.findFirst({
      select: { w9TemplateUrl: true, w9TemplateOriginalName: true, w9PandaDocTemplateId: true, w9PandaDocRoles: true },
    });
    return settings || {};
  }

  @Post("api/admin/w9/template")
  @UseGuards(SessionOrJwtGuard)
  async saveTemplate(@Req() req: Request, @Body() body: any) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const { url, originalName } = body || {};
    if (!url || typeof url !== "string") {
      throw new HttpException("url is required", HttpStatus.BAD_REQUEST);
    }
    try {
      const existing = await prisma.siteSettings.findFirst({ select: { id: true } });
      if (!existing) throw new HttpException("Site settings not initialized", HttpStatus.BAD_REQUEST);
      await prisma.siteSettings.update({
        where: { id: existing.id },
        data: {
          w9TemplateUrl: url,
          w9TemplateOriginalName: originalName || null,
          w9PandaDocTemplateId: null,
          w9PandaDocRoles: null,
          // Mark template version: per-provider docs created from the prior
          // template will be detected as stale and regenerated on next access.
          w9TemplateUpdatedAt: new Date(),
        },
      });
      return { success: true };
    } catch (e: any) {
      this.logger.error(`W-9 template save error: ${e.message}`);
      if (e instanceof HttpException) throw e;
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Delete("api/admin/w9/template")
  @UseGuards(SessionOrJwtGuard)
  async deleteTemplate(@Req() req: Request) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const existing = await prisma.siteSettings.findFirst({ select: { id: true } });
    if (existing) {
      await prisma.siteSettings.update({
        where: { id: existing.id },
        data: {
          w9TemplateUrl: null,
          w9TemplateOriginalName: null,
          w9PandaDocTemplateId: null,
          w9PandaDocRoles: null,
          w9TemplateUpdatedAt: new Date(),
        },
      });
    }
    return { success: true };
  }

  @Post("api/admin/w9/sync-template")
  @UseGuards(SessionOrJwtGuard)
  async syncTemplate(@Req() req: Request) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    try {
      const templateId = await syncW9TemplateToPandaDoc();
      return { templateId };
    } catch (e: any) {
      this.logger.error(`W-9 sync template error: ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get("api/admin/w9/template-editor-session")
  @UseGuards(SessionOrJwtGuard)
  async editorSession(@Req() req: Request) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    try {
      const user = req.user as any;
      const eToken = await createW9TemplateEditingSession(user.email);
      return { eToken };
    } catch (e: any) {
      this.logger.error(`W-9 template editor session error: ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post("api/admin/w9/refresh-roles")
  @UseGuards(SessionOrJwtGuard)
  async refreshRoles(@Req() req: Request) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    try {
      return await refreshW9TemplateRoles();
    } catch (e: any) {
      this.logger.error(`W-9 refresh roles error: ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ── Admin: per-provider W-9 status + send request ──

  @Get("api/admin/providers/:providerId/w9")
  @UseGuards(SessionOrJwtGuard)
  async getProviderW9Status(@Req() req: Request, @Param("providerId") providerId: string) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    return buildW9Status(providerId);
  }

  @Post("api/admin/providers/:providerId/w9/send")
  @UseGuards(SessionOrJwtGuard)
  async sendW9Request(@Req() req: Request, @Param("providerId") providerId: string, @Body() body: any) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const user = req.user as any;

    // Block send if the template isn't fully configured - otherwise providers
    // get a W-9 with no signature field to fill in.
    const settings = await prisma.siteSettings.findFirst({
      select: { w9TemplateUrl: true, w9PandaDocTemplateId: true, w9PandaDocRoles: true },
    });
    if (!settings?.w9TemplateUrl || !settings?.w9PandaDocTemplateId) {
      throw new HttpException("Upload a W-9 template first.", HttpStatus.BAD_REQUEST);
    }
    if (!settings.w9PandaDocRoles) {
      throw new HttpException("Configure the W-9 signature field before sending.", HttpStatus.BAD_REQUEST);
    }

    // `force: true` wipes any existing ProviderW9 row first - used when admin
    // wants to re-request a W-9 from a provider whose previous one is already
    // COMPLETED (e.g. wrong legal name, EIN, or address was filled in). The
    // previous PandaDoc document stays in PandaDoc's archive for audit; we
    // just stop referencing it and start a fresh signing flow.
    if (body?.force) {
      await (prisma as any).providerW9.deleteMany({ where: { providerId } });
    }

    try {
      const { w9, signer } = await ensureW9Document({ providerId, requestedByUserId: user.id });
      const provider = await prisma.provider.findUnique({ where: { id: providerId }, select: { name: true } });

      try {
        await this.notificationService.sendW9RequestNotification({
          providerId,
          providerName: provider?.name || "Provider",
          signingUrl: `${appBaseUrl()}/w9/${w9.id}`,
          fallbackSigner: { userId: signer.userId, email: signer.email, name: signer.name || signer.email },
        });
      } catch (notifErr: any) {
        this.logger.error(`[W-9] Request notification failed: ${notifErr?.message}`);
      }

      return { success: true, w9Id: w9.id, status: w9.status };
    } catch (e: any) {
      this.logger.error(`W-9 send error: ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ── Provider: own W-9 status + self-initiated fill ──

  @Get("api/provider/w9")
  @UseGuards(SessionOrJwtGuard)
  async getOwnW9(@Req() req: Request) {
    const user = req.user as any;
    const roles = user?.roles || [];
    if (!user?.providerId || (!roles.includes("PROVIDER_ADMIN") && !roles.includes("BILLING_MANAGER"))) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    return buildW9Status(user.providerId);
  }

  @Post("api/provider/w9/fill")
  @UseGuards(SessionOrJwtGuard)
  async fillW9(@Req() req: Request) {
    const user = req.user as any;
    const roles = user?.roles || [];
    if (!user?.providerId || (!roles.includes("PROVIDER_ADMIN") && !roles.includes("BILLING_MANAGER"))) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);

    const settings = await prisma.siteSettings.findFirst({
      select: { w9TemplateUrl: true, w9PandaDocTemplateId: true, w9PandaDocRoles: true },
    });
    if (!settings?.w9TemplateUrl || !settings?.w9PandaDocTemplateId || !settings.w9PandaDocRoles) {
      throw new HttpException("W-9 template is not ready yet. Please contact GoStork.", HttpStatus.BAD_REQUEST);
    }

    try {
      const { w9 } = await ensureW9Document({ providerId: user.providerId, requestedByUserId: null });
      return { success: true, w9Id: w9.id, status: w9.status };
    } catch (e: any) {
      this.logger.error(`W-9 fill error: ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Provider asks to start over on their W-9 - typically because they signed
   * the wrong details (legal name, EIN, address) or the admin updated the
   * template and they need to re-sign the latest version. Wipes the existing
   * ProviderW9 row so ensureW9Document() creates a fresh PandaDoc document
   * from the current template.
   *
   * The previous PandaDoc document stays in PandaDoc's archive (we don't
   * delete it there) for audit purposes - we just stop referencing it.
   */
  @Post("api/provider/w9/resubmit")
  @UseGuards(SessionOrJwtGuard)
  async resubmitW9(@Req() req: Request) {
    const user = req.user as any;
    const roles = user?.roles || [];
    if (!user?.providerId || (!roles.includes("PROVIDER_ADMIN") && !roles.includes("BILLING_MANAGER"))) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);

    const settings = await prisma.siteSettings.findFirst({
      select: { w9TemplateUrl: true, w9PandaDocTemplateId: true, w9PandaDocRoles: true },
    });
    if (!settings?.w9TemplateUrl || !settings?.w9PandaDocTemplateId || !settings.w9PandaDocRoles) {
      throw new HttpException("W-9 template is not ready yet. Please contact GoStork.", HttpStatus.BAD_REQUEST);
    }

    try {
      await (prisma as any).providerW9.deleteMany({ where: { providerId: user.providerId } });
      const { w9 } = await ensureW9Document({ providerId: user.providerId, requestedByUserId: null });
      return { success: true, w9Id: w9.id, status: w9.status };
    } catch (e: any) {
      this.logger.error(`W-9 resubmit error: ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /** Admin equivalent of resubmit - clears a specific provider's W-9 so a fresh
   *  one can be generated from the current template version. */
  @Post("api/admin/providers/:providerId/w9/reset")
  @UseGuards(SessionOrJwtGuard)
  async resetProviderW9(@Req() req: Request, @Param("providerId") providerId: string) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    try {
      await (prisma as any).providerW9.deleteMany({ where: { providerId } });
      return { success: true };
    } catch (e: any) {
      this.logger.error(`W-9 reset error: ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ── Shared: signing session + download ──

  @Get("api/w9/:id/signing-session")
  @UseGuards(SessionOrJwtGuard)
  async signingSession(@Req() req: Request, @Param("id") id: string) {
    const user = req.user as any;
    try {
      const w9 = await (prisma as any).providerW9.findUnique({
        where: { id },
        select: { id: true, providerId: true, status: true },
      });
      if (!w9) throw new HttpException("W-9 not found", HttpStatus.NOT_FOUND);
      const userRoles = user?.roles || [];
      const hasBillingRole = userRoles.includes("PROVIDER_ADMIN") || userRoles.includes("BILLING_MANAGER");
      if (!isAdmin(user) && (user.providerId !== w9.providerId || !hasBillingRole)) {
        throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
      }

      if (w9.status === "COMPLETED") {
        return { isCompletedView: true, status: w9.status, w9Id: w9.id, providerId: w9.providerId };
      }
      const { signingUrl, providerId } = await getW9SigningSession(w9.id, user);
      return { isCompletedView: false, signingUrl, w9Id: w9.id, providerId };
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      this.logger.error(`W-9 signing session error: ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get("api/w9/:id/download")
  @UseGuards(SessionOrJwtGuard)
  async download(@Req() req: Request, @Res() res: Response, @Param("id") id: string) {
    try {
      const user = req.user as any;
      const w9 = await (prisma as any).providerW9.findUnique({
        where: { id },
        select: { providerId: true, pandaDocDocumentId: true },
      });
      if (!w9) throw new HttpException("W-9 not found", HttpStatus.NOT_FOUND);
      const dlRoles = user?.roles || [];
      const hasBillingRoleDl = dlRoles.includes("PROVIDER_ADMIN") || dlRoles.includes("BILLING_MANAGER");
      if (!isAdmin(user) && (user.providerId !== w9.providerId || !hasBillingRoleDl)) {
        throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
      }
      if (!w9.pandaDocDocumentId) throw new HttpException("No PandaDoc document linked", HttpStatus.BAD_REQUEST);

      const apiKey = process.env.PANDADOC_API_KEY;
      if (!apiKey) throw new HttpException("PandaDoc not configured", HttpStatus.INTERNAL_SERVER_ERROR);

      const pdRes = await fetch(
        `https://api.pandadoc.com/public/v1/documents/${w9.pandaDocDocumentId}/download`,
        { headers: { "Authorization": `API-Key ${apiKey}` } },
      );
      if (!pdRes.ok) {
        const err = await pdRes.text();
        this.logger.error(`[W-9 download] PandaDoc error: ${err}`);
        throw new HttpException("Failed to download from PandaDoc", HttpStatus.BAD_GATEWAY);
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="w9-${w9.pandaDocDocumentId}.pdf"`);
      res.send(Buffer.from(await pdRes.arrayBuffer()));
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      this.logger.error(`[W-9 download] ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
