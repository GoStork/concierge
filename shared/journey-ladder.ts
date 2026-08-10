/**
 * The one journey ladder.
 *
 * There were two, and they disagreed. `server/journey-timeline.ts` derives the
 * full timeline the sidebar renders - eleven rungs including Consultation
 * Completed and Parent Form Submitted. Separately, the two parents-list
 * endpoints hand-rolled a six-rung "matchStatus" out of a different set of
 * queries, with no rung for either of those two milestones.
 *
 * The result: a family who finished their consultation on Jul 24 and submitted
 * their form on Jul 23 still read "Call Booked" in the Match Status column and
 * on the chat badge - directly beneath a timeline showing both ticked. Not
 * stale data; a ladder missing its middle.
 *
 * This module is the shared vocabulary: one ordered list of stage ids, one set
 * of labels, one resolver. The timeline keeps its richer per-type ladders and
 * branch rungs (No Show, Not Matched) - those are display concerns. What both
 * sides now agree on is WHICH RUNG a family is standing on and WHAT IT IS
 * CALLED.
 *
 * Labels are WORD-FOR-WORD the timeline's. I first shortened them for the
 * table column ("Form Submitted"), which put two different names on one rung
 * and recreated in wording the split this file exists to remove. If a label
 * ever has to be shorter somewhere, truncate at the call site - do not fork
 * the name.
 */

/** Ordered lowest to highest. Later entries win when several are proven. */
export const JOURNEY_STAGE_ORDER = [
  "registered",
  "exploring",
  "consult_scheduled",
  "consult_completed",
  "ip_form_submitted",
  "doctor_call_scheduled",
  "doctor_call_completed",
  "match_call_scheduled",
  "matched",
  "invoice_sent",
  "invoice_paid",
  "agreement_sent",
  "agreement_signed",
  "handed_off",
] as const;

export type JourneyStageId = (typeof JOURNEY_STAGE_ORDER)[number];

export const JOURNEY_STAGE_LABELS: Record<JourneyStageId, string> = {
  registered: "Registered",
  exploring: "Exploring Profiles",
  // Was "Call Booked", while the timeline rung beside it said "Consultation
  // Scheduled" - one rung, two names, on the same screen. The timeline's
  // wording wins, per this file's own rule.
  consult_scheduled: "Consultation Scheduled",
  consult_completed: "Consultation Completed",
  ip_form_submitted: "Parent Form Submitted",
  doctor_call_scheduled: "Doctor Call Scheduled",
  doctor_call_completed: "Doctor Call Completed",
  match_call_scheduled: "Match Call",
  matched: "Matched",
  invoice_sent: "Invoice Sent",
  invoice_paid: "Invoice Paid",
  agreement_sent: "Agreement Sent",
  agreement_signed: "Agreement Signed",
  handed_off: "Handed Off",
};

/**
 * Evidence for one (parent x provider) relationship. Every field is a plain
 * boolean so callers can gather it however suits them - the list endpoints
 * batch it across every parent at once, the record resolves it for one.
 */
export interface JourneyEvidence {
  connected?: boolean;          // provider joined the thread
  consultScheduled?: boolean;
  consultCompleted?: boolean;   // outcome COMPLETED or UNVERIFIED
  ipFormSubmitted?: boolean;
  doctorCallScheduled?: boolean;   // IVF only - the call with the physician
  doctorCallCompleted?: boolean;
  matchCallScheduled?: boolean;
  matched?: boolean;
  invoiceSent?: boolean;
  invoicePaid?: boolean;
  agreementSent?: boolean;
  agreementSigned?: boolean;
  handedOff?: boolean;
}

/**
 * The highest rung with evidence, or null when there is none.
 *
 * Deliberately NOT "the latest thing that happened": a family who submitted
 * their form after their match call was booked is still at match_call, because
 * that is further along. Later rungs win.
 */
export function resolveJourneyStage(e: JourneyEvidence): JourneyStageId | null {
  if (e.handedOff) return "handed_off";
  if (e.agreementSigned) return "agreement_signed";
  if (e.agreementSent) return "agreement_sent";
  if (e.invoicePaid) return "invoice_paid";
  if (e.invoiceSent) return "invoice_sent";
  if (e.matched) return "matched";
  if (e.matchCallScheduled) return "match_call_scheduled";
  if (e.doctorCallCompleted) return "doctor_call_completed";
  if (e.doctorCallScheduled) return "doctor_call_scheduled";
  if (e.ipFormSubmitted) return "ip_form_submitted";
  if (e.consultCompleted) return "consult_completed";
  if (e.consultScheduled || e.connected) return "consult_scheduled";
  return null;
}

/**
 * The cross-provider outcome: this family committed to a DIFFERENT provider
 * on this service line.
 *
 * Deliberately OUTSIDE JOURNEY_STAGE_ORDER. The order array is a rank ladder
 * ("which rung is furthest along"), and this is not a rung - it is a branch
 * that ends the journey sideways, like No Show or Canceled. Putting it in the
 * order would make `rank()` treat it as more or less advanced than a real
 * stage, and the most-advanced-wins rollups would start comparing a loss
 * against a milestone.
 *
 * Lives here rather than in server/matched-elsewhere.ts (which re-exports it)
 * so the tables' pills and the ladder read the same words.
 */
export const MATCHED_ELSEWHERE_STAGE = "matched_elsewhere";
export const MATCHED_ELSEWHERE_LABEL = "Matched Elsewhere";

export function journeyStageLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id === MATCHED_ELSEWHERE_STAGE) return MATCHED_ELSEWHERE_LABEL;
  return JOURNEY_STAGE_LABELS[id as JourneyStageId] ?? null;
}

/**
 * Old matchStatus values, mapped onto the shared ids.
 *
 * Rows written before this existed - and the chat session's own status enum,
 * which is a different thing entirely (it tracks whether a provider can post
 * in the thread) - still speak the old vocabulary. Translate rather than
 * leaving two enums in play.
 */
export const LEGACY_MATCH_STATUS_TO_STAGE: Record<string, JourneyStageId> = {
  CONSULTATION_BOOKED: "consult_scheduled",
  PROVIDER_CONNECTED: "consult_scheduled",
  MATCH_CALL: "match_call_scheduled",
  MATCHED: "matched",
  DEPOSIT_PAID: "invoice_paid",
  AGREEMENT_SIGNED: "agreement_signed",
  HANDED_OFF: "handed_off",
};
