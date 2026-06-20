/**
 * Default sponsorship plans. Seeded into the SponsorshipPlan table on server
 * boot using create-if-not-exists (never overwrite) - admin price edits in the
 * UI survive restarts, exactly like the concierge prompt sections.
 *
 * Two products:
 *   SLOT_BUNDLE   - tiers scoped to ONE sub-profile type. Roster sizes differ
 *                   wildly (an agency may have hundreds of egg donors but a few
 *                   surrogates; a clinic a handful of doctors), so egg/sperm
 *                   donors get large tiers and surrogates/doctors get small ones.
 *   WHOLE_PROFILE - the provider's own top-level profile, priced per provider
 *                   type: IVF clinic vs surrogacy agency.
 *
 * priceCents is the source of truth for charges. Editing it only affects NEW
 * sponsorships (existing Stripe subscriptions keep their attached Price).
 */

export interface SponsorshipPlanSeed {
  productType: "SLOT_BUNDLE" | "WHOLE_PROFILE";
  tierKey: string;
  slotEntityType?: "EGG_DONOR" | "SPERM_DONOR" | "SURROGATE" | "DOCTOR" | null;
  displayName: string;
  priceCents: number;
  currency: string;
  slotCount: number;
  sortOrder: number;
}

export const SPONSORSHIP_PLAN_DEFAULTS: SponsorshipPlanSeed[] = [
  // Egg donors - large rosters.
  { productType: "SLOT_BUNDLE", slotEntityType: "EGG_DONOR", tierKey: "egg_donor_starter", displayName: "Egg Donors - Starter", priceCents: 19900, currency: "USD", slotCount: 5, sortOrder: 10 },
  { productType: "SLOT_BUNDLE", slotEntityType: "EGG_DONOR", tierKey: "egg_donor_growth", displayName: "Egg Donors - Growth", priceCents: 59900, currency: "USD", slotCount: 25, sortOrder: 11 },
  { productType: "SLOT_BUNDLE", slotEntityType: "EGG_DONOR", tierKey: "egg_donor_pro", displayName: "Egg Donors - Pro", priceCents: 149900, currency: "USD", slotCount: 100, sortOrder: 12 },
  // Sperm donors - large rosters (banks).
  { productType: "SLOT_BUNDLE", slotEntityType: "SPERM_DONOR", tierKey: "sperm_donor_starter", displayName: "Sperm Donors - Starter", priceCents: 19900, currency: "USD", slotCount: 5, sortOrder: 20 },
  { productType: "SLOT_BUNDLE", slotEntityType: "SPERM_DONOR", tierKey: "sperm_donor_growth", displayName: "Sperm Donors - Growth", priceCents: 59900, currency: "USD", slotCount: 25, sortOrder: 21 },
  { productType: "SLOT_BUNDLE", slotEntityType: "SPERM_DONOR", tierKey: "sperm_donor_pro", displayName: "Sperm Donors - Pro", priceCents: 149900, currency: "USD", slotCount: 100, sortOrder: 22 },
  // Surrogates - small rosters.
  { productType: "SLOT_BUNDLE", slotEntityType: "SURROGATE", tierKey: "surrogate_single", displayName: "Surrogates - Single", priceCents: 9900, currency: "USD", slotCount: 1, sortOrder: 30 },
  { productType: "SLOT_BUNDLE", slotEntityType: "SURROGATE", tierKey: "surrogate_trio", displayName: "Surrogates - Trio", priceCents: 24900, currency: "USD", slotCount: 3, sortOrder: 31 },
  { productType: "SLOT_BUNDLE", slotEntityType: "SURROGATE", tierKey: "surrogate_five", displayName: "Surrogates - Five", priceCents: 39900, currency: "USD", slotCount: 5, sortOrder: 32 },
  // Doctors - small rosters (clinics).
  { productType: "SLOT_BUNDLE", slotEntityType: "DOCTOR", tierKey: "doctor_single", displayName: "Doctors - Single", priceCents: 14900, currency: "USD", slotCount: 1, sortOrder: 40 },
  { productType: "SLOT_BUNDLE", slotEntityType: "DOCTOR", tierKey: "doctor_trio", displayName: "Doctors - Trio", priceCents: 39900, currency: "USD", slotCount: 3, sortOrder: 41 },
  { productType: "SLOT_BUNDLE", slotEntityType: "DOCTOR", tierKey: "doctor_practice", displayName: "Doctors - Practice", priceCents: 99900, currency: "USD", slotCount: 10, sortOrder: 42 },
  // Whole-profile boosts (per provider type).
  { productType: "WHOLE_PROFILE", slotEntityType: null, tierKey: "whole_profile_ivf", displayName: "Featured IVF Clinic Profile", priceCents: 500000, currency: "USD", slotCount: 1, sortOrder: 90 },
  { productType: "WHOLE_PROFILE", slotEntityType: null, tierKey: "whole_profile_surrogacy", displayName: "Featured Surrogacy Agency Profile", priceCents: 250000, currency: "USD", slotCount: 1, sortOrder: 91 },
];

export function getSponsorshipPlanDefaults(): SponsorshipPlanSeed[] {
  return SPONSORSHIP_PLAN_DEFAULTS;
}
