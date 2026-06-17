/**
 * Default sponsorship plans. Seeded into the SponsorshipPlan table on server
 * boot using create-if-not-exists (never overwrite) - admin price edits in the
 * UI survive restarts, exactly like the concierge prompt sections.
 *
 * Two products:
 *   SLOT_BUNDLE   - a pool of slots filled with individual sub-profiles
 *                   (egg donors, surrogates, sperm donors, doctors).
 *   WHOLE_PROFILE - the provider's own top-level profile. Priced per provider
 *                   type: IVF clinic vs surrogacy agency.
 *
 * priceCents is the source of truth for charges. Editing it only affects NEW
 * sponsorships (existing Stripe subscriptions keep their attached Price).
 */

export interface SponsorshipPlanSeed {
  productType: "SLOT_BUNDLE" | "WHOLE_PROFILE";
  tierKey: string;
  displayName: string;
  priceCents: number;
  currency: string;
  slotCount: number;
  sortOrder: number;
}

export const SPONSORSHIP_PLAN_DEFAULTS: SponsorshipPlanSeed[] = [
  { productType: "SLOT_BUNDLE", tierKey: "starter", displayName: "Starter", priceCents: 19900, currency: "USD", slotCount: 5, sortOrder: 1 },
  { productType: "SLOT_BUNDLE", tierKey: "growth", displayName: "Growth", priceCents: 59900, currency: "USD", slotCount: 25, sortOrder: 2 },
  { productType: "SLOT_BUNDLE", tierKey: "pro", displayName: "Pro", priceCents: 149900, currency: "USD", slotCount: 100, sortOrder: 3 },
  { productType: "WHOLE_PROFILE", tierKey: "whole_profile_ivf", displayName: "Featured IVF Clinic Profile", priceCents: 500000, currency: "USD", slotCount: 1, sortOrder: 4 },
  { productType: "WHOLE_PROFILE", tierKey: "whole_profile_surrogacy", displayName: "Featured Surrogacy Agency Profile", priceCents: 250000, currency: "USD", slotCount: 1, sortOrder: 5 },
];

export function getSponsorshipPlanDefaults(): SponsorshipPlanSeed[] {
  return SPONSORSHIP_PLAN_DEFAULTS;
}
