/** Throwaway: an admin login plus a parent holding an active consultation lock. */
import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";

const envContent = fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
const dbUrl = envContent.match(/^DIRECT_URL="?([^"\n]+)"?/m)?.[1] || envContent.match(/^DATABASE_URL="?([^"\n]+)"?/m)?.[1];
const BASE = "http://localhost:5001";
const PW = "Test1234!x";
const MATCHMAKER_ID = "f590dbcb-011e-43d9-98d0-1157c3cfa1e2";

const db = new Client({ connectionString: dbUrl });
await db.connect();
const stamp = Date.now();

const mk = async (email: string, name: string) => {
  await fetch(`${BASE}/api/users`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PW, name }),
  });
  return (await db.query(`SELECT id, "parentAccountId" FROM "User" WHERE email=$1`, [email])).rows[0];
};

const adminEmail = `test-lockadmin-${stamp}@gostork-test.com`;
const admin = await mk(adminEmail, "Zz Admin");
await db.query(`UPDATE "User" SET roles = ARRAY['GOSTORK_ADMIN']::text[] WHERE id=$1`, [admin.id]);

const parentEmail = `test-lockparent-${stamp}@gostork-test.com`;
const parent = await mk(parentEmail, "Riley Locked");
let acctId = parent.parentAccountId;
if (!acctId) {
  acctId = (await db.query(`INSERT INTO "ParentAccount" (id,"createdAt","updatedAt") VALUES (gen_random_uuid(),now(),now()) RETURNING id`)).rows[0].id;
  await db.query(`UPDATE "User" SET "parentAccountId"=$1 WHERE id=$2`, [acctId, parent.id]);
}

const provEmail = `test-lockprov-${stamp}@gostork-test.com`;
const provUser = await mk(provEmail, "Casey Coordinator");
const providerId = (await db.query(
  `INSERT INTO "Provider" (id,name,"createdAt","updatedAt") VALUES (gen_random_uuid(),$1,now(),now()) RETURNING id`,
  [`ZZ Test Lockview ${stamp}`],
)).rows[0].id;
await db.query(`UPDATE "User" SET "providerId"=$1, roles=ARRAY['PROVIDER_ADMIN']::text[] WHERE id=$2`, [providerId, provUser.id]);
const typeId = (await db.query(`SELECT id FROM "ProviderType" WHERE name='Surrogacy Agency'`)).rows[0].id;
await db.query(`INSERT INTO "ProviderService" (id,"providerId","providerTypeId",status) VALUES (gen_random_uuid(),$1,$2,'APPROVED')`, [providerId, typeId]);

const session = (await db.query(
  `INSERT INTO "AiChatSession" (id,"userId","providerId","providerName",status,"sessionType",title,"matchmakerId","subjectType","createdAt","updatedAt")
   VALUES (gen_random_uuid(),$1,$2,$3,'CONSULTATION_BOOKED','PARENT','Surrogate #8812',$4,'Surrogate',now(),now()) RETURNING id`,
  [parent.id, providerId, `ZZ Test Lockview ${stamp}`, MATCHMAKER_ID],
)).rows[0].id;
await db.query(
  `INSERT INTO "Booking" (id,"publicToken","providerUserId","parentUserId","sessionId","scheduledAt",duration,"meetingType",status,"createdAt","updatedAt")
   VALUES (gen_random_uuid(), gen_random_uuid(), $1,$2,$3, now() + interval '3 days', 30,'video','CONFIRMED', now(), now())`,
  [provUser.id, parent.id, session],
);

console.log(JSON.stringify({ adminEmail, parentEmail, password: PW, sessionId: session, acctId, providerId }, null, 2));
await db.end();
