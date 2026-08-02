// Interrogative-STRUCTURE detector for the QUESTION INTERCEPTOR in
// ai-router.ts. The previous heuristic matched substring PRESENCE of question
// words (/\?|what|how|.../) and fired the expensive regenerate-the-reply path
// on declarative fragments - both multi-second interceptor fires in the
// 2026-08-02 baseline were "That's what I wanted to tell you to"-shaped
// utterances matching a bare "what". A question is now recognized only by
// actual interrogative structure:
//
//   1. a question mark anywhere (Deepgram punctuates reliably),
//   2. a sentence that BEGINS with an interrogative word or an ask-imperative
//      ("tell me...", "show me..."), or
//   3. subject-auxiliary inversion about a third party ("does she", "is he",
//      "can they") anywhere in the utterance.
//
// Pure function, no imports - unit-tested directly in
// scripts/test-unit-guards.ts (UT: question-shape).

// Sentence-leading interrogatives and ask-imperatives. Anchored to the start
// of the message or the start of a sentence ([.!?] + space), never substring.
const INTERROGATIVE_LEAD =
  /(^|[.!?]\s+)(what|who|whose|whom|why|how|where|when|which|can|could|would|will|shall|should|does|do|did|is|are|was|were|has|have|am|tell me|show me)\b/i;

// Subject-auxiliary inversion about the profile subject ("does she", "has
// he", "are they"). Word order is the signal - "she does yoga" won't match.
const SUBJECT_AUX_INVERSION =
  /\b(does|do|did|is|are|was|were|has|have|can|could|would|will|shall|should)\s+(she|he|they|it)\b/i;

export function looksLikeProfileQuestion(text: string): boolean {
  if (!text) return false;
  return (
    text.includes("?") ||
    INTERROGATIVE_LEAD.test(text) ||
    SUBJECT_AUX_INVERSION.test(text)
  );
}
