/**
 * Auto-assigning the GoStork lead owner on takeover.
 *
 * The rule that carries the risk is "never steal": a second admin glancing at a
 * thread must not silently reassign a family somebody else already owns. That
 * is the case worth a test, because it only misbehaves when there is already an
 * owner - the state a fresh database never has.
 *
 * Runs against the real database and cleans up after itself.
 *
 * Run: npx tsx scripts/test-parent-owner-claim.ts
 */
import "dotenv/config";
import { prisma } from "../server/db";
import { claimGostorkOwner } from "../server/parent-owner-claim";

const fails: string[] = [];
const ck = (n: string, ok: boolean) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`);
  if (!ok) fails.push(n);
};

(async () => {
  const parent = await prisma.user.findFirst({
    where: { email: "natan123+lala@gmail.com" },
    select: { id: true, name: true, parentAccountId: true },
  });
  if (!parent) {
    console.log("fixture parent missing - skipping (not a failure on a fresh DB)");
    process.exit(0);
  }
  const acct = parent.parentAccountId || parent.id;

  const staff = await prisma.user.findMany({
    where: { roles: { hasSome: ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE"] } },
    select: { id: true, name: true, roles: true },
    take: 2,
  });
  if (staff.length < 2) {
    console.log("need two GoStork staff accounts to test the no-steal rule - skipping");
    process.exit(0);
  }
  const [first, second] = staff;

  const preexisting = await prisma.parentOwner.findFirst({
    where: { parentAccountId: acct, scope: "GOSTORK" },
    select: { id: true },
  });
  if (preexisting) {
    console.log("fixture parent already has a GoStork owner - skipping so we do not disturb it");
    process.exit(0);
  }

  const created: string[] = [];
  try {
    console.log(`parent: ${parent.name} (${parent.id})\n`);
    console.log("CLAIM ON TAKEOVER");

    await claimGostorkOwner(parent.id, first, "JOINED_CHAT");
    const afterFirst = await prisma.parentOwner.findFirst({
      where: { parentAccountId: acct, scope: "GOSTORK" },
    });
    if (afterFirst) created.push(afterFirst.id);
    ck("an empty slot is filled by the admin who joined", afterFirst?.ownerUserId === first.id);
    ck("the row is GOSTORK scope with no provider",
      afterFirst?.scope === "GOSTORK" && afterFirst?.providerId === null);
    ck("the owner name is snapshotted", afterFirst?.ownerName === (first.name || null));

    // The one that matters.
    await claimGostorkOwner(parent.id, second, "FIRST_REPLY");
    const afterSecond = await prisma.parentOwner.findFirst({
      where: { parentAccountId: acct, scope: "GOSTORK" },
    });
    ck("a second admin does NOT steal an existing owner", afterSecond?.ownerUserId === first.id);
    ck("and does not create a duplicate row",
      (await prisma.parentOwner.count({ where: { parentAccountId: acct, scope: "GOSTORK" } })) === 1);

    console.log("\nWHO MAY CLAIM");
    await prisma.parentOwner.deleteMany({ where: { parentAccountId: acct, scope: "GOSTORK" } });
    // A provider reaching this helper would be a bug, but the guard is cheap
    // and an agency name appearing as the GoStork owner would be a real leak.
    await claimGostorkOwner(parent.id, { id: "x", name: "Agency Staff", roles: ["PROVIDER_ADMIN"], providerId: "p" }, "JOINED_CHAT");
    ck("a provider is refused",
      (await prisma.parentOwner.count({ where: { parentAccountId: acct, scope: "GOSTORK" } })) === 0);

    await claimGostorkOwner(null, first, "JOINED_CHAT");
    ck("a session with no user is a no-op, not a throw", true);

    console.log("\nPROVIDER SCOPE UNTOUCHED");
    ck("claiming never writes a PROVIDER-scope owner",
      (await prisma.parentOwner.count({ where: { parentAccountId: acct, scope: "PROVIDER", assignedByUserId: first.id } })) === 0);
  } finally {
    // Ours alone: the run bailed out above if the parent already had an owner.
    await prisma.parentOwner.deleteMany({ where: { parentAccountId: acct, scope: "GOSTORK" } });
    void created;
  }

  console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error("THREW:", e);
  process.exit(1);
});
