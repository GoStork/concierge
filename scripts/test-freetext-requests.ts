/**
 * GoStork AI Concierge - Free-Text Request Handling E2E Suite
 *
 * Covers the five failure classes fixed on Jul 24 2026 (see
 * docs/freetext-request-test-plan.md): parents typing requests the scripted
 * flow did not anticipate must NEVER be ignored, steamrolled, overruled, or
 * answered with mismatched quick replies.
 *
 * Scenarios (all against a live server - default http://localhost:5001):
 *  A. Marketplace deep-link (surrogate pin) 4-turn replay:
 *     "schedule a call" -> booking calendar renders
 *     "I am interested in an egg donor" -> egg-donor intake, no detour
 *     "I need a sperm donor" -> stream opens on-topic
 *     "I need a surrogate" (same service as pin) -> engagement, no old-thread bleed
 *  B. Confirm-never-overrule: profile has PGT-A embryos, parent asks for an
 *     egg/sperm donor -> confirm question with ITS OWN quick replies, no refusal
 *  C. C2 no-repeat: donor-type answer is saved deterministically and never re-asked
 *  D. Buy vials: purchase intent ends in a bank_checkout card, never a
 *     re-presented match card
 *
 * Usage:
 *   TEST_BASE_URL=http://localhost:5001 npx tsx scripts/test-freetext-requests.ts
 *
 * Creates throwaway *@gostork-test.com users and deletes them (and all their
 * sessions/messages) at the end of each scenario.
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

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"} - ${label}${detail ? ` :: ${detail}` : ""}`);
  if (ok) pass++;
  else {
    fail++;
    failures.push(label);
  }
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

// ── Scenario A: deep-link pin - the live 4-turn failure replay ───────────────
async function scenarioDeepLink(db: Client) {
  console.log("\n▶ A. Deep-link surrogate pin - 4-turn free-text replay");
  const u = await createUser(db, "ft-deeplink", ["Surrogate"]);
  try {
    const sid = await initSession(u.auth, true);

    const s1 = await send(u.auth, sid, "schedule a call");
    check("A1 booking calendar rendered on 'schedule a call'", !!s1.consultPid, `consultPid=${s1.consultPid}`);

    const s2 = await send(u.auth, sid, "I am interested in an egg donor");
    check("A2 egg-donor request engaged", /egg\s*donor/i.test(s2.content));
    check("A2 no detour to prior context", !/colombia|bio[eé]tica|surrogacy in/i.test(s2.content), s2.content.slice(0, 100));
    check("A2 asks a question", /\?/.test(s2.content));

    const s3 = await send(u.auth, sid, "I need a sperm donor");
    const st = s3.streamed.toLowerCase();
    const spermIdx = st.indexOf("sperm");
    const eggIdx = st.indexOf("egg donor");
    check("A3 final content about sperm donor", /sperm/i.test(s3.content));
    check("A3 stream opens on sperm topic", spermIdx >= 0 && (eggIdx === -1 || spermIdx < eggIdx), st.slice(0, 100));

    const s4 = await send(u.auth, sid, "I need a surrogate");
    check("A4 no old-thread bleed (sperm) on surrogate ask", !/sperm/i.test(s4.content), s4.content.slice(0, 120));
    check("A4 surrogate request engaged", /surrogate/i.test(s4.content));
    check(
      "A4 QRs coherent (never another service's options)",
      s4.qr.length > 0 && !s4.qr.some((q) => /sperm|egg|donor/i.test(q)),
      JSON.stringify(s4.qr),
    );
  } finally {
    await deleteUser(db, u);
  }
}

// ── Scenario B: confirm-never-overrule (profile already has embryos) ─────────
async function scenarioConfirmNotOverrule(db: Client) {
  console.log("\n▶ B. Confirm-never-overrule - embryos on file, donor requested");
  const u = await createUser(db, "ft-overrule", ["Surrogate"]);
  try {
    await db.query(
      `UPDATE "IntendedParentProfile" SET "hasEmbryos" = true, "embryoCount" = 45, "embryosTested" = true WHERE "parentAccountId" = $1`,
      [u.acctId],
    );
    const sid = await initSession(u.auth, true);

    const r1 = await send(u.auth, sid, "I need an egg donor");
    check("B1 no refusal ('don't need')", !/(don'?t|do not|no longer|won'?t)\s+(actually\s+)?need/i.test(r1.content), r1.content.slice(0, 120));
    check("B1 references existing embryos", /embryo/i.test(r1.content));
    check("B1 asks a confirming question", /\?/.test(r1.content));
    check("B1 no directive-label leak", !/acknowledge:|noted:/i.test(r1.content));
    check(
      "B1 QRs answer THE question (not egg/sperm-source options)",
      r1.qr.length > 0 && !r1.qr.some((q) => /^my (own|partner)/i.test(q)) && r1.qr.some((q) => /more embryos|plans have changed/i.test(q)),
      JSON.stringify(r1.qr),
    );

    const r2 = await send(u.auth, sid, "I need to find a sperm donor");
    check(
      "B2 sperm variant: QRs answer THE question",
      r2.qr.length > 0 && !r2.qr.some((q) => /^my (own|partner)|donor sperm/i.test(q)) && r2.qr.some((q) => /more embryos|plans have changed/i.test(q)),
      JSON.stringify(r2.qr),
    );
  } finally {
    await deleteUser(db, u);
  }
}

// ── Scenario C: C2 answer saved + never re-asked ─────────────────────────────
async function scenarioC2NoRepeat(db: Client) {
  console.log("\n▶ C. Sperm C2 - donor-type answer saved, never re-asked");
  const u = await createUser(db, "ft-c2repeat", ["Sperm Donor"]);
  try {
    const sid = await initSession(u.auth, false);
    await send(u.auth, sid, "I need a sperm donor");
    const t2 = await send(u.auth, sid, "Tall, athletic, and college educated");
    let asked = /open.{0,80}anonymous|anonymous.{0,80}exclusive/i.test(t2.content) ? t2 : null;
    if (!asked) asked = await send(u.auth, sid, "nothing else matters to me");
    check("C1 donor-type question asked once", /open.{0,80}anonymous|anonymous.{0,80}exclusive/i.test(asked.content), asked.content.slice(0, 100));

    const t3 = await send(u.auth, sid, "Open");
    check(
      "C2 no re-ask after answering",
      !/would you prefer.{0,40}open|open donor.{0,60}anonymous|anonymous.{0,40}exclusive/i.test(t3.content),
      t3.content.slice(0, 120),
    );
    const prof = await db.query(`SELECT "spermDonorType" FROM "IntendedParentProfile" WHERE "parentAccountId" = $1`, [u.acctId]);
    check("C3 spermDonorType saved as Open", prof.rows[0]?.spermDonorType === "Open", JSON.stringify(prof.rows[0]));
  } finally {
    await deleteUser(db, u);
  }
}

// ── Scenario D: buy vials -> checkout card, never a re-presented match ───────
async function scenarioBuyVials(db: Client) {
  console.log("\n▶ D. Buy vials - purchase intent ends in checkout");
  const u = await createUser(db, "ft-buyvials", ["Sperm Donor"]);
  try {
    const sid = await initSession(u.auth, false);
    await send(u.auth, sid, "I need a sperm donor");
    await send(u.auth, sid, "Tall, athletic, and college educated");
    await send(u.auth, sid, "Open");
    const t4 = await send(u.auth, sid, "ready");
    check("D1 match presented before purchase", t4.hasCard || /donor #/i.test(t4.content));

    const t5 = await send(u.auth, sid, "Buy vials now");
    check("D2 no re-presented match card on buy", !t5.hasCard, `hasCard=${t5.hasCard}`);
    check("D3 short confirmation, not a donor re-description", !/matched \d+ preferences|here'?s a match/i.test(t5.content), t5.content.slice(0, 100));

    await new Promise((r) => setTimeout(r, 2500)); // checkout card posts async after the reply
    const cards = await db.query(
      `SELECT "uiCardType", left(content, 140) AS content FROM "AiChatMessage" WHERE "sessionId" = $1 ORDER BY "createdAt" DESC LIMIT 3`,
      [sid],
    );
    const gotCheckout = cards.rows.some((r: any) => r.uiCardType === "bank_checkout");
    const gotAgencyGuidance = cards.rows.some((r: any) => /direct checkout isn'?t available|guide you through their process/i.test(r.content || ""));
    check("D4 checkout card or agency-guidance posted", gotCheckout || gotAgencyGuidance, JSON.stringify(cards.rows));
  } finally {
    await deleteUser(db, u);
  }
}

(async () => {
  console.log(`🧪 Free-Text Request Handling E2E - base: ${BASE}`);
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  try {
    await scenarioDeepLink(db);
    await scenarioConfirmNotOverrule(db);
    await scenarioC2NoRepeat(db);
    await scenarioBuyVials(db);
  } finally {
    await db.end();
  }
  console.log(`\n${"─".repeat(50)}\nResults: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log("Failed: " + failures.join(" | "));
  process.exit(fail ? 1 : 0);
})();
