/**
 * The parent record endpoint plus the CRM writes behind it.
 *
 * Lives outside chat-router.ts, which is already past 6000 lines. Every route
 * here resolves the viewer from req.user alone - a provider can never name a
 * scope or an org, and req.query.providerId / req.body.providerId are not read
 * on the read path at all.
 */

import { Router, Request, Response } from "express";
import { prisma } from "./db";
import { buildParentRecord, ParentRecordError, RecordSection } from "./parent-record";
import {
  CrmAuthError,
  CrmViewer,
  canMutateCrmRow,
  crmReadWhere,
  resolveCrmViewer,
  resolveWriteTarget,
} from "./parent-crm";
import { parentAccountKey, resolveParentGates } from "./parent-privacy";
import { emitJourneyEvent } from "./journey-events";
import { blockContactInfo } from "./contact-guard";

export const parentRecordRouter = Router();

function requireAuth(req: Request, res: Response, next: () => void) {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  next();
}

function fail(res: Response, e: any, label: string) {
  if (e instanceof ParentRecordError || e instanceof CrmAuthError) {
    return res.status(e.status).json({ message: e.message });
  }
  console.error(`[parent-record] ${label}:`, e);
  return res.status(500).json({ message: e?.message || "Server error" });
}

/** Resolve :id (a parent USER id) to the account key every CRM row is keyed on. */
async function accountKeyFor(parentUserId: string): Promise<string> {
  const u = await prisma.user.findUnique({
    where: { id: parentUserId },
    select: { id: true, parentAccountId: true },
  });
  if (!u) throw new ParentRecordError(404, "Parent not found");
  return parentAccountKey(u);
}

/**
 * Every CRM write re-proves the relationship. Without this, a provider could
 * attach notes and tags to a parent they have never met by guessing a user id.
 */
async function assertCanReachParent(user: any, parentUserId: string): Promise<string> {
  await buildParentRecord(user, parentUserId, { sections: ["identity"] });
  return accountKeyFor(parentUserId);
}

// ─── The record ─────────────────────────────────────────────────────────────

parentRecordRouter.get("/api/parents/:id/record", requireAuth, async (req, res) => {
  try {
    const sections = String(req.query.sections || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as RecordSection[];
    const record = await buildParentRecord(req.user as any, String(req.params.id), {
      sections: sections.length ? sections : undefined,
    });
    res.json(record);
  } catch (e: any) {
    fail(res, e, "GET record");
  }
});

// ─── Notes ──────────────────────────────────────────────────────────────────

/**
 * The exact email we sent, as it was sent.
 *
 * Served rather than embedded in the record payload: a family with a hundred
 * emails would otherwise ship a hundred rendered documents on every page load.
 *
 * ACCESS: reuses buildParentRecord's own check. If the caller cannot build
 * this parent's record they cannot read their mail either, so there is one
 * access rule here and not a second one to keep in sync. Rendered inside a
 * sandboxed iframe on the client - this is third-party-ish HTML that has
 * already been through a mail client once.
 */
parentRecordRouter.get("/api/parents/:id/messages/:notificationId", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    // Throws 403/404 exactly as the record endpoint would.
    await buildParentRecord(user, String(req.params.id), { sections: ["identity"] });

    const parent = await prisma.user.findUnique({
      where: { id: String(req.params.id) },
      select: { id: true, parentAccountId: true },
    });
    if (!parent) return res.status(404).json({ message: "Parent not found" });

    const memberIds = (await prisma.user.findMany({
      where: parent.parentAccountId
        ? { parentAccountId: parent.parentAccountId }
        : { id: parent.id },
      select: { id: true },
    })).map((u) => u.id);

    const row = await prisma.notification.findFirst({
      // userId scoping is the point: a notification id alone must not fetch
      // somebody else's mail.
      where: { id: String(req.params.notificationId), userId: { in: memberIds } },
      select: { id: true, subject: true, bodyHtml: true, bodyText: true, sentAt: true, recipient: true, type: true },
    });
    if (!row) return res.status(404).json({ message: "Message not found" });
    if (!row.bodyHtml && !row.bodyText) {
      return res.status(404).json({ message: "This message was sent before its content was recorded." });
    }
    res.json(row);
  } catch (e: any) {
    if (e instanceof ParentRecordError) return res.status(e.status).json({ message: e.message });
    console.error("[parent-record] message fetch failed:", e?.message);
    res.status(500).json({ message: "Failed to load message" });
  }
});

parentRecordRouter.get("/api/parents/:id/notes", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    const accountKey = await assertCanReachParent(req.user as any, String(req.params.id));
    const notes = await prisma.parentNote.findMany({
      where: { ...crmReadWhere(viewer, accountKey), deletedAt: null },
      orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
    });
    res.json(notes);
  } catch (e: any) {
    fail(res, e, "GET notes");
  }
});

parentRecordRouter.post("/api/parents/:id/notes", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    const accountKey = await assertCanReachParent(req.user as any, String(req.params.id));
    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(400).json({ message: "A note needs a body" });

    const target = resolveWriteTarget(viewer, req.body?.scope, req.body?.providerId);

    // The one place a human can walk around Gate B. A PROVIDER-scoped note is
    // delivered to an org that may not have earned contact details, and someone
    // typing "her mobile is 555-0143" hands over exactly what the release
    // machinery withholds. Do NOT redact on read - a human chose the audience
    // and mangling their words is worse. Reject on WRITE instead, through the
    // same guard the chat composer uses, so the author gets an explanation.
    if (target.scope === "PROVIDER" && target.providerId) {
      const g = await resolveParentGates(target.providerId, accountKey, { sessionStatus: null, hasBooking: true });
      // "note" surface: the person being stopped here is STAFF, not the
      // parent, so the chat wording ("your messages are always free") would be
      // nonsense. They need to know this org has not earned the details yet.
      if (!g.showContact && blockContactInfo(res, body, "parent CRM note", {
        parentAccountId: accountKey, providerId: target.providerId, authorUserId: viewer.userId,
      }, "note")) return;
    }

    const note = await prisma.parentNote.create({
      data: {
        parentAccountId: accountKey,
        scope: target.scope,
        providerId: target.providerId,
        body,
        pinned: !!req.body?.pinned,
        authorUserId: viewer.userId,
        authorName: viewer.name,
        authorProviderId: viewer.providerId,
      },
    });

    emitJourneyEvent({
      eventType: target.scope === "PROVIDER" ? "CRM_NOTE_SHARED_WITH_PROVIDER" : "CRM_NOTE_ADDED",
      parentAccountId: accountKey,
      providerId: target.providerId,
      actorRole: viewer.isAdmin ? "admin" : "provider",
      // Ids and lengths only. GET /api/journey/events returns metadata verbatim
      // to providers; it is force-scoped by providerId, but that exclusion must
      // not be the only thing between an internal note and an agency inbox.
      metadata: { noteId: note.id, scope: target.scope, length: body.length },
    });

    res.json(note);
  } catch (e: any) {
    fail(res, e, "POST note");
  }
});

parentRecordRouter.patch("/api/parents/:id/notes/:noteId", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    await assertCanReachParent(req.user as any, String(req.params.id));
    const existing = await prisma.parentNote.findUnique({ where: { id: String(req.params.noteId) } });
    if (!existing || existing.deletedAt) return res.status(404).json({ message: "Note not found" });
    if (!canMutateCrmRow(viewer, existing as any)) return res.status(403).json({ message: "Forbidden" });
    if (!viewer.isAdmin && existing.authorUserId !== viewer.userId) {
      return res.status(403).json({ message: "You can only edit your own notes" });
    }
    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(400).json({ message: "A note needs a body" });

    // scope and providerId are IMMUTABLE. Re-scoping a GOSTORK note to PROVIDER
    // by edit would disclose it to an agency with nothing on the record saying
    // it happened. Deleting and re-creating leaves that trail.
    const note = await prisma.parentNote.update({
      where: { id: existing.id },
      data: { body, pinned: req.body?.pinned ?? existing.pinned },
    });
    res.json(note);
  } catch (e: any) {
    fail(res, e, "PATCH note");
  }
});

parentRecordRouter.delete("/api/parents/:id/notes/:noteId", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    await assertCanReachParent(req.user as any, String(req.params.id));
    const existing = await prisma.parentNote.findUnique({ where: { id: String(req.params.noteId) } });
    if (!existing || existing.deletedAt) return res.status(404).json({ message: "Note not found" });
    if (!canMutateCrmRow(viewer, existing as any)) return res.status(403).json({ message: "Forbidden" });
    if (!viewer.isAdmin && existing.authorUserId !== viewer.userId) {
      return res.status(403).json({ message: "You can only delete your own notes" });
    }
    // Soft delete: a provider-visible note that has been read cannot be un-read.
    await prisma.parentNote.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
    res.json({ ok: true });
  } catch (e: any) {
    fail(res, e, "DELETE note");
  }
});

// ─── Follow-up ──────────────────────────────────────────────────────────────

parentRecordRouter.put("/api/parents/:id/follow-up", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    const accountKey = await assertCanReachParent(req.user as any, String(req.params.id));
    const target = resolveWriteTarget(viewer, req.body?.scope, req.body?.providerId);
    const body = String(req.body?.body || "").trim();
    const dueAt = req.body?.dueAt ? new Date(req.body.dueAt) : null;
    if (!body) return res.status(400).json({ message: "A next step needs a description" });
    if (!dueAt || isNaN(dueAt.getTime())) return res.status(400).json({ message: "A next step needs a valid due date" });

    // The partial unique indexes guarantee at most one OPEN row per
    // (account, scope, org), so this is a find-then-write rather than an
    // upsert - Prisma cannot target a partial index.
    const open = await prisma.parentFollowUp.findFirst({
      where: {
        parentAccountId: accountKey, scope: target.scope, providerId: target.providerId, status: "OPEN",
      },
    });
    const row = open
      ? await prisma.parentFollowUp.update({
          where: { id: open.id },
          data: { body, dueAt, assigneeUserId: req.body?.assigneeUserId ?? open.assigneeUserId },
        })
      : await prisma.parentFollowUp.create({
          data: {
            parentAccountId: accountKey,
            scope: target.scope,
            providerId: target.providerId,
            body,
            dueAt,
            assigneeUserId: req.body?.assigneeUserId ?? null,
            createdByUserId: viewer.userId,
          },
        });

    emitJourneyEvent({
      eventType: "CRM_FOLLOWUP_SET",
      parentAccountId: accountKey,
      providerId: target.providerId,
      actorRole: viewer.isAdmin ? "admin" : "provider",
      metadata: { followUpId: row.id, scope: target.scope, dueAt: dueAt.toISOString() },
    });
    res.json(row);
  } catch (e: any) {
    fail(res, e, "PUT follow-up");
  }
});

parentRecordRouter.post("/api/parents/:id/follow-up/:fid/complete", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    const accountKey = await assertCanReachParent(req.user as any, String(req.params.id));
    const row = await prisma.parentFollowUp.findUnique({ where: { id: String(req.params.fid) } });
    if (!row) return res.status(404).json({ message: "Next step not found" });
    if (!canMutateCrmRow(viewer, row as any)) return res.status(403).json({ message: "Forbidden" });
    const updated = await prisma.parentFollowUp.update({
      where: { id: row.id },
      data: { status: "DONE", completedAt: new Date(), completedByUserId: viewer.userId },
    });
    emitJourneyEvent({
      eventType: "CRM_FOLLOWUP_COMPLETED",
      parentAccountId: accountKey,
      providerId: row.providerId,
      actorRole: viewer.isAdmin ? "admin" : "provider",
      metadata: { followUpId: row.id, scope: row.scope },
    });
    res.json(updated);
  } catch (e: any) {
    fail(res, e, "complete follow-up");
  }
});

parentRecordRouter.delete("/api/parents/:id/follow-up/:fid", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    await assertCanReachParent(req.user as any, String(req.params.id));
    const row = await prisma.parentFollowUp.findUnique({ where: { id: String(req.params.fid) } });
    if (!row) return res.status(404).json({ message: "Next step not found" });
    if (!canMutateCrmRow(viewer, row as any)) return res.status(403).json({ message: "Forbidden" });
    await prisma.parentFollowUp.update({ where: { id: row.id }, data: { status: "CANCELED" } });
    res.json({ ok: true });
  } catch (e: any) {
    fail(res, e, "cancel follow-up");
  }
});

// ─── Lead owner ─────────────────────────────────────────────────────────────

parentRecordRouter.put("/api/parents/:id/owner", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    const accountKey = await assertCanReachParent(req.user as any, String(req.params.id));
    const target = resolveWriteTarget(viewer, req.body?.scope, req.body?.providerId);
    const ownerUserId = req.body?.ownerUserId ?? null;

    const existing = await prisma.parentOwner.findFirst({
      where: { parentAccountId: accountKey, scope: target.scope, providerId: target.providerId },
    });

    if (!ownerUserId) {
      if (existing) await prisma.parentOwner.delete({ where: { id: existing.id } });
      return res.json({ ok: true, owner: null });
    }

    // Load-bearing. Without this a provider can set ownerUserId to any uuid,
    // and the parents table then renders that person's snapshotted name back to
    // them - a cross-org staff-directory enumeration oracle.
    const owner = await prisma.user.findUnique({
      where: { id: ownerUserId },
      select: { id: true, name: true, roles: true, providerId: true },
    });
    if (!owner) return res.status(400).json({ message: "Unknown owner" });
    if (target.scope === "GOSTORK") {
      const isStaff = (owner.roles || []).some((r: string) => r.startsWith("GOSTORK_"));
      if (!isStaff) return res.status(400).json({ message: "A GoStork owner must be GoStork staff" });
    } else if (owner.providerId !== target.providerId) {
      return res.status(400).json({ message: "That user does not belong to this provider" });
    }

    const row = existing
      ? await prisma.parentOwner.update({
          where: { id: existing.id },
          data: { ownerUserId: owner.id, ownerName: owner.name, assignedByUserId: viewer.userId, assignedAt: new Date() },
        })
      : await prisma.parentOwner.create({
          data: {
            parentAccountId: accountKey,
            scope: target.scope,
            providerId: target.providerId,
            ownerUserId: owner.id,
            ownerName: owner.name,
            assignedByUserId: viewer.userId,
          },
        });

    emitJourneyEvent({
      eventType: "CRM_OWNER_ASSIGNED",
      parentAccountId: accountKey,
      providerId: target.providerId,
      actorRole: viewer.isAdmin ? "admin" : "provider",
      metadata: { ownerUserId: owner.id, scope: target.scope },
    });
    res.json(row);
  } catch (e: any) {
    fail(res, e, "PUT owner");
  }
});

/** Candidate owners for the picker, scoped to what the viewer may assign. */
parentRecordRouter.get("/api/parents/crm/owner-options", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    const where = viewer.isAdmin
      ? { roles: { hasSome: ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE", "GOSTORK_DEVELOPER"] } }
      : { providerId: viewer.providerId as string };
    const users = await prisma.user.findMany({
      where,
      select: { id: true, name: true, photoUrl: true },
      orderBy: { name: "asc" },
    });
    res.json(users);
  } catch (e: any) {
    fail(res, e, "owner options");
  }
});

// ─── Tags ───────────────────────────────────────────────────────────────────

parentRecordRouter.get("/api/parents/crm/tag-vocabulary", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    const where = viewer.isAdmin
      ? { isActive: true }
      : { isActive: true, scope: "PROVIDER", providerId: viewer.providerId as string };
    const tags = await prisma.parentTagDefinition.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
    });
    res.json(tags);
  } catch (e: any) {
    fail(res, e, "tag vocabulary");
  }
});

parentRecordRouter.post("/api/parents/crm/tag-vocabulary", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    const target = resolveWriteTarget(viewer, req.body?.scope, req.body?.providerId);
    const label = String(req.body?.label || "").trim();
    if (!label) return res.status(400).json({ message: "A tag needs a label" });
    const tag = await prisma.parentTagDefinition.create({
      data: {
        scope: target.scope,
        providerId: target.providerId,
        label,
        colorToken: String(req.body?.colorToken || "accent"),
        createdByUserId: viewer.userId,
      },
    });
    res.json(tag);
  } catch (e: any) {
    fail(res, e, "create tag");
  }
});

parentRecordRouter.post("/api/parents/:id/tags", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    const accountKey = await assertCanReachParent(req.user as any, String(req.params.id));
    const tagId = String(req.body?.tagId || "");
    const def = await prisma.parentTagDefinition.findUnique({ where: { id: tagId } });

    // 404, not 403, for a tag the caller cannot see. Otherwise assignment
    // becomes a probe for GoStork's private vocabulary: "it failed with 403"
    // tells you the id exists.
    const visible = def && (viewer.isAdmin || (def.scope === "PROVIDER" && def.providerId === viewer.providerId));
    if (!visible) return res.status(404).json({ message: "Tag not found" });

    const row = await prisma.parentTagAssignment.upsert({
      where: { parentAccountId_tagId: { parentAccountId: accountKey, tagId: def!.id } },
      create: {
        parentAccountId: accountKey,
        tagId: def!.id,
        // Copied from the definition server-side, never from the client.
        scope: def!.scope,
        providerId: def!.providerId,
        assignedByUserId: viewer.userId,
      },
      update: {},
    });

    emitJourneyEvent({
      eventType: "CRM_TAG_ADDED",
      parentAccountId: accountKey,
      providerId: def!.providerId,
      actorRole: viewer.isAdmin ? "admin" : "provider",
      metadata: { tagId: def!.id, scope: def!.scope },
    });
    res.json(row);
  } catch (e: any) {
    fail(res, e, "add tag");
  }
});

parentRecordRouter.delete("/api/parents/:id/tags/:tagId", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    const accountKey = await assertCanReachParent(req.user as any, String(req.params.id));
    const row = await prisma.parentTagAssignment.findUnique({
      where: { parentAccountId_tagId: { parentAccountId: accountKey, tagId: String(req.params.tagId) } },
    });
    if (!row) return res.status(404).json({ message: "Tag not found" });
    if (!canMutateCrmRow(viewer, row as any)) return res.status(404).json({ message: "Tag not found" });
    await prisma.parentTagAssignment.delete({ where: { id: row.id } });
    res.json({ ok: true });
  } catch (e: any) {
    fail(res, e, "remove tag");
  }
});
