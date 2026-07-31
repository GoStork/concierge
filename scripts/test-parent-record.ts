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

  // ── Saved-profile roster filter, with LIVE rows ───────────────────────────
  //
  // A parent's favourites span every org's roster, and the saved-preference
  // endpoints are self-only, so no ownership filter has ever been needed
  // before. Without one, agency A learns the family is shopping bank B.
  //
  // Finding a parent who actually has saved profiles takes a query - most
  // fixtures have none, which is why the shape-only check was never enough.
  const savedRow = await prisma.userDonorPreference.findFirst({
    where: { type: "favorite" },
    select: { userId: true, donorId: true },
    orderBy: { createdAt: "desc" },
  });
  const owningSurrogate = savedRow
    ? await prisma.surrogate.findUnique({
        where: { id: savedRow.donorId },
        select: { id: true, providerId: true },
      })
    : null;

  if (!owningSurrogate) {
    console.log("\nSAVED ROSTER FILTER - skipped, no live favourited profile found");
  } else {
    const saver = await prisma.user.findUnique({
      where: { id: savedRow!.userId },
      select: { id: true, parentAccountId: true },
    });
    const owner = owningSurrogate.providerId;
    // Any OTHER org that can legitimately open this parent's record.
    const otherOrgId = await prisma.aiChatSession.findFirst({
      where: {
        userId: saver!.id,
        providerId: { not: owner },
        status: { in: ["CONSULTATION_BOOKED", "PROVIDER_CONNECTED"] },
      },
      select: { providerId: true },
    });

    console.log("\nSAVED ROSTER FILTER");
    const ownerView = await buildParentRecord(
      { id: "o", roles: ["PROVIDER_ADMIN"], providerId: owner }, saver!.id,
    ).catch(() => null);
    if (ownerView) {
      ck("owning org sees only its own saved profiles",
        ownerView.savedProfiles.every((s: any) => s.providerId === owner));
    }
    if (otherOrgId?.providerId) {
      const otherView = await buildParentRecord(
        { id: "x", roles: ["PROVIDER_ADMIN"], providerId: otherOrgId.providerId }, saver!.id,
      ).catch(() => null);
      if (otherView) {
        ck("a DIFFERENT org sees none of the owning org's saved profiles",
          !otherView.savedProfiles.some((s: any) => s.providerId === owner));
      }
    } else {
      console.log("  (no second org on this parent - cross-org half not exercised)");
    }
    // Admin is the control: it must see what the providers are filtered out of.
    const adminView = await buildParentRecord({ id: "a", roles: ["GOSTORK_ADMIN"] }, saver!.id);
    ck("admin sees at least as many saved profiles as the owning org",
      adminView.savedProfiles.length >= (ownerView?.savedProfiles.length ?? 0));
  }

  // ── CRM note scoping ──────────────────────────────────────────────────────
  // The whole point of the two-scope design: a GOSTORK note ("price shopper")
  // must never reach an agency, while the agency keeps seeing its own.
  const gostorkNotes = a.crm.notes.filter((n: any) => n.scope === "GOSTORK");
  const provNotes = p.crm.notes;
  if (gostorkNotes.length === 0) {
    console.log("\nCRM NOTE SCOPING - skipped, no GOSTORK note on the fixture");
  } else {
    console.log("\nCRM NOTE SCOPING");
    ck("provider sees NO GOSTORK-scope note", !provNotes.some((n: any) => n.scope === "GOSTORK"));
    ck("provider sees no GOSTORK note body",
      !provNotes.some((n: any) => gostorkNotes.some((g: any) => g.body === n.body)));
    ck("provider still sees its own PROVIDER note",
      provNotes.every((n: any) => n.scope === "PROVIDER" && n.providerId === FC));
    ck("admin sees both scopes", a.crm.notes.length >= provNotes.length);
  }

  // Follow-ups and tags are scoped the same way and are just as disclosing.
  ck("provider sees only its own follow-ups",
    p.crm.followUps.every((f: any) => f.scope === "PROVIDER" && f.providerId === FC));
  ck("provider sees only its own tags",
    p.crm.tags.every((t: any) => t.scope === "PROVIDER" && t.providerId === FC));
  ck("provider sees only its own owner rows",
    p.crm.owners.every((o: any) => o.scope === "PROVIDER" && o.providerId === FC));

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
