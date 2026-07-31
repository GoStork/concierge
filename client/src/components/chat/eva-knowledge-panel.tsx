/**
 * "What Eva knows" - the takeover briefing. Shows the session's rolling
 * summary (the exact context injected into Eva's prompt each turn) and the
 * family's durable concierge memory, editable in place via the shared
 * ConciergeMemoryTab admin variant. Collapsed by default so the sidebar
 * stays scannable; no modal per design rules.
 *
 * Lived inside admin-concierge-monitor.tsx, where it only ever had ONE
 * session's summary to show. The parent record is account-scoped and has N
 * sessions, so it also accepts `sessionSummaries`. The single-`historySummary`
 * path is preserved exactly, so the monitor renders as it always did - this is
 * a move plus a widening, not a rewrite.
 */
import { useState } from "react";
import { Brain, ChevronDown } from "lucide-react";
import { ConciergeMemoryTab } from "@/components/concierge-memory-tab";

export interface EvaSessionSummary {
  sessionId: string;
  /** What to call this thread - usually the provider org or the subject. */
  label: string;
  historySummary: string;
}

export function EvaKnowledgePanel({
  historySummary,
  sessionSummaries,
  parentAccountId,
  divider = true,
}: {
  /** Single-session form, used by the concierge monitor. */
  historySummary?: string | null;
  /** Multi-session form, used by the parent record. */
  sessionSummaries?: EvaSessionSummary[];
  parentAccountId: string;
  /** The monitor stacks this mid-rail and needs its own rule; the record does not. */
  divider?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const multi = (sessionSummaries?.length || 0) > 0;

  return (
    <div className={divider ? "border-b pb-4 mb-4" : "pt-1"} data-testid="eva-knowledge-panel">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
        data-testid="btn-toggle-eva-knowledge"
      >
        <h4 className="font-semibold text-sm flex items-center gap-1.5" style={{ fontFamily: "var(--font-display)" }}>
          <Brain className="w-4 h-4 text-primary" /> What Eva knows
        </h4>
        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-3 space-y-4">
          <div>
            <p className="t-micro-label mb-1">
              {multi ? "Session summaries" : "Session summary"}
            </p>
            {multi ? (
              <div className="space-y-2">
                {sessionSummaries!.map((s) => (
                  <div key={s.sessionId} data-testid={`text-history-summary-${s.sessionId}`}>
                    <p className="t-helper mb-0.5">{s.label}</p>
                    <p className="text-xs text-foreground whitespace-pre-wrap bg-secondary/50 rounded-md p-2.5">
                      {s.historySummary}
                    </p>
                  </div>
                ))}
              </div>
            ) : historySummary ? (
              <p className="text-xs text-foreground whitespace-pre-wrap bg-secondary/50 rounded-md p-2.5" data-testid="text-history-summary">
                {historySummary}
              </p>
            ) : (
              <p className="t-helper">
                No rolling summary yet - it starts once the conversation is long enough to fold (about 28 turns).
              </p>
            )}
          </div>
          <div>
            <p className="t-micro-label mb-1">Family memory</p>
            <ConciergeMemoryTab admin={{ parentAccountId }} />
          </div>
        </div>
      )}
    </div>
  );
}
