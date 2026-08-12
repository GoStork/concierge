/**
 * Stage playbooks: authoring CRUD + the bulk "Apply a playbook" action.
 *
 * Same trust model as the rest of the CRM (parent-crm.ts): everything is
 * resolved from req.user. A provider's playbooks are forced onto their own
 * org; GoStork staff author org-less playbooks (operational ones that raise
 * GOSTORK-scope tasks) and starter templates every org can copy.
 */
import { Router, Request, Response } from "express";
import { prisma } from "./db";
import { resolveCrmViewer, isGostorkStaff, isProviderStaff, CrmAuthError } from "./parent-crm";
import { sanitizeNoteHtml } from "./note-html";
import { readServiceLine } from "./service-lines";
import { JOURNEY_STAGE_ORDER } from "../shared/journey-ladder";
import { firePlaybookForFamily } from "./playbook-sweep";
import { buildParentRecord } from "./parent-record";
import { parentAccountKey } from "./parent-privacy";

export const playbooksRouter = Router();

function requireAuth(req: Request, res: Response, next: () => void) {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  next();
}

/** Staff only - a parent has no playbooks to author. */
function requireStaff(req: Request, res: Response): { isAdmin: boolean; providerId: string | null; userId: string } | null {
  const user = req.user as any;
  if (isGostorkStaff(user)) return { isAdmin: true, providerId: null, userId: user.id };
  if (isProviderStaff(user)) return { isAdmin: false, providerId: user.providerId, userId: user.id };
  res.status(403).json({ message: "Forbidden" });
  return null;
}

const STEP_TYPES = new Set(["TODO", "CALL", "EMAIL"]);
const PRIORITIES = new Set(["NONE", "LOW", "MEDIUM", "HIGH"]);

function readSteps(raw: any): Array<any> {
  const list = Array.isArray(raw) ? raw : [];
  const steps = list
    .map((s: any, i: number) => ({
      id: typeof s?.id === "string" && s.id ? s.id : undefined,
      title: String(s?.title || "").trim().slice(0, 300),
      notes: s?.notes ? sanitizeNoteHtml(String(s.notes)) : null,
      type: STEP_TYPES.has(s?.type) ? s.type : "TODO",
      priority: PRIORITIES.has(s?.priority) ? s.priority : "NONE",
      dueOffsetDays: Math.max(0, Math.min(365, Math.round(Number(s?.dueOffsetDays) || 0))),
      dueTime: /^\d{2}:\d{2}$/.test(String(s?.dueTime || "")) ? String(s.dueTime) : null,
      reminderMinutesBefore: Number.isFinite(Number(s?.reminderMinutesBefore)) && s?.reminderMinutesBefore !== null && s?.reminderMinutesBefore !== ""
        ? Math.max(0, Math.round(Number(s.reminderMinutesBefore)))
        : null,
      sortOrder: i,
    }))
    .filter((s: any) => s.title.length > 0);
  if (steps.length === 0) throw new CrmAuthError(400, "A playbook needs at least one step");
  if (steps.length > 50) throw new CrmAuthError(400, "Too many steps");
  return steps;
}

function readHead(body: any) {
  const name = String(body?.name || "").trim().slice(0, 200);
  if (!name) throw new CrmAuthError(400, "Name is required");
  const triggerStage = String(body?.triggerStage || "");
  if (!(JOURNEY_STAGE_ORDER as readonly string[]).includes(triggerStage)) {
    throw new CrmAuthError(400, "triggerStage must be a journey stage");
  }
  return {
    name,
    triggerStage,
    serviceLine: readServiceLine(body?.serviceLine),
    isActive: body?.isActive === undefined ? true : !!body.isActive,
  };
}

function fail(res: Response, e: any, label: string) {
  if (e instanceof CrmAuthError) return res.status(e.status).json({ message: e.message });
  console.error(`[playbooks] ${label}:`, e);
  return res.status(500).json({ message: e?.message || "Server error" });
}

const PLAYBOOK_INCLUDE = { steps: { orderBy: { sortOrder: "asc" as const } } };

/** Own playbooks + the GoStork starters (read-only to orgs). */
playbooksRouter.get("/api/playbooks", requireAuth, async (req, res) => {
  try {
    const who = requireStaff(req, res);
    if (!who) return;
    const [mine, starters] = await Promise.all([
      prisma.taskPlaybook.findMany({
        where: who.isAdmin ? { providerId: null, isStarter: false } : { providerId: who.providerId },
        include: PLAYBOOK_INCLUDE,
        orderBy: { createdAt: "desc" },
      }),
      prisma.taskPlaybook.findMany({
        where: { isStarter: true },
        include: PLAYBOOK_INCLUDE,
        orderBy: { createdAt: "desc" },
      }),
    ]);
    res.json({ playbooks: mine, starters, isAdmin: who.isAdmin });
  } catch (e) {
    fail(res, e, "GET list");
  }
});

playbooksRouter.post("/api/playbooks", requireAuth, async (req, res) => {
  try {
    const who = requireStaff(req, res);
    if (!who) return;
    const head = readHead(req.body);
    const steps = readSteps(req.body?.steps);
    const created = await prisma.taskPlaybook.create({
      data: {
        ...head,
        // Only GoStork can mint a starter; a provider's flag is ignored.
        isStarter: who.isAdmin ? !!req.body?.isStarter : false,
        providerId: who.providerId,
        createdByUserId: who.userId,
        steps: { create: steps.map(({ id, ...s }: any) => s) },
      },
      include: PLAYBOOK_INCLUDE,
    });
    res.json(created);
  } catch (e) {
    fail(res, e, "POST create");
  }
});

/** May this staffer touch this playbook at all? */
async function loadOwn(who: { isAdmin: boolean; providerId: string | null }, id: string) {
  const pb = await prisma.taskPlaybook.findUnique({ where: { id }, include: PLAYBOOK_INCLUDE });
  if (!pb) throw new CrmAuthError(404, "Playbook not found");
  if (who.isAdmin) return pb;
  if (pb.providerId !== who.providerId) throw new CrmAuthError(403, "Forbidden");
  return pb;
}

playbooksRouter.patch("/api/playbooks/:id", requireAuth, async (req, res) => {
  try {
    const who = requireStaff(req, res);
    if (!who) return;
    const pb = await loadOwn(who, String(req.params.id));
    const head = readHead({ ...pb, ...req.body });
    const steps = readSteps(req.body?.steps ?? pb.steps);

    // Steps are replaced as a set, but rows the client kept (same id) are
    // UPDATED in place - their id is baked into every fired systemKey, and
    // recreating them would let an edited playbook fire twice for the same
    // family. Editing affects future firings only; raised tasks are real
    // rows and are left alone.
    const keptIds = steps.filter((s: any) => s.id).map((s: any) => s.id as string);
    const updated = await prisma.$transaction(async (tx) => {
      await tx.taskPlaybookStep.deleteMany({
        where: { playbookId: pb.id, id: { notIn: keptIds.length ? keptIds : ["-"] } },
      });
      for (const s of steps) {
        const { id, ...data } = s;
        if (id && pb.steps.some((old: any) => old.id === id)) {
          await tx.taskPlaybookStep.update({ where: { id }, data });
        } else {
          await tx.taskPlaybookStep.create({ data: { ...data, playbookId: pb.id } });
        }
      }
      return tx.taskPlaybook.update({
        where: { id: pb.id },
        data: {
          ...head,
          isStarter: who.isAdmin && req.body?.isStarter !== undefined ? !!req.body.isStarter : pb.isStarter,
        },
        include: PLAYBOOK_INCLUDE,
      });
    });
    res.json(updated);
  } catch (e) {
    fail(res, e, "PATCH update");
  }
});

playbooksRouter.delete("/api/playbooks/:id", requireAuth, async (req, res) => {
  try {
    const who = requireStaff(req, res);
    if (!who) return;
    const pb = await loadOwn(who, String(req.params.id));
    await prisma.taskPlaybook.delete({ where: { id: pb.id } });
    res.json({ ok: true });
  } catch (e) {
    fail(res, e, "DELETE");
  }
});

/** "Copy to my agency": a starter becomes an editable playbook of your own. */
playbooksRouter.post("/api/playbooks/:id/copy", requireAuth, async (req, res) => {
  try {
    const who = requireStaff(req, res);
    if (!who) return;
    const src = await prisma.taskPlaybook.findUnique({
      where: { id: String(req.params.id) },
      include: PLAYBOOK_INCLUDE,
    });
    if (!src || !src.isStarter) return res.status(404).json({ message: "Starter not found" });
    const copy = await prisma.taskPlaybook.create({
      data: {
        providerId: who.providerId,
        isStarter: false,
        name: src.name,
        serviceLine: src.serviceLine,
        triggerStage: src.triggerStage,
        isActive: true,
        createdByUserId: who.userId,
        steps: {
          create: src.steps.map((s: any) => ({
            title: s.title, notes: s.notes, type: s.type, priority: s.priority,
            dueOffsetDays: s.dueOffsetDays, dueTime: s.dueTime,
            reminderMinutesBefore: s.reminderMinutesBefore, sortOrder: s.sortOrder,
          })),
        },
      },
      include: PLAYBOOK_INCLUDE,
    });
    res.json(copy);
  } catch (e) {
    fail(res, e, "POST copy");
  }
});

/**
 * Run a playbook across a selection - for families who passed the trigger
 * stage before the playbook existed. Offsets anchor on NOW rather than a
 * long-gone stage date; the systemKey still dedupes against anything the
 * sweep already raised for a step.
 */
playbooksRouter.post("/api/playbooks/:id/apply", requireAuth, async (req, res) => {
  try {
    const who = requireStaff(req, res);
    if (!who) return;
    const pb = await loadOwn(who, String(req.params.id));
    if (pb.isStarter) return res.status(400).json({ message: "Copy the starter to your agency first" });
    const ids: string[] = Array.isArray(req.body?.parentUserIds)
      ? req.body.parentUserIds.map(String).slice(0, 200)
      : [];
    if (!ids.length) return res.status(400).json({ message: "parentUserIds is required" });

    const now = new Date();
    let applied = 0, created = 0;
    const failed: string[] = [];
    for (const parentUserId of ids) {
      try {
        // Re-proves the relationship exactly as every other CRM write does -
        // a provider cannot run a playbook over families they cannot reach.
        await buildParentRecord(req.user as any, parentUserId, { sections: ["identity"] });
        const u = await prisma.user.findUnique({
          where: { id: parentUserId },
          select: { id: true, parentAccountId: true },
        });
        if (!u) throw new Error("not found");
        created += await firePlaybookForFamily(prisma, pb as any, {
          accountKey: parentAccountKey(u),
          serviceLine: pb.serviceLine,
          stageReachedAt: now,
          createdByUserId: who.userId,
        });
        applied++;
      } catch {
        failed.push(parentUserId);
      }
    }
    res.json({ applied, tasksCreated: created, failed });
  } catch (e) {
    fail(res, e, "POST apply");
  }
});
