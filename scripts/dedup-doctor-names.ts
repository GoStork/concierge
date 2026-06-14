/**
 * One-off cleanup: collapse same-person NAME VARIANTS within a provider's roster
 * (ProviderMember rows). The live enrichment already dedups via mergeTeamMembers
 * + collapseTeamNameVariants; this fixes rows that predate that logic.
 *
 * Example it fixes: "Shady Grove Fertility-Rockville" listing BOTH
 * "Jeff McKeeby M.D." and "Jeffrey L. McKeeby" as separate doctors.
 *
 * Uses the SAME shared matcher (clusterPersonVariants) as the live merge, so it
 * never merges genuinely different doctors who share a last name (requires
 * compatible first names - prefix / initial / nickname).
 *
 * Per cluster it keeps ONE survivor row (the durable CDC medical director if any,
 * else the most complete row), updates it to the fullest given name + union of
 * fields, reassigns the duplicates' reviews to the survivor, then deletes the
 * duplicates (their ProviderMemberLocation rows cascade away).
 *
 * READ-ONLY by default. Pass --apply to write.
 *   npx tsx -r dotenv/config scripts/dedup-doctor-names.ts            # dry run
 *   npx tsx -r dotenv/config scripts/dedup-doctor-names.ts --apply
 *   npx tsx -r dotenv/config scripts/dedup-doctor-names.ts --only="Shady Grove"
 */
import "dotenv/config";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { clusterPersonVariants, parsePersonName, pickBestDisplayName } from "../server/src/lib/doctor-name-dedup";

const arg = (k: string) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split("=")[1] : undefined;
};
const APPLY = process.argv.includes("--apply");
const ONLY = arg("only");
const LIMIT = arg("limit") ? parseInt(arg("limit")!, 10) : undefined;

const prisma = new PrismaService();

type Member = {
  id: string; name: string; title: string | null; bio: string | null;
  photoUrl: string | null; highResPhotoUrl: string | null; isMedicalDirector: boolean;
  specialties: string[]; education: string[]; boardCertifications: string[];
  _count: { reviews: number };
};

const completeness = (m: Member) =>
  (m.isMedicalDirector ? 100 : 0) + m._count.reviews * 10 +
  (m.photoUrl ? 4 : 0) + (m.highResPhotoUrl ? 2 : 0) + (m.bio ? 2 : 0) + (m.title ? 1 : 0) +
  m.specialties.length + m.education.length;

const longest = (vals: (string | null)[]) =>
  vals.filter((v): v is string => !!v).sort((a, b) => b.length - a.length)[0] || null;

async function main() {
  const providers = await prisma.provider.findMany({
    where: {
      members: { some: {} },
      ...(ONLY ? { name: { contains: ONLY, mode: "insensitive" } } : {}),
    },
    select: {
      id: true, name: true,
      members: {
        select: {
          id: true, name: true, title: true, bio: true, photoUrl: true, highResPhotoUrl: true,
          isMedicalDirector: true, specialties: true, education: true, boardCertifications: true,
          _count: { select: { reviews: true } },
        },
      },
    },
    orderBy: { name: "asc" },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  console.log(`[dedup] ${providers.length} providers with members (${APPLY ? "APPLY" : "DRY RUN"})`);
  let clinicsAffected = 0, clustersCollapsed = 0, rowsDeleted = 0;

  for (const p of providers) {
    const members = p.members as Member[];
    if (members.length < 2) continue;
    const clusters = clusterPersonVariants(members.map(m => m.name));
    const dupClusters = clusters.filter(c => c.length > 1);
    if (dupClusters.length === 0) continue;

    clinicsAffected++;
    console.log(`\n[dedup] ${p.name} (${members.length} members):`);
    for (const idxs of dupClusters) {
      const group = idxs.map(i => members[i]);
      const survivor = [...group].sort((a, b) =>
        completeness(b) - completeness(a) ||
        parsePersonName(b.name).first.length - parsePersonName(a.name).first.length ||
        b.name.length - a.name.length)[0];
      const dups = group.filter(m => m.id !== survivor.id);
      const bestName = pickBestDisplayName(group.map(m => m.name));

      clustersCollapsed++;
      rowsDeleted += dups.length;
      console.log(`  - merge [${group.map(m => `"${m.name}"${m.isMedicalDirector ? "*" : ""}`).join(" + ")}] -> "${bestName}" (keep ${survivor.id.slice(0, 8)}, drop ${dups.length})`);

      if (!APPLY) continue;

      await prisma.providerMember.update({
        where: { id: survivor.id },
        data: {
          name: bestName,
          title: survivor.title || longest(group.map(m => m.title)),
          bio: survivor.bio || longest(group.map(m => m.bio)),
          photoUrl: survivor.photoUrl || group.map(m => m.photoUrl).find(Boolean) || null,
          highResPhotoUrl: survivor.highResPhotoUrl || group.map(m => m.highResPhotoUrl).find(Boolean) || null,
          isMedicalDirector: group.some(m => m.isMedicalDirector),
          specialties: Array.from(new Set(group.flatMap(m => m.specialties))),
          education: survivor.education.length ? survivor.education : (group.find(m => m.education.length)?.education || []),
          boardCertifications: Array.from(new Set(group.flatMap(m => m.boardCertifications))),
        },
      });
      const dupIds = dups.map(m => m.id);
      await prisma.providerReview.updateMany({ where: { memberId: { in: dupIds } }, data: { memberId: survivor.id } });
      await prisma.providerMember.deleteMany({ where: { id: { in: dupIds } } });
    }
  }

  console.log(`\n[dedup] ${APPLY ? "APPLIED" : "WOULD COLLAPSE"}: ${clustersCollapsed} clusters across ${clinicsAffected} providers, ${rowsDeleted} duplicate rows ${APPLY ? "deleted" : "to delete"}`);
  if (!APPLY) console.log(`[dedup] Re-run with --apply to write.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
