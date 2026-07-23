/**
 * Phase 7C: journey funnel analytics.
 *
 * Aggregates the SAME derived journeys the timeline shows (one
 * buildJourneyTimelines call per parent account - guaranteed consistent
 * with every sidebar/Home view) into:
 *   - per-journey-type stage funnels (count, conversion %, median days)
 *   - leak analysis (no-shows by side, canceled-not-rebooked, churn reasons)
 *   - win-back performance (sent -> responses -> re-engaged)
 *   - a per-provider comparison table
 *   - headline KPIs
 *
 * Deliberately deriver-based (user decision): correctness and consistency
 * over raw speed. A 5-minute in-memory cache absorbs dashboard traffic;
 * when account volume makes this hurt, the optimization is a bulk evidence
 * loader - not a second source of stage truth.
 */
import { prisma } from "./db";
import { buildJourneyTimelines, JourneyOut } from "./journey-timeline";

export interface FunnelFilters {
  providerId?: string | null;
  journeyType?: string | null;
  from?: Date | null;
  to?: Date | null;
  // True when the CALLER is a provider user (not an admin drilling into a
  // provider): platform-wide numbers (total registered parents) are hidden
  // and the funnel starts at Exploring Profiles - a provider only ever sees
  // parents who engaged THEM.
  providerScope?: boolean;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; data: any }>();

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function buildJourneyFunnel(filters: FunnelFilters): Promise<any> {
  const key = JSON.stringify({
    p: filters.providerId || null,
    t: filters.journeyType || null,
    f: filters.from?.toISOString() || null,
    o: filters.to?.toISOString() || null,
    s: !!filters.providerScope,
  });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  // ---- Cohort: parent accounts by registration date ----
  const parentUsers = await prisma.user.findMany({
    where: {
      roles: { has: "PARENT" },
      ...(filters.from || filters.to
        ? { createdAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
        : {}),
    },
    select: { id: true, parentAccountId: true },
  });
  const accountIds = Array.from(new Set(parentUsers.map((u) => u.parentAccountId || u.id)));

  // ---- Derive journeys per account (bounded concurrency) ----
  const journeys: (JourneyOut & { accountId: string })[] = [];
  const CHUNK = 8;
  for (let i = 0; i < accountIds.length; i += CHUNK) {
    const chunk = accountIds.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async (a) => {
        try {
          const r = await buildJourneyTimelines(a, { providerId: filters.providerId || null });
          return r.journeys.map((j) => ({ ...j, accountId: a }));
        } catch {
          return [] as (JourneyOut & { accountId: string })[];
        }
      }),
    );
    for (const arr of results) journeys.push(...arr);
  }
  const filteredJourneys = filters.journeyType
    ? journeys.filter((j) => j.journeyType === filters.journeyType)
    : journeys;

  // ---- Stage funnels per journey type ----
  const byType = new Map<string, (JourneyOut & { accountId: string })[]>();
  for (const j of filteredJourneys) {
    const list = byType.get(j.journeyType) || [];
    list.push(j);
    byType.set(j.journeyType, list);
  }

  const funnels = Array.from(byType.entries()).map(([journeyType, list]) => {
    // Stage order comes from the journeys themselves (they all share the
    // type's ladder; use the longest stage list seen so optional rungs that
    // were dropped on some journeys still appear).
    const template = list.reduce((best, j) => (j.stages.length > best.stages.length ? j : best), list[0]);
    const stageIds = template.stages
      .filter((s) => !["no_show", "match_call_no_show", "not_matched"].includes(s.id))
      .filter((s) => !(filters.providerScope && s.id === "registered"))
      .map((s) => ({ id: s.id, label: s.label }));
    let prevCount: number | null = null;
    const stages = stageIds.map((st, idx) => {
      const reached = list.filter((j) => j.stages.find((s) => s.id === st.id)?.reachedAt);
      // Days from the PREVIOUS reached rung on the same journey.
      const dayDiffs: number[] = [];
      if (idx > 0) {
        const prevId = stageIds[idx - 1].id;
        for (const j of reached) {
          const cur = j.stages.find((s) => s.id === st.id)?.reachedAt;
          const prev = j.stages.find((s) => s.id === prevId)?.reachedAt;
          if (cur && prev) dayDiffs.push(Math.max(0, (new Date(cur).getTime() - new Date(prev).getTime()) / DAY_MS));
        }
      }
      const row = {
        id: st.id,
        label: st.label,
        count: reached.length,
        conversionFromPrev: prevCount && prevCount > 0 ? Math.round((reached.length / prevCount) * 100) : null,
        medianDaysFromPrev: idx > 0 ? median(dayDiffs) : null,
      };
      prevCount = reached.length;
      return row;
    });
    return { journeyType, typeLabel: list[0].typeLabel, journeys: list.length, stages };
  });
  funnels.sort((a, z) => z.journeys - a.journeys);

  // ---- Event-based analytics (leaks, win-back), scoped to the cohort ----
  const eventWhere: any = { ...(filters.providerId ? { providerId: filters.providerId } : {}) };
  const cohortFiltered = filters.from || filters.to;
  const events: { eventType: string; actorRole: string | null; metadata: any; providerId: string | null; parentAccountId: string }[] = [];
  if (accountIds.length > 0) {
    for (let i = 0; i < accountIds.length; i += 500) {
      const chunk = accountIds.slice(i, i + 500);
      const rows = await prisma.journeyEvent.findMany({
        where: { ...eventWhere, ...(cohortFiltered || filters.providerId ? { parentAccountId: { in: chunk } } : { parentAccountId: { in: chunk } }) },
        select: { eventType: true, actorRole: true, metadata: true, providerId: true, parentAccountId: true, createdAt: true },
      });
      events.push(...rows);
    }
  }
  const count = (pred: (e: any) => boolean) => events.filter(pred).length;
  const scheduledCount = funnels.reduce((sum, f) => sum + (f.stages.find((s: any) => s.id === "consult_scheduled")?.count || 0), 0);
  const noShowParent = count((e) => e.eventType.endsWith("_NO_SHOW_PARENT") || e.eventType.endsWith("_NO_SHOW_BOTH"));
  const noShowProvider = count((e) => e.eventType.endsWith("_NO_SHOW_PROVIDER"));
  const canceledNotRebooked = count((e) => e.eventType === "CANCELED_NOT_REBOOKED");
  const churnReasons: Record<string, number> = {};
  for (const e of events) {
    if (e.eventType === "CHURN_REASON") {
      const r = (e.metadata as any)?.reason || "unknown";
      churnReasons[r] = (churnReasons[r] || 0) + 1;
    }
  }
  const winbackSent = count((e) => e.eventType === "WINBACK_SENT");
  const winbackResponses: Record<string, number> = {};
  for (const e of events) {
    if (e.eventType === "WINBACK_RESPONSE") {
      const r = (e.metadata as any)?.response || "other";
      winbackResponses[r] = (winbackResponses[r] || 0) + 1;
    }
  }
  const reengaged = count((e) => e.eventType === "REENGAGED");

  // ---- Per-provider comparison table ----
  const byProvider = new Map<string, (JourneyOut & { accountId: string })[]>();
  for (const j of filteredJourneys) {
    const list = byProvider.get(j.providerId) || [];
    list.push(j);
    byProvider.set(j.providerId, list);
  }
  const providers = Array.from(byProvider.entries()).map(([providerId, list]) => {
    const reachedCount = (id: string) => list.filter((j) => j.stages.find((s) => s.id === id)?.reachedAt).length;
    const handoffDays: number[] = [];
    for (const j of list) {
      const sched = j.stages.find((s) => s.id === "consult_scheduled")?.reachedAt;
      const done = j.stages.find((s) => s.id === "handed_off")?.reachedAt;
      if (sched && done) handoffDays.push((new Date(done).getTime() - new Date(sched).getTime()) / DAY_MS);
    }
    const provEvents = events.filter((e) => e.providerId === providerId);
    return {
      providerId,
      providerName: list[0].providerName,
      journeyTypes: Array.from(new Set(list.map((j) => j.typeLabel))),
      journeys: list.length,
      consultScheduled: reachedCount("consult_scheduled"),
      consultCompleted: reachedCount("consult_completed"),
      noShowsParent: provEvents.filter((e) => e.eventType.endsWith("_NO_SHOW_PARENT") || e.eventType.endsWith("_NO_SHOW_BOTH")).length,
      noShowsProvider: provEvents.filter((e) => e.eventType.endsWith("_NO_SHOW_PROVIDER")).length,
      matched: reachedCount("matched"),
      invoicePaid: reachedCount("invoice_paid"),
      agreementSigned: reachedCount("agreement_signed"),
      handedOff: reachedCount("handed_off"),
      medianDaysToHandoff: median(handoffDays) !== null ? Math.round(median(handoffDays)!) : null,
    };
  });
  providers.sort((a, z) => z.journeys - a.journeys);

  // ---- Drill-down details: WHO is behind each leak number ----
  // Providers use these lists to act (rebook, reach out); each row links to
  // the parent. Names resolve via the account's first member.
  const detailAccountIds = Array.from(new Set(
    events
      .filter((e) => ["CANCELED_NOT_REBOOKED", "CHURN_REASON", "WINBACK_SENT", "WINBACK_RESPONSE", "REENGAGED"].includes(e.eventType) || e.eventType.includes("_NO_SHOW_"))
      .map((e) => e.parentAccountId),
  ));
  const nameByAccount = new Map<string, { name: string; userId: string }>();
  if (detailAccountIds.length > 0) {
    const members = await prisma.user.findMany({
      where: { OR: [{ parentAccountId: { in: detailAccountIds } }, { id: { in: detailAccountIds } }] },
      select: { id: true, name: true, firstName: true, parentAccountId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    for (const m of members) {
      const acct = m.parentAccountId || m.id;
      if (!nameByAccount.has(acct)) nameByAccount.set(acct, { name: m.name || m.firstName || "Parent", userId: m.id });
    }
  }
  const providerNameById = new Map<string, string>();
  for (const [pid, list] of byProvider.entries()) providerNameById.set(pid, list[0].providerName);
  const detailRow = (e: (typeof events)[number], extra?: Record<string, unknown>) => ({
    parentUserId: nameByAccount.get(e.parentAccountId)?.userId || null,
    parentName: nameByAccount.get(e.parentAccountId)?.name || "Parent",
    providerName: (e.providerId && providerNameById.get(e.providerId)) || null,
    at: (e as any).createdAt,
    ...(extra || {}),
  });
  const byNewest = (a: any, z: any) => new Date(z.at).getTime() - new Date(a.at).getTime();
  const noShowDetails = events
    .filter((e) => e.eventType.endsWith("_NO_SHOW_PARENT") || e.eventType.endsWith("_NO_SHOW_BOTH"))
    .map((e) => detailRow(e)).sort(byNewest).slice(0, 25);
  const notRebookedDetails = events
    .filter((e) => e.eventType === "CANCELED_NOT_REBOOKED")
    .map((e) => detailRow(e)).sort(byNewest).slice(0, 25);
  const churnedDetails = events
    .filter((e) => e.eventType === "CHURN_REASON")
    .map((e) => detailRow(e, { reason: (e.metadata as any)?.reason || "unknown" })).sort(byNewest).slice(0, 25);
  // Win-back follow-ups that never got any reply or rebook.
  const respondedAccounts = new Set(
    events.filter((e) => ["WINBACK_RESPONSE", "REENGAGED", "CHURN_REASON"].includes(e.eventType)).map((e) => `${e.parentAccountId}:${e.providerId || ""}`),
  );
  const awaitingReplyDetails = events
    .filter((e) => e.eventType === "WINBACK_SENT" && !respondedAccounts.has(`${e.parentAccountId}:${e.providerId || ""}`))
    .map((e) => detailRow(e)).sort(byNewest).slice(0, 25);

  // ---- KPIs ----
  const handedOffJourneys = filteredJourneys.filter((j) => j.stages.find((s) => s.id === "handed_off")?.reachedAt);
  const handedOff30d = handedOffJourneys.filter((j) => {
    const at = j.stages.find((s) => s.id === "handed_off")?.reachedAt;
    return at && Date.now() - new Date(at).getTime() <= 30 * DAY_MS;
  }).length;
  const dormant = filteredJourneys.filter((j) => j.attention?.kind === "dormant").length;
  const accountsWithJourney = new Set(filteredJourneys.map((j) => j.accountId)).size;

  // Journey-type options for the dashboard dropdown: a provider only sees
  // the types their APPROVED services can produce; admin (no provider
  // scope) sees all.
  const ALL_TYPES = ["surrogacy", "egg_donation", "ivf", "bank", "legal"];
  let availableTypes = ALL_TYPES;
  if (filters.providerId) {
    const prov = await prisma.provider.findUnique({
      where: { id: filters.providerId },
      select: { services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } } },
    });
    const t = new Set<string>();
    for (const sv of prov?.services || []) {
      const n = (sv.providerType?.name || "").toLowerCase();
      if (n.includes("legal")) t.add("legal");
      else if (n.includes("egg bank") || n.includes("sperm bank")) t.add("bank");
      else if (n.includes("ivf") || n.includes("clinic")) t.add("ivf");
      else if (n.includes("surrogacy")) t.add("surrogacy");
      else if (n.includes("egg donor")) t.add("egg_donation");
    }
    if (t.size > 0) availableTypes = ALL_TYPES.filter((x) => t.has(x));
  }

  const data = {
    generatedAt: new Date().toISOString(),
    availableTypes,
    kpis: {
      // Provider scope: never expose the platform cohort - "registered"
      // becomes the parents who actually engaged this provider, and
      // conversion is measured from engagement.
      registeredAccounts: filters.providerScope ? accountsWithJourney : accountIds.length,
      accountsWithJourney,
      journeysInFlight: filteredJourneys.length - handedOffJourneys.length - dormant,
      handedOffTotal: handedOffJourneys.length,
      handedOff30d,
      dormant,
      overallConversionPct: filters.providerScope
        ? (accountsWithJourney > 0 ? Math.round((handedOffJourneys.length / accountsWithJourney) * 100) : null)
        : (accountIds.length > 0 ? Math.round((handedOffJourneys.length / accountIds.length) * 100) : null),
    },
    funnels,
    leaks: {
      consultationsScheduled: scheduledCount,
      noShowParent,
      noShowProvider,
      canceledNotRebooked,
      churnReasons,
      details: {
        noShows: noShowDetails,
        notRebooked: notRebookedDetails,
        churned: churnedDetails,
      },
    },
    winback: {
      sent: winbackSent,
      responses: winbackResponses,
      reengaged: reengaged,
      recoveryPct: winbackSent > 0 ? Math.round((reengaged / winbackSent) * 100) : null,
      details: { awaitingReply: awaitingReplyDetails },
    },
    providers,
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}
