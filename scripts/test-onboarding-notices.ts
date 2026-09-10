/**
 * Onboarding completion notices - two milestones, told once each.
 *
 * Drives the REAL notice pipeline (GET /api/admin/providers/:id/onboarding
 * fires maybeNotifyOnboardingComplete) against a provider that already
 * computes to 100% required. The optional "sponsorship" step is derived
 * purely from the onbsponsor:<id> task, so flipping that row PENDING/DONE
 * toggles allDone without touching any real artifact.
 *
 * Scenarios:
 *   1. required only      -> onbcomplete marker, "required" notice, Home row
 *   2. idempotent         -> re-polls add nothing
 *   3. live row upgrade   -> optional walked, row reads allDone before the
 *                            "all" notice even fires
 *   4. dismissed row      -> comes BACK when the optional pages finish
 *   5. "all" dismiss      -> settles both milestones
 *   6. combined           -> required + optional in one poll = ONE notice
 *
 * Markers and acks for the provider are restored exactly as found. A
 * throwaway GOSTORK_ADMIN user is created and deleted. Real admins DO
 * receive the emails / toasts this fires (that is the pipeline under test);
 * their notification rows from this run are removed afterwards.
 *
 * Usage: npx tsx -r dotenv/config scripts/test-onboarding-notices.ts --provider=<id>
 */
import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";

const envContent = fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
const dbUrl = envContent.match(/^DIRECT_URL="?([^"\n]+)"?/m)?.[1] || envContent.match(/^DATABASE_URL="?([^"\n]+)"?/m)?.[1];
const BASE = process.env.TEST_BASE_URL || "http://localhost:5001";
const PW = "Test1234!x";
const PROVIDER_ID = process.argv.slice(2).find((a) => a.startsWith("--provider="))?.split("=")[1];
if (!PROVIDER_ID) { console.error("--provider=<id> required"); process.exit(1); }

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` :: ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

async function jfetch(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

async function main() {
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const runStart = new Date();

  // ── Throwaway admin ──
  const adminEmail = `test-onb-admin-${Date.now()}@gostork-test.com`;
  await jfetch(`${BASE}/api/users`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: adminEmail, password: PW, name: "Test Onb Admin" }) });
  const adminRow = await db.query(`UPDATE "User" SET roles=ARRAY['GOSTORK_ADMIN']::text[] WHERE email=$1 RETURNING id`, [adminEmail]);
  const adminId = adminRow.rows[0].id as string;
  const login = await jfetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: adminEmail, password: PW }) });
  const hdr: Record<string, string> = { Authorization: `Bearer ${(await login.json()).token}`, "Content-Type": "application/json" };

  // ── Snapshot provider marker state ──
  const KEYS = ["onbcomplete", "onbcompleteall", "onbmark:complete_ack", "onbmark:completeall_ack"].map((k) => `${k}:${PROVIDER_ID}`);
  const saved = await db.query(`SELECT * FROM "ParentTask" WHERE "systemKey" = ANY($1)`, [KEYS]);
  const sponsorKey = `onbsponsor:${PROVIDER_ID}`;
  const sponsorSaved = await db.query(`SELECT status, "completedAt" FROM "ParentTask" WHERE "systemKey"=$1`, [sponsorKey]);
  if (!sponsorSaved.rows.length) throw new Error("Provider has no onbsponsor task - pick a provider whose sponsorship step is marked done");
  const provName = (await db.query(`SELECT name FROM "Provider" WHERE id=$1`, [PROVIDER_ID])).rows[0].name;
  console.log(`Provider: ${provName} (${PROVIDER_ID}); saved ${saved.rows.length} marker rows`);

  const resetMarkers = () => db.query(`DELETE FROM "ParentTask" WHERE "systemKey" = ANY($1)`, [KEYS]);
  const setSponsor = (done: boolean) => db.query(`UPDATE "ParentTask" SET status=$2 WHERE "systemKey"=$1`, [sponsorKey, done ? "DONE" : "PENDING"]);
  const markers = async () => (await db.query(`SELECT "systemKey" FROM "ParentTask" WHERE "systemKey" = ANY($1) ORDER BY 1`, [KEYS])).rows.map((r) => String(r.systemKey).split(":").slice(0, -1).join(":"));
  const poll = async () => (await jfetch(`${BASE}/api/admin/providers/${PROVIDER_ID}/onboarding`, { headers: hdr })).json();
  const pendingRow = async () => ((await (await jfetch(`${BASE}/api/admin/onboarding/pending`, { headers: hdr })).json()) as any[]).find((r) => r.providerId === PROVIDER_ID);
  const dismiss = (milestone: "required" | "all") => jfetch(`${BASE}/api/admin/onboarding/${PROVIDER_ID}/complete/dismiss`, { method: "POST", headers: hdr, body: JSON.stringify({ milestone }) });
  // Evidence the throwaway admin was told: email row + persisted toast.
  const emails = async () => (await db.query(`SELECT subject FROM "Notification" WHERE "userId"=$1 AND channel='provider_onboarding_complete' ORDER BY "createdAt"`, [adminId])).rows.map((r) => r.subject as string);
  const toasts = async () => (await db.query(`SELECT payload FROM "InAppNotification" WHERE "userId"=$1 AND "eventType"='provider_onboarding_complete' ORDER BY "createdAt"`, [adminId])).rows.map((r) => r.payload as any);

  try {
    // ════ 1. Required only ════
    console.log("\n1. Required steps done, one optional page still open");
    await resetMarkers();
    await setSponsor(false);
    let s = await poll();
    check("summary reads 100% required", s.percent === 100, `${s.percent}%`);
    check("only onbcomplete marker written", (await markers()).join(",") === "onbcomplete", (await markers()).join(","));
    let e = await emails();
    let t = await toasts();
    check("one email, 'required steps' subject", e.length === 1 && /required steps - ready to go live/.test(e[0]), e.join(" | "));
    check("one toast, stage=required, allDone=false, openOptionalCount=1", t.length === 1 && t[0].stage === "required" && t[0].allDone === false && t[0].openOptionalCount === 1, JSON.stringify(t[0] || null));
    let row = await pendingRow();
    check("Home row: finished / milestone=required / allDone=false / 1 open", row?.stage === "finished" && row?.milestone === "required" && row?.allDone === false && row?.openOptionalCount === 1, JSON.stringify(row || null));

    // ════ 2. Idempotent ════
    console.log("\n2. Re-polling (provider page reload, admin page open)");
    await poll(); await poll(); await pendingRow();
    check("still exactly one marker", (await markers()).length === 1);
    check("still one email, one toast", (await emails()).length === 1 && (await toasts()).length === 1);

    // ════ 3. Live upgrade of the row ════
    console.log("\n3. Provider walks the last optional page while the row is still up");
    await setSponsor(true);
    row = await pendingRow(); // pending list does NOT fire notices - reads live
    check("row upgrades to allDone=true before any new notice", row?.allDone === true && row?.openOptionalCount === 0 && row?.milestone === "required", JSON.stringify(row || null));
    check("no 'all' marker yet (pending list never claims)", (await markers()).length === 1);

    // ════ 4. Dismissed row comes back ════
    console.log("\n4. Admin dismissed the required row earlier; optional pages now finish");
    await setSponsor(false);
    await dismiss("required");
    check("row gone after dismiss", !(await pendingRow()));
    await setSponsor(true);
    s = await poll();
    check("onbcompleteall marker added (required ack kept)", (await markers()).join(",") === "onbcomplete,onbcompleteall,onbmark:complete_ack", (await markers()).join(","));
    e = await emails(); t = await toasts();
    check("second email, 'optional pages' subject", e.length === 2 && /optional onboarding pages - every page reviewed/.test(e[1]), e.join(" | "));
    check("second toast, stage=all", t.length === 2 && t[1].stage === "all" && t[1].allDone === true, JSON.stringify(t[1] || null));
    row = await pendingRow();
    check("row is BACK with milestone=all", row?.stage === "finished" && row?.milestone === "all" && row?.allDone === true, JSON.stringify(row || null));
    await poll();
    check("re-poll adds nothing", (await markers()).length === 3 && (await emails()).length === 2 && (await toasts()).length === 2);

    // ════ 5. Dismiss "all" settles both ════
    console.log("\n5. Dismissing the 'all' row");
    await dismiss("all");
    check("row gone", !(await pendingRow()));
    check("both acks written", (await markers()).join(",") === "onbcomplete,onbcompleteall,onbmark:complete_ack,onbmark:completeall_ack", (await markers()).join(","));

    // ════ 6. Combined: everything in one poll ════
    console.log("\n6. Required and optional both finish before the first poll");
    await resetMarkers();
    await db.query(`DELETE FROM "Notification" WHERE "userId"=$1`, [adminId]);
    await db.query(`DELETE FROM "InAppNotification" WHERE "userId"=$1`, [adminId]);
    await setSponsor(true);
    await poll();
    check("both markers claimed at once", (await markers()).join(",") === "onbcomplete,onbcompleteall", (await markers()).join(","));
    e = await emails(); t = await toasts();
    check("exactly ONE email, 'required and optional' subject", e.length === 1 && /required and optional steps - ready to go live/.test(e[0]), e.join(" | "));
    check("exactly ONE toast, stage=required, allDone=true", t.length === 1 && t[0].stage === "required" && t[0].allDone === true, JSON.stringify(t[0] || null));
    row = await pendingRow();
    check("one Home row (milestone=all outranks), allDone=true", row?.milestone === "all" && row?.allDone === true, JSON.stringify(row || null));
    await poll(); await poll();
    check("re-polls add nothing", (await emails()).length === 1 && (await toasts()).length === 1);
    await dismiss("all");
    check("dismiss clears it", !(await pendingRow()));
    // Dismissing "required" on a combined row would leave "all" un-acked:
    await resetMarkers(); await poll(); await dismiss("required");
    row = await pendingRow();
    check("dismissing only 'required' on a combined row: row stays as 'all' (documented, not a bug)", row?.milestone === "all", JSON.stringify(row || null));
  } finally {
    // ── Restore ──
    await db.query(`DELETE FROM "ParentTask" WHERE "systemKey" = ANY($1)`, [KEYS]);
    for (const r of saved.rows) {
      const cols = Object.keys(r);
      await db.query(`INSERT INTO "ParentTask" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => r[c]));
    }
    await db.query(`UPDATE "ParentTask" SET status=$2, "completedAt"=$3 WHERE "systemKey"=$1`, [sponsorKey, sponsorSaved.rows[0].status, sponsorSaved.rows[0].completedAt]);
    const n1 = await db.query(`DELETE FROM "Notification" WHERE channel='provider_onboarding_complete' AND "createdAt" >= $1`, [runStart]);
    const n2 = await db.query(`DELETE FROM "InAppNotification" WHERE "eventType"='provider_onboarding_complete' AND "createdAt" >= $1`, [runStart]);
    await db.query(`DELETE FROM "User" WHERE id=$1`, [adminId]);
    console.log(`\nRestored ${saved.rows.length} marker rows, sponsor step, removed ${n1.rowCount} email + ${n2.rowCount} toast rows from this run, deleted throwaway admin.`);
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
