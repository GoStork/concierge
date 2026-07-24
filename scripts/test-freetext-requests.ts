/**
 * GoStork AI Concierge - Free-Text Request Handling E2E Suite
 *
 * Covers the five failure classes fixed on Jul 24 2026 (see
 * docs/freetext-request-test-plan.md): parents typing requests the scripted
 * flow did not anticipate must NEVER be ignored, steamrolled, overruled, or
 * answered with mismatched quick replies.
 *
 * Cases (all against a live server - default http://localhost:5001):
 *  FT-01 Marketplace deep-link (surrogate pin) 4-turn replay
 *  FT-02 Confirm-never-overrule (embryos on file, donor requested)
 *  FT-03 Sperm C2 - donor-type answer saved, never re-asked
 *  FT-04 Buy vials - purchase intent ends in checkout
 *
 * Usage:
 *   TEST_BASE_URL=http://localhost:5001 npx tsx scripts/test-freetext-requests.ts
 *   TEST_BASE_URL=http://localhost:5001 npx tsx scripts/test-freetext-requests.ts --id=FT-01,FT-04
 *
 * Output follows the admin test-runner protocol (test-runner.service.ts):
 *   "  ▶ Starting: FT-01" / "  ✅ FT-01 PASS (12.3s)" / "  ❌ FT-01 FAIL (12.3s)"
 *   failed checks as "     [FT-01] <check> :: <detail>"
 *
 * Creates throwaway *@gostork-test.com users and deletes them (and all their
 * sessions/messages) at the end of each case.
 */

import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";

const envContent = fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
const dbUrl =
  envContent.match(/^DIRECT_URL="?([^"\n]+)"?/m)?.[1] ||
  envContent.match(/^DATABASE_URL="?([^"\n]+)"?/m)?.[1];
const BASE = process.env.TEST_BASE_URL || "http://localhost:5001";

// Adam persona + the live deep-link fixture used in the Jul 24 sessions.
const MATCHMAKER_ID = "f590dbcb-011e-43d9-98d0-1157c3cfa1e2";
const SURROGATE_ID = "8874fb3a-9df8-48e8-9eba-c270d211dfd6"; // Surrogate #09410 (Lizet)
const OWNER_ID = "d0af900d-41bf-43cb-9051-d52c8cda3f24"; // Family Creations
const TEST_PASSWORD = "Test1234!x";

const filterId = process.argv.slice(2).find((a) => a.startsWith("--id="))?.split("=")[1];

// ─── Per-case check tracking ─────────────────────────────────────────────────
let caseId = "";
let caseFails: string[] = [];
let totalPass = 0;
let totalFail = 0;
function check(label: string, ok: boolean, detail?: string) {
  // Plain log lines (no "[FT-xx]" prefix - the runner treats bracketed lines as errors)
  console.log(`      ${ok ? "✓" : "✗"} ${label}${detail ? ` :: ${detail.replace(/\n/g, " | ")}` : ""}`);
  if (!ok) caseFails.push(`${label}${detail ? ` :: ${detail.replace(/\n/g, " | ").slice(0, 160)}` : ""}`);
}

async function jfetch(url: string, opts: RequestInit): Promise<Response> {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${await res.text()}`);
  return res;
}

interface Turn {
  content: string;
  streamed: string;
  qr: string[];
  hasCard: boolean;
  consultPid: string | null;
  resets: number;
}

interface TestUser {
  userId: string;
  acctId: string;
  auth: Record<string, string>;
  email: string;
}

async function createUser(db: Client, tag: string, services: string[]): Promise<TestUser> {
  const email = `test-${tag}-${Date.now()}@gostork-test.com`;
  await jfetch(`${BASE}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD, name: `Test ${tag}` }),
  });
  const loginRes = await jfetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  const loginBody: any = await loginRes.json();
  const auth: Record<string, string> = loginBody?.token
    ? { Authorization: `Bearer ${loginBody.token}` }
    : { Cookie: loginRes.headers.get("set-cookie") || "" };

  const userRow = await db.query(`SELECT id, "parentAccountId" FROM "User" WHERE email = $1`, [email]);
  const userId = userRow.rows[0].id;
  let acctId = userRow.rows[0].parentAccountId;
  if (!acctId) {
    const acct = await db.query(
      `INSERT INTO "ParentAccount" (id, "createdAt", "updatedAt") VALUES (gen_random_uuid(), now(), now()) RETURNING id`,
    );
    acctId = acct.rows[0].id;
    await db.query(`UPDATE "User" SET "parentAccountId" = $1, state = 'California', city = 'Los Angeles' WHERE id = $2`, [
      acctId,
      userId,
    ]);
  }
  await db.query(
    `INSERT INTO "IntendedParentProfile" (id, "parentAccountId", "interestedServices", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, now(), now())
     ON CONFLICT ("parentAccountId") DO UPDATE SET "interestedServices" = $2`,
    [acctId, services],
  );
  return { userId, acctId, auth, email };
}

async function deleteUser(db: Client, u: TestUser) {
  await db.query(`DELETE FROM "AiChatMessage" WHERE "sessionId" IN (SELECT id FROM "AiChatSession" WHERE "userId" = $1)`, [u.userId]);
  await db.query(`DELETE FROM "AiChatSession" WHERE "userId" = $1`, [u.userId]);
  await db.query(`DELETE FROM "IntendedParentProfile" WHERE "parentAccountId" = $1`, [u.acctId]);
  await db.query(`DELETE FROM "User" WHERE id = $1`, [u.userId]);
  await db.query(`DELETE FROM "ParentAccount" WHERE id = $1`, [u.acctId]).catch(() => {});
}

async function initSession(auth: Record<string, string>, deepLink: boolean): Promise<string> {
  const body: any = { matchmakerId: MATCHMAKER_ID };
  if (deepLink) {
    body.donorId = SURROGATE_ID;
    body.donorType = "surrogate";
    body.ownerProviderId = OWNER_ID;
    body.greeting = "Hi! I see you're interested in a Surrogate profile. Do you have a specific question about this surrogate?";
  }
  const res = await jfetch(`${BASE}/api/ai-concierge/init-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify(body),
  });
  return ((await res.json()) as any).sessionId;
}

async function send(auth: Record<string, string>, sessionId: string, message: string): Promise<Turn> {
  const res = await jfetch(`${BASE}/api/ai-concierge/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ message, sessionId }),
  });
  const text = await res.text();
  const turn: Turn = { content: "", streamed: "", qr: [], hasCard: false, consultPid: null, resets: 0 };
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const d = JSON.parse(line.slice(6));
      if (d.type === "token") turn.streamed += d.delta;
      else if (d.type === "reset") {
        turn.resets++;
        turn.streamed = "";
      } else if (d.type === "done") {
        turn.content = (d.message && d.message.content) || turn.streamed;
        turn.qr = d.quickReplies || [];
        turn.hasCard = !!(d.matchCards && d.matchCards.length);
        turn.consultPid = d.consultationCard?.providerId || null;
      }
    } catch {
      /* non-JSON SSE line */
    }
  }
  return turn;
}

// ─── FT-01: deep-link pin - the live 4-turn failure replay ───────────────────
async function ft01(db: Client) {
  const u = await createUser(db, "ft-deeplink", ["Surrogate"]);
  try {
    const sid = await initSession(u.auth, true);

    const s1 = await send(u.auth, sid, "schedule a call");
    check("booking calendar rendered on 'schedule a call'", !!s1.consultPid, `consultPid=${s1.consultPid}`);

    const s2 = await send(u.auth, sid, "I am interested in an egg donor");
    check("egg-donor request engaged", /egg\s*donor/i.test(s2.content));
    check("no detour to prior context", !/colombia|bio[eé]tica|surrogacy in/i.test(s2.content), s2.content.slice(0, 100));
    check("asks a question", /\?/.test(s2.content));

    const s3 = await send(u.auth, sid, "I need a sperm donor");
    const st = s3.streamed.toLowerCase();
    const spermIdx = st.indexOf("sperm");
    const eggIdx = st.indexOf("egg donor");
    check("final content about sperm donor", /sperm/i.test(s3.content));
    check("stream opens on sperm topic", spermIdx >= 0 && (eggIdx === -1 || spermIdx < eggIdx), st.slice(0, 100));

    const s4 = await send(u.auth, sid, "I need a surrogate");
    check("no old-thread bleed (sperm) on surrogate ask", !/sperm/i.test(s4.content), s4.content.slice(0, 120));
    check("surrogate request engaged", /surrogate/i.test(s4.content));
    check(
      "QRs coherent (never another service's options)",
      s4.qr.length > 0 && !s4.qr.some((q) => /sperm|egg|donor/i.test(q)),
      JSON.stringify(s4.qr),
    );
  } finally {
    await deleteUser(db, u);
  }
}

// ─── FT-02: confirm-never-overrule (profile already has embryos) ─────────────
async function ft02(db: Client) {
  const u = await createUser(db, "ft-overrule", ["Surrogate"]);
  try {
    await db.query(
      `UPDATE "IntendedParentProfile" SET "hasEmbryos" = true, "embryoCount" = 45, "embryosTested" = true WHERE "parentAccountId" = $1`,
      [u.acctId],
    );
    const sid = await initSession(u.auth, true);

    const r1 = await send(u.auth, sid, "I need an egg donor");
    check("no refusal ('don't need')", !/(don'?t|do not|no longer|won'?t)\s+(actually\s+)?need/i.test(r1.content), r1.content.slice(0, 120));
    check("references existing embryos", /embryo/i.test(r1.content));
    check("asks a confirming question", /\?/.test(r1.content));
    check("no directive-label leak", !/acknowledge:|noted:/i.test(r1.content));
    check(
      "QRs answer THE question (not egg/sperm-source options)",
      r1.qr.length > 0 && !r1.qr.some((q) => /^my (own|partner)/i.test(q)) && r1.qr.some((q) => /more embryos|plans have changed/i.test(q)),
      JSON.stringify(r1.qr),
    );

    const r2 = await send(u.auth, sid, "I need to find a sperm donor");
    check(
      "sperm variant: QRs answer THE question",
      r2.qr.length > 0 && !r2.qr.some((q) => /^my (own|partner)|donor sperm/i.test(q)) && r2.qr.some((q) => /more embryos|plans have changed/i.test(q)),
      JSON.stringify(r2.qr),
    );
  } finally {
    await deleteUser(db, u);
  }
}

// ─── FT-03: C2 answer saved + never re-asked ─────────────────────────────────
async function ft03(db: Client) {
  const u = await createUser(db, "ft-c2repeat", ["Sperm Donor"]);
  try {
    const sid = await initSession(u.auth, false);
    await send(u.auth, sid, "I need a sperm donor");
    const t2 = await send(u.auth, sid, "Tall, athletic, and college educated");
    let asked = /open.{0,80}anonymous|anonymous.{0,80}exclusive/i.test(t2.content) ? t2 : null;
    if (!asked) asked = await send(u.auth, sid, "nothing else matters to me");
    check("donor-type question asked once", /open.{0,80}anonymous|anonymous.{0,80}exclusive/i.test(asked.content), asked.content.slice(0, 100));

    const t3 = await send(u.auth, sid, "Open");
    check(
      "no re-ask after answering",
      !/would you prefer.{0,40}open|open donor.{0,60}anonymous|anonymous.{0,40}exclusive/i.test(t3.content),
      t3.content.slice(0, 120),
    );
    const prof = await db.query(`SELECT "spermDonorType" FROM "IntendedParentProfile" WHERE "parentAccountId" = $1`, [u.acctId]);
    check("spermDonorType saved as Open", prof.rows[0]?.spermDonorType === "Open", JSON.stringify(prof.rows[0]));
  } finally {
    await deleteUser(db, u);
  }
}

// ─── FT-04: buy vials -> checkout card, never a re-presented match ───────────
async function ft04(db: Client) {
  const u = await createUser(db, "ft-buyvials", ["Sperm Donor"]);
  try {
    const sid = await initSession(u.auth, false);
    await send(u.auth, sid, "I need a sperm donor");
    await send(u.auth, sid, "Tall, athletic, and college educated");
    await send(u.auth, sid, "Open");
    const t4 = await send(u.auth, sid, "ready");
    check("match presented before purchase", t4.hasCard || /donor #/i.test(t4.content));

    const t5 = await send(u.auth, sid, "Buy vials now");
    check("no re-presented match card on buy", !t5.hasCard, `hasCard=${t5.hasCard}`);
    check("short confirmation, not a donor re-description", !/matched \d+ preferences|here'?s a match/i.test(t5.content), t5.content.slice(0, 100));

    await new Promise((r) => setTimeout(r, 2500)); // checkout card posts async after the reply
    const cards = await db.query(
      `SELECT "uiCardType", left(content, 140) AS content FROM "AiChatMessage" WHERE "sessionId" = $1 ORDER BY "createdAt" DESC LIMIT 3`,
      [sid],
    );
    const gotCheckout = cards.rows.some((r: any) => r.uiCardType === "bank_checkout");
    const gotAgencyGuidance = cards.rows.some((r: any) => /direct checkout isn'?t available|guide you through their process/i.test(r.content || ""));
    check("checkout card or agency-guidance posted", gotCheckout || gotAgencyGuidance, JSON.stringify(cards.rows));
  } finally {
    await deleteUser(db, u);
  }
}

// ─── Runner (admin test-runner stdout protocol) ──────────────────────────────
const CASES: { id: string; name: string; run: (db: Client) => Promise<void> }[] = [
  { id: "FT-01", name: "Deep-link surrogate pin - 4-turn free-text replay", run: ft01 },
  { id: "FT-02", name: "Confirm-never-overrule - embryos on file, donor requested", run: ft02 },
  { id: "FT-03", name: "Sperm C2 - donor-type answer saved, never re-asked", run: ft03 },
  { id: "FT-04", name: "Buy vials - purchase intent ends in checkout", run: ft04 },
];

(async () => {
  const wanted = filterId ? filterId.split(",").map((s) => s.trim().toUpperCase()) : null;
  const toRun = wanted ? CASES.filter((c) => wanted.includes(c.id)) : CASES;
  console.log(`🧪 Free-Text Request Handling E2E - base: ${BASE}`);
  console.log(`   Running: ${toRun.length} of ${CASES.length} cases${wanted ? ` (filter: ${wanted.join(",")})` : ""}\n`);

  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const suiteStart = Date.now();
  try {
    for (const c of toRun) {
      caseId = c.id;
      caseFails = [];
      console.log(`  ▶ Starting: ${c.id}`);
      console.log(`    ${c.name}`);
      const t0 = Date.now();
      try {
        await c.run(db);
      } catch (e: any) {
        caseFails.push(`scenario crashed: ${(e?.message || String(e)).slice(0, 200)}`);
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (caseFails.length === 0) {
        totalPass++;
        console.log(`  ✅ ${c.id} PASS (${secs}s)`);
      } else {
        totalFail++;
        for (const f of caseFails) console.log(`     [${c.id}] ${f}`);
        console.log(`  ❌ ${c.id} FAIL (${secs}s)`);
      }
    }
  } finally {
    await db.end();
  }
  const totalSecs = Math.round((Date.now() - suiteStart) / 1000);
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${totalPass} passed, ${totalFail} failed (${totalSecs}s total)`);
  process.exit(totalFail ? 1 : 0);
})();
