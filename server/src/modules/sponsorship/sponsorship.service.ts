import { Injectable, Inject, Logger, BadRequestException, NotFoundException, ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationService } from "../notifications/notification.service";
import { invalidateMarketplaceCache } from "../providers/providers.controller";
import * as stripeService from "../../../stripe-service";

type ProductType = "SLOT_BUNDLE" | "WHOLE_PROFILE";
type BillingMode = "AUTO_RENEW" | "ONE_TIME";
type EntityType = "EGG_DONOR" | "SURROGATE" | "SPERM_DONOR" | "DOCTOR" | "CLINIC_PROFILE" | "AGENCY_PROFILE";

function addMonths(from: Date, n: number): Date {
  // Calendar-month add with timestamp fallback for edge dates.
  const d = new Date(from);
  const day = d.getDate();
  d.setMonth(d.getMonth() + n);
  if (d.getDate() < day) d.setDate(0); // clamp e.g. Jan 31 -> Feb 28
  return d;
}
function addOneMonth(from: Date): Date {
  return addMonths(from, 1);
}

const SLOT_NOUN: Record<string, string> = { EGG_DONOR: "egg donor", SPERM_DONOR: "sperm donor", SURROGATE: "surrogate", DOCTOR: "doctor" };
/** Human summary of what a plan includes, for emails: "up to 5 egg donor profiles". */
function planSummary(p: { productType: string; slotCount: number; slotEntityType?: string | null }): string {
  if (p.productType === "WHOLE_PROFILE") return "your top-level profile";
  const noun = SLOT_NOUN[p.slotEntityType || ""] || "profile";
  return `up to ${p.slotCount} ${noun} profile${p.slotCount === 1 ? "" : "s"}`;
}

/** Maps a SponsoredEntityType to the ParentProfileView.profileType string used by the marketplace view tracker. */
const ENTITY_TO_VIEW_TYPE: Partial<Record<EntityType, string>> = {
  EGG_DONOR: "egg-donor",
  SURROGATE: "surrogate",
  SPERM_DONOR: "sperm-donor",
  DOCTOR: "doctor",
};

@Injectable()
export class SponsorshipService {
  private readonly logger = new Logger("Sponsorship");

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  // ─── Plans / pricing config ──────────────────────────────────────────────

  async getPlans(activeOnly = true) {
    return this.prisma.sponsorshipPlan.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: { sortOrder: "asc" },
    });
  }

  async updatePlan(id: string, data: { priceCents?: number; displayName?: string; slotCount?: number; isActive?: boolean; sortOrder?: number }) {
    const plan = await this.prisma.sponsorshipPlan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException("Plan not found");
    // Whole-profile plans always boost a single top-level profile.
    const safe = { ...data };
    if (plan.productType === "WHOLE_PROFILE") delete safe.slotCount;
    return this.prisma.sponsorshipPlan.update({ where: { id }, data: safe });
  }

  /** Create a new sponsorship program (admin). Slot bundles are scoped to one
   *  sub-profile type; whole-profile plans are limited to the two boost types. */
  async createPlan(data: { productType: ProductType; tierKey: string; slotEntityType?: EntityType | null; displayName: string; priceCents: number; slotCount?: number; currency?: string; sortOrder?: number }) {
    if (!data.tierKey?.trim() || !data.displayName?.trim()) throw new BadRequestException("Tier key and display name are required");
    if (data.priceCents == null || data.priceCents < 0) throw new BadRequestException("A valid price is required");
    if (data.productType !== "SLOT_BUNDLE" && data.productType !== "WHOLE_PROFILE") throw new BadRequestException("Invalid product type");

    let slotEntityType: EntityType | null = null;
    if (data.productType === "SLOT_BUNDLE") {
      slotEntityType = data.slotEntityType || null;
      if (!slotEntityType || !["EGG_DONOR", "SPERM_DONOR", "SURROGATE", "DOCTOR"].includes(slotEntityType)) {
        throw new BadRequestException("A slot bundle must target egg donors, sperm donors, surrogates, or doctors");
      }
    } else if (!["whole_profile_ivf", "whole_profile_surrogacy"].includes(data.tierKey)) {
      throw new BadRequestException("Whole-profile plans are limited to the IVF clinic and surrogacy agency types");
    }

    const slotCount = data.productType === "WHOLE_PROFILE" ? 1 : Math.floor(data.slotCount || 0);
    if (data.productType === "SLOT_BUNDLE" && slotCount < 1) throw new BadRequestException("Slot bundles need at least 1 slot");
    const tierKey = data.tierKey.trim();
    const exists = await this.prisma.sponsorshipPlan.findUnique({
      where: { productType_tierKey: { productType: data.productType, tierKey } },
    });
    if (exists) throw new BadRequestException("A plan with this type and key already exists");
    return this.prisma.sponsorshipPlan.create({
      data: {
        productType: data.productType, tierKey, slotEntityType: slotEntityType as any, displayName: data.displayName.trim(),
        priceCents: Math.floor(data.priceCents), currency: data.currency || "USD", slotCount,
        sortOrder: data.sortOrder ?? 99, isActive: true,
      },
    });
  }

  /** Delete a plan if unused; otherwise deactivate it (existing sponsorships reference it). */
  async deletePlan(id: string) {
    const plan = await this.prisma.sponsorshipPlan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException("Plan not found");
    const refs = await this.prisma.sponsorship.count({ where: { planId: id } });
    if (refs > 0) {
      await this.prisma.sponsorshipPlan.update({ where: { id }, data: { isActive: false } });
      return { deactivated: true, message: "This plan has existing sponsorships, so it was deactivated (hidden from new purchases) instead of deleted." };
    }
    await this.prisma.sponsorshipPlan.delete({ where: { id } });
    return { deleted: true };
  }

  /** Which marketplace-card profile types a provider has (a provider can be both). */
  private async providerServiceFlags(providerId: string): Promise<{ isIvf: boolean; isSurrogacy: boolean }> {
    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
      include: { services: { include: { providerType: true } } },
    });
    if (!provider) throw new NotFoundException("Provider not found");
    const names = (provider.services || []).map((s: any) => (s.providerType?.name || "").toLowerCase());
    return {
      isIvf: names.some((n: string) => n.includes("ivf") || n.includes("in vitro")),
      isSurrogacy: names.some((n: string) => n.includes("surrogacy")),
    };
  }

  /** Maps a whole-profile plan to the entity type it boosts. */
  private wholeProfileEntityType(tierKey: string): EntityType | null {
    if (tierKey === "whole_profile_ivf") return "CLINIC_PROFILE";
    if (tierKey === "whole_profile_surrogacy") return "AGENCY_PROFILE";
    return null;
  }

  /**
   * Every whole-profile plan applicable to this provider. A provider that is BOTH
   * an IVF clinic and a surrogacy agency gets both (boost the clinic deck card AND
   * the agency deck card); a provider that is neither gets an empty list.
   */
  async getApplicableWholeProfilePlans(providerId: string) {
    const flags = await this.providerServiceFlags(providerId);
    const tierKeys: string[] = [];
    if (flags.isIvf) tierKeys.push("whole_profile_ivf");
    if (flags.isSurrogacy) tierKeys.push("whole_profile_surrogacy");
    if (!tierKeys.length) return [];
    return this.prisma.sponsorshipPlan.findMany({
      where: { productType: "WHOLE_PROFILE", tierKey: { in: tierKeys }, isActive: true },
      orderBy: { sortOrder: "asc" },
    });
  }

  /**
   * The slot-fillable entity types this provider actually offers, with display
   * labels for the "Slot bundles (...)" header. An egg-donor + surrogacy agency
   * gets donors + surrogates; an IVF clinic gets doctors; a sperm bank gets sperm
   * donors. Drives both the section label and the slot-picker tabs.
   */
  async getApplicableSlotEntityTypes(providerId: string): Promise<{ type: EntityType; label: string }[]> {
    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
      include: { services: { include: { providerType: true } } },
    });
    if (!provider) throw new NotFoundException("Provider not found");
    const names = (provider.services || []).map((s: any) => (s.providerType?.name || "").toLowerCase());
    const out: { type: EntityType; label: string }[] = [];
    if (names.some((n: string) => n.includes("egg donor") || n.includes("egg bank"))) out.push({ type: "EGG_DONOR", label: "donors" });
    if (names.some((n: string) => n.includes("surrogacy"))) out.push({ type: "SURROGATE", label: "surrogates" });
    if (names.some((n: string) => n.includes("sperm"))) out.push({ type: "SPERM_DONOR", label: "sperm donors" });
    if (names.some((n: string) => n.includes("ivf") || n.includes("in vitro"))) out.push({ type: "DOCTOR", label: "doctors" });
    return out;
  }

  /** One sponsorship's details for the in-tab profile-selection flow (Option B). */
  async getCampaign(sponsorshipId: string, providerId: string) {
    const s = await this.prisma.sponsorship.findUnique({
      where: { id: sponsorshipId },
      include: { plan: true, items: { where: { removedAt: null } } },
    });
    if (!s) throw new NotFoundException("Sponsorship not found");
    if (s.providerId !== providerId) throw new ForbiddenException("Not your sponsorship");
    return {
      id: s.id,
      status: s.status,
      planName: s.plan.displayName,
      slotEntityType: s.plan.slotEntityType,
      slotsUsed: s.items.length,
      slotsTotal: s.slotCountSnapshot,
      // entityId -> itemId, so the tab can add (POST) or remove (DELETE by itemId).
      items: s.items.map((it: any) => ({ id: it.id, entityId: it.entityId })),
    };
  }

  /** Validate + resolve the boost target for a whole-profile plan purchase. */
  private async resolveWholeProfileItem(providerId: string, tierKey: string): Promise<EntityType> {
    const entityType = this.wholeProfileEntityType(tierKey);
    if (!entityType) throw new BadRequestException("Unknown whole-profile plan");
    const flags = await this.providerServiceFlags(providerId);
    const ok = (entityType === "CLINIC_PROFILE" && flags.isIvf) || (entityType === "AGENCY_PROFILE" && flags.isSurrogacy);
    if (!ok) throw new BadRequestException("This whole-profile boost does not apply to this provider's services");
    return entityType;
  }

  // ─── Provider-facing reads ──────────────────────────────────────────────

  /** The provider's saved sponsorship card (for the "paying with ••••X" hint), or null. */
  async getSavedCard(providerId: string): Promise<{ brand: string | null; last4: string | null } | null> {
    const provider = await this.prisma.provider.findUnique({ where: { id: providerId }, select: { sponsorStripeCustomerId: true } });
    if (!provider?.sponsorStripeCustomerId) return null;
    const pm = await stripeService.getSponsorDefaultPaymentMethod(provider.sponsorStripeCustomerId);
    return pm ? { brand: pm.brand, last4: pm.last4 } : null;
  }

  async getProviderSummary(providerId: string) {
    const sponsorships = await this.prisma.sponsorship.findMany({
      where: { providerId },
      include: { plan: true, items: { where: { removedAt: null } } },
      orderBy: { createdAt: "desc" },
    });
    return sponsorships.map((s: any) => ({
      ...s,
      slotsUsed: s.items.length,
      slotsTotal: s.slotCountSnapshot,
    }));
  }

  /**
   * The provider's own sub-profiles available to fill slots, returned as uniform
   * cards (photo + display name + subtitle) so the picker shows real profiles
   * instead of raw ids.
   */
  async getEligibleEntities(providerId: string, type: EntityType): Promise<Array<{
    id: string; displayName: string; photoUrl: string | null; subtitle: string | null; status: string | null; sponsored: boolean;
  }>> {
    const isSponsored = (until: any) => !!until && new Date(until).getTime() > Date.now();
    const subtitleOf = (parts: (string | number | null | undefined)[]) =>
      parts.map((p) => (p == null || p === "" ? null : String(p))).filter(Boolean).join(" · ") || null;
    const firstPhoto = (row: any) => row.photoUrl || (Array.isArray(row.photos) && row.photos[0]) || null;

    if (type === "EGG_DONOR" || type === "SPERM_DONOR") {
      const delegate: any = type === "EGG_DONOR" ? this.prisma.eggDonor : this.prisma.spermDonor;
      const rows = await delegate.findMany({
        where: { providerId },
        select: { id: true, firstName: true, externalId: true, age: true, location: true, ethnicity: true, photoUrl: true, photos: true, status: true, sponsoredUntil: true },
        orderBy: { createdAt: "desc" },
      });
      const noun = type === "EGG_DONOR" ? "Donor" : "Donor";
      return rows.map((r: any) => ({
        id: r.id,
        displayName: r.firstName || `${noun} #${r.externalId || r.id.slice(-6)}`,
        photoUrl: firstPhoto(r),
        subtitle: subtitleOf([r.age ? `${r.age} yrs` : null, r.location, r.ethnicity]),
        status: r.status || null,
        sponsored: isSponsored(r.sponsoredUntil),
      }));
    }
    if (type === "SURROGATE") {
      const rows = await this.prisma.surrogate.findMany({
        where: { providerId },
        select: { id: true, firstName: true, externalId: true, age: true, location: true, ethnicity: true, photoUrl: true, photos: true, status: true, sponsoredUntil: true },
        orderBy: { createdAt: "desc" },
      });
      return rows.map((r: any) => ({
        id: r.id,
        displayName: r.firstName || `Surrogate #${r.externalId || r.id.slice(-6)}`,
        photoUrl: firstPhoto(r),
        subtitle: subtitleOf([r.age ? `${r.age} yrs` : null, r.location, r.ethnicity]),
        status: r.status || null,
        sponsored: isSponsored(r.sponsoredUntil),
      }));
    }
    if (type === "DOCTOR") {
      const rows = await this.prisma.providerMember.findMany({
        where: { providerId, isPublicProfile: true },
        select: { id: true, name: true, title: true, photoUrl: true, highResPhotoUrl: true, sponsoredUntil: true },
        orderBy: { sortOrder: "asc" },
      });
      return rows.map((r: any) => ({
        id: r.id,
        displayName: r.name || `Doctor #${r.id.slice(-6)}`,
        photoUrl: r.highResPhotoUrl || r.photoUrl || null,
        subtitle: r.title || null,
        status: null,
        sponsored: isSponsored(r.sponsoredUntil),
      }));
    }
    throw new BadRequestException("Unsupported entity type for slot fill");
  }

  // ─── Checkout / creation ─────────────────────────────────────────────────

  async createSponsorship(params: {
    providerId: string;
    planId: string;
    billingMode: BillingMode;
    actingUser: { id: string; email: string; name?: string | null; stripeCustomerId?: string | null };
    createdByAdmin?: boolean;
  }): Promise<{ sponsorshipId: string; clientSecret: string | null; activated: boolean; savedCard: { brand: string | null; last4: string | null } | null }> {
    const plan = await this.prisma.sponsorshipPlan.findUnique({ where: { id: params.planId } });
    if (!plan || !plan.isActive) throw new NotFoundException("Plan not found or inactive");

    // One pending checkout at a time - don't let a provider stack multiple
    // unpaid sponsorships. They must complete or discard the pending one first.
    const pending = await this.prisma.sponsorship.findFirst({
      where: { providerId: params.providerId, status: "PENDING_PAYMENT" },
    });
    if (pending) {
      throw new BadRequestException("There's already a sponsorship awaiting payment. Discard or complete it (under “Your sponsorships” below) before starting another.");
    }

    // Provider-level customer so a card saved by one billing user is reused by all.
    const provider = await this.prisma.provider.findUnique({ where: { id: params.providerId }, select: { sponsorStripeCustomerId: true } });
    const customerId = await stripeService.getOrCreateSponsorCustomer({
      providerId: params.providerId,
      email: params.actingUser.email,
      name: params.actingUser.name,
      existingCustomerId: provider?.sponsorStripeCustomerId,
    });
    if (provider?.sponsorStripeCustomerId !== customerId) {
      await this.prisma.provider.update({ where: { id: params.providerId }, data: { sponsorStripeCustomerId: customerId } }).catch(() => {});
    }

    const sponsorship = await this.prisma.sponsorship.create({
      data: {
        providerId: params.providerId,
        planId: plan.id,
        productType: plan.productType,
        billingMode: params.billingMode,
        status: "PENDING_PAYMENT",
        priceCentsSnapshot: plan.priceCents,
        currency: plan.currency,
        slotCountSnapshot: plan.slotCount,
        stripeCustomerId: customerId,
        createdByAdmin: !!params.createdByAdmin,
        createdByUserId: params.actingUser.id,
      },
    });

    // Whole-profile auto-fills its single slot with the provider's own profile.
    // The boost target (clinic vs agency deck) comes from the specific plan bought.
    if (plan.productType === "WHOLE_PROFILE") {
      const entityType = await this.resolveWholeProfileItem(params.providerId, plan.tierKey);
      await this.prisma.sponsorshipItem.create({
        data: { sponsorshipId: sponsorship.id, entityType, entityId: params.providerId },
      });
    }

    // Reuse a previously saved card (Option B). Admin "send payment request"
    // never auto-charges - it always routes to the provider to confirm.
    const savedCard = params.createdByAdmin ? null : await stripeService.getSponsorDefaultPaymentMethod(customerId);

    let clientSecret: string | null = null;
    let activated = false;

    try {
    if (params.billingMode === "AUTO_RENEW") {
      const sub = await stripeService.createSponsorshipSubscription({
        customerId,
        planDisplayName: `GoStork Sponsorship - ${plan.displayName}`,
        amountCents: plan.priceCents,
        currency: plan.currency,
        preProvisionedPriceId: plan.stripePriceId,
        sponsorshipId: sponsorship.id,
        providerId: params.providerId,
        defaultPaymentMethod: savedCard?.id || null,
      });
      await this.prisma.sponsorship.update({
        where: { id: sponsorship.id },
        data: { stripeSubscriptionId: sub.subscriptionId, stripePriceId: sub.priceId },
      });
      if (savedCard && !sub.paymentIntentClientSecret && ["active", "trialing"].includes(sub.status)) {
        // Saved card charged the first invoice off-session - activate now.
        await this.activate(sponsorship.id, sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000) : addOneMonth(new Date()));
        activated = true;
      } else {
        clientSecret = sub.paymentIntentClientSecret; // no saved card, or auth needed
      }
    } else if (savedCard) {
      // ONE_TIME with a saved card: charge off-session.
      const charge = await stripeService.chargeSponsorshipOffSession({
        customerId, paymentMethodId: savedCard.id,
        amountCents: plan.priceCents, currency: plan.currency,
        description: `GoStork Sponsorship - ${plan.displayName} (1 month)`,
        sponsorshipId: sponsorship.id, providerId: params.providerId,
      });
      await this.prisma.sponsorship.update({ where: { id: sponsorship.id }, data: { stripePaymentIntentId: charge.paymentIntentId } });
      if (charge.status === "succeeded") {
        await this.activate(sponsorship.id, addOneMonth(new Date()));
        activated = true;
      } else if (charge.status === "requires_action") {
        clientSecret = charge.clientSecret;
      } else {
        // Saved card failed - fall back to a fresh interactive PaymentIntent.
        const pi = await stripeService.createSponsorshipOneTimeIntent({
          customerId, amountCents: plan.priceCents, currency: plan.currency,
          description: `GoStork Sponsorship - ${plan.displayName} (1 month)`,
          sponsorshipId: sponsorship.id, providerId: params.providerId,
        });
        await this.prisma.sponsorship.update({ where: { id: sponsorship.id }, data: { stripePaymentIntentId: pi.paymentIntentId } });
        clientSecret = pi.clientSecret;
      }
    } else {
      const pi = await stripeService.createSponsorshipOneTimeIntent({
        customerId,
        amountCents: plan.priceCents,
        currency: plan.currency,
        description: `GoStork Sponsorship - ${plan.displayName} (1 month)`,
        sponsorshipId: sponsorship.id,
        providerId: params.providerId,
      });
      clientSecret = pi.clientSecret;
      await this.prisma.sponsorship.update({
        where: { id: sponsorship.id },
        data: { stripePaymentIntentId: pi.paymentIntentId },
      });
    }
    } catch (e: any) {
      // Stripe failed (e.g. a restricted key without subscription permissions).
      // Roll back the pending row so it doesn't block the provider's next attempt,
      // log the real error for us, and surface a clean message to the provider.
      await this.prisma.sponsorshipItem.deleteMany({ where: { sponsorshipId: sponsorship.id } }).catch(() => {});
      await this.prisma.sponsorship.delete({ where: { id: sponsorship.id } }).catch(() => {});
      this.logger.error(`Sponsorship checkout failed (provider ${params.providerId}, plan ${plan.tierKey}, ${params.billingMode}): ${e?.message}`);
      throw new BadRequestException(
        params.billingMode === "AUTO_RENEW"
          ? "We couldn't set up the auto-renewing subscription. Please try “One month” billing instead, or contact support."
          : "We couldn't start the payment. Please try again or contact support.",
      );
    }

    // Mock mode (no Stripe keys): activate immediately so dev can exercise the flow.
    if (!stripeService.isStripeConfigured()) {
      await this.activate(sponsorship.id, addOneMonth(new Date()));
      activated = true;
    } else if (params.createdByAdmin) {
      // Admin "send payment request": notify the provider's billing contacts so
      // they can complete payment from their dashboard.
      await this.notifications.sendSponsorshipNotification({
        providerId: params.providerId, kind: "payment_requested", planName: plan.displayName, programDetail: planSummary(plan),
      }).catch((e) => this.logger.warn(`payment-request notify failed: ${e.message}`));
    }

    return { sponsorshipId: sponsorship.id, clientSecret, activated, savedCard: savedCard ? { brand: savedCard.brand, last4: savedCard.last4 } : null };
  }

  /** Returns a fresh client secret to complete payment on a PENDING sponsorship
   *  (e.g. an admin-initiated "payment request" the provider finishes later). */
  async resumePayment(params: { sponsorshipId: string; providerId: string }): Promise<{ clientSecret: string | null }> {
    const sponsorship = await this.prisma.sponsorship.findUnique({
      where: { id: params.sponsorshipId }, include: { plan: { select: { displayName: true, productType: true, slotCount: true, slotEntityType: true } } },
    });
    if (!sponsorship) throw new NotFoundException("Sponsorship not found");
    if (sponsorship.providerId !== params.providerId) throw new ForbiddenException("Not your sponsorship");
    if (sponsorship.status !== "PENDING_PAYMENT") throw new BadRequestException("This sponsorship is not awaiting payment");

    if (sponsorship.billingMode === "AUTO_RENEW" && sponsorship.stripeSubscriptionId) {
      const clientSecret = await stripeService.getSponsorshipSubscriptionClientSecret(sponsorship.stripeSubscriptionId);
      return { clientSecret };
    }
    // ONE_TIME: mint a fresh PaymentIntent (the old one may have expired).
    const pi = await stripeService.createSponsorshipOneTimeIntent({
      customerId: sponsorship.stripeCustomerId,
      amountCents: sponsorship.priceCentsSnapshot,
      currency: sponsorship.currency,
      description: `GoStork Sponsorship - ${sponsorship.plan.displayName} (1 month)`,
      sponsorshipId: sponsorship.id,
      providerId: sponsorship.providerId,
    });
    await this.prisma.sponsorship.update({ where: { id: sponsorship.id }, data: { stripePaymentIntentId: pi.paymentIntentId } });
    return { clientSecret: pi.clientSecret };
  }

  /** Admin-only: grant a free (comped) sponsorship that activates immediately, no charge. */
  async grantComp(params: {
    providerId: string;
    planId: string;
    adminUserId: string;
    compReason?: string;
    months?: number;
  }): Promise<{ sponsorshipId: string }> {
    const plan = await this.prisma.sponsorshipPlan.findUnique({ where: { id: params.planId } });
    if (!plan || !plan.isActive) throw new NotFoundException("Plan not found or inactive");
    // Admin chooses how long the complimentary sponsorship runs (1-36 months).
    const months = Math.min(36, Math.max(1, Math.floor(params.months || 1)));

    const now = new Date();
    const sponsorship = await this.prisma.sponsorship.create({
      data: {
        providerId: params.providerId,
        planId: plan.id,
        productType: plan.productType,
        billingMode: "ONE_TIME",
        status: "PENDING_PAYMENT",
        priceCentsSnapshot: plan.priceCents,
        currency: plan.currency,
        slotCountSnapshot: plan.slotCount,
        isComped: true,
        compedByUserId: params.adminUserId,
        compReason: params.compReason || null,
        createdByAdmin: true,
        createdByUserId: params.adminUserId,
      },
    });

    if (plan.productType === "WHOLE_PROFILE") {
      const entityType = await this.resolveWholeProfileItem(params.providerId, plan.tierKey);
      await this.prisma.sponsorshipItem.create({
        data: { sponsorshipId: sponsorship.id, entityType, entityId: params.providerId },
      });
    }

    await this.activate(sponsorship.id, addMonths(now, months));
    return { sponsorshipId: sponsorship.id };
  }

  // ─── Slot items ──────────────────────────────────────────────────────────

  async addItem(params: { sponsorshipId: string; providerId: string; entityType: EntityType; entityId: string }) {
    const sponsorship = await this.prisma.sponsorship.findUnique({
      where: { id: params.sponsorshipId },
      include: { items: { where: { removedAt: null } }, plan: { select: { slotEntityType: true } } },
    });
    if (!sponsorship) throw new NotFoundException("Sponsorship not found");
    if (sponsorship.providerId !== params.providerId) throw new ForbiddenException("Not your sponsorship");
    if (sponsorship.productType === "WHOLE_PROFILE") {
      throw new BadRequestException("Whole-profile sponsorships do not have fillable slots");
    }
    if (["CLINIC_PROFILE", "AGENCY_PROFILE"].includes(params.entityType)) {
      throw new BadRequestException("Use a whole-profile sponsorship for the provider's own profile");
    }
    // A typed slot bundle only accepts its own sub-profile type.
    if (sponsorship.plan?.slotEntityType && params.entityType !== sponsorship.plan.slotEntityType) {
      throw new BadRequestException(`This bundle only sponsors ${String(sponsorship.plan.slotEntityType).replace("_", " ").toLowerCase()}s.`);
    }
    if (sponsorship.items.length >= sponsorship.slotCountSnapshot) {
      throw new BadRequestException(`All ${sponsorship.slotCountSnapshot} slots are filled. Remove one or upgrade your tier.`);
    }
    await this.assertEntityOwnership(params.entityType, params.entityId, params.providerId);

    // Reactivate a soft-removed item or create a new one (idempotent on the unique key).
    const existing = await this.prisma.sponsorshipItem.findUnique({
      where: { sponsorshipId_entityType_entityId: { sponsorshipId: params.sponsorshipId, entityType: params.entityType, entityId: params.entityId } },
    });
    let item;
    if (existing) {
      if (!existing.removedAt) return existing; // already active
      item = await this.prisma.sponsorshipItem.update({ where: { id: existing.id }, data: { removedAt: null, addedAt: new Date() } });
    } else {
      item = await this.prisma.sponsorshipItem.create({
        data: { sponsorshipId: params.sponsorshipId, entityType: params.entityType, entityId: params.entityId },
      });
    }

    if (sponsorship.status === "ACTIVE") {
      await this.restampEntity(params.entityType, params.entityId);
      invalidateMarketplaceCache("marketplace:");
    }
    return item;
  }

  async removeItem(params: { sponsorshipId: string; providerId: string; itemId: string }) {
    const item = await this.prisma.sponsorshipItem.findUnique({
      where: { id: params.itemId },
      include: { sponsorship: true },
    });
    if (!item || item.sponsorshipId !== params.sponsorshipId) throw new NotFoundException("Item not found");
    if (item.sponsorship.providerId !== params.providerId) throw new ForbiddenException("Not your sponsorship");
    if (item.removedAt) return item;
    const updated = await this.prisma.sponsorshipItem.update({ where: { id: item.id }, data: { removedAt: new Date() } });
    // Recompute the entity's boost from any other still-active coverage.
    await this.restampEntity(item.entityType as EntityType, item.entityId);
    invalidateMarketplaceCache("marketplace:");
    return updated;
  }

  // ─── Cancellation ────────────────────────────────────────────────────────

  async cancel(params: { sponsorshipId: string; providerId: string; immediate?: boolean }) {
    const sponsorship = await this.prisma.sponsorship.findUnique({ where: { id: params.sponsorshipId } });
    if (!sponsorship) throw new NotFoundException("Sponsorship not found");
    if (sponsorship.providerId !== params.providerId) throw new ForbiddenException("Not your sponsorship");

    if (sponsorship.stripeSubscriptionId) {
      await stripeService.cancelSponsorshipSubscription({
        subscriptionId: sponsorship.stripeSubscriptionId,
        cancelAtPeriodEnd: !params.immediate,
      });
    }

    if (params.immediate) {
      await this.deactivate(sponsorship.id, "CANCELED");
    } else {
      // Auto-renew off; boost runs out at currentPeriodEnd, swept later.
      await this.prisma.sponsorship.update({ where: { id: sponsorship.id }, data: { canceledAt: new Date() } });
    }
    return { ok: true };
  }

  // ─── Lifecycle primitives (also called by the webhook + scheduler) ─────────

  /** Activate (or renew) a sponsorship and stamp the boost onto every active item. Idempotent. */
  async activate(sponsorshipId: string, currentPeriodEnd: Date) {
    const sponsorship = await this.prisma.sponsorship.findUnique({
      where: { id: sponsorshipId },
      include: { items: { where: { removedAt: null } }, plan: { select: { displayName: true, productType: true, slotCount: true, slotEntityType: true } } },
    });
    if (!sponsorship) return;
    const isFirstActivation = sponsorship.status === "PENDING_PAYMENT";

    await this.prisma.sponsorship.update({
      where: { id: sponsorshipId },
      data: {
        status: "ACTIVE",
        currentPeriodStart: sponsorship.currentPeriodStart || new Date(),
        currentPeriodEnd,
        endedAt: null,
      },
    });

    for (const item of sponsorship.items) {
      await this.restampEntity(item.entityType as EntityType, item.entityId);
    }
    invalidateMarketplaceCache("marketplace:");
    // Email + in-app on the first activation only - renewals shouldn't spam the provider.
    if (isFirstActivation) {
      await this.notifications.sendSponsorshipNotification({
        providerId: sponsorship.providerId, kind: "activated", planName: sponsorship.plan.displayName, programDetail: planSummary(sponsorship.plan), currentPeriodEnd,
      }).catch((e) => this.logger.warn(`activate notify failed: ${e.message}`));
    }
    this.logger.log(`Activated sponsorship ${sponsorshipId} until ${currentPeriodEnd.toISOString()}${isFirstActivation ? " (first)" : " (renewal)"}`);
  }

  /** Mark a sponsorship terminated and clear its boost (respecting other coverage). */
  async deactivate(sponsorshipId: string, status: "EXPIRED" | "CANCELED") {
    const sponsorship = await this.prisma.sponsorship.findUnique({
      where: { id: sponsorshipId },
      include: { items: { where: { removedAt: null } }, plan: { select: { displayName: true, productType: true, slotCount: true, slotEntityType: true } } },
    });
    if (!sponsorship) return;
    // Don't re-notify (or re-clear) an already-terminated sponsorship.
    const alreadyEnded = sponsorship.status === "EXPIRED" || sponsorship.status === "CANCELED";

    await this.prisma.sponsorship.update({
      where: { id: sponsorshipId },
      data: { status, endedAt: new Date() },
    });

    // Recompute each entity's boost from any OTHER still-active sponsorship.
    for (const item of sponsorship.items) {
      await this.restampEntity(item.entityType as EntityType, item.entityId);
    }
    invalidateMarketplaceCache("marketplace:");
    if (!alreadyEnded) {
      await this.notifications.sendSponsorshipNotification({
        providerId: sponsorship.providerId, kind: status === "EXPIRED" ? "expired" : "canceled", planName: sponsorship.plan.displayName, programDetail: planSummary(sponsorship.plan),
      }).catch((e) => this.logger.warn(`deactivate notify failed: ${e.message}`));
    }
    this.logger.log(`Deactivated sponsorship ${sponsorshipId} (${status})`);
  }

  async markPastDue(sponsorshipId: string) {
    const sponsorship = await this.prisma.sponsorship.findUnique({
      where: { id: sponsorshipId }, include: { plan: { select: { displayName: true, productType: true, slotCount: true, slotEntityType: true } } },
    });
    if (!sponsorship || sponsorship.status === "PAST_DUE") return;
    await this.prisma.sponsorship.update({ where: { id: sponsorshipId }, data: { status: "PAST_DUE" } }).catch(() => {});
    await this.notifications.sendSponsorshipNotification({
      providerId: sponsorship.providerId, kind: "payment_failed", planName: sponsorship.plan.displayName, programDetail: planSummary(sponsorship.plan),
    }).catch((e) => this.logger.warn(`pastDue notify failed: ${e.message}`));
  }

  /**
   * Recompute an entity's denormalized sponsoredUntil from ALL active sponsorships
   * that cover it (handles double-coverage by taking the max period end). Bumps
   * the rotation seed so the marketplace shuffle re-orders.
   */
  private async restampEntity(entityType: EntityType, entityId: string) {
    const now = new Date();
    const covering = await this.prisma.sponsorshipItem.findMany({
      where: {
        entityType: entityType as any,
        entityId,
        removedAt: null,
        sponsorship: { status: "ACTIVE", currentPeriodEnd: { gt: now } },
      },
      include: { sponsorship: { select: { currentPeriodEnd: true } } },
    });
    const maxEnd = covering.reduce<Date | null>((acc, it: any) => {
      const e = it.sponsorship?.currentPeriodEnd ? new Date(it.sponsorship.currentPeriodEnd) : null;
      if (!e) return acc;
      return !acc || e > acc ? e : acc;
    }, null);

    const data: any = { sponsoredUntil: maxEnd, sponsorBoostSeed: { increment: 1 } };
    const delegate = this.entityDelegate(entityType);
    await delegate.update({ where: { id: entityId }, data }).catch((e: any) => {
      this.logger.warn(`restampEntity failed for ${entityType} ${entityId}: ${e.message}`);
    });
  }

  private entityDelegate(entityType: EntityType): any {
    switch (entityType) {
      case "EGG_DONOR": return this.prisma.eggDonor;
      case "SURROGATE": return this.prisma.surrogate;
      case "SPERM_DONOR": return this.prisma.spermDonor;
      case "DOCTOR": return this.prisma.providerMember;
      case "CLINIC_PROFILE":
      case "AGENCY_PROFILE": return this.prisma.provider;
    }
  }

  private async assertEntityOwnership(entityType: EntityType, entityId: string, providerId: string) {
    if (entityType === "CLINIC_PROFILE" || entityType === "AGENCY_PROFILE") {
      if (entityId !== providerId) throw new ForbiddenException("Profile does not belong to this provider");
      return;
    }
    const delegate = this.entityDelegate(entityType);
    const row = await delegate.findUnique({ where: { id: entityId }, select: { providerId: true } });
    if (!row) throw new NotFoundException("Profile not found");
    if (row.providerId !== providerId) throw new ForbiddenException("Profile does not belong to this provider");
  }

  // ─── Webhook routing ───────────────────────────────────────────────────────

  async handleStripeWebhook(parsed: ReturnType<typeof stripeService.parseSponsorshipEvent>) {
    if (!parsed) return;
    const sponsorship = await this.resolveSponsorship(parsed);
    if (!sponsorship) {
      this.logger.warn(`Sponsorship webhook ${parsed.type}: no matching sponsorship`);
      return;
    }

    const periodEndDate = parsed.currentPeriodEnd ? new Date(parsed.currentPeriodEnd * 1000) : null;

    switch (parsed.type) {
      case "payment_intent.succeeded":
        // One-time month paid. Remember the card on the provider customer so the
        // next purchase reuses it without re-entry (Option B).
        if (parsed.paymentMethodId && sponsorship.stripeCustomerId) {
          await stripeService.setSponsorDefaultPaymentMethod(sponsorship.stripeCustomerId, parsed.paymentMethodId).catch(() => {});
        }
        await this.activate(sponsorship.id, addOneMonth(new Date()));
        break;
      case "payment_intent.canceled":
        if (sponsorship.status === "PENDING_PAYMENT") {
          await this.prisma.sponsorship.update({ where: { id: sponsorship.id }, data: { status: "CANCELED", endedAt: new Date() } });
        }
        break;
      case "payment_intent.payment_failed":
        // Leave PENDING_PAYMENT so the provider can retry; the sweep cancels stale ones.
        break;
      case "customer.subscription.created":
        await this.prisma.sponsorship.update({
          where: { id: sponsorship.id },
          data: {
            stripeSubscriptionId: parsed.stripeSubscriptionId || sponsorship.stripeSubscriptionId,
            currentPeriodEnd: periodEndDate || sponsorship.currentPeriodEnd,
          },
        });
        break;
      case "customer.subscription.updated":
        await this.prisma.sponsorship.update({
          where: { id: sponsorship.id },
          data: { canceledAt: parsed.cancelAtPeriodEnd ? (sponsorship.canceledAt || new Date()) : null },
        });
        if (parsed.subscriptionStatus === "canceled") {
          await this.deactivate(sponsorship.id, "CANCELED");
        }
        break;
      case "customer.subscription.deleted":
        await this.deactivate(sponsorship.id, "CANCELED");
        break;
      case "invoice.payment_succeeded":
        await this.activate(sponsorship.id, periodEndDate || addOneMonth(new Date()));
        break;
      case "invoice.payment_failed":
        await this.markPastDue(sponsorship.id);
        break;
    }
  }

  /** Deactivate a sponsorship whose one-time charge was refunded/disputed. Called from the refund webhook branch. */
  async deactivateByPaymentIntent(paymentIntentId: string) {
    const sponsorship = await this.prisma.sponsorship.findFirst({ where: { stripePaymentIntentId: paymentIntentId } });
    if (sponsorship) await this.deactivate(sponsorship.id, "CANCELED");
  }

  private async resolveSponsorship(parsed: NonNullable<ReturnType<typeof stripeService.parseSponsorshipEvent>>) {
    if (parsed.sponsorshipId) {
      const s = await this.prisma.sponsorship.findUnique({ where: { id: parsed.sponsorshipId } });
      if (s) return s;
    }
    if (parsed.stripeSubscriptionId) {
      const s = await this.prisma.sponsorship.findFirst({ where: { stripeSubscriptionId: parsed.stripeSubscriptionId } });
      if (s) return s;
    }
    if (parsed.paymentIntentId) {
      const s = await this.prisma.sponsorship.findFirst({ where: { stripePaymentIntentId: parsed.paymentIntentId } });
      if (s) return s;
    }
    return null;
  }

  // ─── Analytics ─────────────────────────────────────────────────────────────

  async getAnalytics(providerId: string, rangeDays?: number) {
    const sponsorships = await this.prisma.sponsorship.findMany({
      where: { providerId },
      include: { plan: true, items: { where: { removedAt: null } } },
      orderBy: { createdAt: "desc" },
    });

    // Active window = from the earliest active sponsorship's period start. If the
    // provider has NO active sponsorship there is no window, and every engagement
    // metric is 0 - we never count provider-wide activity that wasn't sponsored.
    const active = sponsorships.filter((s: any) => s.status === "ACTIVE");
    const windowStart: Date | null = active.reduce<Date | null>((acc, s: any) => {
      const start = s.currentPeriodStart ? new Date(s.currentPeriodStart) : null;
      if (!start) return acc;
      return !acc || start < acc ? start : acc;
    }, null);

    // Effective window: a finite range (7/30d) zooms in, but never earlier than
    // the sponsorship start (we only ever count "while sponsored" activity).
    const now = new Date();
    const DAY = 86_400_000;
    const effStart: Date | null = windowStart
      ? (rangeDays ? new Date(Math.max(windowStart.getTime(), now.getTime() - rangeDays * DAY)) : windowStart)
      : null;

    // Collect sponsored entity ids by type across active sponsorships.
    const idsByType: Record<string, Set<string>> = {};
    for (const s of active) {
      for (const it of s.items) {
        (idsByType[it.entityType] ||= new Set()).add(it.entityId);
      }
    }
    const setToArr = (k: string) => Array.from(idsByType[k] || []);
    const allEntityIds = Array.from(new Set(Object.values(idsByType).flatMap((s) => Array.from(s))));
    const donorLikeIds = Array.from(new Set([...setToArr("EGG_DONOR"), ...setToArr("SPERM_DONOR")]));
    const profileLikeIds = Array.from(new Set([...setToArr("DOCTOR"), ...setToArr("CLINIC_PROFILE"), ...setToArr("AGENCY_PROFILE")]));

    const db = this.prisma.client;

    // Impressions (ParentProfileView) for any sponsored entity within the window.
    const views = windowStart && allEntityIds.length
      ? await db.parentProfileView.findMany({
          where: { profileId: { in: allEntityIds }, viewedAt: { gte: effStart } },
          select: { profileId: true, viewedAt: true },
        })
      : [];

    // Saves vs passes - donors (UserDonorPreference) + doctors/clinics/agencies (UserProfilePreference).
    const donorPrefs = windowStart && donorLikeIds.length
      ? await db.userDonorPreference.findMany({
          where: { donorId: { in: donorLikeIds }, createdAt: { gte: effStart } },
          select: { donorId: true, type: true },
        })
      : [];
    const profilePrefs = windowStart && profileLikeIds.length
      ? await db.userProfilePreference.findMany({
          where: { entityId: { in: profileLikeIds }, createdAt: { gte: effStart } },
          select: { entityId: true, type: true },
        })
      : [];

    const saves = donorPrefs.filter((p: any) => p.type === "favorite").length + profilePrefs.filter((p: any) => p.type === "favorite").length;
    const passes = donorPrefs.filter((p: any) => p.type === "skip").length + profilePrefs.filter((p: any) => p.type === "skip").length;

    // Inquiries: whisper questions about a SPONSORED profile (via the chat
    // session's subject), within the sponsored window - not provider-wide. Fetched
    // (not just counted) so we can also break inquiries down per profile.
    const inquiryRows = windowStart && allEntityIds.length
      ? await db.silentQuery.findMany({
          where: { providerId, createdAt: { gte: effStart }, session: { subjectProfileId: { in: allEntityIds } } },
          select: { session: { select: { subjectProfileId: true } } },
        })
      : [];
    const inquiries = inquiryRows.length;
    // Hot leads are a provider-level signal (not tied to one profile); count only
    // within the sponsored window, so 0 when the provider isn't currently sponsored.
    const hotLeads = windowStart
      ? await db.intendedParentProfile.count({ where: { hotLeadProviderId: providerId, hotLeadAt: { gte: effStart } } })
      : 0;

    // Time series (views per day).
    const byDay = new Map<string, number>();
    for (const v of views) {
      const day = new Date(v.viewedAt).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
    }
    const timeSeries = Array.from(byDay.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, impressions]) => ({ date, impressions }));

    // Per-profile impression/save breakdown.
    const impressionsById = new Map<string, number>();
    for (const v of views) impressionsById.set(v.profileId, (impressionsById.get(v.profileId) || 0) + 1);
    const savesById = new Map<string, number>();
    for (const p of donorPrefs) if (p.type === "favorite") savesById.set(p.donorId, (savesById.get(p.donorId) || 0) + 1);
    for (const p of profilePrefs) if (p.type === "favorite") savesById.set(p.entityId, (savesById.get(p.entityId) || 0) + 1);
    const inquiriesById = new Map<string, number>();
    for (const r of inquiryRows) {
      const pid = (r as any).session?.subjectProfileId;
      if (pid) inquiriesById.set(pid, (inquiriesById.get(pid) || 0) + 1);
    }

    const perProfile = await this.labelEntities(active, impressionsById, savesById, inquiriesById);

    // Consultations booked while sponsored - the bottom-of-funnel business
    // outcome (provider-level, like hot leads): an AI chat session that reached
    // CONSULTATION_BOOKED / PROVIDER_CONNECTED is a parent who moved to actually
    // engage the provider.
    const consultations = windowStart
      ? await db.aiChatSession.count({
          where: { providerId, status: { in: ["CONSULTATION_BOOKED", "PROVIDER_CONNECTED"] }, createdAt: { gte: effStart } },
        })
      : 0;

    // Monthly spend across active, non-comped sponsorships (drives cost-per-result).
    const monthlySpendCents = active.reduce((n: number, s: any) => n + (s.isComped ? 0 : (s.priceCentsSnapshot || 0)), 0);

    // Lift: do sponsored profiles outperform this provider's NON-sponsored ones?
    // Only donor/surrogate/sperm are view-tracked (ParentProfileView), so the
    // comparison is scoped to those types. This is the headline ROI proof.
    const VIEW_TYPES: Array<[string, any]> = [
      ["EGG_DONOR", this.prisma.eggDonor],
      ["SURROGATE", this.prisma.surrogate],
      ["SPERM_DONOR", this.prisma.spermDonor],
    ];
    let lift: { sponsoredAvg: number; baselineAvg: number; multiple: number | null; sponsoredCount: number; baselineCount: number } | null = null;
    if (windowStart) {
      const sponsoredViewIds = Array.from(new Set(VIEW_TYPES.flatMap(([t]) => setToArr(t))));
      if (sponsoredViewIds.length) {
        const ownedIds: string[] = [];
        for (const [type, delegate] of VIEW_TYPES) {
          if (!idsByType[type]?.size) continue; // only types the provider actually sponsors
          const rows = await delegate.findMany({ where: { providerId }, select: { id: true } });
          ownedIds.push(...rows.map((r: any) => r.id));
        }
        const sponsoredSet = new Set(sponsoredViewIds);
        const baselineIds = ownedIds.filter((id) => !sponsoredSet.has(id));
        const sponsoredImpr = sponsoredViewIds.reduce((n, id) => n + (impressionsById.get(id) || 0), 0);
        const baselineImpr = baselineIds.length
          ? await db.parentProfileView.count({ where: { profileId: { in: baselineIds }, viewedAt: { gte: effStart } } })
          : 0;
        const sponsoredAvg = sponsoredImpr / sponsoredViewIds.length;
        const baselineAvg = baselineIds.length ? baselineImpr / baselineIds.length : 0;
        lift = {
          sponsoredAvg,
          baselineAvg,
          multiple: baselineAvg > 0 ? sponsoredAvg / baselineAvg : null,
          sponsoredCount: sponsoredViewIds.length,
          baselineCount: baselineIds.length,
        };
      }
    }

    // Prior-period deltas: only meaningful when a finite range is selected AND
    // the equivalent window before it was also within the sponsored period.
    let deltas: Record<string, { prior: number; pct: number | null }> | null = null;
    if (effStart && windowStart && rangeDays) {
      const priorStart = new Date(effStart.getTime() - (now.getTime() - effStart.getTime()));
      if (priorStart.getTime() >= windowStart.getTime() && allEntityIds.length) {
        const win = { gte: priorStart, lt: effStart };
        const [pImpr, pDonorFav, pProfileFav, pInq, pCons] = await Promise.all([
          db.parentProfileView.count({ where: { profileId: { in: allEntityIds }, viewedAt: win } }),
          donorLikeIds.length ? db.userDonorPreference.count({ where: { donorId: { in: donorLikeIds }, type: "favorite", createdAt: win } }) : Promise.resolve(0),
          profileLikeIds.length ? db.userProfilePreference.count({ where: { entityId: { in: profileLikeIds }, type: "favorite", createdAt: win } }) : Promise.resolve(0),
          db.silentQuery.count({ where: { providerId, createdAt: win, session: { subjectProfileId: { in: allEntityIds } } } }),
          db.aiChatSession.count({ where: { providerId, status: { in: ["CONSULTATION_BOOKED", "PROVIDER_CONNECTED"] }, createdAt: win } }),
        ]);
        const priorSaves = pDonorFav + pProfileFav;
        const mk = (cur: number, prior: number) => ({ prior, pct: prior > 0 ? Math.round(((cur - prior) / prior) * 100) : null });
        deltas = {
          impressions: mk(views.length, pImpr),
          saves: mk(saves, priorSaves),
          inquiries: mk(inquiries, pInq),
          consultations: mk(consultations, pCons),
        };
      }
    }

    // Sponsorship + invoicing history.
    const invoices = await db.invoice.findMany({
      where: { providerId },
      select: { id: true, status: true, serviceAmount: true, createdAt: true, paidAt: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    const totalImpressions = views.length;
    return {
      kpis: {
        totalImpressions,
        saves,
        passes,
        inquiries,
        consultations,
        hotLeads,
        activeSponsorships: active.length,
        slotsUsed: active.reduce((n: number, s: any) => n + s.items.length, 0),
        slotsTotal: active.reduce((n: number, s: any) => n + s.slotCountSnapshot, 0),
        monthlySpendCents,
        windowStart,
      },
      lift,
      deltas,
      rangeDays: rangeDays ?? null,
      funnel: [
        { stage: "Impressions", value: totalImpressions },
        { stage: "Saves", value: saves },
        { stage: "Inquiries", value: inquiries },
        { stage: "Consultations", value: consultations },
        { stage: "Hot leads", value: hotLeads },
      ],
      timeSeries,
      perProfile,
      history: {
        // Only sponsorships that were actually paid/activated at least once -
        // never-paid pending/abandoned checkouts don't belong in history.
        sponsorships: sponsorships
          .filter((s: any) => s.currentPeriodStart != null)
          .map((s: any) => ({
            id: s.id,
            productType: s.productType,
            tier: s.plan?.displayName,
            status: s.status,
            billingMode: s.billingMode,
            isComped: s.isComped,
            priceCents: s.priceCentsSnapshot,
            currentPeriodStart: s.currentPeriodStart,
            currentPeriodEnd: s.currentPeriodEnd,
            slotsUsed: s.items.length,
            slotsTotal: s.slotCountSnapshot,
            createdAt: s.createdAt,
          })),
        invoices,
      },
    };
  }

  /** Resolve human-readable labels (readable name + thumbnail) for the per-profile breakdown. */
  private async labelEntities(activeSponsorships: any[], impressionsById: Map<string, number>, savesById: Map<string, number>, inquiriesById: Map<string, number>) {
    const byType: Record<string, Set<string>> = {};
    for (const s of activeSponsorships) for (const it of s.items) (byType[it.entityType] ||= new Set()).add(it.entityId);

    const photoOf = (r: any) => r.photoUrl || (Array.isArray(r.photos) && r.photos[0]) || null;
    // Donors/surrogates are scraped and usually have no real name - fall back to a
    // readable "<noun> #<externalId>" (matching the marketplace card), never the UUID.
    const idLabel = (noun: string) => (r: any) => (r.firstName?.trim() || `${noun} #${r.externalId || r.id.slice(-6)}`);

    const labels = new Map<string, { name: string; type: string; photoUrl: string | null }>();
    const load = async (ids: string[], delegate: any, type: string, nameFn: (r: any) => string, photoFn: (r: any) => string | null, select: any) => {
      if (!ids.length) return;
      const rows = await delegate.findMany({ where: { id: { in: ids } }, select });
      for (const r of rows) labels.set(r.id, { name: nameFn(r), type, photoUrl: photoFn(r) });
    };
    const subProfileSelect = { id: true, firstName: true, externalId: true, photoUrl: true, photos: true };
    await load(Array.from(byType["EGG_DONOR"] || []), this.prisma.eggDonor, "Egg donor", idLabel("Egg Donor"), photoOf, subProfileSelect);
    await load(Array.from(byType["SURROGATE"] || []), this.prisma.surrogate, "Surrogate", idLabel("Surrogate"), photoOf, subProfileSelect);
    await load(Array.from(byType["SPERM_DONOR"] || []), this.prisma.spermDonor, "Sperm donor", idLabel("Sperm Donor"), photoOf, subProfileSelect);
    await load(Array.from(byType["DOCTOR"] || []), this.prisma.providerMember, "Doctor", (r) => r.name || `Doctor #${r.id.slice(-6)}`, (r) => r.highResPhotoUrl || r.photoUrl || null, { id: true, name: true, photoUrl: true, highResPhotoUrl: true });
    await load(Array.from(new Set([...Array.from(byType["CLINIC_PROFILE"] || []), ...Array.from(byType["AGENCY_PROFILE"] || [])])), this.prisma.provider, "Profile", (r) => r.name || `Profile #${r.id.slice(-6)}`, (r) => r.logoUrl || null, { id: true, name: true, logoUrl: true });

    const allIds = Array.from(new Set(Object.values(byType).flatMap((s) => Array.from(s))));
    return allIds
      .map((id) => ({
        id,
        name: labels.get(id)?.name || id,
        type: labels.get(id)?.type || "Profile",
        photoUrl: labels.get(id)?.photoUrl || null,
        impressions: impressionsById.get(id) || 0,
        saves: savesById.get(id) || 0,
        inquiries: inquiriesById.get(id) || 0,
      }))
      .sort((a, b) => b.impressions - a.impressions);
  }
}
