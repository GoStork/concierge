/**
 * Backfill lead owners from history.
 *
 * Auto-assignment only started when it was built, so every family handed off
 * before then reads "Unassigned". The past does record who took each one, in
 * two different shapes:
 *
 *   GOSTORK  - AiChatSession.humanAgentId, a real user id, set whenever an
 *              admin joined a chat or sent the first human reply. Reliable.
 *
 *   PROVIDER - only AiChatMessage.senderName, a display string. There is no
 *              staff user id on provider messages, so this half is a name
 *              match inside the session's own org, and it is taken ONLY when
 *              exactly one person there carries that name. Anything ambiguous
 *              is skipped and counted rather than guessed - a wrong owner is
 *              worse than none, because it looks authoritative.
 *
 * Most recent session wins: who holds a family now matters more than who
 * spoke to them first. Existing owners are never touched.
 *
 * Dry run:  npx tsx scripts/backfill-parent-owners.ts
 * Apply:    npx tsx scripts/backfill-parent-owners.ts --apply
 */
import "dotenv/config";
import { prisma } from "../server/db";

const APPLY = process.argv.includes("--apply");

(async () => {
  console.log(APPLY ? "APPLYING\n" : "DRY RUN - pass --apply to write\n");

  const sessions = await prisma.aiChatSession.findMany({
    where: { OR: [{ humanAgentId: { not: null } }, { providerId: { not: null } }] },
    select: { id: true, userId: true, providerId: true, humanAgentId: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });

  const userIds = Array.from(new Set(sessions.map((s) => s.userId)));
  const parents = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, parentAccountId: true },
  });
  const keyByUser = new Map(parents.map((p) => [p.id, p.parentAccountId || p.id]));

  const existing = await prisma.parentOwner.findMany({
    select: { parentAccountId: true, scope: true, providerId: true },
  });
  const taken = new Set(existing.map((o) => `${o.parentAccountId}|${o.scope}|${o.providerId || ""}`));

  // ── GoStork: straight from humanAgentId ───────────────────────────────────
  const agentIds = Array.from(new Set(sessions.map((s) => s.humanAgentId).filter(Boolean) as string[]));
  const agents = await prisma.user.findMany({
    where: { id: { in: agentIds } },
    select: { id: true, name: true, roles: true },
  });
  const agentById = new Map(agents.map((a) => [a.id, a]));

  const gostork: { key: string; ownerUserId: string; ownerName: string | null }[] = [];
  const seenG = new Set<string>();
  for (const s of sessions) {
    if (!s.humanAgentId) continue;
    const key = keyByUser.get(s.userId);
    if (!key || seenG.has(key) || taken.has(`${key}|GOSTORK|`)) continue;
    const a = agentById.get(s.humanAgentId);
    // Someone who has since lost their GoStork role should not be revived as
    // an owner; the write endpoint would refuse it, and so does this.
    if (!a || !(a.roles || []).some((r: string) => r.startsWith("GOSTORK_"))) continue;
    seenG.add(key);
    gostork.push({ key, ownerUserId: a.id, ownerName: a.name });
  }

  // ── Provider: unique name match inside the session's own org ──────────────
  const providerSessionIds = sessions.filter((s) => s.providerId).map((s) => s.id);
  const provMsgs = providerSessionIds.length
    ? await prisma.aiChatMessage.findMany({
        where: { sessionId: { in: providerSessionIds }, senderType: "provider", senderName: { not: null } },
        select: { sessionId: true, senderName: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const nameBySession = new Map<string, string>();
  for (const m of provMsgs) if (!nameBySession.has(m.sessionId)) nameBySession.set(m.sessionId, m.senderName as string);

  const orgIds = Array.from(new Set(sessions.map((s) => s.providerId).filter(Boolean) as string[]));
  const staff = orgIds.length
    ? await prisma.user.findMany({
        where: { providerId: { in: orgIds } },
        select: { id: true, name: true, providerId: true },
      })
    : [];
  // Provider messages store an abbreviated display name, not the full one:
  // chat-router writes `${first} ${lastInitial}.` ("Jered Mercer" -> "Jered
  // M."). Matching on the raw name found nothing at all, so rebuild the same
  // abbreviation from each staff row and compare those.
  const abbreviate = (name: string | null): string => {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean);
    return parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : (parts[0] || "");
  };
  const staffByOrgName = new Map<string, { id: string; name: string | null }[]>();
  for (const u of staff) {
    const k = `${u.providerId}|${abbreviate(u.name).toLowerCase()}`;
    if (!k.endsWith("|")) staffByOrgName.set(k, [...(staffByOrgName.get(k) || []), u]);
  }

  const provider: { key: string; providerId: string; ownerUserId: string; ownerName: string | null }[] = [];
  const seenP = new Set<string>();
  let ambiguous = 0, unmatched = 0;
  for (const s of sessions) {
    if (!s.providerId) continue;
    const key = keyByUser.get(s.userId);
    const senderName = nameBySession.get(s.id);
    if (!key || !senderName) continue;
    const pair = `${key}|${s.providerId}`;
    if (seenP.has(pair) || taken.has(`${key}|PROVIDER|${s.providerId}`)) continue;
    const matches = staffByOrgName.get(`${s.providerId}|${senderName.trim().toLowerCase()}`) || [];
    if (matches.length === 0) { unmatched++; continue; }
    if (matches.length > 1) { ambiguous++; continue; }
    seenP.add(pair);
    provider.push({ key, providerId: s.providerId, ownerUserId: matches[0].id, ownerName: matches[0].name });
  }

  console.log(`GOSTORK   ${gostork.length} families would get an owner`);
  for (const g of gostork.slice(0, 8)) console.log(`  ${g.key.slice(0, 8)}  ->  ${g.ownerName || g.ownerUserId}`);
  if (gostork.length > 8) console.log(`  ... and ${gostork.length - 8} more`);

  console.log(`\nPROVIDER  ${provider.length} (family, org) pairs would get an owner`);
  for (const p of provider.slice(0, 8)) console.log(`  ${p.key.slice(0, 8)}  ->  ${p.ownerName || p.ownerUserId}`);
  if (provider.length > 8) console.log(`  ... and ${provider.length - 8} more`);
  console.log(`  skipped: ${ambiguous} ambiguous name(s), ${unmatched} sender name(s) with no matching staff row`);

  if (!APPLY) {
    console.log("\nNothing written.");
    process.exit(0);
  }

  let wrote = 0;
  for (const g of gostork) {
    try {
      await prisma.parentOwner.create({
        data: {
          parentAccountId: g.key, scope: "GOSTORK", providerId: null,
          ownerUserId: g.ownerUserId, ownerName: g.ownerName, assignedByUserId: g.ownerUserId,
        },
      });
      wrote++;
    } catch (e: any) {
      if (e?.code !== "P2002") throw e;   // someone claimed it while we ran
    }
  }
  for (const p of provider) {
    try {
      await prisma.parentOwner.create({
        data: {
          parentAccountId: p.key, scope: "PROVIDER", providerId: p.providerId,
          ownerUserId: p.ownerUserId, ownerName: p.ownerName, assignedByUserId: p.ownerUserId,
        },
      });
      wrote++;
    } catch (e: any) {
      if (e?.code !== "P2002") throw e;
    }
  }
  console.log(`\nWrote ${wrote} owner rows.`);
  process.exit(0);
})().catch((e) => {
  console.error("THREW:", e);
  process.exit(1);
});
