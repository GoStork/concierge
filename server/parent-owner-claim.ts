/**
 * Auto-assign the GoStork lead owner when a person actually picks a family up.
 *
 * The owner field only ever got set by hand, so in practice it stayed empty and
 * the "My leads" and "No owner" filters had almost nothing to work with. The
 * honest moment to fill it is not the [[HUMAN_NEEDED]] escalation - that pings
 * every admin at once, so there is nobody in particular to assign - but one
 * step later, when a named admin joins the chat or sends the first human reply.
 * Both of those already stamp `humanAgentId` on the session; this puts the same
 * fact on the CRM record.
 *
 * Two rules, both deliberate:
 *
 *   Never steal. An existing owner is somebody's explicit decision, and a
 *   second admin glancing at the thread must not silently reassign the family.
 *   Only an empty slot is filled.
 *
 *   Never break the takeover. Claiming is a side effect of joining a chat, so
 *   every failure here is swallowed and logged - a CRM write must not be able
 *   to stop a concierge from reaching a parent.
 */
import { prisma } from "./db";
import { emitJourneyEvent } from "./journey-events";
import { isGostorkStaff, isProviderStaff } from "./parent-crm";

export type OwnerClaimReason = "JOINED_CHAT" | "FIRST_REPLY";

/**
 * @param parentUserId the session's own userId - the account key is derived
 *   here so callers never have to remember the `parentAccountId ?? userId`
 *   convention the CRM tables key on.
 */
export async function claimGostorkOwner(
  parentUserId: string | null | undefined,
  actor: any,
  reason: OwnerClaimReason,
): Promise<void> {
  try {
    if (!parentUserId || !actor?.id || !isGostorkStaff(actor)) return;

    const parent = await prisma.user.findUnique({
      where: { id: parentUserId },
      select: { parentAccountId: true },
    });
    if (!parent) return;
    const accountKey = parent.parentAccountId || parentUserId;

    const existing = await prisma.parentOwner.findFirst({
      where: { parentAccountId: accountKey, scope: "GOSTORK" },
      select: { id: true },
    });
    if (existing) return;

    // A partial unique index enforces one GOSTORK row per account, so two
    // admins opening the same thread at once cannot both insert. The loser of
    // that race is not an error worth surfacing - the family has an owner.
    try {
      await prisma.parentOwner.create({
        data: {
          parentAccountId: accountKey,
          scope: "GOSTORK",
          providerId: null,
          ownerUserId: actor.id,
          ownerName: actor.name || null,
          assignedByUserId: actor.id,
        },
      });
    } catch (raceErr: any) {
      if (raceErr?.code === "P2002") return;
      throw raceErr;
    }

    emitJourneyEvent({
      eventType: "CRM_OWNER_ASSIGNED",
      parentAccountId: accountKey,
      providerId: null,
      actorRole: "admin",
      // Ids and a reason only - never a name. GET /api/journey/events returns
      // metadata verbatim, and GoStork staff names are not an agency's business.
      metadata: { ownerUserId: actor.id, auto: true, reason },
    });
  } catch (e) {
    console.error("[owner-claim] failed to auto-assign GoStork owner:", e);
  }
}

/**
 * The provider-side twin: the first staffer at an agency to reply in a thread
 * claims that family FOR THEIR OWN ORG.
 *
 * A separate row from the GoStork owner - scope PROVIDER, pinned to the org -
 * so the two never overwrite each other and an agency never sees GoStork's
 * choice or vice versa. Same never-steal rule.
 *
 * The org comes from the ACTOR, never from the session: a staffer replying in
 * a thread is claiming it for the org they belong to.
 */
export async function claimProviderOwner(
  parentUserId: string | null | undefined,
  actor: any,
  reason: OwnerClaimReason,
): Promise<void> {
  try {
    if (!parentUserId || !actor?.id || !isProviderStaff(actor)) return;
    const providerId: string | null = actor.providerId ?? null;
    if (!providerId) return;

    const parent = await prisma.user.findUnique({
      where: { id: parentUserId },
      select: { parentAccountId: true },
    });
    if (!parent) return;
    const accountKey = parent.parentAccountId || parentUserId;

    const existing = await prisma.parentOwner.findFirst({
      where: { parentAccountId: accountKey, scope: "PROVIDER", providerId },
      select: { id: true },
    });
    if (existing) return;

    try {
      await prisma.parentOwner.create({
        data: {
          parentAccountId: accountKey,
          scope: "PROVIDER",
          providerId,
          ownerUserId: actor.id,
          ownerName: actor.name || null,
          assignedByUserId: actor.id,
        },
      });
    } catch (raceErr: any) {
      if (raceErr?.code === "P2002") return;
      throw raceErr;
    }

    emitJourneyEvent({
      eventType: "CRM_OWNER_ASSIGNED",
      parentAccountId: accountKey,
      providerId,
      actorRole: "provider",
      metadata: { ownerUserId: actor.id, auto: true, reason },
    });
  } catch (e) {
    console.error("[owner-claim] failed to auto-assign provider owner:", e);
  }
}
