/**
 * Booking.meetingSubtype values.
 *
 * null is a consultation (the first call with a provider), and it drives the
 * journey ladder, the consultation lock and the post-call flows. MATCH_CALL
 * and DOCTOR_CONSULTATION are journey calls with their own rungs.
 *
 * FOLLOW_UP is a plain call a connected family books with their provider from
 * inside the shared chat. It is NOT a journey step: it never ticks a ladder
 * rung, never emits a CONSULTATION_* / MATCH_CALL_* event, never counts
 * toward the consultation lock, and never triggers win-back or readiness
 * prompts. Every consumer that treats "not MATCH_CALL / DOCTOR" as a
 * consultation must exclude it through isFollowUpCall().
 */
export const FOLLOW_UP_CALL = "FOLLOW_UP";

export const VALID_MEETING_SUBTYPES = new Set(["MATCH_CALL", "DOCTOR_CONSULTATION", FOLLOW_UP_CALL]);

export function isFollowUpCall(meetingSubtype: string | null | undefined): boolean {
  return meetingSubtype === FOLLOW_UP_CALL;
}
