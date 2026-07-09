/**
 * Deterministic journeyStage sync.
 *
 * IntendedParentProfile.journeyStage is Eva's coarse "where is this parent"
 * note, injected into her prompt context ("Journey stage: X."). Historically
 * only three values were ever written (Consultation Requested / Match
 * Eligibility / Consultation - Not a Fit), so the field fossilized early in
 * the journey while the real Match Status ladder marched on to Matched /
 * Deposit Paid / Agreement Signed - and Eva reasoned from stale state.
 *
 * advanceJourneyStage moves the field FORWARD at the same server events that
 * drive the derived Match Status (official match, deposit paid, agreement
 * signed). Forward-only: a late-paying second invoice can't demote an
 * Agreement Signed parent back to Deposit Paid. Unknown/legacy values are
 * treated as rank 0 and overwritten. Eva's own [[SAVE:{"journeyStage"}]]
 * writes keep working for the early conversational stages.
 */
import { prisma } from "./db";

const STAGE_ORDER = [
  "Exploring",
  "Consultation Requested",
  "Match Eligibility",
  "Matched",
  "Deposit Paid",
  "Agreement Signed",
];

export async function advanceJourneyStage(parentUserId: string, stage: string): Promise<void> {
  try {
    const me = await prisma.user.findUnique({ where: { id: parentUserId }, select: { parentAccountId: true } });
    if (!me?.parentAccountId) return;
    const profile = await prisma.intendedParentProfile.findUnique({
      where: { parentAccountId: me.parentAccountId },
      select: { journeyStage: true },
    });
    if (!profile) return;
    const curRank = STAGE_ORDER.indexOf(profile.journeyStage || "");
    const newRank = STAGE_ORDER.indexOf(stage);
    if (newRank < 0 || newRank <= curRank) return;
    await prisma.intendedParentProfile.update({
      where: { parentAccountId: me.parentAccountId },
      data: { journeyStage: stage },
    });
    console.log(`[journey-stage] Parent account ${me.parentAccountId}: "${profile.journeyStage || "(none)"}" -> "${stage}"`);
  } catch (e: any) {
    console.error(`[journey-stage] advance failed for ${parentUserId}: ${e?.message}`);
  }
}
