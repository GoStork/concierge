/**
 * GoStork -> Provider service agreement routes.
 *
 * The GoStork admin sends the provider service agreement (default template =
 * the house provider's upload on /account/documents, or a per-provider CUSTOM
 * upload) to providers. GoStork signs first (referral-fee fields), the
 * provider second. Tracking table, reminders (Home-page task) and signed-PDF
 * download live on the admin Agreements tab.
 *
 * Endpoints:
 *  - Admin overview           GET  /api/admin/provider-agreements
 *  - Send default             POST /api/admin/provider-agreements/send
 *  - Create custom draft      POST /api/admin/provider-agreements/custom
 *  - Custom template config   PUT/DELETE /api/admin/provider-agreements/:id/custom-template
 *                             POST /api/admin/provider-agreements/:id/sync-template
 *                             GET  /api/admin/provider-agreements/:id/template-editor-session
 *                             POST /api/admin/provider-agreements/:id/refresh-roles
 *  - Send custom draft        POST /api/admin/provider-agreements/:id/send
 *  - Reminder task            POST /api/admin/provider-agreements/:id/remind
 *  - Shared                   GET  /api/provider-agreements/:id/signing-session + /download
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Req,
  Res,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  UseGuards,
} from "@nestjs/common";
import { Request, Response } from "express";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { NotificationService } from "../notifications/notification.service";
import { prisma } from "../../../db";
import {
  sendProviderAgreement,
  syncProviderAgreementTemplate,
  createProviderAgreementEditingSession,
  refreshProviderAgreementRoles,
  getProviderAgreementSigningSession,
  notifyProviderAgreementProviderTurn,
  fetchDocumentViewUrl,
} from "../../../pandadoc-service";

function isAdmin(user: any): boolean {
  return !!user?.roles?.includes("GOSTORK_ADMIN");
}

function requesterFromUser(user: any): { userId: string; email: string; firstName: string; lastName: string } {
  const name: string = user?.name || "";
  return {
    userId: user.id,
    email: user.email,
    firstName: user.firstName || name.split(" ")[0] || "GoStork",
    lastName: user.lastName || name.split(" ").slice(1).join(" ") || "Team",
  };
}

@Controller()
export class ProviderAgreementController {
  private readonly logger = new Logger(ProviderAgreementController.name);

  // Explicit @Inject: the esbuild bundle emits no design:type metadata, so
  // plain constructor injection resolves to undefined at runtime.
  constructor(@Inject(NotificationService) private readonly notificationService: NotificationService) {}

  // ── Admin overview: eligible providers + all agreement rows ──
  // Eligible = the account exists and someone there can actually sign: at
  // least one enabled PROVIDER_ADMIN or BILLING_MANAGER user. Deliberately NOT
  // "approved" - approval implies the agreement was already signed, so it
  // cannot be the entry filter. The GoStork house provider is excluded.
  @Get("api/admin/provider-agreements")
  @UseGuards(SessionOrJwtGuard)
  async overview(@Req() req: Request) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);

    const providers = await prisma.provider.findMany({
      where: {
        users: { some: { isDisabled: false, roles: { hasSome: ["PROVIDER_ADMIN", "BILLING_MANAGER"] } } },
        NOT: { users: { some: { roles: { has: "GOSTORK_ADMIN" } } } },
      },
      select: {
        id: true,
        name: true,
        services: { select: { providerType: { select: { name: true } } } },
      },
      orderBy: { name: "asc" },
    });

    const rows = await (prisma as any).providerAgreement.findMany({
      where: { providerId: { in: providers.map((p: any) => p.id) } },
      orderBy: [{ createdAt: "desc" }],
    });

    const reminders = await (prisma as any).parentTask.findMany({
      where: { systemKey: { in: providers.map((p: any) => `pagr:${p.id}`) }, status: "OPEN" },
      select: { systemKey: true },
    });
    const openReminders = new Set(reminders.map((r: any) => r.systemKey));
    const nameById = new Map(providers.map((p: any) => [p.id, p.name]));

    return {
      providers: providers.map((p: any) => ({
        providerId: p.id,
        name: p.name,
        serviceTypes: Array.from(new Set(p.services.map((s: any) => s.providerType.name))),
      })),
      agreements: rows.map((a: any) => ({
        id: a.id,
        providerId: a.providerId,
        providerName: nameById.get(a.providerId) || "Provider",
        status: a.status,
        templateSource: a.templateSource,
        customTemplateUrl: a.customTemplateUrl,
        customTemplateOriginalName: a.customTemplateOriginalName,
        customPandaDocTemplateId: a.customPandaDocTemplateId,
        signerEmail: a.signerEmail,
        requestedAt: a.requestedAt,
        completedAt: a.completedAt,
        supersededAt: a.supersededAt,
        guestOpenedAt: a.guestOpenedAt,
        autoRemindCount: a.autoRemindCount,
        reminderOpen: !a.supersededAt && openReminders.has(`pagr:${a.providerId}`),
      })),
    };
  }

  // ── Send the DEFAULT contract ──
  @Post("api/admin/provider-agreements/send")
  @UseGuards(SessionOrJwtGuard)
  async sendDefault(@Req() req: Request, @Body() body: any) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const providerId = String(body?.providerId || "");
    if (!providerId) throw new HttpException("providerId is required", HttpStatus.BAD_REQUEST);
    try {
      const result = await sendProviderAgreement({ providerId, requestedBy: requesterFromUser(req.user) });
      return { success: true, agreementId: result.agreement.id, status: result.agreement.status };
    } catch (e: any) {
      this.logger.error(`[ProviderAgreement] send error: ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ── CUSTOM contract: draft row + template config (PandaDocTemplateEditor contract) ──

  @Post("api/admin/provider-agreements/custom")
  @UseGuards(SessionOrJwtGuard)
  async createCustomDraft(@Req() req: Request, @Body() body: any) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const providerId = String(body?.providerId || "");
    if (!providerId) throw new HttpException("providerId is required", HttpStatus.BAD_REQUEST);
    // One DRAFT at a time per provider - reuse it so a half-configured custom
    // contract is picked up where the admin left off.
    const existing = await (prisma as any).providerAgreement.findFirst({
      where: { providerId, status: "DRAFT" },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return { agreement: existing, reused: true };
    const agreement = await (prisma as any).providerAgreement.create({
      data: { providerId, status: "DRAFT", templateSource: "CUSTOM", requestedByUserId: (req.user as any).id },
    });
    return { agreement, reused: false };
  }

  @Put("api/admin/provider-agreements/:id/custom-template")
  @UseGuards(SessionOrJwtGuard)
  async saveCustomTemplate(@Req() req: Request, @Param("id") id: string, @Body() body: any) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const row = await (prisma as any).providerAgreement.findUnique({ where: { id } });
    if (!row) throw new HttpException("Agreement not found", HttpStatus.NOT_FOUND);
    if (row.status !== "DRAFT") throw new HttpException("This agreement was already sent", HttpStatus.BAD_REQUEST);
    await (prisma as any).providerAgreement.update({
      where: { id },
      data: {
        customTemplateUrl: body?.url || null,
        customTemplateOriginalName: body?.originalName || null,
        // New file = new template; force a re-sync.
        customPandaDocTemplateId: null,
        customPandaDocRoles: null,
      },
    });
    return { success: true };
  }

  @Delete("api/admin/provider-agreements/:id/custom-template")
  @UseGuards(SessionOrJwtGuard)
  async deleteCustomTemplate(@Req() req: Request, @Param("id") id: string) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const row = await (prisma as any).providerAgreement.findUnique({ where: { id } });
    if (!row) throw new HttpException("Agreement not found", HttpStatus.NOT_FOUND);
    if (row.status !== "DRAFT") throw new HttpException("This agreement was already sent", HttpStatus.BAD_REQUEST);
    // Removing the file from a draft removes the draft - nothing else on it.
    await (prisma as any).providerAgreement.delete({ where: { id } });
    return { success: true };
  }

  @Post("api/admin/provider-agreements/:id/sync-template")
  @UseGuards(SessionOrJwtGuard)
  async syncTemplate(@Req() req: Request, @Param("id") id: string) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    try {
      const templateId = await syncProviderAgreementTemplate(id);
      return { templateId };
    } catch (e: any) {
      this.logger.error(`[ProviderAgreement] sync template error: ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get("api/admin/provider-agreements/:id/template-editor-session")
  @UseGuards(SessionOrJwtGuard)
  async editorSession(@Req() req: Request, @Param("id") id: string) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    try {
      const eToken = await createProviderAgreementEditingSession(id, (req.user as any).email);
      return { eToken };
    } catch (e: any) {
      this.logger.error(`[ProviderAgreement] editor session error: ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post("api/admin/provider-agreements/:id/refresh-roles")
  @UseGuards(SessionOrJwtGuard)
  async refreshRoles(@Req() req: Request, @Param("id") id: string) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    try {
      return await refreshProviderAgreementRoles(id);
    } catch (e: any) {
      this.logger.error(`[ProviderAgreement] refresh roles error: ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ── Send a configured CUSTOM draft ──
  @Post("api/admin/provider-agreements/:id/send")
  @UseGuards(SessionOrJwtGuard)
  async sendCustom(@Req() req: Request, @Param("id") id: string) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const row = await (prisma as any).providerAgreement.findUnique({ where: { id } });
    if (!row) throw new HttpException("Agreement not found", HttpStatus.NOT_FOUND);
    try {
      const result = await sendProviderAgreement({
        providerId: row.providerId,
        agreementId: id,
        requestedBy: requesterFromUser(req.user),
      });
      return { success: true, agreementId: result.agreement.id, status: result.agreement.status };
    } catch (e: any) {
      this.logger.error(`[ProviderAgreement] custom send error: ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ── Reminder: reopen/refresh the Home-page task ──
  @Post("api/admin/provider-agreements/:id/remind")
  @UseGuards(SessionOrJwtGuard)
  async remind(@Req() req: Request, @Param("id") id: string) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const row = await (prisma as any).providerAgreement.findUnique({ where: { id } });
    if (!row) throw new HttpException("Agreement not found", HttpStatus.NOT_FOUND);
    if (row.status === "COMPLETED") throw new HttpException("This agreement is already signed.", HttpStatus.BAD_REQUEST);
    if (row.status !== "SENT") throw new HttpException("The provider cannot sign yet - complete the GoStork signature first.", HttpStatus.BAD_REQUEST);
    // Full reminder: re-send the signing email (guest link, minted if
    // missing) AND reopen the Home-page task - a nudge nobody is emailed
    // about is not a nudge.
    await notifyProviderAgreementProviderTurn(row.id, (req.user as any).id);
    return { success: true };
  }

  // ── Provider self-service: my GoStork contract (Legal Identity tab) ──
  // The live agreement once it is the provider's to see (SENT / COMPLETED -
  // never a DRAFT or one still waiting on the GoStork signature), falling
  // back to the most recent signed copy so a re-send in progress does not
  // hide the contract they already executed.
  @Get("api/provider/gostork-agreement")
  @UseGuards(SessionOrJwtGuard)
  async myAgreement(@Req() req: Request) {
    const user = req.user as any;
    if (!user?.providerId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const live = await (prisma as any).providerAgreement.findFirst({
      where: { providerId: user.providerId, supersededAt: null, status: { in: ["SENT", "COMPLETED"] } },
      orderBy: { createdAt: "desc" },
    });
    const row = live || await (prisma as any).providerAgreement.findFirst({
      where: { providerId: user.providerId, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
    });
    if (!row) return { agreement: null };
    return {
      agreement: {
        id: row.id,
        status: row.status,
        requestedAt: row.requestedAt,
        completedAt: row.completedAt,
      },
    };
  }

  /** Share the agreement with arbitrary email recipients (lawyers, partners).
   *  Provider members share their own agreement; admins any. Sends each
   *  recipient the token-gated public link - no GoStork account needed.
   *  Mints the guest token on demand for agreements created before guest
   *  signing existed. */
  @Post("api/provider-agreements/:id/share")
  @UseGuards(SessionOrJwtGuard)
  async share(@Req() req: Request, @Param("id") id: string, @Body() body: { emails?: string[] }) {
    const user = req.user as any;
    const row = await (prisma as any).providerAgreement.findUnique({
      where: { id },
      select: { id: true, providerId: true, status: true, guestToken: true, provider: { select: { name: true } } },
    });
    if (!row) throw new HttpException("Agreement not found", HttpStatus.NOT_FOUND);
    if (!isAdmin(user) && user.providerId !== row.providerId) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }
    if (!["SENT", "COMPLETED"].includes(row.status)) {
      throw new HttpException("This agreement has not been sent yet", HttpStatus.BAD_REQUEST);
    }
    const emails = Array.from(new Set((body?.emails || [])
      .map((e) => String(e || "").trim().toLowerCase())
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))));
    if (!emails.length) throw new HttpException("Add at least one valid email address", HttpStatus.BAD_REQUEST);
    if (emails.length > 10) throw new HttpException("At most 10 recipients per share", HttpStatus.BAD_REQUEST);

    let guestToken = row.guestToken;
    if (!guestToken) {
      guestToken = (await import("crypto")).randomBytes(24).toString("hex");
      await (prisma as any).providerAgreement.update({ where: { id }, data: { guestToken } });
    }
    const { getBaseUrl } = await import("../../lib/get-base-url");
    await this.notificationService.sendProviderAgreementShareEmail({
      toEmails: emails,
      providerName: row.provider?.name || "Provider",
      sharedByName: user.name || user.email || "A GoStork member",
      url: `${getBaseUrl()}/sign-agreement/${guestToken}`,
    });
    return { shared: emails.length };
  }

  // ── Public: login-free guest signing (token-gated, NO auth) ──
  //
  // The provider signs the agreement BEFORE they ever log in - their
  // onboarding starts after the signature - so the email links here instead
  // of the auth-guarded /provider-agreement/:id page. The token is generated
  // when the provider is notified (chat-router webhook) and is unguessable
  // (24 random bytes). First open stamps guestOpenedAt for admin tracking;
  // signing is tracked by the PandaDoc completion webhook as before.

  @Get("api/public/provider-agreements/:token/session")
  async guestSession(@Param("token") token: string) {
    if (!token || token.length < 20) throw new HttpException("Invalid signing link", HttpStatus.NOT_FOUND);
    const row = await (prisma as any).providerAgreement.findUnique({
      where: { guestToken: token },
      select: { id: true, status: true, signerEmail: true, pandaDocDocumentId: true, guestOpenedAt: true, provider: { select: { name: true } } },
    });
    if (!row) throw new HttpException("Invalid or expired signing link", HttpStatus.NOT_FOUND);

    if (!row.guestOpenedAt) {
      await (prisma as any).providerAgreement.update({
        where: { id: row.id },
        data: { guestOpenedAt: new Date() },
      }).catch(() => {});
    }

    if (row.status === "COMPLETED") {
      return { isCompletedView: true, status: row.status, providerName: row.provider?.name || null };
    }
    if (row.status !== "SENT") {
      throw new HttpException("This agreement is not ready for your signature yet", HttpStatus.BAD_REQUEST);
    }
    if (!row.signerEmail || !row.pandaDocDocumentId) {
      throw new HttpException("Agreement has no signer on record", HttpStatus.BAD_REQUEST);
    }
    const apiKey = process.env.PANDADOC_API_KEY;
    if (!apiKey) throw new HttpException("PandaDoc not configured", HttpStatus.INTERNAL_SERVER_ERROR);
    const signingUrl = await fetchDocumentViewUrl(apiKey, row.pandaDocDocumentId, row.signerEmail);
    if (!signingUrl) throw new HttpException("Could not create signing session - document may not be ready yet", HttpStatus.BAD_REQUEST);
    return { isCompletedView: false, signingUrl, providerName: row.provider?.name || null };
  }

  @Get("api/public/provider-agreements/:token/download")
  async guestDownload(@Res() res: Response, @Param("token") token: string) {
    if (!token || token.length < 20) throw new HttpException("Invalid link", HttpStatus.NOT_FOUND);
    const row = await (prisma as any).providerAgreement.findUnique({
      where: { guestToken: token },
      select: { status: true, pandaDocDocumentId: true },
    });
    if (!row || row.status !== "COMPLETED" || !row.pandaDocDocumentId) {
      throw new HttpException("Not available", HttpStatus.NOT_FOUND);
    }
    const apiKey = process.env.PANDADOC_API_KEY;
    if (!apiKey) throw new HttpException("PandaDoc not configured", HttpStatus.INTERNAL_SERVER_ERROR);
    const pdRes = await fetch(
      `https://api.pandadoc.com/public/v1/documents/${row.pandaDocDocumentId}/download`,
      { headers: { "Authorization": `API-Key ${apiKey}` } },
    );
    if (!pdRes.ok) throw new HttpException("Failed to download", HttpStatus.BAD_GATEWAY);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="gostork-agreement.pdf"`);
    res.send(Buffer.from(await pdRes.arrayBuffer()));
  }

  // ── Shared: signing session + download ──

  @Get("api/provider-agreements/:id/signing-session")
  @UseGuards(SessionOrJwtGuard)
  async signingSession(@Req() req: Request, @Param("id") id: string) {
    try {
      const user = req.user as any;
      const row = await (prisma as any).providerAgreement.findUnique({
        where: { id },
        select: { id: true, providerId: true, status: true },
      });
      if (!row) throw new HttpException("Agreement not found", HttpStatus.NOT_FOUND);
      const authorized = isAdmin(user) || user.providerId === row.providerId;
      if (!authorized) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
      if (row.status === "COMPLETED") {
        return { isCompletedView: true, status: row.status, agreementId: row.id, providerId: row.providerId };
      }
      const session = await getProviderAgreementSigningSession(id, user);
      return { isCompletedView: false, signingUrl: session.signingUrl, agreementId: row.id, providerId: row.providerId, forGoStork: session.forGoStork };
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      this.logger.error(`[ProviderAgreement] signing session error: ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get("api/provider-agreements/:id/download")
  @UseGuards(SessionOrJwtGuard)
  async download(@Req() req: Request, @Res() res: Response, @Param("id") id: string) {
    try {
      const user = req.user as any;
      const row = await (prisma as any).providerAgreement.findUnique({
        where: { id },
        select: { providerId: true, pandaDocDocumentId: true },
      });
      if (!row) throw new HttpException("Agreement not found", HttpStatus.NOT_FOUND);
      const roles = user?.roles || [];
      const hasBillingRole = roles.includes("PROVIDER_ADMIN") || roles.includes("BILLING_MANAGER");
      if (!isAdmin(user) && (user.providerId !== row.providerId || !hasBillingRole)) {
        throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
      }
      if (!row.pandaDocDocumentId) throw new HttpException("No PandaDoc document linked", HttpStatus.BAD_REQUEST);

      const apiKey = process.env.PANDADOC_API_KEY;
      if (!apiKey) throw new HttpException("PandaDoc not configured", HttpStatus.INTERNAL_SERVER_ERROR);

      const pdRes = await fetch(
        `https://api.pandadoc.com/public/v1/documents/${row.pandaDocDocumentId}/download`,
        { headers: { "Authorization": `API-Key ${apiKey}` } },
      );
      if (!pdRes.ok) {
        this.logger.error(`[ProviderAgreement download] PandaDoc error: ${await pdRes.text()}`);
        throw new HttpException("Failed to download from PandaDoc", HttpStatus.BAD_GATEWAY);
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="gostork-agreement-${row.pandaDocDocumentId}.pdf"`);
      res.send(Buffer.from(await pdRes.arrayBuffer()));
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      this.logger.error(`[ProviderAgreement download] ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
