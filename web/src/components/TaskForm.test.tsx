import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi } from "vitest";
import { TaskForm } from "./TaskForm";
import { AppHiddenModelsContext } from "../hiddenModels";
import type { Project, Task, TaskStatus } from "../types";

vi.mock("../api", () => ({
  api: { branches: vi.fn(async () => ({ current: "main", default_branch: null, base: "main", branches: ["main", "dev"], items: [] })) },
}));

const task = (id: number, title: string, projectId = 1, status: TaskStatus = "todo"): Task => ({
  id, project_id: projectId, title, description: "", status, priority: "normal", blocker: null, blocker_detail: null,
  target_branch: "main", model: null, effort: null, permission_mode: null, verify_cmd: null, requires_review: 0,
  worktree_path: null, branch: null, job_id: null, session_id: null, auto_resume_count: 0, state_miss_count: 0,
  quota_retry_count: 0, conflict_retry_count: 0, resume_with: null, outbox_state: null, merge_queued_at: null, retry_after: null, report_json: null,
  created_at: "", updated_at: "", done_at: null, archived_at: null, position: null, usage_json: null, depends_on: [],
});

const project = (over: Partial<Project> = {}): Project => ({
  id: 1, name: "Project", path: "/tmp/p", default_model: "claude-opus-5", default_effort: "high",
  default_permission_mode: "acceptEdits", default_branch: null, verify_cmd: "make test", verify_timeout_sec: 600, max_workers: 2,
  push_enabled: 0, archived_at: null, path_ok: true, path_error: null, created_at: "", position: null, ...over,
});

it("in blockers it shows the tasks of its own project, except the one being edited", async () => {
  const all = [task(1, "Own"), task(2, "Edited"), task(3, "Foreign", 2)];
  render(<TaskForm projectId={1} allTasks={all} excludeId={2} onSubmit={vi.fn()} onCancel={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /#1 Own/ })).toBeInTheDocument());
  expect(screen.queryByRole("checkbox", { name: /#2 Edited/ })).not.toBeInTheDocument();
  // A foreign project is not mixed with its own, but not lost either: it is behind a button.
  expect(screen.queryByRole("checkbox", { name: /#3 Foreign/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show other projects (1)" })).toBeInTheDocument();
});

it("a blocker from a foreign project can be selected, and you can see which one", async () => {
  const onSubmit = vi.fn();
  const all = [task(1, "Own"), task(3, "Foreign", 2)];
  const projects = [project(), project({ id: 2, name: "Backend" })];
  render(
    <TaskForm projectId={1} projects={projects} allTasks={all} initial={{ title: "Exists" }} onSubmit={onSubmit} onCancel={vi.fn()} />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Show other projects (1)" }));
  await userEvent.click(screen.getByRole("checkbox", { name: /#3 Foreign .*project Backend/ }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  expect(onSubmit.mock.calls[0][0]).toMatchObject({ depends_on: [3] });
});

it("the checked tasks go into depends_on on save", async () => {
  const onSubmit = vi.fn();
  render(<TaskForm projectId={1} allTasks={[task(1, "First"), task(4, "Second")]} onSubmit={onSubmit} onCancel={vi.fn()} />);
  await userEvent.type(screen.getByPlaceholderText("Title"), "New");
  await userEvent.click(await screen.findByRole("checkbox", { name: /#4 Second/ }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  expect(onSubmit.mock.calls[0][0]).toMatchObject({ title: "New", depends_on: [4] });
});

it("the selected blockers are not lost when other form fields are edited", async () => {
  const onSubmit = vi.fn();
  render(
    <TaskForm projectId={1} initial={{ title: "Exists", depends_on: [1] }} allTasks={[task(1, "First"), task(4, "Second")]}
      onSubmit={onSubmit} onCancel={vi.fn()} />,
  );
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /#1 First/ })).toBeChecked());
  await userEvent.selectOptions(screen.getByDisplayValue("normal"), "high");
  expect(screen.getByRole("checkbox", { name: /#1 First/ })).toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  expect(onSubmit.mock.calls[0][0]).toMatchObject({ priority: "high", depends_on: [1] });
});

it("an already saved link to a task of another project is not lost on save", async () => {
  const onSubmit = vi.fn();
  const all = [task(1, "Own"), task(3, "Foreign", 2)];
  render(
    <TaskForm projectId={1} initial={{ title: "Exists", depends_on: [3] }} allTasks={all} onSubmit={onSubmit} onCancel={vi.fn()} />,
  );
  // A foreign project is hidden in the list, but the selected link must be shown, otherwise there is no way to remove it,
  // and submitting the form would silently wipe it.
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /#3 Foreign/ })).toBeChecked());
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  expect(onSubmit.mock.calls[0][0]).toMatchObject({ depends_on: [3] });
});

it("the launch parameters are visible at once, without expanding a block", () => {
  render(<TaskForm projectId={1} project={project()} allTasks={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />);
  // These are the fields people come to the form for: they must not cost a click on a spoiler.
  expect(screen.getByRole("combobox", { name: "Model" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Effort" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Permission mode" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Run parameters/ })).not.toBeInTheDocument();
});

it("the model is chosen from a list and goes to onSubmit", async () => {
  const onSubmit = vi.fn();
  render(<TaskForm projectId={1} allTasks={[]} onSubmit={onSubmit} onCancel={vi.fn()} />);
  await userEvent.type(screen.getByPlaceholderText("Title"), "New");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Model" }), "claude-sonnet-5");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  expect(onSubmit.mock.calls[0][0]).toMatchObject({ model: "claude-sonnet-5" });
});

it("the effort is chosen from a list and goes to onSubmit", async () => {
  const onSubmit = vi.fn();
  render(<TaskForm projectId={1} allTasks={[]} onSubmit={onSubmit} onCancel={vi.fn()} />);
  await userEvent.type(screen.getByPlaceholderText("Title"), "New");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Effort" }), "xhigh");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  expect(onSubmit.mock.calls[0][0]).toMatchObject({ effort: "xhigh" });
});

it("empty launch parameters name the value inherited from the project", () => {
  render(<TaskForm projectId={1} project={project()} allTasks={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByRole("option", { name: "Opus 5 — from project" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "high — from project" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "acceptEdits — from project" })).toBeInTheDocument();
  expect(screen.getByPlaceholderText("make test — from project")).toBeInTheDocument();
  // The value is visible, but it is not pinned to the task: the block says so directly.
  expect(screen.getByText(/An empty field means the project's value/)).toBeInTheDocument();
});

it("when a parameter is not set in the project either, we honestly say that Claude Code will decide", () => {
  render(
    <TaskForm projectId={1} project={project({ default_model: null, default_effort: null, verify_cmd: null })}
      allTasks={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />,
  );
  expect(screen.getAllByRole("option", { name: "as Claude Code decides — not set in the project" })).toHaveLength(2);
  expect(screen.getByPlaceholderText("no verify command set")).toBeInTheDocument();
});

it("the shown project value is not substituted into the task: it stays bound to the project", async () => {
  const onSubmit = vi.fn();
  render(<TaskForm projectId={1} project={project()} allTasks={[]} onSubmit={onSubmit} onCancel={vi.fn()} />);
  await userEvent.type(screen.getByPlaceholderText("Title"), "New");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  expect(onSubmit.mock.calls[0][0]).toMatchObject({ model: null, effort: null, permission_mode: null, verify_cmd: null });
});

it("returning to project values is offered only where the task has overridden them", () => {
  const { unmount } = render(
    <TaskForm projectId={1} project={project()} allTasks={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />,
  );
  expect(screen.queryByRole("button", { name: /Reset to project values/ })).not.toBeInTheDocument();
  unmount();

  render(
    <TaskForm projectId={1} project={project()} initial={{ title: "Exists", model: "claude-sonnet-5" }}
      allTasks={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />,
  );
  expect(screen.getByRole("button", { name: /Reset to project values/ })).toBeInTheDocument();
});

it("\"Reset to project values\" clears all overrides at once", async () => {
  const onSubmit = vi.fn();
  render(
    <TaskForm projectId={1} project={project()}
      initial={{ title: "Exists", model: "claude-sonnet-5", effort: "xhigh", permission_mode: "dontAsk", verify_cmd: "npm test" }}
      allTasks={[]} onSubmit={onSubmit} onCancel={vi.fn()} />,
  );
  await userEvent.click(screen.getByRole("button", { name: /Reset to project values/ }));
  // The fields went back to the empty option, the one that follows the project settings.
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue("");
  expect(screen.getByPlaceholderText("make test — from project")).toHaveValue("");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  expect(onSubmit.mock.calls[0][0]).toMatchObject({ model: null, effort: null, permission_mode: null, verify_cmd: null });
});

it("the model choice has no hidden ones: the shared orc list, and the project's own list replaces it", async () => {
  const modelValues = () =>
    Array.from(screen.getByRole("combobox", { name: "Model" }).querySelectorAll("option")).map((o) => o.value);
  const form = (p: Project) => (
    <AppHiddenModelsContext.Provider value={["claude-opus-5"]}>
      <TaskForm projectId={1} project={p} allTasks={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />
    </AppHiddenModelsContext.Provider>
  );
  const { rerender } = render(form(project()));
  expect(modelValues()).not.toContain("claude-opus-5");
  expect(modelValues()).toContain("claude-sonnet-5");

  rerender(form(project({ hidden_models: ["claude-sonnet-5"] })));
  expect(modelValues()).toContain("claude-opus-5");
  expect(modelValues()).not.toContain("claude-sonnet-5");
  await waitFor(() => expect(screen.getByRole("combobox", { name: /Base branch/ })).toHaveValue("main"));
});

it("\"On schedule\" + \"+1 h\": the submit carries the moment an hour later", async () => {
  const onSubmit = vi.fn();
  render(<TaskForm projectId={1} allTasks={[]} initial={{ title: "At night" }} onSubmit={onSubmit} onCancel={vi.fn()} />);
  await userEvent.click(screen.getByRole("radio", { name: "On schedule" }));
  await userEvent.click(screen.getByRole("button", { name: "+1 h" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  const { start_after, start_before } = onSubmit.mock.calls[0][0];
  const minutes = (Date.parse(start_after) - Date.now()) / 60_000;
  expect(minutes).toBeGreaterThan(58);
  expect(minutes).toBeLessThan(61);
  expect(start_before).toBeNull();
});

it("a window end earlier than the start is an error and saving is blocked", async () => {
  render(
    <TaskForm projectId={1} allTasks={[]} initial={{ title: "X", start_after: "2099-01-02T10:00:00+00:00" }} onSubmit={vi.fn()} onCancel={vi.fn()} />,
  );
  fireEvent.change(screen.getByLabelText("Not after"), { target: { value: "2099-01-01T10:00" } });
  expect(await screen.findByText("The end of the window must be after its start")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

it("\"Right away\" clears the schedule", async () => {
  const onSubmit = vi.fn();
  render(
    <TaskForm
      projectId={1}
      allTasks={[]}
      initial={{ title: "X", start_after: "2099-01-01T10:00:00+00:00", start_before: "2099-01-01T12:00:00+00:00" }}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByRole("radio", { name: "Right away" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  expect(onSubmit.mock.calls[0][0]).toMatchObject({ start_after: null, start_before: null });
});

it("\"On schedule\" with an empty \"Not before\" gives a hint that it starts at once", async () => {
  render(
    <TaskForm projectId={1} allTasks={[]} initial={{ title: "X", start_after: "2099-01-02T10:00:00+00:00" }} onSubmit={vi.fn()} onCancel={vi.fn()} />,
  );
  fireEvent.change(screen.getByLabelText("Not before"), { target: { value: "" } });
  expect(await screen.findByText(/No time set — it will start right away\./)).toBeInTheDocument();
});
