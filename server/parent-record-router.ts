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
import { parentAccountKey, resolveParentGates, resolveParentGatesBatch } from "./parent-privacy";
import { emitJourneyEvent } from "./journey-events";
import { blockContactInfo } from "./contact-guard";
import { sanitizeNoteHtml, noteHtmlToText } from "./note-html";
import { reconcileTaskKeys } from "./task-materializer";
import { readServiceLine } from "./service-lines";

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
 * attach notes and tasks to a parent they have never met by guessing a user id.
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

/**
 * Search #1 - reach what people wrote. ILIKE over note bodies (plain-text
 * form, so a tag name never matches) and task subjects/notes, scoped to the
 * viewer's audience: an admin sees everything, a provider only PROVIDER rows
 * on their own org - a GOSTORK note NEVER surfaces to a provider.
 */
parentRecordRouter.get("/api/parents/search", requireAuth, async (req, res) => {
  try {
    const viewer = resolveCrmViewer(req.user as any);
    const q = String(req.query?.q || "").trim();
    if (q.length < 3) return res.json({ results: [] });
    const scope = viewer.isAdmin ? {} : { scope: "PROVIDER", providerId: viewer.providerId };
    const like = { contains: q, mode: "insensitive" as const };

    const [notes, tasks] = await Promise.all([
      prisma.parentNote.findMany({
        where: { ...scope, deletedAt: null, bodyText: like },
        select: { id: true, parentAccountId: true, kind: true, bodyText: true, createdAt: true },
        orderBy: { createdAt: "desc" }, take: 50,
      }),
      prisma.parentTask.findMany({
        where: { ...scope, OR: [{ title: like }, { notes: like }] },
        select: { id: true, parentAccountId: true, title: true, notes: true, createdAt: true },
        orderBy: { createdAt: "desc" }, take: 50,
      }),
    ]);

    const keys = Array.from(new Set([...notes, ...tasks].map((r) => r.parentAccountId)));
    if (!keys.length) return res.json({ results: [] });
    // Resolve each accountKey (parentAccountId ?? userId) to a parent user +
    // gated name. One login per key is enough to name and link the family.
    const users = await prisma.user.findMany({
      where: { OR: [{ parentAccountId: { in: keys } }, { id: { in: keys } }], roles: { has: "PARENT" } },
      select: { id: true, name: true, parentAccountId: true },
    });
    const userByKey = new Map<string, { id: string; name: string | null }>();
    for (const u of users) {
      const k = u.parentAccountId || u.id;
      if (!userByKey.has(k)) userByKey.set(k, { id: u.id, name: u.name });
    }
    // Gate the displayed names for providers (admins see all).
    const gates = viewer.isAdmin
      ? null
      : await resolveParentGatesBatch(viewer.providerId!, keys.map((k) => ({ accountKey: k, sessionStatus: null, siblingStatuses: [], hasBooking: true })), prisma as any).catch(() => null);
    const gateByKey = new Map<string, any>();
    if (gates) keys.forEach((k, i) => gateByKey.set(k, (gates as any)[i]));

    const snippet = (text: string | null) => {
      const t = (text || "").replace(/\s+/g, " ").trim();
      const i = t.toLowerCase().indexOf(q.toLowerCase());
      if (i < 0) return t.slice(0, 120);
      const start = Math.max(0, i - 40);
      return (start > 0 ? "…" : "") + t.slice(start, start + 120) + (t.length > start + 120 ? "…" : "");
    };
    const nameFor = (k: string) => {
      const u = userByKey.get(k);
      if (!u) return { parentUserId: null, parentName: "A family" };
      const g = gateByKey.get(k);
      const showName = viewer.isAdmin || (g?.showIdentity ?? true);
      return { parentUserId: u.id, parentName: showName ? (u.name || "A family") : "Prospective Parent" };
    };

    const results = [
      ...notes.map((n) => ({ ...nameFor(n.parentAccountId), kind: n.kind === "NOTE" ? "note" : n.kind.toLowerCase(), snippet: snippet(n.bodyText), at: n.createdAt, entryId: `note-${n.id}` })),
      ...tasks.map((t) => ({ ...nameFor(t.parentAccountId), kind: "task", snippet: snippet(t.title + (t.notes ? " - " + t.notes : "")), at: t.createdAt, entryId: `task-${t.id}` })),
    ].filter((r) => r.parentUserId)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 50);

    res.json({ results });
  } catch (e: any) {
    fail(res, e, "GET parents search");
  }
});

/** Log-a-call fields: a note with a kind. Validated + defaulted. */
const NOTE_KINDS = new Set(["NOTE", "CALL", "EMAIL", "MEETING"]);
const CALL_OUTCOMES = new Set(["reached", "voicemail", "no_answer", "rescheduled"]);
function readNoteKind(body: any): { kind: string; outcome: string | null; durationMinutes: number | null; occurredAt: Date | null } {
  const kind = NOTE_KINDS.has(String(body?.kind)) ? String(body.kind) : "NOTE";
  const outcome = kind === "CALL" && CALL_OUTCOMES.has(String(body?.outcome)) ? String(body.outcome) : null;
  const dur = kind === "CALL" && Number.isFinite(Number(body?.durationMinutes)) ? Math.max(0, Math.round(Number(body.durationMinutes))) : null;
  // Anything but a plain note can have happened in the past; default to now.
  const at = kind !== "NOTE" ? (body?.occurredAt ? new Date(body.occurredAt) : new Date()) : (body?.occurredAt ? new Date(body.occurredAt) : null);
  const occurredAt = at && !isNaN(at.getTime()) ? at : (kind !== "NOTE" ? new Date() : null);
  return { kind, outcome, durationMinutes: dur, occurredAt };
}

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

    const logged = readNoteKind(req.body);
    const note = await prisma.parentNote.create({
      data: {
        parentAccountId: accountKey,
        scope: target.scope,
        providerId: target.providerId,
        body,
        bodyText,
        serviceLine: readServiceLine(req.body?.serviceLine),
        pinned: !!req.body?.pinned,
        authorUserId: viewer.userId,
        authorName: viewer.name,
        authorProviderId: viewer.providerId,
        kind: logged.kind,
        outcome: logged.outcome,
        durationMinutes: logged.durationMinutes,
        occurredAt: logged.occurredAt,
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


/**
 * Hand the pin to this activity - one per KIND.
 *
 * A pinned note is the note to read first, and a pinned task is the task to
 * do first. They live in different parts of the page and answer different
 * questions, so they do not compete: pinning a task unpins only other tasks,
 * and a note only other notes.
 *
 * Scoped to the audience: GoStork's pin and an agency's pin are different
 * records' worth of attention, and neither should be able to knock the other
 * off a card it cannot even see.
 */
async function claimThePin(
  parentAccountId: string,
  scope: string,
  providerId: string | null,
  keep: { kind: "note" | "task"; id: string },
): Promise<void> {
  // Written out per model rather than through a variable: the two delegates
  // are different types, and a union of them is not callable.
  const where = { parentAccountId, scope, providerId, pinned: true, id: { not: keep.id } };
  if (keep.kind === "note") {
    await prisma.parentNote.updateMany({ where, data: { pinned: false } });
  } else {
    await prisma.parentTask.updateMany({ where, data: { pinned: false } });
  }
}

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
      if (req.body.pinned) {
        await claimThePin(existing.parentAccountId, existing.scope, existing.providerId, { kind: "note", id: existing.id });
      }
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
    // Kind/outcome/occurredAt are editable on a logged interaction; kind itself
    // is only re-read when the client sends it (composer edit), else preserved.
    const logged = req.body?.kind !== undefined ? readNoteKind(req.body) : null;
    const note = await prisma.parentNote.update({
      where: { id: existing.id },
      data: {
        body,
        bodyText,
        pinned: req.body?.pinned ?? existing.pinned,
        ...(logged ? { kind: logged.kind, outcome: logged.outcome, durationMinutes: logged.durationMinutes, occurredAt: logged.occurredAt } : {}),
      },
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
    // Task notes carry the same rich text a note's body does, and go through
    // the same sanitizer - they are rendered as HTML on the card.
    notes: body?.notes ? (sanitizeNoteHtml(String(body.notes)) || null) : null,
    serviceLine: readServiceLine(body?.serviceLine),
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

    // Every task belongs to somebody. Left blank, it is the creator's - they
    // are the one who just decided it needed doing, and "Unassigned" is a
    // queue nobody reads.
    const assignee = await resolveAssignee(req.body?.assigneeUserId || viewer.userId);
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
      if (!g.showContact && blockContactInfo(res, `${input.title}\n${noteHtmlToText(input.notes || "")}`, "parent task", {
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
        serviceLine: input.serviceLine,
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

    // Pinning is not editing. It carries no text to validate, and it belongs
    // to the record rather than to whoever typed the task - including for a
    // SYSTEM task, which has no author at all but is often exactly the thing
    // worth reading first.
    if (req.body?.title === undefined && typeof req.body?.pinned === "boolean") {
      if (req.body.pinned) {
        await claimThePin(row.parentAccountId, row.scope, row.providerId, { kind: "task", id: row.id });
      }
      const pinned = await prisma.parentTask.update({
        where: { id: row.id },
        data: { pinned: !!req.body.pinned },
      });
      return res.json(pinned);
    }

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
      if (!g.showContact && blockContactInfo(res, `${input.title}\n${noteHtmlToText(input.notes || "")}`, "parent task", {
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
        serviceLine: input.serviceLine,
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

/**
 * Every open task for this provider, for the Home work queue.
 *
 * Reads TASKS rather than re-deriving the queue, which is the point of
 * materializing: dismiss an item on the family's record and it leaves Home
 * too, because there is only one row behind both. Mine first, then the rest of
 * the org - unassigned work is still everyone's to pick up.
 */
parentRecordRouter.get("/api/provider/tasks", requireAuth, async (req, res) => {
  try {
    const user = req.user as any;
    const providerId = user?.providerId;
    if (!providerId) return res.status(403).json({ message: "Forbidden" });

    const open = await prisma.parentTask.findMany({
      where: { providerId, status: "OPEN" },
      orderBy: { dueAt: "asc" },
      take: 200,
    });
    // Anything the system can see is finished closes itself here rather than
    // waiting for the next ten-minute sweep, so the queue is never telling
    // someone to do what they just did.
    const rows = await reconcileTaskKeys(prisma as any, open as any[]);
    if (!rows.length) return res.json({ tasks: [] });

    // Parent NAMES go through the same gate as everywhere else: a family who
    // has not released their identity to this org is "Prospective Parent" on
    // the dashboard too, not just in chat.
    const accountKeys = Array.from(new Set(rows.map((r) => r.parentAccountId)));
    const members = await prisma.user.findMany({
      where: { OR: [{ parentAccountId: { in: accountKeys } }, { id: { in: accountKeys } }] },
      select: { id: true, name: true, firstName: true, email: true, parentAccountId: true },
    });
    const gates = await resolveParentGatesBatch(
      providerId,
      accountKeys.map((k) => ({ accountKey: k })),
      prisma as any,
    );
    const nameByKey = new Map<string, { name: string; parentUserId: string; email: string | null }>();
    for (const m of members as any[]) {
      const key = m.parentAccountId || m.id;
      if (nameByKey.has(key)) continue;
      const g = gates.get(key);
      nameByKey.set(key, {
        name: g?.showIdentity ? (m.firstName || m.name || "Parent") : "Prospective Parent",
        parentUserId: m.id,
        // #2a: a second identifier so two same-named families are distinct -
        // the email only when this org has earned contact details (Gate B).
        email: g?.showContact ? (m.email || null) : null,
      });
    }

    const now = Date.now();
    res.json({
      tasks: rows.map((t) => {
        const who = nameByKey.get(t.parentAccountId);
        // Work that is the FAMILY's wears the family's name as this viewer is
        // allowed to see it - the gated one, not the stored snapshot.
        const waitingOnParent = !t.assigneeUserId && t.systemKey?.startsWith("agreement:");
        return {
          id: t.id,
          title: t.title,
          type: t.type,
          priority: t.priority,
          dueAt: t.dueAt,
          overdue: new Date(t.dueAt).getTime() < now,
          source: t.source,
          deepLink: t.deepLink,
          assigneeUserId: t.assigneeUserId,
          assigneeName: waitingOnParent ? (who?.name ?? t.assigneeName) : t.assigneeName,
          mine: t.assigneeUserId === user.id,
          parentName: who?.name || "A family",
          parentUserId: who?.parentUserId || null,
          // #2a identifier: email when the org can see it, else the service line.
          parentEmail: who?.email || null,
          serviceLine: t.serviceLine || null,
        };
      }).sort((a, b) => (a.mine === b.mine ? 0 : a.mine ? -1 : 1)),
    });
  } catch (e: any) {
    fail(res, e, "provider tasks");
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
