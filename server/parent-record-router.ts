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
import { sanitizeNoteHtml, noteHtmlToText } from "./note-html";

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
    // Sanitize on READ as well as write: pre-rich-text notes are plain text a
    // user could have typed literal markup into, and the client renders
    // anything tag-shaped as HTML.
    res.json(notes.map((n) => ({ ...n, body: sanitizeNoteHtml(n.body) })));
  } catch (e: any) {
    fail(res, e, "GET notes");
  }
});

parentRecordRouter.post("/api/parents/:id/notes", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    const accountKey = await assertCanReachParent(req.user as any, String(req.params.id));
    // The composer sends rich HTML. Sanitize before ANYTHING else - storage,
    // the contact guard, the length in the journey event - so hostile markup
    // never exists anywhere downstream.
    const body = sanitizeNoteHtml(String(req.body?.body || ""));
    const bodyText = noteHtmlToText(body);
    if (!bodyText) return res.status(400).json({ message: "A note needs a body" });

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
      // Scan the stripped text: markup could split a phone number
      // ("555<b>-</b>0143") straight past the regex.
      if (!g.showContact && blockContactInfo(res, bodyText, "parent CRM note", {
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
      metadata: { noteId: note.id, scope: target.scope, length: bodyText.length },
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
    // A pin toggle sends no body; the note keeps its text. It sits BEFORE the
    // author check on purpose: a pin belongs to the PARENT RECORD, not to the
    // note's author (HubSpot semantics) - a coordinator covering for a
    // colleague must be able to pin or unpin the colleague's note. The org
    // check above still applies; only the note's words stay author-only.
    const pinOnly = req.body?.body === undefined && typeof req.body?.pinned === "boolean";
    if (pinOnly) {
      const note = await prisma.parentNote.update({
        where: { id: existing.id },
        data: { pinned: !!req.body.pinned },
      });
      return res.json(note);
    }
    if (!viewer.isAdmin && existing.authorUserId !== viewer.userId) {
      return res.status(403).json({ message: "You can only edit your own notes" });
    }

    const body = sanitizeNoteHtml(String(req.body?.body || ""));
    const bodyText = noteHtmlToText(body);
    if (!bodyText) return res.status(400).json({ message: "A note needs a body" });

    // The SAME Gate B guard as POST. Without it, editing was a hole: post a
    // clean provider-visible note, then edit the phone number in.
    if (existing.scope === "PROVIDER" && existing.providerId) {
      const accountKey2 = existing.parentAccountId;
      const g = await resolveParentGates(existing.providerId, accountKey2, { sessionStatus: null, hasBooking: true });
      if (!g.showContact && blockContactInfo(res, bodyText, "parent CRM note", {
        parentAccountId: accountKey2, providerId: existing.providerId, authorUserId: viewer.userId,
      }, "note")) return;
    }

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

const TASK_TYPES = ["TODO", "CALL", "EMAIL"];
const TASK_PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH"];
/** Offsets the UI offers, in minutes before due. 0 = at due time. */
const REMINDER_OFFSETS = [0, 30, 60, 1440, 10080];

/**
 * Shape and validate the writable half of a task.
 *
 * Enums are whitelisted rather than passed through: the reminder sweep and the
 * digest both branch on these strings, so an unrecognised one would silently
 * mean "never remind" instead of failing loudly.
 */
function readTaskInput(body: any) {
  const title = String(body?.title ?? body?.body ?? "").trim();
  const dueAt = body?.dueAt ? new Date(body.dueAt) : null;
  const type = TASK_TYPES.includes(String(body?.type)) ? String(body.type) : "TODO";
  const priority = TASK_PRIORITIES.includes(String(body?.priority)) ? String(body.priority) : "NONE";
  const raw = body?.reminderMinutesBefore;
  const reminderMinutesBefore = raw === null || raw === undefined || raw === ""
    ? null
    : (REMINDER_OFFSETS.includes(Number(raw)) ? Number(raw) : null);
  return {
    title,
    notes: body?.notes ? String(body.notes) : null,
    type,
    priority,
    dueAt,
    reminderMinutesBefore,
  };
}

/**
 * Can this viewer put a task in that person's queue?
 *
 * GoStork may assign across orgs - that is a deliberate product decision, so
 * they can chase an agency directly. It has a consequence the caller must not
 * forget: a cross-org task is READ BY the provider, so it is written at
 * PROVIDER scope and its text goes through the same contact guard as a
 * provider-visible note. GoStork cannot smuggle a parent's phone number into
 * an agency's task list.
 */
async function resolveAssignee(assigneeUserId: string | null | undefined) {
  if (!assigneeUserId) return { assigneeUserId: null, assigneeName: null, providerId: null as string | null };
  const u = await prisma.user.findUnique({
    where: { id: String(assigneeUserId) },
    select: { id: true, name: true, email: true, providerId: true },
  });
  if (!u) return { assigneeUserId: null, assigneeName: null, providerId: null as string | null };
  return { assigneeUserId: u.id, assigneeName: u.name || u.email, providerId: u.providerId };
}

parentRecordRouter.post("/api/parents/:id/tasks", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    const accountKey = await assertCanReachParent(req.user as any, String(req.params.id));
    const input = readTaskInput(req.body);
    if (!input.title) return res.status(400).json({ message: "A task needs a title" });
    if (!input.dueAt || isNaN(input.dueAt.getTime())) {
      return res.status(400).json({ message: "A task needs a valid due date" });
    }

    const assignee = await resolveAssignee(req.body?.assigneeUserId);
    // Assigning to someone at a provider org makes this THEIR task, so it is
    // written at that org's scope no matter who created it - otherwise a
    // GoStork-scoped row would be invisible to the person meant to do it.
    const target = assignee.providerId
      ? { scope: "PROVIDER", providerId: assignee.providerId }
      : resolveWriteTarget(viewer, req.body?.scope, req.body?.providerId);

    // A PROVIDER-scoped task is READ BY that org, so it passes the same
    // contact guard a provider-visible note does. GoStork assigning across
    // orgs must not become a way to hand an agency a phone number that
    // ParentContactRelease is deliberately withholding.
    if (target.scope === "PROVIDER" && target.providerId) {
      const g = await resolveParentGates(target.providerId, accountKey, { sessionStatus: null, hasBooking: true });
      if (!g.showContact && blockContactInfo(res, `${input.title}\n${input.notes || ""}`, "parent task", {
        parentAccountId: accountKey, providerId: target.providerId, authorUserId: viewer.userId,
      }, "note")) return;
    }

    const row = await prisma.parentTask.create({
      data: {
        parentAccountId: accountKey,
        scope: target.scope,
        providerId: target.providerId,
        title: input.title,
        notes: input.notes,
        type: input.type,
        priority: input.priority,
        dueAt: input.dueAt,
        reminderMinutesBefore: input.reminderMinutesBefore,
        assigneeUserId: assignee.assigneeUserId,
        assigneeName: assignee.assigneeName,
        createdByUserId: viewer.userId,
      },
    });

    emitJourneyEvent({
      eventType: "CRM_FOLLOWUP_SET",
      parentAccountId: accountKey,
      providerId: target.providerId,
      actorRole: viewer.isAdmin ? "admin" : "provider",
      // Ids and shapes only - never the task text. GET /api/journey/events
      // returns metadata verbatim to providers.
      metadata: {
        taskId: row.id, scope: target.scope, dueAt: input.dueAt.toISOString(),
        type: input.type, priority: input.priority,
      },
    });
    res.json(row);
  } catch (e: any) {
    fail(res, e, "create task");
  }
});

parentRecordRouter.patch("/api/parents/:id/tasks/:tid", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    const accountKey = await assertCanReachParent(req.user as any, String(req.params.id));
    const row = await prisma.parentTask.findUnique({ where: { id: String(req.params.tid) } });
    if (!row) return res.status(404).json({ message: "Task not found" });
    if (!canMutateCrmRow(viewer, row as any)) return res.status(403).json({ message: "Forbidden" });

    const input = readTaskInput({ ...row, ...req.body });
    if (!input.title) return res.status(400).json({ message: "A task needs a title" });
    if (!input.dueAt || isNaN(input.dueAt.getTime())) {
      return res.status(400).json({ message: "A task needs a valid due date" });
    }
    const assignee = req.body?.assigneeUserId !== undefined
      ? await resolveAssignee(req.body.assigneeUserId)
      : { assigneeUserId: row.assigneeUserId, assigneeName: row.assigneeName, providerId: null };

    if (row.scope === "PROVIDER" && row.providerId) {
      const g = await resolveParentGates(row.providerId, accountKey, { sessionStatus: null, hasBooking: true });
      if (!g.showContact && blockContactInfo(res, `${input.title}\n${input.notes || ""}`, "parent task", {
        parentAccountId: accountKey, providerId: row.providerId, authorUserId: viewer.userId,
      }, "note")) return;
    }

    const updated = await prisma.parentTask.update({
      where: { id: row.id },
      data: {
        title: input.title,
        notes: input.notes,
        type: input.type,
        priority: input.priority,
        dueAt: input.dueAt,
        reminderMinutesBefore: input.reminderMinutesBefore,
        assigneeUserId: assignee.assigneeUserId,
        assigneeName: assignee.assigneeName,
        // A re-dated or re-timed task earns a fresh reminder.
        reminderSentAt: input.dueAt.getTime() !== new Date(row.dueAt).getTime() ? null : row.reminderSentAt,
      },
    });
    res.json(updated);
  } catch (e: any) {
    fail(res, e, "update task");
  }
});

/**
 * Complete a task.
 *
 * A SYSTEM task mirrors an artifact that is still sitting there unresolved, so
 * closing one is not the same as doing the work. The client asks first and
 * sends force:true; we record `dismissedUnresolved` so the history says what
 * actually happened rather than showing a clean "done". MANUAL tasks are
 * nobody's business but the person who wrote them - they just close.
 */
parentRecordRouter.post("/api/parents/:id/tasks/:tid/complete", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    const accountKey = await assertCanReachParent(req.user as any, String(req.params.id));
    const row = await prisma.parentTask.findUnique({ where: { id: String(req.params.tid) } });
    if (!row) return res.status(404).json({ message: "Task not found" });
    if (!canMutateCrmRow(viewer, row as any)) return res.status(403).json({ message: "Forbidden" });

    const unresolved = row.source === "SYSTEM";
    if (unresolved && req.body?.force !== true) {
      return res.status(409).json({
        message: "This has not actually been done yet.",
        needsConfirmation: true,
        title: row.title,
      });
    }

    const updated = await prisma.parentTask.update({
      where: { id: row.id },
      data: {
        status: "DONE",
        completedAt: new Date(),
        completedByUserId: viewer.userId,
        dismissedUnresolved: unresolved,
      },
    });
    emitJourneyEvent({
      eventType: "CRM_FOLLOWUP_COMPLETED",
      parentAccountId: accountKey,
      providerId: row.providerId,
      actorRole: viewer.isAdmin ? "admin" : "provider",
      metadata: { taskId: row.id, scope: row.scope, dismissedUnresolved: unresolved },
    });
    res.json(updated);
  } catch (e: any) {
    fail(res, e, "complete task");
  }
});

parentRecordRouter.delete("/api/parents/:id/tasks/:tid", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    await assertCanReachParent(req.user as any, String(req.params.id));
    const row = await prisma.parentTask.findUnique({ where: { id: String(req.params.tid) } });
    if (!row) return res.status(404).json({ message: "Task not found" });
    if (!canMutateCrmRow(viewer, row as any)) return res.status(403).json({ message: "Forbidden" });
    await prisma.parentTask.update({ where: { id: row.id }, data: { status: "CANCELED" } });
    res.json({ ok: true });
  } catch (e: any) {
    fail(res, e, "cancel task");
  }
});

/**
 * Who a task on this record can be handed to.
 *
 * An admin may assign across orgs (their call), so they see GoStork staff plus
 * every org already working this family - never the whole user table. A
 * provider sees only their own colleagues; offering them GoStork staff would
 * leak an internal directory and let them push work at us.
 */
parentRecordRouter.get("/api/parents/:id/assignable", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    await assertCanReachParent(req.user as any, String(req.params.id));
    if (!viewer.isAdmin) {
      if (!viewer.providerId) return res.json({ users: [] });
      const users = await prisma.user.findMany({
        where: { providerId: viewer.providerId },
        select: { id: true, name: true, email: true },
        orderBy: { name: "asc" },
      });
      return res.json({ users });
    }
    const record = await prisma.aiChatSession.findMany({
      where: { userId: String(req.params.id) },
      select: { providerId: true },
    });
    const providerIds = Array.from(new Set(record.map((r) => r.providerId).filter(Boolean))) as string[];
    const [staff, admins] = await Promise.all([
      providerIds.length
        ? prisma.user.findMany({
            where: { providerId: { in: providerIds } },
            select: { id: true, name: true, email: true, provider: { select: { name: true } } },
            orderBy: { name: "asc" },
          })
        : [],
      prisma.user.findMany({
        where: { roles: { hasSome: ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE"] } },
        select: { id: true, name: true, email: true },
        orderBy: { name: "asc" },
      }),
    ]);
    res.json({
      users: [
        ...admins.map((u: any) => ({ ...u, providerName: "GoStork" })),
        ...staff.map((u: any) => ({ id: u.id, name: u.name, email: u.email, providerName: u.provider?.name || null })),
      ],
    });
  } catch (e: any) {
    fail(res, e, "assignable users");
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
