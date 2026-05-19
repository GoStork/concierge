export type TestStatus = "pending" | "running" | "pass" | "fail";

export interface TestProgress {
  id: string;
  persona: string;
  name: string;
  status: TestStatus;
  currentMessage: number;
  totalMessages: number;
  errors: string[];
  durationMs: number;
  startedAt?: number;
  lastUserMsg?: string;     // last message sent to AI
  lastAiSnippet?: string;   // first 80 chars of AI response
  currentStatus?: string;   // "testing" | "got_response"
}

export interface RunnerState {
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

export type SSEEvent =
  | { type: "state"; state: RunnerState }
  | { type: "log"; line: string }
  | { type: "test_start"; id: string }
  | { type: "test_progress"; id: string; currentMessage: number; lastUserMsg?: string; lastAiSnippet?: string }
  | { type: "test_done"; id: string; status: "pass" | "fail"; durationMs: number; errors: string[] }
  | { type: "test_error"; id: string; error: string }
  | { type: "run_done"; passCount: number; failCount: number; durationMs: number; exitCode: number }
  | { type: "run_stopped" }
  | { type: "report_ready"; path: string }
  | { type: "error"; message: string };
