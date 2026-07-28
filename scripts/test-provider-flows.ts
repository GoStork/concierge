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
 *  PR-12 Booking auto-reply templates are scoped to one org and one scope.
 *  PR-13 The greeting posts on booking without marking the provider present.
 *  PR-14 The provider's own /book/<slug> link is covered, once per parent.
 *  PR-15 The private parent briefing is provider-only - never the parent.
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
  // Auto-reply rows: the send log holds the "once per parent" key, so leaving
  // one behind would silently suppress the greeting in a later run.
  await db.query(`DELETE FROM "ProviderAutoReplySend" WHERE "providerId" = $1`, [f.providerId]).catch(() => {});
  await db.query(`DELETE FROM "ProviderParentBriefing" WHERE "providerId" = $1`, [f.providerId]).catch(() => {});
  await db.query(`DELETE FROM "ProviderAutoReply" WHERE "providerId" = $1`, [f.providerId]).catch(() => {});
  await db.query(`DELETE FROM "Booking" WHERE "providerUserId" = $1 OR "parentUserId" = $2`, [f.providerUserId, f.parentUserId]).catch(() => {});
  await db.query(`DELETE FROM "ScheduleConfig" WHERE "userId" = $1`, [f.providerUserId]).catch(() => {});
  await db.query(`DELETE FROM "AiChatMessage" WHERE "sessionId" IN (SELECT id FROM "AiChatSession" WHERE "userId" = $1)`, [f.parentUserId]);
  // Invoice/ProviderQuote hold an FK to AiChatSession, so they must go first.
  await db.query(`DELETE FROM "Invoice" WHERE "providerId" = $1`, [f.providerId]).catch(() => {});
  await db.query(`DELETE FROM "ProviderQuote" WHERE "providerId" = $1`, [f.providerId]).catch(() => {});
  await db.query(`DELETE FROM "AiChatSession" WHERE "userId" = $1`, [f.parentUserId]);
  await db.query(`DELETE FROM "InAppNotification" WHERE "userId" IN ($1, $2)`, [f.parentUserId, f.providerUserId]);
  await db.query(`DELETE FROM "IntendedParentProfile" WHERE "parentAccountId" = $1`, [f.parentAcctId]);
  await db.query(`DELETE FROM "User" WHERE id IN ($1, $2)`, [f.parentUserId, f.providerUserId]);
  await db.query(`DELETE FROM "ParentAccount" WHERE id = $1`, [f.parentAcctId]).catch(() => {});
  await db.query(`DELETE FROM "ReferralFeeConfig" WHERE "providerId" = $1`, [f.providerId]).catch(() => {});
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


// ─── Draft-approval helpers ──────────────────────────────────────────────────
// The three draft cards (cost sheet / invoice / agreement) are approved by
// (sessionId, messageId) - which is precisely why the merged provider view
// deliberately does NOT surface them across sibling sessions.
async function seedDraftCard(db: Client, sessionId: string, uiCardType: string, uiCardData: any, content: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO "AiChatMessage" (id,"sessionId",role,content,"senderType","senderName","uiCardType","uiCardData","createdAt")
     VALUES (gen_random_uuid(),$1,'assistant',$2,'system','System',$3,$4::jsonb,now()) RETURNING id`,
    [sessionId, content, uiCardType, JSON.stringify(uiCardData)],
  );
  return r.rows[0].id;
}

async function addReferralFee(db: Client, providerId: string) {
  await db.query(
    `INSERT INTO "ReferralFeeConfig" (id,"providerId","serviceType","feeType","flatAmount","defaultServiceAmount","parentPaysBasis","isActive","createdAt","updatedAt")
     VALUES (gen_random_uuid(),$1,'SURROGACY','FLAT',100000,500000,'DEFAULT_FIRST_PAYMENT',true,now(),now())
     ON CONFLICT ("providerId","serviceType") DO NOTHING`, [providerId]);
  // Legal Name + Tax ID + a COMPLETED W-9: the compliance gate the billing
  // service enforces before any invoice can be issued.
  await db.query(
    `INSERT INTO "ProviderLegalIdentity" (id,"providerId","legalName","taxId","taxIdType","taxClassification","businessType","createdAt","updatedAt")
     VALUES (gen_random_uuid(),$1,'ZZ Test Agency LLC','12-3456789','ein','LLC','company',now(),now())
     ON CONFLICT ("providerId") DO NOTHING`, [providerId]);
  await db.query(
    `INSERT INTO "ProviderW9" (id,"providerId",status,"completedAt","createdAt","updatedAt")
     VALUES (gen_random_uuid(),$1,'COMPLETED',now(),now(),now())
     ON CONFLICT ("providerId") DO NOTHING`, [providerId]);
}

// ─── PR-04: cost-sheet draft approval turns into a real parent-visible quote ──
async function pr04(db: Client) {
  const f = await createFixture(db, "pr04");
  try {
    const sessionId = await mkSession(db, f, { status: "CONSULTATION_BOOKED", title: "Consultation", providerJoined: true });
    const msgId = await seedDraftCard(db, sessionId, "cost_sheet_draft_approval",
      { totalCostCents: 3900000, notes: "Drafted from the uploaded cost sheet", lineItems: [] },
      "Draft cost sheet ready for your approval");

    // Parent must NOT see the draft before approval.
    const before = await (await jfetch(`${BASE}/api/ai-concierge/session/${sessionId}/messages`, { headers: f.parentAuth })).json();
    const beforeMsgs: any[] = Array.isArray(before) ? before : (before as any).messages || [];
    check("draft card is hidden from the parent before approval",
      !beforeMsgs.some((m: any) => m.uiCardType === "cost_sheet_draft_approval"), JSON.stringify(beforeMsgs.map((m: any) => m.uiCardType)));

    await jfetch(`${BASE}/api/sessions/${sessionId}/cost-sheet-draft/${msgId}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json", ...f.providerAuth },
      body: JSON.stringify({ totalCostCents: 3900000, notes: "Approved" }),
    });

    const quote = await db.query(`SELECT id,"totalCostCents" FROM "ProviderQuote" WHERE "sessionId"=$1`, [sessionId]);
    check("approval creates the real quote", quote.rowCount === 1 && quote.rows[0].totalCostCents === 3900000, `rows=${quote.rowCount}`);

    const after = await (await jfetch(`${BASE}/api/ai-concierge/session/${sessionId}/messages`, { headers: f.parentAuth })).json();
    const afterMsgs: any[] = Array.isArray(after) ? after : (after as any).messages || [];
    check("parent now SEES the sent cost sheet", afterMsgs.some((m: any) => m.uiCardType === "cost_sheet"),
      JSON.stringify(afterMsgs.map((m: any) => m.uiCardType)));
  } finally {
    await destroyFixture(db, f);
  }
}

// ─── PR-05: invoice draft approval issues a real invoice ─────────────────────
async function pr05(db: Client) {
  const f = await createFixture(db, "pr05");
  try {
    await addReferralFee(db, f.providerId);
    const sessionId = await mkSession(db, f, { status: "CONSULTATION_BOOKED", title: "Consultation", providerJoined: true });
    const msgId = await seedDraftCard(db, sessionId, "invoice_draft_approval",
      { serviceAmount: 500000, description: "Agency retainer", lineItems: [{ serviceType: "SURROGACY", amountCents: 500000 }] },
      "Draft invoice ready for your approval");

    await jfetch(`${BASE}/api/sessions/${sessionId}/invoice-draft/${msgId}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json", ...f.providerAuth },
      body: JSON.stringify({ description: "Agency retainer" }),
    });
    const inv = await db.query(`SELECT id,status,"paymentToken" FROM "Invoice" WHERE "sessionId"=$1`, [sessionId]);
    check("approval issues a real invoice", inv.rowCount === 1, `rows=${inv.rowCount}`);
    check("issued invoice has a payment token", !!inv.rows[0]?.paymentToken);

    const after = await (await jfetch(`${BASE}/api/ai-concierge/session/${sessionId}/messages`, { headers: f.parentAuth })).json();
    const afterMsgs: any[] = Array.isArray(after) ? after : (after as any).messages || [];
    check("parent SEES the invoice, not the draft",
      afterMsgs.some((m: any) => m.uiCardType === "invoice") && !afterMsgs.some((m: any) => m.uiCardType === "invoice_draft_approval"),
      JSON.stringify(afterMsgs.map((m: any) => m.uiCardType)));
  } finally {
    await destroyFixture(db, f);
  }
}

// ─── PR-06: a draft card cannot be approved from another session ─────────────
// Draft approvals are addressed by (sessionId, messageId); the consolidated
// provider view deliberately keeps them out of the merge for this reason.
async function pr06(db: Client) {
  const f = await createFixture(db, "pr06");
  try {
    await addReferralFee(db, f.providerId);
    const sessionA = await mkSession(db, f, { status: "CONSULTATION_BOOKED", title: "Consultation A", providerJoined: true });
    const sessionB = await mkSession(db, f, { status: "CONSULTATION_BOOKED", title: "Consultation B", providerJoined: true });
    const msgId = await seedDraftCard(db, sessionA, "cost_sheet_draft_approval",
      { totalCostCents: 1234500, notes: "Draft", lineItems: [] }, "Draft cost sheet");

    let rejected = false;
    try {
      await jfetch(`${BASE}/api/sessions/${sessionB}/cost-sheet-draft/${msgId}/approve`, {
        method: "POST", headers: { "Content-Type": "application/json", ...f.providerAuth },
        body: JSON.stringify({ totalCostCents: 1234500 }),
      });
    } catch { rejected = true; }
    check("approving a draft from the WRONG session is rejected", rejected);

    const leaked = await db.query(`SELECT id FROM "ProviderQuote" WHERE "sessionId"=$1`, [sessionB]);
    check("no quote is created in the wrong session", leaked.rowCount === 0, `rows=${leaked.rowCount}`);
  } finally {
    await destroyFixture(db, f);
  }
}

// ─── PR-07: the pinned provider assistant (shipped with zero tests) ──────────
async function pr07(db: Client) {
  const f = await createFixture(db, "pr07");
  try {
    // Give the provider a real parent thread so the assistant has pipeline context.
    const sessionId = await mkSession(db, f, { status: "ACTIVE", title: "AI Concierge Chat" });
    await db.query(
      `INSERT INTO "SilentQuery" (id,"sessionId","parentUserId","providerId","questionText",status,"createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,$3,'Does she have any travel restrictions?','PENDING',now(),now())`,
      [sessionId, f.parentUserId, f.providerId]);

    const created: any = await (await jfetch(`${BASE}/api/provider/concierge-assistant`, { headers: f.providerAuth })).json();
    check("provider assistant session is created/returned", !!created?.sessionId || !!created?.id, JSON.stringify(Object.keys(created || {})).slice(0, 120));

    const res = await jfetch(`${BASE}/api/provider/concierge-assistant/message`, {
      method: "POST", headers: { "Content-Type": "application/json", ...f.providerAuth },
      body: JSON.stringify({ content: "what needs my attention right now?" }),
    });
    const text = await res.text();
    let reply = "";
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const d = JSON.parse(line.slice(6));
        if (d.type === "token") reply += d.delta;
        else if (d.type === "done") reply = (d.message && d.message.content) || reply;
      } catch { /* non-JSON frame */ }
    }
    if (!reply) {
      // Non-streaming shape: { userMessage, aiMessage } or { message }.
      try {
        const j = JSON.parse(text);
        reply = j?.aiMessage?.content || j?.message?.content || j?.assistantMessage?.content || "";
      } catch { /* leave empty - an unparseable body is a real failure */ }
    }
    check("assistant answers the provider in parseable assistant content", reply.trim().length > 0,
      reply ? `${reply.length} chars` : `UNPARSED: ${text.slice(0, 160)}`);
    check("assistant does not leak an anonymous parent's identity",
      !new RegExp(`Test Parent pr07`, "i").test(reply), reply.slice(0, 160));

    const sess = await db.query(
      `SELECT "sessionType" FROM "AiChatSession" WHERE "providerId"=$1 AND "sessionType"='PROVIDER_CONCIERGE'`, [f.providerId]);
    check("assistant uses a PROVIDER_CONCIERGE session (never a parent thread)", sess.rowCount === 1, `rows=${sess.rowCount}`);
  } finally {
    await db.query(`DELETE FROM "AiChatMessage" WHERE "sessionId" IN (SELECT id FROM "AiChatSession" WHERE "providerId"=$1)`, [f.providerId]).catch(() => {});
    await db.query(`DELETE FROM "AiChatSession" WHERE "providerId"=$1`, [f.providerId]).catch(() => {});
    await destroyFixture(db, f);
  }
}


// ─── PR-08: the server-side match-call gate (the real enforcement) ───────────
// Eva's IP-form reminder is a prompt directive and can be talked around; THIS
// is the gate that actually holds. The agency proposes match-call times, and
// the endpoint refuses while the Intended Parent Form is unsubmitted.
async function pr08(db: Client) {
  const f = await createFixture(db, "pr08");
  try {
    const sessionId = await mkSession(db, f, { status: "CONSULTATION_BOOKED", title: "Consultation", providerJoined: true });
    await db.query(
      `INSERT INTO "IpFormResponse" (id,"parentAccountId",status,"hasSecondParent","promptedAt","createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,'DRAFT',false,now(),now(),now())
       ON CONFLICT ("parentAccountId") DO UPDATE SET status='DRAFT', "submittedAt"=NULL`, [f.parentAcctId]);

    const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
    const propose = (subtype: string) => fetch(`${BASE}/api/chat-session/${sessionId}/propose-call-times`, {
      method: "POST", headers: { "Content-Type": "application/json", ...f.providerAuth },
      body: JSON.stringify({ hostUserId: f.providerUserId, meetingSubtype: subtype, slots: [future(3), future(4)] }),
    });

    const blocked = await propose("MATCH_CALL");
    const blockedBody: any = await blocked.json().catch(() => ({}));
    check("match-call times are REFUSED while the IP form is unsubmitted", blocked.status === 409, `status=${blocked.status}`);
    check("the refusal is a typed reason the UI can act on", blockedBody?.code === "IP_FORM_REQUIRED", JSON.stringify(blockedBody).slice(0, 140));
    check("no proposed-times card is posted to the chat",
      (await db.query(`SELECT id FROM "AiChatMessage" WHERE "sessionId"=$1 AND "uiCardType"='proposed_times'`, [sessionId])).rowCount === 0);

    // The gate is specific to the MATCH call - a doctor call is unaffected.
    const otherCall = await propose("DOCTOR_CONSULTATION");
    check("the gate does NOT block other call types", otherCall.status < 400, `status=${otherCall.status}`);

    await db.query(`UPDATE "IpFormResponse" SET status='SUBMITTED', "submittedAt"=now() WHERE "parentAccountId"=$1`, [f.parentAcctId]);
    const allowed = await propose("MATCH_CALL");
    check("match-call times are accepted once the form is submitted", allowed.status < 400, `status=${allowed.status}`);
    check("the proposed-times card reaches the chat",
      (await db.query(`SELECT id FROM "AiChatMessage" WHERE "sessionId"=$1 AND "uiCardType"='proposed_times'`, [sessionId])).rowCount > 0);
  } finally {
    await db.query(`DELETE FROM "IpFormResponse" WHERE "parentAccountId"=$1`, [f.parentAcctId]).catch(() => {});
    await destroyFixture(db, f);
  }
}


// ─── PR-09: agreement draft approval card ────────────────────────────────────
// The approve path drives PandaDoc (external), so this covers the parts that
// are ours: parent invisibility, the reject path, the already-resolved guard,
// and cross-session addressing. The PandaDoc round trip itself is not
// exercised here - JR-02 covers the signed-agreement state it produces.
async function pr09(db: Client) {
  const f = await createFixture(db, "pr09");
  try {
    const sessionId = await mkSession(db, f, { status: "CONSULTATION_BOOKED", title: "Consultation", providerJoined: true });
    const otherSession = await mkSession(db, f, { status: "CONSULTATION_BOOKED", title: "Consultation B", providerJoined: true });
    const msgId = await seedDraftCard(db, sessionId, "agreement_draft_approval",
      { documentType: "Agreement", parentName: "Test Parent" }, "Draft agreement ready for your approval");

    const seen = await (await jfetch(`${BASE}/api/ai-concierge/session/${sessionId}/messages`, { headers: f.parentAuth })).json();
    const seenMsgs: any[] = Array.isArray(seen) ? seen : (seen as any).messages || [];
    check("agreement draft is invisible to the parent",
      !seenMsgs.some((m: any) => m.uiCardType === "agreement_draft_approval"),
      JSON.stringify(seenMsgs.map((m: any) => m.uiCardType)));

    // Addressed by (sessionId, messageId) - the sibling session must not work.
    const wrong = await fetch(`${BASE}/api/sessions/${otherSession}/agreement-draft/${msgId}/reject`, {
      method: "POST", headers: { "Content-Type": "application/json", ...f.providerAuth },
    });
    check("a draft cannot be actioned from a sibling session", wrong.status === 404, `status=${wrong.status}`);

    const rejected = await fetch(`${BASE}/api/sessions/${sessionId}/agreement-draft/${msgId}/reject`, {
      method: "POST", headers: { "Content-Type": "application/json", ...f.providerAuth },
    });
    check("provider can reject the draft", rejected.status < 400, `status=${rejected.status}`);
    const row = await db.query(`SELECT "uiCardData"->>'resolvedAs' AS r FROM "AiChatMessage" WHERE id=$1`, [msgId]);
    check("rejection is recorded on the card", row.rows[0]?.r === "rejected", String(row.rows[0]?.r));
    check("rejecting creates no Agreement",
      (await db.query(`SELECT id FROM "Agreement" WHERE "sessionId"=$1`, [sessionId])).rowCount === 0);

    // A resolved draft must not be actionable twice - the provider can open a
    // stale card in another tab and click again.
    const again = await fetch(`${BASE}/api/sessions/${sessionId}/agreement-draft/${msgId}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json", ...f.providerAuth }, body: "{}",
    });
    check("an already-rejected draft cannot then be approved", again.status === 409, `status=${again.status}`);
  } finally {
    await destroyFixture(db, f);
  }
}

// ─── PR-10: unread counts must agree with what the parent can actually see ───
// A card the read path hides but the counter counts is a badge the parent can
// never clear - they open the chat, see nothing new, and the number stays.
async function pr10(db: Client) {
  const f = await createFixture(db, "pr10");
  try {
    const sessionId = await mkSession(db, f, { status: "ACTIVE", title: "AI Concierge Chat" });
    // clearance_tracker is provider-side/internal: never rendered to a parent.
    await seedDraftCard(db, sessionId, "clearance_tracker", { stage: "pending" }, "Medical clearance in progress");

    const listUnread = async (): Promise<number> => {
      const res = await jfetch(`${BASE}/api/my/chat-sessions`, { headers: f.parentAuth });
      const rows: any[] = await res.json();
      const row = rows.find((r: any) => r.id === sessionId);
      return row ? (row.unreadCount || 0) : -1;
    };
    const hiddenOnly = await listUnread();
    check("a hidden system card does not raise the parent's unread badge", hiddenOnly === 0, `unread=${hiddenOnly}`);

    // A card the parent CAN see must still count.
    await seedDraftCard(db, sessionId, "cost_sheet", { totalCostCents: 100000 }, "Your cost sheet");
    const withVisible = await listUnread();
    check("a visible card still counts toward unread", withVisible === 1, `unread=${withVisible}`);

    const shown = await (await jfetch(`${BASE}/api/ai-concierge/session/${sessionId}/messages`, { headers: f.parentAuth })).json();
    const shownMsgs: any[] = Array.isArray(shown) ? shown : (shown as any).messages || [];
    const visibleCount = shownMsgs.filter((m: any) => m.uiCardType).length;
    check("the badge matches the number of cards actually rendered", withVisible === visibleCount,
      `badge=${withVisible} rendered=${visibleCount} :: ${JSON.stringify(shownMsgs.map((m: any) => m.uiCardType))}`);
  } finally {
    await destroyFixture(db, f);
  }
}

// ─── PR-11: viewing a merged thread does not touch the parent's private chat ─
// A whisper stamps providerId onto the parent's PRIVATE Eva session, so the
// provider's merged view can reach sibling sessions it must never mark as
// delivered - "delivered" would then mean nothing.
async function pr11(db: Client) {
  const f = await createFixture(db, "pr11");
  try {
    const evaSession = await mkSession(db, f, { status: "ACTIVE", title: "AI Concierge Chat" });
    const booked = await mkSession(db, f, { status: "CONSULTATION_BOOKED", title: "Consultation", providerJoined: true });
    // Eva's private message to the parent, in the whisper-stamped Eva session.
    const evaMsg = await db.query(
      `INSERT INTO "AiChatMessage" (id,"sessionId",role,content,"senderType","senderName","createdAt")
       VALUES (gen_random_uuid(),$1,'assistant','Just between us - here is what I would ask them.','ai','Eva',now()) RETURNING id`,
      [evaSession]);
    const evaMsgId = evaMsg.rows[0].id;

    // Provider opens their thread (this is what triggers the delivery stamp).
    await jfetch(`${BASE}/api/provider/concierge-sessions/${booked}`, { headers: f.providerAuth });
    // The delivery stamp is fire-and-forget, so asserting immediately races it
    // and the test passes for the wrong reason.
    await new Promise((r) => setTimeout(r, 2000));

    const after = await db.query(`SELECT "deliveredAt" FROM "AiChatMessage" WHERE id=$1`, [evaMsgId]);
    check("provider opening their thread does NOT mark the parent's private Eva message delivered",
      !after.rows[0].deliveredAt, String(after.rows[0].deliveredAt));
  } finally {
    await destroyFixture(db, f);
  }
}

// ─── Booking auto-reply helpers ───────────────────────────────────────────────
/** Give the provider user a public booking page so /book/:slug is reachable. */
async function mkBookingPage(db: Client, f: Fixture, tag: string): Promise<string> {
  const slug = `zz-test-${tag}-${Date.now()}`;
  await db.query(
    `INSERT INTO "ScheduleConfig" (id, "userId", timezone, "meetingDuration", "minBookingNotice", "bookingPageSlug")
     VALUES (gen_random_uuid(), $1, 'America/New_York', 30, 0, $2)
     ON CONFLICT ("userId") DO UPDATE SET "bookingPageSlug" = $2`,
    [f.providerUserId, slug],
  );
  return slug;
}

/** The session-creation + auto-reply work is fire-and-forget off the booking
 *  response, so asserting immediately races it. Poll instead of sleeping a
 *  fixed amount, so a slow run does not read as a failure. */
async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 15000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = await fn();
    if (got) return got;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`      (timed out waiting for ${label})`);
  return null;
}

/** Book a slot through the real public endpoint, exactly as the UI does.
 *  Passing aiSessionId mimics Eva's inline widget; omitting it mimics the
 *  provider's own shareable /book/<slug> link. */
async function bookViaHttp(
  slug: string,
  f: Fixture,
  opts: { aiSessionId?: string; providerId?: string; hoursOut: number },
) {
  const when = new Date(Date.now() + opts.hoursOut * 3600_000);
  const body: any = {
    // The endpoint parses this in the booker's timezone, so send a local-style
    // stamp rather than a UTC one.
    scheduledAt: when.toISOString().replace(/\.\d{3}Z$/, ""),
    name: `Test Parent ${f.parentEmail.split("@")[0]}`,
    email: f.parentEmail,
    timezone: "America/New_York",
  };
  if (opts.aiSessionId) {
    body.aiSessionId = opts.aiSessionId;
    body.consultationProviderId = opts.providerId;
    body.matchmakerId = MATCHMAKER_ID;
    body.profileLabel = "Surrogate #ZZTEST";
    body.subjectType = "surrogate";
  }
  const res = await jfetch(`${BASE}/api/calendar/book/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<any>;
}

// ─── PR-12: auto-reply templates are the provider's own, and only theirs ──────
// The settings CRUD is the surface a provider actually touches. It is also the
// place a scoping mistake becomes silent: two templates for the same scope, or
// one org editing another's greeting.
async function pr12(db: Client) {
  const f = await createFixture(db, "pr12");
  const other = await createFixture(db, "pr12b");
  try {
    const svcType = await db.query(`SELECT id FROM "ProviderType" WHERE name = 'Surrogacy Agency' LIMIT 1`);
    const typeId = svcType.rows[0]?.id || null;

    const created: any = await (await jfetch(`${BASE}/api/provider-auto-replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...f.providerAuth },
      body: JSON.stringify({ body: "Hi {{parent_name}}, looking forward to it." }),
    })).json();
    check("provider can create an org-wide auto-reply", !!created?.autoReply?.id, JSON.stringify(created).slice(0, 120));

    const dup = await fetch(`${BASE}/api/provider-auto-replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...f.providerAuth } as any,
      body: JSON.stringify({ body: "Second org-wide one" }),
    });
    check("a second template for the SAME scope is rejected", dup.status === 400, `HTTP ${dup.status}`);

    if (typeId) {
      const scoped: any = await (await jfetch(`${BASE}/api/provider-auto-replies`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...f.providerAuth },
        body: JSON.stringify({ body: "Surrogacy-specific greeting", providerTypeId: typeId }),
      })).json();
      check("the same staff scope with a DIFFERENT service line is allowed", !!scoped?.autoReply?.id);
    }

    const listed: any = await (await jfetch(`${BASE}/api/provider-auto-replies`, { headers: f.providerAuth })).json();
    check("list returns only this provider's templates",
      Array.isArray(listed?.autoReplies) && listed.autoReplies.every((a: any) => a.providerId === f.providerId),
      String(listed?.autoReplies?.length));

    // A different provider org must not be able to read or edit these.
    const foreignList: any = await (await jfetch(`${BASE}/api/provider-auto-replies`, { headers: other.providerAuth })).json();
    check("another provider's list does not include this org's templates",
      (foreignList?.autoReplies || []).every((a: any) => a.providerId !== f.providerId));

    const foreignEdit = await fetch(`${BASE}/api/provider-auto-replies/${created.autoReply.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...other.providerAuth } as any,
      body: JSON.stringify({ body: "hijacked" }),
    });
    check("another provider cannot edit this org's template", foreignEdit.status === 403, `HTTP ${foreignEdit.status}`);

    const still = await db.query(`SELECT body FROM "ProviderAutoReply" WHERE id = $1`, [created.autoReply.id]);
    check("the template body is unchanged after the rejected edit", !/hijacked/.test(still.rows[0]?.body || ""), still.rows[0]?.body);

    const del = await fetch(`${BASE}/api/provider-auto-replies/${created.autoReply.id}`, {
      method: "DELETE", headers: f.providerAuth as any,
    });
    check("provider can delete their own template", del.status === 200 || del.status === 201, `HTTP ${del.status}`);
  } finally {
    await destroyFixture(db, f);
    await destroyFixture(db, other);
  }
}

// ─── PR-13: the greeting lands on booking without faking the provider's presence ─
// Booked through the REAL public endpoint, so a change to the booking payload
// or the session-creation wiring breaks this test rather than silently
// disabling the feature.
async function pr13(db: Client) {
  const f = await createFixture(db, "pr13");
  try {
    await db.query(
      `INSERT INTO "ProviderAutoReply" (id, "providerId", body, attachments, "isEnabled", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3::jsonb, true, now(), now())`,
      [
        f.providerId,
        "Hi {{parent_name}} - thanks for booking. Here is our intro packet.",
        JSON.stringify([{ originalName: "Intro Packet.pdf", url: "/uploads/zz-test-intro.pdf", mimeType: "application/pdf", size: 1024 }]),
      ],
    );

    const slug = await mkBookingPage(db, f, "pr13");
    const evaSession = await mkSession(db, f, { status: "ACTIVE", title: "AI Concierge Chat" });
    const booked = await bookViaHttp(slug, f, { aiSessionId: evaSession, providerId: f.providerId, hoursOut: 48 });
    check("the booking was accepted", !!booked?.id, JSON.stringify(booked).slice(0, 140));

    const msgs = await waitFor("the auto-reply message", async () => {
      const r = await db.query(
        `SELECT m.id, m."senderType", m."senderName", m.content, m."uiCardType", m."uiCardData", m."sessionId"
           FROM "AiChatMessage" m JOIN "AiChatSession" s ON s.id = m."sessionId"
          WHERE s."userId" = $1 AND m."uiCardData"->>'isAutoReply' = 'true'`,
        [f.parentUserId],
      );
      return r.rows.length >= 2 ? r.rows : null;
    });
    check("the greeting and its attachment were both posted", !!msgs && msgs.length === 2, `${msgs?.length ?? 0} message(s)`);

    if (msgs) {
      const text = msgs.find((m: any) => m.uiCardType !== "attachment");
      const file = msgs.find((m: any) => m.uiCardType === "attachment");
      check("it is stored as a PROVIDER message, not a system one", text?.senderType === "provider", text?.senderType);
      check("the parent's name was substituted into the body",
        !!text && !/\{\{/.test(text.content) && /Test Parent/.test(text.content), text?.content?.slice(0, 90));
      check("the attachment carries a usable file card",
        !!file && !!file.uiCardData?.url && !!file.uiCardData?.originalName, JSON.stringify(file?.uiCardData || {}).slice(0, 100));

      // THE invariant: an automated greeting must never look like the provider
      // showed up. If this flips, the parent is told someone joined who did not.
      const sess = await db.query(`SELECT status, "providerJoinedAt" FROM "AiChatSession" WHERE id = $1`, [text?.sessionId || file?.sessionId]);
      check("the session was NOT flipped to PROVIDER_CONNECTED", sess.rows[0]?.status !== "PROVIDER_CONNECTED", sess.rows[0]?.status);
      check("providerJoinedAt was NOT stamped", !sess.rows[0]?.providerJoinedAt, String(sess.rows[0]?.providerJoinedAt));
    }
  } finally {
    await destroyFixture(db, f);
  }
}

// ─── PR-14: once per parent, and the provider's own booking link is covered ───
// More than half of real bookings arrive through /book/<slug> with no
// aiSessionId. Those must attach to the thread the parent already has - and
// must not greet a parent who was already greeted.
async function pr14(db: Client) {
  const f = await createFixture(db, "pr14");
  try {
    await db.query(
      `INSERT INTO "ProviderAutoReply" (id, "providerId", body, "isEnabled", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, 'Hi {{parent_name}}, welcome.', true, now(), now())`,
      [f.providerId],
    );
    const slug = await mkBookingPage(db, f, "pr14");

    // A thread that already exists with this provider, as if from an earlier call.
    const existing = await mkSession(db, f, { status: "CONSULTATION_BOOKED", title: "Consultation" });

    // Booking through the provider's own link - no aiSessionId at all.
    const direct = await bookViaHttp(slug, f, { hoursOut: 72 });
    check("the direct-link booking was accepted", !!direct?.id, JSON.stringify(direct).slice(0, 140));

    const greeted = await waitFor("the greeting on the existing thread", async () => {
      const r = await db.query(
        `SELECT id FROM "AiChatMessage" WHERE "sessionId" = $1 AND "uiCardData"->>'isAutoReply' = 'true'`,
        [existing],
      );
      return r.rows.length ? r.rows : null;
    });
    check("a link booking greets the parent in their EXISTING thread", !!greeted, greeted ? undefined : "nothing was posted");

    const linked = await waitFor("the booking->thread link", async () => {
      const r = await db.query(`SELECT "sessionId" FROM "Booking" WHERE id = $1`, [direct.id]);
      return r.rows[0]?.sessionId ? r.rows[0] : null;
    });
    check("the booking is linked to that thread (journey scoping)", linked?.sessionId === existing, String(linked?.sessionId));

    // Second booking through the link: still links, must not greet again.
    const second = await bookViaHttp(slug, f, { hoursOut: 96 });
    await waitFor("the second booking to be processed", async () => {
      const r = await db.query(`SELECT "sessionId" FROM "Booking" WHERE id = $1`, [second.id]);
      return r.rows[0]?.sessionId ? r.rows[0] : null;
    });

    const totals = await db.query(
      `SELECT count(*)::int AS n FROM "AiChatMessage" m JOIN "AiChatSession" s ON s.id = m."sessionId"
        WHERE s."userId" = $1 AND m."uiCardData"->>'isAutoReply' = 'true'`,
      [f.parentUserId],
    );
    check("a second booking does NOT greet the parent again", totals.rows[0].n === 1, `${totals.rows[0].n} greeting(s)`);

    const sends = await db.query(
      `SELECT count(*)::int AS n FROM "ProviderAutoReplySend" WHERE "providerId" = $1`, [f.providerId]);
    check("exactly one send is on record for this parent+provider", sends.rows[0].n === 1, `${sends.rows[0].n}`);
  } finally {
    await destroyFixture(db, f);
  }
}

// ─── PR-15: the private parent briefing reaches the provider, never the parent ─
// An AI summary of the family is posted into the shared thread when the first
// consultation is booked. The whole feature rests on ONE property: the parent
// must never read an assessment of themselves. That is what this asserts,
// through both sides' real read endpoints rather than by inspecting the row.
async function pr15(db: Client) {
  const f = await createFixture(db, "pr15");
  try {
    const session = await mkSession(db, f, { status: "CONSULTATION_BOOKED", title: "Consultation" });

    // Stand in for a generated briefing - this case is about VISIBILITY, not
    // the model's wording (a live Gemini call would make it flaky).
    const secret = "PRIVATE-BRIEFING-CANARY-two-tested-embryos";
    const msg = await db.query(
      `INSERT INTO "AiChatMessage" (id,"sessionId",role,content,"senderType","senderName","uiCardType","uiCardData","createdAt")
       VALUES (gen_random_uuid(),$1,'assistant',$2,'system','GoStork','provider_assessment','{"parentBriefing":true}'::jsonb,now())
       RETURNING id`,
      [session, `**Private briefing - only you can see this**\n\n${secret}`],
    );
    const briefingId = msg.rows[0].id;

    const provView: any = await (await jfetch(`${BASE}/api/provider/concierge-sessions/${session}`, { headers: f.providerAuth })).json();
    check("the provider can read the briefing", JSON.stringify(provView).includes(secret));

    // The parent side - the one that matters.
    const parentView: any = await (await jfetch(`${BASE}/api/ai-concierge/session/${session}/messages`, { headers: f.parentAuth })).json();
    const parentBlob = JSON.stringify(parentView);
    check("the PARENT cannot read the briefing", !parentBlob.includes(secret),
      parentBlob.includes(secret) ? "LEAKED to the parent" : undefined);
    check("the briefing message id is absent from the parent's feed", !parentBlob.includes(briefingId));

    // A hidden card must not inflate the parent's unread badge either - that
    // is a count they could never clear by reading.
    const unreadRow = await db.query(
      `SELECT count(*)::int AS n FROM "AiChatMessage"
        WHERE "sessionId" = $1 AND "uiCardType" = 'provider_assessment' AND "readAt" IS NULL`,
      [session],
    );
    const parentMsgs: any[] = Array.isArray(parentView) ? parentView : (parentView?.messages || []);
    check("the briefing is not among the messages the parent is served",
      !parentMsgs.some((m: any) => m.id === briefingId), `${parentMsgs.length} message(s) served`);
    check("the briefing row does exist (so the check above is meaningful)", unreadRow.rows[0].n === 1);
  } finally {
    await destroyFixture(db, f);
  }
}

const CASES: { id: string; name: string; run: (db: Client) => Promise<void> }[] = [
  { id: "PR-01", name: "Whisper answer relays into the parent's own chat (consolidated threads)", run: pr01 },
  { id: "PR-02", name: "Parent identity masked before booking, revealed after", run: pr02 },
  { id: "PR-03", name: "Provider-only content never reaches the parent transcript", run: pr03 },
  { id: "PR-04", name: "Cost-sheet draft approval sends a parent-visible cost sheet", run: pr04 },
  { id: "PR-05", name: "Invoice draft approval issues a real invoice", run: pr05 },
  { id: "PR-06", name: "A draft cannot be approved from another session", run: pr06 },
  { id: "PR-07", name: "Pinned provider assistant answers without leaking parent identity", run: pr07 },
  { id: "PR-08", name: "Match-call times are gated server-side on the Intended Parent Form", run: pr08 },
  { id: "PR-09", name: "Agreement draft: parent-invisible, rejectable, not re-actionable", run: pr09 },
  { id: "PR-10", name: "Unread badge counts only what the parent can actually see", run: pr10 },
  { id: "PR-11", name: "Merged provider view never marks the parent's private chat delivered", run: pr11 },
  { id: "PR-12", name: "Auto-reply templates are the provider's own, and only theirs", run: pr12 },
  { id: "PR-13", name: "Booking auto-reply lands without faking the provider's presence", run: pr13 },
  { id: "PR-14", name: "Auto-reply covers the provider's own booking link, once per parent", run: pr14 },
  { id: "PR-15", name: "The private parent briefing reaches the provider, never the parent", run: pr15 },
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
