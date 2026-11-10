import { expect, it } from "vitest";
import { clock, logRows, visiblePast } from "./executionLog";
import type { ExecutionLog, TaskRun } from "./types";

function run(id: number, started: string, ended: string | null, active = false): TaskRun {
  return { id, job_id: `j${id}`, trigger: "start", agent_id: null, started_at: started, ended_at: ended, outcome: null, active,
    duration_sec: null, cost_usd: 0, tokens: 0 };
}

const log: ExecutionLog = {
  runs: [run(1, "2026-01-01T10:00:00Z", "2026-01-01T10:10:00Z"), run(2, "2026-01-01T10:20:00Z", null, true)],
  checks: [{ id: 1, job_id: "j1", cmd: "t", ok: true, duration_sec: 1, output_tail: "", exit_code: null, timed_out: false, created_at: "2026-01-01T10:10:00Z" }],
  merges: [{ id: 5, at: "2026-01-01T10:10:00Z", result: "conflict", target: "main", detail: null }],
  totals: { cost_usd: 0, tokens: 0, agent_sec: 0 },
};

it("active runs apart, the past newest first, and on one second the merge before the check before the run", () => {
  const rows = logRows(log);
  expect(rows.active.map((e) => e.key)).toEqual(["run-2"]);
  expect(rows.past.map((e) => e.key)).toEqual(["merge-5", "check-1", "run-1"]);
});

it("the past fills what the active runs leave of three rows", () => {
  expect(visiblePast(logRows(log)).map((e) => e.key)).toEqual(["merge-5", "check-1"]);
  const busy = { ...log, runs: [1, 2, 3, 4].map((i) => run(i, "2026-01-01T10:00:00Z", null, true)) };
  expect(visiblePast(logRows(busy))).toEqual([]);
});

it("a live timer", () => {
  expect(clock(42)).toBe("0:42");
  expect(clock(725)).toBe("12:05");
  expect(clock(3723)).toBe("1:02:03");
});
