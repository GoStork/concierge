/**
 * Two-tier parent privacy, end to end against the running server.
 *
 * Proves the thing the whole change exists for: a provider who has met a parent
 * sees their NAME and never their email or phone, until the parent does
 * something that releases it. And proves the two live leaks are closed.
 *
 *   npx tsx scripts/test-parent-privacy.ts
 */

import "dotenv/config";

const BASE = process.env.TEST_BASE_URL || "http://localhost:5001";
const PW = "TestPass123!";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail && !ok ? ` :: ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

async function getDB() {
  const mod = await import("../server/db.js");
  return mod.prisma;
}

async function login(email: string) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PW }),
  });
  const body = await res.json();
  if (!body?.token) throw new Error(`login failed for ${email}: ${JSON.stringify(body).slice(0, 200)}`);
  return `Bearer ${body.token}`;
}

async function main() {
  const prisma = await getDB();
  const made: { userIds: string[]; sessionIds: string[]; releaseIds: string[]; accountKeys: string[] } =
    { userIds: [], sessionIds: [], releaseIds: [], accountKeys: [] };

  try {
    // A provider org with at least one staff login we can borrow the shape of.
    const provider = await prisma.provider.findFirst({
      where: { users: { some: {} } },
      select: { id: true, name: true, users: { select: { id: true, email: true }, take: 1 } },
    });
    if (!provider) throw new Error("no provider with users in this DB");

    const stamp = Date.now();
    const parentEmail = `test-privacy-parent-${stamp}@gostork-test.com`;
    const provEmail = `test-privacy-prov-${stamp}@gostork-test.com`;

    for (const [email, name] of [[parentEmail, "Privacy Parent"], [provEmail, "Privacy Provider"]] as const) {
      const r = await fetch(`${BASE}/api/users`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: PW, name }),
      });
      if (!r.ok) throw new Error(`register ${email}: ${await r.text()}`);
      made.userIds.push((await r.json()).id);
    }
    const [parentId, provUserId] = made.userIds;

    await prisma.user.update({
      where: { id: parentId },
      data: { mobileNumber: "+19172247761", mobileNumberDisplay: "+1 (917) 224-7761", city: "New York", state: "New York" },
    });
    await prisma.user.update({
      where: { id: provUserId },
      data: { providerId: provider.id, roles: { set: ["PROVIDER_ADMIN"] } },
    });
    const provAuth = await login(provEmail);
    const hdr = { "Content-Type": "application/json", Authorization: provAuth };

    // Releases are keyed on `parentAccountId ?? id`, and registration creates a
    // ParentAccount - so writing one under the raw userId would silently never
    // be found. This is the R7 hazard in the plan, exercised for real.
    const parentRow = await prisma.user.findUnique({ where: { id: parentId }, select: { id: true, parentAccountId: true } });
    const accountKey = parentRow?.parentAccountId || parentId;
    made.accountKeys.push(accountKey);

    // A booked consultation: Gate A open (they are meeting), Gate B closed.
    const session = await prisma.aiChatSession.create({
      data: {
        userId: parentId, title: `Consultation with ${provider.name}`, sessionType: "PARENT",
        status: "CONSULTATION_BOOKED", providerId: provider.id, providerName: provider.name,
      },
    });
    made.sessionIds.push(session.id);

    const getJson = async (path: string) => {
      const r = await fetch(`${BASE}${path}`, { headers: hdr });
      return { status: r.status, body: await r.json().catch(() => ({} as any)) };
    };

    console.log("\n── Gate A open, Gate B closed (consultation booked) ──");
    const detail = await getJson(`/api/provider/concierge-sessions/${session.id}`);
    check("session detail returns the parent's real name", detail.body?.user?.name === "Privacy Parent", JSON.stringify(detail.body?.user));
    check("session detail withholds the email", detail.body?.user?.email === null, String(detail.body?.user?.email));
    check("session detail withholds the mobile", !detail.body?.user?.mobileNumber, String(detail.body?.user?.mobileNumber));
    check("session detail keeps the city (not contact)", detail.body?.user?.city === "New York", String(detail.body?.user?.city));
    check("session detail reports contactReleased false", detail.body?.contactReleased === false, String(detail.body?.contactReleased));

    const inbox = await getJson("/api/provider/concierge-sessions");
    const row = (inbox.body || []).find((s: any) => s.id === session.id);
    check("inbox row shows the name", row?.userName === "Privacy Parent", JSON.stringify(row?.userName));
    check("inbox row withholds the email", row?.userEmail === null, String(row?.userEmail));

    const parentsList = await getJson(`/api/providers/${provider.id}/parent-contacts`);
    const pRow = (parentsList.body || []).find((r: any) => r.id === parentId);
    check("/parents lists the parent", !!pRow, `${(parentsList.body || []).length} rows`);
    check("/parents withholds the email", pRow ? pRow.email === null : false, String(pRow?.email));
    check("/parents withholds the mobile", pRow ? !pRow.mobileNumber : false, String(pRow?.mobileNumber));
    check("/parents flags contactReleased false", pRow?.contactReleased === false, String(pRow?.contactReleased));

    const pDetail = await getJson(`/api/provider/parents/${parentId}`);
    check("parent profile withholds the email", pDetail.body?.email === null, String(pDetail.body?.email));
    check("parent profile withholds the mobile", !pDetail.body?.mobileNumber, String(pDetail.body?.mobileNumber));
    check("parent profile withholds the IP-form PDF handle", pDetail.body?.ipForm?.responseId == null, String(pDetail.body?.ipForm?.responseId));

    console.log("\n── BUG FIX: /api/calendar/contacts no longer lists every parent ──");
    const contacts = await getJson("/api/calendar/contacts");
    // This provider legitimately has other released parents (real invoices), so
    // assert on OUR parent plus the shape of the whole list, not on it being
    // empty: nobody unreleased may carry an address.
    const mine = (contacts.body || []).find((c: any) => c.parentUserId === parentId);
    const unreleasedWithEmail = (contacts.body || []).filter((c: any) => !c.contactReleased && c.email);
    check("our unreleased parent has no address in the autocomplete", !mine || mine.email === null, JSON.stringify(mine));
    check("no unreleased contact anywhere in the list carries an address",
      Array.isArray(contacts.body) && unreleasedWithEmail.length === 0,
      `${(contacts.body || []).length} rows, ${unreleasedWithEmail.length} leaking`);
    const parentAuth = await login(parentEmail);
    const asParent = await fetch(`${BASE}/api/calendar/contacts`, { headers: { Authorization: parentAuth } });
    check("a parent cannot enumerate other parents at all", asParent.status === 403, `status=${asParent.status}`);

    console.log("\n── Gate B opens on release ──");
    const rel = await fetch(`${BASE}/api/admin/contact-releases`, {
      method: "POST", headers: hdr,
      body: JSON.stringify({ providerId: provider.id, parentAccountId: accountKey }),
    });
    check("a provider cannot unlock contact for themselves", rel.status === 403, `status=${rel.status}`);

    await prisma.parentContactRelease.create({
      data: { providerId: provider.id, parentAccountId: accountKey, reason: "INVOICE" },
    });
    const relRow = await prisma.parentContactRelease.findFirst({ where: { providerId: provider.id, parentAccountId: accountKey } });
    if (relRow) made.releaseIds.push(relRow.id);

    const after = await getJson(`/api/provider/concierge-sessions/${session.id}`);
    check("email appears after release", after.body?.user?.email === parentEmail, String(after.body?.user?.email));
    check("mobile appears after release", !!after.body?.user?.mobileNumber, String(after.body?.user?.mobileNumber));
    check("contactReleased flips to true", after.body?.contactReleased === true, String(after.body?.contactReleased));
    check("the release reason is reported", after.body?.contactReleaseReason === "INVOICE", String(after.body?.contactReleaseReason));

    const afterList = await getJson(`/api/providers/${provider.id}/parent-contacts`);
    const aRow = (afterList.body || []).find((r: any) => r.id === parentId);
    check("/parents shows the email after release", aRow?.email === parentEmail, String(aRow?.email));

    const afterContacts = await getJson("/api/calendar/contacts");
    check("calendar autocomplete now includes them, with an address",
      (afterContacts.body || []).some((c: any) => c.parentUserId === parentId && c.email === parentEmail),
      JSON.stringify((afterContacts.body || []).slice(0, 3)));

    console.log("\n── Anonymous whisper stage stays anonymous ──");
    await prisma.parentContactRelease.deleteMany({ where: { providerId: provider.id, parentAccountId: accountKey } });
    await prisma.aiChatSession.update({ where: { id: session.id }, data: { status: "ACTIVE", providerJoinedAt: null } });
    const anon = await getJson(`/api/provider/concierge-sessions/${session.id}`);
    check("anonymous stage masks the name", anon.body?.user?.name === "Prospective Parent", String(anon.body?.user?.name));
    check("anonymous stage masks the email", anon.body?.user?.email === null, String(anon.body?.user?.email));
    const anonParents = await getJson(`/api/providers/${provider.id}/parent-contacts`);
    check("anonymous stage drops the row from /parents entirely",
      !(anonParents.body || []).some((r: any) => r.id === parentId),
      `${(anonParents.body || []).length} rows`);

    console.log(`\n${"─".repeat(46)}\n${pass} passed, ${fail} failed`);
  } catch (e: any) {
    console.error("verify crashed:", e?.message || e);
    fail++;
  } finally {
    await prisma.parentContactRelease.deleteMany({ where: { parentAccountId: { in: [...made.userIds, ...made.accountKeys] } } }).catch(() => {});
    await prisma.aiChatMessage.deleteMany({ where: { sessionId: { in: made.sessionIds } } }).catch(() => {});
    await prisma.aiChatSession.deleteMany({ where: { id: { in: made.sessionIds } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: made.userIds } } }).catch(() => {});
    process.exit(fail ? 1 : 0);
  }
}

main();
