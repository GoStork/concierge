/**
 * "Matched Elsewhere" - the cross-provider outcome.
 *
 * When a family commits to one agency on a service line (first PAID invoice
 * or SIGNED agreement, whichever lands first), every OTHER agency working
 * that same line has effectively lost it. They should stop chasing, and the
 * lead should stop reading as live in their pipeline.
 *
 * DERIVED, NEVER STORED. The winning artifact is the whole truth, so this
 * reverses for free: void the invoice, refund it, or supersede the signed
 * agreement and every losing ladder returns to where it was. A stored flag
 * would have needed its own un-set path and would have gone stale the first
 * time a match fell through - which, in this business, it does.
 *
 * Three rules the callers must honour, each one a way to do real damage:
 *   - SAME LINE ONLY. Winning egg donation says nothing about surrogacy.
 *   - MATERIAL RELATIONSHIPS ONLY. An agency the family merely browsed has
 *     lost nothing; only mark those who reached a consultation or beyond.
 *   - NEVER NAME THE WINNER. The losing agency learns that the family moved
 *     on, not who they moved on with. `winnerProviderId` exists so a caller
 *     can exclude the winner from its own sweep - it must not reach a
 *     provider-facing payload.
 */

/** Money/paperwork that proves a family committed to one provider. */
export interface CommitmentArtifact {
  providerId: string | null;
  /** Journey service line ("surrogacy", "egg_donation", ...). */
  serviceLine: string | null;
  at: Date | string | null;
}

export interface LineWinner {
  providerId: string;
  at: Date;
}

/**
 * Earliest commitment per service line. Ties go to the earliest timestamp,
 * so a later second payment never steals the outcome from the first.
 */
export function winnersByLine(artifacts: CommitmentArtifact[]): Map<string, LineWinner> {
  const out = new Map<string, LineWinner>();
  for (const a of artifacts) {
    if (!a.providerId || !a.serviceLine || !a.at) continue;
    const at = a.at instanceof Date ? a.at : new Date(a.at);
    if (Number.isNaN(at.getTime())) continue;
    const cur = out.get(a.serviceLine);
    if (!cur || at < cur.at) out.set(a.serviceLine, { providerId: a.providerId, at });
  }
  return out;
}

/**
 * The moment this provider lost the line, or null if they did not.
 *
 * `material` is the caller's judgement that the relationship was real enough
 * to be worth marking - passing false always returns null.
 */
export function matchedElsewhereAt(
  winners: Map<string, LineWinner>,
  providerId: string | null,
  serviceLine: string | null,
  material: boolean,
): Date | null {
  if (!material || !providerId || !serviceLine) return null;
  const winner = winners.get(serviceLine);
  if (!winner || winner.providerId === providerId) return null;
  return winner.at;
}

/**
 * A commitment is a non-refunded PAID invoice or a live SIGNED agreement.
 *
 * BANK_CHECKOUT invoices are excluded on purpose: buying vials from one bank
 * is a purchase, not an exclusive engagement, and a family may well buy from
 * two. Cancelled and refunded invoices are excluded because the money did not
 * stay moved - the same rule the ladder uses for the Invoice Paid rung.
 */
export function isCommittingInvoice(inv: {
  status?: string | null; triggerSource?: string | null;
}): boolean {
  return inv?.status === "PAID" && inv?.triggerSource !== "BANK_CHECKOUT";
}

export function isCommittingAgreement(agr: {
  status?: string | null; supersededAt?: Date | string | null;
}): boolean {
  return agr?.status === "SIGNED" && !agr?.supersededAt;
}

/**
 * Rungs that mean "this family only browsed". A provider sitting on one of
 * these has no relationship to lose, so they are never marked or notified.
 */
export const PRE_ENGAGEMENT_STAGES = new Set(["registered", "exploring"]);

/** The stage id and label the ladder and the Match Status pill both use. */
export const MATCHED_ELSEWHERE_STAGE = "matched_elsewhere";
export const MATCHED_ELSEWHERE_LABEL = "Matched Elsewhere";
