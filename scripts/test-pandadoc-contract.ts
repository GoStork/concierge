/**
 * GoStork - PandaDoc API contract (PD-xx)
 *
 * PP-09 proves OUR side of agreement sending: the release writer, that every
 * send path calls it, and that no sent agreement in the database lacks a
 * release. What it cannot prove is that PandaDoc still answers the way we parse
 * - a rotated key or a changed response shape would break agreement sending in
 * production with nothing failing first.
 *
 * This suite closes that, READ-ONLY. It creates no documents, sends no email
 * and consumes no document quota, so it is safe to run on every change. The
 * mutating round trip (create -> send -> delete) is deliberately NOT here: it
 * would put a real document in the provider's PandaDoc account and email a real
 * recipient, which is not a price a per-commit suite should pay.
 *
 * Skips cleanly when PANDADOC_API_KEY is absent, so CI without the secret stays
 * green rather than failing for the wrong reason.
 *
 * Usage:
 *   npx tsx scripts/test-pandadoc-contract.ts
 *   npx tsx scripts/test-pandadoc-contract.ts --id=PD-02
 */

import "dotenv/config";

const BASE = process.env.TEST_BASE_URL || "http://localhost:5001";
const API = "https://api.pandadoc.com/public/v1";
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
  } catch { /* dashboard is optional */ }
}

const KEY = process.env.PANDADOC_API_KEY || "";
const auth = { Authorization: `API-Key ${KEY}` };

/**
 * Fetch and read the body EXACTLY ONCE.
 *
 * A Response body is a one-shot stream. Passing `(await res.text())` as a
 * failure-detail argument reads it even when the check passes, so the later
 * .json() sees an already-drained stream and silently yields {} - which looks
 * exactly like "PandaDoc changed their response shape". Read once, keep both.
 */
async function getJson(url: string): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(url, { headers: auth });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}

let prisma: any;
async function db() {
  if (!prisma) prisma = (await import("../server/db.js")).prisma;
  return prisma;
}

/** Every case no-ops with a visible note when the secret is not configured. */
function skipWithoutKey(): boolean {
  if (KEY) return false;
  check("PANDADOC_API_KEY is not configured on this host - skipping (not a failure)", true);
  return true;
}

// ─── PD-01: the credential still works ─────────────────────────────────────
// The quiet failure this catches: a rotated or expired key breaks agreement
// sending for every provider, and nothing tells anyone until one tries to send.
async function pd01() {
  if (skipWithoutKey()) return;
  const { status, json, text } = await getJson(`${API}/templates?count=1`);
  check("PandaDoc accepts our API key", status === 200, `status=${status} ${text.slice(0, 140)}`);
  if (status !== 200) return;

  // The listing shape is not something we parse in the send path, but a 200 with
  // an unexpected body means something moved and the parse sites deserve a look.
  check("the listing response still has a `results` array", Array.isArray(json?.results),
    `keys: ${Object.keys(json || {}).join(",")}`);
}

// ─── PD-02: template details still parse ───────────────────────────────────
// fetchTemplateDetails reads exactly three things: roles[].id, roles[].name and
// roles[].signing_order, plus fields[].assigned_to.{type,id}. If PandaDoc
// renames or nests any of them, generateAgreementFromTemplate silently builds a
// document with no recipients or no fields.
async function pd02() {
  if (skipWithoutKey()) return;
  const p = await db();
  const provider = await p.provider.findFirst({
    where: { pandaDocTemplateId: { not: null } },
    select: { name: true, pandaDocTemplateId: true },
  });
  if (!provider?.pandaDocTemplateId) {
    check("no provider has a pandaDocTemplateId configured - skipping (not a failure)", true);
    return;
  }

  const { status, json: data, text } = await getJson(`${API}/templates/${provider.pandaDocTemplateId}/details`);
  check(`template details fetch succeeds (${provider.name})`, status === 200, `status=${status} ${text.slice(0, 140)}`);
  if (status !== 200) return;
  check("response carries a `roles` array", Array.isArray(data?.roles), `keys: ${Object.keys(data || {}).join(",")}`);
  check("response carries a `fields` array", Array.isArray(data?.fields), `keys: ${Object.keys(data || {}).join(",")}`);

  const role = (data?.roles || [])[0];
  if (role) {
    check("roles[].id is present", role.id != null, JSON.stringify(role).slice(0, 140));
    check("roles[].name is present", role.name != null, JSON.stringify(role).slice(0, 140));
    // Read with `?? 0` in our code, so absent is tolerated - but a RENAME is not,
    // and that is what this distinguishes.
    check("roles[].signing_order is still the field name we read",
      "signing_order" in role, `role keys: ${Object.keys(role).join(",")}`);
  } else {
    check("template has at least one role", false, "roles array is empty - agreements would have no recipients");
  }

  const field = (data?.fields || []).find((f: any) => f?.assigned_to);
  if (field) {
    check("fields[].assigned_to.type is still the shape we read", field.assigned_to?.type != null,
      JSON.stringify(field.assigned_to).slice(0, 140));
    check("fields[].assigned_to.id is still the shape we read", field.assigned_to?.id != null,
      JSON.stringify(field.assigned_to).slice(0, 140));
  } else {
    // Not a failure: a template may legitimately have no role-assigned fields.
    check("no role-assigned fields on this template (nothing to shape-check)", true);
  }

  // Our parser has to survive whatever came back, not just look at it.
  const roles = ((data.roles || []) as any[])
    .map((r: any) => ({ id: String(r.id), name: String(r.name), signingOrder: Number(r.signing_order ?? 0) }))
    .sort((a, b) => a.signingOrder - b.signingOrder)
    .map((r, i) => ({ ...r, signingOrder: i + 1 }));
  check("our own parse yields usable, 1-based signing orders",
    roles.length > 0 && roles.every((r) => r.id && r.name && r.signingOrder >= 1),
    JSON.stringify(roles).slice(0, 160));
}

// ─── PD-03: every configured template still exists ─────────────────────────
// A provider-side deletion in PandaDoc turns agreement generation into a 404 at
// the worst possible moment. Cheap to notice here instead.
async function pd03() {
  if (skipWithoutKey()) return;
  const p = await db();
  const providers = await p.provider.findMany({
    where: { pandaDocTemplateId: { not: null } },
    select: { name: true, pandaDocTemplateId: true },
  });
  check("at least one provider has a template configured", providers.length > 0, `${providers.length}`);

  const missing: string[] = [];
  for (const pr of providers) {
    const { status, text } = await getJson(`${API}/templates/${pr.pandaDocTemplateId}/details`);
    if (status === 404) missing.push(`${pr.name}: template deleted in PandaDoc (${pr.pandaDocTemplateId})`);
    else if (status === 403) missing.push(`${pr.name}: our key cannot access this template (${pr.pandaDocTemplateId})`);
    else if (status !== 200) missing.push(`${pr.name}: HTTP ${status} ${text.slice(0, 60)}`);
  }
  check(`every configured template is still reachable (checked ${providers.length})`, missing.length === 0,
    missing.join(" | "));
}

const CASES: { id: string; name: string; run: () => Promise<void> }[] = [
  { id: "PD-01", name: "PandaDoc still accepts our API key", run: pd01 },
  { id: "PD-02", name: "Template details still parse into the shape the send path needs", run: pd02 },
  { id: "PD-03", name: "Every provider's configured template still exists", run: pd03 },
];

(async () => {
  const wanted = filterId ? filterId.split(",").map((s) => s.trim().toUpperCase()) : null;
  const toRun = wanted ? CASES.filter((c) => wanted.includes(c.id)) : CASES;
  console.log(`📄 PandaDoc API contract (read-only)`);
  console.log(`   Running: ${toRun.length} of ${CASES.length} cases\n`);

  const suiteStart = Date.now();
  await reportToDashboard({ type: "run_start", testIds: toRun.map((c) => c.id), filter: "pandadoc" });
  for (const c of toRun) {
    caseFails = [];
    console.log(`  ▶ Starting: ${c.id}`);
    console.log(`    ${c.name}`);
    await reportToDashboard({ type: "test_start", id: c.id });
    const t0 = Date.now();
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
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${totalPass} passed, ${totalFail} failed (${Math.round((Date.now() - suiteStart) / 1000)}s total)`);
  await reportToDashboard({ type: "run_done", passCount: totalPass, failCount: totalFail, durationMs: Date.now() - suiteStart });
  process.exit(totalFail ? 1 : 0);
})();
