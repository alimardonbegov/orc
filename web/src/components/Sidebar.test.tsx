import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, describe } from "vitest";
import { Sidebar, byPosition } from "./Sidebar";
import type { Project, Task } from "../types";

// EventsPanel inside the column polls the feed itself: an empty response is enough for the layout.
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { events: vi.fn(async () => []), markEventsRead: vi.fn(async () => ({ ok: true })) } };
});

const project = (id: number, name: string, position: number | null = null): Project => ({
  id,
  name,
  path: `/repo/${name}`,
  default_model: null,
  default_effort: null,
  default_permission_mode: "auto",
  default_branch: null,
  verify_cmd: null,
  verify_timeout_sec: 900,
  max_workers: 2,
  push_enabled: 0,
  archived_at: null,
  path_ok: true,
  path_error: null,
  created_at: "",
  position,
});

const baseProps = {
  tasks: [] as Task[],
  currentId: null as number | null,
  collapsed: false,
  usage: null,
  onUsageRefresh: vi.fn(),
  usagePending: false,
  dispatcher: null,
  onPause: vi.fn(),
  onResume: vi.fn(),
  onTick: vi.fn(),
  dispatcherPending: false,
  eventsOpen: false,
  onEventsOpen: vi.fn(),
  onOpenTask: vi.fn(),
  awake: false,
  working: false,
  onToggleCollapsed: vi.fn(),
  onAddProject: vi.fn(),
  onOpenSettings: vi.fn(),
  helpPage: null,
  onOpenHelp: vi.fn(),
};

describe("byPosition: manual order of projects in the sidebar", () => {
  it("sorts by position, ones never reordered (null) go to the tail by id", () => {
    const a = project(1, "A", null);
    const b = project(2, "B", 10);
    expect(byPosition([a, b]).map((p) => p.id)).toEqual([2, 1]);
  });

  it("a list nobody touched stays in id order", () => {
    const a = project(1, "A");
    const b = project(2, "B");
    const c = project(3, "C");
    expect(byPosition([a, b, c]).map((p) => p.id)).toEqual([1, 2, 3]);
  });
});

it("draws active projects in position order, not in the order of the incoming list", () => {
  const projects = [project(1, "Bravo", 20), project(2, "Alpha", 10)];
  render(<Sidebar projects={projects} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} />);
  const names = screen.getAllByText(/Alpha|Bravo/).map((el) => el.textContent);
  expect(names).toEqual(["Alpha", "Bravo"]);
});

it("clicking a project still selects it (the drag handlers do not intercept an ordinary click)", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const projects = [project(1, "Demo")];
  render(<Sidebar projects={projects} onSelect={onSelect} onReorderProjects={vi.fn()} {...baseProps} />);
  await user.click(screen.getByText("Demo"));
  expect(onSelect).toHaveBeenCalledWith(1);
});

it("archived projects do not take part in the manual order and stay in their section", () => {
  const projects = [project(1, "Live", 10), { ...project(2, "Dead"), archived_at: "2024-01-01" }];
  render(<Sidebar projects={projects} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} />);
  expect(screen.getByText("Archive")).toBeInTheDocument();
  expect(screen.getByText("Dead")).toBeInTheDocument();
});

it("the \"New project\" button sits in the project list, not in the footer of the column", async () => {
  const onAddProject = vi.fn();
  render(
    <Sidebar projects={[project(1, "Demo")]} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} onAddProject={onAddProject} />,
  );
  const nav = screen.getByRole("navigation", { name: "Projects" });
  await userEvent.click(within(nav).getByRole("button", { name: "New project" }));
  expect(onAddProject).toHaveBeenCalledOnce();
});

it("in the collapsed rail adding a project stays next to the list", () => {
  render(
    <Sidebar projects={[project(1, "Demo")]} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} collapsed />,
  );
  const nav = screen.getByRole("navigation", { name: "Projects" });
  expect(within(nav).getByRole("button", { name: "New project" })).toBeInTheDocument();
});

it("settings open from a row in the bottom navigation, and there is no separate theme button any more", async () => {
  const onOpenSettings = vi.fn();
  render(
    <Sidebar projects={[project(1, "Demo")]} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} onOpenSettings={onOpenSettings} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(onOpenSettings).toHaveBeenCalledOnce();
  // The appearance is switched in the settings themselves: a second door to the theme is not needed in the column
  expect(screen.queryByRole("button", { name: /Theme:/ })).not.toBeInTheDocument();
});

it("help opens from the bottom navigation, the open page is highlighted", async () => {
  const onOpenHelp = vi.fn();
  render(
    <Sidebar projects={[]} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} helpPage="about" onOpenHelp={onOpenHelp} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "How it works" }));
  expect(onOpenHelp).toHaveBeenCalledWith("guide");
  expect(screen.getByRole("button", { name: "About orc" })).toHaveAttribute("aria-current", "page");
});

it("in the collapsed rail help stays available as icons", async () => {
  const onOpenHelp = vi.fn();
  render(
    <Sidebar projects={[]} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} collapsed onOpenHelp={onOpenHelp} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "About orc" }));
  expect(onOpenHelp).toHaveBeenCalledWith("about");
});

// Tasks are closed in several projects at once: the counter in the list says where the
// results the owner has not seen yet are (viewing.ts).
it("a project has an unviewed-results counter, only where viewing is tracked", () => {
  const done = (id: number, projectId: number, viewed_at: string | null = null) =>
    ({ id, project_id: projectId, status: "done", blocker: null, archived_at: null, done_at: "2026-03-01T10:00:00+00:00", viewed_at }) as Task;
  const projects = [{ ...project(1, "Alpha"), track_viewed: 1 }, { ...project(2, "Beta"), track_viewed: 0 }];
  const tasks = [done(1, 1), done(2, 1), done(3, 1, "2026-03-02T00:00:00+00:00"), done(4, 2)];
  render(<Sidebar projects={projects} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} tasks={tasks} />);

  expect(within(screen.getByRole("button", { name: /Alpha/ })).getByTitle("not viewed: 2")).toHaveTextContent("2");
  expect(within(screen.getByRole("button", { name: /Beta/ })).queryByTitle(/not viewed/)).not.toBeInTheDocument();
});

describe("cards in work under their project", () => {
  const card = (id: number, projectId: number, status: Task["status"], title = `Card ${id}`, extra: Partial<Task> = {}) =>
    ({ id, project_id: projectId, title, status, blocker: null, archived_at: null, agent_id: null, ...extra }) as Task;
  const renderWith = (tasks: Task[], props: Record<string, unknown> = {}) =>
    render(<Sidebar projects={[project(1, "Alpha"), project(2, "Beta")]} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} tasks={tasks} {...props} />);

  it("a project whose only card sleeps until a wakeup still shows a counter", () => {
    renderWith([card(7, 1, "in_progress", "Asleep", { blocker: "sleeping" })]);
    const row = screen.getByRole("button", { name: /Alpha/ });
    expect(within(row).getByTitle("asleep: 1")).toHaveTextContent("1");
    expect(within(row).queryByTitle(/running/)).not.toBeInTheDocument();
  });

  it("lists running cards of a project open by default, with their numbers", () => {
    renderWith([card(7, 1, "in_progress"), card(8, 1, "verifying"), card(9, 1, "todo"), card(10, 2, "done")]);
    expect(screen.getByRole("button", { name: /#7/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /#8/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /#9/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /#10/ })).not.toBeInTheDocument();
  });

  it("shows nothing for a project without running cards and in the collapsed rail", () => {
    const { unmount } = renderWith([card(9, 1, "todo")]);
    expect(screen.queryByRole("button", { name: "Hide running cards" })).not.toBeInTheDocument();
    unmount();
    renderWith([card(7, 1, "in_progress")], { collapsed: true });
    expect(screen.queryByRole("button", { name: /#7/ })).not.toBeInTheDocument();
  });

  it("clicking a card opens it without selecting the project row", async () => {
    const user = userEvent.setup();
    const onOpenTask = vi.fn();
    const onSelect = vi.fn();
    renderWith([card(7, 1, "in_progress")], { onOpenTask, onSelect });
    await user.click(screen.getByRole("button", { name: /#7/ }));
    expect(onOpenTask).toHaveBeenCalledWith(7);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("has no extra heading line: the chevron sits in the project row itself", () => {
    renderWith([card(7, 1, "in_progress")]);
    expect(screen.queryByText(/In work/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide running cards" })).toHaveAttribute("aria-expanded", "true");
  });

  it("folds and unfolds the list, and remembers the choice", async () => {
    const user = userEvent.setup();
    localStorage.clear();
    const { unmount } = renderWith([card(7, 1, "in_progress")]);
    await user.click(screen.getByRole("button", { name: "Hide running cards" }));
    expect(screen.queryByRole("button", { name: /#7/ })).not.toBeInTheDocument();
    unmount();
    renderWith([card(7, 1, "in_progress")]);
    expect(screen.queryByRole("button", { name: /#7/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show running cards" }));
    expect(screen.getByRole("button", { name: /#7/ })).toBeInTheDocument();
    localStorage.clear();
  });

  it("shows the first three and opens the rest on request", async () => {
    const user = userEvent.setup();
    localStorage.clear();
    renderWith([1, 2, 3, 4, 5].map((id) => card(id, 1, "in_progress")));
    expect(screen.queryByRole("button", { name: /#4/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all (5)" }));
    expect(screen.getByRole("button", { name: /#5/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.queryByRole("button", { name: /#5/ })).not.toBeInTheDocument();
  });

  it("a card that waits for a human does not pulse", () => {
    renderWith([card(7, 1, "in_progress"), card(8, 1, "in_progress", "Stuck", { blocker: "question" as Task["blocker"] })]);
    const dots = screen.getAllByTestId("running-dot");
    expect(dots[0].className).toContain("animate-pulse");
    expect(dots[1].className).not.toContain("animate-pulse");
  });

  it("a card disappears from the list once it stops running", () => {
    const { rerender } = renderWith([card(7, 1, "in_progress")]);
    expect(screen.getByRole("button", { name: /#7/ })).toBeInTheDocument();
    rerender(<Sidebar projects={[project(1, "Alpha")]} onSelect={vi.fn()} onReorderProjects={vi.fn()} {...baseProps} tasks={[card(7, 1, "done")]} />);
    expect(screen.queryByRole("button", { name: /#7/ })).not.toBeInTheDocument();
  });
});
