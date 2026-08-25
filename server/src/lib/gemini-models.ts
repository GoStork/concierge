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
