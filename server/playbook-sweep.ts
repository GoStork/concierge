/**
 * Stage playbooks (CRM Phase 9 §3): when a family reaches a stage, raise the
 * steps that always follow.
 *
 * Runs in the existing 10-minute sweep, beside the task materializer. The
 * derived journey stage per (family x provider org x service line) comes from
 * buildJourneyTimelines - the same derivation every other surface reads, so
 * the sweep can never disagree with the record page about where a family is.
 *
 * "Newly reached" is a comparison against ParentStageSnapshot, the last stage
 * this sweep saw for that (family x org x line). Two guards keep the write
 * path honest:
 *
 *   - The unique systemKey `playbook:<stepId>:<accountKey>:<line>` makes each
 *     step once-only across both machines AND makes dismissal permanent -
 *     exactly the work-queue tasks' behaviour. Stage regression never
 *     re-raises: the key already exists.
 *   - A recency window: a rung is only fired on when it was reached in the
 *     last RECENT_WINDOW_MS. Without it, the FIRST pass after deploy (or
 *     after an org writes its first playbook) would read every family's
 *     months-old history as "newly reached" and bury the team in backdated
 *     tasks. Families past the trigger before a playbook existed are what the
 *     bulk "Apply a playbook" action is for.
 */
import { JOURNEY_STAGE_ORDER } from "../shared/journey-ladder";
import { buildJourneyTimelines } from "./journey-timeline";

type Db = any;

const RECENT_WINDOW_MS = 72 * 3_600_000;
const FALLBACK_TZ = "America/New_York";

const rankOf = (stage: string | null | undefined): number =>
  stage ? (JOURNEY_STAGE_ORDER as readonly string[]).indexOf(stage) : -1;

/** Wall-clock milliseconds of `d` as read in `tz` (Date.UTC of its parts). */
function wallClockMs(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") === 24 ? 0 : get("hour"), get("minute"), get("second"));
}

/**
 * The instant that is `hhmm` on `day`'s calendar date IN `tz`. "09:00" means
 * nine in the assignee's own morning, not the server's.
 */
export function atTimeInTz(day: Date, hhmm: string, tz: string): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(day);
  const [h, m] = hhmm.split(":").map((n) => Number(n));
  const guess = new Date(`${ymd}T${String(h || 0).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}:00Z`);
  if (Number.isNaN(guess.getTime())) return day;
  // Correct the guess by the zone's offset at that instant. A DST boundary
  // can land this an hour off, which is fine for a task due date.
  return new Date(guess.getTime() - (wallClockMs(guess, tz) - guess.getTime()));
}

export interface PlaybookLike {
  id: string;
  providerId: string | null;
  serviceLine: string | null;
  triggerStage: string;
  steps: Array<{
    id: string;
    title: string;
    notes: string | null;
    type: string;
    priority: string;
    dueOffsetDays: number;
    dueTime: string | null;
    reminderMinutesBefore: number | null;
  }>;
}

/**
 * Raise every step of `playbook` for one family on one line. Shared verbatim
 * between the sweep and the bulk "Apply a playbook" action so the two can
 * never drift on assignment, due dates or keys. Returns how many rows were
 * actually created (existing keys are the correct outcome, not an error).
 */
export async function firePlaybookForFamily(db: Db, playbook: PlaybookLike, opts: {
  accountKey: string;
  /** The line the firing journey is on (used in the systemKey + task lane). */
  serviceLine: string | null;
  /** When the trigger stage was reached - offsets anchor here. */
  stageReachedAt: Date;
  /** Recorded on the task rows this playbook raises. */
  createdByUserId?: string;
}): Promise<number> {
  const scope = playbook.providerId ? "PROVIDER" : "GOSTORK";
  const line = playbook.serviceLine || opts.serviceLine || null;

  // Assignment: the family's lead owner; with no owner, the org's own name,
  // visible to the whole team - same rule as the work-queue materializer.
  const owner = await db.parentOwner.findFirst({
    where: playbook.providerId
      ? { parentAccountId: opts.accountKey, scope: "PROVIDER", providerId: playbook.providerId }
      : { parentAccountId: opts.accountKey, scope: "GOSTORK" },
    select: { ownerUserId: true, ownerName: true },
  });
  let fallbackName = "GoStork";
  if (playbook.providerId) {
    const prov = await db.provider.findUnique({ where: { id: playbook.providerId }, select: { name: true } });
    fallbackName = prov?.name || "the team";
  }
  // "09:00" is nine o'clock in the ASSIGNEE'S morning - their calendar config
  // already knows their timezone.
  let tz = FALLBACK_TZ;
  if (owner?.ownerUserId) {
    const cfg = await db.scheduleConfig.findFirst({
      where: { userId: owner.ownerUserId }, select: { timezone: true },
    }).catch(() => null);
    tz = cfg?.timezone || FALLBACK_TZ;
  }

  // The record page routes by parent USER id, so the deep link needs one.
  const member = await db.user.findFirst({
    where: { OR: [{ parentAccountId: opts.accountKey }, { id: opts.accountKey }] },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  let raised = 0;
  for (const step of playbook.steps) {
    const day = new Date(opts.stageReachedAt.getTime() + (step.dueOffsetDays || 0) * 86_400_000);
    const dueAt = step.dueTime ? atTimeInTz(day, step.dueTime, tz) : day;
    try {
      await db.parentTask.create({
        data: {
          parentAccountId: opts.accountKey,
          scope,
          providerId: playbook.providerId,
          title: step.title,
          notes: step.notes || null,
          type: step.type || "TODO",
          priority: step.priority || "NONE",
          dueAt,
          reminderMinutesBefore: step.reminderMinutesBefore ?? null,
          serviceLine: line,
          source: "SYSTEM",
          systemKey: `playbook:${step.id}:${opts.accountKey}:${line || "any"}`,
          deepLink: member ? `/parents/${member.id}?sec=crm` : null,
          assigneeUserId: owner?.ownerUserId ?? null,
          assigneeName: owner?.ownerName ?? fallbackName,
          createdByUserId: opts.createdByUserId || "system",
        },
      });
      raised++;
    } catch (e: any) {
      // P2002 = already fired (the other machine, a previous pass, or a
      // dismissal). All are the designed outcome.
      if (e?.code !== "P2002") throw e;
    }
  }
  return raised;
}

/**
 * The sweep: compare every engaged family's derived stage per (org x line)
 * with the last snapshot, fire playbooks on newly-reached trigger stages,
 * and move the snapshot forward. Idempotent by construction.
 */
export async function runPlaybookSweep(db: Db): Promise<void> {
  try {
    const playbooks: PlaybookLike[] = await db.taskPlaybook.findMany({
      where: { isActive: true, isStarter: false },
      include: { steps: { orderBy: { sortOrder: "asc" } } },
    });
    // Snapshots are maintained even with ZERO playbooks authored: the silence
    // sweep reads ParentStageSnapshot for each family's stage per line, so
    // this table is platform state, not playbook bookkeeping. The recency
    // window keeps a newly-authored playbook from firing on old history.

    // Every family engaged with a provider org. Bot accounts never open a
    // provider thread, so this set stays the size of the real customer base.
    const sessions = await db.aiChatSession.findMany({
      where: { providerId: { not: null } },
      select: { userId: true },
      distinct: ["userId"],
    });
    const userIds = Array.from(new Set(sessions.map((s: any) => s.userId).filter(Boolean))) as string[];
    if (userIds.length === 0) return;
    const users = await db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, parentAccountId: true },
    });
    const accountKeys = Array.from(new Set(users.map((u: any) => u.parentAccountId || u.id))) as string[];

    const now = Date.now();
    let fired = 0;

    // Small batches: each account costs ~6 queries inside the timeline
    // builder, and the sweep shares the pool with live traffic.
    const CONCURRENCY = 5;
    for (let i = 0; i < accountKeys.length; i += CONCURRENCY) {
      await Promise.all(accountKeys.slice(i, i + CONCURRENCY).map(async (accountKey) => {
        let journeys;
        try {
          ({ journeys } = await buildJourneyTimelines(accountKey));
        } catch (e: any) {
          console.error(`[playbooks] timeline failed for ${accountKey}: ${e?.message}`);
          return;
        }
        if (!journeys.length) return;

        const snapshots = await db.parentStageSnapshot.findMany({
          where: { parentAccountId: accountKey },
          select: { providerId: true, serviceLine: true, stage: true },
        });
        const snapOf = new Map<string, string>(
          snapshots.map((s: any) => [`${s.providerId}|${s.serviceLine}`, s.stage]),
        );

        for (const j of journeys) {
          if (!j.providerId || !j.serviceLine) continue;
          // The highest MAIN-ladder rung with evidence. Branch rungs (No
          // Show, Matched Elsewhere) and bank-only rungs are not trigger
          // stages and never move the snapshot.
          let stage: string | null = null;
          let reachedAtOf = new Map<string, Date>();
          for (const s of j.stages) {
            if (s.state !== "done" && s.state !== "current") continue;
            if (rankOf(s.id) < 0) continue;
            if (s.reachedAt) reachedAtOf.set(s.id, new Date(s.reachedAt));
            if (rankOf(s.id) > rankOf(stage)) stage = s.id;
          }
          if (!stage) continue;

          const prevRank = rankOf(snapOf.get(`${j.providerId}|${j.serviceLine}`));
          const newRank = rankOf(stage);
          if (newRank <= prevRank) continue;

          // Fire every playbook whose trigger was CROSSED by this advance -
          // a family that jumps from consult straight to invoice_paid still
          // "reached" matched on the way through.
          for (const pb of playbooks) {
            if (pb.providerId && pb.providerId !== j.providerId) continue;
            if (pb.serviceLine && pb.serviceLine !== j.serviceLine) continue;
            const trigRank = rankOf(pb.triggerStage);
            if (trigRank <= prevRank || trigRank > newRank) continue;
            const reachedAt = reachedAtOf.get(pb.triggerStage)
              || reachedAtOf.get(stage)
              || new Date();
            // Old history is not news. Bulk-apply covers pre-existing families.
            if (now - reachedAt.getTime() > RECENT_WINDOW_MS) continue;
            fired += await firePlaybookForFamily(db, pb, {
              accountKey,
              serviceLine: j.serviceLine,
              stageReachedAt: reachedAt,
            });
          }

          const reachedAt = reachedAtOf.get(stage) || new Date();
          await db.parentStageSnapshot.upsert({
            where: {
              parentAccountId_providerId_serviceLine: {
                parentAccountId: accountKey, providerId: j.providerId, serviceLine: j.serviceLine,
              },
            },
            create: {
              parentAccountId: accountKey, providerId: j.providerId, serviceLine: j.serviceLine,
              stage, reachedAt,
            },
            update: { stage, reachedAt },
          }).catch((e: any) => {
            // The other machine upserting the same key on the same tick.
            if (e?.code !== "P2002") throw e;
          });
        }
      }));
    }

    if (fired) console.log(`[playbooks] Raised ${fired} playbook task(s)`);
  } catch (e: any) {
    console.error(`[playbooks] sweep failed: ${e?.message}`);
  }
}
