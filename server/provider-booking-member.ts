/**
 * Which staff member's calendar does a PARENT see when booking a consultation
 * with a provider org?
 *
 * The old logic was findFirst({ bookingPageSlug not null }) - whichever row
 * the DB happened to return. At Family Creations that picked Jayde (a
 * SCHEDULER) over Julia (the surrogacy coordinator) and Jered (the provider
 * admin) for a surrogate consultation (observed live, Aug 7 2026).
 *
 * Priority, most specific first - always among members who actually have a
 * booking page configured:
 *   1. A coordinator whose role matches the conversation's subject type
 *      (surrogate subject -> surrogacy coordinator, etc.)
 *   2. PROVIDER_ADMIN
 *   3. Any other coordinator
 *   4. Anyone who is not a pure SCHEDULER / BILLING_MANAGER
 *   5. Last resort: anyone with a booking page - a scheduler's calendar
 *      still beats a dead end with no calendar at all.
 */
import { prisma } from "./db";
import { IP_COORDINATOR_ROLES, DONOR_COORDINATOR_ROLES } from "../shared/roles";

export interface BookingMember {
  name: string | null;
  photoUrl: string | null;
  slug: string;
}

const ALL_COORDINATOR_ROLES: string[] = [...IP_COORDINATOR_ROLES, ...DONOR_COORDINATOR_ROLES];

/** Subject type (match-card `type` / session subjectType) -> preferred coordinator roles. */
function coordinatorRolesForSubject(subjectType: string | null | undefined): string[] {
  const st = (subjectType || "").toLowerCase();
  if (st.includes("surrog")) return ["IP_SURROGACY_COORDINATOR", "SURROGATE_COORDINATOR"];
  if (st.includes("egg")) return ["IP_EGG_DONOR_COORDINATOR", "EGG_DONOR_COORDINATOR"];
  if (st.includes("sperm")) return ["IP_SPERM_DONOR_COORDINATOR", "SPERM_DONOR_COORDINATOR"];
  if (st.includes("legal") || st.includes("lawyer")) return ["IP_LEGAL_COORDINATOR"];
  if (st.includes("clinic") || st.includes("doctor") || st.includes("ivf")) return ["IP_IVF_COORDINATOR"];
  return [];
}

export async function pickProviderBookingMember(
  providerId: string,
  subjectType: string | null | undefined,
): Promise<BookingMember | null> {
  const candidates = await prisma.user.findMany({
    where: {
      providerId,
      isDisabled: false,
      scheduleConfig: { bookingPageSlug: { not: null } },
    },
    orderBy: { createdAt: "asc" },
    select: {
      name: true,
      photoUrl: true,
      roles: true,
      scheduleConfig: { select: { bookingPageSlug: true } },
    },
  });
  if (candidates.length === 0) return null;

  const has = (u: { roles: string[] }, roles: string[]) => (u.roles || []).some((r) => roles.includes(r));
  const subjectRoles = coordinatorRolesForSubject(subjectType);
  const picked =
    (subjectRoles.length ? candidates.find((u) => has(u, subjectRoles)) : undefined) ||
    candidates.find((u) => (u.roles || []).includes("PROVIDER_ADMIN")) ||
    candidates.find((u) => has(u, ALL_COORDINATOR_ROLES)) ||
    candidates.find((u) => !has(u, ["SCHEDULER", "BILLING_MANAGER"])) ||
    candidates[0];

  return {
    name: picked.name,
    photoUrl: picked.photoUrl,
    slug: picked.scheduleConfig!.bookingPageSlug!,
  };
}
