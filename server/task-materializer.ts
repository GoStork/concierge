/**
 * Turning the provider work queue into real tasks.
 *
 * The Home queue was DERIVED: computed live from unresolved artifacts, stored
 * nowhere. That made it honest but inert - you could not assign an item, date
 * it, or see it on the family's record. Now each item is a real ParentTask, so
 * a coordinator's own tasks and the ones the product raises live in one list.
 *
 * THE HAZARD, AND WHAT ANSWERS IT. Writing rows from derived state on a cron
 * that runs on two machines is how ghost tasks are born - work that says
 * "approve the cost sheet" long after someone approved it. Two things keep
 * that from happening, and they are the reason this file exists as a pair
 * rather than a single raise() function:
 *
 *   - `systemKey` is the artifact's identity and is UNIQUE in the database.
 *     Both machines can run this in the same second; the second insert loses.
 *   - `reconcile` runs in the same pass and closes any open SYSTEM task whose
 *     key is no longer in the live set. Resolve the artifact anywhere - the
 *     chat, the invoices page, another coordinator's session - and the task
 *     closes itself within ten minutes.
 *
 * A task the coordinator DISMISSED (dismissedUnresolved) is never re-raised.
 * They were shown exactly what was still outstanding and said do it anyway;
 * raising it again would be arguing with them every ten minutes.
 */
import { serviceLineOfType } from "./service-lines";
import { serviceLineOfSubject } from "./journey-timeline";
import { PROVIDER_ROLES } from "../shared/roles";

type Db = any;

/** The kinds of work the queue knows how to raise. */
/**
 * IP-form review is deliberately NOT here. That queue item is scoped by a JSON
 * providerViewedAt map and by which orgs are working the family at all, which
 * is association logic this sweep would have to reproduce - and it already has
 * its own section on Home. Left derived rather than half-materialized.
 */
type QueueKind = "approval" | "whisper" | "review" | "agreement";

interface QueueItem {
  /** Unique per artifact - the whole dedupe story. */
  systemKey: string;
  /**
   * Waiting on the FAMILY rather than the org. An agreement sitting unsigned
   * is the parent's move; saying so is the difference between "nobody owns
   * this" and "this is not yours to do yet".
   */
  waitingOnParent?: boolean;
  /** First name, for the assignee line when the family is the one to act. */
  parentName?: string;
  providerId: string;
  parentAccountId: string;
  title: string;
  deepLink: string | null;
  kind: QueueKind;
  /** When the work appeared, so an old item is visibly old. */
  since: Date;
  /** Which line the work belongs to, so the record's scope filter can place it. */
  serviceLine: string | null;
  /** The thread it came out of, when the deep link points somewhere else. */
  chatSessionId?: string | null;
}

/**
 * Copied deliberately from the dashboard-queue handler, and VERIFIED against
 * it - an earlier guess at these names ("cost_sheet_approval") matched nothing
 * and silently raised zero approval tasks. If that list ever changes, this one
 * has to change with it.
 */
const APPROVAL_TYPES = [
  "cost_sheet_draft_approval", "invoice_draft_approval",
  "agreement_draft_approval", "provider_readiness_prompt",
];

/**
 * What "still outstanding" MEANS, per kind, in one place.
 *
 * Both readers below depend on these: the sweep, which asks the question for
 * every artifact on the platform, and reconcileTaskKeys, which asks it for the
 * handful of tasks someone is looking at right now. Written once so the two
 * can never come to disagree about whether a piece of work is done.
 */
/**
 * The systemKey prefixes THIS file owns. Other producers write SYSTEM tasks
 * too (playbook:, silence:) with lifecycles of their own; both reconcilers
 * below must only ever close keys from this list, or every foreign task
 * would be "stale" by definition and die on the next pass.
 */
const QUEUE_KINDS = ["approval", "whisper", "review", "agreement"] as const;
const isQueueKey = (key: string) => QUEUE_KINDS.some((k) => key.startsWith(`${k}:`));

export const LIVE_WHERE = {
  whisper: { status: "PENDING" },
  // PUBLISHED only: a review still in moderation is not the provider's to
  // answer yet, and providerReply is the field that says they have.
  review: { providerReply: null, visibility: "PUBLIC", status: "PUBLISHED" },
  agreement: { status: "SENT", supersededAt: null },
} as const;

/**
 * An approval card is done when it has been resolved - approved, rejected or
 * superseded, they all count, because the decision is the work. A readiness
 * prompt is a question rather than a decision, so it is done when answered.
 */
export function isApprovalCardLive(cardType: string, data: any): boolean {
  const d = data || {};
  return cardType === "provider_readiness_prompt" ? !d.answered : !d.resolvedAt;
}

/**
 * How long each kind of work gets before it counts as late.
 *
 * The due date used to be the moment the work APPEARED, which made every new
 * task overdue on arrival - send an agreement and the task to chase it is
 * already amber before you have left the page. Anchoring on when it appeared
 * is still right (an item that has sat for a month should read as a month
 * late); what was missing is the window in which doing it is simply on time.
 *
 * The numbers are the ones the rest of the product already implies: a whisper
 * gets the two hours after which whisper-sla.scheduler starts nudging, an
 * approval blocks the family's next step so it gets a day, a public review
 * reply is worth writing well rather than fast, and an agreement sitting
 * unsigned is the family's move for the best part of a week before anyone
 * should be chasing it.
 */
const DUE_IN_HOURS: Record<QueueKind, number> = {
  approval: 24,
  whisper: 2,
  review: 72,
  agreement: 120,
};

const KIND_TITLE: Record<QueueKind, (subject: string) => string> = {
  approval: (s) => `Review and approve: ${s}`,
  whisper: (s) => `Answer a question from ${s}`,
  review: (s) => `Reply to a review from ${s}`,
  agreement: (s) => `Agreement out for signature: ${s}`,
};

/**
 * Everything unresolved, across every provider, in one pass.
 *
 * Set-based rather than per-provider: the sweep runs for the whole platform,
 * and N round trips per provider would grow with the customer base.
 */
export async function collectQueueItems(db: Db): Promise<QueueItem[]> {
  const items: QueueItem[] = [];

  const [approvalCards, whispers, reviews, agreements] = await Promise.all([
    db.aiChatMessage.findMany({
      where: { uiCardType: { in: APPROVAL_TYPES }, session: { providerId: { not: null } } },
      select: {
        id: true, uiCardType: true, uiCardData: true, createdAt: true,
        session: { select: { id: true, providerId: true, userId: true, subjectType: true } },
      },
    }),
    db.silentQuery.findMany({
      where: { ...LIVE_WHERE.whisper },
      select: { id: true, providerId: true, createdAt: true, session: { select: { userId: true, subjectType: true } } },
    }),
    db.providerReview.findMany({
      where: { ...LIVE_WHERE.review },
      select: { id: true, providerId: true, parentAccountId: true, createdAt: true },
    }),
    db.agreement.findMany({
      where: { ...LIVE_WHERE.agreement },
      select: { id: true, providerId: true, parentUserId: true, documentType: true, serviceType: true, sessionId: true, createdAt: true },
    }),
  ]);

  // One account lookup for every parent id these rows mention.
  const userIds = Array.from(new Set([
    ...approvalCards.map((c: any) => c.session?.userId),
    ...whispers.map((w: any) => w.session?.userId),
    ...agreements.map((a: any) => a.parentUserId),
  ].filter(Boolean))) as string[];
  const users = userIds.length
    ? await db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, firstName: true, parentAccountId: true },
      })
    : [];
  const acctOf = new Map<string, string>(users.map((u: any) => [u.id, u.parentAccountId || u.id]));
  const nameOf = new Map<string, string>(users.map((u: any) => [u.id, u.firstName || u.name || "a family"]));
  // The full name is for the assignee line, where a person is named the way
  // every other person on the page is. Titles keep the first name, which is
  // how the product refers to a family in a sentence.
  const fullNameOf = new Map<string, string>(users.map((u: any) => [u.id, u.name || u.firstName || "the family"]));

  for (const c of approvalCards as any[]) {
    const pid = c.session?.providerId;
    const uid = c.session?.userId;
    if (!pid || !uid) continue;
    const data = (c.uiCardData as any) || {};
    if (!isApprovalCardLive(c.uiCardType, data)) continue;
    items.push({
      systemKey: `approval:${c.id}`,
      providerId: pid,
      parentAccountId: acctOf.get(uid) || uid,
      title: c.uiCardType === "provider_readiness_prompt"
        ? `Confirm you are ready for ${nameOf.get(uid)}`
        : KIND_TITLE.approval(
            c.uiCardType === "invoice_draft_approval" ? `invoice for ${nameOf.get(uid)}`
              : c.uiCardType === "agreement_draft_approval" ? `agreement for ${nameOf.get(uid)}`
              : `cost sheet for ${nameOf.get(uid)}`,
          ),
      deepLink: `/chat/${uid}/${c.session.id}`,
      kind: "approval",
      // The card carries the line it was drafted for; the thread's subject is
      // the fallback for older cards that do not.
      serviceLine: serviceLineOfType(data.serviceType) || serviceLineOfSubject(c.session.subjectType),
      since: c.createdAt,
    });
  }

  for (const w of whispers as any[]) {
    const uid = w.session?.userId;
    if (!w.providerId || !uid) continue;
    items.push({
      systemKey: `whisper:${w.id}`,
      providerId: w.providerId,
      parentAccountId: acctOf.get(uid) || uid,
      // The parent is ANONYMOUS at whisper stage, so the title must not name
      // them - that is the entire point of the whisper protocol.
      title: KIND_TITLE.whisper("a prospective parent"),
      deepLink: "/chat",
      kind: "whisper",
      serviceLine: serviceLineOfSubject(w.session?.subjectType),
      since: w.createdAt,
    });
  }

  for (const r of reviews as any[]) {
    if (!r.providerId || !r.parentAccountId) continue;
    items.push({
      systemKey: `review:${r.id}`,
      providerId: r.providerId,
      parentAccountId: r.parentAccountId,
      title: KIND_TITLE.review("a family"),
      deepLink: "/performance?tab=reviews",
      kind: "review",
      // A review is about the org, not one line of work.
      serviceLine: null,
      since: r.createdAt,
    });
  }

  for (const a of agreements as any[]) {
    if (!a.providerId || !a.parentUserId) continue;
    items.push({
      systemKey: `agreement:${a.id}`,
      providerId: a.providerId,
      parentAccountId: acctOf.get(a.parentUserId) || a.parentUserId,
      title: KIND_TITLE.agreement(
        `${a.documentType || "Agreement"} for ${nameOf.get(a.parentUserId) || "a family"}`,
      ),
      deepLink: `/agreements/${a.id}`,
      // The agreement opens the document; this opens the conversation it was
      // sent from, which is where the coordinator would chase it.
      chatSessionId: a.sessionId,
      kind: "agreement",
      serviceLine: serviceLineOfType(a.serviceType),
      waitingOnParent: true,
      parentName: fullNameOf.get(a.parentUserId) || "the family",
      since: a.createdAt,
    });
  }

  return items;
}

/**
 * Raise a task for anything unresolved, and close anything that resolved.
 *
 * Idempotent by construction: the unique systemKey means re-running this is a
 * no-op, which is what lets both machines run it on the same tick.
 */
export async function runTaskMaterializeSweep(db: Db): Promise<void> {
  try {
    const items = await collectQueueItems(db);
    const liveKeys = new Set(items.map((i) => i.systemKey));

    // Lead owners decide assignment - PER SERVICE LINE: the surrogacy
    // coordinator gets the surrogacy work, the egg-donor coordinator the
    // egg-donor work, on the same family; the org-wide fallback owner takes
    // lines nobody claimed. Every task still ends up with a NAME on it:
    // there is no such thing as work nobody is waiting on, and "Unassigned"
    // is a queue nobody reads.
    const accountIds = Array.from(new Set(items.map((i) => i.parentAccountId)));
    const owners = accountIds.length
      ? await db.parentOwner.findMany({
          where: { parentAccountId: { in: accountIds }, scope: "PROVIDER" },
          select: { parentAccountId: true, providerId: true, serviceLine: true, ownerUserId: true, ownerName: true },
        })
      : [];
    const ownerRowsOf = new Map<string, any[]>();
    for (const o of owners as any[]) {
      const k = `${o.parentAccountId}|${o.providerId}`;
      const list = ownerRowsOf.get(k) || [];
      list.push(o);
      ownerRowsOf.set(k, list);
    }
    const { ownerForLine } = await import("./parent-crm");
    const ownerOf = (accountId: string, providerId: string, line: string | null): { id: string; name: string | null } | null => {
      const row = ownerForLine(ownerRowsOf.get(`${accountId}|${providerId}`) || [], line);
      return row ? { id: row.ownerUserId, name: row.ownerName } : null;
    };

    // The org's own name, for work that is the team's rather than one
    // person's. It is not a user, so nothing gets emailed to it - it is the
    // honest answer to "whose is this" when the family has no lead owner yet.
    const providerIds = Array.from(new Set(items.map((i) => i.providerId)));
    const providers = providerIds.length
      ? await db.provider.findMany({ where: { id: { in: providerIds } }, select: { id: true, name: true } })
      : [];
    const orgName = new Map<string, string>(providers.map((p: any) => [p.id, p.name]));

    let raised = 0;
    for (const item of items) {
      const owner = ownerOf(item.parentAccountId, item.providerId, item.serviceLine);
      try {
        await db.parentTask.create({
          data: {
            parentAccountId: item.parentAccountId,
            scope: "PROVIDER",
            providerId: item.providerId,
            title: item.title,
            type: item.kind === "whisper" || item.kind === "review" ? "EMAIL" : "TODO",
            priority: "NONE",
            // Anchored on when the work appeared, plus the window its kind
            // gets - so a backlog item still reads as weeks late, and one
            // raised a minute ago does not read as late at all.
            dueAt: new Date(item.since.getTime() + DUE_IN_HOURS[item.kind] * 3_600_000),
            source: "SYSTEM",
            systemKey: item.systemKey,
            deepLink: item.deepLink,
            chatSessionId: item.chatSessionId ?? null,
            serviceLine: item.serviceLine,
            // Waiting on the family: it wears their name, and no user id, so
            // no reminder is ever addressed to a parent about the provider's
            // work queue.
            assigneeUserId: item.waitingOnParent ? null : (owner?.id ?? null),
            assigneeName: item.waitingOnParent
              ? (item.parentName || "the family")
              : (owner?.name ?? orgName.get(item.providerId) ?? "the team"),
            createdByUserId: owner?.id ?? "system",
          },
        });
        raised++;
      } catch (e: any) {
        // P2002 = the other machine got there first, or it already exists.
        // Both are the correct outcome, not an error.
        if (e?.code !== "P2002") throw e;
      }
    }

    // Reconcile. Anything open whose artifact is gone gets closed - NOT
    // deleted, so the record still shows the work happened. ONLY the queue
    // kinds this sweep raises: other SYSTEM producers (playbook:, silence:)
    // have their own lifecycles, and closing their keys here would kill
    // every one of their tasks within ten minutes of it being raised.
    const openSystem = await db.parentTask.findMany({
      where: { source: "SYSTEM", status: "OPEN" },
      select: { id: true, systemKey: true },
    });
    const stale = openSystem
      .filter((t: any) => t.systemKey && isQueueKey(t.systemKey) && !liveKeys.has(t.systemKey))
      .map((t: any) => t.id);
    if (stale.length) {
      await db.parentTask.updateMany({
        where: { id: { in: stale } },
        data: { status: "DONE", completedAt: new Date() },
      });
    }
    if (raised || stale.length) {
      console.log(`[tasks] Raised ${raised}, auto-closed ${stale.length} resolved`);
    }
  } catch (e: any) {
    console.error(`[tasks] materialize sweep failed: ${e?.message}`);
  }
}

/**
 * Calendar-connection tasks (calconn:<userId>).
 *
 * Every provider staff member is expected to have a working calendar - it is
 * what lets parents book calls with them. This raises "Connect your calendar"
 * for staff with no live connection and "Reconnect your calendar" when a
 * connection's refresh token has died (tokenValid=false, cleared by the
 * calendar-health scheduler), and closes the task itself the moment the
 * calendar is healthy again.
 *
 * Same personal-task shape as the W-9 and provider-agreement tasks: the
 * parentAccountId slot carries the providerId (no family attached), and the
 * task is assigned to the specific user whose calendar it is.
 *
 * Reopen rule: a row this sweep closed (completedByUserId null) reopens if the
 * calendar breaks again. A row the USER completed (completedByUserId set,
 * possibly dismissedUnresolved) is their answer and is never re-raised.
 */
const calendarTaskState = (conns: Array<{ connected: boolean; tokenValid: boolean }>): "none" | "expired" | "ok" => {
  const live = conns.filter((c) => c.connected);
  if (!live.length) return "none";
  if (live.some((c) => c.tokenValid === false)) return "expired";
  return "ok";
};

const CAL_TASK_COPY = {
  none: {
    title: "Connect your calendar",
    notes: "Connect your Google, Outlook, or Apple calendar so parents can book calls with you and your availability stays accurate.",
    deepLink: "/account/calendar?connect=true",
  },
  expired: {
    title: "Reconnect your calendar",
    notes: "A calendar connection has expired, so new bookings are not syncing. Reconnect it from your Calendar settings.",
    deepLink: "/account/calendar",
  },
} as const;

export async function runCalendarConnectionTaskSweep(db: Db): Promise<void> {
  try {
    const staff = await db.user.findMany({
      where: {
        providerId: { not: null },
        roles: { hasSome: [...PROVIDER_ROLES] },
        // GoStork staff are linked to the house provider row; their calendars
        // are managed from the admin table, not nagged by tasks.
        NOT: { roles: { hasSome: ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE"] } },
      },
      select: {
        id: true, name: true, email: true, providerId: true,
        calendarConnections: {
          where: { NOT: { calendarId: "__pending__" } },
          select: { connected: true, tokenValid: true },
        },
      },
    });

    let raised = 0, reopened = 0, closed = 0;
    for (const u of staff as any[]) {
      const key = `calconn:${u.id}`;
      const state = calendarTaskState(u.calendarConnections);
      if (state === "ok") {
        // completedByUserId stays null - that is the marker that the SYSTEM
        // closed it, which is what allows a reopen if it breaks again.
        const r = await db.parentTask.updateMany({
          where: { systemKey: key, status: "OPEN" },
          data: { status: "DONE", completedAt: new Date() },
        });
        closed += r.count;
        continue;
      }
      const copy = CAL_TASK_COPY[state];
      try {
        await db.parentTask.create({
          data: {
            parentAccountId: u.providerId,
            scope: "PROVIDER",
            providerId: u.providerId,
            title: copy.title,
            notes: copy.notes,
            type: "TODO",
            priority: "MEDIUM",
            dueAt: new Date(Date.now() + 3 * 86_400_000),
            source: "SYSTEM",
            systemKey: key,
            deepLink: copy.deepLink,
            assigneeUserId: u.id,
            assigneeName: u.name || u.email,
            createdByUserId: "system",
          },
        });
        raised++;
      } catch (e: any) {
        if (e?.code !== "P2002") throw e;
        // Row exists. Keep an OPEN row's copy current (none -> expired), and
        // reopen only a system-closed row - never one the user completed.
        const r = await db.parentTask.updateMany({
          where: {
            systemKey: key,
            OR: [
              { status: "OPEN" },
              { status: "DONE", completedByUserId: null },
            ],
          },
          data: { status: "OPEN", title: copy.title, notes: copy.notes, deepLink: copy.deepLink, completedAt: null },
        });
        reopened += r.count;
      }
    }
    if (raised || reopened || closed) {
      console.log(`[tasks] calendar: raised ${raised}, refreshed/reopened ${reopened}, closed ${closed}`);
    }
  } catch (e: any) {
    console.error(`[tasks] calendar-connection sweep failed: ${e?.message}`);
  }
}

/**
 * Read-time reconcile for calconn: tasks - connect a calendar, come straight
 * back to Home, and the task is gone rather than waiting out the 10-minute
 * sweep. Close-only, mirroring the silence reconciler.
 */
async function reconcileCalendarTasks<T extends { id: string; source?: string; systemKey?: string | null }>(
  db: Db, tasks: T[],
): Promise<T[]> {
  const cal = tasks.filter((t) => t.source === "SYSTEM" && t.systemKey?.startsWith("calconn:"));
  if (!cal.length) return tasks;
  try {
    const userIds = cal.map((t) => t.systemKey!.slice("calconn:".length));
    const conns = await db.calendarConnection.findMany({
      where: { userId: { in: userIds }, NOT: { calendarId: "__pending__" } },
      select: { userId: true, connected: true, tokenValid: true },
    });
    const byUser = new Map<string, any[]>();
    for (const c of conns as any[]) {
      const list = byUser.get(c.userId) || [];
      list.push(c);
      byUser.set(c.userId, list);
    }
    const closedIds = cal
      .filter((t) => calendarTaskState(byUser.get(t.systemKey!.slice("calconn:".length)) || []) === "ok")
      .map((t) => t.id);
    if (!closedIds.length) return tasks;
    await db.parentTask.updateMany({
      where: { id: { in: closedIds }, status: "OPEN" },
      data: { status: "DONE", completedAt: new Date() },
    });
    const closed = new Set(closedIds);
    return tasks.filter((t) => !closed.has(t.id));
  } catch (e: any) {
    console.error(`[tasks] calendar reconcile failed: ${e?.message}`);
    return tasks;
  }
}

/**
 * Close, right now, any of these tasks whose work is already done.
 *
 * The sweep above runs every ten minutes, which is fine for a queue nobody is
 * watching and useless the moment someone IS: approve the agreement in the
 * chat, come straight back to the family's record, and the task that sent you
 * there is still sitting in the list. Ten minutes of a coordinator being told
 * to do a thing they just did.
 *
 * So the two readers that show tasks - the family record and the Home queue -
 * verify the handful of rows they are about to render, using the same
 * predicates the sweep uses, and close what is finished before answering. Only
 * SYSTEM tasks: a task somebody typed is theirs to close.
 *
 * Deliberately NOT wired into each act that resolves an artifact. There are a
 * dozen of those - approve, reject, supersede, sign, void, answer, reply - and
 * a rule that has to be remembered at a dozen call sites is a rule that gets
 * missed at the thirteenth. Asking the question at the two places that display
 * the answer cannot be forgotten by code written later.
 *
 * Returns the tasks that are genuinely still open.
 */
export async function reconcileTaskKeys<T extends { id: string; source?: string; systemKey?: string | null }>(
  db: Db, tasks: T[],
): Promise<T[]> {
  // Silence tasks close the moment the family (or the team) touches the
  // thread again - checked here so a coordinator reading the record right
  // after a reply is not told to chase a family that just answered.
  let remaining = await reconcileSilenceTasks(db, tasks);
  // Calendar tasks close the moment the calendar is healthy again.
  remaining = await reconcileCalendarTasks(db, remaining);
  // W-9 / provider-agreement tasks close the moment the document is signed.
  remaining = await reconcileDocSignTasks(db, remaining);
  // Provider-onboarding handoff tasks close the moment their artifact exists.
  remaining = await reconcileOnboardingTasks(db, remaining);

  // Only the queue kinds this file owns - a playbook task has no artifact to
  // reconcile against, and silence was handled above.
  const system = remaining.filter((t) => t.source === "SYSTEM" && t.systemKey && isQueueKey(t.systemKey));
  if (!system.length) return remaining;

  const idsOf = (kind: string) => system
    .filter((t) => t.systemKey!.startsWith(`${kind}:`))
    .map((t) => t.systemKey!.slice(kind.length + 1));

  const [approvalIds, whisperIds, reviewIds, agreementIds] = QUEUE_KINDS.map(idsOf);

  try {
    const [cards, whispers, reviews, agreements] = await Promise.all([
      approvalIds.length
        ? db.aiChatMessage.findMany({ where: { id: { in: approvalIds } }, select: { id: true, uiCardType: true, uiCardData: true } })
        : [],
      whisperIds.length
        ? db.silentQuery.findMany({ where: { id: { in: whisperIds }, ...LIVE_WHERE.whisper }, select: { id: true } })
        : [],
      reviewIds.length
        ? db.providerReview.findMany({ where: { id: { in: reviewIds }, ...LIVE_WHERE.review }, select: { id: true } })
        : [],
      agreementIds.length
        ? db.agreement.findMany({ where: { id: { in: agreementIds }, ...LIVE_WHERE.agreement }, select: { id: true } })
        : [],
    ]);

    const live = new Set<string>([
      ...(cards as any[])
        .filter((c) => isApprovalCardLive(c.uiCardType, c.uiCardData))
        .map((c) => `approval:${c.id}`),
      ...(whispers as any[]).map((w) => `whisper:${w.id}`),
      ...(reviews as any[]).map((r) => `review:${r.id}`),
      ...(agreements as any[]).map((a) => `agreement:${a.id}`),
    ]);

    // An artifact that no longer exists at all (a deleted draft) is not
    // outstanding work either, so anything missing from `live` closes.
    const done = system.filter((t) => !live.has(t.systemKey!));
    const doneIds = done.map((t) => t.id);
    if (!doneIds.length) return remaining;

    await db.parentTask.updateMany({
      where: { id: { in: doneIds }, status: "OPEN" },
      data: { status: "DONE", completedAt: new Date() },
    });

    /**
     * Close it in the name of whoever actually did it.
     *
     * An approval card records who approved or rejected it, so the task it
     * raised should say that person did the work - not the org it fell back to
     * when nobody owned the family. Only the approve/reject paths know a name;
     * an agreement that simply got signed has none to offer, and keeps the one
     * it had.
     */
    const resolvedBy = new Map<string, string>();
    for (const c of cards as any[]) {
      const uid = (c.uiCardData as any)?.resolvedByUserId;
      if (uid) resolvedBy.set(`approval:${c.id}`, uid);
    }
    const toAttribute = done.filter((t) => resolvedBy.has(t.systemKey!));
    if (toAttribute.length) {
      const ids = Array.from(new Set(toAttribute.map((t) => resolvedBy.get(t.systemKey!)!)));
      const people = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
      const nameOf = new Map<string, string>(people.map((u: any) => [u.id, u.name || u.email]));
      await Promise.all(toAttribute.map((t) => {
        const uid = resolvedBy.get(t.systemKey!)!;
        return db.parentTask.update({
          where: { id: t.id },
          data: {
            completedByUserId: uid,
            assigneeUserId: uid,
            assigneeName: nameOf.get(uid) ?? undefined,
          },
        }).catch(() => {});
      }));
    }
    const closed = new Set(doneIds);
    return remaining.filter((t) => !closed.has(t.id));
  } catch (e: any) {
    // A reconcile that fails must not take the page down with it - the worst
    // case is the ten-minute sweep closing it instead, which is where we were.
    console.error(`[tasks] on-demand reconcile failed: ${e?.message}`);
    return remaining;
  }
}

/**
 * Silence tasks (silence:<accountKey>:<line>:<nth>) have no artifact - their
 * "done" is the family or the team touching the thread again. Checked at
 * read time with the cheapest honest signal: any human message on the org's
 * threads after the task was raised. The 10-minute silence sweep is the
 * backstop with the full last-touch definition.
 */
/**
 * W-9 and GoStork provider-agreement tasks (systemKey `w9:<providerId>` /
 * `pagr:<providerId>`) are normally closed by the PandaDoc completion webhook
 * the moment the document is signed. But that webhook is a single delivery to
 * whichever machine PandaDoc has registered - a machine that is asleep, a
 * handler that throws, or a stale Prisma client orphans the OPEN task forever
 * while the document itself already shows COMPLETED. Reconcile at read time:
 * the task is live only while a matching document row exists that is not yet
 * COMPLETED; a signed document (or a deleted row - e.g. a force re-request in
 * flight) closes the task, so the queue never tells a provider to do what
 * they already did.
 */
async function reconcileDocSignTasks<T extends { id: string; source?: string; systemKey?: string | null }>(
  db: Db, tasks: T[],
): Promise<T[]> {
  const docTasks = tasks.filter(
    (t: any) => t.source === "SYSTEM" && (t.systemKey?.startsWith("w9:") || t.systemKey?.startsWith("pagr:")),
  ) as any[];
  if (!docTasks.length) return tasks;
  try {
    const w9ProviderIds = docTasks.filter((t) => t.systemKey.startsWith("w9:")).map((t) => t.systemKey.slice(3));
    const pagrProviderIds = docTasks.filter((t) => t.systemKey.startsWith("pagr:")).map((t) => t.systemKey.slice(5));

    const [openW9s, openPagrs] = await Promise.all([
      w9ProviderIds.length
        ? db.providerW9.findMany({
            where: { providerId: { in: w9ProviderIds }, status: { not: "COMPLETED" } },
            select: { providerId: true },
          })
        : [],
      pagrProviderIds.length
        ? db.providerAgreement.findMany({
            where: { providerId: { in: pagrProviderIds }, status: { not: "COMPLETED" } },
            select: { providerId: true },
          })
        : [],
    ]);
    const live = new Set<string>([
      ...(openW9s as any[]).map((w) => `w9:${w.providerId}`),
      ...(openPagrs as any[]).map((p) => `pagr:${p.providerId}`),
    ]);

    const done = docTasks.filter((t) => !live.has(t.systemKey));
    if (!done.length) return tasks;
    const doneIds = new Set(done.map((t) => t.id));
    await db.parentTask.updateMany({
      where: { id: { in: Array.from(doneIds) }, status: "OPEN" },
      data: { status: "DONE", completedAt: new Date() },
    });
    console.log(`[tasks] Doc-sign reconcile closed ${done.length} task(s): ${done.map((t: any) => t.systemKey).join(", ")}`);
    return tasks.filter((t) => !doneIds.has(t.id));
  } catch (e: any) {
    console.error(`[tasks] Doc-sign reconcile failed: ${e?.message}`);
    return tasks;
  }
}

/**
 * Provider-onboarding handoff tasks (systemKey `onbcal:` / `onbstripe:` /
 * `onbcosts:` / `onbteam:` / `onbplaybooks:` / `onbauto:` - raised by the
 * admin's "Send onboarding tasks" button, provider-onboarding.controller.ts).
 * Each closes the moment its artifact exists, so a provider who connects a
 * calendar is never told to connect a calendar (onbpaybasis: likewise closes
 * once every fee config line has a decided Parent Pays Basis). Close-only,
 * own prefixes only - the manual-complete onboarding tasks (onbprofile:,
 * onbai:, onbbrand:, onbsponsor:) have no artifact and are NOT touched here.
 */
async function reconcileOnboardingTasks<T extends { id: string; source?: string; systemKey?: string | null }>(
  db: Db, tasks: T[],
): Promise<T[]> {
  const CHECKS: Record<string, (providerId: string) => Promise<boolean>> = {
    onbcal: async (pid) => (await db.calendarConnection.count({ where: { connected: true, tokenValid: true, user: { providerId: pid } } })) > 0,
    onbavail: async (pid) => (await db.availabilitySlot.count({ where: { scheduleConfig: { user: { providerId: pid } } } })) > 0,
    onblegal: async (pid) => {
      const li = await db.providerLegalIdentity.findUnique({
        where: { providerId: pid },
        select: { legalName: true, taxId: true, businessAddressLine1: true, businessAddressCity: true },
      });
      return Boolean(li?.legalName && li?.taxId && li?.businessAddressLine1 && li?.businessAddressCity);
    },
    onbstripe: async (pid) => Boolean((await db.providerBankAccount.findUnique({ where: { providerId: pid }, select: { payoutsEnabled: true } }))?.payoutsEnabled),
    onbcosts: async (pid) => (await db.providerCostSheet.count({ where: { providerId: pid } })) > 0,
    // Decided = TOTAL_COST, or DEFAULT_FIRST_PAYMENT with an actual amount
    // (bare DEFAULT_FIRST_PAYMENT is just the column default). All active
    // lines must be decided, and at least one config row must exist.
    onbpaybasis: async (pid) => {
      const cfgs = await db.referralFeeConfig.findMany({
        where: { providerId: pid, isActive: true },
        select: { parentPaysBasis: true, defaultServiceAmount: true },
      });
      return cfgs.length > 0 && cfgs.every((c: any) => c.parentPaysBasis === "TOTAL_COST" || c.defaultServiceAmount != null);
    },
    onbteam: async (pid) => (await db.user.count({ where: { providerId: pid } })) >= 2,
    // Any parent-agreement template (per-service row or the legacy single
    // fields on Provider) closes the upload task; per-line completeness stays
    // visible on the admin checklist.
    onbtemplates: async (pid) => {
      const [rows, p] = await Promise.all([
        db.providerAgreementTemplate.count({ where: { providerId: pid, agreementTemplateUrl: { not: null } } }),
        db.provider.findUnique({ where: { id: pid }, select: { agreementTemplateUrl: true } }),
      ]);
      return rows > 0 || Boolean(p?.agreementTemplateUrl);
    },
    onbplaybooks: async (pid) => (await db.taskPlaybook.count({ where: { providerId: pid } })) > 0,
    onbauto: async (pid) => (await db.providerAutoReply.count({ where: { providerId: pid } })) > 0,
  };
  const onb = tasks.filter((t: any) => {
    if (t.source !== "SYSTEM" || !t.systemKey) return false;
    const prefix = t.systemKey.split(":")[0];
    return Object.prototype.hasOwnProperty.call(CHECKS, prefix);
  }) as any[];
  if (!onb.length) return tasks;
  try {
    const closedIds: string[] = [];
    for (const t of onb) {
      const [prefix, providerId] = String(t.systemKey).split(":");
      if (!providerId) continue;
      if (await CHECKS[prefix](providerId)) closedIds.push(t.id);
    }
    if (!closedIds.length) return tasks;
    await db.parentTask.updateMany({
      where: { id: { in: closedIds }, status: "OPEN" },
      data: { status: "DONE", completedAt: new Date() },
    });
    console.log(`[tasks] onboarding reconcile closed ${closedIds.length} task(s)`);
    const closed = new Set(closedIds);
    return tasks.filter((t) => !closed.has(t.id));
  } catch (e: any) {
    console.error(`[tasks] onboarding reconcile failed: ${e?.message}`);
    return tasks;
  }
}

async function reconcileSilenceTasks<T extends { id: string; source?: string; systemKey?: string | null }>(
  db: Db, tasks: T[],
): Promise<T[]> {
  const silence = tasks.filter(
    (t: any) => t.source === "SYSTEM" && t.systemKey?.startsWith("silence:") && t.providerId,
  ) as any[];
  if (!silence.length) return tasks;
  try {
    const closedIds: string[] = [];
    for (const t of silence) {
      const acct = String(t.systemKey).split(":")[1];
      if (!acct) continue;
      const memberIds = (await db.user.findMany({
        where: { OR: [{ parentAccountId: acct }, { id: acct }] },
        select: { id: true },
      })).map((u: any) => u.id);
      const touched = await db.aiChatMessage.findFirst({
        where: {
          role: "user",
          createdAt: { gt: t.createdAt },
          session: { userId: { in: memberIds }, providerId: t.providerId },
        },
        select: { id: true },
      });
      if (touched) closedIds.push(t.id);
    }
    if (!closedIds.length) return tasks;
    await db.parentTask.updateMany({
      where: { id: { in: closedIds }, status: "OPEN" },
      data: { status: "DONE", completedAt: new Date() },
    });
    const closed = new Set(closedIds);
    return tasks.filter((t) => !closed.has(t.id));
  } catch (e: any) {
    console.error(`[tasks] silence reconcile failed: ${e?.message}`);
    return tasks;
  }
}
