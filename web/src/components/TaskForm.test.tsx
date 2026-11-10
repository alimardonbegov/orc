import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi } from "vitest";
import { TaskForm } from "./TaskForm";
import { AgentsContext } from "../agents";
import { AppCardSettingsContext, type CardSettings } from "../cardSettings";
import type { Agent, Project, Task, TaskStatus } from "../types";

const { createBranch } = vi.hoisted(() => ({
  createBranch: vi.fn(async (_p: number, name: string) => ({
    current: "main", default_branch: null, base: "main", branches: ["main", "dev", name], items: [],
  })),
}));

vi.mock("../api", () => ({
  api: {
    branches: vi.fn(async () => ({ current: "main", default_branch: null, base: "main", branches: ["main", "dev"], items: [] })),
    createBranch,
  },
}));

const task = (id: number, title: string, projectId = 1, status: TaskStatus = "todo"): Task => ({
  id, project_id: projectId, title, description: "", status, priority: "normal", blocker: null, blocker_detail: null,
  target_branch: "main", verify_cmd: null, requires_review: 0,
  worktree_path: null, branch: null, job_id: null, session_id: null, auto_resume_count: 0, state_miss_count: 0,
  quota_retry_count: 0, conflict_retry_count: 0, resume_with: null, outbox_state: null, merge_queued_at: null, retry_after: null, report_json: null,
  created_at: "", updated_at: "", done_at: null, archived_at: null, position: null, usage_json: null, depends_on: [],
});

const project = (over: Partial<Project> = {}): Project => ({
  id: 1, name: "Project", path: "/tmp/p", default_model: "claude-opus-5", default_effort: "high",
  default_permission_mode: "acceptEdits", default_branch: null, verify_cmd: "make test", verify_timeout_sec: 600, max_workers: 2,
  push_enabled: 0, archived_at: null, path_ok: true, path_error: null, created_at: "", position: null, ...over,
});

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 1, name: "Lena", description: "Reviews code", avatar: null, model: null, effort: null, permission_mode: null, prompt: "",
  project_id: null, memory_enabled: false, created_at: "", updated_at: "", tasks: { active: 0, total: 0 }, ...over,
});

const openBlockers = async () => userEvent.click(await screen.findByRole("button", { name: /^Waits for/ }));
const branchButton = (branch: string) => screen.findByRole("button", { name: `Branch: ${branch}` });

async function pick(trigger: RegExp, option: RegExp | string) {
  await userEvent.click(screen.getByRole("button", { name: trigger }));
  await userEvent.click(within(await screen.findByRole("listbox")).getByRole("option", { name: option }));
}

const save = async (onSubmit: ReturnType<typeof vi.fn>) => {
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  return onSubmit.mock.calls[0][0];
};

it("the form holds what to do and a row of properties, without run parameters or a schedule", async () => {
  render(<TaskForm projectId={1} project={project()} allTasks={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />);
  await branchButton("main");
  expect(screen.getByRole("button", { name: /^Assignee/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Priority/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Waits for/ })).toBeInTheDocument();
  // These live in the agent and the project now
  expect(screen.queryByRole("combobox", { name: "Model" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Effort" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Permission mode" })).not.toBeInTheDocument();
  expect(screen.queryByRole("radio", { name: "On schedule" })).not.toBeInTheDocument();
});

it("what goes out holds only what the form edits, so a new card follows the agent and the project", async () => {
  const onSubmit = vi.fn();
  render(<TaskForm projectId={1} project={project()} allTasks={[]} initial={{ title: "New" }} onSubmit={onSubmit} onCancel={vi.fn()} />);
  await branchButton("main");
  const sent = await save(onSubmit);
  expect(sent).toMatchObject({ title: "New", priority: "normal", agent_id: null, status: "backlog", target_branch: "main" });
  for (const key of ["model", "effort", "permission_mode", "verify_cmd", "start_after", "start_before"]) expect(sent).not.toHaveProperty(key);
});

it("in blockers it shows the tasks of its own project", async () => {
  const all = [task(1, "Own"), task(3, "Foreign", 2)];
  render(<TaskForm projectId={1} allTasks={all} onSubmit={vi.fn()} onCancel={vi.fn()} />);
  await openBlockers();
  expect(await screen.findByRole("checkbox", { name: /#1 Own/ })).toBeInTheDocument();
  // A foreign project is not mixed with its own, but not lost either: it is behind a button.
  expect(screen.queryByRole("checkbox", { name: /#3 Foreign/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show other projects (1)" })).toBeInTheDocument();
});

it("a blocker from a foreign project can be selected, and you can see which one", async () => {
  const onSubmit = vi.fn();
  const all = [task(1, "Own"), task(3, "Foreign", 2)];
  const projects = [project(), project({ id: 2, name: "Backend" })];
  render(<TaskForm projectId={1} projects={projects} allTasks={all} initial={{ title: "Exists" }} onSubmit={onSubmit} onCancel={vi.fn()} />);
  await openBlockers();
  await userEvent.click(await screen.findByRole("button", { name: "Show other projects (1)" }));
  expect(screen.getByRole("group", { name: "Backend" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("checkbox", { name: /#3 Foreign/ }));
  await userEvent.keyboard("{Escape}");
  expect((await save(onSubmit)).depends_on).toEqual([3]);
});

it("the selected blockers are not lost when other properties are edited", async () => {
  const onSubmit = vi.fn();
  render(<TaskForm projectId={1} initial={{ title: "Exists", depends_on: [1] }} allTasks={[task(1, "First"), task(4, "Second")]} onSubmit={onSubmit} onCancel={vi.fn()} />);
  await pick(/^Priority/, /High/i);
  expect(await save(onSubmit)).toMatchObject({ priority: "high", depends_on: [1] });
});

it("an already saved link to a task of another project stays visible and is not lost", async () => {
  const onSubmit = vi.fn();
  render(<TaskForm projectId={1} initial={{ title: "Exists", depends_on: [3] }} allTasks={[task(1, "Own"), task(3, "Foreign", 2)]} onSubmit={onSubmit} onCancel={vi.fn()} />);
  await openBlockers();
  // A foreign project is hidden in the list, but the selected link must be shown, otherwise there is no way to remove it.
  expect(await screen.findByRole("checkbox", { name: /#3 Foreign/ })).toBeChecked();
  await userEvent.keyboard("{Escape}");
  expect((await save(onSubmit)).depends_on).toEqual([3]);
});

it("the agent list shows the shared agents and the project's own, and the choice goes out with the task", async () => {
  const onSubmit = vi.fn();
  render(
    <AgentsContext.Provider value={[agent(), agent({ id: 2, name: "Alien", project_id: 9 }), agent({ id: 3, name: "Local", project_id: 1 })]}>
      <TaskForm projectId={1} allTasks={[]} initial={{ title: "T" }} onSubmit={onSubmit} onCancel={vi.fn()} />
    </AgentsContext.Provider>,
  );
  await userEvent.click(screen.getByRole("button", { name: /^Assignee/ }));
  const list = await screen.findByRole("listbox");
  expect(within(list).getByRole("option", { name: /Unassigned/ })).toHaveAttribute("aria-selected", "true");
  expect(within(list).getByRole("option", { name: /Local/ })).toBeInTheDocument();
  expect(within(list).queryByRole("option", { name: /Alien/ })).not.toBeInTheDocument();
  // The agent is told apart by more than a name
  expect(within(list).getByRole("option", { name: /Lena/ })).toHaveTextContent("Reviews code");
  await userEvent.click(within(list).getByRole("option", { name: /Lena/ }));
  expect(screen.getByRole("button", { name: "Assignee: Lena" })).toBeInTheDocument();
  expect((await save(onSubmit)).agent_id).toBe(1);
});

it("the agent list says what to do when there are no agents at all", async () => {
  render(<TaskForm projectId={1} allTasks={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: /^Assignee/ }));
  expect(await screen.findByText(/No agents yet/)).toBeInTheDocument();
});

const withSettings = (settings: CardSettings, agents: Agent[], ui: React.ReactNode) => (
  <AppCardSettingsContext.Provider value={settings}>
    <AgentsContext.Provider value={agents}>{ui}</AgentsContext.Provider>
  </AppCardSettingsContext.Provider>
);

it("a new card starts with the defaults from the orc settings, and the project's override them", async () => {
  const onSubmit = vi.fn();
  const agents = [agent(), agent({ id: 2, name: "Max" })];
  const { unmount } = render(
    withSettings({ default_agent_id: 1, default_priority: "high" }, agents, <TaskForm projectId={1} project={project()} allTasks={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />),
  );
  expect(screen.getByRole("button", { name: "Assignee: Lena" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Priority: high/i })).toBeInTheDocument();
  unmount();

  render(
    withSettings({ default_agent_id: 1 }, agents, <TaskForm projectId={1} project={project({ card_settings: { default_agent_id: 2 } })} initial={{ title: "T" }} allTasks={[]} onSubmit={onSubmit} onCancel={vi.fn()} />),
  );
  expect((await save(onSubmit)).agent_id).toBe(2);
});

it("a default agent that arrives after the form opened fills it in, but not over the person's choice", async () => {
  const form = (agents: Agent[]) => withSettings({ default_agent_id: 1 }, agents, <TaskForm projectId={1} allTasks={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />);
  const { rerender, unmount } = render(form([]));
  expect(screen.getByRole("button", { name: "Assignee: Unassigned" })).toBeInTheDocument();
  rerender(form([agent()]));
  await screen.findByRole("button", { name: "Assignee: Lena" });
  await pick(/^Assignee/, /Unassigned/);
  rerender(form([agent(), agent({ id: 2, name: "Max" })]));
  expect(screen.getByRole("button", { name: "Assignee: Unassigned" })).toBeInTheDocument();
  unmount();
});

it("a property hidden in the settings is not offered, while the assignee cannot be hidden", async () => {
  render(withSettings({ hidden: ["priority", "agent"] }, [], <TaskForm projectId={1} allTasks={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />));
  expect(screen.queryByRole("button", { name: /^Priority/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Assignee/ })).toBeInTheDocument();
});

it("\"Create and start\" needs an assignee and a description, and sends the card to the queue", async () => {
  const onSubmit = vi.fn();
  render(withSettings({ default_agent_id: 1 }, [agent()], <TaskForm projectId={1} allTasks={[]} initial={{ title: "T" }} onSubmit={onSubmit} onCancel={vi.fn()} />));
  const start = screen.getByRole("button", { name: "Create and start" });
  expect(start).toBeDisabled();
  await userEvent.type(screen.getByLabelText("Task for the agent"), "do it");
  expect(start).toBeEnabled();
  await pick(/^Assignee/, /Unassigned/);
  expect(start).toBeDisabled();
  await pick(/^Assignee/, /Lena/);
  await userEvent.click(start);
  expect(onSubmit.mock.calls[0][0]).toMatchObject({ status: "todo", agent_id: 1, description: "do it" });
});

it("a new branch is created from the chosen parent and becomes the task's base", async () => {
  localStorage.clear();
  createBranch.mockClear();
  const onSubmit = vi.fn();
  render(<TaskForm projectId={1} initial={{ title: "T" }} allTasks={[]} onSubmit={onSubmit} onCancel={vi.fn()} />);
  await userEvent.click(await branchButton("main"));
  await userEvent.click(await screen.findByRole("button", { name: "+ New branch…" }));
  await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Create from" }), "dev");
  await userEvent.type(screen.getByRole("textbox", { name: "New branch name" }), "feature/x{Enter}");
  await waitFor(() => expect(createBranch).toHaveBeenCalledWith(1, "feature/x", "dev"));
  await branchButton("feature/x");
  // Enter in the name field created the branch, it did not submit the task
  expect(onSubmit).not.toHaveBeenCalled();
  expect((await save(onSubmit)).target_branch).toBe("feature/x");
});

it("a refused branch shows the reason and keeps the previous base", async () => {
  localStorage.clear();
  createBranch.mockRejectedValueOnce(new Error("branch dev already exists"));
  render(<TaskForm projectId={1} allTasks={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />);
  await userEvent.click(await branchButton("main"));
  await userEvent.click(await screen.findByRole("button", { name: "+ New branch…" }));
  await userEvent.type(await screen.findByRole("textbox", { name: "New branch name" }), "dev");
  await userEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("branch dev already exists");
  expect(screen.getByRole("button", { name: "Branch: main", hidden: true })).toBeInTheDocument();
});

it("a new task opens with the branch of the previous one, if it still exists", async () => {
  localStorage.clear();
  const first = render(<TaskForm projectId={1} initial={{ title: "T" }} allTasks={[]} rememberBranch onSubmit={vi.fn()} onCancel={vi.fn()} />);
  await branchButton("main");
  await pick(/^Branch/, "dev");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  first.unmount();

  const second = render(<TaskForm projectId={1} allTasks={[]} rememberBranch onSubmit={vi.fn()} onCancel={vi.fn()} />);
  await branchButton("dev");
  second.unmount();

  // The remembered branch was deleted meanwhile: fall back to the project base
  localStorage.setItem("orc.lastBranch.1", "gone");
  render(<TaskForm projectId={1} allTasks={[]} rememberBranch onSubmit={vi.fn()} onCancel={vi.fn()} />);
  await branchButton("main");
});

it("without rememberBranch the remembered branch is ignored", async () => {
  localStorage.setItem("orc.lastBranch.1", "dev");
  render(<TaskForm projectId={1} allTasks={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />);
  await branchButton("main");
  localStorage.clear();
});

it("warns when a blocker merges into another branch, and fixes it in one click", async () => {
  const onSubmit = vi.fn();
  const all = [{ ...task(1, "On dev"), target_branch: "dev" }, task(2, "On main")];
  render(<TaskForm projectId={1} allTasks={all} initial={{ title: "Next", target_branch: "main" }} onSubmit={onSubmit} onCancel={vi.fn()} />);
  await openBlockers();
  await userEvent.click(await screen.findByRole("checkbox", { name: /#2 On main/ }));
  expect(screen.queryByText(/Its blockers merge into/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("checkbox", { name: /#1 On dev/ }));
  await userEvent.keyboard("{Escape}");
  expect(await screen.findByText(/Its blockers merge into dev/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Use dev" }));
  expect(screen.queryByRole("button", { name: "Use dev" })).not.toBeInTheDocument();
  expect((await save(onSubmit)).target_branch).toBe("dev");
});

it("a blocker of another project says nothing about this project's base", async () => {
  const foreign = { ...task(3, "Foreign", 2), target_branch: "release" };
  render(<TaskForm projectId={1} allTasks={[foreign]} initial={{ title: "Next", target_branch: "main", depends_on: [3] }} onSubmit={vi.fn()} onCancel={vi.fn()} />);
  await branchButton("main");
  expect(screen.queryByText(/Its blockers merge into/)).not.toBeInTheDocument();
});

it("Enter in the title saves the card as before, and a title never takes a second line", async () => {
  const onSubmit = vi.fn();
  render(<TaskForm projectId={1} project={project()} allTasks={[]} initial={{ title: "Wrap me" }} onSubmit={onSubmit} onCancel={vi.fn()} />);
  await branchButton("main");
  const title = screen.getByRole("textbox", { name: "Title" });
  expect(title.tagName).toBe("TEXTAREA");
  await userEvent.type(title, " please{Enter}");
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  expect(onSubmit.mock.calls[0][0].title).toBe("Wrap me please");
});

it("the description field of the form grows with its text", async () => {
  render(<TaskForm projectId={1} project={project()} allTasks={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />);
  await branchButton("main");
  const field = screen.getByRole("textbox", { name: "Task for the agent" });
  await userEvent.type(field, "a{Enter}b{Enter}c");
  const mirror = field.parentElement!.querySelector("[data-autogrow-mirror]")!;
  expect(mirror.getAttribute("data-autogrow-mirror")).toBe("a\nb\nc ");
});

it("a subtask opens with its parent, base and agent filled in, and can still stand on its own", async () => {
  const onSubmit = vi.fn();
  render(
    <AgentsContext.Provider value={[agent({ id: 4, name: "Senior" })]}>
      <TaskForm
        projectId={1}
        project={project()}
        allTasks={[task(7, "Epic")]}
        initial={{ parent_task_id: 7, target_branch: "dev", agent_id: 4 }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    </AgentsContext.Provider>,
  );
  expect(await screen.findByText("Subtask of #7")).toBeInTheDocument();
  expect(screen.getByText("Epic")).toBeInTheDocument();
  await branchButton("dev");
  await userEvent.type(screen.getByLabelText("Title"), "Step");
  const values = await save(onSubmit);
  expect(values).toMatchObject({ parent_task_id: 7, target_branch: "dev", agent_id: 4 });

  onSubmit.mockClear();
  await userEvent.click(screen.getByRole("button", { name: "Not a subtask" }));
  expect(screen.queryByText("Subtask of #7")).not.toBeInTheDocument();
  expect((await save(onSubmit)).parent_task_id).toBeNull();
});
