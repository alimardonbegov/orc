import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ExecutionLog } from "./ExecutionLog";
import { AgentsContext } from "../agents";
import { api } from "../api";
import { parseUsage } from "../usage";
import type { ExecutionLog as Log, TaskDetail, TaskRun } from "../types";

vi.mock("../api", () => ({
  api: { taskRuns: vi.fn(), stopTask: vi.fn(), resume: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const task = {
  id: 7, project_id: 1, title: "Port", description: "", status: "done", priority: "normal", blocker: null,
  blocker_detail: null, target_branch: "main", job_id: "j3", session_id: "s", updated_at: "u1", comments: [], outbox: [],
} as unknown as TaskDetail;

function run(id: number, fields: Partial<TaskRun> = {}): TaskRun {
  return {
    id, job_id: `j${id}`, trigger: "start", agent_id: 1, started_at: `2026-11-07T10:0${id}:00+00:00`,
    ended_at: `2026-11-07T10:0${id}:30+00:00`, outcome: "handed_in", active: false, duration_sec: 30, cost_usd: 0.5,
    tokens: 1000, ...fields,
  };
}

const empty: Log = { runs: [], checks: [], merges: [], totals: { cost_usd: 0, tokens: 0, agent_sec: 0 } };

function show(log: Log, fields: Partial<TaskDetail> = {}, onAction = vi.fn(async (action: () => Promise<unknown>) => {
  await action();
  return true;
})) {
  (api.taskRuns as any).mockResolvedValue(log);
  render(
    <AgentsContext.Provider value={[{ id: 1, name: "Ann", avatar: null } as any]}>
      <ExecutionLog task={{ ...task, ...fields }} usage={null} pending={false} onAction={onAction} onOpenThread={vi.fn()} />
    </AgentsContext.Provider>,
  );
  return onAction;
}

it("a card with no runs shows no log", async () => {
  show(empty);
  await waitFor(() => expect(api.taskRuns).toHaveBeenCalledWith(7));
  expect(screen.queryByText("Execution log")).not.toBeInTheDocument();
});

it("totals, the active run first, then three rows of the past and the rest behind Show all", async () => {
  show(
    {
      runs: [run(1, { trigger: null, outcome: null }), run(2, { trigger: "crash", outcome: "failed" }), run(3, { trigger: "verify_failed" }),
        run(4, { trigger: "message", active: true, ended_at: null, outcome: null })],
      checks: [{ id: 1, job_id: "j2", cmd: "make test", ok: false, duration_sec: 5, output_tail: "boom", exit_code: 1, timed_out: false, created_at: "2026-11-07T10:02:40+00:00" }],
      merges: [],
      totals: { cost_usd: 2, tokens: 4000, agent_sec: 3600 },
    },
    { status: "in_progress" },
  );
  expect(await screen.findByText("Execution log")).toBeInTheDocument();
  expect(screen.getByText("$2.00")).toBeInTheDocument();
  expect(screen.getByText("4k")).toBeInTheDocument();
  expect(screen.getByText("1 h")).toBeInTheDocument();
  const rows = within(screen.getByRole("list")).getAllByRole("listitem");
  // active run, then newest first: the third run, the check of the second, the second run
  expect(rows.map((r) => r.textContent?.split("$")[0])).toEqual([
    expect.stringContaining("Your message"),
    expect.stringContaining("Sent back after verification"),
    expect.stringContaining("Check exited with code 1"),
  ]);
  expect(screen.getByRole("button", { name: "Show all (2 more)" })).toBeInTheDocument();
});

it("Show all lists every row, a run from before the log reads as Run, and the usage breakdown is there", async () => {
  const usage = parseUsage(JSON.stringify({
    total: { input: 1, cache_creation: 0, cache_read: 0, output: 1 }, total_tokens: 2,
    models: { "claude-opus-5": { input: 1, cache_creation: 0, cache_read: 0, output: 1, messages: 1 } },
    agents: [], sessions: [{ session_id: "s", job_id: "j1", total_tokens: 2 }], cost_usd: null, cost_usd_estimated: 0.01,
    scanned_at: "2026-09-21T12:00:00+00:00",
  }));
  (api.taskRuns as any).mockResolvedValue({ ...empty, runs: [run(1, { trigger: null }), run(2), run(3), run(4)] });
  render(<ExecutionLog task={task} usage={usage} pending={false} onAction={vi.fn()} onOpenThread={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "Show all (1 more)" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getAllByRole("listitem")).toHaveLength(4);
  expect(within(dialog).getByText("Run")).toBeInTheDocument();
  expect(within(dialog).getAllByText("claude-opus-5").length).toBeGreaterThan(0);
});

it("a failed check opens its output as plain text", async () => {
  show({
    ...empty,
    runs: [run(1)],
    checks: [{ id: 1, job_id: "j1", cmd: "make test", ok: false, duration_sec: 5, output_tail: "**FAIL** <b>x</b>", exit_code: null, timed_out: false, created_at: "2026-11-07T10:01:40+00:00" }],
  });
  await userEvent.click(await screen.findByRole("button", { name: "Check failed" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("make test")).toBeInTheDocument();
  expect(within(dialog).getByText("**FAIL** <b>x</b>")).toBeInTheDocument();
});

it("a failed check with empty output says which code it exited with", async () => {
  show({
    ...empty,
    runs: [run(1)],
    checks: [{ id: 1, job_id: "j1", cmd: "test ! -f FAIL", ok: false, duration_sec: 1, output_tail: "", exit_code: 3, timed_out: false, created_at: "2026-11-07T10:01:40+00:00" }],
  });
  await userEvent.click(await screen.findByRole("button", { name: "Check exited with code 3" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("The check printed nothing and exited with code 3.")).toBeInTheDocument();
});

it("a timed out check reads as a timeout, not as a code", async () => {
  show({
    ...empty,
    runs: [run(1)],
    checks: [{ id: 1, job_id: "j1", cmd: "sleep 99", ok: false, duration_sec: 60, output_tail: "", exit_code: null, timed_out: true, created_at: "2026-11-07T10:01:40+00:00" }],
  });
  await userEvent.click(await screen.findByRole("button", { name: "Check timed out" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("The check was killed by the timeout.")).toBeInTheDocument();
});

it("merges show with their result", async () => {
  show({ ...empty, runs: [run(1)], merges: [{ id: 9, at: "2026-11-07T10:05:00+00:00", result: "merged", target: "dev", detail: null }] });
  expect(await screen.findByText("Merged into dev")).toBeInTheDocument();
});

it("the active run of a card in work can be stopped, after a confirmation", async () => {
  const onAction = show({ ...empty, runs: [run(1, { active: true, ended_at: null, outcome: null })] }, { status: "in_progress" });
  await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
  await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(api.stopTask).toHaveBeenCalledWith(7));
  expect(onAction).toHaveBeenCalled();
});

it("the latest run of a failed card runs again in the same session", async () => {
  show({ ...empty, runs: [run(1), run(2, { outcome: "failed" })] }, { status: "failed" });
  const buttons = await screen.findAllByRole("button", { name: "Run again in the same session" });
  expect(buttons).toHaveLength(1);
  await userEvent.click(buttons[0]);
  await waitFor(() => expect(api.resume).toHaveBeenCalledWith(7));
});

it("the last run of a failed card says why in plain words, and an unknown or missing code adds nothing", async () => {
  const log = { ...empty, runs: [run(1, { outcome: "failed" })] };
  show(log, { status: "failed", detail_code: "check_failed_again" });
  const reason = await screen.findByTestId("run-reason");
  expect(reason).toHaveTextContent("The check failed twice.");
  expect(reason).toHaveAttribute("title", expect.stringContaining("«Continue»"));
});

it("an earlier run, a finished card and a code this client does not know get no reason line", async () => {
  show({ ...empty, runs: [run(1, { outcome: "failed" }), run(2, { outcome: "failed" })] }, { status: "failed", detail_code: "stopped_by_owner" });
  await screen.findByText("Execution log");
  expect(screen.getAllByTestId("run-reason")).toHaveLength(1);
  cleanup();
  show({ ...empty, runs: [run(1, { outcome: "failed" })] }, { status: "failed", detail_code: "from_a_newer_server" });
  await screen.findByText("Execution log");
  expect(screen.queryByTestId("run-reason")).not.toBeInTheDocument();
  cleanup();
  show({ ...empty, runs: [run(1)] }, { status: "done", detail_code: "stopped_by_owner" });
  await screen.findByText("Execution log");
  expect(screen.queryByTestId("run-reason")).not.toBeInTheDocument();
});
