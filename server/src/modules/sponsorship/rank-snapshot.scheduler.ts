import * as cron from "node-cron";
import { PrismaService } from "../prisma/prisma.service";
import { applySponsoredOrdering } from "../providers/sponsorship-sort";

/**
 * "Search visibility" snapshots. Periodically (every 2h) recomputes, for each
 * currently-sponsored profile, its boosted marketplace position vs the organic
 * position it would have without the boost. Runs entirely off the live request
 * path so it never slows the marketplace decks.
 *
 * Boosted position: sponsored profiles are pinned to the top of the deck (with a
 * rotating shuffle), so a sponsored profile's deck position is simply its index
 * in the rotated sponsored sublist - identical to what applySponsoredOrdering
 * produces for the real deck. Organic position: its rank among ALL marketplace-
 * visible profiles of that type by the deck's natural (non-sponsored) order.
 *
 * Scoped to the view-ordered slot types (egg donor / surrogate / sperm donor /
 * doctor). Whole-profile clinic/agency cards rank by parent-contextual success
 * rate, so they're out of scope here.
 */

type TypeCfg = {
  entityType: string;
  delegate: () => any;
  visible: any; // marketplace-visibility WHERE (mirrors the deck)
  organicOrderBy: any; // deck secondary order, no sponsorship
};

function typeConfigs(prisma: PrismaService): TypeCfg[] {
  const approved = (names: string[]) => ({
    provider: { services: { some: { status: "APPROVED", providerType: { name: { in: names } } } } },
  });
  return [
    { entityType: "EGG_DONOR", delegate: () => prisma.eggDonor, visible: { hiddenFromSearch: false, ...approved(["Egg Donor Agency", "Egg Bank"]) }, organicOrderBy: { createdAt: "desc" } },
    { entityType: "SURROGATE", delegate: () => prisma.surrogate, visible: { hiddenFromSearch: false, ...approved(["Surrogacy Agency"]) }, organicOrderBy: { createdAt: "desc" } },
    { entityType: "SPERM_DONOR", delegate: () => prisma.spermDonor, visible: { hiddenFromSearch: false, ...approved(["Sperm Bank"]) }, organicOrderBy: { createdAt: "desc" } },
    { entityType: "DOCTOR", delegate: () => prisma.providerMember, visible: { isPublicProfile: true, slug: { not: null }, ...approved(["IVF Clinic"]) }, organicOrderBy: [{ isMedicalDirector: "desc" }, { name: "asc" }] },
  ];
}

export async function runRankSnapshot(prisma: PrismaService): Promise<number> {
  const now = new Date();
  let total = 0;
  for (const cfg of typeConfigs(prisma)) {
    const delegate = cfg.delegate();
    try {
      const sponsored = await delegate.findMany({
        where: { ...cfg.visible, sponsoredUntil: { gt: now } },
        select: { id: true, providerId: true, sponsoredUntil: true, sponsorBoostSeed: true },
      });
      if (!sponsored.length) continue;

      // Organic ranking: ids by the deck's natural order, no boost.
      const organic = await delegate.findMany({ where: cfg.visible, orderBy: cfg.organicOrderBy, select: { id: true } });
      const organicPos = new Map<string, number>(organic.map((r: any, i: number) => [r.id, i + 1]));
      const poolSize = organic.length;

      // Boosted ranking: rotated sponsored sublist sits at the very top.
      const ordered = applySponsoredOrdering(sponsored.map((s: any) => ({ ...s })), now.getTime());
      const rows = ordered.map((p: any, i: number) => ({
        providerId: p.providerId,
        profileId: p.id,
        entityType: cfg.entityType,
        position: i + 1,
        organicPosition: organicPos.get(p.id) ?? poolSize,
        poolSize,
      }));
      if (rows.length) {
        await prisma.sponsoredRankSnapshot.createMany({ data: rows });
        total += rows.length;
      }
    } catch (e: any) {
      console.error(`[rank-snapshot] ${cfg.entityType} failed: ${e.message}`);
    }
  }
  if (total) console.log(`[rank-snapshot] recorded ${total} sponsored rank samples`);
  return total;
}

let scheduledTask: cron.ScheduledTask | null = null;

export function startRankSnapshotScheduler(prisma: PrismaService) {
  if (scheduledTask) {
    console.log("[rank-snapshot] Scheduler already running");
    return;
  }
  runRankSnapshot(prisma).catch((e) => console.error(`[rank-snapshot] startup error: ${e.message}`));
  // Every 2 hours: spreads samples across rotation windows for share-of-voice
  // variation without hammering the DB.
  scheduledTask = cron.schedule("0 */2 * * *", async () => {
    try { await runRankSnapshot(prisma); } catch (e: any) { console.error(`[rank-snapshot] cron error: ${e.message}`); }
  });
  console.log("[rank-snapshot] Scheduler started - runs every 2 hours");
}

export function stopRankSnapshotScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}
