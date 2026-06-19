import {
  Controller, Get, Post, Patch, Delete, Param, Query, Body, Req,
  UseGuards, ForbiddenException, BadRequestException, Inject,
} from "@nestjs/common";
import { Request } from "express";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { SponsorshipService } from "./sponsorship.service";
import { PrismaService } from "../prisma/prisma.service";

type EntityType = "EGG_DONOR" | "SURROGATE" | "SPERM_DONOR" | "DOCTOR" | "CLINIC_PROFILE" | "AGENCY_PROFILE";
const BILLING_ROLES = ["PROVIDER_ADMIN", "BILLING_MANAGER"];

@Controller()
@UseGuards(SessionOrJwtGuard)
export class SponsorshipController {
  constructor(
    @Inject(SponsorshipService) private readonly sponsorship: SponsorshipService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  private isAdmin(req: Request): boolean {
    const roles: string[] = (req.user as any)?.roles || [];
    return roles.includes("GOSTORK_ADMIN");
  }

  /** Provider self-serve gate: a billing-capable provider member, scoped to their own provider. */
  private requireProvider(req: Request): string {
    const user = req.user as any;
    const roles: string[] = user?.roles || [];
    if (this.isAdmin(req)) {
      // admins use the /api/admin/* routes; block them from the self-serve provider scope unless they carry a providerId
      if (!user?.providerId) throw new ForbiddenException("Admins must use the admin sponsorship routes");
      return user.providerId;
    }
    if (!user?.providerId || !roles.some((r) => BILLING_ROLES.includes(r))) {
      throw new ForbiddenException("Sponsorship management requires a billing role");
    }
    return user.providerId;
  }

  private requireAdmin(req: Request) {
    if (!this.isAdmin(req)) throw new ForbiddenException("Admin only");
  }

  private async actingUser(req: Request) {
    const id = (req.user as any)?.id;
    const u = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, stripeCustomerId: true },
    });
    if (!u) throw new ForbiddenException("User not found");
    return u;
  }

  // ─── Shared: pricing ───────────────────────────────────────────────────────

  @Get("api/sponsorship/plans")
  async getPlans() {
    return this.sponsorship.getPlans(true);
  }

  // ─── Provider self-serve ───────────────────────────────────────────────────

  @Get("api/sponsorship/mine")
  async mine(@Req() req: Request) {
    const providerId = this.requireProvider(req);
    return this.sponsorship.getProviderSummary(providerId);
  }

  @Get("api/sponsorship/analytics")
  async analytics(@Req() req: Request) {
    const providerId = this.requireProvider(req);
    return this.sponsorship.getAnalytics(providerId);
  }

  @Get("api/sponsorship/eligible-entities")
  async eligible(@Req() req: Request, @Query("type") type: EntityType) {
    const providerId = this.requireProvider(req);
    return this.sponsorship.getEligibleEntities(providerId, type);
  }

  @Get("api/sponsorship/whole-profile-plan")
  async wholeProfilePlan(@Req() req: Request) {
    const providerId = this.requireProvider(req);
    return this.sponsorship.resolveWholeProfilePlan(providerId);
  }

  @Post("api/sponsorship/checkout")
  async checkout(@Req() req: Request, @Body() body: { planId: string; billingMode: "AUTO_RENEW" | "ONE_TIME" }) {
    const providerId = this.requireProvider(req);
    if (!body?.planId || !["AUTO_RENEW", "ONE_TIME"].includes(body?.billingMode)) {
      throw new BadRequestException("planId and billingMode are required");
    }
    const actingUser = await this.actingUser(req);
    return this.sponsorship.createSponsorship({ providerId, planId: body.planId, billingMode: body.billingMode, actingUser });
  }

  @Post("api/sponsorship/:id/items")
  async addItem(@Req() req: Request, @Param("id") id: string, @Body() body: { entityType: EntityType; entityId: string }) {
    const providerId = this.requireProvider(req);
    return this.sponsorship.addItem({ sponsorshipId: id, providerId, entityType: body.entityType, entityId: body.entityId });
  }

  @Delete("api/sponsorship/:id/items/:itemId")
  async removeItem(@Req() req: Request, @Param("id") id: string, @Param("itemId") itemId: string) {
    const providerId = this.requireProvider(req);
    return this.sponsorship.removeItem({ sponsorshipId: id, providerId, itemId });
  }

  @Post("api/sponsorship/:id/pay")
  async resumePayment(@Req() req: Request, @Param("id") id: string) {
    const providerId = this.requireProvider(req);
    return this.sponsorship.resumePayment({ sponsorshipId: id, providerId });
  }

  @Post("api/sponsorship/:id/cancel")
  async cancel(@Req() req: Request, @Param("id") id: string, @Body() body: { immediate?: boolean }) {
    const providerId = this.requireProvider(req);
    return this.sponsorship.cancel({ sponsorshipId: id, providerId, immediate: !!body?.immediate });
  }

  // ─── Admin ─────────────────────────────────────────────────────────────────

  @Get("api/admin/sponsorship/plans")
  async adminPlans(@Req() req: Request) {
    this.requireAdmin(req);
    return this.sponsorship.getPlans(false);
  }

  @Patch("api/admin/sponsorship/plans/:id")
  async adminUpdatePlan(@Req() req: Request, @Param("id") id: string, @Body() body: any) {
    this.requireAdmin(req);
    return this.sponsorship.updatePlan(id, body);
  }

  @Get("api/admin/sponsorship")
  async adminList(@Req() req: Request, @Query("providerId") providerId: string) {
    this.requireAdmin(req);
    if (!providerId) throw new BadRequestException("providerId required");
    return this.sponsorship.getProviderSummary(providerId);
  }

  @Get("api/admin/sponsorship/analytics")
  async adminAnalytics(@Req() req: Request, @Query("providerId") providerId: string) {
    this.requireAdmin(req);
    if (!providerId) throw new BadRequestException("providerId required");
    return this.sponsorship.getAnalytics(providerId);
  }

  @Get("api/admin/sponsorship/eligible-entities")
  async adminEligible(@Req() req: Request, @Query("providerId") providerId: string, @Query("type") type: EntityType) {
    this.requireAdmin(req);
    if (!providerId) throw new BadRequestException("providerId required");
    return this.sponsorship.getEligibleEntities(providerId, type);
  }

  @Get("api/admin/sponsorship/whole-profile-plan")
  async adminWholeProfilePlan(@Req() req: Request, @Query("providerId") providerId: string) {
    this.requireAdmin(req);
    if (!providerId) throw new BadRequestException("providerId required");
    return this.sponsorship.resolveWholeProfilePlan(providerId);
  }

  @Post("api/admin/sponsorship")
  async adminCreate(
    @Req() req: Request,
    @Body() body: { providerId: string; planId: string; billingMode?: "AUTO_RENEW" | "ONE_TIME"; mode: "CHARGE" | "COMP"; compReason?: string },
  ) {
    this.requireAdmin(req);
    const adminUserId = (req.user as any).id;
    if (!body?.providerId || !body?.planId) throw new BadRequestException("providerId and planId required");
    if (body.mode === "COMP") {
      return this.sponsorship.grantComp({ providerId: body.providerId, planId: body.planId, adminUserId, compReason: body.compReason });
    }
    // CHARGE: create a pending sponsorship + return the client secret for the provider to pay.
    const adminUser = await this.actingUser(req);
    return this.sponsorship.createSponsorship({
      providerId: body.providerId,
      planId: body.planId,
      billingMode: body.billingMode || "AUTO_RENEW",
      actingUser: adminUser,
      createdByAdmin: true,
    });
  }

  @Post("api/admin/sponsorship/:id/items")
  async adminAddItem(@Req() req: Request, @Param("id") id: string, @Body() body: { providerId: string; entityType: EntityType; entityId: string }) {
    this.requireAdmin(req);
    if (!body?.providerId) throw new BadRequestException("providerId required");
    return this.sponsorship.addItem({ sponsorshipId: id, providerId: body.providerId, entityType: body.entityType, entityId: body.entityId });
  }

  @Delete("api/admin/sponsorship/:id/items/:itemId")
  async adminRemoveItem(@Req() req: Request, @Param("id") id: string, @Param("itemId") itemId: string, @Query("providerId") providerId: string) {
    this.requireAdmin(req);
    if (!providerId) throw new BadRequestException("providerId required");
    return this.sponsorship.removeItem({ sponsorshipId: id, providerId, itemId });
  }

  @Post("api/admin/sponsorship/:id/cancel")
  async adminCancel(@Req() req: Request, @Param("id") id: string, @Body() body: { providerId: string; immediate?: boolean }) {
    this.requireAdmin(req);
    if (!body?.providerId) throw new BadRequestException("providerId required");
    return this.sponsorship.cancel({ sponsorshipId: id, providerId: body.providerId, immediate: !!body?.immediate });
  }
}
