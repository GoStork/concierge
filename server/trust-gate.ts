/**
 * Runtime gate for quarantined signups (Phase 9 §8, #3 enforcement).
 *
 * A QUARANTINED account exists and can browse, but is held back from the
 * actions that spend a provider's time or reveal a real person to them -
 * booking a call, a consultation (which unmasks the parent). The account
 * clears the moment an admin approves it in the /parents review queue.
 *
 * Fail-open by design: only an explicit QUARANTINED state blocks. A lookup
 * error or a missing user never turns a real parent away.
 */
import { ForbiddenException } from "@nestjs/common";

export const QUARANTINE_ACTION_MESSAGE =
  "account_under_review"; // client maps this to a friendly "your account is being reviewed" notice

/** Structural type so both PrismaService and the raw client satisfy it. */
type PrismaLike = { user: { findUnique: (args: any) => Promise<{ trustState: string | null } | null> } };

/**
 * Throw if this parent is quarantined. Pass the already-loaded trustState when
 * you have it (req.user), else the userId to look up.
 */
export async function assertNotQuarantined(
  prisma: PrismaLike,
  who: { userId?: string | null; trustState?: string | null },
): Promise<void> {
  let state = who.trustState ?? null;
  if (state == null && who.userId) {
    try {
      const u = await prisma.user.findUnique({ where: { id: who.userId }, select: { trustState: true } });
      state = u?.trustState ?? null;
    } catch {
      return; // fail open
    }
  }
  if (state === "QUARANTINED") {
    throw new ForbiddenException(QUARANTINE_ACTION_MESSAGE);
  }
}
