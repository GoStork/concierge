/**
 * International payout rail (Trolley) - HTTP surface.
 *
 *   GET  api/provider/payouts/trolley/widget-url   signed widget URL for the Payouts page iframe
 *   POST api/provider/payouts/trolley/refresh      re-sync readiness from Trolley (button)
 *   POST api/admin/providers/:id/payouts/trolley/refresh  admin equivalent
 *   POST api/webhooks/trolley                      Trolley webhook (signature-verified, idempotent)
 *
 * The webhook also answers Trolley's activation probe: Trolley POSTs a
 * validation request when a webhook is added in the dashboard and only
 * enables it after a 200 - an unsigned/empty probe gets 200 without being
 * processed.
 */
import { Controller, Get, Post, Param, Req, Res, UseGuards, HttpException, HttpStatus, Logger, Inject } from "@nestjs/common";
import { Request, Response } from "express";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { prisma } from "../../../db";
import { TrolleyService } from "./trolley.service";
import { verifyWebhookSignature } from "./trolley.client";

function providerRoleOk(user: any): boolean {
  const r = user?.roles || [];
  return !!user?.providerId && (r.includes("PROVIDER_ADMIN") || r.includes("BILLING_MANAGER"));
}

@Controller()
export class TrolleyController {
  private readonly logger = new Logger(TrolleyController.name);
  // esbuild does not emit decorator metadata, so DI-by-type fails silently -
  // every injection in this codebase is an explicit @Inject().
  constructor(@Inject(TrolleyService) private readonly trolleyService: TrolleyService) {}

  @Get("api/provider/payouts/trolley/widget-url")
  @UseGuards(SessionOrJwtGuard)
  async widgetUrl(@Req() req: Request) {
    const user = req.user as any;
    if (!providerRoleOk(user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    try {
      return await this.trolleyService.widgetUrl(user.providerId);
    } catch (e: any) {
      this.logger.error(`Trolley widget URL failed for provider ${user.providerId}: ${e?.message}`);
      throw new HttpException(e?.message || "Could not start international payout setup", e?.status && e.status < 500 ? e.status : HttpStatus.BAD_REQUEST);
    }
  }

  @Post("api/provider/payouts/trolley/refresh")
  @UseGuards(SessionOrJwtGuard)
  async refreshOwn(@Req() req: Request) {
    const user = req.user as any;
    if (!providerRoleOk(user)) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    await this.trolleyService.syncFromTrolley(user.providerId);
    return { success: true };
  }

  @Post("api/admin/providers/:providerId/payouts/trolley/refresh")
  @UseGuards(SessionOrJwtGuard)
  async refreshAdmin(@Req() req: Request, @Param("providerId") providerId: string) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN")) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    await this.trolleyService.syncFromTrolley(providerId);
    return { success: true };
  }

  @Post("api/webhooks/trolley")
  async webhook(@Req() req: Request, @Res() res: Response) {
    const rawBuf: Buffer | undefined = (req as any).rawBody;
    const rawBody = rawBuf ? rawBuf.toString("utf8") : JSON.stringify(req.body || {});
    const sigHeader = req.headers["x-paymentrails-signature"] as string | undefined;
    const deliveryId = (req.headers["x-paymentrails-delivery"] as string | undefined) || null;

    // Trolley's "is this URL alive" probe when a webhook is created in the
    // dashboard: no signature, trivial body. Answer 200 so the webhook can
    // be enabled; nothing is processed.
    if (!sigHeader && !deliveryId) {
      this.logger.log(`Trolley webhook probe received (${rawBody.slice(0, 80)})`);
      return res.status(200).json({ received: true, probe: true });
    }

    const verified = verifyWebhookSignature(sigHeader, rawBody);
    if (!verified.ok) {
      this.logger.warn(`Trolley webhook rejected: ${verified.reason}`);
      return res.status(400).json({ error: `Invalid signature: ${verified.reason}` });
    }

    let payload: any = req.body;
    if (!payload || typeof payload !== "object") {
      try { payload = JSON.parse(rawBody); } catch { payload = {}; }
    }
    const model = String(payload?.model || "").trim();
    const action = String(payload?.action || "").trim();
    const body = payload?.body ?? payload?.data ?? payload;

    // Idempotency on the delivery id.
    if (deliveryId) {
      const seen = await prisma.trolleyWebhookEvent.findUnique({ where: { deliveryId } }).catch(() => null);
      if (seen) return res.status(200).json({ received: true, duplicate: true });
      await prisma.trolleyWebhookEvent.create({ data: { deliveryId, model, action, payload } }).catch(() => {});
    }

    try {
      const outcome = await this.trolleyService.handleEvent(model, action, body);
      if (deliveryId) await prisma.trolleyWebhookEvent.update({ where: { deliveryId }, data: { status: outcome } }).catch(() => {});
      this.logger.log(`Trolley webhook ${model}.${action}: ${outcome}`);
      return res.status(200).json({ received: true });
    } catch (e: any) {
      this.logger.error(`Trolley webhook ${model}.${action} failed: ${e?.message}`);
      if (deliveryId) await prisma.trolleyWebhookEvent.update({ where: { deliveryId }, data: { status: "error", error: String(e?.message || e).slice(0, 500) } }).catch(() => {});
      // 200 so Trolley does not retry forever on a logic bug; the log row
      // keeps the payload for replay.
      return res.status(200).json({ received: true, error: true });
    }
  }
}
