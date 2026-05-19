/**
 * TestRunnerService
 *
 * Spawns `scripts/test-ai-concierge.ts` as a child process and streams
 * its output to SSE subscribers. The CLI script is the single source of
 * truth for test logic - this service just provides UI control + visibility.
 *
 * Output parsing: the CLI emits lines like:
 *   "  ✅ SM-01 PASS (25.3s)"
 *   "  ❌ SM-01 FAIL (25.3s)"
 *   "     [SM-01] msg ...: error detail"
 *   "Results: 11 passed, 3 failed (737s total)"
 *   "  ▶ Starting: SM-01"
 */

import { Injectable, Logger } from "@nestjs/common";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import { RunnerState, TestProgress, SSEEvent } from "./test-runner.types";
import { TEST_CASES } from "./test-cases";

@Injectable()
export class TestRunnerService {
  private readonly logger = new Logger(TestRunnerService.name);
  private subscribers = new Set<(json: string) => void>();
  private childProcess: ChildProcess | null = null;

  private state: RunnerState = {
    runId: "",
    startedAt: "",
    status: "idle",
    filter: undefined,
    tests: {},
    passCount: 0,
    failCount: 0,
    totalCount: 0,
    log: [],
  };

  // ─── SSE subscription ───────────────────────────────────────────────────────

  subscribe(callback: (json: string) => void): () => void {
    this.subscribers.add(callback);
    // Send full current state immediately
    callback(JSON.stringify({ type: "state", state: this.state }));
    return () => this.subscribers.delete(callback);
  }

  private emit(event: SSEEvent) {
    const json = JSON.stringify(event);
    for (const sub of this.subscribers) {
      try { sub(json); } catch {}
    }
  }

  getState(): RunnerState { return this.state; }

  // ─── Run control ────────────────────────────────────────────────────────────

  startRun(filter?: string): { started: boolean; message: string } {
    if (this.state.status === "running") {
      return { started: false, message: "A run is already in progress. Stop it first." };
    }

    // Reset state
    const runId = Date.now().toString();
    const matchingTests = filter
      ? TEST_CASES.filter(tc => tc.persona === filter || tc.id === filter)
      : TEST_CASES;

    const tests: Record<string, TestProgress> = {};
    for (const tc of matchingTests) {
      tests[tc.id] = {
        id: tc.id,
        persona: tc.persona,
        name: tc.name,
        status: "pending",
        currentMessage: 0,
        totalMessages: tc.messageCount,
        errors: [],
        durationMs: 0,
      };
    }

    this.state = {
      runId,
      startedAt: new Date().toISOString(),
      status: "running",
      filter,
      tests,
      passCount: 0,
      failCount: 0,
      totalCount: matchingTests.length,
      log: [],
    };

    this.emit({ type: "state", state: this.state });

    // Spawn the CLI script
    const scriptPath = path.resolve(process.cwd(), "scripts", "test-ai-concierge.ts");
    const args = ["tsx", scriptPath, "--sequential"];
    if (filter) {
      if (TEST_CASES.find(tc => tc.id === filter)) {
        args.push(`--id=${filter}`);
      } else {
        args.push(`--persona=${filter}`);
      }
    }

    this.logger.log(`Spawning test runner: npx ${args.join(" ")}`);

    this.childProcess = spawn("npx", args, {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let currentTestId: string | null = null;

    const processLine = (line: string) => {
      // Add to log (keep last 500 lines)
      this.state.log.push(line);
      if (this.state.log.length > 500) this.state.log.shift();

      // Emit raw log line
      this.emit({ type: "log", line });

      // Parse test start: "  ▶ Starting: SM-01"
      const startMatch = line.match(/▶\s+Starting:\s+(\w+-\d+)/);
      if (startMatch) {
        currentTestId = startMatch[1];
        if (this.state.tests[currentTestId]) {
          this.state.tests[currentTestId].status = "running";
          this.state.tests[currentTestId].startedAt = Date.now();
          this.emit({ type: "test_start", id: currentTestId });
        }
        return;
      }

      // Parse PASS: "  ✅ SM-01 PASS (25.3s)"
      const passMatch = line.match(/✅\s+(\w+-\d+)\s+PASS\s+\(([0-9.]+)s\)/);
      if (passMatch) {
        const id = passMatch[1];
        const dur = Math.round(parseFloat(passMatch[2]) * 1000);
        if (this.state.tests[id]) {
          this.state.tests[id].status = "pass";
          this.state.tests[id].durationMs = dur;
          this.state.passCount++;
          this.emit({ type: "test_done", id, status: "pass", durationMs: dur, errors: [] });
        }
        currentTestId = null;
        return;
      }

      // Parse FAIL: "  ❌ SM-01 FAIL (25.3s)"
      const failMatch = line.match(/❌\s+(\w+-\d+)\s+FAIL\s+\(([0-9.]+)s\)/);
      if (failMatch) {
        const id = failMatch[1];
        const dur = Math.round(parseFloat(failMatch[2]) * 1000);
        if (this.state.tests[id]) {
          this.state.tests[id].status = "fail";
          this.state.tests[id].durationMs = dur;
          this.state.failCount++;
          this.emit({ type: "test_done", id, status: "fail", durationMs: dur, errors: this.state.tests[id].errors });
        }
        currentTestId = null;
        return;
      }

      // Parse error detail: "     [SM-01] msg ...: error detail"
      const errMatch = line.match(/\[(\w+-\d+)\]\s+(.+)/);
      if (errMatch) {
        const id = errMatch[1];
        const errMsg = errMatch[2].trim();
        if (this.state.tests[id]) {
          this.state.tests[id].errors.push(errMsg);
          this.emit({ type: "test_error", id, error: errMsg });
        }
        return;
      }

      // Parse summary: "Results: 11 passed, 3 failed (737s total)"
      const summaryMatch = line.match(/Results:\s+(\d+)\s+passed,\s+(\d+)\s+failed/);
      if (summaryMatch) {
        this.state.passCount = parseInt(summaryMatch[1]);
        this.state.failCount = parseInt(summaryMatch[2]);
      }

      // Parse HTML report path
      const reportMatch = line.match(/HTML report:\s+(.+\.html)/);
      if (reportMatch) {
        this.state.reportPath = reportMatch[1].trim();
        this.emit({ type: "report_ready", path: this.state.reportPath });
      }
    };

    const onData = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const clean = line.replace(/[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
        if (clean.trim()) processLine(clean);
      }
    };

    this.childProcess.stdout?.on("data", onData);
    this.childProcess.stderr?.on("data", onData);

    this.childProcess.on("close", (code) => {
      if (buffer.trim()) processLine(buffer.trim());
      this.state.status = "done";
      this.state.endedAt = new Date().toISOString();
      this.childProcess = null;
      this.emit({
        type: "run_done",
        passCount: this.state.passCount,
        failCount: this.state.failCount,
        durationMs: Date.now() - new Date(this.state.startedAt).getTime(),
        exitCode: code ?? 0,
      });
      this.logger.log(`Test run complete: ${this.state.passCount} passed, ${this.state.failCount} failed`);
    });

    this.childProcess.on("error", (err) => {
      this.logger.error(`Test runner error: ${err.message}`);
      this.state.status = "done";
      this.emit({ type: "error", message: err.message });
    });

    return { started: true, message: `Started run ${runId} with ${matchingTests.length} tests` };
  }

  stopRun(): { stopped: boolean } {
    if (this.childProcess) {
      this.childProcess.kill("SIGTERM");
      this.childProcess = null;
      this.state.status = "done";
      this.state.endedAt = new Date().toISOString();
      this.emit({ type: "run_stopped" });
      return { stopped: true };
    }
    return { stopped: false };
  }

  clearResults(): void {
    if (this.state.status === "running") return;
    this.state = {
      runId: "",
      startedAt: "",
      status: "idle",
      filter: undefined,
      tests: {},
      passCount: 0,
      failCount: 0,
      totalCount: 0,
      log: [],
    };
    this.emit({ type: "state", state: this.state });
  }

  // ─── Receive events from CLI process ────────────────────────────────────────
  // The CLI script POSTs events here so any running CLI shows in the dashboard.

  receiveCliEvent(event: Record<string, unknown>): void {
    const type = event.type as string;

    if (type === "run_start") {
      // CLI started a new run - initialize state
      const testIds = (event.testIds as string[]) || [];
      const tests: Record<string, any> = {};
      for (const id of testIds) {
        const meta = ALL_TEST_META.find(t => t.id === id);
        tests[id] = {
          id,
          persona: meta?.persona || "",
          name: meta?.name || id,
          status: "pending",
          currentMessage: 0,
          totalMessages: meta?.messageCount || 10,
          errors: [],
          durationMs: 0,
        };
      }
      this.state = {
        runId: `cli-${Date.now()}`,
        startedAt: new Date().toISOString(),
        status: "running",
        filter: event.filter as string | undefined,
        tests,
        passCount: 0,
        failCount: 0,
        totalCount: testIds.length,
        log: [`[CLI] Test run started: ${testIds.length} tests`],
      };
      this.emit({ type: "state", state: this.state });

    } else if (type === "test_start") {
      const id = event.id as string;
      // Auto-add test if not already registered (e.g. separate CLI invocation)
      if (!this.state.tests[id]) {
        const meta = ALL_TEST_META.find(t => t.id === id);
        this.state.tests[id] = { id, persona: meta?.persona || "", name: meta?.name || id, status: "pending", currentMessage: 0, totalMessages: meta?.messageCount || 10, errors: [], durationMs: 0 };
        this.state.totalCount = Math.max(this.state.totalCount, Object.keys(this.state.tests).length);
        if (this.state.status !== "running") { this.state.status = "running"; this.state.startedAt = this.state.startedAt || new Date().toISOString(); }
      }
      this.state.tests[id].status = "running";
      const line = `  ▶ Starting: ${id}`;
      this.state.log.push(line);
      this.emit({ type: "test_start", id });
      this.emit({ type: "log", line });

    } else if (type === "test_pass") {
      const id = event.id as string;
      const dur = event.durationMs as number || 0;
      // Auto-add if not registered
      if (!this.state.tests[id]) {
        const meta = ALL_TEST_META.find(t => t.id === id);
        this.state.tests[id] = { id, persona: meta?.persona || "", name: meta?.name || id, status: "pending", currentMessage: 0, totalMessages: meta?.messageCount || 10, errors: [], durationMs: 0 };
        this.state.totalCount = Math.max(this.state.totalCount, Object.keys(this.state.tests).length);
      }
      this.state.tests[id].status = "pass";
      this.state.tests[id].durationMs = dur;
      this.state.passCount++;
      const line = `  ✅ ${id} PASS (${(dur / 1000).toFixed(1)}s)`;
      this.state.log.push(line);
      this.emit({ type: "test_done", id, status: "pass", durationMs: dur, errors: [] });
      this.emit({ type: "log", line });

    } else if (type === "test_fail") {
      const id = event.id as string;
      const dur = event.durationMs as number || 0;
      const errors = (event.errors as string[]) || [];
      // Auto-add if not registered
      if (!this.state.tests[id]) {
        const meta = ALL_TEST_META.find(t => t.id === id);
        this.state.tests[id] = { id, persona: meta?.persona || "", name: meta?.name || id, status: "pending", currentMessage: 0, totalMessages: meta?.messageCount || 10, errors: [], durationMs: 0 };
        this.state.totalCount = Math.max(this.state.totalCount, Object.keys(this.state.tests).length);
      }
      if (this.state.tests[id]) {
        this.state.tests[id].status = "fail";
        this.state.tests[id].durationMs = dur;
        this.state.tests[id].errors = errors;
        this.state.failCount++;
        const line = `  ❌ ${id} FAIL (${(dur / 1000).toFixed(1)}s)`;
        this.state.log.push(line, ...errors.map(e => `     ${e}`));
        this.emit({ type: "test_done", id, status: "fail", durationMs: dur, errors });
        this.emit({ type: "log", line });
        errors.forEach(e => this.emit({ type: "log", line: `     [${id}] ${e}` }));
      }

    } else if (type === "run_done") {
      this.state.status = "done";
      this.state.endedAt = new Date().toISOString();
      this.state.passCount = event.passCount as number || this.state.passCount;
      this.state.failCount = event.failCount as number || this.state.failCount;
      const line = `Results: ${this.state.passCount} passed, ${this.state.failCount} failed`;
      this.state.log.push(line);
      this.emit({ type: "run_done", passCount: this.state.passCount, failCount: this.state.failCount, durationMs: event.durationMs as number || 0, exitCode: event.exitCode as number || 0 });
      this.emit({ type: "log", line });
    }
  }
}

// ─── Test metadata lookup ─────────────────────────────────────────────────────

import { TEST_CASES as ALL_TEST_META_RAW } from "./test-cases";
const ALL_TEST_META = ALL_TEST_META_RAW;
