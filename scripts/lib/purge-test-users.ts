/**
 * Shared leftover-fixture purge for the scripts/test-*.ts suite.
 *
 * Every test script mints throwaway users on @gostork-test.com (or
 * @example.com for one-off scratch scripts) and deletes them on exit, but a
 * crashed or interrupted run leaks its fixtures into the admin /parents list
 * forever. Calling purgeLeftoverTestUsers() at script startup sweeps those
 * leftovers so the DB self-heals on the next run.
 *
 * Only users OLDER than MIN_AGE_MS are touched: both Macs can run suites
 * concurrently (and test-ai-concierge shards across servers), so freshly
 * created fixtures from an in-flight run must never be swept.
 */
import jwt from "jsonwebtoken";
import type { PrismaClient } from "@prisma/client";

export const TEST_EMAIL_DOMAINS = ["@gostork-test.com", "@example.com"];
/** Fixture providers are always named "ZZ Test ..." so they sort last in admin lists. */
export const TEST_PROVIDER_PREFIX = "ZZ Test";
const MIN_AGE_MS = 2 * 60 * 60 * 1000;
const BASE = process.env.BASE_URL || "http://localhost:5001";

/**
 * Deletes leftover fixture providers through the admin DELETE /api/providers/:id
 * endpoint so the full cascade (staff users, bookings, services, donors, sync
 * configs, locations, invoices, ...) stays in ONE place - the controller -
 * instead of being duplicated here.
 */
async function deleteProvidersViaApi(
  providers: { id: string; name: string }[],
  adminUserId: string,
): Promise<number> {
  const token = jwt.sign({ sub: adminUserId }, process.env.JWT_SECRET || "dev-jwt-secret-change-me", {
    expiresIn: "10m",
  });
  let removed = 0;
  for (const p of providers) {
    try {
      const res = await fetch(`${BASE}/api/providers/${p.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) removed++;
      else {
        console.warn(
          `[purge-test-users] delete of provider "${p.name}" failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
        );
      }
    } catch (e: any) {
      console.warn(`[purge-test-users] delete of provider "${p.name}" failed: ${e?.message || e}`);
    }
  }
  if (removed > 0) {
    console.log(`[purge-test-users] swept ${removed} leftover test provider(s) from prior runs`);
  }
  return removed;
}

export async function purgeLeftoverTestUsers(prisma: PrismaClient): Promise<number> {
  const cutoff = new Date(Date.now() - MIN_AGE_MS);

  // Providers first: the endpoint's cascade also removes their staff users.
  const staleProviders = await prisma.provider.findMany({
    where: { name: { startsWith: TEST_PROVIDER_PREFIX }, createdAt: { lt: cutoff } },
    select: { id: true, name: true },
  });
  let removedProviders = 0;
  if (staleProviders.length > 0) {
    const admin = await prisma.user.findFirst({
      where: { roles: { has: "GOSTORK_ADMIN" } },
      select: { id: true },
    });
    if (admin) removedProviders = await deleteProvidersViaApi(staleProviders, admin.id);
    else console.warn("[purge-test-users] no GOSTORK_ADMIN user found; skipping provider sweep");
  }

  const leftovers = await prisma.user.findMany({
    where: {
      createdAt: { lt: cutoff },
      OR: TEST_EMAIL_DOMAINS.map((d) => ({ email: { endsWith: d } })),
    },
    select: { id: true, parentAccountId: true },
  });
  if (leftovers.length === 0) return removedProviders;
  const ids = leftovers.map((u) => u.id);

  // FK blockers first: Booking.providerUserId is RESTRICT and
  // Invoice.parentUserId is NO ACTION; everything else cascades off User.
  await prisma.booking.deleteMany({
    where: { OR: [{ providerUserId: { in: ids } }, { parentUserId: { in: ids } }] },
  });
  await prisma.invoice.deleteMany({ where: { parentUserId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });

  const accountIds = [
    ...new Set(leftovers.map((u) => u.parentAccountId).filter((a): a is string => !!a)),
  ];
  if (accountIds.length > 0) {
    await prisma.parentAccount.deleteMany({
      where: { id: { in: accountIds }, members: { none: {} } },
    });
  }
  console.log(`[purge-test-users] swept ${ids.length} leftover test user(s) from prior runs`);
  return ids.length + removedProviders;
}

/** Same sweep for scripts that talk to Postgres via a raw pg Client. */
export async function purgeLeftoverTestUsersPg(db: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}): Promise<number> {
  // Providers first: the endpoint's cascade also removes their staff users.
  const staleProviders = (
    await db.query(
      `SELECT id, name FROM "Provider" WHERE name LIKE $1 AND "createdAt" < NOW() - INTERVAL '2 hours'`,
      [`${TEST_PROVIDER_PREFIX}%`],
    )
  ).rows;
  let removedProviders = 0;
  if (staleProviders.length > 0) {
    const adminRows = (
      await db.query(`SELECT id FROM "User" WHERE 'GOSTORK_ADMIN' = ANY(roles) LIMIT 1`)
    ).rows;
    if (adminRows.length > 0) removedProviders = await deleteProvidersViaApi(staleProviders, adminRows[0].id);
    else console.warn("[purge-test-users] no GOSTORK_ADMIN user found; skipping provider sweep");
  }

  const cond = `(u."email" LIKE '%@gostork-test.com' OR u."email" LIKE '%@example.com') AND u."createdAt" < NOW() - INTERVAL '2 hours'`;
  const { rows } = await db.query(
    `SELECT u.id, u."parentAccountId" FROM "User" u WHERE ${cond}`,
  );
  if (rows.length === 0) return removedProviders;
  const ids = rows.map((r) => r.id);
  const accountIds = [...new Set(rows.map((r) => r.parentAccountId).filter(Boolean))];
  await db.query(
    `DELETE FROM "Booking" WHERE "providerUserId" = ANY($1) OR "parentUserId" = ANY($1)`,
    [ids],
  );
  await db.query(`DELETE FROM "Invoice" WHERE "parentUserId" = ANY($1)`, [ids]);
  await db.query(`DELETE FROM "User" WHERE id = ANY($1)`, [ids]);
  if (accountIds.length > 0) {
    await db.query(
      `DELETE FROM "ParentAccount" pa WHERE pa.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."parentAccountId" = pa.id)`,
      [accountIds],
    );
  }
  console.log(`[purge-test-users] swept ${ids.length} leftover test user(s) from prior runs`);
  return ids.length + removedProviders;
}
