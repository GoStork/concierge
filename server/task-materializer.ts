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

    // Lead owners decide assignment. Every task ends up with a NAME on it:
    // there is no such thing as work nobody is waiting on, and "Unassigned"
    // is a queue nobody reads.
    const accountIds = Array.from(new Set(items.map((i) => i.parentAccountId)));
    const owners = accountIds.length
      ? await db.parentOwner.findMany({
          where: { parentAccountId: { in: accountIds }, scope: "PROVIDER" },
          select: { parentAccountId: true, providerId: true, ownerUserId: true, ownerName: true },
        })
      : [];
    const ownerOf = new Map<string, { id: string; name: string | null }>(
      owners.map((o: any) => [`${o.parentAccountId}|${o.providerId}`, { id: o.ownerUserId, name: o.ownerName }]),
    );

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
      const owner = ownerOf.get(`${item.parentAccountId}|${item.providerId}`);
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
  // Only the queue kinds this file owns - a playbook or silence task is not
  // this reconciler's to close (silence has its own read-time reconcile).
  const system = tasks.filter((t) => t.source === "SYSTEM" && t.systemKey && isQueueKey(t.systemKey));
  if (!system.length) return tasks;

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
    if (!doneIds.length) return tasks;

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
    return tasks.filter((t) => !closed.has(t.id));
  } catch (e: any) {
    // A reconcile that fails must not take the page down with it - the worst
    // case is the ten-minute sweep closing it instead, which is where we were.
    console.error(`[tasks] on-demand reconcile failed: ${e?.message}`);
    return tasks;
  }
}
