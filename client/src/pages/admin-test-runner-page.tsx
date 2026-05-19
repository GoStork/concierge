import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

// ─── Types ────────────────────────────────────────────────────────────────────

type TestStatus = "pending" | "running" | "pass" | "fail" | "skipped";

interface TestProgress {
  id: string;
  status: TestStatus;
  currentMessage: number;
  totalMessages: number;
  errors: string[];
  durationMs: number;
  lastUserMsg?: string;
  lastAiSnippet?: string;
}

interface RunnerState {
  runId: string;
  startedAt: string;
  status: "idle" | "running" | "done";
  filter?: string;
  tests: Record<string, TestProgress>;
}

// ─── Static test case metadata (persona + name) ───────────────────────────────

interface TestMeta {
  id: string;
  persona: string;
  name: string;
  desc: string;
}

const TEST_META: TestMeta[] = [
  // SOLO MAN
  { id: "SM-01", persona: "solo-man", name: "No embryos - Own sperm - All services - Intake only", desc: "Most common solo man path - validates intake" },
  { id: "SM-02", persona: "solo-man", name: "No embryos - Own sperm - Has egg donor - CLINIC_HAVE - USA", desc: "CLINIC_HAVE: egg donor skipped, D-cycle validates USA" },
  { id: "SM-03", persona: "solo-man", name: "No embryos - Own sperm - Has surrogate - CLINIC_HAVE", desc: "CLINIC_HAVE: Step 2 egg source SKIPPED for solo man" },
  { id: "SM-04", persona: "solo-man", name: "No embryos - Donor sperm - All services - Intake only", desc: "Validates donor sperm path" },
  { id: "SM-05", persona: "solo-man", name: "No embryos - Donor sperm - Has sperm donor - CLINIC_HAVE - Colombia", desc: "CLINIC_HAVE: Colombia agency" },
  { id: "SM-06", persona: "solo-man", name: "No embryos - Donor sperm - CLINIC_HAVE - Mexico", desc: "CLINIC_HAVE: Mexico agency match" },
  { id: "SM-07", persona: "solo-man", name: "No embryos - Own sperm - CLINIC_HAVE - Mixed USA + Colombia", desc: "Path C mixed countries" },
  { id: "SM-08", persona: "solo-man", name: "Has embryos (2, tested) - Own sperm - Has egg donor - CLINIC_HAVE - USA", desc: "Existing embryos, D-cycle USA" },
  { id: "SM-09", persona: "solo-man", name: "Has embryos (1, not tested) - CLINIC_HAVE - Colombia", desc: "Ships embryos to Colombia" },
  { id: "SM-10", persona: "solo-man", name: "Has embryos - Step 3b use existing - Intake only", desc: "Step 3b conflict: USE branch" },
  { id: "SM-11", persona: "solo-man", name: "Has embryos - Step 3b create new embryos - Intake only", desc: "Step 3b conflict: CREATE branch" },
  { id: "SM-12", persona: "solo-man", name: "No embryos - Own sperm - CLINIC_HAVE - USA - Cost education", desc: "D-cycle cost education check" },
  { id: "SM-13", persona: "solo-man", name: "LGBTQ+ - No embryos - Own sperm - CLINIC_HAVE - USA - Twins", desc: "Gay solo man - isLGBTQ saved" },
  { id: "SM-14", persona: "solo-man", name: "No embryos - Donor sperm - CLINIC_HAVE - Colombia", desc: "CLINIC_HAVE: Colombia agency" },
  // SOLO WOMAN
  { id: "SW-01", persona: "solo-woman", name: "No embryos - Own eggs - Self carry - Needs sperm donor", desc: "Simplest solo woman path" },
  { id: "SW-02", persona: "solo-woman", name: "No embryos - Own eggs - Self carry - Has sperm donor - Needs clinic", desc: "Sperm donor skipped" },
  { id: "SW-03", persona: "solo-woman", name: "No embryos - Donor eggs - Self carry - Needs egg + sperm donor", desc: "Embryo donation path" },
  { id: "SW-04", persona: "solo-woman", name: "No embryos - Donor eggs - Has egg donor - Self carry - Needs sperm donor", desc: "Egg match cycle skipped" },
  { id: "SW-05", persona: "solo-woman", name: "No embryos - Own eggs - Surrogate - All services - USA", desc: "Solo woman with surrogate" },
  { id: "SW-06", persona: "solo-woman", name: "No embryos - Own eggs - Has surrogate - Needs sperm donor", desc: "Surrogate Phase 3 skipped" },
  { id: "SW-07", persona: "solo-woman", name: "No embryos - Donor eggs - Surrogate - All three - USA - Twins", desc: "Full embryo donation + surrogate" },
  { id: "SW-08", persona: "solo-woman", name: "No embryos - Donor eggs - Surrogate - All services - Colombia", desc: "Colombia path" },
  { id: "SW-09", persona: "solo-woman", name: "Has embryos (2, tested) - Own eggs - Self carry", desc: "Past-tense questions" },
  { id: "SW-10", persona: "solo-woman", name: "Has embryos - Step 1c - Uses existing - Surrogate - USA", desc: "Step 1c: use existing embryos" },
  { id: "SW-11", persona: "solo-woman", name: "Has embryos - Step 1c - Create new embryos - Surrogate", desc: "Step 1c: fresh egg donor" },
  { id: "SW-12", persona: "solo-woman", name: "No embryos - Own eggs - Surrogate - USA - No preference", desc: "No-preference answers" },
  { id: "SW-13", persona: "solo-woman", name: "No embryos - Donor eggs - Surrogate - Mexico", desc: "Mexico path" },
  { id: "SW-14", persona: "solo-woman", name: "LGBTQ+ - No embryos - Own eggs - Self carry - Sperm donor", desc: "LGBTQ+ solo woman" },
  // TWO DADS
  { id: "TD-01", persona: "two-dads", name: "No embryos - Own sperm - Needs egg + surrogate - USA", desc: "Base two-dads path" },
  { id: "TD-02", persona: "two-dads", name: "No embryos - Partner's sperm - All services - USA - Twins", desc: "Partner's sperm option" },
  { id: "TD-03", persona: "two-dads", name: "No embryos - Donor sperm - All services - USA", desc: "Embryo donation all services" },
  { id: "TD-04", persona: "two-dads", name: "No embryos - Donor sperm - Has sperm donor - Egg + surrogate - Colombia", desc: "Sperm match skipped, Colombia" },
  { id: "TD-05", persona: "two-dads", name: "No embryos - Own sperm - Has egg donor - USA - Pro-life", desc: "Egg match skipped" },
  { id: "TD-06", persona: "two-dads", name: "No embryos - Own sperm - Needs egg donor - Has surrogate", desc: "Phase 3 D-cycle skipped" },
  { id: "TD-07", persona: "two-dads", name: "Has embryos (2, tested) - Own sperm - Needs surrogate - USA", desc: "Existing tested embryos" },
  { id: "TD-08", persona: "two-dads", name: "Has embryos (3) - Partner's sperm - Needs surrogate - Colombia", desc: "Ship embryos to Colombia" },
  { id: "TD-09", persona: "two-dads", name: "Has embryos - Registered sperm donor - Step 3b use existing", desc: "Step 3b conflict for two dads" },
  { id: "TD-10", persona: "two-dads", name: "No embryos - Partner's sperm - Egg + surrogate - Mexico", desc: "Mexico international path" },
  { id: "TD-11", persona: "two-dads", name: "No embryos - Own sperm - Mixed USA + Colombia - Twins", desc: "Path C mixed countries" },
  { id: "TD-12", persona: "two-dads", name: "No embryos - Donor sperm - All services - USA - No preference", desc: "All no-preference answers" },
  // TWO MOMS
  { id: "TM-01", persona: "two-moms", name: "No embryos - Own eggs - Partner A carries - Needs sperm + clinic", desc: "Simplest two-moms path" },
  { id: "TM-02", persona: "two-moms", name: "No embryos - Own eggs - Partner A carries - Has sperm donor", desc: "Sperm match cycle skipped" },
  { id: "TM-03", persona: "two-moms", name: "No embryos - Partner B eggs - Partner A carries (Reciprocal IVF)", desc: "Reciprocal IVF" },
  { id: "TM-04", persona: "two-moms", name: "No embryos - Donor eggs - Partner A carries - All services", desc: "Third-party egg donor" },
  { id: "TM-05", persona: "two-moms", name: "No embryos - Donor eggs - Has egg donor - Partner A carries - Sperm", desc: "Egg match skipped" },
  { id: "TM-06", persona: "two-moms", name: "No embryos - Own eggs - Partner B carries - Needs sperm + clinic", desc: "carrier = My partner" },
  { id: "TM-07", persona: "two-moms", name: "No embryos - Partner B eggs - Partner B carries - Needs sperm + clinic", desc: "Partner B provides eggs AND carries" },
  { id: "TM-08", persona: "two-moms", name: "No embryos - Own eggs - Surrogate carries - USA - Singleton", desc: "Two moms using surrogate" },
  { id: "TM-09", persona: "two-moms", name: "No embryos - Donor eggs - Surrogate carries - All services - USA - Twins", desc: "All-donor + surrogate" },
  { id: "TM-10", persona: "two-moms", name: "No embryos - Partner B eggs - Surrogate carries - Colombia", desc: "Reciprocal IVF + Colombia" },
  { id: "TM-11", persona: "two-moms", name: "Has embryos (2, tested) - Own eggs - Partner B carries", desc: "Existing embryos, partner carries" },
  { id: "TM-12", persona: "two-moms", name: "Has embryos - Step 1c - Uses existing - Surrogate - USA", desc: "Step 1c for two moms" },
  { id: "TM-13", persona: "two-moms", name: "No embryos - Donor eggs - Surrogate carries - Has surrogate - All", desc: "Phase 3 D-cycle skipped" },
  // MAN & WOMAN
  { id: "MW-01", persona: "man-woman", name: "No embryos - Her eggs - His sperm - She carries - Needs clinic (W)", desc: "Simplest MW path" },
  { id: "MW-02", persona: "man-woman", name: "No embryos - Her eggs - His sperm - She carries - Needs clinic (M)", desc: "Man speaking" },
  { id: "MW-03", persona: "man-woman", name: "No embryos - Donor eggs - His sperm - She carries - Needs egg + clinic (W)", desc: "Donor eggs self-carry" },
  { id: "MW-04", persona: "man-woman", name: "No embryos - Donor eggs - His sperm - She carries - Has egg donor (M)", desc: "Egg match skipped" },
  { id: "MW-05", persona: "man-woman", name: "No embryos - Her eggs - Donor sperm - She carries - Needs sperm (W)", desc: "Donor sperm path" },
  { id: "MW-06", persona: "man-woman", name: "No embryos - Her eggs - Donor sperm - Has sperm donor - Has clinic (M)", desc: "No match cycles at all" },
  { id: "MW-07", persona: "man-woman", name: "No embryos - Donor eggs - Donor sperm - She carries - All services (W)", desc: "Full embryo donation self-carry" },
  { id: "MW-08", persona: "man-woman", name: "No embryos - Her eggs - His sperm - Surrogate - USA - Pro-choice (W)", desc: "Own genetics with surrogate" },
  { id: "MW-09", persona: "man-woman", name: "No embryos - Her eggs - His sperm - Surrogate - USA - Twins (M)", desc: "Surrogate + twins, man speaking" },
  { id: "MW-10", persona: "man-woman", name: "No embryos - Donor eggs - His sperm - Surrogate - Needs all (W)", desc: "Donor eggs with surrogate" },
  { id: "MW-11", persona: "man-woman", name: "No embryos - Her eggs - Donor sperm - Has surrogate - Needs sperm (W)", desc: "Phase 3 D-cycle skipped" },
  { id: "MW-12", persona: "man-woman", name: "No embryos - Donor eggs - Donor sperm - Surrogate - All services (M)", desc: "All-donor + surrogate pro-life" },
  { id: "MW-13", persona: "man-woman", name: "No embryos - Donor eggs - Donor sperm - Surrogate - Colombia (W)", desc: "Colombia international path" },
  { id: "MW-14", persona: "man-woman", name: "Has embryos (2, tested) - Her eggs - His sperm - She carries (W)", desc: "Existing embryos, clinic only" },
  { id: "MW-15", persona: "man-woman", name: "Has embryos (4, tested) - Her eggs - His sperm - Surrogate (M)", desc: "Existing embryos with surrogate" },
  { id: "MW-16", persona: "man-woman", name: "Has embryos - Step 1c - Use existing - She carries (W)", desc: "Step 1c: uses existing embryos" },
  { id: "MW-17", persona: "man-woman", name: "Has embryos - Step 1c - Create new - Surrogate - USA (W)", desc: "Step 1c: fresh donor + surrogate" },
  { id: "MW-18", persona: "man-woman", name: "Has embryos - Step 3b - Use existing - She carries (W)", desc: "Step 3b: use existing embryos" },
  { id: "MW-19", persona: "man-woman", name: "No embryos - Donor eggs - His sperm - Surrogate - Mexico (M)", desc: "Mexico path, man speaking" },
];

// ─── Persona display config ───────────────────────────────────────────────────

const PERSONAS = [
  { id: "all",        label: "All",          count: 72 },
  { id: "solo-man",   label: "Solo Man",     count: 14 },
  { id: "solo-woman", label: "Solo Woman",   count: 14 },
  { id: "two-dads",   label: "Two Dads",     count: 12 },
  { id: "two-moms",   label: "Two Moms",     count: 13 },
  { id: "man-woman",  label: "Man & Woman",  count: 19 },
];

// ─── Status helpers ───────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: TestStatus }) {
  if (status === "pending") return <span className="text-lg" title="Pending">--</span>;
  if (status === "running") return (
    <span className="inline-block animate-spin text-lg" title="Running" style={{ color: "hsl(var(--primary))" }}>
      &#x21BB;
    </span>
  );
  if (status === "pass") return <span className="text-lg" title="Pass" style={{ color: "hsl(var(--brand-success))" }}>✓</span>;
  if (status === "fail") return <span className="text-lg" title="Fail" style={{ color: "hsl(var(--brand-error))" }}>✗</span>;
  if (status === "skipped") return <span className="text-lg" title="Skipped" style={{ color: "hsl(var(--muted-foreground))" }}>-</span>;
  return null;
}

function statusColor(status: TestStatus): string {
  switch (status) {
    case "pass":    return "hsl(var(--brand-success))";
    case "fail":    return "hsl(var(--brand-error))";
    case "running": return "hsl(var(--primary))";
    default:        return "hsl(var(--muted-foreground))";
  }
}

function statusBg(status: TestStatus): string {
  switch (status) {
    case "pass":    return "hsl(var(--brand-success) / 0.08)";
    case "fail":    return "hsl(var(--brand-error) / 0.08)";
    case "running": return "hsl(var(--primary) / 0.06)";
    default:        return "hsl(var(--muted))";
  }
}

function personaLabel(persona: string): string {
  return PERSONAS.find(p => p.id === persona)?.label ?? persona;
}

// ─── Connection dot ───────────────────────────────────────────────────────────

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full"
      style={{ background: connected ? "hsl(var(--brand-success))" : "hsl(var(--brand-error))" }}
      title={connected ? "SSE connected" : "SSE disconnected"}
    />
  );
}

// ─── Test card ────────────────────────────────────────────────────────────────

interface TestCardProps {
  meta: TestMeta;
  progress?: TestProgress;
  expanded: boolean;
  onToggle: () => void;
}

function TestCard({ meta, progress, expanded, onToggle }: TestCardProps) {
  const status = progress?.status ?? "pending";
  const pct = progress && progress.totalMessages > 0
    ? Math.round((progress.currentMessage / progress.totalMessages) * 100)
    : 0;

  return (
    <div
      style={{
        background: statusBg(status),
        border: `1px solid ${statusColor(status)}33`,
        borderRadius: "var(--radius)",
        overflow: "hidden",
        transition: "box-shadow 0.15s",
      }}
    >
      {/* Card header - clickable */}
      <button
        className="w-full text-left px-3 py-2.5"
        onClick={onToggle}
        style={{ background: "transparent", cursor: "pointer" }}
      >
        <div className="flex items-start gap-2">
          <div className="flex-shrink-0 mt-0.5">
            <StatusIcon status={status} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="font-mono text-xs font-bold px-1.5 py-0.5 rounded"
                style={{
                  background: statusColor(status) + "22",
                  color: statusColor(status),
                }}
              >
                {meta.id}
              </span>
              <span
                className="text-xs px-1.5 py-0.5 rounded"
                style={{
                  background: "hsl(var(--muted))",
                  color: "hsl(var(--muted-foreground))",
                }}
              >
                {personaLabel(meta.persona)}
              </span>
              {progress?.errors && progress.errors.length > 0 && (
                <span
                  className="text-xs font-bold px-1.5 py-0.5 rounded"
                  style={{
                    background: "hsl(var(--brand-error) / 0.15)",
                    color: "hsl(var(--brand-error))",
                  }}
                >
                  {progress.errors.length} error{progress.errors.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>
            <div
              className="text-xs mt-1 font-medium truncate"
              style={{ color: "hsl(var(--foreground))" }}
              title={meta.name}
            >
              {meta.name}
            </div>
          </div>
          <div className="flex-shrink-0 text-right">
            {progress?.durationMs && progress.durationMs > 0 && (
              <div
                className="text-xs"
                style={{ color: "hsl(var(--muted-foreground))" }}
              >
                {(progress.durationMs / 1000).toFixed(1)}s
              </div>
            )}
          </div>
        </div>

        {/* Progress bar - only when running */}
        {status === "running" && (
          <div className="mt-2 px-0.5">
            <Progress value={pct} className="h-1" />
            <div
              className="text-xs mt-1"
              style={{ color: "hsl(var(--muted-foreground))" }}
            >
              msg {progress?.currentMessage ?? 0} / {progress?.totalMessages ?? "?"} ({pct}%)
            </div>
          </div>
        )}
      </button>

      {/* Expandable detail */}
      {expanded && (
        <div
          className="px-3 pb-3 border-t text-xs space-y-2"
          style={{ borderColor: statusColor(status) + "22" }}
        >
          <div className="pt-2" style={{ color: "hsl(var(--muted-foreground))" }}>
            {meta.desc}
          </div>

          {progress?.lastUserMsg && (
            <div>
              <span style={{ color: "hsl(var(--muted-foreground))" }}>Last sent: </span>
              <span className="font-medium" style={{ color: "hsl(var(--foreground))" }}>
                "{progress.lastUserMsg}"
              </span>
            </div>
          )}

          {progress?.lastAiSnippet && (
            <div>
              <span style={{ color: "hsl(var(--muted-foreground))" }}>AI response: </span>
              <span style={{ color: "hsl(var(--foreground))" }}>
                {progress.lastAiSnippet}...
              </span>
            </div>
          )}

          {progress?.errors && progress.errors.length > 0 && (
            <div className="space-y-1">
              <div className="font-semibold" style={{ color: "hsl(var(--brand-error))" }}>Errors:</div>
              {progress.errors.map((err, i) => (
                <div
                  key={i}
                  className="pl-2 border-l-2 py-0.5"
                  style={{
                    borderColor: "hsl(var(--brand-error))",
                    color: "hsl(var(--brand-error))",
                    wordBreak: "break-word",
                  }}
                >
                  {err}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AdminTestRunnerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activePersona = searchParams.get("persona") ?? "all";

  const [state, setState] = useState<RunnerState | null>(null);
  const [connected, setConnected] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── SSE connection ─────────────────────────────────────────────────────────

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
    }

    const es = new EventSource("/api/admin/test-runner/stream", { withCredentials: true });
    esRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data);
        if (event.type === "state") {
          setState(event.state as RunnerState);
        } else if (event.type === "test_start") {
          setState(prev => {
            if (!prev) return prev;
            const tests = { ...prev.tests };
            if (tests[event.id]) {
              tests[event.id] = { ...tests[event.id], status: "running" };
            }
            return { ...prev, tests };
          });
        } else if (event.type === "test_progress") {
          setState(prev => {
            if (!prev) return prev;
            const tests = { ...prev.tests };
            if (tests[event.id]) {
              tests[event.id] = {
                ...tests[event.id],
                currentMessage: event.currentMessage as number,
                lastUserMsg: event.lastUserMsg as string,
                lastAiSnippet: event.lastAiSnippet as string,
              };
            }
            return { ...prev, tests };
          });
        } else if (event.type === "test_done") {
          setState(prev => {
            if (!prev) return prev;
            const tests = { ...prev.tests };
            if (tests[event.id]) {
              tests[event.id] = {
                ...tests[event.id],
                status: event.status as TestStatus,
                durationMs: event.durationMs as number,
                errors: (event.errors as string[]) ?? [],
              };
            }
            return { ...prev, tests };
          });
        } else if (event.type === "run_done") {
          setState(prev => prev ? { ...prev, status: "done" } : prev);
        }
      } catch {}
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;
      reconnectTimer.current = setTimeout(connect, 3000);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (esRef.current) esRef.current.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect]);

  // ─── Actions ────────────────────────────────────────────────────────────────

  const startRun = async (filter?: string) => {
    await fetch("/api/admin/test-runner/run", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter }),
    });
  };

  const stopRun = async () => {
    await fetch("/api/admin/test-runner/stop", {
      method: "POST",
      credentials: "include",
    });
  };

  const clearResults = async () => {
    await fetch("/api/admin/test-runner/results", {
      method: "DELETE",
      credentials: "include",
    });
  };

  // ─── Derived stats ──────────────────────────────────────────────────────────

  const allProgress = state ? Object.values(state.tests) : [];
  const total   = allProgress.length;
  const passing = allProgress.filter(t => t.status === "pass").length;
  const failing = allProgress.filter(t => t.status === "fail").length;
  const running = allProgress.filter(t => t.status === "running").length;
  const pending = allProgress.filter(t => t.status === "pending").length;
  const done    = passing + failing + allProgress.filter(t => t.status === "skipped").length;
  const overallPct = total > 0 ? Math.round((done / total) * 100) : 0;

  const isRunning = state?.status === "running";

  // ─── Filtered cards ─────────────────────────────────────────────────────────

  const visibleMeta = activePersona === "all"
    ? TEST_META
    : TEST_META.filter(m => m.persona === activePersona);

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setPersona = (persona: string) => {
    setSearchParams({ persona }, { replace: true });
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold" style={{ fontFamily: "var(--font-heading)", color: "hsl(var(--foreground))" }}>
            AI Concierge Test Runner
          </h1>
          <ConnectionDot connected={connected} />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {!isRunning && (
            <>
              <Button
                onClick={() => startRun(activePersona === "all" ? undefined : activePersona)}
                style={{
                  background: "hsl(var(--brand-success))",
                  color: "white",
                  borderRadius: "var(--radius)",
                }}
                className="font-semibold"
              >
                {activePersona === "all"
                  ? "Run All (72)"
                  : `Run ${personaLabel(activePersona)} (${PERSONAS.find(p => p.id === activePersona)?.count ?? "?"})`
                }
              </Button>
              {total > 0 && (
                <Button
                  variant="ghost"
                  onClick={clearResults}
                  style={{ borderRadius: "var(--radius)" }}
                >
                  Clear
                </Button>
              )}
            </>
          )}
          {isRunning && (
            <Button
              onClick={stopRun}
              style={{
                background: "hsl(var(--brand-error))",
                color: "white",
                borderRadius: "var(--radius)",
              }}
              className="font-semibold"
            >
              Stop
            </Button>
          )}
        </div>
      </div>

      {/* Stats bar */}
      {total > 0 && (
        <div
          className="rounded-lg p-4 space-y-3"
          style={{
            background: "hsl(var(--muted))",
            borderRadius: "var(--radius)",
          }}
        >
          <div className="flex flex-wrap gap-4 text-sm font-medium">
            <span style={{ color: "hsl(var(--muted-foreground))" }}>
              Total: <strong style={{ color: "hsl(var(--foreground))" }}>{total}</strong>
            </span>
            <span style={{ color: "hsl(var(--brand-success))" }}>
              Passing: <strong>{passing}</strong>
            </span>
            <span style={{ color: "hsl(var(--brand-error))" }}>
              Failing: <strong>{failing}</strong>
            </span>
            <span style={{ color: "hsl(var(--primary))" }}>
              Running: <strong>{running}</strong>
            </span>
            <span style={{ color: "hsl(var(--muted-foreground))" }}>
              Pending: <strong>{pending}</strong>
            </span>
            {total > 0 && done > 0 && (
              <span style={{ color: "hsl(var(--foreground))" }}>
                Pass rate: <strong>{total > 0 && done === total ? `${Math.round((passing / total) * 100)}%` : `${Math.round((passing / done) * 100)}% of done`}</strong>
              </span>
            )}
          </div>
          <div className="relative">
            <Progress value={overallPct} className="h-2" />
          </div>
        </div>
      )}

      {/* Persona filter tabs */}
      <div
        className="flex gap-1 flex-wrap border-b"
        style={{ borderColor: "hsl(var(--border))" }}
      >
        {PERSONAS.map(p => (
          <button
            key={p.id}
            onClick={() => setPersona(p.id)}
            className="px-3 py-2 text-sm font-medium transition-colors relative"
            style={{
              color: activePersona === p.id
                ? "hsl(var(--primary))"
                : "hsl(var(--muted-foreground))",
              borderBottom: activePersona === p.id
                ? "2px solid hsl(var(--primary))"
                : "2px solid transparent",
              background: "transparent",
              marginBottom: "-1px",
            }}
          >
            {p.label}
            {state && (
              <span
                className="ml-1.5 text-xs"
                style={{ color: "hsl(var(--muted-foreground))" }}
              >
                ({p.id === "all"
                  ? allProgress.length
                  : allProgress.filter(t => {
                      const meta = TEST_META.find(m => m.id === t.id);
                      return meta?.persona === p.id;
                    }).length
                })
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Empty state */}
      {!state || total === 0 ? (
        <div
          className="text-center py-16 rounded-lg"
          style={{
            background: "hsl(var(--muted))",
            color: "hsl(var(--muted-foreground))",
            borderRadius: "var(--radius)",
          }}
        >
          <div className="text-4xl mb-3">&#x25B6;</div>
          <div className="text-lg font-medium">No tests running yet</div>
          <div className="text-sm mt-1">Click "Run All" to start the test suite</div>
        </div>
      ) : (
        /* Test grid */
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
          }}
        >
          {visibleMeta.map(meta => {
            const progress = state?.tests[meta.id];
            return (
              <TestCard
                key={meta.id}
                meta={meta}
                progress={progress}
                expanded={expandedIds.has(meta.id)}
                onToggle={() => toggleExpanded(meta.id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
