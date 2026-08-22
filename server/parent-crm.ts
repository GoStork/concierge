/**
 * Parent CRM: who may write what, and to whom.
 *
 * The CRM rows (notes, next steps, owners, tags) each carry a `scope`:
 *
 *   GOSTORK  - GoStork staff only. providerId is always null.
 *   PROVIDER - GoStork staff AND the one org in providerId.
 *
 * Everything here reads the AUTHENTICATED user and nothing else. A provider
 * cannot name a scope or an org: their scope is forced to PROVIDER and their
 * providerId to their own. A client-supplied providerId is IGNORED rather than
 * validated-and-rejected, which removes the "did I cover every branch?"
 * question entirely - there is no branch in which it can be honoured.
 *
 * Sits beside parent-privacy.ts, which answers the neighbouring question of
 * what a provider may SEE about a parent. This file answers what they may
 * WRITE, and who the writing is visible to.
 */

// Roles come from shared/roles.ts rather than chat-router's local copy: the
// local PROVIDER_ROLES array there omits LEGAL_ASSISTANT, and importing from
// chat-router would close a cycle (chat-router -> parent-record -> here).
import { hasProviderRole } from "../shared/roles";

export type CrmScope = "GOSTORK" | "PROVIDER";

function roles(user: any): string[] {
  return user?.roles || [];
}

/** GoStork staff who may see and write every scope. */
export function isGostorkStaff(user: any): boolean {
  const r = roles(user);
  return r.includes("GOSTORK_ADMIN") || r.includes("GOSTORK_CONCIERGE");
}

/** Provider staff, scoped to their own org. */
export function isProviderStaff(user: any): boolean {
  if (!user?.providerId) return false;
  return hasProviderRole(roles(user)) || roles(user).includes("GOSTORK_ADMIN");
}

export interface CrmViewer {
  userId: string;
  name: string | null;
  isAdmin: boolean;
  /** The viewer's own org. Null for GoStork staff. */
  providerId: string | null;
}

/** Resolve the viewer from req.user. Never reads the body or the query. */
export function resolveCrmViewer(user: any): CrmViewer {
  const isAdmin = isGostorkStaff(user);
  return {
    userId: user?.id,
    name: user?.name ?? null,
    isAdmin,
    providerId: isAdmin ? null : (user?.providerId ?? null),
  };
}

export interface WriteTarget {
  scope: CrmScope;
  providerId: string | null;
}

/**
 * Decide the (scope, providerId) a write lands on.
 *
 * Admins may name any scope, and must name a providerId when they choose
 * PROVIDER - writing a provider-scoped row with no org would create a note
 * nobody can ever read. Providers get exactly one possible answer.
 *
 * Throws a CrmAuthError the routers turn into a 400/403.
 */
export function resolveWriteTarget(
  viewer: CrmViewer,
  bodyScope?: string | null,
  bodyProviderId?: string | null,
): WriteTarget {
  if (!viewer.isAdmin) {
    if (!viewer.providerId) throw new CrmAuthError(403, "Forbidden");
    // Deliberately ignores bodyScope and bodyProviderId.
    return { scope: "PROVIDER", providerId: viewer.providerId };
  }
  const scope = (bodyScope || "GOSTORK").toUpperCase();
  if (scope !== "GOSTORK" && scope !== "PROVIDER") {
    throw new CrmAuthError(400, "scope must be GOSTORK or PROVIDER");
  }
  if (scope === "PROVIDER") {
    if (!bodyProviderId) throw new CrmAuthError(400, "providerId is required for a PROVIDER-scoped write");
    return { scope: "PROVIDER", providerId: bodyProviderId };
  }
  return { scope: "GOSTORK", providerId: null };
}

/**
 * The WHERE clause for every CRM read.
 *
 * Always a where clause, never a post-`.filter()`. Post-filtering is the class
 * of bug that closed Gate A on the most advanced parents in the parents table:
 * by the time you filter, the rows are already materialised in the response
 * object and one refactor away from being serialised.
 */
export function crmReadWhere(viewer: CrmViewer, parentAccountId: string): Record<string, any> {
  if (viewer.isAdmin) return { parentAccountId };
  return { parentAccountId, scope: "PROVIDER", providerId: viewer.providerId };
}

/**
 * Which owner row answers for a given service line.
 *
 * The rule, in one place so the sweeps, the Home queue and the endpoints can
 * never disagree: the LINE's own owner wins; a family line nobody claimed
 * falls back to the org-wide owner (serviceLine null); with neither, there
 * is no owner and callers fall back to "the whole team".
 */
export function ownerForLine<T extends { serviceLine?: string | null }>(
  rows: T[],
  line: string | null | undefined,
): T | null {
  if (line) {
    const exact = rows.find((r) => r.serviceLine === line);
    if (exact) return exact;
  }
  return rows.find((r) => !r.serviceLine) ?? null;
}

export class CrmAuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "CrmAuthError";
  }
}

/**
 * May this viewer act on an existing row?
 *
 * Admins may act on anything. A provider may act only on their own org's rows,
 * and never on a GOSTORK row - which they should never have been handed in the
 * first place, so reaching here means something upstream leaked.
 */
export function canMutateCrmRow(
  viewer: CrmViewer,
  row: { scope: string; providerId: string | null; authorUserId?: string },
): boolean {
  if (viewer.isAdmin) return true;
  return row.scope === "PROVIDER" && !!viewer.providerId && row.providerId === viewer.providerId;
}
