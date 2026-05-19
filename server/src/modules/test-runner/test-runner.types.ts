export type TestStatus = "pending" | "running" | "pass" | "fail" | "skipped";

export interface TestCaseInfo {
  id: string;
  persona: string;
  name: string;
  desc: string;
  messageCount: number;
}

export interface TestProgress {
  id: string;
  status: TestStatus;
  currentMessage: number;
  totalMessages: number;
  errors: string[];
  durationMs: number;
  lastUserMsg?: string;
  lastAiSnippet?: string;
}

export interface RunnerState {
  runId: string;
  startedAt: string;
  status: "idle" | "running" | "done";
  filter?: string;
  tests: Record<string, TestProgress>;
}

export interface SSEEvent {
  type:
    | "state"
    | "test_start"
    | "test_progress"
    | "test_done"
    | "run_done";
  [key: string]: unknown;
}
