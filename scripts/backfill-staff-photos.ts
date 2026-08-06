/**
 * Give staff Users the headshot that already exists on their doctor profile.
 *
 * "Add Team Member" pre-fills from an existing ProviderMember and copies its
 * photoUrl onto the new User - that path works, and 15 provider users have a
 * photo because of it. But staff created before that wiring (or typed in by
 * hand rather than picked from the dropdown) have User.photoUrl NULL while
 * their ProviderMember row carries a perfectly good headshot. They show
 * initials everywhere the app renders a user avatar: the nav, the owner chip
 * on a parent record, chat bylines.
 *
 * MATCHING: exact name within the same provider. That is the ONLY link
 * available - ProviderMember has no userId and no email column. Exact and
 * org-scoped on purpose: PFCLA has both "Vicken Sahakian" and "Dr. Vicken
 * Sepilian", two different doctors, and a fuzzy match would put one man's
 * face on the other's account.
 *
 * Only ever FILLS a null. Never overwrites a photo someone chose.
 *
 * Dry run:  npx tsx scripts/backfill-staff-photos.ts
 * Apply:    npx tsx scripts/backfill-staff-photos.ts --apply
 */
import "dotenv/config";
import { prisma } from "../server/db";

const APPLY = process.argv.includes("--apply");

(async () => {
  console.log(APPLY ? "APPLYING\n" : "DRY RUN - pass --apply to write\n");

  const staff = await prisma.user.findMany({
    where: { providerId: { not: null }, photoUrl: null, name: { not: null } },
    select: { id: true, name: true, providerId: true, email: true },
  });
  if (staff.length === 0) {
    console.log("No staff users are missing a photo.");
    process.exit(0);
  }

  const members = await prisma.providerMember.findMany({
    where: {
      OR: staff.map((u) => ({ providerId: u.providerId as string, name: u.name as string })),
      photoUrl: { not: null },
    },
    select: { id: true, name: true, providerId: true, photoUrl: true },
  });

  let matched = 0;
  for (const u of staff) {
    const hits = members.filter((m) => m.providerId === u.providerId && m.name === u.name);
    if (hits.length === 0) {
      console.log(`  no member photo   ${u.name} <${u.email}>`);
      continue;
    }
    if (hits.length > 1) {
      // Two member rows with the identical name in one org is ambiguous, and
      // guessing would put a face on the wrong account. Skip loudly.
      console.log(`  AMBIGUOUS (${hits.length} members named "${u.name}") - skipped`);
      continue;
    }
    matched++;
    console.log(`  MATCH             ${u.name} <${u.email}>`);
    console.log(`                    ${hits[0].photoUrl}`);
    if (APPLY) {
      await prisma.user.update({ where: { id: u.id }, data: { photoUrl: hits[0].photoUrl } });
    }
  }

  console.log(`\n${staff.length} staff without a photo, ${matched} matched to a doctor profile.`);
  console.log(APPLY ? "Written." : "Nothing written.");
  process.exit(0);
})().catch((e) => {
  console.error("THREW:", e);
  process.exit(1);
});
