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
  providerId: string;
  parentAccountId: string;
  title: string;
  deepLink: string | null;
  kind: QueueKind;
  /** When the work appeared, so an old item is visibly old. */
  since: Date;
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
        session: { select: { id: true, providerId: true, userId: true } },
      },
    }),
    db.silentQuery.findMany({
      where: { status: "PENDING" },
      select: { id: true, providerId: true, createdAt: true, session: { select: { userId: true } } },
    }),
    // PUBLISHED only: a review still in moderation is not the provider's to
    // answer yet, and providerReply is the field that says they have.
    db.providerReview.findMany({
      where: { providerReply: null, visibility: "PUBLIC", status: "PUBLISHED" },
      select: { id: true, providerId: true, parentAccountId: true, createdAt: true },
    }),
    db.agreement.findMany({
      where: { status: "SENT", supersededAt: null },
      select: { id: true, providerId: true, parentUserId: true, documentType: true, createdAt: true },
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

  for (const c of approvalCards as any[]) {
    const pid = c.session?.providerId;
    const uid = c.session?.userId;
    if (!pid || !uid) continue;
    const data = (c.uiCardData as any) || {};
    // Same resolved test the queue endpoint uses: a readiness prompt is done
    // when it has been answered, everything else when it has been resolved.
    const resolved = c.uiCardType === "provider_readiness_prompt" ? !!data.answered : !!data.resolvedAt;
    if (resolved) continue;
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
      kind: "agreement",
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

    // Lead owners decide assignment. Falling back to unassigned is deliberate:
    // a task nobody owns is still visible to the whole org, whereas guessing
    // an assignee would put work in someone's queue that was never theirs.
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
            // Due when it appeared, not a day out: this work was already
            // waiting before anyone raised a task for it, and dating it
            // forward would hide how long it has been sitting.
            dueAt: item.since,
            source: "SYSTEM",
            systemKey: item.systemKey,
            deepLink: item.deepLink,
            assigneeUserId: owner?.id ?? null,
            assigneeName: owner?.name ?? null,
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
    // deleted, so the record still shows the work happened.
    const openSystem = await db.parentTask.findMany({
      where: { source: "SYSTEM", status: "OPEN" },
      select: { id: true, systemKey: true },
    });
    const stale = openSystem.filter((t: any) => t.systemKey && !liveKeys.has(t.systemKey)).map((t: any) => t.id);
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
