/**
 * Throwaway: seed a parent whose chat contains all three consent-gate cards,
 * so they can be looked at in a real browser. Deleted after verification.
 */
import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";

const envContent = fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
const dbUrl =
  envContent.match(/^DIRECT_URL="?([^"\n]+)"?/m)?.[1] ||
  envContent.match(/^DATABASE_URL="?([^"\n]+)"?/m)?.[1];
const BASE = "http://localhost:5001";
const PW = "Test1234!x";
const MATCHMAKER_ID = "f590dbcb-011e-43d9-98d0-1157c3cfa1e2";

const db = new Client({ connectionString: dbUrl });
await db.connect();

const stamp = Date.now();
const parentEmail = `test-cardview-${stamp}@gostork-test.com`;
await fetch(`${BASE}/api/users`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: parentEmail, password: PW, name: "Dana Verified" }),
});
const p = await db.query(`SELECT id, "parentAccountId" FROM "User" WHERE email=$1`, [parentEmail]);
const parentUserId = p.rows[0].id;
let acctId = p.rows[0].parentAccountId;
if (!acctId) {
  acctId = (await db.query(`INSERT INTO "ParentAccount" (id,"createdAt","updatedAt") VALUES (gen_random_uuid(),now(),now()) RETURNING id`)).rows[0].id;
  await db.query(`UPDATE "User" SET "parentAccountId"=$1, "partnerFirstName"='Sam', "relationshipStatus"='Married' WHERE id=$2`, [acctId, parentUserId]);
}
const prov = await db.query(
  `INSERT INTO "Provider" (id,name,"createdAt","updatedAt") VALUES (gen_random_uuid(),$1,now(),now()) RETURNING id`,
  [`ZZ Test Cardview ${stamp}`],
);
const providerId = prov.rows[0].id;
const typeId = (await db.query(`SELECT id FROM "ProviderType" WHERE name='Surrogacy Agency'`)).rows[0].id;
await db.query(`INSERT INTO "ProviderService" (id,"providerId","providerTypeId",status) VALUES (gen_random_uuid(),$1,$2,'APPROVED')`, [providerId, typeId]);

const eva = (await db.query(
  `INSERT INTO "AiChatSession" (id,"userId","providerId",status,"sessionType",title,"matchmakerId","createdAt","updatedAt")
   VALUES (gen_random_uuid(),$1,NULL,'ACTIVE','PARENT','AI Concierge Chat',$2,now(),now()) RETURNING id`,
  [parentUserId, MATCHMAKER_ID],
)).rows[0].id;
const shared = (await db.query(
  `INSERT INTO "AiChatSession" (id,"userId","providerId","providerName",status,"sessionType",title,"matchmakerId","providerJoinedAt","createdAt","updatedAt")
   VALUES (gen_random_uuid(),$1,$2,$3,'PROVIDER_CONNECTED','PARENT','Surrogate #4471',$4,now(),now(),now()) RETURNING id`,
  [parentUserId, providerId, `ZZ Test Cardview ${stamp}`, MATCHMAKER_ID],
)).rows[0].id;

const card = async (sessionId: string, type: string, content: string, data: any) =>
  db.query(
    `INSERT INTO "AiChatMessage" (id,"sessionId",role,content,"senderType","senderName","uiCardType","uiCardData","createdAt")
     VALUES (gen_random_uuid(),$1,'assistant',$2,'system','GoStork',$3,$4::jsonb,now())`,
    [sessionId, content, type, JSON.stringify(data)],
  );

await card(eva, "consult_preliminary_ack",
  "Before you pick a time: this call is the first step toward a match call with Surrogate #4471 specifically, not a general information session. the Surrogate's Agency will prepare for it as real interest in her.",
  { gate: "PRELIMINARY_STEP", providerId, providerDisplayName: "the Surrogate's Agency", subjectLabel: "Surrogate #4471", subjectProfileId: null, subjectType: "Surrogate", acknowledgedAt: null, acknowledgedByName: null });

await card(shared, "match_call_attendance_ack",
  "Both of you need to be on the match call with Surrogate #4471 - you and Sam. A surrogate is choosing a family, and meeting half of one tells her very little. Confirm below and the agency can send you times.",
  { gate: "BOTH_PARENTS", providerId, subjectLabel: "Surrogate #4471", partnerFirstName: "Sam", requiredBecause: "RELATIONSHIP",
    providerContent: "Waiting on the parents to confirm that BOTH of them will attend the match call for Surrogate #4471.", acknowledgedAt: null, acknowledgedByName: null });

await card(shared, "match_call_decision_ack",
  "One thing to know before the match call: if it goes well, Surrogate #4471 goes on hold exclusively for you and you have 24 hours to decide and place the match deposit. We would rather you see the number now than on an invoice.",
  { gate: "DECISION_WINDOW", providerId, subjectLabel: "Surrogate #4471",
    deposit: { source: "COST_SHEET", label: "First Deposit", minCents: 800000, maxCents: 1200000, triggerLabel: "Due within 5 business days of match", payToLabel: "Escrow", isRefundable: false, refundNote: "Non-refundable once she is on hold", depositAtClearance: false },
    policyText: null, providerContent: "Waiting on the parents to confirm the 24-hour decision window and the match deposit.", acknowledgedAt: null, acknowledgedByName: null });

// A second decision card with NO figure on file, to see the honest fallback.
await card(eva, "match_call_decision_ack",
  "One thing to know before the match call: if it goes well, she goes on hold exclusively for you and you have 24 hours to decide and place the match deposit.",
  { gate: "DECISION_WINDOW", providerId, subjectLabel: "Surrogate #9002",
    deposit: { source: "NONE", label: null, minCents: null, maxCents: null, triggerLabel: null, payToLabel: null, isRefundable: null, refundNote: null, depositAtClearance: false },
    policyText: "Your agency sets the exact deposit amount. Ask them here and they'll confirm it before the call.", acknowledgedAt: null, acknowledgedByName: null });

console.log(JSON.stringify({ parentEmail, password: PW, parentUserId, acctId, providerId, evaSession: eva, sharedSession: shared }, null, 2));
await db.end();
