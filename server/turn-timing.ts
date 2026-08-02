import { AsyncLocalStorage } from "async_hooks";

// INSTRUMENTATION ONLY - per-request timing collector for the /api/ai-concierge
// /chat pipeline. A request-scoped store is entered at the top of the /chat
// handler; mark() and recordToolCall() write into it from anywhere downstream
// (tier functions, the wrapped MCP callTool) without threading a parameter
// through 10k lines. setupSSE's sendDone() snapshots the store into the done
// payload as `__turnTimings`, where the voice gateway merges it into the
// per-turn [TURN_METRICS] JSON line (and strips it before forwarding cards to
// the client). Changes NO behavior: every write is a push into an array.
//
// Epoch-ms timestamps throughout, all from THIS server process's clock - the
// voice gateway's internal fetch lands in the same process, so gateway and
// router marks are directly comparable.

export interface ToolCallTiming {
  name: string;
  tStart: number;
  tEnd: number;
  ms: number;
}

export interface TurnTimings {
  reqAt: number;
  // Ordered named checkpoints: router_entry, context_sections_loaded,
  // skip_directives_done, bypass_served, tier1_start/end, tier2_start/end,
  // tier2_round_N, done_sent ...
  marks: Array<{ event: string; t: number }>;
  toolCalls: ToolCallTiming[];
}

export const turnTimingStore = new AsyncLocalStorage<TurnTimings>();

export function newTurnTimings(): TurnTimings {
  return { reqAt: Date.now(), marks: [], toolCalls: [] };
}

export function mark(event: string): void {
  const s = turnTimingStore.getStore();
  if (s) s.marks.push({ event, t: Date.now() });
}

export function recordToolCall(name: string, tStart: number, tEnd: number): void {
  const s = turnTimingStore.getStore();
  if (s) s.toolCalls.push({ name, tStart, tEnd, ms: tEnd - tStart });
}

// Wrap a single async call with <name>_start / <name>_done marks. For
// conditional call sites (D1 cost lookups etc.) where surrounding-mark deltas
// would mis-attribute time on turns that skip them.
export async function timeSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  mark(`${name}_start`);
  try {
    return await fn();
  } finally {
    mark(`${name}_done`);
  }
}

// Snapshot for embedding in the done payload. Returns null outside a request
// context (e.g. non-chat routes that share setupSSE-like helpers).
export function snapshotTurnTimings(): TurnTimings | null {
  const s = turnTimingStore.getStore();
  if (!s) return null;
  return { reqAt: s.reqAt, marks: [...s.marks], toolCalls: [...s.toolCalls] };
}
