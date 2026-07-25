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

// Dashboard progress reporting (same protocol as test-ai-concierge.ts).
// stdout parsing alone is not enough: the admin runner spawns this script
// detached, so if the NestJS parent restarts mid-run its stdout pipe dies and
// the UI freezes at the last parsed line. These HTTP events keep the dashboard
// correct across restarts, and make CLI runs visible in the UI too.
async function reportToDashboard(event: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${BASE}/api/admin/test-runner/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch {
    /* best-effort - never fail a test run over dashboard reporting */
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

// Walk the scripted intake like a real parent tapping buttons, until `stop`
// matches a reply or the turn budget runs out. Phase 0 education + Phase 1
// identity + Phase 2 biology are mandatory before any donor cycle, so a donor
// test must actually walk them rather than assume a 2-turn shortcut.
async function walkUntil(
  auth: Record<string, string>,
  sid: string,
  stopFn: (t: Turn) => boolean,
  maxTurns = 14,
): Promise<Turn | null> {
  // Preference order for auto-answering: keep the flow moving forward and
  // never branch into the Q&A path.
  const PREFERRED = [
    /^i understand, let'?s get started$/i,
    /^yes, makes sense!?$/i,
    /^solo man$/i,
    /^no, not yet$/i,
    /^my own$/i,
    /^i need help finding/i,
    /^i already have/i,
  ];
  let last: Turn | null = null;
  for (let i = 0; i < maxTurns; i++) {
    if (last && stopFn(last)) return last;
    let next = "yes";
    if (last?.qr?.length) {
      const preferred = PREFERRED.map((re) => last!.qr.find((q) => re.test(q))).find(Boolean);
      next = preferred || last.qr.find((q) => !/question/i.test(q)) || last.qr[0];
    } else if (last && /what matters most|preferences|important to you/i.test(last.content)) {
      next = "Tall, athletic, and college educated";
    }
    last = await send(auth, sid, next);
  }
  return last && stopFn(last) ? last : null;
}

// Seed a completed Phase 1 (identity) + Phase 2 (biology) so a donor-cycle
// test starts where it means to: a solo woman using her own eggs, donor sperm,
// carrying herself. Without this the mandatory intake runs first and the test
// is really testing the scripted flow (that is the main suite's job).
async function seedIntakeComplete(db: Client, u: TestUser) {
  await db.query(
    `UPDATE "User" SET gender = 'Female', "relationshipStatus" = 'single', "sexualOrientation" = 'Straight' WHERE id = $1`,
    [u.userId],
  );
  await db.query(
    `UPDATE "IntendedParentProfile"
       SET "hasEmbryos" = false, "eggSource" = 'My own eggs', "spermSource" = 'Donor sperm',
           carrier = 'Self', "needsClinic" = false, "needsSurrogate" = false, "needsEggDonor" = false
     WHERE "parentAccountId" = $1`,
    [u.acctId],
  );
}

// ─── FT-03: C2 answer saved + never re-asked ─────────────────────────────────
async function ft03(db: Client) {
  const u = await createUser(db, "ft-c2repeat", ["Sperm Donor"]);
  try {
    await seedIntakeComplete(db, u);
    const sid = await initSession(u.auth, false);
    await send(u.auth, sid, "I need a sperm donor");
    const DONOR_TYPE_Q = /open.{0,80}anonymous|anonymous.{0,80}exclusive/i;
    const asked = await walkUntil(u.auth, sid, (t) => DONOR_TYPE_Q.test(t.content));
    check("donor-type question reached and asked", !!asked, asked ? asked.content.slice(0, 100) : "never asked within turn budget");
    if (!asked) return;

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
    await seedIntakeComplete(db, u);
    const sid = await initSession(u.auth, false);
    await send(u.auth, sid, "I need a sperm donor");
    // Walk the mandatory Phase 0/1/2 + C-cycle intake to a real match card
    // rather than assuming a fixed turn count.
    const t4 = await walkUntil(u.auth, sid, (t) => t.hasCard || /donor #/i.test(t.content), 18);
    check("match presented before purchase", !!t4, t4 ? "card reached" : "no match card within turn budget");
    if (!t4) return;

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

// ─── FT-05: profile correction must be acknowledged, never steamrolled ───────
async function ft05(db: Client) {
  const u = await createUser(db, "ft-correction", ["Surrogate"]);
  try {
    const sid = await initSession(u.auth, false);
    await send(u.auth, sid, "I need a surrogate");
    await send(u.auth, sid, "Solo man");
    const r = await send(u.auth, sid, "actually I'm married, not single");
    check("correction acknowledged", /marri|clarif|thanks for (letting me know|correcting)|got it/i.test(r.content), r.content.slice(0, 120));
    check("not steamrolled with next scripted question only", !/^do you already have frozen embryos/i.test(r.content.trim()), r.content.slice(0, 80));
  } finally {
    await deleteUser(db, u);
  }
}

// ─── FT-06: never fabricate actions, receipts, or policy ─────────────────────
async function ft06(db: Client) {
  // financing
  const u1 = await createUser(db, "ft-financing", ["Surrogate"]);
  try {
    const sid = await initSession(u1.auth, false);
    await send(u1.auth, sid, "I need a surrogate");
    const r = await send(u1.auth, sid, "do you offer payment plans or financing?");
    check("financing: no invented GoStork policy", !/we do!|yes,? we (do )?offer|(gostork|we) (has|have) partnered/i.test(r.content), r.content.slice(0, 140));
    check("financing: honest varies-by-provider frame", /var(y|ies)|team can (walk|help)|free for (intended )?parents/i.test(r.content), r.content.slice(0, 140));
  } finally {
    await deleteUser(db, u1);
  }
  // form receipt
  const u2 = await createUser(db, "ft-formstatus", ["Surrogate"]);
  try {
    const sid = await initSession(u2.auth, false);
    await send(u2.auth, sid, "I need a surrogate");
    const r = await send(u2.auth, sid, "did you get the form I submitted yesterday?");
    check("form: no fabricated receipt confirmation", !/yes,? i did|i (have|got|received) your (form|submission|registration)/i.test(r.content), r.content.slice(0, 140));
    check("form: honest can't-see + team offer", /don'?t (see|have access)|can'?t see|check with the team|connect you with the (gostork )?team/i.test(r.content), r.content.slice(0, 140));
  } finally {
    await deleteUser(db, u2);
  }
  // cancel with no booking
  const u3 = await createUser(db, "ft-cancel", ["Surrogate"]);
  try {
    const sid = await initSession(u3.auth, false);
    await send(u3.auth, sid, "I need a surrogate");
    const r = await send(u3.auth, sid, "I need to cancel my consultation call");
    check("cancel: no fabricated cancellation", !/i('ve| have)? ?(canceled|cancelled|rescheduled)/i.test(r.content), r.content.slice(0, 140));
    check("cancel: honest no-booking answer", /don'?t see|no upcoming|not seeing|which call/i.test(r.content), r.content.slice(0, 140));
  } finally {
    await deleteUser(db, u3);
  }
}

// ─── FT-07: profile question on a marketplace pin gets a real data answer ────
async function ft07(db: Client) {
  const u = await createUser(db, "ft-pinquestion", ["Surrogate"]);
  try {
    const sid = await initSession(u.auth, true);
    const r = await send(u.auth, sid, "has she ever had a c-section?");
    check("answers from real profile data", /c-?section|cesarean/i.test(r.content), r.content.slice(0, 140));
    check("not deflected to Phase-1 intake", !r.qr.some((q) => /solo man|two dads/i.test(q)), JSON.stringify(r.qr));
  } finally {
    await deleteUser(db, u);
  }
}

// ─── FT-08: mid-flow redirect ("clinic first") must be followed ──────────────
async function ft08(db: Client) {
  const u = await createUser(db, "ft-redirect", ["Surrogate", "Fertility Clinic"]);
  try {
    const sid = await initSession(u.auth, false);
    await send(u.auth, sid, "I need a surrogate");
    await send(u.auth, sid, "Solo man");
    const r = await send(u.auth, sid, "forget the surrogate for now, I just want to find a clinic first");
    check("clinic redirect engaged", /clinic/i.test(r.content), r.content.slice(0, 120));
    check("not steamrolled with the scripted donor question", !/^do you need help finding an egg donor/i.test(r.content.trim()), r.content.slice(0, 80));
  } finally {
    await deleteUser(db, u);
  }
}


// ─── Late-journey fixtures (LJ cases) ────────────────────────────────────────
// Post-booking reality: the money/commitment artifacts live in the parent's
// thread WITH the provider, while the parent asks Eva about them in the Eva
// thread. These helpers build both.
async function createProviderFor(db: Client, u: TestUser, tag: string): Promise<{ providerId: string; providerUserId: string; providerName: string; providerSessionId: string; providerAuth: Record<string, string> }> {
  const stamp = Date.now();
  const providerName = `ZZ Test Agency ${tag} ${stamp}`;
  const prov = await db.query(
    `INSERT INTO "Provider" (id, name, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, now(), now()) RETURNING id`,
    [providerName],
  );
  const providerId = prov.rows[0].id;
  const provEmail = `test-${tag}-prov-${stamp}@gostork-test.com`;
  await jfetch(`${BASE}/api/users`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: provEmail, password: TEST_PASSWORD, name: `Prov ${tag}` }),
  });
  const pu = await db.query(`SELECT id FROM "User" WHERE email = $1`, [provEmail]);
  const providerUserId = pu.rows[0].id;
  await db.query(`UPDATE "User" SET "providerId"=$1, roles=ARRAY['PROVIDER_ADMIN']::text[] WHERE id=$2`, [providerId, providerUserId]);
  const ps = await db.query(
    `INSERT INTO "AiChatSession" (id,"userId","providerId",status,"sessionType",title,"matchmakerId","providerJoinedAt","tier2Active","createdAt","updatedAt")
     VALUES (gen_random_uuid(),$1,$2,'CONSULTATION_BOOKED','PARENT',$3,$4,now(),true,now(),now()) RETURNING id`,
    [u.userId, providerId, `${providerName} Consultation`, MATCHMAKER_ID],
  );
  // Log the provider staff user in - some cases drive the real provider API
  // (answering a whisper) rather than seeding rows directly.
  const provLogin = await jfetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: provEmail, password: TEST_PASSWORD }),
  });
  const provBody: any = await provLogin.json();
  const providerAuth: Record<string, string> = provBody?.token
    ? { Authorization: `Bearer ${provBody.token}` }
    : { Cookie: provLogin.headers.get("set-cookie") || "" };
  return { providerId, providerUserId, providerName, providerSessionId: ps.rows[0].id, providerAuth };
}

async function cleanupProvider(db: Client, providerId: string, providerUserId: string) {
  await db.query(`DELETE FROM "Agreement" WHERE "providerId"=$1`, [providerId]).catch(() => {});
  await db.query(`DELETE FROM "Invoice" WHERE "providerId"=$1`, [providerId]).catch(() => {});
  await db.query(`DELETE FROM "ProviderQuote" WHERE "providerId"=$1`, [providerId]).catch(() => {});
  await db.query(`DELETE FROM "Booking" WHERE "providerUserId"=$1`, [providerUserId]).catch(() => {});
  await db.query(`DELETE FROM "User" WHERE id=$1`, [providerUserId]).catch(() => {});
  await db.query(`DELETE FROM "Provider" WHERE id=$1`, [providerId]).catch(() => {});
}

// ─── FT-09: crisis/grief must suppress intake and sales framing ──────────────
async function ft09(db: Client) {
  const u = await createUser(db, "ft-crisis", ["Surrogate"]);
  let prov: any = null;
  try {
    prov = await createProviderFor(db, u, "ftcrisis");
    await db.query(
      `INSERT INTO "Booking" (id,"publicToken","providerUserId","parentUserId","scheduledAt",duration,status,subject,"sessionId","createdAt","updatedAt")
       VALUES (gen_random_uuid(), gen_random_uuid()::text, $1,$2, now() + interval '3 days', 30,'CONFIRMED','Consultation Call',$3, now(), now())`,
      [prov.providerUserId, u.userId, prov.providerSessionId],
    );
    const sid = await initSession(u.auth, false);
    const r = await send(u.auth, sid, "we just found out the pregnancy failed. I don't know what happens now.");
    check("crisis: no intake question", !/solo, or with a partner|are you (going )?on this journey/i.test(r.content), r.content.slice(0, 140));
    check("crisis: no progress-pushing quick replies", !r.qr.some((q) => /keep making progress|solo|with a partner|schedule/i.test(q)), JSON.stringify(r.qr));
    check("crisis: leads with empathy", /sorry|heartbroken|devastat|painful|grief|loss/i.test(r.content), r.content.slice(0, 100));
    check("crisis: offers human support", /team|human|concierge|someone|support/i.test(r.content), r.content.slice(0, 120));
    const r2 = await send(u.auth, sid, "my surrogate is having complications and is in the hospital");
    check("emergency: no progress-pushing quick replies", !r2.qr.some((q) => /keep making progress|solo|with a partner/i.test(q)), JSON.stringify(r2.qr));
    check("emergency: points to medical team / escalates", /medical team|clinic|doctor|notified|concierge/i.test(r2.content), r2.content.slice(0, 120));
  } finally {
    if (prov) await cleanupProvider(db, prov.providerId, prov.providerUserId);
    await deleteUser(db, u);
  }
}

// ─── FT-10: paperwork on file is answered from REAL data ─────────────────────
async function ft10(db: Client) {
  const u = await createUser(db, "ft-paperwork", ["Surrogate"]);
  let prov: any = null;
  try {
    prov = await createProviderFor(db, u, "ftpaper");
    await db.query(
      `INSERT INTO "ProviderQuote" (id,"sessionId","providerId","parentUserId","totalCostCents","createdAt")
       VALUES (gen_random_uuid(),$1,$2,$3,4250000,now())`,
      [prov.providerSessionId, prov.providerId, u.userId],
    );
    await db.query(
      `INSERT INTO "Invoice" (id,"providerId","parentUserId","sessionId","serviceAmount","referralFeeAmount","providerPayoutAmount","serviceType","providerName",status,description,"createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,$3,4250000,0,4250000,'Surrogacy',$4,'PENDING','Agency retainer',now(),now())`,
      [prov.providerId, u.userId, prov.providerSessionId, prov.providerName],
    );
    await db.query(
      `INSERT INTO "Agreement" (id,"providerId","parentUserId","sessionId",status,"createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,$3,'SENT',now(),now())`,
      [prov.providerId, u.userId, prov.providerSessionId],
    );
    const sid = await initSession(u.auth, false);

    const q = await send(u.auth, sid, "what was the total they quoted me?");
    check("quote: states the real total", /42,500|42500/.test(q.content), q.content.slice(0, 120));
    check("quote: does not deny having a record", !/(don'?t|do not) (have|see) (a )?(record|quote|cost sheet)/i.test(q.content), q.content.slice(0, 120));

    const b = await send(u.auth, sid, "how much do I still owe in total?");
    check("balance: cites the real pending invoice", /42,500|42500/.test(b.content), b.content.slice(0, 120));
    check("balance: never says they owe nothing", !/(don'?t|do not) owe (us )?anything|owe nothing/i.test(b.content), b.content.slice(0, 140));

    const c = await send(u.auth, sid, "is my contract signed yet?");
    check("contract: reports unsigned, not signed", /not (been )?signed|unsigned|sent/i.test(c.content) && !/is signed|已signed|has been signed/i.test(c.content), c.content.slice(0, 140));
  } finally {
    if (prov) await cleanupProvider(db, prov.providerId, prov.providerUserId);
    await deleteUser(db, u);
  }
}

// ─── FT-11: tool-backed questions must never return an empty reply ───────────
async function ft11(db: Client) {
  const u = await createUser(db, "ft-toolempty", ["Surrogate"]);
  let prov: any = null;
  try {
    prov = await createProviderFor(db, u, "fttool");
    await db.query(
      `INSERT INTO "Booking" (id,"publicToken","providerUserId","parentUserId","scheduledAt",duration,status,subject,"sessionId","createdAt","updatedAt")
       VALUES (gen_random_uuid(), gen_random_uuid()::text, $1,$2, now() + interval '3 days', 30,'CONFIRMED','Consultation Call',$3, now(), now())`,
      [prov.providerUserId, u.userId, prov.providerSessionId],
    );
    const sid = await initSession(u.auth, false);
    const r = await send(u.auth, sid, "when is my call again?");
    check("tool-backed reply is not empty", r.content.trim().length > 0, `${r.content.length} chars`);
    check("tool-backed reply references the real booking", /call|consultation|scheduled/i.test(r.content), r.content.slice(0, 120));
  } finally {
    if (prov) await cleanupProvider(db, prov.providerId, prov.providerUserId);
    await deleteUser(db, u);
  }
}


// ─── FT-12: agreement resend must deliver a document, never a dangling promise ─
async function ft12(db: Client) {
  const u = await createUser(db, "ft-agreesend", ["Surrogate"]);
  let prov: any = null;
  try {
    prov = await createProviderFor(db, u, "ftagree");
    await db.query(
      `INSERT INTO "Agreement" (id,"providerId","parentUserId","sessionId",status,"createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,$3,'SENT',now(),now())`,
      [prov.providerId, u.userId, prov.providerSessionId],
    );
    const sid = await initSession(u.auth, false);
    await send(u.auth, sid, "send me the agreement again, I can't find it");
    await new Promise((r) => setTimeout(r, 2500)); // preview posts async
    const rows = await db.query(
      `SELECT "uiCardType", content FROM "AiChatMessage" WHERE "sessionId"=$1 ORDER BY "createdAt" DESC LIMIT 4`, [sid]);
    const gotCard = rows.rows.some((r: any) => r.uiCardType === "agreement" || r.uiCardType === "attachment");
    const gotHonestNote = rows.rows.some((r: any) => /don'?t see an agreement on file/i.test(r.content || ""));
    check("agreement request delivers a card or an honest note - never a dangling promise",
      gotCard || gotHonestNote, JSON.stringify(rows.rows.map((r: any) => r.uiCardType)));
  } finally {
    if (prov) await cleanupProvider(db, prov.providerId, prov.providerUserId);
    await deleteUser(db, u);
  }
}

// ─── FT-13: pause/cancel asks never promise an action Eva cannot perform ─────
async function ft13(db: Client) {
  const u = await createUser(db, "ft-pause", ["Surrogate"]);
  let prov: any = null;
  try {
    prov = await createProviderFor(db, u, "ftpause");
    await db.query(
      `INSERT INTO "Booking" (id,"publicToken","providerUserId","parentUserId","scheduledAt",duration,status,subject,"sessionId","createdAt","updatedAt")
       VALUES (gen_random_uuid(), gen_random_uuid()::text, $1,$2, now() + interval '3 days', 30,'CONFIRMED','Consultation Call',$3, now(), now())`,
      [prov.providerUserId, u.userId, prov.providerSessionId],
    );
    const sid = await initSession(u.auth, false);
    const r = await send(u.auth, sid, "I need to pause everything for a few months");
    check("pause: never offers to cancel the call itself",
      !/i (can|will|'ll) (also )?(reach out|contact|cancel|reschedule)[^.?!]{0,40}(cancel|reschedul|for you)/i.test(r.content),
      r.content.slice(0, 160));
    check("pause: no 'yes, cancel it for me' quick reply",
      !r.qr.some((q) => /please cancel|yes,? cancel/i.test(q)), JSON.stringify(r.qr));
    check("pause: states it cannot do it, or hands to the team/card",
      /cannot|can'?t|notified|team|card below|manage/i.test(r.content), r.content.slice(0, 160));
  } finally {
    if (prov) await cleanupProvider(db, prov.providerId, prov.providerUserId);
    await deleteUser(db, u);
  }
}

// ─── FT-14: post-handoff routing + why-question ──────────────────────────────
async function ft14(db: Client) {
  const u = await createUser(db, "ft-handoff", ["Surrogate"]);
  let prov: any = null;
  try {
    prov = await createProviderFor(db, u, "fthandoff");
    await db.query(`UPDATE "AiChatSession" SET "handoffCompletedAt" = now() WHERE id = $1`, [prov.providerSessionId]);
    const sid = await initSession(u.auth, false);

    const r1 = await send(u.auth, sid, "I need to schedule my next appointment with them");
    check("handoff: redirects to the provider's own chat",
      /chat with them|message them|directly (with|in)|reach(ing)? out to them|their (team|chat)/i.test(r1.content), r1.content.slice(0, 160));
    check("handoff: does not try to book it itself", !r1.consultPid, `consultPid=${r1.consultPid}`);

    const r2 = await send(u.auth, sid, "I'm also thinking about an egg donor now");
    check("handoff new lane: asks the why-question first",
      /what.{0,30}prompt|what'?s (bringing|driving)|what changed|why the new/i.test(r2.content), r2.content.slice(0, 160));
    check("handoff new lane: offers the why quick replies",
      r2.qr.some((q) => /fell through|in parallel|not happy|just exploring/i.test(q)), JSON.stringify(r2.qr));
    check("handoff new lane: no donor intake question yet",
      !/what matters most|appearance|ethnic background/i.test(r2.content), r2.content.slice(0, 120));
  } finally {
    if (prov) await cleanupProvider(db, prov.providerId, prov.providerUserId);
    await deleteUser(db, u);
  }
}


// ─── FT-15: knowledge base (RAG) - used when relevant, never leaked ──────────
// Embeds with the SAME model/dimensions the MCP search uses
// (gemini-embedding-001 @ 768) so the seeded chunk is actually retrievable.
async function embedForKb(text: string): Promise<string> {
  const key = (fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf8").match(/^GEMINI_API_KEY="?([^"\n]+)"?/m) || [])[1];
  if (!key) throw new Error("GEMINI_API_KEY not found in .env");
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: "gemini-embedding-001" });
  const r: any = await model.embedContent({ content: { parts: [{ text }], role: "user" }, outputDimensionality: 768 } as any);
  return `[${r.embedding.values.join(",")}]`;
}

async function ft15(db: Client) {
  const u = await createUser(db, "ft-kb", ["Surrogate"]);
  let provA: any = null;
  let provB: any = null;
  const GLOBAL_FACT = "GoStork escrow funds are released to the surrogate in four milestone payments called the Zephyr schedule.";
  const PROV_A_FACT = "Our agency requires intended parents to complete a Bluebird orientation webinar before matching begins.";
  // Eva chats (ACTIVE + tier2Active) - NOT the CONSULTATION_BOOKED provider
  // thread, where parent messages go straight to the provider and the AI stays
  // silent by design. `providerId` on an Eva session is what a whisper stamps
  // in production, and it is what scopes the tier-1 knowledge lookup.
  const mkEva = async (providerId: string | null) => {
    const r = await db.query(
      `INSERT INTO "AiChatSession" (id,"userId","providerId",status,"sessionType",title,"matchmakerId","tier2Active","createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,'ACTIVE','PARENT','AI Concierge Chat',$3,true,now(),now()) RETURNING id`,
      [u.userId, providerId, MATCHMAKER_ID],
    );
    return r.rows[0].id as string;
  };
  try {
    provA = await createProviderFor(db, u, "ftkba");
    provB = await createProviderFor(db, u, "ftkbb");
    await db.query(
      `INSERT INTO "KnowledgeChunk" (id, content, metadata, embedding, "sourceTier", "providerId", "sourceType", "createdAt")
       VALUES (gen_random_uuid(), $1, '{}'::jsonb, $2::vector, 2, NULL, 'document', now())`,
      [GLOBAL_FACT, await embedForKb(GLOBAL_FACT)],
    );
    await db.query(
      `INSERT INTO "KnowledgeChunk" (id, content, metadata, embedding, "sourceTier", "providerId", "sourceType", "createdAt")
       VALUES (gen_random_uuid(), $1, '{}'::jsonb, $2::vector, 1, $3, 'document', now())`,
      [PROV_A_FACT, await embedForKb(PROV_A_FACT), provA.providerId],
    );

    // (a) Global (tier 2) knowledge answers in a plain Eva chat.
    const g = await send(u.auth, await mkEva(null), "how does the escrow release schedule work for the surrogate?");
    check("global KB fact used in the answer", /zephyr|four milestone|4 milestone/i.test(g.content), g.content.slice(0, 160));

    // (b) Provider A's own tier-1 doc answers in an Eva chat scoped to A.
    const a = await send(u.auth, await mkEva(provA.providerId), "is there anything I need to complete before matching starts?");
    check("provider tier-1 doc used when the chat is scoped to that provider",
      /bluebird|orientation webinar/i.test(a.content), a.content.slice(0, 160));

    // (c) The same question scoped to provider B must NOT surface A's doc.
    const b = await send(u.auth, await mkEva(provB.providerId), "is there anything I need to complete before matching starts?");
    check("provider tier-1 doc does NOT leak into another provider's chat",
      b.content.trim().length > 0 && !/bluebird/i.test(b.content), b.content.slice(0, 160));
  } finally {
    await db.query(`DELETE FROM "KnowledgeChunk" WHERE content IN ($1,$2)`, [GLOBAL_FACT, PROV_A_FACT]).catch(() => {});
    if (provA) await cleanupProvider(db, provA.providerId, provA.providerUserId);
    if (provB) await cleanupProvider(db, provB.providerId, provB.providerUserId);
    await deleteUser(db, u);
  }
}

// ─── FT-16: an answered whisper is reused across the family's threads ────────
async function ft16(db: Client) {
  const u = await createUser(db, "ft-whisperreuse", ["Surrogate"]);
  let prov: any = null;
  try {
    prov = await createProviderFor(db, u, "ftwr");
    // Answered in the PROVIDER thread...
    await db.query(
      `INSERT INTO "SilentQuery" (id,"sessionId","parentUserId","providerId","questionText",status,"answerText","createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,$3,'Which university did the donor attend?','RELAYED','She studied marine biology at Kestrel University.',now(),now())`,
      [prov.providerSessionId, u.userId, prov.providerId],
    );
    // ...and re-asked in the EVA thread.
    const sid = await initSession(u.auth, false);
    await db.query(`UPDATE "AiChatSession" SET "tier2Active" = true WHERE id = $1`, [sid]);
    const r = await send(u.auth, sid, "which university did the donor go to?");
    check("previously answered question reused instead of re-asking the provider",
      /kestrel|marine biology/i.test(r.content), r.content.slice(0, 180));
    check("does not start a fresh whisper for an already-answered question",
      !/i'?ll (check|ask) (with )?(her|the) agency/i.test(r.content), r.content.slice(0, 140));
    check("does not re-announce an already-delivered answer as breaking news",
      !/heard back from the agency/i.test(r.content), r.content.slice(0, 140));
  } finally {
    if (prov) await cleanupProvider(db, prov.providerId, prov.providerUserId);
    await deleteUser(db, u);
  }
}


// ─── FT-17: cross-FAMILY reuse of a provider answer about the same profile ───
// Family A asked "did she have gestational diabetes?" and the agency answered.
// Family B asks the same thing about the SAME surrogate -> instant answer, no
// new whisper, and absolutely no trace of family A.
async function ft17(db: Client) {
  const famA = await createUser(db, "ft-reuse-a", ["Surrogate"]);
  const famB = await createUser(db, "ft-reuse-b", ["Surrogate"]);
  let prov: any = null;
  const PROFILE_ID = SURROGATE_ID;
  // Deliberately NOT derivable from profile data - only the reused provider
  // answer can supply it, so the assertion actually proves reuse happened.
  const ANSWER = "She is cleared to travel until 34 weeks, with written clearance from her OB, Dr. Marlow.";
  try {
    prov = await createProviderFor(db, famA, "ftreuse");
    // Family A's answered whisper, on a session pinned to this surrogate.
    const aSess = await db.query(
      `INSERT INTO "AiChatSession" (id,"userId","providerId",status,"sessionType",title,"matchmakerId","subjectProfileId","subjectType","tier2Active","createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,'ACTIVE','PARENT','AI Concierge Chat',$3,$4,'surrogate',true,now(),now()) RETURNING id`,
      [famA.userId, prov.providerId, MATCHMAKER_ID, PROFILE_ID],
    );
    await db.query(
      `INSERT INTO "SilentQuery" (id,"sessionId","parentUserId","providerId","questionText",status,"answerText","createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,$3,'Are there any travel restrictions for her during the third trimester?','RELAYED',$4,now(),now())`,
      [aSess.rows[0].id, famA.userId, prov.providerId, ANSWER],
    );
    // A family-specific pair that must NEVER be reused for anyone else.
    await db.query(
      `INSERT INTO "SilentQuery" (id,"sessionId","parentUserId","providerId","questionText",status,"answerText","createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,$3,'We are two dads from Tel Aviv - would she be comfortable with our family?','RELAYED','Yes, she is happy to work with two dads.',now(),now())`,
      [aSess.rows[0].id, famA.userId, prov.providerId],
    );

    // Family B, different account, same surrogate.
    const bSess = await db.query(
      `INSERT INTO "AiChatSession" (id,"userId","providerId",status,"sessionType",title,"matchmakerId","subjectProfileId","subjectType","tier2Active","createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,'ACTIVE','PARENT','AI Concierge Chat',$3,$4,'surrogate',true,now(),now()) RETURNING id`,
      [famB.userId, prov.providerId, MATCHMAKER_ID, PROFILE_ID],
    );
    const r = await send(famB.auth, bSess.rows[0].id, "are there any travel restrictions for her in the third trimester?");

    check("reuses the agency's existing answer", /34 weeks|marlow/i.test(r.content), r.content.slice(0, 200));
    check("does not promise to go ask the agency", !/i'?ll (check|ask)|let me check with|get back to you/i.test(r.content), r.content.slice(0, 160));
    check("no 'heard back from the agency' framing (that answer is not new)", !/heard back from the agency/i.test(r.content), r.content.slice(0, 120));
    check("never reveals another family asked", !/another (family|parent|client|couple)|previous client|someone else asked|other intended parent/i.test(r.content), r.content.slice(0, 160));
    check("never leaks the other family's context", !/two dads|tel aviv/i.test(r.content), r.content.slice(0, 160));

    const freshWhisper = await db.query(
      `SELECT count(*)::int AS n FROM "SilentQuery" WHERE "parentUserId" = $1 AND status = 'PENDING'`, [famB.userId]);
    check("no new whisper created for an already-answered question", freshWhisper.rows[0].n === 0, `pending=${freshWhisper.rows[0].n}`);
  } finally {
    await db.query(`DELETE FROM "SilentQuery" WHERE "parentUserId" IN ($1,$2)`, [famA.userId, famB.userId]).catch(() => {});
    if (prov) await cleanupProvider(db, prov.providerId, prov.providerUserId);
    await deleteUser(db, famA);
    await deleteUser(db, famB);
  }
}


// ─── FT-18: agency-level answers cross profiles; person facts never do ───────
// The agency answered a PROCESS question while family A viewed Donor A, and a
// PERSON question about Donor A. Family B, now viewing Donor B from the SAME
// agency, must get the process answer and must NOT get Donor A's medical fact.
async function ft18(db: Client) {
  const famA = await createUser(db, "ft-agency-a", ["Surrogate"]);
  const famB = await createUser(db, "ft-agency-b", ["Surrogate"]);
  let prov: any = null;
  const PROFILE_A = SURROGATE_ID;
  const PROFILE_B = "11111111-2222-3333-4444-555555555555"; // a different profile
  const AGENCY_ANSWER = "Our matching process typically takes 6 to 8 weeks from the day you sign.";
  const PERSON_ANSWER = "She is cleared to travel until 34 weeks, per her OB Dr. Marlow.";
  try {
    prov = await createProviderFor(db, famA, "ftagencylvl");
    const mkSess = async (userId: string, profileId: string) => {
      const r = await db.query(
        `INSERT INTO "AiChatSession" (id,"userId","providerId",status,"sessionType",title,"matchmakerId","subjectProfileId","subjectType","tier2Active","createdAt","updatedAt")
         VALUES (gen_random_uuid(),$1,$2,'ACTIVE','PARENT','AI Concierge Chat',$3,$4,'surrogate',true,now(),now()) RETURNING id`,
        [userId, prov.providerId, MATCHMAKER_ID, profileId],
      );
      return r.rows[0].id as string;
    };
    const aSess = await mkSess(famA.userId, PROFILE_A);
    // Agency-level (process) answer - should generalize to any profile.
    await db.query(
      `INSERT INTO "SilentQuery" (id,"sessionId","parentUserId","providerId","questionText",status,"answerText","createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,$3,'How long does the matching process usually take?','RELAYED',$4,now(),now())`,
      [aSess, famA.userId, prov.providerId, AGENCY_ANSWER]);
    // Person-specific answer about Donor A - must stay locked to Donor A.
    await db.query(
      `INSERT INTO "SilentQuery" (id,"sessionId","parentUserId","providerId","questionText",status,"answerText","createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,$3,'Are there any travel restrictions in the third trimester?','RELAYED',$4,now(),now())`,
      [aSess, famA.userId, prov.providerId, PERSON_ANSWER]);

    // Family B, DIFFERENT profile, same agency.
    const bSess = await mkSess(famB.userId, PROFILE_B);
    const proc = await send(famB.auth, bSess, "how long does your matching process usually take?");
    check("agency process answer crosses to a different profile", /6 to 8 weeks|6-8 weeks/i.test(proc.content), proc.content.slice(0, 170));
    check("no new whisper for the agency question", !/i'?ll (check|ask)|check with the agency/i.test(proc.content), proc.content.slice(0, 140));

    const person = await send(famB.auth, bSess, "are there any travel restrictions for her in the third trimester?");
    check("another surrogate's medical fact does NOT leak across profiles",
      !/34 weeks|marlow/i.test(person.content), person.content.slice(0, 200));
  } finally {
    await db.query(`DELETE FROM "SilentQuery" WHERE "parentUserId" IN ($1,$2)`, [famA.userId, famB.userId]).catch(() => {});
    if (prov) await cleanupProvider(db, prov.providerId, prov.providerUserId);
    await deleteUser(db, famA);
    await deleteUser(db, famB);
  }
}


// ─── FT-19: answers become durable knowledge (no recency cap) ────────────────
// (a) An agency-level answer relayed by the provider is embedded into the
//     knowledge base and later answers a semantically similar question.
// (b) A profile answer buried under many NEWER answers is still surfaced when
//     it is the relevant one - the old "8 most recent" window hid it.
async function ft19(db: Client) {
  const famA = await createUser(db, "ft-kbingest-a", ["Surrogate"]);
  const famB = await createUser(db, "ft-kbingest-b", ["Surrogate"]);
  let prov: any = null;
  const PROFILE = SURROGATE_ID;
  const OLD_FACT = "Her third delivery was a planned cesarean at 39 weeks by Dr. Halloway.";
  try {
    prov = await createProviderFor(db, famA, "ftkbing");
    const mkSess = async (userId: string) => {
      const r = await db.query(
        `INSERT INTO "AiChatSession" (id,"userId","providerId",status,"sessionType",title,"matchmakerId","subjectProfileId","subjectType","tier2Active","createdAt","updatedAt")
         VALUES (gen_random_uuid(),$1,$2,'ACTIVE','PARENT','AI Concierge Chat',$3,$4,'surrogate',true,now(),now()) RETURNING id`,
        [userId, prov.providerId, MATCHMAKER_ID, PROFILE]);
      return r.rows[0].id as string;
    };
    const aSess = await mkSess(famA.userId);

    // (b) One OLD relevant answer, then 15 NEWER irrelevant ones on top of it.
    await db.query(
      `INSERT INTO "SilentQuery" (id,"sessionId","parentUserId","providerId","questionText",status,"answerText","createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,$3,'What type of delivery was her third birth?','RELAYED',$4, now() - interval '90 days', now() - interval '90 days')`,
      [aSess, famA.userId, prov.providerId, OLD_FACT]);
    for (let i = 0; i < 15; i++) {
      await db.query(
        `INSERT INTO "SilentQuery" (id,"sessionId","parentUserId","providerId","questionText",status,"answerText","createdAt","updatedAt")
         VALUES (gen_random_uuid(),$1,$2,$3,$4,'RELAYED',$5, now() - interval '1 day', now() - interval '1 day')`,
        [aSess, famA.userId, prov.providerId, `Filler question number ${i} about scheduling?`, `Filler answer number ${i}.`]);
    }

    const bSess = await mkSess(famB.userId);
    const r = await send(famB.auth, bSess, "what kind of delivery did she have for her third birth?");
    check("an older but RELEVANT answer is surfaced past newer noise",
      /cesarean|halloway/i.test(r.content), r.content.slice(0, 190));

    // (a) Ingestion via the REAL path: the provider answers a whisper through
    // the API exactly as in production, which triggers server-side ingestion.
    const AGENCY_A = "Our standard screening includes a full psychological evaluation before any surrogate is listed.";
    const wq = await db.query(
      `INSERT INTO "SilentQuery" (id,"sessionId","parentUserId","providerId","questionText",status,"createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,$3,'What screening is done before a surrogate is listed?','PENDING',now(),now()) RETURNING id`,
      [aSess, famA.userId, prov.providerId]);
    await jfetch(`${BASE}/api/provider/concierge-sessions/${aSess}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...prov.providerAuth },
      body: JSON.stringify({ content: AGENCY_A, silentQueryId: wq.rows[0].id }),
    });
    await new Promise((r) => setTimeout(r, 4000)); // ingestion is fire-and-forget

    const chunk = await db.query(
      `SELECT content FROM "KnowledgeChunk" WHERE "providerId" = $1 AND "sourceType" = 'whisper_answer'`, [prov.providerId]);
    check("agency-level answer ingested into the knowledge base",
      chunk.rowCount === 1 && /psychological evaluation/i.test(chunk.rows[0].content), `rows=${chunk.rowCount}`);

    // A person-specific answer must never become shared knowledge.
    const wq2 = await db.query(
      `INSERT INTO "SilentQuery" (id,"sessionId","parentUserId","providerId","questionText",status,"createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,$3,'Did she ever have gestational diabetes?','PENDING',now(),now()) RETURNING id`,
      [aSess, famA.userId, prov.providerId]);
    await jfetch(`${BASE}/api/provider/concierge-sessions/${aSess}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...prov.providerAuth },
      body: JSON.stringify({ content: "She has never had gestational diabetes.", silentQueryId: wq2.rows[0].id }),
    });
    await new Promise((r) => setTimeout(r, 4000));
    const chunks2 = await db.query(
      `SELECT content FROM "KnowledgeChunk" WHERE "providerId" = $1 AND "sourceType" = 'whisper_answer'`, [prov.providerId]);
    check("person-specific answer is NOT ingested",
      chunks2.rowCount === 1 && !/gestational diabetes/i.test(JSON.stringify(chunks2.rows)), `rows=${chunks2.rowCount}`);

    const kbSess = await mkSess(famB.userId);
    const kb = await send(famB.auth, kbSess, "what psychological screening do you require before listing someone?");
    check("ingested agency knowledge answers a later question",
      /psychological evaluation|standard screening/i.test(kb.content), kb.content.slice(0, 190));
  } finally {
    await db.query(`DELETE FROM "KnowledgeChunk" WHERE "providerId" = $1`, [prov?.providerId || ""]).catch(() => {});
    await db.query(`DELETE FROM "SilentQuery" WHERE "parentUserId" IN ($1,$2)`, [famA.userId, famB.userId]).catch(() => {});
    if (prov) await cleanupProvider(db, prov.providerId, prov.providerUserId);
    await deleteUser(db, famA);
    await deleteUser(db, famB);
  }
}

// ─── Runner (admin test-runner stdout protocol) ──────────────────────────────
const CASES: { id: string; name: string; run: (db: Client) => Promise<void> }[] = [
  { id: "FT-01", name: "Deep-link surrogate pin - 4-turn free-text replay", run: ft01 },
  { id: "FT-02", name: "Confirm-never-overrule - embryos on file, donor requested", run: ft02 },
  { id: "FT-03", name: "Sperm C2 - donor-type answer saved, never re-asked", run: ft03 },
  { id: "FT-04", name: "Buy vials - purchase intent ends in checkout", run: ft04 },
  { id: "FT-05", name: "Profile correction acknowledged, never steamrolled", run: ft05 },
  { id: "FT-06", name: "Never fabricate: financing policy, form receipt, cancellation", run: ft06 },
  { id: "FT-07", name: "Pinned-profile question answered from real data", run: ft07 },
  { id: "FT-08", name: "Mid-flow redirect (clinic first) followed", run: ft08 },
  { id: "FT-09", name: "Crisis/grief suppresses intake and sales framing", run: ft09 },
  { id: "FT-10", name: "Paperwork on file answered from real data", run: ft10 },
  { id: "FT-11", name: "Tool-backed questions never return an empty reply", run: ft11 },
  { id: "FT-12", name: "Agreement resend delivers a document, never a dangling promise", run: ft12 },
  { id: "FT-13", name: "Pause/cancel asks never promise an action Eva cannot perform", run: ft13 },
  { id: "FT-14", name: "Post-handoff routing and why-question", run: ft14 },
  { id: "FT-15", name: "Knowledge base used when relevant, never leaked cross-provider", run: ft15 },
  { id: "FT-16", name: "Answered whisper reused across the family's threads", run: ft16 },
  { id: "FT-17", name: "Provider answer reused across families, asking family invisible", run: ft17 },
  { id: "FT-18", name: "Agency-level answers cross profiles; person facts never do", run: ft18 },
  { id: "FT-19", name: "Answers become durable knowledge; relevance beats recency", run: ft19 },
];

(async () => {
  const wanted = filterId ? filterId.split(",").map((s) => s.trim().toUpperCase()) : null;
  const toRun = wanted ? CASES.filter((c) => wanted.includes(c.id)) : CASES;
  console.log(`🧪 Free-Text Request Handling E2E - base: ${BASE}`);
  console.log(`   Running: ${toRun.length} of ${CASES.length} cases${wanted ? ` (filter: ${wanted.join(",")})` : ""}\n`);

  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const suiteStart = Date.now();
  await reportToDashboard({ type: "run_start", testIds: toRun.map((c) => c.id), filter: wanted ? wanted.join(",") : "free-text" });
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
        for (const f of caseFails) console.log(`     [${c.id}] ${f}`);
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
