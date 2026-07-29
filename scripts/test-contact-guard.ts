/**
 * GoStork - Contact guard end-to-end (CG-xx)
 *
 * UT-11/UT-12 prove the RULES in isolation. This proves the PLUMBING: that every
 * enforcement point actually rejects, that nothing is persisted when it does,
 * and - the regression most likely to go unnoticed - that the Eva exception
 * still lets a parent give Eva their own phone number during intake.
 *
 * Usage:
 *   npx tsx scripts/test-contact-guard.ts
 *   npx tsx scripts/test-contact-guard.ts --id=CG-03
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
  } catch { /* dashboard is optional - the CLI run works without it */ }
}

let prisma: any;
async function db() {
  if (!prisma) prisma = (await import("../server/db.js")).prisma;
  return prisma;
}

// ─── Shared fixture: one parent, one provider login, two threads ────────────

type Fixture = {
  parentId: string; parentEmail: string; parentAuth: string;
  provUserId: string; provAuth: string; providerId: string; providerName: string;
  sharedSessionId: string; privateSessionId: string;
};
let fixture: Fixture | null = null;
const trash: { userIds: string[]; sessionIds: string[] } = { userIds: [], sessionIds: [] };

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
  const parentEmail = `test-cg-parent-${stamp}@gostork-test.com`;
  const provEmail = `test-cg-prov-${stamp}@gostork-test.com`;
  const parentId = await register(parentEmail, "Guard Parent");
  const provUserId = await register(provEmail, "Guard Provider");
  trash.userIds.push(parentId, provUserId);
  await p.user.update({ where: { id: provUserId }, data: { providerId: provider.id, roles: { set: ["PROVIDER_ADMIN"] } } });

  // Shared thread: the provider reads it. Private thread: Eva alone - but
  // deliberately STAMPED with providerId, which is exactly what a whisper
  // leaves behind and is the trap the discriminator has to survive.
  const shared = await p.aiChatSession.create({
    data: {
      userId: parentId, title: `Consultation with ${provider.name}`, sessionType: "PARENT",
      status: "CONSULTATION_BOOKED", providerId: provider.id, providerName: provider.name, providerJoinedAt: new Date(),
    },
  });
  const priv = await p.aiChatSession.create({
    data: { userId: parentId, title: "Eva", sessionType: "PARENT", status: "ACTIVE", providerId: provider.id, providerJoinedAt: null },
  });
  trash.sessionIds.push(shared.id, priv.id);

  fixture = {
    parentId, parentEmail, parentAuth: await login(parentEmail),
    provUserId, provAuth: await login(provEmail), providerId: provider.id, providerName: provider.name,
    sharedSessionId: shared.id, privateSessionId: priv.id,
  };
  return fixture;
}

const BLOCKED = (r: { status: number; body: any }) => r.status === 422 && r.body?.code === "CONTACT_INFO_BLOCKED";

async function post(path: string, auth: string, body: any) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({} as any)) };
}

// ─── CG-01: parent -> provider, every obfuscated form ───────────────────────
async function cg01() {
  const f = await getFixture();
  const send = (content: string) => post(`/api/chat-session/${f.sharedSessionId}/message`, f.parentAuth, { content });

  for (const [label, text] of [
    ["phone", "here is my cell 917-224-7761"],
    ["spaced email", "email me: e r a n @ g o s t o r k . c o m"],
    ["bracketed email", "eran (at) gostork dot com"],
    ["fullwidth @", "my address is eran＠gostork.com"],
    ["zoom link", "let's meet on us02web.zoom.us/j/98765432101"],
    ["calendly link", "grab a slot at calendly.com/eran-gostork/30min"],
    ["whatsapp move", "let us move this over to WhatsApp"],
    ["telegram handle", "my telegram is @eranamir"],
  ] as const) {
    check(`blocks ${label}`, BLOCKED(await send(text)));
  }

  const ok = await send("Thanks. Our budget is around $145,000 and her AMH was 1.2 - can we talk Friday at 9:30?");
  check("an ordinary cost + clinical message goes through", ok.status === 200, `status=${ok.status}`);

  const p = await db();
  const leaked = await p.aiChatMessage.count({
    where: { sessionId: f.sharedSessionId, OR: [{ content: { contains: "224-7761" } }, { content: { contains: "zoom.us" } }] },
  });
  check("no blocked message was persisted", leaked === 0, `${leaked} rows`);
}

// ─── CG-02: the rejection explains itself and leaks nothing ─────────────────
async function cg02() {
  const f = await getFixture();
  const r = await post(`/api/chat-session/${f.sharedSessionId}/message`, f.parentAuth, { content: "call me at 917-224-7761" });
  const msg = String(r.body?.message || "");
  check("422 with the CONTACT_INFO_BLOCKED code", BLOCKED(r), `status=${r.status} code=${r.body?.code}`);
  check("carries user-facing copy", msg.length > 40, msg);
  check("names what it found", /phone number/i.test(msg), msg);
  check("says GoStork is free", /free/i.test(msg), msg);
  check("contains no em dash", !/[—–]/.test(msg), msg);
  // Echoing the match back would hand a determined sender an oracle to tune
  // obfuscations against.
  check("does not echo the matched text back", !JSON.stringify(r.body).includes("224-7761"), JSON.stringify(r.body).slice(0, 160));
  check("does not leak rule internals", !JSON.stringify(r.body).includes("findings"), JSON.stringify(r.body).slice(0, 160));
}

// ─── CG-03: THE EVA EXCEPTION ──────────────────────────────────────────────
// If this breaks, intake silently stops working: Eva can no longer be told the
// parent's own phone number, and nothing anywhere reports an error.
async function cg03() {
  const f = await getFixture();
  const evaSend = (sessionId: string, message: string) =>
    fetch(`${BASE}/api/ai-concierge/chat`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: f.parentAuth },
      body: JSON.stringify({ message, sessionId }),
    });

  const priv = await evaSend(f.privateSessionId, "sure, my number is 917-224-7761 and my email is eran@gostork.com");
  check("parent CAN give Eva their own details in the PRIVATE thread", priv.status !== 422, `status=${priv.status}`);
  try { await priv.body?.cancel(); } catch { /* streaming response */ }

  const shared = await evaSend(f.sharedSessionId, "my number is 917-224-7761");
  const body = await shared.json().catch(() => ({} as any));
  check("the SAME text is blocked on a SHARED thread", shared.status === 422 && body?.code === "CONTACT_INFO_BLOCKED",
    `status=${shared.status} code=${body?.code}`);

  // providerId must never be the discriminator: the private session above is
  // stamped with one, exactly as a whisper would leave it.
  const p = await db();
  const privRow = await p.aiChatSession.findUnique({ where: { id: f.privateSessionId }, select: { providerId: true, providerJoinedAt: true } });
  check("the private session really is providerId-stamped (the trap is live)",
    !!privRow?.providerId && privRow.providerJoinedAt === null, JSON.stringify(privRow));
}

// ─── CG-04: provider -> parent ─────────────────────────────────────────────
async function cg04() {
  const f = await getFixture();
  const send = (content: string) => post(`/api/provider/concierge-sessions/${f.sharedSessionId}/message`, f.provAuth, { content });

  check("blocks the provider's phone number", BLOCKED(await send("easiest is to call my direct line 917-224-7761")));
  check("blocks the provider's email", BLOCKED(await send("just email me at coordinator@brightfutures.com")));
  check("blocks an outside meeting link", BLOCKED(await send("here is my zoom room: zoom.us/j/9876543210")));

  const ok = await send("Happy to help. Our all-in estimate is $145,000 and we can start in cycle 2.");
  check("an ordinary provider message goes through", ok.status === 200, `status=${ok.status} ${JSON.stringify(ok.body).slice(0, 120)}`);

  const p = await db();
  const leaked = await p.aiChatMessage.count({ where: { sessionId: f.sharedSessionId, content: { contains: "coordinator@" } } });
  check("no blocked provider message was persisted", leaked === 0, `${leaked} rows`);
}

// ─── CG-05: the whisper answer relay ───────────────────────────────────────
// One guard covers three writes: the persisted answerText, the Eva relay that
// quotes it verbatim to the parent, and the provider's own confirmation.
async function cg05() {
  const f = await getFixture();
  const p = await db();
  const anon = await p.aiChatSession.create({
    data: { userId: f.parentId, title: "Whisper thread", sessionType: "PARENT", status: "ACTIVE", providerId: f.providerId },
  });
  trash.sessionIds.push(anon.id);
  const q = await p.silentQuery.create({
    data: {
      parentUserId: f.parentId, providerId: f.providerId, sessionId: anon.id,
      questionText: "Do you work with international parents?", status: "PENDING",
    },
  });

  const bad = await post(`/api/provider/concierge-sessions/${anon.id}/message`, f.provAuth,
    { content: "Yes we do - easiest is to call me on 917-224-7761", silentQueryId: q.id });
  check("blocks a whisper answer carrying a phone number", BLOCKED(bad), `status=${bad.status}`);

  const still = await p.silentQuery.findUnique({ where: { id: q.id }, select: { status: true, answerText: true } });
  check("the whisper stays PENDING (nothing half-answered)", still?.status === "PENDING", JSON.stringify(still));
  check("no answerText was persisted", !still?.answerText, String(still?.answerText));

  const good = await post(`/api/provider/concierge-sessions/${anon.id}/message`, f.provAuth,
    { content: "Yes, we work with international parents all the time.", silentQueryId: q.id });
  check("a clean whisper answer goes through", good.status === 200, `status=${good.status}`);
}

// ─── CG-06: provider auto-reply, rejected when SAVED ───────────────────────
// The auto-reply deliberately bypasses the send endpoint, so without this a bad
// template would reach every parent who books.
async function cg06() {
  const f = await getFixture();
  const p = await db();
  // Scoped to THIS test's own freshly-created staff login, not the org-wide
  // default: the org default is a real row a provider may already own, and the
  // unique scope guard would reject a second one, failing the test for a reason
  // that has nothing to do with the guard.
  const create = (body: string) =>
    post("/api/provider-auto-replies", f.provAuth, { providerId: f.providerId, staffUserId: f.provUserId, body });

  const bad = await create("Hi {{parent_name}}, looking forward to it. Call me any time on 917-224-7761.");
  check("rejects a template carrying a phone number", bad.status === 422 && bad.body?.code === "CONTACT_INFO_BLOCKED",
    `status=${bad.status} code=${bad.body?.code}`);

  const badLink = await create("Hi {{parent_name}}, join me at calendly.com/brightfutures/intro");
  check("rejects a template carrying an outside booking link", badLink.status === 422, `status=${badLink.status}`);

  const ok = await create("Hi {{parent_name}}, this is {{staff_name}} from {{provider_name}}. Looking forward to {{call_time}}.");
  check("accepts a clean template", ok.status === 200 || ok.status === 201,
    `status=${ok.status} ${JSON.stringify(ok.body).slice(0, 120)}`);
  if (ok.body?.id) await p.providerAutoReply.delete({ where: { id: ok.body.id } }).catch(() => {});
}

// ─── CG-07: the other paths that reach an external inbox ───────────────────
async function cg07() {
  const f = await getFixture();
  const p = await db();

  // Booking notes are printed verbatim in the provider's notification email and
  // copied into the external calendar event description.
  const cfg = await p.scheduleConfig.findFirst({
    where: { bookingPageSlug: { not: null } },
    select: { bookingPageSlug: true },
  });
  if (cfg?.bookingPageSlug) {
    const r = await fetch(`${BASE}/api/calendar/book/${cfg.bookingPageSlug}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheduledAt: new Date(Date.now() + 7 * 864e5).toISOString(),
        name: "Guard Parent", email: f.parentEmail, timezone: "America/New_York",
        notes: "Please call me on 917-224-7761 instead",
      }),
    });
    const body = await r.json().catch(() => ({} as any));
    check("blocks contact details in booking notes", r.status === 422 && body?.code === "CONTACT_INFO_BLOCKED",
      `status=${r.status} code=${body?.code}`);
  } else {
    check("booking-notes guard (skipped: no public booking page in this DB)", true);
  }

  // The provider's public review reply was never screened, while the review body
  // always was.
  const review = await p.providerReview.findFirst({
    where: { providerId: f.providerId, visibility: "PUBLIC" },
    select: { id: true },
  });
  if (review) {
    const r = await post(`/api/reviews/${review.id}/reply`, f.provAuth, { text: "Thanks! Reach us any time at 917-224-7761." });
    check("blocks contact details in a public review reply", r.status === 422, `status=${r.status}`);
  } else {
    check("review-reply guard (skipped: no public review for this provider)", true);
  }
}

const CASES: { id: string; name: string; run: () => Promise<void> }[] = [
  { id: "CG-01", name: "Parent to provider: every obfuscated form blocked, ordinary text is not", run: cg01 },
  { id: "CG-02", name: "The rejection explains itself and echoes nothing back", run: cg02 },
  { id: "CG-03", name: "THE EVA EXCEPTION: private thread accepts, shared thread blocks", run: cg03 },
  { id: "CG-04", name: "Provider to parent is guarded the same way", run: cg04 },
  { id: "CG-05", name: "A whisper answer cannot smuggle a number through Eva's relay", run: cg05 },
  { id: "CG-06", name: "A provider auto-reply is rejected when saved, not silently at send", run: cg06 },
  { id: "CG-07", name: "Booking notes and public review replies are guarded too", run: cg07 },
];

async function cleanup() {
  try {
    const p = await db();
    await p.silentQuery.deleteMany({ where: { sessionId: { in: trash.sessionIds } } }).catch(() => {});
    await p.aiChatMessage.deleteMany({ where: { sessionId: { in: trash.sessionIds } } }).catch(() => {});
    await p.aiChatSession.deleteMany({ where: { id: { in: trash.sessionIds } } }).catch(() => {});
    await p.booking.deleteMany({ where: { parentUserId: { in: trash.userIds } } }).catch(() => {});
    // Auto-reply templates are scoped to the test's own staff login, so this
    // cleans up even when a case fails partway through.
    await p.providerAutoReply.deleteMany({ where: { staffUserId: { in: trash.userIds } } }).catch(() => {});
    await p.user.deleteMany({ where: { id: { in: trash.userIds } } }).catch(() => {});
  } catch { /* best effort */ }
}

(async () => {
  const wanted = filterId ? filterId.split(",").map((s) => s.trim().toUpperCase()) : null;
  const toRun = wanted ? CASES.filter((c) => wanted.includes(c.id)) : CASES;
  console.log(`🛡  Contact Guard (end to end)`);
  console.log(`   Running: ${toRun.length} of ${CASES.length} cases\n`);

  const suiteStart = Date.now();
  await reportToDashboard({ type: "run_start", testIds: toRun.map((c) => c.id), filter: "contact-guard" });
  for (const c of toRun) {
    caseFails = [];
    console.log(`  ▶ Starting: ${c.id}`);
    console.log(`    ${c.name}`);
    await reportToDashboard({ type: "test_start", id: c.id });
    const t0 = Date.now();
    // No retry: these are deterministic. A retry would only hide a real bug.
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
