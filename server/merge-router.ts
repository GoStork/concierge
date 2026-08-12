/**
 * Merge or link two families - MANUAL ONLY (CRM Phase 9 §2b).
 *
 * The platform deliberately never suggests duplicates: the production bot
 * wave means the same detection that finds a husband and wife would offer to
 * merge ten thousand bot accounts. Only a human knows two records are the
 * same family, so both actions start from the record's Actions menu.
 *
 * MERGE (admin-only, irreversible): the absorbed logins become MEMBERS of
 * the surviving account - the same shape a couple already has - so every
 * row keyed by parentUserId (sessions, bookings, invoices, agreements,
 * quotes) follows its user with no row updates at all. Rows keyed by
 * parentAccountKey (notes, tasks, owners, releases, journey events, silence
 * state, stage snapshots) are re-keyed to the surviving key, with
 * unique-collision losers dropped in the absorbed record's favorless
 * direction (the surviving record's row always wins). A ParentAccountMerge
 * row records who did it and what moved; each absorbed User keeps
 * mergedIntoUserId so old links still resolve.
 *
 * LINK AS HOUSEHOLD (providers too, undoable): the two accounts stay
 * separate but wear the household badge the parents table already draws.
 */
import { Router, Request, Response } from "express";
import { prisma } from "./db";
import { isGostorkStaff, isProviderStaff, CrmAuthError } from "./parent-crm";
import { parentAccountKey } from "./parent-privacy";
import { buildParentRecord } from "./parent-record";

export const mergeRouter = Router();

function requireAuth(req: Request, res: Response, next: () => void) {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  next();
}

function fail(res: Response, e: any, label: string) {
  if (e instanceof CrmAuthError) return res.status(e.status).json({ message: e.message });
  console.error(`[merge] ${label}:`, e);
  return res.status(500).json({ message: e?.message || "Server error" });
}

async function accountOf(parentUserId: string) {
  const u = await prisma.user.findUnique({
    where: { id: parentUserId },
    select: { id: true, name: true, email: true, parentAccountId: true, roles: true },
  });
  if (!u || !(u.roles || []).includes("PARENT")) throw new CrmAuthError(404, "Parent not found");
  return { user: u, key: parentAccountKey(u) };
}

/**
 * The picker: search by name, email or phone, showing what each record
 * holds so the choice is informed. Admin sees everyone; a provider (link
 * only) sees just parents they can already reach - enforced by re-proving
 * each candidate through buildParentRecord.
 */
mergeRouter.get("/api/parents/merge-candidates", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    const isAdmin = isGostorkStaff(user);
    if (!isAdmin && !isProviderStaff(user)) return res.status(403).json({ message: "Forbidden" });
    const q = String(req.query.q || "").trim();
    const excludeId = String(req.query.exclude || "");
    if (q.length < 2) return res.json({ candidates: [] });

    const users = await prisma.user.findMany({
      where: {
        roles: { has: "PARENT" },
        id: { not: excludeId || undefined },
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
          { mobileNumber: { contains: q } },
        ],
      },
      select: { id: true, name: true, email: true, mobileNumber: true, parentAccountId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 12,
    });

    const out: any[] = [];
    for (const u of users) {
      if (!isAdmin) {
        // A provider may only link families already on their books.
        try {
          await buildParentRecord(user, u.id, { sections: ["identity"] });
        } catch {
          continue;
        }
      }
      const key = parentAccountKey(u);
      const memberIds = (await prisma.user.findMany({
        where: { OR: [{ parentAccountId: key }, { id: key }] },
        select: { id: true },
      })).map((m) => m.id);
      const [notes, tasks, invoices, agreements, sessions, snapshots] = await Promise.all([
        prisma.parentNote.count({ where: { parentAccountId: key, deletedAt: null } }),
        prisma.parentTask.count({ where: { parentAccountId: key } }),
        prisma.invoice.count({ where: { parentUserId: { in: memberIds } } }),
        prisma.agreement.count({ where: { parentUserId: { in: memberIds } } }),
        prisma.aiChatSession.count({ where: { userId: { in: memberIds } } }),
        prisma.parentStageSnapshot.findMany({
          where: { parentAccountId: key },
          select: { serviceLine: true, stage: true },
        }),
      ]);
      out.push({
        parentUserId: u.id,
        name: u.name,
        email: u.email,
        mobileNumber: u.mobileNumber,
        createdAt: u.createdAt,
        holdings: {
          notes, tasks, invoices, agreements, sessions,
          lines: snapshots.map((s) => ({ serviceLine: s.serviceLine, stage: s.stage })),
        },
      });
    }
    res.json({ candidates: out });
  } catch (e) {
    fail(res, e, "GET candidates");
  }
});

/** Re-key one account-keyed table, dropping absorbed rows a unique blocks. */
async function rekey(model: any, fromKey: string, toKey: string, where: any = {}): Promise<number> {
  const rows = await model.findMany({ where: { parentAccountId: fromKey, ...where }, select: { id: true } });
  let moved = 0;
  for (const r of rows) {
    try {
      await model.update({ where: { id: r.id }, data: { parentAccountId: toKey } });
      moved++;
    } catch (e: any) {
      // A unique on the surviving side already covers this row - the
      // surviving record wins, the absorbed duplicate is dropped.
      if (e?.code === "P2002") await model.delete({ where: { id: r.id } }).catch(() => {});
      else throw e;
    }
  }
  return moved;
}

mergeRouter.post("/api/parents/:id/merge", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    // Merge is ADMIN-ONLY and irreversible.
    if (!isGostorkStaff(user)) return res.status(403).json({ message: "Merging is GoStork-admin only" });

    const surviving = await accountOf(String(req.params.id));
    const absorbed = await accountOf(String(req.body?.absorbedParentUserId || ""));
    if (surviving.key === absorbed.key) return res.status(400).json({ message: "These are already the same family" });

    // The surviving side needs a REAL ParentAccount row for the absorbed
    // logins to join. A legacy solo parent (key = their user id) gets one
    // here, and their own account-keyed rows move onto the new key first so
    // nothing detaches.
    let newKey = surviving.key;
    const moved: Record<string, number> = {};
    if (!surviving.user.parentAccountId) {
      const account = await prisma.parentAccount.create({ data: {} });
      await prisma.user.update({
        where: { id: surviving.user.id },
        data: { parentAccountId: account.id, parentAccountRole: "INTENDED_PARENT_1" },
      });
      for (const [name, model] of Object.entries(KEYED_MODELS)) {
        moved[`surviving_${name}`] = await rekey(model, surviving.key, account.id);
      }
      newKey = account.id;
    }

    // Absorbed members join the surviving account. Everything keyed by
    // parentUserId follows them automatically.
    const absorbedMembers = await prisma.user.findMany({
      where: { OR: [{ parentAccountId: absorbed.key }, { id: absorbed.key }] },
      select: { id: true },
    });
    const absorbedIds = absorbedMembers.map((m) => m.id);
    await prisma.user.updateMany({
      where: { id: { in: absorbedIds } },
      data: { parentAccountId: newKey, mergedIntoUserId: surviving.user.id },
    });

    for (const [name, model] of Object.entries(KEYED_MODELS)) {
      moved[name] = await rekey(model, absorbed.key, newKey);
    }
    // The Intended Parent form: the surviving record's answers win; the
    // absorbed form moves over only when the surviving family has none.
    const survivingForm = await prisma.ipFormResponse.findUnique({ where: { parentAccountId: newKey }, select: { id: true } });
    if (!survivingForm) {
      moved.ipForm = await prisma.ipFormResponse
        .updateMany({ where: { parentAccountId: absorbed.key }, data: { parentAccountId: newKey } })
        .then((r) => r.count)
        .catch(() => 0);
    }

    const audit = await prisma.parentAccountMerge.create({
      data: {
        survivingAccountId: newKey,
        absorbedAccountId: absorbed.key,
        absorbedUserIds: absorbedIds,
        performedByUserId: user.id,
        metadata: { moved, survivingUserId: surviving.user.id },
      },
    });
    // A link between the two is moot once they are one record.
    await prisma.parentHouseholdLink.deleteMany({
      where: {
        OR: [
          { aAccountId: absorbed.key }, { bAccountId: absorbed.key },
        ],
      },
    }).catch(() => {});

    console.log(`[merge] ${absorbed.key} -> ${newKey} by ${user.email} (${JSON.stringify(moved)})`);
    res.json({ ok: true, mergeId: audit.id, moved, survivingAccountId: newKey });
  } catch (e) {
    fail(res, e, "POST merge");
  }
});

/** Account-keyed CRM tables the merge re-keys. */
const KEYED_MODELS: Record<string, any> = {
  notes: prisma.parentNote,
  tasks: prisma.parentTask,
  owners: prisma.parentOwner,
  releases: prisma.parentContactRelease,
  journeyEvents: prisma.journeyEvent,
  silenceState: prisma.silenceState,
  stageSnapshots: prisma.parentStageSnapshot,
};

// ─── Link as household (undoable, providers allowed) ────────────────────────

mergeRouter.post("/api/parents/:id/household-link", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    if (!isGostorkStaff(user) && !isProviderStaff(user)) return res.status(403).json({ message: "Forbidden" });
    // Both sides must be reachable by this viewer.
    await buildParentRecord(user, String(req.params.id), { sections: ["identity"] });
    await buildParentRecord(user, String(req.body?.otherParentUserId || ""), { sections: ["identity"] });

    const a = await accountOf(String(req.params.id));
    const b = await accountOf(String(req.body?.otherParentUserId || ""));
    if (a.key === b.key) return res.status(400).json({ message: "These are already one account" });
    const [lo, hi] = [a.key, b.key].sort();
    const link = await prisma.parentHouseholdLink.upsert({
      where: { aAccountId_bAccountId: { aAccountId: lo, bAccountId: hi } },
      create: { aAccountId: lo, bAccountId: hi, createdByUserId: user.id },
      update: {},
    });
    res.json({ ok: true, linkId: link.id });
  } catch (e) {
    fail(res, e, "POST link");
  }
});

mergeRouter.delete("/api/parents/:id/household-link", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    if (!isGostorkStaff(user) && !isProviderStaff(user)) return res.status(403).json({ message: "Forbidden" });
    await buildParentRecord(user, String(req.params.id), { sections: ["identity"] });
    const a = await accountOf(String(req.params.id));
    const gone = await prisma.parentHouseholdLink.deleteMany({
      where: { OR: [{ aAccountId: a.key }, { bAccountId: a.key }] },
    });
    res.json({ ok: true, removed: gone.count });
  } catch (e) {
    fail(res, e, "DELETE link");
  }
});

/** The record page asks whether this family is linked to another. */
mergeRouter.get("/api/parents/:id/household-link", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    if (!isGostorkStaff(user) && !isProviderStaff(user)) return res.status(403).json({ message: "Forbidden" });
    await buildParentRecord(user, String(req.params.id), { sections: ["identity"] });
    const a = await accountOf(String(req.params.id));
    const links = await prisma.parentHouseholdLink.findMany({
      where: { OR: [{ aAccountId: a.key }, { bAccountId: a.key }] },
    });
    const otherKeys = links.map((l) => (l.aAccountId === a.key ? l.bAccountId : l.aAccountId));
    const others = otherKeys.length
      ? await prisma.user.findMany({
          where: { OR: [{ parentAccountId: { in: otherKeys } }, { id: { in: otherKeys } }] },
          select: { id: true, name: true, email: true, parentAccountId: true },
        })
      : [];
    res.json({
      links: links.map((l) => ({
        id: l.id,
        otherMembers: others
          .filter((o) => (o.parentAccountId || o.id) === (l.aAccountId === a.key ? l.bAccountId : l.aAccountId))
          .map((o) => ({ id: o.id, name: o.name, email: o.email })),
      })),
    });
  } catch (e) {
    fail(res, e, "GET link");
  }
});
