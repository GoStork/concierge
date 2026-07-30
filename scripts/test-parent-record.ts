/**
 * Parent record: the privacy contract, against the live database.
 *
 * buildParentRecord serves one payload to two audiences, so the difference
 * between them IS the security boundary. These checks drive the real builder
 * against real rows rather than fixtures, because the failure mode being
 * guarded is "a WHERE clause quietly stopped scoping" - which a fixture
 * containing one provider cannot catch.
 *
 * Run: npx tsx scripts/test-parent-record.ts
 */
import "dotenv/config";
import { prisma } from "../server/db";
import { buildParentRecord } from "../server/parent-record";

const FC = "d0af900d-41bf-43cb-9051-d52c8cda3f24"; // Family Creations
const fails: string[] = [];
const ck = (n: string, ok: boolean) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`);
  if (!ok) fails.push(n);
};
const line = (l: string, v: any) => console.log(`  ${l.padEnd(32)} ${v}`);

(async () => {
  // The fixture parent: a shared account with sessions across three orgs, a
  // contact release from exactly one of them, and a MATCHED surrogate.
  const parent = await prisma.user.findFirst({
    where: { email: "natan123+lala@gmail.com" },
    select: { id: true, name: true, parentAccountId: true },
  });
  if (!parent) {
    console.log("fixture parent missing - skipping (not a failure on a fresh DB)");
    process.exit(0);
  }
  const acct = parent.parentAccountId || parent.id;
  console.log(`parent: ${parent.name} (${parent.id})\n`);

  const admin: any = { id: "admin-test", name: "Admin", roles: ["GOSTORK_ADMIN"], providerId: null };
  const prov: any = { id: "prov-test", name: "FC Staff", roles: ["PROVIDER_ADMIN"], providerId: FC };

  const a = await buildParentRecord(admin, parent.id);
  const p = await buildParentRecord(prov, parent.id);

  console.log("ADMIN");
  line("providerOrgs", a.providerOrgs.map((o) => o.providerName).join(", ") || "(none)");
  line("conversations", a.conversations.length);
  line("engagement.profilesViewed", a.engagement.profilesViewed);
  console.log("\nPROVIDER (Family Creations)");
  line("providerOrgs", p.providerOrgs.map((o) => o.providerName).join(", ") || "(none)");
  line("conversations", p.conversations.length);
  line("contactReleaseReason", p.contactReleaseReason);

  console.log("\nSCOPING");
  ck("admin sees >= provider's org count", a.providerOrgs.length >= p.providerOrgs.length);
  ck("provider sees ONLY its own org", p.providerOrgs.every((o) => o.providerId === FC));
  ck("provider conversations all own org", p.conversations.every((c: any) => !c.providerId || c.providerId === FC));
  // The saved-profile leak: favourites span every org's roster, and the
  // self-only preference endpoints never needed an ownership filter.
  ck("provider saved profiles all own org", p.savedProfiles.every((s: any) => !s.providerId || s.providerId === FC));
  ck("provider money all own org", p.money.byProvider.every((m: any) => m.providerId === FC));
  ck("provider gets no historySummary", !p.conversations.some((c: any) => c.historySummary));
  ck("admin engagement is global", (a.engagement.profilesViewed ?? 0) >= (p.engagement.profilesViewed ?? 0));
  ck("admin email present", !!(a.parent as any)?.email);
  ck("released provider sees email", !!(p.parent as any)?.email === p.contactReleased);

  // ── Gate B closed: a real session, no release row ─────────────────────────
  const iflg = await prisma.provider.findFirst({
    where: { name: { contains: "IFLG" } },
    select: { id: true, name: true },
  });
  if (iflg) {
    const rel = await prisma.parentContactRelease.findFirst({
      where: { providerId: iflg.id, parentAccountId: acct },
      select: { id: true },
    });
    if (rel) {
      console.log(`\nGATE B CLOSED - skipped, ${iflg.name} now has a release row`);
    } else {
      const g: any = { id: "x", name: "IFLG Staff", roles: ["PROVIDER_ADMIN"], providerId: iflg.id };
      const r = await buildParentRecord(g, parent.id);
      console.log(`\nGATE B CLOSED (${iflg.name})`);
      ck("email withheld", (r.parent as any)?.email === null);
      ck("mobile withheld", (r.parent as any)?.mobileNumber === null);
      ck("name still visible (Gate A open)",
        !!(r.parent as any)?.name && (r.parent as any).name !== "Prospective Parent");
      // The PDF handle is the richest PII we hold; the status must survive so
      // the page can say "submitted, unlocks when..." not "not submitted yet".
      ck("ipForm.responseId withheld", r.ipForm.responseId === null);
      ck("ipForm.status still readable", !!r.ipForm.status);
      ck("account members redacted too",
        r.accountMembers.every((m: any) => m.email === null && m.mobileNumber === null));
      ck("sees only own org", r.providerOrgs.every((o: any) => o.providerId === iflg.id));
    }
  }

  // ── No relationship at all ───────────────────────────────────────────────
  const stranger = await prisma.provider.findFirst({
    where: { id: { notIn: [FC, ...(iflg ? [iflg.id] : [])] } },
    select: { id: true, name: true },
  });
  if (stranger) {
    let status = 0;
    try {
      await buildParentRecord({ id: "y", roles: ["PROVIDER_ADMIN"], providerId: stranger.id }, parent.id);
    } catch (e: any) {
      status = e.status;
    }
    console.log(`\nUNRELATED PROVIDER (${stranger.name})`);
    ck("403 on no relationship", status === 403);
  }

  console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error("THREW:", e);
  process.exit(1);
});
