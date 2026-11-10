import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, beforeEach } from "vitest";
import { RoutinesView } from "./RoutinesView";
import { api } from "../api";
import { AgentsContext } from "../agents";
import type { Agent, Project, Routine, RoutineRun } from "../types";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ApiError: actual.ApiError,
    api: {
      routines: vi.fn(), addRoutine: vi.fn(), patchRoutine: vi.fn(), deleteRoutine: vi.fn(),
      runRoutine: vi.fn(), routineRuns: vi.fn(), previewSchedule: vi.fn(), branches: vi.fn(),
    },
  };
});

const project = {
  id: 1, name: "demo", path: "/repo", default_model: null, default_effort: null, default_permission_mode: "auto",
  default_branch: null, verify_cmd: null, verify_timeout_sec: 900, max_workers: 2, push_enabled: 0,
  archived_at: null, path_ok: true, path_error: null, created_at: "2026-10-01T00:00:00+00:00", position: null,
} as Project;

const lastRun: RoutineRun = {
  task_id: 42, chat_id: null, run: 3, title: "Report · #3", status: "done", blocker: null, blocker_detail: null,
  created_at: "2026-10-07T11:00:00+00:00", started_at: "2026-10-07T11:00:10+00:00",
  done_at: "2026-10-07T11:04:10+00:00", updated_at: "2026-10-07T11:04:10+00:00", archived_at: null,
  report: { status: "success", summary: "three dependencies are outdated" }, tokens: 12_500,
};

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: 7, project_id: 1, title: "Report", description: "do A, B, C", priority: "normal",
  verify_cmd: null, target_branch: null, schedule_kind: "interval", interval_minutes: 60,
  cron: null, timezone: "UTC", enabled: true, next_run_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  last_run_at: lastRun.created_at, run_count: 3, skipped_count: 1, max_runs: null, archive_runs: true,
  schedule_text: "every hour", stats: { total: 3, done: 2, failed: 1, active: 0, skipped: 1 }, last_run: lastRun,
  created_at: "2026-10-01T00:00:00+00:00", updated_at: "2026-10-07T11:00:00+00:00", ...over,
});

const mount = (list: Routine[], scope: Project | null = project, agents: Agent[] = []) => {
  vi.mocked(api.routines).mockResolvedValue(list);
  const props = { onOpenTask: vi.fn(), onOpenChat: vi.fn(), onTasksChanged: vi.fn() };
  render(
    <AgentsContext.Provider value={agents}>
      <RoutinesView project={scope} projects={[project]} canCreate {...props} />
    </AgentsContext.Provider>,
  );
  return props;
};

const agent = { id: 5, name: "Ann", description: "", avatar: null, project_id: null } as Agent;
const chatRun: RoutineRun = { ...lastRun, task_id: null, chat_id: 90, run: 1, status: "done", report: null };

beforeEach(() => vi.clearAllMocks());

it("an empty project explains what a routine is", async () => {
  mount([]);
  expect(await screen.findByText("No recurring tasks yet")).toBeInTheDocument();
});

it("shows the schedule, counters and the last run; a click opens its card", async () => {
  const props = mount([routine()]);
  const card = (await screen.findByText("Report")).closest("article")!;
  expect(within(card).getByText("every hour")).toBeInTheDocument();
  expect(within(card).getByText(/next in 30 min/)).toBeInTheDocument();
  // runs 3, done 2, failed 1, skipped 1, success 67%
  expect(within(card).getByText("67%")).toBeInTheDocument();
  await userEvent.click(within(card).getByText("three dependencies are outdated"));
  expect(props.onOpenTask).toHaveBeenCalledWith(42);
});

it("\"Run now\" creates a run and refreshes the board", async () => {
  vi.mocked(api.runRoutine).mockResolvedValue({ task_id: 43, chat_id: null, routine: routine() });
  const props = mount([routine()]);
  await userEvent.click(await screen.findByRole("button", { name: "Run now" }));
  expect(api.runRoutine).toHaveBeenCalledWith(7);
  await waitFor(() => expect(props.onTasksChanged).toHaveBeenCalled());
});

it("while the previous run is going, \"Run now\" is unavailable", async () => {
  mount([routine({ stats: { total: 3, done: 2, failed: 0, active: 1, skipped: 0 } })]);
  expect(await screen.findByRole("button", { name: "Run now" })).toBeDisabled();
});

it("pause and resume send enabled", async () => {
  vi.mocked(api.patchRoutine).mockResolvedValue(routine({ enabled: false }));
  mount([routine()]);
  await userEvent.click(await screen.findByRole("button", { name: "Pause" }));
  expect(api.patchRoutine).toHaveBeenCalledWith(7, { enabled: false });
});

it("when paused, \"paused\" is shown instead of the next run", async () => {
  mount([routine({ enabled: false, next_run_at: null })]);
  expect(await screen.findByText("paused")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
});

it("expanding shows the run history with reports", async () => {
  vi.mocked(api.routineRuns).mockResolvedValue([
    { ...lastRun, task_id: 44, run: 4, status: "failed", report: null, blocker_detail: "merge failed", done_at: null },
    lastRun,
  ]);
  const props = mount([routine()]);
  await userEvent.click(await screen.findByRole("button", { name: "Run history of Report" }));
  const rows = await screen.findAllByRole("row");
  expect(rows).toHaveLength(3); // header + two runs
  expect(within(rows[1]).getByText("merge failed")).toBeInTheDocument();
  expect(within(rows[2]).getByText("three dependencies are outdated")).toBeInTheDocument();
  expect(within(rows[2]).getByText("13k")).toBeInTheDocument();
  await userEvent.click(rows[1]);
  expect(props.onOpenTask).toHaveBeenCalledWith(44);
});

it("the form creates an interval routine with the schedule checked on the server", async () => {
  vi.mocked(api.previewSchedule).mockResolvedValue({ next: [new Date(Date.now() + 2 * 3_600_000).toISOString()], text: "every 2 h" });
  vi.mocked(api.branches).mockResolvedValue({ branches: ["main"], base: "main" } as never);
  vi.mocked(api.addRoutine).mockResolvedValue(routine());
  mount([]);
  await userEvent.click((await screen.findAllByRole("button", { name: "Routine" }))[0]);
  await userEvent.type(screen.getByPlaceholderText("Morning dependency check"), "Check");
  await userEvent.type(screen.getByRole("textbox", { name: "Instruction" }), "do A");
  const every = screen.getByRole("spinbutton", { name: "Every" });
  await userEvent.clear(every);
  await userEvent.type(every, "2");
  await waitFor(() => expect(api.previewSchedule).toHaveBeenCalledWith(
    expect.objectContaining({ schedule_kind: "interval", interval_minutes: 120 })));
  expect(await screen.findByText("Next runs:")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(api.addRoutine).toHaveBeenCalled());
  const body = vi.mocked(api.addRoutine).mock.calls[0][0];
  expect(body).toMatchObject({ project_id: 1, title: "Check", description: "do A", schedule_kind: "interval",
    interval_minutes: 120, cron: null, archive_runs: true, max_runs: null });
});

it("too frequent an interval is not sent to the server", async () => {
  vi.mocked(api.previewSchedule).mockResolvedValue({ next: [], text: "" });
  mount([]);
  await userEvent.click((await screen.findAllByRole("button", { name: "Routine" }))[0]);
  const unit = screen.getByRole("combobox", { name: "Unit" });
  await userEvent.selectOptions(unit, "minutes");
  const every = screen.getByRole("spinbutton", { name: "Every" });
  await userEvent.clear(every);
  await userEvent.type(every, "2");
  expect(await screen.findByText("Interval must be at least 5 minutes")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create routine" })).toBeDisabled();
});

it("the Routines page lists every routine and says whose it is", async () => {
  mount([routine(), routine({ id: 8, project_id: null, title: "Digest", agent_id: 5, last_run: chatRun })], null);
  const free = (await screen.findByText("Digest")).closest("article")!;
  expect(within(free).getByText("No project")).toBeInTheDocument();
  expect(vi.mocked(api.routines)).toHaveBeenCalledWith(undefined);
  expect(within((await screen.findByText("Report")).closest("article")!).getByText("demo")).toBeInTheDocument();
});

it("a run of a routine outside a project opens its chat, not a card", async () => {
  vi.mocked(api.routineRuns).mockResolvedValue([chatRun]);
  const props = mount([routine({ id: 8, project_id: null, title: "Digest", agent_id: 5, last_run: chatRun })], null);
  await userEvent.click(await screen.findByRole("button", { name: "Run history of Digest" }));
  await userEvent.click((await screen.findAllByRole("row"))[1]);
  expect(props.onOpenChat).toHaveBeenCalledWith(90);
  expect(props.onOpenTask).not.toHaveBeenCalled();
});

it("the page form creates a routine without a project and needs an agent", async () => {
  vi.mocked(api.previewSchedule).mockResolvedValue({ next: [], text: "" });
  vi.mocked(api.addRoutine).mockResolvedValue(routine({ project_id: null }));
  mount([], null, [agent]);
  await userEvent.click((await screen.findAllByRole("button", { name: "Routine" }))[0]);
  expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("");
  await userEvent.type(screen.getByPlaceholderText("Morning dependency check"), "Digest");
  await userEvent.type(screen.getByRole("textbox", { name: "Instruction" }), "read the news");
  const submit = screen.getByRole("button", { name: "Create routine" });
  await waitFor(() => expect(submit).toBeDisabled()); // no agent yet
  expect(screen.queryByText("Verify command")).not.toBeInTheDocument(); // card-only parameters are gone
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Agent" }), "5");
  await waitFor(() => expect(submit).toBeEnabled());
  await userEvent.click(submit);
  await waitFor(() => expect(api.addRoutine).toHaveBeenCalled());
  expect(vi.mocked(api.addRoutine).mock.calls[0][0]).toMatchObject({
    project_id: null, agent_id: 5, verify_cmd: null, title: "Digest" });
});

it("editing a routine can detach it from its project", async () => {
  vi.mocked(api.previewSchedule).mockResolvedValue({ next: [], text: "" });
  vi.mocked(api.patchRoutine).mockResolvedValue(routine({ project_id: null }));
  mount([routine({ agent_id: 5 })], project, [agent]);
  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const select = screen.getByRole("combobox", { name: "Project" });
  expect(select).toHaveValue("1");
  await userEvent.selectOptions(select, "");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Agent" }), "5");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.patchRoutine).toHaveBeenCalled());
  expect(vi.mocked(api.patchRoutine).mock.calls[0][1]).toMatchObject({ project_id: null, agent_id: 5 });
});
