/**
 * Remove saved/skipped profile rows that point at a profile which no longer
 * exists.
 *
 * UserDonorPreference.donorId is a bare uuid with no FK - it can address an
 * EggDonor, a Surrogate or a SpermDonor, so no single relation could enforce
 * it. When a profile is deleted the row survives as a dead pointer.
 *
 * Safe to delete rather than wait for the id to come back: routine sync
 * UPSERTS on (providerId, externalId), so a live profile keeps its uuid. Rows
 * only orphan when a profile is genuinely removed - and a later re-import
 * mints a NEW uuid, so the old pointer can never resolve again.
 *
 * Worth knowing: an admin purge of a provider's roster silently orphans every
 * parent's favourites for that provider. This cleans up after that; it does
 * not stop it happening.
 *
 * Dry run:  npx tsx scripts/prune-orphan-favorites.ts
 * Apply:    npx tsx scripts/prune-orphan-favorites.ts --apply
 */
import "dotenv/config";
import { prisma } from "../server/db";

const APPLY = process.argv.includes("--apply");

(async () => {
  console.log(APPLY ? "APPLYING\n" : "DRY RUN - pass --apply to write\n");

  const prefs = await prisma.userDonorPreference.findMany({
    select: { id: true, donorId: true, type: true, userId: true },
  });
  const ids = Array.from(new Set(prefs.map((p) => p.donorId)));

  // Every table a donorId can point at. Missing one here would delete live
  // favourites - sperm donors were nearly missed on the first pass.
  const live = new Set<string>();
  for (const [name, model] of [
    ["eggDonor", prisma.eggDonor],
    ["surrogate", prisma.surrogate],
    ["spermDonor", (prisma as any).spermDonor],
  ] as [string, any][]) {
    if (!model?.findMany) {
      console.error(`no prisma getter for ${name} - refusing to run rather than risk deleting live rows`);
      process.exit(1);
    }
    const rows = await model.findMany({ where: { id: { in: ids } }, select: { id: true } });
    console.log(`  ${name.padEnd(11)} matches ${rows.length}`);
    for (const r of rows) live.add(r.id);
  }

  const orphans = prefs.filter((p) => !live.has(p.donorId));
  const byType: Record<string, number> = {};
  for (const o of orphans) byType[o.type] = (byType[o.type] || 0) + 1;
  const affected = new Set(orphans.map((o) => o.userId)).size;

  console.log(`\n${prefs.length} rows, ${ids.length} distinct profiles, ${live.size} still live.`);
  console.log(`${orphans.length} orphaned ${JSON.stringify(byType)} across ${affected} parents.`);

  if (!APPLY) {
    console.log("\nNothing written.");
    process.exit(0);
  }
  const res = await prisma.userDonorPreference.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
  console.log(`\nDeleted ${res.count} rows.`);
  process.exit(0);
})().catch((e) => {
  console.error("THREW:", e);
  process.exit(1);
});
