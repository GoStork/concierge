/**
 * One-time backfill: derive User.partnerGender for existing parents.
 *
 * Eva's onboarding emits [[SAVE:{"familyType":"..."}]] but the SAVE post-
 * processor strips those blocks from message content before it's persisted,
 * so we can't read familyType out of history. Instead we infer partnerGender
 * from the three User fields that DID get persisted via the same SAVE block:
 *   gender, relationshipStatus, sexualOrientation
 * plus the IntendedParentProfile.sameSexCouple flag when present.
 *
 * Truth table:
 *   gender=man,   single                          -> partner=null  (Solo Man)
 *   gender=woman, single                          -> partner=null  (Solo Woman)
 *   gender=man,   couple, sexualOrientation=Gay   -> partner=man   (2 Dads)
 *   gender=woman, couple, sexualOrientation=Lesbian -> partner=woman (2 Moms)
 *   gender=man,   couple, sexualOrientation=Straight -> partner=woman (straight)
 *   gender=woman, couple, sexualOrientation=Straight -> partner=man (straight)
 *   gender=woman, couple, sameSexCouple=true      -> partner=woman (2 Moms fallback)
 *   gender=man,   couple, sameSexCouple=true      -> partner=man   (2 Dads fallback)
 *   gender=woman, couple, sameSexCouple=false     -> partner=man   (straight fallback)
 *   gender=man,   couple, sameSexCouple=false     -> partner=woman (straight fallback)
 *
 * Anything ambiguous (e.g. partnered but orientation/sameSex unknown) is left
 * alone and reported so the user can fill it in next time they touch Eva.
 *
 * Run: npx tsx -r dotenv/config scripts/backfill-partner-gender.ts
 *      npx tsx -r dotenv/config scripts/backfill-partner-gender.ts --dry-run
 *
 * Idempotent: only updates rows where partnerGender IS NULL. Safe to re-run.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const DRY_RUN = process.argv.includes("--dry-run");

function normalizeGender(g: string | null | undefined): "man" | "woman" | null {
  if (!g) return null;
  const lower = g.toLowerCase().trim();
  if (lower === "i'm a man" || lower === "man" || lower === "male") return "man";
  if (lower === "i'm a woman" || lower === "woman" || lower === "female") return "woman";
  return null;
}

function isSingle(rel: string | null): boolean {
  return rel === "Single";
}

function isCoupled(rel: string | null): boolean {
  return rel === "Partnered" || rel === "Married";
}

function isLesbianOrGay(o: string | null): boolean {
  return o === "Lesbian" || o === "Gay";
}

function isStraight(o: string | null): boolean {
  return o === "Straight";
}

interface Decision {
  partnerGender: "man" | "woman" | null;
  reason: string;
}

function decide(user: {
  gender: string | null;
  relationshipStatus: string | null;
  sexualOrientation: string | null;
}, ipSameSex: boolean | null): Decision | null {
  const g = normalizeGender(user.gender);
  if (!g) return null; // gender unknown -> can't decide

  if (isSingle(user.relationshipStatus)) {
    return { partnerGender: null, reason: `solo_${g === "man" ? "man" : "woman"}` };
  }

  if (!isCoupled(user.relationshipStatus)) {
    // Relationship unknown - skip rather than guess.
    return null;
  }

  if (g === "woman") {
    if (user.sexualOrientation === "Lesbian") return { partnerGender: "woman", reason: "two_moms (Lesbian)" };
    if (user.sexualOrientation === "Queer" && ipSameSex === true) return { partnerGender: "woman", reason: "two_moms (Queer+sameSex)" };
    if (isStraight(user.sexualOrientation)) return { partnerGender: "man", reason: "straight_couple (Straight)" };
    if (user.sexualOrientation === "Bi" || user.sexualOrientation === "Queer") {
      if (ipSameSex === true) return { partnerGender: "woman", reason: "two_moms (Bi/Queer+sameSex)" };
      if (ipSameSex === false) return { partnerGender: "man", reason: "straight_couple (Bi/Queer+!sameSex)" };
      return null;
    }
    // Orientation unknown - fall back to sameSexCouple flag.
    if (ipSameSex === true) return { partnerGender: "woman", reason: "two_moms (sameSex)" };
    if (ipSameSex === false) return { partnerGender: "man", reason: "straight_couple (!sameSex)" };
    return null;
  }

  // g === "man"
  if (user.sexualOrientation === "Gay") return { partnerGender: "man", reason: "two_dads (Gay)" };
  if (isStraight(user.sexualOrientation)) return { partnerGender: "woman", reason: "straight_couple (Straight)" };
  if (user.sexualOrientation === "Bi" || user.sexualOrientation === "Queer") {
    if (ipSameSex === true) return { partnerGender: "man", reason: "two_dads (Bi/Queer+sameSex)" };
    if (ipSameSex === false) return { partnerGender: "woman", reason: "straight_couple (Bi/Queer+!sameSex)" };
    return null;
  }
  if (ipSameSex === true) return { partnerGender: "man", reason: "two_dads (sameSex)" };
  if (ipSameSex === false) return { partnerGender: "woman", reason: "straight_couple (!sameSex)" };
  return null;
}

async function main() {
  console.log(`[backfill] partnerGender backfill ${DRY_RUN ? "(DRY RUN)" : ""} starting`);

  const candidates = await prisma.user.findMany({
    where: {
      partnerGender: null,
      roles: { has: "PARENT" },
    },
    select: {
      id: true,
      email: true,
      gender: true,
      relationshipStatus: true,
      sexualOrientation: true,
      parentAccountId: true,
    },
  });

  console.log(`[backfill] ${candidates.length} parent users with null partnerGender`);

  // Bulk-load IntendedParentProfile.sameSexCouple to avoid a per-user query.
  const accountIds = candidates.map((u) => u.parentAccountId).filter((x): x is string => !!x);
  const profiles = accountIds.length > 0
    ? await prisma.intendedParentProfile.findMany({
        where: { parentAccountId: { in: accountIds } },
        select: { parentAccountId: true, sameSexCouple: true },
      })
    : [];
  const sameSexByAccount = new Map(profiles.map((p) => [p.parentAccountId, p.sameSexCouple]));

  const summary = { updated: 0, soloMan: 0, soloWoman: 0, twoMoms: 0, twoDads: 0, straightCouple: 0, ambiguous: 0, noGender: 0 };

  for (const user of candidates) {
    const ipSameSex = user.parentAccountId ? sameSexByAccount.get(user.parentAccountId) ?? null : null;
    const decision = decide(user, ipSameSex);

    if (!decision) {
      if (!normalizeGender(user.gender)) summary.noGender++;
      else summary.ambiguous++;
      continue;
    }

    const tag = decision.reason.split(" ")[0];
    if (tag === "solo_man") summary.soloMan++;
    else if (tag === "solo_woman") summary.soloWoman++;
    else if (tag === "two_moms") summary.twoMoms++;
    else if (tag === "two_dads") summary.twoDads++;
    else if (tag === "straight_couple") summary.straightCouple++;

    console.log(`[backfill]   ${user.email}: gender=${user.gender} rel=${user.relationshipStatus} orientation=${user.sexualOrientation} sameSex=${ipSameSex} -> partner=${decision.partnerGender ?? "null"}  // ${decision.reason}`);

    if (!DRY_RUN) {
      await prisma.user.update({
        where: { id: user.id },
        data: { partnerGender: decision.partnerGender },
      });
    }
    summary.updated++;
  }

  console.log(`[backfill] done. ${JSON.stringify(summary, null, 2)} ${DRY_RUN ? "(NO WRITES)" : ""}`);
}

main()
  .catch((e) => {
    console.error("[backfill] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
