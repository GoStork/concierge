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
  resolveTaxFormTemplate,
  TAX_FORM_SETTINGS_FIELDS,
  getW9SigningSession,
  fetchDocumentViewUrl,
} from "../../../pandadoc-service";

function isAdmin(user: any): boolean {
  return !!user?.roles?.includes("GOSTORK_ADMIN");
}

/** Login-free signing link (mirrors ProviderAgreement.guestToken): mints the
 *  token on first use so pre-existing rows get one on resend/remind. */
async function mintW9GuestToken(w9Id: string, existingToken: string | null): Promise<string> {
  if (existingToken) return existingToken;
  const { randomBytes } = await import("crypto");
  const guestToken = randomBytes(24).toString("hex");
  await (prisma as any).providerW9.update({ where: { id: w9Id }, data: { guestToken } });
  return guestToken;
}

function appBaseUrl(): string {
  return getBaseUrl();
}

async function buildW9Status(providerId: string) {
  // W-9 or W-8BEN-E per the provider's legal country - the template set
  // and the labels follow. A row signed for the other form reads as
  // NOT_SENT for this one (formMismatch), so the UI asks for the right form.
  const [tpl, w9raw] = await Promise.all([
    resolveTaxFormTemplate(providerId),
    (prisma as any).providerW9.findUnique({ where: { providerId } }),
  ]);
  const settings: any = await prisma.siteSettings.findFirst({ select: { [TAX_FORM_SETTINGS_FIELDS[tpl.formType].originalName]: true } as any });
  const w9 = w9raw && (w9raw.formType || "W9") === tpl.formType ? w9raw : null;
  // "Configured" means: file uploaded, synced to PandaDoc, AND at least one field
  // assigned to a role (roles set by refreshW9TemplateRoles after Save).
  // Without the field assignment step, sending the form produces an unsignable doc.
  const templateUploaded = !!(tpl.templateUrl && tpl.templateId);
  const fieldsConfigured = !!tpl.roles;
  return {
    formType: tpl.formType,
    formLabel: tpl.label,
    templateConfigured: templateUploaded && fieldsConfigured,
    templateNeedsFields: templateUploaded && !fieldsConfigured,
    templateName: settings?.[TAX_FORM_SETTINGS_FIELDS[tpl.formType].originalName] || null,
    w9Id: w9?.id || null,
    status: w9?.status || "NOT_SENT",
    requestedAt: w9?.requestedAt || null,
    completedAt: w9?.completedAt || null,
  };
}

/** ?form=W9|W8BENE on the admin template endpoints; W9 when absent. */
function formTypeOf(req: Request): "W9" | "W8BENE" {
  const f = String((req.query as any)?.form || "W9").toUpperCase();
  return f === "W8BENE" ? "W8BENE" : "W9";
}

// Raise (or reopen) the "Complete your W-9 form" task on the provider's Home
// page work queue. Idempotent via the unique systemKey (w9:<providerId>).
// Called on BOTH the initial admin send and every reminder, so the request is
// always visible as a to-do; the PandaDoc completion webhook closes it
// (chat-router handleW9Webhook).
async function raiseW9Task(providerId: string, createdByUserId: string) {
  const dueAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  await (prisma as any).parentTask.upsert({
    where: { systemKey: `w9:${providerId}` },
    create: {
      // Provider-scoped work with no family attached: the account key slot
      // carries the providerId, which matches no parent account, so the task
      // renders only on this provider's Home queue and nowhere else.
      parentAccountId: providerId,
      scope: "PROVIDER",
      providerId,
      title: "Complete your W-9 form",
      notes: "GoStork needs your signed W-9 on file before payouts can be sent.",
      type: "TODO",
      priority: "HIGH",
      dueAt,
      source: "SYSTEM",
      systemKey: `w9:${providerId}`,
      deepLink: "/account/legal-identity",
      createdByUserId,
    },
    update: { status: "OPEN", dueAt, completedAt: null, completedByUserId: null },
  });
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
    // Always answered in the W-9 field names so the shared template-config
    // component reads one shape for either form (?form=W8BENE maps the
    // w8bene* columns onto them).
    const F = TAX_FORM_SETTINGS_FIELDS[formTypeOf(req)];
    const settings: any = await prisma.siteSettings.findFirst({
      select: { [F.url]: true, [F.originalName]: true, [F.templateId]: true, [F.roles]: true } as any,
    });
    if (!settings) return {};
    return {
      w9TemplateUrl: settings[F.url] || null,
      w9TemplateOriginalName: settings[F.originalName] || null,
      w9PandaDocTemplateId: settings[F.templateId] || null,
      w9PandaDocRoles: settings[F.roles] || null,
    };
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
      const F = TAX_FORM_SETTINGS_FIELDS[formTypeOf(req)];
      await prisma.siteSettings.update({
        where: { id: existing.id },
        data: {
          [F.url]: url,
          [F.originalName]: originalName || null,
          [F.templateId]: null,
          [F.roles]: null,
          // Mark template version: per-provider docs created from the prior
          // template will be detected as stale and regenerated on next access.
          [F.updatedAt]: new Date(),
        } as any,
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
      const F = TAX_FORM_SETTINGS_FIELDS[formTypeOf(req)];
      await prisma.siteSettings.update({
        where: { id: existing.id },
        data: {
          [F.url]: null,
          [F.originalName]: null,
          [F.templateId]: null,
          [F.roles]: null,
          [F.updatedAt]: new Date(),
        } as any,
      });
    }
    return { success: true };
  }

  @Post("api/admin/w9/sync-template")
  @UseGuards(SessionOrJwtGuard)
  async syncTemplate(@Req() req: Request) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    try {
      const templateId = await syncW9TemplateToPandaDoc(formTypeOf(req));
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
      const eToken = await createW9TemplateEditingSession(user.email, formTypeOf(req));
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
      return await refreshW9TemplateRoles(formTypeOf(req));
    } catch (e: any) {
      this.logger.error(`W-9 refresh roles error: ${e.message}`);
      throw new HttpException(e.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ── Admin: W-9 tracking table (all approved providers with user accounts) ──
  // Scraped/CDC profiles with no login are excluded - nobody there can sign.
  // The GoStork house provider (the row admin users are linked to) is excluded
  // too: GoStork does not W-9 itself.

  @Get("api/admin/w9/providers")
  @UseGuards(SessionOrJwtGuard)
  async listProviderW9s(@Req() req: Request) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const providers = await prisma.provider.findMany({
      where: {
        services: { some: { status: "APPROVED" } },
        users: { some: {} },
        NOT: { users: { some: { roles: { has: "GOSTORK_ADMIN" } } } },
      },
      select: {
        id: true,
        name: true,
        services: {
          where: { status: "APPROVED" },
          select: { providerType: { select: { name: true } } },
        },
        w9: {
          select: { id: true, status: true, requestedAt: true, completedAt: true, signerEmail: true, formType: true },
        },
        legalIdentity: { select: { businessAddressCountry: true, usPayoutEntity: true } },
      },
      orderBy: { name: "asc" },
    });
    // Which providers already have an open W-9 reminder task on their Home page.
    const reminders = await (prisma as any).parentTask.findMany({
      where: { systemKey: { in: providers.map((p: any) => `w9:${p.id}`) }, status: "OPEN" },
      select: { systemKey: true },
    });
    const openReminders = new Set(reminders.map((r: any) => r.systemKey));
    return {
      providers: providers.map((p: any) => ({
        providerId: p.id,
        name: p.name,
        serviceTypes: Array.from(new Set(p.services.map((s: any) => s.providerType.name))),
        // Which form this provider owes (by legal country) and which one the
        // row actually is - a mismatch renders as NOT_SENT for the owed form.
        country: p.legalIdentity?.businessAddressCountry || "US",
        requiredForm: p.legalIdentity?.usPayoutEntity || (p.legalIdentity?.businessAddressCountry || "US").toUpperCase() === "US" ? "W9" : "W8BENE",
        formType: p.w9?.formType || null,
        w9Id: p.w9?.id || null,
        status: p.w9 && (p.w9.formType || "W9") === (p.legalIdentity?.usPayoutEntity || (p.legalIdentity?.businessAddressCountry || "US").toUpperCase() === "US" ? "W9" : "W8BENE") ? p.w9.status : "NOT_SENT",
        requestedAt: p.w9?.requestedAt || null,
        completedAt: p.w9?.completedAt || null,
        signerEmail: p.w9?.signerEmail || null,
        reminderOpen: openReminders.has(`w9:${p.id}`),
      })),
    };
  }

  // Raise a "Complete your W-9 form" task on the provider's Home page work
  // queue. Idempotent via the unique systemKey (w9:<providerId>) - re-sending
  // just reopens/refreshes the same task. The task auto-closes when the
  // PandaDoc completion webhook lands (chat-router handleW9Webhook).
  @Post("api/admin/providers/:providerId/w9/remind")
  @UseGuards(SessionOrJwtGuard)
  async remindW9(@Req() req: Request, @Param("providerId") providerId: string) {
    if (!isAdmin(req.user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const user = req.user as any;
    const w9 = await (prisma as any).providerW9.findUnique({ where: { providerId } });
    if (w9?.status === "COMPLETED") {
      throw new HttpException("This provider's W-9 is already completed.", HttpStatus.BAD_REQUEST);
    }
    const provider = await prisma.provider.findUnique({ where: { id: providerId }, select: { id: true, name: true, email: true } });
    if (!provider) throw new HttpException("Provider not found", HttpStatus.NOT_FOUND);

    await raiseW9Task(providerId, user.id);

    // A nudge nobody is emailed about is not a nudge: re-send the request
    // email with the login-free link (same as agreement reminders).
    if (w9 && w9.status === "SENT") {
      try {
        const guestToken = await mintW9GuestToken(w9.id, w9.guestToken || null);
        await this.notificationService.sendW9RequestNotification({
          providerId,
          providerName: provider.name || "Provider",
          signingUrl: `${appBaseUrl()}/sign-w9/${guestToken}`,
          fallbackSigner: { userId: w9.signerUserId, email: w9.signerEmail || provider.email || "", name: provider.name || "" },
        });
      } catch (notifErr: any) {
        this.logger.error(`[W-9] Reminder notification failed: ${notifErr?.message}`);
      }
    }
    return { success: true };
  }

  // ── Public: login-free guest signing (token-gated, NO auth) ──
  // Mirrors the provider-agreement guest flow: the W-9 request email links
  // here so a signer with no GoStork account can fill and sign. First open
  // stamps guestOpenedAt; completion is tracked by the PandaDoc webhook.

  @Get("api/public/w9/:token/session")
  async guestW9Session(@Param("token") token: string) {
    if (!token || token.length < 20) throw new HttpException("Invalid signing link", HttpStatus.NOT_FOUND);
    const row = await (prisma as any).providerW9.findUnique({
      where: { guestToken: token },
      select: { id: true, status: true, signerEmail: true, pandaDocDocumentId: true, guestOpenedAt: true },
    });
    if (!row) throw new HttpException("Invalid or expired signing link", HttpStatus.NOT_FOUND);
    if (!row.guestOpenedAt) {
      await (prisma as any).providerW9.update({ where: { id: row.id }, data: { guestOpenedAt: new Date() } }).catch(() => {});
    }
    if (row.status === "COMPLETED") {
      return { isCompletedView: true, status: row.status };
    }
    if (!row.signerEmail || !row.pandaDocDocumentId) {
      throw new HttpException("W-9 has no signer on record", HttpStatus.BAD_REQUEST);
    }
    const apiKey = process.env.PANDADOC_API_KEY;
    if (!apiKey) throw new HttpException("PandaDoc not configured", HttpStatus.INTERNAL_SERVER_ERROR);
    const signingUrl = await fetchDocumentViewUrl(apiKey, row.pandaDocDocumentId, row.signerEmail);
    if (!signingUrl) throw new HttpException("Could not create signing session - document may not be ready yet", HttpStatus.BAD_REQUEST);
    return { isCompletedView: false, signingUrl };
  }

  @Get("api/public/w9/:token/download")
  async guestW9Download(@Res() res: Response, @Param("token") token: string) {
    if (!token || token.length < 20) throw new HttpException("Invalid link", HttpStatus.NOT_FOUND);
    const row = await (prisma as any).providerW9.findUnique({
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
    res.setHeader("Content-Disposition", `inline; filename="gostork-w9.pdf"`);
    res.send(Buffer.from(await pdRes.arrayBuffer()));
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
    const tpl = await resolveTaxFormTemplate(providerId);
    if (!tpl.templateUrl || !tpl.templateId) {
      throw new HttpException(`Upload a ${tpl.label} template first.`, HttpStatus.BAD_REQUEST);
    }
    if (!tpl.roles) {
      throw new HttpException(`Configure the ${tpl.label} signature field before sending.`, HttpStatus.BAD_REQUEST);
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
        // Login-free link: the signer often has no working GoStork account
        // yet (W-9s go out during onboarding), so the email must not point
        // at an auth-guarded page.
        const guestToken = await mintW9GuestToken(w9.id, w9.guestToken || null);
        await this.notificationService.sendW9RequestNotification({
          providerId,
          providerName: provider?.name || "Provider",
          signingUrl: `${appBaseUrl()}/sign-w9/${guestToken}`,
          fallbackSigner: { userId: signer.userId, email: signer.email, name: signer.name || signer.email },
        });
      } catch (notifErr: any) {
        this.logger.error(`[W-9] Request notification failed: ${notifErr?.message}`);
      }

      // The request itself is a to-do: put "Complete your W-9 form" on the
      // provider's Home page work queue right away, not only on reminders.
      try {
        await raiseW9Task(providerId, user.id);
      } catch (taskErr: any) {
        this.logger.error(`[W-9] Task raise failed: ${taskErr?.message}`);
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

    const tpl = await resolveTaxFormTemplate(user.providerId);
    if (!tpl.templateUrl || !tpl.templateId || !tpl.roles) {
      throw new HttpException(`${tpl.label} template is not ready yet. Please contact GoStork.`, HttpStatus.BAD_REQUEST);
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

    const tpl = await resolveTaxFormTemplate(user.providerId);
    if (!tpl.templateUrl || !tpl.templateId || !tpl.roles) {
      throw new HttpException(`${tpl.label} template is not ready yet. Please contact GoStork.`, HttpStatus.BAD_REQUEST);
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
