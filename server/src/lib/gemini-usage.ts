/**
 * Gemini spend instrumentation.
 *
 * Why this exists: on 2026-08-20..23 a scraper auto-resume crash-loop burned
 * ~$845 of Gemini in four days and nothing in the codebase could say where it
 * went - there was no token accounting anywhere. The answer had to be
 * reconstructed from Cloud Monitoring after the fact. This module makes the
 * same question answerable with a grep.
 *
 * Two outputs, both cheap:
 *   1. A structured log line per call, so grepping "gemini-cost" on
 *      /tmp/gostork-server.log attributes spend live.
 *   2. An in-memory daily rollup flushed to GeminiUsage every 60s, so
 *      GET /api/admin/gemini-usage can show cost by subsystem over time.
 *
 * It never writes per call - a single donor sync makes thousands of calls and
 * a DB round-trip on each would cost more than the thing it measures.
 *
 * IMPORTANT: recording must never break the caller. Every entry point here
 * swallows its own errors; a broken meter must not fail a sync.
 */

// Real per-token prices from the Cloud Billing Catalog (service AEFD-7695-64FA,
// "Gemini API"), read 2026-08-25. Output is 6x input on 3.5-flash and is where
// essentially all of our spend lands - the Aug 20-23 incident was 95% output.
// Re-check these after any model migration.
type Price = { input: number; output: number };
const PRICES: Record<string, Price> = {
  "gemini-3.5-flash": { input: 1.5e-6, output: 9.0e-6 },
  // 3.6 and 3.7 are priced identically - half the input, 2.4x cheaper output
  // than 3.5. Since output is ~95% of our spend, that is a ~57% cut.
  "gemini-3.7-flash": { input: 0.75e-6, output: 3.75e-6 },
  "gemini-3.6-flash": { input: 0.75e-6, output: 3.75e-6 },
  "gemini-3.5-flash-lite": { input: 0.3e-6, output: 2.5e-6 },
  // Image model: output tokens are IMAGE tokens at $60/M - 6.7x the text rate.
  // One doctor-photo upscale run on 2026-08-23 cost $87 on its own.
  "gemini-3.1-flash-image": { input: 0.5e-6, output: 60e-6 },
  "gemini-3.1-flash-lite-preview": { input: 0.25e-6, output: 1.5e-6 },
};

export type GeminiUsageRow = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
};

export type GeminiUsageFlushRow = { day: string; subsystem: string; model: string } & GeminiUsageRow;

const buffer = new Map<string, GeminiUsageRow>(); // `${day} ${subsystem} ${model}`
let flushTimer: NodeJS.Timeout | null = null;
let flushFn: ((rows: GeminiUsageFlushRow[]) => Promise<void>) | null = null;

/** Pull input/output/cached token counts out of either SDK's response shape. */
function readUsage(result: any): { input: number; output: number; cached: number } | null {
  const u =
    result?.response?.usageMetadata ?? // @google/generative-ai
    result?.usageMetadata ??           // @google/genai, and bare response objects
    null;
  if (!u) return null;
  const input = Number(u.promptTokenCount ?? u.promptTokens ?? 0) || 0;
  const output =
    Number(u.candidatesTokenCount ?? u.candidatesTokens ?? u.responseTokenCount ?? 0) || 0;
  const cached = Number(u.cachedContentTokenCount ?? 0) || 0;
  if (!input && !output && !cached) return null;
  return { input, output, cached };
}

export function priceFor(model: string, input: number, output: number): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return input * p.input + output * p.output;
}

/**
 * Record one Gemini call. Pass the raw SDK result - usage metadata is read off
 * it. Safe to call with anything; unrecognised shapes are ignored.
 *
 * `subsystem` is the label you will grep and group by, so keep it stable and
 * specific: "donor-catalog", "donor-profile", "concierge-tier2", "cost-sheet".
 */
export function trackGemini(subsystem: string, model: string, result: any): void {
  try {
    const u = readUsage(result);
    if (!u) return;
    const cost = priceFor(model, u.input, u.output);
    const day = new Date().toISOString().slice(0, 10);
    const key = `${day} ${subsystem} ${model}`;
    const row =
      buffer.get(key) ?? { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
    row.calls += 1;
    row.inputTokens += u.input;
    row.outputTokens += u.output;
    row.cachedTokens += u.cached;
    row.costUsd += cost ?? 0;
    buffer.set(key, row);

    console.log(
      `[gemini-cost] subsystem=${subsystem} model=${model} in=${u.input} out=${u.output}` +
        (u.cached ? ` cached=${u.cached}` : "") +
        ` cost=${cost == null ? "UNPRICED" : "$" + cost.toFixed(6)}` +
        ` day_total=$${row.costUsd.toFixed(4)} day_calls=${row.calls}`,
    );
    if (cost == null) {
      console.warn(
        `[gemini-cost] no price entry for model "${model}" - tokens counted, cost not. Add it to PRICES in server/src/lib/gemini-usage.ts.`,
      );
    }
  } catch {
    // A broken meter must never break a sync.
  }
}

/** Snapshot of everything buffered since the last flush (for debugging/tests). */
export function pendingGeminiUsage(): GeminiUsageFlushRow[] {
  return [...buffer.entries()].map(([k, v]) => {
    const [day, subsystem, model] = k.split(" ");
    return { day, subsystem, model, ...v };
  });
}

/**
 * Register the persistence callback and start the flush loop. Called once at
 * boot from server/index.ts. Without this the module still logs; it just does
 * not persist.
 */
export function startGeminiUsageFlush(
  persist: (rows: GeminiUsageFlushRow[]) => Promise<void>,
  intervalMs = 60_000,
): void {
  flushFn = persist;
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushGeminiUsage();
  }, intervalMs);
  flushTimer.unref?.();

  // Signal handling here is a LIABILITY, not a feature. Node's default action
  // for SIGTERM/SIGINT is to terminate; the moment you register a listener that
  // default is replaced by your listener. A first cut of this file registered a
  // handler that only flushed and never exited, which silently made the server
  // unkillable: `lsof -ti :5001 | xargs kill` (the documented restart in
  // CLAUDE.md) stopped working, and `systemctl stop` on the prod VM would have
  // hung until systemd's SIGKILL timeout. These are the only signal handlers in
  // the app, so nothing else was going to call exit for us.
  //
  // So: flush, then exit with the conventional 128+signo, and never let a slow
  // DB write hold shutdown open. Metering must never change process lifecycle.
  let exiting = false;
  const onSignal = (signo: number) => () => {
    if (exiting) return;
    exiting = true;
    const done = () => process.exit(128 + signo);
    const guard = setTimeout(done, 2000);
    guard.unref?.();
    void flushGeminiUsage().finally(() => {
      clearTimeout(guard);
      done();
    });
  };
  process.once("SIGTERM", onSignal(15));
  process.once("SIGINT", onSignal(2));
  // beforeExit fires only on a natural empty-event-loop exit, never on signals
  // or process.exit(), so it is additive and cannot block anything.
  process.once("beforeExit", () => { void flushGeminiUsage(); });
}

/**
 * Drain the buffer into the DB. Drains FIRST so a slow write cannot
 * double-count; on failure the rows are merged back so nothing is lost.
 */
export async function flushGeminiUsage(): Promise<void> {
  if (!flushFn || buffer.size === 0) return;
  const rows = pendingGeminiUsage();
  buffer.clear();
  try {
    await flushFn(rows);
  } catch (err: any) {
    for (const r of rows) {
      const key = `${r.day} ${r.subsystem} ${r.model}`;
      const back =
        buffer.get(key) ?? { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
      back.calls += r.calls;
      back.inputTokens += r.inputTokens;
      back.outputTokens += r.outputTokens;
      back.cachedTokens += r.cachedTokens;
      back.costUsd += r.costUsd;
      buffer.set(key, back);
    }
    console.error(
      `[gemini-cost] flush failed, ${rows.length} row(s) requeued: ${err?.message || err}`,
    );
  }
}
