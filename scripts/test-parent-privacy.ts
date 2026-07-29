/**
 * GoStork - Two-tier parent privacy end-to-end (PP-xx)
 *
 * Proves the thing the whole change exists for: a provider who has met a parent
 * sees their NAME and never their email or phone, until the parent does
 * something that releases it. Also pins the two live leaks that were open
 * before it (every-parent contact enumeration, and the IP form reachable from
 * an anonymous whisper).
 *
 * Usage:
 *   npx tsx scripts/test-parent-privacy.ts
 *   npx tsx scripts/test-parent-privacy.ts --id=PP-05
 */

import "dotenv/config";

const BASE = process.env.TEST_BASE_URL || "http://localhost:5001";
const PW = "TestPass123!";
const filterId = process.argv.slice(2).find((a) => a.startsWith("--id="))?.split("=")[1];

let caseFails: string[] = [];
let totalPass = 0;
let totalFail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`      ${ok ? "✓" : "✗"} ${label}${detail && !ok ? ` :: ${String(detail).replace(/\n/g, " | ").slice(0, 180)}` : ""}`);
  if (!ok) caseFails.push(`${label}${detail ? ` :: ${String(detail).slice(0, 160)}` : ""}`);
}

async function reportToDashboard(event: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${BASE}/api/admin/test-runner/event`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event),
    });
  } catch { /* dashboard is optional */ }
}

let prisma: any;
async function db() {
  if (!prisma) prisma = (await import("../server/db.js")).prisma;
  return prisma;
}

// ─── Fixture ────────────────────────────────────────────────────────────────

type Fixture = {
  parentId: string; parentEmail: string; parentAuth: string; accountKey: string;
  provAuth: string; providerId: string; providerName: string;
  adminAuth: string;
  sessionId: string;
};
let fixture: Fixture | null = null;
const trash: { userIds: string[]; sessionIds: string[]; accountKeys: string[] } = { userIds: [], sessionIds: [], accountKeys: [] };

async function login(email: string) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PW }),
  });
  const body = await res.json();
  if (!body?.token) throw new Error(`login failed for ${email}`);
  return `Bearer ${body.token}`;
}

async function register(email: string, name: string) {
  const r = await fetch(`${BASE}/api/users`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PW, name }),
  });
  if (!r.ok) throw new Error(`register ${email}: ${await r.text()}`);
  return (await r.json()).id as string;
}

async function getFixture(): Promise<Fixture> {
  if (fixture) return fixture;
  const p = await db();
  const provider = await p.provider.findFirst({ where: { users: { some: {} } }, select: { id: true, name: true } });
  if (!provider) throw new Error("no provider with users in this DB");

  const stamp = Date.now();
  const parentEmail = `test-pp-parent-${stamp}@gostork-test.com`;
  const provEmail = `test-pp-prov-${stamp}@gostork-test.com`;
  const adminEmail = `test-pp-admin-${stamp}@gostork-test.com`;
  const parentId = await register(parentEmail, "Privacy Parent");
  const provUserId = await register(provEmail, "Privacy Provider");
  const adminId = await register(adminEmail, "Privacy Admin");
  trash.userIds.push(parentId, provUserId, adminId);

  await p.user.update({
    where: { id: parentId },
    data: { mobileNumber: "+19172247761", mobileNumberDisplay: "+1 (917) 224-7761", city: "New York", state: "New York" },
  });
  await p.user.update({ where: { id: provUserId }, data: { providerId: provider.id, roles: { set: ["PROVIDER_ADMIN"] } } });
  await p.user.update({ where: { id: adminId }, data: { roles: { set: ["GOSTORK_ADMIN"] } } });

  // Releases are keyed on `parentAccountId ?? id`, and registration creates a
  // ParentAccount - so a release written under the raw userId would silently
  // never be found. Resolve the real key rather than assuming.
  const parentRow = await p.user.findUnique({ where: { id: parentId }, select: { id: true, parentAccountId: true } });
  const accountKey = parentRow?.parentAccountId || parentId;
  trash.accountKeys.push(accountKey);

  // A booked consultation: Gate A open (they are meeting), Gate B closed.
  const session = await p.aiChatSession.create({
    data: {
      userId: parentId, title: `Consultation with ${provider.name}`, sessionType: "PARENT",
      status: "CONSULTATION_BOOKED", providerId: provider.id, providerName: provider.name,
    },
  });
  trash.sessionIds.push(session.id);

  fixture = {
    parentId, parentEmail, parentAuth: await login(parentEmail), accountKey,
    provAuth: await login(provEmail), providerId: provider.id, providerName: provider.name,
    adminAuth: await login(adminEmail),
    sessionId: session.id,
  };
  return fixture;
}

async function get(path: string, auth: string) {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: auth } });
  return { status: r.status, body: await r.json().catch(() => ({} as any)) };
}
async function send(method: string, path: string, auth: string, body?: any) {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { "Content-Type": "application/json", Authorization: auth },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({} as any)) };
}

async function clearReleases() {
  const p = await db();
  await p.parentContactRelease.deleteMany({ where: { parentAccountId: { in: trash.accountKeys } } });
}

// ─── PP-01: Gate A open, Gate B closed ─────────────────────────────────────
async function pp01() {
  const f = await getFixture();
  await clearReleases();

  const detail = await get(`/api/provider/concierge-sessions/${f.sessionId}`, f.provAuth);
  check("session detail returns the parent's real name", detail.body?.user?.name === "Privacy Parent", JSON.stringify(detail.body?.user));
  check("session detail withholds the email", detail.body?.user?.email === null, String(detail.body?.user?.email));
  check("session detail withholds the mobile", !detail.body?.user?.mobileNumber, String(detail.body?.user?.mobileNumber));
  check("session detail keeps the city (identity, not contact)", detail.body?.user?.city === "New York", String(detail.body?.user?.city));
  check("session detail reports contactReleased false", detail.body?.contactReleased === false, String(detail.body?.contactReleased));

  const inbox = await get("/api/provider/concierge-sessions", f.provAuth);
  const row = (inbox.body || []).find((s: any) => s.id === f.sessionId);
  check("inbox row shows the name", row?.userName === "Privacy Parent", JSON.stringify(row?.userName));
  check("inbox row withholds the email", row?.userEmail === null, String(row?.userEmail));

  const list = await get(`/api/providers/${f.providerId}/parent-contacts`, f.provAuth);
  const pRow = (list.body || []).find((r: any) => r.id === f.parentId);
  check("/parents lists the parent", !!pRow, `${(list.body || []).length} rows`);
  check("/parents withholds the email", pRow ? pRow.email === null : false, String(pRow?.email));
  check("/parents withholds the mobile", pRow ? !pRow.mobileNumber : false, String(pRow?.mobileNumber));
  check("/parents flags contactReleased false", pRow?.contactReleased === false, String(pRow?.contactReleased));

  const pd = await get(`/api/provider/parents/${f.parentId}`, f.provAuth);
  check("parent profile withholds the email", pd.body?.email === null, String(pd.body?.email));
  check("parent profile withholds the mobile", !pd.body?.mobileNumber, String(pd.body?.mobileNumber));
  check("parent profile withholds the IP-form PDF handle", pd.body?.ipForm?.responseId == null, String(pd.body?.ipForm?.responseId));
}

// ─── PP-02: the contact-enumeration leak ───────────────────────────────────
async function pp02() {
  const f = await getFixture();
  await clearReleases();

  const contacts = await get("/api/calendar/contacts", f.provAuth);
  const mine = (contacts.body || []).find((c: any) => c.parentUserId === f.parentId);
  const leaking = (contacts.body || []).filter((c: any) => !c.contactReleased && c.email);
  check("an unreleased parent carries no address", !mine || mine.email === null, JSON.stringify(mine));
  check("no unreleased contact anywhere in the list carries an address",
    Array.isArray(contacts.body) && leaking.length === 0,
    `${(contacts.body || []).length} rows, ${leaking.length} leaking`);

  // The original bug: ANY authenticated user, including a parent, could
  // enumerate every parent on the platform with their email.
  const asParent = await get("/api/calendar/contacts", f.parentAuth);
  check("a parent cannot enumerate other parents at all", asParent.status === 403, `status=${asParent.status}`);
}

// ─── PP-03: release opens Gate B everywhere ────────────────────────────────
async function pp03() {
  const f = await getFixture();
  const p = await db();
  await clearReleases();
  await p.parentContactRelease.create({ data: { providerId: f.providerId, parentAccountId: f.accountKey, reason: "INVOICE" } });

  const detail = await get(`/api/provider/concierge-sessions/${f.sessionId}`, f.provAuth);
  check("email appears after release", detail.body?.user?.email === f.parentEmail, String(detail.body?.user?.email));
  check("mobile appears after release", !!detail.body?.user?.mobileNumber, String(detail.body?.user?.mobileNumber));
  check("contactReleased flips to true", detail.body?.contactReleased === true, String(detail.body?.contactReleased));
  check("the release reason is reported", detail.body?.contactReleaseReason === "INVOICE", String(detail.body?.contactReleaseReason));

  const list = await get(`/api/providers/${f.providerId}/parent-contacts`, f.provAuth);
  const pRow = (list.body || []).find((r: any) => r.id === f.parentId);
  check("/parents shows the email after release", pRow?.email === f.parentEmail, String(pRow?.email));

  const contacts = await get("/api/calendar/contacts", f.provAuth);
  check("calendar autocomplete now offers them with an address",
    (contacts.body || []).some((c: any) => c.parentUserId === f.parentId && c.email === f.parentEmail),
    JSON.stringify((contacts.body || []).find((c: any) => c.parentUserId === f.parentId)));

  await clearReleases();
}

// ─── PP-04: the anonymous whisper stage ────────────────────────────────────
async function pp04() {
  const f = await getFixture();
  const p = await db();
  await clearReleases();
  await p.aiChatSession.update({ where: { id: f.sessionId }, data: { status: "ACTIVE", providerJoinedAt: null } });

  const detail = await get(`/api/provider/concierge-sessions/${f.sessionId}`, f.provAuth);
  check("anonymous stage masks the name", detail.body?.user?.name === "Prospective Parent", String(detail.body?.user?.name));
  check("anonymous stage masks the email", detail.body?.user?.email === null, String(detail.body?.user?.email));

  const list = await get(`/api/providers/${f.providerId}/parent-contacts`, f.provAuth);
  check("anonymous stage drops the row from /parents entirely",
    !(list.body || []).some((r: any) => r.id === f.parentId), `${(list.body || []).length} rows`);

  await p.aiChatSession.update({ where: { id: f.sessionId }, data: { status: "CONSULTATION_BOOKED" } });
}

// ─── PP-05: the IP-form fan-out, which is also the leak that was open ──────
// The form is ONE global row per account with no provider column, so who it is
// shared with has to be computed. It used to be computed with NO status filter,
// which meant a clinic that answered a single anonymous whisper received the
// parents' legal names and could download their home address.
async function pp05() {
  const f = await getFixture();
  const p = await db();
  const { ipFormProviderIds } = await import("../server/notify-ip-form.js");

  // Make this provider a form-collecting one, and give the parent a whisper-only
  // relationship with a SECOND provider.
  const prevCollects = (await p.provider.findUnique({ where: { id: f.providerId }, select: { collectsIntendedParentForm: true } }))?.collectsIntendedParentForm;
  await p.provider.update({ where: { id: f.providerId }, data: { collectsIntendedParentForm: true } });

  const other = await p.provider.findFirst({ where: { id: { not: f.providerId } }, select: { id: true, collectsIntendedParentForm: true } });
  let whisperSessionId: string | null = null;
  if (other) {
    await p.provider.update({ where: { id: other.id }, data: { collectsIntendedParentForm: true } });
    const s = await p.aiChatSession.create({
      data: { userId: f.parentId, title: "Anonymous Q&A", sessionType: "PARENT", status: "ACTIVE", providerId: other.id },
    });
    whisperSessionId = s.id;
    trash.sessionIds.push(s.id);
  }

  await p.aiChatSession.update({ where: { id: f.sessionId }, data: { status: "CONSULTATION_BOOKED" } });
  const ids = await ipFormProviderIds([f.parentId]);

  check("the booked, form-collecting provider IS in the fan-out", ids.includes(f.providerId), JSON.stringify(ids));
  if (other) {
    check("a whisper-only provider is NOT in the fan-out (the leak that was open)",
      !ids.includes(other.id), `whisper provider ${other.id} in ${JSON.stringify(ids)}`);
  }

  // And the PDF gate: with no release, the provider cannot reach the form list.
  await clearReleases();
  const forms = await get("/api/provider/ip-forms", f.provAuth);
  const visible = (forms.body?.forms || []).some((x: any) => x.parentAccountId === f.accountKey);
  check("with no release, the parent's form is not listed to the provider", !visible, JSON.stringify(forms.body?.forms?.length));

  if (whisperSessionId) await p.aiChatSession.deleteMany({ where: { id: whisperSessionId } }).catch(() => {});
  if (other) await p.provider.update({ where: { id: other.id }, data: { collectsIntendedParentForm: other.collectsIntendedParentForm } }).catch(() => {});
  await p.provider.update({ where: { id: f.providerId }, data: { collectsIntendedParentForm: !!prevCollects } }).catch(() => {});
}

// ─── PP-06: the invoice list defends itself ────────────────────────────────
// Every row in this endpoint has an Invoice, which by definition released
// contact - so in practice nothing is redacted. The invariant is invisible from
// that file though, so the redaction runs anyway. This proves it actually would.
async function pp06() {
  const f = await getFixture();
  const p = await db();
  await clearReleases();

  let createErr: any = null;
  const invoice = await p.invoice.create({
    data: {
      providerId: f.providerId, parentUserId: f.parentId, sessionId: f.sessionId,
      serviceAmount: 100000, referralFeeAmount: 10000, providerPayoutAmount: 90000,
      serviceType: "Egg Donation", providerName: f.providerName,
      status: "AWAITING_PAYMENT", paymentToken: `pp-test-${Date.now()}`,
    },
  }).catch((e: any) => { createErr = e; return null; });

  // A skipped assertion that still reports green is how a regression hides, so
  // this fails loudly rather than shrugging.
  check("the invoice fixture was created", !!invoice, String(createErr?.message || "").slice(0, 200));
  if (!invoice) return;

  const list = await get("/api/provider/invoices", f.provAuth);
  const rows = Array.isArray(list.body) ? list.body : (list.body?.invoices || []);
  const row = rows.find((i: any) => i.id === invoice.id);
  check("the invoice is returned to its provider", !!row, `${rows.length} rows`);
  check("an unreleased pair still gets no email on the invoice", row ? row.parentUser?.email === null : false, String(row?.parentUser?.email));
  check("...and no phone, in EITHER field", row ? (!row.parentUser?.mobileNumber && !row.parentUser?.mobileNumberDisplay) : false,
    `${row?.parentUser?.mobileNumber} / ${row?.parentUser?.mobileNumberDisplay}`);

  await p.invoice.delete({ where: { id: invoice.id } }).catch(() => {});
}

// ─── PP-07: the admin override, and the monotonic rule ─────────────────────
async function pp07() {
  const f = await getFixture();
  const p = await db();
  await clearReleases();

  const denied = await send("POST", "/api/admin/contact-releases", f.provAuth, { providerId: f.providerId, parentAccountId: f.accountKey });
  check("a provider cannot unlock contact for themselves", denied.status === 403, `status=${denied.status}`);

  const made = await send("POST", "/api/admin/contact-releases", f.adminAuth, { providerId: f.providerId, parentAccountId: f.accountKey, note: "urgent clinical coordination" });
  check("an admin can unlock a pair", made.status === 200 && made.body?.reason === "ADMIN", `status=${made.status} ${JSON.stringify(made.body).slice(0, 120)}`);

  const after = await get(`/api/provider/concierge-sessions/${f.sessionId}`, f.provAuth);
  check("the unlock takes effect immediately (no cache to wait out)", after.body?.contactReleased === true, String(after.body?.contactReleased));

  const revoked = await send("DELETE", `/api/admin/contact-releases/${made.body?.id}`, f.adminAuth);
  check("a MANUAL unlock can be revoked", revoked.status === 200, `status=${revoked.status}`);

  // A system release records a fact - the provider already holds a document with
  // the address on it - so removing the row would only make the UI lie.
  const earned = await p.parentContactRelease.create({ data: { providerId: f.providerId, parentAccountId: f.accountKey, reason: "INVOICE" } });
  const refused = await send("DELETE", `/api/admin/contact-releases/${earned.id}`, f.adminAuth);
  check("an EARNED release cannot be revoked (409)", refused.status === 409, `status=${refused.status}`);

  // Monotonic: the first trigger wins, so PandaDoc webhook replays and the two
  // agreement send paths cannot rewrite history.
  const { releaseParentContact } = await import("../server/parent-privacy.js");
  await releaseParentContact({ providerId: f.providerId, parentAccountId: f.accountKey, reason: "AGREEMENT" });
  const still = await p.parentContactRelease.findFirst({ where: { providerId: f.providerId, parentAccountId: f.accountKey } });
  check("a repeat release is idempotent and keeps the FIRST reason", still?.reason === "INVOICE", String(still?.reason));
  const count = await p.parentContactRelease.count({ where: { providerId: f.providerId, parentAccountId: f.accountKey } });
  check("and never creates a duplicate row", count === 1, `${count} rows`);

  await clearReleases();
}

const CASES: { id: string; name: string; run: () => Promise<void> }[] = [
  { id: "PP-01", name: "Booked consultation: the name is shown, the email and phone are not", run: pp01 },
  { id: "PP-02", name: "Contact enumeration is closed (every parent, to anyone, with email)", run: pp02 },
  { id: "PP-03", name: "A release opens Gate B across every provider surface at once", run: pp03 },
  { id: "PP-04", name: "The anonymous whisper stage stays anonymous", run: pp04 },
  { id: "PP-05", name: "IP-form fan-out reaches booked providers, never whisper-only ones", run: pp05 },
  { id: "PP-06", name: "The invoice list redacts an unreleased pair rather than trusting the invariant", run: pp06 },
  { id: "PP-07", name: "Admin override: unlock, revoke manual, refuse to revoke earned, stay monotonic", run: pp07 },
];

async function cleanup() {
  try {
    const p = await db();
    await p.parentContactRelease.deleteMany({ where: { parentAccountId: { in: [...trash.accountKeys, ...trash.userIds] } } }).catch(() => {});
    await p.invoice.deleteMany({ where: { parentUserId: { in: trash.userIds } } }).catch(() => {});
    await p.aiChatMessage.deleteMany({ where: { sessionId: { in: trash.sessionIds } } }).catch(() => {});
    await p.aiChatSession.deleteMany({ where: { id: { in: trash.sessionIds } } }).catch(() => {});
    await p.user.deleteMany({ where: { id: { in: trash.userIds } } }).catch(() => {});
  } catch { /* best effort */ }
}

(async () => {
  const wanted = filterId ? filterId.split(",").map((s) => s.trim().toUpperCase()) : null;
  const toRun = wanted ? CASES.filter((c) => wanted.includes(c.id)) : CASES;
  console.log(`🔒 Parent Privacy (two gates, end to end)`);
  console.log(`   Running: ${toRun.length} of ${CASES.length} cases\n`);

  const suiteStart = Date.now();
  await reportToDashboard({ type: "run_start", testIds: toRun.map((c) => c.id), filter: "parent-privacy" });
  for (const c of toRun) {
    caseFails = [];
    console.log(`  ▶ Starting: ${c.id}`);
    console.log(`    ${c.name}`);
    await reportToDashboard({ type: "test_start", id: c.id });
    const t0 = Date.now();
    try { await c.run(); } catch (e: any) { caseFails.push(`scenario crashed: ${(e?.message || String(e)).slice(0, 220)}`); }
    const durationMs = Date.now() - t0;
    if (caseFails.length === 0) {
      totalPass++; console.log(`  ✅ ${c.id} PASS (${(durationMs / 1000).toFixed(1)}s)`);
      await reportToDashboard({ type: "test_pass", id: c.id, durationMs });
    } else {
      totalFail++;
      for (const x of caseFails) console.log(`     [${c.id}] ${x}`);
      console.log(`  ❌ ${c.id} FAIL (${(durationMs / 1000).toFixed(1)}s)`);
      await reportToDashboard({ type: "test_fail", id: c.id, durationMs, errors: caseFails });
    }
  }
  await cleanup();
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${totalPass} passed, ${totalFail} failed (${Math.round((Date.now() - suiteStart) / 1000)}s total)`);
  await reportToDashboard({ type: "run_done", passCount: totalPass, failCount: totalFail, durationMs: Date.now() - suiteStart });
  process.exit(totalFail ? 1 : 0);
})();
