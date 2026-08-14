/**
 * One-off cleanup: remove non-clinician staff (practice directors, lab
 * directors, office managers...) from IVF clinic rosters (ProviderMember rows).
 *
 * The enrichment pipeline now filters to clinicians at ingest (SART map +
 * mergeTeamMembers) and every doctor surface enforces isClinicianMember, but
 * rows scraped before that change are still in the DB - e.g. PFCLA listing a
 * "Practice Director" and an "Executive Lab Director" in the Doctors tab.
 *
 * Uses the SAME shared rule (isClinicianMember) as the live filters, so it
 * never deletes a physician who also holds an admin title.
 *
 * Members that already have reviews are hidden (isPublicProfile=false) instead
 * of deleted, so review history is never orphaned.
 *
 * READ-ONLY by default. Pass --apply to write.
 *   npx tsx -r dotenv/config scripts/purge-non-doctor-members.ts            # dry run
 *   npx tsx -r dotenv/config scripts/purge-non-doctor-members.ts --apply
 *   npx tsx -r dotenv/config scripts/purge-non-doctor-members.ts --only="PFCLA"
 */
import "dotenv/config";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { isClinicianMember, isNonClinicalTitle } from "../server/src/modules/providers/clinician";

// Scrape artifacts that aren't a person at all ("Find a Doctor", "Our Care
// Team", alt-text sentences). Safe to delete even without a staff title.
const isJunkName = (name: string) =>
  /\b(find a|our care|care team|faculty|staff|request|materials|physician is)\b/i.test(name) ||
  name.trim().split(/\s+/).length > 5;

const arg = (k: string) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split("=")[1] : undefined;
};
const APPLY = process.argv.includes("--apply");
const ONLY = arg("only");

const prisma = new PrismaService();

async function main() {
  const providers = await prisma.provider.findMany({
    where: {
      members: { some: {} },
      services: { some: { providerType: { name: "IVF Clinic" } } },
      ...(ONLY ? { name: { contains: ONLY, mode: "insensitive" } } : {}),
    },
    select: {
      id: true,
      name: true,
      members: {
        select: {
          id: true, name: true, title: true, credential: true, npiNumber: true,
          isMedicalDirector: true, isPublicProfile: true,
          _count: { select: { reviews: true } },
        },
      },
    },
  });

  let deleted = 0;
  let hidden = 0;
  let kept = 0;

  for (const p of providers) {
    const nonClinicians = p.members.filter((m) => !isClinicianMember(m));
    kept += p.members.length - nonClinicians.length;
    if (nonClinicians.length === 0) continue;

    console.log(`\n${p.name} (${p.id})`);
    for (const m of nonClinicians) {
      // Delete only when the row is AFFIRMATIVELY staff or junk; a row with no
      // signal either way might be a doctor whose NPPES/credential enrichment
      // missed, so hide it instead (reversible, and every surface filters
      // isPublicProfile). Rows with reviews are always hidden, never deleted.
      const affirmativelyStaff = isNonClinicalTitle(m.title) || isJunkName(m.name);
      const doDelete = affirmativelyStaff && m._count.reviews === 0;
      const action = doDelete ? "DELETE" : m._count.reviews > 0 ? "HIDE (has reviews)" : "HIDE (no clinical signal)";
      console.log(`  ${action}: "${m.name}"${m.title ? ` - ${m.title}` : ""}`);
      if (!APPLY) continue;
      if (doDelete) {
        // ProviderMemberLocation rows cascade away with the member.
        await prisma.providerMember.delete({ where: { id: m.id } });
        deleted++;
      } else {
        await prisma.providerMember.update({ where: { id: m.id }, data: { isPublicProfile: false } });
        hidden++;
      }
    }
  }

  console.log(`\n${APPLY ? "Applied" : "DRY RUN (pass --apply to write)"}: ${deleted} deleted, ${hidden} hidden, ${kept} clinicians kept across ${providers.length} clinics.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit());
