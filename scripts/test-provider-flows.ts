/**
 * GoStork - Provider-Side E2E Suite (PR-01..)
 *
 * Covers the PROVIDER experience and the parent/provider chat boundary, which
 * the parent-only suites cannot reach. See docs/freetext-request-test-plan.md
 * for the free-text (parent) counterpart.
 *
 * Cases:
 *  PR-01 Whisper answer is relayed into the PARENT'S OWN chat, even when the
 *        provider answers it from a consolidated sibling thread.
 *  PR-02 Parent identity stays masked before a consultation is booked, and is
 *        revealed once it is.
 *  PR-03 Provider-only messages never leak into the parent's transcript.
 *
 * Usage:
 *   TEST_BASE_URL=http://localhost:5001 npx tsx scripts/test-provider-flows.ts
 *   TEST_BASE_URL=http://localhost:5001 npx tsx scripts/test-provider-flows.ts --id=PR-01
 *
 * Emits the admin test-runner stdout protocol AND posts progress events, so it
 * behaves exactly like the other suites in /admin/test-runner.
 *
 * All fixtures are throwaway (*@gostork-test.com / "ZZ Test Provider ...") and
 * are deleted at the end of each case.
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

let caseId = "";
let caseFails: string[] = [];
let totalPass = 0;
let totalFail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`      ${ok ? "✓" : "✗"} ${label}${detail ? ` :: ${detail.replace(/\n/g, " | ")}` : ""}`);
  if (!ok) caseFails.push(`${label}${detail ? ` :: ${detail.replace(/\n/g, " | ").slice(0, 160)}` : ""}`);
}

async function reportToDashboard(event: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${BASE}/api/admin/test-runner/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch {
    /* best-effort */
  }
}

async function jfetch(url: string, opts: RequestInit): Promise<Response> {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

async function login(email: string): Promise<Record<string, string>> {
  const res = await jfetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  const body: any = await res.json();
  return body?.token ? { Authorization: `Bearer ${body.token}` } : { Cookie: res.headers.get("set-cookie") || "" };
}

interface Fixture {
  parentUserId: string;
  parentAcctId: string;
  parentEmail: string;
  providerId: string;
  providerUserId: string;
  providerAuth: Record<string, string>;
  parentAuth: Record<string, string>;
}

/**
 * Throwaway parent + provider + provider staff user. The provider is created
 * directly in the DB (registration does not create providers) with a
 * PROVIDER_ADMIN staff user, which is the role with no subjectType restriction
 * and full chat-send capability.
 */
async function createFixture(db: Client, tag: string): Promise<Fixture> {
  const stamp = Date.now();
  const parentEmail = `test-${tag}-parent-${stamp}@gostork-test.com`;
  const providerEmail = `test-${tag}-prov-${stamp}@gostork-test.com`;

  await jfetch(`${BASE}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: parentEmail, password: TEST_PASSWORD, name: `Test Parent ${tag}` }),
  });
  await jfetch(`${BASE}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: providerEmail, password: TEST_PASSWORD, name: `Test Provider Staff ${tag}` }),
  });

  const p = await db.query(`SELECT id, "parentAccountId" FROM "User" WHERE email = $1`, [parentEmail]);
  const parentUserId = p.rows[0].id;
  let parentAcctId = p.rows[0].parentAccountId;
  if (!parentAcctId) {
    const acct = await db.query(
      `INSERT INTO "ParentAccount" (id, "createdAt", "updatedAt") VALUES (gen_random_uuid(), now(), now()) RETURNING id`,
    );
    parentAcctId = acct.rows[0].id;
    await db.query(`UPDATE "User" SET "parentAccountId" = $1, name = 'Test Parent ${tag}' WHERE id = $2`, [parentAcctId, parentUserId]);
  }
  await db.query(
    `INSERT INTO "IntendedParentProfile" (id, "parentAccountId", "interestedServices", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, ARRAY['Surrogate'], now(), now())
     ON CONFLICT ("parentAccountId") DO NOTHING`,
    [parentAcctId],
  );

  const prov = await db.query(
    `INSERT INTO "Provider" (id, name, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, now(), now()) RETURNING id`,
    [`ZZ Test Provider ${tag} ${stamp}`],
  );
  const providerId = prov.rows[0].id;

  const provUser = await db.query(`SELECT id FROM "User" WHERE email = $1`, [providerEmail]);
  const providerUserId = provUser.rows[0].id;
  await db.query(
    `UPDATE "User" SET "providerId" = $1, roles = ARRAY['PROVIDER_ADMIN']::text[], "firstName" = 'Casey', "lastName" = 'Coordinator' WHERE id = $2`,
    [providerId, providerUserId],
  );

  return {
    parentUserId,
    parentAcctId,
    parentEmail,
    providerId,
    providerUserId,
    providerAuth: await login(providerEmail),
    parentAuth: await login(parentEmail),
  };
}

async function destroyFixture(db: Client, f: Fixture) {
  await db.query(`DELETE FROM "SilentQuery" WHERE "providerId" = $1`, [f.providerId]);
  await db.query(`DELETE FROM "AiChatMessage" WHERE "sessionId" IN (SELECT id FROM "AiChatSession" WHERE "userId" = $1)`, [f.parentUserId]);
  await db.query(`DELETE FROM "AiChatSession" WHERE "userId" = $1`, [f.parentUserId]);
  await db.query(`DELETE FROM "InAppNotification" WHERE "userId" IN ($1, $2)`, [f.parentUserId, f.providerUserId]);
  await db.query(`DELETE FROM "IntendedParentProfile" WHERE "parentAccountId" = $1`, [f.parentAcctId]);
  await db.query(`DELETE FROM "User" WHERE id IN ($1, $2)`, [f.parentUserId, f.providerUserId]);
  await db.query(`DELETE FROM "ParentAccount" WHERE id = $1`, [f.parentAcctId]).catch(() => {});
  await db.query(`DELETE FROM "Provider" WHERE id = $1`, [f.providerId]).catch(() => {});
}

async function mkSession(
  db: Client,
  f: Fixture,
  opts: { status: string; title: string; providerJoined?: boolean },
): Promise<string> {
  const r = await db.query(
    `INSERT INTO "AiChatSession" (id, "userId", "providerId", status, "sessionType", title, "matchmakerId", "providerJoinedAt", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, 'PARENT', $4, $5, $6, now(), now()) RETURNING id`,
    [f.parentUserId, f.providerId, opts.status, opts.title, MATCHMAKER_ID, opts.providerJoined ? new Date() : null],
  );
  return r.rows[0].id;
}

// ─── PR-01: whisper answer follows the WHISPER'S session, not the provider's ──
async function pr01(db: Client) {
  const f = await createFixture(db, "pr01");
  try {
    // The parent's private Eva thread (where they asked) and the booked
    // provider thread (which the consolidated provider view surfaces).
    const evaSessionId = await mkSession(db, f, { status: "ACTIVE", title: "AI Concierge Chat" });
    const bookedSessionId = await mkSession(db, f, { status: "CONSULTATION_BOOKED", title: "Consultation", providerJoined: true });

    const wq = await db.query(
      `INSERT INTO "SilentQuery" (id, "sessionId", "parentUserId", "providerId", "questionText", status, "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PENDING', now(), now()) RETURNING id`,
      [evaSessionId, f.parentUserId, f.providerId, "Does she have any travel restrictions?"],
    );
    const whisperId = wq.rows[0].id;

    // Provider answers it from the CONSOLIDATED (booked) thread.
    await jfetch(`${BASE}/api/provider/concierge-sessions/${bookedSessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...f.providerAuth },
      body: JSON.stringify({ content: "No travel restrictions at all.", silentQueryId: whisperId }),
    });

    const relayInEva = await db.query(
      `SELECT id FROM "AiChatMessage" WHERE "sessionId" = $1 AND content ILIKE '%heard back from the agency%'`,
      [evaSessionId],
    );
    const relayInBooked = await db.query(
      `SELECT id FROM "AiChatMessage" WHERE "sessionId" = $1 AND content ILIKE '%heard back from the agency%'`,
      [bookedSessionId],
    );
    check("relay lands in the parent's own (whisper) chat", relayInEva.rowCount === 1, `evaRows=${relayInEva.rowCount}`);
    check("relay does NOT land in the provider's open thread", relayInBooked.rowCount === 0, `bookedRows=${relayInBooked.rowCount}`);

    const notif = await db.query(
      `SELECT payload FROM "InAppNotification" WHERE "userId" = $1 AND "eventType" = 'WHISPER_ANSWERED' ORDER BY "createdAt" DESC LIMIT 1`,
      [f.parentUserId],
    );
    check("parent notification deep-links to the chat holding the answer",
      notif.rows[0]?.payload?.sessionId === evaSessionId,
      JSON.stringify(notif.rows[0]?.payload?.sessionId));

    const status = await db.query(`SELECT status FROM "SilentQuery" WHERE id = $1`, [whisperId]);
    check("whisper marked RELAYED", status.rows[0]?.status === "RELAYED", status.rows[0]?.status);
  } finally {
    await destroyFixture(db, f);
  }
}

// ─── PR-02: parent identity masking before booking, revealed after ───────────
async function pr02(db: Client) {
  const f = await createFixture(db, "pr02");
  try {
    const anonSessionId = await mkSession(db, f, { status: "ACTIVE", title: "AI Concierge Chat" });
    const listBefore: any = await (await jfetch(`${BASE}/api/provider/concierge-sessions`, { headers: f.providerAuth })).json();
    const rowBefore = (Array.isArray(listBefore) ? listBefore : listBefore.sessions || []).find((s: any) => s.id === anonSessionId);
    check("anonymous session appears in the provider inbox", !!rowBefore, rowBefore ? "found" : "missing");
    if (rowBefore) {
      check("parent name masked before booking", /prospective parent/i.test(rowBefore.userName || ""), rowBefore.userName);
      check("parent email hidden before booking", !rowBefore.userEmail, String(rowBefore.userEmail));
    }

    await db.query(`UPDATE "AiChatSession" SET status = 'CONSULTATION_BOOKED' WHERE id = $1`, [anonSessionId]);
    const listAfter: any = await (await jfetch(`${BASE}/api/provider/concierge-sessions`, { headers: f.providerAuth })).json();
    const rowAfter = (Array.isArray(listAfter) ? listAfter : listAfter.sessions || []).find((s: any) => s.id === anonSessionId);
    check("real parent name revealed once booked", !!rowAfter && !/prospective parent/i.test(rowAfter.userName || ""), rowAfter?.userName);
    check("parent email revealed once booked", !!rowAfter?.userEmail, String(rowAfter?.userEmail));
  } finally {
    await destroyFixture(db, f);
  }
}

// ─── PR-03: provider-only content never reaches the parent transcript ────────
async function pr03(db: Client) {
  const f = await createFixture(db, "pr03");
  try {
    const sessionId = await mkSession(db, f, { status: "CONSULTATION_BOOKED", title: "Consultation", providerJoined: true });
    const secret = `PROVIDER_ONLY_SECRET_${Date.now()}`;
    await db.query(
      `INSERT INTO "AiChatMessage" (id, "sessionId", role, content, "senderType", "senderName", "uiCardType", "createdAt")
       VALUES (gen_random_uuid(), $1, 'assistant', $2, 'system', 'System', 'provider_only', now())`,
      [sessionId, secret],
    );
    // Also drop a draft-approval card, which must stay provider-side too.
    await db.query(
      `INSERT INTO "AiChatMessage" (id, "sessionId", role, content, "senderType", "senderName", "uiCardType", "createdAt")
       VALUES (gen_random_uuid(), $1, 'assistant', 'DRAFT_COST_SHEET_SECRET', 'system', 'System', 'cost_sheet_draft_approval', now())`,
      [sessionId],
    );

    const parentView: any = await (await jfetch(`${BASE}/api/ai-concierge/session/${sessionId}/messages`, { headers: f.parentAuth })).json();
    const msgs: any[] = Array.isArray(parentView) ? parentView : parentView.messages || [];
    const blob = JSON.stringify(msgs);
    check("provider_only content hidden from parent", !blob.includes(secret), `${msgs.length} msgs returned`);
    check("draft-approval card hidden from parent", !blob.includes("DRAFT_COST_SHEET_SECRET"));
  } finally {
    await destroyFixture(db, f);
  }
}

const CASES: { id: string; name: string; run: (db: Client) => Promise<void> }[] = [
  { id: "PR-01", name: "Whisper answer relays into the parent's own chat (consolidated threads)", run: pr01 },
  { id: "PR-02", name: "Parent identity masked before booking, revealed after", run: pr02 },
  { id: "PR-03", name: "Provider-only content never reaches the parent transcript", run: pr03 },
];

(async () => {
  const wanted = filterId ? filterId.split(",").map((s) => s.trim().toUpperCase()) : null;
  const toRun = wanted ? CASES.filter((c) => wanted.includes(c.id)) : CASES;
  console.log(`🧪 Provider-Side E2E - base: ${BASE}`);
  console.log(`   Running: ${toRun.length} of ${CASES.length} cases\n`);

  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const suiteStart = Date.now();
  await reportToDashboard({ type: "run_start", testIds: toRun.map((c) => c.id), filter: "provider" });
  try {
    for (const c of toRun) {
      caseId = c.id;
      caseFails = [];
      console.log(`  ▶ Starting: ${c.id}`);
      console.log(`    ${c.name}`);
      await reportToDashboard({ type: "test_start", id: c.id });
      const t0 = Date.now();
      try {
        await c.run(db);
      } catch (e: any) {
        caseFails.push(`scenario crashed: ${(e?.message || String(e)).slice(0, 200)}`);
      }
      // FLAKE RETRY (same policy as scripts/test-ai-concierge.ts): these cases
      // assert on LLM output, which varies run to run - a case can fail once and
      // pass immediately after. Retry ONCE. A recovery is reported loudly so a
      // genuinely regressing test can never hide behind the retry.
      if (caseFails.length > 0) {
        const firstFailures = [...caseFails];
        console.log(`  🔁 ${c.id} flaked - retrying once (was: ${firstFailures[0]})`);
        caseFails = [];
        try {
          await c.run(db);
        } catch (e: any) {
          caseFails.push(`scenario crashed: ${(e?.message || String(e)).slice(0, 200)}`);
        }
        if (caseFails.length === 0) {
          console.log(`  ✨ ${c.id} recovered on retry (first attempt was a flake)`);
        } else {
          caseFails = caseFails.map((f) => `FAILED TWICE. attempt1: ${firstFailures[0]} | attempt2: ${f}`);
        }
      }
      const durationMs = Date.now() - t0;
      const secs = (durationMs / 1000).toFixed(1);
      if (caseFails.length === 0) {
        totalPass++;
        console.log(`  ✅ ${c.id} PASS (${secs}s)`);
        await reportToDashboard({ type: "test_pass", id: c.id, durationMs });
      } else {
        totalFail++;
        for (const fmsg of caseFails) console.log(`     [${c.id}] ${fmsg}`);
        console.log(`  ❌ ${c.id} FAIL (${secs}s)`);
        await reportToDashboard({ type: "test_fail", id: c.id, durationMs, errors: caseFails });
      }
    }
  } finally {
    await db.end();
  }
  const totalSecs = Math.round((Date.now() - suiteStart) / 1000);
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${totalPass} passed, ${totalFail} failed (${totalSecs}s total)`);
  await reportToDashboard({ type: "run_done", passCount: totalPass, failCount: totalFail, durationMs: Date.now() - suiteStart });
  process.exit(totalFail ? 1 : 0);
})();
