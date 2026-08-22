/**
 * Silence as a first-class signal (CRM Phase 9 §5).
 *
 * A family that simply goes quiet is invisible. Every 10 minutes this sweep
 * computes each engaged family's LAST TOUCH per provider org - the most
 * recent of: a message either direction on any of the family's threads with
 * the org, a meeting that happened, a note or logged call, a completed task,
 * a payment - and compares the quiet against the stage's threshold.
 *
 * The ladder: Eva first, the coordinator second.
 *   1. At the threshold, Eva sends ONE warm check-in in the shared thread
 *      (dual-audience: `content` speaks to the parent in second person,
 *      `uiCardData.providerContent` tells the provider what she did).
 *   2. At the threshold AGAIN with no reply, a SYSTEM task
 *      (systemKey = silence:<accountKey>:<line>:<nth>) lands on the lead
 *      owner, deep-linked to the thread. It closes the moment the family
 *      replies - both here and in the read-time reconcile.
 *
 * SHIPPING STATE: on by default. Eva's parent-facing step runs in SHADOW for
 * each org's first 7 days (SilenceConfig.shadowSince): it records who it
 * WOULD have messaged as a SILENCE_EVA_SHADOW journey event and sends
 * nothing. The coordinator task is live from day one - a task cannot
 * embarrass anyone.
 *
 * Cross-machine safety, exactly as the spec names it: the Eva send is
 * claimed through Notification.dedupeKey (unique - the second machine's
 * insert fails and it walks away), and the task through the unique
 * systemKey.
 *
 * NEVER fires when: the line is handed off or was won by another org, a
 * future booking exists, the family's last word was a churn reason
 * (CHURN_REASON newer than any touch), or an open silence task already sits
 * there.
 */
import { JOURNEY_STAGE_ORDER, journeyStageLabel } from "../shared/journey-ladder";
import { emitJourneyEvent } from "./journey-events";
import { serviceLineOfSubject } from "./journey-timeline";

type Db = any;

const DAY_MS = 86_400_000;
const SHADOW_DAYS = 7;

/** Per-stage "quiet after N days" defaults; null = never (the journey is done). */
export const SILENCE_DEFAULT_THRESHOLDS: Record<string, number | null> = {
  registered: 14,
  exploring: 14,
  consult_scheduled: 7,
  consult_completed: 7,
  ip_form_submitted: 7,
  doctor_call_scheduled: 7,
  doctor_call_completed: 7,
  match_call_scheduled: 5,
  matched: 5,
  invoice_sent: 3,
  invoice_paid: 3,
  agreement_sent: 3,
  agreement_signed: null,
  handed_off: null,
};

const LINE_LABELS: Record<string, string> = {
  surrogacy: "surrogacy",
  egg_donation: "egg donation",
  sperm_donation: "sperm donation",
  ivf: "IVF",
  legal: "legal",
};

const rankOf = (stage: string | null | undefined): number =>
  stage ? (JOURNEY_STAGE_ORDER as readonly string[]).indexOf(stage) : -1;
const WON_RANK = rankOf("invoice_paid");

function checkinCopy(firstName: string | null, line: string, providerName: string): string {
  const lineLabel = LINE_LABELS[line] || "family-building";
  return `Hi${firstName ? ` ${firstName}` : ""}! It's been a little while since we last connected about your ${lineLabel} journey with ${providerName}. Just checking in - how are you feeling about everything? If any questions have come up, or you'd like to pick things back up, I'm right here.`;
}

/** The org-or-defaults resolution for one setting surface. */
export interface SilenceConfigView {
  enabled: boolean;
  evaEnabled: boolean;
  shadowSince: Date | null;
  thresholdFor(stage: string): number | null;
  lineOn(line: string): boolean;
}

export function resolveSilenceConfig(orgRow: any, defaultsRow: any): SilenceConfigView {
  const row = orgRow || defaultsRow || {};
  const defaults = defaultsRow || {};
  return {
    enabled: row.enabled !== false,
    evaEnabled: row.evaEnabled !== false,
    shadowSince: orgRow?.shadowSince ? new Date(orgRow.shadowSince) : null,
    thresholdFor(stage: string): number | null {
      const own = (row.thresholds as any)?.[stage];
      if (own !== undefined) return own === null ? null : Number(own);
      const def = (defaults.thresholds as any)?.[stage];
      if (def !== undefined) return def === null ? null : Number(def);
      const built = SILENCE_DEFAULT_THRESHOLDS[stage];
      return built === undefined ? null : built;
    },
    lineOn(line: string): boolean {
      const own = (row.lineEnabled as any)?.[line];
      if (own !== undefined) return !!own;
      const def = (defaults.lineEnabled as any)?.[line];
      if (def !== undefined) return !!def;
      return true;
    },
  };
}

const key2 = (acct: string, org: string) => `${acct}|${org}`;

export async function runSilenceSweep(db: Db, notifications?: any): Promise<void> {
  try {
    const now = new Date();
    const snapshots = await db.parentStageSnapshot.findMany({
      select: { parentAccountId: true, providerId: true, serviceLine: true, stage: true, reachedAt: true },
    });
    if (!snapshots.length) return;

    const accountKeys = Array.from(new Set(snapshots.map((s: any) => s.parentAccountId))) as string[];
    const orgIds = Array.from(new Set(snapshots.map((s: any) => s.providerId))) as string[];

    // ── Settings: the GoStork defaults row plus each org's own ──────────────
    let defaultsRow = await db.silenceConfig.findUnique({ where: { id: "defaults" } });
    if (!defaultsRow) {
      defaultsRow = await db.silenceConfig
        .create({ data: { id: "defaults", providerId: null, updatedAt: now } })
        .catch(() => db.silenceConfig.findUnique({ where: { id: "defaults" } }));
    }
    const orgRows = await db.silenceConfig.findMany({ where: { providerId: { in: orgIds } } });
    const orgRowOf = new Map<string, any>(orgRows.map((r: any) => [r.providerId, r]));
    // An org's shadow clock starts the first time this sweep SEES it - a
    // create-if-missing row, so "7 days per org" means 7 days from its own
    // go-live rather than one global date.
    for (const orgId of orgIds) {
      if (orgRowOf.has(orgId)) continue;
      const row = await db.silenceConfig
        .create({ data: { providerId: orgId } })
        .catch(() => db.silenceConfig.findUnique({ where: { providerId: orgId } }));
      if (row) orgRowOf.set(orgId, row);
    }

    // ── Membership: account key -> user ids (and back) ──────────────────────
    const members = await db.user.findMany({
      where: { OR: [{ parentAccountId: { in: accountKeys } }, { id: { in: accountKeys } }] },
      select: { id: true, parentAccountId: true, name: true, firstName: true, createdAt: true },
    });
    const acctOfUser = new Map<string, string>();
    const primaryOf = new Map<string, any>();
    for (const u of members) {
      const key = u.parentAccountId || u.id;
      acctOfUser.set(u.id, key);
      const cur = primaryOf.get(key);
      if (!cur || u.createdAt < cur.createdAt) primaryOf.set(key, u);
    }
    const memberIds = members.map((u: any) => u.id);

    // ── Last touch, batched across the whole platform ───────────────────────
    const lastTouch = new Map<string, number>();
    const touch = (acct: string | undefined, org: string | null | undefined, at: Date | string | null | undefined) => {
      if (!acct || !org || !at) return;
      const t = new Date(at).getTime();
      const k = key2(acct, org);
      if (!lastTouch.has(k) || t > lastTouch.get(k)!) lastTouch.set(k, t);
    };

    const sessions = await db.aiChatSession.findMany({
      where: { userId: { in: memberIds }, providerId: { in: orgIds } },
      select: { id: true, userId: true, providerId: true, subjectType: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
    });
    const sessionMeta = new Map<string, any>(sessions.map((s: any) => [s.id, s]));
    const sessionsOfPair = new Map<string, any[]>();
    for (const s of sessions) {
      const k = key2(acctOfUser.get(s.userId)!, s.providerId);
      const list = sessionsOfPair.get(k) || [];
      list.push(s);
      sessionsOfPair.set(k, list);
    }

    // Human messages either direction. role "user" covers both the family and
    // provider staff (senderType "provider"); Eva's own sends are role
    // "assistant" and deliberately NOT a touch - if her check-in reset the
    // clock, the coordinator task could never fire.
    const msgAgg = sessions.length
      ? await db.aiChatMessage.groupBy({
          by: ["sessionId"],
          where: { sessionId: { in: sessions.map((s: any) => s.id) }, role: "user" },
          _max: { createdAt: true },
        })
      : [];
    for (const m of msgAgg as any[]) {
      const s = sessionMeta.get(m.sessionId);
      if (s) touch(acctOfUser.get(s.userId), s.providerId, m._max.createdAt);
    }

    const [meetings, notes, doneTasks, paidInvoices, futureBookings, churns] = await Promise.all([
      db.booking.findMany({
        where: { parentUserId: { in: memberIds }, outcome: { in: ["COMPLETED", "UNVERIFIED"] } },
        select: { parentUserId: true, scheduledAt: true, providerUser: { select: { providerId: true } } },
      }),
      db.parentNote.findMany({
        where: { parentAccountId: { in: accountKeys }, scope: "PROVIDER", providerId: { in: orgIds }, deletedAt: null },
        select: { parentAccountId: true, providerId: true, createdAt: true, occurredAt: true },
      }),
      db.parentTask.findMany({
        where: { parentAccountId: { in: accountKeys }, scope: "PROVIDER", providerId: { in: orgIds }, completedAt: { not: null } },
        select: { parentAccountId: true, providerId: true, completedAt: true },
      }),
      db.invoice.findMany({
        where: { parentUserId: { in: memberIds }, providerId: { in: orgIds }, paidAt: { not: null } },
        select: { parentUserId: true, providerId: true, paidAt: true },
      }),
      db.booking.findMany({
        where: { parentUserId: { in: memberIds }, status: { in: ["PENDING", "CONFIRMED"] }, scheduledAt: { gt: now } },
        select: { parentUserId: true, providerUser: { select: { providerId: true } } },
      }),
      db.journeyEvent.findMany({
        where: { parentAccountId: { in: accountKeys }, providerId: { in: orgIds }, eventType: "CHURN_REASON" },
        select: { parentAccountId: true, providerId: true, createdAt: true },
      }),
    ]);
    for (const b of meetings as any[]) touch(acctOfUser.get(b.parentUserId), b.providerUser?.providerId, b.scheduledAt);
    for (const n of notes as any[]) touch(n.parentAccountId, n.providerId, n.occurredAt || n.createdAt);
    for (const t of doneTasks as any[]) touch(t.parentAccountId, t.providerId, t.completedAt);
    for (const inv of paidInvoices as any[]) touch(acctOfUser.get(inv.parentUserId), inv.providerId, inv.paidAt);

    const hasFutureBooking = new Set<string>();
    for (const b of futureBookings as any[]) {
      const acct = acctOfUser.get(b.parentUserId);
      if (acct && b.providerUser?.providerId) hasFutureBooking.add(key2(acct, b.providerUser.providerId));
    }
    const churnAt = new Map<string, number>();
    for (const c of churns as any[]) {
      const k = key2(c.parentAccountId, c.providerId);
      const t = new Date(c.createdAt).getTime();
      if (!churnAt.has(k) || t > churnAt.get(k)!) churnAt.set(k, t);
    }

    // A family with a stage but no recorded touch anchors on when the stage
    // was reached - the stage itself is proof something happened then.
    {
      const fallback = new Map<string, number>();
      for (const s of snapshots as any[]) {
        const k = key2(s.parentAccountId, s.providerId);
        const t = new Date(s.reachedAt).getTime();
        if (!fallback.has(k) || t > fallback.get(k)!) fallback.set(k, t);
      }
      for (const [k, t] of Array.from(fallback.entries())) {
        if (!lastTouch.has(k)) lastTouch.set(k, t);
      }
    }

    // ── Cache for the "Quiet for" column ────────────────────────────────────
    for (const [k, t] of Array.from(lastTouch.entries())) {
      const [acct, org] = k.split("|");
      await db.silenceState.upsert({
        where: { parentAccountId_providerId: { parentAccountId: acct, providerId: org } },
        create: { parentAccountId: acct, providerId: org, lastTouchAt: new Date(t) },
        update: { lastTouchAt: new Date(t) },
      }).catch(() => {});
    }

    // ── Existing silence machinery state ────────────────────────────────────
    const [checkinEvents, silenceTasks] = await Promise.all([
      db.journeyEvent.findMany({
        where: {
          parentAccountId: { in: accountKeys },
          providerId: { in: orgIds },
          eventType: { in: ["SILENCE_EVA_CHECKIN", "SILENCE_EVA_SHADOW"] },
        },
        select: { parentAccountId: true, providerId: true, eventType: true, metadata: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      db.parentTask.findMany({
        where: { source: "SYSTEM", systemKey: { startsWith: "silence:" } },
        select: { id: true, systemKey: true, status: true, providerId: true, parentAccountId: true, createdAt: true },
      }),
    ]);
    const lastCheckin = new Map<string, Date>();
    for (const ev of checkinEvents as any[]) {
      const line = (ev.metadata as any)?.line || "any";
      lastCheckin.set(`${ev.parentAccountId}|${ev.providerId}|${line}`, new Date(ev.createdAt));
    }
    const openSilenceTask = new Set<string>();
    const silenceKeyCount = new Map<string, number>();
    const staleOpenTasks: { id: string }[] = [];
    for (const t of silenceTasks as any[]) {
      // silence:<accountKey>:<line>:<nth>
      const parts = String(t.systemKey).split(":");
      const acct = parts[1], line = parts[2];
      const prefix = `${acct}|${line}`;
      silenceKeyCount.set(prefix, (silenceKeyCount.get(prefix) || 0) + 1);
      if (t.status === "OPEN") {
        const lt = t.providerId ? lastTouch.get(key2(acct, t.providerId)) : undefined;
        if (lt && lt > new Date(t.createdAt).getTime()) {
          // The family (or the team) touched the thread after the task was
          // raised - the silence ended, so the task closes itself.
          staleOpenTasks.push({ id: t.id });
        } else {
          openSilenceTask.add(prefix);
        }
      }
    }
    if (staleOpenTasks.length) {
      await db.parentTask.updateMany({
        where: { id: { in: staleOpenTasks.map((t) => t.id) }, status: "OPEN" },
        data: { status: "DONE", completedAt: now },
      });
    }

    // Which orgs already won each (account x line) - silence at the LOSING
    // orgs is an answer, not a signal, and must never be chased.
    const wonBy = new Map<string, string>();
    for (const s of snapshots as any[]) {
      if (rankOf(s.stage) >= WON_RANK) wonBy.set(`${s.parentAccountId}|${s.serviceLine}`, s.providerId);
    }

    const providerNames = new Map<string, string>(
      (await db.provider.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }))
        .map((p: any) => [p.id, p.name]),
    );
    // Per-line owners: the silence task lands on whoever owns THAT line of
    // the family's journey, falling back to the org-wide owner row.
    const { ownerForLine } = await import("./parent-crm");
    const owners = await db.parentOwner.findMany({
      where: { parentAccountId: { in: accountKeys }, scope: "PROVIDER", providerId: { in: orgIds } },
      select: { parentAccountId: true, providerId: true, serviceLine: true, ownerUserId: true, ownerName: true },
    });
    const ownerRowsOf = new Map<string, any[]>();
    for (const o of owners as any[]) {
      const k = key2(o.parentAccountId, o.providerId);
      const list = ownerRowsOf.get(k) || [];
      list.push(o);
      ownerRowsOf.set(k, list);
    }
    const ownerOf = (pairKey: string, line: string | null): any =>
      ownerForLine(ownerRowsOf.get(pairKey) || [], line);

    let sent = 0, shadowed = 0, raised = 0;

    // ── The ladder, per (family x org x line) ───────────────────────────────
    for (const snap of snapshots as any[]) {
      const acct = snap.parentAccountId, org = snap.providerId, line = snap.serviceLine;
      const pairKey = key2(acct, org);
      const cfg = resolveSilenceConfig(orgRowOf.get(org), defaultsRow);
      if (!cfg.enabled || !cfg.lineOn(line)) continue;
      const threshold = cfg.thresholdFor(snap.stage);
      if (threshold === null || !Number.isFinite(threshold)) continue;

      // Never-fire guards.
      const winner = wonBy.get(`${acct}|${line}`);
      if (winner && winner !== org) continue;               // matched elsewhere
      if (rankOf(snap.stage) >= rankOf("handed_off")) continue;
      if (hasFutureBooking.has(pairKey)) continue;          // a call is coming
      const lt = lastTouch.get(pairKey);
      if (!lt) continue;
      if ((churnAt.get(pairKey) || 0) >= lt) continue;      // their last word was "no thanks"
      if (openSilenceTask.has(`${acct}|${line}`)) continue; // already on someone's desk

      const quietMs = now.getTime() - lt;
      if (quietMs < threshold * DAY_MS) continue;
      const quietDays = Math.floor(quietMs / DAY_MS);

      const primary = primaryOf.get(acct);
      const familyName = primary?.name || primary?.firstName || "the family";
      const providerName = providerNames.get(org) || "your provider";

      const checkin = lastCheckin.get(`${acct}|${org}|${line}`);
      const checkinLive = checkin && checkin.getTime() > lt;

      if (!checkinLive) {
        // Step 1: Eva's warm check-in (or its shadow) - once per episode.
        if (!cfg.evaEnabled || !primary) continue;
        const inShadow = !cfg.shadowSince || now.getTime() - cfg.shadowSince.getTime() < SHADOW_DAYS * DAY_MS;
        const content = checkinCopy(primary.firstName || null, line, providerName);
        // Atomic cross-machine claim, exactly as the duplicate-notification
        // guard prescribes: unique dedupeKey, second insert loses.
        try {
          await db.notification.create({
            data: {
              userId: primary.id,
              type: inShadow ? "SILENCE_EVA_SHADOW" : "SILENCE_EVA_CHECKIN",
              channel: "chat",
              recipient: "chat",
              status: "sent",
              sentAt: now,
              bodyText: content,
              dedupeKey: `silence-eva:${acct}:${org}:${line}:${lt}`,
            },
          });
        } catch (e: any) {
          if (e?.code === "P2002") continue; // the other machine owns this send
          throw e;
        }

        if (inShadow) {
          await emitJourneyEvent({
            eventType: "SILENCE_EVA_SHADOW",
            parentAccountId: acct,
            providerId: org,
            metadata: { line, quietDays, content },
          });
          shadowed++;
        } else {
          // The SHARED thread with this org, preferring the line's own; the
          // provider reads providerContent, the family reads content - the
          // dual-audience house rule.
          const pairSessions = sessionsOfPair.get(pairKey) || [];
          const session = pairSessions.find((s: any) => serviceLineOfSubject(s.subjectType) === line) || pairSessions[0];
          if (!session) continue;
          await db.aiChatMessage.create({
            data: {
              sessionId: session.id,
              role: "assistant",
              content,
              senderType: "ai",
              uiCardData: {
                providerContent: `Eva checked in with ${familyName} after ${quietDays} days of quiet on ${LINE_LABELS[line] || line}.`,
                silenceCheckin: { line, quietDays, providerId: org },
              },
            },
          });
          await db.aiChatSession.update({ where: { id: session.id }, data: { updatedAt: now } }).catch(() => {});
          await emitJourneyEvent({
            eventType: "SILENCE_EVA_CHECKIN",
            parentAccountId: acct,
            providerId: org,
            sessionId: session.id,
            metadata: { line, quietDays, content },
          });
          sent++;
        }
        continue;
      }

      // Step 2: the threshold again after the check-in, still nothing.
      if (now.getTime() - checkin!.getTime() < threshold * DAY_MS) continue;

      const nth = (silenceKeyCount.get(`${acct}|${line}`) || 0) + 1;
      const owner = ownerOf(pairKey, line);
      const pairSessions = sessionsOfPair.get(pairKey) || [];
      const session = pairSessions.find((s: any) => serviceLineOfSubject(s.subjectType) === line) || pairSessions[0];
      const sinceStr = new Date(lt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      try {
        await db.parentTask.create({
          data: {
            parentAccountId: acct,
            scope: "PROVIDER",
            providerId: org,
            title: `No reply from ${familyName} since ${sinceStr}`,
            type: "CALL",
            priority: "MEDIUM",
            dueAt: now,
            serviceLine: line,
            source: "SYSTEM",
            systemKey: `silence:${acct}:${line}:${nth}`,
            deepLink: primary && session ? `/chat/${primary.id}/${session.id}` : (primary ? `/parents/${primary.id}` : null),
            chatSessionId: session?.id ?? null,
            assigneeUserId: owner?.ownerUserId ?? null,
            assigneeName: owner?.ownerName ?? providerName,
            createdByUserId: "system",
          },
        });
        raised++;
      } catch (e: any) {
        if (e?.code !== "P2002") throw e; // the other machine, same tick
      }
    }

    if (sent || shadowed || raised || staleOpenTasks.length) {
      console.log(`[silence] check-ins ${sent}, shadowed ${shadowed}, tasks raised ${raised}, auto-closed ${staleOpenTasks.length}`);
    }
  } catch (e: any) {
    console.error(`[silence] sweep failed: ${e?.message}`);
  }
}
