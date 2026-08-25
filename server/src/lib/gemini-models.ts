/**
 * The model id lives HERE, not at 20-odd call sites.
 *
 * Before this file the id was hardcoded as a string literal everywhere a model
 * was constructed AND again in every trackGemini() call, so a migration meant a
 * find-and-replace across 14 files with two chances per site to leave the meter
 * disagreeing with the model that was actually billed.
 *
 * Split by workload rather than one global default, because the two have
 * genuinely different risk profiles:
 *
 *   BATCH - extraction, scraping, classification, enrichment. Nobody reads the
 *   output live, correctness is checkable against data we already hold, and
 *   this is where essentially all the tokens are. Safe to move first.
 *
 *   CHAT - Eva (Tier 1 / Tier 2), provider assistant, concierge memory. Talks
 *   to real families, depends on tool-calling and structured-tag discipline
 *   ([[MATCH_CARD]] and friends), and the 73-test concierge suite is tuned
 *   against whatever is set here. Only move it on a green suite run.
 *
 * Both are env-overridable so an A/B needs a restart, not a deploy.
 *
 * Pricing note (Cloud Billing Catalog, service AEFD-7695-64FA, 2026-08-25):
 *   gemini-3.5-flash   $1.50/M in   $9.00/M out
 *   gemini-3.7-flash   $0.75/M in   $3.75/M out   <- 2.4x cheaper on output
 * Output is ~95% of our spend, so the output column is the one that matters.
 * gemini-3.6-flash is priced identically to 3.7, so 3.7 is strictly preferable.
 *
 * When changing either default, add the new id to PRICES in gemini-usage.ts in
 * the same commit or the meter logs UNPRICED and cost attribution silently
 * stops working.
 */

/** Extraction / scraping / classification / enrichment. */
export const GEMINI_BATCH_MODEL = process.env.GEMINI_BATCH_MODEL || "gemini-3.7-flash";

/** Eva and anything else a human reads in real time. */
export const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || "gemini-3.5-flash";

/**
 * The "don't think, just answer" generation config for a given model.
 *
 * THE TRAP: the parameter changed between model generations and the old one
 * fails SILENTLY. gemini-3.5-flash honours `thinkingBudget: 0`. gemini-3.7-flash
 * IGNORES it - no error, no warning, it simply thinks anyway. Measured
 * 2026-08-25 on an identical prompt:
 *
 *   3.5 + thinkingBudget:0     2228ms   0 thinking tokens
 *   3.7 + thinkingBudget:0     7664ms   617 thinking tokens   <- ignored
 *   3.7 + thinkingLevel:"low"  2144ms   0 thinking tokens     <- correct
 *
 * That silence cost a full afternoon. Moving Tier 2 to 3.7 made concierge turns
 * slow enough to blow the test harness's 100s per-attempt SSE budget, producing
 * 24 failures that looked like a streaming or quality regression - while the
 * model's answers were in fact never once wrong. Hidden thinking also bills as
 * OUTPUT, the expensive column, so an ignored budget quietly costs money too.
 *
 * `"off"`, `"none"` and `"minimal"` are all REJECTED by the API; `"low"` is the
 * value that actually yields zero thinking tokens.
 *
 * When adding a model here, PROBE it - do not assume it inherited the previous
 * generation's parameter. Send one prompt each way and read
 * `usageMetadata.thoughtsTokenCount`; anything above 0 means the knob was
 * ignored.
 */
export function thinkingOff(model: string): Record<string, unknown> {
  if (model.startsWith("gemini-3.7")) return { thinkingLevel: "low" };
  return { thinkingBudget: 0 };
}
