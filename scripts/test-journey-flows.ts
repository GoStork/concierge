/**
 * GoStork - Transactional Journey E2E (JR-xx)
 *
 * The conversational suites (test-freetext-requests, test-ai-concierge) cover
 * what Eva SAYS. This one covers what actually MOVES: booking -> cost sheet ->
 * acknowledgement -> invoice -> payment -> agreement -> signature -> handoff.
 *
 * Every step is driven through the REAL endpoints a provider/parent would hit,
 * never by seeding the resulting row. The core assertion at each step is not
 * just "the record exists" but "the artifact landed in a chat the PARENT can
 * actually see" - the two routing bugs found on Jul 24 (cost-sheet draft and
 * prep bundle landing in the wrong thread) both lived exactly here and were
 * found by reading code, not by a test.
 *
 * Usage:
 *   TEST_BASE_URL=http://localhost:5001 npx tsx scripts/test-journey-flows.ts
 *   TEST_BASE_URL=http://localhost:5001 npx tsx scripts/test-journey-flows.ts --id=JR-01
 */

import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";

const envContent = fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
const dbUrl =
  envContent.match(/^DIRECT_URL="?([^"\n]+)"?/m)?.[1] ||
  envContent.match(/^DATABASE_URL="?([^"\n]+)"?/m)?.[1];
const BASE = process.env.TEST_BASE_URL || "http://localhost:5001";
const MATCHMAKER_ID = "f590dbcb-011e-43d9-98d0-1157c3cfa1e2";
const TEST_PASSWORD = "Test1234!x";
const filterId = process.argv.slice(2).find((a) => a.startsWith("--id="))?.split("=")[1];

let caseFails: string[] = [];
let totalPass = 0;
let totalFail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`      ${ok ? "✓" : "✗"} ${label}${detail ? ` :: ${String(detail).replace(/\n/g, " | ").slice(0, 180)}` : ""}`);
  if (!ok) caseFails.push(`${label}${detail ? ` :: ${String(detail).replace(/\n/g, " | ").slice(0, 160)}` : ""}`);
}

async function reportToDashboard(event: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${BASE}/api/admin/test-runner/event`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event),
    });
  } catch { /* best-effort */ }
}

async function jfetch(url: string, opts: RequestInit): Promise<Response> {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${(await res.text()).slice(0, 220)}`);
  return res;
}

async function login(email: string): Promise<Record<string, string>> {
  const res = await jfetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  const body: any = await res.json();
  return body?.token ? { Authorization: `Bearer ${body.token}` } : { Cookie: res.headers.get("set-cookie") || "" };
}

interface Fixture {
  parentUserId: string; parentAcctId: string; parentAuth: Record<string, string>;
  providerId: string; providerUserId: string; providerName: string; providerAuth: Record<string, string>;
  sessionId: string;
}

/** Parent + provider + an already-booked 3-way session (the post-booking world). */
async function buildFixture(db: Client, tag: string): Promise<Fixture> {
  const stamp = Date.now();
  const parentEmail = `test-${tag}-parent-${stamp}@gostork-test.com`;
  const providerEmail = `test-${tag}-prov-${stamp}@gostork-test.com`;
  const providerName = `ZZ Test Agency ${tag} ${stamp}`;

  for (const [email, name] of [[parentEmail, `JR Parent ${tag}`], [providerEmail, `JR Prov ${tag}`]]) {
    await jfetch(`${BASE}/api/users`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: TEST_PASSWORD, name }),
    });
  }
  const pr = await db.query(`SELECT id, "parentAccountId" FROM "User" WHERE email=$1`, [parentEmail]);
  const parentUserId = pr.rows[0].id;
  let parentAcctId = pr.rows[0].parentAccountId;
  if (!parentAcctId) {
    const a = await db.query(`INSERT INTO "ParentAccount" (id,"createdAt","updatedAt") VALUES (gen_random_uuid(),now(),now()) RETURNING id`);
    parentAcctId = a.rows[0].id;
    await db.query(`UPDATE "User" SET "parentAccountId"=$1, state='California', city='Los Angeles' WHERE id=$2`, [parentAcctId, parentUserId]);
  }
  await db.query(
    `INSERT INTO "IntendedParentProfile" (id,"parentAccountId","interestedServices","createdAt","updatedAt")
     VALUES (gen_random_uuid(),$1,ARRAY['Surrogate'],now(),now()) ON CONFLICT ("parentAccountId") DO NOTHING`, [parentAcctId]);

  const prov = await db.query(
    `INSERT INTO "Provider" (id,name,"createdAt","updatedAt") VALUES (gen_random_uuid(),$1,now(),now()) RETURNING id`, [providerName]);
  const providerId = prov.rows[0].id;
  const pu = await db.query(`SELECT id FROM "User" WHERE email=$1`, [providerEmail]);
  const providerUserId = pu.rows[0].id;
  await db.query(
    `UPDATE "User" SET "providerId"=$1, roles=ARRAY['PROVIDER_ADMIN']::text[], "firstName"='Robin', "lastName"='Reed' WHERE id=$2`,
    [providerId, providerUserId]);

  // Referral fee config - the invoice endpoint legitimately refuses to issue
  // without one ("No active referral fee configured for this provider"), which
  // is the same guard a real provider hits before GoStork admin sets up billing.
  await db.query(
    `INSERT INTO "ReferralFeeConfig" (id,"providerId","serviceType","feeType","flatAmount","defaultServiceAmount","parentPaysBasis","isActive","createdAt","updatedAt")
     VALUES (gen_random_uuid(),$1,'SURROGACY','FLAT',100000,500000,'DEFAULT_FIRST_PAYMENT',true,now(),now())`,
    [providerId]);

  // The shared parent-provider thread a real booking creates.
  const s = await db.query(
    `INSERT INTO "AiChatSession" (id,"userId","providerId",status,"sessionType",title,"matchmakerId","providerJoinedAt","tier2Active","createdAt","updatedAt")
     VALUES (gen_random_uuid(),$1,$2,'CONSULTATION_BOOKED','PARENT',$3,$4,now(),true,now(),now()) RETURNING id`,
    [parentUserId, providerId, `${providerName} Consultation`, MATCHMAKER_ID]);

  return {
    parentUserId, parentAcctId, parentAuth: await login(parentEmail),
    providerId, providerUserId, providerName, providerAuth: await login(providerEmail),
    sessionId: s.rows[0].id,
  };
}

async function destroyFixture(db: Client, f: Fixture) {
  await db.query(`DELETE FROM "Agreement" WHERE "parentUserId"=$1`, [f.parentUserId]).catch(() => {});
  await db.query(`DELETE FROM "Invoice" WHERE "parentUserId"=$1`, [f.parentUserId]).catch(() => {});
  await db.query(`DELETE FROM "ProviderQuote" WHERE "parentUserId"=$1`, [f.parentUserId]).catch(() => {});
  await db.query(`DELETE FROM "Booking" WHERE "parentUserId"=$1`, [f.parentUserId]).catch(() => {});
  await db.query(`DELETE FROM "SilentQuery" WHERE "parentUserId"=$1`, [f.parentUserId]).catch(() => {});
  await db.query(`DELETE FROM "AiChatMessage" WHERE "sessionId" IN (SELECT id FROM "AiChatSession" WHERE "userId"=$1)`, [f.parentUserId]);
  await db.query(`DELETE FROM "AiChatSession" WHERE "userId"=$1 OR "providerId"=$2`, [f.parentUserId, f.providerId]);
  await db.query(`DELETE FROM "InAppNotification" WHERE "userId" IN ($1,$2)`, [f.parentUserId, f.providerUserId]).catch(() => {});
  await db.query(`DELETE FROM "IntendedParentProfile" WHERE "parentAccountId"=$1`, [f.parentAcctId]);
  await db.query(`DELETE FROM "User" WHERE id IN ($1,$2)`, [f.parentUserId, f.providerUserId]);
  await db.query(`DELETE FROM "ParentAccount" WHERE id=$1`, [f.parentAcctId]).catch(() => {});
  await db.query(`DELETE FROM "ReferralFeeConfig" WHERE "providerId"=$1`, [f.providerId]).catch(() => {});
  await db.query(`DELETE FROM "Provider" WHERE id=$1`, [f.providerId]).catch(() => {});
}

/**
 * Legal Name + Tax ID + a COMPLETED W-9 - the compliance gate every provider
 * must clear before GoStork will let them invoice a parent.
 */
async function completeLegalIdentity(db: Client, providerId: string) {
  await db.query(
    `INSERT INTO "ProviderLegalIdentity" (id,"providerId","legalName","taxId","taxIdType","taxClassification","businessType","createdAt","updatedAt")
     VALUES (gen_random_uuid(),$1,'ZZ Test Agency LLC','12-3456789','ein','LLC','company',now(),now())
     ON CONFLICT ("providerId") DO UPDATE SET "legalName"=EXCLUDED."legalName", "taxId"=EXCLUDED."taxId"`,
    [providerId]);
  await db.query(
    `INSERT INTO "ProviderW9" (id,"providerId",status,"completedAt","createdAt","updatedAt")
     VALUES (gen_random_uuid(),$1,'COMPLETED',now(),now(),now())
     ON CONFLICT ("providerId") DO UPDATE SET status='COMPLETED', "completedAt"=now()`,
    [providerId]);
}

/** What the PARENT's own message feed returns - the real visibility check. */
async function parentSeesInChat(f: Fixture, sessionId: string): Promise<any[]> {
  const res = await jfetch(`${BASE}/api/ai-concierge/session/${sessionId}/messages`, { headers: f.parentAuth });
  const data: any = await res.json();
  return Array.isArray(data) ? data : data.messages || [];
}

// ─── JR-01: the full money + commitment spine ────────────────────────────────
async function jr01(db: Client) {
  const f = await buildFixture(db, "jr01");
  try {
    // 1. Provider sends a cost sheet through the real endpoint.
    await jfetch(`${BASE}/api/sessions/${f.sessionId}/cost-sheet`, {
      method: "POST", headers: { "Content-Type": "application/json", ...f.providerAuth },
      body: JSON.stringify({ totalCostCents: 4250000, notes: "Agency programme fee" }),
    });
    const quote = await db.query(`SELECT id, "totalCostCents", "parentAcknowledgedAt" FROM "ProviderQuote" WHERE "sessionId"=$1`, [f.sessionId]);
    check("cost sheet created via the provider endpoint", quote.rowCount === 1 && quote.rows[0].totalCostCents === 4250000, `rows=${quote.rowCount}`);

    let visible = await parentSeesInChat(f, f.sessionId);
    check("parent can SEE the cost sheet in their chat",
      visible.some((m: any) => m.uiCardType === "cost_sheet"), JSON.stringify(visible.map((m: any) => m.uiCardType)));

    // 2. Parent acknowledges it.
    await jfetch(`${BASE}/api/sessions/${f.sessionId}/quotes/${quote.rows[0].id}/acknowledge`, {
      method: "POST", headers: { "Content-Type": "application/json", ...f.parentAuth }, body: "{}",
    });
    const ack = await db.query(`SELECT "parentAcknowledgedAt" FROM "ProviderQuote" WHERE id=$1`, [quote.rows[0].id]);
    check("acknowledgement recorded", !!ack.rows[0].parentAcknowledgedAt, String(ack.rows[0].parentAcknowledgedAt));

    // 3. A provider who has not completed Legal Identity CANNOT invoice.
    // This is a real compliance gate (Legal Name + Tax ID + signed W-9),
    // and it must hold before we satisfy it and continue.
    let blocked = "";
    try {
      await jfetch(`${BASE}/api/sessions/${f.sessionId}/invoice`, {
        method: "POST", headers: { "Content-Type": "application/json", ...f.providerAuth },
        body: JSON.stringify({ description: "Agency retainer" }),
      });
    } catch (e: any) { blocked = e?.message || ""; }
    check("invoice is BLOCKED until Legal Identity + W-9 are complete",
      /Legal Identity is incomplete/i.test(blocked), blocked.slice(0, 120));
    check("no invoice row is created while the provider is blocked",
      (await db.query(`SELECT id FROM "Invoice" WHERE "sessionId"=$1`, [f.sessionId])).rowCount === 0);

    await completeLegalIdentity(db, f.providerId);

    // 4. Provider raises the invoice.
    await jfetch(`${BASE}/api/sessions/${f.sessionId}/invoice`, {
      method: "POST", headers: { "Content-Type": "application/json", ...f.providerAuth },
      body: JSON.stringify({ description: "Agency retainer" }),
    });
    const inv = await db.query(`SELECT id, status, "paymentToken", "serviceAmount" FROM "Invoice" WHERE "sessionId"=$1`, [f.sessionId]);
    check("invoice created via the provider endpoint", inv.rowCount === 1, `rows=${inv.rowCount} status=${inv.rows[0]?.status}`);
    check("invoice carries a payment token", !!inv.rows[0]?.paymentToken);

    visible = await parentSeesInChat(f, f.sessionId);
    check("parent can SEE the invoice in their chat",
      visible.some((m: any) => m.uiCardType === "invoice"), JSON.stringify(visible.map((m: any) => m.uiCardType)));

    // 5. Payment (mock endpoint - the same code path Stripe's webhook drives).
    await jfetch(`${BASE}/api/billing/mock-payment-success`, {
      method: "POST", headers: { "Content-Type": "application/json", ...f.parentAuth },
      body: JSON.stringify({ paymentToken: inv.rows[0].paymentToken }),
    });
    await new Promise((r) => setTimeout(r, 2500));
    const paid = await db.query(`SELECT status, "paidAt" FROM "Invoice" WHERE id=$1`, [inv.rows[0].id]);
    check("invoice reaches PAID", paid.rows[0].status === "PAID" && !!paid.rows[0].paidAt, `${paid.rows[0].status}`);

    // 6. Handoff must NOT fire on payment alone - a signed agreement is
    // required too. Paying is a big commitment, but it is not the handoff.
    const sess = await db.query(`SELECT "handoffCompletedAt" FROM "AiChatSession" WHERE id=$1`, [f.sessionId]);
    check("handoff does NOT fire on payment alone (agreement still unsigned)",
      !sess.rows[0].handoffCompletedAt, String(sess.rows[0].handoffCompletedAt));

    const noHandoff = JSON.stringify(await parentSeesInChat(f, f.sessionId)).toLowerCase();
    check("parent is not told the handoff is complete before signature",
      !/handoff is complete|officially matched/.test(noHandoff));
  } finally {
    await destroyFixture(db, f);
  }
}

// ─── JR-02: the completion ordering - signed FIRST, then paid ────────────────
// Both artefacts are required for handoff, and either one can land last. JR-01
// covers paid-last (must not fire); this covers signed-first/paid-last, where
// the payment path is what completes the handoff. Neither case imports server
// code - both drive the endpoints production drives.
async function jr02(db: Client) {
  const f = await buildFixture(db, "jr02");
  try {
    await completeLegalIdentity(db, f.providerId);
    await jfetch(`${BASE}/api/sessions/${f.sessionId}/cost-sheet`, {
      method: "POST", headers: { "Content-Type": "application/json", ...f.providerAuth },
      body: JSON.stringify({ totalCostCents: 3800000, notes: "Agency programme fee" }),
    });
    await jfetch(`${BASE}/api/sessions/${f.sessionId}/invoice`, {
      method: "POST", headers: { "Content-Type": "application/json", ...f.providerAuth },
      body: JSON.stringify({ description: "Agency retainer" }),
    });
    const inv = await db.query(`SELECT id,"paymentToken" FROM "Invoice" WHERE "sessionId"=$1`, [f.sessionId]);

    // The agreement is signed BEFORE the money lands (PandaDoc is external, so
    // this is the state its webhook writes).
    await db.query(
      `INSERT INTO "Agreement" (id,"providerId","parentUserId","sessionId",status,"documentType","signedAt","createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,$3,'SIGNED','Agreement',now(),now(),now())`,
      [f.providerId, f.parentUserId, f.sessionId]);

    let sess = await db.query(`SELECT "handoffCompletedAt" FROM "AiChatSession" WHERE id=$1`, [f.sessionId]);
    check("handoff does NOT fire on a signed agreement alone (invoice unpaid)",
      !sess.rows[0].handoffCompletedAt, String(sess.rows[0].handoffCompletedAt));

    // Payment closes the loop - and the payment path is what runs the check.
    await jfetch(`${BASE}/api/billing/mock-payment-success`, {
      method: "POST", headers: { "Content-Type": "application/json", ...f.parentAuth },
      body: JSON.stringify({ paymentToken: inv.rows[0].paymentToken }),
    });
    await new Promise((r) => setTimeout(r, 4000));

    sess = await db.query(`SELECT "handoffCompletedAt" FROM "AiChatSession" WHERE id=$1`, [f.sessionId]);
    check("handoff completes once BOTH a signed agreement and a paid invoice exist",
      !!sess.rows[0].handoffCompletedAt, String(sess.rows[0].handoffCompletedAt));
    const firstStamp = sess.rows[0].handoffCompletedAt;

    const visible = await parentSeesInChat(f, f.sessionId);
    const blob = JSON.stringify(visible).toLowerCase();
    check("parent is actually told the journey has moved on",
      /handoff|officially|congratulations|all set|welcome|matched/.test(blob), `${visible.length} msgs`);

    // The parent must never read about themselves in the third person - the
    // dual-audience rule. The provider-facing copy lives in providerContent.
    const parentText = visible.map((m: any) => String(m.content || "")).join(" ");
    check("handoff copy addresses the parent directly, not in third person",
      !new RegExp(`JR Parent jr02 (has|is|picked|selected)`, "i").test(parentText),
      parentText.slice(0, 160));

    // Payment webhooks retry, and PandaDoc can fire the same check again.
    await jfetch(`${BASE}/api/billing/mock-payment-success`, {
      method: "POST", headers: { "Content-Type": "application/json", ...f.parentAuth },
      body: JSON.stringify({ paymentToken: inv.rows[0].paymentToken }),
    }).catch(() => { /* an already-paid invoice may legitimately refuse */ });
    await new Promise((r) => setTimeout(r, 2500));
    sess = await db.query(`SELECT "handoffCompletedAt" FROM "AiChatSession" WHERE id=$1`, [f.sessionId]);
    check("handoff is idempotent - a replayed payment does not re-stamp it",
      String(sess.rows[0].handoffCompletedAt) === String(firstStamp), String(sess.rows[0].handoffCompletedAt));

    // The handoff message is a plain celebration message (no uiCardType), so
    // count the copy itself - keying on a card type silently counts zero and
    // "passes" no matter how many times the handoff fires.
    const dupes = await db.query(
      `SELECT count(*)::int AS n FROM "AiChatMessage"
       WHERE "sessionId"=$1 AND content ILIKE '%officially begins%'`, [f.sessionId]);
    check("the congratulations message is posted exactly once", dupes.rows[0].n === 1, `count=${dupes.rows[0].n}`);

    // Dual-audience rule: the shared thread is read by both sides, so the
    // provider-facing wording must live in uiCardData.providerContent.
    const dual = await db.query(
      `SELECT "uiCardData"->>'providerContent' AS pc FROM "AiChatMessage"
       WHERE "sessionId"=$1 AND content ILIKE '%officially begins%' LIMIT 1`, [f.sessionId]);
    check("handoff message carries provider-facing copy for the provider side",
      !!dual.rows[0]?.pc, String(dual.rows[0]?.pc).slice(0, 120));
  } finally {
    await destroyFixture(db, f);
  }
}

const CASES: { id: string; name: string; run: (db: Client) => Promise<void> }[] = [
  { id: "JR-01", name: "Cost sheet -> acknowledge -> legal-identity gate -> invoice -> payment (no handoff yet)", run: jr01 },
  { id: "JR-02", name: "Signed agreement + payment completes the handoff, once and only once", run: jr02 },
];

(async () => {
  const wanted = filterId ? filterId.split(",").map((s) => s.trim().toUpperCase()) : null;
  const toRun = wanted ? CASES.filter((c) => wanted.includes(c.id)) : CASES;
  console.log(`🧪 Transactional Journey E2E - base: ${BASE}`);
  console.log(`   Running: ${toRun.length} of ${CASES.length} cases\n`);

  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const { purgeLeftoverTestUsersPg } = await import("./lib/purge-test-users.js");
  await purgeLeftoverTestUsersPg(db).catch((e: any) => console.warn("[purge-test-users] sweep failed:", e?.message || e));
  const suiteStart = Date.now();
  await reportToDashboard({ type: "run_start", testIds: toRun.map((c) => c.id), filter: "journey" });
  try {
    for (const c of toRun) {
      caseFails = [];
      console.log(`  ▶ Starting: ${c.id}`);
      console.log(`    ${c.name}`);
      await reportToDashboard({ type: "test_start", id: c.id });
      const t0 = Date.now();
      try { await c.run(db); } catch (e: any) { caseFails.push(`scenario crashed: ${(e?.message || String(e)).slice(0, 220)}`); }
      if (caseFails.length > 0) {
        const first = [...caseFails];
        console.log(`  🔁 ${c.id} flaked - retrying once (was: ${first[0]})`);
        caseFails = [];
        try { await c.run(db); } catch (e: any) { caseFails.push(`scenario crashed: ${(e?.message || String(e)).slice(0, 220)}`); }
        if (caseFails.length === 0) console.log(`  ✨ ${c.id} recovered on retry (first attempt was a flake)`);
        else caseFails = caseFails.map((x) => `FAILED TWICE. attempt1: ${first[0]} | attempt2: ${x}`);
      }
      const durationMs = Date.now() - t0;
      const secs = (durationMs / 1000).toFixed(1);
      if (caseFails.length === 0) {
        totalPass++; console.log(`  ✅ ${c.id} PASS (${secs}s)`);
        await reportToDashboard({ type: "test_pass", id: c.id, durationMs });
      } else {
        totalFail++;
        for (const x of caseFails) console.log(`     [${c.id}] ${x}`);
        console.log(`  ❌ ${c.id} FAIL (${secs}s)`);
        await reportToDashboard({ type: "test_fail", id: c.id, durationMs, errors: caseFails });
      }
    }
  } finally { await db.end(); }
  const totalSecs = Math.round((Date.now() - suiteStart) / 1000);
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${totalPass} passed, ${totalFail} failed (${totalSecs}s total)`);
  await reportToDashboard({ type: "run_done", passCount: totalPass, failCount: totalFail, durationMs: Date.now() - suiteStart });
  process.exit(totalFail ? 1 : 0);
})();
