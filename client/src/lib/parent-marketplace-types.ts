// Maps a parent's "Services You're Looking For" (interestedServices) to the
// marketplace provider types they should see. Shared by the marketplace Explore
// picker (marketplace-page) and the primary nav (layout-shell) so the nav and the
// marketplace always agree on which provider tabs a parent gets.

export const PARENT_TYPE_MAP: Record<string, { id: string; label: string }> = {
  "Egg Donor": { id: "egg-donors", label: "Eggs" },
  "Sperm Donor": { id: "sperm-donors", label: "Sperm" },
  "Surrogate": { id: "surrogates", label: "Surrogates" },
  "Fertility Clinic": { id: "ivf-clinics", label: "Clinics" },
};

// Doctors (Path B) has no interestedService of its own - doctors practice at
// clinics, so the Doctors type is offered exactly when IVF Clinics is. It still
// gets its own first-class tab + Explore card.
export const DOCTORS_TYPE = { id: "doctors", label: "Doctors" };

export const PARENT_TYPE_ORDER = ["egg-donors", "sperm-donors", "surrogates", "ivf-clinics", "doctors"];

/**
 * The ordered set of marketplace type ids a parent should see, derived from their
 * interestedServices. Empty/unset services -> show everything (don't hide the
 * whole marketplace from a parent who hasn't picked yet). "Fertility Clinic" also
 * unlocks Doctors.
 */
export function parentVisibleTypeIds(interestedServices: string[] | undefined | null): string[] {
  const services = interestedServices ?? [];
  const mapped = services.map(s => PARENT_TYPE_MAP[s]).filter(Boolean);
  const base = mapped.length > 0 ? mapped : Object.values(PARENT_TYPE_MAP);
  const types = base.some(t => t.id === "ivf-clinics") ? [...base, DOCTORS_TYPE] : base;
  const ids = new Set(types.map(t => t.id));
  return PARENT_TYPE_ORDER.filter(id => ids.has(id));
}
