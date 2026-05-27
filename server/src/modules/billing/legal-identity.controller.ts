import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Req,
  Inject,
  HttpException,
  HttpStatus,
  Logger,
  UseGuards,
  Param,
} from "@nestjs/common";
import { Request } from "express";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { LegalIdentityService, type LegalIdentityFormData } from "./legal-identity.service";

/**
 * Provider + admin endpoints for ProviderLegalIdentity. The data backs the
 * Legal Identity tab in /account/legal-identity (provider) and the
 * Payouts + Billing tabs that previously collected this info inline.
 */
@Controller()
export class LegalIdentityController {
  private readonly logger = new Logger(LegalIdentityController.name);

  constructor(
    @Inject(LegalIdentityService) private readonly legalIdentityService: LegalIdentityService,
  ) {}

  // ── Provider self-service ──────────────────────────────────────────────

  @Get("api/provider/legal-identity")
  @UseGuards(SessionOrJwtGuard)
  async getOwn(@Req() req: Request) {
    const user = req.user as any;
    if (!user?.providerId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    return this.legalIdentityService.get(user.providerId);
  }

  @Put("api/provider/legal-identity")
  @UseGuards(SessionOrJwtGuard)
  async updateOwn(@Req() req: Request, @Body() body: LegalIdentityFormData) {
    const user = req.user as any;
    if (!user?.providerId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    return this.legalIdentityService.update(user.providerId, body);
  }

  // ── Admin ──────────────────────────────────────────────────────────────

  @Get("api/admin/providers/:providerId/legal-identity")
  @UseGuards(SessionOrJwtGuard)
  async getForProvider(@Req() req: Request, @Param("providerId") providerId: string) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    return this.legalIdentityService.get(providerId);
  }

  @Put("api/admin/providers/:providerId/legal-identity")
  @UseGuards(SessionOrJwtGuard)
  async updateForProvider(
    @Req() req: Request,
    @Param("providerId") providerId: string,
    @Body() body: LegalIdentityFormData,
  ) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    return this.legalIdentityService.update(providerId, body);
  }

  // ── Manual W-9 sync (admin + provider) ────────────────────────────────

  /**
   * Triggered from the Legal Identity tab UI when the provider sees
   * their W-9 is signed but the row hasn't been auto-filled yet. Also
   * a useful fallback if the PandaDoc webhook didn't fire (test mode,
   * missed event, etc.).
   */
  @Post("api/provider/legal-identity/sync-from-w9")
  @UseGuards(SessionOrJwtGuard)
  async syncOwnFromW9(@Req() req: Request, @Body() body: { force?: boolean }) {
    const user = req.user as any;
    if (!user?.providerId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    return this.legalIdentityService.syncFromW9(user.providerId, { force: !!body?.force });
  }

  @Post("api/admin/providers/:providerId/legal-identity/sync-from-w9")
  @UseGuards(SessionOrJwtGuard)
  async syncForProvider(
    @Req() req: Request,
    @Param("providerId") providerId: string,
    @Body() body: { force?: boolean },
  ) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    return this.legalIdentityService.syncFromW9(providerId, { force: !!body?.force });
  }

  // NOTE: the PandaDoc webhook (POST /api/webhooks/pandadoc) is already
  // handled in server/chat-router.ts where handleW9Webhook calls
  // LegalIdentityService.syncFromW9 on document.completed. A NestJS
  // controller method here would be shadowed by the chat-router route
  // (mounted earlier in the Express stack) and unreachable.
}
