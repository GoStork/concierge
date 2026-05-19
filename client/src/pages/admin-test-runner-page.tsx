import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { FlaskConical, Play, Square, Trash2, ExternalLink, ChevronDown, ChevronUp } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type TestStatus = "pending" | "running" | "pass" | "fail";

interface TestProgress {
  id: string;
  persona: string;
  name: string;
  status: TestStatus;
  currentMessage: number;
  totalMessages: number;
  errors: string[];
  durationMs: number;
  lastUserMsg?: string;
  lastAiSnippet?: string;
  currentStatus?: string;
}

interface RunnerState {
  runId: string;
  startedAt: string;
  endedAt?: string;
  status: "idle" | "running" | "done";
  filter?: string;
  tests: Record<string, TestProgress>;
  passCount: number;
  failCount: number;
  totalCount: number;
  log: string[];
  reportPath?: string;
}

// ─── Test metadata (for showing all 72 tests even before a run) ───────────────

const ALL_TESTS = [
  // SOLO MAN
  { id: "SM-01", persona: "solo-man", name: "No embryos · Own sperm · All services · Intake only", messageCount: 7 },
  { id: "SM-02", persona: "solo-man", name: "No embryos · Own sperm · Has egg donor · CLINIC_HAVE · USA", messageCount: 14 },
  { id: "SM-03", persona: "solo-man", name: "No embryos · Own sperm · Has surrogate · CLINIC_HAVE", messageCount: 6 },
  { id: "SM-04", persona: "solo-man", name: "No embryos · Donor sperm · All services · Intake only", messageCount: 8 },
  { id: "SM-05", persona: "solo-man", name: "No embryos · Donor sperm · Has sperm donor · Colombia", messageCount: 8 },
  { id: "SM-06", persona: "solo-man", name: "No embryos · Donor sperm · CLINIC_HAVE · Mexico", messageCount: 9 },
  { id: "SM-07", persona: "solo-man", name: "No embryos · Own sperm · Mixed USA+Colombia · Twins", messageCount: 10 },
  { id: "SM-08", persona: "solo-man", name: "Has embryos (2, tested) · Own sperm · Has egg donor · USA", messageCount: 17 },
  { id: "SM-09", persona: "solo-man", name: "Has embryos (1, not tested) · CLINIC_HAVE · Colombia", messageCount: 10 },
  { id: "SM-10", persona: "solo-man", name: "Has embryos · Step 3b → Use existing · Intake only", messageCount: 6 },
  { id: "SM-11", persona: "solo-man", name: "Has embryos · Step 3b → Create new embryos · Intake only", messageCount: 7 },
  { id: "SM-12", persona: "solo-man", name: "No embryos · Own sperm · CLINIC_HAVE · USA · Cost education", messageCount: 9 },
  { id: "SM-13", persona: "solo-man", name: "LGBTQ+ · No embryos · Own sperm · CLINIC_HAVE · USA · Twins", messageCount: 12 },
  { id: "SM-14", persona: "solo-man", name: "No embryos · Donor sperm · CLINIC_HAVE · Colombia", messageCount: 9 },
  // SOLO WOMAN
  { id: "SW-01", persona: "solo-woman", name: "No embryos · Own eggs · Self carry · Needs sperm donor", messageCount: 10 },
  { id: "SW-02", persona: "solo-woman", name: "No embryos · Own eggs · Self carry · Has sperm donor · Clinic", messageCount: 11 },
  { id: "SW-03", persona: "solo-woman", name: "No embryos · Donor eggs · Self carry · Needs egg+sperm donor", messageCount: 13 },
  { id: "SW-04", persona: "solo-woman", name: "No embryos · Donor eggs · Has egg donor · Self carry · Sperm", messageCount: 12 },
  { id: "SW-05", persona: "solo-woman", name: "No embryos · Own eggs · Surrogate · All services · USA", messageCount: 14 },
  { id: "SW-06", persona: "solo-woman", name: "No embryos · Own eggs · Has surrogate · Needs sperm donor", messageCount: 12 },
  { id: "SW-07", persona: "solo-woman", name: "No embryos · Donor eggs · Surrogate · All three · USA · Twins", messageCount: 14 },
  { id: "SW-08", persona: "solo-woman", name: "No embryos · Donor eggs · Surrogate · All services · Colombia", messageCount: 12 },
  { id: "SW-09", persona: "solo-woman", name: "Has embryos (2, tested) · Own eggs · Self carry", messageCount: 9 },
  { id: "SW-10", persona: "solo-woman", name: "Has embryos · Step 1c → Uses existing · Surrogate · USA", messageCount: 10 },
  { id: "SW-11", persona: "solo-woman", name: "Has embryos · Step 1c → Create new embryos · Surrogate", messageCount: 13 },
  { id: "SW-12", persona: "solo-woman", name: "No embryos · Own eggs · Surrogate · USA · No preference", messageCount: 8 },
  { id: "SW-13", persona: "solo-woman", name: "No embryos · Donor eggs · Surrogate · Mexico", messageCount: 11 },
  { id: "SW-14", persona: "solo-woman", name: "LGBTQ+ · No embryos · Own eggs · Self carry · Sperm donor", messageCount: 12 },
  // TWO DADS
  { id: "TD-01", persona: "two-dads", name: "No embryos · Own sperm · Needs egg+surrogate · Has clinic · USA", messageCount: 13 },
  { id: "TD-02", persona: "two-dads", name: "No embryos · Partner sperm · All services · USA · Twins", messageCount: 13 },
  { id: "TD-03", persona: "two-dads", name: "No embryos · Donor sperm · All services · USA", messageCount: 14 },
  { id: "TD-04", persona: "two-dads", name: "No embryos · Has sperm donor · Egg+surrogate · Colombia", messageCount: 10 },
  { id: "TD-05", persona: "two-dads", name: "No embryos · Own sperm · Has egg donor · USA · Pro-life", messageCount: 9 },
  { id: "TD-06", persona: "two-dads", name: "No embryos · Own sperm · Needs egg donor · Has surrogate", messageCount: 11 },
  { id: "TD-07", persona: "two-dads", name: "Has embryos (2, tested) · Own sperm · Surrogate · USA", messageCount: 10 },
  { id: "TD-08", persona: "two-dads", name: "Has embryos (3) · Partner sperm · Surrogate · Colombia", messageCount: 9 },
  { id: "TD-09", persona: "two-dads", name: "Has embryos · Registered sperm donor · Step 3b → Use existing", messageCount: 8 },
  { id: "TD-10", persona: "two-dads", name: "No embryos · Partner sperm · Egg+surrogate · Mexico", messageCount: 9 },
  { id: "TD-11", persona: "two-dads", name: "No embryos · Own sperm · Mixed USA+Colombia · Twins", messageCount: 9 },
  { id: "TD-12", persona: "two-dads", name: "No embryos · Donor sperm · All services · USA · No preference", messageCount: 13 },
  // TWO MOMS
  { id: "TM-01", persona: "two-moms", name: "No embryos · Partner A eggs · Partner A carries · Sperm donor · Clinic", messageCount: 12 },
  { id: "TM-02", persona: "two-moms", name: "No embryos · Partner A eggs · Self carry · Has sperm donor · Clinic", messageCount: 10 },
  { id: "TM-03", persona: "two-moms", name: "No embryos · Reciprocal IVF (Partner B eggs) · Sperm donor", messageCount: 12 },
  { id: "TM-04", persona: "two-moms", name: "No embryos · Donor eggs · Self carry · Egg+sperm donor · Clinic", messageCount: 13 },
  { id: "TM-05", persona: "two-moms", name: "No embryos · Has egg donor · Self carry · Sperm donor", messageCount: 10 },
  { id: "TM-06", persona: "two-moms", name: "No embryos · Partner A eggs · Partner B carries · Sperm donor", messageCount: 12 },
  { id: "TM-07", persona: "two-moms", name: "No embryos · Partner B eggs · Partner B carries · Sperm donor", messageCount: 12 },
  { id: "TM-08", persona: "two-moms", name: "No embryos · Own eggs · Surrogate · Sperm donor · USA", messageCount: 13 },
  { id: "TM-09", persona: "two-moms", name: "No embryos · Donor eggs · Surrogate · All services · USA · Twins", messageCount: 13 },
  { id: "TM-10", persona: "two-moms", name: "No embryos · Partner B eggs · Surrogate · Colombia · Sperm donor", messageCount: 11 },
  { id: "TM-11", persona: "two-moms", name: "Has embryos (2, tested) · Partner A eggs · Partner B carries", messageCount: 9 },
  { id: "TM-12", persona: "two-moms", name: "Has embryos · Step 1c → Uses existing · Surrogate · USA", messageCount: 9 },
  { id: "TM-13", persona: "two-moms", name: "No embryos · Donor eggs · Has surrogate · Sperm donor · Clinic", messageCount: 13 },
  // MAN & WOMAN
  { id: "MW-01", persona: "man-woman", name: "No embryos · Her eggs · His sperm · She carries · Clinic (Woman)", messageCount: 9 },
  { id: "MW-02", persona: "man-woman", name: "No embryos · Her eggs · His sperm · She carries · Clinic (Man)", messageCount: 9 },
  { id: "MW-03", persona: "man-woman", name: "No embryos · Donor eggs · His sperm · She carries · Egg+clinic (Woman)", messageCount: 12 },
  { id: "MW-04", persona: "man-woman", name: "No embryos · Has egg donor · His sperm · She carries · Clinic (Man)", messageCount: 10 },
  { id: "MW-05", persona: "man-woman", name: "No embryos · Her eggs · Donor sperm · She carries · Sperm+clinic", messageCount: 12 },
  { id: "MW-06", persona: "man-woman", name: "No embryos · Her eggs · Has sperm donor · Has clinic (Man)", messageCount: 8 },
  { id: "MW-07", persona: "man-woman", name: "No embryos · Donor eggs · Donor sperm · She carries · All", messageCount: 13 },
  { id: "MW-08", persona: "man-woman", name: "No embryos · Her eggs · His sperm · Surrogate · USA (Woman)", messageCount: 12 },
  { id: "MW-09", persona: "man-woman", name: "No embryos · Her eggs · His sperm · Surrogate · USA · Twins (Man)", messageCount: 8 },
  { id: "MW-10", persona: "man-woman", name: "No embryos · Donor eggs · His sperm · Surrogate · USA (Woman)", messageCount: 13 },
  { id: "MW-11", persona: "man-woman", name: "No embryos · Her eggs · Donor sperm · Has surrogate · Clinic", messageCount: 12 },
  { id: "MW-12", persona: "man-woman", name: "No embryos · All donor · Surrogate · USA · Pro-life (Man)", messageCount: 14 },
  { id: "MW-13", persona: "man-woman", name: "No embryos · All donor · Surrogate · Colombia (Woman)", messageCount: 12 },
  { id: "MW-14", persona: "man-woman", name: "Has embryos (2, tested) · Her eggs · His sperm · She carries", messageCount: 11 },
  { id: "MW-15", persona: "man-woman", name: "Has embryos (4, tested) · Surrogate · USA · Pro-choice (Man)", messageCount: 10 },
  { id: "MW-16", persona: "man-woman", name: "Has embryos · Step 1c → Use existing · She carries (Woman)", messageCount: 10 },
  { id: "MW-17", persona: "man-woman", name: "Has embryos · Step 1c → New embryos · Surrogate · USA", messageCount: 14 },
  { id: "MW-18", persona: "man-woman", name: "Has embryos · Step 3b → Use existing · She carries", messageCount: 9 },
  { id: "MW-19", persona: "man-woman", name: "No embryos · Donor eggs · His sperm · Surrogate · Mexico (Man)", messageCount: 13 },
];

const PERSONAS = [
  { id: "all", label: "All (72)" },
  { id: "solo-man", label: "Solo Man (14)" },
  { id: "solo-woman", label: "Solo Woman (14)" },
  { id: "two-dads", label: "Two Dads (12)" },
  { id: "two-moms", label: "Two Moms (13)" },
  { id: "man-woman", label: "Man & Woman (19)" },
];

// ─── Status helpers ───────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: TestStatus }) {
  if (status === "pass") return <span style={{ color: "hsl(var(--brand-success))" }}>✅</span>;
  if (status === "fail") return <span style={{ color: "hsl(var(--brand-error))" }}>❌</span>;
  if (status === "running") return (
    <span style={{ display: "inline-block", animation: "spin 1s linear infinite", color: "hsl(var(--primary))" }}>⟳</span>
  );
  return <span style={{ color: "hsl(var(--muted-foreground))" }}>○</span>;
}

function statusBg(status: TestStatus): string {
  if (status === "pass") return "hsl(var(--brand-success) / 0.08)";
  if (status === "fail") return "hsl(var(--brand-error) / 0.08)";
  if (status === "running") return "hsl(var(--primary) / 0.06)";
  return "hsl(var(--muted) / 0.3)";
}

function statusBorder(status: TestStatus): string {
  if (status === "pass") return "hsl(var(--brand-success) / 0.3)";
  if (status === "fail") return "hsl(var(--brand-error) / 0.3)";
  if (status === "running") return "hsl(var(--primary) / 0.3)";
  return "hsl(var(--border))";
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminTestRunnerPage() {
  const [params, setParams] = useSearchParams();
  const persona = params.get("persona") || "all";
  const [state, setState] = useState<RunnerState>({
    runId: "", startedAt: "", status: "idle",
    tests: {}, passCount: 0, failCount: 0, totalCount: 0, log: [],
  });
  const [connected, setConnected] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  // SSE connection
  const connect = useCallback(() => {
    if (esRef.current) esRef.current.close();
    const es = new EventSource("/api/admin/test-runner/stream", { withCredentials: true });
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      setTimeout(connect, 3000);
    };

    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === "state") {
          setState(ev.state);
        } else if (ev.type === "log") {
          setState(prev => ({ ...prev, log: [...prev.log.slice(-499), ev.line] }));
          // Auto-scroll log
          setTimeout(() => {
            if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
          }, 50);
        } else if (ev.type === "test_start") {
          setState(prev => ({
            ...prev,
            tests: {
              ...prev.tests,
              [ev.id]: { ...prev.tests[ev.id], status: "running" },
            },
          }));
        } else if (ev.type === "test_done") {
          setState(prev => ({
            ...prev,
            tests: {
              ...prev.tests,
              [ev.id]: { ...prev.tests[ev.id], status: ev.status, durationMs: ev.durationMs, errors: ev.errors },
            },
            passCount: ev.status === "pass" ? prev.passCount + 1 : prev.passCount,
            failCount: ev.status === "fail" ? prev.failCount + 1 : prev.failCount,
          }));
        } else if (ev.type === "test_error") {
          setState(prev => ({
            ...prev,
            tests: {
              ...prev.tests,
              [ev.id]: {
                ...prev.tests[ev.id],
                errors: [...(prev.tests[ev.id]?.errors || []), ev.error],
              },
            },
          }));
        } else if (ev.type === "run_done" || ev.type === "run_stopped") {
          setState(prev => ({ ...prev, status: "done" }));
        } else if (ev.type === "report_ready") {
          setState(prev => ({ ...prev, reportPath: ev.path }));
        }
      } catch {}
    };
  }, []);

  useEffect(() => { connect(); return () => esRef.current?.close(); }, [connect]);

  // Run control
  const startRun = async (filter?: string) => {
    await fetch("/api/admin/test-runner/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ filter }),
    });
  };

  const stopRun = async () => {
    await fetch("/api/admin/test-runner/stop", { method: "POST", credentials: "include" });
  };

  const clearResults = async () => {
    await fetch("/api/admin/test-runner/results", { method: "DELETE", credentials: "include" });
  };

  // Derived display
  const isRunning = state.status === "running";
  const visibleTests = persona === "all" ? ALL_TESTS : ALL_TESTS.filter(t => t.persona === persona);

  const passed = state.passCount;
  const failed = state.failCount;
  const total = state.totalCount || ALL_TESTS.length;
  const done = passed + failed;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  const getTestState = (id: string): TestProgress | null => state.tests[id] || null;

  return (
    <div style={{ padding: "24px", maxWidth: "1400px", margin: "0 auto" }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .test-card { transition: border-color 0.2s, background 0.2s; cursor: pointer; }
        .test-card:hover { border-color: hsl(var(--primary) / 0.4) !important; }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <FlaskConical style={{ color: "hsl(var(--primary))", width: "24px", height: "24px" }} />
          <div>
            <h1 style={{ fontSize: "20px", fontWeight: "700", fontFamily: "var(--font-heading)", margin: 0 }}>AI Concierge Test Runner</h1>
            <p style={{ fontSize: "12px", color: "hsl(var(--muted-foreground))", margin: "2px 0 0" }}>72 tests · 5 personas · runs scripts/test-ai-concierge.ts</p>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {/* Connection status */}
          <div style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "11px", color: "hsl(var(--muted-foreground))" }}>
            <div style={{ width: "7px", height: "7px", borderRadius: "50%", background: connected ? "hsl(var(--brand-success))" : "hsl(var(--brand-error))" }} />
            {connected ? "Live" : "Reconnecting..."}
          </div>

          {state.reportPath && (
            <Button variant="outline" size="sm" onClick={() => window.open(`/api/admin/test-runner/report`, "_blank")}
              style={{ fontSize: "12px" }}>
              <ExternalLink style={{ width: "12px", height: "12px", marginRight: "4px" }} />
              HTML Report
            </Button>
          )}

          <Button variant="outline" size="sm" onClick={() => setShowLog(v => !v)} style={{ fontSize: "12px" }}>
            {showLog ? "Hide Log" : "Live Log"}
          </Button>

          {!isRunning ? (
            <>
              <Button onClick={() => startRun(persona !== "all" ? persona : undefined)}
                style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)", fontSize: "13px" }}>
                <Play style={{ width: "13px", height: "13px", marginRight: "5px" }} />
                {persona !== "all" ? `Run ${PERSONAS.find(p => p.id === persona)?.label.split(" ")[0]} ${PERSONAS.find(p => p.id === persona)?.label.split(" ")[1]}` : "Run All (72)"}
              </Button>
              <Button variant="outline" size="sm" onClick={clearResults}
                disabled={state.status === "idle" && Object.keys(state.tests).length === 0}
                style={{ fontSize: "12px" }}>
                <Trash2 style={{ width: "12px", height: "12px" }} />
              </Button>
            </>
          ) : (
            <Button onClick={stopRun}
              style={{ background: "hsl(var(--brand-error))", color: "#fff", borderRadius: "var(--radius)", fontSize: "13px" }}>
              <Square style={{ width: "13px", height: "13px", marginRight: "5px" }} />
              Stop
            </Button>
          )}
        </div>
      </div>

      {/* Stats bar */}
      {(state.status !== "idle" || Object.keys(state.tests).length > 0) && (
        <div style={{ marginBottom: "20px" }}>
          <div style={{ display: "flex", gap: "12px", marginBottom: "10px", flexWrap: "wrap" }}>
            {[
              { label: "Pass", val: passed, color: "hsl(var(--brand-success))" },
              { label: "Fail", val: failed, color: "hsl(var(--brand-error))" },
              { label: "Running", val: Object.values(state.tests).filter(t => t.status === "running").length, color: "hsl(var(--primary))" },
              { label: "Pending", val: Object.values(state.tests).filter(t => t.status === "pending").length, color: "hsl(var(--muted-foreground))" },
              { label: "Total", val: total, color: "hsl(var(--foreground))" },
            ].map(s => (
              <div key={s.label} style={{ textAlign: "center", minWidth: "70px" }}>
                <div style={{ fontSize: "22px", fontWeight: "700", color: s.color }}>{s.val}</div>
                <div style={{ fontSize: "11px", color: "hsl(var(--muted-foreground))" }}>{s.label}</div>
              </div>
            ))}
            {state.status !== "idle" && (
              <div style={{ flex: 1, minWidth: "200px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                <div style={{ height: "8px", background: "hsl(var(--muted))", borderRadius: "4px", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${progress}%`, background: failed > 0 ? "hsl(var(--brand-error))" : "hsl(var(--brand-success))", borderRadius: "4px", transition: "width 0.3s" }} />
                </div>
                <div style={{ fontSize: "11px", color: "hsl(var(--muted-foreground))", marginTop: "3px" }}>
                  {progress}% · {done}/{total} complete {isRunning ? "· running..." : state.status === "done" ? "· done" : ""}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Live Log */}
      {showLog && (
        <div style={{ marginBottom: "20px", border: "1px solid hsl(var(--border))", borderRadius: "8px", overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", background: "hsl(var(--muted) / 0.5)", borderBottom: "1px solid hsl(var(--border))", fontSize: "11px", fontWeight: "600", color: "hsl(var(--muted-foreground))" }}>
            LIVE CLI OUTPUT
          </div>
          <div ref={logRef} style={{ height: "200px", overflow: "auto", padding: "8px 12px", fontFamily: "monospace", fontSize: "11px", background: "hsl(var(--background))", lineHeight: "1.6" }}>
            {state.log.length === 0 ? (
              <span style={{ color: "hsl(var(--muted-foreground))" }}>No output yet. Click Run to start tests.</span>
            ) : (
              state.log.map((line, i) => (
                <div key={i} style={{
                  color: line.includes("PASS") || line.includes("✅") ? "hsl(var(--brand-success))"
                    : line.includes("FAIL") || line.includes("❌") ? "hsl(var(--brand-error))"
                    : line.includes("▶") ? "hsl(var(--primary))"
                    : "hsl(var(--foreground))",
                }}>
                  {line}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Persona tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "16px", borderBottom: "1px solid hsl(var(--border))", overflowX: "auto" }}>
        {PERSONAS.map(p => (
          <button key={p.id} onClick={() => setParams({ persona: p.id }, { replace: true })}
            style={{
              padding: "8px 14px", fontSize: "12px", fontWeight: "500", border: "none", cursor: "pointer",
              borderBottom: persona === p.id ? "2px solid hsl(var(--primary))" : "2px solid transparent",
              color: persona === p.id ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))",
              background: "transparent", whiteSpace: "nowrap",
            }}>
            {p.label}
          </button>
        ))}
      </div>

      {/* Test grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "10px" }}>
        {visibleTests.map(tc => {
          const ts = getTestState(tc.id);
          const status: TestStatus = ts?.status || "pending";
          const errors = ts?.errors || [];
          const dur = ts?.durationMs || 0;
          const isExpanded = expandedId === tc.id;

          return (
            <div key={tc.id} className="test-card"
              onClick={() => setExpandedId(isExpanded ? null : tc.id)}
              style={{
                border: `1px solid ${statusBorder(status)}`,
                borderRadius: "8px",
                background: statusBg(status),
                overflow: "hidden",
              }}>
              {/* Card header */}
              <div style={{ padding: "10px 12px" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                  <StatusIcon status={status} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" }}>
                      <span style={{
                        fontSize: "10px", fontWeight: "700", fontFamily: "monospace",
                        background: "hsl(var(--muted))", padding: "1px 5px", borderRadius: "3px",
                        color: "hsl(var(--foreground))",
                      }}>{tc.id}</span>
                      {dur > 0 && (
                        <span style={{ fontSize: "10px", color: "hsl(var(--muted-foreground))" }}>
                          {(dur / 1000).toFixed(1)}s
                        </span>
                      )}
                      {errors.length > 0 && (
                        <span style={{
                          fontSize: "10px", background: "hsl(var(--brand-error))", color: "#fff",
                          padding: "1px 5px", borderRadius: "3px",
                        }}>{errors.length} error{errors.length > 1 ? "s" : ""}</span>
                      )}
                    </div>
                    <div style={{ fontSize: "12px", fontWeight: "500", color: "hsl(var(--foreground))", lineHeight: "1.4" }}>
                      {tc.name}
                    </div>
                  </div>
                  <div style={{ color: "hsl(var(--muted-foreground))", flexShrink: 0 }}>
                    {isExpanded ? <ChevronUp style={{ width: "14px", height: "14px" }} /> : <ChevronDown style={{ width: "14px", height: "14px" }} />}
                  </div>
                </div>

                {/* Progress bar + live status (running only) */}
                {status === "running" && ts && (
                  <div style={{ marginTop: "6px" }}>
                    {ts.totalMessages > 0 && (
                      <div style={{ height: "3px", background: "hsl(var(--muted))", borderRadius: "2px", overflow: "hidden", marginBottom: "4px" }}>
                        <div style={{ height: "100%", width: `${Math.round(((ts.currentMessage || 0) / ts.totalMessages) * 100)}%`, background: "hsl(var(--primary))", borderRadius: "2px", transition: "width 0.3s" }} />
                      </div>
                    )}
                    {ts.lastUserMsg && (
                      <div style={{ fontSize: "10px", color: "hsl(var(--muted-foreground))", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {ts.currentStatus === "testing" ? "→ " : "← "}{ts.currentStatus === "testing" ? ts.lastUserMsg : ts.lastAiSnippet || ts.lastUserMsg}
                      </div>
                    )}
                    <div style={{ fontSize: "10px", color: "hsl(var(--muted-foreground))" }}>
                      Msg {ts.currentMessage || 0}/{ts.totalMessages || tc.messageCount}
                    </div>
                  </div>
                )}
              </div>

              {/* Expanded detail */}
              {isExpanded && (
                <div style={{ borderTop: "1px solid hsl(var(--border))", padding: "10px 12px", background: "hsl(var(--background) / 0.5)" }}>
                  {errors.length > 0 ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                      {errors.map((e, i) => (
                        <div key={i} style={{ fontSize: "11px", color: "hsl(var(--brand-error))", padding: "3px 6px", background: "hsl(var(--brand-error) / 0.08)", borderRadius: "4px", fontFamily: "monospace" }}>
                          {e}
                        </div>
                      ))}
                    </div>
                  ) : status === "pass" ? (
                    <div style={{ fontSize: "11px", color: "hsl(var(--brand-success))" }}>All assertions passed ✓</div>
                  ) : (
                    <div style={{ fontSize: "11px", color: "hsl(var(--muted-foreground))" }}>
                      {status === "pending" ? "Waiting to run..." : status === "running" ? `Message ${ts?.currentMessage || 0} of ${tc.messageCount}` : "No details"}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
