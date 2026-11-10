import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentsContext, agentHue, agentsForProject, chatProjectOf } from "../agents";
import type { Agent, Project, Task } from "../types";
import { AgentDialog } from "./AgentDialog";
import { AgentsPage } from "./AgentsPage";
import { AgentAvatar } from "./AgentAvatar";
import { TaskForm } from "./TaskForm";
import { api } from "../api";

vi.mock("../api", () => ({
  api: {
    branches: vi.fn(async () => ({ current: "main", default_branch: null, base: "main", branches: ["main"], items: [] })),
    addAgent: vi.fn(async () => ({})),
    patchAgent: vi.fn(async () => ({})),
    deleteAgent: vi.fn(async () => ({ deleted: 1 })),
    agentMemory: vi.fn(async () => ({ enabled: true, path: "/d/agents/1/memory", files: [{ name: "MEMORY.md", size: 5, content: "notes", truncated: false }] })),
    clearAgentMemory: vi.fn(async () => ({ files: [] })),
  },
  ApiError: class extends Error {},
}));

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 1, name: "Reviewer", description: "finds bugs", avatar: null, model: "claude-haiku-4-5", effort: "low",
  permission_mode: "dontAsk", prompt: "Be strict.", project_id: null, memory_enabled: false, created_at: "", updated_at: "",
  tasks: { active: 0, total: 0 }, ...over,
});

const project = (over: Partial<Project> = {}): Project => ({
  id: 1, name: "Demo", path: "/tmp/p", default_model: "claude-opus-5", default_effort: "high",
  default_permission_mode: "acceptEdits", default_branch: null, verify_cmd: null, verify_timeout_sec: 600, max_workers: 2,
  push_enabled: 0, archived_at: null, path_ok: true, path_error: null, created_at: "", position: null, ...over,
});

const none: Task[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

it("only shared agents and the project's own are offered", () => {
  const list = [agent(), agent({ id: 2, name: "Inner", project_id: 7 }), agent({ id: 3, name: "Alien", project_id: 8 })];
  expect(agentsForProject(list, 7).map((a) => a.name)).toEqual(["Reviewer", "Inner"]);
  expect(agentsForProject(list, null).map((a) => a.name)).toEqual(["Reviewer"]);
});

it("a task's stored agent is shown when the form opens", async () => {
  render(
    <AgentsContext.Provider value={[agent()]}>
      <TaskForm projectId={1} project={project()} allTasks={none} initial={{ title: "T", agent_id: 1 }} onSubmit={vi.fn()} onCancel={vi.fn()} />
    </AgentsContext.Provider>,
  );
  expect(await screen.findByRole("button", { name: `Assignee: ${agent().name}` })).toBeInTheDocument();
});

it("avatar: a picture, a glyph or initials on the agent's own color", () => {
  const { rerender, container } = render(<AgentAvatar agent={agent({ avatar: "data:image/png;base64,AAAA" })} />);
  expect(container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,AAAA");
  rerender(<AgentAvatar agent={agent({ avatar: "🦊" })} />);
  expect(container).toHaveTextContent("🦊");
  rerender(<AgentAvatar agent={agent({ name: "Code Reviewer" })} />);
  expect(container).toHaveTextContent("CR");
  expect(agentHue(1)).not.toBe(agentHue(2));
});

it("the agents page shows scope, leadership and parameters and leads to a chat", async () => {
  const onChat = vi.fn();
  const list = [
    agent({ memory_enabled: true, tasks: { active: 2, total: 5 } }),
    agent({ id: 2, name: "Inner", project_id: 1, model: null, effort: null, permission_mode: null, description: "", prompt: "" }),
  ];
  render(
    <AgentsContext.Provider value={list}>
      <AgentsPage projects={[project({ lead_agent_id: 1 })]} onChanged={vi.fn()} onChat={onChat} />
    </AgentsContext.Provider>,
  );
  expect(screen.getByText("lead of Demo")).toBeInTheDocument();
  expect(screen.getByText("own memory")).toBeInTheDocument();
  expect(screen.getByText("working: 2")).toBeInTheDocument();
  expect(screen.getByText("Haiku 4.5 · low · dontAsk")).toBeInTheDocument();
  expect(screen.getByText("project model")).toBeInTheDocument();
  await userEvent.click(screen.getAllByRole("button", { name: "Chat" })[1]);
  expect(onChat.mock.calls[0][0].name).toBe("Inner");
});

const renderPage = (list: Agent[], projects: Project[] = []) =>
  render(
    <AgentsContext.Provider value={list}>
      <AgentsPage projects={projects} onChanged={vi.fn()} onChat={vi.fn()} />
    </AgentsContext.Provider>,
  );
// The title button of each card carries the agent's name in its label.
const cardNames = () =>
  screen.getAllByRole("button", { name: /^Open the page of / }).map((b) => b.getAttribute("aria-label")?.replace("Open the page of ", ""));

it("the agents page sorts, filters, groups and remembers the view", async () => {
  const list = [
    agent({ id: 1, name: "Zed", created_at: "2026-01-01" }),
    agent({ id: 2, name: "Amy", project_id: 1, created_at: "2026-01-02" }),
  ];
  const { unmount } = renderPage(list, [project()]);
  expect(cardNames()).toEqual(["Zed", "Amy"]);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sort" }), "name");
  expect(cardNames()).toEqual(["Amy", "Zed"]);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Project" }), "shared");
  expect(cardNames()).toEqual(["Zed"]);
  await userEvent.type(screen.getByRole("searchbox", { name: "Search agents" }), "nobody");
  expect(screen.getByText("No agents match the filters")).toBeInTheDocument();
  unmount();
  // The view survives a reload.
  renderPage(list, [project()]);
  expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("name");
  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(cardNames()).toEqual(["Zed", "Amy"]);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Group" }), "scope");
  expect(screen.getByRole("heading", { name: "All projects · 1" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Demo · 1" })).toBeInTheDocument();
});

it("the saved order puts cards first and offers a grip only for the manual order", async () => {
  localStorage.setItem("orc.agents.order", JSON.stringify([2, 1]));
  renderPage([agent({ id: 1, name: "Zed" }), agent({ id: 2, name: "Amy" })]);
  expect(cardNames()).toEqual(["Amy", "Zed"]);
  expect(screen.getByRole("button", { name: "Drag to reorder: Amy" })).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sort" }), "name");
  expect(screen.queryByRole("button", { name: /Drag to reorder/ })).toBeNull();
});

it("the empty agents page explains what to do", () => {
  render(
    <AgentsContext.Provider value={[]}>
      <AgentsPage projects={[]} onChanged={vi.fn()} onChat={vi.fn()} />
    </AgentsContext.Provider>,
  );
  expect(screen.getByText("No agents yet")).toBeInTheDocument();
});

it("creating an agent sends every field the form holds", async () => {
  const onSaved = vi.fn();
  render(<AgentDialog open onOpenChange={vi.fn()} agent={null} projects={[project()]} onSaved={onSaved} />);
  const create = screen.getByRole("button", { name: "Create agent" });
  expect(create).toBeDisabled();
  await userEvent.type(screen.getByPlaceholderText("Reviewer"), "Tess");
  await userEvent.type(screen.getByRole("textbox", { name: "Prompt (optional)" }), "Write tests.");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Effort" }), "max");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Where it works" }), "1");
  await userEvent.click(screen.getByRole("switch", { name: /Own memory/ }));
  await userEvent.click(create);
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.addAgent).toHaveBeenCalledWith({
    name: "Tess", description: "", avatar: null, model: null, effort: "max", permission_mode: null,
    prompt: "Write tests.", project_id: 1, memory_enabled: true,
  });
});

it("appointing a lead from the agent's settings sends the projects it leads", async () => {
  const onSaved = vi.fn();
  const projects = [project({ lead_agent_id: 1 }), project({ id: 2, name: "Second" })];
  render(<AgentDialog open onOpenChange={vi.fn()} agent={agent()} projects={projects} onSaved={onSaved} />);
  expect(screen.getByRole("checkbox", { name: "Demo" })).toBeChecked();
  await userEvent.click(screen.getByRole("checkbox", { name: "Second" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(vi.mocked(api.patchAgent).mock.calls[0][1].lead_project_ids).toEqual([1, 2]);
});

it("saving without touching the leads does not send them", async () => {
  const onSaved = vi.fn();
  render(<AgentDialog open onOpenChange={vi.fn()} agent={agent()} projects={[project({ lead_agent_id: 1 })]} onSaved={onSaved} />);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(vi.mocked(api.patchAgent).mock.calls[0][1]).not.toHaveProperty("lead_project_ids");
});

it("a project led by another agent names that lead, and an archived one is offered only to its own", () => {
  const projects = [
    project({ lead_agent_id: 2 }),
    project({ id: 2, name: "Old", archived_at: "2026-01-01", lead_agent_id: 1 }),
    project({ id: 3, name: "Gone", archived_at: "2026-01-01" }),
  ];
  render(
    <AgentsContext.Provider value={[agent(), agent({ id: 2, name: "Other" })]}>
      <AgentDialog open onOpenChange={vi.fn()} agent={agent()} projects={projects} onSaved={vi.fn()} />
    </AgentsContext.Provider>,
  );
  expect(screen.getByRole("checkbox", { name: "Demo now: Other" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Old" })).toBeChecked();
  expect(screen.queryByRole("checkbox", { name: "Gone" })).not.toBeInTheDocument();
});

it("limiting an agent to one project drops its other leads from the list", async () => {
  const onSaved = vi.fn();
  const projects = [project({ lead_agent_id: 1 }), project({ id: 2, name: "Second", lead_agent_id: 1 })];
  render(<AgentDialog open onOpenChange={vi.fn()} agent={agent()} projects={projects} onSaved={onSaved} />);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Where it works" }), "1");
  expect(screen.queryByRole("checkbox", { name: "Second" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(vi.mocked(api.patchAgent).mock.calls[0][1]).toMatchObject({ project_id: 1, lead_project_ids: [1] });
});

it("trying one project's scope and coming back keeps the agent's leads", async () => {
  const onSaved = vi.fn();
  const projects = [project({ lead_agent_id: 1 }), project({ id: 2, name: "Second", lead_agent_id: 1 })];
  render(<AgentDialog open onOpenChange={vi.fn()} agent={agent()} projects={projects} onSaved={onSaved} />);
  const scope = screen.getByRole("combobox", { name: "Where it works" });
  await userEvent.selectOptions(scope, "1");
  await userEvent.selectOptions(scope, "");
  expect(screen.getByRole("checkbox", { name: "Second" })).toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(vi.mocked(api.patchAgent).mock.calls[0][1]).not.toHaveProperty("lead_project_ids");
});

it("a chat opened from the agent's card goes to its own or its only led project", () => {
  const led = project({ lead_agent_id: 1 });
  expect(chatProjectOf(agent(), [led])).toBe(1);
  expect(chatProjectOf(agent(), [project()])).toBeNull();
  expect(chatProjectOf(agent(), [led, project({ id: 2, lead_agent_id: 1 })])).toBeNull();
  expect(chatProjectOf(agent(), [project({ lead_agent_id: 1, archived_at: "2026-01-01" })])).toBeNull();
  expect(chatProjectOf(agent(), [project({ lead_agent_id: 1, path_ok: false })])).toBeNull();
  expect(chatProjectOf(agent({ project_id: 7 }), [led])).toBe(7);
});

it("a refused deletion keeps the dialog open with the server's reason", async () => {
  vi.mocked(api.deleteAgent).mockRejectedValueOnce(new Error("the agent is in use: tasks [4], routines []"));
  const onOpenChange = vi.fn();
  render(<AgentDialog open onOpenChange={onOpenChange} agent={agent()} projects={[]} onSaved={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  const buttons = await screen.findAllByRole("button", { name: "Delete" });
  fireEvent.click(buttons[buttons.length - 1]);
  expect(await screen.findByText(/the agent is in use/)).toBeInTheDocument();
  expect(onOpenChange).not.toHaveBeenCalled();
});

it("memory files of an agent are shown and can be cleared", async () => {
  render(<AgentDialog open onOpenChange={vi.fn()} agent={agent({ memory_enabled: true })} projects={[]} onSaved={vi.fn()} />);
  expect(await screen.findByText("MEMORY.md")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Clear memory" }));
  const buttons = await screen.findAllByRole("button", { name: "Clear memory" });
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() => expect(api.clearAgentMemory).toHaveBeenCalledWith(1));
  expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument();
});
