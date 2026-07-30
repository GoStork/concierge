/**
 * Parent CRM scope resolution: the rules that decide who a note reaches.
 *
 * Pure functions, so this needs no database. They are worth pinning precisely
 * because every one of them is the difference between a GoStork-internal note
 * and one an agency can read.
 *
 * Run: npx tsx scripts/test-parent-crm-scope.ts
 */
import {
  CrmAuthError, canMutateCrmRow, crmReadWhere, resolveCrmViewer, resolveWriteTarget,
} from "../server/parent-crm";

const fails: string[] = [];
const ck = (n: string, ok: boolean) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fails.push(n); };

const ORG = "org-1", OTHER = "org-2";
const admin = resolveCrmViewer({ id: "a", name: "Admin", roles: ["GOSTORK_ADMIN"] });
const conc  = resolveCrmViewer({ id: "c", name: "Concierge", roles: ["GOSTORK_CONCIERGE"] });
const prov  = resolveCrmViewer({ id: "p", name: "Staff", roles: ["PROVIDER_ADMIN"], providerId: ORG });

console.log("VIEWER");
ck("admin is staff", admin.isAdmin && admin.providerId === null);
ck("concierge is staff", conc.isAdmin);
ck("provider is not staff", !prov.isAdmin && prov.providerId === ORG);
// A GoStork admin who also carries a providerId must still resolve as staff,
// not get force-scoped to that org.
ck("admin with a providerId stays unscoped",
  resolveCrmViewer({ id: "a", roles: ["GOSTORK_ADMIN"], providerId: ORG }).providerId === null);

console.log("\nWRITE TARGET");
ck("admin defaults to GOSTORK", resolveWriteTarget(admin).scope === "GOSTORK");
ck("admin may target an org",
  JSON.stringify(resolveWriteTarget(admin, "PROVIDER", OTHER)) === JSON.stringify({ scope: "PROVIDER", providerId: OTHER }));
// The core containment rule: a provider cannot name a scope or an org, and a
// hostile body is IGNORED rather than rejected - there is no branch that honours it.
const forced = resolveWriteTarget(prov, "GOSTORK", OTHER);
ck("provider forced to PROVIDER scope", forced.scope === "PROVIDER");
ck("provider forced to own org (body ignored)", forced.providerId === ORG);

let threw = false;
try { resolveWriteTarget(admin, "PROVIDER", null); } catch (e) { threw = e instanceof CrmAuthError; }
ck("admin PROVIDER scope without an org is rejected", threw);
threw = false;
try { resolveWriteTarget(admin, "NONSENSE" as any); } catch (e) { threw = e instanceof CrmAuthError; }
ck("unknown scope rejected", threw);
threw = false;
try { resolveWriteTarget(resolveCrmViewer({ id: "z", roles: [] })); } catch (e) { threw = e instanceof CrmAuthError; }
ck("orgless non-admin rejected", threw);

console.log("\nREAD WHERE");
const aw: any = crmReadWhere(admin, "acct-1");
const pw: any = crmReadWhere(prov, "acct-1");
ck("admin read is unscoped", aw.scope === undefined && aw.providerId === undefined);
ck("provider read pins scope AND org", pw.scope === "PROVIDER" && pw.providerId === ORG);

console.log("\nMUTATE");
ck("admin may touch a GOSTORK row", canMutateCrmRow(admin, { scope: "GOSTORK", providerId: null }));
ck("provider may touch own PROVIDER row", canMutateCrmRow(prov, { scope: "PROVIDER", providerId: ORG }));
ck("provider may NOT touch a GOSTORK row", !canMutateCrmRow(prov, { scope: "GOSTORK", providerId: null }));
ck("provider may NOT touch another org's row", !canMutateCrmRow(prov, { scope: "PROVIDER", providerId: OTHER }));

console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
